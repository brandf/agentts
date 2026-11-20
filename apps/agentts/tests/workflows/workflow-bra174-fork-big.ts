// BRA-174 test workflow: one all() branch returns a >1MB string.
// The C host prints each branch outcome on its stdout as
// `branch <i> outcome: <json>` (durablets.c write_outcome), and the
// host reads it back from the child's captured stdout
// (host.ts branchOutcome via runHost). With the default ~1MB
// spawnSync stdout cap the branch run's spawn fails ENOBUFS on
// un-fixed code, so the whole run dies with "host spawn failed".
import { sleep, all } from "../../src/agentts";

export interface ForkBigInput {
  /** Bytes in the branch's returned string (2,000,000 in the test). */
  size: number;
}
export interface ForkBigResult {
  parts: string[];
  totalLen: number;
}

function branch(size: number): string {
  sleep({ ms: 0 });
  return "x".repeat(size);
}

export default function run(input: ForkBigInput): ForkBigResult {
  const outcomes = all([() => branch(input.size)]);
  const parts: string[] = [];
  for (const o of outcomes) {
    if (!o.ok) throw new Error(`branch failed: ${JSON.stringify(o.error)}`);
    parts.push(o.value as string);
  }
  return { parts, totalLen: parts.reduce((n, p) => n + p.length, 0) };
}
