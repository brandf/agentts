// BRA-165 probe/e2e workflow: two exec traps + one sleep, no jobs,
// no gates. The direct adapter answers the execs for real; the
// sleep waits for real (50ms) under the real clock. Used by the
// BRA-165 pre-fix probe (no ledger existed then) and by
// tests/test-bra165.ts (the run must leave a ledger entry).
import { exec, sleep, type ExecResult } from "../../src/agentts";

export interface RunInput {}

export interface RunResult {
  echo: ExecResult;
  date: ExecResult;
  sleptMs: number;
}

export default function run(_input: RunInput): RunResult {
  const echo = exec({ cmd: "echo", args: ["bra165"] });
  const date = exec({ cmd: "date", args: ["+%s"] });
  const s = sleep({ ms: 50 });
  return { echo, date, sleptMs: s.sleptMs };
}
