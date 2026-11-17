// muse-adapter — the Muse environment adapter (BRA-48).
// Implementation — the loadable seam is ./adapter.ts.
//
// Layer 3, and the ONLY layer that knows about Muse: the host (Layer
// 2) never sees a subagent, a chat, or this HTTP queue — it calls
// answer("job", ...) and gets a value back, exactly as it does for
// the mock and direct adapters. The swap test proves the boundary
// for those two; this adapter keeps the same contract, so swapping
// it changes nothing in layers 1–2.
//
// Mechanism: the host CANNOT spawn a Muse subagent (it is a Bun
// process; the coordinator in this chat is the entity that spawns
// subagents). So the adapter works through the get-job/complete-job
// loop over HTTP (src/worker-server.ts):
//   - job: POST /enqueue, then BLOCK waiting for completion —
//     polling GET /job-status with Bun.sleepSync, exactly as the
//     direct adapter blocks in spawnSync. The host's drive loop is
//     synchronous, so a blocking wait is the contract, not a hack.
//     A worker crash/timeout is the server's business: the lease
//     expires, the job re-queues, and the adapter keeps waiting
//     until the job completes, fails loudly (max attempts), or is
//     cancelled. Cancel arrives from another process (CLI /
//     coordinator) via POST /cancel-job; the wait loop sees it and
//     returns { throw: JobCancelled } so the run resumes by throwing
//     at the call site.
//   - exec: run the command for real (spawnSync, no shell) in the
//     given cwd — v0 has no sandbox beyond the process boundary and
//     the workspace cwd; a real sandbox is future work, recorded in
//     BRA-48.
//   - gate: ALWAYS hold (like direct) + a best-effort POST
//     /gate-notify so the coordinator polling the queue server can
//     see the pending gate. Delivery itself stays host-owned
//     (CLI deliver-gate).
//   - decide: the local decision model (decision-model.ts), same as
//     direct — cheap/narrow, computed from the question content.
//
// The adapter also provides the core EnvironmentAdapter methods
// (packages/durablets/plugin/adapter.ts: spawnJob / collectJob /
// cancelJob / runExec / deliverGate, async) over the same queue —
// that is the seam a future async host drive uses, and the shape a
// Claude Code adapter would mirror later. answer() is the sync
// wrapper the host uses today; both share the queue client.
//
// Server lifecycle: if AGENTTS_WORKER_SERVER is set, the adapter
// uses that server and never starts one. Otherwise it health-checks
// loopback:<port> and auto-starts `bun src/worker-server.ts` as a
// detached process (logs to <stateDir>/worker-jobs/server.log) when
// nothing answers, then waits up to 10s for /health. So `agentts
// run --adapter muse` works with zero extra setup, and the
// coordinator can also start the server explicitly (`agentts worker
// serve`) for the true-subagent leg.
//
// Config (env): AGENTTS_WORKER_SERVER (full URL), AGENTTS_WORKER_PORT
// (default 18741), AGENTTS_STATE_DIR (server state; the CLI sets it
// from --state-dir), AGENTTS_MUSE_JOB_TIMEOUT_MS (explicit job timeout
// — overrides the derived timeout below; use only when you know the
// server's settle time is shorter), AGENTTS_MUSE_SETTLE_MARGIN_MS
// (default 60_000 — margin added to the server settle time, see
// deriveJobTimeoutMs), AGENTTS_MUSE_POLL_MS (default 500),
// AGENTTS_WORKER_CWD (exec default cwd).
//
// G14 (BRA-74): the job timeout is DERIVED from the queue server's
// actual lease/maxAttempts (via /health), not a fixed default: the
// timeout must exceed the server's worst-case settle time
// (leaseMs x maxAttempts), or the adapter gives up before the server
// fails the job. The old fixed default (600_000) was shorter than the
// default settle time (300_000 x 3 = 900_000). An explicit timeout
// (config / AGENTTS_MUSE_JOB_TIMEOUT_MS) still wins, but a warning
// fires when it is below the settle time.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../../../src/adapter";
import { decideLocal } from "../../../src/decision-model";
import { httpAsync, httpGetSync, httpPostSync, serverHealthy } from "../../../src/worker-http";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  workerPort,
  workerServerUrl,
} from "../../../src/worker-protocol";

// The async spawnJob / collectJob / cancelJob / runExec / deliverGate
// methods below mirror the core EnvironmentAdapter shape
// (packages/durablets/plugin/adapter.ts) exactly, but this file does
// NOT import it: the host never imports the core package (the two
// trees resolve that path differently — working dir vs staged repo —
// and the host's own adapter.ts is the interface it programs to).
// These aliases are kept identical to the core's by hand; the worker
// suite's typecheck step (tsc over the staged tree) re-verifies the
// method signatures against the core file. Do not let them drift.
export interface JobHandle {
  id: string;
  /** Run/trap the job belongs to (for the host's journal callback). */
  runId?: string;
  trapId?: string;
}
/** A mid-flight pool transition the host journals into the run
 * journal as it happens (BRA-61) — the journal is the profiler's
 * source of truth, and these events are invisible there today (they
 * live only in worker-jobs/jobs.log). The adapter observes them by
 * polling /job-status while it waits; the host supplies the callback
 * (Host.wireJobEvents) and journals them via journalEvent. */
export interface JobPoolEvent {
  event: "job-nudged" | "job-requeued" | "job-attempt";
  jobId: string;
  spec: string;
  detail: Record<string, unknown>;
}
export interface JobSpec {
  spec: unknown;
  trapId: string;
  runId: string;
}
export interface JobResult {
  value?: unknown;
  error?: unknown;
  cancelled?: boolean;
  /** The pool worker id that produced this answer (BRA-73): the
   * worker server is the one that knows it — /job-status returns
   * the job record with workerId, and collectJob carries it here
   * so the host can journal it on trap-result.worker. Absent when
   * the server names no worker (a job that never ran). The sync
   * waitForJobSync path already returned it on TrapAnswer.worker;
   * this is the same field on the async path, which dropped it. */
  worker?: string;
}
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MuseAdapterConfig {
  /** Full server URL; defaults to AGENTTS_WORKER_SERVER or loopback:port. */
  serverUrl?: string;
  /** Max ms answer("job") waits for a terminal job state. When omitted, the timeout is derived
   * from the queue server's actual lease/maxAttempts (G14, see deriveJobTimeoutMs) — an explicit
   * value overrides the derivation. */
  jobTimeoutMs?: number;
  /** Poll interval ms while waiting. */
  pollMs?: number;
  /** Working directory for exec traps without an explicit cwd. */
  cwd?: string;
  /** State dir for an auto-started server (AGENTTS_STATE_DIR). */
  stateDir?: string;
  /** Called for every mid-flight pool transition the adapter
   * observes while waiting (BRA-61). The host wires this to its
   * journal (Host.wireJobEvents); without it the events stay in
   * jobs.log only. Best-effort: a callback that throws must never
   * fail the trap it reports on. */
  onJobEvent?: (ctx: TrapContext, ev: JobPoolEvent) => void;
}

/** G14 (BRA-74): margin added to the server's worst-case settle time (leaseMs x maxAttempts) to
 * form the adapter's job timeout. The margin covers the final lease sweep + one poll interval
 * after the last attempt fails, so the server always settles the job before the adapter gives
 * up. Env: AGENTTS_MUSE_SETTLE_MARGIN_MS (default 60_000). */
export const DEFAULT_SETTLE_MARGIN_MS = 60_000;

/** G14 (BRA-74): the adapter's job timeout for a server with this lease and maxAttempts. Must
 * EXCEED leaseMs x maxAttempts — the server's worst-case settle time — or the adapter gives up
 * before the server fails the job (the old fixed default, 600_000, was shorter than the default
 * settle time 300_000 x 3 = 900_000). An explicit timeout (config / AGENTTS_MUSE_JOB_TIMEOUT_MS)
 * overrides this; use it only when you know the server's settle time is shorter. */
export function deriveJobTimeoutMs(
  leaseMs: number,
  maxAttempts: number,
  marginMs = DEFAULT_SETTLE_MARGIN_MS,
): number {
  const lease = Math.max(1, Math.floor(leaseMs));
  const attempts = Math.max(1, Math.floor(maxAttempts));
  return lease * attempts + Math.max(0, Math.floor(marginMs));
}

const DEFAULT_POLL_MS = 500;

function serverScriptPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, "..", "..", "..", "src", "worker-server.ts"),
    path.resolve(here, "..", "..", "..", "..", "agentts-repo", "apps", "agentts", "src", "worker-server.ts"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`muse adapter: worker server script not found (tried ${candidates.join(", ")})`);
}

export class MuseAdapter implements Adapter {
  readonly name = "muse";
  private serverUrl: string;
  /** Explicit job timeout (config / AGENTTS_MUSE_JOB_TIMEOUT_MS), or null to derive it from the
   * server (G14). */
  private jobTimeoutMs: number | null;
  /** Resolved effective timeout (explicit or derived) — cached per adapter (the server's
   * lease/maxAttempts are server config; they do not change at runtime). */
  private jobTimeoutResolved: number | null = null;
  /** The server's worst-case settle time (leaseMs x maxAttempts) the timeout was derived from,
   * for the JobTimeout message. Null until resolved. */
  private settleMs: number | null = null;
  private settleWarned = false;
  private settleMarginMs: number;
  private pollMs: number;
  private cwd: string;
  private stateDir: string;
  private serverStartedByUs = false;
  private onJobEvent?: (ctx: TrapContext, ev: JobPoolEvent) => void;

  constructor(config: MuseAdapterConfig = {}) {
    this.serverUrl = (config.serverUrl ?? workerServerUrl()).replace(/\/$/, "");
    this.jobTimeoutMs =
      config.jobTimeoutMs ??
      (process.env.AGENTTS_MUSE_JOB_TIMEOUT_MS ? Number(process.env.AGENTTS_MUSE_JOB_TIMEOUT_MS) : null);
    this.settleMarginMs = Number(process.env.AGENTTS_MUSE_SETTLE_MARGIN_MS ?? DEFAULT_SETTLE_MARGIN_MS);
    this.pollMs = config.pollMs ?? Number(process.env.AGENTTS_MUSE_POLL_MS ?? DEFAULT_POLL_MS);
    this.cwd = config.cwd ?? process.env.AGENTTS_WORKER_CWD ?? process.cwd();
    this.stateDir =
      config.stateDir ?? process.env.AGENTTS_STATE_DIR ?? path.join(process.cwd(), ".agentts-state");
    this.onJobEvent = config.onJobEvent;
  }

  /** G14 (BRA-74): the effective job timeout, derived from the queue server's actual
   * lease/maxAttempts (via /health) when no explicit timeout was configured. Cached per adapter
   * (the server's lease/maxAttempts are server config — they do not change at runtime). An
   * explicit timeout wins, but a warning fires once when it is below the settle time (the
   * adapter would give up before the server settles the job). Falls back to the default
   * lease/maxAttempts when /health is unreachable or lacks the fields. */
  effectiveJobTimeoutMs(): number {
    if (this.jobTimeoutResolved !== null) return this.jobTimeoutResolved;
    this.ensureServer();
    let leaseMs = DEFAULT_LEASE_MS;
    let maxAttempts = DEFAULT_MAX_ATTEMPTS;
    try {
      const r = httpGetSync(`${this.serverUrl}/health`, 10_000);
      if (r.status === 200 && r.body) {
        if (typeof r.body.leaseMs === "number" && r.body.leaseMs > 0) leaseMs = r.body.leaseMs;
        if (typeof r.body.maxAttempts === "number" && r.body.maxAttempts >= 1) maxAttempts = r.body.maxAttempts;
      }
    } catch {
      /* /health unreachable — fall back to the default lease/maxAttempts. The derived timeout is
         still above the default settle time; an explicit override, if set, is unaffected. */
    }
    const settleMs = leaseMs * Math.max(1, Math.floor(maxAttempts));
    this.settleMs = settleMs;
    const derived = deriveJobTimeoutMs(leaseMs, maxAttempts, this.settleMarginMs);
    if (this.jobTimeoutMs !== null) {
      if (this.jobTimeoutMs < derived && !this.settleWarned) {
        this.settleWarned = true;
        console.warn(
          `muse adapter: explicit job timeout ${this.jobTimeoutMs}ms is below the server settle time ${settleMs}ms (lease ${leaseMs}ms x ${maxAttempts} attempts + ${this.settleMarginMs}ms margin = ${derived}ms) — the adapter may give up before the server fails the job`,
        );
      }
      this.jobTimeoutResolved = this.jobTimeoutMs;
    } else {
      this.jobTimeoutResolved = derived;
    }
    return this.jobTimeoutResolved;
  }

  /** Set (or clear) the job-event callback after construction (the
   * Host wires it — see Host.wireJobEvents — because the adapter is
   * built before the Host that owns the journal). */
  setJobEventHandler(fn?: (ctx: TrapContext, ev: JobPoolEvent) => void): void {
    this.onJobEvent = fn;
  }

  /** Observe one /job-status poll and emit the mid-flight
   * transitions the run journal needs (BRA-61). `seen` is the
   * last snapshot this wait loop saw (null before the first poll —
   * the first observation sets the baseline and emits nothing, so
   * a wait that starts mid-flight cannot invent a transition).
   * Only transitions fire — a steady state is silent, so a long
   * wait does not spam the journal. The terminal outcome itself is
   * NOT emitted here: the host already journals trap-result /
   * trap-error with the worker and the error. */
  private observeJob(
    ctx: TrapContext,
    body: any,
    seen: { attempts: number; status: string; workerId: string | null; nudgeCount: number; requeues: number; runningKey: string | null } | null,
  ): { attempts: number; status: string; workerId: string | null; nudgeCount: number; requeues: number; runningKey: string | null } {
    const snap = {
      attempts: typeof body?.attempts === "number" ? body.attempts : 0,
      status: typeof body?.status === "string" ? body.status : "",
      workerId: typeof body?.workerId === "string" ? body.workerId : null,
      nudgeCount: typeof body?.nudgeCount === "number" ? body.nudgeCount : 0,
      requeues: typeof body?.requeues === "number" ? body.requeues : 0,
      runningKey: null as string | null,
    };
    if (seen === null) return { ...snap, runningKey: snap.status === "running" && snap.workerId ? `${snap.attempts}:${snap.workerId}` : null };
    if (!this.onJobEvent) return { ...snap, runningKey: seen.runningKey };
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    const spec = typeof body?.spec === "string" ? body.spec : "";
    const emit = (ev: JobPoolEvent): void => {
      try {
        this.onJobEvent!(ctx, ev);
      } catch {
        /* journaling a pool event must never fail the trap */
      }
    };
    if (snap.nudgeCount > seen.nudgeCount) {
      const silentMs =
        typeof body?.lastHeartbeatAt === "number" ? Date.now() - body.lastHeartbeatAt : null;
      emit({
        event: "job-nudged",
        jobId,
        spec,
        detail: {
          workerId: snap.workerId,
          silentMs,
          leaseMs: typeof body?.leaseMs === "number" ? body.leaseMs : null,
          // May be null when the worker's heartbeat already
          // delivered the nudge between polls; the count + silence
          // carry the substance, the text is a rendering of them.
          message: typeof body?.nudgeMessage === "string" ? body.nudgeMessage : null,
        },
      });
    }
    // A re-queue happened: keyed off the monotonic requeues counter,
    // NOT off the transient "queued" state. A re-queue that is
    // re-taken within one poll interval (a parked get-job waiter
    // takes it in milliseconds) never shows as queued to the poller
    // — the counter is the only durable witness. requeueReason is
    // last-requeue history on the job record, so it still names the
    // reason after the retry has started. (Two re-queues inside one
    // poll interval collapse into one event — the counter jump is
    // visible in `attempts`, and jobs.log keeps the full history;
    // that needs two full leases inside 500ms, so it is not a
    // realistic shape.)
    if (snap.requeues > seen.requeues) {
      emit({
        event: "job-requeued",
        jobId,
        spec,
        detail: {
          reason: typeof body?.requeueReason === "string" ? body.requeueReason : "unknown",
          lastWorker: seen.workerId,
          attempts: snap.attempts,
        },
      });
    }
    // A retry attempt starting: the job is running again after at
    // least one expiry/error (attempts > 0) on a (attempts, worker)
    // pair this wait has not seen. The first assignment (attempts
    // 0) is not an event — the trap-result already names the worker.
    // `attempts` is the server's own number (re-queues + final
    // failure count), used verbatim — no +1, no derived numbering.
    if (snap.status === "running" && snap.workerId && snap.attempts > 0) {
      const key = `${snap.attempts}:${snap.workerId}`;
      if (key !== seen.runningKey) {
        emit({
          event: "job-attempt",
          jobId,
          spec,
          detail: { attempts: snap.attempts, workerId: snap.workerId },
        });
        return { ...snap, runningKey: key };
      }
    }
    // The final attempt may complete within one poll interval, so
    // its running state is never observed — the terminal poll still
    // carries the completing worker and the attempts count, so the
    // attempt is recorded here rather than lost. Suppressed when
    // the running state was already seen (runningKey matches), so a
    // slow retry is reported once, not twice.
    if (
      (snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled") &&
      snap.workerId &&
      snap.attempts > 0
    ) {
      const key = `${snap.attempts}:${snap.workerId}`;
      if (key !== seen.runningKey) {
        emit({
          event: "job-attempt",
          jobId,
          spec,
          detail: { attempts: snap.attempts, workerId: snap.workerId },
        });
        return { ...snap, runningKey: key };
      }
    }
    return { ...snap, runningKey: seen.runningKey };
  }

  // ------------------------------------------------------- server lifecycle
  /** Ensure the queue server answers. Auto-starts it (detached)
   * when no explicit server URL is configured and nothing answers
   * on loopback. Throws loudly when the server cannot be reached. */
  ensureServer(): void {
    if (serverHealthy(this.serverUrl)) return;
    if (process.env.AGENTTS_WORKER_SERVER) {
      throw new Error(
        `muse adapter: worker server ${this.serverUrl} (AGENTTS_WORKER_SERVER) is not answering /health — start it with: agentts worker serve --state-dir ${this.stateDir}`,
      );
    }
    if (this.serverStartedByUs) {
      throw new Error(`muse adapter: worker server ${this.serverUrl} is not answering /health after we started it`);
    }
    const script = serverScriptPath();
    const logDir = path.join(this.stateDir, "worker-jobs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "server.log");
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(
      "/opt/hatch-image/bin/bun",
      [script, "--state-dir", this.stateDir, "--port", String(workerPort())],
      { detached: true, stdio: ["ignore", logFd, logFd] },
    );
    child.unref();
    this.serverStartedByUs = true;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (serverHealthy(this.serverUrl)) return;
      Bun.sleepSync(250);
    }
    throw new Error(
      `muse adapter: worker server did not come up on ${this.serverUrl} within 10s (see ${logPath})`,
    );
  }

  // ------------------------------------------------------- sync queue calls
  private enqueueJob(spec: string, input: unknown, ctx: TrapContext, workspace?: string): string {
    this.ensureServer();
    const r = httpPostSync(`${this.serverUrl}/enqueue`, {
      spec,
      input,
      runId: ctx.runId,
      trapId: ctx.trapId,
      ...(workspace ? { workspace } : {}),
    });
    if (r.status !== 200 || typeof r.body?.jobId !== "string") {
      throw new Error(
        `muse adapter: enqueue failed for jobspec "${spec}": HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`,
      );
    }
    return r.body.jobId as string;
  }

  /** Blocking wait for a terminal job state (sync, for answer()).
   * Polls /job-status and journals the mid-flight pool transitions
   * the run journal needs (BRA-61) as it observes them. */
  private waitForJobSync(jobId: string, ctx: TrapContext): TrapAnswer {
    // G14 (BRA-74): the effective timeout is derived from the server's lease/maxAttempts, so the
    // server always settles the job before the adapter gives up.
    const timeoutMs = this.effectiveJobTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    let seen: { attempts: number; status: string; workerId: string | null; nudgeCount: number; requeues: number; runningKey: string | null } | null = null;
    for (;;) {
      const r = httpGetSync(`${this.serverUrl}/job-status?jobId=${encodeURIComponent(jobId)}`);
      if (r.status === 200 && r.body) {
        seen = this.observeJob(ctx, r.body, seen);
        const status = r.body.status as string;
        // BRA-57: the job record carries the worker that completed
        // it (job.workerId); the host journals it on the trap-result
        // event as the worker identity for this trap.
        const worker = typeof r.body.workerId === "string" && r.body.workerId ? r.body.workerId : undefined;
        if (status === "completed") return { value: r.body.result ?? null, ...(worker ? { worker } : {}) };
        if (status === "failed") {
          const err = r.body.error ?? { name: "JobFailed", message: `job ${jobId} failed` };
          return { throw: { name: err.name ?? "JobFailed", message: err.message ?? `job ${jobId} failed` }, ...(worker ? { worker } : {}) };
        }
        if (status === "cancelled") {
          return {
            throw: {
              name: "JobCancelled",
              message: `job ${jobId} was cancelled${r.body.cancelReason ? `: ${r.body.cancelReason}` : ""}`,
            },
            ...(worker ? { worker } : {}),
          };
        }
      } else if (r.status === 404) {
        throw new Error(`muse adapter: job ${jobId} disappeared from the queue server`);
      }
      if (Date.now() > deadline) {
        return {
          throw: {
            name: "JobTimeout",
            message: `job ${jobId} did not reach a terminal state within ${timeoutMs}ms (server worst-case settle time ${this.settleMs ?? "unknown"}ms — the server should have failed the job first; check the server log)`,
          },
        };
      }
      Bun.sleepSync(this.pollMs);
    }
  }

  /** Cancel a job by id (sync, for the host path). The run resumes
   * by throwing at the call site via the wait loop. */
  cancelJobById(jobId: string, reason = "cancelled via adapter"): void {
    this.ensureServer();
    const r = httpPostSync(`${this.serverUrl}/cancel-job`, { jobId, reason });
    if (r.status !== 200) {
      throw new Error(`muse adapter: cancel-job ${jobId} failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    }
  }

  // ------------------------------------------------------- host Adapter
  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD {
    switch (type) {
      case "job": {
        const spec = arg?.spec;
        if (typeof spec !== "string") {
          throw new Error(`muse adapter: job trap ${ctx.trapId} has no string spec — the muse adapter routes jobs by spec`);
        }
        const jobId = this.enqueueJob(spec, arg?.input ?? null, ctx);
        return this.waitForJobSync(jobId, ctx);
      }
      case "exec": {
        const cmd: string = arg?.cmd;
        if (typeof cmd !== "string" || !cmd) {
          throw new Error(`muse adapter: exec trap ${ctx.trapId} has no cmd`);
        }
        const args: string[] = Array.isArray(arg?.args) ? arg.args : [];
        const cwd = typeof arg?.cwd === "string" ? arg.cwd : this.cwd;
        const r = spawnSync(cmd, args, { encoding: "utf8", cwd, shell: false });
        if (r.error) {
          return { value: { stdout: "", stderr: String(r.error), exitCode: 1 } };
        }
        return {
          value: {
            stdout: r.stdout ?? "",
            stderr: r.stderr ?? "",
            exitCode: r.status ?? 1,
          },
        };
      }
      case "gate": {
        // Best-effort notification so the coordinator polling the
        // queue server can see the pending gate; delivery stays
        // host-owned (CLI deliver-gate). A notification failure never
        // blocks the hold.
        try {
          this.ensureServer();
          httpPostSync(`${this.serverUrl}/gate-notify`, {
            runId: ctx.runId,
            trapId: ctx.trapId,
            question: typeof arg?.question === "string" ? arg.question : "",
          });
        } catch {
          /* notification is informational */
        }
        return HOLD;
      }
      case "decide": {
        const question = typeof arg?.question === "string" ? arg.question : "";
        const options = Array.isArray(arg?.options) ? arg.options : undefined;
        return { value: decideLocal(question, options) };
      }
      default:
        throw new Error(`muse adapter: unknown trap type "${type}" (trap ${ctx.trapId})`);
    }
  }

  // ---------------- core EnvironmentAdapter methods (async; mirror
  // packages/durablets/plugin/adapter.ts — see the aliases above)
  async spawnJob(spec: JobSpec, input: unknown, workspace: string): Promise<JobHandle> {
    this.ensureServer();
    const specName = typeof spec.spec === "string" ? spec.spec : JSON.stringify(spec.spec);
    const r = await httpAsync("POST", `${this.serverUrl}/enqueue`, {
      spec: specName,
      input,
      runId: spec.runId,
      trapId: spec.trapId,
      workspace,
    });
    if (r.status !== 200 || typeof r.body?.jobId !== "string") {
      throw new Error(`muse adapter: spawnJob failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    return { id: r.body.jobId as string, runId: spec.runId, trapId: spec.trapId };
  }

  async collectJob(handle: JobHandle): Promise<JobResult> {
    // G14 (BRA-74): same derived timeout as the sync wait path (waitForJobSync) — the async
    // collectJob is the same wait, and it must also exceed the server settle time.
    const timeoutMs = this.effectiveJobTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    const ctx: TrapContext = {
      runId: handle.runId ?? "",
      trapId: handle.trapId ?? "",
      ordinal: 0,
    };
    let seen: { attempts: number; status: string; workerId: string | null; nudgeCount: number; requeues: number; runningKey: string | null } | null = null;
    for (;;) {
      const r = await httpAsync("GET", `${this.serverUrl}/job-status?jobId=${encodeURIComponent(handle.id)}`);
      if (r.status === 200 && r.body) {
        seen = this.observeJob(ctx, r.body, seen);
        const status = r.body.status as string;
        // BRA-73: the job record carries the worker that completed
        // it (job.workerId) — carry it on the result, exactly as
        // the sync waitForJobSync path does on TrapAnswer.worker,
        // so the host journals it on trap-result.worker. The
        // worker server is the one that knows the id; the adapter
        // never guesses it.
        const worker = typeof r.body.workerId === "string" && r.body.workerId ? r.body.workerId : undefined;
        if (status === "completed") return { value: r.body.result ?? null, ...(worker ? { worker } : {}) };
        if (status === "failed") {
          return { error: r.body.error ?? { name: "JobFailed", message: `job ${handle.id} failed` }, ...(worker ? { worker } : {}) };
        }
        if (status === "cancelled") return { cancelled: true, ...(worker ? { worker } : {}) };
      } else if (r.status === 404) {
        throw new Error(`muse adapter: job ${handle.id} disappeared from the queue server`);
      }
      if (Date.now() > deadline) {
        return { error: { name: "JobTimeout", message: `job ${handle.id} did not settle within ${timeoutMs}ms (server worst-case settle time ${this.settleMs ?? "unknown"}ms — the server should have failed the job first; check the server log)` } };
      }
      await Bun.sleep(this.pollMs);
    }
  }

  async cancelJob(handle: JobHandle, reason: string): Promise<void> {
    this.ensureServer();
    const r = await httpAsync("POST", `${this.serverUrl}/cancel-job`, { jobId: handle.id, reason });
    if (r.status !== 200) {
      throw new Error(`muse adapter: cancelJob ${handle.id} failed: HTTP ${r.status}`);
    }
  }

  async runExec(command: string, args: string[], cwd: string): Promise<ExecResult> {
    const r = spawnSync(command, args, { encoding: "utf8", cwd: cwd || this.cwd, shell: false });
    if (r.error) return { stdout: "", stderr: String(r.error), exitCode: 1 };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  }

  async deliverGate(trapId: string, runId: string, question: string): Promise<void> {
    try {
      this.ensureServer();
      await httpAsync("POST", `${this.serverUrl}/gate-notify`, { runId, trapId, question });
    } catch {
      /* notification is informational */
    }
  }
}
