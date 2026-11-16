// muse-adapter — the Muse environment adapter (BRA-48).
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
// from --state-dir), AGENTTS_MUSE_JOB_TIMEOUT_MS (default 600_000 —
// must exceed leaseMs * maxAttempts, else the adapter gives up
// before the server fails the job), AGENTTS_MUSE_POLL_MS (default
// 500), AGENTTS_WORKER_CWD (exec default cwd).

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../adapter";
import { decideLocal } from "../decision-model";
import { httpAsync, httpGetSync, httpPostSync, serverHealthy } from "../worker-http";
import { workerPort, workerServerUrl } from "../worker-protocol";

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
}
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MuseAdapterConfig {
  /** Full server URL; defaults to AGENTTS_WORKER_SERVER or loopback:port. */
  serverUrl?: string;
  /** Max ms answer("job") waits for a terminal job state. */
  jobTimeoutMs?: number;
  /** Poll interval ms while waiting. */
  pollMs?: number;
  /** Working directory for exec traps without an explicit cwd. */
  cwd?: string;
  /** State dir for an auto-started server (AGENTTS_STATE_DIR). */
  stateDir?: string;
}

const DEFAULT_JOB_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_MS = 500;

function serverScriptPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, "..", "worker-server.ts"),
    path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "src", "worker-server.ts"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`muse adapter: worker server script not found (tried ${candidates.join(", ")})`);
}

export class MuseAdapter implements Adapter {
  readonly name = "muse";
  private serverUrl: string;
  private jobTimeoutMs: number;
  private pollMs: number;
  private cwd: string;
  private stateDir: string;
  private serverStartedByUs = false;

  constructor(config: MuseAdapterConfig = {}) {
    this.serverUrl = (config.serverUrl ?? workerServerUrl()).replace(/\/$/, "");
    this.jobTimeoutMs = config.jobTimeoutMs ?? Number(process.env.AGENTTS_MUSE_JOB_TIMEOUT_MS ?? DEFAULT_JOB_TIMEOUT_MS);
    this.pollMs = config.pollMs ?? Number(process.env.AGENTTS_MUSE_POLL_MS ?? DEFAULT_POLL_MS);
    this.cwd = config.cwd ?? process.env.AGENTTS_WORKER_CWD ?? process.cwd();
    this.stateDir =
      config.stateDir ?? process.env.AGENTTS_STATE_DIR ?? path.join(process.cwd(), ".agentts-state");
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

  /** Blocking wait for a terminal job state (sync, for answer()). */
  private waitForJobSync(jobId: string): TrapAnswer {
    const deadline = Date.now() + this.jobTimeoutMs;
    for (;;) {
      const r = httpGetSync(`${this.serverUrl}/job-status?jobId=${encodeURIComponent(jobId)}`);
      if (r.status === 200 && r.body) {
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
            message: `job ${jobId} did not reach a terminal state within ${this.jobTimeoutMs}ms (server lease/maxAttempts should have settled it first — check the server log)`,
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
        return this.waitForJobSync(jobId);
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
    return { id: r.body.jobId as string };
  }

  async collectJob(handle: JobHandle): Promise<JobResult> {
    const deadline = Date.now() + this.jobTimeoutMs;
    for (;;) {
      const r = await httpAsync("GET", `${this.serverUrl}/job-status?jobId=${encodeURIComponent(handle.id)}`);
      if (r.status === 200 && r.body) {
        const status = r.body.status as string;
        if (status === "completed") return { value: r.body.result ?? null };
        if (status === "failed") {
          return { error: r.body.error ?? { name: "JobFailed", message: `job ${handle.id} failed` } };
        }
        if (status === "cancelled") return { cancelled: true };
      } else if (r.status === 404) {
        throw new Error(`muse adapter: job ${handle.id} disappeared from the queue server`);
      }
      if (Date.now() > deadline) {
        return { error: { name: "JobTimeout", message: `job ${handle.id} did not settle within ${this.jobTimeoutMs}ms` } };
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
