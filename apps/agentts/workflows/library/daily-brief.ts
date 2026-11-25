// daily-brief — encode the daily project report as a workflow (BRA-274).
//
// The daily proof: 05:30 prompt + 06:30 aggregate + 07:00 HTML exec
// brief. Today the Director drives it by hand: the 05:30 cron prompts
// each lead, the leads write JSONs by hand, the Director aggregates
// by 07:00. This workflow makes the machine do it — one workflow,
// three phases selected by run.phase, one phase per cron (the crons
// stay as triggers; the workflow is the work).
//
// The workflow sends no messages. The prompt phase returns the
// per-lead prompt payloads in its report (target chat id from
// project.roster, message text naming the deadline, the schema, the
// reports-dir path) — the launcher (the 05:30 cron / the Director)
// delivers them. The brief phase returns the delivery payload (the
// dated HTML path + the must-know line) in its report — the launcher
// sends it to main chat at 07:00. This is the BRA-50 pattern: the
// sub-job returns in the report; the launcher dispatches it.
//
// What the aggregate derives, deterministically, in roster order:
// decisions-needed (every needs_pm entry, attributed), must-know
// (Director-supplied run.mustKnow, else the program-management
// report's optional mustKnow, else the first decisions-needed entry
// rendered as a sentence — derived, logged as derived), risks
// (every solutions[].problem, attributed), per-lead sections
// (status + numbers as key/value pairs with a trend arrow per key
// vs the prior day's report when present — never the raw JSON,
// never reflections/predictions/solutions verbatim), and the
// Director's own report (overall state from the goal notes, what
// changed from the ledger tail + the leads' status changes, what is
// next from the open backlog headings + predictions). A missing lead
// report is noted as missing with the reason named and never blocks
// the brief; the receipt line names the missing leads. The brief
// aggregates; it never pastes the JSON.
//
// Reads and writes go through exec traps, never trap stdout: each
// file read is its own bounded trap (the exec-trap stdout cap is
// ~60KB and a day's reports plus the PM state exceed it in
// aggregate), and every write is chunked base64 + rename +
// read-back in the dispatch pattern. The HTML template lives in
// this file (a pure string builder carrying the Nov 21 exec-brief
// structure), not a separate asset.
//
// Design decisions (brief ~/workspace/bra274-impl-brief.md):
//
// 1. Three phases, one workflow, selected by run.phase.
// 2. The workflow sends no messages.
// 3. The brief aggregates; it never pastes the JSON. Per-lead
//    sections carry status + numbers with trend arrows.
// 4. Derivation rules are deterministic (above); authorship takes
//    precedence over derivation for the must-know.
// 5. A missing lead report never blocks the brief.
// 6. Run contract: project is the standard ProjectConfig (inlined
//    by the launcher); run carries phase, date (never inferred
//    from the clock), reportsDir, rosterPath, the four PM-state
//    paths, briefPath, aggregationPath, logPath, deadlines,
//    mustKnow?, dryRun, launchedBy, owner, now, bunPath.
// 7. Reads/writes via exec traps in the dispatch pattern.
// 8. Cancel check-then-act (the triage pattern); a null/absent
//    run is refused, never dereferenced (this workflow validates
//    first, so it does not have the defect).
// 9. Validation first, fail-closed. All lead-report fields except
//    lead and date are optional; an absent optional field is
//    treated as empty, NOT invalid. Only lead/date missing,
//    unparsable JSON, or a wrong type on a field that IS present
//    counts as invalid. The roster must be present and non-empty.
// 10. No Linear dependency in the workflow.
// 11. The template lives in the workflow.
// 12. Dry-run unchanged in shape: lists what it would do, writes
//     nothing.
// 13. Not a decision-maker. The brief surfaces decisions; it
//     never closes an issue, merges code, or decides acceptance.
// 14. Predictor-record scoring is out of this build: the aggregate
//     reads the predictor record as part of the PM's state and logs
//     that it was read, but does not score predictions.
// 15. (BRA-247/248) The aggregate optionally reads 247's throughput
//     report (run.throughputReportPath, one new validated input) and
//     renders one Throughput card in the HTML: present renders the
//     section, absent renders without it, malformed records
//     missing-with-reason and still renders. The throughput read
//     never blocks the brief. Import-cycle note: this module imports
//     validateThroughputReportFile from throughput-report.ts at
//     runtime while throughput-report.ts imports this module's trap
//     helpers — the cycle is safe only because neither module calls
//     an imported binding at module-eval time (all uses are inside
//     entry functions); verified by tsc + agentts check + the §D
//     aggregate cases (D10/D11/D12), and the fallback is a
//     duplicated validator in this file if check ever chokes on the
//     cycle.
//
// Known v0 limits, carried verbatim in every report:
//
// - The brief aggregates; it never pastes the JSON. A missing lead
//   report is noted as missing and never blocks the brief. The
//   workflow sends no messages — the launcher delivers the prompt
//   payloads and the 07:00 delivery payload. The workflow never
//   closes an issue, merges code, or decides acceptance.
//   Predictor-record scoring is a later workflow's job.
// - Per-file read bound: a file over the read bound is recorded
//   as missing-with-reason (the bound named), never silently
//   truncated into a wrong parse. The goal-notes head is bounded
//   to 8KB by design (only the first paragraph feeds the overall
//   state); the ledger read is the tail (last 20 lines); the
//   backlog read is the first 10 item headings.
import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import { splitHandoffChunks, appendChunkScript, parseWriteSummary } from "./dispatch";
import { validateThroughputReportFile, THROUGHPUT_READ_MAX_BYTES, type ThroughputSection } from "./throughput-report";

/** The known-limit string, carried verbatim in every report. */
export const DAILY_BRIEF_KNOWN_LIMIT =
  "The brief aggregates; it never pastes the JSON. A missing lead report is noted as missing and never blocks the brief. " +
  "The workflow sends no messages — the launcher delivers the prompt payloads and the 07:00 delivery payload. " +
  "The workflow never closes an issue, merges code, or decides acceptance. Predictor-record scoring is a later workflow's job.";

/** Per-file read bound (bytes of decoded text): far under the
 * ~60KB exec-trap stdout cap, with headroom for the READ header. */
export const DAILY_BRIEF_READ_MAX_BYTES = 48 * 1024;
/** The goal-notes head bound: only the first paragraph feeds the
 * overall state, so the aggregate reads a bounded head, never the
 * whole 40KB+ file. */
export const DAILY_BRIEF_GOAL_NOTES_MAX_BYTES = 8 * 1024;
/** Lead JSONs and the roster are small; a file over this bound is
 * recorded as missing-with-reason (the bound named). */
export const DAILY_BRIEF_REPORT_MAX_BYTES = 16 * 1024;
/** The ledger read is the tail: the last 20 records. */
export const DAILY_BRIEF_LEDGER_TAIL_LINES = 20;
/** The backlog read is the first 10 item headings. */
export const DAILY_BRIEF_BACKLOG_MAX_HEADINGS = 10;

export type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface DailyBriefProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the
   * brief v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir: string;
}

export type DailyBriefPhase = "prompt" | "aggregate" | "brief";

export interface DailyBriefRunInput {
  phase: DailyBriefPhase;
  /** The brief's date (YYYY-MM-DD) — never today inferred from
   * the clock. */
  date: string;
  reportsDir: string;
  rosterPath: string;
  goalNotesPath: string;
  ledgerPath: string;
  predictorRecordPath: string;
  backlogPath: string;
  /** 247's throughput report file for the same date, when one
   * exists — the aggregate reads it (one new validated input) and
   * renders one Throughput card. Optional: absent renders without
   * it, malformed records missing-with-reason and still renders.
   * Never blocks the brief. */
  throughputReportPath?: string;
  /** The dated HTML output path, e.g.
   * <goal>/files/daily-reports/<date>-exec-brief.html. */
  briefPath: string;
  aggregationPath: string;
  logPath: string;
  /** Per-lead write deadline, e.g. {implementation: "06:00"} —
   * the prompt phase names each lead's deadline in its payload. */
  deadlines: Record<string, string>;
  /** The Director-supplied one-line must-know, when the Director
   * authors it — absent when the workflow must derive it. */
  mustKnow?: string;
  dryRun?: boolean;
  launchedBy?: string;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  /** Caller-supplied now (ISO), for tests. */
  now?: string;
  bunPath?: string;
}

export interface DailyBriefInput {
  project: DailyBriefProjectConfig;
  run: DailyBriefRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

export interface RosterEntry {
  lead: string;
  chat_id: string;
}

export interface LeadPrediction {
  claim: string;
  confidence: "high" | "medium" | "low";
  horizon: "today" | "this week" | "this release";
}

export interface LeadSolution {
  problem: string;
  proposal: string;
}

export interface LeadReport {
  lead: string;
  date: string;
  status: string;
  reflections: string[];
  predictions: LeadPrediction[];
  solutions: LeadSolution[];
  needs_pm: string[];
  numbers: Record<string, number>;
  /** Optional, PM lead only in use: the program-management report
   * may carry the must-know it authors. Accepted by the validator
   * on any report at schema level; the aggregate uses it only
   * when the lead is program-management, and logs when one on
   * another lead's report is ignored. */
  mustKnow?: string;
}

export interface PromptPayload {
  lead: string;
  chatId: string;
  message: string;
}

export interface MissingLead {
  lead: string;
  reason: string;
}

export interface DecisionNeeded {
  lead: string;
  text: string;
}

export interface RiskItem {
  lead: string;
  problem: string;
}

export interface LeadNumber {
  key: string;
  value: number;
  /** "↑" | "↓" | "→" vs the prior day's report, or null when
   * there is no prior-day value for the key. */
  arrow: string | null;
}

export interface PerLeadSection {
  lead: string;
  present: boolean;
  status: string;
  numbers: LeadNumber[];
}

export interface DirectorReport {
  overallState: string;
  whatChanged: string[];
  whatIsNext: string[];
}

export interface Aggregation {
  date: string;
  receipt: string;
  decisionsNeeded: DecisionNeeded[];
  mustKnow: string;
  mustKnowSource: "director" | "pm" | "derived";
  risks: RiskItem[];
  perLead: PerLeadSection[];
  directorReport: DirectorReport;
  missing: MissingLead[];
  log: string[];
  /** 247's throughput section for the same date, when the
   * throughput report was present and valid. Absent when no report
   * was supplied or it was malformed — the brief renders without
   * the Throughput card. */
  throughput?: ThroughputSection;
}

export interface DeliveryPayload {
  briefPath: string;
  mustKnow: string;
}

export interface DailyBriefReport {
  briefId: string;
  verdict: "prompted" | "aggregated" | "briefed" | "dry-run" | "failed";
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  phase: DailyBriefPhase;
  date: string;
  promptPayloads?: PromptPayload[];
  aggregationPath?: string;
  logPath?: string;
  briefPath?: string;
  deliveryPayload?: DeliveryPayload;
  decisionsNeeded?: number;
  risks?: number;
  missing: MissingLead[];
  notes: string[];
  knownLimit: string;
}

/** Validate the run input. Pure — returns the error strings (empty
 * when valid), each naming the missing or malformed field. The
 * entry converts these into a refused report; nothing throws for
 * bad input. A null/absent run is an error here too, but the entry
 * guards it first (never dereferenced). */
export function validateDailyBriefInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["daily-brief: input is not an object"];
  const project = (input as JsonObject).project;
  const run = (input as JsonObject).run;
  if (!isPlainObject(project)) errors.push("daily-brief: input has no project object");
  if (!isPlainObject(run)) {
    errors.push("daily-brief: input has no run object");
    return errors;
  }
  const r = run as JsonObject;
  if (r.phase !== "prompt" && r.phase !== "aggregate" && r.phase !== "brief") {
    errors.push("daily-brief: run.phase must be prompt, aggregate, or brief");
  }
  if (typeof r.date !== "string" || !isValidDateString(r.date)) {
    errors.push("daily-brief: run.date must be a valid YYYY-MM-DD date");
  }
  for (const f of ["reportsDir", "rosterPath", "goalNotesPath", "ledgerPath", "predictorRecordPath", "backlogPath", "briefPath", "aggregationPath", "logPath"]) {
    if (!isNonEmptyString(r[f])) errors.push("daily-brief: run has no " + f + " string");
  }
  if (!isPlainObject(r.deadlines)) {
    errors.push("daily-brief: run has no deadlines object");
  } else {
    for (const [k, v] of Object.entries(r.deadlines as JsonObject)) {
      if (typeof v !== "string" || v === "") errors.push("daily-brief: run.deadlines[" + k + "] is not a non-empty string");
    }
  }
  if (r.mustKnow !== undefined && typeof r.mustKnow !== "string") {
    errors.push("daily-brief: run.mustKnow must be a string when present");
  }
  if (r.throughputReportPath !== undefined && typeof r.throughputReportPath !== "string") {
    errors.push("daily-brief: run.throughputReportPath must be a string when present");
  }
  if (r.dryRun !== undefined && typeof r.dryRun !== "boolean") {
    errors.push("daily-brief: run.dryRun must be a boolean when present");
  }
  if (r.runId !== undefined && typeof r.runId !== "string") {
    errors.push("daily-brief: run.runId must be a string when present");
  }
  if (r.now !== undefined && typeof r.now !== "string") {
    errors.push("daily-brief: run.now must be a string when present");
  }
  if (r.bunPath !== undefined && typeof r.bunPath !== "string") {
    errors.push("daily-brief: run.bunPath must be a string when present");
  }
  if (r.launchedBy !== undefined && typeof r.launchedBy !== "string") {
    errors.push("daily-brief: run.launchedBy must be a string when present");
  }
  if (!isNonEmptyString((input as JsonObject).owner)) {
    errors.push("daily-brief: input has no owner string — the owner is the driving session, never assumed from the launcher");
  }
  if (isPlainObject(project)) {
    const p = project as JsonObject;
    for (const f of ["linearProject", "repo", "stateDir", "workDir", "resumeDir"]) {
      if (!isNonEmptyString(p[f])) errors.push("daily-brief: project has no " + f + " string");
    }
    if (!isPlainObject(p.roster)) errors.push("daily-brief: project has no roster object");
    if (p.thresholds !== undefined) {
      if (!isPlainObject(p.thresholds)) {
        errors.push("daily-brief: project.thresholds must be an object when present");
      } else {
        for (const [k, v] of Object.entries(p.thresholds as JsonObject)) {
          if (typeof v !== "number" || Number.isNaN(v)) errors.push("daily-brief: project.thresholds[" + k + "] must be a number");
        }
      }
    }
  }
  return errors;
}

/** Is the string a real YYYY-MM-DD date (not just shaped like
 * one)? Pure. */
export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** The prior calendar day of a YYYY-MM-DD date, as YYYY-MM-DD.
 * Pure — month and year boundaries included (unit-tested). */
export function yesterdayOf(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const y = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  return y.toISOString().slice(0, 10);
}

/** Validate the roster file's parsed JSON. Pure — returns the
 * roster in file order plus the errors (empty when valid). The
 * roster must be present and non-empty; an empty roster refuses
 * the whole run before any write. */
export function validateRoster(value: unknown): { roster: RosterEntry[]; errors: string[] } {
  if (!Array.isArray(value)) return { roster: [], errors: ["daily-brief: roster is not an array"] };
  if (value.length === 0) return { roster: [], errors: ["daily-brief: roster is empty"] };
  const errors: string[] = [];
  const roster: RosterEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const e = value[i];
    if (!isPlainObject(e)) {
      errors.push("daily-brief: roster entry " + i + " is not an object");
      continue;
    }
    if (!isNonEmptyString(e.lead)) {
      errors.push("daily-brief: roster entry " + i + " has no lead string");
      continue;
    }
    if (!isNonEmptyString(e.chat_id)) {
      errors.push("daily-brief: roster entry " + i + " has no chat_id string");
      continue;
    }
    if (seen.has(e.lead as string)) {
      errors.push("daily-brief: roster lists lead " + JSON.stringify(e.lead) + " twice");
      continue;
    }
    seen.add(e.lead as string);
    roster.push({ lead: e.lead as string, chat_id: e.chat_id as string });
  }
  return { roster, errors };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate one lead report's parsed JSON against the schema.
 * Pure. All fields except lead and date are optional — an absent
 * optional field is treated as empty, NOT invalid. Only lead/date
 * missing, a date that does not match the brief's date, unparsable
 * JSON (caught by the caller), or a wrong type on a field that IS
 * present counts as invalid. The returned report normalizes the
 * absent optionals to their empty shapes, so derive can assume
 * them. */
export function validateLeadReport(
  value: unknown,
  expectedLead: string,
  expectedDate: string,
): { valid: true; report: LeadReport } | { valid: false; reason: string } {
  if (!isPlainObject(value)) return { valid: false, reason: "report is not a JSON object" };
  if (!isNonEmptyString(value.lead)) return { valid: false, reason: "lead field is missing" };
  if (value.lead !== expectedLead) {
    return { valid: false, reason: "lead field " + JSON.stringify(value.lead) + " does not match file lead " + JSON.stringify(expectedLead) };
  }
  if (!isNonEmptyString(value.date)) return { valid: false, reason: "date field is missing" };
  if (value.date !== expectedDate) {
    return { valid: false, reason: "date field " + JSON.stringify(value.date) + " does not match brief date " + JSON.stringify(expectedDate) };
  }
  if (value.status !== undefined && typeof value.status !== "string") {
    return { valid: false, reason: "status field is not a string" };
  }
  if (value.reflections !== undefined && !isStringArray(value.reflections)) {
    return { valid: false, reason: "reflections field is not an array of strings" };
  }
  if (value.predictions !== undefined) {
    if (!Array.isArray(value.predictions)) return { valid: false, reason: "predictions field is not an array" };
    for (let i = 0; i < value.predictions.length; i++) {
      const p = value.predictions[i];
      if (!isPlainObject(p)) return { valid: false, reason: "predictions[" + i + "] is not an object" };
      if (!isNonEmptyString(p.claim)) return { valid: false, reason: "predictions[" + i + "].claim is missing" };
      if (p.confidence !== "high" && p.confidence !== "medium" && p.confidence !== "low") {
        return { valid: false, reason: "predictions[" + i + "].confidence is not high, medium, or low" };
      }
      if (p.horizon !== "today" && p.horizon !== "this week" && p.horizon !== "this release") {
        return { valid: false, reason: "predictions[" + i + "].horizon is not today, this week, or this release" };
      }
    }
  }
  if (value.solutions !== undefined) {
    if (!Array.isArray(value.solutions)) return { valid: false, reason: "solutions field is not an array" };
    for (let i = 0; i < value.solutions.length; i++) {
      const s = value.solutions[i];
      if (!isPlainObject(s)) return { valid: false, reason: "solutions[" + i + "] is not an object" };
      if (!isNonEmptyString(s.problem)) return { valid: false, reason: "solutions[" + i + "].problem is missing" };
      if (!isNonEmptyString(s.proposal)) return { valid: false, reason: "solutions[" + i + "].proposal is missing" };
    }
  }
  if (value.needs_pm !== undefined && !isStringArray(value.needs_pm)) {
    return { valid: false, reason: "needs_pm field is not an array of strings" };
  }
  if (value.numbers !== undefined) {
    if (!isPlainObject(value.numbers)) return { valid: false, reason: "numbers field is not an object" };
    for (const [k, v] of Object.entries(value.numbers as JsonObject)) {
      if (typeof v !== "number" || Number.isNaN(v)) {
        return { valid: false, reason: "numbers[" + JSON.stringify(k) + "] is not a number" };
      }
    }
  }
  if (value.mustKnow !== undefined && typeof value.mustKnow !== "string") {
    return { valid: false, reason: "mustKnow field is not a string" };
  }
  const report: LeadReport = {
    lead: value.lead as string,
    date: value.date as string,
    status: typeof value.status === "string" ? value.status : "",
    reflections: isStringArray(value.reflections) ? [...(value.reflections as string[])] : [],
    predictions: Array.isArray(value.predictions)
      ? (value.predictions as JsonObject[]).map((p) => ({
          claim: p.claim as string,
          confidence: p.confidence as LeadPrediction["confidence"],
          horizon: p.horizon as LeadPrediction["horizon"],
        }))
      : [],
    solutions: Array.isArray(value.solutions)
      ? (value.solutions as JsonObject[]).map((s) => ({ problem: s.problem as string, proposal: s.proposal as string }))
      : [],
    needs_pm: isStringArray(value.needs_pm) ? [...(value.needs_pm as string[])] : [],
    numbers: isPlainObject(value.numbers) ? { ...(value.numbers as Record<string, number>) } : {},
  };
  if (typeof value.mustKnow === "string") report.mustKnow = value.mustKnow;
  return { valid: true, report };
}

/** The trend arrow for one number key: today vs the prior day's
 * value. Null when there is no prior-day value for the key. Pure. */
export function trendArrow(today: number, yesterday: number | null): string | null {
  if (yesterday === null) return null;
  if (today > yesterday) return "↑";
  if (today < yesterday) return "↓";
  return "→";
}

/** Render one number value for the brief (integers plain,
 * non-integers with up to two decimals). Pure. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/** A millisecond duration in human form (null reads "unknown").
 * Pure. */
export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "unknown";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (Math.round(ms / 100) / 10) + " s";
  if (ms < 3_600_000) return (Math.round(ms / 6000) / 10) + " min";
  return (Math.round(ms / 360_000) / 10) + " h";
}

/** A ledger tail record (from run-ledger.jsonl): the fields the
 * "what changed" derivation reads. */
export interface LedgerRun {
  runId: string;
  workflow: string;
  status: string;
}

/** Derive the aggregation from the validated inputs. Pure —
 * every rule is deterministic from its arguments, in roster
 * order; the log records every derivation choice that is not
 * directly visible in the output (must-know source, truncated
 * reads, ignored mustKnow fields). */
export function deriveAggregation(args: {
  date: string;
  yesterday: string;
  roster: RosterEntry[];
  /** Validated reports, keyed by lead (absent when missing). */
  reports: Map<string, LeadReport>;
  /** Prior-day validated reports, keyed by lead (absent when
   * there is none). */
  priorReports: Map<string, LeadReport>;
  missing: MissingLead[];
  /** The goal-notes head (first paragraph feeds the overall
   * state), or null when the file is missing. */
  goalNotes: string | null;
  goalNotesTruncated: boolean;
  /** The ledger tail (most recent last). */
  ledgerRuns: LedgerRun[];
  ledgerMissing: boolean;
  ledgerSkippedLines: number;
  /** The predictor record text, or null when missing. Read and
   * logged, never scored (scoring is a later workflow's job). */
  predictorRecord: string | null;
  predictorMissing: boolean;
  /** The open backlog's first item headings, in file order. */
  backlogHeadings: string[];
  backlogMissing: boolean;
  /** The Director-supplied must-know, when the Director authors
   * it. */
  directorMustKnow?: string;
  /** 247's validated throughput section for the same date, when
   * the report was present and valid. */
  throughputSection?: ThroughputSection;
  /** Why the throughput section is absent (not supplied, missing,
   * or malformed) — logged, never blocking. */
  throughputMissingReason?: string;
}): Aggregation {
  const log: string[] = [];
  if (args.throughputSection !== undefined) {
    log.push(
      "throughput report read — " +
        args.throughputSection.tasksCompleted +
        " completed, " +
        args.throughputSection.landings +
        " landings, " +
        args.throughputSection.stalled.length +
        " stalled step(s), " +
        args.throughputSection.missing.length +
        " missing source(s)" +
        (args.throughputSection.machineDown ? " — MACHINE DOWN" : ""),
    );
  } else if (args.throughputMissingReason !== undefined) {
    log.push("throughput report missing: " + args.throughputMissingReason + " — the brief renders without the throughput section");
  }
  const decisionsNeeded: DecisionNeeded[] = [];
  for (const entry of args.roster) {
    const rep = args.reports.get(entry.lead);
    if (!rep) continue;
    for (const text of rep.needs_pm) decisionsNeeded.push({ lead: entry.lead, text });
  }
  const risks: RiskItem[] = [];
  for (const entry of args.roster) {
    const rep = args.reports.get(entry.lead);
    if (!rep) continue;
    for (const s of rep.solutions) risks.push({ lead: entry.lead, problem: s.problem });
  }
  // Must-know: authorship takes precedence over derivation.
  let mustKnow: string;
  let mustKnowSource: Aggregation["mustKnowSource"];
  const pmReport = args.reports.get("program-management");
  if (typeof args.directorMustKnow === "string" && args.directorMustKnow !== "") {
    mustKnow = args.directorMustKnow;
    mustKnowSource = "director";
    log.push("must-know authored by the Director (run.mustKnow)");
  } else if (pmReport && typeof pmReport.mustKnow === "string" && pmReport.mustKnow !== "") {
    mustKnow = pmReport.mustKnow;
    mustKnowSource = "pm";
    log.push("must-know authored by the program-management report (mustKnow)");
  } else if (decisionsNeeded.length > 0) {
    mustKnow = decisionsNeeded[0].text + " (raised by " + decisionsNeeded[0].lead + ")";
    mustKnowSource = "derived";
    log.push("must-know derived from the first decisions-needed entry (no authored must-know supplied)");
  } else {
    mustKnow = "No decisions needed today.";
    mustKnowSource = "derived";
    log.push("must-know derived: no decisions needed and no authored must-know supplied");
  }
  // A mustKnow on any other lead's report is ignored — only the
  // program-management report's mustKnow is used — and logged.
  for (const entry of args.roster) {
    if (entry.lead === "program-management") continue;
    const rep = args.reports.get(entry.lead);
    if (rep && typeof rep.mustKnow === "string" && rep.mustKnow !== "") {
      log.push("mustKnow present on " + entry.lead + " report, ignored — only the program-management report's mustKnow is used");
    }
  }
  // Per-lead sections: status + numbers with trend arrows. Never
  // the raw JSON, never reflections/predictions/solutions verbatim.
  const perLead: PerLeadSection[] = [];
  for (const entry of args.roster) {
    const rep = args.reports.get(entry.lead);
    if (!rep) {
      perLead.push({ lead: entry.lead, present: false, status: "", numbers: [] });
      continue;
    }
    const prior = args.priorReports.get(entry.lead);
    const numbers: LeadNumber[] = [];
    for (const key of Object.keys(rep.numbers).sort()) {
      const priorValue = prior && typeof prior.numbers[key] === "number" ? (prior.numbers[key] as number) : null;
      numbers.push({ key, value: rep.numbers[key], arrow: trendArrow(rep.numbers[key], priorValue) });
      if (priorValue === null) log.push("no prior-day value for " + entry.lead + " numbers[" + key + "] — no trend arrow");
    }
    perLead.push({ lead: entry.lead, present: true, status: rep.status, numbers });
  }
  // The Director's own report, derived from the state inputs.
  let overallState: string;
  if (args.goalNotes === null) {
    overallState = "Goal notes unavailable — overall state not derived.";
    log.push("goal notes missing — overall state not derived");
  } else {
    overallState = firstParagraph(args.goalNotes);
    if (overallState === "") {
      overallState = "Goal notes carry no prose paragraph — overall state not derived.";
      log.push("goal notes carry no prose paragraph — overall state not derived");
    }
  }
  if (args.goalNotesTruncated) log.push("goal notes read truncated to the 8KB head — only the first paragraph feeds the overall state");
  const whatChanged: string[] = [];
  for (const r of args.ledgerRuns.slice(-5).reverse()) {
    whatChanged.push("run " + r.runId + " (" + r.workflow + ") " + r.status);
  }
  if (args.ledgerMissing) log.push("ledger file missing — no runs listed under what changed");
  if (args.ledgerSkippedLines > 0) log.push("ledger tail skipped " + args.ledgerSkippedLines + " unparsable line(s)");
  for (const entry of args.roster) {
    const rep = args.reports.get(entry.lead);
    const prior = args.priorReports.get(entry.lead);
    if (rep && prior && rep.status !== prior.status) {
      whatChanged.push(entry.lead + " status changed since " + args.yesterday);
    }
  }
  if (whatChanged.length === 0) whatChanged.push("No ledger runs and no status changes since " + args.yesterday + ".");
  const whatIsNext: string[] = [];
  for (const h of args.backlogHeadings.slice(0, 5)) whatIsNext.push("backlog: " + h);
  if (args.backlogMissing) log.push("backlog file missing — no backlog items listed under what is next");
  let predictionCount = 0;
  for (const entry of args.roster) {
    const rep = args.reports.get(entry.lead);
    if (!rep) continue;
    for (const p of rep.predictions) {
      if (predictionCount >= 5) break;
      whatIsNext.push(entry.lead + " predicts: " + firstSentence(p.claim) + " (" + p.confidence + ", " + p.horizon + ")");
      predictionCount++;
    }
    if (predictionCount >= 5) break;
  }
  if (whatIsNext.length === 0) whatIsNext.push("No open backlog items or predictions recorded.");
  if (args.predictorMissing) log.push("predictor record missing — read as part of the PM's state, nothing scored");
  else log.push("predictor record read as part of the PM's state — nothing scored (scoring is a later workflow's job)");
  const present = args.roster.filter((e) => args.reports.has(e.lead)).length;
  const missingNames = args.missing.map((m) => m.lead);
  const receipt =
    present +
    " of " +
    args.roster.length +
    " lead reports received" +
    (missingNames.length > 0 ? ". Missing: " + missingNames.join(", ") + "." : ". No report missing.");
  return {
    date: args.date,
    receipt,
    decisionsNeeded,
    mustKnow,
    mustKnowSource,
    risks,
    perLead,
    directorReport: { overallState, whatChanged, whatIsNext },
    missing: args.missing,
    log,
    ...(args.throughputSection !== undefined ? { throughput: args.throughputSection } : {}),
  };
}

/** The first paragraph of a markdown text: skip leading blank
 * lines and `#` headings, take lines until the first blank line,
 * join with spaces, truncate to 800 characters at a word
 * boundary. Pure. */
export function firstParagraph(text: string): string {
  const lines = text.split("\n");
  const para: string[] = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (!started) {
      if (t === "" || t.startsWith("#")) continue;
      started = true;
      para.push(t);
      continue;
    }
    if (t === "") break;
    para.push(t);
  }
  const joined = para.join(" ");
  if (joined.length <= 800) return joined;
  const cut = joined.slice(0, 800);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 400 ? cut.slice(0, lastSpace) : cut) + " …";
}

/** The first sentence of a claim (up to the first `.`, `!`, or
 * `?`, else the whole claim, bounded to 200 characters). Pure. */
export function firstSentence(claim: string): string {
  const m = /^[^.!?]+[.!?]/.exec(claim.trim());
  const s = m ? m[0] : claim.trim();
  return s.length <= 200 ? s : s.slice(0, 200);
}

/** Escape text for the HTML brief. Pure. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Render the dated HTML exec brief from the aggregation. Pure —
 * the template lives in this file: the Nov 21 brief's structure
 * (receipt line, must-know box, decisions box up top, KPI bar,
 * per-lead sections, risks, the Director's own report, missing-lead
 * sections when present, footer). The test asserts the STRUCTURE,
 * not pixel-identical HTML. */
export function renderBriefHtml(agg: Aggregation): string {
  const esc = escapeHtml;
  const presentCount = agg.perLead.filter((p) => p.present).length;
  const parts: string[] = [];
  parts.push("<!DOCTYPE html>");
  parts.push('<html lang="en">');
  parts.push("<head>");
  parts.push('<meta charset="utf-8">');
  parts.push("<title>AgentTS Exec Brief — " + esc(agg.date) + "</title>");
  parts.push("<style>");
  parts.push("  * { box-sizing: border-box; }");
  parts.push('  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; background: #f4f4f2; margin: 0; padding: 24px; line-height: 1.5; }');
  parts.push("  .wrap { max-width: 920px; margin: 0 auto; }");
  parts.push("  h1 { font-size: 26px; margin: 0 0 4px; }");
  parts.push("  .sub { color: #666; font-size: 14px; margin-bottom: 20px; }");
  parts.push("  .mustknow { background: #14213d; color: #fff; border-radius: 10px; padding: 18px 22px; margin-bottom: 20px; }");
  parts.push("  .mustknow .label { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #fca311; margin-bottom: 6px; }");
  parts.push("  .mustknow p { font-size: 19px; line-height: 1.45; margin: 0; font-weight: 600; }");
  parts.push("  .card { background: #fff; border: 1px solid #e2e2de; border-radius: 10px; padding: 18px 22px; margin-bottom: 16px; }");
  parts.push("  .card h2 { font-size: 17px; margin: 0 0 10px; }");
  parts.push("  .card h3 { font-size: 14px; margin: 16px 0 6px; }");
  parts.push("  .decisions { border-left: 5px solid #c0392b; }");
  parts.push("  .decisions ol { margin: 6px 0 0; padding-left: 20px; }");
  parts.push("  .decisions li { margin-bottom: 10px; }");
  parts.push("  .decisions .who { color: #666; font-size: 13px; }");
  parts.push("  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }");
  parts.push("  .kpi { background: #fff; border: 1px solid #e2e2de; border-radius: 10px; padding: 14px; text-align: center; }");
  parts.push("  .kpi .n { font-size: 28px; font-weight: 700; }");
  parts.push("  .kpi .t { font-size: 12px; color: #666; margin-top: 2px; }");
  parts.push("  .lead { border-top: 1px solid #eee; padding-top: 12px; margin-top: 12px; }");
  parts.push("  .lead:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }");
  parts.push("  .lead h3 { margin: 0 0 4px; font-size: 15px; }");
  parts.push("  .lead .status { font-size: 14px; }");
  parts.push("  .lead .nums { font-size: 13px; color: #555; margin-top: 6px; }");
  parts.push("  .lead .nums b { color: #1a1a1a; }");
  parts.push("  ul { margin: 6px 0; padding-left: 20px; }");
  parts.push("  li { margin-bottom: 5px; font-size: 14px; }");
  parts.push("  .foot { color: #888; font-size: 12px; margin-top: 8px; }");
  parts.push("</style>");
  parts.push("</head>");
  parts.push("<body>");
  parts.push('<div class="wrap">');
  parts.push("");
  parts.push("<h1>AgentTS Exec Brief</h1>");
  parts.push('<div class="sub">' + esc(agg.date) + " · " + esc(agg.receipt) + "</div>");
  parts.push("");
  parts.push('<div class="mustknow">');
  parts.push('  <div class="label">The thing you most need to know</div>');
  parts.push("  <p>" + esc(agg.mustKnow) + "</p>");
  parts.push("</div>");
  parts.push("");
  parts.push('<div class="card decisions">');
  parts.push("  <h2>Decisions needed</h2>");
  if (agg.decisionsNeeded.length === 0) {
    parts.push("  <p>No decisions needed today.</p>");
  } else {
    parts.push("  <ol>");
    for (const d of agg.decisionsNeeded) {
      parts.push("    <li>" + esc(d.text) + ' <span class="who">Raised by: ' + esc(d.lead) + ".</span></li>");
    }
    parts.push("  </ol>");
  }
  parts.push("</div>");
  parts.push("");
  parts.push('<div class="kpis">');
  parts.push('  <div class="kpi"><div class="n">' + presentCount + " / " + agg.perLead.length + '</div><div class="t">lead reports received</div></div>');
  parts.push('  <div class="kpi"><div class="n">' + agg.decisionsNeeded.length + '</div><div class="t">decisions needed</div></div>');
  parts.push('  <div class="kpi"><div class="n">' + agg.risks.length + '</div><div class="t">risks</div></div>');
  parts.push('  <div class="kpi"><div class="n">' + agg.missing.length + '</div><div class="t">reports missing</div></div>');
  parts.push("</div>");
  parts.push("");
  if (agg.throughput !== undefined) {
    const t = agg.throughput;
    parts.push('<div class="card">');
    parts.push("  <h2>Throughput (" + esc(t.date) + ", " + t.windowDays + "-day window)</h2>");
    parts.push("  <ul>");
    parts.push("    <li><b>" + t.tasksCompleted + "</b> tasks completed · <b>" + t.landings + "</b> landings · <b>" + t.itemsInWindow + "</b> items in window</li>");
    parts.push("    <li>Median pickup-to-landed: <b>" + esc(formatDurationMs(t.medianPickupToLandedMs)) + "</b> · median verify: <b>" + esc(formatDurationMs(t.medianVerifyMs)) + "</b></li>");
    parts.push(
      "    <li>Cost of a kill: <b>" +
        esc(formatDurationMs(t.killWallMsTotal)) +
        "</b>" +
        (t.killTokensTotal !== null ? " · " + t.killTokensTotal + " tokens" : "") +
        "</li>",
    );
    if (t.machineDown) {
      parts.push("    <li><b>Machine down</b> — no new runs in the window and the production server is down.</li>");
    }
    if (t.stalled.length > 0) {
      parts.push("    <li>Stalled: " + t.stalled.map((s) => esc(s.issue) + " (" + esc(s.status) + ", " + esc(formatDurationMs(s.stalledForMs)) + ")").join("; ") + "</li>");
    }
    if (t.missing.length > 0) {
      parts.push("    <li>Missing sources: " + t.missing.map((m) => esc(m.source) + " — " + esc(m.reason)).join("; ") + "</li>");
    }
    parts.push("  </ul>");
    parts.push("</div>");
    parts.push("");
  }
  parts.push('<div class="card">');
  parts.push("  <h2>Per-lead status</h2>");
  for (const p of agg.perLead) {
    if (!p.present) continue;
    parts.push('  <div class="lead">');
    parts.push("    <h3>" + esc(p.lead) + "</h3>");
    parts.push('    <div class="status">' + (p.status !== "" ? esc(p.status) : "(no status written)") + "</div>");
    if (p.numbers.length > 0) {
      const nums = p.numbers
        .map((n) => esc(n.key) + " <b>" + esc(formatNumber(n.value)) + "</b>" + (n.arrow !== null ? " " + n.arrow : ""))
        .join(" · ");
      parts.push('    <div class="nums">' + nums + "</div>");
    }
    parts.push("  </div>");
  }
  parts.push("</div>");
  parts.push("");
  parts.push('<div class="card">');
  parts.push("  <h2>Risks</h2>");
  if (agg.risks.length === 0) {
    parts.push("  <p>No risks recorded.</p>");
  } else {
    parts.push("  <ul>");
    for (const r of agg.risks) {
      parts.push("    <li><b>" + esc(r.lead) + ":</b> " + esc(r.problem) + "</li>");
    }
    parts.push("  </ul>");
  }
  parts.push("</div>");
  parts.push("");
  parts.push('<div class="card">');
  parts.push("  <h2>The Director's own report</h2>");
  parts.push("  <h3>Overall state</h3>");
  parts.push('  <p style="font-size:14px;margin:4px 0">' + esc(agg.directorReport.overallState) + "</p>");
  parts.push("  <h3>What changed</h3>");
  parts.push("  <ul>");
  for (const c of agg.directorReport.whatChanged) parts.push("    <li>" + esc(c) + "</li>");
  parts.push("  </ul>");
  parts.push("  <h3>What is next</h3>");
  parts.push("  <ul>");
  for (const n of agg.directorReport.whatIsNext) parts.push("    <li>" + esc(n) + "</li>");
  parts.push("  </ul>");
  parts.push("</div>");
  if (agg.missing.length > 0) {
    parts.push("");
    parts.push('<div class="card">');
    parts.push("  <h2>Missing reports</h2>");
    for (const m of agg.missing) {
      parts.push('  <div class="lead">');
      parts.push("    <h3>" + esc(m.lead) + "</h3>");
      parts.push('    <div class="status">Missing — ' + esc(m.reason) + "</div>");
      parts.push("  </div>");
    }
    parts.push("</div>");
  }
  parts.push("");
  parts.push('<div class="foot">Sources: lead daily reports ' + esc(agg.date) + " · aggregation log. The brief aggregates; it never pastes the JSON.</div>");
  parts.push("");
  parts.push("</div>");
  parts.push("</body>");
  parts.push("</html>");
  return parts.join("\n") + "\n";
}

// ------------------------------------------------------------------
// Trap scripts (pure — their shapes are unit-tested in §C).
// ------------------------------------------------------------------

/** The bounded file-read script: print one `READ <total> <printed>`
 * header line, then the file's decoded text (at most maxBytes
 * characters). Exit codes: 0 = read (header + content; the content
 * may be truncated when the file exceeds maxBytes — the header says
 * so, and the caller records it instead of parsing a truncated
 * file); 2 = file missing (`READ-MISSING <path>`); 1 = unreadable
 * (`READ-ERROR <reason>`). Pure. */
export function readFileScript(filePath: string, maxBytes: number): string {
  const py = [
    "import sys",
    "p = sys.argv[1]",
    "mx = int(sys.argv[2])",
    "try:",
    "    data = open(p, 'rb').read()",
    "except FileNotFoundError:",
    "    print('READ-MISSING ' + p)",
    "    raise SystemExit(2)",
    "except OSError as e:",
    "    print('READ-ERROR ' + str(e)[:200])",
    "    raise SystemExit(1)",
    "text = data.decode('utf-8', 'replace')",
    "total = len(text)",
    "chunk = text[:mx]",
    "sys.stdout.write('READ %d %d\\n' % (total, len(chunk)))",
    "sys.stdout.write(chunk)",
  ];
  return (
    "python3 - " +
    shellQuote(filePath) +
    " " +
    String(maxBytes) +
    " <<'DAILY_BRIEF_READ_PY'\n" +
    py.join("\n") +
    "\nDAILY_BRIEF_READ_PY"
  );
}

/** Parse a successful read trap's stdout. Throws loudly on a
 * malformed header — a read that returns something unparseable is
 * a broken trap, never a silent empty file. Pure. */
export function parseReadOutput(text: string): { total: number; printed: number; content: string } {
  const nl = text.indexOf("\n");
  const header = nl < 0 ? text.trim() : text.slice(0, nl).trim();
  const m = /^READ (\d+) (\d+)$/.exec(header);
  if (!m) throw new Error("daily-brief: read output is not a READ line: " + JSON.stringify(header.slice(0, 200)));
  return { total: Number(m[1]), printed: Number(m[2]), content: nl < 0 ? "" : text.slice(nl + 1) };
}

/** The ledger-tail script: print one `TAIL <lines>` header line,
 * then the last maxLines lines of the JSONL ledger, verbatim.
 * Exit codes: 0 = read; 2 = file missing (`TAIL-MISSING <path>`);
 * 1 = unreadable. Pure. */
export function ledgerTailScript(ledgerPath: string, maxLines: number): string {
  const py = [
    "import sys",
    "p = sys.argv[1]",
    "mx = int(sys.argv[2])",
    "try:",
    "    lines = open(p, 'rb').read().decode('utf-8', 'replace').splitlines()",
    "except FileNotFoundError:",
    "    print('TAIL-MISSING ' + p)",
    "    raise SystemExit(2)",
    "except OSError as e:",
    "    print('TAIL-ERROR ' + str(e)[:200])",
    "    raise SystemExit(1)",
    "tail = lines[-mx:] if mx > 0 else []",
    "sys.stdout.write('TAIL %d\\n' % len(tail))",
    "for ln in tail:",
    "    sys.stdout.write(ln + '\\n')",
  ];
  return (
    "python3 - " +
    shellQuote(ledgerPath) +
    " " +
    String(maxLines) +
    " <<'DAILY_BRIEF_TAIL_PY'\n" +
    py.join("\n") +
    "\nDAILY_BRIEF_TAIL_PY"
  );
}

/** Parse a ledger-tail trap's stdout: each tail line parsed as a
 * JSONL record, taking runId / workflow / status. Unparsable lines
 * are skipped and counted (never silently treated as runs). Pure. */
export function parseLedgerTail(text: string): { runs: LedgerRun[]; skipped: number } {
  const lines = text.split("\n");
  const header = (lines[0] ?? "").trim();
  const m = /^TAIL (\d+)$/.exec(header);
  if (!m) throw new Error("daily-brief: ledger tail output is not a TAIL line: " + JSON.stringify(header.slice(0, 200)));
  const runs: LedgerRun[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    let v: unknown;
    try {
      v = JSON.parse(line) as unknown;
    } catch {
      skipped++;
      continue;
    }
    if (!isPlainObject(v) || !isNonEmptyString(v.runId) || !isNonEmptyString(v.status)) {
      skipped++;
      continue;
    }
    runs.push({
      runId: v.runId as string,
      workflow: typeof v.workflow === "string" ? (v.workflow as string) : "",
      status: v.status as string,
    });
  }
  return { runs, skipped };
}

/** The backlog-headings script: print one `HEADINGS <count>`
 * header line, then the first maxItems `## ` headings of the
 * BACKLOG.md file, with the `## ` stripped. Exit codes: 0 = read;
 * 2 = file missing (`HEADINGS-MISSING <path>`); 1 = unreadable.
 * Pure. */
export function backlogHeadingsScript(backlogPath: string, maxItems: number): string {
  const py = [
    "import sys",
    "p = sys.argv[1]",
    "mx = int(sys.argv[2])",
    "try:",
    "    lines = open(p, 'rb').read().decode('utf-8', 'replace').splitlines()",
    "except FileNotFoundError:",
    "    print('HEADINGS-MISSING ' + p)",
    "    raise SystemExit(2)",
    "except OSError as e:",
    "    print('HEADINGS-ERROR ' + str(e)[:200])",
    "    raise SystemExit(1)",
    "heads = []",
    "for ln in lines:",
    "    if ln.startswith('## '):",
    "        heads.append(ln[3:].strip())",
    "        if len(heads) >= mx:",
    "            break",
    "sys.stdout.write('HEADINGS %d\\n' % len(heads))",
    "for h in heads:",
    "    sys.stdout.write(h + '\\n')",
  ];
  return (
    "python3 - " +
    shellQuote(backlogPath) +
    " " +
    String(maxItems) +
    " <<'DAILY_BRIEF_HEADINGS_PY'\n" +
    py.join("\n") +
    "\nDAILY_BRIEF_HEADINGS_PY"
  );
}

/** Parse a backlog-headings trap's stdout. Throws loudly on a
 * malformed header. Pure. */
export function parseBacklogHeadings(text: string): string[] {
  const lines = text.split("\n");
  const header = (lines[0] ?? "").trim();
  const m = /^HEADINGS (\d+)$/.exec(header);
  if (!m) throw new Error("daily-brief: backlog headings output is not a HEADINGS line: " + JSON.stringify(header.slice(0, 200)));
  return lines.slice(1).filter((l) => l.trim() !== "");
}

/** The script for one chunk of a file write: append one base64
 * chunk (decoded) to the temp file, in the dispatch pattern
 * (`splitHandoffChunks` + `appendChunkScript`). The first chunk
 * truncates the temp file; later chunks append. Pure. */
export function chunkWriteScript(chunkB64: string, index: number, tmpPath: string): string {
  const truncate = index === 0 ? ": > " + shellQuote(tmpPath) + "\n" : "";
  return truncate + appendChunkScript(chunkB64, index, tmpPath);
}

/** The finalize script: rename the temp file onto the destination
 * (atomic), then read it back and verify it (JSON parses for
 * kind "json"; non-empty and contains </html> for kind "html"),
 * then print one `WROTE <bytes> <path>` line (the dispatch
 * summary format, parsed by `parseWriteSummary`). Exit codes:
 * 0 = wrote + verified; 1 = rename failed; 2 = read-back
 * failed. Pure. */
export function finalizeWriteScript(tmpPath: string, destPath: string, kind: "json" | "html" | "text"): string {
  const verify =
    kind === "json"
      ? "python3 -c 'import json,sys; json.load(open(sys.argv[1]))' " + shellQuote(destPath) + " > /dev/null || exit 2\n"
      : kind === "html"
        ? "grep -q '</html>' " + shellQuote(destPath) + " || exit 2\n"
        : "[ -s " + shellQuote(destPath) + " ] || exit 2\n";
  return (
    "mkdir -p \"$(dirname " +
    shellQuote(destPath) +
    ")\" || exit 1\n" +
    "mv " +
    shellQuote(tmpPath) +
    " " +
    shellQuote(destPath) +
    " || exit 1\n" +
    verify +
    "bytes=$(wc -c < " +
    shellQuote(destPath) +
    ")\n" +
    "printf 'WROTE %s %s\\n' \"$bytes\" " +
    shellQuote(destPath)
  );
}

/** Assemble the report. Pure — unit-tested directly. The verdict
 * is "prompted" / "aggregated" / "briefed" only when the phase
 * wrote (or, in dry-run, planned) cleanly; "dry-run" when the
 * plan is clean and nothing was written; "failed" otherwise.
 * Every failure is named in notes. */
export function buildDailyBriefReport(args: {
  briefId: string;
  verdict: DailyBriefReport["verdict"];
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  phase: DailyBriefPhase;
  date: string;
  promptPayloads?: PromptPayload[];
  aggregationPath?: string;
  logPath?: string;
  briefPath?: string;
  deliveryPayload?: DeliveryPayload;
  decisionsNeeded?: number;
  risks?: number;
  missing: MissingLead[];
  extraNotes?: string[];
}): DailyBriefReport {
  const notes: string[] = [...(args.extraNotes ?? [])];
  if (args.cancelled) {
    notes.push("run cancelled — daily brief refused, nothing was written");
  }
  return {
    briefId: args.briefId,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    phase: args.phase,
    date: args.date,
    promptPayloads: args.promptPayloads,
    aggregationPath: args.aggregationPath,
    logPath: args.logPath,
    briefPath: args.briefPath,
    deliveryPayload: args.deliveryPayload,
    decisionsNeeded: args.decisionsNeeded,
    risks: args.risks,
    missing: args.missing,
    notes,
    knownLimit: DAILY_BRIEF_KNOWN_LIMIT,
  };
}

// ------------------------------------------------------------------
// Trap I/O helpers (exec traps; not pure).
// ------------------------------------------------------------------

type ReadResult =
  | { kind: "ok"; total: number; printed: number; content: string }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/** Read one file through a bounded exec trap. A missing file is a
 * result, not a throw — the caller records it (a missing lead
 * report never blocks the brief). A truncated read is reported
 * in the result (the caller records the bound, never parses a
 * truncated file). A malformed trap response throws loudly. */
function readFileViaTrap(filePath: string, maxBytes: number): ReadResult {
  const r = exec({ cmd: "/bin/sh", args: ["-c", readFileScript(filePath, maxBytes)] });
  if (r.exitCode === 2) return { kind: "missing" };
  if (r.exitCode === 1) {
    return { kind: "error", reason: (r.stdout ?? "").trim().slice(0, 200) || "read failed (rc 1)" };
  }
  if (r.exitCode !== 0) {
    throw new Error(
      "daily-brief: read trap failed unexpectedly for " +
        filePath +
        " (rc " +
        r.exitCode +
        "): " +
        ((r.stderr ?? "") + (r.stdout ?? "")).slice(0, 200),
    );
  }
  const parsed = parseReadOutput(r.stdout ?? "");
  return { kind: "ok", total: parsed.total, printed: parsed.printed, content: parsed.content };
}

/** Write one text file through chunked base64 traps + rename +
 * read-back (the dispatch pattern). Throws loudly on any failure
 * — a half-written brief must not report success. */
function writeTextFile(tmpPath: string, destPath: string, content: string, kind: "json" | "html" | "text"): void {
  const chunks = splitHandoffChunks(content);
  for (let i = 0; i < chunks.length; i++) {
    const r = exec({ cmd: "/bin/sh", args: ["-c", chunkWriteScript(chunks[i], i, tmpPath)] });
    if (r.exitCode !== 0 || (r.stdout ?? "").trim() !== "CHUNK " + i) {
      throw new Error(
        "daily-brief: write chunk " + i + " failed for " + destPath + ": " + JSON.stringify((r.stdout ?? "").slice(0, 200)),
      );
    }
  }
  const fin = exec({ cmd: "/bin/sh", args: ["-c", finalizeWriteScript(tmpPath, destPath, kind)] });
  if (fin.exitCode !== 0) {
    throw new Error("daily-brief: write finalize failed for " + destPath + " (rc " + fin.exitCode + ")");
  }
  const summary = parseWriteSummary(fin.stdout ?? "");
  if (summary.path !== destPath) {
    throw new Error("daily-brief: write path mismatch: " + summary.path + " != " + destPath);
  }
}

/** Build one prompt payload per roster lead. Pure — the message
 * names the deadline, the schema, the reports-dir path, and the
 * rule that a lead with nothing to say writes a short status and
 * empty lists, never nothing. */
export function buildPromptPayloads(args: {
  roster: RosterEntry[];
  date: string;
  reportsDir: string;
  deadlines: Record<string, string>;
}): PromptPayload[] {
  return args.roster.map((entry) => {
    const deadline = typeof args.deadlines[entry.lead] === "string" ? args.deadlines[entry.lead] : "06:00";
    const message =
      "Write today's lead report for " +
      entry.lead +
      " (" +
      args.date +
      ") by " +
      deadline +
      ". Schema: {lead, date, status, reflections[], predictions[{claim, confidence, horizon}], solutions[{problem, proposal}], needs_pm[], numbers{}} — " +
      "all fields except lead and date are optional. A lead with nothing to say writes a short status and empty lists, never nothing — " +
      "silence is indistinguishable from a dead lead. Write it to " +
      args.reportsDir +
      "/" +
      entry.lead +
      "-" +
      args.date +
      ".json.";
    return { lead: entry.lead, chatId: entry.chat_id, message };
  });
}

/** Validate a parsed aggregation JSON (the brief phase reads the
 * aggregate's output). Pure — returns the error string, or null
 * when the aggregation is well-formed for this date. */
export function validateAggregation(value: unknown, date: string): string | null {
  if (!isPlainObject(value)) return "aggregation is not a JSON object";
  if (value.date !== date) return "aggregation date " + JSON.stringify(value.date) + " does not match brief date " + JSON.stringify(date);
  for (const f of ["receipt", "mustKnow"]) {
    if (typeof value[f] !== "string") return "aggregation has no " + f + " string";
  }
  for (const f of ["decisionsNeeded", "risks", "perLead", "missing", "log"]) {
    if (!Array.isArray(value[f])) return "aggregation has no " + f + " array";
  }
  if (!isPlainObject(value.directorReport)) return "aggregation has no directorReport object";
  // The throughput section, when present, must carry the shape
  // the renderer assumes — this hardens the known Low at
  // BACKLOG.md line 429 for the new field only (the existing Low
  // stands for the rest of the aggregation: the brief phase throws
  // on a malformed aggregation instead of refusing).
  if (value.throughput !== undefined) {
    if (!isPlainObject(value.throughput)) return "aggregation throughput is not an object";
    const t = value.throughput as JsonObject;
    for (const f of ["tasksCompleted", "landings", "itemsInWindow"]) {
      if (typeof t[f] !== "number") return "aggregation throughput." + f + " is not a number";
    }
    for (const f of ["stalled", "missing"]) {
      if (!Array.isArray(t[f])) return "aggregation throughput." + f + " is not an array";
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Entry.
// ------------------------------------------------------------------

export default function dailyBrief(input: DailyBriefInput): DailyBriefReport {
  const briefId = "daily-brief-" + (isPlainObject(input) && isPlainObject((input as JsonObject).run) ? String(((input as JsonObject).run as JsonObject).date ?? "unknown") : "unknown");
  const dryRun = isPlainObject(input) && isPlainObject((input as JsonObject).run) && (input as DailyBriefInput).run.dryRun === true;
  const owner = isPlainObject(input) && typeof (input as JsonObject).owner === "string" ? ((input as JsonObject).owner as string) : "";
  const launchedBy =
    isPlainObject(input) && typeof (input as JsonObject).launchedBy === "string" ? ((input as JsonObject).launchedBy as string) : undefined;
  let cancelChecked = false;
  let cancelled = false;

  // refused() builds a failed report with the LIVE cancelChecked
  // value, used for every refusal path.
  const refusedReport = (notes: string[], phase?: DailyBriefPhase, date?: string): DailyBriefReport =>
    buildDailyBriefReport({
      briefId,
      verdict: "failed",
      dryRun,
      owner,
      launchedBy,
      cancelChecked,
      cancelled,
      phase: phase ?? "aggregate",
      date: date ?? "",
      missing: [],
      extraNotes: notes,
    });

  if (!isPlainObject(input)) {
    throw new Error("daily-brief: input is not an object");
  }
  const project = (input as JsonObject).project;
  const workDir = isPlainObject(project) && typeof project.workDir === "string" ? (project.workDir as string) : "";
  // Step 0: mkdir the work dir (exec trap), then validate. A mkdir
  // failure is environmental — throw loudly. A validation failure
  // refuses the run with a failed report (the triage pattern:
  // refused(), never a throw for bad input). When workDir is empty
  // the mkdir is skipped — validation refuses the input below
  // instead of the mkdir throwing on an empty path.
  if (workDir !== "") {
    const mk = exec({ cmd: "/bin/sh", args: ["-c", "mkdir -p " + shellQuote(workDir) + " " + shellQuote(workDir + "/tmp")] });
    if (mk.exitCode !== 0) {
      throw new Error("daily-brief: cannot create workDir " + workDir + " (rc " + mk.exitCode + ")");
    }
  }
  // run may be null (the BACKLOG.md refused() nit: validate
  // defensively — a null run yields a failed report, never a
  // throw). The checks below read run.* only after this guard.
  if (!isPlainObject((input as JsonObject).run)) {
    return refusedReport(["daily-brief: input has no run object"]);
  }
  const run = (input as DailyBriefInput).run;
  const validationErrors = validateDailyBriefInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors, run.phase, run.date);
  }
  const stateDir = (input as DailyBriefInput).project.stateDir;

  // Cancel check first (when runId present): check-then-act before
  // any read or write. Exit 2 (no queue entry) and exit 3 (queue
  // missing/unparsable) mean the check did not complete — the run
  // refuses with cancelChecked false. A cancelled run refuses
  // with cancelChecked true + cancelled true.
  if (typeof run.runId === "string" && run.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, run.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["daily-brief: cancel check: no queue entry for run " + run.runId], run.phase, run.date);
    }
    if (check.exitCode === 3) {
      return refusedReport(["daily-brief: cancel check: " + (check.stdout ?? "").trim().slice(0, 200)], run.phase, run.date);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "daily-brief: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout ?? "");
    } catch (e) {
      throw new Error("daily-brief: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["daily-brief: run " + run.runId + " is cancelled — the brief exits cleanly without advancing"], run.phase, run.date);
    }
  }

  const tmpDir = (input as DailyBriefInput).project.workDir + "/tmp";

  if (run.phase === "prompt") {
    // Read the roster (it must be present and non-empty — an
    // empty roster refuses the whole run before any write). The
    // prompt phase writes nothing; dry-run and real differ only
    // in the verdict.
    const rosterRead = readFileViaTrap(run.rosterPath, DAILY_BRIEF_REPORT_MAX_BYTES);
    if (rosterRead.kind === "missing") {
      return refusedReport(["daily-brief: roster file not found: " + run.rosterPath], run.phase, run.date);
    }
    if (rosterRead.kind === "error") {
      return refusedReport(["daily-brief: roster unreadable: " + rosterRead.reason], run.phase, run.date);
    }
    if (rosterRead.printed < rosterRead.total) {
      return refusedReport(
        ["daily-brief: roster exceeds the " + DAILY_BRIEF_REPORT_MAX_BYTES + "-byte read bound (" + rosterRead.total + " bytes)"],
        run.phase,
        run.date,
      );
    }
    let rosterJson: unknown;
    try {
      rosterJson = JSON.parse(rosterRead.content) as unknown;
    } catch (e) {
      return refusedReport(["daily-brief: roster is unparsable JSON: " + (e as Error).message.slice(0, 200)], run.phase, run.date);
    }
    const { roster, errors } = validateRoster(rosterJson);
    if (errors.length > 0) {
      return refusedReport(errors, run.phase, run.date);
    }
    const payloads = buildPromptPayloads({ roster, date: run.date, reportsDir: run.reportsDir, deadlines: run.deadlines });
    return buildDailyBriefReport({
      briefId,
      verdict: dryRun ? "dry-run" : "prompted",
      dryRun,
      owner: (input as DailyBriefInput).owner,
      launchedBy: (input as DailyBriefInput).launchedBy,
      cancelChecked,
      cancelled,
      phase: run.phase,
      date: run.date,
      promptPayloads: payloads,
      missing: [],
      extraNotes: dryRun
        ? ["dry-run: " + payloads.length + " prompt payloads planned, nothing written, nothing sent"]
        : [payloads.length + " prompt payloads emitted for the launcher to deliver (the workflow sends no messages)"],
    });
  }

  if (run.phase === "aggregate") {
    const rosterRead = readFileViaTrap(run.rosterPath, DAILY_BRIEF_REPORT_MAX_BYTES);
    if (rosterRead.kind === "missing") {
      return refusedReport(["daily-brief: roster file not found: " + run.rosterPath], run.phase, run.date);
    }
    if (rosterRead.kind === "error") {
      return refusedReport(["daily-brief: roster unreadable: " + rosterRead.reason], run.phase, run.date);
    }
    if (rosterRead.printed < rosterRead.total) {
      return refusedReport(
        ["daily-brief: roster exceeds the " + DAILY_BRIEF_REPORT_MAX_BYTES + "-byte read bound (" + rosterRead.total + " bytes)"],
        run.phase,
        run.date,
      );
    }
    let rosterJson: unknown;
    try {
      rosterJson = JSON.parse(rosterRead.content) as unknown;
    } catch (e) {
      return refusedReport(["daily-brief: roster is unparsable JSON: " + (e as Error).message.slice(0, 200)], run.phase, run.date);
    }
    const { roster, errors } = validateRoster(rosterJson);
    if (errors.length > 0) {
      return refusedReport(errors, run.phase, run.date);
    }
    if (dryRun) {
      // Dry-run: list the files it would read and the sections it
      // would derive; write nothing.
      const plannedReads: string[] = [run.rosterPath];
      for (const entry of roster) {
        plannedReads.push(run.reportsDir + "/" + entry.lead + "-" + run.date + ".json");
        plannedReads.push(run.reportsDir + "/" + entry.lead + "-" + yesterdayOf(run.date) + ".json");
      }
      plannedReads.push(run.goalNotesPath, run.ledgerPath, run.predictorRecordPath, run.backlogPath);
      if (typeof run.throughputReportPath === "string" && run.throughputReportPath !== "") {
        plannedReads.push(run.throughputReportPath);
      }
      return buildDailyBriefReport({
        briefId,
        verdict: "dry-run",
        dryRun,
        owner: (input as DailyBriefInput).owner,
        launchedBy: (input as DailyBriefInput).launchedBy,
        cancelChecked,
        cancelled,
        phase: run.phase,
        date: run.date,
        aggregationPath: run.aggregationPath,
        logPath: run.logPath,
        missing: [],
        extraNotes: [
          "dry-run: would read " + plannedReads.length + " files: " + plannedReads.join(", "),
          "dry-run: would derive decisions-needed, must-know, risks, per-lead sections, the Director's own report, and missing-lead sections; would write the aggregation to " +
            run.aggregationPath +
            " and the log to " +
            run.logPath +
            "; nothing written",
        ],
      });
    }
    const yesterday = yesterdayOf(run.date);
    const reports = new Map<string, LeadReport>();
    const priorReports = new Map<string, LeadReport>();
    const missing: MissingLead[] = [];
    const readLog: string[] = [];
    readLog.push("read " + run.rosterPath);
    for (const entry of roster) {
      const reportPath = run.reportsDir + "/" + entry.lead + "-" + run.date + ".json";
      const read = readFileViaTrap(reportPath, DAILY_BRIEF_REPORT_MAX_BYTES);
      readLog.push("read " + reportPath);
      if (read.kind === "missing") {
        missing.push({ lead: entry.lead, reason: "report file not found: " + reportPath });
        continue;
      }
      if (read.kind === "error") {
        missing.push({ lead: entry.lead, reason: "report unreadable: " + read.reason });
        continue;
      }
      if (read.printed < read.total) {
        missing.push({
          lead: entry.lead,
          reason: "report exceeds the " + DAILY_BRIEF_REPORT_MAX_BYTES + "-byte read bound (" + read.total + " bytes)",
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.content) as unknown;
      } catch (e) {
        missing.push({ lead: entry.lead, reason: "report is unparsable JSON: " + (e as Error).message.slice(0, 200) });
        continue;
      }
      const validated = validateLeadReport(parsed, entry.lead, run.date);
      if (!validated.valid) {
        missing.push({ lead: entry.lead, reason: "report failed validation: " + validated.reason });
        continue;
      }
      reports.set(entry.lead, validated.report);
    }
    // Prior-day reports: trend arrows and status-change detection
    // only. A missing or invalid prior-day report means no arrow
    // for that lead — recorded in the log, never blocking.
    for (const entry of roster) {
      if (!reports.has(entry.lead)) continue;
      const priorPath = run.reportsDir + "/" + entry.lead + "-" + yesterday + ".json";
      const read = readFileViaTrap(priorPath, DAILY_BRIEF_REPORT_MAX_BYTES);
      if (read.kind !== "ok") {
        readLog.push("no prior-day report for " + entry.lead + " (" + read.kind + ") — no trend arrow");
        continue;
      }
      readLog.push("read " + priorPath);
      if (read.printed < read.total) {
        readLog.push("prior-day report for " + entry.lead + " exceeds the read bound — no trend arrow");
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.content) as unknown;
      } catch {
        readLog.push("prior-day report for " + entry.lead + " is unparsable — no trend arrow");
        continue;
      }
      const validated = validateLeadReport(parsed, entry.lead, yesterday);
      if (!validated.valid) {
        readLog.push("prior-day report for " + entry.lead + " failed validation (" + validated.reason + ") — no trend arrow");
        continue;
      }
      priorReports.set(entry.lead, validated.report);
    }
    // The PM's state: goal notes (bounded head), ledger tail,
    // predictor record, backlog headings. Each missing file is
    // recorded in the log; none blocks the brief.
    const goalRead = readFileViaTrap(run.goalNotesPath, DAILY_BRIEF_GOAL_NOTES_MAX_BYTES);
    readLog.push("read " + run.goalNotesPath);
    const goalNotes = goalRead.kind === "ok" ? goalRead.content : null;
    const goalNotesTruncated = goalRead.kind === "ok" && goalRead.printed < goalRead.total;
    if (goalRead.kind === "missing") readLog.push("goal notes missing: " + run.goalNotesPath);
    if (goalRead.kind === "error") readLog.push("goal notes unreadable: " + goalRead.reason);
    const ledgerResult = exec({ cmd: "/bin/sh", args: ["-c", ledgerTailScript(run.ledgerPath, DAILY_BRIEF_LEDGER_TAIL_LINES)] });
    readLog.push("read " + run.ledgerPath);
    let ledgerRuns: LedgerRun[] = [];
    let ledgerMissing = false;
    let ledgerSkipped = 0;
    if (ledgerResult.exitCode === 2) {
      ledgerMissing = true;
    } else if (ledgerResult.exitCode === 1) {
      readLog.push("ledger unreadable: " + (ledgerResult.stdout ?? "").trim().slice(0, 200));
      ledgerMissing = true;
    } else if (ledgerResult.exitCode !== 0) {
      throw new Error("daily-brief: ledger tail trap failed unexpectedly (rc " + ledgerResult.exitCode + ")");
    } else {
      const tail = parseLedgerTail(ledgerResult.stdout ?? "");
      ledgerRuns = tail.runs;
      ledgerSkipped = tail.skipped;
    }
    const predictorRead = readFileViaTrap(run.predictorRecordPath, DAILY_BRIEF_REPORT_MAX_BYTES);
    readLog.push("read " + run.predictorRecordPath);
    const predictorRecord = predictorRead.kind === "ok" ? predictorRead.content : null;
    const predictorMissing = predictorRead.kind !== "ok";
    if (predictorRead.kind === "missing") readLog.push("predictor record missing: " + run.predictorRecordPath);
    if (predictorRead.kind === "error") readLog.push("predictor record unreadable: " + predictorRead.reason);
    if (predictorRead.kind === "ok" && predictorRead.printed < predictorRead.total) {
      readLog.push("predictor record truncated to the read bound — read as part of the PM's state, nothing scored");
    }
    const headingsResult = exec({ cmd: "/bin/sh", args: ["-c", backlogHeadingsScript(run.backlogPath, DAILY_BRIEF_BACKLOG_MAX_HEADINGS)] });
    readLog.push("read " + run.backlogPath);
    let backlogHeadings: string[] = [];
    let backlogMissing = false;
    if (headingsResult.exitCode === 2) {
      backlogMissing = true;
    } else if (headingsResult.exitCode === 1) {
      readLog.push("backlog unreadable: " + (headingsResult.stdout ?? "").trim().slice(0, 200));
      backlogMissing = true;
    } else if (headingsResult.exitCode !== 0) {
      throw new Error("daily-brief: backlog headings trap failed unexpectedly (rc " + headingsResult.exitCode + ")");
    } else {
      backlogHeadings = parseBacklogHeadings(headingsResult.stdout ?? "");
    }
    // 247's throughput report (one new validated input): present
    // renders the section, absent renders without it, malformed
    // records missing-with-reason and still renders. Never blocks
    // the brief.
    let throughputSection: ThroughputSection | undefined;
    let throughputMissingReason: string | undefined;
    if (typeof run.throughputReportPath === "string" && run.throughputReportPath !== "") {
      const throughputRead = readFileViaTrap(run.throughputReportPath, THROUGHPUT_READ_MAX_BYTES);
      readLog.push("read " + run.throughputReportPath);
      if (throughputRead.kind === "missing") {
        throughputMissingReason = "throughput report not found: " + run.throughputReportPath;
      } else if (throughputRead.kind === "error") {
        throughputMissingReason = "throughput report unreadable: " + throughputRead.reason;
      } else if (throughputRead.printed < throughputRead.total) {
        throughputMissingReason =
          "throughput report exceeds the " + THROUGHPUT_READ_MAX_BYTES + "-byte read bound (" + throughputRead.total + " bytes)";
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(throughputRead.content) as unknown;
        } catch (e) {
          throughputMissingReason = "throughput report is unparsable JSON: " + (e as Error).message.slice(0, 200);
        }
        if (throughputMissingReason === undefined) {
          const validated = validateThroughputReportFile(parsed, run.date);
          if (!validated.valid) throughputMissingReason = "throughput report failed validation: " + validated.reason;
          else throughputSection = validated.section;
        }
      }
    }
    const aggregation = deriveAggregation({
      date: run.date,
      yesterday,
      roster,
      reports,
      priorReports,
      missing,
      goalNotes,
      goalNotesTruncated,
      ledgerRuns,
      ledgerMissing,
      ledgerSkippedLines: ledgerSkipped,
      predictorRecord,
      predictorMissing,
      backlogHeadings,
      backlogMissing,
      directorMustKnow: run.mustKnow,
      throughputSection,
      throughputMissingReason,
    });
    aggregation.log = [...readLog, ...aggregation.log];
    const aggregationJson = JSON.stringify(aggregation, null, 2) + "\n";
    const logText = aggregation.log.join("\n") + "\n";
    writeTextFile(tmpDir + "/daily-brief-aggregation-" + run.date + ".tmp", run.aggregationPath, aggregationJson, "json");
    writeTextFile(tmpDir + "/daily-brief-log-" + run.date + ".tmp", run.logPath, logText, "text");
    return buildDailyBriefReport({
      briefId,
      verdict: "aggregated",
      dryRun,
      owner: (input as DailyBriefInput).owner,
      launchedBy: (input as DailyBriefInput).launchedBy,
      cancelChecked,
      cancelled,
      phase: run.phase,
      date: run.date,
      aggregationPath: run.aggregationPath,
      logPath: run.logPath,
      decisionsNeeded: aggregation.decisionsNeeded.length,
      risks: aggregation.risks.length,
      missing,
      extraNotes: aggregation.log,
    });
  }

  // run.phase === "brief"
  const aggRead = readFileViaTrap(run.aggregationPath, DAILY_BRIEF_READ_MAX_BYTES);
  if (aggRead.kind === "missing") {
    return refusedReport(["daily-brief: aggregation not found: " + run.aggregationPath + " — the aggregate phase must run first"], run.phase, run.date);
  }
  if (aggRead.kind === "error") {
    return refusedReport(["daily-brief: aggregation unreadable: " + aggRead.reason], run.phase, run.date);
  }
  if (aggRead.printed < aggRead.total) {
    return refusedReport(
      ["daily-brief: aggregation exceeds the " + DAILY_BRIEF_READ_MAX_BYTES + "-byte read bound (" + aggRead.total + " bytes)"],
      run.phase,
      run.date,
    );
  }
  let aggJson: unknown;
  try {
    aggJson = JSON.parse(aggRead.content) as unknown;
  } catch (e) {
    return refusedReport(["daily-brief: aggregation is unparsable JSON: " + (e as Error).message.slice(0, 200)], run.phase, run.date);
  }
  const aggError = validateAggregation(aggJson, run.date);
  if (aggError !== null) {
    return refusedReport(["daily-brief: aggregation is malformed: " + aggError], run.phase, run.date);
  }
  const aggregation = aggJson as unknown as Aggregation;
  const html = renderBriefHtml(aggregation);
  if (!dryRun) {
    writeTextFile(tmpDir + "/daily-brief-html-" + run.date + ".tmp", run.briefPath, html, "html");
  }
  const deliveryPayload: DeliveryPayload = { briefPath: run.briefPath, mustKnow: aggregation.mustKnow };
  return buildDailyBriefReport({
    briefId,
    verdict: dryRun ? "dry-run" : "briefed",
    dryRun,
    owner: (input as DailyBriefInput).owner,
    launchedBy: (input as DailyBriefInput).launchedBy,
    cancelChecked,
    cancelled,
    phase: run.phase,
    date: run.date,
    briefPath: run.briefPath,
    deliveryPayload,
    decisionsNeeded: aggregation.decisionsNeeded.length,
    risks: aggregation.risks.length,
    missing: aggregation.missing,
    extraNotes: dryRun
      ? ["dry-run: would write the HTML brief to " + run.briefPath + "; nothing written", "dry-run: delivery payload planned (dated HTML path + must-know line) for the launcher to send at 07:00"]
      : ["HTML brief written to " + run.briefPath, "delivery payload for the launcher: dated HTML path + must-know line (send to main chat at 07:00)"],
  });
}
