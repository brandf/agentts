// diagnosis — root-cause diagnosis for a failing phase review (BRA-126).
//
// Brandon's Nov 18 diagnosis rule: when an issue comes up, ask
// whether it is the work itself, the workflow running it, or the
// rubric judging it — and fix it at the root cause, possibly in
// multiple areas. The Nov 18 BRA-111 trial was all three at once
// (a thin draft, a draft step that never saw the rubric, and a
// rubric that could not tell good from bad), diagnosed by hand in
// chat. The point of this module is that the process must not depend
// on Meroki remembering to ask the question: the template asks it
// every time a phase review fails, and records the answer.
//
// Why a plain function, not a job trap: the diagnosis classifies
// data the review already recorded (the evidence, the acceptance,
// the loop outcome) — it is deterministic structure, like
// planWaves / splitExecuted, not agent judgment. A job trap would
// run the same rules inside a worker (and need a mock mirror kept
// in sync) without adding any signal: the v0 workers cannot reason
// about root causes, they can only apply rules. When a real judging
// agent replaces the v0 workers, the diagnosis step is the place to
// hand the same question to it — the call site in phase-review.ts
// is one line.
//
// The three levels, and the observable signal for each:
//   - work: the default. A failing review means the work did not
//     satisfy the acceptance — that is definitional, so work is
//     always named on failure. The reason is specific: no evidence,
//     almost no evidence, the evidence missing the acceptance's key
//     term, or the evidence addressing the key term while the score
//     still stayed below threshold (the mock adapter's base scores
//     cap at 0.70 — this is the case its phase reviews hit).
//   - workflow: the evidence shares no content word with the
//     acceptance — it is about a different subject, so the step
//     that produced it ran against the wrong input. (Only when the
//     evidence is non-empty; empty evidence is a work failure.)
//   - rubric: the acceptance criterion as written cannot be
//     checked — it is empty, a single word, or starts with a
//     stopword (the v0 judge checks first-word containment, so a
//     stopword-first criterion matches everything or nothing
//     meaningful).
// The levels are independent: several can fire at once, and a
// three-level failure is diagnosed as all three, not as a
// single-level work failure. Each level carries a fix routing —
// where the fix belongs — so the caller knows what to change
// instead of fixing only the level that is easiest to reach.
//
// Known limit (v0): a review that CONVERGES gets no diagnosis
// (null) — including a false pass, where a vacuous criterion
// approves evidence that does not really satisfy it. The loop
// cannot see a false pass; catching vacuous criteria is the
// rubric side's job (the meta-rubric + rubric review), not this
// module's.

/** The three root-cause levels of the diagnosis rule. */
export type DiagnosisLevel = "work" | "workflow" | "rubric";

/** A recorded diagnosis. `reasons[i]` and `fixRouting[i]` describe
 * `levels[i]` — the three arrays are parallel, in the fixed order
 * work, workflow, rubric. */
export interface Diagnosis {
  levels: DiagnosisLevel[];
  reasons: string[];
  fixRouting: string[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "it", "its", "this", "that", "by", "from",
  "at", "as", "be", "has", "have", "had", "do", "does", "did", "not",
  "no", "so", "if", "then", "than", "but", "we", "you", "they", "he",
  "she", "i",
]);

/** Evidence shorter than this is "almost no evidence" — the work
 * produced nothing substantive. */
export const THIN_EVIDENCE_WORDS = 5;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The evidence as the phase produced it: the fix loop's
 * "(revised N)." markers are loop artifacts, not work product —
 * strip them before measuring thinness or content overlap, or a
 * one-word evidence would read as five words after two loops. */
function cleanEvidence(text: string): string {
  return text.replace(/\(revised \d+\)\.?/g, " ");
}

function firstWord(text: string): string {
  return words(text)[0] ?? "";
}

/** Content words: long enough to carry meaning, not stopwords. */
function contentWords(text: string): string[] {
  return words(text).filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/** Diagnose a phase review's outcome. Returns null when the review
 * converged — there is no failure to diagnose. Otherwise returns a
 * diagnosis naming at least one level (work is always named: a
 * failing review means the work did not satisfy the acceptance),
 * plus workflow and/or rubric when their signals are present. */
export function diagnosePhaseReview(input: {
  evidence: string;
  acceptance: string;
  loops: number;
  converged: boolean;
  finalMeanScore: number;
  threshold: number;
}): Diagnosis | null {
  if (input.converged) return null;
  const evidence = cleanEvidence(input.evidence ?? "");
  const acceptance = input.acceptance ?? "";
  const evWords = words(evidence);
  const first = firstWord(acceptance);
  const levels: DiagnosisLevel[] = ["work"];
  const reasons: string[] = [];
  const fixRouting: string[] = [];
  // work (always named): the reason cites the specific observation.
  if (evWords.length === 0) {
    reasons.push("the phase produced no evidence at all — the work did not do what the acceptance asks");
  } else if (evWords.length < THIN_EVIDENCE_WORDS) {
    reasons.push(
      `the phase produced almost no evidence (${evWords.length} word(s)) — the work did not do what the acceptance asks`,
    );
  } else if (first && !evidence.toLowerCase().includes(first)) {
    reasons.push(
      `the evidence does not contain the acceptance's key term "${first}" — the work did not produce what the acceptance asks for`,
    );
  } else {
    reasons.push(
      `the evidence addresses the acceptance's key term but the review still did not converge ` +
        `(final mean ${input.finalMeanScore} < threshold ${input.threshold} after ${input.loops} loop(s)) — ` +
        `the work is incomplete or the loop cap was reached`,
    );
  }
  fixRouting.push(
    "re-execute or deepen the phase's work: the phase's evidence must name what the acceptance asks for",
  );
  // workflow: the evidence is about a different subject than the
  // acceptance — the step that produced it ran against the wrong
  // input. Only when the evidence is non-empty (empty evidence is
  // a work failure, not a wrong-subject failure).
  const accContent = contentWords(acceptance);
  const evLower = evidence.toLowerCase();
  if (evWords.length > 0 && accContent.length > 0 && !accContent.some((w) => evLower.includes(w))) {
    levels.push("workflow");
    reasons.push(
      `the evidence shares no content word with the acceptance (${accContent.slice(0, 4).join(", ")}) — ` +
        `it is about a different subject, so the step that produced it ran against the wrong input`,
    );
    fixRouting.push(
      "fix the step that produced the evidence: check the phase's input and the step's wiring — the evidence came from the wrong place",
    );
  }
  // rubric: the acceptance criterion as written cannot be checked.
  if (!acceptance.trim() || words(acceptance).length === 1 || STOPWORDS.has(first)) {
    levels.push("rubric");
    reasons.push(
      !acceptance.trim()
        ? "the acceptance criterion is empty — there is nothing to check the evidence against"
        : words(acceptance).length === 1
          ? `the acceptance criterion is a single word ("${acceptance.trim()}") — it names no observable outcome to check against`
          : `the acceptance criterion starts with the stopword "${first}" — the judge's first-word check matches everything or nothing meaningful`,
    );
    fixRouting.push(
      "revise the acceptance criterion: name the observable outcome in checkable words (avoid a single-word or stopword-first criterion)",
    );
  }
  return { levels, reasons, fixRouting };
}
