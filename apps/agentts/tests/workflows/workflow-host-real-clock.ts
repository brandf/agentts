// Host-only fixture (BRA-44): real wall-clock sleep/cron through the
// direct adapter (clock: "real"). Durations are short on purpose:
// the test asserts wall time actually passes, not virtual jumps.

import { sleep, cron } from "../../src/agentts";

declare function trap<Input, Output>(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

interface ClockInput {}
interface ClockResult {
  now: string;
  nowMs: number;
}

function now(): string {
  const c = trap<ClockInput, ClockResult>("clock", {}) as ClockResult;
  return c.now;
}

print("start:", now());
const s = sleep({ ms: 100 });
print("sleep:", JSON.stringify(s));
print("after sleep:", now());

// Cron 2s in the future from the test's point of view: the workflow
// computes it from the clock it reads, so the target is always ~2s
// ahead of the run's real clock.
const c0 = trap<ClockInput, ClockResult>("clock", {}) as ClockResult;
const target = new Date(c0.nowMs + 2000).toISOString();
const c = cron({ at: target });
print("cron:", JSON.stringify(c));
print("after cron:", now());
print("done");
