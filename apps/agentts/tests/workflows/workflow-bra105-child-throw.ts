// Child workflow for BRA-105 S3: throws. The parent must see the
// failure loudly at the call site — never a silent drop.

export interface Bra105ThrowChildInput {
  n: number;
}

export interface Bra105ThrowChildOutput {
  doubled: number;
}

export default function run(input: Bra105ThrowChildInput): Bra105ThrowChildOutput {
  if (input.n === 0) throw new Error("boom from child");
  return { doubled: input.n * 2 };
}
