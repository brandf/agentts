#!/usr/bin/env bun
/**
 * Tests for the fix-verification workflow (Linear BRA-158).
 *
 * The fix+verify+close loop is manual (Meroki re-runs, greps logs,
 * writes the Linear comment, closes). BRA-158 encodes it as the
 * verify-fix workflow (workflows/library/verify-fix.ts): it
 * re-runs the changed test directly with a freshly built host,
 * runs the tiered suite and greps the on-disk logs (never the
 * runner's summary line), checks the diff is confined to the
 * claimed files, compares against the recorded suite-count
 * baseline, and produces a verify report. It never closes issues,
 * merges code, or decides acceptance — Meroki reviews the report
 * and closes.
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh's section definitions on slug + tier).
 *   B. `agentts check` passes on verify-fix.ts (first-run gate).
 *   C. Pure unit checks: parseDirectTestOutput (real bra132 log
 *      lines), parseTierSummaryLine (the real BRA-132 live PASS
 *      line), parseTier1Aggregation (synthetic, incl. a no-PASS
 *      section and malformed inputs), checkDiffConfinement (the
 *      real BRA-132 file list + extras/missing), compareBaseline
 *      (expected growth / regression / unexplained delta),
 *      buildVerifyReport (verified + failed verdicts).
 *   D. A live scoped run through the CLI on direct: a synthetic
 *      BRA-103 fix (direct re-run of test-bra103.ts, 5 checks;
 *      scoped suite bra101 + bra103; typecheck; fresh host build),
 *      asserting the report's fields and a "verified" verdict.
 *      The full-tier BRA-132 re-verification (the acceptance run)
 *      is a separate script, not this test: it takes ~11 minutes
 *      and compares the workflow's report line-by-line against
 *      Meroki's manual verification.
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The live run's leaf execs inherit this process's env, so
 *   DQUICKTS and TMPDIR must be set (run.sh sets DQUICKTS when
 *   it runs this test; TMPDIR is set here when absent).
 * - The workflow's counts use run.sh's narrow rule (lines
 *   containing " OK:"). The broader ` OK(\s|:)` rule counts 2
 *   extra lines on the real Nov 18 data (1186 vs the recorded
 *   1184) — the rule matters, and the workflow states it.
 * - ^PASS is evidence, not a gate: bra112 ends "BRA112 PASS: ..."
 *   and layering ends "LAYERING OK: ..." (no line starts with
 *   PASS), and bra164's log holds two PASS lines — the Nov 19
 *   tier-1 logs show 34 ^PASS lines across 35 section logs.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra158.ts
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
  parseDirectTestOutput,
  parseTierSummaryLine,
  parseTier1Aggregation,
  checkDiffConfinement,
  compareBaseline,
  buildVerifyReport,
  VERIFY_KNOWN_LIMIT,
  type BaselineResult,
  type ConfinementResult,
  type DirectTestResult,
  type SuiteResult,
  type TypecheckResult,
} from "../workflows/library/verify-fix";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const VERIFY_FIX = path.join(ROOT, "workflows", "library", "verify-fix.ts");
const WORKDIR = process.env.BRA158_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra158-"));
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
const RUN_D = "run-bra158-scoped";

/** The real BRA-132 file list (8 files, as merged into the live tree). */
const BRA132_FILES = [
  "apps/agentts/src/host.ts",
  "apps/agentts/tests/test-bra132.ts",
  "apps/agentts/tests/workflows/workflow-bra132.ts",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/skills/agentts-usage.md",
  "apps/agentts/run.sh",
  "apps/agentts/suite-inventory.json",
];

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
    if (Date.now() > deadline) throw new Error("bra158 server did not come up");
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

function fakeSuite(over: Partial<SuiteResult> = {}): SuiteResult {
  return {
    mode: "full",
    tier: 1,
    sectionsRan: 36,
    totalOk: 1268,
    passLines: 35,
    sections: [],
    allPassed: true,
    skippedViaResume: 0,
    summaryLine: "",
    summaryMatchesIndependent: true,
    elapsedMs: 665000,
    ...over,
  };
}
function fakeBaseline(over: Partial<BaselineResult> = {}): BaselineResult {
  return {
    compared: true,
    baselineLabel: "pre-BRA-132 tier-1",
    baselineSections: 35,
    baselineOk: 1184,
    deltaSections: 1,
    deltaOk: 84,
    expectedSections: 1,
    expectedOk: 84,
    explained: true,
    explanation: "expected growth",
    ...over,
  };
}
function fakeConfinement(over: Partial<ConfinementResult> = {}): ConfinementResult {
  return { confined: true, extras: [], missing: [], ...over };
}
function fakeDirect(over: Partial<DirectTestResult> = {}): DirectTestResult {
  return {
    testPath: "tests/test-bra132.ts",
    exitCode: 0,
    ok: 84,
    expectedChecks: 84,
    checksMatch: true,
    executed: true,
    passed: true,
    passLines: 1,
    elapsedMs: 60000,
    ...over,
  };
}
function fakeTypecheck(over: Partial<TypecheckResult> = {}): TypecheckResult {
  return { ran: true, exitCode: 0, passed: true, stderrHead: "", ...over };
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
      // parseDirectTestOutput: the first 12 lines of the real
      // bra132 direct log (all " OK:" lines) + its PASS line.
      const sample = [
        "PROBE OK: base host build signature stable across probes (0xd389a8d9)",
        "PARSE OK: host native names parsed in order (print, trap, all, any, race, __agentts_begin)",
        "PARSE OK: parseHostNativeNames throws loudly when durablets_register is absent",
        "PARSE OK: parseHostNativeNames throws loudly when a registration is deleted (counts 5 vs 6 vs 6)",
        "PARSE OK: parseHostNativeNames throws loudly when .native_count disagrees with the registry",
        "IDENTITY OK: formatIdentityFor/split round-trip (snapfmt-d389a8d9:96a9a79:print,trap,all,any,race,__agentts_begin)",
        "IDENTITY OK: legacy signature-only form parses with null pin/natives",
        "IDENTITY OK: a full engine version string is not a format identity (split returns null)",
        "BLOB OK: readSnapshotBuildSignature returns null for a missing file",
        "BLOB OK: readSnapshotBuildSignature throws loudly on a truncated blob",
        "BLOB OK: readSnapshotBuildSignature throws loudly on a bad magic",
        "BLOB OK: readSnapshotBuildSignature throws loudly on a non-11 format version",
        "",
        "PASS bra132: snapshot format identity gate",
        "",
      ].join("\n");
      const d = parseDirectTestOutput(sample, 0);
      check(d.ok === 12, `PARSE OK: bra132 sample counts 12 OK lines (got ${d.ok})`);
      check(d.passLines === 1, `PARSE OK: bra132 sample counts 1 PASS line (got ${d.passLines})`);
      check(d.executed === true, `PARSE OK: bra132 sample executed (got ${d.executed})`);
      check(d.passed === true, `PARSE OK: bra132 sample passed (got ${d.passed})`);

      // A FAIL line is a verdict; a nonzero exit with a verdict is a
      // test failure, not a runner crash.
      const f = parseDirectTestOutput(" OK: a\nFAIL: b broke\n", 1);
      check(f.executed === true && f.passed === false, `PARSE OK: FAIL case executed and not passed (got executed=${f.executed}, passed=${f.passed})`);
      check(f.ok === 1, `PARSE OK: FAIL case counts 1 OK (got ${f.ok})`);

      // The narrow rule: " OK " without a colon does NOT count.
      // (The broader rule counts 2 extra lines on the real Nov 18
      // data — 1186 vs the recorded 1184 — so the rule matters.)
      const n = parseDirectTestOutput(" OK: a\nSOME OK b\n", 0);
      check(n.ok === 1, `PARSE OK: narrow rule counts only " OK:" lines (got ${n.ok})`);

      // parseTierSummaryLine: the real BRA-132 live PASS line.
      const s = parseTierSummaryLine(
        "PASS tier 1 (quick) — 36 sections ran, 1268 OK, 665s; skipped 0 via resume, 35 by tier/selection",
      );
      check(s !== null, `PARSE OK: live PASS line parses (got ${JSON.stringify(s)})`);
      check(s?.sectionsRan === 36, `PARSE OK: live line sectionsRan 36 (got ${s?.sectionsRan})`);
      check(s?.ok === 1268, `PARSE OK: live line OK 1268 (got ${s?.ok})`);
      check(s?.wallSeconds === 665, `PARSE OK: live line 665s (got ${s?.wallSeconds})`);
      check(s?.skippedViaResume === 0, `PARSE OK: live line skipped 0 via resume (got ${s?.skippedViaResume})`);
      check(parseTierSummaryLine("no PASS here") === null, `PARSE OK: missing summary line parses to null`);
      check(parseTierSummaryLine("PASS tier 2 (broad) — 68 sections ran, 2702 OK, 1700s; skipped 3 via resume, 0 by tier/selection")?.skippedViaResume === 3,
        `PARSE OK: tier-2 line with skipped 3 parses (got ${JSON.stringify(parseTierSummaryLine("PASS tier 2 (broad) — 68 sections ran, 2702 OK, 1700s; skipped 3 via resume, 0 by tier/selection"))})`);

      // parseTier1Aggregation: synthetic, incl. a no-PASS section
      // (layering prints "LAYERING OK: ..." — no line starts PASS).
      const agg = parseTier1Aggregation(
        ["sectionsRan=3", "bra101 12 1", "bra103 5 1", "layering 1 0", "totalOk=18", "passLines=2"].join("\n"),
      );
      check(agg.sectionsRan === 3, `PARSE OK: aggregation sectionsRan 3 (got ${agg.sectionsRan})`);
      check(agg.totalOk === 18, `PARSE OK: aggregation totalOk 18 (got ${agg.totalOk})`);
      check(agg.passLines === 2, `PARSE OK: aggregation passLines 2 (got ${agg.passLines})`);
      check(agg.perSection.length === 3, `PARSE OK: aggregation lists 3 sections (got ${agg.perSection.length})`);
      check(agg.perSection[2]?.slug === "layering" && agg.perSection[2]?.passLines === 0,
        `PARSE OK: layering has 0 PASS lines in the aggregation (got ${JSON.stringify(agg.perSection[2])})`);
      let threw = false;
      try {
        parseTier1Aggregation(["sectionsRan=2", "bra101 12 1", "totalOk=99", "passLines=1"].join("\n"));
      } catch { threw = true; }
      check(threw, `PARSE OK: aggregation with a wrong totalOk throws loudly`);
      threw = false;
      try {
        parseTier1Aggregation(["sectionsRan=0", "totalOk=0", "passLines=0"].join("\n"));
      } catch { threw = true; }
      check(threw, `PARSE OK: aggregation with 0 sections throws loudly`);
      threw = false;
      try {
        parseTier1Aggregation(["sectionsRan=2", "bra101 12 1", "bra103 5 1", "totalOk=17", "passLines=2", "garbage line"].join("\n"));
      } catch { threw = true; }
      check(threw, `PARSE OK: aggregation with a malformed line throws loudly`);

      // checkDiffConfinement: the real BRA-132 file list, confined;
      // then extras and missing.
      const c = checkDiffConfinement(BRA132_FILES, BRA132_FILES);
      check(c.confined === true, `CONFINE OK: BRA-132 files confined (got ${JSON.stringify(c)})`);
      check(c.extras.length === 0 && c.missing.length === 0, `CONFINE OK: BRA-132 extras/missing empty`);
      const ce = checkDiffConfinement([...BRA132_FILES, "apps/agentts/src/extra.ts"], BRA132_FILES);
      check(ce.confined === false && ce.extras.length === 1 && ce.extras[0] === "apps/agentts/src/extra.ts",
        `CONFINE OK: an extra file is reported (got ${JSON.stringify(ce.extras)})`);
      const cm = checkDiffConfinement(BRA132_FILES.slice(0, 7), BRA132_FILES);
      check(cm.confined === false && cm.missing.length === 1 && cm.missing[0] === "apps/agentts/suite-inventory.json",
        `CONFINE OK: a missing file is reported (got ${JSON.stringify(cm.missing)})`);

      // compareBaseline: expected growth (the real BRA-132 numbers),
      // regression, unexplained delta.
      const b = compareBaseline(
        { sections: 36, ok: 1268 },
        { sections: 35, ok: 1184, label: "pre-BRA-132 tier-1 (post-BRA-124-remaining: 35 sections / 1184 OK)" },
        [{ sections: 1, ok: 84, note: "BRA-132 bra132 section (84 checks)" }],
      );
      check(b.explained === true, `BASELINE OK: BRA-132 +1/+84 is expected growth (got ${JSON.stringify(b)})`);
      check(b.deltaSections === 1 && b.deltaOk === 84, `BASELINE OK: BRA-132 deltas +1/+84 (got ${b.deltaSections}/${b.deltaOk})`);
      const br = compareBaseline(
        { sections: 35, ok: 1180 },
        { sections: 35, ok: 1184, label: "pre-BRA-132 tier-1" },
        [{ sections: 1, ok: 84, note: "BRA-132 bra132 section (84 checks)" }],
      );
      check(br.explained === false && /REGRESSION/.test(br.explanation),
        `BASELINE OK: a below-baseline measurement is a regression (got ${JSON.stringify(br.explanation)})`);
      const bu = compareBaseline(
        { sections: 36, ok: 1270 },
        { sections: 35, ok: 1184, label: "pre-BRA-132 tier-1" },
        [{ sections: 1, ok: 84, note: "BRA-132 bra132 section (84 checks)" }],
      );
      check(bu.explained === false && /UNEXPLAINED DELTA/.test(bu.explanation) && /\+2 OK/.test(bu.explanation),
        `BASELINE OK: a +2 OK residual is unexplained and named (got ${JSON.stringify(bu.explanation)})`);

      // buildVerifyReport: verified case, then one failure each.
      const v = buildVerifyReport({
        fixId: "BRA-132",
        direct: [fakeDirect()],
        typecheck: fakeTypecheck(),
        suite: fakeSuite(),
        confinement: fakeConfinement(),
        baseline: fakeBaseline(),
      });
      check(v.verdict === "verified", `REPORT OK: clean evidence verifies (got ${v.verdict})`);
      check(v.notes.length === 0, `REPORT OK: clean evidence has no notes (got ${JSON.stringify(v.notes)})`);
      check(v.knownLimit === VERIFY_KNOWN_LIMIT && /false pass/.test(v.knownLimit),
        `REPORT OK: the known v0 limit is carried verbatim`);
      const vf = buildVerifyReport({
        fixId: "BRA-132",
        direct: [fakeDirect({ ok: 83, checksMatch: false })],
        typecheck: fakeTypecheck(),
        suite: fakeSuite(),
        confinement: fakeConfinement(),
        baseline: fakeBaseline(),
      });
      check(vf.verdict === "failed", `REPORT OK: a count mismatch fails the verdict (got ${vf.verdict})`);
      check(vf.notes.some((n) => /counted 83 OK, expected 84/.test(n)),
        `REPORT OK: the mismatch is named with its counts (got ${JSON.stringify(vf.notes)})`);
      const vs = buildVerifyReport({
        fixId: "BRA-132",
        direct: [fakeDirect()],
        typecheck: fakeTypecheck(),
        suite: fakeSuite({ skippedViaResume: 2, summaryMatchesIndependent: false }),
        confinement: fakeConfinement(),
        baseline: fakeBaseline(),
      });
      check(vs.verdict === "failed" && vs.notes.some((n) => /skipped 2 sections via resume/.test(n)),
        `REPORT OK: a resumed run fails the verdict and is named (got ${JSON.stringify(vs.notes)})`);
    }

    // --------------------------------------------- §D live scoped run
    console.log("\n=== §D live scoped run ===");
    const outD = driveRun(RUN_D, {
      fixId: "BRA-103",
      repoRoot: COPY_ROOT,
      workDir: path.join(WORKDIR, "verify-work"),
      resumeDir: path.join(WORKDIR, "verify-resume"),
      dquicktsPath: process.env.DQUICKTS || "/home/hatch/workspace/dquickts-build-minimal",
      directTests: [{ testPath: "tests/test-bra103.ts", expectedChecks: 5 }],
      buildHost: true,
      typecheck: true,
      tier: 1,
      onlySections: ["bra101", "bra103"],
      claimedFiles: ["tests/test-bra103.ts"],
      changedFiles: ["tests/test-bra103.ts"],
    });
    if (outD) {
      check(outD.verdict === "verified", `LIVE OK: scoped run verifies (got ${outD.verdict}: ${JSON.stringify(outD.notes)})`);
      check(Array.isArray(outD.notes) && outD.notes.length === 0, `LIVE OK: no notes on a verified run (got ${JSON.stringify(outD.notes)})`);
      const d0 = (outD.direct as any[])[0];
      check(d0?.testPath === "tests/test-bra103.ts", `LIVE OK: direct test is test-bra103.ts (got ${d0?.testPath})`);
      check(d0?.ok === 5, `LIVE OK: bra103 counted 5 OK (got ${d0?.ok})`);
      check(d0?.checksMatch === true, `LIVE OK: bra103 checks match (got ${d0?.checksMatch})`);
      check(d0?.passed === true, `LIVE OK: bra103 passed (got ${d0?.passed})`);
      check(d0?.passLines === 1, `LIVE OK: bra103 has 1 PASS line (got ${d0?.passLines})`);
      check((outD.typecheck as any)?.passed === true, `LIVE OK: typecheck passed (got ${JSON.stringify(outD.typecheck)})`);
      const s = outD.suite as any;
      check(s?.mode === "scoped", `LIVE OK: suite mode is scoped (got ${s?.mode})`);
      check(s?.sectionsRan === 2, `LIVE OK: 2 sections ran (got ${s?.sectionsRan})`);
      check(s?.allPassed === true, `LIVE OK: suite all passed (got ${s?.allPassed})`);
      check(s?.totalOk >= 5, `LIVE OK: suite totalOk >= 5 (got ${s?.totalOk})`);
      check(Array.isArray(s?.sections) && s.sections.length === 2, `LIVE OK: 2 per-section results (got ${s?.sections?.length})`);
      check((outD.confinement as any)?.confined === true, `LIVE OK: confinement confined (got ${JSON.stringify(outD.confinement)})`);
      check((outD.baseline as any)?.compared === false, `LIVE OK: baseline skipped on a scoped run (got ${JSON.stringify(outD.baseline)})`);
      check(typeof outD.knownLimit === "string" && /false pass/.test(outD.knownLimit),
        `LIVE OK: the report carries the known v0 limit`);
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA158 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra158 fix verification workflow (inventory check, agentts check, pure unit checks, live scoped run — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
