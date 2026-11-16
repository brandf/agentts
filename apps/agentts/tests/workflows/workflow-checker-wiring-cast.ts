// Checker fixture (BRA-29): wiring mismatch through an `as` cast.
// Same shape as workflow-checker-wiring-any, but the score result
// is cast to JudgeVerdict (inside the verdicts array) instead of
// flowing through `any`. tsc passes (the cast is legal via
// unknown); the checker traces the origin through the cast and
// refuses it on the schemas.

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
}
interface ScoreResult {
  score: number;
  label: string;
}
interface JudgeVerdict {
  score: number;
  label: string;
  notes: string;
}
interface FixInput {
  item: string;
  verdicts: JudgeVerdict[];
}
interface WorkItem {
  text: string;
}

const s = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
const fixed = job<FixInput, WorkItem>({
  spec: "fix",
  input: { item: "x", verdicts: [s as unknown as JudgeVerdict] },
});
print("fixed:", JSON.stringify(fixed));
print("done");
