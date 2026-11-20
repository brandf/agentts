// BRA-129 library fixture: the trap sits inside a map callback in THIS
// file (not the entry). The extraction walk covers the whole closure,
// so the entry importing this helper is refused, with the message
// naming this file.
import { exec } from "../../src/agentts";

export function libRunAll(items: string[]): string[] {
  const outs: string[] = [];
  items.map((v) => {
    const r = exec({ cmd: "echo", args: [v] });
    outs.push(r.stdout.trim());
    return r;
  });
  return outs;
}
