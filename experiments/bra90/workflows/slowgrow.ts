// BRA-90 keyframes: slow accumulation. __SUSPENSIONS__ "note" traps,
// each returning ~512 B of notes appended to a live list. Heap growth
// ~0.5 KB per suspension, so the 75% ratio rule fires late (~90
// suspensions) and the interval trigger is what fires first at
// intervals 10/25/50 — the workload that separates the intervals.
declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface NoteResult { notes: string; }

export default function run(): { notes: number; chars: number } {
  const notes: string[] = [];
  for (let i = 0; i < __SUSPENSIONS__; i++) {
    const r = trap("job", { op: "note", i: i }) as NoteResult;
    notes.push(r.notes);
  }
  let chars = 0;
  for (const n of notes) chars += n.length;
  print("notes:", notes.length, "chars:", chars);
  return { notes: notes.length, chars };
}
