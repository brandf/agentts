// BRA-72 test workflow: a single exec trap that appends a marker
// to a file, sleeps, then returns. The marker file counts
// executions: a crash DURING dispatch re-runs the command (the
// duplicate is visible in the journal per BRA-75, not silent), so
// the test asserts completion and the repair report — not the marker
// count — except where it documents the re-run.
import { exec } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ExecInput {
  markerFile: string;
  sleepMs: number;
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
      `echo bra72-exec >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`,
    ],
  });
  print("exec:", r.stdout.trim());
  return { stdout: r.stdout, exitCode: r.exitCode };
}
