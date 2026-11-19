// BRA-90 test workflow: N sleeps, one exec trap (writes a marker,
// sleeps in the shell so the drive can be stranded mid-dispatch),
// then M more sleeps. Stranding mid-exec leaves the run suspended
// at the exec trap with a checkpoint at ordinal N — a delta when
// N >= 1, a keyframe when N == 25 (interval) — so the test can
// inspect the manifest, corrupt one link of the chain, and drive.
import { sleep, exec } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface SleepsExecInput {
  count: number;
  after: number;
  markerFile: string;
  sleepMs: number;
}
export interface SleepsExecResult {
  sleeps: number;
}

export default function run(input: SleepsExecInput): SleepsExecResult {
  let n = 0;
  for (let i = 0; i < input.count; i++) {
    sleep({ ms: 0 });
    n++;
  }
  const r = exec({
    cmd: "sh",
    args: [
      "-c",
      `echo bra90-exec >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`,
    ],
  });
  print("exec:", r.stdout.trim());
  for (let i = 0; i < input.after; i++) {
    sleep({ ms: 0 });
    n++;
  }
  return { sleeps: n };
}
