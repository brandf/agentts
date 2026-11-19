import { sleep } from "../../src/agentts";

/**
 * BRA-115 fault probe: delta checkpoint.
 *
 * Sleeps twice. After the first suspension (base checkpoint) and a
 * resume, the second suspension writes a DELTA checkpoint. The
 * converter only handles base checkpoints and must refuse a delta.
 */
export interface FaultDeltaOutput {
  done: boolean;
}

export default function run(): FaultDeltaOutput {
  sleep({ ms: 50 });
  sleep({ ms: 60000 });
  return { done: true };
}
