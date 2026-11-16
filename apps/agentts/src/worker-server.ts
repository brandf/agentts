// worker-server — the host-side job queue + get-job/complete-job HTTP API (BRA-48).
//
// One Bun process, loopback only. It is the SOLE writer of the job
// store (<stateDir>/worker-jobs/store.json): the adapter, the CLI,
// and workers all go through HTTP, so there is exactly one mutation
// path and no lost-update race between processes. Handlers are
// synchronous (no awaits in the mutation path) and every mutation is
// written through to disk before the response is sent.
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
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DEFAULT_DISPATCH_AGING_MS, DispatchScheduler } from "./scheduler";
import { CostModel } from "./cost-model";
import { QuotaTracker } from "./quotas";
import {
  DEFAULT_AFFINITY_HOLD_MS,
  DEFAULT_AFFINITY_TTL_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WORKER_PORT,
  MAX_FILE_EFFECT_BYTES,
  type FileEffect,
  type GateNotice,
  type Job,
  type JobAssignment,
  type JobStatus,
  type WorkerInfo,
} from "./worker-protocol";

const BUN = "/opt/hatch-image/bin/bun";

interface Store {
  jobs: Record<string, Job>;
  workers: Record<string, WorkerInfo>;
  gates: GateNotice[];
  seq: number;
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
  private loadStore(): Store {
    const p = this.storePath();
    if (fs.existsSync(p)) {
      try {
        const s = JSON.parse(fs.readFileSync(p, "utf8")) as Store;
        if (s && typeof s === "object" && s.jobs && s.workers) {
          // Backfill BRA-49 dispatch fields on jobs written by an
          // older server (defaults: medium priority, no quota flags,
          // no estimate). The store is the record; missing fields
          // must not crash selection.
          for (const j of Object.values(s.jobs)) {
            if (typeof j.priority !== "number") j.priority = 3;
            if (typeof j.cpuHeavy !== "boolean") j.cpuHeavy = false;
            if (typeof j.isDecision !== "boolean") j.isDecision = false;
            if (typeof j.tokensEst !== "number") j.tokensEst = 0;
            if (typeof j.estDurationMs !== "number" && j.estDurationMs !== null) j.estDurationMs = null;
          }
          return s;
        }
      } catch {
        /* corrupt store: start fresh rather than refuse (the log keeps the history) */
      }
    }
    return { jobs: {}, workers: {}, gates: [], seq: 0 };
  }
  private saveStore(): void {
    const tmp = this.storePath() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
    fs.renameSync(tmp, this.storePath());
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
  private specHash(spec: string): { specPath: string | null; specHash: string | null } {
    const p = this.specFile(spec);
    if (!p) return { specPath: null, specHash: null };
    return { specPath: p, specHash: shaFile(p) };
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
  /** Re-queue expired running jobs (or fail them at max attempts).
   * Called on every request and once a second. */
  sweepLeases(now = Date.now()): void {
    let changed = false;
    for (const job of Object.values(this.store.jobs)) {
      if (job.status !== "running" || job.leaseUntil === null || job.leaseUntil > now) continue;
      job.attempts += 1;
      const expiredWorker = job.workerId;
      job.workerId = null;
      job.leaseUntil = null;
      if (job.attempts >= job.maxAttempts) {
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
        this.logJob("job-timeout-requeue", job, { reason: "lease-expired", lastWorker: expiredWorker });
      }
      changed = true;
    }
    if (changed) this.saveStore();
  }

  // ------------------------------------------------------------ handlers
  private enqueue(body: any): { status: number; body: unknown } {
    const spec = body?.spec;
    if (typeof spec !== "string" || !spec) {
      return { status: 400, body: { error: "enqueue requires a string spec" } };
    }
    const now = Date.now();
    this.store.seq += 1;
    const jobId = `job-${this.store.seq}-${now.toString(36)}`;
    const { specPath, specHash } = this.specHash(spec);
    const priority =
      typeof body?.priority === "number" && body.priority >= 1 && body.priority <= 4
        ? Math.floor(body.priority)
        : 3;
    const est = this.costModel.estimate(`job:${spec}`);
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
      leaseMs:
        typeof body?.leaseMs === "number" && body.leaseMs > 0 ? Math.floor(body.leaseMs) : this.config.leaseMs,
      leaseUntil: null,
      enqueuedAt: now,
      assignedAt: null,
      completedAt: null,
    };
    this.store.jobs[jobId] = job;
    this.saveStore();
    this.logJob("job-enqueued", job);
    return { status: 200, body: { jobId, status: "queued" as JobStatus } };
  }

  private getJob(url: URL): { status: number; body: unknown } {
    const workerId = url.searchParams.get("workerId") ?? "";
    if (!workerId) return { status: 400, body: { error: "get-job requires ?workerId=" } };
    const now = Date.now();
    this.sweepLeases(now);
    const worker = this.touchWorker(workerId, now);
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
    const blockedReasons: string[] = [];
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
      blockedReasons.push(`${job.jobId} (${check.reason}: ${check.detail})`);
      // The exclusion itself is journaled: a blocked pick that a
      // later pick worked around must still be visible in the log.
      this.logScheduler(workerId, "quota-blocked", check.detail, job.jobId);
      sel = this.scheduler.selectJobForWorker(
        workerView,
        queued.filter((j) => !excluded.has(j.jobId)),
        now,
        affinityFor,
      );
    }
    if (!sel.job) {
      if (excluded.size > 0) {
        this.logScheduler(
          workerId,
          "none-quota",
          `all ${excluded.size} candidate(s) quota-blocked: ${blockedReasons.join("; ")}`,
          null,
        );
      } else {
        this.logScheduler(workerId, sel.decision, sel.reason, null);
      }
      this.saveStore();
      return { status: 200, body: { job: null } };
    }
    this.logScheduler(workerId, sel.decision, sel.reason, sel.job.jobId);
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
    this.saveStore();
    this.logJob("job-assigned", job, { decision: sel.decision });
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
        return { status: 200, body: { ok: true, status: "failed" as JobStatus } };
      }
      job.status = "queued";
      job.workerId = null;
      job.assignedAt = null;
      job.leaseUntil = null;
      job.error = record;
      this.saveStore();
      this.logJob("job-error-requeue", job, { reason: "worker-error" });
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
    return { status: 200, body: { ok: true, status: "completed" as JobStatus } };
  }

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
    this.touchWorker(workerId, now);
    this.saveStore();
    return { status: 200, body: { ok: true, cancelled: false, leaseUntil: job.leaseUntil } };
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
    return { status: 200, body: { ok: true, status: "cancelled" as JobStatus } };
  }

  private jobStatus(url: URL): { status: number; body: unknown } {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = this.store.jobs[jobId];
    if (!job) return { status: 404, body: { error: `no job ${jobId}` } };
    this.sweepLeases();
    return { status: 200, body: this.store.jobs[jobId] };
  }

  private readJson(req: Request): Promise<any> {
    return req
      .json()
      .catch(() => null)
      .then((v) => v);
  }

  /** Start listening. Returns the bound port. */
  start(): number {
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
          const r = this.getJob(url);
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
    this.server = Bun.serve({ port: this.config.port, hostname: "127.0.0.1", fetch: handler });
    this.sweepTimer = setInterval(() => this.sweepLeases(), 1000);
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
}
