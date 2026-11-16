// Checker fixture (BRA-29): wiring mismatch through a JSON
// round-trip. JSON.parse(JSON.stringify(s)) has type `any`, so tsc
// passes; the checker traces the origin through the round-trip and
// refuses it on the schemas. The value sits inside the verdicts
// array so the diagnostic names the missing required property
// (`notes`), not just the array/object shape.

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
  input: { item: "x", verdicts: [JSON.parse(JSON.stringify(s))] },
});
print("fixed:", JSON.stringify(fixed));
print("done");
