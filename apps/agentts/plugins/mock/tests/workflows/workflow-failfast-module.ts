interface JobInput {
  value?: number;
  verdicts?: Outcome<string>[];
}

interface StepResult {
  score: number;
  label: string;
}

import { job, all, type Outcome } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function judgePath(x: number): string {
    const a = job<JobInput, StepResult>({ spec: "score", input: { value: x } });
    if (x === 5) throw new Error("judge crashed");
    if (x === 9) throw new Error("judge timed out");
    const b = job<JobInput, StepResult>({ spec: "verify", input: { value: x } });
    return a.label + "/" + b.label;
  }

  const values = all([() => judgePath(7), () => judgePath(3)], true);

  print("values:", JSON.stringify(values));

  const collected = all([() => judgePath(7), () => judgePath(5)], false);

  print("collected false:", JSON.stringify(collected));

  let caught = "";

  try {
    all([() => judgePath(7), () => judgePath(5), () => judgePath(3)], true);
  } catch (e) {
    caught = (e as Error).message;
    print("caught is Error:", e instanceof Error);
  } finally {
    print("finally ran");
  }

  print("caught:", caught);

  const resumed = job<JobInput, StepResult>({ spec: "score", input: { value: 11 } });

  print("continued:", JSON.stringify(resumed));

  let first = "";

  try {
    all([() => judgePath(7), () => judgePath(9), () => judgePath(5)], true);
  } catch (e) {
    first = (e as Error).message;
  }

  print("first failure:", first);
  return { done: true };
}
