// BRA-90 heap shape / pinning: grow, then drop. Builds __COUNT__
// small objects (~500 KB live), suspends once (base pins them),
// then drops the array (live heap collapses to ~nothing) and suspends
// __SUSPENSIONS__ more times on sleep traps. In pure-delta mode the
// old base keeps the dead objects pinned: stored bytes stay ~500 KB
// (base + tiny deltas) and a load of the post-drop checkpoint restores
// all base cells, so the loaded runtime's RSS still carries the dead
// heap. A keyframe after the drop writes a small new base and lets the
// dead cells go. The workload that shows keyframes bounding the
// pinned set, not just delta size.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { dropped: number } {
  let objs: Array<{ i: number; v: string }> = [];
  for (let i = 0; i < __COUNT__; i++) objs.push({ i, v: "x".repeat(20) });
  trap("sleep", { ms: 0 });
  const dropped = objs.length;
  objs = [];
  for (let s = 0; s < __SUSPENSIONS__; s++) trap("sleep", { ms: 0 });
  print("dropped:", dropped, "live-now:", objs.length);
  return { dropped };
}
