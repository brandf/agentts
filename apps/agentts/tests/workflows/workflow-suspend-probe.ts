// Minimal probe: can an exec trap suspend from inside Array.map?
// Control: direct exec. Then exec inside .map, inside forEach, and
// inside a plain for loop. Each step prints; the run fails loudly at
// the first step that throws "this call cannot be suspended".
import { exec } from "../../src/agentts";

declare function print(...args: unknown[]): void;

export interface ProbeResult {
  direct: string;
  map: string;
  forEach: string;
  loop: string;
}

export default function probe(): ProbeResult {
  const direct = exec({ cmd: "echo", args: ["direct"] });
  print(`direct ok: ${direct.stdout.trim()}`);

  let mapOut = "";
  ["map"].map((x) => {
    const r = exec({ cmd: "echo", args: [x] });
    mapOut = r.stdout.trim();
    return r;
  });
  print(`map ok: ${mapOut}`);

  let feOut = "";
  ["foreach"].forEach((x) => {
    const r = exec({ cmd: "echo", args: [x] });
    feOut = r.stdout.trim();
  });
  print(`foreach ok: ${feOut}`);

  let loopOut = "";
  for (const x of ["loop"]) {
    const r = exec({ cmd: "echo", args: [x] });
    loopOut = r.stdout.trim();
  }
  print(`loop ok: ${loopOut}`);

  return { direct: direct.stdout.trim(), map: mapOut, forEach: feOut, loop: loopOut };
}
