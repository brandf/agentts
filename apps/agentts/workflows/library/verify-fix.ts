// verify-fix — encode Meroki's manual fix verify+close loop as a workflow (BRA-158).
//
// The fix+verify+close loop is manual (re-run, grep logs, write the
// Linear comment, close). It went direct after BRA-121 because direct
// was faster — but that leaves the verify stage with no
// microarchitecture, so it runs on the slow manual path and is the
// serial bottleneck (BRA-155). This workflow encodes it. It complements
// BRA-155: parallel verification agents run THIS workflow rather than
// improvising, so their reports are comparable.
//
// What the manual loop does (the spec, from the brief):
//
// 1. Read the worker's report + diff. Check the diff is confined to
//    the claimed files (no scope creep, no unrelated edits).
// 2. Re-run the new/changed test DIRECTLY (fresh host built from the
//    current tree — never trust a stale binary), and count the checks
//    from the output with Meroki's own greps.
// 3. Run the tiered suite (tier 1 by default) and grep the logs for
//    the OK count, the ^PASS count, and the bench verdict — from the
//    logs, never from the runner's summary line (workers' reported
//    counts have been wrong before: BRA-117 claimed 2139/0, actual
//    2135/81).
// 4. Compare against the pre-change baseline (the suite-count
//    progression) and explain any delta (a counting-pattern
//    difference is not a regression, but it must be named).
// 5. Write the Linear comment with the evidence and close the issue.
//
// Steps 1–4 are the workflow. Step 5 is NOT: this workflow verifies;
// it never closes issues, merges code, or decides acceptance. Meroki
// reviews the report and closes. (Workers never close — that rule
// extends to this workflow.)
//
// Design decisions:
//
// 1. Counts come from the logs, never from a summary. The suite step
//    runs run.sh, then greps the on-disk section logs with one
//    `/bin/sh -c` aggregation script (one exec, one small line-based
//    result — the big outputs stay on disk). The OK count uses
//    run.sh's own narrow rule: lines containing " OK:" (the broader
//    ` OK(\s|:)` rule counts 2 extra lines on the real Nov 18 data —
//    1186 vs the recorded 1184 — so the rule matters and is stated
//    in the report). The driver's printed PASS line is parsed
//    separately and COMPARED against the independent counts; a
//    mismatch fails the verdict instead of being trusted.
// 2. ^PASS is evidence, not a gate — except through the verdict rule
//    below. Two real tier-1 sections print no line starting with
//    PASS (bra112 ends "BRA112 PASS: ...", layering ends "LAYERING
//    OK: ...") and one prints two (bra164); the Nov 19 tier-1 logs
//    show 34 ^PASS lines across 35 section logs. The report carries
//    the per-section passLines so the gap is visible, and the
//    verdict requires each section to show SOME verdict (an " OK:"
//    line or a PASS line) — a section that exits 0 with no verdict
//    at all is a no-verdict pass and fails verification.
// 3. Bench is tier 3. Tier 1 does not run it, so the report says
//    "not-run" instead of inventing a verdict. Tier >= 3 greps the
//    bench section log for ALL GREEN.
// 4. The direct re-run builds a fresh host first (make, ~3s) and
//    runs each test with that host via `env` (the exec trap has no
//    env override, so env vars ride on the command). A failed host
//    build throws loudly — without a host there is no verification
//    to report, and a loud failure is not a verdict.
// 5. The baseline comparison is skipped, with a note, for scoped
//    runs (onlySections): a 2-section run cannot be compared
//    against the full-tier progression. Scoped runs verify the
//    mechanism; only a full-tier run verifies the suite.
// 6. The direct-test verdict parser is run-tests'
//    parseSectionOutput (one counting rule, imported, not
//    duplicated) plus a ^PASS-line count of its own.
//
// Known v0 limit, recorded not fixed (same limit as BRA-126): a
// false pass — a test that passes for the wrong reason — is NOT
// diagnosed by this workflow. The workflow counts evidence; it
// does not judge whether the evidence means what it claims. The
// report carries this limit verbatim.
//
// Environment: the leaf execs inherit the CLI process's env, so the
// driver must export DQUICKTS (the dquickts tree for the C host
// build — the Makefile's default vendor dir is absent) and TMPDIR
// (scratch under /home — /tmp is a 512M tmpfs) before invoking the
// workflow. run.sh does this for its own runs; a bare CLI
// invocation must do it by hand. The workflow never reads
// process.env — every path it needs arrives in the input.

import { exec } from "../../src/agentts";
import { parseSectionOutput } from "./run-tests";

/** One direct test to re-run. */
export interface DirectTestInput {
  /** Path relative to apps/agentts, e.g. "tests/test-bra132.ts". */
  testPath: string;
  /** Checks the worker's report claims (the number Meroki counts). */
  expectedChecks: number;
}

/** One expected suite growth item (a section/checks the fix itself adds). */
export interface ExpectedAddition {
  sections: number;
  ok: number;
  /** What adds it, e.g. "BRA-132 bra132 section (84 checks)". */
  note: string;
}

/** The pre-change baseline, from the recorded suite-count progression. */
export interface SuiteBaseline {
  sections: number;
  ok: number;
  /** e.g. "pre-BRA-132 tier-1 (post-BRA-124-remaining: 35 sections / 1184 OK)". */
  label: string;
}

/** Input to the verify-fix workflow. */
export interface VerifyFixInput {
  /** e.g. "BRA-132". */
  fixId: string;
  /** Absolute path to the repo root under verification. */
  repoRoot: string;
  /** Absolute scratch dir (host build output, work files). Created by the workflow. */
  workDir: string;
  /** Fresh --resume-dir for the suite run. Must be fresh: a resumed
   * run that skips sections proves nothing (skippedViaResume > 0
   * fails the verdict). */
  resumeDir: string;
  /** Tests to re-run directly with the fresh host. */
  directTests: DirectTestInput[];
  /** dquickts tree for the C host build (default the standard minimal tree). */
  dquicktsPath?: string;
  /** bun binary (default /opt/hatch-image/bin/bun). */
  bunPath?: string;
  /** Prebuilt C host to use when buildHost is false. */
  hostPath?: string;
  /** Build a fresh host first (default true). False is for tests
   * that supply hostPath; production verification always builds. */
  buildHost?: boolean;
  /** Run `bun x tsc --noEmit` (default true). */
  typecheck?: boolean;
  /** Suite tier (default 1). */
  tier?: number;
  /** Scoped mode: run only these sections via `run.sh --bash
   * --only`. Absent means the full tier via the workflow driver.
   * Scoped runs skip the baseline comparison (see design note 5). */
  onlySections?: string[];
  /** Files the worker claims the fix touches (repo-relative paths). */
  claimedFiles: string[];
  /** Files the diff actually touches (repo-relative paths). */
  changedFiles: string[];
  /** Pre-change baseline. Absent means no comparison (noted). */
  baseline?: SuiteBaseline;
  /** Growth the fix itself is expected to add (its own new section
   * and checks). Absent means no growth is expected. */
  expectedAdditions?: ExpectedAddition[];
}

/** One direct test's re-run result. */
export interface DirectTestResult {
  testPath: string;
  exitCode: number;
  /** " OK:" lines counted (run.sh's narrow rule). */
  ok: number;
  expectedChecks: number;
  checksMatch: boolean;
  executed: boolean;
  passed: boolean;
  /** Lines starting with PASS. */
  passLines: number;
  elapsedMs: number;
}

/** The typecheck step's result. */
export interface TypecheckResult {
  ran: boolean;
  exitCode: number;
  passed: boolean;
  /** First 500 chars of stderr (empty when clean). */
  stderrHead: string;
}

/** One suite section's log evidence. */
export interface SuiteSectionResult {
  slug: string;
  ok: number;
  passLines: number;
  /** The section's log shows a verdict (an " OK:" line or a PASS line). */
  verdictPresent: boolean;
}

/** The suite step's result — counts from the on-disk logs. */
export interface SuiteResult {
  mode: string;
  tier: number;
  /** Marker files under .done (one per section that ran). */
  sectionsRan: number;
  /** Narrow-rule OK total across the section logs. */
  totalOk: number;
  /** ^PASS lines across the section logs. */
  passLines: number;
  sections: SuiteSectionResult[];
  /** Every section exited 0 AND showed a verdict in its log. */
  allPassed: boolean;
  /** Sections skipped via resume (must be 0 — a resumed run proves nothing). */
  skippedViaResume: number;
  /** The driver's printed PASS line (full mode only). */
  summaryLine: string;
  /** The summary's sections/OK match the independent log counts
   * (full mode only; scoped mode has no summary line). */
  summaryMatchesIndependent: boolean;
  elapsedMs: number;
}

/** The diff-confinement check. */
export interface ConfinementResult {
  confined: boolean;
  /** Changed but not claimed (scope creep). */
  extras: string[];
  /** Claimed but not changed (stale claim). */
  missing: string[];
}

/** The baseline comparison. */
export interface BaselineResult {
  compared: boolean;
  baselineLabel: string;
  baselineSections: number;
  baselineOk: number;
  deltaSections: number;
  deltaOk: number;
  expectedSections: number;
  expectedOk: number;
  explained: boolean;
  explanation: string;
}

/** The verify report — the workflow's output, for Meroki's review + close. */
export interface VerifyReport {
  fixId: string;
  /** "verified" means the evidence checks out. It is NOT acceptance:
   * Meroki reviews this report and closes. */
  verdict: string;
  direct: DirectTestResult[];
  typecheck: TypecheckResult;
  suite: SuiteResult;
  confinement: ConfinementResult;
  baseline: BaselineResult;
  /** The known v0 limit, carried verbatim in every report. */
  knownLimit: string;
  /** Every discrepancy, named with its counts. Empty when verified. */
  notes: string[];
}

export const VERIFY_KNOWN_LIMIT =
  "v0 limit: a false pass - a test that passes for the wrong reason - is NOT diagnosed by this workflow (same limit as BRA-126 diagnosis). The workflow counts evidence; it does not judge whether the evidence means what it claims.";

/** Parse one direct test's output. Pure — unit-tested directly.
 * The OK count is run-tests' parseSectionOutput (the narrow
 * " OK:" rule, one counting rule for the whole repo); passLines is
 * counted here because parseSectionOutput does not return it. */
export function parseDirectTestOutput(
  stdout: string,
  exitCode: number,
): { ok: number; executed: boolean; passed: boolean; passLines: number } {
  const parsed = parseSectionOutput(stdout, exitCode);
  let passLines = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("PASS")) passLines++;
  }
  return { ok: parsed.ok, executed: parsed.executed, passed: parsed.passed, passLines };
}

/** Parse run.sh's printed tier PASS line. Pure — unit-tested directly.
 * Returns null when the line is absent or malformed (a missing
 * summary is itself evidence: the run did not finish cleanly). */
export function parseTierSummaryLine(stdout: string): {
  sectionsRan: number;
  ok: number;
  wallSeconds: number;
  skippedViaResume: number;
} | null {
  const m = stdout.match(
    /PASS tier \d+ \([^)]*\) — (\d+) sections ran, (\d+) OK, (\d+)s; skipped (\d+) via resume/,
  );
  if (!m) return null;
  return {
    sectionsRan: Number(m[1]),
    ok: Number(m[2]),
    wallSeconds: Number(m[3]),
    skippedViaResume: Number(m[4]),
  };
}

/** Parse the tier-1 log aggregation's line-based output. Pure —
 * unit-tested directly. Throws loudly on any malformation: a
 * miscounted suite is worse than no suite number at all.
 * Format:
 *   sectionsRan=N
 *   <slug> <ok> <passLines>      (one line per section log)
 *   totalOk=N
 *   passLines=N */
export function parseTier1Aggregation(text: string): {
  sectionsRan: number;
  totalOk: number;
  passLines: number;
  perSection: Array<{ slug: string; ok: number; passLines: number }>;
} {
  let sectionsRan = -1;
  let totalOk = -1;
  let passLines = -1;
  const perSection: Array<{ slug: string; ok: number; passLines: number }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const kv = line.match(/^(sectionsRan|totalOk|passLines)=(\d+)$/);
    if (kv) {
      if (kv[1] === "sectionsRan") sectionsRan = Number(kv[2]);
      if (kv[1] === "totalOk") totalOk = Number(kv[2]);
      if (kv[1] === "passLines") passLines = Number(kv[2]);
      continue;
    }
    const sec = line.match(/^([A-Za-z0-9_-]+) (\d+) (\d+)$/);
    if (!sec) {
      throw new Error("verify-fix: cannot parse aggregation line: " + JSON.stringify(line));
    }
    perSection.push({ slug: sec[1], ok: Number(sec[2]), passLines: Number(sec[3]) });
  }
  if (sectionsRan < 1 || totalOk < 0 || passLines < 0) {
    throw new Error(
      "verify-fix: aggregation is missing a header line (sectionsRan/totalOk/passLines) or no sections ran: " +
        JSON.stringify(text.slice(0, 200)),
    );
  }
  let sumOk = 0;
  let sumPass = 0;
  for (let i = 0; i < perSection.length; i++) {
    sumOk += perSection[i].ok;
    sumPass += perSection[i].passLines;
  }
  if (sumOk !== totalOk) {
    throw new Error(
      "verify-fix: aggregation totalOk " + totalOk + " does not equal the per-section sum " + sumOk,
    );
  }
  if (sumPass !== passLines) {
    throw new Error(
      "verify-fix: aggregation passLines " + passLines + " does not equal the per-section sum " + sumPass,
    );
  }
  if (perSection.length !== sectionsRan) {
    throw new Error(
      "verify-fix: aggregation lists " +
        perSection.length +
        " section logs but sectionsRan is " +
        sectionsRan +
        " (a marker without a log, or vice versa)",
    );
  }
  return { sectionsRan, totalOk, passLines, perSection };
}

/** Diff-confinement check: changed vs claimed. Pure — unit-tested directly. */
export function checkDiffConfinement(
  changedFiles: string[],
  claimedFiles: string[],
): ConfinementResult {
  const changed = new Set(changedFiles);
  const claimed = new Set(claimedFiles);
  const extras: string[] = [];
  const missing: string[] = [];
  for (const f of changed) if (!claimed.has(f)) extras.push(f);
  for (const f of claimed) if (!changed.has(f)) missing.push(f);
  extras.sort();
  missing.sort();
  return { confined: extras.length === 0 && missing.length === 0, extras, missing };
}

/** Baseline comparison: measured vs baseline + expected additions.
 * Pure — unit-tested directly. A delta that equals the expected
 * additions is expected growth, not a regression; a delta below
 * the baseline is a regression; anything else is unexplained and
 * names its residual. */
export function compareBaseline(
  measured: { sections: number; ok: number },
  baseline: SuiteBaseline,
  expectedAdditions: ExpectedAddition[],
): BaselineResult {
  let expectedSections = 0;
  let expectedOk = 0;
  for (let i = 0; i < expectedAdditions.length; i++) {
    expectedSections += expectedAdditions[i].sections;
    expectedOk += expectedAdditions[i].ok;
  }
  const deltaSections = measured.sections - baseline.sections;
  const deltaOk = measured.ok - baseline.ok;
  const explained = deltaSections === expectedSections && deltaOk === expectedOk;
  let explanation: string;
  if (explained) {
    explanation =
      "expected growth: +" +
      deltaSections +
      " sections / +" +
      deltaOk +
      " OK over " +
      baseline.label +
      " (the fix's own additions)";
  } else if (deltaSections < 0 || deltaOk < 0) {
    explanation =
      "REGRESSION: measured " +
      measured.sections +
      "/" +
      measured.ok +
      " is below the baseline " +
      baseline.sections +
      "/" +
      baseline.ok +
      " (" +
      baseline.label +
      ")";
  } else {
    explanation =
      "UNEXPLAINED DELTA: measured +" +
      deltaSections +
      " sections / +" +
      deltaOk +
      " OK over " +
      baseline.label +
      ", expected +" +
      expectedSections +
      " sections / +" +
      expectedOk +
      " OK (residual +" +
      (deltaSections - expectedSections) +
      " sections / +" +
      (deltaOk - expectedOk) +
      " OK)";
  }
  return {
    compared: true,
    baselineLabel: baseline.label,
    baselineSections: baseline.sections,
    baselineOk: baseline.ok,
    deltaSections,
    deltaOk,
    expectedSections,
    expectedOk,
    explained,
    explanation,
  };
}

/** Assemble the report and its verdict from the step results. Pure —
 * unit-tested directly. The verdict is "verified" only when every
 * check passes; every failure is named in notes with its counts. */
export function buildVerifyReport(args: {
  fixId: string;
  direct: DirectTestResult[];
  typecheck: TypecheckResult;
  suite: SuiteResult;
  confinement: ConfinementResult;
  baseline: BaselineResult;
}): VerifyReport {
  const notes: string[] = [];
  for (let i = 0; i < args.direct.length; i++) {
    const d = args.direct[i];
    if (!d.passed) {
      notes.push("direct test " + d.testPath + " did not pass (exit " + d.exitCode + ")");
    } else if (!d.checksMatch) {
      notes.push(
        "direct test " + d.testPath + " counted " + d.ok + " OK, expected " + d.expectedChecks,
      );
    } else if (!d.executed) {
      notes.push("direct test " + d.testPath + " exited 0 with no verdict lines");
    }
  }
  if (args.typecheck.ran && !args.typecheck.passed) {
    notes.push("typecheck failed (exit " + args.typecheck.exitCode + ")");
  }
  if (!args.suite.allPassed) {
    notes.push(
      "suite did not pass cleanly: " +
        args.suite.sectionsRan +
        " sections ran, " +
        args.suite.totalOk +
        " OK, allPassed=false",
    );
  }
  if (args.suite.mode === "full" && args.suite.skippedViaResume !== 0) {
    notes.push(
      "suite skipped " + args.suite.skippedViaResume + " sections via resume — a resumed run proves nothing",
    );
  }
  if (args.suite.mode === "full" && !args.suite.summaryMatchesIndependent) {
    notes.push("suite summary line does not match the independent log counts");
  }
  if (!args.confinement.confined) {
    if (args.confinement.extras.length > 0) {
      notes.push("diff not confined: extras (changed, not claimed): " + args.confinement.extras.join(", "));
    }
    if (args.confinement.missing.length > 0) {
      notes.push("diff not confined: missing (claimed, not changed): " + args.confinement.missing.join(", "));
    }
  }
  if (args.baseline.compared && !args.baseline.explained) {
    notes.push("baseline: " + args.baseline.explanation);
  }
  return {
    fixId: args.fixId,
    verdict: notes.length === 0 ? "verified" : "failed",
    direct: args.direct,
    typecheck: args.typecheck,
    suite: args.suite,
    confinement: args.confinement,
    baseline: args.baseline,
    knownLimit: VERIFY_KNOWN_LIMIT,
    notes,
  };
}

/** The aggregation script: one /bin/sh -c invocation that greps the
 * on-disk section logs and prints the line-based format
 * parseTier1Aggregation reads. The big outputs stay on disk; only
 * the counts cross the trap boundary. */
function aggregationScript(logDir: string, doneDir: string): string {
  return (
    'd="' +
    doneDir +
    '"; l="' +
    logDir +
    '"; ' +
    'echo "sectionsRan=$(ls "$d" | wc -l | tr -d \' \')"; ' +
    't=0; p=0; ' +
    'for f in "$l"/*.log; do [ -f "$f" ] || continue; ' +
    's=$(basename "$f" .log); ' +
    'o=$(grep -c \' OK:\' "$f" || true); ' +
    'q=$(grep -c \'^PASS\' "$f" || true); ' +
    't=$((t + o)); p=$((p + q)); ' +
    'echo "$s $o $q"; done; ' +
    'echo "totalOk=$t"; echo "passLines=$p"'
  );
}

export default function verifyFix(input: VerifyFixInput): VerifyReport {
  const bun = input.bunPath ?? "/opt/hatch-image/bin/bun";
  const dquickts = input.dquicktsPath ?? "/home/hatch/workspace/dquickts-build-minimal";
  const appsDir = input.repoRoot + "/apps/agentts";
  const runSh = input.repoRoot + "/apps/agentts/run.sh";
  const tier = input.tier ?? 1;
  const onlySections = input.onlySections ?? [];
  const scoped = onlySections.length > 0;

  // 0. Scratch dir for the host build.
  const mk = exec({ cmd: "mkdir", args: ["-p", input.workDir] });
  if (mk.exitCode !== 0) {
    throw new Error("verify-fix: cannot create workDir " + input.workDir + " (rc " + mk.exitCode + ")");
  }

  // 1. Fresh host build (never trust a stale binary).
  let hostBin: string;
  if (input.buildHost ?? true) {
    const b = exec({
      cmd: "make",
      args: [
        "-C",
        input.repoRoot + "/packages/durablets",
        "DQUICKTS=" + dquickts,
        "OUT_DIR=" + input.workDir + "/host-bin",
        "durablets",
      ],
    });
    if (b.exitCode !== 0) {
      throw new Error(
        "verify-fix: host build failed (rc " +
          b.exitCode +
          "): " +
          ((b.stderr ?? "") + (b.stdout ?? "")).slice(0, 500),
      );
    }
    hostBin = input.workDir + "/host-bin/durablets";
  } else {
    if (!input.hostPath) {
      throw new Error("verify-fix: buildHost is false but no hostPath was given");
    }
    hostBin = input.hostPath;
  }

  // 2. Targeted direct re-runs with the fresh host.
  const direct: DirectTestResult[] = [];
  for (let i = 0; i < input.directTests.length; i++) {
    const dt = input.directTests[i];
    const t0 = Date.now();
    const r = exec({
      cmd: "env",
      args: [
        "DURABLETS_HOST=" + hostBin,
        "AGENTTS_DURABLETS_DIR=" + input.repoRoot + "/packages/durablets",
        "DQUICKTS=" + dquickts,
        bun,
        dt.testPath,
      ],
      cwd: appsDir,
    });
    const parsed = parseDirectTestOutput(r.stdout, r.exitCode);
    direct.push({
      testPath: dt.testPath,
      exitCode: r.exitCode,
      ok: parsed.ok,
      expectedChecks: dt.expectedChecks,
      checksMatch: parsed.ok === dt.expectedChecks,
      executed: parsed.executed,
      passed: parsed.passed,
      passLines: parsed.passLines,
      elapsedMs: Date.now() - t0,
    });
  }

  // 3. Typecheck.
  let typecheck: TypecheckResult = { ran: false, exitCode: -1, passed: false, stderrHead: "" };
  if (input.typecheck ?? true) {
    const r = exec({ cmd: bun, args: ["x", "tsc", "--noEmit"], cwd: appsDir });
    typecheck = {
      ran: true,
      exitCode: r.exitCode,
      passed: r.exitCode === 0,
      stderrHead: (r.stderr ?? "").slice(0, 500),
    };
  }

  // 4. Suite run + log greps.
  const suiteStarted = Date.now();
  let suiteAllPassed = true;
  let summaryLine = "";
  if (!scoped) {
    const r = exec({ cmd: runSh, args: ["--resume-dir", input.resumeDir], cwd: appsDir });
    summaryLine = r.stdout;
    if (r.exitCode !== 0) suiteAllPassed = false;
  } else {
    for (let i = 0; i < onlySections.length; i++) {
      const r = exec({
        cmd: runSh,
        args: ["--bash", "--only", onlySections[i], "--resume-dir", input.resumeDir],
        cwd: appsDir,
      });
      if (r.exitCode !== 0) suiteAllPassed = false;
    }
  }
  const logDir = scoped
    ? input.resumeDir + "/logs"
    : input.resumeDir + "/workflow/tier" + tier + "/resume/logs";
  const doneDir = scoped
    ? input.resumeDir + "/.done"
    : input.resumeDir + "/workflow/tier" + tier + "/resume/.done";
  const agg = exec({ cmd: "/bin/sh", args: ["-c", aggregationScript(logDir, doneDir)] });
  if (agg.exitCode !== 0) {
    throw new Error(
      "verify-fix: tier log aggregation failed (rc " +
        agg.exitCode +
        "): " +
        (agg.stderr ?? "").slice(0, 500),
    );
  }
  const aggParsed = parseTier1Aggregation(agg.stdout);
  const suiteSections: SuiteSectionResult[] = [];
  for (let i = 0; i < aggParsed.perSection.length; i++) {
    const s = aggParsed.perSection[i];
    const verdictPresent = s.ok > 0 || s.passLines > 0;
    if (!verdictPresent) suiteAllPassed = false;
    suiteSections.push({ slug: s.slug, ok: s.ok, passLines: s.passLines, verdictPresent });
  }
  let skippedViaResume = 0;
  let summaryMatchesIndependent = true;
  if (!scoped) {
    const summary = parseTierSummaryLine(summaryLine);
    if (summary === null) {
      summaryMatchesIndependent = false;
    } else {
      skippedViaResume = summary.skippedViaResume;
      if (summary.sectionsRan !== aggParsed.sectionsRan) summaryMatchesIndependent = false;
      if (summary.ok !== aggParsed.totalOk) summaryMatchesIndependent = false;
      if (summary.skippedViaResume !== 0) summaryMatchesIndependent = false;
    }
  }
  const suite: SuiteResult = {
    mode: scoped ? "scoped" : "full",
    tier,
    sectionsRan: aggParsed.sectionsRan,
    totalOk: aggParsed.totalOk,
    passLines: aggParsed.passLines,
    sections: suiteSections,
    allPassed: suiteAllPassed,
    skippedViaResume,
    summaryLine,
    summaryMatchesIndependent,
    elapsedMs: Date.now() - suiteStarted,
  };

  // 5. Diff confinement (pure) + baseline comparison (pure).
  const confinement = checkDiffConfinement(input.changedFiles, input.claimedFiles);
  let baseline: BaselineResult;
  if (scoped || input.baseline === undefined) {
    baseline = {
      compared: false,
      baselineLabel: input.baseline === undefined ? "" : input.baseline.label,
      baselineSections: input.baseline === undefined ? 0 : input.baseline.sections,
      baselineOk: input.baseline === undefined ? 0 : input.baseline.ok,
      deltaSections: 0,
      deltaOk: 0,
      expectedSections: 0,
      expectedOk: 0,
      explained: true,
      explanation: scoped
        ? "scoped run — baseline comparison not applicable (the full tier was not run)"
        : "no baseline given — comparison skipped",
    };
  } else {
    baseline = compareBaseline(
      { sections: suite.sectionsRan, ok: suite.totalOk },
      input.baseline,
      input.expectedAdditions ?? [],
    );
  }

  // 6. Report (pure). The verdict is evidence, not acceptance.
  return buildVerifyReport({
    fixId: input.fixId,
    direct,
    typecheck,
    suite,
    confinement,
    baseline,
  });
}
