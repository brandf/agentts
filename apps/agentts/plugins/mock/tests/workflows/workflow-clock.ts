declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface ClockInput {}

interface ClockResult {
  now: string;
  nowMs: number;
}

interface SleepInput {
  ms: number;
}

interface SleepResult {
  sleptMs: number;
}

interface CronInput {
  at: string;
}

interface CronResult {
  scheduled: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  function now(): string {
    return (trap<ClockInput, ClockResult>("clock", {}) as ClockResult).now;
  }

  const s1 = trap<SleepInput, SleepResult>("sleep", { ms: 3600000 }) as SleepResult;

  print("slept 1:", JSON.stringify(s1));

  print("after sleep 1:", now());

  const s2 = trap<SleepInput, SleepResult>("sleep", { ms: 3600000 }) as SleepResult;

  print("slept 2:", JSON.stringify(s2));

  print("after sleep 2:", now());

  const cLate = trap<CronInput, CronResult>("cron", { at: "2027-03-01T00:00:00Z" }) as CronResult;

  print("cron late:", JSON.stringify(cLate));

  print("after cron late:", now());

  const cEarly = trap<CronInput, CronResult>("cron", { at: "2027-02-01T00:00:00Z" }) as CronResult;

  print("cron early:", JSON.stringify(cEarly));

  print("after cron early:", now());

  const cApr = trap<CronInput, CronResult>("cron", { at: "2027-04-01T00:00:00Z" }) as CronResult;

  print("cron apr:", JSON.stringify(cApr));

  print("after cron apr:", now());

  const cMay = trap<CronInput, CronResult>("cron", { at: "2027-05-01T00:00:00Z" }) as CronResult;

  print("cron may:", JSON.stringify(cMay));

  print("after cron may:", now());

  print("done");
  return { done: true };
}
