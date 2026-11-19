// BRA-90 test workflow: the ratio rule. A string grows by a small
// first chunk (so the ordinal-0 base stays ~15 KB) and then by a
// large chunk per suspension. The second delta (~100 KB vs a ~16 KB
// base) exceeds 75% of the estimated full snapshot, so the
// keyframe rule must fire at ordinal 2 — before the interval (25)
// would. Returns the final string length, so the test can prove the
// run completed with the right state after the rebase.
import { sleep } from "../../src/agentts";

export interface AccumulateInput {
  count: number;
  firstChunk: number;
  chunk: number;
}
export interface AccumulateResult {
  length: number;
}

export default function run(input: AccumulateInput): AccumulateResult {
  let s = "";
  s += "x".repeat(input.firstChunk);
  sleep({ ms: 0 });
  for (let i = 1; i < input.count; i++) {
    s += "y".repeat(input.chunk);
    sleep({ ms: 0 });
  }
  return { length: s.length };
}
