// Rubric-review probe workflow (tests/test-rubric-review.ts).
//
// Drives workflows/library/rubric-review.ts under the Host in each
// mode, so the test can assert on run results and journals without
// submitting through the CLI:
//
// - "resolve-inline": resolve an inline rubric text, return it.
// - "resolve-file": resolve a rubric file reference, return its text.
// - "resolve-missing": resolve a missing file — the run fails loudly.
// - "review": run rubricReview with the caller-supplied rubric
//   (inline text or file), scope, artifact kind, reference examples,
//   meta-rubric file, threshold, and maxLoops.
// - "rubric-update-text": run the rubric-update job with a text
//   rubric (the meta-rubric shape) — v0 returns it unchanged.
import { resolveTextRubric, type TextRubricInput } from "../../workflows/library/judge-fix-loop";
import rubricReview, {
  type ReferenceExample,
  type RubricReviewInput,
  type RubricReviewResult,
  type ScopeDefinition,
} from "../../workflows/library/rubric-review";

// Types used as generic arguments must be exported from this file
// (BRA-106: the specialization alias imports them by name).
export type { ScopeDefinition } from "../../workflows/library/rubric-review";

export interface ProbeInput {
  mode: "resolve-inline" | "resolve-file" | "resolve-missing" | "review";
  rubricText?: string;
  rubricFile?: string;
  metaRubricFile?: string;
  threshold?: number;
  maxLoops?: number;
  scope?: ScopeDefinition;
  artifactKind?: string;
  goodExample?: string;
  mediocreExample?: string;
  goodExampleFile?: string;
  mediocreExampleFile?: string;
  omitMediocre?: boolean;
  bothExampleForms?: boolean;
  badLabel?: boolean;
}

export interface ProbeResult {
  mode: string;
  resolvedText?: string;
  review?: RubricReviewResult;
}

export default function probe(input: ProbeInput): ProbeResult {
  if (input.mode === "resolve-inline" || input.mode === "resolve-file" || input.mode === "resolve-missing") {
    const ref: TextRubricInput =
      typeof input.rubricText === "string" ? input.rubricText : { file: input.rubricFile as string };
    const resolved = resolveTextRubric(ref, input.threshold ?? 0.8);
    return { mode: input.mode, resolvedText: resolved.text };
  }
  // "review".
  const rubric: TextRubricInput =
    typeof input.rubricText === "string" ? input.rubricText : { file: input.rubricFile as string };
  const examples: ReferenceExample[] = [];
  if (typeof input.goodExampleFile === "string") {
    examples.push({ label: "good", file: input.goodExampleFile });
  } else if (typeof input.goodExample === "string") {
    examples.push({
      label: "good",
      ...(input.bothExampleForms
        ? { text: input.goodExample, file: "/nonexistent-both-forms.txt" }
        : { text: input.goodExample }),
    });
  }
  if (!input.omitMediocre && typeof input.mediocreExampleFile === "string") {
    examples.push({ label: "mediocre", file: input.mediocreExampleFile });
  } else if (!input.omitMediocre && typeof input.mediocreExample === "string") {
    examples.push({ label: "mediocre", text: input.mediocreExample });
  }
  if (input.badLabel) {
    // A label outside good/mediocre — the workflow must fail loudly.
    // (Cast: the wire type is the label union; the runtime value is
    // what the validation reads.)
    examples.push({ label: "weird" as "good", text: "A neither-good-nor-mediocre example." });
  }
  const reviewInput: RubricReviewInput = {
    rubric,
    threshold: input.threshold ?? 0.8,
    scope: input.scope as ScopeDefinition,
    artifactKind: input.artifactKind ?? "test artifact",
    referenceExamples: examples,
    ...(input.metaRubricFile ? { metaRubric: { file: input.metaRubricFile } } : {}),
    ...(input.maxLoops !== undefined ? { maxLoops: input.maxLoops } : {}),
  };
  return { mode: input.mode, review: rubricReview(reviewInput) };
}
