declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface JobInput {
  op: string;
  value?: number;
}

interface JobResult {
  score: number;
  label: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function attempt(n: number): void {
    try {
      const r = trap<JobInput, JobResult>("job", { op: "score", value: 7 }) as JobResult;
      print(`caught ${n}: ERROR accepted:`, JSON.stringify(r));
    } catch (e) {
      print(`caught ${n}:`, (e as Error).name + ": " + (e as Error).message);
    }
  }

  attempt(1);

  attempt(2);

  attempt(3);

  attempt(4);

  attempt(5);

  print("done");
  return { done: true };
}
