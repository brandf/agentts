// Straight-through reference for workflow-failfast.ts: the same thunk
// bodies, run directly with no combinator. failFast() models the bool:
// run in order, first throw escapes, the rest never run; on success it
// returns bare values. The parent output must be byte-identical to the
// fork version's.

interface StepInput {
  op: string;
  value?: number;
  verdicts?: unknown;
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
declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  // step() is a thin wrapper over the trap builtin: trap("job", input).
  function step(input: StepInput): StepResult { return trap("job", input) as StepResult; }

  function judgePath(x: number): string {
    const a = step({ op: "score", value: x }) as StepResult;
    if (x === 5) throw new Error("judge crashed");
    if (x === 9) throw new Error("judge timed out");
    const b = step({ op: "verify", value: x }) as StepResult;
    return a.label + "/" + b.label;
  }

  function failFast(fs: (() => string)[]): string[] {
    const out: string[] = [];
    for (const f of fs) out.push(f());
    return out;
  }

  function runBranch(f: () => string): Outcome {
    try {
      return { ok: true, value: f() };
    } catch (e) {
      const err = e as Error;
      return { ok: false, error: { name: err.name, message: err.message } };
    }
  }

  const values = failFast([() => judgePath(7), () => judgePath(3)]);
  print("values:", JSON.stringify(values));

  const collected = [runBranch(() => judgePath(7)), runBranch(() => judgePath(5))];
  print("collected false:", JSON.stringify(collected));

  let caught = "";
  try {
    failFast([() => judgePath(7), () => judgePath(5), () => judgePath(3)]);
  } catch (e) {
    caught = (e as Error).message;
    print("caught is Error:", e instanceof Error);
  } finally {
    print("finally ran");
  }
  print("caught:", caught);
  const resumed = step({ op: "score", value: 11 }) as StepResult;
  print("continued:", JSON.stringify(resumed));

  let first = "";
  try {
    failFast([() => judgePath(7), () => judgePath(9), () => judgePath(5)]);
  } catch (e) {
    first = (e as Error).message;
  }
  print("first failure:", first);
  return { done: true };
}
