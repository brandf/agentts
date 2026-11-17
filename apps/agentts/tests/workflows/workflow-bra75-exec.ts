// BRA-75 test workflow: a single exec trap that appends a marker
// to a file, sleeps, then returns. The marker file counts
// executions: a crash AFTER dispatch must leave exactly one marker
// (the recorded result is delivered, no re-run); a crash DURING
// dispatch re-runs the command and the journal must show the
// re-dispatch (two trap-dispatch events, the second redispatched)
// — the duplicate is visible, not silent.
import { exec } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ExecInput {
  markerFile: string;
  sleepMs: number;
}
interface ExecResult {
  stdout: string;
  exitCode: number;
}
export interface RunResult {
  stdout: string;
  exitCode: number;
}

export default function run(input: ExecInput): RunResult {
  const r = exec({
    cmd: "sh",
    args: [
      "-c",
      `echo bra75-exec >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`,
    ],
  });
  print("exec:", r.stdout.trim());
  return { stdout: r.stdout, exitCode: r.exitCode };
}
