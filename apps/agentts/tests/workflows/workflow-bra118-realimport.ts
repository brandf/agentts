// BRA-118 test workflow: a genuine top-level import. Bun.build
// leaves the node builtin import in the bundle, and the validator
// must still refuse it loudly — this is the existing behavior the
// fix must preserve.
import { exec, type ExecResult } from "../../src/agentts";
import fs from "node:fs";

export interface RunInput {
  marker: string;
}

export interface RunResult {
  py: ExecResult;
}

export default function run(input: RunInput): RunResult {
  const py = exec({ cmd: "echo", args: [fs.existsSync("/tmp") ? "yes" : "no"] });
  return { py };
}
