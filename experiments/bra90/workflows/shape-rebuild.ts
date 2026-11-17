// BRA-90 heap shape: rebuilt aggregate. One 150 KB string held live;
// each suspension appends ~600 B with `+=`, which REBUILDS the whole
// string (a new cell each suspension). The delta after a keyframe
// therefore carries the whole ~150 KB aggregate, not the ~600 B of
// growth — the delta floor for rebuild-pattern workloads. Controlled
// pair with shape-append.ts (same bytes, same growth, array append).
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { len: number } {
  let agg = "a".repeat(150000);
  for (let i = 0; i < __SUSPENSIONS__; i++) {
    agg += "b".repeat(600);
    trap("sleep", { ms: 0 });
  }
  print("agg-len:", agg.length);
  return { len: agg.length };
}
