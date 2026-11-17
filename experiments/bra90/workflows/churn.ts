// BRA-90 worst-case workload: whole-heap churn between traps.
// A ~20 KB document is REPLACED in full by each "rewrite" trap result
// (six rewrites). The live heap stays ~20 KB, but almost none of it
// survives from one suspension to the next, so a delta should approach
// full-snapshot size. This bounds the "complexity buys nothing" case
// from the issue's decision criteria.
// Suspensions: 6.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface RewriteResult {
  text: string;
}

export default function run(): { rewrites: number; docChars: number } {
  let doc = "seed document\n";
  for (let i = 0; i < 6; i++) {
    const r = trap("job", { op: "rewrite", i: i }) as RewriteResult;
    doc = r.text;
  }
  print("rewrites: 6 doc-chars:", doc.length, "head:", doc.slice(0, 16));
  return { rewrites: 6, docChars: doc.length };
}
