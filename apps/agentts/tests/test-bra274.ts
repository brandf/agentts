/**
 * test-bra274.ts — the daily brief workflow (BRA-274).
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh — the daily-brief section is wired after lead-loop).
 *   B. `agentts check` passes on daily-brief.ts (first-run gate).
 *   C. Pure unit checks: validateDailyBriefInput (every guard),
 *      isValidDateString / yesterdayOf, validateRoster,
 *      validateLeadReport (absent optionals are empty, never
 *      invalid; a wrong shape on a present field is invalid),
 *      trendArrow / formatNumber, deriveAggregation (decisions in
 *      roster order, must-know precedence, risks, per-lead arrows,
 *      the Director's own report, receipt, the throughput section
 *      + missing reason), firstParagraph /
 *      firstSentence / escapeHtml, renderBriefHtml (structure,
 *      the Throughput card only when the section is present),
 *      the trap-script builders + parsers, buildPromptPayloads,
 *      validateAggregation (including the throughput shape check),
 *      buildDailyBriefReport.
 *   D. Live runs against a stub-free scratch project (fixture
 *      roster + fixture lead JSONs + fixture PM state under the
 *      test WORKDIR — never the real goal files), all through the
 *      CLI on direct:
 *      D1 prompt (one payload per roster lead, right chat id,
 *        06:00 deadline named, reports-dir path named; nothing
 *        written, nothing sent);
 *      D2 aggregate, all six present (decisions in roster order
 *        attributed; must-know precedence — PM-authored, then
 *        derived when the PM carries none, log records when
 *        derived; risks; per-lead sections with trend arrows
 *        against a prior-day fixture, no raw JSON; the Director's
 *        own report section; aggregation log lists every file
 *        read);
 *      D3 aggregate, one lead missing + one invalid (missing
 *        noted with reason, invalid recorded with failing field
 *        named, brief still completes, receipt names missing
 *        leads);
 *      D4 aggregate, PM report missing (must-know falls back to
 *        first decision, log records derived, brief notes PM
 *        report missing, nothing blocks);
 *      D5 brief (renders dated HTML from a fixture aggregation —
 *        decisions box up top, must-know line, risks, per-lead
 *        sections, Director's report, missing-lead sections —
 *        refuses loudly on missing or wrong-date aggregation);
 *      D6 full sequence prompt → aggregate → brief on a scratch
 *        project, dated HTML written, aggregation log complete,
 *        brief phase's report carries the delivery payload;
 *      D7 dry-run (all three phases write nothing);
 *      D8 cancel (cancelled runId refuses with cancelChecked
 *        true, writes nothing — the cancel check reads
 *        project.stateDir/queue.json, a scratch dir with a
 *        hand-crafted cancelled entry, while the real run lives
 *        in the test's state dir: the bra210a case-H shape, no
 *        timing race, no live cancel needed);
 *      D9 validation, live (a JSON missing numbers is VALID and
 *        its lead is present; a JSON with a prediction lacking
 *        horizon is invalid, recorded missing-with-reason, never
 *        silently dropped);
 *      D10 throughput present, live (a valid 247 report is read,
 *        the aggregation carries the section, the brief renders
 *        the Throughput card);
 *      D11 throughput absent, live (no section, the brief renders
 *        without the card);
 *      D12 throughput malformed, live (recorded missing-with-
 *        reason, the aggregate still lands, the brief still
 *        renders).
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra274.ts
 *   (run.sh sets DQUICKTS when it runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 *
 * Every passing check prints a line containing " OK:" — run.sh
 * counts those lines for the tier-1 OK total, so every check
 * (not just §A/§B/submit) is phrased with the marker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import dailyBrief, {
  validateDailyBriefInput,
  isValidDateString,
  yesterdayOf,
  validateRoster,
  validateLeadReport,
  trendArrow,
  formatNumber,
  deriveAggregation,
  firstParagraph,
  firstSentence,
  escapeHtml,
  renderBriefHtml,
  readFileScript,
  parseReadOutput,
  ledgerTailScript,
  parseLedgerTail,
  backlogHeadingsScript,
  parseBacklogHeadings,
  chunkWriteScript,
  finalizeWriteScript,
  buildDailyBriefReport,
  buildPromptPayloads,
  validateAggregation,
  DAILY_BRIEF_KNOWN_LIMIT,
  type ThroughputSection,
  DAILY_BRIEF_REPORT_MAX_BYTES,
  type DailyBriefInput,
  type DailyBriefProjectConfig,
  type DailyBriefPhase,
  type DailyBriefRunInput,
  type LeadReport,
  type RosterEntry,
  type Aggregation,
  type MissingLead,
} from "../workflows/library/daily-brief";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const DAILY_BRIEF = path.join(ROOT, "workflows", "library", "daily-brief.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA274_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "daily-brief-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const STATE_DIR = path.join(WORKDIR, "state");
// Hermetic re-runs: the queue registry keeps run IDs forever, so a
// second run against the same state dir would fail every submit as
// "already queued". Wipe our own throwaway state dir at startup.
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
/** The Implementation lead owns brief runs (brief: owner is the driving session). */
const IMPL_OWNER = "3e85493f-f748-4bcd-bec6-94be9c25b282";
const PM_OWNER = "eea685c3-230e-4c26-a286-b7ea60687c70";

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  console.log(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function cli(args: string[], stdinText?: string): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
    input: stdinText,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Every runId this test submits, in submit order. */
const submittedRunIds: string[] = [];
function track(runId: string): string[] {
  submittedRunIds.push(runId);
  return [...submittedRunIds];
}

let server: Subprocess | null = null;
async function startServer(): Promise<void> {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("daily-brief server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
}

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function readJson(p: string): Record<string, any> | null {
  const t = read(p);
  if (t === null) return null;
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Drive one queue pass and return its rc (0 = clean, 1 = some
 * entry failed — the per-run signal is the run's own result,
 * not the exit code). */
function driveQueue(): number {
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--clock", "real", "--gates", "hold"]);
  if (drive.rc !== 0 && drive.rc !== 1) {
    fail(`DRIVE OK: queue run exits ${drive.rc} (expected 0 or 1): ${(drive.out + drive.err).slice(0, 300)}`);
  }
  return drive.rc;
}

/** Submit one daily-brief run (no drive yet — D8's shape needs
 * the submit separated from the drive). */
function submitBrief(runId: string, input: DailyBriefInput): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", DAILY_BRIEF,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
}

/** Fetch one run's result (after a drive) and return the parsed
 * report, or null on a CLI failure (already recorded). */
function fetchResult(runId: string): Record<string, any> | null {
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 300)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as Record<string, any>;
  } catch {
    fail(`RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

/** Drive one daily-brief input through the CLI (submit + queue
 * run + result) and return the parsed report, or null on a CLI
 * failure (the failure is already recorded as a check). */
function driveBrief(runId: string, input: DailyBriefInput): Record<string, any> | null {
  if (!submitBrief(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: a stub-free scratch project. The roster carries the
// real lead names + chat ids (they are just strings here); every
// report, goal note, ledger line, predictor line and backlog
// heading is a fixture written under the test WORKDIR — never
// the real goal files.
// ------------------------------------------------------------------

const DATE = "2026-11-21";
const YESTERDAY = "2026-11-20";

const ROSTER: RosterEntry[] = [
  { lead: "quality", chat_id: "0bc9a8c5-18fa-430c-b6c4-85a54c92b209" },
  { lead: "fleet-ops", chat_id: "319c92ac-34ef-4509-87f5-1ca04a292cd7" },
  { lead: "program-management", chat_id: "eea685c3-230e-4c26-a286-b7ea60687c70" },
  { lead: "implementation", chat_id: "3e85493f-f748-4bcd-bec6-94be9c25b282" },
  { lead: "landing", chat_id: "a25045a8-6678-417c-bcae-d1248594384a" },
  { lead: "knowledge", chat_id: "cdf16d22-d693-4133-be0a-1b87700db377" },
];

/** One lead report's fixture JSON (today or prior day). The
 * reflection string is distinctive on purpose: the aggregation
 * must never carry it (D2 asserts no raw JSON / no reflections). */
function reportFixture(lead: string, date: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    lead,
    date,
    status: `${lead} status for ${date}.`,
    reflections: [`${lead} reflection — never pasted into the brief: the work is moving.`],
    predictions: [{ claim: `${lead} will finish its queue this week.`, confidence: "high", horizon: "this week" }],
    solutions: [{ problem: `${lead} problem: a slow step in the loop.`, proposal: `${lead} proposal: measure it first.` }],
    needs_pm: [],
    numbers: { tasksDone: 1 },
  };
  return { ...base, ...overrides };
}

const TODAY_OVERRIDES: Record<string, Record<string, unknown>> = {
  quality: {
    status: "Quality verified the loop fix round; one Low filed.",
    numbers: { tasksDone: 3, bugsFiled: 2 },
    needs_pm: ["Confirm the Quality acceptance leg for BRA-274"],
    solutions: [{ problem: "Two unfiled fileFirst items lose all but the last reason", proposal: "Accumulate reasons into a list" }],
  },
  "fleet-ops": {
    status: "Fleet-ops measured the loop; the scheduler is next.",
    numbers: { tasksDone: 4 },
    needs_pm: ["Decide whether the scheduler lands before dispatch"],
  },
  "program-management": {
    status: "PM scoped the daily brief; the brief is the next CPU component.",
    numbers: { tasksDone: 2 },
    mustKnow: "The daily brief is the next CPU component; nothing else lands before it.",
  },
  implementation: {
    status: "Role-loop skeleton landed; the daily brief build started.",
    numbers: { tasksDone: 5, landings: 1 },
    needs_pm: ["Approve the daily-brief scope change"],
    solutions: [{ problem: "Tier-1 runs exceed the background wall-clock cap", proposal: "Resume the same resume dir" }],
  },
  landing: {
    status: "Landing authorized and landed the loop skeleton.",
    numbers: { merges: 1 },
  },
  knowledge: {
    status: "Knowledge logged the loop landing.",
    numbers: { tasksDone: 1 },
    needs_pm: ["Pick the next learning-loop topic"],
  },
};

const PRIOR_OVERRIDES: Record<string, Record<string, unknown>> = {
  quality: { status: "Quality ran the loop verification.", numbers: { tasksDone: 3, bugsFiled: 4 } },
  "fleet-ops": { status: "Fleet-ops drafted the CPU model.", numbers: { tasksDone: 4 } },
  "program-management": { status: "PM wrote the scoping doc.", numbers: { tasksDone: 1 } },
  implementation: { status: "Loop fix round in verification.", numbers: { tasksDone: 3, landings: 0 } },
  landing: { status: "Landing waited for authorization.", numbers: { merges: 0 } },
  knowledge: { status: "Knowledge drafted the rubric chain.", numbers: { tasksDone: 2 } },
};

const GOAL_NOTES_FIXTURE = [
  "# AgentTS release 2",
  "",
  "The CPU-first program is mid-flight: seven of eleven components stand, and the daily brief is next. The release is on track.",
  "",
  "## Objectives",
  "",
  "- Land the daily brief workflow.",
  "- Land the scheduler.",
  "",
].join("\n");

/** One 247 throughput section for the brief date (the aggregate
 * reads this shape from the throughput report file). */
function throughputSectionFixture(machineDown = false): ThroughputSection {
  return {
    date: DATE,
    windowDays: 1,
    tasksCompleted: 2,
    landings: 2,
    itemsInWindow: 2,
    medianPickupToLandedMs: 14_400_000,
    medianVerifyMs: 4_800_000,
    killWallMsTotal: 1_200_000,
    killTokensTotal: 5000,
    stalled: [{ issue: "BRA-303", title: "Fixture three (stalled)", status: "ready", stalledForMs: 28_800_000, lastMovedAt: "2026-11-21T06:00:00Z" }],
    missing: [],
    machineDown,
  };
}

/** A full valid 247 throughput report file for the brief date
 * (the shape validateThroughputReportFile accepts). */
function throughputReportFileFixture(): Record<string, unknown> {
  const section = throughputSectionFixture();
  return {
    date: section.date,
    windowDays: section.windowDays,
    totals: {
      tasksCompleted: section.tasksCompleted,
      landings: section.landings,
      itemsInWindow: section.itemsInWindow,
      medianPickupToLandedMs: section.medianPickupToLandedMs,
      medianVerifyMs: section.medianVerifyMs,
      killWallMsTotal: section.killWallMsTotal,
      killTokensTotal: section.killTokensTotal,
      doneRuns: 2,
      failedRuns: 1,
      skippedLedgerLines: 1,
      collectedRuns: 1,
      undatedRuns: 1,
    },
    items: [
      {
        issue: "BRA-301", title: "Fixture one", status: "landed", counted: true, landed: true,
        landedAt: "2026-11-21T12:00:00Z", pickup: "2026-11-21T08:00:00Z", pickupSource: "manifest",
        pickupToLandedMs: 14_400_000, verifyMs: 4_800_000, typecheckPassed: true, closeMs: 1_800_000, buildMs: 4_800_000,
      },
    ],
    stalled: section.stalled,
    missing: section.missing,
    machineDown: section.machineDown,
  };
}

const LEDGER_FIXTURE = [
  JSON.stringify({ version: 1, runId: "loop-fix-1", workflow: "lead-loop", status: "done", adapter: "direct", startedAt: "2026-11-21T01:00:00Z", finishedAt: "2026-11-21T01:05:00Z", wallMs: 300000 }),
  JSON.stringify({ version: 1, runId: "quality-verify-1", workflow: "quality", status: "done", adapter: "direct", startedAt: "2026-11-21T02:00:00Z", finishedAt: "2026-11-21T02:10:00Z", wallMs: 600000 }),
  JSON.stringify({ version: 1, runId: "landing-land-1", workflow: "merge", status: "done", adapter: "direct", startedAt: "2026-11-21T03:00:00Z", finishedAt: "2026-11-21T03:02:00Z", wallMs: 120000 }),
  "",
].join("\n");

const PREDICTOR_FIXTURE = [
  "# Predictor record",
  "",
  "## 2026-11-20",
  "",
  "- implementation predicted the loop would land this week (high, this week).",
  "",
].join("\n");

const BACKLOG_FIXTURE = [
  "# Backlog",
  "",
  "## BRA-300 Scheduler follow-up",
  "",
  "Land the scheduler next.",
  "",
  "## BRA-301 Dispatch routing",
  "",
  "Route dispatch through the scheduler.",
  "",
].join("\n");

interface CasePaths {
  dir: string;
  reportsDir: string;
  rosterPath: string;
  goalNotesPath: string;
  ledgerPath: string;
  predictorRecordPath: string;
  backlogPath: string;
  briefPath: string;
  aggregationPath: string;
  logPath: string;
  workDir: string;
}

/** Build a §D case dir with the full standard fixture. Cases
 * mutate files afterwards (delete a report, overwrite one with
 * invalid JSON) to build their hostile shape. */
function buildCase(name: string): CasePaths {
  const dir = path.join(WORKDIR, "cases", name);
  fs.rmSync(dir, { recursive: true, force: true });
  const reportsDir = path.join(dir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const rosterPath = path.join(dir, "roster.json");
  fs.writeFileSync(rosterPath, JSON.stringify(ROSTER, null, 2) + "\n");
  for (const entry of ROSTER) {
    fs.writeFileSync(
      path.join(reportsDir, `${entry.lead}-${DATE}.json`),
      JSON.stringify(reportFixture(entry.lead, DATE, TODAY_OVERRIDES[entry.lead] ?? {}), null, 2) + "\n",
    );
    fs.writeFileSync(
      path.join(reportsDir, `${entry.lead}-${YESTERDAY}.json`),
      JSON.stringify(reportFixture(entry.lead, YESTERDAY, PRIOR_OVERRIDES[entry.lead] ?? {}), null, 2) + "\n",
    );
  }
  const goalNotesPath = path.join(dir, "GOAL.md");
  fs.writeFileSync(goalNotesPath, GOAL_NOTES_FIXTURE);
  const ledgerPath = path.join(dir, "run-ledger.jsonl");
  fs.writeFileSync(ledgerPath, LEDGER_FIXTURE);
  const predictorRecordPath = path.join(dir, "predictor-record.md");
  fs.writeFileSync(predictorRecordPath, PREDICTOR_FIXTURE);
  const backlogPath = path.join(dir, "BACKLOG.md");
  fs.writeFileSync(backlogPath, BACKLOG_FIXTURE);
  const workDir = path.join(dir, "work");
  return {
    dir,
    reportsDir,
    rosterPath,
    goalNotesPath,
    ledgerPath,
    predictorRecordPath,
    backlogPath,
    briefPath: path.join(dir, "files", `${DATE}-exec-brief.html`),
    aggregationPath: path.join(dir, "aggregation.json"),
    logPath: path.join(dir, "aggregation.log"),
    workDir,
  };
}

/** The shared project config for §D cases (stateDir is the
 * test's engine state dir unless the case overrides it — D8
 * points project.stateDir at a scratch cancel-state dir). */
function testProject(stateDir: string, workDir: string): DailyBriefProjectConfig {
  return {
    linearProject: "P-BRA-2",
    repo: COPY_ROOT,
    stateDir,
    roster: Object.fromEntries(ROSTER.map((e) => [e.lead, e.chat_id])),
    thresholds: {},
    workDir,
    resumeDir: path.join(WORKDIR, "project-resume"),
  };
}

/** Build a daily-brief input for one case + phase. */
function caseInput(paths: CasePaths, phase: DailyBriefPhase, extra: Partial<DailyBriefRunInput> = {}): DailyBriefInput {
  return {
    project: testProject(STATE_DIR, paths.workDir),
    run: {
      phase,
      date: DATE,
      reportsDir: paths.reportsDir,
      rosterPath: paths.rosterPath,
      goalNotesPath: paths.goalNotesPath,
      ledgerPath: paths.ledgerPath,
      predictorRecordPath: paths.predictorRecordPath,
      backlogPath: paths.backlogPath,
      briefPath: paths.briefPath,
      aggregationPath: paths.aggregationPath,
      logPath: paths.logPath,
      deadlines: Object.fromEntries(ROSTER.map((e) => [e.lead, "06:00"])),
      ...extra,
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
  };
}

/** Minimal valid input (the §C base; cases mutate it). */
function validInput(): DailyBriefInput {
  return {
    project: testProject(STATE_DIR, path.join(WORKDIR, "valid-work")),
    run: {
      phase: "aggregate",
      date: DATE,
      reportsDir: path.join(WORKDIR, "valid-reports"),
      rosterPath: path.join(WORKDIR, "valid-roster.json"),
      goalNotesPath: path.join(WORKDIR, "valid-GOAL.md"),
      ledgerPath: path.join(WORKDIR, "valid-ledger.jsonl"),
      predictorRecordPath: path.join(WORKDIR, "valid-predictor.md"),
      backlogPath: path.join(WORKDIR, "valid-BACKLOG.md"),
      briefPath: path.join(WORKDIR, "valid-brief.html"),
      aggregationPath: path.join(WORKDIR, "valid-aggregation.json"),
      logPath: path.join(WORKDIR, "valid-aggregation.log"),
      deadlines: { implementation: "06:00" },
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
  };
}

/** A validated two-lead aggregation for §C (derive + render
 * checks share one fixture, so the render assertions match the
 * derivation assertions). */
function twoLeadAggregation(extra: { throughputSection?: ThroughputSection; throughputMissingReason?: string } = {}): Aggregation {
  const reports = new Map<string, LeadReport>();
  reports.set("implementation", {
    lead: "implementation",
    date: DATE,
    status: "Loop landed.",
    reflections: [],
    predictions: [{ claim: "The brief lands this week.", confidence: "high", horizon: "this week" }],
    solutions: [{ problem: "Tier-1 is slow.", proposal: "Resume it." }],
    needs_pm: ["Approve the scope change"],
    numbers: { tasksDone: 5 },
  });
  reports.set("quality", {
    lead: "quality",
    date: DATE,
    status: "Verified.",
    reflections: [],
    predictions: [],
    solutions: [],
    needs_pm: ["Confirm the leg"],
    numbers: { tasksDone: 3 },
  });
  const prior = new Map<string, LeadReport>();
  prior.set("implementation", {
    lead: "implementation",
    date: YESTERDAY,
    status: "Verifying.",
    reflections: [],
    predictions: [],
    solutions: [],
    needs_pm: [],
    numbers: { tasksDone: 3 },
  });
  return deriveAggregation({
    date: DATE,
    yesterday: YESTERDAY,
    roster: [
      { lead: "implementation", chat_id: "impl-chat" },
      { lead: "quality", chat_id: "quality-chat" },
    ],
    reports,
    priorReports: prior,
    missing: [],
    goalNotes: "The program is mid-flight.\n\n## Objectives\n",
    goalNotesTruncated: false,
    ledgerRuns: [{ runId: "loop-1", workflow: "lead-loop", status: "done" }],
    ledgerMissing: false,
    ledgerSkippedLines: 0,
    predictorRecord: "record",
    predictorMissing: false,
    backlogHeadings: ["BRA-300 Scheduler follow-up"],
    backlogMissing: false,
    ...(extra.throughputSection !== undefined ? { throughputSection: extra.throughputSection } : {}),
    ...(extra.throughputMissingReason !== undefined ? { throughputMissingReason: extra.throughputMissingReason } : {}),
  });
}

async function main(): Promise<number> {
  await startServer();
  try {
    // --------------------------------------------- §A inventory check
    console.log("\n=== §A inventory check ===");
    {
      const r = spawnSync(BUN, [path.join(ROOT, "scripts", "suite-inventory.ts"), "check"], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env },
      });
      check(r.status === 0, `INVENTORY OK: suite-inventory check exits 0 (got ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)})`);
      check(
        /inventory check passed: \d+ sections, run\.sh agrees/.test(r.stdout ?? ""),
        `INVENTORY OK: check prints the agreement line (got ${JSON.stringify((r.stdout ?? "").slice(0, 120))})`,
      );
    }

    // --------------------------------------------- §B agentts check
    console.log("\n=== §B agentts check ===");
    {
      const r = cli(["check", DAILY_BRIEF, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on daily-brief.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("dailyBrief(DailyBriefInput)"), `CHECK OK: entry is dailyBrief(DailyBriefInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure units
    console.log("\n=== §C pure units ===");
    {
      // ---- validateDailyBriefInput: valid + every guard.
      check(validateDailyBriefInput(validInput()).length === 0, "C OK: valid input passes validation");
      const noOwner = validInput();
      delete (noOwner as Record<string, any>).owner;
      check(
        validateDailyBriefInput(noOwner).some((e) => e === "daily-brief: input has no owner string — the owner is the driving session, never assumed from the launcher"),
        "C OK: absent owner refused with the exact string",
      );
      const emptyOwner = validInput();
      emptyOwner.owner = "";
      check(
        validateDailyBriefInput(emptyOwner).some((e) => e === "daily-brief: input has no owner string — the owner is the driving session, never assumed from the launcher"),
        "C OK: empty owner refused with the exact string",
      );
      const noRun = { project: testProject(STATE_DIR, path.join(WORKDIR, "x")), owner: IMPL_OWNER } as unknown as DailyBriefInput;
      check(validateDailyBriefInput(noRun).includes("daily-brief: input has no run object"), "C OK: missing run object refused");
      const badPhase = validInput();
      (badPhase.run as Record<string, any>).phase = "summarize";
      check(validateDailyBriefInput(badPhase).includes("daily-brief: run.phase must be prompt, aggregate, or brief"), "C OK: bad phase refused");
      const badDate = validInput();
      badDate.run.date = "2026-02-30";
      check(validateDailyBriefInput(badDate).includes("daily-brief: run.date must be a valid YYYY-MM-DD date"), "C OK: impossible date refused");
      const badDateShape = validInput();
      badDateShape.run.date = "2026-11-21 06:00";
      check(validateDailyBriefInput(badDateShape).includes("daily-brief: run.date must be a valid YYYY-MM-DD date"), "C OK: non-date shape refused");
      const noReportsDir = validInput();
      delete (noReportsDir.run as Record<string, any>).reportsDir;
      check(validateDailyBriefInput(noReportsDir).includes("daily-brief: run has no reportsDir string"), "C OK: missing reportsDir refused");
      const noDeadlines = validInput();
      delete (noDeadlines.run as Record<string, any>).deadlines;
      check(validateDailyBriefInput(noDeadlines).includes("daily-brief: run has no deadlines object"), "C OK: missing deadlines refused");
      const badDeadline = validInput();
      (badDeadline.run.deadlines as Record<string, any>).implementation = "";
      check(
        validateDailyBriefInput(badDeadline).includes("daily-brief: run.deadlines[implementation] is not a non-empty string"),
        "C OK: empty deadline refused",
      );
      const badMustKnow = validInput();
      (badMustKnow.run as Record<string, any>).mustKnow = 42;
      check(validateDailyBriefInput(badMustKnow).includes("daily-brief: run.mustKnow must be a string when present"), "C OK: non-string mustKnow refused");
      const badDryRun = validInput();
      (badDryRun.run as Record<string, any>).dryRun = "yes";
      check(validateDailyBriefInput(badDryRun).includes("daily-brief: run.dryRun must be a boolean when present"), "C OK: non-boolean dryRun refused");
      const badRunId = validInput();
      (badRunId.run as Record<string, any>).runId = 7;
      check(validateDailyBriefInput(badRunId).includes("daily-brief: run.runId must be a string when present"), "C OK: non-string runId refused");
      const noWorkDir = validInput();
      delete (noWorkDir.project as Record<string, any>).workDir;
      check(
        validateDailyBriefInput(noWorkDir).some((e) => e.includes("project has no workDir string")),
        "C OK: missing project workDir refused",
      );
      const noRoster = validInput();
      delete (noRoster.project as Record<string, any>).roster;
      check(validateDailyBriefInput(noRoster).includes("daily-brief: project has no roster object"), "C OK: missing project roster refused");
      const badThreshold = validInput();
      (badThreshold.project as Record<string, any>).thresholds = { maxLate: "soon" };
      check(
        validateDailyBriefInput(badThreshold).includes("daily-brief: project.thresholds[maxLate] must be a number"),
        "C OK: non-number threshold refused",
      );
      const notAnObject = validateDailyBriefInput("nope");
      check(notAnObject.includes("daily-brief: input is not an object"), "C OK: non-object input refused");

      // ---- isValidDateString / yesterdayOf.
      check(isValidDateString("2026-11-21"), "C OK: 2026-11-21 is a valid date");
      check(isValidDateString("2024-02-29"), "C OK: 2024-02-29 is valid (leap year)");
      check(!isValidDateString("2026-02-29"), "C OK: 2026-02-29 is invalid (not a leap year)");
      check(!isValidDateString("2026-11-31"), "C OK: 2026-11-31 is invalid");
      check(!isValidDateString("2026-11-21T00:00:00Z"), "C OK: timestamp shape is not a date");
      check(!isValidDateString("2026-1-5"), "C OK: unpadded date is invalid");
      check(yesterdayOf("2026-11-22") === "2026-11-21", "C OK: yesterday of 2026-11-22 is 2026-11-21");
      check(yesterdayOf("2026-03-01") === "2026-02-28", "C OK: yesterday of 2026-03-01 is 2026-02-28");
      check(yesterdayOf("2026-01-01") === "2025-12-31", "C OK: yesterday of 2026-01-01 is 2025-12-31");
      check(yesterdayOf("2024-03-01") === "2024-02-29", "C OK: yesterday of 2024-03-01 is 2024-02-29 (leap)");

      // ---- validateRoster.
      check(validateRoster(ROSTER).errors.length === 0 && validateRoster(ROSTER).roster.length === 6, "C OK: six-lead roster validates");
      check(validateRoster([]).errors.includes("daily-brief: roster is empty"), "C OK: empty roster refused");
      check(validateRoster({}).errors.includes("daily-brief: roster is not an array"), "C OK: non-array roster refused");
      check(
        validateRoster([...ROSTER, { lead: "quality", chat_id: "dup" }]).errors.some((e) => e.includes('roster lists lead "quality" twice')),
        "C OK: duplicate lead refused",
      );
      check(
        validateRoster([{ lead: "quality" }]).errors.some((e) => e.includes("has no chat_id string")),
        "C OK: roster entry without chat_id refused",
      );
      check(
        validateRoster(["quality"]).errors.some((e) => e.includes("is not an object")),
        "C OK: non-object roster entry refused",
      );

      // ---- validateLeadReport: absent optionals are empty, never
      // invalid; a wrong shape on a present field is invalid.
      const minimal = validateLeadReport({ lead: "quality", date: DATE }, "quality", DATE);
      check(minimal.valid === true, "C OK: minimal report (lead + date only) is VALID");
      if (minimal.valid) {
        check(
          minimal.report.status === "" && minimal.report.reflections.length === 0 && minimal.report.predictions.length === 0 &&
            minimal.report.solutions.length === 0 && minimal.report.needs_pm.length === 0 && Object.keys(minimal.report.numbers).length === 0,
          "C OK: absent optionals normalize to their empty shapes",
        );
      }
      const noNumbers = validateLeadReport({ lead: "quality", date: DATE, status: "ok" }, "quality", DATE);
      check(noNumbers.valid === true, "C OK: a JSON missing numbers is VALID (D9, pure half)");
      const noHorizon = validateLeadReport(
        { lead: "quality", date: DATE, predictions: [{ claim: "x", confidence: "high" }] },
        "quality",
        DATE,
      );
      check(
        !noHorizon.valid && noHorizon.reason === "predictions[0].horizon is not today, this week, or this release",
        `C OK: a prediction lacking horizon is invalid with the field named (got ${noHorizon.valid ? "valid" : (noHorizon as { reason: string }).reason})`,
      );
      const badConfidence = validateLeadReport(
        { lead: "quality", date: DATE, predictions: [{ claim: "x", confidence: "sure", horizon: "today" }] },
        "quality",
        DATE,
      );
      check(!badConfidence.valid && (badConfidence as { reason: string }).reason.includes("confidence"), "C OK: bad prediction confidence is invalid");
      const wrongDate = validateLeadReport({ lead: "quality", date: YESTERDAY }, "quality", DATE);
      check(!wrongDate.valid && (wrongDate as { reason: string }).reason.includes("does not match brief date"), "C OK: wrong-date report is invalid");
      const wrongLead = validateLeadReport({ lead: "landing", date: DATE }, "quality", DATE);
      check(!wrongLead.valid && (wrongLead as { reason: string }).reason.includes("does not match file lead"), "C OK: wrong-lead report is invalid");
      const noLead = validateLeadReport({ date: DATE }, "quality", DATE);
      check(!noLead.valid && (noLead as { reason: string }).reason === "lead field is missing", "C OK: missing lead field is invalid");
      const badStatus = validateLeadReport({ lead: "quality", date: DATE, status: 3 }, "quality", DATE);
      check(!badStatus.valid && (badStatus as { reason: string }).reason === "status field is not a string", "C OK: non-string status is invalid");
      const badNumbers = validateLeadReport({ lead: "quality", date: DATE, numbers: { tasksDone: "five" } }, "quality", DATE);
      check(!badNumbers.valid && (badNumbers as { reason: string }).reason.includes("is not a number"), "C OK: non-number numbers value is invalid");
      const badReportMustKnow = validateLeadReport({ lead: "quality", date: DATE, mustKnow: 5 }, "quality", DATE);
      check(!badReportMustKnow.valid && (badReportMustKnow as { reason: string }).reason === "mustKnow field is not a string", "C OK: non-string mustKnow is invalid");
      const badSolution = validateLeadReport(
        { lead: "quality", date: DATE, solutions: [{ problem: "p" }] },
        "quality",
        DATE,
      );
      check(!badSolution.valid && (badSolution as { reason: string }).reason.includes("proposal"), "C OK: solution without proposal is invalid");
      const badNeeds = validateLeadReport({ lead: "quality", date: DATE, needs_pm: "ask" }, "quality", DATE);
      check(!badNeeds.valid && (badNeeds as { reason: string }).reason.includes("needs_pm"), "C OK: non-array needs_pm is invalid");
      const notObject = validateLeadReport([1, 2], "quality", DATE);
      check(!notObject.valid && (notObject as { reason: string }).reason === "report is not a JSON object", "C OK: non-object report is invalid");
      const pmMustKnow = validateLeadReport({ lead: "program-management", date: DATE, mustKnow: "The thing." }, "program-management", DATE);
      check(pmMustKnow.valid === true && pmMustKnow.valid && pmMustKnow.report.mustKnow === "The thing.", "C OK: PM mustKnow is accepted");

      // ---- trendArrow / formatNumber.
      check(trendArrow(5, 3) === "↑", "C OK: trend up");
      check(trendArrow(2, 4) === "↓", "C OK: trend down");
      check(trendArrow(3, 3) === "→", "C OK: trend flat");
      check(trendArrow(5, null) === null, "C OK: no prior value, no arrow");
      check(formatNumber(5) === "5", "C OK: integer formats plain");
      check(formatNumber(1.5) === "1.5", "C OK: 1.5 formats as 1.5");
      check(formatNumber(1.234) === "1.23", "C OK: 1.234 formats to two decimals");

      // ---- firstParagraph / firstSentence / escapeHtml.
      check(
        firstParagraph("# Title\n\nFirst para line one.\nSecond line.\n\nSecond para.") === "First para line one. Second line.",
        "C OK: firstParagraph skips headings and stops at the blank line",
      );
      check(firstParagraph("# Only a heading\n") === "", "C OK: firstParagraph of heading-only text is empty");
      check(firstSentence("Hello world. More here.") === "Hello world.", "C OK: firstSentence stops at the first period");
      check(firstSentence("No punctuation here") === "No punctuation here", "C OK: firstSentence without punctuation returns the claim");
      check(escapeHtml('<a href="x">&\'') === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;", "C OK: escapeHtml escapes the five characters");

      // ---- deriveAggregation (two-lead fixture).
      const agg2 = twoLeadAggregation();
      check(
        JSON.stringify(agg2.decisionsNeeded) === JSON.stringify([
          { lead: "implementation", text: "Approve the scope change" },
          { lead: "quality", text: "Confirm the leg" },
        ]),
        `C OK: decisions in roster order, attributed (got ${JSON.stringify(agg2.decisionsNeeded)})`,
      );
      check(agg2.mustKnowSource === "derived" && agg2.mustKnow === "Approve the scope change (raised by implementation)", `C OK: must-know derived from the first decision (got ${agg2.mustKnowSource}: ${agg2.mustKnow})`);
      check(
        agg2.log.some((l) => l.includes("must-know derived from the first decisions-needed entry")),
        "C OK: log records the derived must-know",
      );
      check(
        JSON.stringify(agg2.risks) === JSON.stringify([{ lead: "implementation", problem: "Tier-1 is slow." }]),
        `C OK: risks are every solutions[].problem (got ${JSON.stringify(agg2.risks)})`,
      );
      const implSection = agg2.perLead.find((p) => p.lead === "implementation");
      check(
        implSection?.present === true && implSection.numbers.length === 1 && implSection.numbers[0].key === "tasksDone" &&
          implSection.numbers[0].value === 5 && implSection.numbers[0].arrow === "↑",
        `C OK: per-lead numbers carry the trend arrow (got ${JSON.stringify(implSection?.numbers)})`,
      );
      const qaSection = agg2.perLead.find((p) => p.lead === "quality");
      check(qaSection?.numbers[0].arrow === null, "C OK: no prior-day value, no arrow");
      check(agg2.directorReport.overallState === "The program is mid-flight.", `C OK: overall state is the goal notes' first paragraph (got ${agg2.directorReport.overallState})`);
      check(
        agg2.directorReport.whatChanged.some((c) => c === "run loop-1 (lead-loop) done") &&
          agg2.directorReport.whatChanged.some((c) => c === `implementation status changed since ${YESTERDAY}`),
        `C OK: what changed lists ledger runs + status changes (got ${JSON.stringify(agg2.directorReport.whatChanged)})`,
      );
      check(
        agg2.directorReport.whatIsNext.some((n) => n === "backlog: BRA-300 Scheduler follow-up") &&
          agg2.directorReport.whatIsNext.some((n) => n === "implementation predicts: The brief lands this week. (high, this week)"),
        `C OK: what is next lists backlog headings + predictions (got ${JSON.stringify(agg2.directorReport.whatIsNext)})`,
      );
      check(agg2.receipt === "2 of 2 lead reports received. No report missing.", `C OK: receipt for all present (got ${agg2.receipt})`);
      check(
        JSON.stringify(agg2).includes("Tier-1 is slow.") && !JSON.stringify(agg2).includes("reflections"),
        "C OK: aggregation carries risks but never the raw report JSON",
      );
      // Director-supplied must-know beats the PM's; the PM's beats
      // derivation; a non-PM mustKnow is ignored and logged.
      const withDirector = deriveAggregation({
        date: DATE, yesterday: YESTERDAY,
        roster: [{ lead: "program-management", chat_id: "pm" }],
        reports: new Map([["program-management", { lead: "program-management", date: DATE, status: "", reflections: [], predictions: [], solutions: [], needs_pm: ["Do this"], numbers: {}, mustKnow: "PM says." }]]),
        priorReports: new Map(), missing: [], goalNotes: null, goalNotesTruncated: false,
        ledgerRuns: [], ledgerMissing: true, ledgerSkippedLines: 0, predictorRecord: null, predictorMissing: true,
        backlogHeadings: [], backlogMissing: true, directorMustKnow: "Director says.",
      });
      check(withDirector.mustKnow === "Director says." && withDirector.mustKnowSource === "director", "C OK: Director-supplied must-know wins");
      const withPm = deriveAggregation({
        date: DATE, yesterday: YESTERDAY,
        roster: [{ lead: "program-management", chat_id: "pm" }],
        reports: new Map([["program-management", { lead: "program-management", date: DATE, status: "", reflections: [], predictions: [], solutions: [], needs_pm: ["Do this"], numbers: {}, mustKnow: "PM says." }]]),
        priorReports: new Map(), missing: [], goalNotes: null, goalNotesTruncated: false,
        ledgerRuns: [], ledgerMissing: true, ledgerSkippedLines: 0, predictorRecord: null, predictorMissing: true,
        backlogHeadings: [], backlogMissing: true,
      });
      check(withPm.mustKnow === "PM says." && withPm.mustKnowSource === "pm", "C OK: PM mustKnow wins over derivation");
      const withIgnored = deriveAggregation({
        date: DATE, yesterday: YESTERDAY,
        roster: [
          { lead: "implementation", chat_id: "i" },
          { lead: "program-management", chat_id: "p" },
        ],
        reports: new Map([
          ["implementation", { lead: "implementation", date: DATE, status: "", reflections: [], predictions: [], solutions: [], needs_pm: [], numbers: {}, mustKnow: "Impl says." }],
        ]),
        priorReports: new Map(), missing: [{ lead: "program-management", reason: "report file not found" }],
        goalNotes: null, goalNotesTruncated: false,
        ledgerRuns: [], ledgerMissing: true, ledgerSkippedLines: 0, predictorRecord: null, predictorMissing: true,
        backlogHeadings: [], backlogMissing: true,
      });
      check(
        withIgnored.mustKnow === "No decisions needed today." && withIgnored.mustKnowSource === "derived" &&
          withIgnored.log.some((l) => l.includes("mustKnow present on implementation report, ignored")),
        "C OK: non-PM mustKnow is ignored and logged",
      );
      check(withIgnored.receipt === "1 of 2 lead reports received. Missing: program-management.", `C OK: receipt names the missing lead (got ${withIgnored.receipt})`);
      check(
        withIgnored.directorReport.overallState === "Goal notes unavailable — overall state not derived." &&
          withIgnored.directorReport.whatChanged[0] === `No ledger runs and no status changes since ${YESTERDAY}.` &&
          withIgnored.directorReport.whatIsNext[0] === "No open backlog items or predictions recorded.",
        "C OK: Director's report falls back cleanly when every state input is missing",
      );

      // ---- trap-script builders + parsers (shapes, not live runs).
      const readScript = readFileScript("/tmp/x.json", DAILY_BRIEF_REPORT_MAX_BYTES);
      check(readScript.includes("/tmp/x.json") && readScript.includes(String(DAILY_BRIEF_REPORT_MAX_BYTES)), "C OK: read script carries the path and the bound");
      check(readScript.includes("READ-MISSING") && readScript.includes("READ-ERROR"), "C OK: read script has the missing (2) and error (1) exits");
      const parsed = parseReadOutput("READ 5 5\nhello");
      check(parsed.total === 5 && parsed.printed === 5 && parsed.content === "hello", "C OK: READ line parses");
      let threw = false;
      try { parseReadOutput("garbage\n"); } catch { threw = true; }
      check(threw, "C OK: malformed READ output throws loudly");
      const tailScript = ledgerTailScript("/tmp/ledger.jsonl", 20);
      check(tailScript.includes("/tmp/ledger.jsonl") && tailScript.includes("TAIL-MISSING"), "C OK: ledger tail script carries the path and the missing exit");
      const tail = parseLedgerTail('TAIL 3\n{"runId":"a","workflow":"w","status":"done"}\nnot json\n{"runId":"b","status":"failed"}\n');
      check(tail.runs.length === 2 && tail.skipped === 1 && tail.runs[0].runId === "a" && tail.runs[1].workflow === "", "C OK: ledger tail parses runs and counts the skipped line");
      threw = false;
      try { parseLedgerTail("nope\n"); } catch { threw = true; }
      check(threw, "C OK: malformed TAIL output throws loudly");
      const headingsScript = backlogHeadingsScript("/tmp/BACKLOG.md", 10);
      check(headingsScript.includes("/tmp/BACKLOG.md") && headingsScript.includes("HEADINGS-MISSING"), "C OK: backlog headings script carries the path and the missing exit");
      check(JSON.stringify(parseBacklogHeadings("HEADINGS 2\nAlpha\nBeta\n")) === JSON.stringify(["Alpha", "Beta"]), "C OK: HEADINGS lines parse");
      threw = false;
      try { parseBacklogHeadings("nope\n"); } catch { threw = true; }
      check(threw, "C OK: malformed HEADINGS output throws loudly");
      const chunk0 = chunkWriteScript("QUJD", 0, "/tmp/t.tmp");
      check(chunk0.includes(": > ") && chunk0.includes("CHUNK 0"), "C OK: chunk 0 truncates the temp file and prints CHUNK 0");
      const chunk1 = chunkWriteScript("REVG", 1, "/tmp/t.tmp");
      check(!chunk1.includes(": > ") && chunk1.includes("CHUNK 1"), "C OK: chunk 1 appends and prints CHUNK 1");
      const finJson = finalizeWriteScript("/tmp/t.tmp", "/tmp/out.json", "json");
      check(finJson.includes("WROTE") && finJson.includes("json.load") && finJson.includes("mv "), "C OK: finalize (json) renames, verifies JSON, prints WROTE");
      const finHtml = finalizeWriteScript("/tmp/t.tmp", "/tmp/out.html", "html");
      check(finHtml.includes("</html>"), "C OK: finalize (html) verifies the closing tag");
      const finText = finalizeWriteScript("/tmp/t.tmp", "/tmp/out.log", "text");
      check(finText.includes("[ -s "), "C OK: finalize (text) verifies non-empty");

      // ---- renderBriefHtml (structure, not pixels).
      const html = renderBriefHtml(agg2);
      check(html.includes("The thing you most need to know") && html.includes("Approve the scope change (raised by implementation)"), "C OK: HTML carries the must-know box");
      check(html.indexOf("Decisions needed") < html.indexOf("Per-lead status"), "C OK: decisions box sits above the per-lead sections");
      check(html.includes("2 / 2") && html.includes("decisions needed"), "C OK: KPI bar carries the counts");
      check(html.includes("Loop landed.") && html.includes("tasksDone") && html.includes("↑"), "C OK: per-lead status + numbers + arrow render");
      check(html.includes("Risks") && html.includes("Tier-1 is slow."), "C OK: risks render");
      check(html.includes("The Director's own report") && html.includes("The program is mid-flight."), "C OK: Director's own report renders");
      check(html.includes("Sources: lead daily reports"), "C OK: footer names the sources");
      const htmlMissing = renderBriefHtml(withIgnored);
      check(htmlMissing.includes("Missing reports") && htmlMissing.includes("program-management"), "C OK: missing-lead sections render when a report is missing");

      // ---- Throughput: deriveAggregation carries the section (or
      // the missing reason), renderBriefHtml renders the card only
      // when the section is present, validateAggregation checks the
      // section's shape (the known Low at BACKLOG.md line 429 is
      // hardened for the new field only).
      const tSection = throughputSectionFixture();
      const aggT = twoLeadAggregation({ throughputSection: tSection });
      check(aggT.throughput !== undefined && aggT.throughput.tasksCompleted === 2 && aggT.throughput.landings === 2, `C OK: aggregation carries the throughput section (got ${JSON.stringify(aggT.throughput)})`);
      check(
        aggT.log.some((l) => l.includes("throughput report read — 2 completed, 2 landings, 1 stalled step(s), 0 missing source(s)")),
        "C OK: log records the throughput read",
      );
      const aggTMissing = twoLeadAggregation({ throughputMissingReason: "throughput report file not found" });
      check(aggTMissing.throughput === undefined, "C OK: a missing throughput report leaves no section on the aggregation");
      check(
        aggTMissing.log.some((l) => l.includes("throughput report missing: throughput report file not found — the brief renders without the throughput section")),
        "C OK: log records the missing throughput report with the reason named",
      );
      const htmlT = renderBriefHtml(aggT);
      check(htmlT.includes("Throughput (2026-11-21, 1-day window)") && htmlT.includes("<b>2</b> tasks completed"), "C OK: Throughput card renders the window and the counts");
      check(htmlT.includes("Median pickup-to-landed: <b>4 h</b>") && htmlT.includes("median verify: <b>1.3 h</b>"), "C OK: card renders the medians");
      check(htmlT.includes("Cost of a kill: <b>20 min</b> · 5000 tokens"), "C OK: card renders the cost of a kill");
      check(htmlT.includes("BRA-303 (ready, 8 h)"), "C OK: card renders the stalled step");
      check(!html.includes("Throughput ("), "C OK: no Throughput card without a section");
      const aggDown = twoLeadAggregation({ throughputSection: throughputSectionFixture(true) });
      check(renderBriefHtml(aggDown).includes("Machine down"), "C OK: card names MACHINE DOWN when the machine is down");
      check(validateAggregation(aggT, DATE) === null, "C OK: aggregation with a valid throughput section validates");
      check(validateAggregation({ ...aggT, throughput: { ...tSection, tasksCompleted: "two" } }, DATE) !== null, "C OK: throughput with a non-number tasksCompleted is rejected");
      check(validateAggregation({ ...aggT, throughput: { ...tSection, stalled: "none" } }, DATE) !== null, "C OK: throughput with a non-array stalled is rejected");

      // ---- buildPromptPayloads.
      const payloads = buildPromptPayloads({
        roster: [
          { lead: "implementation", chat_id: "impl-chat" },
          { lead: "quality", chat_id: "quality-chat" },
        ],
        date: DATE,
        reportsDir: "/proj/reports",
        deadlines: { implementation: "06:00" },
      });
      check(payloads.length === 2 && payloads[0].lead === "implementation" && payloads[0].chatId === "impl-chat", "C OK: one payload per roster lead, right chat id");
      check(payloads[0].message.includes("06:00") && payloads[0].message.includes("/proj/reports/implementation-2026-11-21.json"), "C OK: payload names the deadline and the reports-dir path");
      check(payloads[1].message.includes("06:00"), "C OK: payload falls back to 06:00 when no deadline is set for the lead");
      check(payloads[0].message.includes("never nothing"), "C OK: payload tells a lead with nothing to say to write empty lists, never nothing");

      // ---- validateAggregation.
      check(validateAggregation(agg2, DATE) === null, "C OK: well-formed aggregation validates");
      check(validateAggregation({ ...agg2, date: YESTERDAY }, DATE) !== null, "C OK: wrong-date aggregation is rejected");
      check(validateAggregation({ ...agg2, receipt: 5 }, DATE) !== null, "C OK: non-string receipt is rejected");
      check(validateAggregation("nope", DATE) !== null, "C OK: non-object aggregation is rejected");

      // ---- buildDailyBriefReport.
      const rep = buildDailyBriefReport({
        briefId: "daily-brief-2026-11-21",
        verdict: "dry-run",
        dryRun: true,
        owner: IMPL_OWNER,
        cancelChecked: false,
        cancelled: false,
        phase: "aggregate",
        date: DATE,
        missing: [],
        extraNotes: ["planned"],
      });
      check(rep.verdict === "dry-run" && rep.dryRun === true && rep.knownLimit === DAILY_BRIEF_KNOWN_LIMIT && rep.notes.includes("planned"), "C OK: report builder carries the verdict, dry-run flag, known limit and notes");
      check(typeof dailyBrief === "function", "C OK: the default export is the dailyBrief entry function");
    }

    // --------------------------------------------- §D live runs
    console.log("\n=== §D live runs ===");

    // ---- D1 prompt: one payload per roster lead, right chat id,
    // 06:00 deadline named, reports-dir path named; nothing
    // written, nothing sent.
    {
      const c = buildCase("D1-prompt");
      const out = driveBrief("brief-d1", caseInput(c, "prompt"));
      if (out) {
        check(out.verdict === "prompted", `D1 OK: verdict prompted (got ${out.verdict})`);
        check(Array.isArray(out.promptPayloads) && out.promptPayloads.length === 6, `D1 OK: one payload per roster lead (got ${out.promptPayloads?.length})`);
        const byLead = Object.fromEntries((out.promptPayloads as any[]).map((p: any) => [p.lead, p]));
        check(
          ROSTER.every((e) => byLead[e.lead]?.chatId === e.chat_id),
          "D1 OK: every payload carries its lead's roster chat id",
        );
        check(
          (out.promptPayloads as any[]).every((p: any) => p.message.includes("06:00") && p.message.includes(c.reportsDir) && p.message.includes(`-${DATE}.json`)),
          "D1 OK: every payload names the 06:00 deadline and the reports-dir path",
        );
        check(!fs.existsSync(c.aggregationPath) && !fs.existsSync(c.logPath) && !fs.existsSync(c.briefPath), "D1 OK: prompt writes nothing");
        check(out.deliveryPayload === undefined && out.aggregationPath === undefined, "D1 OK: prompt returns payloads in the report — nothing sent, nothing staged");
      }
    }

    // ---- D2 aggregate, all six present.
    {
      const c = buildCase("D2-aggregate");
      const out = driveBrief("brief-d2a", caseInput(c, "aggregate"));
      if (out) {
        check(out.verdict === "aggregated", `D2 OK: verdict aggregated (got ${out.verdict})`);
        const agg = readJson(c.aggregationPath);
        check(agg !== null, "D2 OK: aggregation file written");
        if (agg !== null) {
          check(
            JSON.stringify(agg.decisionsNeeded) === JSON.stringify([
              { lead: "quality", text: "Confirm the Quality acceptance leg for BRA-274" },
              { lead: "fleet-ops", text: "Decide whether the scheduler lands before dispatch" },
              { lead: "implementation", text: "Approve the daily-brief scope change" },
              { lead: "knowledge", text: "Pick the next learning-loop topic" },
            ]),
            `D2 OK: decisions in roster order, attributed (got ${JSON.stringify(agg.decisionsNeeded)})`,
          );
          check(agg.mustKnowSource === "pm" && agg.mustKnow === "The daily brief is the next CPU component; nothing else lands before it.", `D2 OK: must-know comes from the PM report (got ${agg.mustKnowSource})`);
          check(
            JSON.stringify(agg.risks) === JSON.stringify([
              { lead: "quality", problem: "Two unfiled fileFirst items lose all but the last reason" },
              { lead: "fleet-ops", problem: "fleet-ops problem: a slow step in the loop." },
              { lead: "program-management", problem: "program-management problem: a slow step in the loop." },
              { lead: "implementation", problem: "Tier-1 runs exceed the background wall-clock cap" },
              { lead: "landing", problem: "landing problem: a slow step in the loop." },
              { lead: "knowledge", problem: "knowledge problem: a slow step in the loop." },
            ]),
            `D2 OK: risks are every solutions[].problem in roster order (got ${JSON.stringify(agg.risks)})`,
          );
          const impl = (agg.perLead as any[]).find((p: any) => p.lead === "implementation");
          check(
            impl?.present === true && JSON.stringify(impl.numbers) === JSON.stringify([
              { key: "landings", value: 1, arrow: "↑" },
              { key: "tasksDone", value: 5, arrow: "↑" },
            ]),
            `D2 OK: implementation numbers carry trend arrows vs the prior day (got ${JSON.stringify(impl?.numbers)})`,
          );
          const quality = (agg.perLead as any[]).find((p: any) => p.lead === "quality");
          check(
            JSON.stringify(quality.numbers) === JSON.stringify([
              { key: "bugsFiled", value: 2, arrow: "↓" },
              { key: "tasksDone", value: 3, arrow: "→" },
            ]),
            `D2 OK: quality numbers carry a down and a flat arrow (got ${JSON.stringify(quality?.numbers)})`,
          );
          check(
            !JSON.stringify(agg).includes("never pasted into the brief"),
            "D2 OK: no reflection text (no raw JSON) reaches the aggregation",
          );
          check(
            agg.directorReport.overallState === "The CPU-first program is mid-flight: seven of eleven components stand, and the daily brief is next. The release is on track.",
            `D2 OK: Director's overall state is the goal notes' first paragraph (got ${agg.directorReport.overallState})`,
          );
          check(
            (agg.directorReport.whatChanged as string[]).some((x) => x === "run landing-land-1 (merge) done") &&
              (agg.directorReport.whatChanged as string[]).some((x) => x === `implementation status changed since ${YESTERDAY}`),
            `D2 OK: what changed lists ledger runs + status changes (got ${JSON.stringify(agg.directorReport.whatChanged)})`,
          );
          check(
            (agg.directorReport.whatIsNext as string[]).some((x) => x === "backlog: BRA-300 Scheduler follow-up") &&
              (agg.directorReport.whatIsNext as string[]).some((x) => x === "quality predicts: quality will finish its queue this week. (high, this week)"),
            `D2 OK: what is next lists backlog headings + predictions (got ${JSON.stringify(agg.directorReport.whatIsNext)})`,
          );
          check(agg.receipt === "6 of 6 lead reports received. No report missing.", `D2 OK: receipt for all present (got ${agg.receipt})`);
          const log = read(c.logPath) ?? "";
          check(
            log.includes("read " + c.rosterPath) &&
              ROSTER.every((e) => log.includes("read " + path.join(c.reportsDir, `${e.lead}-${DATE}.json`))) &&
              ROSTER.every((e) => log.includes("read " + path.join(c.reportsDir, `${e.lead}-${YESTERDAY}.json`))) &&
              log.includes("read " + c.goalNotesPath) && log.includes("read " + c.ledgerPath) &&
              log.includes("read " + c.predictorRecordPath) && log.includes("read " + c.backlogPath),
            "D2 OK: aggregation log lists every file read",
          );
          check(log.includes("predictor record read as part of the PM's state — nothing scored"), "D2 OK: log records the predictor record was read, not scored");
        }
        check(out.decisionsNeeded === 4 && out.risks === 6, `D2 OK: report counts 4 decisions and 6 risks (got ${out.decisionsNeeded}/${out.risks})`);
      }
      // D2b: the PM carries no mustKnow and the Director supplies
      // none — the must-know is derived from the first decision
      // and the log records that it was derived.
      const c2 = buildCase("D2b-derived");
      const pmPath = path.join(c2.reportsDir, `program-management-${DATE}.json`);
      const pm = readJson(pmPath) as Record<string, any>;
      delete pm.mustKnow;
      fs.writeFileSync(pmPath, JSON.stringify(pm, null, 2) + "\n");
      const out2 = driveBrief("brief-d2b", caseInput(c2, "aggregate"));
      if (out2) {
        const agg2 = readJson(c2.aggregationPath);
        check(
          agg2 !== null && agg2.mustKnowSource === "derived" &&
            agg2.mustKnow === "Confirm the Quality acceptance leg for BRA-274 (raised by quality)",
          `D2 OK: must-know derived from the first decision when none is authored (got ${agg2?.mustKnowSource}: ${agg2?.mustKnow})`,
        );
        const log2 = read(c2.logPath) ?? "";
        check(log2.includes("must-know derived from the first decisions-needed entry"), "D2 OK: log records the derived must-know");
      }
    }

    // ---- D3 aggregate, one lead missing + one invalid.
    {
      const c = buildCase("D3-missing-invalid");
      fs.rmSync(path.join(c.reportsDir, `knowledge-${DATE}.json`));
      const landing = readJson(path.join(c.reportsDir, `landing-${DATE}.json`)) as Record<string, any>;
      landing.predictions = [{ claim: "Landing will merge fast.", confidence: "high" }];
      fs.writeFileSync(path.join(c.reportsDir, `landing-${DATE}.json`), JSON.stringify(landing, null, 2) + "\n");
      const out = driveBrief("brief-d3", caseInput(c, "aggregate"));
      if (out) {
        check(out.verdict === "aggregated", `D3 OK: verdict aggregated despite a missing + an invalid report (got ${out.verdict})`);
        const agg = readJson(c.aggregationPath);
        check(agg !== null, "D3 OK: aggregation still written");
        if (agg !== null) {
          const missing = agg.missing as MissingLead[];
          check(missing.length === 2, `D3 OK: two leads missing (got ${missing.length})`);
          const knowledge = missing.find((m) => m.lead === "knowledge");
          check(knowledge !== undefined && knowledge.reason.includes("report file not found"), `D3 OK: knowledge noted missing with the reason (got ${knowledge?.reason})`);
          const lbrMissing = missing.find((m) => m.lead === "landing");
          check(
            lbrMissing !== undefined && lbrMissing.reason.includes("predictions[0].horizon"),
            `D3 OK: landing recorded missing with the failing field named (got ${lbrMissing?.reason})`,
          );
          check(
            agg.receipt === "4 of 6 lead reports received. Missing: landing, knowledge.",
            `D3 OK: receipt names the missing leads (got ${agg.receipt})`,
          );
          check(
            (agg.perLead as any[]).find((p: any) => p.lead === "knowledge")?.present === false &&
              (agg.perLead as any[]).find((p: any) => p.lead === "landing")?.present === false,
            "D3 OK: missing leads are present:false in the per-lead sections",
          );
        }
      }
    }

    // ---- D4 aggregate, PM report missing.
    {
      const c = buildCase("D4-pm-missing");
      fs.rmSync(path.join(c.reportsDir, `program-management-${DATE}.json`));
      const out = driveBrief("brief-d4", caseInput(c, "aggregate"));
      if (out) {
        check(out.verdict === "aggregated", `D4 OK: verdict aggregated with the PM report missing (got ${out.verdict})`);
        const agg = readJson(c.aggregationPath);
        check(agg !== null, "D4 OK: aggregation still written");
        if (agg !== null) {
          check(
            agg.mustKnowSource === "derived" && agg.mustKnow === "Confirm the Quality acceptance leg for BRA-274 (raised by quality)",
            `D4 OK: must-know falls back to the first decision (got ${agg.mustKnowSource}: ${agg.mustKnow})`,
          );
          const log = read(c.logPath) ?? "";
          check(log.includes("must-know derived from the first decisions-needed entry"), "D4 OK: log records the derived must-know");
          const pm = (agg.missing as MissingLead[]).find((m) => m.lead === "program-management");
          check(pm !== undefined && pm.reason.includes("report file not found"), `D4 OK: brief notes the PM report missing (got ${pm?.reason})`);
          check(agg.receipt === "5 of 6 lead reports received. Missing: program-management.", `D4 OK: receipt names the PM report missing (got ${agg.receipt})`);
        }
      }
    }

    // ---- D5 brief from a fixture aggregation (the cross-shift
    // shape: the brief phase reads a prior run's aggregation).
    {
      const c = buildCase("D5-brief");
      const aggFixture = twoLeadAggregation();
      (aggFixture as Aggregation).missing = [{ lead: "knowledge", reason: "report file not found: /nowhere/knowledge-2026-11-21.json" }];
      (aggFixture as Aggregation).perLead.push({ lead: "knowledge", present: false, status: "", numbers: [] });
      (aggFixture as Aggregation).receipt = "2 of 3 lead reports received. Missing: knowledge.";
      fs.writeFileSync(c.aggregationPath, JSON.stringify(aggFixture, null, 2) + "\n");
      const out = driveBrief("brief-d5", caseInput(c, "brief"));
      if (out) {
        check(out.verdict === "briefed", `D5 OK: verdict briefed (got ${out.verdict})`);
        const html = read(c.briefPath);
        check(html !== null && html.includes("</html>"), "D5 OK: dated HTML written");
        if (html !== null) {
          check(html.includes("The thing you most need to know") && html.includes("Approve the scope change (raised by implementation)"), "D5 OK: must-know line renders");
          check(html.indexOf("Decisions needed") < html.indexOf("Per-lead status"), "D5 OK: decisions box sits up top");
          check(html.includes("Risks") && html.includes("Tier-1 is slow."), "D5 OK: risks render");
          check(html.includes("Loop landed.") && html.includes("Verified."), "D5 OK: per-lead sections render");
          check(html.includes("The Director's own report") && html.includes("The program is mid-flight."), "D5 OK: Director's report renders");
          check(html.includes("Missing reports") && html.includes("knowledge"), "D5 OK: missing-lead sections render");
          check(html.includes(DATE), "D5 OK: HTML is dated");
        }
        check(
          out.deliveryPayload?.briefPath === c.briefPath && out.deliveryPayload?.mustKnow === aggFixture.mustKnow,
          `D5 OK: report carries the delivery payload (got ${JSON.stringify(out.deliveryPayload)})`,
        );
      }
      // Missing aggregation refuses loudly.
      const cMiss = buildCase("D5b-missing-agg");
      const outMiss = driveBrief("brief-d5b", caseInput(cMiss, "brief"));
      if (outMiss) {
        check(outMiss.verdict === "failed", `D5 OK: missing aggregation refuses (got ${outMiss.verdict})`);
        check((outMiss.notes as string[]).some((n) => n.includes("aggregation not found")), `D5 OK: refusal names the missing aggregation (got ${JSON.stringify(outMiss.notes)})`);
        check(!fs.existsSync(cMiss.briefPath), "D5 OK: nothing written on the missing-aggregation refusal");
      }
      // Wrong-date aggregation refuses loudly.
      const cWrong = buildCase("D5c-wrong-date");
      const wrongAgg = { ...twoLeadAggregation(), date: YESTERDAY };
      fs.writeFileSync(cWrong.aggregationPath, JSON.stringify(wrongAgg, null, 2) + "\n");
      const outWrong = driveBrief("brief-d5c", caseInput(cWrong, "brief"));
      if (outWrong) {
        check(outWrong.verdict === "failed", `D5 OK: wrong-date aggregation refuses (got ${outWrong.verdict})`);
        check((outWrong.notes as string[]).some((n) => n.includes("does not match brief date")), `D5 OK: refusal names the date mismatch (got ${JSON.stringify(outWrong.notes)})`);
        check(!fs.existsSync(cWrong.briefPath), "D5 OK: nothing written on the wrong-date refusal");
      }
    }

    // ---- D6 full sequence prompt → aggregate → brief.
    {
      const c = buildCase("D6-sequence");
      const pOut = driveBrief("brief-d6-prompt", caseInput(c, "prompt"));
      if (pOut) check(pOut.verdict === "prompted" && (pOut.promptPayloads as any[]).length === 6, "D6 OK: prompt phase completes with six payloads");
      const aOut = driveBrief("brief-d6-aggregate", caseInput(c, "aggregate"));
      if (aOut) check(aOut.verdict === "aggregated", `D6 OK: aggregate phase completes (got ${aOut?.verdict})`);
      const bOut = driveBrief("brief-d6-brief", caseInput(c, "brief"));
      if (bOut) {
        check(bOut.verdict === "briefed", `D6 OK: brief phase completes (got ${bOut.verdict})`);
        const html = read(c.briefPath);
        check(html !== null && html.includes("</html>") && html.includes("The daily brief is the next CPU component"), "D6 OK: dated HTML written with the PM-authored must-know");
        const log = read(c.logPath) ?? "";
        check(
          log.includes("read " + c.rosterPath) && log.includes("read " + c.ledgerPath) && log.includes("read " + c.backlogPath) &&
            ROSTER.every((e) => log.includes("read " + path.join(c.reportsDir, `${e.lead}-${DATE}.json`))),
          "D6 OK: aggregation log is complete",
        );
        check(
          bOut.deliveryPayload?.briefPath === c.briefPath &&
            bOut.deliveryPayload?.mustKnow === "The daily brief is the next CPU component; nothing else lands before it.",
          `D6 OK: brief phase's report carries the delivery payload (got ${JSON.stringify(bOut.deliveryPayload)})`,
        );
        check(bOut.decisionsNeeded === 4 && bOut.risks === 6, `D6 OK: brief report counts 4 decisions and 6 risks (got ${bOut.decisionsNeeded}/${bOut.risks})`);
      }
    }

    // ---- D7 dry-run: all three phases write nothing.
    {
      const c = buildCase("D7-dryrun");
      const pOut = driveBrief("brief-d7-prompt", caseInput(c, "prompt", { dryRun: true }));
      if (pOut) {
        check(pOut.verdict === "dry-run" && pOut.dryRun === true, `D7 OK: prompt dry-run verdict (got ${pOut.verdict})`);
        check((pOut.promptPayloads as any[]).length === 6, "D7 OK: prompt dry-run still lists the six payloads");
      }
      const aOut = driveBrief("brief-d7-aggregate", caseInput(c, "aggregate", { dryRun: true }));
      if (aOut) {
        check(aOut.verdict === "dry-run", `D7 OK: aggregate dry-run verdict (got ${aOut.verdict})`);
        check((aOut.notes as string[]).some((n) => n.includes("would read")), "D7 OK: aggregate dry-run lists the files it would read");
      }
      // The brief dry-run plans from a real aggregation (the
      // cross-shift shape) but still writes no HTML.
      fs.writeFileSync(c.aggregationPath, JSON.stringify(twoLeadAggregation(), null, 2) + "\n");
      const bOut = driveBrief("brief-d7-brief", caseInput(c, "brief", { dryRun: true }));
      if (bOut) {
        check(bOut.verdict === "dry-run", `D7 OK: brief dry-run verdict (got ${bOut.verdict})`);
        check((bOut.notes as string[]).some((n) => n.includes("would write")), "D7 OK: brief dry-run lists the HTML it would write");
      }
      check(!fs.existsSync(c.logPath) && !fs.existsSync(c.briefPath), "D7 OK: dry-run writes no log and no HTML across all three phases (the fixture aggregation is a test input, not a workflow output)");
    }

    // ---- D8 cancel: cancelled runId refuses with cancelChecked
    // true, writes nothing (bra210a case-H shape).
    {
      const c = buildCase("D8-cancel");
      const cancelStateDir = path.join(c.dir, "cancel-state");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(cancelStateDir, "queue.json"),
        JSON.stringify([{ runId: "brief-d8", status: "cancelled" }]),
      );
      const input = caseInput(c, "aggregate", { runId: "brief-d8" });
      input.project.stateDir = cancelStateDir;
      const out = driveBrief("brief-d8", input);
      if (out) {
        check(out.verdict === "failed", `D8 OK: verdict failed for the cancelled run (got ${out.verdict})`);
        check(out.cancelChecked === true && out.cancelled === true, `D8 OK: cancelChecked true + cancelled true (got ${out.cancelChecked}/${out.cancelled})`);
        check((out.notes as string[]).some((n) => n.includes("is cancelled")), `D8 OK: refusal names the cancellation (got ${JSON.stringify(out.notes)})`);
        check(!fs.existsSync(c.aggregationPath) && !fs.existsSync(c.logPath), "D8 OK: cancelled run writes nothing");
      }
    }

    // ---- D10 throughput present: the aggregate carries the
    // section, the brief renders the Throughput card.
    {
      const c = buildCase("D10-throughput-present");
      const throughputPath = path.join(c.dir, "throughput-2026-11-21.json");
      fs.writeFileSync(throughputPath, JSON.stringify(throughputReportFileFixture(), null, 2) + "\n");
      const out = driveBrief("brief-d10a", caseInput(c, "aggregate", { throughputReportPath: throughputPath }));
      if (out) {
        check(out.verdict === "aggregated", `D10 OK: verdict aggregated (got ${out.verdict})`);
        const agg = readJson(c.aggregationPath);
        check(agg !== null && agg.throughput !== undefined && agg.throughput.tasksCompleted === 2 && agg.throughput.landings === 2, `D10 OK: aggregation carries the throughput section (got ${JSON.stringify(agg?.throughput)})`);
        const log = read(c.logPath) ?? "";
        check(log.includes("throughput report read — 2 completed, 2 landings, 1 stalled step(s), 0 missing source(s)"), "D10 OK: log records the throughput read");
        check(log.includes("read " + throughputPath), "D10 OK: log lists the throughput report among the files read");
      }
      const bOut = driveBrief("brief-d10b", caseInput(c, "brief"));
      if (bOut) {
        check(bOut.verdict === "briefed", `D10 OK: brief verdict briefed (got ${bOut.verdict})`);
        const html = read(c.briefPath) ?? "";
        check(html.includes("Throughput (2026-11-21, 1-day window)"), "D10 OK: brief renders the Throughput card");
        check(html.includes("<b>2</b> tasks completed"), "D10 OK: card carries the counts");
        check(html.includes("BRA-303 (ready, 8 h)"), "D10 OK: card carries the stalled step");
      }
    }

    // ---- D11 throughput absent: the aggregate carries no section,
    // the brief renders without the card.
    {
      const c = buildCase("D11-throughput-absent");
      const out = driveBrief("brief-d11a", caseInput(c, "aggregate"));
      if (out) {
        check(out.verdict === "aggregated", `D11 OK: verdict aggregated (got ${out.verdict})`);
        const agg = readJson(c.aggregationPath);
        check(agg !== null && agg.throughput === undefined, "D11 OK: aggregation carries no throughput section when none is supplied");
      }
      const bOut = driveBrief("brief-d11b", caseInput(c, "brief"));
      if (bOut) {
        const html = read(c.briefPath) ?? "";
        check(!html.includes("Throughput ("), "D11 OK: brief renders without the Throughput card");
      }
    }

    // ---- D12 throughput malformed: recorded missing-with-reason,
    // the aggregate still lands, the brief still renders.
    {
      const c = buildCase("D12-throughput-malformed");
      const throughputPath = path.join(c.dir, "throughput-2026-11-21.json");
      fs.writeFileSync(throughputPath, "{not json\n");
      const out = driveBrief("brief-d12a", caseInput(c, "aggregate", { throughputReportPath: throughputPath }));
      if (out) {
        check(out.verdict === "aggregated", `D12 OK: verdict aggregated despite the malformed throughput report (got ${out.verdict})`);
        const agg = readJson(c.aggregationPath);
        check(agg !== null && agg.throughput === undefined, "D12 OK: aggregation carries no throughput section for a malformed report");
        const log = read(c.logPath) ?? "";
        check(log.includes("throughput report missing: throughput report is unparsable JSON"), `D12 OK: log records the malformed report with the reason named (got ${log.split("\n").find((l) => l.includes("throughput report missing")) ?? "no line"})`);
      }
      const bOut = driveBrief("brief-d12b", caseInput(c, "brief"));
      if (bOut) {
        check(bOut.verdict === "briefed", `D12 OK: brief verdict briefed (got ${bOut.verdict})`);
        const html = read(c.briefPath) ?? "";
        check(!html.includes("Throughput ("), "D12 OK: brief renders without the Throughput card");
      }
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`DAILYBRIEF FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS daily-brief workflow (inventory check, agentts check, pure unit checks, live scratch-project runs D1–D12 — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
