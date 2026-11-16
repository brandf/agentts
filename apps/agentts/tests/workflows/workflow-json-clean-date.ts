// JSON-clean ordering (BRA-45/46, mock-only): the test queues a bad
// first answer (score is a string) and configures a repair handler
// that returns a value containing a Date. The Date is the ONE
// sanctioned conversion: the JSON-clean check converts it to an ISO
// string FIRST, and only then does schema validation run against the
// converted value (at must be a string — it would fail unconverted).
// The workflow must receive the ISO string.

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface JobInput {
  op: string;
  value?: number;
}
interface DatedResult {
  score: number;
  label: string;
  at: string;
}

const r = trap<JobInput, DatedResult>("job", { op: "score", value: 7 }) as DatedResult;
print("job:", JSON.stringify(r));
print("done");
