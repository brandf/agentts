// Async-await workflow: the same step, awaited — except that does NOT
// work with the sync-suspending builtin: `await step(input)` throws
// "TypeError: this call cannot be suspended", because an async frame is
// not suspendable. So the async variant uses stepAsync(), the
// promise-based builtin: it returns a promise, the workflow parks on
// the await between jobs, and the host completes the promise after
// restoring the snapshot. Same workflow shape otherwise, so the two
// variants are directly comparable.

interface StepInput {
  op: string;
  value: number;
}

interface StepResult {
  score: number;
  label: string;
}

declare function stepAsync(input: StepInput): Promise<StepResult>;
declare function print(...args: unknown[]): void;

function judge(score: number): string {
  if (score >= 0.9) return "ship";
  if (score >= 0.5) return "revise";
  return "reject";
}

async function runWorkflow(): Promise<string> {
  const a = await stepAsync({ op: "score", value: 7 });
  print("step 1 ->", JSON.stringify(a));
  const b = await stepAsync({ op: "score", value: 3 });
  print("step 2 ->", JSON.stringify(b));
  const verdict = judge(a.score) + "/" + judge(b.score);
  print("verdict:", verdict);
  return verdict;
}

runWorkflow().then((v) => print("workflow done:", v));
