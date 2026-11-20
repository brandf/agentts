// BRA-129 fixture: a trap inside an Array.forEach callback — refused at
// extraction time.
import { exec } from "../../src/agentts";

export interface ForEachInput {
  marker: string;
}

export interface ForEachOut {
  direct: string;
  cb: string;
}

export default function forEachCase(input: ForEachInput): ForEachOut {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  let cbOut = "";
  ["cb"].forEach((v) => {
    const r = exec({ cmd: "echo", args: [v] });
    cbOut = r.stdout.trim();
  });
  return { direct: direct.stdout.trim(), cb: cbOut };
}
