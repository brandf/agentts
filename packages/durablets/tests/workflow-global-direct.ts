// Straight-through reference for workflow-global.ts. The reference models
// the discard rule explicitly: runBranch saves sharedCount before a branch
// and restores it afterwards, so a branch's write cannot leak into the
// parent — a naive sequential run would leave sharedCount at 99, which is
// exactly the difference the rule exists to prevent.

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

declare function trap(type: string, arg: unknown): unknown;
// step() is a thin wrapper over the trap builtin: trap("job", input).
function step(input: StepInput): StepResult { return trap("job", input) as StepResult; }
declare function print(...args: unknown[]): void;

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

function runBranch(f: () => string): Outcome {
  const saved = sharedCount;
  try {
    const v = f();
    sharedCount = saved;
    return { ok: true, value: v };
  } catch (e) {
    sharedCount = saved;
    const err = e as Error;
    return { ok: false, error: { name: err.name, message: err.message } };
  }
}

const verdicts = [runBranch(() => readBranch(21)), runBranch(() => writeBranch(22)), runBranch(() => readBranch(23))];
print("verdicts:", JSON.stringify(verdicts));
print("empty all:", JSON.stringify([]));
print("sharedCount after join:", sharedCount);
