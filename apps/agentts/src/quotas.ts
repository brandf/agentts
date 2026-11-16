// quotas — the four dispatch quotas (BRA-49), as a pure tracker.
//
//   - decision rate:   decision-model calls per second (sliding window)
//   - token budget:    tokens per hour (sliding window)
//   - CPU slots:       concurrent cpuHeavy jobs (counted live, not windowed)
//   - pool size:       concurrent running jobs (counted live)
//
// The tracker holds only the windowed state (decision timestamps,
// token debits); the live counts come from the store at check time,
// so a server restart cannot desync them. A limit of 0 means
// "unconfigured" (no enforcement) for the windowed quotas; for the
// live quotas 0 likewise means unlimited. The server is the
// enforcement point for pool dispatch: it asks `check` per candidate
// job and skips blocked ones (see worker-server.ts). The host's
// in-engine decide path uses `waitMsForDecision` (opt-in rate limit
// only — decideLocal consumes no tokens, so there is no token meter
// there; the token budget is debited at pool dispatch from the job's
// declared tokensEst).
//
// All times are epoch ms; the caller supplies `nowMs` so the tracker
// is unit-testable without clocks.

export interface QuotaConfig {
  /** Max decision-model calls per second (0 = unlimited). */
  maxDecisionsPerSec?: number;
  /** Max tokens per rolling hour (0 = unlimited). */
  maxTokensPerHour?: number;
  /** Max concurrent cpuHeavy jobs (0 = unlimited). */
  maxCpuSlots?: number;
  /** Max concurrent running jobs (0 = unlimited). */
  maxPoolSize?: number;
}

export interface QuotaCheck {
  allowed: boolean;
  /** Stable reason code when blocked ("" when allowed). */
  reason: string;
  /** Human line for the journal. */
  detail: string;
}

export interface LiveCounts {
  /** Running jobs right now. */
  running: number;
  /** Running cpuHeavy jobs right now. */
  cpuRunning: number;
}

export interface JobQuotaFlags {
  /** This job is decision-model work (counts against the rate). */
  isDecision?: boolean;
  /** This job is CPU-heavy (counts against CPU slots). */
  cpuHeavy?: boolean;
  /** Tokens this job is expected to consume (debited at dispatch). */
  tokensEst?: number;
}

export class QuotaTracker {
  /** Limits are mutable: the server loads saved window state with
   * fromJSON, then applies the current config over it. */
  maxDecisionsPerSec: number;
  maxTokensPerHour: number;
  maxCpuSlots: number;
  maxPoolSize: number;

  /** Epoch ms of each dispatched decision (sliding 1s window). */
  private decisionAt: number[] = [];
  /** { at, tokens } debits inside the rolling hour. */
  private tokenDebits: { at: number; tokens: number }[] = [];

  constructor(config: QuotaConfig = {}) {
    this.maxDecisionsPerSec = config.maxDecisionsPerSec ?? 0;
    this.maxTokensPerHour = config.maxTokensPerHour ?? 0;
    this.maxCpuSlots = config.maxCpuSlots ?? 0;
    this.maxPoolSize = config.maxPoolSize ?? 0;
  }

  private prune(nowMs: number): void {
    const secAgo = nowMs - 1000;
    while (this.decisionAt.length && this.decisionAt[0] <= secAgo) this.decisionAt.shift();
    const hourAgo = nowMs - 3_600_000;
    while (this.tokenDebits.length && this.tokenDebits[0].at <= hourAgo) this.tokenDebits.shift();
  }

  /** Tokens debited inside the rolling hour ending at nowMs. */
  tokensUsedThisHour(nowMs: number): number {
    this.prune(nowMs);
    return this.tokenDebits.reduce((a, d) => a + d.tokens, 0);
  }

  /** Decisions dispatched inside the last second ending at nowMs. */
  decisionsLastSecond(nowMs: number): number {
    this.prune(nowMs);
    return this.decisionAt.length;
  }

  /** Would dispatching `job` right now violate a quota? Pure check:
   * it does not record anything — call `recordDispatch` after a
   * dispatch is actually made. */
  check(job: JobQuotaFlags, live: LiveCounts, nowMs: number): QuotaCheck {
    this.prune(nowMs);
    if (this.maxPoolSize > 0 && live.running >= this.maxPoolSize) {
      return {
        allowed: false,
        reason: "pool-full",
        detail: `pool full: ${live.running}/${this.maxPoolSize} running`,
      };
    }
    if (job.cpuHeavy && this.maxCpuSlots > 0 && live.cpuRunning >= this.maxCpuSlots) {
      return {
        allowed: false,
        reason: "cpu-full",
        detail: `CPU slots full: ${live.cpuRunning}/${this.maxCpuSlots} cpuHeavy running`,
      };
    }
    if (job.isDecision && this.maxDecisionsPerSec > 0 && this.decisionAt.length >= this.maxDecisionsPerSec) {
      return {
        allowed: false,
        reason: "decision-rate",
        detail: `decision rate full: ${this.decisionAt.length}/${this.maxDecisionsPerSec} per second`,
      };
    }
    const tokensEst = job.tokensEst ?? 0;
    if (tokensEst > 0 && this.maxTokensPerHour > 0) {
      const used = this.tokensUsedThisHour(nowMs);
      if (used + tokensEst > this.maxTokensPerHour) {
        return {
          allowed: false,
          reason: "token-budget",
          detail: `token budget full: ${used} + ${tokensEst} est exceeds ${this.maxTokensPerHour}/hour`,
        };
      }
    }
    return { allowed: true, reason: "", detail: "within quotas" };
  }

  /** Record an actual dispatch (call only after `check` allowed it). */
  recordDispatch(job: JobQuotaFlags, nowMs: number): void {
    this.prune(nowMs);
    if (job.isDecision) this.decisionAt.push(nowMs);
    const tokensEst = job.tokensEst ?? 0;
    if (tokensEst > 0) this.tokenDebits.push({ at: nowMs, tokens: tokensEst });
  }

  /** Ms the host must wait before its next decide call at nowMs
   * (0 when within the rate). Only the decision rate applies here. */
  waitMsForDecision(nowMs: number): number {
    if (this.maxDecisionsPerSec <= 0) return 0;
    this.prune(nowMs);
    if (this.decisionAt.length < this.maxDecisionsPerSec) return 0;
    return Math.max(0, this.decisionAt[0] + 1000 - nowMs);
  }

  /** Record a decide call made in-engine (host path). */
  noteDecision(nowMs: number): void {
    this.prune(nowMs);
    this.decisionAt.push(nowMs);
  }

  toJSON(): { decisionAt: number[]; tokenDebits: { at: number; tokens: number }[] } {
    return { decisionAt: [...this.decisionAt], tokenDebits: this.tokenDebits.map((d) => ({ ...d })) };
  }

  static fromJSON(data: unknown): QuotaTracker {
    const t = new QuotaTracker();
    if (!data || typeof data !== "object") return t;
    const d = data as { decisionAt?: unknown; tokenDebits?: unknown };
    if (Array.isArray(d.decisionAt)) {
      t.decisionAt = d.decisionAt.filter((x): x is number => typeof x === "number");
    }
    if (Array.isArray(d.tokenDebits)) {
      t.tokenDebits = d.tokenDebits.filter(
        (x): x is { at: number; tokens: number } =>
          !!x && typeof (x as any).at === "number" && typeof (x as any).tokens === "number",
      );
    }
    return t;
  }
}
