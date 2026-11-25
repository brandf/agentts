// test-bra256 — the dual-report verification workflow (BRA-256).
//
//   A. The inventory check passes (suite-inventory.json agrees
//      with run.sh on the dual-report section).
//   B. `agentts check` passes on dual-report.ts (first-run gate).
//   C. Pure unit checks: validateDualReportInput (every guard),
//      suite-inventory slugs script/parse, log-tail script,
//      buildBatchChildInput, isBatchChildReport,
//      verdictFromBatch, buildDualReportPayloads,
//      buildDualReportReport.
//   D. Live CLI runs on `direct` against scratch trees — the
//      re-verification runs the fixture item's suites in a scratch
//      tree (a fake run.sh + suite-inventory.json), never the live
//      tree:
//      D-256a a fixed item re-verified end to end, verdict PASS
//        in BOTH payloads in the same run;
//      D-256b a failing item re-verified, verdict FAIL in both
//        payloads, with the failing suite + log tail;
//      D-256c an item whose suite is not a registered tier-1
//        section is unable-to-verify, reported, not dropped;
//      D-256d an item whose copy root is absent is
//        unable-to-verify, reported, not dropped;
//      D-256e an item with no owning lead goes to the Director
//        only, recorded;
//      D-256f a dry-run writes nothing and re-verifies nothing;
//      D-256g a cancelled run stops before re-verifying (the
//        bra210a case-H shape: a separate state dir with a
//        hand-crafted cancelled queue entry).
//   Every passing check prints a line containing " OK:" — run.sh
//   counts those lines for the tier-1 OK total, so every check
//   must print exactly one such line. A failing check prints
//   "FAIL: ..." (no " OK:"), so it is not counted.
//   Every §D case asserts the report AND the on-disk outcome
//   separately. All writes go to scratch dirs, never the real
//   goal files, never live, never the production state dir.
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DUAL_REPORT_KNOWN_LIMIT,
  validateDualReportInput,
  suiteInventorySlugsScript,
  parseInventorySlugs,
  logTailScript,
  buildBatchChildInput,
  isBatchChildReport,
  verdictFromBatch,
  buildDualReportPayloads,
  buildDualReportReport,
  type DualReportInput,
  type BatchChildReport,
  type DualReportReport,
  type DualReportSuiteResult,
} from "../workflows/library/dual-report";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const DUAL_REPORT = path.join(ROOT, "workflows", "library", "dual-report.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA256_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "dual-report-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const STATE_DIR = path.join(WORKDIR, "state");
// Hermetic re-runs: the queue registry keeps run IDs forever, so a
// second run against the same state dir would fail every submit as
// "already queued". Wipe our own throwaway state dir at startup.
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 22000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
/** Quality owns dual-report runs (brief: the owner is the driving session). */
const QUALITY_OWNER = "0bc9a8c5-18fa-430c-b6c4-85a54c92b209";
const IMPL_OWNER = "3e85493f-f748-4bcd-bec6-94be9c25b282";
const LBR_OWNER = "a25045a8-6678-417c-bcae-d1248594384a";
const DIRECTOR = "director";

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
    if (Date.now() > deadline) throw new Error("dual-report test server did not come up");
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

/** Drive one queue pass against a state dir and return its rc
 * (0 = clean, 1 = some entry failed — the per-run signal is the
 * run's own result, not the exit code). */
function driveQueue(stateDir: string = STATE_DIR): number {
  const drive = cli(["queue", "run", "--state-dir", stateDir, "--clock", "real", "--gates", "hold"]);
  if (drive.rc !== 0 && drive.rc !== 1) {
    fail(`DRIVE OK: queue run exits ${drive.rc} (expected 0 or 1): ${(drive.out + drive.err).slice(0, 300)}`);
  }
  return drive.rc;
}

/** Submit one dual-report run (no drive yet). */
function submitDualReport(runId: string, input: DualReportInput, stateDir: string = STATE_DIR): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", DUAL_REPORT,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", stateDir,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
}

/** Fetch one run's result (after a drive) and return the parsed
 * report, or null on a CLI failure (already recorded). */
function fetchResult(runId: string, stateDir: string = STATE_DIR): Record<string, any> | null {
  const res = cli(["result", runId, "--state-dir", stateDir]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 300)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as Record<string, any>;
  } catch {
    fail(`RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

/** Drive one dual-report input through the CLI (submit + queue
 * run + result) and return the parsed report, or null on a CLI
 * failure (the failure is already recorded as a check). */
function driveDualReport(runId: string, input: DualReportInput, stateDir: string = STATE_DIR): Record<string, any> | null {
  if (!submitDualReport(runId, input, stateDir)) return null;
  driveQueue(stateDir);
  return fetchResult(runId, stateDir);
}

// ------------------------------------------------------------------
// Fixtures: a scratch tree with a fake run.sh (the fixture suite
// writes a run.sh progress.jsonl section row and exits 0, or 1
// when the fixture-fail marker is present) + a
// suite-inventory.json registering the fixture suite as tier 1.
// Never the live tree.
// ------------------------------------------------------------------

const FIXTURE_RUN_SH = `#!/bin/sh
# Fixture run.sh: only understands --bash --only <slug> --resume-dir <dir>.
suite=""
resume=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) suite="$2"; shift 2;;
    --resume-dir) resume="$2"; shift 2;;
    *) shift;;
  esac
done
mkdir -p "$resume"
if [ -f "$(dirname "$0")/fixture-fail" ]; then
  echo "fixture suite failed: assertion 2 of 5 did not hold"
  echo "FAIL: fixture-suite assertion failed"
  printf '{"event":"section","slug":"%s","ok":3,"rc":1}\\n' "$suite" >> "$resume/progress.jsonl"
  exit 1
fi
echo "fixture suite passed: 5 checks"
printf '{"event":"section","slug":"%s","ok":5,"rc":0}\\n' "$suite" >> "$resume/progress.jsonl"
exit 0
`;

interface DualFixture {
  dir: string;
  copyRoot: string;
  workDir: string;
}

function makeFixture(name: string, failing: boolean): DualFixture {
  const dir = path.join(WORKDIR, name);
  const copyRoot = path.join(dir, "copy");
  const appsDir = path.join(copyRoot, "apps", "agentts");
  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(path.join(appsDir, "run.sh"), FIXTURE_RUN_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(appsDir, "suite-inventory.json"), JSON.stringify({
    sections: [{ slug: "fixture-suite", file: "tests/test-fixture.ts", tier: 1 }],
  }));
  if (failing) fs.writeFileSync(path.join(appsDir, "fixture-fail"), "fail\n");
  return { dir, copyRoot, workDir: path.join(dir, "work") };
}

function validInput(f: DualFixture, overrides: Record<string, any> = {}): DualReportInput {
  const input: DualReportInput = {
    project: {
      linearProject: "P-BRA-2",
      repo: "brandf/agentts",
      stateDir: STATE_DIR,
      roster: {
        implementation: IMPL_OWNER,
        director: DIRECTOR,
        landing: LBR_OWNER,
        quality: QUALITY_OWNER,
      },
      workDir: f.workDir,
      resumeDir: path.join(f.workDir, "resume"),
    },
    run: {
      reportId: "BRA-256",
      itemKey: "BRA-260-FIXTURE",
      itemTitle: "fixture push",
      owningLead: "implementation",
      suites: ["fixture-suite"],
      copyRoot: f.copyRoot,
      workDir: f.workDir,
    },
    owner: QUALITY_OWNER,
    launchedBy: "test",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (k.startsWith("project.")) (input.project as Record<string, any>)[k.slice("project.".length)] = v;
    else if (k.startsWith("run.")) (input.run as Record<string, any>)[k.slice("run.".length)] = v;
    else (input as Record<string, any>)[k] = v;
  }
  return input;
}

async function main(): Promise<number> {
  // --------------------------------------------- §A inventory
  console.log("=== §A inventory ===");
  {
    const inv = readJson(path.join(ROOT, "suite-inventory.json")) as { sections: { slug: string; file: string; tier: number }[] } | null;
    const runSh = read(path.join(ROOT, "run.sh")) ?? "";
    const slugs = (inv?.sections ?? []).filter((s) => s.tier === 1).map((s) => s.slug);
    check(inv !== null && slugs.includes("dual-report"), "A OK: suite-inventory.json has a tier-1 dual-report section");
    const dualEntry = (inv?.sections ?? []).find((s) => s.slug === "dual-report");
    check(dualEntry?.file === "tests/test-bra256.ts", `A OK: dual-report section names tests/test-bra256.ts (got ${dualEntry?.file})`);
    check(runSh.includes("section dual-report 1"), "A OK: run.sh wires the dual-report section");
    check(runSh.includes("BRA256_WORKDIR"), "A OK: run.sh passes BRA256_WORKDIR to test-bra256.ts");
  }

  // --------------------------------------------- §B agentts check
  console.log("\n=== §B agentts check ===");
  {
    const r = cli(["check", DUAL_REPORT, "--state-dir", STATE_DIR]);
    check(r.rc === 0 && r.out.includes("CHECK OK"), `B OK: agentts check passes on dual-report.ts (rc ${r.rc}: ${(r.out + r.err).slice(0, 300)})`);
  }

  // --------------------------------------------- §C pure units
  console.log("\n=== §C pure units ===");
  {
    const cf = makeFixture("c-fixture", false);
    const base = validInput(cf);
    check(validateDualReportInput(base).length === 0, "C OK: the valid input validates");
    check(validateDualReportInput(null as unknown as DualReportInput).includes("dual-report: input is not an object"), "C OK: non-object input refused");
    const noRun = structuredClone(base) as Record<string, unknown>;
    delete noRun.run;
    check(validateDualReportInput(noRun as unknown as DualReportInput).some((e) => e.includes("run is not an object")), "C OK: missing run refused");
    const noOwner = { ...base, owner: "" };
    check(validateDualReportInput(noOwner).some((e) => e.includes("owner must be a non-empty string")), "C OK: missing owner refused");
    for (const field of ["reportId", "itemKey", "copyRoot", "workDir"]) {
      const bad = structuredClone(base);
      (bad.run as Record<string, unknown>)[field] = "";
      check(validateDualReportInput(bad).some((e) => e.includes(`run.${field}`)), `C OK: missing run.${field} refused`);
    }
    const badSuites = structuredClone(base);
    (badSuites.run as Record<string, unknown>).suites = [];
    check(validateDualReportInput(badSuites).some((e) => e.includes("run.suites")), "C OK: an item with no suites refused");
    const badLead = structuredClone(base);
    (badLead.run as Record<string, unknown>).owningLead = "";
    check(validateDualReportInput(badLead).some((e) => e.includes("run.owningLead")), "C OK: an empty owningLead refused");
    const badDry = structuredClone(base);
    (badDry.run as Record<string, unknown>).dryRun = "yes";
    check(validateDualReportInput(badDry).some((e) => e.includes("run.dryRun")), "C OK: non-boolean dryRun refused");

    // Inventory slugs script/parse.
    const slugsScript = suiteInventorySlugsScript(cf.copyRoot);
    check(slugsScript.includes("suite-inventory.json"), "C OK: the slugs script reads the tree's suite-inventory.json");
    check(JSON.stringify(parseInventorySlugs("push\ndual-report\n")) === JSON.stringify(["push", "dual-report"]), "C OK: the slugs output parses to the slug list");
    try {
      parseInventorySlugs("SLUGS-MISSING /x/suite-inventory.json\n");
      fail("C OK: SLUGS-MISSING throws");
    } catch (e) {
      check((e as Error).message.includes("missing"), "C OK: SLUGS-MISSING throws");
    }
    try {
      parseInventorySlugs("SLUGS-ERROR bad json\n");
      fail("C OK: SLUGS-ERROR throws");
    } catch {
      ok("C OK: SLUGS-ERROR throws");
    }

    // Log-tail script.
    check(logTailScript("/w/x.log", 20).includes("tail -20"), "C OK: the log-tail script tails the last 20 lines");
    check(logTailScript("/w/x.log", 20).includes("TAIL-MISSING"), "C OK: the log-tail script names a missing log");

    // Child batch input: one change, the item's suites, the batch
    // dirs under the parent's workDir, the state dir shared with
    // the parent, never a dry-run.
    const batchWorkDir = path.join(cf.workDir, "batch");
    const batchResumeDir = path.join(cf.workDir, "batch-resume");
    const child = buildBatchChildInput({
      linearProject: "P-BRA-2", repo: "brandf/agentts", stateDir: STATE_DIR,
      roster: { implementation: IMPL_OWNER }, owner: QUALITY_OWNER, launchedBy: "test",
      batchId: "dual-BRA-260-FIXTURE", itemKey: "BRA-260-FIXTURE", copyRoot: cf.copyRoot,
      suites: ["fixture-suite"], batchWorkDir, batchResumeDir,
    });
    check(child.run.batchId === "dual-BRA-260-FIXTURE", "C OK: the child input carries the batch id");
    check(child.run.changes.length === 1 && child.run.changes[0].changeId === "BRA-260-FIXTURE" && child.run.changes[0].suites[0] === "fixture-suite", "C OK: the child input carries one change with the item's suites");
    check(child.run.workDir === batchWorkDir && child.run.resumeDir === batchResumeDir, "C OK: the child batch dirs sit under the parent's workDir");
    check(child.project.stateDir === STATE_DIR, "C OK: the child shares the parent's state dir");
    check(child.run.dryRun === false, "C OK: the child never dry-runs (a dry-run parent never reaches it)");
    // The `run` trap's JSON boundary refuses undefined values —
    // optional fields must be omitted, never passed as undefined.
    const bareChild = buildBatchChildInput({
      linearProject: "P-BRA-2", repo: "brandf/agentts", stateDir: STATE_DIR,
      owner: QUALITY_OWNER,
      batchId: "dual-BRA-260-FIXTURE", itemKey: "BRA-260-FIXTURE", copyRoot: cf.copyRoot,
      suites: ["fixture-suite"], batchWorkDir, batchResumeDir,
    });
    const childJson = JSON.stringify(bareChild);
    check(!("roster" in bareChild.project) && !("dquicktsPath" in bareChild.run) && !("launchedBy" in bareChild), "C OK: unset optionals are omitted from the child input, never undefined");
    check(JSON.parse(childJson).run.batchId === "dual-BRA-260-FIXTURE", "C OK: the bare child input survives a JSON round-trip");

    // Child report shape + verdict taken from it.
    const goodChild: BatchChildReport = {
      batchId: "dual-BRA-260-FIXTURE", verdict: "passed", dryRun: false, owner: QUALITY_OWNER,
      cancelChecked: false, cancelled: false,
      changes: [{ changeId: "BRA-260-FIXTURE", passed: true, suites: [{ changeId: "BRA-260-FIXTURE", suite: "fixture-suite", passed: true, logPath: "/w/logs/x.log", ok: 5 }] }],
      stackPassed: true, resumedSuites: 0, notes: [], knownLimit: "x",
    };
    check(isBatchChildReport(goodChild), "C OK: the valid child report is recognized");
    check(!isBatchChildReport({ ...goodChild, verdict: "maybe" }), "C OK: a child report with an unknown verdict is rejected");
    check(!isBatchChildReport({ ...goodChild, batchId: 7 }), "C OK: a child report with no batch id is rejected");
    check(!isBatchChildReport(null), "C OK: a null child report is rejected");
    check(verdictFromBatch(goodChild).verdict === "PASS", "C OK: a passed stack takes PASS");
    const badChild: BatchChildReport = {
      ...goodChild, verdict: "failed", stackPassed: false, failingSuite: "fixture-suite", failingChange: "BRA-260-FIXTURE",
      changes: [{ changeId: "BRA-260-FIXTURE", passed: false, suites: [{ changeId: "BRA-260-FIXTURE", suite: "fixture-suite", passed: false, logPath: "/w/logs/x.log", ok: 3, note: "suite failed" }] }],
    };
    const taken = verdictFromBatch(badChild);
    check(taken.verdict === "FAIL" && taken.failingSuite === "fixture-suite" && (taken.reason ?? "").includes("fixture-suite"), "C OK: a failed stack takes FAIL naming the suite");
    const dryChild: BatchChildReport = { ...goodChild, verdict: "dry-run", stackPassed: false };
    check(verdictFromBatch(dryChild).verdict === "unable-to-verify", "C OK: a dry-run child takes unable-to-verify");
    const unnamedChild: BatchChildReport = { ...goodChild, verdict: "failed", stackPassed: false };
    check((verdictFromBatch(unnamedChild).reason ?? "").includes("no failing suite named"), "C OK: a failed stack with no suite names that");

    // Payloads + report assembly.
    const suites: DualReportSuiteResult[] = [{ suite: "fixture-suite", passed: true, ok: 5, logPath: "/w/logs/x.log" }];
    const payloads = buildDualReportPayloads({
      reportId: "BRA-256", itemKey: "BRA-260-FIXTURE", itemTitle: "fixture push", verdict: "PASS",
      suites, owningLeadTarget: IMPL_OWNER,
    });
    check(payloads.length === 2 && payloads[0].target === IMPL_OWNER && payloads[1].target === "director", "C OK: the payloads go to the owning lead + the Director");
    check(payloads[0].message.includes("PASS") && payloads[0].message.includes("BRA-260-FIXTURE") && payloads[0].message.includes("1/1"), "C OK: the payload message names the verdict + the item + the pass count");
    const directorOnly = buildDualReportPayloads({
      reportId: "BRA-256", itemKey: "BRA-260-FIXTURE", verdict: "PASS", suites,
    });
    check(directorOnly.length === 1 && directorOnly[0].target === "director", "C OK: no owning lead goes to the Director only");
    const failPayloads = buildDualReportPayloads({
      reportId: "BRA-256", itemKey: "BRA-260-FIXTURE", verdict: "FAIL",
      suites: [{ suite: "fixture-suite", passed: false, ok: 3, logPath: "/w/logs/x.log", note: "suite failed" }],
      failingSuite: "fixture-suite", reason: "suite fixture-suite failed",
    });
    check(failPayloads[0].message.includes("FAIL") && failPayloads[0].message.includes("failing suite: fixture-suite"), "C OK: the FAIL payload names the failing suite");
    const report: DualReportReport = buildDualReportReport({
      reportId: "BRA-256", itemKey: "BRA-260-FIXTURE", itemTitle: "fixture push", verdict: "PASS",
      dryRun: false, owner: QUALITY_OWNER, cancelChecked: false, cancelled: false,
      suites, deliveryPayloads: payloads, owningLeadPayloadProduced: true, notes: [],
    });
    check(report.verdict === "PASS" && report.knownLimit === DUAL_REPORT_KNOWN_LIMIT, "C OK: the report assembles with the verdict + the known limit");
    check(report.deliveryPayloads.length === 2 && report.owningLeadPayloadProduced === true, "C OK: the report carries both payloads + the produced flag");
  }

  // --------------------------------------------- §D live CLI runs
  console.log("\n=== §D live CLI runs ===");
  await startServer();
  try {
    // ---- D-256a a fixed item re-verified end to end, verdict PASS
    // in BOTH payloads in the same run.
    const fa = makeFixture("d-256a", false);
    {
      const out = driveDualReport("dual-d256a", validInput(fa));
      if (out) {
        check(out.verdict === "PASS", `D-256a OK: verdict PASS (got ${out.verdict})`);
        check(out.itemKey === "BRA-260-FIXTURE", `D-256a OK: the item is named (got ${out.itemKey})`);
        check(out.batchId === "dual-BRA-260-FIXTURE", `D-256a OK: the batch id is dual-<itemKey> (got ${out.batchId})`);
        check(out.suites?.[0]?.passed === true && out.suites?.[0]?.ok === 5, `D-256a OK: the per-suite result passes with ok 5 (got ${JSON.stringify(out.suites)})`);
        const payloads = out.deliveryPayloads as { target: string; message: string }[];
        check(payloads.length === 2, `D-256a OK: two payloads in the same run (got ${payloads.length})`);
        check(payloads[0].target === IMPL_OWNER && payloads[1].target === "director", `D-256a OK: the payloads go to the owning lead + the Director (got ${payloads.map((p) => p.target).join(",")})`);
        check(payloads[0].message.includes("PASS") && payloads[1].message.includes("PASS"), "D-256a OK: the verdict is PASS in BOTH payloads");
        check(payloads[0].message.includes("BRA-260-FIXTURE") && payloads[1].message.includes("BRA-260-FIXTURE"), "D-256a OK: both payloads name the item");
        check(out.owningLeadPayloadProduced === true, "D-256a OK: the owning-lead payload was produced");
        // On-disk outcome, separately from the report.
        const logPath = out.suites?.[0]?.logPath as string | undefined;
        check(typeof logPath === "string" && (read(logPath) ?? "").includes("fixture suite passed"), `D-256a OK: the child suite log exists on disk with the pass line (got ${logPath})`);
        check(fs.existsSync(path.join(fa.workDir, "batch-resume", "batch-state.json")), `D-256a OK: the child batch state exists under the parent's workDir`);
      }
    }

    // ---- D-256b a failing item re-verified, verdict FAIL in both
    // payloads, with the failing suite + log tail.
    const fb = makeFixture("d-256b", true);
    {
      const out = driveDualReport("dual-d256b", validInput(fb));
      if (out) {
        check(out.verdict === "FAIL", `D-256b OK: verdict FAIL (got ${out.verdict})`);
        check(out.failingSuite === "fixture-suite", `D-256b OK: the report names the failing suite (got ${out.failingSuite})`);
        check(JSON.stringify(out.failingLogTail ?? []).includes("assertion 2 of 5 did not hold"), `D-256b OK: the report carries the failing log tail (got ${JSON.stringify(out.failingLogTail)})`);
        check((out.reason as string | undefined)?.includes("fixture-suite") === true, `D-256b OK: the reason names the failing suite (got ${out.reason})`);
        const payloads = out.deliveryPayloads as { target: string; message: string }[];
        check(payloads.length === 2 && payloads[0].message.includes("FAIL") && payloads[1].message.includes("FAIL"), "D-256b OK: the verdict is FAIL in BOTH payloads");
        check(payloads[0].message.includes("failing suite: fixture-suite"), "D-256b OK: the payloads name the failing suite");
        const logPath = out.suites?.[0]?.logPath as string | undefined;
        check(typeof logPath === "string" && (read(logPath) ?? "").includes("assertion 2 of 5 did not hold"), `D-256b OK: the child suite log exists on disk with the failure line (got ${logPath})`);
      }
    }

    // ---- D-256c an item whose suite is not a registered tier-1
    // section is unable-to-verify, reported, not dropped.
    const fc = makeFixture("d-256c", false);
    {
      const out = driveDualReport("dual-d256c", validInput(fc, { "run.suites": ["no-such-suite"] }));
      if (out) {
        check(out.verdict === "unable-to-verify", `D-256c OK: verdict unable-to-verify (got ${out.verdict})`);
        check(JSON.stringify(out.reason).includes("no-such-suite"), `D-256c OK: the reason names the unregistered suite (got ${JSON.stringify(out.reason)})`);
        const payloads = out.deliveryPayloads as { target: string; message: string }[];
        check(payloads.length === 2 && payloads[0].message.includes("unable-to-verify"), "D-256c OK: the unable-to-verify verdict is still reported to both recipients");
        check(!fs.existsSync(path.join(fc.workDir, "batch-resume", "batch-state.json")), `D-256c OK: the child batch never ran (no batch state)`);
      }
    }

    // ---- D-256d an item whose copy root is absent is
    // unable-to-verify, reported, not dropped.
    const fd = makeFixture("d-256d", false);
    {
      const out = driveDualReport("dual-d256d", validInput(fd, { "run.copyRoot": path.join(WORKDIR, "does-not-exist") }));
      if (out) {
        check(out.verdict === "unable-to-verify", `D-256d OK: verdict unable-to-verify (got ${out.verdict})`);
        check(JSON.stringify(out.reason).includes("does not exist"), `D-256d OK: the reason names the missing copy root (got ${JSON.stringify(out.reason)})`);
        const payloads = out.deliveryPayloads as { target: string; message: string }[];
        check(payloads.length === 2 && payloads[0].message.includes("unable-to-verify"), "D-256d OK: the unable-to-verify verdict is still reported to both recipients");
        check(!fs.existsSync(path.join(fd.workDir, "batch-resume", "batch-state.json")), `D-256d OK: the child batch never ran (no batch state)`);
      }
    }

    // ---- D-256e an item with no owning lead goes to the Director
    // only, recorded.
    const fe = makeFixture("d-256e", false);
    {
      const input = validInput(fe);
      delete (input.run as Record<string, unknown>).owningLead;
      const out = driveDualReport("dual-d256e", input);
      if (out) {
        check(out.verdict === "PASS", `D-256e OK: verdict PASS (got ${out.verdict})`);
        const payloads = out.deliveryPayloads as { target: string; message: string }[];
        check(payloads.length === 1 && payloads[0].target === "director", `D-256e OK: exactly one payload, to the Director (got ${JSON.stringify(payloads.map((p) => p.target))})`);
        check(out.owningLeadPayloadProduced === false, "D-256e OK: the owning-lead payload was not produced");
        check(JSON.stringify(out.owningLeadReason).includes("no owning lead named"), `D-256e OK: the report records the missing owner (got ${JSON.stringify(out.owningLeadReason)})`);
      }
    }

    // ---- D-256f a dry-run writes nothing and re-verifies nothing.
    const ff = makeFixture("d-256f", false);
    {
      const out = driveDualReport("dual-d256f", validInput(ff, { "run.dryRun": true }));
      if (out) {
        check(out.verdict === "dry-run", `D-256f OK: verdict dry-run (got ${out.verdict})`);
        check((out.deliveryPayloads as unknown[]).length === 0, "D-256f OK: no delivery payloads on a dry-run");
        check(!fs.existsSync(path.join(ff.workDir, "batch-resume", "batch-state.json")), "D-256f OK: the child batch never ran (no batch state)");
        check(out.suites?.[0]?.note === "dry-run: planned, not run", `D-256f OK: the suite is planned, not run (got ${JSON.stringify(out.suites?.[0]?.note)})`);
      }
    }

    // ---- D-256g a cancelled run stops before re-verifying (the
    // bra210a case-H shape: a separate state dir with a
    // hand-crafted cancelled queue entry). The CLI queue uses the
    // main state dir; only the input's project.stateDir points at
    // the cancel dir — the workflow's cancel check reads the
    // input's state dir, so the run executes and refuses itself.
    const fg = makeFixture("d-256g", false);
    {
      const cancelStateDir = path.join(WORKDIR, "cancel-state-256g");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(cancelStateDir, "queue.json"),
        JSON.stringify([{ runId: "dual-d256g", status: "cancelled" }]),
      );
      const input = validInput(fg, { "project.stateDir": cancelStateDir, "run.runId": "dual-d256g" });
      const out = driveDualReport("dual-d256g", input);
      if (out) {
        check(out.verdict === "failed", `D-256g OK: verdict failed for the cancelled run (got ${out.verdict})`);
        check(out.cancelChecked === true && out.cancelled === true, `D-256g OK: cancelChecked true + cancelled true (got ${out.cancelChecked}/${out.cancelled})`);
        check((out.notes as string[]).some((n) => n.includes("is cancelled")), `D-256g OK: the refusal names the cancellation (got ${JSON.stringify(out.notes)})`);
        check((out.deliveryPayloads as unknown[]).length === 0, "D-256g OK: no delivery payloads on a cancelled run");
        check(!fs.existsSync(path.join(fg.workDir, "batch-resume", "batch-state.json")), "D-256g OK: the child batch never ran (no batch state)");
      }
    }
  } finally {
    await stopServer();
  }

  console.log("\n=== summary ===");
  if (FAILURES.length > 0) {
    console.log(`FAIL test-bra256 (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("PASS test-bra256");
  return 0;
}

const code = await main();
process.exit(code);
