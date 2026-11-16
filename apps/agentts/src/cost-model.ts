// cost-model — per-call-site cost estimates from recorded actuals (BRA-49).
//
// A call site is a trap's provenance: `<type>:<siteKey>` for in-engine
// traps (the site key is the extraction key the host already journals
// per trap), or `job:<spec>` for worker-pool jobs. The plugin records
// actuals per call site and estimates cost before dispatch; the
// scheduler uses the estimate for shortest-job-first ordering inside
// a priority tier.
//
// Where actuals come from (decided hands-dirty, BRA-49 — updated
// BRA-57): the journal now carries wallTs + per-trap wallMs (journal
// format v2), the same measurement recorded here — but the scheduler
// keeps reading this log, not the journal: the log is the
// scheduler's append-only input, the journal is the profiler's
// source of truth, and neither is derived from the other. Two real
// sources:
//   - Worker-pool jobs: the server measures assignedAt -> completedAt
//     (epoch ms, already in the store) and records `job:<spec>`.
//   - In-engine traps: the host times dispatchTrap in-process and
//     appends one JSON line per trap to <stateDir>/cost-actuals.jsonl
//     (a separate log, never the journal). `loadActualsFile` reads it.
// An estimate is { meanMs, varianceMs, p90Ms, n }. Unknown sites
// (n = 0) return null — the scheduler must not invent a cost for a
// site it has never seen; it treats unknown as the queue average
// (see scheduler.ts), never as zero.

import * as fs from "node:fs";
import * as path from "node:path";

export interface CostEstimate {
  site: string;
  /** Mean wall duration over recorded actuals (ms). */
  meanMs: number;
  /** Population variance of wall duration (ms^2). */
  varianceMs: number;
  /** 90th percentile wall duration (ms). */
  p90Ms: number;
  /** Number of actuals behind the estimate. */
  n: number;
}

export interface CostActual {
  site: string;
  /** Wall duration in ms. */
  ms: number;
  /** Estimated tokens consumed by this call, when known (0/omitted otherwise). */
  tokens?: number;
  runId?: string;
  trapId?: string;
  ts?: string;
}

/** Samples kept per site for the p90 (bounded memory). */
export const MAX_SAMPLES_PER_SITE = 200;

interface SiteStats {
  n: number;
  sum: number;
  sumSq: number;
  tokens: number;
  samples: number[];
}

export class CostModel {
  private sites = new Map<string, SiteStats>();

  record(actual: CostActual): void {
    if (!actual || typeof actual.site !== "string" || !actual.site) return;
    if (typeof actual.ms !== "number" || !Number.isFinite(actual.ms) || actual.ms < 0) return;
    let s = this.sites.get(actual.site);
    if (!s) {
      s = { n: 0, sum: 0, sumSq: 0, tokens: 0, samples: [] };
      this.sites.set(actual.site, s);
    }
    s.n += 1;
    s.sum += actual.ms;
    s.sumSq += actual.ms * actual.ms;
    if (typeof actual.tokens === "number" && Number.isFinite(actual.tokens) && actual.tokens > 0) {
      s.tokens += actual.tokens;
    }
    s.samples.push(actual.ms);
    if (s.samples.length > MAX_SAMPLES_PER_SITE) s.samples.shift();
  }

  estimate(site: string): CostEstimate | null {
    const s = this.sites.get(site);
    if (!s || s.n === 0) return null;
    const meanMs = s.sum / s.n;
    const varianceMs = Math.max(0, s.sumSq / s.n - meanMs * meanMs);
    const sorted = [...s.samples].sort((a, b) => a - b);
    const p90Ms = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))];
    return { site, meanMs, varianceMs, p90Ms, n: s.n };
  }

  /** Mean tokens per call at this site (0 when nothing recorded). */
  meanTokens(site: string): number {
    const s = this.sites.get(site);
    if (!s || s.n === 0) return 0;
    return s.tokens / s.n;
  }

  sitesKnown(): string[] {
    return [...this.sites.keys()].sort();
  }

  allEstimates(): CostEstimate[] {
    return this.sitesKnown()
      .map((site) => this.estimate(site))
      .filter((e): e is CostEstimate => e !== null);
  }

  /** Plain JSON for persistence (samples included, capped). */
  toJSON(): Record<string, { n: number; sum: number; sumSq: number; tokens: number; samples: number[] }> {
    const out: Record<string, { n: number; sum: number; sumSq: number; tokens: number; samples: number[] }> = {};
    for (const [site, s] of this.sites) out[site] = { ...s, samples: [...s.samples] };
    return out;
  }

  static fromJSON(data: unknown): CostModel {
    const m = new CostModel();
    if (!data || typeof data !== "object") return m;
    for (const [site, raw] of Object.entries(data as Record<string, any>)) {
      if (!raw || typeof raw.n !== "number") continue;
      m.sites.set(site, {
        n: raw.n,
        sum: typeof raw.sum === "number" ? raw.sum : 0,
        sumSq: typeof raw.sumSq === "number" ? raw.sumSq : 0,
        tokens: typeof raw.tokens === "number" ? raw.tokens : 0,
        samples: Array.isArray(raw.samples) ? raw.samples.filter((x: unknown) => typeof x === "number") : [],
      });
    }
    return m;
  }

  saveToFile(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2));
    fs.renameSync(tmp, file);
  }

  static loadFromFile(file: string): CostModel {
    if (!fs.existsSync(file)) return new CostModel();
    try {
      return CostModel.fromJSON(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return new CostModel();
    }
  }
}

/** Build a model from one JSONL actuals file (host trap actuals).
 * Corrupt lines are skipped, never fatal — a cost log must not
 * break a run. Returns the model plus the skipped-line count. */
export function loadActualsFile(file: string): { model: CostModel; skipped: number } {
  const model = new CostModel();
  let skipped = 0;
  if (!fs.existsSync(file)) return { model, skipped };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.site !== "string" || typeof e?.ms !== "number") throw new Error("not an actual");
      model.record({ site: e.site, ms: e.ms, tokens: e.tokens, runId: e.runId, trapId: e.trapId, ts: e.ts });
    } catch {
      skipped += 1;
    }
  }
  return { model, skipped };
}

/** Append one trap actual to the host cost log. Best-effort: a
 * failure to write the log must never fail the trap it measures. */
export function appendTrapActual(file: string, actual: CostActual): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...actual, ts: actual.ts ?? new Date().toISOString() }) + "\n");
  } catch {
    /* cost logging is best-effort */
  }
}
