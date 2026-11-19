// Rubric-update probe workflow (tests/test-rubric-review.ts, section G).
//
// A separate file from workflow-rubric-review-probe.ts on purpose:
// the extractor enforces one contract per trap key within a
// workflow's closure, and the review probe's closure already carries
// the loop's `job:rubric-update` site (specialized to TextRubric).
// This probe carries its own extraction, so it can call the same
// spec with the concrete text-rubric input shape — the same pattern
// as phase-review.ts carrying its own JudgeFixLoop extraction.
//
// The shapes below are deliberately re-declared locally, NOT
// imported from the loop library: importing them would pull
// judge-fix-loop.ts (and its generic rubric-update trap site) into
// this file's extraction and conflict with the concrete call below.
//
// Mode "rubric-update-text": run the rubric-update job with a text
// rubric (the meta-rubric shape) — v0 returns it unchanged.
import { job } from "../../src/agentts";

/** A rubric as plain text plus the numeric threshold (mirrors
 * `TextRubric` in workflows/library/judge-fix-loop.ts). */
export interface TextRubric {
  text: string;
  threshold: number;
}

/** A judge verdict (mirrors `JudgeVerdict` in the loop library). */
export interface JudgeVerdict {
  score: number;
  label: string;
  notes: string;
  scores?: { criterion: string; score: number; reason: string }[];
  guidedAnswers?: { question: number; answer: string }[];
  openFeedback?: string;
}

/** Concrete rubric-update input for a text rubric — same fields as
 * `RubricUpdateInput<TextRubric>`, named locally for extraction. */
export interface TextRubricUpdateInput {
  rubric: TextRubric;
  verdicts: JudgeVerdict[];
}

export interface UpdateProbeInput {
  rubricText?: string;
  threshold?: number;
}

export interface UpdateProbeResult {
  rubricUpdate?: TextRubric;
}

export default function probe(input: UpdateProbeInput): UpdateProbeResult {
  const rubric: TextRubric = { text: input.rubricText ?? "", threshold: input.threshold ?? 0.8 };
  const verdicts = [{ score: 0, label: "weak", notes: "coverage: missing; discrimination: missing" }];
  const updated = job<TextRubricUpdateInput, TextRubric>({
    spec: "rubric-update",
    input: { rubric, verdicts },
  });
  return { rubricUpdate: updated };
}
