// BRA-90 heap shape: one big allocation. A single live string of
// __BYTES__ bytes held across __SUSPENSIONS__ sleep traps; each
// suspension appends one character to a small log (a tiny change).
// Delta-write work here is one cell serialization + one memcmp of a
// big body — the low-cell-count end of the shape axis. Compare with
// shape-objects.ts at the same total bytes.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { len: number; logLen: number } {
  const live: string = "ab".repeat(__BYTES__ / 2);
  let log = "";
  for (let i = 0; i < __SUSPENSIONS__; i++) {
    log += "x";
    trap("sleep", { ms: 0 });
  }
  print("live-len:", live.length, "log-len:", log.length);
  return { len: live.length, logLen: log.length };
}
