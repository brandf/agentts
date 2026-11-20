// BRA-129 fixture: .map() building thunks that all() invokes later —
// the traps fire when all() invokes them, NOT inside the map callback,
// so this runs fine. The check must not flag thunks merely created
// inside a native callback.
import { exec, all } from "../../src/agentts";

export interface ThunkInput {
  marker: string;
}

export interface ThunkOut {
  results: string[];
}

export default function thunkCase(input: ThunkInput): ThunkOut {
  const outs = all(
    ["a", "b"].map((v) => () => {
      const r = exec({ cmd: "echo", args: [v] });
      return r.stdout.trim();
    }),
  );
  const results: string[] = [];
  for (const o of outs) {
    if (o.ok) results.push(o.value);
    else throw new Error("branch failed");
  }
  return { results };
}
