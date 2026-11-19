import { sleep } from "../../src/agentts";

/**
 * BRA-115 probe workflow: suspends at a short sleep, then exercises
 * a `false` literal in the resumed code.
 *
 * The prototype NEW engine swaps OP_push_false/OP_push_true (both
 * size 1, fmt none) and bumps BC_VERSION 7 -> 8. An UNCONVERTED old
 * snapshot resumed under it would decode the `false` literal as
 * `true` and return verdict "WRONG"; a correctly converted snapshot
 * returns "RIGHT" with total 7. The verdict is the discriminator
 * that proves the converter (not the engine's refusal) did the work.
 *
 * Also exercises a closure (captured `base`) and a nested call, so
 * the snapshot carries cpool entries and closure vars to re-link,
 * and a frame whose pc must be remapped (the sleep call site).
 */
export interface ProbeOutput {
  verdict: string;
  total: number;
}

function check(flag: boolean): string {
  return flag ? "WRONG" : "RIGHT";
}

export default function run(): ProbeOutput {
  sleep({ ms: 50 });
  const base = 3;
  const add = (n: number): number => base + n;
  const flag = false;
  const verdict = check(flag);
  return { verdict, total: add(4) };
}
