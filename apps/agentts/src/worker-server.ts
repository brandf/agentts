// worker-server — the host-side job queue + get-job/complete-job HTTP API (BRA-48).
//
// One Bun process, loopback only. It is the SOLE writer of the job
// store (<stateDir>/worker-jobs/store.json): the adapter, the CLI,
// and workers all go through HTTP, so there is exactly one mutation
// path and no lost-update race between processes. Handlers are
// synchronous (no awaits in the mutation path) and every mutation is
// written through to disk before the response is sent.
//
// Driver endpoints (BRA-116): the tick agent drives the queue over
// HTTP instead of spawning `bun src/cli.ts` per action (BRA-100:
// 11 fresh Bun processes, ~2.3s per unit of work, ~350ms of it the
// cli.ts module graph per spawn). The six endpoints mirror the CLI
// driver commands exactly — same Host calls, same refusal semantics,
// same outputs — so the operator path (CLI) and the tick-agent path
// (HTTP) cannot drift apart:
//
//   POST /queue/run        {entries, repair, failed}   — queue run
//   POST /deliver-result   {runId} -> DeliveryRecord   — deliver-result
//   GET  /queue/list       {entries}                   — queue list
//   GET  /deliveries      {deliveries}                — deliveries
//   POST /escalate         {kind, runId?, reason, detail?} -> {path}
//   POST /deliver-gate     {runId, answer} -> {ok, runId}
//
// Host lifecycle (decided BRA-116, see makeDriverHost in host.ts):
// a fresh Host is constructed PER REQUEST, exactly like the CLI does
// — a Host held by the server would go stale the moment another
// process drives the same state dir, and would pin every journal in
// memory forever (BRA-98). Cost ~8ms at bench sizes (constructor
// 0.4–1.6ms + adapter load, measured standalone).
//
// Driver lock: the server drive holds the file lock (runQueue
// acquires it with the server's pid), so a concurrent CLI `queue
// run` refuses loudly as today — and a CLI drive holding the lock
// makes POST /queue/run answer 409. Drives are serialized by that
// same lock, in-process as well as across processes: two concurrent
// POST /queue/run calls cannot both hold it. A server restart
// mid-drive leaves a stranded "running" entry + a lock with a dead
// pid; the next drive repairs it (BRA-72) — see test-bra116.ts.
//
// The server names itself: start() sets AGENTTS_WORKER_SERVER to
// its own URL, so driver Hosts constructed inside this process
// notify events to THIS server (not the default port) and the muse
// adapter health-checks this server instead of auto-starting a
// second one on the default port.
//
// Driver Hosts notify in-process (BRA-116): driverHost() passes the
// server's emitEvent as the Host's onEvent sink (see HostConfig in
// host.ts). A driver Host must not notify over HTTP to itself —
// notifyEvent's synchronous curl POST blocks this server's event
// loop while it waits for a response the blocked loop cannot serve,
// burning its whole 2s timeout per terminal drive and losing the
// event. The CLI's Hosts notify over HTTP as before (a separate
// process, whose loop is free to answer).
//
// Submit stays CLI (decided BRA-116): the submitter is the operator
// / coordinator, not the tick agent, and a /submit endpoint would
// move gate+extract+validation into the server — a bigger API and
// process-lifecycle surface. The remaining ~0.5s submit spawn is the
// production path's floor after this change; see AUDIT-BRA116.md.
//
// Crash/timeout policy (decided BRA-48): a running job whose lease
// expires is RE-QUEUED (attempts incremented), not failed — a worker
// crash looks exactly like a timeout, and the work is retried by
// another worker. After maxAttempts attempts the job FAILS LOUDLY
// (status "failed", error recorded, adapter throws at the call site).
// An explicit worker error counts as an attempt the same way.
// Delivery-once: a job is assigned to exactly one worker at a time
// (status running + workerId); a completion is accepted only from
// the assigned worker while the job is running — a late completion
// after re-queue / completion / cancel is a 409 and is journaled,
// never double-applied.
//
// Affinity: the server keeps per-worker completion history and asks
// the DispatchScheduler (src/scheduler.ts, BRA-49 v1) which queued
// job a polling worker should get. Every decision is appended to
// scheduler.log (JSONL); every job transition to jobs.log (JSONL).
// Both logs live under <stateDir>/worker-jobs/ and are the evidence
// for queue behavior — read them, don't trust a green summary.
//
// Dispatch (BRA-49): the scheduler orders by effective priority,
// then affinity inside the tier, then estimated cost (shortest
// first). Quotas are enforced by the server around selection: the
// scheduler picks, the QuotaTracker (src/quotas.ts) vets the pick
// against pool size / CPU slots / decision rate / token budget, and
// a blocked pick is excluded and selection re-runs — a quota never
// hands a worker a job it may not run, and never starves the queue
// behind one blocked job. Cost actuals (assignedAt -> completedAt
// per spec) are recorded in cost-model.json; estimates are attached
// to jobs at enqueue and refreshed at selection time.
//
//   bun src/worker-server.ts --state-dir <dir> [--port N]
//       [--lease-ms N] [--max-attempts N]
//       [--affinity-hold-ms N] [--affinity-ttl-ms N]
//       [--max-pool-size N] [--max-cpu-slots N]
//       [--max-decisions-per-sec N] [--max-tokens-per-hour N]
//       [--dispatch-aging-ms N]
//       [--jobspec-dir <dir>]
// Env overrides: AGENTTS_WORKER_PORT, AGENTTS_WORKER_LEASE_MS,
// AGENTTS_WORKER_MAX_ATTEMPTS, AGENTTS_WORKER_AFFINITY_HOLD_MS,
// AGENTTS_WORKER_AFFINITY_TTL_MS, AGENTTS_MAX_POOL_SIZE,
// AGENTTS_MAX_CPU_SLOTS, AGENTTS_MAX_DECISIONS_PER_SEC,
// AGENTTS_MAX_TOKENS_PER_HOUR, AGENTTS_DISPATCH_AGING_MS,
// AGENTTS_JOBSPEC_DIR, AGENTTS_STATE_DIR (default ./.agentts-state).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { atomicWriteFile, CorruptionLog, type CorruptionRecord } from "./corruption";
import { Host, makeDriverHost } from "./host";
import { LocalTaskBackend, syncRunToTask } from "./task-backend";
import { DEFAULT_DISPATCH_AGING_MS, DispatchScheduler } from "./scheduler";
import { CostModel } from "./cost-model";
import { QuotaTracker } from "./quotas";
import { WaitHub } from "./wait-hub";
import {
  DEFAULT_AFFINITY_HOLD_MS,
  DEFAULT_AFFINITY_TTL_MS,
  DEFAULT_GET_JOB_WAIT_MS,
  DEFAULT_LEASE_MAX_MS,
  DEFAULT_LEASE_MIN_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TICK_TIMEOUT_MS,
  DEFAULT_WORKER_PORT,
  LEASE_P90_MULTIPLIER,
  MAX_FILE_EFFECT_BYTES,
  MAX_LONG_POLL_MS,
  NUDGE_FRACTION,
  SYSTEM_EVENT_TYPES,
  type FileEffect,
  type GateNotice,
  type Job,
  type JobAssignment,
  type JobStatus,
  type SystemEvent,
  type SystemEventType,
  type WorkerInfo,
} from "./worker-protocol";

const BUN = "/opt/hatch-image/bin/bun";

interface Store {
  jobs: Record<string, Job>;
  workers: Record<string, WorkerInfo>;
  gates: GateNotice[];
  seq: number;
}

/** store.json is corrupt AND its backup is corrupt (or missing), so
 * there is no consistent worker store to load (BRA-76, BRA-62 G7).
 * Thrown by loadStore — never a silent fresh store. The message
 * names both files and what a human should do; deleting store.json
 * to start empty is a human decision, not something the server does
 * on its own (it would drop every queued job and worker). Mirrors
 * the Host's CorruptQueueError (BRA-77 G5). */
export class CorruptWorkerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptWorkerStoreError";
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function resolveJobspecDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.AGENTTS_JOBSPEC_DIR) return path.resolve(process.env.AGENTTS_JOBSPEC_DIR);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, "..", "plugins", "muse", "jobspecs"),
    path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "plugins", "muse", "jobspecs"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

export interface WorkerServerConfig {
  stateDir: string;
  port: number;
  leaseMs: number;
  maxAttempts: number;
  affinityHoldMs: number;
  affinityTtlMs: number;
  jobspecDir: string;
  /** Max concurrent running jobs (0 = unlimited). */
  maxPoolSize: number;
  /** Max concurrent cpuHeavy jobs (0 = unlimited). */
  maxCpuSlots: number;
  /** Max decision-model jobs per second (0 = unlimited). */
  maxDecisionsPerSec: number;
  /** Max tokens per rolling hour (0 = unlimited). */
  maxTokensPerHour: number;
  /** Ms of waiting per one-step priority improvement at dispatch. */
  dispatchAgingMs: number;
  /** Workers-config file for the driver Host (BRA-111): --workers-config
   * flag or AGENTTS_WORKERS_CONFIG env. The driver reads it fresh on
   * every drive (makeDriverHost) and registers its scripts on the
   * DirectAdapters it builds — so a run submitted with --adapter
   * direct + a workers-config keeps its workers through the queue
   * drive. Absent: no extra workers (the pre-BRA-111 behavior). */
  workersConfigPath?: string;
}

export function serverConfigFromArgs(args: string[]): WorkerServerConfig {
  const stateDir = path.resolve(
    flag(args, "--state-dir") ?? process.env.AGENTTS_STATE_DIR ?? path.join(process.cwd(), ".agentts-state"),
  );
  return {
    stateDir,
    port: Number(flag(args, "--port") ?? process.env.AGENTTS_WORKER_PORT ?? DEFAULT_WORKER_PORT),
    leaseMs: Number(flag(args, "--lease-ms") ?? process.env.AGENTTS_WORKER_LEASE_MS ?? DEFAULT_LEASE_MS),
    maxAttempts: Number(flag(args, "--max-attempts") ?? process.env.AGENTTS_WORKER_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS),
    affinityHoldMs: Number(
      flag(args, "--affinity-hold-ms") ?? process.env.AGENTTS_WORKER_AFFINITY_HOLD_MS ?? DEFAULT_AFFINITY_HOLD_MS,
    ),
    affinityTtlMs: Number(
      flag(args, "--affinity-ttl-ms") ?? process.env.AGENTTS_WORKER_AFFINITY_TTL_MS ?? DEFAULT_AFFINITY_TTL_MS,
    ),
    jobspecDir: resolveJobspecDir(flag(args, "--jobspec-dir")),
    maxPoolSize: Number(flag(args, "--max-pool-size") ?? process.env.AGENTTS_MAX_POOL_SIZE ?? 0),
    maxCpuSlots: Number(flag(args, "--max-cpu-slots") ?? process.env.AGENTTS_MAX_CPU_SLOTS ?? 2),
    maxDecisionsPerSec: Number(flag(args, "--max-decisions-per-sec") ?? process.env.AGENTTS_MAX_DECISIONS_PER_SEC ?? 0),
    maxTokensPerHour: Number(flag(args, "--max-tokens-per-hour") ?? process.env.AGENTTS_MAX_TOKENS_PER_HOUR ?? 0),
    dispatchAgingMs: Number(
      flag(args, "--dispatch-aging-ms") ?? process.env.AGENTTS_DISPATCH_AGING_MS ?? DEFAULT_DISPATCH_AGING_MS,
    ),
    workersConfigPath:
      flag(args, "--workers-config") ?? process.env.AGENTTS_WORKERS_CONFIG ?? undefined,
  };
}

const shaFile = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export class WorkerServer {
  readonly config: WorkerServerConfig;
  readonly dir: string;
  private store: Store;
  private scheduler: DispatchScheduler;
  private costModel: CostModel;
  private quotas: QuotaTracker;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** The ONE blocking-wait primitive (BRA-65/66): get-job and tick
   * both park here. See wait-hub.ts. */
  private hub = new WaitHub();
  /** System events queued for the next tick call (BRA-65). A
   * notification, not the source of truth — the tick agent re-reads
   * state on wake. Capped (MAX_PENDING_EVENTS): when the tick agent
   * is dead and events keep arriving, the oldest drop (counted);
   * the state they describe is still on disk, so nothing is lost. */
  private events: SystemEvent[] = [];
  private droppedEvents = 0;
  /** At most one tick call may be pending at a time (a second is a
   * 409 — two tick agents is a real problem, and the 409 says so
   * loudly). */
  private tickPending = false;

  constructor(config: WorkerServerConfig) {
    this.config = config;
    this.dir = path.join(config.stateDir, "worker-jobs");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(path.join(this.dir, "notes"), { recursive: true });
    this.scheduler = new DispatchScheduler({
      affinityHoldMs: config.affinityHoldMs,
      affinityTtlMs: config.affinityTtlMs,
      agingMs: config.dispatchAgingMs,
    });
    this.costModel = CostModel.loadFromFile(this.costModelPath());
    this.quotas = QuotaTracker.fromJSON(this.loadQuotas());
    this.quotas.maxDecisionsPerSec = config.maxDecisionsPerSec;
    this.quotas.maxTokensPerHour = config.maxTokensPerHour;
    this.quotas.maxCpuSlots = config.maxCpuSlots;
    this.quotas.maxPoolSize = config.maxPoolSize;
    this.store = this.loadStore();
  }

  private costModelPath(): string {
    return path.join(this.dir, "cost-model.json");
  }
  private quotasPath(): string {
    return path.join(this.dir, "quotas.json");
  }
  private loadQuotas(): unknown {
    const p = this.quotasPath();
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }
  private saveQuotas(): void {
    try {
      fs.writeFileSync(this.quotasPath(), JSON.stringify(this.quotas.toJSON(), null, 2));
    } catch {
      /* quota persistence is best-effort */
    }
  }
  /** Live counts for quota checks, from the store (the source of
   * truth for what is running right now). */
  private liveCounts(): { running: number; cpuRunning: number } {
    let running = 0;
    let cpuRunning = 0;
    for (const j of Object.values(this.store.jobs)) {
      if (j.status !== "running") continue;
      running += 1;
      if (j.cpuHeavy) cpuRunning += 1;
    }
    return { running, cpuRunning };
  }

  // ------------------------------------------------------------ tick + events (BRA-65)
  /** Max system events held for the next tick call. Past this the
   * oldest drop (counted in droppedEvents); the state they describe
   * is on disk, so a drop delays a wake, never loses work. */
  static readonly MAX_PENDING_EVENTS = 500;

  /** Clamp a client-requested long-poll wait into [0, MAX]. A
   * missing/invalid value takes the default. */
  static clampLongPoll(raw: string | null, def: number): number {
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, Math.min(MAX_LONG_POLL_MS, Math.floor(n)));
  }

  /** Queue a system event for the next tick call and wake every
   * parked waiter (tick waiters drain the queue; get-job waiters
   * re-run selection — an event may have freed a quota slot or a
   * hold may have expired). */
  emitEvent(
    type: SystemEventType,
    detail: { runId?: string; jobId?: string; trapId?: string; detail?: unknown } = {},
  ): void {
    const ev: SystemEvent = { type, at: new Date().toISOString(), ...detail };
    this.events.push(ev);
    if (this.events.length > WorkerServer.MAX_PENDING_EVENTS) {
      const drop = this.events.length - WorkerServer.MAX_PENDING_EVENTS;
      this.events.splice(0, drop);
      this.droppedEvents += drop;
    }
    this.hub.notify();
  }

  /** Take the pending events for one tick response (null when none
   * are pending — the tick waiter keeps waiting). Consumes them:
   * each event is delivered to exactly one tick call. */
  private drainEvents(): SystemEvent[] | null {
    if (!this.events.length) return null;
    const evs = this.events;
    this.events = [];
    return evs;
  }

  /** Tick liveness, for the watchdog (BRA-65): <stateDir>/tick/
   * state.json, written atomically on every tick call and every
   * tick-beat. The watchdog restarts the tick agent when this goes
   * stale AND there is pending work. */
  tickStatePath(): string {
    return path.join(this.config.stateDir, "tick", "state.json");
  }
  private recordTick(eventCount: number): void {
    const p = this.tickStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let prev: { tickCount?: number } = {};
    try {
      prev = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      prev = {};
    }
    const state = {
      lastTickAt: new Date().toISOString(),
      tickCount: (typeof prev.tickCount === "number" ? prev.tickCount : 0) + 1,
      lastEventCount: eventCount,
    };
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
  }

  // ------------------------------------------------------------ persistence
  private storePath(): string {
    return path.join(this.dir, "store.json");
  }
  private jobsLogPath(): string {
    return path.join(this.dir, "jobs.log");
  }
  private schedulerLogPath(): string {
    return path.join(this.dir, "scheduler.log");
  }
  /** Previous good store (BRA-76 G7): saveStore backs the current
   * store.json up here — atomically, and only when it parses — so a
   * torn or externally corrupted store.json can be recovered. The
   * backup is at most one save behind the store. */
  storeBackupPath(): string {
    return path.join(this.dir, "store.json.bak");
  }
  /** Durable corruption log (BRA-76 G7): stateDir/corruption.log
   * (append-only JSONL, deduped) — the same log the Host writes
   * queue/journal corruption to (see corruption.ts). Lazily built:
   * the path needs config.stateDir. Best-effort: a failure to write
   * the log never fails the load. */
  private corruptionLogInstance: CorruptionLog | null = null;
  private corruptionLog(): CorruptionLog {
    if (!this.corruptionLogInstance) {
      this.corruptionLogInstance = new CorruptionLog(path.join(this.config.stateDir, "corruption.log"));
    }
    return this.corruptionLogInstance;
  }
  private recordCorruption(rec: CorruptionRecord): void {
    this.corruptionLog().append(rec);
  }
  /** Parse a store file: the parsed value must be an object with
   * jobs + workers maps, or the file is corrupt. Returns null on
   * any failure (missing file, unparseable JSON, wrong shape) with
   * the reason. Gates/seq are backfilled on stores written by an
   * older server; the per-job backfills live in backfillStore. */
  private parseStoreFile(p: string): { store: Store | null; reason: string | null } {
    if (!fs.existsSync(p)) return { store: null, reason: "missing" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return { store: null, reason: `unparseable JSON (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { store: null, reason: "parsed value is not a store object" };
    }
    const s = parsed as Store;
    if (
      !s.jobs ||
      typeof s.jobs !== "object" ||
      Array.isArray(s.jobs) ||
      !s.workers ||
      typeof s.workers !== "object" ||
      Array.isArray(s.workers)
    ) {
      return { store: null, reason: "parsed value is missing jobs/workers maps" };
    }
    if (!Array.isArray(s.gates)) s.gates = [];
    if (typeof s.seq !== "number") s.seq = 0;
    return { store: s, reason: null };
  }
  /** Backfill dispatch/lease fields on jobs written by an older
   * server (BRA-49, BRA-61). The store is the record; missing
   * fields must not crash selection. */
  private backfillStore(s: Store): void {
    for (const j of Object.values(s.jobs)) {
      if (typeof j.priority !== "number") j.priority = 3;
      if (typeof j.cpuHeavy !== "boolean") j.cpuHeavy = false;
      if (typeof j.isDecision !== "boolean") j.isDecision = false;
      if (typeof j.tokensEst !== "number") j.tokensEst = 0;
      if (typeof j.estDurationMs !== "number" && j.estDurationMs !== null) j.estDurationMs = null;
      if (typeof j.leaseSource !== "string") j.leaseSource = "default";
      if (typeof j.lastHeartbeatAt !== "number" && j.lastHeartbeatAt !== null) j.lastHeartbeatAt = null;
      if (typeof j.nudgedAt !== "number" && j.nudgedAt !== null) j.nudgedAt = null;
      if (typeof j.nudgeCount !== "number") j.nudgeCount = 0;
      if (typeof j.nudgeMessage !== "string" && j.nudgeMessage !== null) j.nudgeMessage = null;
      if (typeof j.requeueReason !== "string" && j.requeueReason !== null) j.requeueReason = null;
      // requeues backfills from attempts: the closest count an
      // older record carries (a job re-queued once has attempts 1;
      // a job that failed at maxAttempts may overcount by one —
      // history, not a live decision).
      if (typeof j.requeues !== "number") j.requeues = typeof j.attempts === "number" ? j.attempts : 0;
      if (typeof j.idempotent !== "boolean") j.idempotent = true;
    }
  }
  private loadStore(): Store {
    const p = this.storePath();
    const { store, reason } = this.parseStoreFile(p);
    if (store) {
      this.backfillStore(store);
      return store;
    }
    // No store file yet: first boot — an empty store is correct.
    if (reason === "missing") return { jobs: {}, workers: {}, gates: [], seq: 0 };
    // Corrupt store.json (BRA-76 G7): recover from the backup when
    // it parses, and say so loudly — the recovery is reported
    // (console + corruption.log), never silent. A backup is at most
    // one save behind, and a slightly stale store is exactly what
    // the 1s lease sweep + trapId enqueue dedupe re-derive from —
    // so recovering here is safe where silently returning {} was
    // not (that dropped every queued job and worker). Same
    // recover-from-backup / fail-loudly-only-if-backup-also-bad
    // decision as BRA-77's queue recovery (G5).
    const backup = this.parseStoreFile(this.storeBackupPath());
    if (backup.store) {
      // Restore the recovered store atomically. saveStore would
      // back the corrupt store.json up first — it only backs up a
      // store that parses, so the good backup is never clobbered —
      // but this.store is not assigned yet, so write the restore
      // directly instead of going through saveStore.
      atomicWriteFile(p, JSON.stringify(backup.store, null, 2));
      const at = new Date().toISOString();
      const jobCount = Object.keys(backup.store.jobs).length;
      this.recordCorruption({
        kind: "worker-store-recovered",
        file: "store.json",
        lineNo: 0,
        reason: `store.json is corrupt (${reason}) — recovered ${jobCount} job(s) from store.json.bak`,
        excerpt: reason ?? "corrupt",
        at,
      });
      console.warn(
        `CORRUPT WORKER STORE: store.json is corrupt (${reason}) — recovered ${jobCount} job(s) from store.json.bak; see ${path.join(this.config.stateDir, "corruption.log")}`,
      );
      this.backfillStore(backup.store);
      return backup.store;
    }
    // Both files corrupt (or the backup is missing): fail loudly.
    // Never return {} — that silently dropped the whole worker queue.
    throw new CorruptWorkerStoreError(
      `store.json is corrupt (${reason}) and store.json.bak is ${backup.reason === "missing" ? "missing" : `also corrupt (${backup.reason})`} — refusing to guess. ` +
        `Inspect ${p} and ${this.storeBackupPath()}, restore a known-good copy, or delete store.json to start with an empty worker store (that drops every queued job).`,
    );
  }
  private saveStore(): void {
    // Back the current store up first — but only when it parses.
    // A corrupt store.json must never clobber a good backup: the
    // backup is the recovery source, and loadStore depends on it.
    const current = this.parseStoreFile(this.storePath());
    if (current.store) {
      atomicWriteFile(this.storeBackupPath(), JSON.stringify(current.store, null, 2));
    }
    atomicWriteFile(this.storePath(), JSON.stringify(this.store, null, 2));
  }
  private logJob(event: string, job: Job, extra: Record<string, unknown> = {}): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      jobId: job.jobId,
      spec: job.spec,
      status: job.status,
      workerId: job.workerId,
      attempts: job.attempts,
      ...extra,
    });
    fs.appendFileSync(this.jobsLogPath(), line + "\n");
  }
  private logScheduler(workerId: string, decision: string, reason: string, jobId: string | null): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      workerId,
      decision,
      reason,
      jobId,
    });
    fs.appendFileSync(this.schedulerLogPath(), line + "\n");
  }

  // ------------------------------------------------------------ jobspecs
  private specFile(spec: string): string | null {
    const p = path.join(this.config.jobspecDir, `${spec}.md`);
    return fs.existsSync(p) ? p : null;
  }
  /** Content-addressed snapshot of one jobspec file (BRA-89): the
   * enqueue-time prose for a spec hash, under
   * <stateDir>/worker-jobs/jobspecs/<sha256>.md. A pool worker
   * re-reads its spec when the hash changes (worker-loop
   * ensureSpec); without the snapshot that re-read serves the
   * LIVE file, so a jobspec edited after enqueue changes what an
   * already-dispatched job's worker does. With it, GET /jobspec
   * with ?hash= serves the snapshot — the prose as enqueued.
   * Content-addressed, so a snapshot is written once and never
   * overwritten: two enqueues of the same hash share one file,
   * and a later edit (different hash) writes a different file. */
  private jobspecSnapshotPath(hash: string): string {
    return path.join(this.dir, "jobspecs", `${hash}.md`);
  }
  /** Snapshot the jobspec text for this hash, when a spec file
   * resolved. Best-effort is NOT an option here: the snapshot is
   * the guarantee, so a write failure fails the enqueue loudly
   * rather than silently leaving the pool on the live file. */
  private snapshotJobspec(specPath: string, specHash: string): void {
    const dest = this.jobspecSnapshotPath(specHash);
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    atomicWriteFile(dest, fs.readFileSync(specPath, "utf8"));
  }
  /** Jobspec metadata, read once per enqueue: path + sha256 (the
   * content-addressed cache key workers use) + the idempotency
   * policy (BRA-61). A spec declares
   * `<!-- idempotency: non-idempotent -->` anywhere in its file
   * when a re-queued attempt is NOT safe to re-run (side effects);
   * anything else — including no declaration and no spec file —
   * defaults to idempotent, which preserves the pre-BRA-61
   * re-queue behavior for every existing spec. */
  private specMeta(spec: string): { specPath: string | null; specHash: string | null; idempotent: boolean } {
    const p = this.specFile(spec);
    if (!p) return { specPath: null, specHash: null, idempotent: true };
    const text = fs.readFileSync(p, "utf8");
    const m = /idempotency:\s*(idempotent|non-idempotent)/i.exec(text);
    return {
      specPath: p,
      specHash: crypto.createHash("sha256").update(text).digest("hex"),
      idempotent: m ? m[1].toLowerCase() === "idempotent" : true,
    };
  }

  // ------------------------------------------------------------ workers
  private touchWorker(workerId: string, now: number): WorkerInfo {
    let w = this.store.workers[workerId];
    if (!w) {
      w = {
        id: workerId,
        lastSpec: null,
        lastCompletedAt: null,
        completedBySpec: {},
        completedAtBySpec: {},
        totalCompleted: 0,
        lastSeenAt: now,
      };
      this.store.workers[workerId] = w;
    }
    w.lastSeenAt = now;
    return w;
  }
  /** The warm affinity worker for a spec: most recent completer
   * within the TTL, or null. Ties (same ms) break by higher count,
   * then by worker id for determinism. */
  private affinityWorkerFor(spec: string, now: number): string | null {
    let best: WorkerInfo | null = null;
    for (const w of Object.values(this.store.workers)) {
      const at = w.completedAtBySpec[spec];
      if (typeof at !== "number" || now - at > this.config.affinityTtlMs) continue;
      if (
        !best ||
        at > (best.completedAtBySpec[spec] ?? 0) ||
        (at === (best.completedAtBySpec[spec] ?? 0) &&
          (w.completedBySpec[spec] ?? 0) > (best.completedBySpec[spec] ?? 0)) ||
        (at === (best.completedAtBySpec[spec] ?? 0) &&
          (w.completedBySpec[spec] ?? 0) === (best.completedBySpec[spec] ?? 0) &&
          w.id < best.id)
      ) {
        best = w;
      }
    }
    return best ? best.id : null;
  }

  // ------------------------------------------------------------ lease sweep
  /** Nudge one running job that has passed its nudge point with no
   * completion yet (BRA-61): once per attempt, when its age passes
   * NUDGE_FRACTION of its lease. The nudge is a warning shot, not a
   * punishment — it fires for a silent worker (no heartbeat since
   * assignment, lease about to expire) and for a heartbeating worker
   * running long past its estimate (still alive, still not done).
   * Delivery is threefold: the record (nudgeMessage, read back on
   * the worker's next heartbeat), jobs.log, and a "job-nudged" tick
   * event — the tick agent / coordinator is the layer that can
   * actually message a subagent session, so the event is what lets
   * a human or agent reach the worker. Returns true when it fired. */
  private nudgeJob(job: Job, now: number): boolean {
    if (job.status !== "running" || job.nudgedAt !== null) return false;
    if (typeof job.assignedAt !== "number") return false;
    if (now - job.assignedAt < job.leaseMs * NUDGE_FRACTION) return false;
    const silentMs = now - (job.lastHeartbeatAt ?? job.assignedAt);
    const message =
      `job ${job.jobId} spec "${job.spec}" has run ${now - job.assignedAt}ms with no completion ` +
      `(lease ${job.leaseMs}ms, silent ${silentMs}ms) — reply with your status (heartbeat with a note) ` +
      `or complete it; if you stay silent the lease expires and the job is re-queued to another worker` +
      (job.idempotent ? "" : ` — this spec is non-idempotent, so on expiry it FAILS instead of re-queuing`);
    job.nudgedAt = now;
    job.nudgeCount += 1;
    job.nudgeMessage = message;
    this.logJob("job-nudged", job, { silentMs, leaseMs: job.leaseMs, message });
    this.emitEvent("job-nudged", {
      jobId: job.jobId,
      runId: job.runId,
      trapId: job.trapId,
      detail: { silentMs, leaseMs: job.leaseMs, workerId: job.workerId, message },
    });
    return true;
  }

  /** Re-queue expired running jobs (or fail them at max attempts).
   * Called on every request and once a second. An expiry is a tick
   * event (BRA-65: a stuck worker wakes the tick agent) and wakes
   * every parked waiter (a re-queued job is assignable again).
   * Idempotency (BRA-61): a non-idempotent job is NEVER silently
   * re-run — on lease expiry it FAILS with a JobNotRetried error
   * naming the policy, so the coordinator/human decides instead of
   * the pool repeating a side effect. */
  sweepLeases(now = Date.now()): void {
    let changed = false;
    for (const job of Object.values(this.store.jobs)) {
      if (job.status !== "running") continue;
      if (this.nudgeJob(job, now)) changed = true;
      if (job.leaseUntil === null || job.leaseUntil > now) continue;
      job.attempts += 1;
      job.requeues += 1;
      const expiredWorker = job.workerId;
      job.workerId = null;
      job.leaseUntil = null;
      if (!job.idempotent) {
        job.status = "failed";
        job.completedAt = now;
        job.error = {
          name: "JobNotRetried",
          message: `job ${job.jobId} spec "${job.spec}" failed: lease expired with no completion (last worker ${expiredWorker ?? "unknown"}) and the spec is non-idempotent — it was NOT re-queued, because a retry may repeat a side effect; escalate to the coordinator/human`,
        };
        this.logJob("job-failed", job, { reason: "lease-expired-non-idempotent", lastWorker: expiredWorker });
        this.emitEvent("job-failed", {
          jobId: job.jobId,
          runId: job.runId,
          trapId: job.trapId,
          detail: { error: job.error, reason: "lease-expired-non-idempotent", lastWorker: expiredWorker ?? null },
        });
      } else if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.completedAt = now;
        job.error = {
          name: "JobFailed",
          message: `job ${job.jobId} spec "${job.spec}" failed: lease expired ${job.attempts} time(s) with no completion (last worker ${expiredWorker ?? "unknown"})`,
        };
        this.logJob("job-failed", job, { reason: "lease-expired", lastWorker: expiredWorker });
      } else {
        job.status = "queued";
        job.assignedAt = null;
        job.requeueReason = "lease-expired";
        this.logJob("job-timeout-requeue", job, { reason: "lease-expired", lastWorker: expiredWorker });
      }
      changed = true;
      this.emitEvent("lease-expired", {
        jobId: job.jobId,
        runId: job.runId,
        trapId: job.trapId,
        detail: { attempts: job.attempts, status: job.status, lastWorker: expiredWorker ?? null },
      });
    }
    if (changed) {
      this.saveStore();
      this.hub.notify();
    }
  }

  // ------------------------------------------------------------ handlers
  private enqueue(body: any): { status: number; body: unknown } {
    const spec = body?.spec;
    if (typeof spec !== "string" || !spec) {
      return { status: 400, body: { error: "enqueue requires a string spec" } };
    }
    // G3 (BRA-75): trapId-keyed enqueue idempotency. A trapId names
    // one trap execution (runId/trap-N, Q9). If a job already exists
    // for this trapId, the host crashed mid-dispatch and is
    // re-dispatching — return the existing job instead of creating
    // a second one, or the work runs twice and the first result is
    // orphaned. Any status dedupes: a live job is adopted and
    // waited for; a terminal job's result/error is returned as-is.
    // The spec must match — a trapId with a different spec is a
    // trapId collision (a host bug), so fall through to a fresh job
    // rather than adopting the wrong work, and make it visible.
    if (typeof body?.trapId === "string" && body.trapId) {
      const existing = Object.values(this.store.jobs).find((j) => j.trapId === body.trapId);
      if (existing && existing.spec === spec) {
        this.logJob("job-enqueue-deduped", existing);
        return { status: 200, body: { jobId: existing.jobId, status: existing.status, deduped: true } };
      }
      if (existing) {
        this.logJob("job-enqueue-trapId-collision", existing, { requestedSpec: spec });
      }
    }
    const now = Date.now();
    this.store.seq += 1;
    const jobId = `job-${this.store.seq}-${now.toString(36)}`;
    const { specPath, specHash, idempotent } = this.specMeta(spec);
    // BRA-89: snapshot the enqueue-time jobspec prose (see
    // snapshotJobspec) — a pool worker's re-read must serve the
    // prose as enqueued, not the live file. The host's trap-code
    // pin refuses LATER dispatches when the prose changes; the
    // snapshot covers the job ALREADY dispatched.
    if (specPath && specHash) this.snapshotJobspec(specPath, specHash);
    const priority =
      typeof body?.priority === "number" && body.priority >= 1 && body.priority <= 4
        ? Math.floor(body.priority)
        : 3;
    const est = this.costModel.estimate(`job:${spec}`);
    // Cost-derived lease (BRA-61): an explicit per-enqueue lease
    // wins; otherwise the lease is the cost-model p90 for this spec
    // times LEASE_P90_MULTIPLIER, clamped into [MIN, MAX] — a long
    // job is not killed at 5 minutes and a short one does not hold
    // a slot for 5. With no recorded actuals the server default
    // applies (leaseSource "default", not a guess).
    let leaseMs: number;
    let leaseSource: "explicit" | "cost-model" | "default";
    if (typeof body?.leaseMs === "number" && body.leaseMs > 0) {
      leaseMs = Math.floor(body.leaseMs);
      leaseSource = "explicit";
    } else if (est) {
      leaseMs = Math.max(
        DEFAULT_LEASE_MIN_MS,
        Math.min(DEFAULT_LEASE_MAX_MS, Math.round(est.p90Ms * LEASE_P90_MULTIPLIER)),
      );
      leaseSource = "cost-model";
    } else {
      leaseMs = this.config.leaseMs;
      leaseSource = "default";
    }
    const job: Job = {
      jobId,
      spec,
      specPath,
      specHash,
      input: body?.input ?? null,
      runId: typeof body?.runId === "string" ? body.runId : "",
      trapId: typeof body?.trapId === "string" ? body.trapId : "",
      priority,
      cpuHeavy: body?.cpuHeavy === true,
      isDecision: body?.isDecision === true,
      tokensEst:
        typeof body?.tokensEst === "number" && Number.isFinite(body.tokensEst) && body.tokensEst > 0
          ? Math.floor(body.tokensEst)
          : 0,
      estDurationMs: est ? Math.round(est.meanMs) : null,
      workspace: typeof body?.workspace === "string" ? body.workspace : null,
      status: "queued",
      workerId: null,
      attempts: 0,
      maxAttempts:
        typeof body?.maxAttempts === "number" && body.maxAttempts >= 1 ? Math.floor(body.maxAttempts) : this.config.maxAttempts,
      leaseMs,
      leaseSource,
      leaseUntil: null,
      lastHeartbeatAt: null,
      nudgedAt: null,
      nudgeCount: 0,
      nudgeMessage: null,
      requeueReason: null,
      requeues: 0,
      idempotent,
      enqueuedAt: now,
      assignedAt: null,
      completedAt: null,
    };
    this.store.jobs[jobId] = job;
    this.saveStore();
    this.logJob("job-enqueued", job);
    // A new job may satisfy a worker parked in a long-poll get-job.
    this.hub.notify();
    return { status: 200, body: { jobId, status: "queued" as JobStatus } };
  }

  /**
   * One selection+assignment attempt (BRA-66): the check the
   * long-poll get-job re-runs on every notify(). Pure on the null
   * path — selection reads state only, and no scheduler decision is
   * logged there (a parked wait re-checks every second; logging
   * each re-check would spam scheduler.log). On the success path it
   * assigns the job (status running + lease), records the quota
   * dispatch, and persists — atomically, because the check runs
   * synchronously inside the hub's notify() and JS is
   * single-threaded. The caller logs the outcome once, from the
   * returned decision/reason/blocked list.
   */
  private tryAssignJob(workerId: string): {
    assignment: JobAssignment | null;
    decision: string;
    reason: string;
    blocked: Array<{ jobId: string; detail: string }>;
  } {
    const now = Date.now();
    if (!this.store.workers[workerId]) {
      return { assignment: null, decision: "none-available", reason: `unknown worker ${workerId}`, blocked: [] };
    }
    // Fresh estimates at selection time: actuals recorded since
    // enqueue may have changed the cost of a queued spec.
    const queued = Object.values(this.store.jobs)
      .filter((j) => j.status === "queued")
      .map((j) => {
        const est = this.costModel.estimate(`job:${j.spec}`);
        return {
          jobId: j.jobId,
          spec: j.spec,
          enqueuedAt: j.enqueuedAt,
          priority: j.priority,
          estDurationMs: est ? Math.round(est.meanMs) : j.estDurationMs,
          cpuHeavy: j.cpuHeavy,
          isDecision: j.isDecision,
          tokensEst: j.tokensEst,
        };
      });
    const worker = this.store.workers[workerId];
    const workerView = {
      id: worker.id,
      lastSpec: worker.lastSpec,
      lastCompletedAt: worker.lastCompletedAt,
      completedAtBySpec: worker.completedAtBySpec,
    };
    const affinityFor = (spec: string): string | null => this.affinityWorkerFor(spec, now);
    // Dispatch loop: the scheduler picks, quotas vet the pick. A
    // blocked pick is excluded and selection re-runs, so one blocked
    // job never starves the queue behind it. The loop is bounded by
    // the queue size; each iteration excludes at least one job.
    const excluded = new Set<string>();
    const blocked: Array<{ jobId: string; detail: string }> = [];
    let sel = this.scheduler.selectJobForWorker(
      workerView,
      queued.filter((j) => !excluded.has(j.jobId)),
      now,
      affinityFor,
    );
    while (sel.job) {
      const job = this.store.jobs[sel.job.jobId];
      const check = this.quotas.check(
        { isDecision: job.isDecision, cpuHeavy: job.cpuHeavy, tokensEst: job.tokensEst },
        this.liveCounts(),
        now,
      );
      if (check.allowed) break;
      excluded.add(job.jobId);
      blocked.push({ jobId: job.jobId, detail: `${check.reason}: ${check.detail}` });
      sel = this.scheduler.selectJobForWorker(
        workerView,
        queued.filter((j) => !excluded.has(j.jobId)),
        now,
        affinityFor,
      );
    }
    if (!sel.job) {
      if (excluded.size > 0) {
        return {
          assignment: null,
          decision: "none-quota",
          reason: `all ${excluded.size} candidate(s) quota-blocked`,
          blocked,
        };
      }
      return { assignment: null, decision: sel.decision, reason: sel.reason, blocked };
    }
    const job = this.store.jobs[sel.job.jobId];
    this.quotas.recordDispatch(
      { isDecision: job.isDecision, cpuHeavy: job.cpuHeavy, tokensEst: job.tokensEst },
      now,
    );
    this.saveQuotas();
    job.status = "running";
    job.workerId = workerId;
    job.assignedAt = now;
    job.leaseUntil = now + job.leaseMs;
    // A new attempt is a fresh lease: the worker is alive at
    // assignment (lastHeartbeatAt = assignedAt), the nudge state
    // resets (the new worker gets its own warning shot). nudgeCount
    // is cumulative across attempts — jobs.log is the per-attempt
    // history. requeueReason is NOT cleared: it is the history of
    // the last re-queue, and a poll that arrives after the retry
    // still needs it to name the re-queue (BRA-61).
    job.lastHeartbeatAt = now;
    job.nudgedAt = null;
    job.nudgeMessage = null;
    this.saveStore();
    const assignment: JobAssignment = {
      jobId: job.jobId,
      spec: job.spec,
      specPath: job.specPath,
      specHash: job.specHash,
      input: job.input,
      runId: job.runId,
      trapId: job.trapId,
      workspace: job.workspace,
      attempt: job.attempts + 1,
      leaseMs: job.leaseMs,
      leaseUntil: job.leaseUntil,
    };
    return { assignment, decision: sel.decision, reason: sel.reason, blocked };
  }

  /**
   * get-job, blocking (BRA-66): the call parks in the wait hub
   * until a job is assignable to this worker, or waitMs expires.
   * waitMs defaults to 60s (DEFAULT_GET_JOB_WAIT_MS); waitMs=0 is
   * the old immediate return. The selection re-runs on every
   * notify (enqueue, completion, lease expiry, the 1s sweep) — a
   * worker neither spins when idle nor waits out a poll interval
   * when a job arrives. The outcome is logged ONCE here, not in
   * the check: a parked wait re-checks every second, and logging
   * each re-check would spam scheduler.log.
   */
  private async getJob(url: URL, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const workerId = url.searchParams.get("workerId") ?? "";
    if (!workerId) return { status: 400, body: { error: "get-job requires ?workerId=" } };
    const waitMs = WorkerServer.clampLongPoll(url.searchParams.get("waitMs"), DEFAULT_GET_JOB_WAIT_MS);
    const now = Date.now();
    this.sweepLeases(now);
    this.touchWorker(workerId, now);
    this.saveStore();
    let last: { decision: string; reason: string; blocked: Array<{ jobId: string; detail: string }> } = {
      decision: "none-available",
      reason: "queue empty",
      blocked: [],
    };
    const assignment = await this.hub.waitFor(
      () => {
        const r = this.tryAssignJob(workerId);
        last = { decision: r.decision, reason: r.reason, blocked: r.blocked };
        return r.assignment;
      },
      waitMs,
      signal,
    );
    // The caller disconnected mid-wait (the waiter was unregistered
    // and nothing was assigned to it): say nothing more — logging
    // a "none-available" for a dead caller is noise, and the
    // response goes nowhere anyway.
    if (signal?.aborted) return { status: 200, body: { job: null } };
    for (const b of last.blocked) {
      this.logScheduler(workerId, "quota-blocked", b.detail, b.jobId);
    }
    if (!assignment) {
      if (last.blocked.length) {
        this.logScheduler(
          workerId,
          "none-quota",
          `all ${last.blocked.length} candidate(s) quota-blocked: ${last.blocked.map((b) => b.detail).join("; ")}`,
          null,
        );
      } else {
        this.logScheduler(workerId, last.decision, last.reason, null);
      }
      return { status: 200, body: { job: null } };
    }
    this.logScheduler(workerId, last.decision, last.reason, assignment.jobId);
    const job = this.store.jobs[assignment.jobId];
    this.logJob("job-assigned", job, { decision: last.decision });
    return { status: 200, body: { job: assignment } };
  }

  /** Record a terminal job's wall duration as a cost-model actual
   * for `job:<spec>` (assignedAt -> completedAt, real ms). The
   * model is the scheduler's estimate source for the next dispatch. */
  private recordJobActual(job: Job, now: number): void {
    if (typeof job.assignedAt === "number" && now >= job.assignedAt) {
      this.costModel.record({ site: `job:${job.spec}`, ms: now - job.assignedAt, runId: job.runId, trapId: job.trapId });
      this.costModel.saveToFile(this.costModelPath());
    }
  }

  private completeJob(body: any): { status: number; body: unknown } {
    const jobId = body?.jobId;
    const workerId = body?.workerId;
    if (typeof jobId !== "string" || typeof workerId !== "string") {
      return { status: 400, body: { error: "complete-job requires jobId and workerId" } };
    }
    const now = Date.now();
    const job = this.store.jobs[jobId];
    if (!job) return { status: 404, body: { error: `no job ${jobId}` } };
    if (job.status === "cancelled") {
      return { status: 409, body: { error: `job ${jobId} was cancelled`, status: job.status } };
    }
    if (job.status !== "running" || job.workerId !== workerId) {
      this.logJob("job-complete-rejected", job, {
        reason: "not-assigned-to-this-worker",
        byWorker: workerId,
      });
      return {
        status: 409,
        body: {
          error: `job ${jobId} is ${job.status} (assigned to ${job.workerId ?? "nobody"}), not running for ${workerId} — late completion ignored`,
          status: job.status,
        },
      };
    }
    // Lease may have expired between assignment and completion; the
    // sweep runs on every request, so an expired lease would already
    // have re-queued the job and the status check above would have
    // rejected this. A completion inside the lease is on time.
    const files: FileEffect[] | undefined = Array.isArray(body?.files)
      ? (body.files as FileEffect[]).filter((f) => typeof f?.path === "string" && typeof f?.content === "string")
      : undefined;
    if (files) {
      let bytes = 0;
      for (const f of files) bytes += Buffer.byteLength(f.content, "utf8");
      if (bytes > MAX_FILE_EFFECT_BYTES) {
        return {
          status: 400,
          body: { error: `file effects ${bytes} bytes exceed the ${MAX_FILE_EFFECT_BYTES} byte cap — return fewer/smaller files` },
        };
      }
      job.files = files;
    }
    const worker = this.touchWorker(workerId, now);
    if (body && "error" in body && body.error !== undefined && body.error !== null) {
      const err = body.error as any;
      const record = {
        name: typeof err?.name === "string" ? err.name : "JobError",
        message: typeof err?.message === "string" ? err.message : String(err),
      };
      job.attempts += 1;
      if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.completedAt = now;
        job.error = record;
        job.workerId = workerId;
        job.leaseUntil = null;
        this.recordJobActual(job, now);
        this.saveStore();
        this.logJob("job-failed", job, { reason: "worker-error" });
        // A terminal job wakes the tick agent (BRA-65: a job
        // completing/failing is a wake event — the run it belonged
        // to may now be drivable to completion or failure).
        this.emitEvent("job-failed", {
          jobId,
          runId: job.runId,
          trapId: job.trapId,
          detail: { error: record },
        });
        return { status: 200, body: { ok: true, status: "failed" as JobStatus } };
      }
      job.status = "queued";
      job.workerId = null;
      job.assignedAt = null;
      job.leaseUntil = null;
      job.error = record;
      job.requeues += 1;
      job.requeueReason = "worker-error";
      this.saveStore();
      this.logJob("job-error-requeue", job, { reason: "worker-error" });
      // The job is assignable again — wake parked get-job waiters.
      this.hub.notify();
      return { status: 200, body: { ok: true, status: "queued" as JobStatus } };
    }
    job.status = "completed";
    job.completedAt = now;
    job.leaseUntil = null;
    job.result = body?.result ?? null;
    this.recordJobActual(job, now);
    this.saveStore();
    // Affinity history: the completion is what makes this worker the
    // specialist for this spec until the TTL (warmth) expires.
    worker.lastSpec = job.spec;
    worker.lastCompletedAt = now;
    worker.completedBySpec[job.spec] = (worker.completedBySpec[job.spec] ?? 0) + 1;
    worker.completedAtBySpec[job.spec] = now;
    worker.totalCompleted += 1;
    this.saveStore();
    this.logJob("job-completed", job, { files: job.files?.length ?? 0 });
    // A completed job wakes the tick agent (BRA-65) and may free a
    // quota slot for a parked get-job waiter.
    this.emitEvent("job-completed", { jobId, runId: job.runId, trapId: job.trapId });
    return { status: 200, body: { ok: true, status: "completed" as JobStatus } };
  }

  /** Heartbeat: extend the lease by leaseMs from now. The response
   * also carries a pending nudge (BRA-61) — the delivery channel to
   * a worker that is still talking. A nudge is delivered once: the
   * heartbeat that carries it clears nudgeMessage (nudgedAt /
   * nudgeCount stay as the record). A heartbeat is also proof of
   * life: it updates lastHeartbeatAt, so a heartbeating worker is
   * never "silent" — only long-running, which the nudge already
   * named. */
  private heartbeat(body: any): { status: number; body: unknown } {
    const jobId = body?.jobId;
    const workerId = body?.workerId;
    if (typeof jobId !== "string" || typeof workerId !== "string") {
      return { status: 400, body: { error: "heartbeat requires jobId and workerId" } };
    }
    const now = Date.now();
    const job = this.store.jobs[jobId];
    if (!job) return { status: 404, body: { error: `no job ${jobId}` } };
    if (job.status === "cancelled") return { status: 200, body: { ok: true, cancelled: true } };
    if (job.status !== "running" || job.workerId !== workerId) {
      return {
        status: 409,
        body: { error: `job ${jobId} is ${job.status}, not running for ${workerId}`, status: job.status },
      };
    }
    job.leaseUntil = now + job.leaseMs;
    job.lastHeartbeatAt = now;
    this.touchWorker(workerId, now);
    // Deliver a pending nudge exactly once, with this heartbeat.
    let nudge: { message: string; at: number } | null = null;
    if (job.nudgeMessage !== null && job.nudgedAt !== null) {
      nudge = { message: job.nudgeMessage, at: job.nudgedAt };
      job.nudgeMessage = null;
    }
    this.saveStore();
    return { status: 200, body: { ok: true, cancelled: false, leaseUntil: job.leaseUntil, ...(nudge ? { nudge } : {}) } };
  }

  private cancelJob(body: any): { status: number; body: unknown } {
    const jobId = body?.jobId;
    if (typeof jobId !== "string") return { status: 400, body: { error: "cancel-job requires jobId" } };
    const now = Date.now();
    const job = this.store.jobs[jobId];
    if (!job) return { status: 404, body: { error: `no job ${jobId}` } };
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return { status: 200, body: { ok: true, status: job.status, note: "already terminal" } };
    }
    job.status = "cancelled";
    job.completedAt = now;
    job.leaseUntil = null;
    job.cancelReason = typeof body?.reason === "string" ? body.reason : "cancelled";
    this.saveStore();
    this.logJob("job-cancelled", job, { reason: job.cancelReason });
    // A cancelled job may free a quota slot for a parked waiter.
    this.hub.notify();
    return { status: 200, body: { ok: true, status: "cancelled" as JobStatus } };
  }

  private jobStatus(url: URL): { status: number; body: unknown } {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = this.store.jobs[jobId];
    if (!job) return { status: 404, body: { error: `no job ${jobId}` } };
    this.sweepLeases();
    return { status: 200, body: this.store.jobs[jobId] };
  }

  // ------------------------------------------------------------ driver (BRA-116)
  /** One driver Host per request (see makeDriverHost in host.ts): a
   * fresh Host loads current disk state, exactly like the CLI's
   * `queue run` does. */
  private driverHost(): Promise<Host> {
    // The driver Host notifies in-process (BRA-116): its events
    // land in this server's own queue via emitEvent, instead of a
    // synchronous HTTP POST to itself that would block this
    // server's event loop for its whole 2s timeout per terminal
    // drive — and lose the event.
    // BRA-111: the driver also carries the server's workers-config
    // (see serverConfigFromArgs), so queue drives honor it.
    return makeDriverHost(this.config.stateDir, {
      onEvent: (type, detail) => this.emitEvent(type, detail),
      workersConfigPath: this.config.workersConfigPath,
    });
  }

  /** Drive the queue in a CHILD process (`agentts queue run`),
   * mirroring cmdQueue "run" exactly: runQueue — which repairs
   * stranded entries under the driver lock — then the --task sync
   * for terminal runs. A live driver holding the lock is a 409.
   *
   * BRA-175: the drive used to run in a Host inside this process
   * (driverHost), and that deadlocked on any muse-adapter run:
   * driveToCompletion is fully synchronous, so the server's event
   * loop is blocked for the whole drive — and the muse adapter's
   * sync calls to this server (/health in ensureServer, /enqueue,
   * /job-status polling) are synchronous curl spawns against that
   * blocked loop, so they all time out (ensureServer throws after
   * 2s). A child driver leaves this process's loop free, so the
   * pool path works exactly as the CLI path does. The other
   * driverHost() call sites (deliver-result, queue list,
   * deliveries, escalate, deliver-gate) only read state or write
   * records — they never dispatch a job, so they stay in-process
   * and keep the BRA-116 in-process event delivery.
   *
   * The child's repair report comes back via --repair-report (a
   * JSON file the child writes after runQueue returns); the entries
   * are re-read from queue.json after the child exits, and the
   * --task sync runs here against a fresh driver Host (for journal
   * reads) — the child already syncs too, and syncRunToTask is
   * idempotent (it rewrites the same derived status). The CLI
   * exits 1 both for "a live driver holds the lock" and for "some
   * run failed", so the exit code alone cannot tell them apart: a
   * REFUSED: line on the child's stderr means the lock (409).
   * A missing repair file means the child died before runQueue
   * returned — the drive never completed (500). */
  private async driveQueue(): Promise<{ status: number; body: unknown }> {
    const reportPath = path.join(
      process.env.TMPDIR ?? os.tmpdir(),
      `agentts-driver-repair-${process.pid}-${crypto.randomUUID()}.json`,
    );
    const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), "cli.ts");
    const args = [cliPath, "queue", "run", "--state-dir", this.config.stateDir, "--repair-report", reportPath];
    // BRA-111 (trial runner, Nov 19): the driver child needs a direct
    // adapter to CARRY the workers-config — makeHost refuses a
    // workers-config on any other adapter, and without --adapter the
    // child defaults to mock on a scratch state dir, so the drive
    // died before runQueue ever ran ("--workers-config applies to
    // the direct adapter, not \"mock\""). The driver's own adapter is
    // only the carrier: per-entry adapters are still loaded fresh
    // from each queue entry, so mock/muse entries are unaffected.
    // (BRA-175's child-process drive regressed this path — the old
    // in-process driverHost() carried the config without re-parsing
    // CLI args, so no trial had exercised it since.)
    if (this.config.workersConfigPath) args.push("--workers-config", this.config.workersConfigPath, "--adapter", "direct");
    const proc = Bun.spawn([BUN, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    // Drain both pipes while the child runs: an unread pipe can
    // block the child once it fills (its per-entry lines are small,
    // but never trust that).
    const stdoutP = new Response(proc.stdout).text().catch(() => "");
    const stderrP = new Response(proc.stderr).text().catch(() => "");
    const exitCode = await proc.exited;
    const stderr = await stderrP;
    await stdoutP;
    if (stderr.includes("REFUSED:")) {
      try {
        fs.unlinkSync(reportPath);
      } catch {
        /* never written */
      }
      return { status: 409, body: { error: stderr.trim().slice(0, 500) } };
    }
    let repair: unknown = null;
    try {
      repair = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch {
      repair = null;
    }
    try {
      fs.unlinkSync(reportPath);
    } catch {
      /* never written */
    }
    if (repair === null || typeof repair !== "object" || !Array.isArray((repair as any).actions)) {
      return {
        status: 500,
        body: { error: `queue drive failed (child exit ${exitCode}): ${(stderr.trim() || "no repair report and no stderr").slice(0, 500)}` },
      };
    }
    // Re-read the queue from disk: the child drove it, this process
    // only reads the result. A fresh driver Host loads current disk
    // state (its construction dispatches nothing).
    const host = await this.driverHost();
    const q = host.readQueue();
    // --task sync, as cmdQueue "run" does it: a terminal run with a
    // taskId syncs to the task backend, or the task never learns the
    // run completed.
    for (const e of q) {
      if (e.taskId && (e.status === "done" || e.status === "failed")) {
        const backend = new LocalTaskBackend(host.stateDir);
        await backend.setTaskRun(e.taskId, e.runId);
        await syncRunToTask(backend, e.taskId, e.runId, host.journal(e.runId));
      }
    }
    return {
      status: 200,
      body: {
        entries: q,
        repair,
        failed: q.some((e) => e.status === "failed"),
      },
    };
  }

  /** A run exists in this state dir when it has a queue entry, a
   * registry entry, or a journal. Shared by deliverResult and
   * ingestEvent (BRA-133) — one check and one 404 text, so the two
   * sites cannot drift. A journal alone counts: a run whose queue
   * entry is gone (delivered, repaired) still has its journal on
   * disk, so only a run this state dir has never seen fails. */
  private runExists(host: Host, runId: string): boolean {
    return (
      host.readQueue().some((e) => e.runId === runId) ||
      host.registryHas(runId) ||
      host.journal(runId).length > 0
    );
  }

  /** Deliver one run's result, mirroring `agentts deliver-result`:
   * the outbox record for a terminal run. Unknown runId is a 404;
   * a run that is not terminal yet is a 400 (there is nothing to
   * deliver) — both loud, never a silent empty record. `deliveredBy`
   * is optional (default "tick-agent", as the CLI); the test
   * standin passes its own name so the record names the driver. */
  private async deliverResult(body: any): Promise<{ status: number; body: unknown }> {
    const runId = body?.runId;
    if (typeof runId !== "string" || !runId) {
      return { status: 400, body: { error: "deliver-result requires a runId" } };
    }
    const host = await this.driverHost();
    if (!this.runExists(host, runId)) return { status: 404, body: { error: `no run ${runId} in ${host.stateDir}` } };
    try {
      const record = host.recordDelivery(
        runId,
        typeof body?.deliveredBy === "string" ? body.deliveredBy : "tick-agent",
      );
      return { status: 200, body: record };
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  /** Queue list / deliveries, mirroring `agentts queue list` and
   * `agentts deliveries --json`: the current queue entries and the
   * outbox records, as JSON. */
  private async queueList(): Promise<{ status: number; body: unknown }> {
    const host = await this.driverHost();
    return { status: 200, body: { entries: host.readQueue() } };
  }
  private async deliveries(): Promise<{ status: number; body: unknown }> {
    const host = await this.driverHost();
    return { status: 200, body: { deliveries: host.listDeliveries() } };
  }

  /** Escalate, mirroring `agentts escalate '<json>'`: kind + a
   * non-empty reason are required (400 otherwise); the record lands
   * in <stateDir>/escalations/ and the watchdog surfaces it. */
  private async escalate(body: any): Promise<{ status: number; body: unknown }> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: 400, body: { error: `escalate: expected a JSON object {"kind","runId"?,"reason","detail"?}` } };
    }
    const rec = body as { kind?: unknown; runId?: unknown; reason?: unknown; detail?: unknown };
    if (typeof rec.kind !== "string" || typeof rec.reason !== "string" || !rec.reason) {
      return { status: 400, body: { error: "escalate: requires a kind and a non-empty reason" } };
    }
    const host = await this.driverHost();
    try {
      const p = host.writeEscalation({
        kind: rec.kind as "gate-held" | "stuck-running" | "other",
        ...(typeof rec.runId === "string" ? { runId: rec.runId } : {}),
        reason: rec.reason,
        ...(rec.detail !== undefined ? { detail: rec.detail } : {}),
      });
      return { status: 200, body: { path: p } };
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  /** Deliver a gate answer, mirroring `agentts deliver-gate`: the
   * answer is queued for the run's next gate trap and a held entry
   * is re-queued, so the next drive resumes it. No suspended run
   * is a 404 (the CLI's "no suspended run" refusal); no gate
   * pending is a 400. The answer is any JSON value — including null
   * — so presence is checked by key, not by truthiness. */
  private async deliverGate(body: any): Promise<{ status: number; body: unknown }> {
    const runId = body?.runId;
    if (typeof runId !== "string" || !runId || !body || !("answer" in body)) {
      return { status: 400, body: { error: "deliver-gate requires a runId and an answer" } };
    }
    const host = await this.driverHost();
    if (!host.registryHas(runId)) {
      return { status: 404, body: { error: `no suspended run ${runId} in ${host.stateDir}` } };
    }
    try {
      host.deliverGate(runId, body.answer);
      return { status: 200, body: { ok: true, runId } };
    } catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  // ------------------------------------------------------------ tick (BRA-65)
  /**
   * The tick agent's blocking long-poll. Holds until a system event
   * arrives or timeoutMs fires (default 60s, max 120s). Events
   * already queued return at once; otherwise the call parks in the
   * wait hub (the SAME primitive get-job uses — one mechanism, not
   * two). At most one tick call may be pending: a second concurrent
   * call is a 409, because two tick agents driving one queue is a
   * real problem (G13) and the 409 says so loudly. Every tick call
   * — and every tick-beat — refreshes the liveness file the
   * watchdog reads; a tick agent that stops calling is presumed
   * dead once the file goes stale.
   */
  private async tick(url: URL, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const timeoutMs = WorkerServer.clampLongPoll(url.searchParams.get("timeoutMs"), DEFAULT_TICK_TIMEOUT_MS);
    if (this.tickPending) {
      return {
        status: 409,
        body: {
          error:
            "a tick call is already pending (another tick agent may be running) — wait a few seconds and retry; if this persists, escalate: two tick agents must not drive one queue",
        },
      };
    }
    this.recordTick(0);
    this.tickPending = true;
    try {
      // The request signal aborts when the tick client disconnects:
      // the waiter is unregistered (BRA-81) and the slot is freed
      // by the finally, so a dead tick agent holds it for no longer
      // than the time its client was actually connected.
      const events = await this.hub.waitFor(() => this.drainEvents(), timeoutMs, signal);
      const delivered = events ?? [];
      this.recordTick(delivered.length);
      return {
        status: 200,
        body: { events: delivered, timedOut: events === null, at: new Date().toISOString() },
      };
    } finally {
      this.tickPending = false;
    }
  }

  /** Liveness heartbeat for a tick agent acting between ticks (a
   * long queue drive is not a tick call, so the agent beats while
   * it acts — otherwise the watchdog would presume it dead
   * mid-drive). Refreshes the same liveness file tick() writes. */
  private tickBeat(): { status: number; body: unknown } {
    this.recordTick(0);
    let lastTickAt: string | null = null;
    try {
      lastTickAt = (JSON.parse(fs.readFileSync(this.tickStatePath(), "utf8")) as any).lastTickAt ?? null;
    } catch {
      lastTickAt = null;
    }
    return { status: 200, body: { ok: true, lastTickAt } };
  }

  /** Ingest one system event from a host process (run-submitted,
   * workflow-completed/failed, gate-held/answered, timer-fired).
   * The body is a SystemEvent minus `at` (stamped here). Unknown
   * event types are a 400 — a typo'd event must not silently
   * vanish. An event naming a run this state dir has never seen is
   * a 404 (BRA-133) — a host posting to the wrong server URL — and
   * is rejected before emitting, so it cannot wake the tick loop
   * and trigger drives for runs that are not here. Same check and
   * same 404 text as deliver-result. The poster is fire-and-forget
   * (host.notifyEvent swallows failures), so a 404 cannot break the
   * posting host's run; it is the diagnosable signal. Events with
   * no runId pass through as before. Best-effort by design: the
   * caller swallows failures, and the tick agent's timeout +
   * catch-up sweep bound the damage of a dropped event. */
  private async ingestEvent(body: any): Promise<{ status: number; body: unknown }> {
    const type = body?.type;
    if (typeof type !== "string" || !(SYSTEM_EVENT_TYPES as string[]).includes(type)) {
      return { status: 400, body: { error: `unknown event type ${JSON.stringify(type)} (expected one of ${SYSTEM_EVENT_TYPES.join(", ")})` } };
    }
    const runId = body?.runId;
    if (typeof runId === "string" && runId) {
      const host = await this.driverHost();
      if (!this.runExists(host, runId)) {
        return { status: 404, body: { error: `no run ${runId} in ${host.stateDir}` } };
      }
    }
    this.emitEvent(type as SystemEventType, {
      ...(typeof body?.runId === "string" ? { runId: body.runId } : {}),
      ...(typeof body?.jobId === "string" ? { jobId: body.jobId } : {}),
      ...(typeof body?.trapId === "string" ? { trapId: body.trapId } : {}),
      ...(body?.detail !== undefined ? { detail: body.detail } : {}),
    });
    return { status: 200, body: { ok: true, pending: this.events.length } };
  }

  private readJson(req: Request): Promise<any> {
    return req
      .json()
      .catch(() => null)
      .then((v) => v);
  }

  /** Start listening. Returns the bound port. */
  start(): number {
    // BRA-116: this process IS the worker server at this URL. Name
    // it, so driver Hosts constructed inside this process (the
    // driver endpoints) post their notifyEvent calls to THIS server
    // — not the default port — and the muse adapter health-checks
    // this server instead of auto-starting a second one on the
    // default port. A test that starts a server on a throwaway port
    // gets the same behavior for its own Hosts.
    process.env.AGENTTS_WORKER_SERVER = `http://127.0.0.1:${this.config.port}`;
    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          const live = this.liveCounts();
          return json({
            ok: true,
            service: "agentts-worker-queue",
            port: this.config.port,
            jobs: Object.keys(this.store.jobs).length,
            workers: Object.keys(this.store.workers).length,
            leaseMs: this.config.leaseMs,
            maxAttempts: this.config.maxAttempts,
            affinityHoldMs: this.config.affinityHoldMs,
            affinityTtlMs: this.config.affinityTtlMs,
            stateDir: this.config.stateDir,
            jobspecDir: this.config.jobspecDir,
            scheduler: "dispatch-v1",
            tickPending: this.tickPending,
            pendingEvents: this.events.length,
            droppedEvents: this.droppedEvents,
            waiters: this.hub.waiterCount(),
            quotas: {
              maxPoolSize: this.config.maxPoolSize,
              maxCpuSlots: this.config.maxCpuSlots,
              maxDecisionsPerSec: this.config.maxDecisionsPerSec,
              maxTokensPerHour: this.config.maxTokensPerHour,
              running: live.running,
              cpuRunning: live.cpuRunning,
              tokensUsedThisHour: this.quotas.tokensUsedThisHour(Date.now()),
              decisionsLastSecond: this.quotas.decisionsLastSecond(Date.now()),
            },
            costModelSites: this.costModel.sitesKnown().length,
          });
        }
        if (req.method === "GET" && url.pathname === "/cost-model") {
          return json({ estimates: this.costModel.allEstimates() });
        }
        if (req.method === "POST" && url.pathname === "/enqueue") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "enqueue body must be JSON" }, 400);
          const r = this.enqueue(body);
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/get-job") {
          const r = await this.getJob(url, req.signal);
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/tick") {
          const r = await this.tick(url, req.signal);
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/tick-beat") {
          const r = this.tickBeat();
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/queue/run") {
          const r = await this.driveQueue();
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/deliver-result") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "deliver-result body must be JSON" }, 400);
          const r = await this.deliverResult(body);
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/queue/list") {
          const r = await this.queueList();
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/deliveries") {
          const r = await this.deliveries();
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/escalate") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "escalate body must be JSON" }, 400);
          const r = await this.escalate(body);
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/deliver-gate") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "deliver-gate body must be JSON" }, 400);
          const r = await this.deliverGate(body);
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/event") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "event body must be JSON" }, 400);
          const r = await this.ingestEvent(body);
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/complete-job") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "complete-job body must be JSON" }, 400);
          const r = this.completeJob(body);
          return json(r.body, r.status);
        }
        if (req.method === "POST" && url.pathname === "/heartbeat") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "heartbeat body must be JSON" }, 400);
          const r = this.heartbeat(body);
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/job-status") {
          const r = this.jobStatus(url);
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/jobs") {
          this.sweepLeases();
          return json({ jobs: Object.values(this.store.jobs) });
        }
        if (req.method === "POST" && url.pathname === "/cancel-job") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "cancel-job body must be JSON" }, 400);
          const r = this.cancelJob(body);
          return json(r.body, r.status);
        }
        if (req.method === "GET" && url.pathname === "/jobspec") {
          const spec = url.searchParams.get("spec") ?? "";
          // BRA-89: a ?hash= names the enqueue-time prose — serve
          // the content-addressed snapshot when one exists, so a
          // pool worker re-reading its spec gets the prose as
          // enqueued even when the live file has since changed.
          // No snapshot (a job enqueued before BRA-89, or a hash
          // that was never enqueued): fall back to the live file,
          // whose hash the response carries — the worker's cache
          // check then re-fetches on the next job, never trusting
          // mismatched prose as the pinned one.
          const hash = url.searchParams.get("hash") ?? "";
          if (/^[0-9a-f]{64}$/.test(hash)) {
            const snap = this.jobspecSnapshotPath(hash);
            if (fs.existsSync(snap)) {
              return json({ spec, hash, text: fs.readFileSync(snap, "utf8") });
            }
          }
          const p = this.specFile(spec);
          if (!p) return json({ error: `no jobspec file for "${spec}"` }, 404);
          return json({ spec, hash: shaFile(p), text: fs.readFileSync(p, "utf8") });
        }
        if (req.method === "GET" && url.pathname === "/notes") {
          const spec = url.searchParams.get("spec") ?? "";
          const p = path.join(this.dir, "notes", `${spec}.md`);
          return json({ spec, notes: fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "" });
        }
        if (req.method === "POST" && url.pathname === "/note") {
          const body = await this.readJson(req);
          if (body === null || typeof body?.spec !== "string" || typeof body?.text !== "string") {
            return json({ error: "note requires spec and text" }, 400);
          }
          const p = path.join(this.dir, "notes", `${body.spec}.md`);
          const line = `- ${new Date().toISOString()} [${typeof body?.workerId === "string" ? body.workerId : "unknown"}] ${body.text}\n`;
          fs.appendFileSync(p, line);
          return json({ ok: true });
        }
        if (req.method === "POST" && url.pathname === "/gate-notify") {
          const body = await this.readJson(req);
          if (body === null) return json({ error: "gate-notify body must be JSON" }, 400);
          this.store.gates.push({
            runId: typeof body?.runId === "string" ? body.runId : "",
            trapId: typeof body?.trapId === "string" ? body.trapId : "",
            question: typeof body?.question === "string" ? body.question : "",
            notifiedAt: Date.now(),
          });
          this.saveStore();
          return json({ ok: true });
        }
        if (req.method === "GET" && url.pathname === "/gates") {
          return json({ gates: this.store.gates });
        }
        return json({ error: `unknown route ${req.method} ${url.pathname}` }, 404);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    };
    // idleTimeout must cover the longest long-poll (MAX_LONG_POLL_MS
    // = 120s): Bun.serve() defaults to 10s and RESETS any request
    // that takes longer (the client sees ECONNRESET). 180s gives the
    // 120s max poll 60s of margin. Without this, get-job and tick
    // long-polls die at 10s.
    this.server = Bun.serve({
      port: this.config.port,
      hostname: "127.0.0.1",
      idleTimeout: Math.ceil(MAX_LONG_POLL_MS / 1000) + 60,
      fetch: handler,
    });
    // The sweep re-queues expired leases AND re-notifies every
    // second even when nothing expired: a parked get-job waiter's
    // selection is time-based (affinity-hold expiry, quota windows),
    // so it must re-check on the clock, not only on state changes.
    this.sweepTimer = setInterval(() => {
      this.sweepLeases();
      this.hub.notify();
    }, 1000);
    console.log(
      `agentts worker queue listening on http://127.0.0.1:${this.config.port} (state ${this.dir}, lease ${this.config.leaseMs}ms, maxAttempts ${this.config.maxAttempts}, affinityHold ${this.config.affinityHoldMs}ms)`,
    );
    return this.config.port;
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.server) this.server.stop();
  }
}

// CLI entry: `bun src/worker-server.ts --state-dir <dir> [--port N] ...`
if (import.meta.main) {
  const config = serverConfigFromArgs(process.argv.slice(2));
  const server = new WorkerServer(config);
  server.start();
  console.log(`worker queue state dir: ${server.dir}`);
  console.log(`jobspec dir: ${config.jobspecDir}`);
  if (config.workersConfigPath) console.log(`workers config: ${config.workersConfigPath}`);
}
