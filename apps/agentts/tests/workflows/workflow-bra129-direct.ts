// BRA-129 fixture: a direct trap() call inside an Array.map callback —
// refused at extraction time, same as the wrapper form.
import { type ExecSpec, type ExecResult } from "../../src/agentts";

declare function trap<Input, Output>(type: string, arg: unknown): unknown;

export interface DirectInput {
  marker: string;
}

export interface DirectOut {
  direct: string;
  cb: string;
}

export default function directCase(input: DirectInput): DirectOut {
  const direct = trap<ExecSpec, ExecResult>("exec", { cmd: "echo", args: ["direct"] }) as ExecResult;
  let cbOut = "";
  ["cb"].map((v) => {
    const r = trap<ExecSpec, ExecResult>("exec", { cmd: "echo", args: [v] }) as ExecResult;
    cbOut = r.stdout.trim();
    return r;
  });
  return { direct: direct.stdout.trim(), cb: cbOut };
}
