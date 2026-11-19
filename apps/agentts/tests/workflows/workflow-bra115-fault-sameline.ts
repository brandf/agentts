import { sleep } from "../../src/agentts";

/**
 * BRA-115 fault probe: same-line identity ambiguity.
 *
 * Two anonymous arrow functions share a definition line, so their
 * converter identity (file, name, def line) collides. The converter
 * must refuse loudly rather than pick one.
 */
export interface FaultSameLineOutput {
  total: number;
}

export default function run(): FaultSameLineOutput {
  sleep({ ms: 50 });
  const a = (n: number): number => n + 1, b = (n: number): number => n + 2;
  return { total: a(1) + b(1) };
}
