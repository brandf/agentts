// BRA-90 heap shape: appended aggregate. The same ~150 KB + ~600 B
// per suspension as shape-rebuild.ts, but the aggregate is an ARRAY of
// chunk strings (.push per suspension) instead of one rebuilt string.
// After a keyframe the delta falls to ~growth-since-keyframe. Controlled
// pair with shape-rebuild.ts: the difference isolates the rebuild
// pattern as the cause of the delta floor.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { parts: number; total: number } {
  const parts: string[] = ["a".repeat(150000)];
  let total = 150000;
  for (let i = 0; i < __SUSPENSIONS__; i++) {
    const chunk = "b".repeat(600);
    parts.push(chunk);
    total += 600;
    trap("sleep", { ms: 0 });
  }
  print("parts:", parts.length, "total:", total);
  return { parts: parts.length, total };
}
