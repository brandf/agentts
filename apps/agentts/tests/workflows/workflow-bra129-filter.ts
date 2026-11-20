// BRA-129 fixture: a trap inside an Array.filter callback — refused at
// extraction time.
import { exec } from "../../src/agentts";

export interface FilterInput {
  marker: string;
}

export interface FilterOut {
  direct: string;
  cb: string;
}

export default function filterCase(input: FilterInput): FilterOut {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  let cbOut = "";
  ["cb"].filter((v) => {
    const r = exec({ cmd: "echo", args: [v] });
    cbOut = r.stdout.trim();
    return true;
  });
  return { direct: direct.stdout.trim(), cb: cbOut };
}
