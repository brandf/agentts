// Entry-guard fixture: a trap call at TOP LEVEL (outside the entry
// function) must fail the run with a clear error naming the trap and
// that it must be called under the workflow function. The file HAS
// an exported entry function (so the gate passes — the gate is the
// file-shape companion, not the enforcement for this rule); the
// runtime stack check is the enforcement. A trap call under the
// entry function works (see the other fixtures).
import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface StepInput {
  value: number;
}

interface StepResult {
  score: number;
  label: string;
}

// TOP-LEVEL trap call (not under the entry function) — must throw.
const topLevel = job<StepInput, StepResult>({ spec: "score", input: { value: 7 } });
print("top-level:", JSON.stringify(topLevel));

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  print("entry ran");
  return { done: true };
}
