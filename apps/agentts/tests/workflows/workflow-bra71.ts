// BRA-71 test workflow: an exec trap (writes a marker, sleeps in the
// shell so the drive can be stranded mid-dispatch), then returns the
// marker + the lib's value. The lib's TYPE flows into the output
// schema (the workflow returns LibInfo), so editing the lib mid-run
// changes the schemas a resumed run validates against — the frozen
// closure must prevent that. The test edits this file mid-run and
// restores the original in a finally block (and writes the original
// at startup, so a leftover edit from a killed run is repaired).
import { exec } from "../../src/agentts";
import { libMarker, type LibInfo } from "./bra71-lib";

interface Bra71Input {
  markerFile: string;
  sleepMs: number;
}
export interface RunResult {
  marker: string;
  lib: LibInfo;
}

export default function run(input: Bra71Input): RunResult {
  const r = exec({
    cmd: "sh",
    args: ["-c", `echo bra71-original >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],
  });
  return { marker: r.stdout.trim() === "done" ? "original" : "unexpected", lib: libMarker() };
}
