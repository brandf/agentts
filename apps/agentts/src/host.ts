#!/usr/bin/env bun
/**
 * AgentTS host executable v0 (Linear BRA-44) — the Layer 2 host.
 *
 * Ported from the BRA-45 mock plugin (same dispatch / fork-join /
 * repair / gate / extraction logic, same journal event shapes so the
 * two stay comparable — the swap test proves it). What changes here:
 *  - Blobs live ON DISK (stateDir/blobs/), not in memory: a held gate
 *    must survive the CLI process exiting, so a later process can
 *    resume the run from the stored blob alone.
 *  - The journal is a FILE (stateDir/journals/<run>.journal, JSONL),
 *    the source of truth; the in-memory list is a read cache, reloaded
 *    from disk on construction. Every event goes through the
 *    check-then-serialize helper first (a non-JSON event fails loudly,
 *    never writes a corrupt line).
 *  - The run registry is PERSISTED (stateDir/runs/<run>.json) so a
 *    new process over the same stateDir can resume a suspended run.
 *  - Trap execution is delegated to a Layer 3 ADAPTER (see
 *    adapter.ts): mock (canned answers, virtual clock) or direct
 *    (real worker processes, real exec, held gates, local decision
 *    model). The host never executes a trap's meaning itself.
 *  - A run QUEUE (stateDir/queue.json, plugin-internal — NOT Linear;
 *    Linear holds task->runId + mirrored status only, see
 *    task-backend.ts).
 *  - The first-run pipeline (gate.ts / extract.ts / validate.ts) is
 *    shared verbatim with the mock plugin — same code, copied, not
 *    rewritten. The host's extract.ts additionally walks transitive
 *    relative imports so library workflows (JudgeFixLoop) extract.
 *
 * Trap contracts are ENFORCED at the boundary (BRA-46): schemas are
 * extracted from the workflow's types at first run, cached by content
 * hash; every trap result is JSON-clean-checked first (the agentts
 * module's toJsonValue — ONE implementation defines "clean JSON"
 * everywhere) and then AJV-validated against the cached output schema
 * before the workflow resumes. A failure throws at the call site with
 * the precise error, journaled — and is RETRYABLE via the repair loop
 * (same trapId, error attached; see dispatchTrap).
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
import { toJsonValue, JsonBoundaryError } from "./agentts";
import { compilerVersion, EXPECTED_TS_VERSION } from "./gate";
import { runChecker, runGateWithLayering } from "./checker";
import { SchemaValidator, formatSchemaIssues, type SchemaIssue } from "./validate";
import {
  HOLD,
  isCannedAdapter,
  type Adapter,
  type TrapAnswer,
  type TrapContext,
} from "./adapter";
import { MockAdapter } from "./adapters/mock-adapter";
import { DirectAdapter } from "./adapters/direct-adapter";
import { appendTrapActual } from "./cost-model";
import { QuotaTracker } from "./quotas";

/** The host refuses to start a workflow when the TypeScript compiler
 * is unavailable (or the pinned version is not the one loaded): the
 * first-run gate needs it, and a silent skip would reopen the hole
 * the gate exists to close. AGENTTS_NO_COMPILER=1 forces this path
 * (test hook — the refusal is otherwise untestable without uninstalling
 * typescript). */
export class HostRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRefusalError";
  }
}

/** One queue entry (plugin-internal dispatch queue — NOT Linear). */
export interface QueueEntry {
  runId: string;
  workflowPath: string;
  adapter: string;
  status: "queued" | "running" | "held" | "done" | "failed";
  taskId?: string;
  /** Run priority, Linear scale (1 urgent … 4 low, default 3).
   * runQueue drives highest priority first (FIFO inside a tier). */
  priority?: number;
  enqueuedAt: string;
  error?: string;
}

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
  ctx: TrapContext,
) => TrapAnswer | undefined;

export interface HostConfig {
  /** C host binary. Defaults to the core's built binary (resolved from
   *  the plugin location, working dir or staged, or $DURABLETS_HOST). */
  hostPath?: string;
  /** State dir: slices/ (transient .snap/.out/.log), blobs/ (disk blob
   *  store), journals/ (JSONL, source of truth), runs/ (persisted run
   *  entries), cache/ (schema cache), queue.json. Defaults to a fresh
   *  mkdtemp dir. */
  stateDir?: string;
  /** Back-compat alias for stateDir (the mock plugin's workdir). */
  workdir?: string;
  /** Per-run clock start (ISO string or epoch ms). Default 2027-01-01
   *  (virtual mode). Real mode starts from wall time instead. */
  initialTime?: string | number;
  /** "virtual": sleep/cron jump the per-run clock instantly (tests);
   *  "real": sleep/cron actually wait (production). Default "virtual". */
  clock?: "virtual" | "real";
  /** The environment adapter. Default: MockAdapter (gates auto). */
  adapter?: Adapter;
  /** "auto" answers gates at once; "hold" keeps a gate open until an
   *  answer is delivered. Only used when no adapter is given (builds
   *  the default MockAdapter). Default "auto". */
  gates?: "auto" | "hold";
  /** Repair re-answers attempted after a boundary failure before the
   *  host throws. Default 3. */
  maxRepairAttempts?: number;
  /** Max in-engine decide calls per second (BRA-49 quota, opt-in:
   * default 0 = unlimited). When set, a decide trap waits (bounded:
   * the window is 1s, so the wait is at most ~1s) for its slot
   * instead of executing immediately. Token budgets do not apply
   * here — decideLocal consumes no tokens; they are enforced at
   * pool dispatch from declared tokensEst (see quotas.ts). */
  maxDecisionsPerSec?: number;
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
  /** Original workflow path (not the bundle): re-extraction on resume
   * reads the same source, so the cache hits and the gate never
   * re-runs for a resumed run. */
  workflowPath?: string;
}

function resolveHostPath(): string {
  if (process.env.DURABLETS_HOST && fs.existsSync(process.env.DURABLETS_HOST))
    return process.env.DURABLETS_HOST;
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // Working dir: <workspace>/agentts-host/src → <workspace>/agentts-repo/...
    path.resolve(here, "..", "..", "agentts-repo", "packages", "durablets", "durablets"),
    // Staged: <repo>/apps/agentts/src → <repo>/packages/...
    path.resolve(here, "..", "..", "..", "packages", "durablets", "durablets"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    `C host binary not found (tried ${candidates.join(", ")}); build it with make -C <core> durablets or set $DURABLETS_HOST`,
  );
}

export class Host {
  readonly hostPath: string;
  /** State dir (blobs, journals, runs, cache, queue). */
  readonly stateDir: string;
  /** Transient slice files (.snap/.out/.log) live here. */
  readonly workdir: string;
  readonly cacheDir: string;
  readonly clockMode: "virtual" | "real";
  readonly adapter: Adapter;
  readonly maxRepairAttempts: number;
  private initialClockMs: number;
  private clocks = new Map<string, number>();
  private journals = new Map<string, any[]>();
  /** Per-trap dispatch provenance, recorded in driveStepOnce and
   * attached to the trap-result/trap-error event in ingestLog
   * (BRA-57). Keyed by trapId (globally unique: runId/trap-N). */
  private pendingTrapMeta = new Map<string, { adapter: string; worker?: string; wallMs: number; tokens?: number }>();
  private registry = new Map<string, RunEntry>();
  /** Final exit codes of runs that completed (their registry entries
   * are gone — the registry only holds in-flight runs). Lets drive()
   * return 0 for a run that completed in one slice instead of
   * throwing "no run entry". */
  private finished = new Map<string, number>();
  private extractions = new Map<string, Extraction>();
  /** runId -> original workflow path (set by prepareRun). */
  private workflowPaths = new Map<string, string>();
  private logOffsets = new Map<string, number>();
  private validator = new SchemaValidator();
  private repairHandlers = new Map<string, RepairHandler>();
  private defaultRepair: RepairHandler | undefined;
  private pendingGate = new Set<string>();
  /** Delivered gate answers, per run (host-owned: the direct adapter
   * holds every gate, so the answer cannot live in the adapter). */
  private gateAnswers = new Map<string, unknown[]>();
  /** Decide-rate quota for the in-engine decide path (BRA-49).
   * Default unlimited; see HostConfig.maxDecisionsPerSec. */
  private decideQuotas: QuotaTracker;

  constructor(config: HostConfig = {}) {
    this.hostPath = config.hostPath ?? resolveHostPath();
    this.stateDir = config.stateDir ?? config.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentts-host-"));
    this.workdir = path.join(this.stateDir, "slices");
    for (const d of ["slices", "blobs", "journals", "runs", "cache"]) {
      fs.mkdirSync(path.join(this.stateDir, d), { recursive: true });
    }
    this.cacheDir = path.join(this.stateDir, "cache");
    this.clockMode = config.clock ?? "virtual";
    this.adapter = config.adapter ?? new MockAdapter({ gates: config.gates ?? "auto" });
    this.maxRepairAttempts = config.maxRepairAttempts ?? 3;
    this.decideQuotas = new QuotaTracker({
      maxDecisionsPerSec:
        config.maxDecisionsPerSec ?? Number(process.env.AGENTTS_MAX_DECISIONS_PER_SEC ?? 0),
    });
    this.initialClockMs =
      typeof config.initialTime === "number"
        ? config.initialTime
        : Date.parse(config.initialTime ?? "2027-01-01T00:00:00.000Z");
    // Cross-process durability: reload journals + run entries from
    // disk so a new Host over the same stateDir sees prior runs
    // (held gates resume across CLI invocations).
    this.loadJournalsFromDisk();
    this.loadRunEntriesFromDisk();
  }

  // ------------------------------------------------------- plugin loading
  /**
   * Load an adapter from apps/agentts/plugins/<name>/src/adapter.ts
   * (a module exporting createAdapter() or a default Adapter). Falls
   * back to the host's built-ins only for "direct" (there is no
   * direct plugin — it is the coordinator's own execution). "mock"
   * loads from plugins/mock/src/adapter.ts (BRA-53: the canned
   * answers live in src/adapters/mock-adapter.ts, shared by the
   * Host constructor default and the plugin seam — one copy, not
   * two). A name that resolves to neither is a loud error, never a
   * silent default.
   */
  static async loadAdapter(name: string): Promise<Adapter> {
    if (name === "direct") return new DirectAdapter();
    const here = path.dirname(new URL(import.meta.url).pathname);
    // $AGENTTS_PLUGINS_DIR (set by run.sh when the host runs from a
    // scratch copy) is a directory containing <name>/src/adapter.ts.
    const envDir = process.env.AGENTTS_PLUGINS_DIR;
    const candidates = [
      ...(envDir ? [path.resolve(envDir, name, "src", "adapter.ts")] : []),
      path.resolve(here, "..", "plugins", name, "src", "adapter.ts"),
      path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "plugins", name, "src", "adapter.ts"),
    ];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const mod: any = await import(c);
      if (typeof mod.createAdapter === "function") return mod.createAdapter() as Adapter;
      if (mod.default) return mod.default as Adapter;
      throw new Error(`plugin adapter ${c} exports neither createAdapter() nor a default adapter`);
    }
    throw new Error(
      `unknown adapter "${name}" (tried built-in direct and ${candidates.join(", ")})`,
    );
  }

  /**
   * Load a full plugin ENGINE class from
   * apps/agentts/plugins/<name>/src/<name>-plugin.ts (the mock plugin
   * is the first: it exports MockPlugin). The host drives it
   * in-process (see runWithPlugin) and mirrors its journals to disk.
   * The CLI's default path uses the host's own disk engine above —
   * the mock plugin's in-memory blob store cannot resume a held gate
   * across processes, and its private store cannot be seeded from
   * disk, so wrapping it as the durable engine is not possible.
   */
  static async loadPlugin(name: string): Promise<any> {
    const here = path.dirname(new URL(import.meta.url).pathname);
    // $AGENTTS_PLUGINS_DIR (set by run.sh when the host runs from a
    // scratch copy) is a directory containing <name>/src/<name>-plugin.ts.
    const envDir = process.env.AGENTTS_PLUGINS_DIR;
    const candidates = [
      ...(envDir ? [path.resolve(envDir, name, "src", `${name}-plugin.ts`)] : []),
      path.resolve(here, "..", "plugins", name, "src", `${name}-plugin.ts`),
      path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "plugins", name, "src", `${name}-plugin.ts`),
    ];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const mod: any = await import(c);
      const cls = mod.MockPlugin ?? mod.Host ?? mod.default;
      if (typeof cls !== "function") {
        throw new Error(`plugin ${c} exports no plugin class (MockPlugin/Host/default)`);
      }
      return cls;
    }
    throw new Error(`plugin "${name}" not found (tried ${candidates.join(", ")})`);
  }

  /** Drive a loaded plugin engine in-process and mirror its journals
   * to this host's disk journal dir (the swap-test path). */
  async runWithPlugin(plugin: any, workflowPath: string, runId: string): Promise<number> {
    const rc0 = plugin.startRun(workflowPath, runId);
    let rc = plugin.drive(runId);
    if (rc0 === 0) rc = 0;
    try {
      const dir = path.join(this.stateDir, "journals");
      plugin.dumpJournals(dir);
    } catch {
      /* journal mirroring is best-effort on the plugin path */
    }
    return rc;
  }

  // ------------------------------------------------------------- queue
  queuePath(): string {
    return path.join(this.stateDir, "queue.json");
  }
  readQueue(): QueueEntry[] {
    const p = this.queuePath();
    if (!fs.existsSync(p)) return [];
    try {
      const q = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(q) ? q : [];
    } catch {
      return [];
    }
  }
  private writeQueue(q: QueueEntry[]): void {
    fs.writeFileSync(this.queuePath(), JSON.stringify(q, null, 2));
  }
  /** Enqueue a workflow run (plugin-internal dispatch queue). */
  enqueue(workflowPath: string, runId: string, opts: { adapter?: string; taskId?: string; priority?: number } = {}): QueueEntry {
    const q = this.readQueue();
    if (q.some((e) => e.runId === runId && (e.status === "queued" || e.status === "running" || e.status === "held"))) {
      throw new Error(`run ${runId} is already queued/running/held`);
    }
    const entry: QueueEntry = {
      runId,
      workflowPath: path.resolve(workflowPath),
      adapter: opts.adapter ?? this.adapter.name,
      status: "queued",
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(typeof opts.priority === "number" ? { priority: opts.priority } : {}),
      enqueuedAt: new Date().toISOString(),
    };
    q.push(entry);
    this.writeQueue(q);
    return entry;
  }
  /** Drive every queued run to completion (or a held gate).
   * Priority order (BRA-49): highest priority first (1 urgent …
   * 4 low, missing = 3), FIFO inside a tier. v0 drove in enqueue
   * order; a queued urgent run no longer waits behind a queued
   * low-priority one. Sequential, coordinator executes directly —
   * no worker pool (BRA-48/49). Returns the entries with their
   * final statuses. */
  runQueue(): QueueEntry[] {
    const q = this.readQueue();
    const order = q
      .map((e, i) => ({ e, i }))
      .sort((a, b) => {
        const pa = typeof a.e.priority === "number" ? a.e.priority : 3;
        const pb = typeof b.e.priority === "number" ? b.e.priority : 3;
        if (pa !== pb) return pa - pb;
        if (a.e.enqueuedAt !== b.e.enqueuedAt) return a.e.enqueuedAt < b.e.enqueuedAt ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.e);
    for (const entry of order) {
      if (entry.status !== "queued") continue;
      entry.status = "running";
      this.writeQueue(q);
      try {
        let rc = this.startRun(entry.workflowPath, entry.runId);
        this.journalEvent(entry.runId, { event: "queue-started", runId: entry.runId });
        rc = this.drive(entry.runId);
        if (this.pendingGate.has(entry.runId)) {
          entry.status = "held";
        } else if (rc === 0) {
          entry.status = "done";
        } else {
          entry.status = "failed";
          entry.error = `run exited ${rc}`;
        }
      } catch (e) {
        entry.status = "failed";
        entry.error = e instanceof Error ? e.message : String(e);
      }
      this.writeQueue(q);
    }
    return q;
  }

  // ---------------------------------------------------------- host clock
  /** A run's clock, created at the configured start the first time
   * the run touches it. PER RUN, not per host: runs in one host are
   * hermetic — a run's output must not depend on what another run
   * advanced the clock to first (a shared clock made the second run
   * of the same workflow print different times, caught by the gate
   * re-gate test). Virtual mode jumps instantly (tests); real mode
   * starts from wall time and sleep/cron actually wait. */
  private clockMsFor(runId: string): number {
    const v = this.clocks.get(runId);
    if (v !== undefined) return v;
    const start = this.clockMode === "real" ? Date.now() : this.initialClockMs;
    this.clocks.set(runId, start);
    return start;
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
  /** Actually wait (real clock mode only): Bun.sleepSync blocks the
   * synchronous drive loop — the v0 drive is sync throughout, so a
   * real sleep is a blocking wait, not a suspension to a timer. */
  private waitReal(ms: number): void {
    if (ms > 0) Bun.sleepSync(ms);
  }

  // ------------------------------------------------------- canned answers
  /** Queue an answer (value or {throw}) for the next trap of this type.
   * Delegates to the adapter when it is a canned adapter (mock);
   * the direct adapter has no canned answers — queueing there is a
   * loud error, never a silent no-op. */
  queueAnswer(type: string, answer: TrapAnswer | unknown): void {
    if (!isCannedAdapter(this.adapter)) {
      throw new Error(`adapter "${this.adapter.name}" does not take canned answers`);
    }
    this.adapter.queueAnswer(type, answer);
  }
  /** Override the canned handler for a trap type entirely. */
  setCanned(type: string, fn: CannedFn): void {
    if (!isCannedAdapter(this.adapter)) {
      throw new Error(`adapter "${this.adapter.name}" does not take canned handlers`);
    }
    this.adapter.setCanned(type, fn);
  }
  /** Repair handler for a trap type (see dispatchTrap). */
  setRepairHandler(type: string, fn: RepairHandler): void {
    this.repairHandlers.set(type, fn);
  }
  setDefaultRepairHandler(fn: RepairHandler): void {
    this.defaultRepair = fn;
  }
  /** Queue a gate answer for a run (consumed by its next gate trap).
   * Host-owned, keyed by run: the direct adapter holds every gate,
   * so the answer cannot live in the adapter. */
  queueGateAnswer(runId: string, answer: unknown): void {
    const list = this.gateAnswers.get(runId) ?? [];
    list.push(answer);
    this.gateAnswers.set(runId, list);
  }
  isGatePending(runId: string): boolean {
    return this.pendingGate.has(runId);
  }

  // ------------------------------------------------------------- journals
  /** The journal writer: every event goes through check-then-serialize
   * first (JSONL has the same requirement as the trap boundary). A
   * non-JSON event is a host bug — fail loudly, never write a corrupt
   * journal line. The event is appended to the run's JSONL journal
   * FILE (the source of truth) as well as the in-memory list.
   *
   * Journal format v2 (BRA-57): every event is stamped here with
   * `wallTs`, its wall-clock timestamp (ISO, ms precision). This is
   * the single choke point, so host-authored events AND core events
   * ingested from the C host both carry it. An event that already
   * carries one (a re-journaled line) keeps it: the stamp is when
   * the event was first written, not when it was re-read. Additive
   * over v1 — old readers ignore the new fields, and the profiler
   * treats missing fields as unknown, never invented. */
  journalEvent(runId: string, event: any): void {
    const clean = toJsonValue(event, "journal event"); // throws JsonBoundaryError on a bad event
    if (clean !== null && typeof clean === "object" && !("wallTs" in (clean as Record<string, unknown>))) {
      (clean as Record<string, unknown>).wallTs = new Date().toISOString();
    }
    const list = this.journals.get(runId) ?? [];
    list.push(clean);
    this.journals.set(runId, list);
    fs.mkdirSync(path.join(this.stateDir, "journals"), { recursive: true });
    fs.appendFileSync(this.journalPath(runId), JSON.stringify(clean) + "\n");
  }
  journalPath(runId: string): string {
    return path.join(this.stateDir, "journals", prefixFor(runId) + ".journal");
  }
  journal(runId: string): any[] {
    return [...(this.journals.get(runId) ?? [])];
  }
  /** Reload every journal file from disk into the in-memory lists
   * (constructor: a new Host over the same stateDir sees prior runs). */
  private loadJournalsFromDisk(): void {
    const dir = path.join(this.stateDir, "journals");
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".journal")) continue;
      const runId = f.slice(0, -".journal".length).replace(/_/g, "/");
      // Run ids contain "/" (branches); the file prefix replaced them
      // with "_", which is lossy for ids that already contain "_".
      // The registry (runs/*.json, exact runId) is authoritative for
      // run identity; journals are reloaded by matching the file
      // against known run ids first, falling back to the lossy name.
      const events: any[] = [];
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          throw new Error(`corrupt journal line in ${f}: ${line.slice(0, 120)}`);
        }
      }
      if (events.length) this.journals.set(runId, events);
    }
  }
  /** Dump in-memory journals as JSONL files into a dir (for evidence
   * / inspection; the host's own record is already the journal file
   * under stateDir/journals). */
  dumpJournals(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const [runId, events] of this.journals) {
      const lines = events.map((e) => JSON.stringify(toJsonValue(e, "journal event"))).join("\n");
      fs.writeFileSync(path.join(dir, prefixFor(runId) + ".journal"), lines + (lines ? "\n" : ""));
    }
  }

  // --------------------------------------------------- persisted registry
  private runEntryPath(runId: string): string {
    return path.join(this.stateDir, "runs", prefixFor(runId) + ".json");
  }
  /** Persist a run entry (registry) to disk after every mutation, so
   * a new process over the same stateDir can resume the run. */
  saveRunEntry(runId: string): void {
    const e = this.registry.get(runId);
    if (!e) {
      const p = this.runEntryPath(runId);
      if (fs.existsSync(p)) fs.rmSync(p);
      return;
    }
    fs.mkdirSync(path.join(this.stateDir, "runs"), { recursive: true });
    fs.writeFileSync(this.runEntryPath(runId), JSON.stringify(e, null, 2));
  }
  private loadRunEntriesFromDisk(): void {
    const dir = path.join(this.stateDir, "runs");
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunEntry;
        if (e.runId && (e.rc === 2 || e.rc === 3)) {
          this.registry.set(e.runId, e);
          if (e.rc === 2 || e.rc === 3) this.finished.delete(e.runId);
          // The .log file already holds this run's earlier slices:
          // start the ingest offset at its current size, or the new
          // process would re-journal every old event (duplicates in
          // the journal file, which is the source of truth).
          if (e.log && fs.existsSync(e.log)) {
            this.logOffsets.set(e.log, fs.statSync(e.log).size);
          }
          // The journal reload keyed run ids lossily ("/" -> "_");
          // re-key this run's journal under its exact id when the
          // file's first event names it.
          const evs = this.journal(e.runId);
          if (!evs.length) {
            const jf = this.journalPath(e.runId);
            if (fs.existsSync(jf)) {
              const lines = fs.readFileSync(jf, "utf8").split("\n").filter(Boolean);
              this.journals.set(e.runId, lines.map((l) => JSON.parse(l)));
            }
          }
        }
      } catch {
        /* a corrupt run entry is ignored here; startRun overwrites it */
      }
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
  /** Disk blob store: the host's. The core produces/consumes blob
   * bytes at a path the host passes; it never chooses blob paths.
   * The live .snap file is a transient slice — stateDir/blobs/ is the
   * store, so a held gate survives the process exiting and a later
   * process resumes from the stored copy alone. */
  blobPath(runId: string): string {
    return path.join(this.stateDir, "blobs", prefixFor(runId) + ".snap");
  }
  private storeBlob(runId: string, snap: string): void {
    const dest = this.blobPath(runId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(snap, dest);
    if (shaFile(dest) !== shaFile(snap)) throw new Error(`blob store mismatch for ${runId}`);
  }
  private loadBlob(runId: string, snap: string): void {
    const stored = this.blobPath(runId);
    if (!fs.existsSync(stored)) throw new Error(`no stored blob for ${runId}`);
    fs.copyFileSync(stored, snap);
    if (shaFile(snap) !== shaFile(stored)) throw new Error(`blob restore mismatch for ${runId}`);
  }
  blobStored(runId: string): boolean {
    return fs.existsSync(this.blobPath(runId));
  }
  storedBlobHash(runId: string): string | null {
    const p = this.blobPath(runId);
    return fs.existsSync(p) ? shaFile(p) : null;
  }
  /** Test hook: delete the live blob file. The run must still resume
   * from the stored disk copy alone. */
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
      // BRA-57: a trap-result/trap-error is emitted by the C host on
      // resume, so the host cannot attach dispatch provenance to it
      // at dispatch time — it is recorded in pendingTrapMeta (see
      // driveStepOnce) and attached here, when the event is ingested:
      // the adapter that answered, the worker id when the adapter
      // named one, the host-measured dispatch wall time, tokens when
      // known. Consumed on attach; a trap that never resumes leaves
      // a stale entry, which is harmless.
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
          this.saveRunEntry(runId);
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
   * extraction and before the cache write — a throw there aborts
   * before the entry is written, so a checker-failing workflow is
   * never cached as gated. */
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
  /** Refuse to start a workflow when the TypeScript compiler is
   * unavailable (or not the pinned version). The gate needs it; a
   * silent skip would reopen the hole the gate exists to close.
   * A missing typescript package fails even earlier — at module load
   * (the CLI reports that as a refusal too). */
  ensureCompiler(): void {
    if (process.env.AGENTTS_NO_COMPILER === "1") {
      throw new HostRefusalError(
        "TypeScript compiler unavailable (AGENTTS_NO_COMPILER=1) — refusing to start the workflow rather than silently skipping the first-run gate",
      );
    }
    if (compilerVersion() !== EXPECTED_TS_VERSION) {
      throw new HostRefusalError(
        `TypeScript compiler version mismatch: expected ${EXPECTED_TS_VERSION} (pinned), found ${compilerVersion()} — refusing to start the workflow`,
      );
    }
  }

  /** Restore a run's extraction from the content-hash cache (a
   * resumed run never re-extracts: the cache hit skips the gate and
   * reuses the pinned schemas). Called when a fresh Host over the
   * same stateDir resumes a run it did not start. */
  ensureExtraction(runId: string): void {
    if (this.extractions.has(runId)) return;
    const wp = this.workflowPaths.get(runId) ?? this.registry.get(runId)?.workflowPath;
    if (!wp) {
      throw new Error(
        `cannot resume ${runId}: no workflow path recorded, so the extraction cannot be restored from cache`,
      );
    }
    this.prepareRun(wp, runId);
  }

  prepareRun(workflowPath: string, runId: string): { entryPath: string; extraction: Extraction } {
    this.ensureCompiler();
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
      // write — and it IS the gate's type-check for the rules tsc
      // cannot express (class/empty contracts, schema-level wiring,
      // layering). Throws CheckerError with structured diagnostics.
      onExtracted: (entry, program) => {
        this.checkerRuns++;
        runChecker(program, workflowPath, entry);
      },
    });
    this.extractions.set(runId, extraction);
    return { entryPath: path.resolve(workflowPath), extraction };
  }

  /** Bundle a workflow + the agentts module into one self-contained
   * script with Bun.build; the C host never resolves imports. */
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
    return outPath;
  }

  startRunFrom(entryPath: string, runId: string): number {
    const p = prefixFor(runId);
    this.clean(p);
    this.journals.delete(runId);
    // A re-run starts a fresh journal (the old file is the previous
    // run's record, not this one's).
    if (fs.existsSync(this.journalPath(runId))) fs.rmSync(this.journalPath(runId));
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
      workflowPath: this.workflowPaths.get(runId) ?? entryPath,
    };
    this.registry.set(runId, entry);
    this.refresh(entry);
    if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
    else {
      this.registry.delete(runId);
      this.finished.set(runId, rc);
    }
    this.saveRunEntry(runId);
    return rc;
  }

  /** Start a workflow: extract (loud failure when a trap has no
   * extractable type), then spawn the C host on the workflow source. */
  startRun(workflowPath: string, runId: string): number {
    const { entryPath } = this.prepareRun(workflowPath, runId);
    return this.startRunFrom(entryPath, runId);
  }

  // ------------------------------------------------------------ dispatch
  /**
   * Resolve one trap's answer. sleep / cron / clock are HOST-owned
   * (the clock is host state, virtual or real — see clockMsFor); the
   * other four types go to the Layer 3 adapter. The adapter never
   * sees a sleep/cron/clock trap.
   */
  private resolveAnswer(
    type: string,
    arg: any,
    runId: string,
    trapId: string,
    ordinal: number,
  ): TrapAnswer | typeof HOLD {
    switch (type) {
      case "sleep": {
        const ms = typeof arg?.ms === "number" ? arg.ms : 0;
        if (this.clockMode === "real") {
          // Real time: actually wait, then advance the clock.
          this.waitReal(ms);
          this.advanceClock(ms, runId, "sleep");
        } else {
          // Virtual time: the clock jumps by the duration instantly.
          // No real waiting, ever.
          this.advanceClock(ms, runId, "sleep");
        }
        return { value: { sleptMs: ms } };
      }
      case "cron": {
        const at = arg?.at;
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        if (!Number.isNaN(t)) {
          if (this.clockMode === "real") {
            const wait = t - Date.now();
            if (wait > 0) this.waitReal(wait);
            // The run's clock is wall time in real mode.
            const fromMs = this.clockMsFor(runId);
            this.clocks.set(runId, Math.max(fromMs, t));
            this.journalEvent(runId, {
              event: "clock-advance",
              runId,
              from: new Date(fromMs).toISOString(),
              to: new Date(Math.max(fromMs, t)).toISOString(),
              reason: "cron",
            });
          } else {
            // Virtual time: the clock jumps to the target datetime.
            // A target already past fires immediately, clock unchanged.
            this.advanceClockTo(t, runId, "cron");
          }
        }
        return { value: { scheduled: at } };
      }
      case "clock":
        return { value: { now: this.nowISO(runId), nowMs: this.clockMsFor(runId) } };
      case "gate": {
        // A delivered answer (host queue) wins over the adapter: the
        // direct adapter holds every gate, so without this the run
        // could never resume after deliverGate.
        const q = this.gateAnswers.get(runId);
        if (q && q.length) return { value: q.shift() };
        return this.adapter.answer(type, arg, { runId, trapId, ordinal });
      }
      default:
        return this.adapter.answer(type, arg, { runId, trapId, ordinal });
    }
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
    ordinal = 0,
  ): TrapAnswer | typeof HOLD {
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

    let answer = this.resolveAnswer(type, arg, runId, trapId, ordinal);
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
    this.saveRunEntry(runId);
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
    this.saveRunEntry(runId);
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
      workflowPath: this.workflowPaths.get(parentRunId) ?? this.registry.get(parentRunId)?.workflowPath,
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
    this.saveRunEntry(child);
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
    this.ensureExtraction(runId);
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
      // BRA-49: the in-engine decide path still goes through the
      // dispatch quota — a configured decision rate waits for its
      // slot (bounded: the window is 1s). Default unlimited: no wait.
      if (trapEv.type === "decide") {
        const waitMs = this.decideQuotas.waitMsForDecision(Date.now());
        if (waitMs > 0) Bun.sleepSync(waitMs);
        this.decideQuotas.noteDecision(Date.now());
      }
      // BRA-49 cost actual: time the trap dispatch in-process and
      // append it to the cost log. The same measurement is journaled
      // on the trap-result event (BRA-57: the journal now carries
      // wallTs + per-trap wallMs — the cost log stays the scheduler's
      // input, the journal is the profiler's). The site is
      // the extraction key: `job:<spec>` for job traps, the trap
      // type otherwise — the same namespace the pool server uses.
      // A gate trap answered from the host queue was answered by the
      // host (a human), not the adapter — record "host" as its
      // adapter, so the journal never misattributes it.
      const fromHostGateQueue =
        trapEv.type === "gate" && (this.gateAnswers.get(runId)?.length ?? 0) > 0;
      const startedAt = Date.now();
      const ans = this.dispatchTrap(runId, trapEv.trapId, trapEv.type, trapEv.arg, trapEv.ordinal ?? 0);
      const wallMs = Date.now() - startedAt;
      appendTrapActual(path.join(this.stateDir, "cost-actuals.jsonl"), {
        site: siteKeyFor(trapEv.type, trapEv.arg),
        ms: wallMs,
        runId,
        trapId: trapEv.trapId,
      });
      if (ans === HOLD) return 2;
      this.pendingGate.delete(runId);
      // BRA-57: record dispatch provenance for the trap-result /
      // trap-error event the C host emits on resume (attached in
      // ingestLog). The wall time is measured here, around the whole
      // dispatch including repairs.
      this.pendingTrapMeta.set(trapEv.trapId, {
        adapter: fromHostGateQueue ? "host" : this.adapter.name,
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
        this.saveRunEntry(runId);
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

  /** Is a run suspended at a gate trap? Derived from the journal (the
   * source of truth), not the in-memory pendingGate set — a fresh
   * Host over the same stateDir must be able to deliver a gate answer
   * to a run another process suspended. */
  isGateSuspended(runId: string): boolean {
    const entry = this.registry.get(runId);
    if (!entry || entry.rc !== 2) return false;
    const events = this.journal(runId);
    let lastTrap: any = null;
    let resolvedAfter = false;
    for (const e of events) {
      if (e.event === "trap") {
        lastTrap = e;
        resolvedAfter = false;
      } else if (e.event === "trap-result" || e.event === "trap-error") {
        resolvedAfter = true;
      }
    }
    return lastTrap !== null && lastTrap.type === "gate" && !resolvedAfter;
  }

  /** Deliver a held gate's answer, then keep driving. */
  deliverGate(runId: string, answer: unknown): number {
    if (!this.pendingGate.has(runId) && !this.isGateSuspended(runId)) {
      throw new Error(`no gate pending for ${runId}`);
    }
    this.pendingGate.add(runId);
    this.queueGateAnswer(runId, answer);
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
    this.saveRunEntry(runId);
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
