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
  collectWorkflowFiles,
  extractWorkflow,
  resolveAgenttsModule,
  siteKeyFor,
  type Extraction,
  type SiteEntry,
} from "./extract";
import { toJsonValue, JsonBoundaryError, TRAP_SITE_KEY, type TrapSite } from "./agentts";
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
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { appendTrapActual } from "./cost-model";
import { QuotaTracker } from "./quotas";
import { httpPostSync } from "./worker-http";
import { workerServerUrl, type SystemEvent, type SystemEventType } from "./worker-protocol";
import { atomicWriteFile, CorruptionLog, type CorruptionRecord } from "./corruption";

/** Re-exported for callers that report on corrupt state (the shape
 * lives in corruption.ts, shared with the WorkerServer — BRA-76). */
export type { CorruptionRecord } from "./corruption";

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

/** queue.json is corrupt AND its backup is corrupt (or missing), so
 * there is no consistent queue to load (BRA-77, BRA-62 G5). Thrown
 * by readQueue — never a silent empty queue. The message names both
 * files and what a human should do; deleting queue.json to start
 * empty is a human decision, not something the host does on its own
 * (it would drop every queued run). */
export class CorruptQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptQueueError";
  }
}

/** Max suspensions in one uninterrupted driveToCompletion loop
 * (BRA-76, BRA-62 G12). An infinite-loop guard, not a quota: a
 * workflow that suspends forever would otherwise drive the queue
 * forever. Real workflows today are well under 50 (the briefing
 * parent has ~2 combinators; branch drives are separate — see the
 * BRA-62 audit), so 50 is a guard against a runaway, not a limit a
 * healthy run should approach. Hitting it fails the run loudly
 * (DriveCapError, plus a `drive-cap` journal event) with the blob
 * intact from the last suspension. */
export const MAX_DRIVE_ROUNDS = 50;

/**
 * Split the wrapper-attached call site off a trap arg (BRA-73).
 * The agentts wrappers attach the site under TRAP_SITE_KEY — the
 * only channel from inside the engine to the host, since the C core
 * emits the trap event from the arg alone. The host strips the key
 * before dispatch (no adapter, repair handler, or schema lookup
 * ever sees it) and journals the site as the trap event's
 * top-level `site`, so the journaled arg stays exactly the spec the
 * author passed. A malformed site value (not from our wrappers —
 * an author who used the reserved key as a spec key) is dropped
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

/** A run needed more than MAX_DRIVE_ROUNDS suspensions in one
 * uninterrupted drive (BRA-76, BRA-62 G12). Thrown by
 * driveToCompletion — runQueue marks the entry failed with this
 * message, so `queue run` exits 1 and prints it. The remedy is to
 * split the workflow into fewer than MAX_DRIVE_ROUNDS traps per
 * drive, not to re-drive: the run is suspended at a trap with its
 * blob intact, but a failed queue entry is never retried. */
export class DriveCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveCapError";
  }
}

/** Trap-code pin (BRA-89): the code that answers a run's
 * job/decide/exec traps, content-pinned at submit. `files` maps an
 * absolute path to the sha256 of its content as submitted. The pin
 * lives on the queue entry and the run entry (like frozenHash /
 * engineVersion), so a fresh process resuming the run finds it
 * without the submitting process.
 *
 * What is pinned, per run (computeTrapPin — the precise rule):
 *   - decision-model.ts, always: every run can reach a decide trap
 *     (directly, or via decisionCascade), and the engine version
 *     does not cover host TS source.
 *   - The run adapter's own files (seam + implementation): the
 *     adapter IS the trap-answering code for its traps.
 *   - One worker script per extracted job spec, resolved from the
 *     live adapter's own registry (DirectAdapter.workerPathFor —
 *     the briefing adapter IS a DirectAdapter with its workers
 *     registered, so the same call resolves briefing-worker.ts);
 *     the mock adapter's bugfix-worker.ts for bugfix-* specs
 *     (its runBugfix import is a live import, not a registry).
 *   - One jobspec prose file per extracted job spec
 *     (plugins/muse/jobspecs/<spec>.md, when one exists).
 *   - Any `<name>.ts` under the repo's workflows/ dir that the
 *     run's frozen workflow closure names as `workflows/<name>.ts`
 *     (the exec'd-script path, e.g. briefing-prep.ts, which the
 *     workflow runs via `bun workflows/briefing-prep.ts`).
 * What is NOT pinned, deliberately: the workflow closure itself
 * (already frozen byte-identical by BRA-71 — the frozen copy IS
 * its pin), the C host + dquickts engine (covered by
 * engineVersion), host core source (host.ts, extract.ts, ... — the
 * checker cannot check itself from inside; editing host source
 * mid-run is out of scope), and muse pool worker scripts (the
 * pool workers run scripts from their own --workers-config, which
 * the host never sees — the jobspec prose IS pinned, and the
 * server snapshots it at enqueue so an already-dispatched pool
 * job keeps its enqueue-time prose; see worker-server.ts).
 * A run with no pinned file for a trap (e.g. a spec with no
 * jobspec file and no registered worker) still dispatches — the
 * pin covers what exists, and the adapter's own loud error fires
 * for an unregistered spec. */
export interface TrapPin {
  files: Record<string, string>;
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
  /** The validated input JSON for the workflow's entry function
   * (absent when the entry takes no parameter). Stored here so a
   * later process can start the run from the queue alone. */
  input?: unknown;
  /** Frozen workflow copy (BRA-71, BRA-62 G9): the content-hash of
   * the workflow closure as submitted, and the frozen entry file
   * under stateDir/frozen/<hash>/. A resumed run executes and
   * validates against the frozen copy, never the live file — so an
   * edit (or deletion) of the workflow mid-run cannot change what
   * the run executes. Absent for runs submitted before BRA-71
   * (legacy: they resume from the live file as before). */
  frozenHash?: string;
  frozenPath?: string;
  /** Engine build that wrote this run's snapshot (BRA-71, BRA-62
   * G10): `dquickts-<pin>+durablets-<hash>` — see engineVersion().
   * A resume under a different engine build is refused loudly.
   * Absent for runs started before BRA-71 (legacy: no version was
   * recorded, so there is nothing to compare — they proceed). */
  engineVersion?: string;
  /** Trap-code pin (BRA-89): the content hashes of the code that
   * answers this run's job/decide/exec traps, recorded at submit —
   * worker scripts, jobspec prose, the decision model, the
   * adapter's own files, and any workflow-exec'd script the run
   * references (see TrapPin / computeTrapPin). A dispatch whose
   * live file no longer matches its pinned hash is refused loudly
   * (trap-code-mismatch), never answered from changed code.
   * Absent for runs submitted before BRA-89 (legacy: they proceed
   * unchecked, like BRA-71's legacy runs). */
  trapPin?: TrapPin;
  enqueuedAt: string;
  error?: string;
}

/** Driver lock (BRA-72, BRA-62 G13): one driver per state dir.
 * The lock is a directory `<stateDir>/driver.lock/` holding
 * `holder.json` and a `heartbeat` file — see acquireDriverLock. */
export interface DriverLockHolder {
  pid: number;
  startedAt: string;
  command: string;
}
export interface DriverLockHandle {
  stateDir: string;
  heartbeatTimer: ReturnType<typeof setInterval>;
}
/** One repair decision for a stranded "running" queue entry (BRA-72,
 * BRA-62 G2). `to` is the entry's new status — "left-running" means
 * the repair refused to touch it (inconsistent state; a human must
 * inspect it). */
export interface RepairAction {
  runId: string;
  from: "running";
  to: "queued" | "done" | "failed" | "left-running";
  reason: string;
  /** Short error for the queue entry when `to` is "failed". */
  error?: string;
}
export interface RepairReport {
  /** Number of "running" entries inspected. */
  inspected: number;
  actions: RepairAction[];
}
/** How often a driving process refreshes its lock heartbeat. */
export const DRIVER_LOCK_HEARTBEAT_MS = 10_000;
/** A live pid whose heartbeat is older than this is ambiguous
 * (probably a reused pid, or a driver wedged in a blocking call). */
export const DRIVER_LOCK_AMBIGUOUS_MS = 30 * 60 * 1000;
/** A lock dir with no holder record younger than this is a holder
 * mid-write — treat as live, not stale. */
export const DRIVER_LOCK_EMPTY_GRACE_MS = 60_000;
/** How long a submit waits for the enqueue lock before refusing
 * (BRA-82). The critical section is a read + two atomic writes —
 * milliseconds — so 30s of waiting means something is deeply
 * wrong, not contention; refuse loudly rather than hang. */
export const ENQUEUE_LOCK_WAIT_MS = 30_000;
/** Poll interval while waiting for the enqueue lock (BRA-82). */
export const ENQUEUE_LOCK_POLL_MS = 5;
/** A live pid holding the enqueue lock longer than this is stale
 * (BRA-82): a normal critical section is bounded milliseconds, so
 * a 30s-old lock means the holder crashed or stopped without its
 * pid dying (SIGSTOP, wedged). Breaking it is safe — the writes
 * it guards are atomic tmp+rename — except for a stopped holder
 * that resumes afterwards, which would write a stale snapshot;
 * that needs a process stopped >30s mid-section resuming at
 * exactly the wrong moment, and is documented, not hidden. */
export const ENQUEUE_LOCK_STALE_MS = 30_000;
/** A queue-lock dir with no holder record younger than this is a
 * holder mid-write — treat as live, not stale (BRA-82). */
export const ENQUEUE_LOCK_EMPTY_GRACE_MS = 5_000;

/** What `agentts result <runId>` returns: the run's status, and the
 * validated output JSON once it is done. */
export interface RunResult {
  runId: string;
  status: "pending" | "running" | "held" | "done" | "failed";
  /** The entry function's return value, validated against the
   * extracted Output schema. Present only when done. */
  output?: unknown;
  /** Why the run failed, or why the result is unavailable. */
  error?: string;
}

/** A delivery record (BRA-65): the outbox entry the tick agent
 * writes when a run reaches a terminal state. The delivery path is
 * the outbox — results used to sit in a file until someone ran
 * `result <runId>`; now the tick agent fetches the result and
 * records it here, and the coordinator (Meroki) reads the outbox.
 * A failed run's delivery carries needsAttention: true — that IS
 * the escalation for a terminal failure. */
export interface DeliveryRecord {
  runId: string;
  workflowPath: string;
  status: "done" | "failed";
  /** The validated output JSON (done runs only). */
  output?: unknown;
  /** Why the run failed (failed runs only). */
  error?: string;
  /** A failed delivery needs the coordinator's eyes. */
  needsAttention: boolean;
  deliveredAt: string;
  /** Who delivered it ("tick-agent" in production). */
  deliveredBy: string;
}

/** An escalation record (BRA-65): something stuck that needs the
 * coordinator's judgment — a held gate (a human must answer), a
 * queue entry stranded at "running" (a driver died mid-drive; the
 * tick agent reports it, never flips it — BRA-62 G2). The tick
 * agent writes these; the watchdog surfaces them. */
export interface EscalationRecord {
  kind: "gate-held" | "stuck-running" | "other";
  runId?: string;
  reason: string;
  detail?: unknown;
  at: string;
  escalatedBy: string;
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

/** Candidate DurableTS package dirs (same layouts as
 * resolveHostPath's binary candidates): the staged repo and the
 * working-dir layout. The first one holding src/durablets.c wins.
 *
 * $AGENTTS_DURABLETS_DIR comes first when set: run.sh exports it
 * (BRA-103) as the package dir the C host binary was built from.
 * The host cannot find the package by relative resolution when it
 * runs from run.sh's scratch copy ($SCRATCH/host-src holds
 * apps/agentts only, not packages/), and run.sh is the only party
 * that knows which durablets.c the binary was built from — so the
 * export, not a guess, is what keeps the recorded hash the hash of
 * the actual source. In place it is the same dir the relative
 * candidates resolve to, so the export is harmless there. */
function durabletsPackageDirs(): string[] {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return [
    ...(process.env.AGENTTS_DURABLETS_DIR ? [process.env.AGENTTS_DURABLETS_DIR] : []),
    path.resolve(here, "..", "..", "..", "packages", "durablets"),
    path.resolve(here, "..", "..", "agentts-repo", "packages", "durablets"),
  ];
}

/** The dquickts pin the vendored engine was built from, read from
 * the vendored tree's VENDORED_FROM stamp (the documented source of
 * truth — re-vendor.sh writes it on every re-vendor). "unknown"
 * when the stamp is missing or unparseable: the version still
 * distinguishes durablets.c changes, but a dquickts-only change
 * would not be caught. */
/** The dquickts upstream pin (first 12 hex of the commit) from the
 * VENDORED_FROM stamp of the tree the engine was built against.
 * Which tree that is: $DQUICKTS when set (re-vendor.sh / run.sh set
 * it while proving a candidate tree — without this, a candidate
 * whose only change is in dquickts would record the DEFAULT tree's
 * pin, and the version check would not distinguish the two builds),
 * else the vendored tree in the durablets package (the Makefile
 * default, packages/durablets/vendor/dquickts), else the legacy
 * VM-local minimal tree. The stamp carries the ABBREVIATED
 * commit (7 hex, "96a9a79"), not the full 40 — accept 7..40. */
function readDquicktsPin(): string {
  const candidates = [
    ...(process.env.DQUICKTS ? [path.join(process.env.DQUICKTS, "VENDORED_FROM")] : []),
    // The Makefile default: the vendored tree inside the package.
    ...durabletsPackageDirs().map((d) => path.join(d, "vendor", "dquickts", "VENDORED_FROM")),
    // Legacy VM-local minimal tree (Brandon's working copy).
    path.join(os.homedir(), "workspace", "dquickts-build-minimal", "VENDORED_FROM"),
  ];
  for (const stampPath of candidates) {
    try {
      const stamp = fs.readFileSync(stampPath, "utf8");
      const m = stamp.match(/Pinned commit:\s*([0-9a-f]{7,40})/);
      if (m) return m[1].slice(0, 12);
    } catch {
      /* stamp missing or unreadable — try the next candidate */
    }
  }
  return "unknown";
}

/** Content hash (first 16 hex) of the DurableTS C host source.
 * "unknown" when the package dir cannot be found (a broken install
 * — the binary could not have been built from this tree anyway). */
function hashDurabletsC(): string {
  for (const dir of durabletsPackageDirs()) {
    const p = path.join(dir, "src", "durablets.c");
    if (fs.existsSync(p)) return shaFile(p).slice(0, 16);
  }
  return "unknown";
}

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
   * re-runs for a resumed run. For runs started after BRA-71 this is
   * the FROZEN entry path (stateDir/frozen/<hash>/...) — the
   * execution path — while the queue entry keeps the live author
   * path for display. For legacy runs it is the original live path. */
  workflowPath?: string;
  /** Frozen workflow copy (BRA-71, BRA-62 G9) — see QueueEntry:
   * the closure hash and frozen entry path recorded at submit, so a
   * fresh process resuming this run finds the frozen copy without
   * the queue. Absent for legacy runs. */
  frozenHash?: string;
  frozenPath?: string;
  /** Engine build that wrote this run's snapshot (BRA-71, BRA-62
   * G10) — see QueueEntry. Absent for legacy runs. */
  engineVersion?: string;
  /** Trap-code pin (BRA-89) — see QueueEntry. Absent for runs
   * started before BRA-89 (legacy: no pin was recorded, so there
   * is nothing to compare — they proceed unchecked). */
  trapPin?: TrapPin;
}

function resolveHostPath(): string {
  // BRA-67: an explicitly set $DURABLETS_HOST that no longer exists
  // (e.g. a VM replacement wiped the build it pointed at) is a loud
  // error, not a silent fallback to a different binary — falling back
  // would run a stale build the operator did not choose, and the G10
  // version check only catches it at resume time, if at all. Unset
  // $DURABLETS_HOST still falls through to the repo candidates.
  if (process.env.DURABLETS_HOST) {
    if (fs.existsSync(process.env.DURABLETS_HOST)) return process.env.DURABLETS_HOST;
    throw new Error(
      `C host binary not found at $DURABLETS_HOST=${process.env.DURABLETS_HOST} (the path is set but the file is gone — rebuild it with make -C <core> durablets, or unset $DURABLETS_HOST to fall back to the repo candidates)`,
    );
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // The Makefile's default OUT_DIR is ./out/ — the built binary.
    path.resolve(here, "..", "..", "agentts-repo", "packages", "durablets", "out", "durablets"),
    path.resolve(here, "..", "..", "..", "packages", "durablets", "out", "durablets"),
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
  /** The environment adapter. Swapped per queue entry by runQueue
   * (an entry is driven with the adapter it was submitted with) —
   * deliberately NOT readonly; the swap is restored in a finally. */
  adapter: Adapter;
  readonly maxRepairAttempts: number;
  private initialClockMs: number;
  private clocks = new Map<string, number>();
  private journals = new Map<string, any[]>();
  /** Corrupt-state report (BRA-77, BRA-62 G5+G15; BRA-84 run
   * entries): every corrupt journal line this Host quarantined on
   * load, every queue recovery, and every run-entry recovery or
   * unrecoverable run entry, in load order. A corrupt journal line
   * is skipped, never fatal; a corrupt queue.json is recovered from
   * its backup (see readQueue) or throws CorruptQueueError; a
   * corrupt run entry is recovered from its backup (see
   * loadRunEntriesFromDisk) or dropped from the registry and
   * recorded here — the Host still starts, and queue repair then
   * classifies that run left-running when its journal shows trap
   * activity (see classifyStrandedEntry). The durable record
   * is stateDir/corruption.log (append-only, deduped by
   * kind+file+lineNo+excerpt). */
  readonly corruption: CorruptionRecord[] = [];
  /** Last queue recovery from queue.json.bak (BRA-77 G5), if any —
   * set by readQueue when queue.json was corrupt and the backup
   * parsed. Null when the queue loaded clean. */
  lastQueueRecovery: { at: string; entries: number } | null = null;
  /** Run entries recovered from their runs/*.json.bak backup
   * (BRA-84), in load order — set by loadRunEntriesFromDisk when a
   * torn run entry was restored from its backup. Empty when every
   * entry loaded clean. */
  readonly runEntryRecoveries: Array<{ runId: string; at: string }> = [];
  private corruptionKeys = new Set<string>();
  /** Filename stems (prefixFor(runId)) of run entries that were
   * corrupt on load with no usable backup (BRA-84) — the entry was
   * dropped from the registry, so classifyStrandedEntry would
   * otherwise report a generic "registry lost". The stem lets the
   * repair report name the actual cause (corrupt entry file, no
   * backup) while the run still stays left-running: re-driving
   * could double-execute the dispatched trap, so the caution
   * stands — it is just no longer silent about why. */
  private corruptRunEntryStems = new Set<string>();
  /** Per-trap dispatch provenance, recorded in driveStepOnce and
   * attached to the trap-result/trap-error event in ingestLog
   * (BRA-57). Keyed by trapId (globally unique: runId/trap-N). */
  private pendingTrapMeta = new Map<string, { adapter: string; worker?: string; wallMs: number; tokens?: number }>();
  private registry = new Map<string, RunEntry>();
  /** Final exit codes of runs that completed (their registry entries
   * are gone — the registry only holds in-flight runs). Lets driveToCompletion()
   * return 0 for a run that completed in one slice instead of
   * throwing "no run entry". */
  private finished = new Map<string, number>();
  private extractions = new Map<string, Extraction>();
  /** runId -> execution workflow path (set by prepareRun). For runs
   * started after BRA-71 this is the FROZEN entry path
   * (stateDir/frozen/<hash>/...); for legacy runs it is the original
   * live path. The queue entry keeps the live author path for
   * display. */
  private workflowPaths = new Map<string, string>();
  /** runId -> frozen workflow copy (BRA-71, BRA-62 G9), set when
   * the run's closure is frozen (submit / startRun). The frozen
   * copy is the execution path from then on; see freezeWorkflow. */
  private frozenCopies = new Map<string, { hash: string; entryPath: string }>();
  /** runId -> trap-code pin (BRA-89), set when the run's pin is
   * computed (submit / startRun). The durable record is the queue
   * entry + the run entry (like the frozen copy); this map is the
   * in-process copy. See computeTrapPin. */
  private trapPins = new Map<string, TrapPin>();
  /** runId -> pinned bundle + source map (BRA-73): trap sites are
   * bundle coordinates, so the bundle that ran + its map must be
   * findable from the run. Set by pinBundle in startRun (the only
   * place a bundle is built); the lifecycle-started event records
   * the paths, so the pin survives a process restart even though
   * this map does not. */
  private bundlePins = new Map<string, { bundlePath: string; bundleMapPath: string | null }>();
  /** Cached engine version (BRA-71, BRA-62 G10) — see
   * engineVersion(). The engine cannot change mid-process. */
  private cachedEngineVersion: string | null = null;
  private logOffsets = new Map<string, number>();
  /** Signal that killed the C host on the last slice (runHost), if any — forensics for the
   * host-crash journal event (G1, BRA-74). Null when the C host exited normally. */
  private lastHostSignal: string | null = null;
  private validator = new SchemaValidator();
  private repairHandlers = new Map<string, RepairHandler>();
  private defaultRepair: RepairHandler | undefined;
  private pendingGate = new Set<string>();
  /** Validated inputs, per run (set by prepareRun/submit; the driver
   * embeds them). Also persisted in the queue entry, so a later
   * process can start the run from the queue alone. */
  private inputs = new Map<string, unknown>();
  /** Decide-rate quota for the in-engine decide path (BRA-49).
   * Default unlimited; see HostConfig.maxDecisionsPerSec. */
  private decideQuotas: QuotaTracker;

  constructor(config: HostConfig = {}) {
    this.hostPath = config.hostPath ?? resolveHostPath();
    this.stateDir = config.stateDir ?? config.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentts-host-"));
    this.workdir = path.join(this.stateDir, "slices");
    for (const d of ["slices", "blobs", "journals", "runs", "cache", "frozen"]) {
      fs.mkdirSync(path.join(this.stateDir, d), { recursive: true });
    }
    this.cacheDir = path.join(this.stateDir, "cache");
    this.clockMode = config.clock ?? "virtual";
    this.adapter = config.adapter ?? new MockAdapter({ gates: config.gates ?? "auto" });
    // Wire the journal callback onto the adapter (BRA-61): the muse
    // adapter reports mid-flight pool transitions (nudge, re-queue,
    // retry attempt) as it observes them, and the host journals
    // them into the run journal as they happen — a hung job's events
    // must land while the job is still stuck, not only when the trap
    // finally resolves.
    this.wireJobEvents(this.adapter);
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

  // ------------------------------------------- frozen copy + engine version (BRA-71, BRA-62 G9+G10)

  /** The engine build that writes and reads snapshots:
   * `dquickts-<pin12>+durablets-<hash16>` — the dquickts pin (from
   * the vendored tree's VENDORED_FROM stamp) plus a content hash of
   * the DurableTS C host source. Source-derived, never
   * binary-derived: the binary is rebuilt fresh on every run.sh
   * invocation into a scratch dir, so a binary hash would change on
   * every rebuild and refuse every cross-process resume. Cached per
   * Host (the engine cannot change mid-process).
   *
   * AGENTTS_ENGINE_VERSION_OVERRIDE (test hook) returns the override
   * verbatim — that is how the test simulates a different engine
   * build. Same pattern as AGENTTS_NO_COMPILER and
   * AGENTTS_CRASH_AFTER_DISPATCH. */
  engineVersion(): string {
    const override = process.env.AGENTTS_ENGINE_VERSION_OVERRIDE;
    if (override) return override;
    if (!this.cachedEngineVersion) {
      this.cachedEngineVersion = `dquickts-${readDquicktsPin()}+durablets-${hashDurabletsC()}`;
    }
    return this.cachedEngineVersion;
  }

  /** Freeze a workflow's closure (G9): copy the entry file + its
   * transitive relative imports + the agentts module it imports
   * into stateDir/frozen/<closureHash>/, preserving their relative
   * layout from their longest common ancestor dir, so every
   * relative import resolves exactly as it did originally. The
   * closure hash covers (relative path, content) of every file, so
   * the store is content-addressed: identical source reuses the
   * same directory, and an edited file gets a different hash. The
   * copy is built in a tmp dir and renamed into place (atomic) so
   * a crash mid-freeze never leaves a partial frozen copy behind.
   * Returns the frozen entry path + hash. */
  freezeWorkflow(workflowPath: string): { hash: string; entryPath: string } {
    const abs = path.resolve(workflowPath);
    const source = fs.readFileSync(abs, "utf8");
    const files = collectWorkflowFiles(abs);
    // The agentts module the closure imports: resolve from every
    // closure file, not just the entry — a workflow that only calls a
    // library (BRA-106: the trap calls live in the lib) never imports
    // agentts itself, so entry-only resolution drops the module from
    // the frozen copy and the gate then fails on the lib's import.
    // First hit wins; every file in one closure resolves to the same
    // module.
    let modulePath: string | null = resolveAgenttsModule(source, path.dirname(abs));
    if (!modulePath) {
      for (const f of files) {
        modulePath = resolveAgenttsModule(fs.readFileSync(f, "utf8"), path.dirname(f));
        if (modulePath) break;
      }
    }
    const all = [...files];
    if (modulePath && fs.existsSync(modulePath)) all.push(path.resolve(modulePath));
    // Longest common ancestor dir of all closure files (segment-wise,
    // so it always terminates).
    const split = (p: string): string[] => p.split(path.sep).filter(Boolean);
    let commonSegs = split(path.dirname(all[0]));
    for (const f of all.slice(1)) {
      const segs = split(path.dirname(f));
      let i = 0;
      while (i < commonSegs.length && i < segs.length && commonSegs[i] === segs[i]) i++;
      commonSegs = commonSegs.slice(0, i);
    }
    const common = path.sep + commonSegs.join(path.sep);
    const rels = all.map((f) => path.relative(common, f)).sort();
    const h = crypto.createHash("sha256");
    for (const rel of rels) {
      h.update(rel);
      h.update("\0");
      h.update(fs.readFileSync(path.join(common, rel)));
      h.update("\0");
    }
    const hash = h.digest("hex");
    const destDir = path.join(this.stateDir, "frozen", hash);
    const entryRel = path.relative(common, abs);
    const entryPath = path.join(destDir, entryRel);
    const complete = rels.every((rel) => fs.existsSync(path.join(destDir, rel)));
    if (!complete) {
      const tmp = path.join(this.stateDir, "frozen", `.tmp-${hash}-${process.pid}`);
      fs.mkdirSync(tmp, { recursive: true });
      for (const rel of rels) {
        const dest = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(common, rel), dest);
      }
      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
      fs.renameSync(tmp, destDir);
    }
    return { hash, entryPath };
  }

  // --------------------------------- BRA-85: state-dir relocation
  //
  // A state dir is the sole carrier of run state, so it must be
  // self-contained: copying or moving it to a new path must not break
  // resume of its suspended runs. Before BRA-85 the registry
  // (runs/<run>.json) and queue.json pinned ABSOLUTE paths under the
  // original state dir — frozenPath, snap, out, log — so a relocated
  // copy failed loudly in requireFrozen ("frozen copy missing") and
  // its slices were never found.
  //
  // Two halves, both in the Host (Layer 2):
  //
  // 1. STORE RELATIVE (going forward): frozenPath is persisted
  //    relative to the state dir ("frozen/<hash>/...") — see
  //    frozenRelPath, applied at the two persistence points
  //    (saveRunEntry, writeQueueLocked). The in-memory form stays
  //    absolute (the execution path), so no consumer changes.
  //    workflowPath is NOT relativized: it can also be a live author
  //    path outside the state dir, so only its frozen case is
  //    re-rooted at load (see rebaseRunEntry).
  //
  // 2. REBASE AT LOAD (legacy + relocated): every stored path is
  //    resolved against the CURRENT state dir when it is read —
  //    readQueue for queue entries, registerLoadedRunEntry for
  //    registry entries — and again defensively at use in
  //    requireFrozen. The rule, per path, prefers the copy under
  //    THIS state dir when it exists, falls back to the stored
  //    absolute path when that exists (a legacy non-moved dir keeps
  //    working byte-identically), and otherwise returns the
  //    current-location path so the loud error names the actionable
  //    location. Nothing is ever silently dropped: a path that
  //    exists nowhere still throws in requireFrozen, as before.
  //    snap/out/log are pure functions of runId
  //    (slices/<prefix>.snap/.out/.log), so their rebase is just the
  //    current workdir path for the run.
  //
  // Load-time rebase (not use-time) is the single place on purpose:
  // every consumer — resume (startRunFrom/loadBlob/deliverResult),
  // gate delivery, repair (classifyStrandedEntry), profile
  // (enrichRunStart), output(), snapPath() — reads the registry or
  // queue, so all of them see rebased paths with no per-consumer
  // fix. The queue entry's live workflowPath is never rebased: it
  // points at the author's file by design, outside the state dir.
  // Journal events keep their historical absolute paths (display
  // only — rewriting journal history would falsify the record).

  /** The stored form of a frozen entry path: relative to the state
   * dir ("frozen/<hash>/...") when the file lives under it, the
   * absolute path otherwise (a frozen copy always lives under the
   * state dir, so the otherwise-branch is defensive only). An
   * already-relative value passes through untouched. */
  private frozenRelPath(entryPath: string): string {
    if (!path.isAbsolute(entryPath)) return entryPath;
    const rel = path.relative(this.stateDir, entryPath);
    return rel.startsWith("..") || path.isAbsolute(rel) ? entryPath : rel;
  }

  /** Resolve a stored frozenPath against the CURRENT state dir.
   * Relative (BRA-85 form) resolves under this state dir. Absolute
   * (legacy form): prefer the frozen/ subtree under this state dir
   * when it exists — a relocated copy must execute from its own
   * frozen copy, not the original's — then the stored path itself
   * when it exists (a non-moved legacy dir), else the rebased path
   * so requireFrozen's loud error names the current location. */
  private resolveFrozenPath(stored: string): string {
    if (!path.isAbsolute(stored)) return path.join(this.stateDir, stored);
    const segs = stored.split(path.sep);
    const idx = segs.lastIndexOf("frozen");
    if (idx < 0) return stored;
    const rebased = path.join(this.stateDir, ...segs.slice(idx));
    if (fs.existsSync(rebased)) return rebased;
    if (fs.existsSync(stored)) return stored;
    return rebased;
  }

  /** Rebase one queue entry read from disk: its frozenPath resolves
   * against the current state dir (relative or legacy absolute).
   * Pure — it never writes; the next queue write persists the
   * rebased (relative-stored) form via writeQueueLocked. The live
   * workflowPath is left untouched by design (see above). */
  private rebaseQueueEntry(e: QueueEntry): QueueEntry {
    if (e.frozenPath) e.frozenPath = this.resolveFrozenPath(e.frozenPath);
    return e;
  }

  /** Rebase one registry entry read from disk: frozenPath as above;
   * snap/out/log to the current workdir when the current-location
   * file exists, else keep the stored path when IT exists, else the
   * current-location path (the loud failure then names it);
   * workflowPath re-rooted only when it names a frozen copy that no
   * longer exists at the stored location (a live author path is
   * left untouched). Pure — the next saveRunEntry persists it. */
  private rebaseRunEntry(e: RunEntry): RunEntry {
    if (e.frozenPath) e.frozenPath = this.resolveFrozenPath(e.frozenPath);
    const p = prefixFor(e.runId);
    for (const key of ["snap", "out", "log"] as const) {
      const ext = key === "snap" ? ".snap" : key === "out" ? ".out" : ".log";
      const current = path.join(this.workdir, p + ext);
      const stored = e[key];
      if (fs.existsSync(current)) e[key] = current;
      else if (stored && fs.existsSync(stored)) e[key] = stored;
      else e[key] = current;
    }
    if (e.workflowPath && !fs.existsSync(e.workflowPath)) {
      const segs = e.workflowPath.split(path.sep);
      const idx = segs.lastIndexOf("frozen");
      if (idx >= 0) {
        const rebased = path.join(this.stateDir, ...segs.slice(idx));
        if (fs.existsSync(rebased)) e.workflowPath = rebased;
      }
    }
    return e;
  }

  /** The frozen copy recorded for a run (in-memory first, then the
   * registry entry, then the queue entry — so a fresh process
   * resuming the run finds it). Null when no copy was recorded
   * (legacy run, pre-BRA-71): the caller falls back to the live
   * workflow path. Throws loudly when a copy IS recorded but its
   * files are gone — falling back to the live file there would
   * silently execute a different source, the exact hazard G9
   * closes. */
  private frozenFor(runId: string): { hash: string; entryPath: string } | null {
    const mem = this.frozenCopies.get(runId);
    if (mem) return this.requireFrozen(mem, runId);
    const reg = this.registry.get(runId);
    if (reg?.frozenHash && reg?.frozenPath) {
      return this.requireFrozen({ hash: reg.frozenHash, entryPath: reg.frozenPath }, runId);
    }
    const q = this.readQueue().find((e) => e.runId === runId);
    if (q?.frozenHash && q?.frozenPath) {
      return this.requireFrozen({ hash: q.frozenHash, entryPath: q.frozenPath }, runId);
    }
    return null;
  }

  private requireFrozen(f: { hash: string; entryPath: string }, runId: string): { hash: string; entryPath: string } {
    // BRA-85: resolve defensively at use as well as at load — a
    // stored path that bypassed the load rebase (or an in-memory
    // entry built before a move) still resolves against the current
    // state dir instead of failing on a stale absolute path.
    const entryPath = this.resolveFrozenPath(f.entryPath);
    if (!fs.existsSync(entryPath)) {
      throw new Error(
        `frozen copy missing for run ${runId}: ${entryPath} (hash ${f.hash.slice(0, 12)}) was deleted — cannot resume the run from its submitted source; re-submit the workflow to start a fresh run`,
      );
    }
    return { hash: f.hash, entryPath };
  }

  /** Record a run's frozen copy + engine version + trap-code pin on
   * its queue entry (if one exists — submit does this at enqueue;
   * startRun does it when it freezes on demand, e.g. the admit
   * path, which enqueues without submitting). */
  private stampQueueEntry(runId: string, fields: { frozenHash?: string; frozenPath?: string; engineVersion?: string; trapPin?: TrapPin }): void {
    // BRA-82: a read-modify-write — hold the enqueue lock across
    // it so a concurrent submit cannot interleave and lose either
    // the stamp or the new entry.
    this.withQueueLock(() => {
      const q = this.readQueue();
      const e = q.find((x) => x.runId === runId);
      if (!e) return;
      Object.assign(e, fields);
      this.writeQueue(q);
    });
  }

  /** Refuse loudly to resume a snapshot from a different engine
   * build (G10). Called in runQueue's resume branch, before the
   * snapshot is touched. A run with no recorded version (legacy,
   * pre-BRA-71) has nothing to compare and proceeds — the check
   * only protects runs started after BRA-71. On mismatch the run
   * is marked failed with the version error by runQueue's catch
   * (the blob stays on disk, so restoring the matching engine and
   * re-queueing can still resume it). */
  private assertEngineVersion(runId: string, reg: RunEntry, q: QueueEntry): void {
    const recorded = reg.engineVersion ?? q.engineVersion ?? null;
    if (!recorded) return;
    const current = this.engineVersion();
    if (recorded === current) return;
    const msg =
      `refusing to resume ${runId}: snapshot was written by engine ${recorded} but this host is engine ${current} — snapshots are same-engine-only; restore the ${recorded} engine build to resume this run, or start a fresh run`;
    this.journalEvent(runId, { event: "engine-version-mismatch", runId, recorded, current });
    throw new Error(msg);
  }

  // ------------------------------------------- trap-code pin (BRA-89)
  //
  // BRA-71 froze the workflow source, but the code that ANSWERS a
  // run's traps — worker scripts, jobspec prose, the decision
  // model, the adapter itself, exec'd scripts — lives outside the
  // frozen closure and is resolved from the live tree at trap
  // time. A library update could therefore change an in-flight
  // run's answers while its frozenHash/engineVersion still
  // checked out. The pin closes that half of the promise.
  //
  // Direction (b) — hash-pin + loud refusal — chosen over (a)
  // extend-the-frozen-closure, for three reasons. First, one
  // mechanism at one choke point (dispatchTrap) covers all five
  // answer paths — direct spawn, briefing spawn, the mock
  // adapter's live import, the pool jobspec read, and exec'd
  // scripts — with no per-adapter path plumbing: (a) would need
  // the server to serve per-run frozen jobspec content to remote
  // pool workers, a dynamic per-run import in the sync mock
  // adapter, and rewriting workflow exec args at dispatch (which
  // would falsify the journaled arg). Second, it matches the
  // existing BRA-71 G10 pattern: a run whose code changed under
  // it is refused loudly, the blob kept, restore-and-resume
  // possible — the codebase already treats that as the sanctioned
  // response. Third, it is the smaller change, and the pin is
  // checkable from the queue entry alone (no frozen-dir surgery).
  // The price is explicit: a mid-run edit FAILS the run instead
  // of letting it finish on the old code. That is the documented
  // trade — a loud failure naming the file, never a silent change
  // of what the run executes.
  //
  // The check runs in dispatchTrap, before the adapter answers,
  // for job/decide/exec only: sleep/cron/clock are host-owned
  // (no external code), and a gate answer comes from a human, not
  // from code. A trap already dispatched (BRA-75 journal check
  // re-delivers its recorded answer) never re-checks — its answer
  // was already recorded under the pinned code. Legacy runs with
  // no pin proceed unchecked (nothing to compare), like BRA-71's
  // legacy runs.

  /** Resolve one plugin file the way loadAdapter resolves its
   * seam: $AGENTTS_PLUGINS_DIR first (run.sh sets it when the
   * host runs from a scratch copy), then the sibling plugins/
   * dir, then the staged-repo layout. Null when no candidate
   * exists — the caller skips a missing file (a missing adapter
   * file would already have failed loudly at load). */
  private pluginFile(name: string, rel: string): string | null {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const envDir = process.env.AGENTTS_PLUGINS_DIR;
    const candidates = [
      ...(envDir ? [path.resolve(envDir, name, "src", rel)] : []),
      path.resolve(here, "..", "plugins", name, "src", rel),
      path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "plugins", name, "src", rel),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }

  /** The jobspec dir the way the worker server resolves it:
   * $AGENTTS_JOBSPEC_DIR, else the plugins/muse/jobspecs dir next
   * to this file (or under $AGENTTS_PLUGINS_DIR). */
  private jobspecDir(): string {
    if (process.env.AGENTTS_JOBSPEC_DIR) return path.resolve(process.env.AGENTTS_JOBSPEC_DIR);
    const here = path.dirname(new URL(import.meta.url).pathname);
    const envDir = process.env.AGENTTS_PLUGINS_DIR;
    const candidates = [
      ...(envDir ? [path.resolve(envDir, "muse", "jobspecs")] : []),
      path.resolve(here, "..", "plugins", "muse", "jobspecs"),
      path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "plugins", "muse", "jobspecs"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return candidates[0];
  }

  /** Compute a run's trap-code pin (see TrapPin for the precise
   * rule). Call AFTER prepareRun: it reads the extraction's job
   * specs and the frozen entry path (workflowPaths holds the
   * frozen path once prepareRun ran on it). The adapter is the
   * live instance that will answer the run's traps — its
   * workerPathFor (when it has one) resolves the run's specs to
   * worker scripts, so a --workers-config override is pinned as
   * submitted, not as defaulted. Files that do not exist are
   * skipped, never pinned as missing: a run whose spec has no
   * jobspec file, or whose adapter has no registry entry for a
   * spec, still dispatches, and the adapter's own loud error
   * fires for an unregistered spec. */
  computeTrapPin(runId: string, adapter: Adapter): TrapPin {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const files: Record<string, string> = {};
    const add = (p: string | null | undefined): void => {
      if (!p) return;
      const abs = path.resolve(p);
      if (!fs.existsSync(abs) || abs in files) return;
      files[abs] = shaFile(abs);
    };
    // 1. The decision model, always (see TrapPin).
    add(path.join(here, "decision-model.ts"));
    // 2. The run adapter's own files (seam + implementation).
    const adapterFiles: Record<string, string[]> = {
      direct: ["adapter.ts", "direct-adapter.ts"],
      briefing: ["adapter.ts"],
      mock: ["adapter.ts", "mock-adapter.ts"],
      muse: ["adapter.ts", "muse-adapter.ts"],
    };
    for (const rel of adapterFiles[adapter.name] ?? ["adapter.ts"]) {
      add(this.pluginFile(adapter.name, rel));
    }
    // The briefing adapter delegates to DirectAdapter (it returns
    // one with its workers registered), so its implementation file
    // is the direct adapter's too.
    if (adapter.name === "briefing") add(this.pluginFile("direct", "direct-adapter.ts"));
    // 3. Worker scripts + jobspec prose, per extracted job spec.
    const extraction = this.extractions.get(runId);
    const specs = extraction
      ? Object.keys(extraction.sites)
          .filter((k) => k.startsWith("job:"))
          .map((k) => k.slice("job:".length))
      : [];
    const workerPathFor = (adapter as unknown as { workerPathFor?: (spec: string) => string | null }).workerPathFor;
    for (const spec of specs) {
      if (typeof workerPathFor === "function") {
        try {
          add(workerPathFor.call(adapter, spec));
        } catch {
          /* a registry read that throws pins nothing — the adapter
             still fails loudly at dispatch for an unregistered spec */
        }
      }
      if (adapter.name === "mock" && spec.startsWith("bugfix-")) {
        add(path.join(here, "..", "workflows", "bugfix-worker.ts"));
      }
      const jobspec = path.join(this.jobspecDir(), `${spec}.md`);
      if (fs.existsSync(jobspec)) add(jobspec);
    }
    // 4. Exec'd scripts the run references: any `workflows/<name>.ts`
    // named in the frozen workflow closure (entry + transitive
    // relative imports, already frozen by BRA-71) is a script the
    // workflow runs via an exec trap (`bun workflows/<name>.ts`,
    // relative to the host cwd — the live file, never the frozen
    // dir). The closure text is the authority: a workflow that
    // never names such a script pins none.
    const frozenEntry = this.workflowPaths.get(runId);
    if (frozenEntry) {
      const repoRoot = path.resolve(here, "..");
      for (const f of collectWorkflowFiles(frozenEntry)) {
        let text: string;
        try {
          text = fs.readFileSync(f, "utf8");
        } catch {
          continue;
        }
        for (const m of text.matchAll(/workflows\/([A-Za-z0-9_.-]+\.ts)/g)) {
          add(path.join(repoRoot, "workflows", m[1]));
        }
      }
    }
    return { files };
  }

  /** The trap-code pin recorded for a run (in-memory first, then
   * the registry entry, then the queue entry — so a fresh process
   * resuming the run finds it). Null when no pin was recorded
   * (legacy run, pre-BRA-89): the caller proceeds unchecked. */
  private trapPinFor(runId: string): TrapPin | null {
    const mem = this.trapPins.get(runId);
    if (mem) return mem;
    const reg = this.registry.get(runId);
    if (reg?.trapPin) return reg.trapPin;
    const q = this.readQueue().find((e) => e.runId === runId);
    if (q?.trapPin) return q.trapPin;
    return null;
  }

  /** Refuse loudly to answer a trap from trap code that changed
   * since submit (BRA-89). Called in dispatchTrap, before the
   * adapter answers. A changed or deleted pinned file journals a
   * trap-code-mismatch event (naming the file and both hashes)
   * and throws — runQueue's catch marks the run failed with this
   * message, and the snapshot blob stays on disk, so restoring
   * the file and re-queueing can still resume the run (the trap
   * was never dispatched, so no answer was recorded under the
   * changed code). */
  private assertTrapPin(runId: string, trapId: string): void {
    const pin = this.trapPinFor(runId);
    if (!pin) return;
    for (const file of Object.keys(pin.files).sort()) {
      const recorded = pin.files[file];
      let current: string | null = null;
      try {
        current = fs.existsSync(file) ? shaFile(file) : null;
      } catch {
        current = null;
      }
      if (current === recorded) continue;
      const msg =
        `refusing to answer trap ${trapId} for run ${runId}: trap-code pin mismatch — ${file} changed since submit ` +
        `(pinned sha256 ${recorded.slice(0, 12)}…, now ${current === null ? "missing" : `sha256 ${current.slice(0, 12)}…`}) — ` +
        `a library update must not change in-flight runs; restore ${file} to its submitted content and re-queue the run, or start a fresh run`;
      this.journalEvent(runId, {
        event: "trap-code-mismatch",
        runId,
        trapId,
        file,
        recorded,
        current,
      });
      throw new Error(msg);
    }
  }

  // ------------------------------------------------------- plugin loading
  /**
   * Load an adapter from apps/agentts/plugins/<name>/src/adapter.ts
   * (a module exporting createAdapter() or a default Adapter).
   * Every adapter name goes through the same plugin seam — there
   * is no built-in short-circuit (BRA-68 removed the last one,
   * "direct"; BRA-53 had already removed "mock"). "mock" loads
   * from plugins/mock/src/adapter.ts, "direct" from
   * plugins/direct/src/adapter.ts, "muse" from
   * plugins/muse/src/adapter.ts. The canned answers live in the
   * implementation file next to each seam
   * (plugins/<name>/src/<name>-adapter.ts), shared by the Host
   * constructor default and the plugin seam — one copy, not two.
   * A name that resolves to no plugin is a loud error, never a
   * silent default.
   */
  static async loadAdapter(name: string, opts?: Record<string, unknown>): Promise<Adapter> {
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
      if (typeof mod.createAdapter === "function") return mod.createAdapter(opts) as Adapter;
      if (mod.default) return mod.default as Adapter;
      throw new Error(`plugin adapter ${c} exports neither createAdapter() nor a default adapter`);
    }
    throw new Error(
      `unknown adapter "${name}" (tried ${candidates.join(", ")})`,
    );
  }

  /** Wire the job-event callback onto an adapter that supports it
   * (BRA-61). The muse adapter reports mid-flight pool transitions
   * through onJobEvent / setJobEventHandler; the host journals each
   * one into the run journal as it arrives (journalEvent is the
   * choke point, so the events carry wallTs like every other
   * journal event). Adapters without the seam (mock, direct) are
   * untouched — the check is structural, not a type import, so the
   * host never depends on the muse adapter's class. */
  private wireJobEvents(adapter: Adapter): void {
    const set = (adapter as any)?.setJobEventHandler;
    if (typeof set !== "function") return;
    set.call(adapter, (ctx: TrapContext, ev: { event: string; jobId: string; spec: string; detail: Record<string, unknown> }) => {
      this.journalEvent(ctx.runId, {
        event: ev.event,
        runId: ctx.runId,
        trapId: ctx.trapId,
        jobId: ev.jobId,
        spec: ev.spec,
        ...ev.detail,
      });
    });
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
  /** Previous good queue (BRA-77 G5): writeQueue backs the current
   * queue.json up here — atomically, and only when it parses — so a
   * torn or externally corrupted queue.json can be recovered. The
   * backup is at most one write behind the queue. */
  queueBackupPath(): string {
    return path.join(this.stateDir, "queue.json.bak");
  }
  private corruptionLogPath(): string {
    return path.join(this.stateDir, "corruption.log");
  }
  /** Durable corruption log (BRA-77, shared with the WorkerServer
   * since BRA-76 — see corruption.ts). Lazily built: the path needs
   * stateDir, which the constructor sets. */
  private corruptionLogInstance: CorruptionLog | null = null;
  private corruptionLog(): CorruptionLog {
    if (!this.corruptionLogInstance) {
      this.corruptionLogInstance = new CorruptionLog(this.corruptionLogPath());
    }
    return this.corruptionLogInstance;
  }
  /** Record one corrupt-state finding (BRA-77): in the public
   * `corruption` report and, durably, in stateDir/corruption.log
   * (append-only JSONL). Deduped in-process (a journal file is
   * parsed twice on load — once by loadJournalsFromDisk, once by
   * the registry re-key path) and across processes (a quarantined
   * line stays in its journal file, so every new Host
   * re-quarantines it). The in-memory report keeps the record even
   * when the file already holds it — only the file append dedupes
   * across processes. Best-effort: a failure to write the log never
   * fails the load. */
  private recordCorruption(rec: CorruptionRecord): void {
    const key = `${rec.kind}|${rec.file}|${rec.lineNo}|${rec.excerpt}`;
    if (this.corruptionKeys.has(key)) return;
    this.corruptionKeys.add(key);
    this.corruption.push(rec);
    this.corruptionLog().append(rec);
  }
  /** Parse a queue file: the parsed value must be an array of
   * entries, or the file is corrupt. Returns null on any failure
   * (missing file, unparseable JSON, non-array) with the reason. */
  private parseQueueFile(p: string): { queue: QueueEntry[] | null; reason: string | null } {
    if (!fs.existsSync(p)) return { queue: null, reason: "missing" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return { queue: null, reason: `unparseable JSON (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!Array.isArray(parsed)) return { queue: null, reason: "parsed value is not an array" };
    return { queue: parsed as QueueEntry[], reason: null };
  }
  readQueue(): QueueEntry[] {
    const p = this.queuePath();
    if (!fs.existsSync(p)) return [];
    const { queue, reason } = this.parseQueueFile(p);
    // BRA-85: rebase stored paths against the current state dir, so
    // a relocated copy resumes (see rebaseQueueEntry).
    if (queue) return queue.map((e) => this.rebaseQueueEntry(e));
    // Corrupt queue.json (BRA-77 G5): recover from the backup when
    // it parses, and say so loudly — the recovery is reported
    // (console + corruption.log + lastQueueRecovery), never silent.
    // A backup is at most one write behind, and a slightly stale
    // queue is exactly what the BRA-72 repair re-classifies and the
    // BRA-75 journal check guards against double-dispatch — so
    // recovering here is safe where silently returning [] was not
    // (that dropped every queued run).
    const backup = this.parseQueueFile(this.queueBackupPath());
    if (backup.queue) {
      // Restore the recovered queue atomically. writeQueue would
      // back the corrupt queue.json up first — it only backs up a
      // queue that parses, so the good backup is never clobbered.
      this.writeQueue(backup.queue);
      const at = new Date().toISOString();
      this.lastQueueRecovery = { at, entries: backup.queue.length };
      this.recordCorruption({
        kind: "queue-recovered",
        file: "queue.json",
        lineNo: 0,
        reason: `queue.json is corrupt (${reason}) — recovered ${backup.queue.length} entries from queue.json.bak`,
        excerpt: reason ?? "corrupt",
        at,
      });
      console.warn(
        `CORRUPT QUEUE: queue.json is corrupt (${reason}) — recovered ${backup.queue.length} entries from queue.json.bak; see ${this.corruptionLogPath()}`,
      );
      // BRA-85: rebase the recovered entries too (see above).
      return backup.queue.map((e) => this.rebaseQueueEntry(e));
    }
    // Both files corrupt (or the backup is missing): fail loudly.
    // Never return [] — that silently dropped the whole queue.
    throw new CorruptQueueError(
      `queue.json is corrupt (${reason}) and queue.json.bak is ${backup.reason === "missing" ? "missing" : `also corrupt (${backup.reason})`} — refusing to guess. ` +
        `Inspect ${p} and ${this.queueBackupPath()}, restore a known-good copy, or delete queue.json to start with an empty queue (that drops every queued run).`,
    );
  }
  private writeQueue(q: QueueEntry[]): void {
    // BRA-82: a bare write is still serialized against other
    // processes — when no caller already holds the enqueue lock,
    // take it for the write itself. Callers doing a
    // read-modify-write hold the lock across the whole sequence
    // (see withQueueLock), and the reentrancy depth below makes
    // the nested acquire a no-op instead of a deadlock.
    if (this.queueLockDepth === 0) {
      this.withQueueLock(() => this.writeQueueLocked(q));
      return;
    }
    this.writeQueueLocked(q);
  }
  private writeQueueLocked(q: QueueEntry[]): void {
    // Back the current queue up first — but only when it parses.
    // A corrupt queue.json must never clobber a good backup: the
    // backup is the recovery source, and readQueue depends on it.
    const current = this.parseQueueFile(this.queuePath());
    if (current.queue) {
      atomicWriteFile(this.queueBackupPath(), JSON.stringify(current.queue, null, 2));
    }
    // BRA-85: persist frozenPath state-dir-relative, so a copied or
    // moved state dir stays self-contained (the backup above keeps
    // the previous file verbatim). In-memory entries keep the
    // resolved absolute path — only the stored form is relative.
    const stored = q.map((e) =>
      e.frozenPath ? { ...e, frozenPath: this.frozenRelPath(e.frozenPath) } : e,
    );
    atomicWriteFile(this.queuePath(), JSON.stringify(stored, null, 2));
  }
  /** Enqueue a workflow run (plugin-internal dispatch queue).
   * BRA-82: the read-modify-write runs under the enqueue lock —
   * two concurrent submits each read the same queue and the
   * second write used to overwrite the first, losing an entry
   * (last writer wins). The lock makes the whole sequence atomic
   * across processes. */
  enqueue(workflowPath: string, runId: string, opts: { adapter?: string; taskId?: string; priority?: number; input?: unknown; frozenHash?: string; frozenPath?: string; engineVersion?: string; trapPin?: TrapPin } = {}): QueueEntry {
    return this.withQueueLock(() => {
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
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.frozenHash ? { frozenHash: opts.frozenHash } : {}),
      ...(opts.frozenPath ? { frozenPath: opts.frozenPath } : {}),
      ...(opts.engineVersion ? { engineVersion: opts.engineVersion } : {}),
      ...(opts.trapPin ? { trapPin: opts.trapPin } : {}),
      enqueuedAt: new Date().toISOString(),
    };
    q.push(entry);
    this.writeQueue(q);
    return entry;
    });
  }

  // ------------------------------------------- enqueue lock (BRA-82)
  /** The enqueue lock: a SEPARATE lock from the driver lock, and
   * deliberately so. The driver lock is held for a whole `queue
   * run` drive (minutes to hours); sharing it would serialize
   * submits against long drives and make a submit fail outright
   * whenever a driver is live — the exact failure BRA-82's
   * reproduction hits (concurrent submit during a live drive).
   * The enqueue lock is a brief critical section instead: one
   * queue read-modify-write (enqueue, repair, a status flip, a
   * stamp, a gate re-queue), milliseconds, held only for that
   * sequence and released immediately.
   *
   * Same mkdir-atomic pattern as the driver lock (BRA-72): the
   * lock is a directory `<stateDir>/queue.lock/` holding
   * `holder.json` {pid, startedAt, command}. No heartbeat — a
   * critical section is bounded milliseconds, so there is nothing
   * to refresh; liveness is the holder pid plus the lock's age.
   * A lock is STALE when its holder pid is dead (a crashed submit
   * leaves exactly this behind) or when a live pid has held it
   * longer than ENQUEUE_LOCK_STALE_MS (a stopped/wedged holder —
   * see the constant's comment for the accepted residual risk).
   * A stale lock is broken by the next acquirer and the submit
   * proceeds; a live lock makes the acquirer WAIT (poll every
   * ENQUEUE_LOCK_POLL_MS, up to ENQUEUE_LOCK_WAIT_MS) and then
   * refuse loudly — a submit waits briefly, it never fails fast
   * on contention and never wedges the queue forever.
   *
   * Lock order is driver lock (outer) -> enqueue lock (inner):
   * runQueue and repair hold the driver lock for the drive and
   * take the enqueue lock briefly per queue write; enqueue takes
   * only the enqueue lock, never the driver lock — so no cycle,
   * and a submit waiting briefly on the enqueue lock is never
   * mistaken for a stuck driver (the driver lock is untouched
   * by submits). Reentrancy is per-process (queueLockDepth): a
   * nested acquire in the same process is a no-op, so writeQueue
   * can auto-lock a bare write without deadlocking inside a
   * withQueueLock block. */
  private queueLockDepth = 0;
  private queueLockDir(): string {
    return path.join(this.stateDir, "queue.lock");
  }
  /** Is the queue lock in `dir` live, stale (dead holder pid), or
   * stale with a live pid (held past ENQUEUE_LOCK_STALE_MS)? */
  private inspectQueueLock(dir: string): "live" | "stale" | "stale-live-pid" {
    const holder = this.readLockHolder(dir);
    if (!holder) {
      // No holder record: a holder may be mid-write (it just
      // created the dir). Young = live, old = stale.
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        ageMs = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        return "stale";
      }
      return ageMs > ENQUEUE_LOCK_EMPTY_GRACE_MS ? "stale" : "live";
    }
    let alive = false;
    try {
      process.kill(holder.pid, 0);
      alive = true;
    } catch (e: any) {
      if (e?.code === "ESRCH") alive = false;
      else if (e?.code === "EPERM") alive = true; // exists, cannot signal
      else throw e;
    }
    if (!alive) return "stale";
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - fs.statSync(dir).mtimeMs;
    } catch {
      return "stale";
    }
    return ageMs > ENQUEUE_LOCK_STALE_MS ? "stale-live-pid" : "live";
  }
  /** Acquire the enqueue lock, BLOCKING: wait while a live holder
   * holds it, break a stale one and retry. Throws
   * HostRefusalError after ENQUEUE_LOCK_WAIT_MS of waiting. */
  acquireQueueLock(): void {
    if (this.queueLockDepth > 0) {
      this.queueLockDepth++;
      return;
    }
    const dir = this.queueLockDir();
    const deadline = Date.now() + ENQUEUE_LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(dir);
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        const verdict = this.inspectQueueLock(dir);
        const holder = this.readLockHolder(dir);
        if (verdict === "live") {
          if (Date.now() >= deadline) {
            throw new HostRefusalError(
              `queue lock for ${this.stateDir} held by a live submit (pid ${holder?.pid ?? "?"}, started ${holder?.startedAt ?? "?"}) for over ${ENQUEUE_LOCK_WAIT_MS / 1000}s — refusing to queue concurrently; retry the submit`,
            );
          }
          Bun.sleepSync(ENQUEUE_LOCK_POLL_MS);
          continue;
        }
        // Stale (dead pid), or stale with a live pid: break it and
        // retry. A live-pid break is loud — the holder is wedged
        // or stopped, not driving; see ENQUEUE_LOCK_STALE_MS.
        if (verdict === "stale-live-pid") {
          console.error(
            `WARNING: breaking a stale queue lock for ${this.stateDir} (holder pid ${holder?.pid ?? "?"} alive but held over ${ENQUEUE_LOCK_STALE_MS / 1000}s — wedged or stopped, not in a normal critical section)`,
          );
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* fall through to the retry */
        }
        continue;
      }
      // We own it now.
      const holder: DriverLockHolder = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: process.argv.slice(1).join(" ") || "agentts",
      };
      fs.writeFileSync(path.join(dir, "holder.json"), JSON.stringify(holder, null, 2));
      this.queueLockDepth = 1;
      return;
    }
  }
  /** Release a queue lock this process holds. Only removes the
   * lock dir when the holder pid is ours — never delete another
   * submitter's lock. */
  releaseQueueLock(): void {
    if (this.queueLockDepth === 0) return;
    this.queueLockDepth--;
    if (this.queueLockDepth > 0) return;
    const dir = this.queueLockDir();
    const holder = this.readLockHolder(dir);
    if (holder?.pid === process.pid) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort: a leftover dir with a dead pid is stale and
           the next acquirer breaks it */
      }
    }
  }
  /** Run `fn` with the enqueue lock held (BRA-82): the lock makes
   * a queue read-modify-write atomic across processes. */
  private withQueueLock<T>(fn: () => T): T {
    this.acquireQueueLock();
    try {
      return fn();
    } finally {
      this.releaseQueueLock();
    }
  }
  /** Re-read the queue under the enqueue lock, mutate one entry,
   * write it back (BRA-82). The fresh read matters: a driver
   * holding a snapshot of the queue across a drive would
   * otherwise clobber entries enqueued mid-drive on its next
   * write. Returns false when the entry is gone (nothing to
   * update). */
  private updateQueueEntry(runId: string, mutate: (e: QueueEntry) => void): boolean {
    return this.withQueueLock(() => {
      const q = this.readQueue();
      const e = q.find((x) => x.runId === runId);
      if (!e) return false;
      mutate(e);
      this.writeQueue(q);
      return true;
    });
  }

  /**
   * Emit a system event to the worker server's event hub (BRA-65):
   * the tick agent's wake signal. Best-effort by design — the
   * server may not be running (a mock-adapter test with no tick
   * agent), in which case the POST fails fast and is swallowed.
   * A dropped event only delays the tick agent's wake (bounded by
   * the tick timeout + the catch-up sweep), never loses work: the
   * event is a notification, the queue/journal/store on disk is
   * the source of truth. Never throws, never blocks the drive for
   * more than the 2s POST timeout.
   */
  notifyEvent(
    type: SystemEventType,
    detail: { runId?: string; jobId?: string; trapId?: string; detail?: unknown } = {},
  ): void {
    try {
      httpPostSync(
        `${workerServerUrl()}/event`,
        { type, at: new Date().toISOString(), ...detail } satisfies SystemEvent,
        2000,
      );
    } catch {
      /* event delivery is best-effort */
    }
  }
  // ------------------------------------------- driver lock + repair (BRA-72)
  /** The driver lock (BRA-62 G13): one driver per state dir. The lock
   * is a directory `<stateDir>/driver.lock/` — `mkdir` is the atomic
   * primitive (no flock binding in Bun/Node, no new dependency).
   * It holds `holder.json` {pid, startedAt, command} and a `heartbeat`
   * file (ISO timestamp, refreshed every 10s while driving and before
   * / after each entry, so a slow-but-live driver stays fresh even
   * when a blocking trap stalls the event loop between refreshes).
   * A lock is STALE when its holder pid is dead (kill(pid, 0) throws
   * ESRCH) — a crashed driver leaves exactly this behind. A lock is
   * LIVE when the pid is alive and the heartbeat is fresh. A lock is
   * AMBIGUOUS when the pid is alive but the heartbeat is stale
   * (probably a reused pid, or a driver wedged in a blocking call):
   * refuse by default; `--force` on `queue repair` breaks it, loudly,
   * and only a human who has confirmed the holder is dead may use it
   * — never the tick agent, never automation. The lock is held for
   * the WHOLE drive (acquired in runQueue, released in a finally),
   * so a second driver — manual or a second tick agent — fails
   * loudly instead of corrupting a run (startRunFrom deletes the
   * journal on a re-run). */
  lastRepairReport: RepairReport | null = null;

  private driverLockDir(): string {
    return path.join(this.stateDir, "driver.lock");
  }
  private readLockHolder(dir: string): DriverLockHolder | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, "holder.json"), "utf8"));
      if (parsed && typeof parsed.pid === "number") return parsed as DriverLockHolder;
      return null;
    } catch {
      return null;
    }
  }
  private readLockHeartbeat(dir: string): number | null {
    try {
      const ms = Date.parse(fs.readFileSync(path.join(dir, "heartbeat"), "utf8").trim());
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  private writeLockHeartbeat(dir: string): void {
    // tmp+rename: a torn heartbeat must never corrupt the holder file.
    const tmp = path.join(dir, `.heartbeat.${process.pid}.tmp`);
    fs.writeFileSync(tmp, new Date().toISOString());
    fs.renameSync(tmp, path.join(dir, "heartbeat"));
  }
  /** Best-effort heartbeat refresh (the lock dir may have been
   * force-broken out from under this drive — never fail a drive
   * over it). */
  private refreshLockHeartbeat(): void {
    try {
      this.writeLockHeartbeat(this.driverLockDir());
    } catch {
      /* best-effort */
    }
  }
  /** Is the lock in `dir` live, stale, or ambiguous? */
  private inspectDriverLock(dir: string): "live" | "stale" | "ambiguous" {
    const holder = this.readLockHolder(dir);
    if (!holder) {
      // No holder record: a holder may be mid-write (it just created
      // the dir). Young = live, old = stale.
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        ageMs = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        return "stale";
      }
      return ageMs > DRIVER_LOCK_EMPTY_GRACE_MS ? "stale" : "live";
    }
    let alive = false;
    try {
      process.kill(holder.pid, 0);
      alive = true;
    } catch (e: any) {
      if (e?.code === "ESRCH") alive = false;
      else if (e?.code === "EPERM") alive = true; // exists, cannot signal
      else throw e;
    }
    if (!alive) return "stale";
    const beat = this.readLockHeartbeat(dir);
    if (beat === null) return "ambiguous";
    return Date.now() - beat > DRIVER_LOCK_AMBIGUOUS_MS ? "ambiguous" : "live";
  }
  /** Acquire the driver lock for the whole drive (non-blocking).
   * Throws HostRefusalError when a live driver holds it. A stale
   * lock is broken (its holder is provably gone) and the acquire
   * retried. `force` breaks an ambiguous — or live — lock, loudly;
   * only a human who has confirmed the holder is dead may pass it. */
  acquireDriverLock(opts: { force?: boolean } = {}): DriverLockHandle {
    const dir = this.driverLockDir();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.mkdirSync(dir);
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        const verdict = this.inspectDriverLock(dir);
        const holder = this.readLockHolder(dir);
        if (verdict === "live" && !opts.force) {
          throw new HostRefusalError(
            `driver already running for ${this.stateDir} (pid ${holder?.pid ?? "?"}, started ${holder?.startedAt ?? "?"}) — refusing to drive concurrently; wait for it to finish, or run \`agentts queue repair\` once it is gone`,
          );
        }
        if (verdict === "ambiguous" && !opts.force) {
          throw new HostRefusalError(
            `driver lock for ${this.stateDir} is ambiguous (pid ${holder?.pid} alive but heartbeat stale — probably a reused pid, or a driver wedged in a blocking call) — refusing to break it; confirm the holder is dead, then \`agentts queue repair --force\``,
          );
        }
        // Stale, or forced: break it and retry. A forced break is
        // loud — the caller (queue repair) prints it.
        if (opts.force) {
          console.error(
            `WARNING: forcibly breaking the driver lock for ${this.stateDir} (holder pid ${holder?.pid ?? "?"}, verdict ${verdict}) — only valid after confirming the holder is dead`,
          );
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* fall through to the retry */
        }
        continue;
      }
      // We own it now.
      const holder: DriverLockHolder = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: process.argv.slice(1).join(" ") || "agentts",
      };
      fs.writeFileSync(path.join(dir, "holder.json"), JSON.stringify(holder, null, 2));
      this.writeLockHeartbeat(dir);
      const timer = setInterval(() => {
        try {
          this.writeLockHeartbeat(dir);
        } catch {
          /* heartbeat is best-effort; pid liveness is the signal */
        }
      }, DRIVER_LOCK_HEARTBEAT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      return { stateDir: path.resolve(this.stateDir), heartbeatTimer: timer };
    }
    throw new HostRefusalError(`could not acquire the driver lock for ${this.stateDir} after 3 attempts`);
  }
  /** Release a lock this process holds. Only removes the lock dir
   * when the holder pid is ours — never delete another driver's lock. */
  releaseDriverLock(handle: DriverLockHandle): void {
    clearInterval(handle.heartbeatTimer);
    const dir = this.driverLockDir();
    const holder = this.readLockHolder(dir);
    if (holder?.pid === process.pid) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort: a leftover dir with a dead pid is stale and
           the next acquirer breaks it */
      }
    }
  }
  /** Repair stranded "running" queue entries (BRA-62 G2). CALLER MUST
   * HOLD the driver lock: the lock is what makes "running" mean
   * "stranded" — with no live driver, every running entry's driver
   * is provably gone, so flipping one is safe. Never flips an entry
   * while a driver might be alive. Every action is reported
   * (returned) and journaled on the run as a `queue-repaired` event
   * — except for a never-started run, whose journal startRunFrom
   * deletes when it is re-driven; the printed report is the record
   * there. "held" entries are never touched (a gate answer may be
   * pending — held is a legitimate state, not a stranded one). */
  private repairStrandedEntries(): RepairReport {
    // BRA-82: a read-modify-write — hold the enqueue lock across
    // it (inside the driver lock, which the caller holds) so a
    // concurrent submit cannot interleave and lose either the
    // repair flip or the new entry.
    return this.withQueueLock(() => {
    const q = this.readQueue();
    const actions: RepairAction[] = [];
    let changed = false;
    for (const entry of q) {
      if (entry.status !== "running") continue;
      const action = this.classifyStrandedEntry(entry);
      actions.push(action);
      if (action.to !== "left-running") {
        entry.status = action.to;
        if (action.to === "failed") entry.error = action.error ?? action.reason;
        changed = true;
      }
      this.journalEvent(entry.runId, {
        event: "queue-repaired",
        runId: entry.runId,
        from: "running",
        to: action.to,
        reason: action.reason,
      });
    }
    if (changed) this.writeQueue(q);
    return { inspected: actions.length, actions };
    });
  }
  /** Classify one stranded "running" entry by verifying its state
   * against the journal + registry + blob on disk. */
  private classifyStrandedEntry(entry: QueueEntry): RepairAction {
    const runId = entry.runId;
    const events = this.journal(runId);
    const completed = events.some((e) => e.event === "lifecycle" && e.lifecycle === "completed");
    if (completed) {
      // The C host writes the result file immediately BEFORE the
      // lifecycle "completed" event, so a completed event means the
      // run finished — the driver crashed before the queue write.
      const hasResult = fs.existsSync(this.resultPath(runId));
      return {
        runId,
        from: "running",
        to: "done",
        reason: `journal shows lifecycle completed — the run finished and the driver crashed before the queue write${hasResult ? "" : " (result file missing — \`agentts result\` will report it)"}`,
      };
    }
    const failedEv = events.find((e) => e.event === "lifecycle" && e.lifecycle === "failed");
    if (failedEv) {
      const err = typeof failedEv.error === "string" && failedEv.error.length > 0 ? failedEv.error : "run failed (see journal)";
      return { runId, from: "running", to: "failed", reason: `journal shows lifecycle failed: ${err}`, error: err };
    }
    const reg = this.registry.get(runId);
    if (reg) {
      if (reg.rc === 2 || reg.rc === 3) {
        if (fs.existsSync(this.blobPath(runId))) {
          return {
            runId,
            from: "running",
            to: "queued",
            reason: "suspended at a trap/fork with its snapshot blob on disk — re-drive resumes from the blob (the BRA-75 journal check guards re-dispatch)",
          };
        }
        return {
          runId,
          from: "running",
          to: "failed",
          reason: "suspended but the snapshot blob is missing — the run cannot be resumed (G1); marking failed rather than re-driving into a doomed resume",
          error: "snapshot blob missing; cannot resume",
        };
      }
      if (reg.rc === 0) {
        return { runId, from: "running", to: "done", reason: "registry shows the run completed" };
      }
      if (reg.rc === 1) {
        // G1 (BRA-74): the last slice ended rc 1. The lifecycle checks above already ran, so
        // there is no lifecycle "failed" event — this is a C-host crash mid-slice, not a workflow
        // failure. The last blob is the resume point.
        if (fs.existsSync(this.blobPath(runId))) {
          return {
            runId,
            from: "running",
            to: "queued",
            reason: "C-host crash mid-slice (registry shows exit 1, no lifecycle-failed event) — last snapshot blob intact, re-drive resumes from the blob (G1; the BRA-75 journal check guards re-dispatch)",
          };
        }
        return {
          runId,
          from: "running",
          to: "failed",
          reason: "C-host crash mid-slice (registry shows exit 1) but the snapshot blob is missing — the run cannot be resumed",
          error: "snapshot blob missing; cannot resume after C-host crash",
        };
      }
      return {
        runId,
        from: "running",
        to: "failed",
        reason: `registry shows the run exited ${reg.rc}`,
        error: `run exited ${reg.rc}`,
      };
    }
    // No registry entry: the run either never started, or its
    // registry record is lost. Trap activity in the journal is the
    // tell — a dispatch only happens after a registry entry is
    // saved, so trap/fork events with no registry entry mean the
    // record is gone, and re-driving would restart from scratch and
    // could double-execute the dispatched trap.
    const trapActivity = events.some((e) =>
      ["trap", "trap-dispatch", "trap-dispatched", "trap-result", "trap-error", "fork"].includes(e.event),
    );
    if (trapActivity) {
      // BRA-84: when the missing entry is missing because its file
      // was corrupt with no usable backup (not merely never
      // written), say so — the repair report is the operator-visible
      // surface for a run that would otherwise look like an
      // unexplained inconsistency. The verdict is unchanged
      // (left-running): re-driving would restart from scratch and
      // could double-execute the dispatched trap.
      const corruptEntry = this.corruptRunEntryStems.has(prefixFor(runId));
      return {
        runId,
        from: "running",
        to: "left-running",
        reason: corruptEntry
          ? "journal shows trap/fork activity but the registry entry file is corrupt and no usable backup exists (see corruption.log) — state is inconsistent (registry lost); re-driving would restart from scratch and could double-execute the dispatched trap. Left for a human to inspect."
          : "journal shows trap/fork activity but there is no registry entry — state is inconsistent (registry lost); re-driving would restart from scratch and could double-execute the dispatched trap. Left for a human to inspect.",
      };
    }
    return {
      runId,
      from: "running",
      to: "queued",
      reason: "no registry entry and no trap activity in the journal — the run never started (driver crashed before the first slice); re-drive starts it fresh",
    };
  }
  /** Repair stranded "running" entries: acquire the driver lock,
   * repair, release. Throws HostRefusalError when a live driver
   * holds the lock. `force` breaks an ambiguous (or live) lock —
   * human-only, after confirming the holder is dead. */
  repairQueue(opts: { force?: boolean } = {}): RepairReport {
    const lock = this.acquireDriverLock(opts);
    try {
      return this.repairStrandedEntries();
    } finally {
      this.releaseDriverLock(lock);
    }
  }

  /** Drive every queued run to completion (or a held gate). This is
   * THE run path — submit → runQueue → result. Priority order
   * (BRA-49): highest priority first (1 urgent … 4 low, missing =
   * 3), FIFO inside a tier. Sequential, coordinator executes
   * directly — no worker pool (BRA-48/49). Returns the entries with
   * their final statuses. A queued entry whose run is already
   * started (held at a gate, answer delivered) is RESUMED, not
   * restarted — startRun would wipe its journal and snapshot. */
  async runQueue(): Promise<QueueEntry[]> {
    const lock = this.acquireDriverLock();
    try {
      // G2 (BRA-72): with the lock held no driver is alive, so every
      // "running" entry is provably stranded — repair them before
      // driving. The report is stashed for the CLI to print; a repair
      // is never silent.
      this.lastRepairReport = this.repairStrandedEntries();
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
        // BRA-82: the status flip re-reads the queue under the
        // enqueue lock (updateQueueEntry) instead of writing back
        // this drive's snapshot — a submit landing mid-drive
        // would otherwise be clobbered by the next write of the
        // stale snapshot. Entries enqueued after the snapshot
        // above are simply not driven this pass; they stay queued
        // for the next drive.
        this.updateQueueEntry(entry.runId, (e) => {
          e.status = "running";
        });
        // Fresh heartbeat before a drive that may block the event
        // loop for minutes (a long exec/sleep trap stalls the
        // interval refresh above).
        this.refreshLockHeartbeat();
        // The adapter is a property of the RUN (chosen at submit and
        // recorded on the queue entry), not of the driving process: a
        // `queue run` in a fresh process must drive the run with the
        // adapter it was submitted with, not the Host's default. Swap
        // it in for this entry only (runQueue drives entries one at a
        // time, so the swap is safe) and restore it afterwards.
        const prevAdapter = this.adapter;
        try {
          this.adapter = await this.adapterForEntry(entry);
          let rc: number;
          const suspended = this.registry.get(entry.runId);
          if (suspended && (suspended.rc === 2 || suspended.rc === 3)) {
            // Already started (held): resume it from its snapshot.
            // G10 (BRA-71): refuse loudly FIRST when the engine
            // changed under the run — a snapshot is same-engine-only.
            this.assertEngineVersion(entry.runId, suspended, entry);
            this.ensureExtraction(entry.runId);
            rc = this.driveToCompletion(entry.runId);
          } else if (suspended && suspended.rc === 1) {
            // G1 (BRA-74): the last slice ended rc 1. The journal says whether it was a genuine
            // workflow failure (lifecycle "failed" — fail it with that reason) or a C-host crash
            // (no lifecycle event — resume from the last intact blob instead of restarting from
            // scratch, which would wipe the journal and could double-execute the dispatched trap).
            // resumeFromCrash throws loudly when the run cannot be resumed.
            const outcome = this.classifySliceCrash(entry.runId);
            if (outcome === "completed") {
              rc = 0;
            } else if (outcome === "failed") {
              rc = 1;
            } else if (this.resumeFromCrash(entry.runId)) {
              this.ensureExtraction(entry.runId);
              rc = this.driveToCompletion(entry.runId);
            } else {
              throw new Error(
                `C host crashed mid-slice on ${entry.runId} and the run cannot be resumed (no intact snapshot blob or no suspension point in the journal) — see the host-crash journal event; restore the blob or start a fresh run`,
              );
            }
          } else {
            rc = await this.startRun(entry.workflowPath, entry.runId, entry.input);
            // The frozen hash + engine version that started this run
            // (BRA-71): the forensics record of which source and
            // which engine build the run executes under. The
            // trap-code pin (BRA-89) joins them: which trap code
            // the run's answers are pinned to.
            const fz = this.frozenCopies.get(entry.runId);
            const tp = this.trapPins.get(entry.runId);
            this.journalEvent(entry.runId, {
              event: "queue-started",
              runId: entry.runId,
              ...(fz ? { frozenHash: fz.hash } : {}),
              ...(tp ? { trapPin: tp.files } : {}),
              engineVersion: this.engineVersion(),
            });
            rc = this.driveToCompletion(entry.runId);
          }
          if (this.pendingGate.has(entry.runId)) {
            entry.status = "held";
          } else if (rc === 0) {
            entry.status = "done";
          } else {
            entry.status = "failed";
            // Prefer the recorded failure reason: the C host writes the
            // exception's "Name: message" on the failed lifecycle
            // event. Fall back to the exit code when there is none.
            const failed = this.journal(entry.runId).find(
              (e) => e.event === "lifecycle" && e.lifecycle === "failed",
            );
            entry.error =
              failed && typeof failed.error === "string" && failed.error.length > 0
                ? failed.error
                : `run exited ${rc}`;
          }
        } catch (e) {
          entry.status = "failed";
          entry.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.adapter = prevAdapter;
        }
        // BRA-82: same fresh-read status write as the "running"
        // flip above — the entry's final status/error are copied
        // onto the current queue, never written back over a
        // snapshot that predates a concurrent submit.
        const finalStatus = entry.status;
        const finalError = entry.error;
        this.updateQueueEntry(entry.runId, (e) => {
          e.status = finalStatus;
          if (finalError !== undefined) e.error = finalError;
        });
        // The state above is durable (queue.json written) before the
        // event fires: a tick agent woken by it reads the new status.
        if (entry.status === "done") {
          this.notifyEvent("workflow-completed", { runId: entry.runId });
        } else if (entry.status === "failed") {
          this.notifyEvent("workflow-failed", { runId: entry.runId, detail: { error: entry.error ?? null } });
        } else if (entry.status === "held") {
          this.notifyEvent("gate-held", { runId: entry.runId });
        }
      }
      // BRA-82: return the current queue, not this drive's
      // snapshot — a concurrent submit's entry is in it.
      return this.readQueue();
    } finally {
      this.releaseDriverLock(lock);
    }
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
  /** The adapter a queued entry was submitted with. When it matches
   * the Host's own adapter, use that one (it may carry canned answers
   * or a workers config); otherwise load a fresh one by name through
   * the plugin seam (Host.loadAdapter — every name, mock/direct/muse
   * alike; BRA-68 removed the mock short-circuit here too). */
  private async adapterForEntry(entry: QueueEntry): Promise<Adapter> {
    const name = entry.adapter ?? this.adapter.name;
    if (name === this.adapter.name) return this.adapter;
    const adapter = await Host.loadAdapter(name);
    // A fresh adapter gets the same journal wiring as the Host's
    // own (BRA-61) — otherwise a run driven with a fresh muse
    // adapter would lose its mid-flight pool events.
    this.wireJobEvents(adapter);
    return adapter;
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
   * so the answer cannot live in the adapter. Persisted to disk
   * (runs/<run>.gate-answers.json) — a delivered answer must survive
   * the delivering process, since the run is driven later by
   * `queue run`, possibly in another process. One store, not two:
   * there is no in-memory copy. */
  private gateAnswersPath(runId: string): string {
    return path.join(this.stateDir, "runs", `${prefixFor(runId)}.gate-answers.json`);
  }
  private readGateAnswers(runId: string): unknown[] {
    const p = this.gateAnswersPath(runId);
    if (!fs.existsSync(p)) return [];
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  private writeGateAnswers(runId: string, answers: unknown[]): void {
    fs.mkdirSync(path.join(this.stateDir, "runs"), { recursive: true });
    fs.writeFileSync(this.gateAnswersPath(runId), JSON.stringify(answers));
  }
  queueGateAnswer(runId: string, answer: unknown): void {
    const list = this.readGateAnswers(runId);
    list.push(answer);
    this.writeGateAnswers(runId, list);
  }
  /** Take (and consume) the next queued gate answer for a run.
   * Returns { found: false } when none is queued (a queued answer
   * is a JSON value, so it is never undefined — the flag, not the
   * value, decides). */
  private takeGateAnswer(runId: string): { found: boolean; value?: unknown } {
    const list = this.readGateAnswers(runId);
    if (!list.length) return { found: false };
    const value = list.shift();
    this.writeGateAnswers(runId, list);
    return { found: true, value };
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
  /** Parse one journal file's lines tolerantly (BRA-77 G15): a line
   * is a journal event only when it parses to a plain object with a
   * string `event` field. Anything else — garbage, truncated JSON,
   * a JSON value that is not an event (a number, null, an object
   * without `event`) — is quarantined: skipped from the returned
   * list and recorded via recordCorruption. The file itself is left
   * untouched (the bad line stays for forensics; each load
   * re-quarantines it idempotently) — rewriting it in the
   * constructor could race a live driver appending to the same
   * file. Returns the good events, in file order. */
  private parseJournalLines(file: string, runId: string): any[] {
    const events: any[] = [];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        this.recordCorruption({
          kind: "journal-line",
          file: path.basename(file),
          lineNo: i + 1,
          runId,
          reason: `unparseable JSON (${e instanceof Error ? e.message : String(e)})`,
          excerpt: line.slice(0, 120),
          at: new Date().toISOString(),
        });
        continue;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).event !== "string"
      ) {
        this.recordCorruption({
          kind: "journal-line",
          file: path.basename(file),
          lineNo: i + 1,
          runId,
          reason: "parsed JSON is not a journal event (not a plain object with a string `event` field)",
          excerpt: line.slice(0, 120),
          at: new Date().toISOString(),
        });
        continue;
      }
      events.push(parsed);
    }
    return events;
  }
  /** Reload every journal file from disk into the in-memory lists
   * (constructor: a new Host over the same stateDir sees prior runs).
   * Corrupt lines are quarantined, never fatal (BRA-77 G15): one bad
   * line used to throw here and brick the whole Host — which also
   * made the BRA-72 queue repair un-runnable on that state dir. The
   * Host now starts with the good lines intact and reports the
   * corruption (see `corruption`, corruption.log, and the console
   * warning below). */
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
      const before = this.corruption.length;
      const events = this.parseJournalLines(path.join(dir, f), runId);
      if (events.length) this.journals.set(runId, events);
      const quarantined = this.corruption.length - before;
      if (quarantined) {
        console.warn(
          `CORRUPT JOURNAL: ${quarantined} corrupt line(s) quarantined in ${f} (run ${runId}) — good lines kept, see ${this.corruptionLogPath()}`,
        );
      }
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
  /** Previous good run entry (BRA-84): saveRunEntry mirrors the
   * entry here, atomically, BEFORE writing the entry file itself —
   * so a torn or externally corrupted runs/<run>.json can be
   * recovered on load.
   *
   * Why a mirror, not the BRA-77 queue pattern (back up the previous
   * good file before overwriting)? A suspended run's entry is
   * typically saved exactly once before the strand (startRunFrom
   * saves it, then the drive is killed mid-dispatch) — there IS no
   * previous good file to back up, so the queue pattern would leave
   * the common case with no backup at all. Mirroring the new content
   * first closes that hole: a kill at any point leaves each file old
   * or new (atomicWriteFile is tmp+rename), never torn, and the
   * backup is never older than the entry.
   *
   * The mirror does NOT protect against a bad in-memory entry (it
   * copies it) — but the threat model is a torn/corrupt file on
   * disk, and JSON.stringify of the registry entry cannot produce
   * one. The one-save staleness a kill between the two writes can
   * leave (entry older than the backup) is harmless: the entry is
   * only the pointer — the journal + blob are the resume truth, and
   * rc 1/2/3 all repair to "queued" when the blob is intact, while
   * resumeFromCrash derives the suspension point from the journal,
   * not from entry.rc. */
  private runEntryBackupPath(runId: string): string {
    return `${this.runEntryPath(runId)}.bak`;
  }
  /** Parse a run-entry file: the parsed value must be a plain object
   * with a non-empty string runId and an rc of 1, 2, or 3 — the same
   * load rule loadRunEntriesFromDisk has always applied (rc 0
   * entries are never persisted: a completed run's registry entry is
   * deleted, see saveRunEntry). Returns null on any failure
   * (missing file, unparseable JSON, wrong shape) with the reason.
   * A file that parses but fails validation is corrupt for recovery
   * purposes too — a torn write can leave behind valid JSON of the
   * wrong shape, and silently accepting it would resume the wrong
   * run state. */
  private parseRunEntryFile(p: string): { entry: RunEntry | null; reason: string | null } {
    if (!fs.existsSync(p)) return { entry: null, reason: "missing" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return { entry: null, reason: `unparseable JSON (${e instanceof Error ? e.message : String(e)})` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { entry: null, reason: "parsed value is not a run entry object" };
    }
    const e = parsed as RunEntry;
    if (typeof e.runId !== "string" || !e.runId) {
      return { entry: null, reason: "parsed value has no runId" };
    }
    if (e.rc !== 1 && e.rc !== 2 && e.rc !== 3) {
      return { entry: null, reason: `run entry has rc ${String(e.rc)} (only rc 1/2/3 are resumable)` };
    }
    return { entry: e, reason: null };
  }
  /** Persist a run entry (registry) to disk after every mutation, so
   * a new process over the same stateDir can resume the run. */
  saveRunEntry(runId: string): void {
    const e = this.registry.get(runId);
    if (!e) {
      const p = this.runEntryPath(runId);
      if (fs.existsSync(p)) fs.rmSync(p);
      // A stale backup must not survive the run: a later run reusing
      // this runId must never recover the finished run's entry.
      const b = this.runEntryBackupPath(runId);
      if (fs.existsSync(b)) fs.rmSync(b);
      return;
    }
    fs.mkdirSync(path.join(this.stateDir, "runs"), { recursive: true });
    // BRA-85: persist frozenPath state-dir-relative (see
    // frozenRelPath) — the in-memory entry keeps the resolved
    // absolute path; only the stored form is relative. workflowPath
    // stays as-is (it can be a live author path outside the state
    // dir; its frozen case is re-rooted at load).
    const stored = e.frozenPath ? { ...e, frozenPath: this.frozenRelPath(e.frozenPath) } : e;
    const content = JSON.stringify(stored, null, 2);
    // BRA-84: mirror first, then the entry — both atomic
    // (tmp+rename). A kill mid-save leaves each file old or new,
    // never torn; a torn entry file is always recoverable from the
    // mirror. See runEntryBackupPath for why this mirrors the new
    // content instead of backing up the previous file.
    atomicWriteFile(this.runEntryBackupPath(runId), content);
    atomicWriteFile(this.runEntryPath(runId), content);
  }
  /** Register one loaded run entry (shared by the clean-load and
   * backup-recovery paths): the registry entry, the log offset so a
   * new process does not re-journal old slices, and the journal
   * re-key under the exact run id. */
  private registerLoadedRunEntry(e: RunEntry): void {
    // BRA-85: rebase stored paths against the current state dir
    // before anything reads them (snap/out/log offsets below use
    // the rebased e.log). Covers the clean-load and backup-recovery
    // paths alike — both funnel through here.
    e = this.rebaseRunEntry(e);
    // G1 (BRA-74): a persisted rc 1 entry is a live, resumable run, not a dead one — the last
    // slice ended rc 1, and the journal decides whether it was a genuine workflow failure
    // (lifecycle "failed", classified downstream by classifyStrandedEntry / runQueue) or a
    // C-host crash (no lifecycle event, resumable from the blob via resumeFromCrash). Before
    // this fix only rc 2/3 entries were reloaded, so a crash-recorded run was invisible to
    // repair and came back "left-running" (registry lost) instead of resuming.
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
        // Same tolerant parse as loadJournalsFromDisk (BRA-77
        // G15): the old lines.map(JSON.parse) threw on a bad
        // line, and the catch below then dropped the whole
        // registry entry for the run — a corrupt journal line
        // silently made a suspended run invisible to repair.
        const good = this.parseJournalLines(jf, e.runId);
        if (good.length) this.journals.set(e.runId, good);
      }
    }
  }
  private loadRunEntriesFromDisk(): void {
    const dir = path.join(this.stateDir, "runs");
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      // Gate answers live in the same directory
      // (runs/<run>.gate-answers.json) and are not run entries —
      // the old loader skipped them implicitly via the runId/rc
      // validation; skip them explicitly so a valid gate-answers
      // file is never reported as a corrupt run entry.
      if (f.endsWith(".gate-answers.json")) continue;
      const p = path.join(dir, f);
      const { entry, reason } = this.parseRunEntryFile(p);
      if (entry) {
        this.registerLoadedRunEntry(entry);
        continue;
      }
      // Corrupt run entry (BRA-84): recover from the backup when it
      // parses and validates, and say so loudly — the recovery is
      // reported (console + corruption.log + runEntryRecoveries),
      // never silent. A recovered entry resumes through the normal
      // BRA-74 path: it is registered exactly as if it had loaded
      // clean, so queue repair re-queues it from its intact blob
      // instead of leaving it left-running.
      const stem = f.slice(0, -".json".length);
      const backupPath = `${p}.bak`;
      const backup = this.parseRunEntryFile(backupPath);
      if (backup.entry) {
        // Restore the recovered entry atomically, from the backup's
        // raw bytes. saveRunEntry would do the same, but the
        // in-memory registry is not the source here — the backup
        // file is.
        atomicWriteFile(p, fs.readFileSync(backupPath, "utf8"));
        this.registerLoadedRunEntry(backup.entry);
        const at = new Date().toISOString();
        this.runEntryRecoveries.push({ runId: backup.entry.runId, at });
        this.recordCorruption({
          kind: "run-entry-recovered",
          file: f,
          lineNo: 0,
          runId: backup.entry.runId,
          reason: `runs/${f} is corrupt (${reason}) — recovered run ${backup.entry.runId} (rc ${backup.entry.rc}) from runs/${f}.bak`,
          excerpt: reason ?? "corrupt",
          at,
        });
        console.warn(
          `CORRUPT RUN ENTRY: runs/${f} is corrupt (${reason}) — recovered run ${backup.entry.runId} (rc ${backup.entry.rc}) from runs/${f}.bak; see ${this.corruptionLogPath()}`,
        );
        continue;
      }
      // No usable backup: the entry is dropped from the registry —
      // but LOUDLY, never silently. The Host still starts: one bad
      // run entry must not brick the whole state dir (unlike
      // queue.json, which is the whole queue — a corrupt queue with
      // no backup throws CorruptQueueError instead). The run is not
      // lost without a trace: the corruption is in the `corruption`
      // report, in corruption.log, and on stderr, and the stem is
      // remembered so queue repair can name the cause when it
      // classifies the run left-running (trap activity + no registry
      // entry). Re-driving here would restart from scratch and could
      // double-execute the dispatched trap — that caution is why the
      // entry is dropped rather than guessed at, and why repair
      // leaves the run for a human instead of re-queueing it.
      this.corruptRunEntryStems.add(stem);
      const at = new Date().toISOString();
      this.recordCorruption({
        kind: "run-entry-corrupt",
        file: f,
        lineNo: 0,
        runId: stem.replace(/_/g, "/"),
        reason: `runs/${f} is corrupt (${reason}) and runs/${f}.bak is ${backup.reason === "missing" ? "missing" : `also corrupt (${backup.reason})`} — entry dropped; the run cannot be resumed without its registry entry`,
        excerpt: reason ?? "corrupt",
        at,
      });
      console.warn(
        `CORRUPT RUN ENTRY: runs/${f} is corrupt (${reason}) and runs/${f}.bak is ${backup.reason === "missing" ? "missing" : `also corrupt (${backup.reason})`} — entry dropped (no usable backup); the run is left for queue repair to classify (left-running when its journal shows trap activity). See ${this.corruptionLogPath()}`,
      );
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
    // G4 (BRA-76): atomic store — copy to a pid-suffixed tmp file in
    // the same directory, sha-verify it against the source, then
    // rename into place (the same tmp+rename pattern as
    // atomicWriteFile). A crash mid-copy leaves the previous blob
    // intact — old or new, never torn — and a stray tmp file is
    // never read. The pre-rename check catches a bad copy before it
    // becomes the live blob; the post-rename check is the existing
    // store guarantee. The C host's own live-snap write
    // (save_snapshot in durablets.c) is atomic the same way since
    // BRA-83 (tmp + fsync + rename in write_file_atomic), so the
    // live snap this copies is never torn either; the live snap is
    // transient and re-created from this blob on resume, so a torn
    // live snap fails the slice loudly and the BRA-74 path resumes
    // from the intact blob.
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(snap, tmp);
    if (shaFile(tmp) !== shaFile(snap)) throw new Error(`blob store mismatch for ${runId}`);
    fs.renameSync(tmp, dest);
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

  /**
   * BRA-73: enrich a lifecycle-started event with the run-start
   * fields the profiler needs, from host-side records (the C core
   * knows none of these — it only emits the bare lifecycle event):
   *   - workflowHash: the extraction sourceHash for this run
   *     (reused from the extraction the host already computed —
   *     never a second hash of the source).
   *   - workflowPath: the submitted (live author) path from the
   *     queue entry; a run with no queue entry falls back to the
   *     registry/frozen path.
   *   - submittedAt: the queue entry's enqueuedAt (the submit→start
   *     wait is started.wallTs − submittedAt).
   *   - bundlePath / bundleMapPath: the pinned bundle + source map
   *     the trap sites' coordinates refer to (see pinBundle).
   * Fields with no source are omitted, never invented. Called from
   * ingestLog inside a try/catch — enrichment must never fail the
   * journal write.
   */
  private enrichRunStart(runId: string, ev: any): void {
    const extraction = this.extractions.get(runId);
    if (extraction) ev.workflowHash = extraction.sourceHash;
    const q = this.readQueue().find((e) => e.runId === runId);
    const wp =
      q?.workflowPath ?? this.registry.get(runId)?.workflowPath ?? this.workflowPaths.get(runId);
    if (wp) ev.workflowPath = wp;
    if (q?.enqueuedAt) ev.submittedAt = q.enqueuedAt;
    const pin = this.bundlePins.get(runId);
    if (pin) {
      ev.bundlePath = pin.bundlePath;
      if (pin.bundleMapPath) ev.bundleMapPath = pin.bundleMapPath;
    }
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
      // BRA-73: promote the wrapper-captured call site to the trap
      // event's top-level `site` and strip the transport key from
      // the journaled arg, so the journaled arg stays exactly the
      // spec the author passed. A trap with no site (a direct
      // trap() caller, or an unparseable stack) simply carries none
      // — the profiler treats a missing site as unknown, never
      // invented. And enrich a run's lifecycle-started event with
      // the run-start fields the profiler needs (workflowHash is
      // the extraction sourceHash — reused, never recomputed;
      // submittedAt is the queue entry's enqueuedAt). Fields whose
      // source is unavailable (a stepwise run with no queue entry
      // has no submittedAt; a branch run has no extraction of its
      // own) are omitted, not invented. Enrichment is best-effort:
      // it must never fail ingesting the journal, so any failure
      // here leaves the event as the core emitted it.
      if (ev.event === "trap" && typeof ev.trapId === "string") {
        const { arg, site } = splitTrapSite(ev.arg);
        if (site) ev.site = site;
        ev.arg = arg;
      }
      if (ev.event === "lifecycle" && ev.lifecycle === "started") {
        try {
          this.enrichRunStart(runId, ev);
        } catch {
          /* enrichment is best-effort — the event journals as emitted */
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
    this.lastHostSignal = r.signal ?? null;
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
   * same stateDir resumes a run it did not start. Resolves the
   * FROZEN copy first (BRA-71 G9): extraction reads the frozen
   * source, so the cache hits on the submitted version and the gate
   * never re-runs — an edit of the live file cannot change what
   * the resumed run validates against. Falls back to the live path
   * only for legacy runs with no frozen copy recorded. */
  ensureExtraction(runId: string): void {
    if (this.extractions.has(runId)) return;
    const frozen = this.frozenFor(runId);
    if (frozen) {
      this.prepareRun(frozen.entryPath, runId);
      return;
    }
    // A completed run has no registry entry (the registry only holds
    // in-flight runs), and a fresh process has no in-memory
    // workflowPaths — but the queue entry (queue.json, on disk)
    // records the workflow path, so a `result` in a new process can
    // still restore the extraction from cache.
    const wp =
      this.workflowPaths.get(runId) ??
      this.registry.get(runId)?.workflowPath ??
      this.readQueue().find((e) => e.runId === runId)?.workflowPath;
    if (!wp) {
      throw new Error(
        `cannot resume ${runId}: no workflow path recorded, so the extraction cannot be restored from cache`,
      );
    }
    this.prepareRun(wp, runId);
  }

  prepareRun(workflowPath: string, runId: string): { extraction: Extraction } {
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
    return { extraction };
  }

  /** Validate a workflow's input against its entry contract (the
   * workflow boundary is a trap boundary too: JSON-clean first, then
   * schema — the same order as the trap boundary) and store the
   * validated input for the driver. A workflow whose entry takes no
   * parameter refuses an input; one that takes a parameter refuses
   * to start without one. */
  private validateAndStoreInput(runId: string, input: unknown): void {
    const extraction = this.extractions.get(runId);
    if (!extraction) throw new Error(`no extraction for ${runId} — call prepareRun first`);
    const entry = extraction.entry;
    if (!entry.inputType) {
      if (input !== undefined) {
        throw new HostRefusalError(
          `workflow ${entry.name} takes no input but an input was provided — remove --input-file`,
        );
      }
      this.inputs.delete(runId);
      return;
    }
    if (input === undefined) {
      throw new HostRefusalError(
        `workflow ${entry.name} requires an input (${entry.inputType}) — pass --input-file <json>`,
      );
    }
    let clean: unknown;
    try {
      clean = toJsonValue(input, "input");
    } catch (e) {
      if (e instanceof JsonBoundaryError) {
        throw new HostRefusalError(`input is not JSON-clean: ${e.message}`);
      }
      throw e;
    }
    const issues = this.validator.validate(clean, entry.inputSchema);
    if (issues.length) {
      throw new HostRefusalError(
        `input does not match ${entry.inputType}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    }
    this.inputs.set(runId, clean);
  }

  /** Generate the host driver for a run: global code that arms the
   * entry guard (__agentts_begin) and calls the exported entry
   * function with the validated input JSON. The entry function MUST
   * stay a plain sync function called from global code (module
   * frames cannot suspend; the core evals a global script) — the
   * driver is that global code, not author code. Written to
   * runs/<runId>.driver.ts; the caller bundles it. For a 0-arg
   * entry the driver calls it with no arguments. */
  driverFor(runId: string): string {
    const wp = this.workflowPaths.get(runId);
    const extraction = this.extractions.get(runId);
    if (!wp || !extraction) {
      throw new Error(`no prepared run ${runId} — call prepareRun first`);
    }
    const hasInput = extraction.entry.inputType !== null;
    const inputJson = hasInput ? JSON.stringify(this.inputs.get(runId)) : "";
    const driverPath = path.join(this.stateDir, "runs", `${prefixFor(runId)}.driver.ts`);
    fs.mkdirSync(path.dirname(driverPath), { recursive: true });
    const driver =
      `// Host-generated driver for ${runId} (not author code): arm the\n` +
      `// entry guard, then call the workflow's exported entry function\n` +
      `// from global code with the validated input JSON.\n` +
      `import entry from ${JSON.stringify(wp)};\n` +
      `declare function __agentts_begin(): void;\n` +
      `__agentts_begin();\n` +
      (hasInput ? `entry(${inputJson});\n` : `entry();\n`);
    fs.writeFileSync(driverPath, driver);
    return driverPath;
  }

  /** Submit a workflow + input: gate + extract + validate the input,
   * then enqueue. Returns the runId immediately; the run proceeds
   * when `queue run` drives it (or `run --wait` drives it inline).
   * This is the ONLY way to start a run — there is no in-process
   * drive mode. */
  submit(
    workflowPath: string,
    opts: {
      runId?: string;
      input?: unknown;
      adapter?: string;
      taskId?: string;
      priority?: number;
    } = {},
  ): { runId: string } {
    const runId = opts.runId ?? `run-${path.basename(workflowPath, ".ts")}-${Date.now()}`;
    // BRA-71 G9: freeze the workflow closure FIRST, then prepare
    // (extract + gate) and drive from the frozen copy — the run
    // executes and validates against the submitted source even if
    // the author edits the file afterwards. The queue entry keeps
    // the live path for display; frozenPath is the execution path.
    const frozen = this.freezeWorkflow(workflowPath);
    this.frozenCopies.set(runId, frozen);
    this.prepareRun(frozen.entryPath, runId);
    this.validateAndStoreInput(runId, opts.input);
    // BRA-89: pin the trap code AFTER extraction (the pin needs the
    // extracted job specs) and BEFORE enqueue — the queue entry
    // carries the pin, so a fresh process resuming the run finds
    // it without the submitting process.
    const trapPin = this.computeTrapPin(runId, this.adapter);
    this.trapPins.set(runId, trapPin);
    this.enqueue(workflowPath, runId, {
      adapter: opts.adapter,
      taskId: opts.taskId,
      priority: opts.priority,
      input: this.inputs.get(runId),
      frozenHash: frozen.hash,
      frozenPath: frozen.entryPath,
      engineVersion: this.engineVersion(),
      trapPin,
    });
    // A submitted run is pending work — wake the tick agent so it
    // drives the queue instead of waiting out its tick timeout.
    this.notifyEvent("run-submitted", { runId, detail: { workflowPath: path.resolve(workflowPath) } });
    return { runId };
  }

  /** The run's result file (<run>.result.json in slices/, written
   * by the C host when a top-level run completes). */
  resultPath(runId: string): string {
    return path.join(this.workdir, `${prefixFor(runId)}.result.json`);
  }

  /** Fetch a run's result by runId: the validated output JSON once
   * it is done, or the current status otherwise. The output is
   * validated against the extracted Output schema before it is
   * returned — a result that does not match the entry's declared
   * output is a failure, not a result. */
  result(runId: string): RunResult {
    const queued = this.readQueue().find((e) => e.runId === runId);
    if (queued) {
      if (queued.status === "done") {
        return this.readResultFile(runId, "done");
      }
      if (queued.status === "failed") {
        return { runId, status: "failed", error: queued.error ?? `run ${runId} failed` };
      }
      return { runId, status: queued.status === "held" ? "held" : queued.status === "running" ? "running" : "pending" };
    }
    // Not a queued run (stepwise/cancel tests): derive from the run
    // entry + finished map + journal.
    const finishedRc = this.finished.get(runId);
    if (finishedRc === 0) return this.readResultFile(runId, "done");
    if (finishedRc !== undefined) return { runId, status: "failed", error: `run ${runId} exited ${finishedRc}` };
    const entry = this.registry.get(runId);
    if (entry) {
      if (entry.rc === 2 && this.isGateSuspended(runId)) return { runId, status: "held" };
      return { runId, status: "running" };
    }
    const events = this.journal(runId);
    if (!events.length) return { runId, status: "pending", error: `no run ${runId}` };
    const done = events.some((e) => e.event === "lifecycle" && e.lifecycle === "completed");
    if (done) return this.readResultFile(runId, "done");
    return { runId, status: "running" };
  }

  private readResultFile(runId: string, status: "done"): RunResult {
    const p = this.resultPath(runId);
    if (!fs.existsSync(p)) {
      return { runId, status, error: `run ${runId} completed but the result file is missing (${p}) — the C host did not write it` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return { runId, status, error: `run ${runId} result file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    this.ensureExtraction(runId);
    const extraction = this.extractions.get(runId)!;
    const issues = this.validator.validate(parsed, extraction.entry.outputSchema);
    if (issues.length) {
      return {
        runId,
        status,
        error: `result does not match ${extraction.entry.outputType}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      };
    }
    return { runId, status, output: parsed };
  }

  // ------------------------------------------------------- delivery outbox (BRA-65)
  /** The delivery outbox: <stateDir>/deliveries/<runId>.json + the
   * append-only deliveries.log. The tick agent writes a record here
   * when a run reaches a terminal state; the coordinator reads the
   * outbox. This is the delivery path — results used to sit in a
   * file until someone ran `result <runId>`. */
  deliveriesDir(): string {
    return path.join(this.stateDir, "deliveries");
  }
  private deliveryPath(runId: string): string {
    return path.join(this.deliveriesDir(), `${prefixFor(runId)}.json`);
  }
  /** Every delivery record, oldest first (best-effort parse: a
   * corrupt record is skipped, never fatal). */
  listDeliveries(): DeliveryRecord[] {
    const dir = this.deliveriesDir();
    if (!fs.existsSync(dir)) return [];
    const out: DeliveryRecord[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as DeliveryRecord;
        if (rec && typeof rec.runId === "string") out.push(rec);
      } catch {
        /* a corrupt delivery record is skipped, never fatal */
      }
    }
    return out.sort((a, b) => (a.deliveredAt < b.deliveredAt ? -1 : 1));
  }
  deliveryFor(runId: string): DeliveryRecord | null {
    const p = this.deliveryPath(runId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as DeliveryRecord;
    } catch {
      return null;
    }
  }
  /**
   * Record a run's delivery: fetch its (validated) result and write
   * the outbox record, atomically, plus one line in deliveries.log.
   * A done run delivers its output; a failed run delivers its error
   * with needsAttention: true (that IS the escalation for a terminal
   * failure). A run that is not terminal yet is a loud error — there
   * is nothing to deliver. Idempotent: re-delivering the same run
   * overwrites the same record (same runId, same output).
   */
  recordDelivery(runId: string, deliveredBy = "tick-agent"): DeliveryRecord {
    const res = this.result(runId);
    const workflowPath =
      this.readQueue().find((e) => e.runId === runId)?.workflowPath ??
      this.registry.get(runId)?.workflowPath ??
      "";
    let record: DeliveryRecord;
    if (res.status === "done") {
      record = {
        runId,
        workflowPath,
        status: "done",
        output: res.output,
        needsAttention: false,
        deliveredAt: new Date().toISOString(),
        deliveredBy,
      };
    } else if (res.status === "failed") {
      record = {
        runId,
        workflowPath,
        status: "failed",
        error: res.error ?? `run ${runId} failed`,
        needsAttention: true,
        deliveredAt: new Date().toISOString(),
        deliveredBy,
      };
    } else {
      throw new Error(`run ${runId} is ${res.status} — nothing to deliver yet`);
    }
    const dir = this.deliveriesDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = this.deliveryPath(runId);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, p);
    fs.appendFileSync(path.join(dir, "deliveries.log"), JSON.stringify(record) + "\n");
    return record;
  }

  // ------------------------------------------------------- escalations (BRA-65)
  escalationsDir(): string {
    return path.join(this.stateDir, "escalations");
  }
  listEscalations(): EscalationRecord[] {
    const dir = this.escalationsDir();
    if (!fs.existsSync(dir)) return [];
    const out: EscalationRecord[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EscalationRecord;
        if (rec && typeof rec.kind === "string" && typeof rec.reason === "string") out.push(rec);
      } catch {
        /* a corrupt escalation is skipped, never fatal */
      }
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : 1));
  }
  /**
   * Write an escalation record (something stuck that needs the
   * coordinator's judgment). The tick agent is the writer; the
   * watchdog surfaces these. Returns the path written.
   */
  writeEscalation(
    rec: Omit<EscalationRecord, "at" | "escalatedBy">,
    escalatedBy = "tick-agent",
  ): string {
    if (!rec.kind || typeof rec.reason !== "string" || !rec.reason) {
      throw new Error("escalation requires a kind and a non-empty reason");
    }
    const record: EscalationRecord = {
      ...rec,
      at: new Date().toISOString(),
      escalatedBy,
    };
    const dir = this.escalationsDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${rec.kind}-${rec.runId ? prefixFor(rec.runId) : "anon"}-${Date.now()}.json`;
    const p = path.join(dir, name);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, p);
    fs.appendFileSync(path.join(dir, "escalations.log"), JSON.stringify(record) + "\n");
    return p;
  }

  /** Bundle a driver + the workflow + the agentts module into one
   * self-contained script with Bun.build; the C host never resolves
   * imports. Refuses loudly when the bundle still contains export
   * or import syntax after the build — a bundle the C host would
   * eval as a module (which cannot suspend) is a broken run, not a
   * run to ship. */
  async bundle(entryPath: string, outName: string): Promise<string> {
    const outPath = path.join(this.workdir, outName);
    const result = await Bun.build({
      entrypoints: [entryPath],
      outdir: this.workdir,
      target: "bun",
      naming: outName,
      // BRA-73: emit the source map — trap sites are bundle
      // coordinates, and the map (which embeds the sources) is what
      // translates them back to the workflow source. The map is
      // pinned with the run next to the bundle (see pinBundle).
      sourcemap: "external",
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
    // A re-run starts a fresh journal (the old file is the previous
    // run's record, not this one's).
    if (fs.existsSync(this.journalPath(runId))) fs.rmSync(this.journalPath(runId));
    const env = { AGENTTS_RUN_ID: runId };
    // G1 (BRA-74): a first slice has no blob yet (storeBlob only runs on suspension), so a
    // C-host crash here is retried as a fresh run — no trap was dispatched, the journal was just
    // wiped, and the re-run is idempotent. Bounded: 3 attempts, then the crash fails loudly.
    // A genuine workflow failure (lifecycle "failed" in the journal) or a completion is never
    // retried — see classifySliceCrash.
    let rc = -1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      rc = this.runHost(
        ["run", entryPath, path.join(this.workdir, p + ".snap")],
        path.join(this.workdir, p + ".out"),
        path.join(this.workdir, p + ".log"),
        env,
      );
      if (rc === 0 || rc === 2 || rc === 3) break;
      const outcome = this.classifySliceCrash(runId);
      if (outcome === "completed") {
        rc = 0;
        break;
      }
      if (outcome === "failed") {
        rc = 1;
        break;
      }
      this.journalEvent(runId, {
        event: "host-crash",
        runId,
        slice: "run",
        rc,
        ...(this.lastHostSignal ? { signal: this.lastHostSignal } : {}),
        attempt,
        reason: "C-host first slice ended with no lifecycle event — retrying the run from scratch (no trap dispatched yet)",
      });
      if (attempt === 3) {
        throw new Error(
          `C host crashed starting ${runId} 3 times — the first slice fails deterministically, not transiently; see the host-crash journal events`,
        );
      }
    }
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
      // BRA-71: pin the frozen copy + engine version with the run, so
      // a fresh process resuming it finds both without the queue.
      ...(this.frozenCopies.has(runId)
        ? { frozenHash: this.frozenCopies.get(runId)!.hash, frozenPath: this.frozenCopies.get(runId)!.entryPath }
        : {}),
      // BRA-89: pin the trap code with the run, same way — a fresh
      // process resuming it finds the pin without the queue.
      ...(this.trapPins.has(runId) ? { trapPin: this.trapPins.get(runId)! } : {}),
      engineVersion: this.engineVersion(),
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

  /** Start a workflow: gate + extract + validate the input, generate
   * the driver, bundle it, then spawn the C host. The run suspends
   * at its first trap/combinator (exit 2/3) or completes (exit 0).
   * Stepwise engine control for runQueue and for the cancellation
   * tests (which need a suspended run to cancel) — NOT a run path.
   * The run path is submit → runQueue → result; this never drives a
   * run to completion on its own. */
  async startRun(workflowPath: string, runId: string, input?: unknown): Promise<number> {
    // BRA-71 G9: drive from the frozen copy — prefer the one already
    // recorded for this run (submit froze it; the admit path enqueued
    // without submitting, so the queue entry carries it), else freeze
    // now (direct startRun callers, e.g. stepwise tests). A re-drive
    // after registry loss executes the submitted source, never the
    // live file.
    const frozen = this.frozenFor(runId) ?? this.freezeWorkflow(workflowPath);
    this.frozenCopies.set(runId, frozen);
    this.stampQueueEntry(runId, {
      frozenHash: frozen.hash,
      frozenPath: frozen.entryPath,
      engineVersion: this.engineVersion(),
    });
    this.prepareRun(frozen.entryPath, runId);
    // BRA-89: pin the trap code (see submit — same order: after
    // extraction, which the pin reads). Prefer the pin already
    // recorded for this run (submit pinned it; the admit path's
    // queue entry carries it) — recomputing here would pin code
    // edited between submit and first drive, which is exactly the
    // hole the pin closes. Only compute when no pin exists yet
    // (direct startRun callers, e.g. stepwise tests). this.adapter
    // is the per-entry adapter runQueue swapped in, so a
    // --workers-config override on it is pinned as submitted. The
    // stamp below persists a fresh pin on the queue entry;
    // startRunFrom persists it on the run entry.
    const existingPin = this.trapPinFor(runId);
    const trapPin = existingPin ?? this.computeTrapPin(runId, this.adapter);
    this.trapPins.set(runId, trapPin);
    if (!existingPin) this.stampQueueEntry(runId, { trapPin });
    this.validateAndStoreInput(runId, input);
    const driverPath = this.driverFor(runId);
    const bundle = await this.bundle(driverPath, `bundle-${prefixFor(runId)}.js`);
    // BRA-73: pin the bundle + its source map with the run, durably
    // under runs/ next to the driver + run entry (the workdir copy
    // is the execution artifact; this copy is the record). Trap
    // sites are bundle coordinates — without these files the
    // coordinates are uninterpretable, and the map (with embedded
    // sources) is what translates them back to the workflow source.
    this.pinBundle(runId, bundle);
    return this.startRunFrom(bundle, runId);
  }

  /**
   * BRA-73: copy a built bundle + its source map into runs/ as the
   * run's pinned record and remember the paths for the
   * lifecycle-started enrichment (see enrichRunStart). The map is
   * optional in the record (a build without one still pins the
   * bundle) but Bun.build with sourcemap "external" always emits
   * it — a missing map is a loud gap for the test, not a silent one.
   */
  private pinBundle(runId: string, bundlePath: string): { bundlePath: string; bundleMapPath: string | null } {
    const p = prefixFor(runId);
    const dest = path.join(this.stateDir, "runs", `${p}.bundle.js`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(bundlePath, dest);
    const mapSrc = `${bundlePath}.map`;
    let bundleMapPath: string | null = null;
    if (fs.existsSync(mapSrc)) {
      bundleMapPath = `${dest}.map`;
      fs.copyFileSync(mapSrc, bundleMapPath);
    }
    const pin = { bundlePath: dest, bundleMapPath };
    this.bundlePins.set(runId, pin);
    return pin;
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
          // G3/G11 (BRA-75, BRA-74): wait only the REMAINING time. The
          // trap's suspension wallTs (journaled) is the sleep's
          // start, so a re-dispatched sleep resumes from where the
          // crashed attempt left off instead of re-waiting the full
          // duration. A first dispatch waits the full ms.
          const target = this.sleepTargetMs(runId, trapId, ms);
          // G11 (BRA-74): record the deadline durably BEFORE the wait starts, so a restart
          // mid-sleep resumes from the recorded deadline even if the trap event's wallTs is ever
          // unavailable. Recorded once per trap (re-dispatches reuse it — see sleepTargetMs);
          // the deadline is identical either way (same trap wallTs + ms).
          if (!this.journal(runId).some((e) => e.event === "sleep-deadline" && e.trapId === trapId)) {
            this.journalEvent(runId, {
              event: "sleep-deadline",
              runId,
              trapId,
              ms,
              deadlineMs: target,
              deadline: new Date(target).toISOString(),
            });
          }
          const remaining = target - Date.now();
          if (remaining > 0) this.waitReal(remaining);
          this.advanceClockTo(target, runId, "sleep");
          // The drive was blocked on this timer and has resumed —
          // a wake event (informational in the current architecture:
          // the tick agent is blocked inside this same drive, so it
          // cannot act on it; the event exists for a future async
          // drive and for the record).
          if (ms > 0) this.notifyEvent("timer-fired", { runId, detail: { type: "sleep", ms } });
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
            if (wait > 0) {
              this.waitReal(wait);
              // See the sleep case: the drive was blocked on this
              // timer and has resumed.
              this.notifyEvent("timer-fired", { runId, detail: { type: "cron", at } });
            }
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
        const delivered = this.takeGateAnswer(runId);
        if (delivered.found) return { value: delivered.value };
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
   *
   * Dispatch provenance (BRA-73, item 4): the adapter's answer may
   * carry host-side-only provenance — `worker` (the pool worker id
   * that produced the answer) and `tokens` (see TrapAnswer). Only
   * `value`/`throw` cross into the engine, so this loop carries the
   * provenance through on every return it rebuilds: the validated
   * value, and the ValidationError throws for answers that fail the
   * boundary or the schema (the worker that produced the invalid
   * answer is still the provenance — the host repaired or rejected
   * the shape, it did not do the work). Before this fix the loop
   * returned bare `{ value: cleaned }`, silently dropping the worker
   * the pool adapter had named — trap-result.worker was always
   * undefined for pool jobs even though the adapter returned the id.
   */
  private dispatchTrap(
    runId: string,
    trapId: string,
    type: string,
    arg: any,
    ordinal = 0,
  ): TrapAnswer | typeof HOLD {
    // BRA-73: strip the wrapper-attached call-site transport key
    // before anything consumes the arg — siteKeyFor, the adapter,
    // and the repair handler all see exactly the spec the author
    // passed. (The site itself was already promoted to the trap
    // event's top-level `site` at ingest; the dispatch path only
    // needs the clean arg.)
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

    // BRA-89: refuse to answer from trap code that changed since
    // submit — before the adapter (or any worker process) sees
    // the trap. job/decide/exec only: sleep/cron/clock are
    // host-owned and a gate answer comes from a human.
    if (type === "job" || type === "decide" || type === "exec") {
      this.assertTrapPin(runId, trapId);
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
    // BRA-73 (item 4): the adapter's dispatch provenance — see the
    // method comment. Captured once, carried through every return
    // below that rebuilds the answer.
    const provenance: { worker?: string; tokens?: number } = {
      ...(typeof (answer as any).worker === "string" ? { worker: (answer as any).worker as string } : {}),
      ...(typeof (answer as any).tokens === "number" ? { tokens: (answer as any).tokens as number } : {}),
    };
    if ("throw" in answer) {
      // A throw payload crosses the same resume path as a value: it
      // must be JSON-clean too (JSON.stringify would silently mangle
      // it). If it is not, deliver a ValidationError describing the
      // bad payload instead — the original throw cannot cross.
      try {
        answer = { throw: toJsonValue(answer.throw, "throw"), ...provenance };
      } catch (e) {
        if (e instanceof JsonBoundaryError) {
          const issues = [boundaryIssue(e)];
          this.journalValidation(runId, trapId, "json-clean", 0, issues, "throw-payload");
          return {
            throw: this.validationErrorRecord(trapId, "json-clean", 0, formatIssues(issues)),
            ...provenance,
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
          return { throw: this.validationErrorRecord(trapId, "json-clean", attempt, formatIssues(issues)), ...provenance };
        }
        const repaired = this.tryRepair(type, arg, runId, trapId, site, attempt, "json-clean", issues, current);
        if (!repaired) {
          return { throw: this.validationErrorRecord(trapId, "json-clean", attempt, formatIssues(issues)), ...provenance };
        }
        if ("throw" in repaired) return repaired;
        current = repaired.value;
        attempt++;
        continue;
      }
      const schemaIssues = this.validator.validate(cleaned, site.outputSchema);
      if (!schemaIssues.length) return { value: cleaned, ...provenance };
      this.journalValidation(runId, trapId, "output", attempt, schemaIssues);
      if (attempt >= this.maxRepairAttempts) {
        return { throw: this.validationErrorRecord(trapId, "output", attempt, formatSchemaIssues(schemaIssues)), ...provenance };
      }
      const repaired = this.tryRepair(type, arg, runId, trapId, site, attempt, "output", schemaIssues, current);
      if (!repaired) {
        return { throw: this.validationErrorRecord(trapId, "output", attempt, formatSchemaIssues(schemaIssues)), ...provenance };
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

  /**
   * G3 (BRA-75): the journal check before re-dispatch. Returns the
   * already-recorded answer for a trapId, or null when the trap was
   * never dispatched to a result. A trapId names one trap execution
   * (runId/trap-N, Q9), so a result for it can only be this
   * execution's — there is no cross-trap confusion.
   *
   * Two sources, in preference order:
   *   1. `trap-dispatched` — the host recorded the resolved answer
   *      at dispatch time, before resuming. This is the primary
   *      source: it exists exactly when a dispatch completed but
   *      the resume did not (the G3 window).
   *   2. `trap-result` / `trap-error` — the C host emitted the
   *      result on resume. This covers dispatches from before this
   *      fix (no trap-dispatched event) and the crash-after-resume
   *      case, where the resume happened but the run is still
   *      suspended at this trap. The C host carries the result
   *      value on trap-result (and the error on trap-error).
   */
  private recordedTrapResult(
    runId: string,
    trapId: string,
  ): { answer: TrapAnswer; adapter?: string; wallMs?: number } | null {
    const events = this.journal(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.trapId !== trapId) continue;
      if (e.event === "trap-dispatched" && e.result !== undefined) {
        return {
          answer: e.result as TrapAnswer,
          ...(typeof e.adapter === "string" ? { adapter: e.adapter } : {}),
          ...(typeof e.wallMs === "number" ? { wallMs: e.wallMs } : {}),
        };
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.trapId !== trapId) continue;
      if (e.event === "trap-result" && e.result !== undefined) {
        return {
          answer: { value: e.result },
          ...(typeof e.adapter === "string" ? { adapter: e.adapter } : {}),
          ...(typeof e.wallMs === "number" ? { wallMs: e.wallMs } : {}),
        };
      }
      if (e.event === "trap-error" && e.error !== undefined) {
        return {
          answer: { throw: e.error },
          ...(typeof e.adapter === "string" ? { adapter: e.adapter } : {}),
          ...(typeof e.wallMs === "number" ? { wallMs: e.wallMs } : {}),
        };
      }
    }
    return null;
  }

  /**
   * G3/G11 (BRA-75, BRA-74): the wall time when a sleep trap completes — the deadline, not
   * just the wait. Sources, in preference order:
   *   1. A `sleep-deadline` event recorded at the first dispatch (resolveAnswer journals it
   *      before the wait starts, so it is durable even if the trap event ever loses its wallTs
   *      or is quarantined). The deadline is the fact; the trap wallTs is how it was derived.
   *   2. The trap event's suspension wallTs (journaled at ingest, BRA-75) plus the duration.
   *   3. Now + ms (no trap event or no wallTs — the full wait, the old behavior).
   * A first dispatch waits the full duration (elapsed ~0); a re-dispatched sleep waits only
   * what is left. The latest sleep-deadline event wins — re-dispatches reuse the same deadline
   * (resolveAnswer records it once), so duplicates would carry the same value.
   */
  private sleepTargetMs(runId: string, trapId: string, ms: number): number {
    const events = this.journal(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "sleep-deadline" && e.trapId === trapId && typeof e.deadlineMs === "number") {
        return e.deadlineMs;
      }
    }
    const trap = events.find((e) => e.event === "trap" && e.trapId === trapId);
    const wallTs = typeof trap?.wallTs === "string" ? Date.parse(trap.wallTs) : NaN;
    if (Number.isNaN(wallTs)) return Date.now() + ms;
    return wallTs + ms;
  }

  /**
   * G1 (BRA-74): classify a C-host slice that did not return a normal code (0 done, 2 suspended
   * at a trap, 3 suspended at a combinator). The journal is the source of truth, not the exit
   * code: a genuine workflow failure writes lifecycle "failed" first, and a completed run writes
   * lifecycle "completed" (the C host writes the result file immediately BEFORE the lifecycle
   * event — see classifyStrandedEntry). A slice that ends with neither event died before it
   * could record what happened: the C host was killed (SIGKILL) or segfaulted mid-slice.
   * Returns "crashed" only then; "failed"/"completed" are the run's real outcome.
   */
  private classifySliceCrash(runId: string): "crashed" | "failed" | "completed" {
    const events = this.journal(runId);
    if (events.some((e) => e.event === "lifecycle" && e.lifecycle === "completed")) return "completed";
    if (events.some((e) => e.event === "lifecycle" && e.lifecycle === "failed")) return "failed";
    return "crashed";
  }

  /**
   * G1 (BRA-74): resume a run whose last C-host slice crashed, from its last intact blob.
   * The blob on disk is the snapshot at the last suspension (storeBlob runs after every rc 2/3
   * slice), so re-driving from it re-executes exactly the crashed slice — and the BRA-75
   * journal check re-delivers an already-dispatched trap answer instead of dispatching it
   * again. The suspension point is the last trap/fork event in the journal: a trap with a
   * recorded answer is still the re-drive point (driveStepOnce re-delivers it via
   * recordedTrapResult), and a fork with no later trap/lifecycle is still pending. Returns false
   * when there is no intact blob or no suspension point to resume from (the caller fails the run
   * loudly). Throws when the same suspension point has already crashed 3 times — a
   * deterministically crashing slice, not a transient kill — and when the engine changed under
   * the run (G10, via assertEngineVersion, like every other resume). The budget is counted from
   * the durable journal (host-crash-resumed events for this suspension point), so it survives a
   * restart.
   */
  private resumeFromCrash(runId: string): boolean {
    const entry = this.registry.get(runId);
    if (!entry) return false;
    if (!fs.existsSync(this.blobPath(runId))) return false;
    const events = this.journal(runId);
    let rc: 2 | 3 | null = null;
    let point: { trapId?: string; forkId?: string } = {};
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === "trap") {
        rc = 2;
        point = { trapId: e.trapId };
        break;
      }
      if (e.event === "fork") {
        rc = 3;
        point = { forkId: e.forkId };
        break;
      }
    }
    if (rc === null) return false;
    const prior = events.filter(
      (e) =>
        e.event === "host-crash-resumed" &&
        (point.trapId ? e.trapId === point.trapId : e.forkId === point.forkId),
    ).length;
    if (prior >= 3) {
      throw new Error(
        `C host crashed resuming ${runId} at ${point.trapId ?? point.forkId} ${prior} times — the slice fails deterministically, not transiently; refusing to resume again (last blob intact at ${this.blobPath(runId)})`,
      );
    }
    const q = this.readQueue().find((x) => x.runId === runId);
    this.assertEngineVersion(runId, entry, (q ?? {}) as QueueEntry);
    this.loadBlob(runId, entry.snap);
    entry.rc = rc;
    this.refresh(entry);
    this.saveRunEntry(runId);
    this.journalEvent(runId, {
      event: "host-crash-resumed",
      runId,
      ...(point.trapId ? { trapId: point.trapId } : { forkId: point.forkId }),
      attempt: prior + 1,
      reason: "C-host slice crashed with no lifecycle event — resuming from the last intact blob",
    });
    return true;
  }

  /**
   * G1 (BRA-74): the shared tail for a C-host slice that did not return a normal code (0/2/3).
   * Classifies the outcome from the journal (see classifySliceCrash) and either returns the
   * genuine outcome (0 completed / 1 failed), resumes from the last blob (returning the suspended
   * code 2/3 so the drive loop re-drives the slice), or throws loudly when the run cannot be
   * resumed (no blob, no suspension point, crash budget exhausted). Callers are the resume
   * slices (deliverResult/deliverThrow); the join slices retry inside runJoinSlice instead, so
   * a join crash never re-runs the branches.
   */
  private handleSliceCrash(runId: string, entry: RunEntry, rc: number, slice: "resume" | "join"): number {
    const outcome = this.classifySliceCrash(runId);
    if (outcome === "completed") {
      // The C host died between writing lifecycle "completed" and exiting — the run finished.
      this.finished.set(runId, 0);
      return 0;
    }
    if (outcome === "failed") {
      entry.rc = 1;
      this.refresh(entry);
      this.saveRunEntry(runId);
      return 1;
    }
    // Crashed: no lifecycle event — the C host died mid-slice.
    this.journalEvent(runId, {
      event: "host-crash",
      runId,
      slice,
      rc,
      ...(this.lastHostSignal ? { signal: this.lastHostSignal } : {}),
      reason: "C-host slice ended with no lifecycle event — the process died mid-slice (killed or segfaulted), not a workflow failure",
    });
    if (this.resumeFromCrash(runId)) {
      // resumeFromCrash reset entry.rc to the suspended code (2 trap / 3 fork) and restored the
      // blob; return it so the drive loop re-drives the slice from the blob.
      return this.registry.get(runId)?.rc ?? 2;
    }
    throw new Error(
      `C host crashed mid-slice on ${runId} and the run cannot be resumed (no intact snapshot blob or no suspension point in the journal) — see the host-crash journal event; restore the blob or start a fresh run`,
    );
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
    if (rc === 0 || rc === 2 || rc === 3) {
      entry.rc = rc;
      this.refresh(entry);
      if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
      this.saveRunEntry(runId);
      return rc;
    }
    // G1 (BRA-74): the resume slice did not return a normal code — classify it from the journal
    // (genuine failure/completion vs C-host crash) and resume from the blob when it crashed.
    return this.handleSliceCrash(runId, entry, rc, "resume");
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
    if (rc === 0 || rc === 2 || rc === 3) {
      entry.rc = rc;
      this.refresh(entry);
      if (rc === 2 || rc === 3) this.storeBlob(runId, entry.snap);
      this.saveRunEntry(runId);
      return rc;
    }
    // G1 (BRA-74): same as deliverResult — a crashed resume slice resumes from the blob.
    return this.handleSliceCrash(runId, entry, rc, "resume");
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
    // G1 (BRA-74): same as startRunFrom — a branch's first slice has no blob yet, so a C-host
    // crash here is retried as a fresh branch start (no trap dispatched yet). Bounded: 3 attempts.
    let rc = -1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      rc = this.runHost(
        ["branch", csnap, String(index)],
        path.join(this.workdir, cprefix + ".out"),
        path.join(this.workdir, cprefix + ".log"),
        cenv,
      );
      if (rc === 0 || rc === 2 || rc === 3) break;
      const outcome = this.classifySliceCrash(child);
      if (outcome === "completed") {
        rc = 0;
        break;
      }
      if (outcome === "failed") {
        rc = 1;
        break;
      }
      this.journalEvent(child, {
        event: "host-crash",
        runId: child,
        slice: "branch",
        rc,
        ...(this.lastHostSignal ? { signal: this.lastHostSignal } : {}),
        attempt,
        reason: "C-host branch start ended with no lifecycle event — retrying the branch from scratch (no trap dispatched yet)",
      });
      if (attempt === 3) {
        throw new Error(
          `C host crashed starting branch ${child} 3 times — the first slice fails deterministically, not transiently; see the host-crash journal events`,
        );
      }
    }
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
    const rc = this.driveToCompletion(child);
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

  /**
   * G1 (BRA-74): run one join slice — the C host combining branch outcomes into the parent —
   * with a bounded retry when the C host crashes mid-slice. The branch outcomes are already on
   * disk (durable record files, written before the first attempt), so re-running the join slice
   * is a pure re-combine: it never re-runs a branch. (Re-entering doAllJoin/doAnyJoin/doRaceJoin
   * would re-run the branches — a double-execution risk — which is why the retry lives here, at
   * the slice, and not in driveStepOnce's rc===3 branch.) The blob is restored before each
   * attempt (loadBlob), so a crash mid-join restarts the combine from the parent's last
   * suspension, not from a half-written snapshot. A genuine workflow failure (lifecycle
   * "failed") or completion returns its code as-is. After 3 crashed attempts the slice throws
   * loudly — the run fails with the message, it does not loop.
   */
  private runJoinSlice(
    snap: string,
    outPath: string,
    logPath: string,
    env: Record<string, string>,
    args: string[],
    runId: string,
  ): number {
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.loadBlob(runId, snap);
      const rc = this.runHost(args, outPath, logPath, env);
      if (rc === 0 || rc === 2 || rc === 3) return rc;
      const outcome = this.classifySliceCrash(runId);
      if (outcome === "completed") return 0;
      if (outcome === "failed") return 1;
      this.journalEvent(runId, {
        event: "host-crash",
        runId,
        slice: "join",
        rc,
        ...(this.lastHostSignal ? { signal: this.lastHostSignal } : {}),
        attempt,
        reason: "C-host join slice ended with no lifecycle event — retrying the combine from the blob (branch outcomes already on disk, branches not re-run)",
      });
      if (attempt === 3) {
        throw new Error(
          `C host crashed joining ${runId} 3 times — the join slice fails deterministically, not transiently; see the host-crash journal events`,
        );
      }
    }
    return 1; // unreachable — the loop returns or throws
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
      return this.runJoinSlice(snap, outPath, logPath, env, ["join-throw", snap, recordPath], fork.runId);
    }
    if (failFast) {
      const valueFiles: string[] = [];
      for (let k = 0; k < completed.length; k++) {
        const vpath = path.join(this.workdir, `${prefix}.join-value-${k}.json`);
        fs.writeFileSync(vpath, JSON.stringify(toJsonValue(completed[k].value, "join value")));
        valueFiles.push(vpath);
      }
      return this.runJoinSlice(snap, outPath, logPath, env, ["join", snap, ...valueFiles], fork.runId);
    }
    return this.runJoinSlice(snap, outPath, logPath, env, ["join", snap, ...outcomes], fork.runId);
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
        return this.runJoinSlice(snap, outPath, logPath, env, ["join-value", snap, recordPath], fork.runId);
      }
      errors.push(r.outcome.error);
      completed.push(r.outcome);
    }
    this.snapUntouched(snap, before);
    const record = { errors, completed, cancelled: [] };
    const recordPath = path.join(this.workdir, prefixFor(forkId) + ".join-aggregate.json");
    fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
    return this.runJoinSlice(snap, outPath, logPath, env, ["join-aggregate", snap, recordPath], fork.runId);
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
      return this.runJoinSlice(snap, outPath, logPath, env, ["join-value", snap, recordPath], fork.runId);
    }
    const record = { failedBranch: 0, error: r.outcome.error, cancelled, completed: [] };
    const recordPath = path.join(this.workdir, prefixFor(forkId) + ".join-throw.json");
    fs.writeFileSync(recordPath, JSON.stringify(toJsonValue(record, "join record")));
    return this.runJoinSlice(snap, outPath, logPath, env, ["join-throw", snap, recordPath], fork.runId);
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
      // G3 (BRA-75): check the journal BEFORE re-dispatching. A
      // prior dispatch may have completed and its answer recorded,
      // with the host crashing before the resume — re-dispatching
      // would execute the trap a second time (a job enqueued twice,
      // an exec re-run, a sleep re-waited in full). If the journal
      // holds a result for this trapId, deliver it instead.
      const recorded = this.recordedTrapResult(runId, trapEv.trapId);
      if (recorded) {
        this.pendingTrapMeta.set(trapEv.trapId, {
          adapter: recorded.adapter ?? this.adapter.name,
          ...(typeof (recorded.answer as any).worker === "string"
            ? { worker: (recorded.answer as any).worker as string }
            : {}),
          wallMs: recorded.wallMs ?? 0,
          ...(typeof (recorded.answer as any).tokens === "number"
            ? { tokens: (recorded.answer as any).tokens as number }
            : {}),
        });
        if ("throw" in recorded.answer) rc = this.deliverThrow(runId, recorded.answer.throw);
        else rc = this.deliverResult(runId, recorded.answer.value);
        return rc;
      }
      // G3: record the dispatch start. A crash after this point
      // leaves a trap-dispatch with no trap-dispatched — the
      // recovery check can tell a re-dispatch from a first dispatch
      // (and the profiler gets the dispatch timestamp BRA-73 asked
      // for). A second trap-dispatch for one trapId IS the visible
      // record of a re-dispatch — no separate event is needed.
      const priorDispatch = this.journal(runId).some(
        (e) => e.event === "trap-dispatch" && e.trapId === trapEv.trapId,
      );
      this.journalEvent(runId, {
        event: "trap-dispatch",
        runId,
        trapId: trapEv.trapId,
        type: trapEv.type,
        ordinal: trapEv.ordinal ?? 0,
        ...(priorDispatch ? { redispatched: true } : {}),
      });
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
        trapEv.type === "gate" && this.readGateAnswers(runId).length > 0;
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
      // G3: record the dispatch RESULT before resuming. The answer
      // is the final validated (possibly repaired) one — exactly
      // what deliverResult/deliverThrow will deliver. A crash
      // between here and the resume leaves the answer in the
      // journal; recovery delivers it instead of re-dispatching.
      // (The C host will journal the same result again as
      // trap-result on a successful resume — the duplication is the
      // price of having the result before the resume, and the
      // journal already carries full results.)
      this.journalEvent(runId, {
        event: "trap-dispatched",
        runId,
        trapId: trapEv.trapId,
        type: trapEv.type,
        ordinal: trapEv.ordinal ?? 0,
        result: ans,
        adapter: fromHostGateQueue ? "host" : this.adapter.name,
        wallMs,
      });
      // TEST HOOK (BRA-75): crash after dispatch, before resume —
      // simulates a host SIGKILL in the G3 window (dispatch done,
      // resume not yet delivered). Env-gated, off by default; the
      // fault-injection test (tests/test-bra75.ts) sets it for the
      // drive child only. Exit 137 = 128 + SIGKILL.
      if (process.env.AGENTTS_CRASH_AFTER_DISPATCH === "1") process.exit(137);
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
   * Drive one run to completion (private — the run path is submit →
   * runQueue → result; this is the engine primitive runQueue and
   * the join machinery use, not a run mode). Returns the final exit
   * code: 0 done, 1 error, 2 suspended at a held gate (see
   * isGatePending), 3 still suspended at a 0-branch fork when
   * allowUnresolved. Throws on plugin errors (branch failure,
   * snapshot touched, missing schema).
   */
  private driveToCompletion(runId: string, opts: { allowUnresolved?: boolean } = {}): number {
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
      if (rounds > MAX_DRIVE_ROUNDS) {
        // G12 (BRA-76): the cap is a loud, named error — not a
        // silent stop. The journal records it (the queue entry's
        // error alone would leave `status` showing "suspended" with
        // no reason — see the pre-fix 60-sleep run, whose journal
        // ended at the trap-50 suspension with no mention of the
        // cap). The run is left suspended at a trap with its blob
        // intact; runQueue marks the entry failed with this message.
        this.journalEvent(runId, {
          event: "drive-cap",
          runId,
          cap: MAX_DRIVE_ROUNDS,
          rounds,
          reason: `run needed more than ${MAX_DRIVE_ROUNDS} suspensions in one uninterrupted drive — split the workflow into fewer than ${MAX_DRIVE_ROUNDS} traps per drive`,
        });
        throw new DriveCapError(
          `run ${runId} exceeded the drive cap of ${MAX_DRIVE_ROUNDS} rounds (hit round ${rounds}) — split the workflow into fewer than ${MAX_DRIVE_ROUNDS} traps per drive, or start a fresh run; the run is suspended at a trap with its snapshot blob intact at ${this.blobPath(runId)}`,
        );
      }
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
   * deepest-first. Normal driving (driveToCompletion()) starts branches and joins
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

  /** Deliver a held gate's answer, then re-queue the run so `queue
   * run` drives it. Does NOT drive — the run path is submit →
   * runQueue → result, and deliver-gate is not a second drive mode.
   * The answer is persisted (queueGateAnswer writes it to disk), so
   * the driving process — possibly a different one — can read it. */
  deliverGate(runId: string, answer: unknown): void {
    if (!this.pendingGate.has(runId) && !this.isGateSuspended(runId)) {
      throw new Error(`no gate pending for ${runId}`);
    }
    this.queueGateAnswer(runId, answer);
    this.pendingGate.delete(runId);
    // BRA-82: a read-modify-write — hold the enqueue lock across
    // it so a concurrent submit cannot interleave and lose either
    // the re-queue flip or the new entry.
    this.withQueueLock(() => {
      const q = this.readQueue();
      const entry = q.find((e) => e.runId === runId);
      if (entry && entry.status === "held") {
        entry.status = "queued";
        this.writeQueue(q);
      }
    });
    // The run can be driven again — wake the tick agent so it
    // drives the queue instead of waiting out its tick timeout.
    this.notifyEvent("gate-answered", { runId });
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
