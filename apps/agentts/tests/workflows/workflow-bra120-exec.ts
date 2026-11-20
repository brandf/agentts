// BRA-120 test workflow: three exec traps under the mock adapter.
// - `ls` (not cat, not `echo hi`) is canned: the mock returns the
//   simulated {stdout: "", exitCode: 0} without running it.
// - `cat` reads the input file for real.
// - `echo hi` returns "hi\n" (the mock's one canned literal that
//   behaves like a real command).
import { exec, type ExecResult } from "../../src/agentts";

export interface RunInput {
  file: string;
}

export interface RunResult {
  canned: ExecResult;
  cat: ExecResult;
  echo: ExecResult;
}

export default function run(input: RunInput): RunResult {
  const canned = exec({ cmd: "ls", args: ["-la"] });
  const cat = exec({ cmd: "cat", args: [input.file] });
  const echo = exec({ cmd: "echo hi" });
  return { canned, cat, echo };
}
