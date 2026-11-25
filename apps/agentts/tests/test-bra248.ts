/**
 * test-bra248.ts — the bottleneck detection workflow (BRA-248).
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh — the bottleneck-detect section is wired after
 *      throughput-report).
 *   B. `agentts check` passes on bottleneck-detect.ts (first-run gate).
 *   C. Pure unit checks: validateBottleneckDetectInput (every guard),
 *      decomposeItem (full / clamped residual / incomplete),
 *      slowestWorkflowOf, identifyBottleneck (machine-down override,
 *      build, queue-wait, merge, none, unknown),
 *      evaluateP0Bar (passes / fails / unevaluable without a fix
 *      cost / machine-down met by construction / none),
 *      bottleneckTitleAndArea (all four kinds), renderP0Entry
 *      (heading + marker + numbers + the Resolved instruction),
 *      p0EntryReadScript + findOpenP0 (run through sh against a
 *      fixture backlog: open, resolved, unrelated),
 *      buildBottleneckDetectReport.
 *   D. Live runs against a stub-free scratch project (fixture
 *      ledger + fixture baselines + fixture queue + fixture merge
 *      reports + scratch BACKLOG.md under the test WORKDIR — never
 *      the real goal files), all through the CLI on direct:
 *      D-248a machine-bottleneck P0 filing (empty ledger + dead
 *        serverUrl: verdict filed, the entry on disk with its
 *        marker + heading + numbers);
 *      D-248b not-the-machine reports-not-files (no share >= 0.5:
 *        verdict checked, filed false, no backlog file written);
 *      D-248c build P0 filing, second run while unanswered is a
 *        no-op (openP0 rides the report, one marker on disk),
 *        resolve, third run files again (two markers on disk);
 *      D-248d dry-run (verdict dry-run, nothing written);
 *      D-248e cancel (cancelled runId refuses with cancelChecked
 *        true, writes nothing — the bra210a case-H shape);
 *      D-248f cross-check against 247's report (agreeing report:
 *        the note says the cross-check agrees; tampered report:
 *        the note names the MISMATCH; malformed report: the note
 *        says the decomposition was derived from the sources —
 *        all dry-run, nothing filed);
 *      D-248g live queue file (fix round, Nov 22: a COPY of the
 *        live land-queue.json drives end to end — its pending_qa
 *        entry is named as awaiting Quality, and a second entry with a
 *        genuinely unknown status is skipped-with-reason and named;
 *        the live file itself is never driven as test input).
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra248.ts
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
import detectBottleneck, {
  validateBottleneckDetectInput,
  decomposeItem,
  slowestWorkflowOf,
  identifyBottleneck,
  evaluateP0Bar,
  bottleneckTitleAndArea,
  renderP0Entry,
  p0EntryReadScript,
  findOpenP0,
  buildBottleneckDetectReport,
  BOTTLENECK_DETECT_KNOWN_LIMIT,
  type BottleneckDetectInput,
  type BottleneckDetectProjectConfig,
  type BottleneckFinding,
} from "../workflows/library/bottleneck-detect";
import { validateQueueFileForRead } from "../workflows/library/land-queue";
import {
  deriveThroughput,
  COPY_MANIFEST_NAME,
  type LedgerEntryLite,
  type LandQueueEntry,
  type MergeReportSummary,
  type ThroughputReportFile,
  type ItemPickup,
} from "../workflows/library/throughput-report";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const BOTTLENECK_DETECT = path.join(ROOT, "workflows", "library", "bottleneck-detect.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA248_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "bottleneck-detect-"));
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
    if (Date.now() > deadline) throw new Error("bottleneck-detect server did not come up");
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

/** Submit one bottleneck-detect run (no drive yet). */
function submitDetect(runId: string, input: BottleneckDetectInput): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", BOTTLENECK_DETECT,
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

/** Drive one bottleneck-detect input through the CLI (submit +
 * queue run + result) and return the parsed report, or null on a
 * CLI failure (the failure is already recorded as a check). */
function driveDetect(runId: string, input: BottleneckDetectInput): Record<string, any> | null {
  if (!submitDetect(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: a stub-free scratch project. The ledger, the baselines
// file, the queue, the merge reports and the BACKLOG.md are fixtures
// written under the test WORKDIR — never the real goal files.
// ------------------------------------------------------------------

const DATE = "2026-11-22";
const NOW = "2026-11-22T14:00:00Z";

function ledgerLine(e: LedgerEntryLite): string {
  return JSON.stringify({ version: 1, runId: e.runId, workflow: e.workflow, status: e.status, adapter: e.adapter, startedAt: e.startedAt, finishedAt: e.finishedAt, wallMs: e.wallMs, gateHoldMs: e.gateHoldMs, traps: e.traps, tokens: { total: e.tokensTotal }, ...(e.error ? { error: e.error } : {}) });
}

/** Fixture N (normal): two landed items, every component a third
 * of pickup-to-landed — no single stage dominates ("none"). */
function fixtureNormal(): { entries: LedgerEntryLite[]; queue: LandQueueEntry[]; reports: MergeReportSummary[] } {
  const entries: LedgerEntryLite[] = [
    { runId: "run-bra301-build", workflow: "test-workflow", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T10:00:00Z", wallMs: 4_800_000, gateHoldMs: 0, traps: 3, tokensTotal: 1200 },
    { runId: "run-bra302-build", workflow: "test-workflow", status: "done", adapter: "direct", startedAt: "2026-11-22T09:00:00Z", finishedAt: "2026-11-22T11:00:00Z", wallMs: 4_800_000, gateHoldMs: 0, traps: 3, tokensTotal: 800 },
  ];
  const queue: LandQueueEntry[] = [
    { issue: "BRA-301", title: "Fixture one", status: "landed", ready_at: "2026-11-22T08:00:00Z", landed_at: "2026-11-22T12:00:00Z", notes: "closed 2026-11-22T12:30:00Z" },
    { issue: "BRA-302", title: "Fixture two", status: "landed", ready_at: "2026-11-22T09:00:00Z", landed_at: "2026-11-22T13:00:00Z", notes: "closed 2026-11-22T13:10:00Z" },
  ];
  const reports: MergeReportSummary[] = [
    { mergeId: "merge-bra301-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 4_800_000 },
    { mergeId: "merge-bra302-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 4_800_000 },
  ];
  return { entries, queue, reports };
}

/** Fixture B (build bottleneck): build is 60% of pickup-to-landed
 * on both items; the slowest workflow is build-workflow. */
function fixtureBuild(): { entries: LedgerEntryLite[]; queue: LandQueueEntry[]; reports: MergeReportSummary[] } {
  const entries: LedgerEntryLite[] = [
    { runId: "run-bra401-build", workflow: "build-workflow", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T10:12:00Z", wallMs: 7_920_000, gateHoldMs: 0, traps: 3, tokensTotal: 1200 },
    { runId: "run-bra402-build", workflow: "build-workflow", status: "done", adapter: "direct", startedAt: "2026-11-22T09:00:00Z", finishedAt: "2026-11-22T11:12:00Z", wallMs: 7_920_000, gateHoldMs: 0, traps: 3, tokensTotal: 800 },
  ];
  const queue: LandQueueEntry[] = [
    { issue: "BRA-401", title: "Fixture build one", status: "landed", ready_at: "2026-11-22T08:00:00Z", landed_at: "2026-11-22T11:40:00Z", notes: "closed 2026-11-22T12:00:00Z" },
    { issue: "BRA-402", title: "Fixture build two", status: "landed", ready_at: "2026-11-22T09:00:00Z", landed_at: "2026-11-22T12:40:00Z", notes: "closed 2026-11-22T13:00:00Z" },
  ];
  const reports: MergeReportSummary[] = [
    { mergeId: "merge-bra401-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 2_640_000 },
    { mergeId: "merge-bra402-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 2_640_000 },
  ];
  return { entries, queue, reports };
}

function fixtureBaselines(workflow: string): Record<string, any> {
  return {
    version: 1,
    generated: "2026-11-22T00:00:00Z",
    metrics: {
      [workflow + "::wallMs"]: { unit: "ms", kind: "wallMs", baseline: 3_600_000, threshold: 10_800_000, multiple: 3, history: [3_600_000], greenStreak: 1, note: "fixture" },
    },
  };
}

function fixtureMergeReport(issue: string, elapsedMs: number): Record<string, any> {
  return {
    mergeId: "merge-" + issue.toLowerCase() + "-20261122",
    verdict: "merged",
    typecheck: { ran: true, exitCode: 0, passed: true, stderrHead: "" },
    suite: { ran: true, exitCode: 0, passed: true, sectionsRan: 63, totalOk: 4158, passLines: 58, allPassed: true, skippedViaResume: 0, summaryLine: "63 sections, 4158 OK", summaryMatchesIndependent: true, elapsedMs },
  };
}

/** Derive a throughput file from a fixture (the same derivation
 * 247 runs — 248 re-derives it from the sources). */
function deriveFixture(f: { entries: LedgerEntryLite[]; queue: LandQueueEntry[]; reports: MergeReportSummary[]; queueSkipped?: { issue: string; status: string; reason: string }[] }, serverHealth: { checked: boolean; ok: boolean; reason?: string }): ThroughputReportFile {
  // The pickup per item is the copy creation time (Director ruling,
  // Nov 22 ~01:46 PST) — the fixture's copiedAt is the item's
  // ready_at, so the numbers are unchanged from the ledger anchor.
  const pickups = new Map<string, ItemPickup>(
    f.queue.map((it) => [it.issue, { pickup: typeof it.ready_at === "string" ? it.ready_at : null, source: "manifest" as const }]),
  );
  return deriveThroughput({
    date: DATE,
    windowDays: 1,
    now: NOW,
    ledgerEntries: f.entries,
    ledgerSkippedLines: 0,
    ledgerCollected: 0,
    ledgerMissing: false,
    ledgerTailIncomplete: false,
    ledgerTailPrinted: f.entries.length,
    ledgerTailTotal: f.entries.length,
    queueItems: f.queue,
    queueSkipped: f.queueSkipped,
    queueUpdated: "2026-11-22T14:00:00Z",
    queueMissing: false,
    mergeReports: f.reports,
    mergeReportMissing: [],
    baselines: null,
    baselinesMissingReason: "no baselines in the pure fixture",
    serverHealth,
    pickups,
    stalledAfterMs: 2 * 3_600_000,
  });
}

/** One scratch case dir: its own state dir (ledger + baselines),
 * queue file, merge reports, backlog path, work dir. */
interface CasePaths {
  dir: string;
  stateDir: string;
  workDir: string;
  queuePath: string;
  mergeReportPaths: string[];
  backlogPath: string;
}

function buildCase(name: string, f: { entries: LedgerEntryLite[]; queue: LandQueueEntry[]; reports: MergeReportSummary[] }, baselinesWorkflow: string): CasePaths {
  const dir = path.join(WORKDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(path.join(stateDir, "ledger"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ledger", "run-ledger.jsonl"), f.entries.map(ledgerLine).join("\n") + "\n");
  fs.writeFileSync(path.join(stateDir, "ledger", "workflow-baselines.json"), JSON.stringify(fixtureBaselines(baselinesWorkflow), null, 2) + "\n");
  // Fixture copy dirs: one per queue item, with a manifest
  // carrying copiedAt = the item's ready_at (the pickup anchor).
  const queue = f.queue.map((it) => {
    const copyDir = path.join(dir, "copies", it.issue);
    fs.mkdirSync(copyDir, { recursive: true });
    const at = typeof it.ready_at === "string" ? it.ready_at : "2026-11-22T08:00:00Z";
    fs.writeFileSync(path.join(copyDir, COPY_MANIFEST_NAME), JSON.stringify({ copiedAt: at, root: copyDir, files: {} }, null, 2) + "\n");
    return { ...it, copy: copyDir };
  });
  const queuePath = path.join(dir, "land-queue.json");
  fs.writeFileSync(queuePath, JSON.stringify({ items: queue, owner: "test", policy: {}, queue: [], throughput: {}, updated: "2026-11-22T14:00:00Z" }, null, 2) + "\n");
  const mergeReportPaths = f.reports.map((r) => {
    const issue = r.mergeId.split("-")[1];
    const elapsed = r.suiteElapsedMs ?? 0;
    const p = path.join(dir, "merge-" + issue + ".json");
    fs.writeFileSync(p, JSON.stringify(fixtureMergeReport(issue, elapsed), null, 2) + "\n");
    return p;
  });
  const workDir = path.join(dir, "work");
  fs.mkdirSync(path.join(workDir, "tmp"), { recursive: true });
  return { dir, stateDir, workDir, queuePath, mergeReportPaths, backlogPath: path.join(dir, "BACKLOG.md") };
}

/** The shared project config for §D cases (stateDir is the case's
 * scratch state dir — the ledger/baselines the workflow reads). */
function testProject(stateDir: string, workDir: string): BottleneckDetectProjectConfig {
  return {
    linearProject: "P-BRA-2",
    repo: COPY_ROOT,
    stateDir,
    workDir,
    resumeDir: path.join(WORKDIR, "project-resume"),
  };
}

/** Build a bottleneck-detect input for one case. */
function caseInput(c: CasePaths, extra: Record<string, any> = {}): BottleneckDetectInput {
  return {
    project: testProject(c.stateDir, c.workDir),
    run: {
      bottleneckId: "bottleneck-2026-11-22",
      date: DATE,
      queuePath: c.queuePath,
      mergeReportPaths: c.mergeReportPaths,
      backlogPath: c.backlogPath,
      now: NOW,
      ...extra,
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
  };
}

function validInput(): BottleneckDetectInput {
  return {
    project: testProject(STATE_DIR, path.join(WORKDIR, "valid")),
    run: {
      bottleneckId: "bottleneck-2026-11-22",
      date: DATE,
      queuePath: path.join(WORKDIR, "q.json"),
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
      const r = cli(["check", BOTTLENECK_DETECT, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on bottleneck-detect.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("detectBottleneck(BottleneckDetectInput)"), `CHECK OK: entry is detectBottleneck(BottleneckDetectInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure units
    console.log("\n=== §C pure units ===");
    {
      // ---- validateBottleneckDetectInput: valid + every guard.
      check(validateBottleneckDetectInput(validInput()).length === 0, "C OK: valid input passes validation");
      const noOwner = validInput();
      delete (noOwner as Record<string, any>).owner;
      check(
        validateBottleneckDetectInput(noOwner).some((e) => e === "bottleneck-detect: owner is required"),
        "C OK: absent owner refused with the exact string",
      );
      const noRun = { project: testProject(STATE_DIR, path.join(WORKDIR, "x")), owner: IMPL_OWNER } as unknown as BottleneckDetectInput;
      check(validateBottleneckDetectInput(noRun).includes("bottleneck-detect: input has no run object"), "C OK: missing run object refused");
      const badDate = validInput();
      badDate.run.date = "2026-13-01";
      check(validateBottleneckDetectInput(badDate).includes("bottleneck-detect: run.date must be a YYYY-MM-DD date string"), "C OK: impossible date refused");
      const noQueuePath = validInput();
      delete (noQueuePath.run as Record<string, any>).queuePath;
      check(validateBottleneckDetectInput(noQueuePath).includes("bottleneck-detect: run.queuePath is required"), "C OK: missing queuePath refused");
      const badCost = validInput();
      (badCost.run as Record<string, any>).fixCostMs = -1;
      check(validateBottleneckDetectInput(badCost).includes("bottleneck-detect: run.fixCostMs must be a non-negative number"), "C OK: negative fixCostMs refused");
      const badProbZero = validInput();
      (badProbZero.run as Record<string, any>).fixProbability = 0;
      check(validateBottleneckDetectInput(badProbZero).includes("bottleneck-detect: run.fixProbability must be a number in (0, 1]"), "C OK: fixProbability 0 refused");
      const badProbHigh = validInput();
      (badProbHigh.run as Record<string, any>).fixProbability = 1.5;
      check(validateBottleneckDetectInput(badProbHigh).includes("bottleneck-detect: run.fixProbability must be a number in (0, 1]"), "C OK: fixProbability 1.5 refused");
      const badPaths = validInput();
      (badPaths.run as Record<string, any>).mergeReportPaths = ["ok.json", 7];
      check(validateBottleneckDetectInput(badPaths).includes("bottleneck-detect: run.mergeReportPaths must be an array of path strings"), "C OK: non-string mergeReportPaths entry refused");

      // ---- decomposeItem: full / clamped residual / incomplete.
      {
        const full = decomposeItem({ issue: "BRA-301", title: "", status: "landed", counted: true, landed: true, landedAt: "2026-11-22T12:00:00Z", pickup: "2026-11-22T08:00:00Z", pickupSource: "manifest", pickupToLandedMs: 14_400_000, verifyMs: 4_800_000, typecheckPassed: true, closeMs: 1_800_000, buildMs: 4_800_000 });
        check(full.queueWaitMs === 4_800_000 && full.queueWaitClamped === false, `C OK: full decomposition residuals 4,800,000 ms (got ${full.queueWaitMs})`);
        const overlap = decomposeItem({ issue: "BRA-401", title: "", status: "landed", counted: true, landed: true, landedAt: "2026-11-22T12:00:00Z", pickup: "2026-11-22T08:00:00Z", pickupSource: "manifest", pickupToLandedMs: 10_000_000, verifyMs: 6_000_000, typecheckPassed: true, closeMs: null, buildMs: 6_000_000 });
        check(overlap.queueWaitMs === 0 && overlap.queueWaitClamped === true, `C OK: overlapping runs clamp queue-wait at 0 (got ${overlap.queueWaitMs}, clamped=${overlap.queueWaitClamped})`);
        const incomplete = decomposeItem({ issue: "BRA-303", title: "", status: "ready", counted: false, landed: false, landedAt: null, pickup: null, pickupSource: null, pickupToLandedMs: null, verifyMs: null, typecheckPassed: null, closeMs: null, buildMs: null });
        check(incomplete.queueWaitMs === null && incomplete.queueWaitClamped === false, "C OK: incomplete decomposition has no queue-wait");
      }

      // ---- slowestWorkflowOf.
      {
        const entries: LedgerEntryLite[] = [
          { runId: "run-a-1", workflow: "fast", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T08:10:00Z", wallMs: 600_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
          { runId: "run-b-1", workflow: "slow", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T09:00:00Z", wallMs: 3_600_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
          { runId: "run-b-2", workflow: "slow", status: "done", adapter: "direct", startedAt: "2026-11-22T09:00:00Z", finishedAt: "2026-11-22T10:00:00Z", wallMs: 3_600_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
          { runId: "run-c-1", workflow: "slow", status: "failed", adapter: "direct", startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T10:05:00Z", wallMs: 9_000_000, gateHoldMs: 0, traps: 1, tokensTotal: null },
        ];
        check(slowestWorkflowOf(entries, "2026-11-22T00:00:00.000Z", "2026-11-23T00:00:00.000Z") === "slow", "C OK: slowest workflow is the one with the highest median active wall (failed runs excluded)");
        check(slowestWorkflowOf([], "2026-11-22T00:00:00.000Z", "2026-11-23T00:00:00.000Z") === null, "C OK: slowest workflow is null with no done runs");
      }

      // ---- identifyBottleneck: machine-down / build / queue-wait /
      // merge / none / unknown.
      const normalFile = deriveFixture(fixtureNormal(), { checked: true, ok: true });
      const normal = identifyBottleneck({ file: normalFile, entries: fixtureNormal().entries });
      check(normal.kind === "none", `C OK: thirds across the board is none (got ${normal.kind}: ${normal.detail})`);
      check(normal.share !== null && Math.abs(normal.share - 1 / 3) < 0.001, `C OK: none carries the largest share 1/3 (got ${normal.share})`);
      const buildFile = deriveFixture(fixtureBuild(), { checked: true, ok: true });
      const build = identifyBottleneck({ file: buildFile, entries: fixtureBuild().entries });
      check(build.kind === "build" && build.share === 0.6, `C OK: build bottleneck at share 0.6 (got ${build.kind}/${build.share})`);
      check(build.slowestWorkflow === "build-workflow", `C OK: build names the slowest workflow (got ${build.slowestWorkflow})`);
      check(build.medianPickupToLandedMs === 13_200_000 && build.itemsBlocked === 2, `C OK: build carries median 13,200,000 + 2 blocked (got ${build.medianPickupToLandedMs}/${build.itemsBlocked})`);
      // Queue-wait dominates: pickup 10M, build 2M, verify 2M.
      const queueFile = deriveFixture(
        {
          entries: [{ runId: "run-bra501-build", workflow: "w", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T08:20:00Z", wallMs: 2_000_000, gateHoldMs: 0, traps: 1, tokensTotal: null }],
          queue: [{ issue: "BRA-501", title: "q", status: "landed", ready_at: "2026-11-22T08:00:00Z", landed_at: "2026-11-22T10:46:40Z", notes: "closed 2026-11-22T11:00:00Z" }],
          reports: [{ mergeId: "merge-bra501-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 2_000_000 }],
        },
        { checked: true, ok: true },
      );
      const queueWait = identifyBottleneck({ file: queueFile, entries: [{ runId: "run-bra501-build", workflow: "w", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T08:20:00Z", wallMs: 2_000_000, gateHoldMs: 0, traps: 1, tokensTotal: null }] });
      check(queueWait.kind === "queue-wait" && queueWait.share === 0.6, `C OK: queue-wait bottleneck at share 0.6 (got ${queueWait.kind}/${queueWait.share})`);
      // Merge dominates: pickup 10M, build 2M, verify 6M.
      const mergeFile = deriveFixture(
        {
          entries: [{ runId: "run-bra502-build", workflow: "w", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T08:20:00Z", wallMs: 2_000_000, gateHoldMs: 0, traps: 1, tokensTotal: null }],
          queue: [{ issue: "BRA-502", title: "m", status: "landed", ready_at: "2026-11-22T08:00:00Z", landed_at: "2026-11-22T10:46:40Z", notes: "closed 2026-11-22T11:00:00Z" }],
          reports: [{ mergeId: "merge-bra502-20261122", verdict: "merged", typecheckPassed: true, suiteElapsedMs: 6_000_000 }],
        },
        { checked: true, ok: true },
      );
      const merge = identifyBottleneck({ file: mergeFile, entries: [{ runId: "run-bra502-build", workflow: "w", status: "done", adapter: "direct", startedAt: "2026-11-22T08:00:00Z", finishedAt: "2026-11-22T08:20:00Z", wallMs: 2_000_000, gateHoldMs: 0, traps: 1, tokensTotal: null }] });
      check(merge.kind === "merge" && merge.share === 0.6, `C OK: merge bottleneck at share 0.6 (got ${merge.kind}/${merge.share})`);
      // Unknown: no items at all.
      const emptyFile = deriveFixture({ entries: [], queue: [], reports: [] }, { checked: true, ok: true });
      const unknown = identifyBottleneck({ file: emptyFile, entries: [] });
      check(unknown.kind === "unknown", `C OK: no items means unknown (got ${unknown.kind})`);
      // Machine-down overrides: empty ledger + dead server, two
      // items waiting.
      const downFile = deriveFixture(
        {
          entries: [],
          queue: [
            { issue: "BRA-303", title: "w1", status: "ready", ready_at: "2026-11-22T06:00:00Z" },
            { issue: "BRA-304", title: "w2", status: "blocked", ready_at: "2026-11-22T13:30:00Z" },
          ],
          reports: [],
        },
        { checked: true, ok: false, reason: "/health did not answer ok" },
      );
      const down = identifyBottleneck({ file: downFile, entries: [] });
      check(down.kind === "machine-down" && down.share === 1.0 && down.itemsBlocked === 2, `C OK: machine-down overrides at share 1.0 with 2 blocked (got ${down.kind}/${down.share}/${down.itemsBlocked})`);
      check(down.medianPickupToLandedMs === null, "C OK: machine-down carries no measurable median");

      // ---- pending_qa + skipped-with-reason (fix round, Nov 22 —
      // Landing ruling ~03:38 PST). A "pending_qa" entry is counted as
      // pending and shown as awaiting Quality — NOT landed, NOT stalled
      // — and 248's decomposition still runs on the remaining
      // items. An entry whose only defect is an unknown status is
      // skipped and named in the derived file's missing sources.
      const pendingQaFile = deriveFixture(
        {
          entries: [],
          queue: [
            { issue: "BRA-601", title: "in Quality", status: "pending_qa", ready_at: "2026-11-22T11:17:44Z" },
            { issue: "BRA-602", title: "stalled ready", status: "ready", ready_at: "2026-11-22T06:00:00Z" },
          ],
          reports: [],
        },
        { checked: true, ok: true },
      );
      check(pendingQaFile.pendingQa.length === 1 && pendingQaFile.pendingQa[0].issue === "BRA-601", `C OK: pendingQa lists BRA-601 (got ${JSON.stringify(pendingQaFile.pendingQa)})`);
      check(pendingQaFile.stalled.length === 1 && pendingQaFile.stalled[0].issue === "BRA-602", `C OK: stalled is [BRA-602] — the pending_qa entry is not stalled (got ${JSON.stringify(pendingQaFile.stalled)})`);
      check(pendingQaFile.totals.landings === 0, `C OK: a pending_qa entry is not a landing (got ${pendingQaFile.totals.landings})`);
      const pendingQaFinding = identifyBottleneck({ file: pendingQaFile, entries: [] });
      check(pendingQaFinding.kind === "unknown", `C OK: no decomposable items means unknown, not a false bottleneck (got ${pendingQaFinding.kind})`);
      const lenient248 = validateQueueFileForRead({ items: [
        { issue: "BRA-601", title: "in Quality", status: "pending_qa" },
        { issue: "BRA-603", title: "typo", status: "flying" },
      ] });
      check(lenient248.errors.length === 0 && lenient248.skipped.length === 1 && lenient248.skipped[0].issue === "BRA-603", `C OK: the lenient read skips only the unknown-status entry (got ${JSON.stringify(lenient248.skipped)})`);
      const skippedFile248 = deriveFixture(
        {
          entries: [],
          queue: [{ issue: "BRA-602", title: "stalled ready", status: "ready", ready_at: "2026-11-22T06:00:00Z" }],
          reports: [],
          queueSkipped: [{ issue: "BRA-603", status: "flying", reason: "land-queue: queue item BRA-603 has unknown status \"flying\"" }],
        },
        { checked: true, ok: true },
      );
      check(skippedFile248.missing.some((m) => m.source === "queue:BRA-603" && m.reason.includes("unknown status") && m.reason.includes("skipped")), `C OK: the skipped entry rides the missing sources (got ${JSON.stringify(skippedFile248.missing)})`);
      check(!skippedFile248.items.some((i) => i.issue === "BRA-603"), "C OK: the skipped entry has no item line");

      // ---- evaluateP0Bar: passes / fails / unevaluable / machine-down.
      const barPass = evaluateP0Bar({ finding: build, fixCostMs: 3_600_000, fixProbability: 1 });
      check(barPass.passes === true && barPass.etaSavingMs === 15_840_000, `C OK: build bar passes with ETA saving 15,840,000 ms (got ${barPass.etaSavingMs}, passes=${barPass.passes})`);
      const barFail = evaluateP0Bar({ finding: build, fixCostMs: 20_000_000, fixProbability: 1 });
      check(barFail.passes === false, `C OK: build bar fails when the cost beats the saving (got ${barFail.reason})`);
      const barProb = evaluateP0Bar({ finding: build, fixCostMs: 3_600_000, fixProbability: 0.1 });
      check(barProb.passes === false && barProb.expectedSavingMs === 1_584_000, `C OK: probability 0.1 drops the expected saving to 1,584,000 (got ${barProb.expectedSavingMs})`);
      const barNoCost = evaluateP0Bar({ finding: build });
      check(barNoCost.passes === false && barNoCost.reason.includes("no fix cost"), `C OK: no fix cost makes the bar unevaluable (got ${barNoCost.reason})`);
      const barNone = evaluateP0Bar({ finding: normal, fixCostMs: 1_000 });
      check(barNone.passes === false && barNone.reason.includes("nothing to file"), `C OK: none files nothing (got ${barNone.reason})`);
      const barDown = evaluateP0Bar({ finding: down, fixCostMs: 3_600_000, fixProbability: 1 });
      check(barDown.passes === true && barDown.etaSavingMs === null && barDown.reason.includes("met by construction"), `C OK: machine-down with no median passes by construction (got ${barDown.reason})`);
      const barDownNoCost = evaluateP0Bar({ finding: down });
      check(barDownNoCost.passes === false, "C OK: machine-down without a fix cost is unevaluable");

      // ---- bottleneckTitleAndArea + renderP0Entry.
      check(bottleneckTitleAndArea("machine-down", null).title === "Machine down", "C OK: machine-down title");
      check(bottleneckTitleAndArea("merge", null).title === "Merge bandwidth bottleneck", "C OK: merge title");
      check(bottleneckTitleAndArea("queue-wait", null).title === "Queue wait bottleneck", "C OK: queue-wait title");
      check(bottleneckTitleAndArea("build", "build-workflow").area.includes("build-workflow"), "C OK: build area names the slowest workflow");
      {
        const entry = renderP0Entry({ finding: build, bar: barPass, date: DATE, source: "test run" });
        check(entry.heading === "## Unfiled: Build time bottleneck (P0, 2026-11-22)", `C OK: P0 heading carries title + P0 + date (got ${entry.heading})`);
        check(entry.marker === "fleet-ops-p0: build/2026-11-22", `C OK: P0 marker is fleet-ops-p0: build/2026-11-22 (got ${entry.marker})`);
        check(entry.body.includes("fleet-ops-p0: build/2026-11-22") && entry.body.includes("15840000 ms"), "C OK: P0 body carries the marker + the ETA saving in ms");
        check(entry.body.includes("ETA saving") && entry.body.includes("**Resolved:**"), "C OK: P0 body carries the numbers + the Resolved instruction");
        check(entry.body.includes("Parent:** BRA-248"), "C OK: P0 body names parent BRA-248");
      }

      // ---- p0EntryReadScript + findOpenP0, run through sh.
      {
        const backlog = path.join(WORKDIR, "fixture-backlog.md");
        fs.writeFileSync(
          backlog,
          [
            "# Backlog",
            "",
            "## Unfiled: Machine down (P0, 2026-11-22)",
            "",
            "- **Marker:** fleet-ops-p0: machine-down/2026-11-22.",
            "- **Bottleneck:** machine down.",
            "",
            "## Unfiled: Build time bottleneck (P0, 2026-11-21)",
            "",
            "- **Marker:** fleet-ops-p0: build/2026-11-21.",
            "- **Resolved:** fixed by restarting the worker.",
            "",
            "## Unfiled: Something else (Low)",
            "",
            "- **Marker:** fleet-ops-p0: build/2026-11-20.",
            "",
          ].join("\n"),
        );
        const script = p0EntryReadScript(backlog, "Machine down");
        const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
        check(r.status === 0, `C OK: P0 read script exits 0 (got ${r.status})`);
        const found = findOpenP0(r.stdout ?? "", "machine-down");
        check(found.length === 1 && found[0].resolved === false && found[0].marker === "fleet-ops-p0: machine-down/2026-11-22", `C OK: open machine-down P0 found unanswered (got ${JSON.stringify(found)})`);
        const scriptB = p0EntryReadScript(backlog, "Build time bottleneck");
        const rB = spawnSync("/bin/sh", ["-c", scriptB], { encoding: "utf8" });
        const foundB = findOpenP0(rB.stdout ?? "", "build");
        check(foundB.length === 1 && foundB[0].resolved === true, `C OK: resolved build P0 found answered (got ${JSON.stringify(foundB)})`);
        const scriptNone = p0EntryReadScript(backlog, "Queue wait bottleneck");
        const rNone = spawnSync("/bin/sh", ["-c", scriptNone], { encoding: "utf8" });
        check(findOpenP0(rNone.stdout ?? "", "queue-wait").length === 0, "C OK: no queue-wait P0 found");
      }

      // ---- buildBottleneckDetectReport.
      {
        const rep = buildBottleneckDetectReport({
          bottleneckId: "bottleneck-2026-11-22", verdict: "filed", dryRun: false, owner: IMPL_OWNER, date: DATE, windowDays: 1,
          bottleneck: build, bar: barPass, filed: true, filedMarker: "fleet-ops-p0: build/2026-11-22", filedHeading: "## Unfiled: Build time bottleneck (P0, 2026-11-22)",
        });
        check(rep.verdict === "filed" && rep.filed === true && rep.knownLimit === BOTTLENECK_DETECT_KNOWN_LIMIT, "C OK: buildBottleneckDetectReport carries the verdict + filing + known limit");
      }
    }

    // --------------------------------------------- §D live runs
    console.log("\n=== §D live runs ===");
    {
      // ---- D-248a machine-bottleneck P0 filing.
      const m = buildCase("D-248a-machine-down", { entries: [], queue: [
        { issue: "BRA-303", title: "w1", status: "ready", ready_at: "2026-11-22T06:00:00Z" },
        { issue: "BRA-304", title: "w2", status: "blocked", ready_at: "2026-11-22T13:30:00Z" },
      ], reports: [] }, "test-workflow");
      const mOut = driveDetect("bd-a", caseInput(m, { serverUrl: "http://127.0.0.1:1", fixCostMs: 3_600_000, fixProbability: 1 }));
      if (mOut) {
        check(mOut.verdict === "filed", `D-248a OK: verdict filed (got ${mOut.verdict})`);
        check(mOut.filed === true, "D-248a OK: filed true");
        check(mOut.filedMarker === "fleet-ops-p0: machine-down/2026-11-22", `D-248a OK: marker fleet-ops-p0: machine-down/2026-11-22 (got ${mOut.filedMarker})`);
        check(mOut.filedHeading === "## Unfiled: Machine down (P0, 2026-11-22)", `D-248a OK: heading names Machine down P0 2026-11-22 (got ${mOut.filedHeading})`);
        check((mOut.bottleneck as any).kind === "machine-down" && (mOut.bottleneck as any).itemsBlocked === 2, `D-248a OK: bottleneck machine-down with 2 blocked (got ${JSON.stringify(mOut.bottleneck)})`);
        const backlog = read(m.backlogPath);
        check(backlog !== null && backlog.includes("## Unfiled: Machine down (P0, 2026-11-22)") && backlog.includes("fleet-ops-p0: machine-down/2026-11-22"), "D-248a OK: the entry is on disk in the scratch BACKLOG.md");
        check(backlog !== null && backlog.includes("throughput zero") && backlog.includes("**Resolved:**"), "D-248a OK: the entry names zero throughput + the Resolved instruction");
      }

      // ---- D-248b not-the-machine reports-not-files.
      const n = buildCase("D-248b-none", fixtureNormal(), "test-workflow");
      const nOut = driveDetect("bd-b", caseInput(n, { fixCostMs: 3_600_000, fixProbability: 1 }));
      if (nOut) {
        check(nOut.verdict === "checked", `D-248b OK: verdict checked (got ${nOut.verdict})`);
        check(nOut.filed === false, "D-248b OK: filed false");
        check((nOut.bottleneck as any).kind === "none", `D-248b OK: bottleneck none (got ${(nOut.bottleneck as any).kind})`);
        check(!fs.existsSync(n.backlogPath), "D-248b OK: no backlog file written");
        check(Array.isArray(nOut.notes) && (nOut.notes as string[]).some((x) => x.includes("no filing")), "D-248b OK: the report names no filing");
      }

      // ---- D-248c build P0: file, second run no-op, resolve, re-file.
      const b = buildCase("D-248c-build", fixtureBuild(), "build-workflow");
      const countMarkers = (): number => {
        const t = read(b.backlogPath);
        return t === null ? 0 : (t.match(/fleet-ops-p0: build\/2026-11-22/g) ?? []).length;
      };
      const b1 = driveDetect("bd-c1", caseInput(b, { fixCostMs: 3_600_000, fixProbability: 1 }));
      if (b1) {
        check(b1.verdict === "filed", `D-248c OK: first run verdict filed (got ${b1.verdict})`);
        check(b1.filed === true && b1.filedMarker === "fleet-ops-p0: build/2026-11-22", `D-248c OK: first run filed build P0 (got ${b1.filedMarker})`);
        check(countMarkers() === 1, `D-248c OK: one marker on disk after the first filing (got ${countMarkers()})`);
        check((b1.bottleneck as any).slowestWorkflow === "build-workflow", `D-248c OK: filing names slowest workflow build-workflow (got ${JSON.stringify(b1.bottleneck)})`);
      }
      const b2 = driveDetect("bd-c2", caseInput(b, { fixCostMs: 3_600_000, fixProbability: 1 }));
      if (b2) {
        check(b2.verdict === "checked", `D-248c OK: second run verdict checked (got ${b2.verdict})`);
        check(b2.filed === false, "D-248c OK: second run filed nothing");
        check((b2.openP0 as any)?.marker === "fleet-ops-p0: build/2026-11-22" && (b2.openP0 as any)?.resolved === false, `D-248c OK: second run rides the open P0 (got ${JSON.stringify(b2.openP0)})`);
        check(countMarkers() === 1, `D-248c OK: still one marker on disk after the no-op (got ${countMarkers()})`);
      }
      // Resolve the open P0 (a human answers it with a Resolved line).
      {
        const t = read(b.backlogPath) ?? "";
        const resolved = t.replace(
          "- **Marker:** fleet-ops-p0: build/2026-11-22.",
          "- **Marker:** fleet-ops-p0: build/2026-11-22.\n- **Resolved:** build-workflow sped up; the share is below 0.5 now.",
        );
        fs.writeFileSync(b.backlogPath, resolved);
        check(resolved.includes("- **Resolved:** build-workflow sped up"), "D-248c OK: the P0 is resolved on disk");
      }
      const b3 = driveDetect("bd-c3", caseInput(b, { fixCostMs: 3_600_000, fixProbability: 1 }));
      if (b3) {
        check(b3.verdict === "filed", `D-248c OK: third run verdict filed after the resolve (got ${b3.verdict})`);
        check(b3.filed === true, "D-248c OK: third run filed again");
        check(countMarkers() === 2, `D-248c OK: two markers on disk after the re-filing (got ${countMarkers()})`);
      }

      // ---- D-248d dry-run.
      const d = buildCase("D-248d-dry-run", { entries: [], queue: [
        { issue: "BRA-303", title: "w1", status: "ready", ready_at: "2026-11-22T06:00:00Z" },
      ], reports: [] }, "test-workflow");
      const dOut = driveDetect("bd-d", caseInput(d, { serverUrl: "http://127.0.0.1:1", fixCostMs: 3_600_000, dryRun: true }));
      if (dOut) {
        check(dOut.verdict === "dry-run", `D-248d OK: verdict dry-run (got ${dOut.verdict})`);
        check(dOut.dryRun === true && dOut.filed === false, "D-248d OK: dryRun true, filed false");
        check(!fs.existsSync(d.backlogPath), "D-248d OK: dry-run writes no backlog file");
        check(Array.isArray(dOut.notes) && (dOut.notes as string[]).some((x) => x.includes("would file a P0")), `D-248d OK: dry-run names the P0 it would file (got ${JSON.stringify(dOut.notes)})`);
      }

      // ---- D-248e cancel (bra210a case-H shape).
      const k = buildCase("D-248e-cancel", fixtureNormal(), "test-workflow");
      const cancelStateDir = path.join(k.dir, "cancel-state");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(path.join(cancelStateDir, "queue.json"), JSON.stringify([{ runId: "bd-e", status: "cancelled" }]));
      const kInput = caseInput(k, { fixCostMs: 3_600_000 });
      kInput.project.stateDir = cancelStateDir;
      kInput.run.runId = "bd-e";
      const kOut = driveDetect("bd-e", kInput);
      if (kOut) {
        check(kOut.verdict === "failed", `D-248e OK: verdict failed for the cancelled run (got ${kOut.verdict})`);
        check(kOut.cancelChecked === true && kOut.cancelled === true, `D-248e OK: cancelChecked true + cancelled true (got ${kOut.cancelChecked}/${kOut.cancelled})`);
        check((kOut.notes as string[]).some((x) => x.includes("is cancelled")), `D-248e OK: refusal names the cancellation (got ${JSON.stringify(kOut.notes)})`);
        check(!fs.existsSync(k.backlogPath), "D-248e OK: cancelled run writes nothing");
      }

      // ---- D-248f cross-check against 247's report (all dry-run).
      const f = buildCase("D-248f-cross-check", fixtureBuild(), "build-workflow");
      const throughputPath = path.join(f.dir, "throughput-2026-11-22.json");
      const agreeing = deriveFixture(fixtureBuild(), { checked: true, ok: true });
      fs.writeFileSync(throughputPath, JSON.stringify(agreeing, null, 2) + "\n");
      const f1 = driveDetect("bd-f1", caseInput(f, { throughputReportPath: throughputPath, fixCostMs: 3_600_000, dryRun: true }));
      if (f1) {
        check(f1.verdict === "dry-run", `D-248f OK: agreeing run verdict dry-run (got ${f1.verdict})`);
        check(Array.isArray(f1.notes) && (f1.notes as string[]).some((x) => x.includes("cross-check agrees")), `D-248f OK: agreeing report cross-checks (got ${JSON.stringify(f1.notes)})`);
      }
      const tampered = { ...agreeing, totals: { ...agreeing.totals, tasksCompleted: 99 } };
      fs.writeFileSync(throughputPath, JSON.stringify(tampered, null, 2) + "\n");
      const f2 = driveDetect("bd-f2", caseInput(f, { throughputReportPath: throughputPath, fixCostMs: 3_600_000, dryRun: true }));
      if (f2) {
        check(Array.isArray(f2.notes) && (f2.notes as string[]).some((x) => x.includes("MISMATCH")), `D-248f OK: tampered report names the MISMATCH (got ${JSON.stringify(f2.notes)})`);
        check(f2.verdict === "dry-run", `D-248f OK: tampered run still completes as dry-run (got ${f2.verdict})`);
      }
      fs.writeFileSync(throughputPath, "{not json\n");
      const f3 = driveDetect("bd-f3", caseInput(f, { throughputReportPath: throughputPath, fixCostMs: 3_600_000, dryRun: true }));
      if (f3) {
        check(Array.isArray(f3.notes) && (f3.notes as string[]).some((x) => x.includes("derived from the sources")), `D-248f OK: malformed report falls back to deriving from the sources (got ${JSON.stringify(f3.notes)})`);
      }

      // ---- D-248g live queue file (fix round, Nov 22): a COPY of
      // the live land-queue.json drives end to end. The copy's
      // pending_qa entry is named as awaiting Quality (not skipped);
      // a second entry with a genuinely unknown status is
      // skipped-with-reason and named. The live file itself is
      // never driven as test input — the copy is made first, and
      // the case asserts only the pending / skip naming, never the
      // live file's totals (they move). No fixture merge report
      // matches a live issue, so nothing decomposes: the verdict
      // is "checked", nothing filed.
      const liveQueuePath = path.join(os.homedir(), "workspace", "goals", "agentts-r2-milestone", "hidden_files", "land-queue.json");
      const liveQueue = JSON.parse(fs.readFileSync(liveQueuePath, "utf8")) as { items: any[] };
      let pendingQaIssue248 = (liveQueue.items.find((it) => it.status === "pending_qa") as any)?.issue as string | undefined;
      const g = buildCase("D-248g-live-queue", { entries: [], queue: [], reports: [] }, "test-workflow");
      if (pendingQaIssue248 === undefined) {
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
        pendingQaIssue248 = "BRA-247/248";
        const existing = (liveQueue.items.find((it) => it.issue === pendingQaIssue248) as any) ?? undefined;
        if (existing !== undefined) existing.status = "pending_qa";
        else liveQueue.items.push({ issue: pendingQaIssue248, title: "Synthetic pending_qa (the live entry landed)", status: "pending_qa", ready_at: "2026-11-22T11:17:44Z" });
      }
      liveQueue.items.push({ issue: "BRA-999", title: "Unknown status", status: "flying", ready_at: "2026-11-22T11:00:00Z" });
      fs.writeFileSync(g.queuePath, JSON.stringify(liveQueue, null, 2) + "\n");
      const gOut = driveDetect("bd-g", caseInput(g, { fixCostMs: 3_600_000, fixProbability: 1 }));
      if (gOut) {
        check(gOut.verdict === "checked", `D-248g OK: verdict checked on the live-queue copy (got ${gOut.verdict})`);
        check(gOut.filed === false, `D-248g OK: nothing filed (got filed=${gOut.filed})`);
        check((gOut.bottleneck as any).kind === "unknown", `D-248g OK: bottleneck unknown with nothing decomposed (got ${(gOut.bottleneck as any).kind})`);
        check(Array.isArray(gOut.notes) && (gOut.notes as string[]).some((x) => x.includes("awaiting Quality") && x.includes(pendingQaIssue248 as string)), `D-248g OK: the report names ${pendingQaIssue248} as awaiting Quality (got ${JSON.stringify(gOut.notes)})`);
        check(Array.isArray(gOut.notes) && (gOut.notes as string[]).some((x) => x.includes("skipped 1 queue entry") && x.includes("BRA-999")), `D-248g OK: the report names the skipped entry (got ${JSON.stringify(gOut.notes)})`);
        check(!fs.existsSync(g.backlogPath), "D-248g OK: no backlog file written");
      }
    }

    console.log("\nPASS bottleneck-detect workflow (inventory check, agentts check, pure unit checks, live scratch-project runs D-248a–D-248g — all through the CLI on direct)");
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
