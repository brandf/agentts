// Sync-looking workflow: step() is an ordinary synchronous call.
// No await, no promise, no determinism rule — the engine suspends the
// run inside step() and resumes it when the result arrives.

interface StepInput {
  op: string;
  value: number;
}

interface StepResult {
  score: number;
  label: string;
}

declare function step(input: StepInput): StepResult;
declare function print(...args: unknown[]): void;

function judge(score: number): string {
  if (score >= 0.9) return "ship";
  if (score >= 0.5) return "revise";
  return "reject";
}

function runWorkflow(): string {
  const a = step({ op: "score", value: 7 });
  print("step 1 ->", JSON.stringify(a));
  const b = step({ op: "score", value: 3 });
  print("step 2 ->", JSON.stringify(b));
  const verdict = judge(a.score) + "/" + judge(b.score);
  print("verdict:", verdict);
  return verdict;
}

runWorkflow();
