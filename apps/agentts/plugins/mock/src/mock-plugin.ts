#!/usr/bin/env bun
/**
 * Mock host plugin (Linear BRA-45) — a REAL layer-2 plugin the AgentTS
 * host loads, not a copy of the core's reference test harness.
 *
 * The plugin implements the core's plugin protocol (see
 * packages/durablets/plugin/PROTOCOL.md): it dispatches traps
 * (dispatch {trapId, runId, type, arg, stateBlob} → resume/throw),
 * journals every event, maintains the run registry from lifecycle
 * events, stores blobs, and orchestrates fork/join. It stands in for
 * the environment adapter with canned handlers (the adapter interface
 * is plugin/adapter.ts; swapping it must not touch core, plugin,
 * scheduler, or workflows — the swap test proves that boundary).
 *
 * What makes it a mock instead of the reference driver:
 *  - Blobs live in MEMORY (a Map), never in files. The live .snap
 *    file is a transient slice; every resume restores it from the
 *    Map. Deleting the live blob and resuming from the stored copy
 *    alone is a test, not an accident.
 *  - The clock is VIRTUAL and PER RUN. sleep advances the run's
 *    virtual clock by the duration; cron alarms at the target
 *    datetime on the run's virtual clock. Nothing ever really waits:
 *    sleep(1h) completes instantly. Each run starts at the
 *    configured start (default 2027-01-01), so runs are hermetic.
 *  - Canned answers are CONFIGURABLE per test: queues and per-type
 *    functions, e.g. "the next decide returns X at confidence 0.6".
 *    Gates can be HELD open until the test delivers an answer (the
 *    week-long gate in miniature).
 *  - Trap contracts are ENFORCED at the boundary (BRA-46): schemas
 *    are extracted from the workflow's types at first run
 *    (extract.ts), cached by content hash; every trap result is
 *    JSON-clean-checked first (the agentts module's toJsonValue —
 *    ONE implementation defines "clean JSON" everywhere, per the
 *    landed BRA-46 module) and then AJV-validated against the
 *    cached output schema before the workflow resumes. A failure
 *    throws at the call site with the precise error, journaled —
 *    and is RETRYABLE via the repair loop (same trapId, error
 *    attached; see dispatchTrap).
 *  - The journal is in-memory JSONL (same event shapes as the core
 *    protocol, plus plugin-originated events: clock-advance,
 *    gate-held, validation-error). Every event the journal writer
 *    writes goes through the check-then-serialize helper first.
 *
 * TypeScript, Bun. No C. The C host binary is invoked per run-slice
 * (v0 shape, same as the core's reference driver).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import {
  extractWorkflow,
  siteKeyFor,
  type Extraction,
  type SiteEntry,
} from "./extract";
import { toJsonValue, JsonBoundaryError, TRAP_SITE_KEY, type TrapSite } from "./agentts";
import { runChecker, runGateWithLayering } from "./checker";
import { SchemaValidator, formatSchemaIssues, type SchemaIssue } from "./validate";

/** A precise JSON-boundary issue: path + what it was + what to do.
 * The plugin's journal + repair feedback carry this shape; it is
 * built from the module's JsonBoundaryError (one issue per failure —
 * toJsonValue throws on the FIRST bad value, fail-fast). */
export interface JsonIssue {
  path: string;
  what: string;
  fix: string;
}

export function formatIssues(issues: JsonIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.what} — ${i.fix}`).join("; ");
}

/** Adapt the module's single-issue boundary error to the plugin's
 * JsonIssue shape. The error message already carries path + detail +
 * fix; `what` is the machine-readable kind, `fix` the full message. */
export function boundaryIssue(e: JsonBoundaryError): JsonIssue {
  return { path: e.path, what: e.kind, fix: e.message };
}

/**
 * Split the wrapper-attached call site off a trap arg (BRA-73,
 * landed in the mock copy by BRA-88 — same function as the host's
 * splitTrapSite in src/host.ts, ported verbatim in behavior). The
 * agentts wrappers attach the site under TRAP_SITE_KEY — the only
 * channel from inside the engine to the plugin, since the C core
 * emits the trap event from the arg alone. The plugin strips the
 * key before dispatch (no adapter, repair handler, or schema
 * lookup ever sees it) and journals the site as the trap event's
 * top-level `site`, so the journaled arg stays exactly the spec
 * the author passed. A malformed site value (not from our wrappers
 * — an author who used the reserved key as a spec key) is dropped
 * with no site, never trusted: a forged site in the journal would
 * be worse than a missing one.
 */
function splitTrapSite(arg: any): { arg: any; site: TrapSite | null } {
  if (arg === null || typeof arg !== "object" || Array.isArray(arg)) return { arg, site: null };
  const rec = arg as Record<string, unknown>;
  if (!(TRAP_SITE_KEY in rec)) return { arg, site: null };
  const { [TRAP_SITE_KEY]: _dropped, ...rest } = rec;
  const raw = rec[TRAP_SITE_KEY];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const s = raw as Record<string, unknown>;
    if (
      typeof s.file === "string" &&
      typeof s.line === "number" &&
      Number.isFinite(s.line) &&
      typeof s.column === "number" &&
      Number.isFinite(s.column)
    ) {
      return { arg: rest, site: { file: s.file, line: s.line, column: s.column } };
    }
  }
  return { arg: rest, site: null };
}

export const HOLD = Symbol("mock-plugin-hold");

/** What a trap answer carries. The optional provenance is host-side
 * only — only `value`/`throw` cross into the engine (BRA-57, same
 * shape as the host's TrapAnswer in src/adapter.ts): `worker` names
 * the worker that produced the answer when one can be named,
 * `tokens` the tokens consumed when known. The mock plugin's canned
 * answers carry neither today; the fields exist so the journal can
 * carry them, and so the plugin's dispatch records the same shape
 * the host does. */
export type TrapAnswer =
  | { value: unknown; worker?: string; tokens?: number }
  | { throw: unknown; worker?: string; tokens?: number };

export interface RepairContext {
  type: string;
  arg: any;
  trapId: string;
  runId: string;
  trapSite: string;
  attempt: number;
  /** Which boundary stage failed: the JSON-clean check or schema validation. */
  phase: "json-clean" | "output";
  /** Precise issues from the failed stage. */
  issues: (JsonIssue | SchemaIssue)[];
  /** The answer that failed, for the repair to fix. */
  previousAnswer: unknown;
}

export type RepairHandler = (ctx: RepairContext) => TrapAnswer | undefined;
export type CannedFn = (
  type: string,
  arg: any,
  ctx: { runId: string; trapId: string },
) => TrapAnswer | undefined;

export interface MockPluginConfig {
  /** C host binary. Defaults to the core's built binary (resolved from
   *  the plugin location, working dir or staged, or $DURABLETS_HOST). */
  hostPath?: string;
  /** Scratch dir for transient slice files (.snap/.out/.log) and the
   *  derived schema cache. Blobs and journals live in memory, not here. */
  workdir?: string;
  /** Per-run virtual clock start (ISO string or epoch ms). Default 2027-01-01. */
  initialTime?: string | number;
  /** "auto" answers gates at once ({answer:"yes"}); "hold" keeps a gate
   *  open until the test delivers an answer. Default "auto". */
  gates?: "auto" | "hold";
  /** Repair re-answers attempted after a boundary failure before the
   *  plugin throws. Default 3. */
  maxRepairAttempts?: number;
}

export const prefixFor = (runId: string): string => runId.replace(/\//g, "_");
const shaBuf = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (p: string): string => shaBuf(fs.readFileSync(p));

interface RunEntry {
  runId: string;
  status: "running" | "suspended" | "done" | "failed";
  snap: string;
  out: string;
  log: string;
  env: Record<string, string>;
  rc: number | null;
  kind: "trap" | "combinator" | "done" | "error" | null;
  ordinal: number | null;
  fork: any | null;
  parentForkId: string | null;
  branch: number | null;
}

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

function resolveHostPath(): string {
  if (process.env.DURABLETS_HOST && fs.existsSync(process.env.DURABLETS_HOST))
    return process.env.DURABLETS_HOST;
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // Working dir: <workspace>/agentts-mock-plugin/src → <workspace>/agentts-repo/...
    path.resolve(here, "..", "..", "agentts-repo", "packages", "durablets", "durablets"),
    // Staged: <repo>/apps/agentts/plugins/mock/src → <repo>/packages/...
    path.resolve(here, "..", "..", "..", "..", "..", "packages", "durablets", "durablets"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    `C host binary not found (tried ${candidates.join(", ")}); build it with make -C <core> durablets or set $DURABLETS_HOST`,
  );
}

// Shared improve-loop mock logic (identical in both mock copies —
// plugins/mock/src/mock-adapter.ts and plugins/mock/src/mock-plugin.ts.
// The swap test requires identical answers, so this block is
// inserted verbatim into both files; keep them in sync. It mirrors
// workflows/library/worker.ts's improve-* implementations exactly (same
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

export class MockPlugin {
  readonly hostPath: string;
  readonly workdir: string;
  readonly cacheDir: string;
  readonly gates: "auto" | "hold";
  readonly maxRepairAttempts: number;
  private initialClockMs: number;
  private clocks = new Map<string, number>();
  private blobs = new Map<string, Buffer>();
  private journals = new Map<string, any[]>();
  private registry = new Map<string, RunEntry>();
  /** Final exit codes of runs that completed (their registry entries
   * are gone — the registry only holds in-flight runs). Lets drive()
   * return 0 for a run that completed in one slice instead of
   * throwing "no run entry". */
  private finished = new Map<string, number>();
  private extractions = new Map<string, Extraction>();
  private workflowPaths = new Map<string, string>();
  private inputs = new Map<string, unknown>();
  private logOffsets = new Map<string, number>();
  private validator = new SchemaValidator();
  private answerQueues = new Map<string, TrapAnswer[]>();
  private cannedFns = new Map<string, CannedFn>();
  private repairHandlers = new Map<string, RepairHandler>();
  private defaultRepair: RepairHandler | undefined;
  private gateQueue: unknown[] = [];
  private pendingGate = new Set<string>();
  /** Per-trap dispatch provenance, recorded in driveStepOnce and
   * attached to the trap-result/trap-error event in ingestLog
   * (BRA-57, same shape as the host's pendingTrapMeta). */
  private pendingTrapMeta = new Map<string, { adapter: string; worker?: string; wallMs: number; tokens?: number }>();

  constructor(config: MockPluginConfig = {}) {
    this.hostPath = config.hostPath ?? resolveHostPath();
    this.workdir = config.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mock-plugin-"));
    fs.mkdirSync(this.workdir, { recursive: true });
    this.cacheDir = path.join(this.workdir, ".schema-cache");
    this.gates = config.gates ?? "auto";
    this.maxRepairAttempts = config.maxRepairAttempts ?? 3;
    this.initialClockMs =
      typeof config.initialTime === "number"
        ? config.initialTime
        : Date.parse(config.initialTime ?? "2027-01-01T00:00:00.000Z");
  }

  // ---------------------------------------------------------- virtual clock
  /** A run's virtual clock, created at the configured start the first
   * time the run touches it. PER RUN, not per plugin: runs in one
   * plugin are hermetic — a run's output must not depend on what
   * another run advanced the clock to first (a shared clock made
   * the second run of the same workflow print different times,
   * caught by the gate re-gate test). */
  private clockMsFor(runId: string): number {
    const v = this.clocks.get(runId);
    if (v !== undefined) return v;
    this.clocks.set(runId, this.initialClockMs);
    return this.initialClockMs;
  }
  nowMs(runId: string): number {
    return this.clockMsFor(runId);
  }
  nowISO(runId: string): string {
    return new Date(this.clockMsFor(runId)).toISOString();
  }
  private advanceClock(ms: number, runId: string, reason: string): void {
    const from = this.clockMsFor(runId);
    const to = from + ms;
    this.clocks.set(runId, to);
    this.journalEvent(runId, {
      event: "clock-advance",
      runId,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      reason,
    });
  }
  private advanceClockTo(targetMs: number, runId: string, reason: string): void {
    if (targetMs > this.clockMsFor(runId)) this.advanceClock(targetMs - this.clockMsFor(runId), runId, reason);
  }

  // ------------------------------------------------------- canned answers
  /** Queue an answer (value or {throw}) for the next trap of this type. */
  queueAnswer(type: string, answer: TrapAnswer | unknown): void {
    const list = this.answerQueues.get(type) ?? [];
    list.push(
      answer !== null &&
        typeof answer === "object" &&
        ("value" in (answer as any) || "throw" in (answer as any))
        ? (answer as TrapAnswer)
        : { value: answer },
    );
    this.answerQueues.set(type, list);
  }
  /** Override the canned handler for a trap type entirely. */
  setCanned(type: string, fn: CannedFn): void {
    this.cannedFns.set(type, fn);
  }
  /** Repair handler for a trap type (see dispatchTrap). */
  setRepairHandler(type: string, fn: RepairHandler): void {
    this.repairHandlers.set(type, fn);
  }
  setDefaultRepairHandler(fn: RepairHandler): void {
    this.defaultRepair = fn;
  }
  queueGateAnswer(answer: unknown): void {
    this.gateQueue.push(answer);
  }
  isGatePending(runId: string): boolean {
    return this.pendingGate.has(runId);
  }

  // ------------------------------------------------------------- journals
  /** The journal writer: every event goes through check-then-serialize
   * first (JSONL has the same requirement as the trap boundary). A
   * non-JSON event is a plugin bug — fail loudly, never write a
   * corrupt journal line.
   *
   * Journal format v2 (BRA-57, same as the host): every event is
   * stamped here with `wallTs`, its wall-clock timestamp (ISO, ms
   * precision). This is the single choke point, so plugin-authored
   * events AND core events ingested from the C host both carry it.
   * An event that already carries one keeps it. Additive over v1. */
  journalEvent(runId: string, event: any): void {
    const clean = toJsonValue(event, "journal event"); // throws JsonBoundaryError on a bad event
    if (clean !== null && typeof clean === "object" && !("wallTs" in (clean as Record<string, unknown>))) {
      (clean as Record<string, unknown>).wallTs = new Date().toISOString();
    }
    const list = this.journals.get(runId) ?? [];
    list.push(clean);
    this.journals.set(runId, list);
  }
  journal(runId: string): any[] {
    return [...(this.journals.get(runId) ?? [])];
  }
  /** Dump in-memory journals as JSONL files into a scratch dir (for
   * evidence / inspection; the plugin's own record stays in memory). */
  dumpJournals(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const [runId, events] of this.journals) {
      const lines = events.map((e) => JSON.stringify(toJsonValue(e, "journal event"))).join("\n");
      fs.writeFileSync(path.join(dir, prefixFor(runId) + ".journal"), lines + (lines ? "\n" : ""));
    }
  }

  // ------------------------------------------------------------- registry
  registrySize(): number {
    return this.registry.size;
  }
  registryHas(runId: string): boolean {
    return this.registry.has(runId);
  }
  registryIds(): string[] {
    return [...this.registry.keys()];
  }
  /** Snapshot path of a registered run (test hook: hash it to prove
   * the parent snapshot is untouched while children run). */
  snapPath(runId: string): string | null {
    return this.registry.get(runId)?.snap ?? null;
  }
  /** Latest fork event of a run, if it suspended at a combinator. */
  forkOf(runId: string): any | null {
    return this.registry.get(runId)?.fork ?? null;
  }
  /** Last exit code of a registered run (test hook). */
  runRc(runId: string): number | null {
    return this.registry.get(runId)?.rc ?? null;
  }
  output(runId: string): string {
    const e = this.registry.get(runId);
    const outPath = e ? e.out : path.join(this.workdir, prefixFor(runId) + ".out");
    return fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  }

  // ----------------------------------------------------------- blob store
  /** In-memory blob store: the plugin's. The core produces/consumes
   * blob bytes at a path the plugin passes; it never chooses blob
   * paths. The live .snap file is a transient slice — the Map is the
   * store. */
  private storeBlob(runId: string, snap: string): void {
    const buf = fs.readFileSync(snap);
    this.blobs.set(runId, Buffer.from(buf));
    if (shaBuf(this.blobs.get(runId)!) !== shaFile(snap))
      throw new Error(`blob store mismatch for ${runId}`);
  }
  private loadBlob(runId: string, snap: string): void {
    const buf = this.blobs.get(runId);
    if (!buf) throw new Error(`no stored blob for ${runId}`);
    fs.writeFileSync(snap, buf);
    if (shaFile(snap) !== shaBuf(buf)) throw new Error(`blob restore mismatch for ${runId}`);
  }
  blobStored(runId: string): boolean {
    return this.blobs.has(runId);
  }
  storedBlobHash(runId: string): string | null {
    const b = this.blobs.get(runId);
    return b ? shaBuf(b) : null;
  }
  /** Test hook: delete the live blob file. The run must still resume
   * from the in-memory stored copy alone. */
  deleteLiveBlob(runId: string): void {
    const e = this.registry.get(runId);
    if (e && fs.existsSync(e.snap)) fs.rmSync(e.snap);
  }
  restoreBlob(runId: string): void {
    const e = this.registry.get(runId);
    if (!e) throw new Error(`no run entry for ${runId}`);
    this.loadBlob(runId, e.snap);
  }

  // ---------------------------------------------------------------- spawn
  private ingestLog(logPath: string): void {
    const prev = this.logOffsets.get(logPath) || 0;
    if (!fs.existsSync(logPath)) return;
    const buf = fs.readFileSync(logPath);
    if (buf.length <= prev) return;
    const text = buf.subarray(prev).toString("utf8");
    this.logOffsets.set(logPath, buf.length);
    for (const line of text.split("\n")) {
      const m = line.match(/^\[durablets\] (\{.*\})\s*$/);
      if (!m) continue;
      let ev: any;
      try {
        ev = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const runId: string = ev.runId;
      if (!runId) continue;
      // BRA-57: attach dispatch provenance to trap-result/trap-error
      // events, recorded in driveStepOnce (same shape as the host's
      // pendingTrapMeta): the adapter that answered ("mock" — the
      // canned answers), the host-measured dispatch wall time,
      // worker/tokens when the answer carried them (canned answers
      // carry neither today).
      if ((ev.event === "trap-result" || ev.event === "trap-error") && typeof ev.trapId === "string") {
        const meta = this.pendingTrapMeta.get(ev.trapId);
        if (meta) {
          this.pendingTrapMeta.delete(ev.trapId);
          ev.adapter = meta.adapter;
          if (meta.worker !== undefined) ev.worker = meta.worker;
          ev.wallMs = meta.wallMs;
          if (meta.tokens !== undefined) ev.tokens = meta.tokens;
        }
      }
      // BRA-73 (BRA-88): promote the wrapper-captured call site to
      // the trap event's top-level `site` and strip the transport key
      // from the journaled arg, so the journaled arg stays exactly
      // the spec the author passed — same as the host's ingest
      // (src/host.ts). A trap with no site (a direct trap() caller,
      // or an unparseable stack) simply carries none.
      if (ev.event === "trap" && typeof ev.trapId === "string") {
        const { arg, site } = splitTrapSite(ev.arg);
        if (site) ev.site = site;
        ev.arg = arg;
      }
      // The plugin journals every core event (its journal, plugin-side).
      this.journalEvent(runId, ev);
      // The registry follows lifecycle events ONLY.
      if (ev.event === "lifecycle") {
        const e = this.registry.get(runId);
        if (e) {
          if (ev.lifecycle === "completed") e.status = "done";
          else if (ev.lifecycle === "failed") e.status = "failed";
          else if (ev.lifecycle === "suspended") e.status = "suspended";
          else e.status = "running";
        }
        if (ev.lifecycle === "completed" || ev.lifecycle === "failed") {
          this.registry.delete(runId);
        }
      }
    }
  }

  private runHost(
    args: string[],
    outPath: string,
    logPath: string,
    envExtra: Record<string, string>,
  ): number {
    const env = { ...process.env, ...envExtra } as Record<string, string>;
    fs.appendFileSync(outPath, "");
    fs.appendFileSync(logPath, "");
    const r = spawnSync(this.hostPath, args, { env, encoding: "utf8" });
    if (r.stdout) fs.appendFileSync(outPath, r.stdout);
    if (r.stderr) fs.appendFileSync(logPath, r.stderr);
    if (r.error) throw new Error(`host spawn failed: ${r.error}`);
    this.ingestLog(logPath);
    return r.status ?? 1;
  }

  private refresh(entry: RunEntry): void {
    const events = this.journal(entry.runId);
    if (entry.rc === 2) {
      const traps = events.filter((e) => e.event === "trap");
      entry.kind = "trap";
      entry.ordinal = traps.length ? traps[traps.length - 1].ordinal : null;
      entry.fork = null;
    } else if (entry.rc === 3) {
      entry.kind = "combinator";
      const forks = events.filter((e) => e.event === "fork");
      entry.fork = forks.length ? forks[forks.length - 1] : null;
      entry.ordinal = null;
    } else if (entry.rc === 0) {
      entry.kind = "done";
    } else {
      entry.kind = "error";
    }
  }

  private clean(prefix: string): void {
    // Remove stale per-run artifacts.
    const suffixes = [".snap", ".out", ".log", ".outcome.json", ".join-throw.json", ".join-value.json", ".join-aggregate.json", ".cancel.json"];
    for (const f of fs.readdirSync(this.workdir)) {
      if (!f.startsWith(prefix + ".")) continue;
      if (f.startsWith(prefix + ".join-value-")) {
        fs.rmSync(path.join(this.workdir, f));
        this.logOffsets.delete(path.join(this.workdir, f));
        continue;
      }
      if (suffixes.some((s) => f.endsWith(s))) {
        fs.rmSync(path.join(this.workdir, f));
        this.logOffsets.delete(path.join(this.workdir, f));
      }
    }
    // The schema cache lives under the workdir; never delete it here.
  }

  // ------------------------------------------------------- extraction hook
  /** How many first-run gates this plugin instance has run. A second
   * run of the same workflow version must not increment it — the
   * cached gate result + schemas are reused. */
  gateRuns = 0;

  /** How many M2 checker runs this plugin instance has run (BRA-29).
   * Same caching rule as gateRuns: a second run of the same
   * workflow version reuses the cached checker result and does not
   * increment it. The checker runs in the onExtracted hook, after
   * extraction and before the cache write. */
  checkerRuns = 0;

  /** Extract (or load from the content-hash cache) a workflow's trap
   * contracts. Returns the workflow path itself — the workflow runs
   * as-is, verbatim: there is no transform (the landed BRA-46 module
   * guarantees the trap arg is exactly the spec the author passed).
   * Throws ExtractionError — loudly, before any spawn — when a trap
   * call has no extractable type.
   *
   * The first-run pipeline (CHECK → EXTRACT → CHECKER → CACHE) is IN
   * the run path, not beside it: prepareRun is the only way to start
   * a run, and the gate runs automatically on a cache miss (new
   * content hash). The gate hook throws GateError — structured
   * diagnostics back to the authoring agent — when the workflow does
   * not type-check; extraction throws ExtractionError when a type
   * cannot be validated; the M2 checker (onExtracted hook, BRA-29)
   * throws CheckerError when a class/empty contract, a wiring
   * mismatch, or a layering violation is found. Either way the run
   * never starts, and a checker failure aborts before the cache
   * write, so it is never cached as gated. */
  prepareRun(workflowPath: string, runId: string): { extraction: Extraction } {
    this.workflowPaths.set(runId, path.resolve(workflowPath));
    const extraction = extractWorkflow(workflowPath, this.cacheDir, {
      onFirstRun: (program) => {
        this.gateRuns++;
        // Layering first, then tsc: a forbidden import need not
        // type-check to be a violation (runGateWithLayering).
        runGateWithLayering(program, workflowPath);
      },
      // M2 checker (BRA-29): the gate's AgentTS-specific half. It
      // runs on the same program, after extraction, before the cache
      // write. Throws CheckerError with structured diagnostics.
      onExtracted: (entry, program) => {
        this.checkerRuns++;
        runChecker(program, workflowPath, entry);
      },
    });
    this.extractions.set(runId, extraction);
    return { extraction };
  }

  /** Validate a workflow's input against its entry contract (the
   * workflow boundary is a trap boundary too: JSON-clean first, then
   * schema) and store the validated input for the driver. (Same
   * logic as the host — the mock plugin is the engine the host
   * mirrors, so its refusals must match.) */
  private validateAndStoreInput(runId: string, input: unknown): void {
    const extraction = this.extractions.get(runId);
    if (!extraction) throw new Error(`no extraction for ${runId} — call prepareRun first`);
    const entry = extraction.entry;
    if (!entry.inputType) {
      if (input !== undefined) {
        throw new Error(`workflow ${entry.name} takes no input but an input was provided`);
      }
      this.inputs.delete(runId);
      return;
    }
    if (input === undefined) {
      throw new Error(`workflow ${entry.name} requires an input (${entry.inputType})`);
    }
    let clean: unknown;
    try {
      clean = toJsonValue(input, "input");
    } catch (e) {
      if (e instanceof JsonBoundaryError) {
        throw new Error(`input is not JSON-clean: ${e.message}`);
      }
      throw e;
    }
    const issues = this.validator.validate(clean, entry.inputSchema);
    if (issues.length) {
      throw new Error(
        `input does not match ${entry.inputType}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    }
    this.inputs.set(runId, clean);
  }

  /** Generate the host driver for a run: global code that arms the
   * entry guard (__agentts_begin) and calls the exported entry
   * function with the validated input JSON. (Same as the host's
   * driverFor — the driver is internal machinery, not author code.) */
  driverFor(runId: string): string {
    const wp = this.workflowPaths.get(runId);
    const extraction = this.extractions.get(runId);
    if (!wp || !extraction) {
      throw new Error(`no prepared run ${runId} — call prepareRun first`);
    }
    const hasInput = extraction.entry.inputType !== null;
    const inputJson = hasInput ? JSON.stringify(this.inputs.get(runId)) : "";
    const driverPath = path.join(this.workdir, `${prefixFor(runId)}.driver.ts`);
    const driver =
      `// Mock-plugin driver for ${runId} (not author code): arm the\n` +
      `// entry guard, then call the workflow's exported entry function\n` +
      `// from global code with the validated input JSON.\n` +
      `import entry from ${JSON.stringify(wp)};\n` +
      `declare function __agentts_begin(): void;\n` +
      `__agentts_begin();\n` +
      (hasInput ? `entry(${inputJson});\n` : `entry();\n`);
    fs.writeFileSync(driverPath, driver);
    return driverPath;
  }

  /** Bundle a driver + the workflow + the agentts module into one
   * self-contained script with Bun.build; the C host never resolves
   * imports. Refuses loudly when the bundle still contains export
   * or import syntax after the build — a bundle the C host would
   * eval as a module (which cannot suspend) is a broken run. */
  async bundle(entryPath: string, outName: string): Promise<string> {
    const outPath = path.join(this.workdir, outName);
    const result = await Bun.build({
      entrypoints: [entryPath],
      outdir: this.workdir,
      target: "bun",
      naming: outName,
    });
    if (!result.success) {
      for (const log of result.logs) console.log(String(log));
      throw new Error("Bun.build failed");
    }
    if (!fs.existsSync(outPath)) throw new Error("no bundle output");
    const text = fs.readFileSync(outPath, "utf8");
    if (/^\s*export\s/m.test(text) || /^\s*import\s/m.test(text)) {
      throw new Error(
        `bundle ${outPath} still contains export/import syntax after Bun.build — refusing to run a bundle the C host would eval as a module`,
      );
    }
    return outPath;
  }

  startRunFrom(entryPath: string, runId: string): number {
    const p = prefixFor(runId);
    this.clean(p);
    this.journals.delete(runId);
    const env = { AGENTTS_RUN_ID: runId };
    const rc = this.runHost(
      ["run", entryPath, path.join(this.workdir, p + ".snap")],
      path.join(this.workdir, p + ".out"),
      path.join(this.workdir, p + ".log"),
      env,
    );
    const entry: RunEntry = {
      runId,
      status: rc === 0 ? "done" : rc === 2 || rc === 3 ? "suspended" : "running",
      snap: path.join(this.workdir, p + ".snap"),
      out: path.join(this.workdir, p + ".out"),
      log: path.join(this.workdir, p + ".log"),
      env,
      rc,
      kind: null,
      ordinal: null,
      fork: null,
      parentForkId: null,
      branch: null,
    };
    this.registry.set(runId, entry);
    this.refresh(entry);
    if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
    else {
      this.registry.delete(runId);
      this.finished.set(runId, rc);
    }
    return rc;
  }

  /** Start a workflow: gate + extract + validate the input, generate
   * the driver, bundle it, then spawn the C host. The run suspends
   * at its first trap/combinator (exit 2/3) or completes (exit 0).
   * Stepwise engine control for the mock suite's cancellation tests
   * — the mock plugin keeps its public engine interface (startRun /
   * drive), because the mock suite tests the PLUGIN (the engine),
   * not the host run path. */
  async startRun(workflowPath: string, runId: string, input?: unknown): Promise<number> {
    this.prepareRun(workflowPath, runId);
    this.validateAndStoreInput(runId, input);
    const driverPath = this.driverFor(runId);
    const bundle = await this.bundle(driverPath, `bundle-${prefixFor(runId)}.js`);
    return this.startRunFrom(bundle, runId);
  }

  // ------------------------------------------------------------ dispatch
  private mockJob(arg: any): any {
    // New agentts-module shape (BRA-46): { spec, input }. The jobspec
    // name selects the canned result; the input carries the parameters.
    // (Same logic as the reference driver — the swap test requires
    // identical answers.)
    if (arg && typeof arg.spec === "string") {
      // Improve-loop specs (standard library): input-dependent mock
      // answers — the same logic as the host mock adapter (the block
      // above), so the two mock copies stay identical.
      if (arg.spec === "improve-judge") return mockImproveJudge(arg);
      if (arg.spec === "improve-aggregate") return mockImproveAggregate(arg);
      if (arg.spec === "improve-decide") return mockImproveDecide(arg);
      if (arg.spec === "improve-fix") return mockImproveFix(arg);
      if (arg.spec === "improve-write") return mockImproveWrite(arg);
      // BRA-47: the cascade's job tier ("decision" jobspec). No canned
      // decision exists — the mock answers the first option at 0.5, a
      // deliberate guess: a cascade tier at/above its threshold would
      // need a queued answer, and an unconfigured mock run escalates
      // instead of deciding on a made-up confidence. (Same logic as
      // the host mock adapter, so the two mock copies stay identical.)
      if (arg.spec === "decision") {
        const options: string[] = Array.isArray(arg.input?.options) ? arg.input.options : [];
        return {
          choice: options[0] ?? "yes",
          confidence: 0.5,
          reason: "mock default: no canned decision answer; first option at 0.5",
        };
      }
      if (arg.spec === "aggregate") {
        const verdicts = arg.input?.verdicts || [];
        const ok = verdicts.filter((v: any) => v.ok).length;
        return {
          approved: ok,
          failed: verdicts.length - ok,
          summary: `${ok} approved, ${verdicts.length - ok} failed`,
        };
      }
      const key = `${arg.spec}:${arg.input?.value}`;
      if (key in MOCK) return MOCK[key];
      console.error(`[mock] no canned result for ${key}; using default`);
      return { score: 0.5, label: "default" };
    }
    // Old direct-trap shape { op, value, verdicts } (workflow-*.ts).
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

  private defaultAnswer(type: string, arg: any, runId: string): TrapAnswer | typeof HOLD {
    switch (type) {
      case "job":
        return { value: this.mockJob(arg) };
      case "exec": {
        // `cat <file>` reads the file for real — rubric-file
        // resolution (improve-loop) depends on it.
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
      case "sleep": {
        const ms = typeof arg?.ms === "number" ? arg.ms : 0;
        // Virtual time: the clock jumps by the duration instantly.
        // No real waiting, ever.
        this.advanceClock(ms, runId, "sleep");
        return { value: { sleptMs: ms } };
      }
      case "cron": {
        const at = arg?.at;
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        // Virtual time: the clock jumps to the target datetime.
        // A target already past fires immediately, clock unchanged.
        if (!Number.isNaN(t)) this.advanceClockTo(t, runId, "cron");
        return { value: { scheduled: at } };
      }
      case "decide":
        return { value: { choice: "a", confidence: 0.9 } };
      case "clock":
        return { value: { now: this.nowISO(runId), nowMs: this.clockMsFor(runId) } };
      default:
        console.error(`[mock] unknown trap type ${type}; using default`);
        return { value: { score: 0.5, label: "default" } };
    }
  }

  private resolveAnswer(
    type: string,
    arg: any,
    runId: string,
    trapId: string,
  ): TrapAnswer | typeof HOLD {
    const queued = this.answerQueues.get(type);
    if (queued && queued.length) return queued.shift()!;
    const fn = this.cannedFns.get(type);
    if (fn) {
      const a = fn(type, arg, { runId, trapId });
      if (a !== undefined) return a;
    }
    return this.defaultAnswer(type, arg, runId);
  }

  private validationErrorRecord(
    trapId: string,
    phase: "json-clean" | "output",
    attempt: number,
    detail: string,
  ): { name: string; message: string } {
    const stage =
      phase === "json-clean"
        ? "result is not JSON-clean"
        : "output validation failed";
    return {
      name: "ValidationError",
      message: `${stage} for ${trapId} (attempt ${attempt}): ${detail}`,
    };
  }

  private journalValidation(
    runId: string,
    trapId: string,
    phase: "json-clean" | "output",
    attempt: number,
    issues: (JsonIssue | SchemaIssue)[],
    context?: string,
  ): void {
    this.journalEvent(runId, {
      event: "validation-error",
      runId,
      trapId,
      phase,
      attempt,
      ...(context ? { context } : {}),
      errors: issues,
    });
  }

  /**
   * Dispatch a trap: resolve the canned answer, then enforce the
   * boundary BEFORE resuming:
   *   1. JSON-clean check first (can this even cross?) — the
   *      module's toJsonValue, Date the one sanctioned conversion,
   *      to ISO string.
   *   2. Schema validation against the cached output schema for the
   *      trap's site key (AJV-compiled). The site key comes from the
   *      runtime (type, arg) — the arg is verbatim, so the key is
   *      job:<spec|op> or the bare type; the plugin tries the
   *      specific key, then the bare type key.
   * Either failure is RETRYABLE: the precise error goes to the repair
   * handler with the failed answer attached (same trapId — the trap
   * is re-answered, not re-dispatched); the handler may return a
   * repaired value, which is checked again, up to maxRepairAttempts.
   * Exhausted (or no handler): throw at the call site — resume with
   * throw, so the workflow's ordinary try/catch sees a real Error
   * named ValidationError — with the precise error journaled.
   * A trap whose key has no cached schema never silently skips
   * validation: that is a loud plugin error (host bug), not a throw.
   */
  private dispatchTrap(
    runId: string,
    trapId: string,
    type: string,
    arg: any,
  ): TrapAnswer | typeof HOLD {
    // BRA-73 (BRA-88): strip the wrapper-attached call-site
    // transport key before anything consumes the arg — siteKeyFor,
    // the adapter, and the repair handler all see exactly the spec
    // the author passed. (The site itself was already promoted to
    // the trap event's top-level `site` at ingest; the dispatch path
    // only needs the clean arg.) Same as the host's dispatchTrap.
    arg = splitTrapSite(arg).arg;
    const extraction = this.extractions.get(runId);
    const key = siteKeyFor(type, arg);
    const site: SiteEntry | undefined =
      extraction?.sites[key] ?? extraction?.sites[type];
    if (!site) {
      throw new Error(
        `no extracted schema for trap ${trapId} (key ${key}) — ` +
          `the workflow was not extracted, or the trap was never seen at extraction; a trap with no extractable type must fail loudly at first run, never run unvalidated`,
      );
    }

    let answer = this.resolveAnswer(type, arg, runId, trapId);
    if (answer === HOLD) {
      this.pendingGate.add(runId);
      this.journalEvent(runId, {
        event: "gate-held",
        runId,
        trapId,
        question: arg?.question ?? null,
      });
      return HOLD;
    }
    if ("throw" in answer) {
      // A throw payload crosses the same resume path as a value: it
      // must be JSON-clean too (JSON.stringify would silently mangle
      // it). If it is not, deliver a ValidationError describing the
      // bad payload instead — the original throw cannot cross.
      try {
        answer = { throw: toJsonValue(answer.throw, "throw") };
      } catch (e) {
        if (e instanceof JsonBoundaryError) {
          const issues = [boundaryIssue(e)];
          this.journalValidation(runId, trapId, "json-clean", 0, issues, "throw-payload");
          return {
            throw: this.validationErrorRecord(trapId, "json-clean", 0, formatIssues(issues)),
          };
        }
        throw e;
      }
      return answer;
    }

    let attempt = 0;
    let current: unknown = answer.value;
    for (;;) {
      let cleaned: unknown;
      try {
        cleaned = toJsonValue(current, "result");
      } catch (e) {
        if (!(e instanceof JsonBoundaryError)) throw e;
        const issues = [boundaryIssue(e)];
        this.journalValidation(runId, trapId, "json-clean", attempt, issues);
        if (attempt >= this.maxRepairAttempts) {
          return { throw: this.validationErrorRecord(trapId, "json-clean", attempt, formatIssues(issues)) };
        }
        const repaired = this.tryRepair(type, arg, runId, trapId, site, attempt, "json-clean", issues, current);
        if (!repaired) {
          return { throw: this.validationErrorRecord(trapId, "json-clean", attempt, formatIssues(issues)) };
        }
        if ("throw" in repaired) return repaired;
        current = repaired.value;
        attempt++;
        continue;
      }
      const schemaIssues = this.validator.validate(cleaned, site.outputSchema);
      if (!schemaIssues.length) return { value: cleaned };
      this.journalValidation(runId, trapId, "output", attempt, schemaIssues);
      if (attempt >= this.maxRepairAttempts) {
        return { throw: this.validationErrorRecord(trapId, "output", attempt, formatSchemaIssues(schemaIssues)) };
      }
      const repaired = this.tryRepair(type, arg, runId, trapId, site, attempt, "output", schemaIssues, current);
      if (!repaired) {
        return { throw: this.validationErrorRecord(trapId, "output", attempt, formatSchemaIssues(schemaIssues)) };
      }
      if ("throw" in repaired) return repaired;
      current = repaired.value;
      attempt++;
    }
  }

  private tryRepair(
    type: string,
    arg: any,
    runId: string,
    trapId: string,
    site: SiteEntry,
    attempt: number,
    phase: "json-clean" | "output",
    issues: (JsonIssue | SchemaIssue)[],
    previousAnswer: unknown,
  ): TrapAnswer | undefined {
    const handler = this.repairHandlers.get(type) ?? this.defaultRepair;
    if (!handler) return undefined;
    return handler({
      type,
      arg,
      trapId,
      runId,
      trapSite: site.key,
      attempt,
      phase,
      issues,
      previousAnswer,
    });
  }

  // ------------------------------------------------------------- drive
  private lastTrap(logPath: string): any | null {
    if (!fs.existsSync(logPath)) return null;
    let last: any = null;
    for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
      const m = line.match(/^\[durablets\] (\{.*\})\s*$/);
      if (!m) continue;
      try {
        const ev = JSON.parse(m[1]);
        if (ev.event === "trap") last = ev;
      } catch {
        /* ignore */
      }
    }
    return last;
  }
  private lastFork(runId: string): any | null {
    const forks = this.journal(runId).filter((e) => e.event === "fork");
    return forks.length ? forks[forks.length - 1] : null;
  }
  private forksOf(runId: string): any[] {
    return this.journal(runId).filter((e) => e.event === "fork");
  }

  private deliverResult(runId: string, result: any): number {
    const entry = this.registry.get(runId)!;
    this.loadBlob(runId, entry.snap);
    const rc = this.runHost(["resume", entry.snap, JSON.stringify(result)], entry.out, entry.log, entry.env);
    entry.rc = rc;
    this.refresh(entry);
    if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
    return rc;
  }

  private deliverThrow(runId: string, err: any): number {
    const entry = this.registry.get(runId)!;
    this.loadBlob(runId, entry.snap);
    const rc = this.runHost(
      ["resume", entry.snap, "throw:" + JSON.stringify(err)],
      entry.out,
      entry.log,
      entry.env,
    );
    entry.rc = rc;
    this.refresh(entry);
    if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
    return rc;
  }

  private recordCancel(child: string, forkId: string, branch: number, trigger: string, extra: any = {}): void {
    this.journalEvent(child, {
      event: "cancel",
      runId: child,
      parentForkId: forkId,
      branch,
      trigger,
      ...extra,
    });
  }

  private startBranch(
    child: string,
    snap: string,
    index: number,
    env: Record<string, string>,
    forkId: string,
    parentRunId: string,
  ): number {
    const cprefix = prefixFor(child);
    const csnap = path.join(this.workdir, cprefix + ".snap");
    this.clean(cprefix);
    this.journals.delete(child);
    fs.copyFileSync(snap, csnap);
    fs.writeFileSync(path.join(this.workdir, cprefix + ".out"), "");
    fs.writeFileSync(path.join(this.workdir, cprefix + ".log"), "");
    const cenv = { ...env, AGENTTS_RUN_ID: child, AGENTTS_PARENT_FORK: forkId };
    const rc = this.runHost(
      ["branch", csnap, String(index)],
      path.join(this.workdir, cprefix + ".out"),
      path.join(this.workdir, cprefix + ".log"),
      cenv,
    );
    const entry: RunEntry = {
      runId: child,
      status: rc === 0 ? "done" : rc === 2 || rc === 3 ? "suspended" : "running",
      snap: csnap,
      out: path.join(this.workdir, cprefix + ".out"),
      log: path.join(this.workdir, cprefix + ".log"),
      env: cenv,
      rc,
      kind: null,
      ordinal: null,
      fork: null,
      parentForkId: forkId,
      branch: index,
    };
    this.registry.set(child, entry);
    this.refresh(entry);
    const parentExtraction = this.extractions.get(parentRunId);
    if (parentExtraction) this.extractions.set(child, parentExtraction);
    if (rc === 2 || rc === 3) this.storeBlob(child, csnap);
    else {
      this.registry.delete(child);
      this.finished.set(child, rc);
    }
    return rc;
  }

  private branchOutcome(outPath: string, index: number): any | null {
    if (!fs.existsSync(outPath)) return null;
    const prefix = `branch ${index} outcome: `;
    for (const line of fs.readFileSync(outPath, "utf8").split("\n")) {
      if (line.startsWith(prefix)) {
        try {
          return JSON.parse(line.slice(prefix.length));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private runOneBranch(
    children: string[],
    i: number,
    snap: string,
    env: Record<string, string>,
    forkId: string,
    parentRunId: string,
  ): { outcome: any; outcomePath: string } {
    const child = children[i];
    const cprefix = prefixFor(child);
    this.startBranch(child, snap, i, env, forkId, parentRunId);
    const rc = this.drive(child);
    if (rc !== 0) throw new Error(`branch ${child} exited ${rc}`);
    const outcome = this.branchOutcome(path.join(this.workdir, cprefix + ".out"), i);
    if (outcome === null) throw new Error(`no outcome for ${child}`);
    const outcomePath = path.join(this.workdir, cprefix + ".outcome.json");
    fs.writeFileSync(outcomePath, JSON.stringify(toJsonValue(outcome, "branch outcome")));
    return { outcome, outcomePath };
  }

  private snapUntouched(snap: string, before: string): boolean {
    if (shaFile(snap) !== before) {
      throw new Error(`${snap} changed while children ran (parent snapshot not untouched)`);
    }
    return true;
  }

  private doAllJoin(
    snap: string,
    outPath: string,
    logPath: string,
    env: Record<string, string>,
    fork: any,
  ): number {
    const prefix = prefixFor(fork.runId);
    const forkId = fork.forkId;
    const children: string[] = fork.childRuns;
    const failFast = !!fork.failFast;
    const before = shaFile(snap);
    const outcomes: string[] = [];
    const completed: any[] = [];
    let failedBranch: number | null = null;
    let failedError: any = null;
    const cancelled: number[] = [];
    for (let i = 0; i < children.length; i++) {
      const r = this.runOneBranch(children, i, snap, env, forkId, fork.runId);
      completed.push(r.outcome);
      outcomes.push(r.outcomePath);
      if (failFast && !r.outcome.ok) {
        failedBranch = i;
        failedError = r.outcome.error;
        for (let j = i + 1; j < children.length; j++) {
          cancelled.push(j);
          this.recordCancel(children[j], forkId, j, "sibling failed with fail-fast on", {
            failedBranch,
            error: failedError,
          });
        }
        break;
      }
    }
    this.snapUntouched(snap, before);
    if (failFast && failedBranch !== null) {
      const record = {
        failedBranch,
        error: failedError,
        cancelled,
        completed: completed.slice(0, -1),
      };
      const recordPath = path.join(this.workdir, prefix + ".join-throw.json");
      fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
      this.loadBlob(fork.runId, snap);
      return this.runHost(["join-throw", snap, recordPath], outPath, logPath, env);
    }
    if (failFast) {
      const valueFiles: string[] = [];
      for (let k = 0; k < completed.length; k++) {
        const vpath = path.join(this.workdir, `${prefix}.join-value-${k}.json`);
        fs.writeFileSync(vpath, JSON.stringify(toJsonValue(completed[k].value, "join value")));
        valueFiles.push(vpath);
      }
      this.loadBlob(fork.runId, snap);
      return this.runHost(["join", snap, ...valueFiles], outPath, logPath, env);
    }
    this.loadBlob(fork.runId, snap);
    return this.runHost(["join", snap, ...outcomes], outPath, logPath, env);
  }

  private doAnyJoin(
    snap: string,
    outPath: string,
    logPath: string,
    env: Record<string, string>,
    fork: any,
  ): number {
    const forkId = fork.forkId;
    const children: string[] = fork.childRuns;
    const before = shaFile(snap);
    const errors: any[] = [];
    const completed: any[] = [];
    for (let i = 0; i < children.length; i++) {
      const r = this.runOneBranch(children, i, snap, env, forkId, fork.runId);
      if (r.outcome.ok) {
        const cancelled: number[] = [];
        for (let j = i + 1; j < children.length; j++) {
          cancelled.push(j);
          this.recordCancel(children[j], forkId, j, "loser in any", { winner: i });
        }
        this.snapUntouched(snap, before);
        const record = { value: r.outcome.value, winner: i, cancelled, completed };
        const recordPath = path.join(this.workdir, prefixFor(forkId) + ".join-value.json");
        fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
        this.loadBlob(fork.runId, snap);
        return this.runHost(["join-value", snap, recordPath], outPath, logPath, env);
      }
      errors.push(r.outcome.error);
      completed.push(r.outcome);
    }
    this.snapUntouched(snap, before);
    const record = { errors, completed, cancelled: [] };
    const recordPath = path.join(this.workdir, prefixFor(forkId) + ".join-aggregate.json");
    fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
    this.loadBlob(fork.runId, snap);
    return this.runHost(["join-aggregate", snap, recordPath], outPath, logPath, env);
  }

  private doRaceJoin(
    snap: string,
    outPath: string,
    logPath: string,
    env: Record<string, string>,
    fork: any,
  ): number {
    const forkId = fork.forkId;
    const children: string[] = fork.childRuns;
    const before = shaFile(snap);
    const r = this.runOneBranch(children, 0, snap, env, forkId, fork.runId);
    const cancelled: number[] = [];
    for (let j = 1; j < children.length; j++) {
      cancelled.push(j);
      this.recordCancel(children[j], forkId, j, "loser in race", { winner: 0 });
    }
    this.snapUntouched(snap, before);
    if (r.outcome.ok) {
      const record = { value: r.outcome.value, winner: 0, cancelled, completed: [] };
      const recordPath = path.join(this.workdir, prefixFor(forkId) + ".join-value.json");
      fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
      this.loadBlob(fork.runId, snap);
      return this.runHost(["join-value", snap, recordPath], outPath, logPath, env);
    }
    const record = { failedBranch: 0, error: r.outcome.error, cancelled, completed: [] };
    const recordPath = path.join(this.workdir, prefixFor(forkId) + ".join-throw.json");
    fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
    this.loadBlob(fork.runId, snap);
    return this.runHost(["join-throw", snap, recordPath], outPath, logPath, env);
  }

  /**
   * Drive one step: answer one pending trap, or join one pending
   * fork. Returns the run's exit code afterwards (0 done, 1 error,
   * 2 suspended at a trap — including a held gate, see isGatePending
   * — 3 suspended at a combinator). Stepwise control is what the
   * cancel-vs-complete race tests use: deliver one result, then
   * cancel the next trap.
   */
  driveStep(runId: string, opts: { allowUnresolved?: boolean } = {}): number {
    const rc = this.driveStepOnce(runId, opts);
    if (rc === 0 || rc === 1) this.finished.set(runId, rc);
    return rc;
  }

  private driveStepOnce(runId: string, opts: { allowUnresolved?: boolean } = {}): number {
    const entry = this.registry.get(runId);
    if (!entry) {
      const f = this.finished.get(runId);
      if (f !== undefined) return f;
      throw new Error(`no run entry for ${runId}`);
    }
    let rc = entry.rc!;
    if (rc === 2) {
      const trapEv = this.lastTrap(entry.log);
      if (!trapEv) throw new Error(`no trap event in ${entry.log} for ${runId}`);
      // BRA-57: time the dispatch (same measurement the host records
      // in cost-actuals.jsonl) and record provenance for the
      // trap-result/trap-error event the C host emits on resume.
      const startedAt = Date.now();
      const ans = this.dispatchTrap(runId, trapEv.trapId, trapEv.type, trapEv.arg);
      const wallMs = Date.now() - startedAt;
      if (ans === HOLD) return 2;
      this.pendingGate.delete(runId);
      this.pendingTrapMeta.set(trapEv.trapId, {
        adapter: "mock",
        ...(typeof (ans as any).worker === "string" ? { worker: (ans as any).worker as string } : {}),
        wallMs,
        ...(typeof (ans as any).tokens === "number" ? { tokens: (ans as any).tokens as number } : {}),
      });
      if ("throw" in ans) rc = this.deliverThrow(runId, ans.throw);
      else rc = this.deliverResult(runId, ans.value);
      return rc;
    }
    if (rc === 3) {
      const fork = this.lastFork(runId);
      if (!fork) throw new Error(`no fork event in journal for ${runId}`);
      if (!fork.childRuns.length) {
        if (opts.allowUnresolved) return 3;
        throw new Error(`fork ${fork.forkId} has no children and the drive is not bounded`);
      }
      const env = { AGENTTS_RUN_ID: runId };
      if (fork.kind === "all") rc = this.doAllJoin(entry.snap, entry.out, entry.log, env, fork);
      else if (fork.kind === "any") rc = this.doAnyJoin(entry.snap, entry.out, entry.log, env, fork);
      else if (fork.kind === "race") rc = this.doRaceJoin(entry.snap, entry.out, entry.log, env, fork);
      else throw new Error(`unknown fork kind ${fork.kind}`);
      const e2 = this.registry.get(runId);
      if (e2) {
        e2.rc = rc;
        this.refresh(e2);
        if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
      }
      return rc;
    }
    return rc;
  }

  /**
   * Drive one run to completion. Returns the final exit code: 0 done,
   * 1 error, 2 suspended at a held gate (see isGatePending), 3 still
   * suspended at a 0-branch fork when allowUnresolved. Throws on
   * plugin errors (branch failure, snapshot touched, missing schema).
   */
  drive(runId: string, opts: { allowUnresolved?: boolean } = {}): number {
    const entry = this.registry.get(runId);
    if (!entry) {
      const f = this.finished.get(runId);
      if (f !== undefined) return f;
      throw new Error(`no run entry for ${runId}`);
    }
    let rc = entry.rc!;
    let rounds = 0;
    while (rc === 2 || rc === 3) {
      rounds++;
      if (rounds > 50) throw new Error(`drive loop exceeded for ${runId}`);
      rc = this.driveStep(runId, opts);
      // A held gate stops the drive here (rc stays 2): the run is
      // suspended until the test delivers an answer. Without this
      // the loop would re-dispatch the same held gate forever.
      if (this.pendingGate.has(runId)) return 2;
      if (opts.allowUnresolved && rc === 3) {
        const fork = this.lastFork(runId);
        if (fork && !fork.childRuns.length) return 3;
      }
    }
    return rc;
  }

  /**
   * Start every branch of a fork-suspended run WITHOUT driving them
   * (each child suspends at its first trap/combinator or completes).
   * The parent stays suspended and its snapshot is untouched. This is
   * the hook cancellation tests use: start the tree, then cancel it
   * deepest-first. Normal driving (drive()) starts branches and joins
   * them in one step; this exposes the start step separately.
   */
  startForkBranches(runId: string): string[] {
    const entry = this.registry.get(runId);
    if (!entry || entry.rc !== 3 || !entry.fork) {
      throw new Error(`run ${runId} is not suspended at a combinator`);
    }
    const fork = entry.fork;
    const children: string[] = fork.childRuns;
    for (let i = 0; i < children.length; i++) {
      this.startBranch(children[i], entry.snap, i, entry.env, fork.forkId, runId);
    }
    return children;
  }

  /** Deliver a held gate's answer, then keep driving. */
  deliverGate(runId: string, answer: unknown): number {
    if (!this.pendingGate.has(runId)) throw new Error(`no gate pending for ${runId}`);
    this.gateQueue.push(answer);
    return this.drive(runId);
  }

  // -------------------------------------------------------- cancellation
  cancelRun(
    runId: string,
    reason: string,
    trigger: string,
    cancelled: string[] | null = null,
  ): number | null {
    const entry = this.registry.get(runId)!;
    if (entry.rc !== 2 && entry.rc !== 3) return null;
    const p = prefixFor(runId);
    const record: any = { reason, trigger };
    if (entry.kind === "trap") {
      record.what = "trap";
      record.ordinal = entry.ordinal;
    } else {
      record.what = "fork";
      record.forkId = entry.fork.forkId;
      record.cancelled = cancelled || [];
    }
    if (entry.parentForkId !== null) {
      record.parentForkId = entry.parentForkId;
      record.branch = entry.branch;
    }
    const recordPath = path.join(this.workdir, p + ".cancel.json");
    fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "cancel record")));
    this.loadBlob(runId, entry.snap);
    const rc = this.runHost(["cancel", entry.snap, recordPath], entry.out, entry.log, entry.env);
    entry.rc = rc;
    this.refresh(entry);
    if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
    return rc;
  }

  cancelTree(runId: string, reason: string, trigger: string): string[] {
    const cancelled: string[] = [];
    const entry = this.registry.get(runId);
    if (!entry || (entry.rc !== 2 && entry.rc !== 3)) return cancelled;
    const direct: string[] = [];
    for (const fork of this.forksOf(runId)) {
      for (const child of fork.childRuns || []) {
        const ce = this.registry.get(child);
        if (ce && (ce.rc === 2 || ce.rc === 3)) {
          cancelled.push(...this.cancelTree(child, reason, "parent cancelled"));
          direct.push(child);
        }
      }
    }
    const rc = this.cancelRun(runId, reason, trigger, direct);
    if (rc !== null) cancelled.push(runId);
    return cancelled;
  }
}
