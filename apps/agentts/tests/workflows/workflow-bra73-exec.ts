// BRA-73 test workflow: two exec traps at distinct call sites.
// The journal must carry a different site {file, line, column} for
// each (both share the site key `exec`, so the key alone cannot tell
// them apart — the site is the click-to-code key). The first exec
// prints "first", the second "second"; the outputs prove each trap
// ran once, at its own site.
import { exec } from "../../src/agentts";

export interface RunResult {
  first: string;
  second: string;
}

export default function run(): RunResult {
  const a = exec({ cmd: "echo", args: ["first"] });
  const b = exec({ cmd: "echo", args: ["second"] });
  return { first: a.stdout.trim(), second: b.stdout.trim() };
}
