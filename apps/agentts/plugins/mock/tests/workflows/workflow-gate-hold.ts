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
