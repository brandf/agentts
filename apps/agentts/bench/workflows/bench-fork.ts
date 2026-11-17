// Bench workflow: fork copy cost vs snapshot size / branch count (BRA-93).
// all() over `branches` thunks, each doing one exec trap. Each branch
// starts from a copy of the parent snapshot, so the measured time is
// the per-branch copy + spawn cost. Keep branches small (each branch
// is a full C-host slice).
import { exec, all } from "../../src/agentts";

export interface BenchForkInput {
  branches: number;
}
export interface BenchForkOutput {
  branches: number;
}

export default function run(input: BenchForkInput): BenchForkOutput {
  const thunks: (() => number)[] = [];
  for (let i = 0; i < input.branches; i++) {
    thunks.push(() => {
      exec({ cmd: "echo", args: ["hi"] });
      return i;
    });
  }
  const results = all(thunks);
  return { branches: results.length };
}
