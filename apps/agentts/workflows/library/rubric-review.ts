// rubric-review — the rubricReview library workflow.
//
// Built on judgeFixLoop: takes a rubric under review and improves it
// against the meta-rubric (workflows/rubrics/meta-rubric.md, the
// default judging rubric). The meta-rubric judges the rubric, not
// the artifact: would this rubric, applied honestly, separate good
// work from bad work, and would it tell the fixer what to change?
//
// Inputs (RubricReviewInput): the rubric under review (inline text
// or a { file } reference — the general inline-or-file indirection),
// the scope the rubric claims (in scope / explicitly out /
// boundaries — generality is judged against it), the artifact kind,
// reference examples (REQUIRED: at least one known-good and one
// known-mediocre — a rubric cannot be judged in the abstract), the
// meta-rubric (default: the checked-in meta-rubric.md), the numeric
// threshold (default 0.8, separate from the prose, never parsed out
// of it), and maxLoops (default 3).
//
// The three judges receive the rubric, the scope, the artifact kind,
// the reference examples, and the meta-rubric, and return scored
// criteria (0–10, interpolated, one-line reason each) PLUS
// open-ended feedback: answers to the five guided questions plus
// free-form text. The fix receives the rubric and all verdicts
// INCLUDING all open-ended feedback. The output carries the revised
// rubric, the loop outcome, and the final round's verdicts — the
// per-criterion scores and the full open-ended feedback — so a human
// can read them in the run result.
//
// v1 limits, stated plainly: the v0 judge/fix workers are
// deterministic keyword/coverage workers (see
// plugins/muse/jobspecs/judge.md and fix.md), not LLM judgement —
// the judge scores each meta-criterion 10 when the rubric names it
// and 0 when it does not, and the fix appends one addressing
// sentence per missed criterion rather than rewriting the rubric.
// A rubric that fails discrimination needs its criteria rewritten,
// not its scores argued with; if three loops do not converge, the
// rubric needs a human rethink, not a fourth loop. The meta-rubric
// itself is validated separately (self-test + generalization suite,
// run by Meroki operating this workflow) before it is trusted.

import {
  judgeFixLoop,
  resolveTextRubric,
  resolveTextBlob,
  type JudgeFixLoopResult,
  type JudgeVerdict,
  type TextRubric,
  type TextRubricInput,
} from "./judge-fix-loop";

declare function print(...args: unknown[]): void;

// The item/rubric types used as judgeFixLoop's generic arguments
// must be exported from this file (BRA-106: the specialization
// alias imports them by name). TextRubric / TextRubricInput are
// defined in the loop library and re-exported here for that import.
export type { TextRubric, TextRubricInput } from "./judge-fix-loop";
export type { JudgeVerdict } from "./judge-fix-loop";

/** The rubric under review, as the judges see it: the rubric text,
 * the scope it claims, the artifact kind, and the resolved reference
 * examples (judges apply the rubric mentally to them). `kind` marks
 * the item shape for the workers (the rubric branch of judge/fix). */
export interface RubricText {
  text: string;
  kind: "rubric";
  scope: string;
  artifactKind: string;
  references: ResolvedReference[];
}

export interface ResolvedReference {
  label: "good" | "mediocre";
  text: string;
}

/** The class of items the rubric claims to judge: what is in scope,
 * what is explicitly out of scope, and where the boundaries lie.
 * The judges receive it alongside the rubric, and it is what
 * generality is judged against — without it, the judges have to
 * guess the intended scope. */
export interface ScopeDefinition {
  inScope: string;
  outOfScope: string;
  boundaries: string;
}

/** One reference example: a known-good or known-mediocre artifact
 * of the kind, as inline text or a file reference. */
export interface ReferenceExample {
  label: "good" | "mediocre";
  text?: string;
  file?: string;
}

export interface RubricReviewInput {
  rubric: TextRubricInput;
  threshold?: number;
  scope: ScopeDefinition;
  artifactKind: string;
  referenceExamples: ReferenceExample[];
  metaRubric?: TextRubricInput;
  maxLoops?: number;
}

export interface RubricReviewResult {
  rubric: string;
  loops: number;
  converged: boolean;
  finalMeanScore: number;
  /** The final round's verdicts — the per-criterion scores and the
   * full open-ended feedback, recorded in the run result so a human
   * can read them. */
  lastVerdicts: JudgeVerdict[];
}

export const DEFAULT_THRESHOLD = 0.8;
export const MAX_LOOPS = 3;
export const DEFAULT_META_RUBRIC: TextRubricInput = { file: "workflows/rubrics/meta-rubric.md" };

/** Render a scope definition as the text the judges read. */
export function renderScope(scope: ScopeDefinition): string {
  return `In scope: ${scope.inScope}\nOut of scope: ${scope.outOfScope}\nBoundaries: ${scope.boundaries}`;
}

/** Validate the review inputs before any judging runs. Reference
 * examples are required, not optional — criterion 7 (calibration)
 * cannot be scored without them, and a rubric cannot be judged in
 * the abstract. */
export function validateReviewInput(input: RubricReviewInput): void {
  if (
    !input.scope ||
    typeof input.scope.inScope !== "string" ||
    !input.scope.inScope.trim() ||
    typeof input.scope.outOfScope !== "string" ||
    !input.scope.outOfScope.trim() ||
    typeof input.scope.boundaries !== "string" ||
    !input.scope.boundaries.trim()
  ) {
    throw new Error(
      "rubric-review: scope must define inScope, outOfScope, and boundaries (all non-empty strings) — generality is judged against the claimed scope",
    );
  }
  if (typeof input.artifactKind !== "string" || !input.artifactKind.trim()) {
    throw new Error("rubric-review: artifactKind must be a non-empty string");
  }
  const examples: ReferenceExample[] = Array.isArray(input.referenceExamples) ? input.referenceExamples : [];
  const good = examples.filter((e) => e.label === "good").length;
  const mediocre = examples.filter((e) => e.label === "mediocre").length;
  const other = examples.filter((e) => e.label !== "good" && e.label !== "mediocre").length;
  if (other > 0) {
    throw new Error(
      `rubric-review: reference example labels must be "good" or "mediocre" (got ${other} with another label)`,
    );
  }
  if (good < 1 || mediocre < 1) {
    throw new Error(
      `rubric-review: referenceExamples must include at least one known-good and one known-mediocre example (got ${good} good, ${mediocre} mediocre) — a rubric cannot be judged in the abstract`,
    );
  }
  for (const e of examples) {
    const hasText = typeof e.text === "string";
    const hasFile = typeof e.file === "string";
    if (hasText === hasFile) {
      throw new Error("rubric-review: a reference example must carry text or file, not both and not neither");
    }
  }
}

/** Resolve the reference examples to text (file refs read with the
 * same exec-cat resolver as rubrics). */
export function resolveReferences(examples: ReferenceExample[]): ResolvedReference[] {
  // Plain for loop, NOT examples.map: a trap called from inside a
  // native-builtin callback (Array.prototype.map is C in QuickJS)
  // cannot suspend in dquickts — "TypeError: this call cannot be
  // suspended" (BRA-129). Direct calls and plain loops suspend fine.
  const out: ResolvedReference[] = [];
  for (const e of examples) {
    out.push({
      label: e.label,
      text: resolveTextBlob(typeof e.text === "string" ? e.text : { file: e.file as string }),
    });
  }
  return out;
}

// -------------------------------------------------------- workflow entry
/** The workflow: one JSON-capable input in, one JSON-capable output
 * out. The host generates a driver (global code) that calls this
 * with the input JSON; the C host captures the return value as the
 * run result. */
export default function rubricReview(input: RubricReviewInput): RubricReviewResult {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const maxLoops = input.maxLoops ?? MAX_LOOPS;
  validateReviewInput(input);

  const underReview = resolveTextRubric(input.rubric, threshold);
  const meta = resolveTextRubric(input.metaRubric ?? DEFAULT_META_RUBRIC, threshold);
  const references = resolveReferences(input.referenceExamples);
  print(`rubric under review: ${underReview.text.length} chars; ${references.length} reference example(s)`);

  const item: RubricText = {
    text: underReview.text,
    kind: "rubric",
    scope: renderScope(input.scope),
    artifactKind: input.artifactKind,
    references,
  };
  const loop: JudgeFixLoopResult<RubricText, TextRubric> = judgeFixLoop<RubricText, TextRubric>(
    item,
    meta,
    maxLoops,
  );
  print(
    `rubric review: ${loop.loops} loop(s), converged ${loop.converged}, final mean ${loop.lastAggregate?.meanScore ?? 0}`,
  );
  for (const v of loop.lastVerdicts) {
    print(`final verdict: score ${v.score} — ${v.openFeedback ?? ""}`);
  }
  return {
    rubric: loop.item.text,
    loops: loop.loops,
    converged: loop.converged,
    finalMeanScore: loop.lastAggregate?.meanScore ?? 0,
    lastVerdicts: loop.lastVerdicts,
  };
}
