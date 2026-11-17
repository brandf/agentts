// BRA-90 control workload: reproduces the issue's synthetic measurement.
// A single live string of SIZE_BYTES is held across three sleep traps.
// The string content is deterministic ("ab" repeated) so full-mode and
// delta-mode runs hold byte-identical heaps. SIZE_BYTES is substituted
// by the measurement harness before bundling (token __SIZE_BYTES__).
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { len: number } {
  const live: string = "ab".repeat(__SIZE_BYTES__ / 2);
  trap("sleep", { ms: 0 });
  trap("sleep", { ms: 0 });
  trap("sleep", { ms: 0 });
  print("live-len:", live.length, "head:", live.slice(0, 8));
  return { len: live.length };
}
