// test-bra263 — test-batching workflow suite (BRA-263).
//
// The batcher verifies a stack of changes passes together
// without re-verifying each change from scratch.
//
// §A inventory check: workflows/library/test-batching.ts
//     registered in suite-inventory.json (slug "test-batching",
//     tier 1), and run.sh carries a section for it.
// §B `agentts check`: batchTests(BatchTestsInput):
//     BatchTestsReport, a clean workflow with no errors, no
//     unused imports, no unknown job() types, no trap-cap
//     violations.
// §C pure units: validateBatchTestsInput (null run, empty
//     changes, a change with no suites, a duplicate changeId,
//     missing owner — all refused loudly; a valid input passes);
//     appendSuiteResult (appends; a duplicate (changeId, suite)
//     throws); parseBatchState (round-trips; malformed text
//     throws); batchSuiteScript shape (run.sh --bash --only,
//     output to the log file, RUNSH rc line, section-row grep,
//     no Buffer); parseSuiteRunOutput (rc + row; missing rc
//     throws; a row-less output parses with sectionRow null);
//     batchStateWriteScript / batchStateReadScript /
//     batchStateDecodeScript shapes; buildBatchTestsReport
//     (all-passed → passed + stackPassed; one failure → failed
//     with the failing change + suite named; dry-run).
// §D live CLI runs on `direct` (a throwaway worker server on a
//     random port, never production port 18741): D-263a a batch
//     of two changes — one passing (the real copy, land-queue
//     suite) and one failing (a sabotaged copy, rebase suite) —
//     per-change results plus the stack verdict naming the
//     failing change + suite; D-263b the same batch resumed
//     (same batchId, same resumeDir) skips both recorded suites
//     and the logs are byte-identical; D-263c dry-run writes
//     nothing; D-263d cancel; D-263e a single passing change
//     passes the stack. Every §D case asserts the report AND
//     the on-disk outcome separately. All writes to scratch
//     dirs, never live.
//
// No mock server here: the §D cases drive the real workflow
// through the real worker server on a random port, and the
// batcher runs real run.sh sections against real copies.
//
// Run: `bun tests/test-bra263.ts` (BRA263_WORKDIR env or
// /tmp/bra263). Needs DQUICKTS=$HOME/workspace/dquickts-build-minimal
// for the C host build.

import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BatchTestsInput, BatchTestsReport, BatchState, BatchSuiteResult } from "../workflows/library/test-batching";
import {
  validateBatchTestsInput,
  appendSuiteResult,
  parseBatchState,
  batchSuiteScript,
  parseSuiteRunOutput,
  batchStateWriteScript,
  batchStateReadScript,
  batchStateDecodeScript,
  buildBatchTestsReport,
  BATCHING_KNOWN_LIMIT,
} from "../workflows/library/test-batching";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BATCHING = path.join(ROOT, "workflows", "library", "test-batching.ts");
const BUN = "/opt/hatch-image/bin/bun";
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA263_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "test-batching-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const tmpDir = path.join(WORKDIR, "tmp");
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

/** The real copy this test file lives in — the passing change. */
const GOOD_COPY = path.resolve(DIR, "../../..");

const FAILURES: string[] = [];
function check(cond: boolean, label: string) {
  console.log((cond ? " OK: " : "FAIL: ") + label);
  if (!cond) FAILURES.push(label);
}

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function testProject(stateDir: string, workDir: string): BatchTestsInput["project"] {
  return {
    linearProject: "BRA",
    repo: "/tmp/bra263-repo",
    stateDir,
    workDir,
    resumeDir: path.join(workDir, "resume"),
  };
}

function caseInput(workDir: string, batchId: string, changes: BatchTestsInput["run"]["changes"], extra?: Partial<BatchTestsInput["run"]>): BatchTestsInput {
  return {
    project: testProject(path.join(workDir, "state"), workDir),
    run: {
      batchId,
      changes,
      workDir,
      resumeDir: path.join(workDir, "resume"),
      ...(extra ?? {}),
    },
    owner: "test-session",
    launchedBy: "test-session",
  };
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
    if (Date.now() > deadline) throw new Error("test-batching server did not come up");
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

function submitBatch(runId: string, input: BatchTestsInput): boolean {
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", BATCHING,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
}

/** Drive one queue pass and return its rc (0 = clean, 1 = some
 * entry failed — the per-run signal is the run's own result,
 * not the exit code). */
function driveBatch(): number {
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--clock", "real", "--gates", "hold"]);
  if (drive.rc !== 0 && drive.rc !== 1) {
    check(false, `DRIVE OK: queue run exits ${drive.rc} (expected 0 or 1): ${(drive.out + drive.err).slice(0, 300)}`);
  }
  return drive.rc;
}

function fetchResult(runId: string): BatchTestsReport | null {
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 300)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as BatchTestsReport;
  } catch {
    check(false, `RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

function driveBatchRun(runId: string, input: BatchTestsInput): BatchTestsReport | null {
  if (!submitBatch(runId, input)) return null;
  driveBatch();
  return fetchResult(runId);
}

/** Build the sabotaged copy: a full copy of the real tree with
 * test-bra262.ts broken (its §A tier assertion flipped), so its
 * rebase section fails deterministically. */
function sabotagedCopy(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "bad-copy");
  fs.rmSync(dest, { recursive: true, force: true });
  const cp = spawnSync("cp", ["-a", GOOD_COPY, dest], { encoding: "utf8", env: { ...process.env, TMPDIR: tmpDir } });
  if (cp.status !== 0) throw new Error("cp -a failed rc=" + cp.status + ": " + (cp.stderr ?? "").slice(0, 200));
  const testPath = path.join(dest, "apps/agentts/tests/test-bra262.ts");
  const content = read(testPath);
  if (!content.includes("check(section.tier === 1,")) throw new Error("sabotage anchor not found in test-bra262.ts");
  fs.writeFileSync(testPath, content.replace("check(section.tier === 1,", "check(section.tier === 2,"));
  return dest;
}

async function main(): Promise<number> {
  // --------------------------------------------- §A inventory check
  console.log("=== §A inventory check ===");
  {
    const inventoryPath = path.resolve(import.meta.dir, "../suite-inventory.json");
    const inventory = JSON.parse(read(inventoryPath)) as { sections: { slug: string; file: string; tier: number }[] };
    const section = inventory.sections.find((s) => s.slug === "test-batching");
    check(section !== undefined, "suite-inventory.json has a test-batching section");
    if (section) {
      check(section.file === "tests/test-bra263.ts", "test-batching section points at tests/test-bra263.ts (got " + section.file + ")");
      check(section.tier === 1, "test-batching section is tier 1 (got " + section.tier + ")");
    }
    const runSh = read(path.resolve(import.meta.dir, "../run.sh"));
    check(/section test-batching 1 /.test(runSh), "run.sh carries a section test-batching line");
    check(runSh.includes("tests/test-bra263.ts"), "run.sh test-batching section runs tests/test-bra263.ts");
    check(runSh.includes('BRA263_WORKDIR="$SCRATCH/test-batching"'), "run.sh test-batching section uses BRA263_WORKDIR");
  }

  // --------------------------------------------- §B agentts check
  console.log("\n=== §B agentts check ===");
  {
    const r = cli(["check", BATCHING, "--state-dir", STATE_DIR]);
    const text = r.out + r.err;
    check(r.rc === 0, "CHECK OK: agentts check exits 0 on test-batching.ts (got " + r.rc + ": " + text.slice(0, 200) + ")");
    check(text.includes("batchTests(BatchTestsInput): BatchTestsReport"), "CHECK OK: check lists the entry batchTests(BatchTestsInput): BatchTestsReport");
    check(text.includes("CHECK OK"), "CHECK OK: check prints CHECK OK");
  }

  // --------------------------------------------- §C pure units
  console.log("\n=== §C pure units ===");
  {
    const valid: BatchTestsInput = {
      project: testProject("/tmp/bra263-state", "/tmp/bra263-work"),
      run: {
        batchId: "BRA-263",
        changes: [{ changeId: "c1", copyRoot: "/tmp/c", suites: ["bra159"] }],
        workDir: "/tmp/w",
        resumeDir: "/tmp/r",
      },
      owner: "test-session",
    };
    check(validateBatchTestsInput(valid).length === 0, "C valid input passes validation");
    check(validateBatchTestsInput(null).length > 0, "C null input is refused");
    check(
      validateBatchTestsInput({ ...valid, run: { ...valid.run, changes: [] } }).some((e) => /changes is empty/.test(e)),
      "C empty changes is refused",
    );
    check(
      validateBatchTestsInput({ ...valid, run: { ...valid.run, changes: [{ changeId: "c1", copyRoot: "/tmp/c", suites: [] }] } }).some((e) => /no suites array/.test(e)),
      "C a change with no suites is refused",
    );
    check(
      validateBatchTestsInput({
        ...valid,
        run: {
          ...valid.run,
          changes: [
            { changeId: "c1", copyRoot: "/tmp/c", suites: ["bra159"] },
            { changeId: "c1", copyRoot: "/tmp/d", suites: ["bra159"] },
          ],
        },
      }).some((e) => /duplicate changeId c1/.test(e)),
      "C a duplicate changeId is refused",
    );
    check(
      validateBatchTestsInput({ ...valid, owner: "" }).some((e) => /no owner string/.test(e)),
      "C missing owner is refused",
    );

    // appendSuiteResult + parseBatchState round-trip.
    const empty: BatchState = { batchId: "BRA-263", results: [] };
    const r1: BatchSuiteResult = { changeId: "c1", suite: "bra159", passed: true, logPath: "/tmp/w/logs/c1-bra159.log", ok: 42 };
    const one = appendSuiteResult(empty, r1);
    check(one.results.length === 1 && one.results[0].ok === 42, "C appendSuiteResult appends the result");
    check(JSON.stringify(parseBatchState(JSON.stringify(one))) === JSON.stringify(one), "C parseBatchState round-trips the state");
    let dupThrew = false;
    try {
      appendSuiteResult(one, r1);
    } catch {
      dupThrew = true;
    }
    check(dupThrew, "C appendSuiteResult throws on a duplicate (changeId, suite)");
    let badThrew = false;
    try {
      parseBatchState("{not json");
    } catch {
      badThrew = true;
    }
    check(badThrew, "C parseBatchState throws on malformed text");

    // batchSuiteScript shape.
    const script = batchSuiteScript({
      dquickts: "/home/hatch/workspace/dquickts-build-minimal",
      tmpdir: "/tmp/w/tmp",
      runSh: "/tmp/c/apps/agentts/run.sh",
      suite: "bra159",
      suiteResumeDir: "/tmp/r/suites/c1-bra159",
      logPath: "/tmp/w/logs/c1-bra159.log",
    });
    check(script.includes("--bash --only 'bra159'"), "C the suite script runs run.sh --bash --only <slug>");
    check(script.includes("> '/tmp/w/logs/c1-bra159.log' 2>&1"), "C the suite script redirects output to the log file");
    check(script.includes("RUNSH rc=$rc"), "C the suite script prints the RUNSH rc line");
    check(script.includes("\"event\":\"section\""), "C the suite script greps the progress.jsonl section row");
    check(!script.includes("Buffer"), "C the suite script never uses Buffer");

    // parseSuiteRunOutput.
    const parsed = parseSuiteRunOutput("RUNSH rc=0\n{\"event\":\"section\",\"section\":\"bra159\",\"ok\":42,\"elapsed_s\":3,\"rc\":0,\"ts\":\"2026-11-22T07:00:00Z\"}\n");
    check(parsed.rc === 0 && parsed.sectionRow?.ok === 42 && parsed.sectionRow?.rc === 0, "C parseSuiteRunOutput parses rc + the section row");
    const noRow = parseSuiteRunOutput("RUNSH rc=1\n");
    check(noRow.rc === 1 && noRow.sectionRow === null, "C parseSuiteRunOutput parses a row-less failure");
    let rcThrew = false;
    try {
      parseSuiteRunOutput("nothing here\n");
    } catch {
      rcThrew = true;
    }
    check(rcThrew, "C parseSuiteRunOutput throws without the rc line");

    // State scripts shapes.
    check(batchStateWriteScript({ resumeDir: "/tmp/r", stateB64: "e30=" }).includes("batch-state.json.tmp"), "C the state write goes through a temp file");
    check(batchStateWriteScript({ resumeDir: "/tmp/r", stateB64: "e30=" }).includes("STATE-WRITTEN"), "C the state write prints STATE-WRITTEN");
    check(batchStateReadScript("/tmp/r").includes("STATE-MISSING"), "C the state read prints STATE-MISSING when absent");
    check(batchStateDecodeScript("e30=").includes("base64"), "C the state decode is base64 in-shell");

    // buildBatchTestsReport.
    const passing: BatchSuiteResult = { changeId: "c1", suite: "bra159", passed: true, logPath: "/tmp/l", ok: 42 };
    const failing: BatchSuiteResult = { changeId: "c2", suite: "bra159", passed: false, logPath: "/tmp/l2", ok: 3, note: "suite failed" };
    const passRep = buildBatchTestsReport({
      batchId: "BRA-263",
      verdict: "passed",
      dryRun: false,
      owner: "test-session",
      cancelChecked: false,
      cancelled: false,
      changes: [{ changeId: "c1", passed: true, suites: [passing] }],
      resumedSuites: 0,
    });
    check(passRep.stackPassed === true && passRep.failingChange === undefined, "C all-passed reports stackPassed with no failing change");
    const failRep = buildBatchTestsReport({
      batchId: "BRA-263",
      verdict: "failed",
      dryRun: false,
      owner: "test-session",
      cancelChecked: false,
      cancelled: false,
      changes: [
        { changeId: "c1", passed: true, suites: [passing] },
        { changeId: "c2", passed: false, suites: [failing] },
      ],
      resumedSuites: 0,
    });
    check(failRep.stackPassed === false, "C one failure fails the stack");
    check(failRep.failingChange === "c2" && failRep.failingSuite === "bra159", "C the failing change + suite are named (got " + failRep.failingChange + "/" + failRep.failingSuite + ")");
    check(failRep.notes.some((n) => /c2\/bra159/.test(n)), "C the failure is named in the notes");
    check(failRep.knownLimit === BATCHING_KNOWN_LIMIT, "C the known limit is carried verbatim");
  }

  // --------------------------------------------- §D live CLI runs
  console.log("\n=== §D live CLI runs ===");
  await startServer();
  try {
    const badCopy = sabotagedCopy(path.join(WORKDIR, "cases", "A-stack"));
    const changesA = [
      { changeId: "good-change", copyRoot: GOOD_COPY, suites: ["land-queue"] },
      { changeId: "bad-change", copyRoot: badCopy, suites: ["rebase"] },
    ];

    // ---- D-263a: a batch of two changes — one passing, one
    // failing. Per-change results plus the stack verdict naming
    // the failing change + suite. The state file records both
    // suites incrementally.
    const workA = path.join(WORKDIR, "cases", "A-stack", "work");
    const outA = driveBatchRun("run-bra263-A", caseInput(workA, "BRA-263-A", changesA));
    const stateA = path.join(workA, "resume", "batch-state.json");
    if (outA) {
      check(outA.verdict === "failed", `A verdict failed (got ${outA.verdict}: ${JSON.stringify(outA.notes)})`);
      check(outA.stackPassed === false, `A stackPassed is false`);
      check(outA.failingChange === "bad-change", `A failingChange is bad-change (got ${outA.failingChange})`);
      check(outA.failingSuite === "rebase", `A failingSuite is rebase (got ${outA.failingSuite})`);
      const good = outA.changes.find((c) => c.changeId === "good-change");
      const bad = outA.changes.find((c) => c.changeId === "bad-change");
      check(good?.passed === true, `A the good change passed`);
      check((good?.suites[0]?.ok ?? 0) > 0, `A the good suite reports an OK count (got ${good?.suites[0]?.ok})`);
      check(bad?.passed === false, `A the bad change failed`);
      check((bad?.suites[0]?.note ?? "").includes("see "), `A the bad suite names its log (got ${JSON.stringify(bad?.suites[0]?.note)})`);
      check(fs.existsSync(good?.suites[0]?.logPath ?? ""), `A the good suite's log exists on disk`);
      check(fs.existsSync(bad?.suites[0]?.logPath ?? ""), `A the bad suite's log exists on disk`);
      check(fs.existsSync(stateA), `A the state file exists after the batch`);
      if (fs.existsSync(stateA)) {
        const state = JSON.parse(read(stateA)) as BatchState;
        check(state.batchId === "BRA-263-A", `A the state carries the batchId`);
        check(state.results.length === 2, `A the state records both suites (got ${state.results.length})`);
      }
    }

    // ---- D-263b: the same batch resumed — both recorded suites
    // are skipped, and the logs are byte-identical (nothing
    // re-ran, not even the failing suite).
    const goodLogBefore = read(path.join(workA, "logs", "good-change-land-queue.log"));
    const badLogBefore = read(path.join(workA, "logs", "bad-change-rebase.log"));
    const outB = driveBatchRun("run-bra263-B", caseInput(workA, "BRA-263-A", changesA));
    if (outB) {
      check(outB.verdict === "failed", `B verdict failed on the resumed batch (got ${outB.verdict})`);
      check(outB.resumedSuites === 2, `B resumedSuites is 2 (got ${outB.resumedSuites})`);
      check(outB.failingChange === "bad-change" && outB.failingSuite === "rebase", `B the resumed batch still names the failing change + suite`);
      check(read(path.join(workA, "logs", "good-change-land-queue.log")) === goodLogBefore, `B the good suite's log is byte-identical (not re-run)`);
      check(read(path.join(workA, "logs", "bad-change-rebase.log")) === badLogBefore, `B the bad suite's log is byte-identical (the failing suite is not re-run)`);
    }

    // ---- D-263c: dry-run plans the batch and writes nothing —
    // no state file, no logs.
    const workC = path.join(WORKDIR, "cases", "C-dryrun", "work");
    const outC = driveBatchRun("run-bra263-C", caseInput(workC, "BRA-263-C", changesA, { dryRun: true }));
    if (outC) {
      check(outC.verdict === "dry-run", `C verdict dry-run (got ${outC.verdict})`);
      check(outC.changes.length === 2, `C the dry-run still plans both changes`);
      check(!fs.existsSync(path.join(workC, "resume", "batch-state.json")), `C no state file after a dry-run`);
      check(!fs.existsSync(path.join(workC, "logs", "good-change-land-queue.log")), `C no suite log after a dry-run`);
    }

    // ---- D-263d: cancel (bra210a case-H shape). The cancel
    // check reads project.stateDir/queue.json — a scratch dir
    // with a hand-crafted cancelled entry.
    const workD = path.join(WORKDIR, "cases", "D-cancel", "work");
    const cancelState = path.join(WORKDIR, "cases", "D-cancel", "cancel-state");
    fs.mkdirSync(cancelState, { recursive: true });
    fs.writeFileSync(
      path.join(cancelState, "queue.json"),
      JSON.stringify([{ runId: "run-bra263-D", status: "cancelled" }]) + "\n",
    );
    const inputD = caseInput(workD, "BRA-263-D", changesA, { runId: "run-bra263-D" });
    inputD.project = testProject(cancelState, workD);
    const outD = driveBatchRun("run-bra263-D", inputD);
    if (outD) {
      check(outD.verdict === "failed", `D verdict failed on a cancelled run (got ${outD.verdict})`);
      check(outD.cancelChecked === true, `D cancelChecked is true (got ${outD.cancelChecked})`);
      check(outD.cancelled === true, `D cancelled is true (got ${outD.cancelled})`);
      check(!fs.existsSync(path.join(workD, "resume", "batch-state.json")), `D no state file after the cancel refusal`);
    }

    // ---- D-263e: a single passing change passes the stack.
    const workE = path.join(WORKDIR, "cases", "E-pass", "work");
    const outE = driveBatchRun("run-bra263-E", caseInput(workE, "BRA-263-E", [
      { changeId: "good-change", copyRoot: GOOD_COPY, suites: ["land-queue"] },
    ]));
    if (outE) {
      check(outE.verdict === "passed", `E verdict passed (got ${outE.verdict}: ${JSON.stringify(outE.notes)})`);
      check(outE.stackPassed === true, `E stackPassed is true`);
      check(outE.changes.length === 1 && outE.changes[0].passed === true, `E the single change passed`);
    }
  } finally {
    await stopServer();
  }
  if (FAILURES.length > 0) {
    console.log(`\nFAILURES (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    return 1;
  }
  console.log("\nPASS test-bra263 (test-batching)");
  return 0;
}

main().then((rc) => {
  console.log("TEST EXIT rc=" + rc);
  process.exit(rc);
}).catch((e) => {
  console.log("TEST FAILED:", e);
  process.exit(1);
});
