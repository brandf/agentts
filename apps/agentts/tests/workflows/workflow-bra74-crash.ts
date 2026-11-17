// BRA-74 test workflow: an exec trap, then a long pure-computation slice (busy loop).
// The test SIGKILLs the C host mid-loop — during the resume slice, after the exec was
// dispatched — and proves the run resumes from its last intact blob and completes: the exec
// is not re-dispatched (the BRA-75 journal check re-delivers its recorded answer) and the
// loop re-executes from the blob. The loop is pure computation (no side effects), so
// re-executing it is safe; its count is exact, so completion proves it ran to the end.
import { exec } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface CrashInput {
  markerFile: string;
  iterations: number;
}
export interface RunResult {
  marker: string;
  looped: boolean;
  count: number;
}

export default function run(input: CrashInput): RunResult {
  const r = exec({
    cmd: "sh",
    args: ["-c", `echo bra74-crash >> "${input.markerFile}" && echo done`],
  });
  print("exec:", r.stdout.trim());
  let n = 0;
  for (let i = 0; i < input.iterations; i++) n++;
  print("loop-done:", n);
  return { marker: "bra74-crash", looped: true, count: n };
}
