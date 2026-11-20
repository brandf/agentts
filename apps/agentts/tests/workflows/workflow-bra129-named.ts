// BRA-129 fixture: a named function holding a trap, passed by reference
// to Array.map — refused at extraction time.
import { exec } from "../../src/agentts";

export interface NamedInput {
  marker: string;
}

export interface NamedOut {
  direct: string;
  cb: string;
}

function runOne(v: string): string {
  const r = exec({ cmd: "echo", args: [v] });
  return r.stdout.trim();
}

export default function namedCase(input: NamedInput): NamedOut {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  const cbs = ["cb"].map(runOne);
  return { direct: direct.stdout.trim(), cb: cbs[0] ?? "" };
}
