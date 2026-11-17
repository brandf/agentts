// BRA-90 keyframes: stable heap, long chain. One 512 KB live string
// held across __SUSPENSIONS__ sleep traps; nothing changes between
// suspensions, so every delta is ~111 B and resume/load time should
// be flat vs chain length — the control that shows keyframing buys
// nothing when the heap does not grow (interval barely matters).
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

export default function run(): { len: number } {
  const live: string = "ab".repeat(512000 / 2);
  for (let i = 0; i < __SUSPENSIONS__; i++) trap("sleep", { ms: 0 });
  print("live-len:", live.length, "head:", live.slice(0, 8));
  return { len: live.length };
}
