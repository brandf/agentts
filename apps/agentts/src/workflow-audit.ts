// Workflow efficiency audit + ratchet (BRA-166).
//
// The bench already has this discipline for the C-host suite
// (bench/check.ts + baselines.json + ratchet.log: tighten-only ratchet,
// confirm-before-fail, human-approved loosening with a recorded reason
// — BRA-107, BRA-127). No equivalent existed for workflows: a workflow
// could get slower or more token-hungry across releases and nobody
// would notice. This is the workflow equivalent, reading the BRA-165
// run ledger (<stateDir>/ledger/run-ledger.jsonl).
//
// Model (deliberately the bench model, applied to ledger data):
//   - One metric per workflow per dimension: `<workflow>::wallMs`
//     (latency, ms) and `<workflow>::tokens` (tokens per run).
//     Threshold = baseline x multiple; multiples are latency 3.0 and
//     tokens 3.0. The latency 3.0 is the bench justification verbatim
//     (run-to-run medians swing ~2.2x under load, so 2x would
//     false-positive; 3x sits above demonstrated noise). Tokens get
//     3.0 for the same reason: token totals vary with input size (how
//     many papers were judged, how long the abstracts were), so a
//     tight bound would false-positive on input alone; 3x catches a
//     genuine blowup (a workflow suddenly judging 3x the papers, or
//     looping). A multiple is stored per metric so a human can change
//     it with a recorded reason, like a loosen.
//   - Observation window: the median of the last 5 done runs (bench
//     reps = 5). Only DONE runs feed a median — a failed run's wall
//     time is failure behavior, not efficiency, and is reported but
//     excluded. A run whose wallMs is null (v1 journal) is likewise
//     excluded from the wall median.
//   - Confirm-before-fail (BRA-107 (b), ledger analog): the bench
//     re-runs the suite once on a breach. There is no live suite to
//     re-run here — the observation IS the ledger — so a breach is
//     confirmed against the most recent runs: if the last 3 runs are
//     green, the breach was stale (slow runs aging out of the window
//     after the workflow already recovered) and the check passes with
//     the breaching observation discarded, never recorded; if the
//     last 3 still breach, the regression is current and the check
//     fails. A single stalled run can never breach a 5-run median at
//     all, so the confirm step guards the case that matters: a
//     regression that already healed.
//   - Tighten-only ratchet (BRA-107): the bench rule verbatim —
//     K = 5 consecutive observations each beating the threshold by
//     >= 20% (<= 0.80x threshold), and only on a decisive
//     improvement (window median <= 0.80x the old baseline); the new
//     baseline is min(window median, old baseline), so it never moves
//     up. Ratchets are logged to <stateDir>/ledger/workflow-ratchet.log.
//   - "Sustained" means sustained over runs, not over audit
//     invocations: a green observation is recorded only when new
//     runs landed since the last observation (tracked per metric).
//     Re-running the audit with no new runs re-checks the same data
//     but records nothing — five audits of an unchanged ledger must
//     not manufacture a ratchet.
//   - Loosening is NEVER automatic. `loosen` (below) is the only
//     path: human decision, reason required, logged.
//   - Seeding: a workflow with no baseline and >= 3 runs seeds its
//     baseline from the window median (reported SEEDED, not a
//     failure). Fewer than 3 runs is NO-BASELINE — reported, skipped,
//     never a failure. A bad seed corrects itself downward through
//     the ratchet; a bad seed that is too low is caught by
//     confirm-before-fail and can be loosened by a human.
//
// Two deliberate deviations from a literal "median wall clock":
//   - The wall metric is ACTIVE wall time: wallMs minus gateHoldMs
//     when the gate hold is known. Gate-hold time is human waiting,
//     not workflow slowness — a run that waited a week at a gate
//     would otherwise read as a 1000x regression. The report line
//     carries the raw wallMs alongside the active figure so nothing
//     is hidden.
//   - Tokens are explicit unknown, never zero (the BRA-165 rule,
//     same as rankQueueByLedgerCost). A workflow with no
//     token-reporting runs gets verdict UNKNOWN for its tokens
//     metric — not a pass, not a failure, no baseline. When some
//     runs report tokens, the median is over reporting runs only.
//
// Baselines live with the ledger, not in the repo: wall time is
// machine-dependent and the ledger is per state dir, so
// <stateDir>/ledger/workflow-baselines.json is the right home —
// and it keeps a copy's audit runs from ever drifting the repo's
// bench/baselines.json. A corrupt baselines file fails loudly (it
// is a small JSON file we own; silent tolerance would hide a broken
// check) — unlike the ledger, whose corrupt lines are skipped.
//
// Runnable: bun src/workflow-audit.ts [--state-dir DIR]
//           [--workflows a,b] [--window N]
//           bun src/workflow-audit.ts loosen <metric> <newBaseline>
//           --reason "..." [--state-dir DIR]
// Exit 0: no failures. Exit 1: a regression was confirmed, the
// baselines file is corrupt, or the arguments are bad.
import * as fs from "node:fs";
import * as path from "node:path";

import { loadLedger, ledgerFile, type LedgerEntry } from "./run-ledger";

/** Audit format version (bump only on a breaking baselines change). */
export const AUDIT_VERSION = 1;

/** Runs in the observation window (bench reps = 5). */
export const AUDIT_WINDOW = 5;
/** Runs needed before a baseline can be seeded from the median. */
export const AUDIT_MIN_RUNS = 3;
/** Ratchet streak (bench RATCHET_K). */
export const AUDIT_K = 5;
/** An observation must beat the threshold by >= 20% to count
 * toward the streak (bench RATCHET_MARGIN). */
export const AUDIT_MARGIN = 0.8;
/** Ratchet only when the window median is <= 0.80x the old
 * baseline (bench RATCHET_DECISIVE). */
export const AUDIT_DECISIVE = 0.8;
/** Observations retained per metric (bench HISTORY_KEEP). */
export const AUDIT_HISTORY_KEEP = 10;

export const AUDIT_MULTIPLES: Record<"latency" | "tokens", number> = {
  latency: 3.0,
  tokens: 3.0,
};

/** Where the workflow baselines live under a state dir. */
export function workflowBaselinesFile(stateDir: string): string {
  return path.join(stateDir, "ledger", "workflow-baselines.json");
}

/** Where audit ratchet / loosen events are logged. */
export function workflowRatchetLog(stateDir: string): string {
  return path.join(stateDir, "ledger", "workflow-ratchet.log");
}

export interface WorkflowBaselineEntry {
  unit: "ms" | "tokens";
  kind: "latency" | "tokens";
  baseline: number;
  threshold: number;
  multiple: number;
  history: number[];
  greenStreak: number;
  /** RunId of the newest ledger entry observed the last time this
   * metric recorded an observation (or seeded). A green observation
   * is recorded only when new runs landed since — see the header. */
  lastObservedRunId?: string;
  note?: string;
}

export interface WorkflowBaselinesFile {
  version: 1;
  generated: string;
  metrics: Record<string, WorkflowBaselineEntry>;
}

export function auditMetricId(workflow: string, metric: "wallMs" | "tokens"): string {
  return `${workflow}::${metric}`;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function thresholdFor(baseline: number, multiple: number): number {
  return Math.round(baseline * multiple * 100) / 100;
}

/** Active wall time of a run: wallMs minus gate-hold time when both
 * are known. Null when the run's wall time is unknown (v1 journal).
 * Gate-hold time is human waiting, not workflow slowness — see the
 * header. */
export function activeWallMs(e: LedgerEntry): number | null {
  if (typeof e.wallMs !== "number") return null;
  return e.wallMs - (typeof e.gateHoldMs === "number" ? e.gateHoldMs : 0);
}

export interface WorkflowObservations {
  workflow: string;
  /** Done runs in the window (any wall time). */
  doneRuns: number;
  /** Failed runs in the window (reported, never fed to a median). */
  failedRuns: number;
  /** Median active wallMs over done runs with a known wall time. */
  wallMedian: number | null;
  /** How many runs fed the wall median. */
  wallRuns: number;
  /** Median tokens.total over done runs that reported tokens. */
  tokenMedian: number | null;
  /** How many runs fed the token median. */
  tokenRuns: number;
  /** RunId of the newest ledger entry in the window (any status),
   * or null when the workflow has no entries in the window. */
  newestRunId: string | null;
}

/** Observe one workflow over its last `window` ledger entries
 * (append order = time order). Pure: no I/O. */
export function observeWorkflow(
  entries: LedgerEntry[],
  workflow: string,
  window: number = AUDIT_WINDOW,
): WorkflowObservations {
  const mine = entries.filter((e) => e.workflow === workflow).slice(-window);
  const done = mine.filter((e) => e.status === "done");
  const walls = done.map(activeWallMs).filter((w): w is number => w !== null);
  const tokens = done
    .map((e) => e.tokens?.total)
    .filter((t): t is number => typeof t === "number");
  return {
    workflow,
    doneRuns: done.length,
    failedRuns: mine.filter((e) => e.status === "failed").length,
    wallMedian: walls.length > 0 ? median(walls) : null,
    wallRuns: walls.length,
    tokenMedian: tokens.length > 0 ? median(tokens) : null,
    tokenRuns: tokens.length,
    newestRunId: mine.length > 0 ? mine[mine.length - 1].runId : null,
  };
}

export type AuditVerdict = "pass" | "fail" | "confirmed-pass" | "seeded" | "unknown" | "no-baseline";

export interface AuditMetricResult {
  metricId: string;
  workflow: string;
  metric: "wallMs" | "tokens";
  verdict: AuditVerdict;
  /** Window median that was compared (null when unobserved). */
  observed: number | null;
  /** Runs that fed the observed median. */
  observedRuns: number;
  baseline: number | null;
  threshold: number | null;
  /** Longer-window median, when a breach was confirmed or cleared. */
  confirmObserved: number | null;
  /** True when this observation ratcheted the baseline down. */
  ratcheted: boolean;
  /** One line, numbers included. */
  detail: string;
}

export interface AuditReport {
  workflows: string[];
  results: AuditMetricResult[];
  /** Per-workflow observations (window medians, run counts, failed
   * runs) behind the results. */
  observations: WorkflowObservations[];
  failures: number;
  seeded: string[];
  /** Ratchet / loosen lines to append to the ratchet log. */
  ratchetLogLines: string[];
  ok: boolean;
}

/** Apply one observation to a metric's ratchet state — the bench
 * rule verbatim (bench/baselines.ts applyObservation), with the
 * log line returned instead of written so the caller owns I/O.
 * Mutates the entry in place (history/streak/baseline/threshold).
 * Never loosens: a breach only fails and resets the streak, and the
 * ratchet never moves a baseline up. */
export function applyAuditObservation(
  entry: WorkflowBaselineEntry,
  metricId: string,
  observed: number,
): { outcome: "breach" | "ratcheted" | "green" | "green-no-streak"; logLine: string | null } {
  entry.history.push(observed);
  if (entry.history.length > AUDIT_HISTORY_KEEP) entry.history = entry.history.slice(-AUDIT_HISTORY_KEEP);
  if (observed > entry.threshold) {
    entry.greenStreak = 0;
    return { outcome: "breach", logLine: null };
  }
  if (observed <= AUDIT_MARGIN * entry.threshold) {
    entry.greenStreak += 1;
  } else {
    entry.greenStreak = 0;
    return { outcome: "green-no-streak", logLine: null };
  }
  if (entry.greenStreak >= AUDIT_K) {
    const window = entry.history.slice(-AUDIT_K);
    const oldBaseline = entry.baseline;
    const oldThreshold = entry.threshold;
    const windowMedian = Math.round(median(window) * 100) / 100;
    // Decisive improvement only (BRA-107 (c)): a streak whose
    // window median is not decisively below the old baseline resets
    // without moving — the ratchet must not chase the quiet floor.
    if (windowMedian > AUDIT_DECISIVE * oldBaseline) {
      entry.greenStreak = 0;
      return { outcome: "green", logLine: null };
    }
    // Tighten-only: newBaseline = min(window median, old baseline).
    // With the decisive rule the clamp is a safety net — a decisive
    // median is always below the old baseline.
    const newBaseline = Math.min(windowMedian, oldBaseline);
    if (newBaseline >= oldBaseline) {
      entry.greenStreak = 0;
      return { outcome: "green", logLine: null };
    }
    entry.baseline = newBaseline;
    entry.threshold = thresholdFor(newBaseline, entry.multiple);
    entry.greenStreak = 0;
    return {
      outcome: "ratcheted",
      logLine:
        `AUDIT-RATCHET ${metricId} baseline ${oldBaseline} -> ${newBaseline} ${entry.unit}, ` +
        `threshold ${oldThreshold} -> ${entry.threshold} (x${entry.multiple}), ` +
        `window [${window.join(", ")}]`,
    };
  }
  return { outcome: "green", logLine: null };
}

/** Manual loosen (the ONLY loosen path): human decision, reason
 * required, logged. Resets history/streak so the new baseline must
 * earn its own ratchet from scratch. Returns the log line. */
export function loosenAuditBaseline(
  file: WorkflowBaselinesFile,
  metricId: string,
  newBaseline: number,
  reason: string,
): string {
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
  return (
    `AUDIT-MANUAL-LOOSEN ${metricId} baseline ${oldBaseline} -> ${newBaseline} ${entry.unit}, ` +
    `threshold ${oldThreshold} -> ${entry.threshold} (x${entry.multiple}), reason: ${reason}`
  );
}

function emptyBaselinesFile(): WorkflowBaselinesFile {
  return { version: 1, generated: new Date().toISOString(), metrics: {} };
}

/** Load the workflow baselines for a state dir. A missing file is
 * an empty baselines file (first audit seeds from the ledger). A
 * corrupt file fails loudly — a broken baseline file must not
 * silently pass the audit. */
export function loadWorkflowBaselines(stateDir: string): WorkflowBaselinesFile {
  const file = workflowBaselinesFile(stateDir);
  if (!fs.existsSync(file)) return emptyBaselinesFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as WorkflowBaselinesFile;
    if (parsed?.version !== 1 || typeof parsed?.metrics !== "object" || parsed.metrics === null) {
      throw new Error("not a workflow baselines file");
    }
    return parsed;
  } catch (err) {
    throw new Error(`corrupt workflow baselines file at ${file}: ${(err as Error).message}`);
  }
}

export function saveWorkflowBaselines(stateDir: string, file: WorkflowBaselinesFile): void {
  fs.mkdirSync(path.dirname(workflowBaselinesFile(stateDir)), { recursive: true });
  fs.writeFileSync(workflowBaselinesFile(stateDir), JSON.stringify(file, null, 2) + "\n");
}

export function appendAuditRatchetLog(stateDir: string, lines: string[]): void {
  if (lines.length === 0) return;
  fs.mkdirSync(path.dirname(workflowRatchetLog(stateDir)), { recursive: true });
  const stamped = lines.map((l) => `${new Date().toISOString()} ${l}`).join("\n") + "\n";
  fs.appendFileSync(workflowRatchetLog(stateDir), stamped);
}

function seedEntry(
  unit: "ms" | "tokens",
  kind: "latency" | "tokens",
  observed: number,
  runs: number,
): WorkflowBaselineEntry {
  const multiple = AUDIT_MULTIPLES[kind];
  return {
    unit,
    kind,
    baseline: observed,
    threshold: thresholdFor(observed, multiple),
    multiple,
    history: [],
    greenStreak: 0,
    note: `seeded from the median of ${runs} run(s)`,
  };
}

/** Check one metric of one workflow. Pure except for the baselines
 * object it mutates (entries created / ratcheted in place, like the
 * bench check mutates its baselines file). Returns the result plus
 * any ratchet log lines the check produced. */
function checkMetric(
  baselines: WorkflowBaselinesFile,
  workflow: string,
  metric: "wallMs" | "tokens",
  observed: number | null,
  observedRuns: number,
  confirmObserved: number | null,
  newestRunId: string | null,
  unit: "ms" | "tokens",
  kind: "latency" | "tokens",
): { result: AuditMetricResult; logLines: string[] } {
  const metricId = auditMetricId(workflow, metric);
  const logLines: string[] = [];
  const base = (verdict: AuditVerdict, detail: string, extra: Partial<AuditMetricResult> = {}): AuditMetricResult => ({
    metricId,
    workflow,
    metric,
    verdict,
    observed,
    observedRuns,
    baseline: baselines.metrics[metricId]?.baseline ?? null,
    threshold: baselines.metrics[metricId]?.threshold ?? null,
    confirmObserved: null,
    ratcheted: false,
    detail,
    ...extra,
  });

  // Tokens with no reporting runs: explicit unknown, never zero.
  // No baseline, no pass, no failure — the metric is not checked.
  if (metric === "tokens" && observed === null) {
    return {
      result: base(
        "unknown",
        `UNKNOWN ${metricId}: no run reported tokens — explicit unknown, not zero; metric not checked`,
      ),
      logLines,
    };
  }
  if (observed === null) {
    return {
      result: base("no-baseline", `NO-BASELINE ${metricId}: no done runs with a known ${metric}`),
      logLines,
    };
  }

  let entry = baselines.metrics[metricId];
  if (!entry) {
    if (observedRuns < AUDIT_MIN_RUNS) {
      return {
        result: base(
          "no-baseline",
          `NO-BASELINE ${metricId}: ${observedRuns} run(s), need ${AUDIT_MIN_RUNS} to seed a baseline`,
        ),
        logLines,
      };
    }
    entry = seedEntry(unit, kind, observed, observedRuns);
    baselines.metrics[metricId] = entry;
    return {
      result: base(
        "seeded",
        `SEEDED ${metricId}: baseline ${observed} ${unit} from the median of ${observedRuns} run(s) (threshold ${entry.threshold})`,
      ),
      logLines,
    };
  }

  if (observed > entry.threshold) {
    // Confirm-before-fail against the most recent runs: if the
    // last 3 runs are green, the breach was stale (slow runs aging
    // out of the window after the workflow already recovered) and
    // the breaching observation is discarded, never recorded.
    if (confirmObserved !== null && confirmObserved <= entry.threshold) {
      const { outcome, logLine } = applyAuditObservation(entry, metricId, confirmObserved);
      if (logLine) logLines.push(logLine);
      if (newestRunId !== null) entry.lastObservedRunId = newestRunId;
      return {
        result: base(
          "confirmed-pass",
          `CONFIRMED-PASS ${metricId}: last ${AUDIT_MIN_RUNS} runs re-measured ${confirmObserved} ${unit} <= threshold ${entry.threshold} ` +
            `— first observation ${observed} did not reproduce (stale breach, discarded)`,
          { confirmObserved, ratcheted: outcome === "ratcheted" },
        ),
        logLines,
      };
    }
    const { logLine } = applyAuditObservation(entry, metricId, observed);
    if (logLine) logLines.push(logLine);
    if (newestRunId !== null) entry.lastObservedRunId = newestRunId;
    return {
      result: base(
        "fail",
        `FAIL ${metricId}: observed ${observed} ${unit} > threshold ${entry.threshold} ` +
          `(baseline ${entry.baseline}, x${entry.multiple})` +
          (confirmObserved !== null
            ? ` — confirmed on the last ${AUDIT_MIN_RUNS} runs (${confirmObserved} ${unit})`
            : ""),
        { confirmObserved },
      ),
      logLines,
    };
  }

  // Green: record the observation only when new runs landed since
  // the last one — re-auditing an unchanged ledger records nothing
  // (five audits must not manufacture a ratchet).
  if (newestRunId !== null && entry.lastObservedRunId === newestRunId) {
    return {
      result: base(
        "pass",
        `PASS ${metricId}: ${observed} ${unit} <= threshold ${entry.threshold} ` +
          `(baseline ${entry.baseline}, streak ${entry.greenStreak}/${AUDIT_K}; no new runs since last observation)`,
      ),
      logLines,
    };
  }
  const { outcome, logLine } = applyAuditObservation(entry, metricId, observed);
  if (logLine) logLines.push(logLine);
  if (newestRunId !== null) entry.lastObservedRunId = newestRunId;
  return {
    result: base(
      "pass",
      outcome === "ratcheted"
        ? `RATCHETED ${metricId}: baseline ${entry.baseline} ${unit} is the NEW baseline ` +
            `(was higher; threshold now ${entry.threshold}) — see workflow-ratchet.log`
        : `PASS ${metricId}: ${observed} ${unit} <= threshold ${entry.threshold} ` +
            `(baseline ${entry.baseline}, streak ${entry.greenStreak}/${AUDIT_K})`,
      { ratcheted: outcome === "ratcheted" },
    ),
    logLines,
  };
}

/** Audit workflows against their baselines. Pure except for the
 * baselines object it mutates (seeds / ratchets in place). The
 * caller owns saving the baselines file and the ratchet log.
 * `workflows` restricts the audit; by default every workflow with
 * ledger entries is audited. */
export function auditWorkflows(
  entries: LedgerEntry[],
  baselines: WorkflowBaselinesFile,
  opts: { workflows?: string[]; window?: number } = {},
): AuditReport {
  const window = opts.window ?? AUDIT_WINDOW;
  const workflows = (opts.workflows ?? [...new Set(entries.map((e) => e.workflow))]).sort();
  const results: AuditMetricResult[] = [];
  const observations: WorkflowObservations[] = [];
  const logLines: string[] = [];
  const seeded: string[] = [];
  for (const workflow of workflows) {
    const obs = observeWorkflow(entries, workflow, window);
    observations.push(obs);
    // Confirm window: the most recent runs only — a breach is
    // confirmed when the workflow is STILL slow right now.
    const confirm = observeWorkflow(entries, workflow, AUDIT_MIN_RUNS);
    const wall = checkMetric(
      baselines,
      workflow,
      "wallMs",
      obs.wallMedian,
      obs.wallRuns,
      confirm.wallMedian,
      obs.newestRunId,
      "ms",
      "latency",
    );
    results.push(wall.result);
    logLines.push(...wall.logLines);
    if (wall.result.verdict === "seeded") seeded.push(wall.result.metricId);
    const tokens = checkMetric(
      baselines,
      workflow,
      "tokens",
      obs.tokenMedian,
      obs.tokenRuns,
      confirm.tokenMedian,
      obs.newestRunId,
      "tokens",
      "tokens",
    );
    results.push(tokens.result);
    logLines.push(...tokens.logLines);
    if (tokens.result.verdict === "seeded") seeded.push(tokens.result.metricId);
  }
  const failures = results.filter((r) => r.verdict === "fail").length;
  return { workflows, results, observations, failures, seeded, ratchetLogLines: logLines, ok: failures === 0 };
}

/** One-line-per-result report, bench/check.ts style. */
export function formatAuditReport(report: AuditReport): string {
  const lines = report.results.map((r) => r.detail);
  lines.push(
    `\n${report.ok ? "ALL GREEN" : `${report.failures} FAILURE(S)`} — ` +
      `${report.results.length} metric(s) checked across ${report.workflows.length} workflow(s)` +
      (report.seeded.length > 0 ? `, ${report.seeded.length} seeded` : ""),
  );
  return lines.join("\n");
}

/** Load the ledger, audit it, save baselines + ratchet lines.
 * Returns the report. */
export function runWorkflowAudit(
  stateDir: string,
  opts: { workflows?: string[]; window?: number } = {},
): AuditReport {
  const { entries } = loadLedger(ledgerFile(stateDir));
  const baselines = loadWorkflowBaselines(stateDir);
  const report = auditWorkflows(entries, baselines, opts);
  saveWorkflowBaselines(stateDir, baselines);
  appendAuditRatchetLog(stateDir, report.ratchetLogLines);
  return report;
}

function usage(): never {
  console.error(
    "usage:\n" +
      "  bun src/workflow-audit.ts [--state-dir DIR] [--workflows a,b] [--window N]\n" +
      "  bun src/workflow-audit.ts loosen <metric> <newBaseline> --reason \"...\" [--state-dir DIR]",
  );
  process.exit(1);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const flagValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const stateDir = flagValue("--state-dir") ?? (process.env.AGENTTS_STATE_DIR ?? path.resolve(".agentts-state"));
  const loosenIdx = argv.indexOf("loosen");

  if (loosenIdx >= 0) {
    const metric = argv[loosenIdx + 1];
    const baselineRaw = argv[loosenIdx + 2];
    const reason = flagValue("--reason") ?? "";
    if (!metric || !baselineRaw || !reason) usage();
    // Only the loosen form's own tokens may appear.
    const allowed = new Set(["loosen", metric, baselineRaw, "--reason", reason, "--state-dir", stateDir]);
    for (const a of argv) {
      if (!allowed.has(a)) {
        console.error(`unknown arg: ${a}`);
        usage();
      }
    }
    try {
      const file = loadWorkflowBaselines(stateDir);
      const line = loosenAuditBaseline(file, metric, Number(baselineRaw), reason);
      saveWorkflowBaselines(stateDir, file);
      appendAuditRatchetLog(stateDir, [line]);
      console.log(`loosened ${metric} to baseline ${baselineRaw} (reason recorded in workflow-ratchet.log)`);
      process.exit(0);
    } catch (err) {
      console.error(`workflow audit failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const workflows = flagValue("--workflows")?.split(",").filter(Boolean);
  const windowRaw = flagValue("--window");
  const window = windowRaw !== undefined ? Number(windowRaw) : undefined;
  const allowed = new Set<string>(["--state-dir", "--workflows", "--window"]);
  if (stateDir) allowed.add(stateDir);
  if (workflows) allowed.add(workflows.join(","));
  if (windowRaw !== undefined) allowed.add(windowRaw);
  for (const a of argv) {
    if (!allowed.has(a)) {
      console.error(`unknown arg: ${a}`);
      usage();
    }
  }
  try {
    const report = runWorkflowAudit(stateDir, { workflows, window });
    console.log(formatAuditReport(report));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`workflow audit failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
