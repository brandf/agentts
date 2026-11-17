// BRA-74 test workflow: a long pure-computation slice (busy loop) BEFORE the first trap.
// The test SIGKILLs the C host mid-loop — during the FIRST slice, when there is no blob yet —
// and proves startRunFrom retries the first slice from scratch and the run completes. The loop
// is pure computation, so re-running it is safe; its count is exact, so completion proves it
// ran to the end.
import { exec } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface FirstCrashInput {
  markerFile: string;
  iterations: number;
}
export interface RunResult {
  marker: string;
  looped: boolean;
  count: number;
}

export default function run(input: FirstCrashInput): RunResult {
  let n = 0;
  for (let i = 0; i < input.iterations; i++) n++;
  print("loop-done:", n);
  const r = exec({
    cmd: "sh",
    args: ["-c", `echo bra74-firstcrash >> "${input.markerFile}" && echo done`],
  });
  print("exec:", r.stdout.trim());
  return { marker: "bra74-firstcrash", looped: true, count: n };
}
