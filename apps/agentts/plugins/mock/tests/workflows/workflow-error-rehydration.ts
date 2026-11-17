declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface ScoreInput {
  op: string;
  value?: number;
}

interface ScoreResult {
  score: number;
  label: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  try {
    trap<ScoreInput, ScoreResult>("job", { op: "score", value: 7 });
    print("ERROR: first trap did not throw");
  } catch (e) {
    print("caught is Error:", e instanceof Error);
    print("caught:", (e as Error).name + ": " + (e as Error).message);
  }

  try {
    trap<ScoreInput, ScoreResult>("job", { op: "score", value: 3 });
    print("ERROR: second trap did not throw");
  } catch (e) {
    print("plain is Error:", e instanceof Error);
    print("plain:", String(e));
  }

  print("done");
  return { done: true };
}
