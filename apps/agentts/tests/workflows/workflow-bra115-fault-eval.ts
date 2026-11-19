import { sleep } from "../../src/agentts";

/**
 * BRA-115 fault probe: eval'd function.
 *
 * The eval'd function has no source file — the converter must refuse
 * loudly (missing source) rather than guess or skip it.
 */
export interface FaultEvalOutput {
  value: number;
}

export default function run(): FaultEvalOutput {
  const f = eval("(n) => n + 1") as (n: number) => number;
  sleep({ ms: 50 });
  return { value: f(41) };
}
