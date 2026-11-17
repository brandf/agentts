// BRA-83 test workflow: a sleep trap with a large live heap, so the
// snapshot the C host writes at suspension is megabytes, not
// kilobytes — the write is real work, and a kill landing inside it
// (via the test's fwrite-delay shim) leaves a genuinely torn tmp
// file. 0-arg, like the core reference workflows: the pad size is
// hardcoded.
import { sleep } from "../../src/agentts";

export interface RunResult {
  slept: number;
}

export default function run(): RunResult {
  // 8 MiB live in a global, so it rides along in the snapshot.
  (globalThis as any).__bra83pad = "x".repeat(8 * 1024 * 1024);
  const r = sleep({ ms: 60000 });
  return { slept: r.ms };
}
