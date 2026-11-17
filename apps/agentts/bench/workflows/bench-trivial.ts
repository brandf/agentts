// Bench workflow: fixed per-slice overhead (BRA-93). No traps at all:
// one C-host spawn + runtime init + eval + completion. The measured
// time is the floor every slice pays, before any trap work.
export interface BenchTrivialInput {
  n: number;
}
export interface BenchTrivialOutput {
  n: number;
}

export default function run(input: BenchTrivialInput): BenchTrivialOutput {
  let s = 0;
  for (let i = 0; i < input.n; i++) s += i;
  return { n: s };
}
