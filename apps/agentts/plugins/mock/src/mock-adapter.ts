// mock-adapter — the mock environment adapter (BRA-44).
// Implementation — the loadable seam is ./adapter.ts (see plugins/README.md for why the mock adapter appears in two files).
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

import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../../../src/adapter";
import * as fs from "node:fs";
import { runBugfix } from "../../../workflows/bugfix-worker";

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

// Shared improve-loop mock logic (identical in both mock copies —
// plugins/mock/src/mock-adapter.ts and plugins/mock/src/mock-plugin.ts.
// The swap test requires identical answers, so this block is
// inserted verbatim into both files; keep them in sync. It mirrors
// workflows/worker.ts's improve-* implementations exactly (same
// criterion checks, same dedupe/filter rules, same fix sentences),
// except improve-write, which computes the same paths + bytes
// WITHOUT writing files (a mock never writes).

const IMPROVE_VIVID = ["vivid", "bright", "russet", "flashed", "striking", "golden", "crimson", "blazing", "shimmering", "scarlet", "gleaming"];
const IMPROVE_CONCRETE = ["fox", "coat", "light", "morning", "dog", "river", "stone", "road", "cat", "house", "tree", "rain", "snow"];

function improveCriterionAddressed(criterion: string, text: string): boolean {
  const t = text.toLowerCase();
  const first = criterion.toLowerCase().split(" ")[0];
  if (first === "vivid") return IMPROVE_VIVID.some((w) => t.includes(w));
  if (first === "concrete") {
    if (/\d/.test(text)) return true;
    return IMPROVE_CONCRETE.some((w) => t.includes(w));
  }
  if (first === "concise") return text.split(/\s+/).filter(Boolean).length <= 25;
  return t.includes(first);
}

function improveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "criterion";
}

function mockImproveJudge(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { content: "" };
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  const criteria: any[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const content: string = typeof item.content === "string" ? item.content : "";
  const judgeIndex = typeof input.judge === "number" ? input.judge : 0;
  const axisScores: any[] = [];
  const findings: any[] = [];
  let addressed = 0;
  let weightedGot = 0;
  let weightedTotal = 0;
  criteria.forEach((c: any, i: number) => {
    const name: string = typeof c?.name === "string" ? c.name : String(c ?? "");
    const description: string = typeof c?.description === "string" ? c.description : "";
    const isAddressed = improveCriterionAddressed(name, content);
    const weight = i % Math.max(criteria.length, 1) === judgeIndex % Math.max(criteria.length, 1) ? 2 : 1;
    weightedTotal += weight;
    if (isAddressed) {
      addressed++;
      weightedGot += weight;
    }
    axisScores.push({ criterion: name, score: isAddressed ? 1 : 0, note: isAddressed ? "addressed" : "not addressed" });
    const id = `finding-${improveSlug(name)}`;
    if (isAddressed) {
      findings.push({
        id,
        criterion: name,
        severity: "nit",
        detail: `"${name}": addressed, but could be strengthened`,
        suggestion: `Tighten the wording for "${name}".`,
      });
    } else {
      findings.push({
        id,
        criterion: name,
        severity: "major",
        detail: `"${name}": not addressed — ${description}`,
        suggestion: `Address the "${name}" criterion: ${description}`,
      });
    }
  });
  const mean = weightedTotal > 0 ? Math.round((weightedGot / weightedTotal) * 100) / 100 : 0;
  return {
    judge: judgeIndex,
    axisScores,
    findings,
    summary: `judge ${judgeIndex}: ${addressed} of ${criteria.length} axes addressed (weighted mean ${mean})`,
  };
}

function mockImproveAggregate(arg: any): any {
  const input = arg?.input ?? {};
  const scorecards: any[] = Array.isArray(input.scorecards) ? input.scorecards : [];
  const findings: any[] = [];
  const dropped: any[] = [];
  const seen = new Set<string>();
  for (const sc of scorecards) {
    for (const f of sc?.findings ?? []) {
      if (!f || typeof f.id !== "string") continue;
      if (seen.has(f.id)) {
        dropped.push({ finding: f, reason: "duplicate" });
      } else {
        seen.add(f.id);
        findings.push(f);
      }
    }
  }
  const hasSevere = findings.some((f: any) => f.severity === "blocking" || f.severity === "major");
  const kept: any[] = [];
  if (hasSevere) {
    for (const f of findings) {
      if (f.severity === "nit") dropped.push({ finding: f, reason: "nit filtered: higher-severity findings present" });
      else kept.push(f);
    }
  } else {
    kept.push(...findings);
  }
  let meanSum = 0;
  for (const sc of scorecards) {
    const axes: any[] = Array.isArray(sc?.axisScores) ? sc.axisScores : [];
    const judgeIndex = typeof sc?.judge === "number" ? sc.judge : 0;
    let got = 0;
    let total = 0;
    axes.forEach((a: any, i: number) => {
      const weight = i % Math.max(axes.length, 1) === judgeIndex % Math.max(axes.length, 1) ? 2 : 1;
      total += weight;
      if (a?.score === 1) got += weight;
    });
    meanSum += total > 0 ? got / total : 0;
  }
  const meanScore = scorecards.length ? Math.round((meanSum / scorecards.length) * 100) / 100 : 0;
  return {
    findings: kept,
    dropped,
    meanScore,
    summary: `${kept.length} findings, ${dropped.length} dropped, mean ${meanScore}`,
  };
}

function mockImproveDecide(arg: any): any {
  const input = arg?.input ?? {};
  const aggregated = input.aggregated ?? { findings: [], dropped: [], meanScore: 0, summary: "" };
  const findings: any[] = Array.isArray(aggregated.findings) ? aggregated.findings : [];
  const severe = findings.filter((f: any) => f.severity === "blocking" || f.severity === "major");
  if (!severe.length) {
    return { needsFix: false, fixes: [], reason: "no blocking/major findings — no fixes needed" };
  }
  return {
    needsFix: true,
    fixes: severe.map((f: any) => ({ findingId: f.id, action: f.suggestion })),
    reason: `${severe.length} finding(s) need fixes: ${severe.map((f: any) => f.id).join(", ")}`,
  };
}

function mockImproveFix(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { content: "" };
  const rubric = input.rubric ?? { criteria: [], threshold: 0.8 };
  const decision = input.decision ?? { needsFix: false, fixes: [], reason: "" };
  const aggregated = input.aggregated ?? { findings: [], dropped: [], meanScore: 0, summary: "" };
  const findings: any[] = Array.isArray(aggregated.findings) ? aggregated.findings : [];
  const byId = new Map<string, any>(findings.map((f: any) => [f.id, f]));
  const criteria: any[] = Array.isArray(rubric.criteria) ? rubric.criteria : [];
  const descByName = new Map<string, string>(criteria.map((c: any) => [c?.name, c?.description ?? ""]));
  const content: string = typeof item.content === "string" ? item.content : "";
  const n = (content.match(/\(revised/g) ?? []).length + 1;
  const sentences: string[] = [];
  const changes: any[] = [];
  for (const fix of decision.fixes ?? []) {
    const f = byId.get(fix.findingId);
    if (!f) continue;
    const name: string = f.criterion ?? "";
    const first = name.toLowerCase().split(" ")[0];
    if (first === "concise") continue; // cannot fix by appending
    let sentence: string;
    if (first === "vivid") {
      sentence = "A vivid, golden example brings the point to life.";
    } else if (first === "concrete") {
      sentence = "In 2026, 3 pilot teams ran this process end to end.";
    } else {
      sentence = `${name}: ${descByName.get(name) ?? f.detail ?? ""} (revised ${n}).`;
    }
    sentences.push(sentence);
    changes.push({
      round: 0,
      findingId: f.id,
      description: `Added coverage for '${name}': ${sentence}`,
      why: f.detail,
    });
  }
  const newContent = sentences.length
    ? `${content} (revised ${n}). ${sentences.join(" ")}`
    : content;
  return { item: { ...item, content: newContent }, changes };
}

// The mock write computes the same paths + bytes as the real worker
// (same rendering) WITHOUT writing any file — a mock never writes.
function mockImproveWrite(arg: any): any {
  const input = arg?.input ?? {};
  const item = input.item ?? { kind: "", description: "", content: "" };
  const report = input.report ?? { rounds: 0, converged: false, changes: [], outstanding: [], finalMeanScore: 0, summary: "" };
  const outDir: string = typeof input.outDir === "string" && input.outDir ? input.outDir : ".agentts-scratch/improve-loop-out";
  const improvedPath = `${outDir}/improved.md`;
  const reportPath = `${outDir}/change-report.json`;
  const improved = `# ${item.description}\n\n_kind: ${item.kind}_\n\n${item.content}` + (item.ref ? `\n\nSource: ${item.ref}` : "");
  const reportJson = JSON.stringify(report, null, 2);
  return {
    ok: true,
    error: "",
    improvedPath,
    reportPath,
    bytes: Buffer.byteLength(improved, "utf8") + Buffer.byteLength(reportJson, "utf8"),
  };
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
      // Improve-loop specs (standard library): input-dependent mock
      // answers — the same logic as the real workers (see the block
      // above), so the mock run shows a real improving arc.
      if (arg.spec === "improve-judge") return mockImproveJudge(arg);
      if (arg.spec === "improve-aggregate") return mockImproveAggregate(arg);
      if (arg.spec === "improve-decide") return mockImproveDecide(arg);
      if (arg.spec === "improve-fix") return mockImproveFix(arg);
      if (arg.spec === "improve-write") return mockImproveWrite(arg);
      if (arg.spec === "judge") return mockJudge(arg);
      if (arg.spec === "fix") return mockFix(arg);
      if (arg.spec === "rubric-update") return mockRubricUpdate(arg);
      // BRA-47: the cascade's job tier ("decision" jobspec). No canned
      // decision exists — the mock answers the first option at 0.5, a
      // deliberate guess: a cascade tier at/above its threshold would
      // need a queued answer, and an unconfigured mock run escalates
      // instead of deciding on a made-up confidence.
      if (arg.spec === "decision") {
        const options: string[] = Array.isArray(arg.input?.options) ? arg.input.options : [];
        return {
          choice: options[0] ?? "yes",
          confidence: 0.5,
          reason: "mock default: no canned decision answer; first option at 0.5",
        };
      }
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
      case "exec": {
        // `cat <file>` reads the file for real — rubric-file
        // resolution (improve-loop) depends on it, and the mock
        // cannot canned-answer a file it has never seen.
        if (arg?.cmd === "cat" && typeof arg?.args?.[0] === "string") {
          try {
            return { value: { stdout: fs.readFileSync(arg.args[0], "utf8"), stderr: "", exitCode: 0 } };
          } catch (e: any) {
            return { value: { stdout: "", stderr: e?.message ?? String(e), exitCode: 1 } };
          }
        }
        return {
          value:
            arg?.cmd === "echo hi"
              ? { stdout: "hi\n", exitCode: 0 }
              : { stdout: "", exitCode: 0 },
        };
      }
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
