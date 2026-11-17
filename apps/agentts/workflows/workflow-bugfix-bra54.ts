// Bug-fix workflow for BRA-54 (Phase 2, use case (b)).
//
// Fixes a real bug end to end through the real engine: the CLI mock
// path cannot drive decide-heavy workflows because the mock adapter
// answers decide traps with the canned {choice:"a"}.
//
//   reproduce -> diagnose -> fix -> judge the fix (JudgeFixLoop) ->
//   test (full staged run.sh) -> verify (CLI mock path converges)
//
// Steps are job traps (specs bugfix-*) served by workflows/
// bugfix-worker.ts — a real worker process with fs + exec access
// under the direct adapter, and the same code in-process with
// simulate: true under the mock adapter (see the worker's header for
// what is simulated and what is real; simulated results always carry
// simulated: true). Job traps, not exec traps, because each step is
// multi-step work (copy sources, install deps, build the C host, run
// the CLI/suite, parse the result) that a single exec cannot do, and
// because job traps let the mock adapter simulate deterministically
// for fast iteration where mock exec is canned-empty. The direct
// adapter's exec path is already proven by the host suite
// (testHostRealExec); the workers shell out internally.
//
// No runtime gate trap: the fix is the issue's prescribed option 1,
// minimal and explicit, and the coordinator verifies and closes
// BRA-54 after the run (human review is post-hoc, not in-loop). The
// first-run type-check gate still runs (and is cached on a second
// run of the same workflow version).
//
// The target is the STAGED repo (~/workspace/agentts-repo/apps/
// agentts): the fix lands there by construction, and this file is
// staged there too, so its repoRoot literal stays correct. Runs
// execute from the working host dir (which has node_modules); the
// workers build runnable scratch copies of the staged repo for the
// CLI/suite runs, so no run output ever lands in the staged tree.
//
// The JFL judging step is advisory, not a gate. BRA-54 is fixed: the
// CLI wires the local decision model into its mock path, so reproduce
// reports already-fixed and the workflow returns before the loop on
// the current tree. The pre-fix signature was 6 loops unconverged,
// mean 0.55 under mock; the post-fix signature is 5 loops converged,
// mean 0.85. The fix's acceptance comes from the test and verify job
// results, not from the JFL outcome.

import { job } from "../src/agentts";
import { judgeFixLoop } from "./judge-fix-loop";

declare function print(...args: unknown[]): void;


interface ReproduceInput {
  repoRoot: string;
  workflow: string;
}

interface ReproduceResult {
  reproduced: boolean;
  loops: number;
  converged: boolean;
  mean: number;
  evidence: string;
  runnableCopy: string;
  hostBin: string;
  error: string;
  simulated: boolean;
}

interface DiagnoseInput {
  repoRoot: string;
  targetFile: string;
}

interface PatchEdit {
  search: string;
  replace: string;
}

interface DiagnoseResult {
  found: boolean;
  rootCause: string;
  file: string;
  edits: PatchEdit[];
  rationale: string;
  error: string;
  simulated: boolean;
}

interface FixInput {
  repoRoot: string;
  file: string;
  edits: PatchEdit[];
}

interface FixResult {
  applied: boolean;
  alreadyApplied: boolean;
  wouldApply: boolean;
  file: string;
  editsApplied: number;
  error: string;
  simulated: boolean;
}

interface TestInput {
  repoRoot: string;
}

interface TestResult {
  passed: boolean;
  exitCode: number;
  summary: string;
  error: string;
  simulated: boolean;
}

interface VerifyInput {
  repoRoot: string;
  workflow: string;
  runnableCopy: string;
  hostBin: string;
}

interface VerifyResult {
  converged: boolean;
  loops: number;
  mean: number;
  evidence: string;
  error: string;
  simulated: boolean;
}

export interface FixItem {
  text: string;
  goal: string;
}

export interface FixRubric {
  criteria: string[];
  threshold: number;
}

/** The workflow's input (typed params, not hardcoded constants):
 * the staged repo root, the workflow to reproduce/verify against,
 * and the target file to diagnose. */
export interface BugfixInput {
  repoRoot: string;
  workflow: string;
  targetFile: string;
}

export interface BugfixResult {
  status: string;
  reproduced: boolean;
  reproduceSimulated: boolean;
  fixApplied: boolean;
  fixSimulated: boolean;
  jflLoops: number;
  jflConverged: boolean;
  jflMean: number;
  suitePassed: boolean;
  suiteSimulated: boolean;
  cliConverged: boolean;
  cliLoops: number;
  cliMean: number;
  verifySimulated: boolean;
}

export default function bugfixBra54(input: BugfixInput): BugfixResult {
  // Input-derived constants (were hardcoded module-level consts).
  const REPO = input.repoRoot;
  const WORKFLOW = input.workflow;
  const TARGET = input.targetFile;

  // 1. Reproduce BRA-54: the CLI mock path on the JudgeFixLoop
  // workflow loops 6 times, unconverged, mean 0.55 when the bug is
  // present. On the fixed tree reproduce reports already-fixed
  // (5 loops, converged, mean 0.85) and the workflow returns here.
  const repro = job<ReproduceInput, ReproduceResult>({
    spec: "bugfix-reproduce",
    input: { repoRoot: REPO, workflow: WORKFLOW },
  });
  print("reproduce:", JSON.stringify(repro));

  let status = "failed";
  let fixApplied = false;
  let fixSimulated = false;
  let jflLoops = 0;
  let jflConverged = false;
  let jflMean = 0;
  let suitePassed = false;
  let suiteSimulated = false;
  let cliConverged = false;
  let cliLoops = 0;
  let cliMean = 0;
  let verifySimulated = false;

  if (!repro.reproduced) {
    status = repro.error !== "" ? "failed-reproduce" : "already-fixed";
  } else {
    // 2. Diagnose: read the code, find the root cause, build the patch.
    const diag = job<DiagnoseInput, DiagnoseResult>({
      spec: "bugfix-diagnose",
      input: { repoRoot: REPO, targetFile: TARGET },
    });
    print("diagnose:", JSON.stringify(diag));
    if (!diag.found) {
      status = "failed-diagnose";
    } else {
      // 3. Fix: apply the patch (verified before any write; the worker
      // checks every edit before applying any of them).
      const fix = job<FixInput, FixResult>({
        spec: "bugfix-fix",
        input: { repoRoot: REPO, file: diag.file, edits: diag.edits },
      });
      print("fix:", JSON.stringify(fix));
      fixApplied = fix.applied;
      fixSimulated = fix.simulated;
      if (!fix.applied && !fix.wouldApply && !fix.alreadyApplied) {
        status = "failed-fix";
      } else {
        // 4. Judge the fix with the JudgeFixLoop library: 3 parallel
        // judges (all()), decide cadence from the library. Advisory:
        // the outcome is recorded, not a gate (see the header).
        const jfl = judgeFixLoop<FixItem, FixRubric>(
          {
            text: "The fix is minimal and targeted: the CLI wires the local decision model into the mock path, with no regression to canned answers for other traps.",
            goal: "A minimal, targeted BRA-54 fix with no regression.",
          },
          { criteria: ["minimal", "targeted", "no regression"], threshold: 0.8 },
          6,
        );
        print("jfl:", JSON.stringify(jfl));
        jflLoops = jfl.loops;
        jflConverged = jfl.converged;
        jflMean = jfl.lastAggregate ? jfl.lastAggregate.meanScore : 0;

        // 5. Test: the full staged suite (run.sh) must stay green.
        const test = job<TestInput, TestResult>({
          spec: "bugfix-test",
          input: { repoRoot: REPO },
        });
        print("test:", JSON.stringify(test));
        suitePassed = test.passed;
        suiteSimulated = test.simulated;
        if (!test.passed) {
          status = "failed-test";
        } else {
          // 6. Verify: the CLI mock path on the JFL workflow must now
          // converge (reusing the reproduce step's runnable copy).
          const verify = job<VerifyInput, VerifyResult>({
            spec: "bugfix-verify",
            input: { repoRoot: REPO, workflow: WORKFLOW, runnableCopy: repro.runnableCopy, hostBin: repro.hostBin },
          });
          print("verify:", JSON.stringify(verify));
          cliConverged = verify.converged;
          cliLoops = verify.loops;
          cliMean = verify.mean;
          verifySimulated = verify.simulated;
          status = verify.converged ? "fixed" : "failed-verify";
        }
      }
    }
  }

  const result: BugfixResult = {
    status,
    reproduced: repro.reproduced,
    reproduceSimulated: repro.simulated,
    fixApplied,
    fixSimulated,
    jflLoops,
    jflConverged,
    jflMean,
    suitePassed,
    suiteSimulated,
    cliConverged,
    cliLoops,
    cliMean,
    verifySimulated,
  };
  print("result:", JSON.stringify(result));

  return result;
}
