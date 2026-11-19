// Grandchild workflow for BRA-105 S4: pure computation, the bottom
// of the nested run/call chain.

export interface Bra105GrandchildInput {
  word: string;
}

export interface Bra105GrandchildOutput {
  deep: string;
}

export default function run(input: Bra105GrandchildInput): Bra105GrandchildOutput {
  return { deep: `grandchild:${input.word}` };
}
