// BRA-89 test workflow (direct adapter, exec'd script): an exec trap
// (writes a marker, sleeps in the shell so the drive can be stranded
// mid-dispatch), then a second exec trap running
// `bun workflows/dogfood/briefing-prep.ts` — the script the daily briefing
// workflow runs via an exec trap, resolved from the live tree
// relative to the host cwd, never from the frozen dir. The workflow
// records the prep exit code without throwing on it, so the control
// run completes whatever the prep script does in this environment.
// The test edits briefing-prep.ts mid-run and restores the original
// in a finally block; the pin's closure scan must name the script
// from the `workflows/dogfood/briefing-prep.ts` literal below.
import { exec } from "../../src/agentts";

interface Bra89PrepInput {
  markerFile: string;
  sleepMs: number;
  scratchDir: string;
}

export interface RunResult {
  marker: string;
  prepExitCode: number;
  prepStdout: string;
}

export default function run(input: Bra89PrepInput): RunResult {
  const s = exec({
    cmd: "sh",
    args: ["-c", `echo bra89-original >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],
  });
  const prep = exec({ cmd: "bun", args: ["workflows/dogfood/briefing-prep.ts", input.scratchDir] });
  return {
    marker: s.stdout.trim() === "done" ? "original" : "unexpected",
    prepExitCode: prep.exitCode,
    prepStdout: prep.stdout.trim(),
  };
}
