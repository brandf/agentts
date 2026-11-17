// BRA-67 test workflow: a single cron trap (real clock mode).
// The test kills the host mid-wait and proves the recovery waits
// only the REMAINING time to the absolute target — the target `at`
// is carried in the journaled trap arg, so a re-dispatch recomputes
// `target - Date.now()` instead of re-waiting the full duration.
// Unlike sleep (BRA-74 C) there is no separate sleep-deadline event:
// the arg itself is the durable deadline.
import { cron } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface CronInput {
  at: string;
}
export interface RunResult {
  scheduled: string;
}

export default function run(input: CronInput): RunResult {
  const r = cron({ at: input.at });
  print("scheduled:", r.scheduled);
  return { scheduled: r.scheduled };
}
