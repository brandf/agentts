// Gate hold (BRA-45, mock-only): the mock plugin holds a gate open
// until the test delivers an answer — the week-long gate in miniature.
// Run with gates:"hold": the drive stops at the gate (run stays
// suspended, registry holds it); deliverGate answers it and the run
// completes.

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface GateInput {
  question: string;
}
interface GateResult {
  answer: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const g = trap<GateInput, GateResult>("gate", { question: "approve?" }) as GateResult;
  print("answer:", JSON.stringify(g));
  print("done");
  return { done: true };
}
