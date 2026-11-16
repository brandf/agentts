// Global-state rule (Q13): branches may READ shared state — every branch
// sees the same fork-time snapshot — but must NOT write it. Branch 1
// writes sharedCount in its own heap copy; the write must be discarded
// by construction, so the parent's sharedCount is still 0 after the join.
// Also exercises all([]), which returns [] with no fork and no suspension.

interface StepInput {
  op: string;
  value?: number;
}

interface StepResult {
  score: number;
  label: string;
}

interface Outcome {
  ok: boolean;
  value?: string;
  error?: { name: string; message: string };
}

declare function step(input: StepInput): StepResult;
declare function print(...args: unknown[]): void;
declare function all(thunks: (() => string)[]): Outcome[];

let sharedCount = 0;

function readBranch(x: number): string {
  step({ op: "score", value: x });
  return "read:" + sharedCount;
}

function writeBranch(x: number): string {
  step({ op: "score", value: x });
  sharedCount = 99;
  return "read:" + sharedCount;
}

const verdicts = all([() => readBranch(21), () => writeBranch(22), () => readBranch(23)]);
print("verdicts:", JSON.stringify(verdicts));
print("empty all:", JSON.stringify(all([])));
print("sharedCount after join:", sharedCount);
