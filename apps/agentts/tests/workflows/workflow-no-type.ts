// Negative extraction fixture (BRA-46): a trap call with NO type
// arguments. The host must FAIL LOUDLY at first run — before any
// spawn — not silently run it unvalidated. This file must never
// execute; startRun must throw ExtractionError naming the site.

declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

const r = trap("job", { op: "score", value: 7 });
print("got:", JSON.stringify(r));
