// BRA-132 test workflow: an exec trap (writes a marker, sleeps in the
// shell so the drive can be stranded mid-dispatch), then returns "ok".
import { exec } from "../../src/agentts";

interface Bra132Input {
  markerFile: string;
  sleepMs: number;
}
export interface RunResult {
  marker: string;
}

export default function run(input: Bra132Input): RunResult {
  const r = exec({
    cmd: "sh",
    args: ["-c", `echo bra132 >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],
  });
  return { marker: r.stdout.trim() === "done" ? "ok" : "unexpected" };
}
