#!/usr/bin/env bun
/**
 * probe-merge-driver-shape — the acceptance probe for defect 19
 * (the merge driver's shape check, parent BRA-261).
 *
 * Imports checkMergeDriverShape from ./merge-driver-shape.ts and runs
 * six fixtures, one line per fixture (PASS/FAIL + the reason):
 *   (a) the demonstrated case — the REAL 211 merge report, read from
 *       ~/workspace/bra211-merge-report.json (not copied into this
 *       probe), with claimed == [apps/agentts/workflows/README.md] —
 *       must PASS (this is the case the 211 re-drive driver exited
 *       rc=1 on);
 *   (b) the fresh-drive case — a synthetic report with applied == the
 *       1 file, alreadyApplied == [] — must PASS;
 *   (c) the mix case — a synthetic report with the claimed set split
 *       across applied and alreadyApplied — must PASS;
 *   (d) negative — missing file: applied == [], alreadyApplied == []
 *       with a non-empty claimed set — must FAIL with a reason naming
 *       the missing file;
 *   (e) negative — overlap: a file in BOTH applied and alreadyApplied
 *       — must FAIL with a reason naming the offending file;
 *   (f) negative — extra file: a file outside the claimed set — must
 *       FAIL with a reason naming the offending file.
 *
 * Exit codes: 0 = all six fixtures hold as specified; 1 = any fixture
 * does not. The expected suite values are the 211 driver's
 * expectations (73 sections / 5,459 OK, allPassed, summaryMatchesIndependent)
 * — passed in as an argument, never hardcoded in the module.
 *
 * Usage:
 *   bun apps/agentts/scripts/probe-merge-driver-shape.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkMergeDriverShape,
  type MergeReportShape,
  type MergeSuiteExpectation,
} from "./merge-driver-shape";

const README = "apps/agentts/workflows/README.md";
const RUN_SH = "apps/agentts/run.sh";
const CLI_TS = "apps/agentts/src/cli.ts";

// The 211 driver's expectations for its own merge (the numbers the
// 211 driver checked in run.ts lines 299–306). These are this probe's
// expectations, not the module's — the module takes them as an argument.
const EXPECTED_SUITE_211: MergeSuiteExpectation = {
  sectionsRan: 73,
  totalOk: 5459,
  allPassed: true,
  summaryMatchesIndependent: true,
};

function cleanReport(overrides: Partial<MergeReportShape> & { suite?: MergeSuiteExpectation }): MergeReportShape {
  return {
    verdict: "merged",
    planned: [README],
    applied: [],
    alreadyApplied: [],
    conflicts: [],
    baselinesRefused: [],
    notes: [],
    confinement: { confined: true, extras: [], missing: [] },
    suite: { ...EXPECTED_SUITE_211 },
    ...overrides,
  };
}

interface Fixture {
  label: string;
  report: MergeReportShape;
  claimed: string[];
  expectOk: boolean;
  expectReasonContains?: string;
}

const REPORT_211_PATH = path.join(process.env.HOME ?? "", "workspace", "bra211-merge-report.json");

const fixtures: Fixture[] = [];

function main(): number {
  // (a) The demonstrated case: the REAL 211 merge report, read from disk.
  const real211 = JSON.parse(fs.readFileSync(REPORT_211_PATH, "utf-8")) as MergeReportShape;
  fixtures.push({
    label: "(a) re-drive — real 211 merge report",
    report: real211,
    claimed: [README],
    expectOk: true,
  });

  // (b) The fresh-drive case (synthetic).
  fixtures.push({
    label: "(b) fresh drive — applied == the 1 file",
    report: cleanReport({ applied: [README], alreadyApplied: [] }),
    claimed: [README],
    expectOk: true,
  });

  // (c) The mix case (synthetic): the claimed set split across both lists.
  fixtures.push({
    label: "(c) mix — 1 applied + 1 alreadyApplied",
    report: cleanReport({ planned: [README, RUN_SH], applied: [README], alreadyApplied: [RUN_SH] }),
    claimed: [README, RUN_SH],
    expectOk: true,
  });

  // (d) Negative — missing file.
  fixtures.push({
    label: "(d) negative — missing file (nothing applied)",
    report: cleanReport({ applied: [], alreadyApplied: [] }),
    claimed: [README],
    expectOk: false,
    expectReasonContains: README,
  });

  // (e) Negative — overlap.
  fixtures.push({
    label: "(e) negative — overlap (file in both lists)",
    report: cleanReport({ applied: [README], alreadyApplied: [README] }),
    claimed: [README],
    expectOk: false,
    expectReasonContains: README,
  });

  // (f) Negative — extra file.
  fixtures.push({
    label: "(f) negative — extra file (not in the claimed set)",
    report: cleanReport({ applied: [README, CLI_TS], alreadyApplied: [] }),
    claimed: [README],
    expectOk: false,
    expectReasonContains: CLI_TS,
  });

  let failures = 0;
  for (const fixture of fixtures) {
    const { ok, reason } = checkMergeDriverShape(fixture.report, fixture.claimed, EXPECTED_SUITE_211);
    const reasonMatches =
      fixture.expectReasonContains === undefined || reason.includes(fixture.expectReasonContains);
    const holds = ok === fixture.expectOk && reasonMatches;
    if (holds) {
      console.log(`${fixture.label}: PASS — ${reason}`);
    } else {
      failures++;
      console.log(
        `${fixture.label}: FAIL — expected ok=${fixture.expectOk}` +
          (fixture.expectReasonContains ? ` with reason containing ${fixture.expectReasonContains}` : "") +
          `, got ok=${ok}, reason: ${reason}`,
      );
    }
  }
  console.log(`PROBE: ${fixtures.length - failures}/${fixtures.length} fixtures hold`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
