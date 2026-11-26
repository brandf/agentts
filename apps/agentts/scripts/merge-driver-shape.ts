#!/usr/bin/env bun
/**
 * merge-driver-shape — the shared shape check for merge drivers
 * (defect 19, parent the merge workflow BRA-261).
 *
 * A merge driver drives the merge workflow and then checks the merge
 * report's shape: did the run succeed, and did every claimed file land
 * exactly once? The 211 re-drive driver inlined its own check and got
 * it wrong: it required `applied == claimed`, so a carryForwardResume
 * re-drive whose merge correctly reported applied == [] and
 * alreadyApplied == [the 1 file] exited rc=1 on a merged run
 * (BACKLOG.md line 1941). Future drivers import checkMergeDriverShape
 * from here instead of inlining their own check.
 *
 * The rule is a partition rule, not a two-shape whitelist: every
 * claimed file appears exactly once across `applied` and
 * `alreadyApplied`, regardless of drive mode. That accepts the fresh
 * drive (applied == the changed files), the carryForwardResume
 * re-drive (alreadyApplied == the changed files, applied == []), and
 * the mix (some files applied fresh, some already applied — the shape
 * a re-drive takes when the first drive applied only a subset before
 * being cancelled). It must not key on the drive mode: the 134 (b)
 * fresh run proved a fresh drive can legitimately report alreadyApplied
 * (applied == 8, alreadyApplied == 3), so requiring applied == claimed
 * or alreadyApplied == [] is wrong in the same way the 211 check was.
 *
 * The module takes the expected suite values as an argument — it does
 * not hardcode any run's numbers (73/5,459 are the 211 driver's
 * expectations, not this module's). The plan-clean part is the generic
 * classification (no conflicts, no baselinesRefused, confinement
 * confined with no extras/missing); the driver's own drive-specific
 * expectations (planned == claimed, liveOnlyPreserved, manifest
 * timestamp) stay in the driver's own checkPlan. A report with notes
 * has verdict "failed" by the merge's verdict rule, so the verdict
 * check covers notes.
 *
 * Usage (from a merge driver, path relative to the copy root):
 *   import { checkMergeDriverShape } from "./apps/agentts/scripts/merge-driver-shape.ts";
 *   // or by absolute path into the copy:
 *   import { checkMergeDriverShape } from "<copy>/apps/agentts/scripts/merge-driver-shape.ts";
 *   const { ok, reason } = checkMergeDriverShape(report, claimed, expectedSuite);
 *
 * Verified by the probe apps/agentts/scripts/probe-merge-driver-shape.ts
 * (six fixtures: the real 211 report, a synthetic fresh drive, the mix,
 * and three negatives). Run by bun; not in the tsconfig include, so it
 * is verified at runtime by the probe, not by tsc.
 */

export interface MergeSuiteExpectation {
  sectionsRan: number;
  totalOk: number;
  allPassed: boolean;
  summaryMatchesIndependent: boolean;
}

/** The merge-report fields this check reads. Everything else is ignored. */
export interface MergeReportShape {
  verdict?: unknown;
  applied?: unknown;
  alreadyApplied?: unknown;
  conflicts?: unknown;
  baselinesRefused?: unknown;
  confinement?: unknown;
  suite?: unknown;
}

export interface ShapeCheckResult {
  ok: boolean;
  reason: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

/**
 * Check a merge report's shape against the claimed file set.
 *
 * @param report the merge report object (as returned by the merge workflow).
 * @param claimed the files the driver claimed for this merge, sorted or not.
 * @param expectedSuite the driver's expected suite values (sectionsRan,
 *   totalOk, allPassed, summaryMatchesIndependent) — never hardcoded here.
 * @returns { ok, reason } — ok is true only when every condition holds;
 *   reason names the first failing condition in plain words, or states
 *   the passing shape.
 */
export function checkMergeDriverShape(
  report: MergeReportShape,
  claimed: string[],
  expectedSuite: MergeSuiteExpectation,
): ShapeCheckResult {
  // 1. The merge must have succeeded.
  if (report.verdict !== "merged") {
    return { ok: false, reason: `verdict is ${JSON.stringify(report.verdict)}, not "merged"` };
  }

  // 2. The plan must be clean: no conflicts, nothing refused, confinement confined.
  if (!Array.isArray(report.conflicts) || report.conflicts.length !== 0) {
    return { ok: false, reason: `conflicts is not empty: ${JSON.stringify(report.conflicts)}` };
  }
  if (!Array.isArray(report.baselinesRefused) || report.baselinesRefused.length !== 0) {
    return { ok: false, reason: `baselinesRefused is not empty: ${JSON.stringify(report.baselinesRefused)}` };
  }
  const confinement = report.confinement as
    | { confined?: unknown; extras?: unknown; missing?: unknown }
    | undefined;
  if (!confinement || confinement.confined !== true) {
    return { ok: false, reason: `confinement is not confined: ${JSON.stringify(report.confinement)}` };
  }
  if (!Array.isArray(confinement.extras) || confinement.extras.length !== 0) {
    return { ok: false, reason: `confinement extras is not empty: ${JSON.stringify(confinement.extras)}` };
  }
  if (!Array.isArray(confinement.missing) || confinement.missing.length !== 0) {
    return { ok: false, reason: `confinement missing is not empty: ${JSON.stringify(confinement.missing)}` };
  }

  // 3. The partition rule: every claimed file appears exactly once across
  // applied and alreadyApplied, regardless of drive mode.
  if (!isStringArray(report.applied)) {
    return { ok: false, reason: `report is missing applied (expected a string array)` };
  }
  if (!isStringArray(report.alreadyApplied)) {
    return { ok: false, reason: `report is missing alreadyApplied (expected a string array)` };
  }
  const applied = report.applied as string[];
  const alreadyApplied = report.alreadyApplied as string[];
  const claimedSorted = sorted(claimed);
  const appliedSet = new Set(applied);
  const alreadySet = new Set(alreadyApplied);
  for (const file of claimedSorted) {
    const inApplied = appliedSet.has(file);
    const inAlready = alreadySet.has(file);
    if (inApplied && inAlready) {
      return { ok: false, reason: `file ${file} is in both applied and alreadyApplied` };
    }
    if (!inApplied && !inAlready) {
      return { ok: false, reason: `applied+alreadyApplied is missing ${file}` };
    }
  }
  for (const file of applied) {
    if (!claimedSorted.includes(file)) {
      return { ok: false, reason: `applied contains extra file ${file} (not in the claimed set)` };
    }
  }
  for (const file of alreadyApplied) {
    if (!claimedSorted.includes(file)) {
      return { ok: false, reason: `alreadyApplied contains extra file ${file} (not in the claimed set)` };
    }
  }
  if (applied.length + alreadyApplied.length !== claimedSorted.length) {
    return {
      ok: false,
      reason: `applied+alreadyApplied covers ${applied.length + alreadyApplied.length} files, expected ${claimedSorted.length} claimed files`,
    };
  }

  // 4. The suite must match the driver's expectations.
  const suite = report.suite as
    | {
        sectionsRan?: unknown;
        totalOk?: unknown;
        allPassed?: unknown;
        summaryMatchesIndependent?: unknown;
      }
    | undefined;
  if (!suite || typeof suite !== "object") {
    return { ok: false, reason: `report is missing suite` };
  }
  if (suite.sectionsRan !== expectedSuite.sectionsRan) {
    return {
      ok: false,
      reason: `suite sectionsRan is ${JSON.stringify(suite.sectionsRan)}, expected ${expectedSuite.sectionsRan}`,
    };
  }
  if (suite.totalOk !== expectedSuite.totalOk) {
    return {
      ok: false,
      reason: `suite totalOk is ${JSON.stringify(suite.totalOk)}, expected ${expectedSuite.totalOk}`,
    };
  }
  if (suite.allPassed !== expectedSuite.allPassed) {
    return {
      ok: false,
      reason: `suite allPassed is ${JSON.stringify(suite.allPassed)}, expected ${expectedSuite.allPassed}`,
    };
  }
  if (suite.summaryMatchesIndependent !== expectedSuite.summaryMatchesIndependent) {
    return {
      ok: false,
      reason: `suite summaryMatchesIndependent is ${JSON.stringify(suite.summaryMatchesIndependent)}, expected ${expectedSuite.summaryMatchesIndependent}`,
    };
  }

  return {
    ok: true,
    reason:
      `merged: ${claimedSorted.length} claimed file(s) partitioned across ` +
      `applied (${applied.length}) and alreadyApplied (${alreadyApplied.length}); ` +
      `suite ${expectedSuite.sectionsRan}/${expectedSuite.totalOk} allPassed`,
  };
}
