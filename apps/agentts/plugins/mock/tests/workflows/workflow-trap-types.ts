declare function trap<Input, Output>(type: string, arg: unknown): unknown;

declare function print(...args: unknown[]): void;

interface JobInput {
  op: string;
  value?: number;
}

interface JobResult {
  score: number;
  label: string;
}

interface ExecInput {
  cmd: string;
}

interface ExecResult {
  stdout: string;
  exitCode: number;
}

interface GateInput {
  question: string;
}

interface GateResult {
  answer: string;
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

interface DecideInput {
  question: string;
  options?: string[];
}

interface DecideResult {
  choice: string;
  confidence: number;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  const j = trap<JobInput, JobResult>("job", { op: "score", value: 7 }) as JobResult;

  print("job:", JSON.stringify(j));

  const e = trap<ExecInput, ExecResult>("exec", { cmd: "echo hi" }) as ExecResult;

  print("exec:", JSON.stringify(e));

  const g = trap<GateInput, GateResult>("gate", { question: "approve?" }) as GateResult;

  print("gate:", JSON.stringify(g));

  const s = trap<SleepInput, SleepResult>("sleep", { ms: 1000 }) as SleepResult;

  print("sleep:", JSON.stringify(s));

  const c = trap<CronInput, CronResult>("cron", { at: "2027-04-09T00:00:00Z" }) as CronResult;

  print("cron:", JSON.stringify(c));

  const d = trap<DecideInput, DecideResult>("decide", {
    question: "pick one",
    options: ["a", "b"],
  }) as DecideResult;

  print("decide:", JSON.stringify(d));

  print("done");
  return { done: true };
}
