// JSON-clean rejections (BRA-45/46, mock-only): the test queues five
// job answers that are not clean JSON data. Each must fail the
// JSON-clean check FIRST (before schema validation) with a precise
// error — path, what it was, what to do — thrown at the call site as
// a ValidationError and journaled with phase "json-clean". No repair
// handler is configured, so each failure throws at once.

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

  attempt(1); // undefined score
  attempt(2); // NaN score
  attempt(3); // circular reference
  attempt(4); // Map as the whole result
  attempt(5); // class instance as the whole result
  print("done");
  return { done: true };
}
