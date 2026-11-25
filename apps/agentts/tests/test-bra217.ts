#!/usr/bin/env bun
/**
 * Tests for the verify-fix suite-step trap-cap fix (Linear BRA-217).
 *
 * verify-fix.ts:630 captured run.sh's full stdout uncapped
 * (`summaryLine = r.stdout`). A full tier-1's stdout is megabytes
 * — far over the ~60KB exec-trap stdout cap — so the old code
 * crashed the C host on resume (reproduced before the fix with a
 * stub run.sh emitting ~120KB: "C host crashed resuming
 * run-bra217-repro at run-bra217-repro/trap-2 3 times"). The fix
 * runs run.sh through suiteRunScript / scopedSuiteRunScript, which
 * redirect its stdout to a file in-shell and return only the PASS
 * summary line (full runs) or a one-line exit marker (scoped
 * runs) — the merge workflow's tier1RunScript pattern, applied in
 * place here (merge already imports from verify-fix, so importing
 * its transport back would cycle).
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh's section definitions on slug + tier).
 *   B. `agentts check` passes on verify-fix.ts (first-run gate).
 *   C. Pure unit checks: shellQuote, suiteRunScript /
 *      scopedSuiteRunScript shape, and the real behaviour of both
 *      scripts executed directly against a stub run.sh (bulk
 *      stdout to a file, only the small line returns; a failing
 *      run keeps its exit code and yields no PASS line).
 *   D. Two live runs through the CLI on direct, against scratch
 *      trees with a stub run.sh emitting ~120KB of stdout:
 *      D1 a full (unscoped) verify-fix run — verdict "verified",
 *      the summary matches the independent log counts, and the
 *      bulk output is on disk, not in the report; D2 a scoped
 *      run — the same for one section. The stub writes plausible
 *      section logs + .done markers so the aggregation succeeds;
 *      the workflow's own host build runs from the real
 *      durablets tree (symlinked into the scratch repo).
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The live runs' leaf execs inherit this process's env, so
 *   DQUICKTS and TMPDIR must be set (run.sh sets DQUICKTS when
 *   it runs this test; TMPDIR is set here when absent).
 * - The stub run.sh is a test double, not the real runner: it
 *   proves the transport (bulk to disk, small line back), not
 *   that run.sh itself prints a PASS line. The real-run proof is
 *   the tier-1 run in the copy, where verify-fix runs the real
 *   run.sh through the new scripts.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra217.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import {
  shellQuote,
  suiteRunScript,
  scopedSuiteRunScript,
  parseTierSummaryLine,
} from "../workflows/library/verify-fix";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const VERIFY_FIX = path.join(ROOT, "workflows", "library", "verify-fix.ts");
const WORKDIR = process.env.BRA217_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra217-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
const RUN_D1 = "run-bra217-full";
const RUN_D2 = "run-bra217-scoped";
const PASS_LINE = "PASS tier 1 (quick) — 2 sections ran, 17 OK, 1s; skipped 0 via resume, 0 by tier/selection";

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

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
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
    if (Date.now() > deadline) throw new Error("bra217 server did not come up");
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

/** Drive one verify-fix input through the CLI (submit + queue run +
 * result) and return the parsed result JSON, or null on a CLI failure
 * (the failure is already recorded as a check). */
function driveRun(runId: string, input: unknown): Record<string, any> | null {
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", VERIFY_FIX,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  if (sub.rc !== 0) return null;
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(drive.rc === 0, `DRIVE OK: queue run exits 0 for ${runId} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 200)})`);
  if (drive.rc !== 0) return null;
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 200)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as Record<string, any>;
  } catch {
    fail(`RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

/** Stub run.sh: writes fake section logs + .done markers into the
 * resume dir it is given, then emits ~120KB of junk stdout. Full
 * mode (no --only) writes two sections and ends with the PASS
 * summary line; scoped mode (--only <section>) writes that one
 * section and exits 0 with no PASS line. */
const STUB_RUN_SH = `#!/bin/bash
RESUME=""
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --resume-dir) RESUME="$2"; shift 2;;
    --only) ONLY="$2"; shift 2;;
    *) shift;;
  esac
done
if [ -n "$ONLY" ]; then
  LOGDIR="$RESUME/logs"; DONEDIR="$RESUME/.done"
  mkdir -p "$LOGDIR" "$DONEDIR"
  i=1; while [ $i -le 12 ]; do echo "CHECK$i OK: $ONLY check $i"; i=$((i+1)); done > "$LOGDIR/$ONLY.log"
  echo "PASS $ONLY" >> "$LOGDIR/$ONLY.log"
  touch "$DONEDIR/$ONLY"
else
  LOGDIR="$RESUME/workflow/tier1/resume/logs"; DONEDIR="$RESUME/workflow/tier1/resume/.done"
  mkdir -p "$LOGDIR" "$DONEDIR"
  i=1; while [ $i -le 12 ]; do echo "CHECK$i OK: fake1 check $i"; i=$((i+1)); done > "$LOGDIR/fake1.log"
  echo "PASS fake1" >> "$LOGDIR/fake1.log"
  i=1; while [ $i -le 5 ]; do echo "CHECK$i OK: fake2 check $i"; i=$((i+1)); done > "$LOGDIR/fake2.log"
  echo "PASS fake2" >> "$LOGDIR/fake2.log"
  touch "$DONEDIR/fake1" "$DONEDIR/fake2"
fi
i=1; while [ $i -le 2000 ]; do echo "JUNK LINE $i: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done
if [ -z "$ONLY" ]; then
  echo "PASS tier 1 (quick) — 2 sections ran, 17 OK, 1s; skipped 0 via resume, 0 by tier/selection"
fi
exit 0
`;

/** A failing stub: ~120KB of stdout, exit 3, no PASS line. */
const FAIL_STUB_RUN_SH = `#!/bin/bash
i=1; while [ $i -le 2000 ]; do echo "JUNK LINE $i: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done
echo "run.sh died before the summary" >&2
exit 3
`;

/** Build the scratch repo tree a §D run needs: packages/durablets
 * symlinked to the real tree (the workflow's host build runs make
 * there with OUT_DIR in the work dir), apps/agentts holding only
 * the stub run.sh. Returns the scratch repo root. */
function makeScratchRepo(name: string): string {
  const scratch = path.join(WORKDIR, name);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, "packages"), { recursive: true });
  fs.mkdirSync(path.join(scratch, "apps", "agentts"), { recursive: true });
  fs.symlinkSync(path.join(COPY_ROOT, "packages", "durablets"), path.join(scratch, "packages", "durablets"));
  const stubPath = path.join(scratch, "apps", "agentts", "run.sh");
  fs.writeFileSync(stubPath, STUB_RUN_SH);
  fs.chmodSync(stubPath, 0o755);
  return scratch;
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
      const r = cli(["check", VERIFY_FIX, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on verify-fix.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("verifyFix(VerifyFixInput)"), `CHECK OK: entry is verifyFix(VerifyFixInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure unit checks
    console.log("\n=== §C pure unit checks ===");
    {
      // shellQuote: plain, with a single quote, empty.
      check(shellQuote("/plain/path") === "'/plain/path'", `QUOTE OK: plain path quoted (got ${shellQuote("/plain/path")})`);
      check(shellQuote("o'clock") === "'o'\\''clock'", `QUOTE OK: single quote escaped (got ${shellQuote("o'clock")})`);
      check(shellQuote("") === "''", `QUOTE OK: empty string quoted (got ${shellQuote("")})`);

      // suiteRunScript shape: redirect to the file, grep the PASS
      // line, keep run.sh's exit code.
      const s = suiteRunScript({ dquickts: "/dq", tmpdir: "/w/tmp", runSh: "/l/apps/agentts/run.sh", resumeDir: "/w/resume", outPath: "/w/run-sh.out" });
      check(s.includes("'/l/apps/agentts/run.sh'") && s.includes("--resume-dir '/w/resume'"),
        `SCRIPT OK: suiteRunScript runs run.sh with the resume dir (got ${JSON.stringify(s.slice(0, 120))})`);
      check(s.includes("> '/w/run-sh.out' 2>&1"),
        `SCRIPT OK: suiteRunScript redirects run.sh stdout to a file (got ${JSON.stringify(s.slice(0, 200))})`);
      check(s.includes("grep -E '^PASS tier") && s.includes("tail -1"),
        `SCRIPT OK: suiteRunScript returns only the PASS line (got ${JSON.stringify(s.slice(0, 300))})`);
      check(s.includes("exit $rc"),
        `SCRIPT OK: suiteRunScript keeps run.sh's exit code`);
      check(s.includes("DQUICKTS='/dq'") && s.includes("TMPDIR='/w/tmp'"),
        `SCRIPT OK: suiteRunScript sets the suite env explicitly`);

      // scopedSuiteRunScript shape: --only section, redirect, one
      // exit-marker line, keep the exit code.
      const sc = scopedSuiteRunScript({ dquickts: "/dq", tmpdir: "/w/tmp", runSh: "/l/apps/agentts/run.sh", section: "bra101", resumeDir: "/w/resume", outPath: "/w/run-sh-bra101.out" });
      check(sc.includes("--bash --only 'bra101'") && sc.includes("--resume-dir '/w/resume'"),
        `SCRIPT OK: scopedSuiteRunScript runs one section (got ${JSON.stringify(sc.slice(0, 160))})`);
      check(sc.includes("> '/w/run-sh-bra101.out' 2>&1"),
        `SCRIPT OK: scopedSuiteRunScript redirects the section stdout to a file`);
      check(sc.includes('echo "run.sh exit $rc"') && sc.includes("exit $rc"),
        `SCRIPT OK: scopedSuiteRunScript returns a one-line exit marker and keeps the exit code`);

      // The scripts' real behaviour, executed directly against the
      // stub (no workflow, no host): bulk stdout to the file, only
      // the small line back.
      const stubDir = path.join(WORKDIR, "stub");
      fs.mkdirSync(stubDir, { recursive: true });
      const stubPath = path.join(stubDir, "run.sh");
      fs.writeFileSync(stubPath, STUB_RUN_SH);
      fs.chmodSync(stubPath, 0o755);
      const outPath = path.join(WORKDIR, "direct-run-sh.out");
      const sr = spawnSync("/bin/sh", ["-c", suiteRunScript({ dquickts: "/dq", tmpdir: "/w/tmp", runSh: stubPath, resumeDir: path.join(WORKDIR, "direct-resume"), outPath })], { encoding: "utf8" });
      check(sr.status === 0, `SCRIPT OK: suiteRunScript exits 0 on the stub (got ${sr.status})`);
      check((sr.stdout ?? "").trim() === PASS_LINE,
        `SCRIPT OK: suiteRunScript returns exactly the PASS line (got ${JSON.stringify((sr.stdout ?? "").slice(0, 120))})`);
      check((sr.stdout ?? "").length < 500,
        `SCRIPT OK: suiteRunScript returns under 500 bytes (got ${(sr.stdout ?? "").length})`);
      const outBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : -1;
      check(outBytes > 60000,
        `SCRIPT OK: the bulk stdout is on disk, not in the trap return (${outBytes} B in ${outPath})`);
      const parsed = parseTierSummaryLine((sr.stdout ?? "").trim());
      check(parsed !== null && parsed.sectionsRan === 2 && parsed.ok === 17 && parsed.skippedViaResume === 0,
        `SCRIPT OK: the returned PASS line parses to 2 sections / 17 OK / skipped 0 (got ${JSON.stringify(parsed)})`);

      const scOutPath = path.join(WORKDIR, "direct-run-sh-fake1.out");
      const scr = spawnSync("/bin/sh", ["-c", scopedSuiteRunScript({ dquickts: "/dq", tmpdir: "/w/tmp", runSh: stubPath, section: "fake1", resumeDir: path.join(WORKDIR, "direct-resume-scoped"), outPath: scOutPath })], { encoding: "utf8" });
      check(scr.status === 0, `SCRIPT OK: scopedSuiteRunScript exits 0 on the stub (got ${scr.status})`);
      check((scr.stdout ?? "").trim() === "run.sh exit 0",
        `SCRIPT OK: scopedSuiteRunScript returns one exit-marker line (got ${JSON.stringify((scr.stdout ?? "").trim())})`);
      const scOutBytes = fs.existsSync(scOutPath) ? fs.statSync(scOutPath).size : -1;
      check(scOutBytes > 60000,
        `SCRIPT OK: the section bulk stdout is on disk (${scOutBytes} B in ${scOutPath})`);

      // A failing run keeps its exit code and yields no PASS line:
      // the verdict fails loudly instead of trusting an empty
      // summary.
      const failStubPath = path.join(stubDir, "fail-run.sh");
      fs.writeFileSync(failStubPath, FAIL_STUB_RUN_SH);
      fs.chmodSync(failStubPath, 0o755);
      const failOutPath = path.join(WORKDIR, "direct-fail.out");
      const fr = spawnSync("/bin/sh", ["-c", suiteRunScript({ dquickts: "/dq", tmpdir: "/w/tmp", runSh: failStubPath, resumeDir: path.join(WORKDIR, "direct-resume-fail"), outPath: failOutPath })], { encoding: "utf8" });
      check(fr.status === 3, `SCRIPT OK: suiteRunScript keeps a failing run's exit code 3 (got ${fr.status})`);
      check((fr.stdout ?? "").trim() === "",
        `SCRIPT OK: a run with no PASS line returns empty stdout (got ${JSON.stringify((fr.stdout ?? "").trim())})`);
      check(parseTierSummaryLine((fr.stdout ?? "").trim()) === null,
        `SCRIPT OK: empty stdout parses to a null summary (loud failure, not a trusted zero)`);
    }

    // --------------------------------------------- §D live runs
    console.log("\n=== §D live runs (stub run.sh, ~120KB stdout) ===");
    // D1: full (unscoped) verify-fix run against the stub.
    const scratchD1 = makeScratchRepo("scratch-repo-d1");
    const workD1 = path.join(WORKDIR, "verify-work-d1");
    const outD1 = driveRun(RUN_D1, {
      fixId: "BRA-217-D1",
      repoRoot: scratchD1,
      workDir: workD1,
      resumeDir: path.join(WORKDIR, "verify-resume-d1"),
      dquicktsPath: process.env.DQUICKTS || "/home/hatch/workspace/dquickts-build-minimal",
      directTests: [],
      buildHost: true,
      typecheck: false,
      tier: 1,
      claimedFiles: [],
      changedFiles: [],
    });
    if (outD1) {
      check(outD1.verdict === "verified", `LIVE OK: full run verifies (got ${outD1.verdict}: ${JSON.stringify(outD1.notes)})`);
      check(Array.isArray(outD1.notes) && outD1.notes.length === 0, `LIVE OK: no notes on a verified run (got ${JSON.stringify(outD1.notes)})`);
      const s1 = outD1.suite as any;
      check(s1?.mode === "full", `LIVE OK: suite mode is full (got ${s1?.mode})`);
      check(s1?.sectionsRan === 2, `LIVE OK: 2 sections ran (got ${s1?.sectionsRan})`);
      check(s1?.totalOk === 17, `LIVE OK: suite totalOk 17 (got ${s1?.totalOk})`);
      check(s1?.passLines === 2, `LIVE OK: suite passLines 2 (got ${s1?.passLines})`);
      check(s1?.allPassed === true, `LIVE OK: suite all passed (got ${s1?.allPassed})`);
      check(s1?.skippedViaResume === 0, `LIVE OK: suite skipped 0 via resume (got ${s1?.skippedViaResume})`);
      check(s1?.summaryMatchesIndependent === true, `LIVE OK: summary matches the independent log counts (got ${s1?.summaryMatchesIndependent})`);
      check(typeof s1?.summaryLine === "string" && s1.summaryLine.trim() === PASS_LINE, `LIVE OK: the report's summary line is exactly the PASS line, not the full stdout (got ${JSON.stringify((s1?.summaryLine ?? "").slice(0, 120))})`);
      check(typeof s1?.summaryLine === "string" && s1.summaryLine.length < 500,
        `LIVE OK: the summary line is under 500 bytes (got ${s1?.summaryLine?.length})`);
      const d1Out = path.join(workD1, "run-sh.out");
      const d1Bytes = fs.existsSync(d1Out) ? fs.statSync(d1Out).size : -1;
      check(d1Bytes > 60000,
        `LIVE OK: the bulk run.sh stdout is on disk in the work dir (${d1Bytes} B in run-sh.out)`);
      check((outD1.confinement as any)?.confined === true, `LIVE OK: confinement confined (got ${JSON.stringify(outD1.confinement)})`);
      check((outD1.baseline as any)?.compared === false, `LIVE OK: baseline skipped with no baseline given (got ${JSON.stringify(outD1.baseline)})`);
    }

    // D2: scoped run against the stub (one section, >60KB stdout).
    const scratchD2 = makeScratchRepo("scratch-repo-d2");
    const workD2 = path.join(WORKDIR, "verify-work-d2");
    const outD2 = driveRun(RUN_D2, {
      fixId: "BRA-217-D2",
      repoRoot: scratchD2,
      workDir: workD2,
      resumeDir: path.join(WORKDIR, "verify-resume-d2"),
      dquicktsPath: process.env.DQUICKTS || "/home/hatch/workspace/dquickts-build-minimal",
      directTests: [],
      buildHost: true,
      typecheck: false,
      tier: 1,
      onlySections: ["fake1"],
      claimedFiles: [],
      changedFiles: [],
    });
    if (outD2) {
      check(outD2.verdict === "verified", `LIVE OK: scoped run verifies (got ${outD2.verdict}: ${JSON.stringify(outD2.notes)})`);
      const s2 = outD2.suite as any;
      check(s2?.mode === "scoped", `LIVE OK: scoped suite mode is scoped (got ${s2?.mode})`);
      check(s2?.sectionsRan === 1, `LIVE OK: scoped run ran 1 section (got ${s2?.sectionsRan})`);
      check(s2?.totalOk === 12, `LIVE OK: scoped totalOk 12 (got ${s2?.totalOk})`);
      check(s2?.allPassed === true, `LIVE OK: scoped suite all passed (got ${s2?.allPassed})`);
      const d2Out = path.join(workD2, "run-sh-fake1.out");
      const d2Bytes = fs.existsSync(d2Out) ? fs.statSync(d2Out).size : -1;
      check(d2Bytes > 60000,
        `LIVE OK: the section bulk stdout is on disk (${d2Bytes} B in run-sh-fake1.out)`);
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA217 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra217 verify-fix suite-step trap cap (inventory check, agentts check, pure unit checks, live full + scoped runs against a ~120KB-stdout stub run.sh — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
