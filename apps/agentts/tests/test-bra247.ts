/**
 * test-bra247.ts — the throughput report workflow (BRA-247).
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh — the throughput-report section is wired after bra178).
 *   B. `agentts check` passes on throughput-report.ts (first-run gate).
 *   C. Pure unit checks: validateThroughputReportInput (every guard),
 *      normalizeIssueKey / runItemKey (the pickup join — one token,
 *      never a prefix), median / activeWallMs, parseLedgerEntries
 *      (done/failed/collected/corrupt/undated), parseBaselinesFile
 *      (ok/corrupt/wrong version/metric without threshold),
 *      observeWorkflowWall (last 5, gate-hold, tokens),
 *      parseMergeReport (ok / no elapsedMs / no mergeId),
 *      closeTimeFromNotes (closed <ISO> only), windowBounds,
 *      deriveThroughput (the fixture numbers: tasks completed,
 *      landings, medians, cost of a kill, stalled, audit),
 *      validateThroughputReportFile (valid / wrong date / bad totals
 *      / no stalled / not an object), throughputSectionOf,
 *      boundedTailScript + parseBoundedTail (run through sh: the
 *      last lines survive, printed/total named, missing file rc 2,
 *      malformed header throws), buildThroughputReport.
 *   D. Live runs against a stub-free scratch project (fixture
 *      ledger + fixture baselines + fixture queue + fixture merge
 *      reports under the test WORKDIR — never the real goal files),
 *      all through the CLI on direct:
 *      D-247a fixture-ledger report (verdict reported; the report
 *        file on disk carries the fixture numbers; the report's
 *        totals match the file's; a missing merge report path is
 *        recorded missing-with-reason, never a refusal);
 *      D-247b machine-down fixture (empty ledger + dead serverUrl:
 *        machineDown true, totals zero, verdict reported);
 *      D-247c dry-run (verdict dry-run, report path named, nothing
 *        written);
 *      D-247d cancel (cancelled runId refuses with cancelChecked
 *        true, writes nothing — the bra210a case-H shape: the
 *        cancel check reads project.stateDir/queue.json, a scratch
 *        dir with a hand-crafted cancelled entry);
 *      D-247e missing queue file (verdict reported, missing names
 *        the queue source, totals zero);
 *      D-247f live queue file (fix round, Nov 22: a COPY of the
 *        live land-queue.json drives end to end — its pending_qa
 *        entry is handled explicitly as awaiting Quality, and a second
 *        entry with a genuinely unknown status is skipped-with-
 *        reason and named; the live file itself is never driven
 *        as test input).
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra247.ts
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
import { validateQueueFileForRead } from "../workflows/library/land-queue";
import throughputReport, {
  validateThroughputReportInput,
  normalizeIssueKey,
  runItemKey,
  median,
  activeWallMs,
  parseLedgerEntries,
  parseBaselinesFile,
  observeWorkflowWall,
  parseMergeReport,
  closeTimeFromNotes,
  windowBounds,
  deriveThroughput,
  validateThroughputReportFile,
  throughputSectionOf,
  boundedTailScript,
  parseBoundedTail,
  parseCopyManifestCopiedAt,
  copyCreatedScript,
  parseCopyCreated,
  COPY_MANIFEST_NAME,
  buildThroughputReport,
  THROUGHPUT_REPORT_KNOWN_LIMIT,
  type ThroughputReportInput,
  type ThroughputReportProjectConfig,
  type ThroughputReportFile,
  type LedgerEntryLite,
  type LandQueueEntry,
  type MergeReportSummary,
  type ItemPickup,
} from "../workflows/library/throughput-report";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const THROUGHPUT_REPORT = path.join(ROOT, "workflows", "library", "throughput-report.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA247_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "throughput-report-"));
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
    if (Date.now() > deadline) throw new Error("throughput-report server did not come up");
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

/** Submit one throughput-report run (no drive yet). */
function submitReport(runId: string, input: ThroughputReportInput): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", THROUGHPUT_REPORT,
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

/** Drive one throughput-report input through the CLI (submit +
 * queue run + result) and return the parsed report, or null on a
 * CLI failure (the failure is already recorded as a check). */
function driveReport(runId: string, input: ThroughputReportInput): Record<string, any> | null {
  if (!submitReport(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: a stub-free scratch project. The ledger, the baselines
// file, the queue and the merge reports are fixtures written under
// the test WORKDIR — never the real goal files.
// ------------------------------------------------------------------

const DATE = "2026-11-22";
const NOW = "2026-11-22T14:00:00Z";

/** The fixture ledger entries (the same objects §C feeds
 * deriveThroughput directly and §D writes to disk). */
function fixtureLedgerEntries(): LedgerEntryLite[] {
  return [
    { runId: "run-bra301-build", workflow: "test-workflow", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T10:00:00Z", wallMs: 4_800_000, gateHoldMs: 0, traps: 3, tokensTotal: 1200 },
    { runId: "run-bra302-build", workflow: "test-workflow", status: "done", adapter: "direct", startedAt: "2026-11-22T09:00:00Z", finishedAt: "2026-11-22T11:00:00Z", wallMs: 4_800_000, gateHoldMs: 0, traps: 3, tokensTotal: 800 },
    { runId: "run-bra305-fail", workflow: "other-workflow", status: "failed", adapter: "direct", startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:30:00Z", wallMs: 1_800_000, gateHoldMs: 600_000, traps: 2, tokensTotal: 5000, error: "boom" },
    { runId: "run-bra306-undated", workflow: "undated-workflow", status: "done", adapter: "direct", startedAt: null, finishedAt: "2026-11-22T11:00:00Z", wallMs: 600_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
    { runId: "run-bra307-old", workflow: "old-workflow", status: "done", adapter: "direct", startedAt: "2026-11-21T10:00:00Z", finishedAt: "2026-11-21T11:00:00Z", wallMs: 3_600_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
  ];
}

/** The fixture ledger file text: the entries above, one collected
 * record, one corrupt line. */
function fixtureLedgerText(): string {
  const lines = fixtureLedgerEntries().map((e) =>
    JSON.stringify({ version: 1, runId: e.runId, workflow: e.workflow, status: e.status, adapter: e.adapter, startedAt: e.startedAt, finishedAt: e.finishedAt, wallMs: e.wallMs, gateHoldMs: e.gateHoldMs, traps: e.traps, tokens: { total: e.tokensTotal }, ...(e.error ? { error: e.error } : {}) }),
  );
  lines.push(JSON.stringify({ version: 1, runId: "run-old-1", workflow: "old-workflow", status: "collected", kind: "collected", adapter: "direct", startedAt: "2026-11-20T01:00:00Z", finishedAt: "2026-11-20T01:05:00Z", wallMs: 300_000 }));
  lines.push("not json");
  return lines.join("\n") + "\n";
}

function fixtureQueueItems(copyDir: (issue: string) => string): LandQueueEntry[] {
  return [
    { issue: "BRA-301", title: "Fixture one", status: "landed", copy: copyDir("BRA-301"), ready_at: "2026-11-22T08:00:00Z", landed_at: "2026-11-22T12:00:00Z", notes: "closed 2026-11-22T12:30:00Z in Linear 05:30 PST" },
    { issue: "BRA-302", title: "Fixture two", status: "landed", copy: copyDir("BRA-302"), ready_at: "2026-11-22T09:00:00Z", landed_at: "2026-11-22T13:00:00Z", notes: "closed 2026-11-22T13:10:00Z" },
    { issue: "BRA-303", title: "Fixture three (stalled)", status: "ready", copy: copyDir("BRA-303"), ready_at: "2026-11-22T06:00:00Z" },
    { issue: "BRA-304", title: "Fixture four (fresh)", status: "blocked", copy: copyDir("BRA-304"), ready_at: "2026-11-22T13:30:00Z" },
  ];
}

/** The fixture pickups (copy creation times — the pickup anchor,
 * Director ruling Nov 22 ~01:46 PST). BRA-303's copy has no
 * manifest, so its pickup rides the dir-mtime fallback. */
function fixturePickups(): Map<string, ItemPickup> {
  return new Map<string, ItemPickup>([
    ["BRA-301", { pickup: "2026-11-22T08:00:00Z", source: "manifest" }],
    ["BRA-302", { pickup: "2026-11-22T09:00:00Z", source: "manifest" }],
    ["BRA-303", { pickup: "2026-11-22T06:00:00Z", source: "mtime" }],
    ["BRA-304", { pickup: "2026-11-22T13:30:00Z", source: "manifest" }],
  ]);
}


function fixtureMergeReport(issue: string, elapsedMs: number): Record<string, any> {
  return {
    mergeId: "merge-" + issue.toLowerCase() + "-20261122",
    verdict: "merged",
    typecheck: { ran: true, exitCode: 0, passed: true, stderrHead: "" },
    suite: { ran: true, exitCode: 0, passed: true, sectionsRan: 63, totalOk: 4158, passLines: 58, allPassed: true, skippedViaResume: 0, summaryLine: "63 sections, 4158 OK", summaryMatchesIndependent: true, elapsedMs },
  };
}

function fixtureMergeSummaries(): MergeReportSummary[] {
  return [
    { mergeId: "merge-bra301-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 4_800_000 },
    { mergeId: "merge-bra302-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 4_800_000 },
  ];
}

function fixtureBaselines(): Record<string, any> {
  return {
    version: 1,
    generated: "2026-11-22T00:00:00Z",
    metrics: {
      "test-workflow::wallMs": { unit: "ms", kind: "wallMs", baseline: 3_600_000, threshold: 10_800_000, multiple: 3, history: [3_600_000], greenStreak: 1, note: "fixture" },
    },
  };
}

/** One scratch case dir: its own state dir (ledger + baselines),
 * queue file, merge reports, report path. */
interface CasePaths {
  dir: string;
  stateDir: string;
  workDir: string;
  queuePath: string;
  mergeReportPaths: string[];
  reportPath: string;
}

function buildCase(name: string, opts: { emptyLedger?: boolean; queueIssues?: string[] } = {}): CasePaths {
  const dir = path.join(WORKDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(path.join(stateDir, "ledger"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ledger", "run-ledger.jsonl"), opts.emptyLedger ? "" : fixtureLedgerText());
  fs.writeFileSync(path.join(stateDir, "ledger", "workflow-baselines.json"), JSON.stringify(fixtureBaselines(), null, 2) + "\n");
  // Fixture copy dirs: one per queue item, each with a manifest
  // carrying copiedAt — except BRA-303, whose copy has no manifest
  // (its pickup rides the dir-mtime fallback).
  const copyManifestAt: Record<string, string | null> = {
    "BRA-301": "2026-11-22T08:00:00Z",
    "BRA-302": "2026-11-22T09:00:00Z",
    "BRA-303": null,
    "BRA-304": "2026-11-22T13:30:00Z",
  };
  for (const [issue, at] of Object.entries(copyManifestAt)) {
    const copyDir = path.join(dir, "copies", issue);
    fs.mkdirSync(copyDir, { recursive: true });
    if (at !== null) {
      fs.writeFileSync(path.join(copyDir, COPY_MANIFEST_NAME), JSON.stringify({ copiedAt: at, root: copyDir, files: {} }, null, 2) + "\n");
    }
  }
  const queuePath = path.join(dir, "land-queue.json");
  const items = fixtureQueueItems((issue) => path.join(dir, "copies", issue)).filter(
    (it) => opts.queueIssues === undefined || opts.queueIssues.includes(it.issue),
  );
  fs.writeFileSync(queuePath, JSON.stringify({ items, owner: "test", policy: {}, queue: [], throughput: {}, updated: "2026-11-22T14:00:00Z" }, null, 2) + "\n");
  const mergeReportPaths = ["bra301", "bra302"].map((issue) => {
    const p = path.join(dir, "merge-" + issue + ".json");
    fs.writeFileSync(p, JSON.stringify(fixtureMergeReport(issue, 4_800_000), null, 2) + "\n");
    return p;
  });
  const workDir = path.join(dir, "work");
  fs.mkdirSync(path.join(workDir, "tmp"), { recursive: true });
  return { dir, stateDir, workDir, queuePath, mergeReportPaths, reportPath: path.join(dir, "throughput-2026-11-22.json") };
}

/** The shared project config for §D cases (stateDir is the case's
 * scratch state dir — the ledger/baselines the workflow reads). */
function testProject(stateDir: string, workDir: string): ThroughputReportProjectConfig {
  return {
    linearProject: "P-BRA-2",
    repo: COPY_ROOT,
    stateDir,
    workDir,
    resumeDir: path.join(WORKDIR, "project-resume"),
  };
}

/** Build a throughput-report input for one case. */
function caseInput(c: CasePaths, extra: Record<string, any> = {}): ThroughputReportInput {
  return {
    project: testProject(c.stateDir, c.workDir),
    run: {
      reportId: "throughput-2026-11-22",
      date: DATE,
      queuePath: c.queuePath,
      mergeReportPaths: c.mergeReportPaths,
      reportPath: c.reportPath,
      now: NOW,
      ...extra,
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
  };
}

function validInput(): ThroughputReportInput {
  const c = { stateDir: STATE_DIR, workDir: path.join(WORKDIR, "valid") };
  return {
    project: testProject(c.stateDir, c.workDir),
    run: {
      reportId: "throughput-2026-11-22",
      date: DATE,
      queuePath: path.join(WORKDIR, "q.json"),
      reportPath: path.join(WORKDIR, "r.json"),
    },
    owner: IMPL_OWNER,
  };
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
      const r = cli(["check", THROUGHPUT_REPORT, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on throughput-report.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("throughputReport(ThroughputReportInput)"), `CHECK OK: entry is throughputReport(ThroughputReportInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure units
    console.log("\n=== §C pure units ===");
    {
      // ---- validateThroughputReportInput: valid + every guard.
      check(validateThroughputReportInput(validInput()).length === 0, "C OK: valid input passes validation");
      const noOwner = validInput();
      delete (noOwner as Record<string, any>).owner;
      check(
        validateThroughputReportInput(noOwner).some((e) => e === "throughput-report: input has no owner string — the owner is the driving session, never assumed from the launcher"),
        "C OK: absent owner refused with the exact string",
      );
      const noRun = { project: testProject(STATE_DIR, path.join(WORKDIR, "x")), owner: IMPL_OWNER } as unknown as ThroughputReportInput;
      check(validateThroughputReportInput(noRun).includes("throughput-report: input has no run object"), "C OK: missing run object refused");
      const badDate = validInput();
      badDate.run.date = "2026-02-30";
      check(validateThroughputReportInput(badDate).includes("throughput-report: run.date must be a valid YYYY-MM-DD date"), "C OK: impossible date refused");
      const badDateShape = validInput();
      badDateShape.run.date = "2026-11-22 06:00";
      check(validateThroughputReportInput(badDateShape).includes("throughput-report: run.date must be a valid YYYY-MM-DD date"), "C OK: non-date shape refused");
      const noReportId = validInput();
      delete (noReportId.run as Record<string, any>).reportId;
      check(validateThroughputReportInput(noReportId).includes("throughput-report: run has no reportId string"), "C OK: missing reportId refused");
      const noQueuePath = validInput();
      delete (noQueuePath.run as Record<string, any>).queuePath;
      check(validateThroughputReportInput(noQueuePath).includes("throughput-report: run has no queuePath string"), "C OK: missing queuePath refused");
      const noReportPath = validInput();
      delete (noReportPath.run as Record<string, any>).reportPath;
      check(validateThroughputReportInput(noReportPath).includes("throughput-report: run has no reportPath string"), "C OK: missing reportPath refused");
      const badWindow = validInput();
      (badWindow.run as Record<string, any>).windowDays = 0;
      check(validateThroughputReportInput(badWindow).includes("throughput-report: run.windowDays must be a positive integer when present"), "C OK: windowDays 0 refused");
      const badTail = validInput();
      (badTail.run as Record<string, any>).ledgerTailLines = 0;
      check(validateThroughputReportInput(badTail).includes("throughput-report: run.ledgerTailLines must be a positive integer when present"), "C OK: ledgerTailLines 0 refused");
      const badStalled = validInput();
      (badStalled.run as Record<string, any>).stalledAfterMs = -1;
      check(validateThroughputReportInput(badStalled).includes("throughput-report: run.stalledAfterMs must be a non-negative number when present"), "C OK: negative stalledAfterMs refused");
      const badPaths = validInput();
      (badPaths.run as Record<string, any>).mergeReportPaths = ["ok.json", 7];
      check(validateThroughputReportInput(badPaths).includes("throughput-report: run.mergeReportPaths must be an array of non-empty strings when present"), "C OK: non-string mergeReportPaths entry refused");
      const noWorkDir = validInput();
      delete (noWorkDir.project as Record<string, any>).workDir;
      check(
        validateThroughputReportInput(noWorkDir).some((e) => e.includes("project has no workDir string")),
        "C OK: missing workDir refused",
      );

      // ---- normalizeIssueKey / runItemKey: the pickup join.
      check(normalizeIssueKey("BRA-210c") === "bra210c", "C OK: normalizeIssueKey lowercases and strips non-alphanumerics");
      check(normalizeIssueKey("bra-210") === "bra210", "C OK: normalizeIssueKey strips the dash");
      check(runItemKey("run-bra210c-accept-real") === "bra210c", "C OK: runItemKey names BRA-210c for run-bra210c-accept-real");
      check(runItemKey("run-bra210-accept") === "bra210", "C OK: runItemKey names BRA-210 for run-bra210-accept");
      check(runItemKey("run-bra301-build") === "bra301", "C OK: runItemKey drops the trailing build segment");
      check(runItemKey("run-bra210c-accept-real") !== "bra210", "C OK: run-bra210c-accept-real does NOT name BRA-210 (one token, never a prefix)");
      check(runItemKey("run-bra261-262-263-accept-real") === "bra261262263", "C OK: runItemKey joins a multi-issue middle key");
      check(runItemKey("loop-fix-1") === "", "C OK: runItemKey yields empty for a runId with no issue-key-shaped segment");

      // ---- median / activeWallMs.
      check(median([3, 1, 2]) === 2, "C OK: median of [3,1,2] is 2");
      check(median([1, 2, 3, 4]) === 2.5, "C OK: median of [1,2,3,4] is 2.5");
      check(median([]) === null, "C OK: median of [] is null");
      check(activeWallMs({ runId: "x", workflow: "w", status: "done", adapter: "direct", startedAt: null, finishedAt: null, wallMs: 1000, gateHoldMs: 200, traps: 0, tokensTotal: null }) === 800, "C OK: active wall is wall minus gate-hold");
      check(activeWallMs({ runId: "x", workflow: "w", status: "done", adapter: "direct", startedAt: null, finishedAt: null, wallMs: null, gateHoldMs: 0, traps: 0, tokensTotal: null }) === null, "C OK: active wall is null when wallMs is unknown");
      check(activeWallMs({ runId: "x", workflow: "w", status: "done", adapter: "direct", startedAt: null, finishedAt: null, wallMs: 1000, gateHoldMs: null, traps: 0, tokensTotal: null }) === 1000, "C OK: active wall is wallMs when gateHoldMs is unknown");

      // ---- parseLedgerEntries: done/failed/collected/corrupt/undated.
      {
        const parsed = parseLedgerEntries(fixtureLedgerText());
        check(parsed.entries.length === 5, `C OK: ledger parses 5 run entries (got ${parsed.entries.length})`);
        check(parsed.skipped === 1, `C OK: ledger skips 1 corrupt line (got ${parsed.skipped})`);
        check(parsed.collected === 1, `C OK: ledger counts 1 collected record (got ${parsed.collected})`);
        const undated = parsed.entries.find((e) => e.runId === "run-bra306-undated");
        check(undated !== undefined && undated.startedAt === null, "C OK: undated run keeps startedAt null");
        const failed = parsed.entries.find((e) => e.runId === "run-bra305-fail");
        check(failed !== undefined && failed.status === "failed" && failed.tokensTotal === 5000, "C OK: failed run keeps its tokens");
      }

      // ---- parseBaselinesFile: ok / corrupt / wrong version /
      // metric without threshold.
      {
        const okFile = parseBaselinesFile(JSON.stringify(fixtureBaselines()));
        check(okFile.kind === "ok" && okFile.metrics["test-workflow::wallMs"].threshold === 10_800_000, "C OK: baselines file parses with its threshold");
        const corrupt = parseBaselinesFile("{not json");
        check(corrupt.kind === "corrupt" && corrupt.reason.includes("unparsable"), `C OK: corrupt baselines file is corrupt (got ${JSON.stringify(corrupt)})`);
        const wrongVersion = parseBaselinesFile(JSON.stringify({ version: 2, metrics: {} }));
        check(wrongVersion.kind === "corrupt" && wrongVersion.reason.includes("version"), "C OK: baselines version 2 is corrupt");
        const noThreshold = parseBaselinesFile(JSON.stringify({ version: 1, metrics: { "w::wallMs": { baseline: 100 } } }));
        check(noThreshold.kind === "corrupt" && noThreshold.reason.includes("threshold"), "C OK: metric without a threshold is corrupt");
      }

      // ---- observeWorkflowWall: last 5, gate-hold, tokens.
      {
        const entries: LedgerEntryLite[] = [1, 2, 3, 4, 5, 6].map((n) => ({
          runId: "run-w-" + n, workflow: "w", status: "done", adapter: "direct",
          startedAt: "2026-11-22T0" + n + ":00:00Z", finishedAt: "2026-11-22T0" + n + ":10:00Z",
          wallMs: n * 1_000_000, gateHoldMs: n === 6 ? 500_000 : 0, traps: 1, tokensTotal: n * 100,
        }));
        entries.push({ runId: "run-w-fail", workflow: "w", status: "failed", adapter: "direct", startedAt: "2026-11-22T07:00:00Z", finishedAt: "2026-11-22T07:01:00Z", wallMs: 9_000_000, gateHoldMs: 0, traps: 1, tokensTotal: 999 });
        const obs = observeWorkflowWall(entries, "w", 5);
        check(obs.doneRuns === 6 && obs.failedRuns === 1, `C OK: observation counts 6 done + 1 failed (got ${obs.doneRuns}/${obs.failedRuns})`);
        // Last 5 done walls (active): 2M, 3M, 4M, 5M, 5.5M (6M - 0.5M gate-hold) -> median 4M.
        check(obs.wallMedianMs === 4_000_000, `C OK: wall median is the last 5 done runs' active median (got ${obs.wallMedianMs})`);
        check(obs.wallRuns === 5, `C OK: wall median runs on 5 runs (got ${obs.wallRuns})`);
        check(obs.tokenMedianMs === 400, `C OK: token median is the last 5 done runs' token median (got ${obs.tokenMedianMs})`);
      }

      // ---- parseMergeReport: ok / no elapsedMs / no mergeId.
      {
        const okReport = parseMergeReport(fixtureMergeReport("bra301", 4_800_000));
        check(okReport !== null && okReport.suiteElapsedMs === 4_800_000 && okReport.typecheckPassed === true, "C OK: merge report parses with elapsedMs + typecheck");
        const noElapsed = parseMergeReport({ mergeId: "m-1", verdict: "merged", typecheck: { passed: true }, suite: { passed: true } });
        check(noElapsed !== null && noElapsed.suiteElapsedMs === null, "C OK: merge report without elapsedMs parses with suiteElapsedMs null");
        const noId = parseMergeReport({ verdict: "merged", typecheck: { passed: true }, suite: { elapsedMs: 1 } });
        check(noId === null, "C OK: report without a mergeId is not a merge report");
      }

      // ---- closeTimeFromNotes: closed <ISO> only.
      check(closeTimeFromNotes("closed 2026-11-22T12:30:00Z in Linear 05:30 PST") === "2026-11-22T12:30:00Z", "C OK: close time recognized as closed <ISO>");
      check(closeTimeFromNotes("close 2026-11-22T13:10:00Z") === "2026-11-22T13:10:00Z", "C OK: close time recognized as close <ISO>");
      check(closeTimeFromNotes("closed in Linear 05:28 PST") === null, "C OK: a close with no ISO timestamp is unknown");
      check(closeTimeFromNotes("") === null, "C OK: empty notes carry no close time");

      // ---- windowBounds.
      {
        const one = windowBounds(DATE, 1);
        check(one.start === "2026-11-22T00:00:00.000Z" && one.end === "2026-11-23T00:00:00.000Z", `C OK: 1-day window is [2026-11-22, 2026-11-23) (got ${one.start}..${one.end})`);
        const seven = windowBounds(DATE, 7);
        check(seven.start === "2026-11-16T00:00:00.000Z" && seven.end === "2026-11-23T00:00:00.000Z", `C OK: 7-day window starts 2026-11-16 (got ${seven.start})`);
      }

      // ---- parseCopyManifestCopiedAt: the manifest contract.
      {
        const okManifest = parseCopyManifestCopiedAt(JSON.stringify({ copiedAt: "2026-11-22T09:27:56.795734+00:00", root: "/x", files: {} }));
        check(okManifest.copiedAt === "2026-11-22T09:27:56.795734+00:00", `C OK: manifest copiedAt parses (got ${okManifest.copiedAt})`);
        const noCopiedAt = parseCopyManifestCopiedAt(JSON.stringify({ root: "/x", files: {} }));
        check(noCopiedAt.copiedAt === null && (noCopiedAt.reason ?? "").includes("no copiedAt"), `C OK: manifest without copiedAt is null with reason (got ${JSON.stringify(noCopiedAt)})`);
        const badCopiedAt = parseCopyManifestCopiedAt(JSON.stringify({ copiedAt: "not-a-date" }));
        check(badCopiedAt.copiedAt === null && (badCopiedAt.reason ?? "").includes("not a valid timestamp"), "C OK: manifest with a bad copiedAt is null with reason");
        const corrupt = parseCopyManifestCopiedAt("{not json");
        check(corrupt.copiedAt === null && (corrupt.reason ?? "").includes("unparsable"), "C OK: corrupt manifest is null with reason");
      }

      // ---- copyCreatedScript + parseCopyCreated, run through sh:
      // manifest / mtime fallback / missing dir / malformed output.
      {
        const copyDir = path.join(WORKDIR, "copy-fixture");
        fs.mkdirSync(copyDir, { recursive: true });
        fs.writeFileSync(path.join(copyDir, COPY_MANIFEST_NAME), JSON.stringify({ copiedAt: "2026-11-22T08:00:00Z", root: copyDir, files: {} }, null, 2) + "\n");
        const manifestRun = spawnSync("/bin/sh", ["-c", copyCreatedScript(copyDir)], { encoding: "utf8" });
        check(manifestRun.status === 0, `C OK: copy-created script exits 0 with a manifest (got ${manifestRun.status})`);
        const manifestCreated = parseCopyCreated(manifestRun.stdout ?? "");
        check(manifestCreated.createdAt === "2026-11-22T08:00:00+00:00" && manifestCreated.source === "manifest", `C OK: manifest copy resolves to copiedAt + manifest source (got ${JSON.stringify(manifestCreated)})`);
        const noManifestDir = path.join(WORKDIR, "copy-no-manifest");
        fs.mkdirSync(noManifestDir, { recursive: true });
        const mtimeRun = spawnSync("/bin/sh", ["-c", copyCreatedScript(noManifestDir)], { encoding: "utf8" });
        check(mtimeRun.status === 0, `C OK: copy-created script exits 0 without a manifest (got ${mtimeRun.status})`);
        const mtimeCreated = parseCopyCreated(mtimeRun.stdout ?? "");
        check(mtimeCreated.source === "mtime" && !Number.isNaN(new Date(mtimeCreated.createdAt).getTime()), `C OK: manifest-less copy falls back to dir mtime (got ${JSON.stringify(mtimeCreated)})`);
        const corruptDir = path.join(WORKDIR, "copy-corrupt-manifest");
        fs.mkdirSync(corruptDir, { recursive: true });
        fs.writeFileSync(path.join(corruptDir, COPY_MANIFEST_NAME), "{not json\n");
        const corruptRun = spawnSync("/bin/sh", ["-c", copyCreatedScript(corruptDir)], { encoding: "utf8" });
        const corruptCreated = parseCopyCreated(corruptRun.stdout ?? "");
        check(corruptCreated.source === "mtime" && (corruptCreated.note ?? "").includes("manifest unusable"), `C OK: corrupt manifest falls back to mtime with the reason named (got ${JSON.stringify(corruptCreated)})`);
        const missingRun = spawnSync("/bin/sh", ["-c", copyCreatedScript(path.join(WORKDIR, "no-such-copy"))], { encoding: "utf8" });
        check(missingRun.status === 2 && (missingRun.stdout ?? "").includes("CREATED-MISSING"), `C OK: missing copy dir exits 2 with CREATED-MISSING (got ${missingRun.status})`);
        let threw = false;
        try {
          parseCopyCreated("garbage\n");
        } catch {
          threw = true;
        }
        check(threw, "C OK: parseCopyCreated throws on a malformed line");
      }

      // ---- deriveThroughput: the fixture numbers.
      {
        const parsed = parseLedgerEntries(fixtureLedgerText());
        const baselines = parseBaselinesFile(JSON.stringify(fixtureBaselines()));
        const file = deriveThroughput({
          date: DATE,
          windowDays: 1,
          now: NOW,
          ledgerEntries: parsed.entries,
          ledgerSkippedLines: parsed.skipped,
          ledgerCollected: parsed.collected,
          ledgerMissing: false,
          ledgerTailIncomplete: false,
          ledgerTailPrinted: 7,
          ledgerTailTotal: 7,
          queueItems: fixtureQueueItems(() => "/nonexistent-copy"),
          queueUpdated: "2026-11-22T14:00:00Z",
          queueMissing: false,
          mergeReports: fixtureMergeSummaries(),
          mergeReportMissing: [],
          baselines: baselines.kind === "ok" ? baselines.metrics : null,
          baselinesMissingReason: null,
          serverHealth: { checked: true, ok: true },
          pickups: fixturePickups(),
          stalledAfterMs: 2 * 3_600_000,
        });
        check(file.totals.tasksCompleted === 2, `C OK: 2 tasks completed (got ${file.totals.tasksCompleted})`);
        check(file.totals.landings === 2, `C OK: 2 landings (got ${file.totals.landings})`);
        check(file.totals.itemsInWindow === 2, `C OK: 2 items in window (got ${file.totals.itemsInWindow})`);
        check(file.totals.medianPickupToLandedMs === 14_400_000, `C OK: median pickup-to-landed 14,400,000 ms (got ${file.totals.medianPickupToLandedMs})`);
        check(file.totals.medianVerifyMs === 4_800_000, `C OK: median verify 4,800,000 ms (got ${file.totals.medianVerifyMs})`);
        check(file.totals.doneRuns === 2, `C OK: 2 done runs (got ${file.totals.doneRuns})`);
        check(file.totals.failedRuns.length === 1 && file.totals.failedRuns[0].wallMs === 1_200_000, `C OK: 1 failed run with active wall 1,200,000 (got ${JSON.stringify(file.totals.failedRuns)})`);
        check(file.totals.killWallMsTotal === 1_200_000, `C OK: cost of a kill 1,200,000 ms wall (got ${file.totals.killWallMsTotal})`);
        check(file.totals.killTokensTotal === 5000, `C OK: cost of a kill 5000 tokens (got ${file.totals.killTokensTotal})`);
        check(file.totals.skippedLedgerLines === 1 && file.totals.collectedRecords === 1 && file.totals.undatedRuns === 1, `C OK: skipped 1, collected 1, undated 1 (got ${file.totals.skippedLedgerLines}/${file.totals.collectedRecords}/${file.totals.undatedRuns})`);
        const i301 = file.items.find((i) => i.issue === "BRA-301");
        check(i301 !== undefined && i301.pickupToLandedMs === 14_400_000 && i301.verifyMs === 4_800_000 && i301.closeMs === 1_800_000 && i301.buildMs === 4_800_000, `C OK: BRA-301 line carries pickup/verify/close/build (got ${JSON.stringify(i301)})`);
        check(i301 !== undefined && i301.pickup === "2026-11-22T08:00:00Z" && i301.pickupSource === "manifest", `C OK: BRA-301 pickup is the manifest copiedAt (got ${i301?.pickup}/${i301?.pickupSource})`);
        const i303 = file.items.find((i) => i.issue === "BRA-303");
        check(i303 !== undefined && i303.pickupSource === "mtime", `C OK: BRA-303 pickup rides the mtime fallback (got ${i303?.pickupSource})`);
        const i302 = file.items.find((i) => i.issue === "BRA-302");
        check(i302 !== undefined && i302.closeMs === 600_000, `C OK: BRA-302 close is 600,000 ms (got ${i302?.closeMs})`);
        check(file.stalled.length === 1 && file.stalled[0].issue === "BRA-303" && file.stalled[0].status === "ready" && file.stalled[0].stalledForMs === 28_800_000, `C OK: stalled is [BRA-303 ready 8h] (got ${JSON.stringify(file.stalled)})`);
        check(file.missing.length === 0, `C OK: no missing sources in the full fixture (got ${JSON.stringify(file.missing)})`);
        check(file.machineDown === false, "C OK: machineDown false with runs + server up");
        const audit = file.audit.find((a) => a.workflow === "test-workflow");
        check(audit !== undefined && audit.doneRuns === 2 && audit.wallMedianMs === 4_800_000 && audit.baselineMs === 3_600_000 && audit.thresholdMs === 10_800_000 && audit.baselineStatus === "present", `C OK: audit observes test-workflow with baseline (got ${JSON.stringify(audit)})`);
        check(file.audit.find((a) => a.workflow === "old-workflow") === undefined, "C OK: no audit observation for a workflow with no done runs in the window");
        check(file.knownLimit === THROUGHPUT_REPORT_KNOWN_LIMIT, "C OK: known limit carried verbatim");
      }

      // ---- deriveThroughput: the anchor is the COPY, not the run
      // (Director ruling, Nov 22 ~01:46 PST). The run started an
      // hour after the copy was made — the setup lag stays in the
      // cycle: pickup-to-landed is 4h from copiedAt, not 3h from
      // the run's startedAt.
      {
        const file = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW,
          ledgerEntries: [
            { runId: "run-bra401-build", workflow: "w", status: "done", adapter: "direct", startedAt: "2026-11-22T09:00:00Z", finishedAt: "2026-11-22T10:00:00Z", wallMs: 3_600_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
          ],
          ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 1, ledgerTailTotal: 1,
          queueItems: [{ issue: "BRA-401", title: "anchor", status: "landed", copy: "/nonexistent-copy", ready_at: "2026-11-22T08:00:00Z", landed_at: "2026-11-22T12:00:00Z", notes: "closed 2026-11-22T12:30:00Z" }],
          queueUpdated: "2026-11-22T14:00:00Z", queueMissing: false,
          mergeReports: [{ mergeId: "merge-bra401-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 3_600_000 }],
          mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines",
          serverHealth: { checked: true, ok: true },
          pickups: new Map([["BRA-401", { pickup: "2026-11-22T08:00:00Z", source: "manifest" }]]),
          stalledAfterMs: 7_200_000,
        });
        const item = file.items[0];
        check(item.pickup === "2026-11-22T08:00:00Z" && item.pickupToLandedMs === 14_400_000, `C OK: pickup is copiedAt 08:00, not the run's 09:00 startedAt (got pickup ${item.pickup}, ${item.pickupToLandedMs} ms)`);
        check(file.totals.medianPickupToLandedMs === 14_400_000, `C OK: the median keeps the setup lag (got ${file.totals.medianPickupToLandedMs})`);
      }

      // ---- deriveThroughput: no copy / unresolvable copy.
      {
        const noCopy = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: [], ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 0, ledgerTailTotal: 0,
          queueItems: [{ issue: "BRA-501", title: "no copy", status: "ready", ready_at: "2026-11-22T06:00:00Z" }],
          queueUpdated: "2026-11-22T14:00:00Z", queueMissing: false, mergeReports: [], mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines",
          serverHealth: { checked: true, ok: true }, pickups: new Map(), stalledAfterMs: 7_200_000,
        });
        check(noCopy.items[0].pickup === null && (noCopy.items[0].pickupToLandedUnknownReason ?? "").includes("no copy recorded"), `C OK: no copy means an unknown pickup with the reason named (got ${JSON.stringify(noCopy.items[0].pickupToLandedUnknownReason)})`);
        const unresolvable = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: [], ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 0, ledgerTailTotal: 0,
          queueItems: [{ issue: "BRA-502", title: "gone copy", status: "ready", copy: "/gone/copy", ready_at: "2026-11-22T06:00:00Z" }],
          queueUpdated: "2026-11-22T14:00:00Z", queueMissing: false, mergeReports: [], mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines",
          serverHealth: { checked: true, ok: true },
          pickups: new Map([["BRA-502", { pickup: null, source: null, reason: "no copy could be resolved: /gone/copy (copy dir missing)" }]]),
          stalledAfterMs: 7_200_000,
        });
        check(unresolvable.items[0].pickup === null && (unresolvable.items[0].pickupToLandedUnknownReason ?? "").includes("/gone/copy"), `C OK: an unresolvable copy names the dir (got ${JSON.stringify(unresolvable.items[0].pickupToLandedUnknownReason)})`);
      }

      // ---- deriveThroughput: the kill-total nulls.
      {
        const entries: LedgerEntryLite[] = [
          { runId: "run-fail-nowall", workflow: "w", status: "failed", adapter: "direct", startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:05:00Z", wallMs: null, gateHoldMs: 0, traps: 0, tokensTotal: null },
        ];
        const file = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: entries, ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 1, ledgerTailTotal: 1,
          queueItems: [], queueUpdated: null, queueMissing: false, mergeReports: [], mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines", serverHealth: { checked: true, ok: true }, pickups: new Map(), stalledAfterMs: 7_200_000,
        });
        check(file.totals.killWallMsTotal === null, `C OK: kill wall is null when failed runs have no known wall (got ${file.totals.killWallMsTotal})`);
        check(file.totals.killTokensTotal === null, `C OK: kill tokens null when no failed run reported tokens (got ${file.totals.killTokensTotal})`);
        const empty = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: [], ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 0, ledgerTailTotal: 0,
          queueItems: [], queueUpdated: null, queueMissing: false, mergeReports: [], mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines", serverHealth: { checked: true, ok: true }, pickups: new Map(), stalledAfterMs: 7_200_000,
        });
        check(empty.totals.killWallMsTotal === 0, `C OK: kill wall is 0 when there are no failed runs (got ${empty.totals.killWallMsTotal})`);
      }

      // ---- deriveThroughput: pending_qa + skipped-with-reason
      // (fix round, Nov 22 — Landing ruling ~03:38 PST). A "pending_qa"
      // entry is counted as pending and shown as awaiting Quality — NOT
      // landed, NOT stalled. An entry whose only defect is an
      // unknown status is skipped-with-reason and named in the
      // missing sources.
      {
        const pendingQaFile = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: [], ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 0, ledgerTailTotal: 0,
          queueItems: [
            { issue: "BRA-601", title: "in Quality", status: "pending_qa", copy: "/nonexistent-copy", ready_at: "2026-11-22T11:17:44Z" },
            { issue: "BRA-602", title: "stalled ready", status: "ready", copy: "/nonexistent-copy", ready_at: "2026-11-22T06:00:00Z" },
          ],
          queueUpdated: "2026-11-22T14:00:00Z", queueMissing: false, mergeReports: [], mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines",
          serverHealth: { checked: true, ok: true },
          pickups: new Map([["BRA-601", { pickup: "2026-11-22T10:00:00Z", source: "manifest" }]]),
          stalledAfterMs: 7_200_000,
        });
        check(pendingQaFile.pendingQa.length === 1 && pendingQaFile.pendingQa[0].issue === "BRA-601" && pendingQaFile.pendingQa[0].readyAt === "2026-11-22T11:17:44Z", `C OK: pendingQa lists BRA-601 with its ready_at (got ${JSON.stringify(pendingQaFile.pendingQa)})`);
        check(pendingQaFile.items.find((i) => i.issue === "BRA-601")?.status === "pending_qa", "C OK: the pending_qa item line carries its status");
        check(pendingQaFile.totals.landings === 0, `C OK: a pending_qa entry is not a landing (got ${pendingQaFile.totals.landings})`);
        check(pendingQaFile.stalled.length === 1 && pendingQaFile.stalled[0].issue === "BRA-602", `C OK: stalled is [BRA-602] — the pending_qa entry is not stalled (got ${JSON.stringify(pendingQaFile.stalled)})`);
        check(pendingQaFile.totals.itemsInWindow === 0, `C OK: nothing in window with no landings and no runs (got ${pendingQaFile.totals.itemsInWindow})`);
        check(throughputSectionOf(pendingQaFile).pendingQa.length === 1 && throughputSectionOf(pendingQaFile).pendingQa[0].issue === "BRA-601", "C OK: the section carries pendingQa");
        const skippedFile = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: [], ledgerSkippedLines: 0, ledgerCollected: 0,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 0, ledgerTailTotal: 0,
          queueItems: [{ issue: "BRA-602", title: "stalled ready", status: "ready", copy: "/nonexistent-copy", ready_at: "2026-11-22T06:00:00Z" }],
          queueSkipped: [{ issue: "BRA-603", status: "flying", reason: "land-queue: queue item BRA-603 has unknown status \"flying\"" }],
          queueUpdated: "2026-11-22T14:00:00Z", queueMissing: false, mergeReports: [], mergeReportMissing: [],
          baselines: null, baselinesMissingReason: "no baselines",
          serverHealth: { checked: true, ok: true }, pickups: new Map(), stalledAfterMs: 7_200_000,
        });
        check(skippedFile.missing.some((m) => m.source === "queue:BRA-603" && m.reason.includes("unknown status") && m.reason.includes("skipped")), `C OK: the skipped entry rides the missing sources, named (got ${JSON.stringify(skippedFile.missing)})`);
        check(!skippedFile.items.some((i) => i.issue === "BRA-603"), "C OK: the skipped entry has no item line");
        const lenient = validateQueueFileForRead({ items: [
          { issue: "BRA-601", title: "in Quality", status: "pending_qa" },
          { issue: "BRA-603", title: "typo", status: "flying" },
          { issue: "BRA-604", title: "landed", status: "landed" },
        ] });
        check(lenient.errors.length === 0 && lenient.items.length === 2, `C OK: the lenient read passes with one unknown-status entry (got errors ${JSON.stringify(lenient.errors)}, items ${lenient.items.length})`);
        check(lenient.skipped.length === 1 && lenient.skipped[0].issue === "BRA-603" && lenient.skipped[0].status === "flying" && /unknown status "flying"/.test(lenient.skipped[0].reason), `C OK: the unknown-status entry is skipped-with-reason (got ${JSON.stringify(lenient.skipped)})`);
      }

      // ---- validateThroughputReportFile / throughputSectionOf.
      {
        const parsed = parseLedgerEntries(fixtureLedgerText());
        const baselines = parseBaselinesFile(JSON.stringify(fixtureBaselines()));
        const file: ThroughputReportFile = deriveThroughput({
          date: DATE, windowDays: 1, now: NOW, ledgerEntries: parsed.entries, ledgerSkippedLines: parsed.skipped, ledgerCollected: parsed.collected,
          ledgerMissing: false, ledgerTailIncomplete: false, ledgerTailPrinted: 7, ledgerTailTotal: 7,
          queueItems: fixtureQueueItems(() => "/nonexistent-copy"), queueUpdated: "2026-11-22T14:00:00Z", queueMissing: false,
          mergeReports: fixtureMergeSummaries(), mergeReportMissing: [],
          baselines: baselines.kind === "ok" ? baselines.metrics : null, baselinesMissingReason: null,
          serverHealth: { checked: true, ok: true }, pickups: fixturePickups(), stalledAfterMs: 7_200_000,
        });
        const valid = validateThroughputReportFile(file, DATE);
        check(valid.valid === true, `C OK: the fixture report file validates (got ${JSON.stringify(valid)})`);
        if (valid.valid) {
          check(valid.section.tasksCompleted === 2 && valid.section.landings === 2, "C OK: the section carries the counted numbers");
          check(valid.section.medianPickupToLandedMs === 14_400_000, "C OK: the section carries the median pickup-to-landed");
        }
        const section = throughputSectionOf(file);
        check(section.date === DATE && section.windowDays === 1 && section.stalled.length === 1, "C OK: throughputSectionOf extracts the section");
        const wrongDate = validateThroughputReportFile({ ...file, date: "2026-11-21" }, DATE);
        check(wrongDate.valid === false && wrongDate.reason.includes("does not match"), `C OK: wrong-date report is invalid (got ${JSON.stringify(wrongDate)})`);
        const badTotals = validateThroughputReportFile({ ...file, totals: { ...file.totals, tasksCompleted: "two" } }, DATE);
        check(badTotals.valid === false && badTotals.reason.includes("tasksCompleted"), "C OK: non-numeric tasksCompleted is invalid");
        const noStalled = validateThroughputReportFile({ ...file, stalled: undefined }, DATE);
        check(noStalled.valid === false && noStalled.reason.includes("stalled"), "C OK: missing stalled array is invalid");
        const notObject = validateThroughputReportFile("hello", DATE);
        check(notObject.valid === false, "C OK: a non-object report is invalid");
      }

      // ---- boundedTailScript + parseBoundedTail, run through sh.
      {
        const tailFile = path.join(WORKDIR, "tail-fixture.txt");
        const lines = Array.from({ length: 25 }, (_, i) => "line-" + (i + 1));
        fs.writeFileSync(tailFile, lines.join("\n") + "\n");
        const script = boundedTailScript(tailFile, 20, 16 * 1024);
        const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
        check(r.status === 0, `C OK: bounded tail script exits 0 (got ${r.status}: ${(r.stderr ?? "").slice(0, 200)})`);
        const tail = parseBoundedTail(r.stdout ?? "");
        check(tail.printed === 20 && tail.total === 25, `C OK: tail prints 20 of 25 lines (got ${tail.printed}/${tail.total})`);
        check(tail.lines[0] === "line-6" && tail.lines[19] === "line-25", `C OK: tail keeps the last 20 lines (got ${tail.lines[0]}..${tail.lines[19]})`);
        const missingScript = boundedTailScript(path.join(WORKDIR, "no-such-file.txt"), 20, 16 * 1024);
        const missing = spawnSync("/bin/sh", ["-c", missingScript], { encoding: "utf8" });
        check(missing.status === 2 && (missing.stdout ?? "").includes("BTAIL-MISSING"), `C OK: missing tail file exits 2 with BTAIL-MISSING (got ${missing.status}: ${JSON.stringify((missing.stdout ?? "").slice(0, 80))})`);
        let threw = false;
        try {
          parseBoundedTail("garbage\nline-1\n");
        } catch {
          threw = true;
        }
        check(threw, "C OK: parseBoundedTail throws on a malformed header");
      }

      // ---- buildThroughputReport.
      {
        const rep = buildThroughputReport({
          reportId: "throughput-2026-11-22", verdict: "reported", dryRun: false, owner: IMPL_OWNER, date: DATE, windowDays: 1,
          reportPath: "/tmp/x.json", items: [], totals: { itemsInWindow: 0, tasksCompleted: 0, landings: 0, medianPickupToLandedMs: null, medianVerifyMs: null, doneRuns: 0, failedRuns: [], killWallMsTotal: 0, killTokensTotal: null, skippedLedgerLines: 0, collectedRecords: 0, undatedRuns: 0 },
          stalled: [], missing: [], machineDown: false,
        });
        check(rep.verdict === "reported" && rep.knownLimit === THROUGHPUT_REPORT_KNOWN_LIMIT, "C OK: buildThroughputReport carries the verdict + known limit");
      }
    }

    // --------------------------------------------- §D live runs
    console.log("\n=== §D live runs ===");
    {
      // ---- D-247a fixture-ledger report.
      const c = buildCase("D-247a-report");
      const out = driveReport("tp-a", caseInput(c, { mergeReportPaths: [...c.mergeReportPaths, path.join(c.dir, "merge-missing.json")] }));
      if (out) {
        check(out.verdict === "reported", `D-247a OK: verdict reported (got ${out.verdict})`);
        check(out.reportPath === c.reportPath, `D-247a OK: reportPath named (got ${out.reportPath})`);
        const file = readJson(c.reportPath);
        check(file !== null, "D-247a OK: the report file exists on disk");
        if (file) {
          check(file.totals.tasksCompleted === 2, `D-247a OK: file totals 2 completed (got ${file.totals.tasksCompleted})`);
          check(file.totals.landings === 2, `D-247a OK: file totals 2 landings (got ${file.totals.landings})`);
          check(file.totals.medianPickupToLandedMs === 14_400_000, `D-247a OK: file median pickup-to-landed 14,400,000 (got ${file.totals.medianPickupToLandedMs})`);
          check(file.totals.medianVerifyMs === 4_800_000, `D-247a OK: file median verify 4,800,000 (got ${file.totals.medianVerifyMs})`);
          check(file.totals.killWallMsTotal === 1_200_000 && file.totals.killTokensTotal === 5000, `D-247a OK: file cost of a kill 1,200,000 ms / 5000 tokens (got ${file.totals.killWallMsTotal}/${file.totals.killTokensTotal})`);
          check(file.stalled.length === 1 && file.stalled[0].issue === "BRA-303", `D-247a OK: file stalls BRA-303 (got ${JSON.stringify(file.stalled)})`);
          check(file.machineDown === false, "D-247a OK: file machineDown false");
          check((file.items as any[]).find((i) => i.issue === "BRA-301")?.closeMs === 1_800_000, "D-247a OK: file BRA-301 close 1,800,000 ms");
          check((file.items as any[]).find((i) => i.issue === "BRA-301")?.pickup === "2026-11-22T08:00:00+00:00" && (file.items as any[]).find((i) => i.issue === "BRA-301")?.pickupSource === "manifest", "D-247a OK: file BRA-301 pickup is the manifest copiedAt (normalized to +00:00 by the trap)");
          check((file.items as any[]).find((i) => i.issue === "BRA-303")?.pickupSource === "mtime", "D-247a OK: file BRA-303 pickup rides the mtime fallback");
          check(Array.isArray(file.missing) && (file.missing as any[]).some((m: any) => typeof m.source === "string" && m.source.startsWith("merge-report:") && m.source.includes("merge-missing.json")), `D-247a OK: missing merge report recorded missing-with-reason (got ${JSON.stringify(file.missing)})`);
          check((out.totals as any).tasksCompleted === file.totals.tasksCompleted && (out.totals as any).landings === file.totals.landings, "D-247a OK: the report's totals match the file's totals");
        }
      }

      // ---- D-247b machine-down fixture: an empty ledger and a
      // queue with only waiting items (nothing landed — a down
      // machine runs nothing).
      const m = buildCase("D-247b-machine-down", { emptyLedger: true, queueIssues: ["BRA-303", "BRA-304"] });
      const mOut = driveReport("tp-b", caseInput(m, { serverUrl: "http://127.0.0.1:1" }));
      if (mOut) {
        check(mOut.verdict === "reported", `D-247b OK: verdict reported (got ${mOut.verdict})`);
        check(mOut.machineDown === true, `D-247b OK: machineDown true (got ${mOut.machineDown})`);
        check((mOut.totals as any).tasksCompleted === 0 && (mOut.totals as any).landings === 0 && (mOut.totals as any).doneRuns === 0 && (mOut.totals as any).itemsInWindow === 0, `D-247b OK: totals zero (got ${JSON.stringify(mOut.totals)})`);
        check((mOut.totals as any).medianPickupToLandedMs === null && (mOut.totals as any).medianVerifyMs === null, "D-247b OK: both medians null with nothing completed");
        const mFile = readJson(m.reportPath);
        check(mFile !== null && mFile.machineDown === true, "D-247b OK: the file on disk carries machineDown true");
        check(Array.isArray(mOut.notes) && (mOut.notes as string[]).some((n) => n.includes("MACHINE DOWN")), "D-247b OK: the report names MACHINE DOWN");
        check(mFile !== null && (mFile.items as any[]).find((i: any) => i.issue === "BRA-303")?.pickupSource === "mtime", "D-247b OK: the waiting item's pickup rides the mtime fallback");
        check(Array.isArray(mOut.notes) && (mOut.notes as string[]).some((n) => n.includes("mtime fallback")), "D-247b OK: the report names the mtime fallback");
      }

      // ---- D-247c dry-run.
      const d = buildCase("D-247c-dry-run");
      const dOut = driveReport("tp-c", caseInput(d, { dryRun: true }));
      if (dOut) {
        check(dOut.verdict === "dry-run", `D-247c OK: verdict dry-run (got ${dOut.verdict})`);
        check(dOut.dryRun === true, "D-247c OK: dryRun true");
        check(!fs.existsSync(d.reportPath), "D-247c OK: dry-run writes no report file");
        check(Array.isArray(dOut.notes) && (dOut.notes as string[]).some((n) => n.includes("would write")), "D-247c OK: dry-run names the file it would write");
      }

      // ---- D-247d cancel (bra210a case-H shape).
      const k = buildCase("D-247d-cancel");
      const cancelStateDir = path.join(k.dir, "cancel-state");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(path.join(cancelStateDir, "queue.json"), JSON.stringify([{ runId: "tp-d", status: "cancelled" }]));
      const kInput = caseInput(k);
      kInput.project.stateDir = cancelStateDir;
      kInput.run.runId = "tp-d";
      const kOut = driveReport("tp-d", kInput);
      if (kOut) {
        check(kOut.verdict === "failed", `D-247d OK: verdict failed for the cancelled run (got ${kOut.verdict})`);
        check(kOut.cancelChecked === true && kOut.cancelled === true, `D-247d OK: cancelChecked true + cancelled true (got ${kOut.cancelChecked}/${kOut.cancelled})`);
        check((kOut.notes as string[]).some((n) => n.includes("is cancelled")), `D-247d OK: refusal names the cancellation (got ${JSON.stringify(kOut.notes)})`);
        check(!fs.existsSync(k.reportPath), "D-247d OK: cancelled run writes nothing");
      }

      // ---- D-247e missing queue file.
      const e = buildCase("D-247e-no-queue");
      const eOut = driveReport("tp-e", caseInput(e, { queuePath: path.join(e.dir, "no-such-queue.json") }));
      if (eOut) {
        check(eOut.verdict === "reported", `D-247e OK: verdict reported with a missing queue (got ${eOut.verdict})`);
        check((eOut.totals as any).tasksCompleted === 0 && (eOut.totals as any).landings === 0, "D-247e OK: totals zero with a missing queue");
        check(Array.isArray(eOut.missing) && (eOut.missing as any[]).some((m: any) => m.source === "queue"), `D-247e OK: missing names the queue source (got ${JSON.stringify(eOut.missing)})`);
        const eFile = readJson(e.reportPath);
        check(eFile !== null && Array.isArray(eFile.missing) && (eFile.missing as any[]).some((m: any) => m.source === "queue"), "D-247e OK: the file on disk records the missing queue");
      }

      // ---- D-247f live queue file (fix round, Nov 22): a COPY of
      // the live land-queue.json drives end to end. The copy's
      // pending_qa entry is handled explicitly as awaiting Quality (not
      // skipped, not landed, not stalled); a second entry with a
      // genuinely unknown status is skipped-with-reason and named.
      // The live file itself is never driven as test input — the
      // copy is made first, and the case asserts only the pending /
      // skip naming, never the live file's totals (they move).
      const liveQueuePath = path.join(os.homedir(), "workspace", "goals", "agentts-r2-milestone", "hidden_files", "land-queue.json");
      const liveQueue = JSON.parse(fs.readFileSync(liveQueuePath, "utf8")) as { items: any[] };
      let pendingQaIssue = (liveQueue.items.find((it) => it.status === "pending_qa") as any)?.issue as string | undefined;
      const f = buildCase("D-247f-live-queue");
      if (pendingQaIssue === undefined) {
        // No pending_qa entry in the live file. The entry may be
        // "ready" (the state it is in during a landing — set before
        // the merge runs), "landed", or gone. NEVER push a second
        // entry with the same issue: the reader refuses a duplicate
        // issue outright (land-queue.ts:354), so a synthetic push
        // next to a live "ready" entry fails the case with verdict
        // "failed" — which is exactly what happened in the first
        // 247/248 merge attempt (the entry was "ready" at drive
        // time). Instead flip the existing entry to pending_qa in
        // the COPY; only push a synthetic entry when no entry with
        // that issue exists at all.
        pendingQaIssue = "BRA-247/248";
        const existing = (liveQueue.items.find((it) => it.issue === pendingQaIssue) as any) ?? undefined;
        if (existing !== undefined) existing.status = "pending_qa";
        else liveQueue.items.push({ issue: pendingQaIssue, title: "Synthetic pending_qa (the live entry landed)", status: "pending_qa", copy: path.join(f.dir, "copies", "BRA-303"), ready_at: "2026-11-22T11:17:44Z" });
      }
      liveQueue.items.push({ issue: "BRA-999", title: "Unknown status", status: "flying", copy: path.join(f.dir, "copies", "BRA-303"), ready_at: "2026-11-22T11:00:00Z" });
      fs.writeFileSync(f.queuePath, JSON.stringify(liveQueue, null, 2) + "\n");
      const fOut = driveReport("tp-f", caseInput(f));
      if (fOut) {
        check(fOut.verdict === "reported", `D-247f OK: verdict reported on the live-queue copy (got ${fOut.verdict})`);
        const fFile = readJson(f.reportPath);
        check(fFile !== null && Array.isArray(fFile.pendingQa) && (fFile.pendingQa as any[]).some((p: any) => p.issue === pendingQaIssue), `D-247f OK: the file lists ${pendingQaIssue} as awaiting Quality (got ${JSON.stringify(fFile?.pendingQa)})`);
        check(fFile !== null && !(fFile.stalled as any[]).some((s: any) => s.issue === pendingQaIssue), `D-247f OK: the pending_qa entry is not stalled (got ${JSON.stringify(fFile?.stalled)})`);
        check(fFile !== null && !(fFile.items as any[]).some((i: any) => i.issue === "BRA-999"), "D-247f OK: the skipped entry has no item line");
        check(fFile !== null && Array.isArray(fFile.missing) && (fFile.missing as any[]).some((m: any) => m.source === "queue:BRA-999" && m.reason.includes("unknown status")), `D-247f OK: the skipped entry rides the missing sources (got ${JSON.stringify(fFile?.missing)})`);
        check(Array.isArray(fOut.notes) && (fOut.notes as string[]).some((n) => n.includes("awaiting Quality") && n.includes(pendingQaIssue as string)), `D-247f OK: the report names ${pendingQaIssue} as awaiting Quality (got ${JSON.stringify(fOut.notes)})`);
        check(Array.isArray(fOut.notes) && (fOut.notes as string[]).some((n) => n.includes("skipped 1 queue entry") && n.includes("BRA-999")), `D-247f OK: the report names the skipped entry (got ${JSON.stringify(fOut.notes)})`);
      }
    }

    console.log("\nPASS throughput-report workflow (inventory check, agentts check, pure unit checks, live scratch-project runs D-247a–D-247f — all through the CLI on direct)");
    return FAILURES.length === 0 ? 0 : 1;
  } finally {
    await stopServer();
  }
}

const code = await main();
if (code !== 0) {
  console.log(`\nFAILURES (${FAILURES.length}):`);
  for (const f of FAILURES) console.log(" - " + f);
}
process.exit(code);
