#!/usr/bin/env bun
/**
 * Leg for defect 6 (verify-fix aggregation masks tier-1 failures).
 *
 * A failed section leaves a log but no .done marker and no progress
 * row (run.sh exits 1 before both writes), so the old aggregation —
 * sectionsRan from the marker count, per-section lines from the logs
 * — threw ("aggregation lists X section logs but sectionsRan is Y")
 * instead of reporting the failed slugs. Shape B (the fix): the
 * aggregation counts LOGS for sectionsRan, and verify-fix names the
 * failed slugs (from report-tier1.json's failedSlugs in full mode,
 * from the scoped runs' exit codes in scoped mode).
 *
 * This leg is a STANDALONE test (run directly with bun) — it is NOT
 * a tier-1 section and must never be added to suite-inventory.json
 * (the baseline stays 73 sections / 5,459 OK).
 *
 *   bun tests/test-bra-defect6.ts
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseTier1Aggregation,
  tier1AggregationScript,
  parseReportTier1FailedSlugs,
  failedSlugsFromAggregation,
  buildVerifyReport,
  type SuiteResult,
} from "../workflows/library/verify-fix";

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "defect6-leg-"));

function writeLog(dir: string, slug: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, slug + ".log"), lines.join("\n") + "\n");
}
function writeMarker(dir: string, slug: string, oks: number): void {
  fs.writeFileSync(path.join(dir, slug), `ok=${oks}\nelapsed_s=1\nts=2026-11-25T00:00:00Z\n`);
}

/** Run the aggregation script (the shell it generates) and return its stdout. */
function runAggregation(logDir: string, doneDir: string): { rc: number; out: string; err: string } {
  const script = tier1AggregationScript(logDir, doneDir);
  const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function fakeSuite(over: Partial<SuiteResult> = {}): SuiteResult {
  return {
    mode: "full",
    tier: 1,
    sectionsRan: 3,
    totalOk: 10,
    passLines: 2,
    sections: [
      { slug: "bra101", ok: 3, passLines: 1, verdictPresent: true },
      { slug: "bra103", ok: 7, passLines: 1, verdictPresent: true },
      { slug: "defect6fail", ok: 0, passLines: 0, verdictPresent: false },
    ],
    allPassed: false,
    failedSlugs: ["defect6fail"],
    skippedViaResume: 0,
    summaryLine: "",
    summaryMatchesIndependent: false,
    elapsedMs: 1,
    ...over,
  };
}

// --- Fixture: 2 passing sections (log + marker) + 1 failing section (log, NO marker) ---
const logDir = path.join(TMP, "logs");
const doneDir = path.join(TMP, ".done");
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(doneDir, { recursive: true });
writeLog(logDir, "bra101", ["CHECK OK: a", "CHECK OK: b", "CHECK OK: c", "PASS bra101"]);
writeLog(logDir, "bra103", ["CHECK OK: a", "CHECK OK: b", "CHECK OK: c", "CHECK OK: d", "CHECK OK: e", "CHECK OK: f", "CHECK OK: g", "PASS bra103"]);
writeLog(logDir, "defect6fail", ["section defect6fail FAILED (rc=1, 1s) — last 40 lines:", "some failure output"]);
writeMarker(doneDir, "bra101", 3);
writeMarker(doneDir, "bra103", 7);
// NOTE: no marker for defect6fail — that is the defect-6 shape (log without marker).

const markerCount = fs.readdirSync(doneDir).length;
check(markerCount === 2, `FIXTURE OK: marker count is 2 (got ${markerCount})`);
check(fs.readdirSync(logDir).length === 3, `FIXTURE OK: log count is 3 (got ${fs.readdirSync(logDir).length})`);

// --- 1. The aggregation counts LOGS for sectionsRan (Shape B) ---
const agg = runAggregation(logDir, doneDir);
check(agg.rc === 0, `AGG OK: aggregation script exits 0 (got ${agg.rc}: ${agg.err.slice(0, 200)})`);
let parsed: ReturnType<typeof parseTier1Aggregation> | null = null;
try {
  parsed = parseTier1Aggregation(agg.out);
  ok("AGG OK: aggregation parses (no throw) on a fixture with a failed section");
} catch (e) {
  fail(`AGG OK: aggregation threw on a fixture with a failed section: ${(e as Error).message}`);
}
if (parsed) {
  check(parsed.sectionsRan === 3, `AGG OK: sectionsRan counts the logs (3, got ${parsed.sectionsRan}) — not the markers (2)`);
  check(parsed.perSection.length === 3, `AGG OK: per-section lines are 3 (got ${parsed.perSection.length})`);
  check(parsed.totalOk === 10, `AGG OK: totalOk is 10 (got ${parsed.totalOk})`);
  check(parsed.passLines === 2, `AGG OK: passLines is 2 (got ${parsed.passLines})`);
  const failed = parsed.perSection.find((s) => s.slug === "defect6fail");
  check(failed !== undefined, "AGG OK: the failed slug is present in the per-section lines");
  check(failed !== undefined && failed.ok === 0 && failed.passLines === 0, `AGG OK: the failed slug has ok=0/passLines=0 (got ${JSON.stringify(failed)})`);
}

// --- 2. Control: the OLD shape (sectionsRan from markers) would have thrown ---
const oldText = agg.out.replace(/^sectionsRan=\d+$/m, "sectionsRan=2");
try {
  parseTier1Aggregation(oldText);
  fail("CONTROL OK: the old marker-count aggregation (sectionsRan=2, 3 logs) did NOT throw — it should have");
} catch (e) {
  check(
    (e as Error).message.includes("3 section logs but sectionsRan is 2"),
    `CONTROL OK: the old marker-count aggregation throws as the defect recorded (got ${(e as Error).message.slice(0, 120)})`,
  );
}

// --- 3. The failed-slug helpers ---
const reportJson = JSON.stringify({ tier: 1, ran: 3, passed: 2, failed: 1, totalOk: 10, flaky: [], failedSlugs: ["defect6fail"] });
check(
  JSON.stringify(parseReportTier1FailedSlugs(reportJson)) === JSON.stringify(["defect6fail"]),
  `REPORT OK: parseReportTier1FailedSlugs returns ["defect6fail"] (got ${JSON.stringify(parseReportTier1FailedSlugs(reportJson))})`,
);
check(parseReportTier1FailedSlugs("{}").length === 0, "REPORT OK: a report without failedSlugs returns []");
check(parseReportTier1FailedSlugs("not json").length === 0, "REPORT OK: malformed JSON returns []");
check(parseReportTier1FailedSlugs(JSON.stringify({ failedSlugs: "defect6fail" })).length === 0, "REPORT OK: a non-array failedSlugs returns []");
if (parsed) {
  check(
    JSON.stringify(failedSlugsFromAggregation(parsed.perSection)) === JSON.stringify(["defect6fail"]),
    `REPORT OK: failedSlugsFromAggregation returns ["defect6fail"] (got ${JSON.stringify(failedSlugsFromAggregation(parsed.perSection))})`,
  );
}

// --- 4. The report NAMES the failed slugs (and the verdict is failed) ---
const report = buildVerifyReport({
  fixId: "defect-6",
  direct: [],
  typecheck: { ran: false, exitCode: -1, passed: false, stderrHead: "" },
  suite: fakeSuite(),
  confinement: { confined: true, extras: [], missing: [] },
  baseline: { compared: false, baselineLabel: "", baselineSections: 0, baselineOk: 0, deltaSections: 0, deltaOk: 0, expectedSections: 0, expectedOk: 0, explained: true, explanation: "not compared" },
});
check(report.verdict === "failed", `REPORT OK: the verdict is "failed" (got ${report.verdict})`);
check(
  report.notes.some((n) => n === "suite failed sections: defect6fail"),
  `REPORT OK: a note names the failed slug exactly (got ${JSON.stringify(report.notes)})`,
);

// --- 5. The passing path is unchanged ---
const passLogDir = path.join(TMP, "pass-logs");
const passDoneDir = path.join(TMP, "pass-.done");
fs.mkdirSync(passLogDir, { recursive: true });
fs.mkdirSync(passDoneDir, { recursive: true });
writeLog(passLogDir, "bra101", ["CHECK OK: a", "CHECK OK: b", "CHECK OK: c", "PASS bra101"]);
writeLog(passLogDir, "bra103", ["CHECK OK: a", "PASS bra103"]);
writeMarker(passDoneDir, "bra101", 3);
writeMarker(passDoneDir, "bra103", 1);
const passAgg = runAggregation(passLogDir, passDoneDir);
let passParsed: ReturnType<typeof parseTier1Aggregation> | null = null;
try {
  passParsed = parseTier1Aggregation(passAgg.out);
  ok("PASS OK: the passing fixture parses (no throw)");
} catch (e) {
  fail(`PASS OK: the passing fixture threw: ${(e as Error).message}`);
}
if (passParsed) {
  check(passParsed.sectionsRan === 2, `PASS OK: sectionsRan is 2 on the passing fixture (got ${passParsed.sectionsRan}) — the same as the marker count`);
  check(passParsed.totalOk === 4, `PASS OK: totalOk is 4 on the passing fixture (got ${passParsed.totalOk})`);
}
const passReport = buildVerifyReport({
  fixId: "defect-6",
  direct: [],
  typecheck: { ran: false, exitCode: -1, passed: false, stderrHead: "" },
  suite: fakeSuite({ sectionsRan: 2, totalOk: 4, passLines: 2, allPassed: true, failedSlugs: [], sections: [
    { slug: "bra101", ok: 3, passLines: 1, verdictPresent: true },
    { slug: "bra103", ok: 1, passLines: 1, verdictPresent: true },
  ], summaryMatchesIndependent: true }),
  confinement: { confined: true, extras: [], missing: [] },
  baseline: { compared: false, baselineLabel: "", baselineSections: 0, baselineOk: 0, deltaSections: 0, deltaOk: 0, expectedSections: 0, expectedOk: 0, explained: true, explanation: "not compared" },
});
check(passReport.verdict === "verified", `PASS OK: the passing report's verdict is "verified" (got ${passReport.verdict})`);
check(
  !passReport.notes.some((n) => n.startsWith("suite failed sections:")),
  `PASS OK: the passing report names no failed sections (got ${JSON.stringify(passReport.notes)})`,
);

// --- 6. The count check still guards internal consistency ---
try {
  parseTier1Aggregation("sectionsRan=2\nbra101 3 1\nbra103 1 1\nbra999 0 0\ntotalOk=4\npassLines=2\n");
  fail("CHECK OK: a malformed aggregation (3 lines, sectionsRan=2) did NOT throw — it should have");
} catch (e) {
  check(
    (e as Error).message.includes("3 section logs but sectionsRan is 2"),
    `CHECK OK: a malformed aggregation still throws (got ${(e as Error).message.slice(0, 120)})`,
  );
}

if (FAILURES.length > 0) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS defect 6 leg");
