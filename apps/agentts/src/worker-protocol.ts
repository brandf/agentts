// worker-protocol — shared types + defaults for the BRA-48 worker pool.
//
// One file defines the wire shape so the host-side queue server, the
// Muse adapter, the worker loop script, and the CLI worker commands
// cannot drift apart. Nothing here knows about Muse, subagents, or
// any agentic environment: a job is a spec name + JSON input, a worker
// is an id + affinity history. The protocol is the get-job /
// complete-job loop; the transport is HTTP (Bun.serve) on loopback.
//
// Endpoints (all JSON; server is the sole writer of the store):
//   GET  /health                          { ok: true, ... }
//   POST /enqueue   { spec, input, runId, trapId, workspace?, leaseMs?, maxAttempts?,
//                       priority?, cpuHeavy?, isDecision?, tokensEst? }
//                                              -> { jobId, status: "queued" }
//   GET  /get-job?workerId=W&lastSpec=S   -> { job: null } | { job: JobAssignment }
//   POST /complete-job { jobId, workerId, result? | error?, files? }
//                                              -> { ok: true, status } | 409
//   POST /heartbeat { jobId, workerId }    -> { ok, cancelled } | 409
//   GET  /job-status?jobId=J              -> Job (public view)
//   GET  /jobs                            -> { jobs: Job[] }
//   POST /cancel-job { jobId, reason? }    -> { ok, status }
//   GET  /jobspec?spec=S                  -> { spec, hash, text } | 404
//   GET  /notes?spec=S                    -> { spec, notes: string[] }
//   POST /note { spec, workerId, text }    -> { ok: true }
//   POST /gate-notify { runId, trapId, question } -> { ok: true }
//   GET  /gates                           -> { gates: GateNotice[] }

export const DEFAULT_WORKER_PORT = 18741;
export const DEFAULT_LEASE_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** How long a job stays reserved for its affinity worker before any
 * worker may take it (bounded: the fallback is never delayed past
 * this window). */
export const DEFAULT_AFFINITY_HOLD_MS = 2_000;
/** A worker's affinity for a spec goes cold this long after it last
 * completed that spec (context reset / long absence). */
export const DEFAULT_AFFINITY_TTL_MS = 30 * 60_000;
/** Cap on file-effects bytes returned with one completion. */
export const MAX_FILE_EFFECT_BYTES = 1_000_000;

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface FileEffect {
  /** Path relative to the worker's per-job workspace. */
  path: string;
  /** Full new contents (UTF-8). */
  content: string;
}

export interface Job {
  jobId: string;
  spec: string;
  /** Filesystem path of the jobspec prose file, when the server
   * could resolve one (same-VM workers read it directly). */
  specPath: string | null;
  /** sha256 of the jobspec file, when resolved; null when there is
   * no spec file (the worker proceeds from the spec name + input). */
  specHash: string | null;
  input: unknown;
  runId: string;
  trapId: string;
  /** Run/task priority, Linear scale: 1 urgent, 2 high, 3 medium,
   * 4 low. Default 3. Dispatch orders by effective priority first. */
  priority: number;
  /** CPU-heavy job: counts against the CPU-slot quota at dispatch. */
  cpuHeavy: boolean;
  /** Decision-model work: counts against the decision-rate quota. */
  isDecision: boolean;
  /** Tokens this job is expected to consume (debited at dispatch
   * against the hourly token budget). */
  tokensEst: number;
  /** Estimated wall duration (ms) from the cost model at enqueue
   * time, or null when the call site has no recorded actuals. */
  estDurationMs: number | null;
  /** Workspace the coordinator assigned to this job (informational;
   * the worker uses its own per-worker workspace under it). */
  workspace: string | null;
  status: JobStatus;
  workerId: string | null;
  attempts: number;
  maxAttempts: number;
  leaseMs: number;
  /** Epoch ms the current lease expires (running jobs only). */
  leaseUntil: number | null;
  enqueuedAt: number;
  assignedAt: number | null;
  completedAt: number | null;
  result?: unknown;
  error?: { name: string; message: string };
  files?: FileEffect[];
  cancelReason?: string;
}

/** What get-job hands a worker: the job plus the lease it must
 * heartbeat inside. */
export interface JobAssignment {
  jobId: string;
  spec: string;
  specPath: string | null;
  specHash: string | null;
  input: unknown;
  runId: string;
  trapId: string;
  workspace: string | null;
  attempt: number;
  leaseMs: number;
  leaseUntil: number;
}

export interface WorkerInfo {
  id: string;
  /** Spec of the worker's most recently completed job. */
  lastSpec: string | null;
  lastCompletedAt: number | null;
  /** Per-spec completion counts (the affinity signal). */
  completedBySpec: Record<string, number>;
  /** Last completion time per spec (warmth per spec). */
  completedAtBySpec: Record<string, number>;
  totalCompleted: number;
  lastSeenAt: number;
}

export interface GateNotice {
  runId: string;
  trapId: string;
  question: string;
  notifiedAt: number;
}

/** Server URL resolution (shared by the adapter, the loop script,
 * and the CLI): an explicit URL wins, else loopback + port. */
export function workerServerUrl(): string {
  if (process.env.AGENTTS_WORKER_SERVER) return process.env.AGENTTS_WORKER_SERVER.replace(/\/$/, "");
  const port = process.env.AGENTTS_WORKER_PORT ?? String(DEFAULT_WORKER_PORT);
  return `http://127.0.0.1:${port}`;
}

export function workerPort(): number {
  return Number(process.env.AGENTTS_WORKER_PORT ?? DEFAULT_WORKER_PORT);
}
