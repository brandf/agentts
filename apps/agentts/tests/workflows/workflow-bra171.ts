// BRA-171 test workflow: a single exec trap that cats a file and returns
// the content's length + first/last lines. The exec RESULT is what
// crosses argv to the C host on resume — with a ~200KB file the answer
// JSON exceeds Linux's 128KB single-argument cap (MAX_ARG_STRLEN) and
// the resume spawn fails E2BIG on un-fixed code.
import { exec } from "../../src/agentts";

export interface Bra171Input {
  filePath: string;
}
export interface RunResult {
  len: number;
  head: string;
  tail: string;
}

export default function run(input: Bra171Input): RunResult {
  const r = exec({ cmd: "cat", args: [input.filePath] });
  const lines = r.stdout.split("\n");
  return {
    len: r.stdout.length,
    head: lines[0] ?? "",
    tail: lines.length > 1 ? (lines[lines.length - 2] ?? "") : "",
  };
}
