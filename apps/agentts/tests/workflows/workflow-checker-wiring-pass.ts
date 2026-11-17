// Checker fixture (BRA-29): wiring that must PASS. The judge
// result flows directly into the fix input — both as an array
// element (`verdicts: [v]`) and as a property access (`item:
// v.label`, a string into a string slot). The checker traces both
// edges and finds the schemas compatible.

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface JudgeInput {
  item: string;
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
  const v = job<JudgeInput, JudgeVerdict>({ spec: "judge", input: { item: "x" } });
  const fixed = job<FixInput, WorkItem>({
    spec: "fix",
    input: { item: v.label, verdicts: [v] },
  });
  print("fixed:", JSON.stringify(fixed));
  print("done");
  return { done: true };
}
