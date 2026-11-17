// BRA-90 heap shape: many small allocations. __COUNT__ small objects
// ({i, v} with a 20-char string, ~50 B each in the heap) held in an
// array across __SUSPENSIONS__ sleep traps; each suspension rewrites
// the `v` field of __CHANGES__ objects (1 = few-change: delta output
// tiny but write work still re-serializes every cell; __CHANGES__ =
// half the objects = many-change: delta output large too). The
// mechanism under test (quickjs-snapshot.c snap_write_body): a delta
// re-serializes EVERY cell and memcmps it against the stored base
// body — no dirty tracking — so write work is O(heap cells), not
// O(changed bytes). Compare with shape-string.ts at the same total
// bytes (full snapshot size is the ground truth for "equal bytes").
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { count: number; changed: number } {
  const objs: Array<{ i: number; v: string }> = [];
  for (let i = 0; i < __COUNT__; i++) objs.push({ i, v: "x".repeat(20) });
  let changed = 0;
  for (let s = 0; s < __SUSPENSIONS__; s++) {
    for (let k = 0; k < __CHANGES__; k++) {
      const o = objs[(s * __CHANGES__ + k) % objs.length];
      o.v = "y".repeat(20);
      changed++;
    }
    trap("sleep", { ms: 0 });
  }
  print("count:", objs.length, "changed:", changed);
  return { count: objs.length, changed };
}
