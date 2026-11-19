// phase-review — review one executed phase against its acceptance
// criterion (BRA-117). A child workflow of the plan-driven-work
// template, invoked via the `run` trap (BRA-105 form B) once per
// executed phase.
//
// Why a separate file: the template's own JudgeFixLoop reviews the
// PLAN (item type Plan). Reviewing a phase's evidence needs a
// second JudgeFixLoop instantiation with a different item type
// (PhaseEvidence) — and two instantiations with different types in
// ONE workflow hit the extractor's one-key-one-contract conflict
// on `job:judge`. The child run carries its own extraction, so the
// plan loop and the phase loop never share a key. The child is
// referenced by literal path only (`./phase-review.ts` in
// plan-driven-work.ts); the shared shapes (PhaseEvidence, the
// rubric) are deliberately re-declared here instead of imported
// from plan-driven-work.ts — importing them would pull that file's
// trap sites into this file's extraction.
//
// The loop: JudgeFixLoop over { text: evidence, goal: acceptance }
// with a one-criterion rubric (the acceptance itself, threshold
// 0.8). The v0 judge scores the criterion by first-word
// containment in the evidence text, so the evidence must genuinely
// name what the acceptance asks for; the v0 fix appends an
// addressing sentence (BRA-44 append-only) or, for a criterion it
// does not know, only a revision marker — in which case the loop
// hits the cap honestly instead of pretending to improve.
//
// Diagnosis (BRA-126): when the review fails to converge, the
// workflow diagnoses the root-cause level itself — work, workflow,
// rubric, possibly several at once — via diagnosePhaseReview
// (workflows/library/diagnosis.ts), a deterministic classification
// of the recorded review data, and carries the diagnosis (levels +
// reasons + fix routing per level) in the result. A converged
// review gets no diagnosis (null).

import { judgeFixLoop } from "./judge-fix-loop";
import { diagnosePhaseReview, type Diagnosis } from "./diagnosis";

declare function print(...args: unknown[]): void;

// ---------------------------------------------------------------- types
/** The evidence the loop judges: the phase's evidence text
 * against its acceptance criterion (the goal). Re-declared here
 * (see the header) rather than imported from plan-driven-work.ts. */
export interface PhaseEvidence {
  text: string;
  goal: string;
}

/** A rubric: criteria as bare strings, plus the mean-score
 * threshold. Re-declared here (see the header). */
export interface PhaseRubric {
  criteria: string[];
  threshold: number;
}

export interface PhaseReviewInput {
  phase: string;
  evidence: string;
  acceptance: string;
  threshold?: number;
  maxLoops?: number;
}

export interface PhaseReviewResult {
  phase: string;
  loops: number;
  converged: boolean;
  finalMeanScore: number;
  evidence: string;
  /** Root-cause diagnosis (BRA-126): null when the review
   * converged — there is no failure to diagnose. Otherwise the
   * levels named (work / workflow / rubric, possibly several),
   * each with a reason citing the observed signal and a fix
   * routing naming where the fix belongs. */
  diagnosis: Diagnosis | null;
}

export const MAX_LOOPS = 2;

// -------------------------------------------------------- workflow entry
/** The workflow: one JSON-capable input in, one JSON-capable output
 * out. */
export default function phaseReview(input: PhaseReviewInput): PhaseReviewResult {
  const threshold = input.threshold ?? 0.8;
  const reviewed = judgeFixLoop<PhaseEvidence, PhaseRubric>(
    { text: input.evidence, goal: input.acceptance },
    { criteria: [input.acceptance], threshold },
    input.maxLoops ?? MAX_LOOPS,
  );
  print(`phase review ${input.phase}: ${reviewed.loops} loop(s), converged ${reviewed.converged}`);
  // Root-cause diagnosis (BRA-126): when the review fails, ask
  // work / workflow / rubric and record the answer with the fix
  // routing — the workflow itself asks it every time, so the
  // process does not depend on anyone remembering to. A converged
  // review gets no diagnosis (null).
  const diagnosis = diagnosePhaseReview({
    evidence: reviewed.item.text,
    acceptance: input.acceptance,
    loops: reviewed.loops,
    converged: reviewed.converged,
    finalMeanScore: reviewed.lastAggregate?.meanScore ?? 0,
    threshold,
  });
  if (diagnosis) {
    print(`phase review ${input.phase}: diagnosis [${diagnosis.levels.join(", ")}] — ${diagnosis.reasons.join(" | ")}`);
  }
  return {
    phase: input.phase,
    loops: reviewed.loops,
    converged: reviewed.converged,
    finalMeanScore: reviewed.lastAggregate?.meanScore ?? 0,
    evidence: reviewed.item.text,
    diagnosis,
  };
}
