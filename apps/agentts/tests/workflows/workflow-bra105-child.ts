// Child workflow for BRA-105 S1: pure computation, no traps.
// Takes { n } and returns its double with a label.

declare function print(...args: unknown[]): void;

export interface Bra105ChildInput {
  n: number;
}

export interface Bra105ChildOutput {
  doubled: number;
  label: string;
}

export default function run(input: Bra105ChildInput): Bra105ChildOutput {
  const doubled = input.n * 2;
  print("child doubled:", doubled);
  return { doubled, label: `n=${input.n}` };
}
