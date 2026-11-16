// Trap dispatch by type string (Linear BRA-43): one workflow calls
// trap() directly with each of the six trap types — job, exec, gate,
// sleep, cron, decide — and the reference plugin answers each with a
// canned result. No fork version, no direct reference: the expected
// outputs are literals checked by the driver.

declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

const j = trap("job", { op: "score", value: 7 }) as { score: number; label: string };
print("job:", JSON.stringify(j));

const e = trap("exec", { cmd: "echo hi" }) as { stdout: string; exitCode: number };
print("exec:", JSON.stringify(e));

const g = trap("gate", { question: "approve?" }) as { answer: string };
print("gate:", JSON.stringify(g));

const s = trap("sleep", { ms: 1000 }) as { sleptMs: number };
print("sleep:", JSON.stringify(s));

const c = trap("cron", { at: "2027-04-09T00:00:00Z" }) as { scheduled: string };
print("cron:", JSON.stringify(c));

const d = trap("decide", { question: "pick one", options: ["a", "b"] }) as {
  choice: string;
  confidence: number;
};
print("decide:", JSON.stringify(d));
print("done");
