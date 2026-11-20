// BRA-118 test workflow: embeds scripts and doc text whose
// `import`/`export` lines sit at line starts inside strings and
// comments. The bundle validator must not refuse this — only
// genuine top-level import/export in code is refused.
// - PY_SCRIPT is a Python script in a template literal; its
//   `import` lines are at line starts inside the string (the
//   BRA-118 reproduction: the old line-regex validator refused
//   this bundle).
// - SINGLE / DOUBLE / TEMPLATED hold the keywords in single-,
//   double-quoted, and template-literal strings.
// - The block comment below holds `import`/`export` at line starts
//   inside a comment (whether Bun.build preserves it or strips it,
//   the run must complete either way).
import { exec, type ExecResult } from "../../src/agentts";

export interface RunInput {
  marker: string;
}

export interface RunResult {
  py: ExecResult;
  single: string;
  double: string;
  templated: string;
}

/*
import block-comment
export block-comment
*/
const PY_SCRIPT = `import re, json
import os
print(json.dumps({"re": re.__name__, "os": os.__name__}))`;

// import in a line comment, and export in one too.
const SINGLE = 'import single';
const DOUBLE = "export double";
const TEMPLATED = `templated
import templated
export templated`;

export default function run(input: RunInput): RunResult {
  const py = exec({ cmd: "python3", args: ["-c", PY_SCRIPT] });
  return { py, single: SINGLE, double: DOUBLE, templated: TEMPLATED };
}
