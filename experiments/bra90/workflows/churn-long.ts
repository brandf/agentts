// BRA-90 keyframes: whole-heap churn, long chain. A ~20 KB document
// is REPLACED in full by each "rewrite" trap result (__SUSPENSIONS__
// rewrites). The live heap stays ~20 KB but almost none of it
// survives, so deltas sit flat at ~59% of full and the 75% ratio rule
// never fires — only the interval trigger can keyframe, and keyframes
// do not shrink the deltas (the new base holds the new doc, the next
// delta is still a full replacement). Bounds the "keyframes help
// everywhere" claim.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface RewriteResult { text: string; }

export default function run(): { rewrites: number; docChars: number } {
  let doc = "seed document\n";
  for (let i = 0; i < __SUSPENSIONS__; i++) {
    const r = trap("job", { op: "rewrite", i: i }) as RewriteResult;
    doc = r.text;
  }
  print("rewrites:", __SUSPENSIONS__, "doc-chars:", doc.length, "head:", doc.slice(0, 16));
  return { rewrites: __SUSPENSIONS__, docChars: doc.length };
}
