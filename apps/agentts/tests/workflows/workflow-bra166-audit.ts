// BRA-166 audit probe workflow: one sleep trap, duration from input.
// The audit groups runs by workflow path, so the same file run with
// different sleepMs values is the same workflow getting slower or
// faster — the shape a regression takes. Used by tests/test-bra166.ts
// (integration + e2e: seed a baseline fast, then regress slow).
import { sleep } from "../../src/agentts";

export interface RunInput {
  sleepMs: number;
}

export interface RunResult {
  sleptMs: number;
}

export default function run(input: RunInput): RunResult {
  const s = sleep({ ms: input.sleepMs });
  return { sleptMs: s.sleptMs };
}
