#!/usr/bin/env bun
/**
 * Leg for defect 7 (M3 — a fresh-dir merge run repaired by the engine
 * fails as an unverified resume).
 *
 * The resume-pre pin is written only in the carryForwardResume branch
 * of the step-5b pre-check (merge.ts ~1782). A fresh-dir run sets
 * resumedPre = 0 and writes no pin. If that run is killed mid-tier-1,
 * the engine repairs it by resuming from the snapshot blob — the
 * workflow resumes at the tier-1 step with resumedPre still 0 (the
 * pre-check does not re-run). run.sh resumes from the journal (64
 * skipped via resume, 8 fresh in the observed 134 run); the tier-1
 * completes 72/72 all passing. But the report carried resumedSections
 * 0 with skippedViaResume 64, so two checks fired: the verdict rule
 * (buildMergeReport: skippedViaResume !== 0 && resumedSections === 0
 * → the "a resumed run proves nothing" note) and the reconciliation
 * (skippedViaResume !== 0 && resumedPre === 0 → summaryMatches-
 * Independent = false → the summary-mismatch note). Any note →
 * verdict "failed" — a clean tier-1 failed as an unverified resume.
 *
 * Shape A (as amended): when the full tier-1 ran, the report's
 * resumedSections is max(resumedPre, skippedViaResume) — the pin
 * when a pin exists (carryForwardResume), else the tier-1 summary's
 * skippedViaResume (the true resumed count — run.sh skips a section
 * only when it has a journal row (rc=0) + a .done marker, the same
 * proof the carryForwardResume branch uses). The two numbers measure
 * different things (skippedViaResume is the chunk-level count —
 * chunks reused via their report.json; the pin is the journal-level
 * count — sections the carried-forward journal already has), and
 * defect 6's re-drive is the proof: skippedViaResume 0 (no chunk
 * reused) while the pin said 26 — the unamended formula would record
 * 0 for a run that carried 26 sections forward. And the
 * reconciliation's `skippedViaResume !== 0 && resumedPre === 0` line
 * is removed (the post-run journal validation + the sectionsRan+
 * skipped check already prove the skips are verified). The pin, the
 * pre-check, and reconcileResumeCounts are untouched.
 *
 * This leg is a STANDALONE test (run directly with bun) — it is NOT
 * a tier-1 section and must never be added to suite-inventory.json
 * (the baseline stays 73 sections / 5,459 OK).
 *
 *   bun tests/test-bra-defect7.ts
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import {
  buildMergeReport,
  reconcileTier1Summary,
  resumedSectionsForReport,
  type ResumeJournalResult,
  type SuiteResult,
} from "../workflows/library/merge";

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

/** The workflow's verdict flip (merge.ts step 11): any note → "failed". */
function finalVerdict(report: { verdict: string; notes: string[] }): string {
  return report.notes.length > 0 ? "failed" : report.verdict;
}

function fakeSuite(over: Partial<SuiteResult> = {}): SuiteResult {
  return {
    mode: "full",
    tier: 1,
    sectionsRan: 72,
    totalOk: 5409,
    passLines: 66,
    sections: [],
    allPassed: true,
    skippedViaResume: 64,
    summaryLine: "PASS tier 1 (quick) — 8 sections ran, 5409 OK, 120s; skipped 64 via resume, 36 by tier/selection",
    summaryMatchesIndependent: true,
    elapsedMs: 1,
    ...over,
  };
}

function fakeReportArgs(over: {
  suite: SuiteResult;
  resumedSections: number;
}) {
  return {
    mergeId: "DEFECT-7-LEG",
    verdict: "merged" as const,
    dryRun: false,
    tier1InFlight: false,
    applied: ["CHANGELOG.md"],
    deleted: [],
    planned: ["CHANGELOG.md"],
    alreadyApplied: [],
    liveOnlyPreserved: [],
    conflicts: [],
    baselinesRefused: [],
    confinement: { confined: true, extras: [], missing: [] },
    typecheck: { ran: true, exitCode: 0, passed: true, stderrHead: "" },
    suite: over.suite,
    baseline: {
      compared: true,
      baselineLabel: "live tier-1 (72 passing)",
      baselineSections: 72,
      baselineOk: 5409,
      deltaSections: 0,
      deltaOk: 0,
      expectedSections: 0,
      expectedOk: 0,
      explained: true,
      explanation: "expected growth: +0 sections / +0 OK",
    },
    manifestCopiedAt: "2026-11-25T13:43:33.852318+00:00",
    resumedSections: over.resumedSections,
    resumeFallback: null,
  };
}

const validJournal: ResumeJournalResult = { status: "valid", resumed: 72, rows: 72, reason: null };
const invalidJournal: ResumeJournalResult = { status: "invalid", resumed: 0, rows: 0, reason: "progress.jsonl unparsable" };

// --- (0) The resumedSections formula (Shape A as amended): max(pin, skipped) ---
check(resumedSectionsForReport({ resumedPre: 0, skippedViaResume: 64, tier1Ran: true }) === 64, `MAX OK: max(0, 64) = 64 (got ${resumedSectionsForReport({ resumedPre: 0, skippedViaResume: 64, tier1Ran: true })}) — the M3 case`);
check(resumedSectionsForReport({ resumedPre: 26, skippedViaResume: 0, tier1Ran: true }) === 26, `MAX OK: max(26, 0) = 26 (got ${resumedSectionsForReport({ resumedPre: 26, skippedViaResume: 0, tier1Ran: true })}) — the defect-6 re-drive shape (the pin, not 0)`);
check(resumedSectionsForReport({ resumedPre: 64, skippedViaResume: 64, tier1Ran: true }) === 64, `MAX OK: max(64, 64) = 64 (got ${resumedSectionsForReport({ resumedPre: 64, skippedViaResume: 64, tier1Ran: true })}) — pin == skipped`);
check(resumedSectionsForReport({ resumedPre: 0, skippedViaResume: 0, tier1Ran: true }) === 0, `MAX OK: max(0, 0) = 0 (got ${resumedSectionsForReport({ resumedPre: 0, skippedViaResume: 0, tier1Ran: true })}) — the fresh run`);
check(resumedSectionsForReport({ resumedPre: 26, skippedViaResume: 0, tier1Ran: false }) === 26, `MAX OK: tier-1 did not run → the pin (26, got ${resumedSectionsForReport({ resumedPre: 26, skippedViaResume: 0, tier1Ran: false })})`);

// --- (a) The engine-repaired shape (the observed 134 run): 64 skipped, 8 fresh, resumedPre 0 ---
const repaired = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 8, skippedViaResume: 64, ok: 5409 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: validJournal,
  resumedPre: 0,
});
check(repaired.summaryMatchesIndependent === true, `REPAIRED OK: summaryMatchesIndependent is true (got ${repaired.summaryMatchesIndependent}) — the removed pre-run proxy no longer fires on a genuine resume`);
check(repaired.skippedViaResume === 64, `REPAIRED OK: skippedViaResume is 64 (got ${repaired.skippedViaResume}) — the true resumed count, carried forward`);
const repairedReport = buildMergeReport(fakeReportArgs({ suite: fakeSuite({ skippedViaResume: 64, summaryMatchesIndependent: repaired.summaryMatchesIndependent }), resumedSections: resumedSectionsForReport({ resumedPre: 0, skippedViaResume: repaired.skippedViaResume, tier1Ran: true }) }));
check(repairedReport.notes.length === 0, `REPAIRED OK: no notes (got ${JSON.stringify(repairedReport.notes)}) — no "resumed run proves nothing", no summary-mismatch`);
check(finalVerdict(repairedReport) === "merged", `REPAIRED OK: the verdict is "merged" (got ${finalVerdict(repairedReport)})`);
check(repairedReport.resumedSections === 64, `REPAIRED OK: resumedSections is 64 (got ${repairedReport.resumedSections}) — max(0, 64), not the pre-run 0`);

// --- (a) Control: the OLD shape (resumedSections 0 with skipped 64) would have failed ---
const oldReport = buildMergeReport(fakeReportArgs({ suite: fakeSuite({ skippedViaResume: 64, summaryMatchesIndependent: true }), resumedSections: 0 }));
check(
  oldReport.notes.some((n) => n.includes("a resumed run proves nothing")),
  `CONTROL OK: the old shape (resumedSections 0, skipped 64) still carries the "resumed run proves nothing" note (got ${JSON.stringify(oldReport.notes)})`,
);
check(finalVerdict(oldReport) === "failed", `CONTROL OK: the old shape's verdict is "failed" (got ${finalVerdict(oldReport)})`);

// --- (b) The carryForwardResume shape: pin == skipped → unchanged ---
const carried = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 8, skippedViaResume: 64, ok: 5409 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: validJournal,
  resumedPre: 64,
});
check(carried.summaryMatchesIndependent === true, `CARRIED OK: summaryMatchesIndependent is true (got ${carried.summaryMatchesIndependent})`);
check(carried.skippedViaResume === 64, `CARRIED OK: skippedViaResume is 64 (got ${carried.skippedViaResume}) — the same carried-forward journal, unchanged`);
const carriedReport = buildMergeReport(fakeReportArgs({ suite: fakeSuite({ skippedViaResume: 64, summaryMatchesIndependent: carried.summaryMatchesIndependent }), resumedSections: resumedSectionsForReport({ resumedPre: 64, skippedViaResume: carried.skippedViaResume, tier1Ran: true }) }));
check(carriedReport.notes.length === 0, `CARRIED OK: no notes (got ${JSON.stringify(carriedReport.notes)})`);
check(finalVerdict(carriedReport) === "merged", `CARRIED OK: the verdict is "merged" (got ${finalVerdict(carriedReport)})`);
check(carriedReport.resumedSections === 64, `CARRIED OK: resumedSections is 64 (got ${carriedReport.resumedSections}) — max(64, 64), unchanged from the old behavior (resumedPre was 64)`);

// --- (b) also: the defect-6 re-drive shape (the amendment) — pin 26, skipped 0 → resumedSections 26, NOT 0 ---
// Defect 6's re-drive: the tier-1 ran all 73 sections fresh (skippedViaResume 0 —
// no chunk was reused, chunk-0's report was missing after the kill) while the
// pin recorded 26 (the carried-forward journal's verified count). Under the
// unamended Shape A (resumedSections = skippedViaResume) this run would
// record resumedSections 0 — wrong. max(26, 0) = 26.
const defect6Redrive = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 73, skippedViaResume: 0, ok: 5459 },
  aggSectionsRan: 73,
  aggTotalOk: 5459,
  journalAfter: { status: "valid", resumed: 73, rows: 73, reason: null },
  resumedPre: 26,
});
check(defect6Redrive.summaryMatchesIndependent === true, `D6-REDRIVE OK: summaryMatchesIndependent is true (got ${defect6Redrive.summaryMatchesIndependent})`);
check(defect6Redrive.skippedViaResume === 0, `D6-REDRIVE OK: skippedViaResume is 0 (got ${defect6Redrive.skippedViaResume}) — no chunk was reused`);
const defect6Report = buildMergeReport(fakeReportArgs({
  suite: fakeSuite({ sectionsRan: 73, totalOk: 5459, skippedViaResume: 0, summaryMatchesIndependent: defect6Redrive.summaryMatchesIndependent }),
  resumedSections: resumedSectionsForReport({ resumedPre: 26, skippedViaResume: defect6Redrive.skippedViaResume, tier1Ran: true }),
}));
check(defect6Report.notes.length === 0, `D6-REDRIVE OK: no notes (got ${JSON.stringify(defect6Report.notes)})`);
check(finalVerdict(defect6Report) === "merged", `D6-REDRIVE OK: the verdict is "merged" (got ${finalVerdict(defect6Report)})`);
check(defect6Report.resumedSections === 26, `D6-REDRIVE OK: resumedSections is 26 (got ${defect6Report.resumedSections}) — max(26, 0), the pin, NOT 0`);

// --- (c) The fresh shape: skipped 0 → unchanged ---
const fresh = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 72, skippedViaResume: 0, ok: 5409 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: validJournal,
  resumedPre: 0,
});
check(fresh.summaryMatchesIndependent === true, `FRESH OK: summaryMatchesIndependent is true (got ${fresh.summaryMatchesIndependent})`);
check(fresh.skippedViaResume === 0, `FRESH OK: skippedViaResume is 0 (got ${fresh.skippedViaResume})`);
const freshReport = buildMergeReport(fakeReportArgs({ suite: fakeSuite({ sectionsRan: 72, skippedViaResume: 0, summaryMatchesIndependent: fresh.summaryMatchesIndependent }), resumedSections: resumedSectionsForReport({ resumedPre: 0, skippedViaResume: fresh.skippedViaResume, tier1Ran: true }) }));
check(freshReport.notes.length === 0, `FRESH OK: no notes (got ${JSON.stringify(freshReport.notes)})`);
check(finalVerdict(freshReport) === "merged", `FRESH OK: the verdict is "merged" (got ${finalVerdict(freshReport)})`);
check(freshReport.resumedSections === 0, `FRESH OK: resumedSections is 0 (got ${freshReport.resumedSections}) — unchanged`);

// --- (d) The genuinely-unverified shape: the summary claims skips but the journal is invalid ---
const unverified = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 8, skippedViaResume: 64, ok: 5409 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: invalidJournal,
  resumedPre: 0,
});
check(unverified.summaryMatchesIndependent === false, `UNVERIFIED OK: summaryMatchesIndependent is false (got ${unverified.summaryMatchesIndependent}) — a summary claiming skips with an invalid journal still fails`);
const unverifiedReport = buildMergeReport(fakeReportArgs({ suite: fakeSuite({ skippedViaResume: 64, summaryMatchesIndependent: unverified.summaryMatchesIndependent }), resumedSections: 64 }));
check(
  unverifiedReport.notes.some((n) => n === "suite summary line does not match the independent log counts"),
  `UNVERIFIED OK: the summary-mismatch note fires (got ${JSON.stringify(unverifiedReport.notes)})`,
);
check(finalVerdict(unverifiedReport) === "failed", `UNVERIFIED OK: the verdict is "failed" (got ${finalVerdict(unverifiedReport)})`);

// --- (d) also: a missing summary fails ---
const noSummary = reconcileTier1Summary({
  effectiveSummary: null,
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: validJournal,
  resumedPre: 0,
});
check(noSummary.summaryMatchesIndependent === false, `UNVERIFIED OK: a missing summary still fails (got ${noSummary.summaryMatchesIndependent})`);

// --- (e) The journal reconciliation still guards a shrunk journal ---
const shrunk = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 8, skippedViaResume: 64, ok: 5409 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: { status: "valid", resumed: 60, rows: 60, reason: null },
  resumedPre: 64,
});
check(shrunk.summaryMatchesIndependent === false, `SHRUNK OK: a journal that lost sections still fails (resumedPre 64, journalAfter 60, got ${shrunk.summaryMatchesIndependent})`);

// --- (f) The arithmetic guards still fire (a summary that does not add up) ---
const badSum = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 8, skippedViaResume: 60, ok: 5409 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: validJournal,
  resumedPre: 0,
});
check(badSum.summaryMatchesIndependent === false, `SUM OK: fresh + resumed != total still fails (8 + 60 != 72, got ${badSum.summaryMatchesIndependent})`);
const badOk = reconcileTier1Summary({
  effectiveSummary: { sectionsRan: 8, skippedViaResume: 64, ok: 5400 },
  aggSectionsRan: 72,
  aggTotalOk: 5409,
  journalAfter: validJournal,
  resumedPre: 0,
});
check(badOk.summaryMatchesIndependent === false, `SUM OK: a mismatched OK total still fails (5400 != 5409, got ${badOk.summaryMatchesIndependent})`);

if (FAILURES.length > 0) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log("\nPASS defect 7 leg");
