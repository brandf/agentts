// mock-adapter — the mock environment adapter (BRA-44).
//
// The canned-answer half of the BRA-45 mock plugin, factored out so
// the host can load it as an adapter. Same answers as the mock
// plugin's defaultAnswer/mockJob (the swap test requires identical
// answers): job specs score/verify/aggregate by the canned table,
// exec echo hi, gate auto-yes or held, decide {choice:"a",
// confidence:0.9}. Queues and per-type functions let tests configure
// answers ("the next decide returns X at confidence 0.6").
//
// The virtual clock lives in the HOST, not here: sleep/cron/clock
// never reach the adapter. JudgeFixLoop mock judges are answered
// here too (spec "judge"): a deterministic function of the input —
// base score per judge index plus 0.15 per revision the fix job has
// applied (counted from "(revised" markers in the item text) — so
// the loop genuinely improves across iterations and converges, with
// no canned literal per loop. "fix" appends a revision marker and a
// sentence addressing the rubric; "aggregate" computes the mean over
// the verdicts; "rubric-update" adds a criterion when verdicts show
// a repeated miss.

import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../adapter";
import { runBugfix } from "../../workflows/bugfix-worker";

export type CannedFn = (
  type: string,
  arg: any,
  ctx: TrapContext,
) => TrapAnswer | undefined;

const MOCK: Record<string, any> = {
  "score:7": { score: 0.92, label: "approved" },
  "verify:7": { score: 0.97, label: "verified" },
  "score:3": { score: 0.41, label: "weak" },
  "verify:3": { score: 0.88, label: "retried" },
  "score:5": { score: 0.63, label: "approved" },
  "score:9": { score: 0.31, label: "slow" },
  "score:11": { score: 0.9, label: "approved" },
  "score:12": { score: 0.85, label: "approved" },
  "score:21": { score: 0.21, label: "g21" },
  "score:22": { score: 0.22, label: "g22" },
  "score:23": { score: 0.23, label: "g23" },
};

/** Judge base scores per judge index (mock judges, canned). */
const JUDGE_BASE = [0.55, 0.62, 0.48];

function revisionsOf(text: string): number {
  return (text.match(/\(revised/g) ?? []).length;
}

function mockJudge(arg: any): any {
  const input = arg?.input ?? {};
  const judge = typeof input.judge === "number" ? input.judge : 0;
  const text: string = typeof input.item?.text === "string" ? input.item.text : "";
  const rubric = input.rubric ?? {};
  const criteria: string[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const score = Math.min(
    0.98,
    JUDGE_BASE[judge % JUDGE_BASE.length] + 0.15 * revisionsOf(text),
  );
  const notes =
    criteria.length === 0
      ? "no criteria"
      : criteria.map((c) => `${c}: ${text.toLowerCase().includes(c.toLowerCase().split(" ")[0]) ? "addressed" : "missing"}`).join("; ");
  return { score: Math.round(score * 100) / 100, label: score >= 0.8 ? "approved" : "weak", notes };
}

function mockFix(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { text: "", goal: "" };
  const n = revisionsOf(item.text) + 1;
  // Deliberately neutral: the revision marker is what the mock judges
  // score on (+0.15 per revision). Naming the missed criteria here
  // would game the mock judge's keyword check (its notes look for the
  // criterion's first word in the text) and fake an improvement.
  return { text: `${item.text} (revised ${n}). It is tightened and clarified.`, goal: item.goal ?? "" };
}

/** JudgeFixLoop aggregate (spec "aggregate", new shape): the input
 * carries plain JudgeVerdicts plus the failed-branch count (the
 * workflow unwraps the all() outcomes first). The old direct-trap
 * aggregate ({op:"aggregate", verdicts: Outcome[]}) is a separate
 * branch in mockJob below and keeps its ok-counting shape. */
function mockAggregate(arg: any): any {
  const input = arg?.input ?? {};
  const verdicts = Array.isArray(input.verdicts) ? input.verdicts : [];
  const threshold = typeof input.threshold === "number" ? input.threshold : 0.8;
  const scores = verdicts
    .map((v: any) => (typeof v?.score === "number" ? v.score : null))
    .filter((s: any) => s !== null);
  const mean = scores.length ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
  const approved = scores.filter((s: number) => s >= threshold).length;
  const failed = typeof input.failed === "number" ? input.failed : verdicts.length - approved;
  return {
    approved,
    failed,
    meanScore: Math.round(mean * 100) / 100,
    summary: `${approved} approved, ${failed} failed, mean ${Math.round(mean * 100) / 100}`,
  };
}

function mockRubricUpdate(arg: any): any {
  const input = arg?.input ?? {};
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  const criteria: string[] = [...(rubric.criteria ?? [])];
  if (!criteria.includes("concrete example")) criteria.push("concrete example");
  return { criteria, threshold: rubric.threshold ?? 0.8 };
}

export class MockAdapter implements Adapter {
  readonly name = "mock";
  readonly gates: "auto" | "hold";
  private answerQueues = new Map<string, TrapAnswer[]>();
  private cannedFns = new Map<string, CannedFn>();
  private gateQueue: unknown[] = [];

  constructor(opts: { gates?: "auto" | "hold" } = {}) {
    this.gates = opts.gates ?? "auto";
  }

  queueAnswer(type: string, answer: TrapAnswer | unknown): void {
    const list = this.answerQueues.get(type) ?? [];
    list.push(
      answer !== null && typeof answer === "object" && ("value" in (answer as any) || "throw" in (answer as any))
        ? (answer as TrapAnswer)
        : { value: answer },
    );
    this.answerQueues.set(type, list);
  }

  setCanned(type: string, fn: CannedFn): void {
    this.cannedFns.set(type, fn);
  }

  queueGateAnswer(answer: unknown): void {
    this.gateQueue.push(answer);
  }

  private mockJob(arg: any): any {
    // Bug-fix workflow specs (Phase 2, BRA-54): the same bugfix
    // worker code, run in-process with simulate: true — deterministic
    // simulation for fast iteration under --adapter mock (reproduce
    // statically checks the canned decide, fix dry-runs the patch,
    // test/verify report the post-fix signature). Simulated results
    // always carry simulated: true; the direct adapter spawns the
    // worker process and executes everything for real.
    if (arg && typeof arg.spec === "string" && arg.spec.startsWith("bugfix-")) {
      return runBugfix(arg.spec, arg.input ?? {}, { simulate: true });
    }
    if (arg && typeof arg.spec === "string") {
      if (arg.spec === "judge") return mockJudge(arg);
      if (arg.spec === "fix") return mockFix(arg);
      if (arg.spec === "rubric-update") return mockRubricUpdate(arg);
      if (arg.spec === "aggregate") {
        // Two shapes share the "aggregate" spec across workflows, and
        // the adapter is shared too — distinguish by the INPUT shape:
        // Outcome objects ({ok}) count ok/failed (the judges
        // workflow); JudgeVerdicts ({score}) reduce to a mean (JFL).
        // The extractor never confuses them (one extraction per
        // workflow); only the shared adapter must look at the input.
        const verdicts = Array.isArray(arg.input?.verdicts) ? arg.input.verdicts : [];
        if (verdicts.some((v: any) => v && typeof v === "object" && typeof v.ok === "boolean")) {
          const ok = verdicts.filter((v: any) => v.ok).length;
          return {
            approved: ok,
            failed: verdicts.length - ok,
            summary: `${ok} approved, ${verdicts.length - ok} failed`,
          };
        }
        return mockAggregate(arg);
      }
      const key = `${arg.spec}:${arg.input?.value}`;
      if (key in MOCK) return MOCK[key];
      console.error(`[mock] no canned result for ${key}; using default`);
      return { score: 0.5, label: "default" };
    }
    if (arg && arg.op === "aggregate") {
      const verdicts = arg.verdicts || [];
      const ok = verdicts.filter((v: any) => v.ok).length;
      return {
        approved: ok,
        failed: verdicts.length - ok,
        summary: `${ok} approved, ${verdicts.length - ok} failed`,
      };
    }
    const key = `${arg?.op}:${arg?.value}`;
    if (key in MOCK) return MOCK[key];
    console.error(`[mock] no canned result for ${key}; using default`);
    return { score: 0.5, label: "default" };
  }

  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD {
    const queued = this.answerQueues.get(type);
    if (queued && queued.length) return queued.shift()!;
    const fn = this.cannedFns.get(type);
    if (fn) {
      const a = fn(type, arg, ctx);
      if (a !== undefined) return a;
    }
    switch (type) {
      case "job":
        return { value: this.mockJob(arg) };
      case "exec":
        return {
          value:
            arg?.cmd === "echo hi"
              ? { stdout: "hi\n", exitCode: 0 }
              : { stdout: "", exitCode: 0 },
        };
      case "gate": {
        if (this.gateQueue.length) return { value: this.gateQueue.shift() };
        if (this.gates === "hold") return HOLD;
        return { value: { answer: "yes" } };
      }
      case "decide":
        return { value: { choice: "a", confidence: 0.9 } };
      default:
        console.error(`[mock] unknown trap type ${type}; using default`);
        return { value: { score: 0.5, label: "default" } };
    }
  }
}
