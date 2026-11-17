// Checker fixture (BRA-29): wiring mismatch through an `any`
// intermediary. The score job's result (ScoreResult) is stored in
// an `any` variable and passed as one element of the fix job's
// `verdicts` (JudgeVerdict[]). tsc passes — `any` is assignable to
// anything — but the value's ORIGIN is the score job, and its
// output schema (score, label) lacks the `notes` the fix input
// requires. The M2 checker must refuse it, naming the producer
// (job:score) and the consumer (job:fix) sites.

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

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const s = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
  const sAny: any = s;
  const fixed = job<FixInput, WorkItem>({ spec: "fix", input: { item: "x", verdicts: [sAny] } });
  print("fixed:", JSON.stringify(fixed));
  print("done");
  return { done: true };
}
