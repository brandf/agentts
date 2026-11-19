// Baselines + thresholds + the ratchet rule (BRA-93).
//
// One file owns the baseline format so run.ts (--write-baselines) and
// check.ts (compare + ratchet + loosen) cannot drift apart.
//
// Threshold rule (justified from the measurements, not invented):
//   latency metrics: threshold = baseline x 3.0. Two independent
//     full-suite runs showed run-to-run median swings up to ~2.2x
//     under concurrent load (slice_spawn 20.5 -> 43.6ms), so 2x would
//     false-positive on machine load alone; 3x sits above demonstrated
//     noise while still catching a genuine 3x+ regression.
//   byte metrics (snapshot sizes are deterministic for a fixed input):
//     threshold = baseline x 1.1. A 10% growth in snapshot bytes means
//     the snapshot format or the live heap changed — worth flagging.
// The multiple is stored per metric so a metric can carry its own
// justification; changing a multiple is a human decision, recorded
// in ratchet.log like a loosen.
//
// Ratchet rule (Brandon): auto-tighten only, per metric.
//   - Each check run appends the metric's median to `history`
//     (last 10 observations kept) and updates `greenStreak`:
//     an observation <= 0.80 x threshold increments the streak,
//     anything above that (but still green) resets it to 0, and a
//     breach (observation > threshold) resets it to 0 and fails.
//   - When greenStreak reaches RATCHET_K = 5 consecutive observations
//     each beating the threshold by >= 20%, the metric ratchets —
//     but ONLY on a decisive improvement (BRA-107): the window median
//     must also be <= RATCHET_DECISIVE (0.80) x the old baseline.
//     Otherwise the streak resets without moving (the metric is green
//     but not decisively faster, so the baseline stays). This stops
//     the ratchet chasing the quiet floor in small steps: without it
//     a streak of observations up to 2.4x the old baseline (0.80x a
//     3.0x threshold) could ratchet the baseline down to a median
//     barely below the old one, and the next loaded run would breach
//     the tightened threshold. With the decisive rule the clamp below
//     is a safety net rather than the active rule, since a decisive
//     median is always below the old baseline.
//     newBaseline = min(median of those 5 observations, old baseline),
//     newThreshold = newBaseline x multiple, greenStreak resets to 0.
//     Tighten-only (BRA-107): the window median can exceed the old
//     baseline, so the ratchet never moves a baseline up. When the
//     clamp binds (median >= old baseline) nothing changes: the
//     streak resets and the observation counts as green.
//     The ratchet is appended to ratchet.log with before/after numbers.
//   - Never ratchet on a single good run: one observation is noise.
//   - Loosening is NEVER automatic. `check.ts loosen <metric>
//     <newBaseline> --reason "..."` is the only path: it sets the
//     baseline, recomputes the threshold from the multiple, clears
//     history/streak, and logs a MANUAL-LOOSEN entry with the reason.
import * as fs from "node:fs";
import * as path from "node:path";

export const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);
export const BASELINES_PATH = path.join(BENCH_DIR, "baselines.json");
export const RATCHET_LOG_PATH = path.join(BENCH_DIR, "ratchet.log");

export const RATCHET_K = 5; // consecutive observations to trigger a ratchet
export const RATCHET_MARGIN = 0.8; // observation must beat threshold by >=20%
export const RATCHET_DECISIVE = 0.8; // ratchet only when the window median is <= 0.80x the OLD BASELINE (BRA-107)
export const HISTORY_KEEP = 10; // observations retained per metric

export const MULTIPLES: Record<string, number> = {
  // Latency: 3.0x. Justification — two independent full-suite runs
  // (2026-11-16, flush worker running concurrently) showed run-to-run
  // median swings up to ~2.2x on spawn/bundle/blob-recipe metrics
  // (slice_spawn 20.5 -> 43.6ms; bundle 10.3 -> 5.1ms; blob recipe
  // 19.6 -> 8.8ms). A 2x bound would false-positive on machine load
  // alone. 3x sits above demonstrated noise and still catches a
  // genuine 3x+ regression. The ratchet (below) tightens the baseline
  // itself toward the true median over time; the multiple is the alarm
  // sensitivity, not the baseline.
  latency: 3.0,
  // Bytes: 1.1x. Snapshot bytes are deterministic for a fixed input
  // (36,472B @1KB and 547,463B @500KB reproduced the Nov 16 BRA-90
  // measurement of 35,522B / 546,502B within 3%). A 10% growth means
  // the snapshot format or the live heap changed.
  bytes: 1.1,
  // Counts: 1.0x. A count metric (BRA-100: fresh CLI invocations per
  // unit of work) is deterministic by construction — the bench counts
  // the spawns it performed, and the same sequence yields the same
  // count on every run. Any increase is a real change to the loop
  // (a CLI call added), not noise, so the threshold equals the
  // baseline and any increase fails the gate loudly for review. The
  // ratchet can never fire on a count: a green observation must beat
  // 0.80x the threshold, impossible for an exact count.
  count: 1.0,
};

export interface BaselineEntry {
  unit: string;
  kind: "latency" | "bytes" | "count";
  baseline: number;
  threshold: number;
  multiple: number;
  history: number[];
  greenStreak: number;
  note?: string;
}

export interface BaselinesFile {
  version: 1;
  generated: string;
  codeFingerprint: Record<string, string>;
  multiples: Record<string, number>;
  ratchet: { k: number; margin: number; decisive: number; historyKeep: number };
  metrics: Record<string, BaselineEntry>;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function thresholdFor(baseline: number, multiple: number): number {
  return Math.round(baseline * multiple * 100) / 100;
}

/** Build a fresh baselines file from measured medians. The caller
 * (run.ts --write-baselines) has already reviewed the numbers: this
 * only formats them, it never invents a baseline. */
export function writeBaselinesFile(
  results: Array<{ id: string; unit: string; median: number; note?: string }>,
  codeFingerprint: Record<string, string>,
): void {
  const metrics: Record<string, BaselineEntry> = {};
  for (const r of results) {
    const kind = r.unit === "bytes" ? "bytes" : r.unit === "invocations" ? "count" : "latency";
    const multiple = MULTIPLES[kind];
    metrics[r.id] = {
      unit: r.unit,
      kind,
      baseline: r.median,
      threshold: thresholdFor(r.median, multiple),
      multiple,
      history: [],
      greenStreak: 0,
      note: r.note,
    };
  }
  const file: BaselinesFile = {
    version: 1,
    generated: new Date().toISOString(),
    codeFingerprint,
    multiples: MULTIPLES,
    ratchet: { k: RATCHET_K, margin: RATCHET_MARGIN, decisive: RATCHET_DECISIVE, historyKeep: HISTORY_KEEP },
    metrics,
  };
  fs.writeFileSync(BASELINES_PATH, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${BASELINES_PATH} (${Object.keys(metrics).length} metrics)`);
}

export function loadBaselines(): BaselinesFile {
  if (!fs.existsSync(BASELINES_PATH)) {
    throw new Error(
      `no baselines file at ${BASELINES_PATH} — run \`bun bench/run.ts --write-baselines\` first and review the numbers`,
    );
  }
  return JSON.parse(fs.readFileSync(BASELINES_PATH, "utf8")) as BaselinesFile;
}

export function saveBaselines(file: BaselinesFile): void {
  fs.writeFileSync(BASELINES_PATH, JSON.stringify(file, null, 2) + "\n");
}

export function logRatchet(line: string): void {
  fs.appendFileSync(RATCHET_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
}

/** Apply one observation to a metric's ratchet state. Returns
 * "breach" | "ratcheted" | "green" | "green-no-streak". Mutates the
 * entry in place (history/streak/baseline/threshold) and logs any
 * ratchet. Never loosens: a breach only fails and resets the streak,
 * and the ratchet itself never moves a baseline up (BRA-107):
 * newBaseline = min(window median, old baseline); when the clamp
 * binds the streak resets and the outcome is green, with no ratchet
 * logged. The ratchet also fires only on a decisive improvement
 * (BRA-107 (c)): window median <= 0.80x old baseline; otherwise the
 * streak resets with no move and no ratchet logged. */
export function applyObservation(
  entry: BaselineEntry,
  metricId: string,
  observed: number,
): "breach" | "ratcheted" | "green" | "green-no-streak" {
  entry.history.push(observed);
  if (entry.history.length > HISTORY_KEEP) entry.history = entry.history.slice(-HISTORY_KEEP);
  if (observed > entry.threshold) {
    entry.greenStreak = 0;
    return "breach";
  }
  if (observed <= RATCHET_MARGIN * entry.threshold) {
    entry.greenStreak += 1;
  } else {
    entry.greenStreak = 0;
    return "green-no-streak";
  }
  if (entry.greenStreak >= RATCHET_K) {
    const window = entry.history.slice(-RATCHET_K);
    const oldBaseline = entry.baseline;
    const oldThreshold = entry.threshold;
    const windowMedian = Math.round(median(window) * 100) / 100;
    // BRA-107 (c): ratchet only on a decisive improvement. A streak
    // of observations each <= 0.80x threshold can still have a window
    // median barely below (or above) the old baseline; ratcheting to
    // that median chases the quiet floor in small steps and the next
    // loaded run breaches the tightened threshold. If the median is
    // not decisively below the old baseline, reset the streak without
    // moving — same outcome as the clamp binding below, no ratchet
    // logged.
    if (windowMedian > RATCHET_DECISIVE * oldBaseline) {
      entry.greenStreak = 0;
      return "green";
    }
    // BRA-107: tighten-only. The window median can exceed the old
    // baseline (a streak observation only needs <= 0.80x threshold,
    // i.e. up to 2.4x the old baseline for latency), so clamp:
    // newBaseline = min(window median, old baseline). When the clamp
    // binds there is nothing to tighten — reset the streak and count
    // the observation green, with no ratchet logged. With the decisive
    // rule above the clamp is a safety net: a decisive median is
    // always below the old baseline, so the clamp should never bind.
    const newBaseline = Math.min(windowMedian, oldBaseline);
    if (newBaseline >= oldBaseline) {
      entry.greenStreak = 0;
      return "green";
    }
    entry.baseline = newBaseline;
    entry.threshold = thresholdFor(newBaseline, entry.multiple);
    entry.greenStreak = 0;
    logRatchet(
      `RATCHET ${metricId} baseline ${oldBaseline} -> ${newBaseline} ${entry.unit}, ` +
        `threshold ${oldThreshold} -> ${entry.threshold} (x${entry.multiple}), ` +
        `window [${window.join(", ")}]`,
    );
    return "ratcheted";
  }
  return "green";
}

/** Manual loosen (the ONLY loosen path): human decision, reason
 * required, logged. Resets history/streak so the new baseline must
 * earn its own ratchet from scratch. */
export function loosenBaseline(
  file: BaselinesFile,
  metricId: string,
  newBaseline: number,
  reason: string,
): void {
  const entry = file.metrics[metricId];
  if (!entry) throw new Error(`unknown metric: ${metricId}`);
  if (!reason.trim()) throw new Error("loosen requires a --reason (human decision, recorded)");
  if (!(newBaseline > 0)) throw new Error(`loosen requires a positive baseline, got ${newBaseline}`);
  const oldBaseline = entry.baseline;
  const oldThreshold = entry.threshold;
  entry.baseline = newBaseline;
  entry.threshold = thresholdFor(newBaseline, entry.multiple);
  entry.history = [];
  entry.greenStreak = 0;
  logRatchet(
    `MANUAL-LOOSEN ${metricId} baseline ${oldBaseline} -> ${newBaseline} ${entry.unit}, ` +
      `threshold ${oldThreshold} -> ${entry.threshold} (x${entry.multiple}), reason: ${reason}`,
  );
}
