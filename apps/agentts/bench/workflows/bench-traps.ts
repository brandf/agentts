// Bench workflow: per-trap drive cost vs journal length (BRA-93).
// Runs `traps` sequential exec traps on the mock adapter (canned
// answers, no real work), so the measured time is the host drive loop:
// one C-host resume + one dispatch per trap, plus the journal scans
// that grow with the journal. Keep traps <= 50 (MAX_DRIVE_ROUNDS).
import { exec } from "../../src/agentts";

export interface BenchTrapsInput {
  traps: number;
}
export interface BenchTrapsOutput {
  traps: number;
}

export default function run(input: BenchTrapsInput): BenchTrapsOutput {
  for (let i = 0; i < input.traps; i++) {
    exec({ cmd: "echo", args: ["hi"] });
  }
  return { traps: input.traps };
}
