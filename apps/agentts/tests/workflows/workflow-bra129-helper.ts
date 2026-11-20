// BRA-129 fixture: a helper holding a trap, called synchronously from
// inside a .map callback — refused at extraction time (the helper runs
// while the map callback is on the stack).
import { exec } from "../../src/agentts";

export interface HelperInput {
  marker: string;
}

export interface HelperOut {
  direct: string;
  cb: string;
}

function runOne(v: string): string {
  const r = exec({ cmd: "echo", args: [v] });
  return r.stdout.trim();
}

export default function helperCase(input: HelperInput): HelperOut {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  let cbOut = "";
  ["cb"].map((v) => {
    cbOut = runOne(v);
    return v;
  });
  return { direct: direct.stdout.trim(), cb: cbOut };
}
