// BRA-110 test workflow: fails deterministically with a loud error.
// The deliver proof (tests/test-bra110.ts) drives it to failed over
// HTTP and delivers it — the failed-run delivery must carry
// needsAttention: true and the error.
export interface FailInput {
  note: string;
}
export interface FailOutput {
  done: boolean;
}

export default function failWorkflow(input: FailInput): FailOutput {
  throw new Error(`bra110 deliberate failure: ${input.note}`);
}
