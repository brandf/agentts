// BRA-76 test workflow: N sequential sleep traps (each suspends the
// run once, so N sleeps need N drive rounds). 50 sleeps complete
// under the 50-round drive cap; 51+ hit it. Sleep is host-owned and
// the clock is virtual, so each trap resolves instantly.
import { sleep } from "../../src/agentts";

export interface ManySleepsInput {
  count: number;
}
export interface ManySleepsResult {
  sleeps: number;
}

export default function run(input: ManySleepsInput): ManySleepsResult {
  let n = 0;
  for (let i = 0; i < input.count; i++) {
    sleep({ ms: 0 });
    n++;
  }
  return { sleeps: n };
}
