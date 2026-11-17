// Bench workflow: snapshot size/latency vs live-heap size (BRA-93).
// Holds a live string of `sizeKb` kilobytes across a single sleep trap
// (virtual clock: the sleep resolves instantly, so the measured time is
// the suspension/resume machinery, not the wait). The string is built
// from a repeated pattern so its content is deterministic; the snapshot
// must carry it live across the suspension.
import { sleep } from "../../src/agentts";

export interface BenchSnapInput {
  sizeKb: number;
}
export interface BenchSnapOutput {
  sizeKb: number;
  len: number;
}

export default function run(input: BenchSnapInput): BenchSnapOutput {
  const chunk = "abcdefgh".repeat(128); // 1 KB
  let s = "";
  for (let i = 0; i < input.sizeKb; i++) s += chunk;
  sleep({ ms: 1 });
  return { sizeKb: input.sizeKb, len: s.length };
}
