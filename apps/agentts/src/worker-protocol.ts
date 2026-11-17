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
//   GET  /get-job?workerId=W&lastSpec=S&waitMs=N
//                                              -> { job: null } | { job: JobAssignment }
//         waitMs (default 60000, max 120000): the call BLOCKS until a
//         job is assignable to this worker, or the wait expires
//         (BRA-66: get-job was designed to be blocking/long-poll).
//         waitMs=0 is the old immediate return, for tests/scripts
//         that need it.
//   GET  /tick?timeoutMs=N                   -> { events: SystemEvent[], timedOut: bool, at }
//         The tick agent's blocking long-poll (BRA-65): holds until a
//         system event arrives or the timeout fires (default 60000,
//         max 120000). At most ONE tick call may be pending at a
//         time; a second concurrent call is a 409 (two tick agents
//         is a real problem, and the 409 says so loudly).
//   POST /tick-beat                          -> { ok: true, lastTickAt }
//         The tick agent's liveness heartbeat (also updated by every
//         tick call): the watchdog reads <stateDir>/tick/state.json.
//   POST /event { type, ... }                -> { ok: true, pending: N }
//         Ingest a system event (the host POSTs run/gate/workflow
//         events here; the server emits job/lease events itself).
//         Unknown event types are a 400 — a typo'd event must not
//         silently vanish.
//   GET  /health                          { ok: true, ... }

export const DEFAULT_WORKER_PORT = 18741;
export const DEFAULT_LEASE_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Cost-derived lease (BRA-61): a lease is the cost-model p90 for
 * the spec times this multiplier, clamped into
 * [DEFAULT_LEASE_MIN_MS, DEFAULT_LEASE_MAX_MS]. The multiplier
 * gives a healthy-but-slow run headroom above the 90th percentile;
 * the floor stops a fast spec getting a lease so short that any
 * hiccup expires it, and the ceiling stops a pathological estimate
 * holding a slot forever (a healthy long job extends its lease by
 * heartbeating). */
export const LEASE_P90_MULTIPLIER = 2;
export const DEFAULT_LEASE_MIN_MS = 60_000;
export const DEFAULT_LEASE_MAX_MS = 1_800_000;
/** Nudge point (BRA-61): a running job is nudged once per attempt
 * when its age passes this fraction of its lease with no completion
 * yet — a warning shot before the lease expires (silent case) and a
 * status check for a job running long past its estimate
 * (heartbeating case). With a cost-derived lease the threshold is
 * roughly the p90, i.e. ~1x the estimate. */
export const NUDGE_FRACTION = 0.5;
/** Default long-poll waits (BRA-65/66): a get-job or tick call
 * blocks this long before returning empty/timed-out. */
export const DEFAULT_GET_JOB_WAIT_MS = 60_000;
export const DEFAULT_TICK_TIMEOUT_MS = 60_000;
/** Max a single long-poll may ask the server to hold (a client
 * asking for more is clamped, never an error — a hung waiter is
 * worse than a short one). */
export const MAX_LONG_POLL_MS = 120_000;
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
  /** Where the lease came from: an explicit per-enqueue override, the
   * cost-model estimate for this spec (BRA-61), or the server default
   * (no estimate recorded yet). */
  leaseSource: "explicit" | "cost-model" | "default";
  /** Epoch ms the current lease expires (running jobs only). */
  leaseUntil: number | null;
  /** Epoch ms of the last heartbeat for the current attempt (the
   * assignment time when none has arrived yet). A job whose worker
   * stops heartbeating goes silent; the nudge fires on age, the
   * lease expires on silence (BRA-61). */
  lastHeartbeatAt: number | null;
  /** Epoch ms the nudge fired for the current attempt (null when not
   * yet nudged). Reset on each new assignment. */
  nudgedAt: number | null;
  /** Nudges fired for this job across all attempts (jobs.log is the
   * per-attempt history). */
  nudgeCount: number;
  /** The nudge message waiting for the worker's next heartbeat
   * (null once delivered). The heartbeat response carries it — that
   * is the delivery channel to a worker that is still talking. */
  nudgeMessage: string | null;
  /** Why the job was last re-queued ("lease-expired" |
   * "worker-error"), null when it never re-queued. This is HISTORY,
   * not current state: it survives assignment on purpose, so a poll
   * that arrives after the retry can still see why the job was
   * re-queued (BRA-61 — a re-queue lasts milliseconds when a worker
   * is parked in get-job, far shorter than the adapter's poll
   * interval). The adapter reads it alongside the requeues counter
   * to name the re-queue in the run journal. */
  requeueReason: string | null;
  /** How many times the job has been re-queued (monotonic). The
   * adapter's journal observer keys the job-requeued event off
   * this counter, not off the transient "queued" state — a re-queue
   * that is re-taken within one poll interval must still land in
   * the journal (BRA-61). `attempts` is NOT the same number: it
   * also counts the final failure that ends the job. */
  requeues: number;
  /** Per-jobspec idempotency policy (BRA-61): true when a re-queued
   * attempt is safe to re-run (pure computation), false when the job
   * may already have produced side effects and must NOT be silently
   * re-run — a lease expiry then FAILS the job instead, so the
   * coordinator/human decides. Declared in the jobspec file
   * (`<!-- idempotency: non-idempotent -->`); default true. */
  idempotent: boolean;
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

/** A system event: the tick agent's wake signal (BRA-65). The
 * event is a notification, not the source of truth — the tick
 * agent re-reads state (queue, results, jobs) on wake and acts on
 * that, so a dropped event only delays the wake (bounded by the
 * tick timeout), never loses work. */
export type SystemEventType =
  | "run-submitted"
  | "workflow-completed"
  | "workflow-failed"
  | "gate-held"
  | "gate-answered"
  | "job-completed"
  | "job-failed"
  | "lease-expired"
  | "job-nudged"
  | "timer-fired";
export const SYSTEM_EVENT_TYPES: SystemEventType[] = [
  "run-submitted",
  "workflow-completed",
  "workflow-failed",
  "gate-held",
  "gate-answered",
  "job-completed",
  "job-failed",
  "lease-expired",
  "job-nudged",
  "timer-fired",
];
export interface SystemEvent {
  type: SystemEventType;
  /** ISO wall time the event was emitted. */
  at: string;
  runId?: string;
  jobId?: string;
  trapId?: string;
  detail?: unknown;
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
