// BRA-129 fixture: the same trap in a plain for loop — runs fine.
import { exec } from "../../src/agentts";

export interface LoopInput {
  marker: string;
}

export interface LoopOut {
  direct: string;
  cb: string;
}

export default function loopCase(input: LoopInput): LoopOut {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  let cbOut = "";
  for (const v of ["cb"]) {
    const r = exec({ cmd: "echo", args: [v] });
    cbOut = r.stdout.trim();
  }
  return { direct: direct.stdout.trim(), cb: cbOut };
}
