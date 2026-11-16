// scheduler — the dispatch seam (BRA-48 v0, BRA-49 v1).
//
// The scheduler is a module with a simple implementation behind a
// small interface. v0 was the pool + get-job/complete-job + affinity
// preference. v1 (BRA-49, DispatchScheduler) keeps the interface and
// adds the rest of layer-2 dispatch behind it: priority ordering,
// a cost model (estimated duration per call site, recorded actuals),
// and quotas (enforced by the server around selection — the
// scheduler stays pure; see quotas.ts and worker-server.ts).
// Affinity stays as one input to selection, not the whole story:
// priority dominates it, cost orders inside a priority tier, and
// quotas can hold any job back regardless of all three.
//
// The scheduler runs at DEQUEUE time (pull model): a worker asks for
// work, and the scheduler picks the best queued job FOR that worker.
// That is where affinity lives — the specialist's session context IS
// its cache (repo layout, what works, pitfalls, reviewer prefs), so
// giving the same worker the same job spec across work items pays
// off. Warmth decays: after a context reset the worker is cold
// again, so affinity only counts while the worker completed that spec
// recently (affinityTtlMs).
//
// Preference rule (exact, recorded — BRA-48 decision):
//   1. A job RESERVED for this worker: the job's spec is the spec
//      this worker most recently completed (within the TTL) AND the
//      job is still inside the affinity hold window after enqueue.
//      Oldest such job first. (Decision: "affinity-reserved".)
//   2. An AFFINITY MATCH among jobs any worker may take: the job's
//      spec equals this worker's most recently completed spec
//      (within the TTL). Oldest first. ("affinity-match".)
//   3. FALLBACK: the oldest takeable job, whatever its spec. This is
//      the load-balancing fallback: when the queue backs up or the
//      job is urgent, any worker takes any job rather than idling.
//      ("fallback-oldest".)
//   A job inside its hold window whose affinity worker is a DIFFERENT
//   worker is not takeable by this worker at all ("held-for-other").
//   The hold is bounded (affinityHoldMs, default 2s): after it
//   expires the job is takeable by anyone, so an offline specialist
//   delays the fallback by at most the hold window, never blocks it.
//
// The scheduler is pure (no I/O): the server owns the store and the
// log. Decisions are returned as data so the server can journal
// them; the journal is the evidence affinity actually happened.

import { DEFAULT_AFFINITY_HOLD_MS, DEFAULT_AFFINITY_TTL_MS } from "./worker-protocol";

export interface QueuedJobView {
  jobId: string;
  spec: string;
  enqueuedAt: number;
  /** Run/task priority, Linear scale: 1 urgent, 2 high, 3 medium,
   * 4 low. Absent = medium (3). Priority dominates affinity: a
   * higher-priority job for a cold worker beats a lower-priority
   * warm job. */
  priority?: number;
  /** Estimated wall duration (ms) from the cost model, or null when
   * the call site has no recorded actuals. Shortest-job-first
   * orders inside one priority tier; unknown costs sort as the
   * average of the known estimates in the queue, never as zero. */
  estDurationMs?: number | null;
  /** CPU-heavy job: counts against the CPU-slot quota at dispatch. */
  cpuHeavy?: boolean;
  /** Decision-model work: counts against the decision-rate quota. */
  isDecision?: boolean;
  /** Tokens this job is expected to consume (debited at dispatch). */
  tokensEst?: number;
}

export interface WorkerView {
  id: string;
  /** Spec of the worker's most recently completed job, or null. */
  lastSpec: string | null;
  /** When the worker last completed lastSpec (epoch ms), or null. */
  lastCompletedAt: number | null;
  /** Last completion time per spec (epoch ms). */
  completedAtBySpec: Record<string, number>;
}

export type SchedulerDecision =
  | "affinity-reserved"
  | "affinity-match"
  | "fallback-oldest"
  | "priority"
  | "shortest-first"
  | "none-available"
  | "none-quota";

export interface Selection {
  job: QueuedJobView | null;
  decision: SchedulerDecision;
  /** Why, in one line — journaled verbatim by the server. */
  reason: string;
}

export interface Scheduler {
  /**
   * Pick the best queued job for `worker` at `nowMs`, or null.
   * `affinityWorkerFor` maps a spec to the worker id that most
   * recently completed it (within the TTL), or null when no worker
   * is warm for that spec. Pure: no I/O, no mutation.
   */
  selectJobForWorker(
    worker: WorkerView,
    queued: QueuedJobView[],
    nowMs: number,
    affinityWorkerFor: (spec: string) => string | null,
  ): Selection;
}

export interface AffinitySchedulerConfig {
  affinityHoldMs?: number;
  affinityTtlMs?: number;
}

/** v0 scheduler: affinity preference + load-balancing fallback. */
export class AffinityScheduler implements Scheduler {
  readonly affinityHoldMs: number;
  readonly affinityTtlMs: number;

  constructor(config: AffinitySchedulerConfig = {}) {
    this.affinityHoldMs = config.affinityHoldMs ?? DEFAULT_AFFINITY_HOLD_MS;
    this.affinityTtlMs = config.affinityTtlMs ?? DEFAULT_AFFINITY_TTL_MS;
  }

  private warmFor(worker: WorkerView, spec: string, nowMs: number): boolean {
    const at = worker.completedAtBySpec[spec];
    return typeof at === "number" && nowMs - at <= this.affinityTtlMs;
  }

  selectJobForWorker(
    worker: WorkerView,
    queued: QueuedJobView[],
    nowMs: number,
    affinityWorkerFor: (spec: string) => string | null,
  ): Selection {
    if (!queued.length) {
      return { job: null, decision: "none-available", reason: "queue empty" };
    }
    const byAge = [...queued].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    // Takeable = not held for a different affinity worker.
    const takeable = byAge.filter((j) => {
      if (nowMs - j.enqueuedAt > this.affinityHoldMs) return true;
      const affinity = affinityWorkerFor(j.spec);
      return affinity === null || affinity === worker.id;
    });
    if (!takeable.length) {
      return {
        job: null,
        decision: "none-available",
        reason: `all ${queued.length} queued job(s) held for their affinity worker`,
      };
    }
    // 1. Reserved for this worker: this worker IS the affinity
    // worker and the job is inside its hold window.
    const reserved = takeable.filter((j) => {
      if (nowMs - j.enqueuedAt > this.affinityHoldMs) return false;
      return affinityWorkerFor(j.spec) === worker.id;
    });
    if (reserved.length) {
      return {
        job: reserved[0],
        decision: "affinity-reserved",
        reason: `job ${reserved[0].jobId} spec "${reserved[0].spec}" reserved for affinity worker ${worker.id} (hold window)`,
      };
    }
    // 2. Affinity match: this worker is warm for the spec.
    const match = takeable.filter(
      (j) => worker.lastSpec === j.spec && this.warmFor(worker, j.spec, nowMs),
    );
    if (match.length) {
      return {
        job: match[0],
        decision: "affinity-match",
        reason: `job ${match[0].jobId} spec "${match[0].spec}" matches worker ${worker.id} last completed spec (warm)`,
      };
    }
    // 3. Load-balancing fallback: oldest takeable job.
    return {
      job: takeable[0],
      decision: "fallback-oldest",
      reason: `no affinity job for worker ${worker.id}; oldest takeable job ${takeable[0].jobId} spec "${takeable[0].spec}"`,
    };
  }
}

/** Default aging step for dispatch: waiting this long improves a
 * job's effective priority by one step (starvation guard). */
export const DEFAULT_DISPATCH_AGING_MS = 5 * 60_000;

export interface DispatchSchedulerConfig extends AffinitySchedulerConfig {
  /** Ms of waiting per one-step priority improvement (default 5 min). */
  agingMs?: number;
}

/**
 * v1 scheduler (BRA-49): priority + affinity + cost, in that order.
 *
 * Selection, lexicographic:
 *   1. Takeable only — a job inside its hold window whose affinity
 *      worker is a DIFFERENT worker is not takeable (v0 rule kept).
 *   2. Effective priority: base priority (1 urgent … 4 low,
 *      default 3), improved one step per `agingMs` waited, capped
 *      at two steps, never below 1. Only the best-priority tier is
 *      considered — priority dominates affinity and cost.
 *   3. Affinity inside the tier: a job reserved for this worker
 *      (hold window) first, then a warm match for this worker.
 *      Affinity never promotes a job out of its priority tier.
 *   4. Cost inside the tier: lowest estimated duration first
 *      (shortest-job-first — a quick job does not wait behind a
 *      long one at the same priority). Unknown estimates sort as
 *      the average of the known estimates in the tier.
 *   5. Oldest first (FIFO tiebreak).
 *
 * The decision names the factor that actually selected the job:
 * "affinity-reserved" / "affinity-match" (affinity inside the best
 * tier), "priority" (the winner's tier beat every other takeable
 * job's tier), "shortest-first" (cost broke a tie inside the tier),
 * "fallback-oldest" (nothing distinguished it but age).
 * "none-quota" is never returned by the scheduler itself — the
 * server logs it when every candidate is quota-blocked.
 */
export class DispatchScheduler implements Scheduler {
  readonly affinityHoldMs: number;
  readonly affinityTtlMs: number;
  readonly agingMs: number;

  constructor(config: DispatchSchedulerConfig = {}) {
    this.affinityHoldMs = config.affinityHoldMs ?? DEFAULT_AFFINITY_HOLD_MS;
    this.affinityTtlMs = config.affinityTtlMs ?? DEFAULT_AFFINITY_TTL_MS;
    this.agingMs = config.agingMs ?? DEFAULT_DISPATCH_AGING_MS;
  }

  private warmFor(worker: WorkerView, spec: string, nowMs: number): boolean {
    const at = worker.completedAtBySpec[spec];
    return typeof at === "number" && nowMs - at <= this.affinityTtlMs;
  }

  /** Effective priority of a job at nowMs (aging included). */
  effectivePriority(job: QueuedJobView, nowMs: number): number {
    const base = typeof job.priority === "number" && job.priority >= 1 && job.priority <= 4 ? job.priority : 3;
    const waited = nowMs - job.enqueuedAt;
    if (waited <= 0 || this.agingMs <= 0) return base;
    const steps = Math.min(2, Math.floor(waited / this.agingMs));
    return Math.max(1, base - steps);
  }

  /** Cost used for ordering: the estimate, or the average of the
   * known estimates in `tier` when unknown, or Infinity when no
   * estimate is known anywhere in the tier. */
  private costOf(job: QueuedJobView, tier: QueuedJobView[]): number {
    if (typeof job.estDurationMs === "number" && Number.isFinite(job.estDurationMs)) return job.estDurationMs;
    const known = tier
      .map((j) => j.estDurationMs)
      .filter((e): e is number => typeof e === "number" && Number.isFinite(e));
    if (!known.length) return Number.POSITIVE_INFINITY;
    return known.reduce((a, b) => a + b, 0) / known.length;
  }

  private byCostThenAge(a: QueuedJobView, b: QueuedJobView, tier: QueuedJobView[]): number {
    const ca = this.costOf(a, tier);
    const cb = this.costOf(b, tier);
    if (ca !== cb) return ca - cb;
    return a.enqueuedAt - b.enqueuedAt;
  }

  selectJobForWorker(
    worker: WorkerView,
    queued: QueuedJobView[],
    nowMs: number,
    affinityWorkerFor: (spec: string) => string | null,
  ): Selection {
    if (!queued.length) {
      return { job: null, decision: "none-available", reason: "queue empty" };
    }
    const byAge = [...queued].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    // Takeable = not held for a different affinity worker.
    const takeable = byAge.filter((j) => {
      if (nowMs - j.enqueuedAt > this.affinityHoldMs) return true;
      const affinity = affinityWorkerFor(j.spec);
      return affinity === null || affinity === worker.id;
    });
    if (!takeable.length) {
      return {
        job: null,
        decision: "none-available",
        reason: `all ${queued.length} queued job(s) held for their affinity worker`,
      };
    }
    // Best effective-priority tier only.
    const bestPriority = Math.min(...takeable.map((j) => this.effectivePriority(j, nowMs)));
    const tier = takeable.filter((j) => this.effectivePriority(j, nowMs) === bestPriority);
    const tierBeatsOthers = tier.length < takeable.length;
    const inHold = (j: QueuedJobView): boolean => nowMs - j.enqueuedAt <= this.affinityHoldMs;

    // 1. Reserved for this worker inside the tier (hold window).
    const reserved = tier
      .filter((j) => inHold(j) && affinityWorkerFor(j.spec) === worker.id)
      .sort((a, b) => this.byCostThenAge(a, b, tier));
    if (reserved.length) {
      return {
        job: reserved[0],
        decision: "affinity-reserved",
        reason: `job ${reserved[0].jobId} spec "${reserved[0].spec}" priority ${bestPriority} reserved for affinity worker ${worker.id} (hold window)`,
      };
    }
    // 2. Affinity match inside the tier.
    const match = tier
      .filter((j) => worker.lastSpec === j.spec && this.warmFor(worker, j.spec, nowMs))
      .sort((a, b) => this.byCostThenAge(a, b, tier));
    if (match.length) {
      return {
        job: match[0],
        decision: "affinity-match",
        reason: `job ${match[0].jobId} spec "${match[0].spec}" priority ${bestPriority} matches worker ${worker.id} last completed spec (warm)`,
      };
    }
    // 3-4. Cost, then age, inside the tier.
    const ordered = [...tier].sort((a, b) => this.byCostThenAge(a, b, tier));
    const winner = ordered[0];
    const costsDiffer =
      ordered.length > 1 && this.costOf(ordered[0], tier) < this.costOf(ordered[ordered.length - 1], tier);
    if (tierBeatsOthers) {
      return {
        job: winner,
        decision: "priority",
        reason: `job ${winner.jobId} spec "${winner.spec}" at best effective priority ${bestPriority} (beats ${takeable.length - tier.length} lower-priority takeable job(s))`,
      };
    }
    if (costsDiffer) {
      return {
        job: winner,
        decision: "shortest-first",
        reason: `job ${winner.jobId} spec "${winner.spec}" priority ${bestPriority} shortest estimated cost (${Math.round(this.costOf(winner, tier))}ms) in tier`,
      };
    }
    return {
      job: winner,
      decision: "fallback-oldest",
      reason: `no affinity or cost distinction for worker ${worker.id} at priority ${bestPriority}; oldest takeable job ${winner.jobId} spec "${winner.spec}"`,
    };
  }
}
