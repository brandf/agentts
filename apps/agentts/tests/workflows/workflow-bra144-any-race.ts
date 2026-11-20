import { any, race, sleep, exec } from "../../src/agentts";

/**
 * BRA-144 fixture: CLI+direct happy paths for any() and race().
 *
 * Semantics (documented in tests/workflows/workflow-race.ts): the
 * driver runs combinator branches SEQUENTIALLY, so the first branch
 * is always the first settler — true time-based racing needs the
 * real scheduler (M3), which does not exist yet. So the happy paths
 * prove the join mechanics in array order, not a wall-clock race:
 * - "any": the first branch throws, the second returns "fast" after
 *   a real 5ms sleep trap, the third would exec-echo "slow" into
 *   the marker file — any() returns the first success, "fast", and
 *   the third branch never runs (marker stays empty).
 * - "race": the first branch returns "fast" after a real 5ms sleep
 *   trap; the second would exec-echo "slow" into the marker file
 *   and the third would throw — race() returns the first settler,
 *   "fast", and the later branches never run (marker stays empty).
 *
 * The marker file is the black-box proof the losers never ran: it
 * is written only by a branch's exec, so an empty/missing marker
 * after the run means that branch never executed.
 */
declare function print(...args: unknown[]): void;

export interface In {
  mode: string;
  markerFile: string;
}

export interface Out {
  winner: string;
}

export default function run(input: In): Out {
  if (input.mode === "any") {
    const winner = any([
      () => {
        throw new Error("first branch boom");
      },
      () => {
        sleep({ ms: 5 });
        return "fast";
      },
      () => {
        exec({ cmd: "sh", args: ["-c", `echo slow >> "${input.markerFile}"`] });
        return "slow";
      },
    ]);
    print("winner:", winner);
    return { winner };
  }
  if (input.mode === "race") {
    const winner = race([
      () => {
        sleep({ ms: 5 });
        return "fast";
      },
      () => {
        exec({ cmd: "sh", args: ["-c", `echo slow >> "${input.markerFile}"`] });
        return "slow";
      },
      () => {
        throw new Error("loser boom");
      },
    ]);
    print("winner:", winner);
    return { winner };
  }
  throw new Error(`unknown mode: ${input.mode}`);
}
