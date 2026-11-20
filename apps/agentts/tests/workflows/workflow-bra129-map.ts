// BRA-129 fixture: a trap inside an Array.map callback — refused at
// extraction time (the callback runs from C, so the trap cannot suspend).
import { exec } from "../../src/agentts";

export interface MapInput {
  marker: string;
}

export interface MapOut {
  direct: string;
  cb: string;
}

export default function mapCase(input: MapInput): MapOut {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  let cbOut = "";
  ["cb"].map((v) => {
    const r = exec({ cmd: "echo", args: [v] });
    cbOut = r.stdout.trim();
    return r;
  });
  return { direct: direct.stdout.trim(), cb: cbOut };
}
