#!/usr/bin/env bun
/**
 * Workflow efficiency audit + ratchet (Linear BRA-166 — r2).
 *
 * The bench has this discipline for the C-host suite (bench/check.ts
 * + baselines.json + ratchet.log: tighten-only ratchet,
 * confirm-before-fail, human-approved loosening with a recorded
 * reason). No equivalent existed for workflows: a workflow could get
 * slower or more token-hungry across releases and nothing flagged
 * it. src/workflow-audit.ts is the workflow equivalent, reading the
 * BRA-165 run ledger: per-workflow baselines (median active wall
 * clock + tokens per run), a check that flags regressions with
 * numbers, a tighten-only ratchet, and loosen-only-by-human-decision.
 *
 * Sections:
 *   A. Unit — pure audit functions on synthetic ledger entries
 *      (no host, no engine): observation windows, the ratchet rule,
 *      confirm-before-fail, tokens-unknown, loosen, file round trips.
 *   B. Integration — Host + mock adapter + REAL clock: real runs of
 *      the audit fixture seed a baseline, regress, and recover, and
 *      the audit reads the real ledger file. Real clock, not virtual:
 *      the audit measures real wall time, and under the virtual clock
 *      a sleep is free — probed 2026-11-20 (sleep 50ms -> wallMs 93,
 *      sleep 500ms -> wallMs 119), so a virtual-clock regression is
 *      invisible by construction. wallTs is wall time by definition;
 *      the virtual clock virtualizes the sleep trap's waiting, not
 *      the wall clock.
 *   C. E2E — real CLI runs (direct adapter, real exec/clock, no
 *      mocks) plus the audit CLI (`bun src/workflow-audit.ts`):
 *      regression flagged with numbers, the ratchet tightening a
 *      slow-seeded baseline down over successive audits, and loosen
 *      carrying a recorded reason.
 *
 *   DURABLETS_HOST=<built C host> DQUICKTS=<dquickts tree> bun tests/test-bra166.ts
 *   (run.sh sets both.)
 *
 * Run outputs go to $BRA166_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "bun";

import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { loadLedger, ledgerFile, type LedgerEntry } from "../src/run-ledger";
import {
  auditWorkflows,
  applyAuditObservation,
  loosenAuditBaseline,
  observeWorkflow,
  activeWallMs,
  median,
  thresholdFor,
  loadWorkflowBaselines,
  saveWorkflowBaselines,
  workflowBaselinesFile,
  workflowRatchetLog,
  runWorkflowAudit,
  auditMetricId,
  AUDIT_MIN_RUNS,
  type WorkflowBaselinesFile,
  type WorkflowBaselineEntry,
} from "../src/workflow-audit";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA166_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra166-"));
const STATE_DIR = path.join(WORKDIR, "state");
const E2E_REG_DIR = path.join(WORKDIR, "e2e-regression-state");
const E2E_RATCHET_DIR = path.join(WORKDIR, "e2e-ratchet-state");
for (const d of [STATE_DIR, E2E_REG_DIR, E2E_RATCHET_DIR]) fs.mkdirSync(d, { recursive: true });

// Standing rule: any test that submits in-process sets
// AGENTTS_WORKER_SERVER first, or notifyEvent posts to the
// production port 18741. No test server runs here, so point it at
// a dead port — notifyEvent is fire-and-forget.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:9";

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra166-audit.ts");
const FAIL_WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra110-fail.ts");

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

function mkEntry(
  runId: string,
  workflow: string,
  wallMs: number | null,
  opts: { status?: "done" | "failed"; gateHoldMs?: number | null; tokens?: number | null } = {},
): LedgerEntry {
  return {
    version: 1,
    runId,
    workflow,
    status: opts.status ?? "done",
    adapter: "direct",
    startedAt: "2026-11-20T00:00:00.000Z",
    finishedAt: "2026-11-20T00:00:01.000Z",
    wallMs,
    gateHoldMs: opts.gateHoldMs ?? null,
    traps: { total: 1, byType: { sleep: { results: 1, errors: 0 } }, jobsCompleted: 0, jobsFailed: 0 },
    tokens: {
      total: opts.tokens ?? null,
      reportedTraps: opts.tokens === undefined || opts.tokens === null ? 0 : 1,
      totalTraps: 1,
    },
    error: opts.status === "failed" ? "boom" : null,
  };
}

function emptyFile(): WorkflowBaselinesFile {
  return { version: 1, generated: "2026-11-20T00:00:00.000Z", metrics: {} };
}

async function main(): Promise<number> {
  // ---------------------------------------------------------- A. unit
  console.log("=== A. unit: pure audit functions on synthetic ledger entries ===");
  check(activeWallMs(mkEntry("r", "w", 1000, { gateHoldMs: 200 })) === 800, "UNIT OK: activeWallMs subtracts gate-hold time (1000 - 200 = 800)");
  check(activeWallMs(mkEntry("r", "w", null)) === null, "UNIT OK: activeWallMs is null when wallMs is unknown");
  check(activeWallMs(mkEntry("r", "w", 500)) === 500, "UNIT OK: activeWallMs is wallMs when there is no gate hold");
  check(median([3, 1, 2]) === 2, "UNIT OK: median of an odd list is the middle value");
  check(median([4, 1, 2, 3]) === 2.5, "UNIT OK: median of an even list averages the middle pair");

  const eight = [
    mkEntry("r1", "wf", 100), mkEntry("r2", "wf", 110), mkEntry("r3", "wf", 90),
    mkEntry("r4", "wf", 100), mkEntry("r5", "wf", 100), mkEntry("r6", "wf", 500),
    mkEntry("r7", "wf", 510), mkEntry("r8", "wf", 490),
  ];
  const obs8 = observeWorkflow(eight, "wf");
  check(obs8.wallMedian === 490, `UNIT OK: observeWorkflow takes the last 5 runs (median ${obs8.wallMedian}, expected 490: sorted [100,100,490,500,510])`);
  check(obs8.wallRuns === 5, `UNIT OK: observeWorkflow wallRuns is 5 (got ${obs8.wallRuns})`);
  check(obs8.newestRunId === "r8", `UNIT OK: observeWorkflow newestRunId is the last entry (got ${obs8.newestRunId})`);

  const withFail = [
    mkEntry("r1", "wf", 100), mkEntry("r2", "wf", 100), mkEntry("r3", "wf", 100),
    mkEntry("r4", "wf", 60000, { status: "failed" }), mkEntry("r5", "wf", 100),
  ];
  const obsFail = observeWorkflow(withFail, "wf");
  check(obsFail.wallMedian === 100, `UNIT OK: a failed run with wallMs 60000 does not move the median (got ${obsFail.wallMedian})`);
  check(obsFail.failedRuns === 1, `UNIT OK: failedRuns counts the failed run (got ${obsFail.failedRuns})`);
  check(obsFail.doneRuns === 4, `UNIT OK: doneRuns counts only done runs (got ${obsFail.doneRuns})`);

  const mixed = [
    mkEntry("r1", "wf", 100, { tokens: 1000 }),
    mkEntry("r2", "wf", 100, { tokens: 1100 }),
    mkEntry("r3", "wf", 100, { tokens: 1050 }),
    mkEntry("r4", "wf", 100),
    mkEntry("r5", "wf", 100),
  ];
  const obsMixed = observeWorkflow(mixed, "wf");
  check(obsMixed.tokenMedian === 1050, `UNIT OK: token median is over reporting runs only (got ${obsMixed.tokenMedian})`);
  check(obsMixed.tokenRuns === 3, `UNIT OK: tokenRuns counts reporting runs only (got ${obsMixed.tokenRuns})`);
  const noTokens = [mkEntry("r1", "wf", 100), mkEntry("r2", "wf", 100), mkEntry("r3", "wf", 100)];
  const obsNoTok = observeWorkflow(noTokens, "wf");
  check(obsNoTok.tokenMedian === null && obsNoTok.tokenRuns === 0, "UNIT OK: all-null tokens gives tokenMedian null, tokenRuns 0");
  const nullWall = [mkEntry("r1", "wf", null), mkEntry("r2", "wf", 100), mkEntry("r3", "wf", 120)];
  check(observeWorkflow(nullWall, "wf").wallRuns === 2, "UNIT OK: a run with unknown wallMs is excluded from wallRuns");

  // Empty ledger: nothing to audit, not a failure.
  const empty = auditWorkflows([], emptyFile());
  check(empty.ok && empty.results.length === 0 && empty.workflows.length === 0, "UNIT OK: an empty ledger audits clean with no results");

  // Fewer than 3 runs: NO-BASELINE, never a failure.
  const two = auditWorkflows([mkEntry("r1", "wf", 100), mkEntry("r2", "wf", 110)], emptyFile());
  check(two.ok && two.failures === 0, "UNIT OK: 2 runs is NO-BASELINE, not a failure");
  check(two.results.find((r) => r.metric === "wallMs")?.verdict === "no-baseline", "UNIT OK: the wall verdict is no-baseline with 2 runs");
  check(two.results.find((r) => r.metric === "tokens")?.verdict === "unknown", "UNIT OK: the tokens verdict is unknown when no run reports tokens");

  // 3 runs seed a baseline from the median; tokens stay unknown.
  const file1 = emptyFile();
  const three = [mkEntry("r1", "wf", 98), mkEntry("r2", "wf", 102), mkEntry("r3", "wf", 100)];
  const seeded = auditWorkflows(three, file1);
  const wallSeed = seeded.results.find((r) => r.metric === "wallMs")!;
  check(wallSeed.verdict === "seeded", `UNIT OK: 3 runs seed the wall baseline (verdict ${wallSeed.verdict})`);
  check(wallSeed.baseline === 100 && wallSeed.threshold === 300, `UNIT OK: seeded baseline 100, threshold 300 (got ${wallSeed.baseline}/${wallSeed.threshold})`);
  check(seeded.ok, "UNIT OK: seeding is not a failure");
  check(file1.metrics["wf::wallMs"]?.baseline === 100, "UNIT OK: the seeded baseline is stored in the file");
  check(file1.metrics["wf::tokens"] === undefined, "UNIT OK: no tokens baseline is created when nothing reports tokens");

  // A green observation advances the streak; re-auditing an unchanged
  // ledger records nothing (sustained means over runs, not audits).
  const four = [...three, mkEntry("r4", "wf", 100)];
  const green1 = auditWorkflows(four, file1);
  check(green1.results.find((r) => r.metric === "wallMs")?.verdict === "pass", "UNIT OK: a green observation passes");
  check(file1.metrics["wf::wallMs"]?.greenStreak === 1, `UNIT OK: greenStreak is 1 after one green observation (got ${file1.metrics["wf::wallMs"]?.greenStreak})`);
  const greenAgain = auditWorkflows(four, file1);
  check(greenAgain.results.find((r) => r.metric === "wallMs")?.verdict === "pass", "UNIT OK: re-auditing unchanged data still passes");
  check(file1.metrics["wf::wallMs"]?.greenStreak === 1, `UNIT OK: re-auditing unchanged data does NOT advance the streak (still ${file1.metrics["wf::wallMs"]?.greenStreak})`);
  check(
    greenAgain.results.find((r) => r.metric === "wallMs")?.detail.includes("no new runs") === true,
    "UNIT OK: the repeat pass says no new runs landed",
  );

  // Ratchet: seed slow, then 5 fresh fast observations ratchet down.
  const file2 = emptyFile();
  const slow: LedgerEntry[] = [mkEntry("s1", "wf", 600), mkEntry("s2", "wf", 600), mkEntry("s3", "wf", 600)];
  auditWorkflows(slow, file2);
  check(file2.metrics["wf::wallMs"]?.baseline === 600, "UNIT OK: ratchet test seeds at 600");
  let ratcheted = false;
  const ratchetLines: string[] = [];
  const runs: LedgerEntry[] = [...slow];
  for (let i = 1; i <= 5; i++) {
    runs.push(mkEntry(`f${i}`, "wf", 100));
    const rep = auditWorkflows(runs, file2);
    ratchetLines.push(...rep.ratchetLogLines);
    if (rep.results.find((r) => r.metric === "wallMs")?.ratcheted) ratcheted = true;
  }
  check(ratcheted, "UNIT OK: 5 decisive fast observations ratchet the baseline down");
  check(file2.metrics["wf::wallMs"]?.baseline === 100, `UNIT OK: ratcheted baseline is 100 (got ${file2.metrics["wf::wallMs"]?.baseline})`);
  check(file2.metrics["wf::wallMs"]?.threshold === 300, `UNIT OK: ratcheted threshold is 300 (got ${file2.metrics["wf::wallMs"]?.threshold})`);
  check(file2.metrics["wf::wallMs"]?.greenStreak === 0, "UNIT OK: the streak resets after a ratchet");
  check(
    ratchetLines.some((l) => l.includes("AUDIT-RATCHET wf::wallMs baseline 600 -> 100")),
    "UNIT OK: the ratchet is logged with before/after numbers",
  );

  // Non-decisive streak: observations beat the threshold but the
  // window median is not decisively below the baseline — no ratchet.
  // The streak reaches 5 on the 5th 150ms observation and resets
  // there (decisive rule), then builds back from the next runs.
  const file3 = emptyFile();
  const base100: LedgerEntry[] = [mkEntry("b1", "wf", 100), mkEntry("b2", "wf", 100), mkEntry("b3", "wf", 100)];
  auditWorkflows(base100, file3);
  const slow150: LedgerEntry[] = [...base100];
  const streaks: number[] = [];
  for (let i = 1; i <= 7; i++) {
    slow150.push(mkEntry(`s${i}`, "wf", 150));
    auditWorkflows(slow150, file3);
    streaks.push(file3.metrics["wf::wallMs"]?.greenStreak ?? -1);
  }
  check(file3.metrics["wf::wallMs"]?.baseline === 100, `UNIT OK: a non-decisive streak does not move the baseline (still ${file3.metrics["wf::wallMs"]?.baseline})`);
  check(streaks[4] === 0, `UNIT OK: the streak resets when the 5th observation is not decisive (streaks [${streaks.join(", ")}])`);
  check(streaks[6] === 2, `UNIT OK: the streak builds back from later runs (final ${streaks[6]})`);

  // Regression: 4.5x over baseline is flagged with numbers.
  const file4 = emptyFile();
  auditWorkflows(three, file4);
  const regressed = [...three, mkEntry("r4", "wf", 445), mkEntry("r5", "wf", 452), mkEntry("r6", "wf", 448)];
  const failed = auditWorkflows(regressed, file4);
  const wallFail = failed.results.find((r) => r.metric === "wallMs")!;
  check(wallFail.verdict === "fail", `UNIT OK: a 4.5x regression fails (verdict ${wallFail.verdict})`);
  check(failed.ok === false && failed.failures === 1, `UNIT OK: one failure, ok=false (failures ${failed.failures})`);
  check(
    wallFail.detail.includes("448") && wallFail.detail.includes("300") && wallFail.detail.includes("100"),
    `UNIT OK: the FAIL line carries observed/baseline/threshold (got: ${wallFail.detail})`,
  );
  check(wallFail.confirmObserved === 448, `UNIT OK: the confirm median is the last 3 runs (got ${wallFail.confirmObserved})`);

  // Stale breach: slow runs age out of the window and the workflow
  // already recovered — confirmed-pass, breaching observation discarded.
  const file5 = emptyFile();
  auditWorkflows(three, file5);
  const stale = [
    ...three,
    mkEntry("x1", "wf", 900), mkEntry("x2", "wf", 900), mkEntry("x3", "wf", 900),
  ];
  const failFirst = auditWorkflows(stale, file5);
  check(failFirst.results.find((r) => r.metric === "wallMs")?.verdict === "fail", "UNIT OK: three 900ms runs fail against a 100 baseline");
  const healed = [...stale, mkEntry("h1", "wf", 100), mkEntry("h2", "wf", 100)];
  const cleared = auditWorkflows(healed, file5);
  const wallClear = cleared.results.find((r) => r.metric === "wallMs")!;
  check(wallClear.verdict === "confirmed-pass", `UNIT OK: a healed regression clears as confirmed-pass (verdict ${wallClear.verdict})`);
  check(cleared.ok && cleared.failures === 0, "UNIT OK: the cleared breach is not a failure");
  check(
    file5.metrics["wf::wallMs"]!.history.join(",") === "900,100",
    `UNIT OK: the stale breach added no second 900 — history is exactly [900, 100] (got [${file5.metrics["wf::wallMs"]!.history.join(", ")}]: the first 900 is the confirmed failure, the stale one was discarded)`,
  );
  check(
    file5.metrics["wf::wallMs"]!.history.includes(100),
    "UNIT OK: the confirming green observation is recorded instead",
  );

  // Tokens: mixed reporting seeds from reporting runs only; a token
  // regression fails; a window with no reporting runs is unknown.
  const file6 = emptyFile();
  const tokSeed = auditWorkflows(mixed, file6);
  const tokSeeded = tokSeed.results.find((r) => r.metric === "tokens")!;
  check(tokSeeded.verdict === "seeded", `UNIT OK: tokens seed from reporting runs only (verdict ${tokSeeded.verdict})`);
  check(tokSeeded.baseline === 1050 && tokSeeded.threshold === 3150, `UNIT OK: seeded tokens baseline 1050, threshold 3150 (got ${tokSeeded.baseline}/${tokSeeded.threshold})`);
  const tokReg = [
    ...mixed,
    mkEntry("t1", "wf", 100, { tokens: 4200 }),
    mkEntry("t2", "wf", 100, { tokens: 4250 }),
    mkEntry("t3", "wf", 100, { tokens: 4150 }),
  ];
  const tokFailed = auditWorkflows(tokReg, file6);
  const tokFail = tokFailed.results.find((r) => r.metric === "tokens")!;
  check(tokFail.verdict === "fail", `UNIT OK: a 4x token regression fails (verdict ${tokFail.verdict})`);
  check(tokFail.metric === "tokens", "UNIT OK: the failing metric is tokens, not wallMs");
  const tokDark = [
    ...tokReg,
    mkEntry("d1", "wf", 100), mkEntry("d2", "wf", 100), mkEntry("d3", "wf", 100),
    mkEntry("d4", "wf", 100), mkEntry("d5", "wf", 100),
  ];
  const tokUnknown = auditWorkflows(tokDark, file6);
  check(tokUnknown.results.find((r) => r.metric === "tokens")?.verdict === "unknown", "UNIT OK: a window with no reporting runs is unknown, not a failure");
  check(file6.metrics["wf::tokens"]?.baseline === 1050, "UNIT OK: the tokens baseline is untouched by an unknown window");
  check(tokUnknown.ok, "UNIT OK: an unknown tokens window does not fail the audit");

  // Loosen: reason required, unknown metric refused, values + log.
  const file7 = emptyFile();
  auditWorkflows(three, file7);
  let loosenThrew = "";
  try {
    loosenAuditBaseline(file7, "wf::wallMs", 500, "");
  } catch (err) {
    loosenThrew = (err as Error).message;
  }
  check(loosenThrew.includes("--reason"), `UNIT OK: loosen without a reason throws (got: ${loosenThrew})`);
  loosenThrew = "";
  try {
    loosenAuditBaseline(file7, "wf::nope", 500, "because");
  } catch (err) {
    loosenThrew = (err as Error).message;
  }
  check(loosenThrew.includes("unknown metric"), `UNIT OK: loosen on an unknown metric throws (got: ${loosenThrew})`);
  loosenThrew = "";
  try {
    loosenAuditBaseline(file7, "wf::wallMs", 0, "because");
  } catch (err) {
    loosenThrew = (err as Error).message;
  }
  check(loosenThrew.includes("positive baseline"), `UNIT OK: loosen to a non-positive baseline throws (got: ${loosenThrew})`);
  const entryBefore = file7.metrics["wf::wallMs"]!;
  entryBefore.history = [100, 100];
  entryBefore.greenStreak = 2;
  const loosenLine = loosenAuditBaseline(file7, "wf::wallMs", 500, "workflow legitimately slower after the new judge step");
  check(file7.metrics["wf::wallMs"]?.baseline === 500, "UNIT OK: loosen sets the baseline");
  check(file7.metrics["wf::wallMs"]?.threshold === 1500, "UNIT OK: loosen recomputes the threshold from the multiple");
  check(file7.metrics["wf::wallMs"]?.history.length === 0, "UNIT OK: loosen clears history");
  check(file7.metrics["wf::wallMs"]?.greenStreak === 0, "UNIT OK: loosen clears the streak");
  check(
    loosenLine.includes("AUDIT-MANUAL-LOOSEN wf::wallMs baseline 100 -> 500") &&
      loosenLine.includes("workflow legitimately slower after the new judge step"),
    `UNIT OK: the loosen log line carries before/after + the reason (got: ${loosenLine})`,
  );

  // applyAuditObservation directly: the breach path only fails and
  // resets; a ratchet never moves a baseline up.
  const directEntry: WorkflowBaselineEntry = {
    unit: "ms", kind: "latency", baseline: 100, threshold: 300, multiple: 3, history: [], greenStreak: 0,
  };
  const breachOut = applyAuditObservation(directEntry, "wf::wallMs", 400);
  check(breachOut.outcome === "breach", `UNIT OK: an observation over threshold is a breach (got ${breachOut.outcome})`);
  check(directEntry.greenStreak === 0, "UNIT OK: a breach resets the streak");
  check(directEntry.baseline === 100, "UNIT OK: a breach never moves the baseline");
  check(thresholdFor(100, 3) === 300, "UNIT OK: thresholdFor rounds baseline x multiple");

  // Baselines file round trip + corrupt file fails loudly.
  const fileDir = path.join(WORKDIR, "file-state");
  fs.mkdirSync(fileDir, { recursive: true });
  const loaded0 = loadWorkflowBaselines(fileDir);
  check(Object.keys(loaded0.metrics).length === 0, "UNIT OK: a missing baselines file loads as empty");
  saveWorkflowBaselines(fileDir, file7);
  const loaded7 = loadWorkflowBaselines(fileDir);
  check(loaded7.metrics["wf::wallMs"]?.baseline === 500, "UNIT OK: baselines survive a save/load round trip");
  check(fs.existsSync(workflowBaselinesFile(fileDir)), "UNIT OK: the baselines file lives under <stateDir>/ledger/");
  fs.writeFileSync(workflowBaselinesFile(fileDir), "{not json\n");
  let corruptThrew = "";
  try {
    loadWorkflowBaselines(fileDir);
  } catch (err) {
    corruptThrew = (err as Error).message;
  }
  check(corruptThrew.includes("corrupt workflow baselines file"), `UNIT OK: a corrupt baselines file fails loudly (got: ${corruptThrew.slice(0, 100)})`);

  // --------------------------------------------- B. integration (host)
  console.log("=== B. integration: Host + mock adapter + real clock ===");
  const host = new Host({ stateDir: STATE_DIR, adapter: new MockAdapter({ gates: "auto" }), clock: "real" });
  async function runFixture(runId: string, sleepMs: number): Promise<void> {
    host.submit(WORKFLOW, { runId, input: { sleepMs } });
    await host.runQueue();
  }
  await runFixture("run-bra166-fast-1", 30);
  await runFixture("run-bra166-fast-2", 30);
  await runFixture("run-bra166-fast-3", 30);
  const intEntries1 = loadLedger(ledgerFile(STATE_DIR)).entries;
  check(intEntries1.length === 3, `INT OK: three ledger entries after three fast runs (got ${intEntries1.length})`);
  const seedRep = runWorkflowAudit(STATE_DIR);
  const seedWall = seedRep.results.find((r) => r.metric === "wallMs")!;
  check(seedWall.verdict === "seeded", `INT OK: the audit seeds from real runs (verdict ${seedWall.verdict})`);
  check(
    typeof seedWall.baseline === "number" && seedWall.baseline > 0 && seedWall.baseline < 500,
    `INT OK: the seeded baseline is a plausible fast-run median (got ${seedWall.baseline}ms)`,
  );
  check(seedRep.results.find((r) => r.metric === "tokens")?.verdict === "unknown", "INT OK: tokens are unknown — the mock reports none");
  check(seedRep.ok, "INT OK: seeding is not a failure");
  check(fs.existsSync(workflowBaselinesFile(STATE_DIR)), "INT OK: the baselines file is written under the state dir ledger/");
  const seededBaseline = seedWall.baseline as number;

  await runFixture("run-bra166-slow-1", 1000);
  await runFixture("run-bra166-slow-2", 1000);
  await runFixture("run-bra166-slow-3", 1000);
  const regRep = runWorkflowAudit(STATE_DIR);
  const regWall = regRep.results.find((r) => r.metric === "wallMs")!;
  check(regWall.verdict === "fail", `INT OK: three 1000ms runs fail against a ~${seededBaseline}ms baseline (verdict ${regWall.verdict})`);
  check(regRep.ok === false && regRep.failures === 1, `INT OK: one failure, ok=false (failures ${regRep.failures})`);
  check(
    typeof regWall.observed === "number" && regWall.observed > 3 * seededBaseline,
    `INT OK: the observed median is over 3x the baseline (observed ${regWall.observed}, baseline ${seededBaseline})`,
  );

  await runFixture("run-bra166-fast-4", 30);
  await runFixture("run-bra166-fast-5", 30);
  await runFixture("run-bra166-fast-6", 30);
  const recRep = runWorkflowAudit(STATE_DIR);
  check(recRep.ok, "INT OK: three fast runs after the regression recover the audit to green");
  check(recRep.results.find((r) => r.metric === "wallMs")?.verdict === "pass", "INT OK: the recovered wall verdict is pass");

  // A failing run of another workflow lands in the same ledger but
  // never fails the audit (failed runs are excluded from medians).
  host.submit(FAIL_WORKFLOW, { runId: "run-bra166-fail", input: { note: "audit-fail" } });
  await host.runQueue();
  const failRep = runWorkflowAudit(STATE_DIR);
  check(failRep.ok, "INT OK: a failed run in the ledger does not fail the audit");
  check(
    failRep.workflows.includes(FAIL_WORKFLOW),
    "INT OK: the audit covers every workflow in the ledger, including the failed one",
  );
  check(
    failRep.results.find((r) => r.workflow === FAIL_WORKFLOW && r.metric === "wallMs")?.verdict === "no-baseline",
    "INT OK: the failed workflow (1 run) is no-baseline, not a failure",
  );

  // ------------------------------------------------------- C. e2e (CLI)
  console.log("=== C. e2e: real CLI runs + the audit CLI ===");
  if (!process.env.DURABLETS_HOST) {
    fail("E2E FAIL: DURABLETS_HOST is not set — run.sh sets it; refusing to guess a C host");
  } else {
    async function cliRun(stateDir: string, sleepMs: number): Promise<{ rc: number; out: string; err: string }> {
      const p = spawn(
        [BUN, path.join(ROOT, "src", "cli.ts"), "run", WORKFLOW, "--wait", "--adapter", "direct", "--clock", "real", "--state-dir", stateDir, "--input", JSON.stringify({ sleepMs })],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      );
      const [out, err] = await Promise.all([
        new Response(p.stdout).text().catch(() => ""),
        new Response(p.stderr).text().catch(() => ""),
      ]);
      return { rc: await p.exited, out, err };
    }
    async function auditCli(stateDir: string, extra: string[] = []): Promise<{ rc: number; out: string; err: string }> {
      const p = spawn(
        [BUN, path.join(ROOT, "src", "workflow-audit.ts"), "--state-dir", stateDir, ...extra],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      );
      const [out, err] = await Promise.all([
        new Response(p.stdout).text().catch(() => ""),
        new Response(p.stderr).text().catch(() => ""),
      ]);
      return { rc: await p.exited, out, err };
    }

    // C1: regression — seed fast, regress slow, the audit CLI fails
    // with numbers.
    for (let i = 1; i <= 3; i++) {
      const r = await cliRun(E2E_REG_DIR, 30);
      check(r.rc === 0, `E2E OK: CLI fast run ${i} exits 0 (got ${r.rc})${r.rc !== 0 ? `: ${r.err.slice(-300)}` : ""}`);
    }
    const e2eSeed = await auditCli(E2E_REG_DIR);
    check(e2eSeed.rc === 0, `E2E OK: audit CLI exits 0 after seeding (got ${e2eSeed.rc})${e2eSeed.rc !== 0 ? `: ${e2eSeed.err.slice(-300)}` : ""}`);
    check(e2eSeed.out.includes("SEEDED"), `E2E OK: the audit CLI reports SEEDED (got: ${e2eSeed.out.split("\n")[0] ?? ""})`);
    check(fs.existsSync(workflowBaselinesFile(E2E_REG_DIR)), "E2E OK: the audit CLI wrote the baselines file under the e2e state dir");
    for (let i = 1; i <= 3; i++) {
      const r = await cliRun(E2E_REG_DIR, 1000);
      check(r.rc === 0, `E2E OK: CLI slow run ${i} exits 0 (got ${r.rc})`);
    }
    const e2eFail = await auditCli(E2E_REG_DIR);
    check(e2eFail.rc === 1, `E2E OK: audit CLI exits 1 on the regression (got ${e2eFail.rc})`);
    check(e2eFail.out.includes("FAIL"), `E2E OK: the audit CLI prints FAIL (got: ${e2eFail.out.split("\n").find((l) => l.includes("FAIL")) ?? e2eFail.out.slice(0, 200)})`);
    check(e2eFail.out.includes("::wallMs"), "E2E OK: the FAIL names the wallMs metric");

    // C2: ratchet — seed slow, then 5 fast runs with an audit after
    // each; the 5th audit ratchets the baseline down.
    for (let i = 1; i <= 3; i++) {
      const r = await cliRun(E2E_RATCHET_DIR, 1000);
      check(r.rc === 0, `E2E OK: ratchet-dir CLI slow run ${i} exits 0 (got ${r.rc})`);
    }
    const ratchetSeed = await auditCli(E2E_RATCHET_DIR);
    check(ratchetSeed.rc === 0 && ratchetSeed.out.includes("SEEDED"), "E2E OK: ratchet-dir audit seeds from the slow runs");
    const seedBase = loadWorkflowBaselines(E2E_RATCHET_DIR).metrics[auditMetricId(WORKFLOW, "wallMs")]?.baseline;
    check(
      typeof seedBase === "number" && seedBase > 500,
      `E2E OK: the slow-seeded baseline is over 500ms (got ${seedBase})`,
    );
    let ratchetedOut = "";
    for (let i = 1; i <= 5; i++) {
      const r = await cliRun(E2E_RATCHET_DIR, 30);
      check(r.rc === 0, `E2E OK: ratchet-dir CLI fast run ${i} exits 0 (got ${r.rc})`);
      const a = await auditCli(E2E_RATCHET_DIR);
      check(a.rc === 0, `E2E OK: ratchet-dir audit ${i} exits 0 (got ${a.rc})`);
      if (a.out.includes("RATCHETED")) ratchetedOut = a.out;
    }
    check(ratchetedOut.length > 0, "E2E OK: the 5th fast audit prints RATCHETED");
    const ratchetBase = loadWorkflowBaselines(E2E_RATCHET_DIR).metrics[auditMetricId(WORKFLOW, "wallMs")]?.baseline;
    check(
      typeof ratchetBase === "number" && typeof seedBase === "number" && ratchetBase < seedBase && ratchetBase < 500,
      `E2E OK: the ratcheted baseline dropped below the slow seed (seed ${seedBase} -> ${ratchetBase})`,
    );
    const ratchetLog = fs.readFileSync(workflowRatchetLog(E2E_RATCHET_DIR), "utf8");
    check(ratchetLog.includes("AUDIT-RATCHET"), "E2E OK: the ratchet log records the AUDIT-RATCHET line");

    // C3: loosen — recorded reason required, logged, applied.
    const loosen = await auditCli(E2E_REG_DIR, ["loosen", auditMetricId(WORKFLOW, "wallMs"), "5000", "--reason", "e2e loosen test"]);
    check(loosen.rc === 0, `E2E OK: audit CLI loosen exits 0 (got ${loosen.rc})${loosen.rc !== 0 ? `: ${loosen.err.slice(-300)}` : ""}`);
    check(loosen.out.includes("loosened"), `E2E OK: the loosen output confirms (got: ${loosen.out.slice(0, 120)})`);
    check(
      loadWorkflowBaselines(E2E_REG_DIR).metrics[auditMetricId(WORKFLOW, "wallMs")]?.baseline === 5000,
      "E2E OK: the loosened baseline is 5000 in the file",
    );
    const loosenLog = fs.readFileSync(workflowRatchetLog(E2E_REG_DIR), "utf8");
    check(
      loosenLog.includes("AUDIT-MANUAL-LOOSEN") && loosenLog.includes("e2e loosen test"),
      "E2E OK: the ratchet log carries the MANUAL-LOOSEN line with the reason",
    );
    const loosenNoReason = await auditCli(E2E_REG_DIR, ["loosen", auditMetricId(WORKFLOW, "wallMs"), "6000"]);
    check(loosenNoReason.rc === 1, `E2E OK: loosen without --reason exits 1 (got ${loosenNoReason.rc})`);
    const loosenUnknown = await auditCli(E2E_REG_DIR, ["loosen", "wf::nope", "6000", "--reason", "x"]);
    check(loosenUnknown.rc === 1, `E2E OK: loosen on an unknown metric exits 1 (got ${loosenUnknown.rc})`);
  }

  if (FAILURES.length > 0) {
    console.log(`\nFAIL bra166 workflow efficiency audit (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("\nPASS bra166 workflow efficiency audit (per-workflow baselines from the ledger, regression check with numbers, tighten-only ratchet, loosen by recorded human reason)");
  return 0;
}

process.exit(await main());
