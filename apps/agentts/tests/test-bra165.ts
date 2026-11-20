#!/usr/bin/env bun
/**
 * Workflow run ledger (Linear BRA-165 — r2 foundation).
 *
 * The cost model records per-call-site wall-time actuals and the
 * scheduler reads them; tier timings are recorded per run.sh
 * section. Neither aggregates per-RUN totals, and nothing records
 * tokens anywhere. The ledger (src/run-ledger.ts) is the single
 * source for per-run efficiency numbers: one record per terminal
 * run in <stateDir>/ledger/run-ledger.jsonl, carrying wall clock,
 * trap/job counts, and tokens as reported by workers.
 *
 * Token finding (verified in code, not assumed): the complete-job
 * payload carries NO token counts (worker-server.ts completeJob
 * reads jobId/workerId/files/error/result only; the worker loop
 * posts no tokens; the CLI has no --tokens flag), and no adapter
 * reports TrapAnswer.tokens today (adapter.ts says so outright).
 * Tokens are therefore explicit unknown (total null) until an
 * adapter starts reporting them — never invented.
 *
 * Sections:
 *   A. Unit — pure ledger functions on a synthetic journal tree
 *      and ledger-file round trips (no host, no engine).
 *   B. Integration — Host + mock adapter + virtual clock: a run
 *      driven through submit + runQueue leaves a ledger entry; a
 *      failing run leaves a failed entry; a second run of the same
 *      workflow shows comparable numbers.
 *   C. E2E — a real run through the CLI (`agentts run --wait`,
 *      direct adapter, real exec/clock, no mocks) leaves a ledger
 *      entry whose wall time covers the workflow's real 50ms sleep;
 *      the scheduler ranking surface reads that real ledger file.
 *
 *   DURABLETS_HOST=<built C host> DQUICKTS=<dquickts tree> bun tests/test-bra165.ts
 *   (run.sh sets both.)
 *
 * Run outputs go to $BRA165_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "bun";

import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import {
  buildLedgerEntry,
  appendLedgerEntry,
  loadLedger,
  meanWallMsForWorkflow,
  meanTokensForWorkflow,
  rankQueueByLedgerCost,
  recordRunLedger,
  ledgerFile,
  type JournalTree,
  type LedgerEntry,
} from "../src/run-ledger";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA165_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra165-"));
const STATE_DIR = path.join(WORKDIR, "state");
const E2E_DIR = path.join(WORKDIR, "e2e-state");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(E2E_DIR, { recursive: true });

// Standing rule: any test that submits in-process sets
// AGENTTS_WORKER_SERVER first, or notifyEvent posts to the
// production port 18741. No test server runs here, so point it at
// a dead port — notifyEvent is fire-and-forget.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:9";

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra165-ledger.ts");
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

/** Minimal synthetic journal tree: 3 traps over 1000ms of wall time. */
function syntheticTree(withTokens: boolean): JournalTree {
  const t0 = "2026-11-19T00:00:00.000Z";
  const t1 = "2026-11-19T00:00:01.000Z";
  const events: any[] = [
    { event: "lifecycle", lifecycle: "started", runId: "run-synth", wallTs: t0 },
    { event: "trap", trapId: "run-synth/trap-0", type: "exec", wallTs: t0 },
    { event: "trap", trapId: "run-synth/trap-1", type: "exec", wallTs: t0 },
    { event: "trap", trapId: "run-synth/trap-2", type: "job", wallTs: t0 },
    {
      event: "trap-result",
      trapId: "run-synth/trap-0",
      wallTs: t0,
      ...(withTokens ? { tokens: 120 } : {}),
    },
    { event: "trap-result", trapId: "run-synth/trap-1", wallTs: t0 },
    { event: "trap-error", trapId: "run-synth/trap-2", wallTs: t1, error: "boom" },
    { event: "lifecycle", lifecycle: "completed", runId: "run-synth", wallTs: t1 },
  ];
  return { rootRunId: "run-synth", journals: [{ runId: "run-synth", file: "synth", events }] };
}

function readLedger(stateDir: string): LedgerEntry[] {
  const f = ledgerFile(stateDir);
  if (!fs.existsSync(f)) return [];
  return loadLedger(f).entries;
}

function readQueue(stateDir: string): any[] {
  const p = path.join(stateDir, "queue.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main(): Promise<number> {
  // ---------------------------------------------------------- A. unit
  console.log("=== A. unit: pure ledger functions on a synthetic journal tree ===");
  const entry = buildLedgerEntry(syntheticTree(true), {
    runId: "run-synth",
    workflow: "workflows/synth.ts",
    status: "done",
    adapter: "direct",
  });
  check(entry !== null, "UNIT OK: buildLedgerEntry returns an entry for a non-empty tree");
  check(entry?.wallMs === 1000, `UNIT OK: wallMs is the journal span (got ${entry?.wallMs})`);
  check(entry?.startedAt === "2026-11-19T00:00:00.000Z", `UNIT OK: startedAt is the first wallTs (got ${entry?.startedAt})`);
  check(entry?.finishedAt === "2026-11-19T00:00:01.000Z", `UNIT OK: finishedAt is the last wallTs (got ${entry?.finishedAt})`);
  check(entry?.traps.total === 3, `UNIT OK: traps.total counts answered traps (got ${entry?.traps.total})`);
  check(entry?.traps.byType["exec"]?.results === 2, `UNIT OK: byType.exec.results is 2 (got ${entry?.traps.byType["exec"]?.results})`);
  check(entry?.traps.byType["job"]?.errors === 1, `UNIT OK: byType.job.errors is 1 (got ${entry?.traps.byType["job"]?.errors})`);
  check(entry?.traps.jobsCompleted === 0, `UNIT OK: jobsCompleted is 0 (got ${entry?.traps.jobsCompleted})`);
  check(entry?.traps.jobsFailed === 1, `UNIT OK: jobsFailed is 1 (got ${entry?.traps.jobsFailed})`);
  check(entry?.tokens.total === 120, `UNIT OK: tokens.total sums reported tokens (got ${entry?.tokens.total})`);
  check(entry?.tokens.reportedTraps === 1, `UNIT OK: tokens.reportedTraps is 1 (got ${entry?.tokens.reportedTraps})`);
  check(entry?.tokens.totalTraps === 3, `UNIT OK: tokens.totalTraps is 3 (got ${entry?.tokens.totalTraps})`);
  check(entry?.gateHoldMs === null, `UNIT OK: gateHoldMs is null with no gates (got ${entry?.gateHoldMs})`);
  check(entry?.error === null, `UNIT OK: error is null for a done run (got ${entry?.error})`);

  const noTokens = buildLedgerEntry(syntheticTree(false), {
    runId: "run-synth",
    workflow: "workflows/synth.ts",
    status: "done",
    adapter: "direct",
  });
  check(noTokens?.tokens.total === null, `UNIT OK: tokens.total is null when no trap reports tokens (got ${noTokens?.tokens.total})`);
  check(noTokens?.tokens.reportedTraps === 0, `UNIT OK: tokens.reportedTraps is 0 when none report (got ${noTokens?.tokens.reportedTraps})`);

  check(
    buildLedgerEntry({ rootRunId: "run-empty", journals: [] }, { runId: "run-empty", workflow: "w", status: "done", adapter: "direct" }) === null,
    "UNIT OK: buildLedgerEntry returns null for an empty tree",
  );

  const ledgerTmp = path.join(WORKDIR, "unit-ledger.jsonl");
  const e1: LedgerEntry = { ...entry!, runId: "r1", workflow: "wf-a", wallMs: 100, tokens: { total: 50, reportedTraps: 1, totalTraps: 2 } };
  const e2: LedgerEntry = { ...entry!, runId: "r2", workflow: "wf-a", wallMs: 300, tokens: { total: null, reportedTraps: 0, totalTraps: 2 } };
  const e3: LedgerEntry = { ...entry!, runId: "r3", workflow: "wf-b", wallMs: null, tokens: { total: 90, reportedTraps: 1, totalTraps: 1 } };
  appendLedgerEntry(ledgerTmp, e1);
  appendLedgerEntry(ledgerTmp, e2);
  appendLedgerEntry(ledgerTmp, e3);
  fs.appendFileSync(ledgerTmp, "{not json\n");
  const loaded = loadLedger(ledgerTmp);
  check(loaded.entries.length === 3, `UNIT OK: loadLedger returns the 3 good entries (got ${loaded.entries.length})`);
  check(loaded.skipped === 1, `UNIT OK: loadLedger skips the corrupt line (skipped=${loaded.skipped})`);
  const missing = loadLedger(path.join(WORKDIR, "no-such-ledger.jsonl"));
  check(missing.entries.length === 0 && missing.skipped === 0, "UNIT OK: loadLedger on a missing file returns empty, skipped 0");

  check(meanWallMsForWorkflow(loaded.entries, "wf-a") === 200, `UNIT OK: meanWallMsForWorkflow averages wf-a (got ${meanWallMsForWorkflow(loaded.entries, "wf-a")})`);
  check(meanWallMsForWorkflow(loaded.entries, "wf-b") === null, "UNIT OK: meanWallMsForWorkflow is null when no run has a known wall time");
  check(meanWallMsForWorkflow(loaded.entries, "wf-nope") === null, "UNIT OK: meanWallMsForWorkflow is null for an unknown workflow");
  check(meanTokensForWorkflow(loaded.entries, "wf-a") === 50, `UNIT OK: meanTokensForWorkflow averages only runs that reported (got ${meanTokensForWorkflow(loaded.entries, "wf-a")})`);
  check(meanTokensForWorkflow(loaded.entries, "wf-b") === 90, `UNIT OK: meanTokensForWorkflow for wf-b is 90 (got ${meanTokensForWorkflow(loaded.entries, "wf-b")})`);

  const ranked = rankQueueByLedgerCost(
    [{ workflow: "wf-b" }, { workflow: "wf-unknown" }, { workflow: "wf-a" }, { workflow: "wf-unknown-2" }],
    loaded.entries,
  );
  check(
    ranked.map((q) => q.workflow).join(",") === "wf-a,wf-b,wf-unknown,wf-unknown-2",
    `UNIT OK: rankQueueByLedgerCost orders fast before slow before unknown, stable (got ${ranked.map((q) => q.workflow).join(",")})`,
  );
  const tie = rankQueueByLedgerCost(
    [{ workflow: "wf-t1" }, { workflow: "wf-t2" }],
    [
      { ...e1, runId: "t1", workflow: "wf-t1", wallMs: 100, tokens: { total: 500, reportedTraps: 1, totalTraps: 1 } },
      { ...e1, runId: "t2", workflow: "wf-t2", wallMs: 100, tokens: { total: 50, reportedTraps: 1, totalTraps: 1 } },
    ],
  );
  check(
    tie.map((q) => q.workflow).join(",") === "wf-t2,wf-t1",
    `UNIT OK: rankQueueByLedgerCost breaks a wall-time tie by tokens (got ${tie.map((q) => q.workflow).join(",")})`,
  );
  const input = [{ workflow: "wf-b" }, { workflow: "wf-a" }];
  rankQueueByLedgerCost(input, loaded.entries);
  check(input[0].workflow === "wf-b", "UNIT OK: rankQueueByLedgerCost does not mutate its input");

  const noJournal = recordRunLedger(path.join(WORKDIR, "no-journals-state"), {
    runId: "run-none",
    workflow: "w",
    status: "done",
    adapter: "direct",
  });
  check(noJournal === null, "UNIT OK: recordRunLedger returns null (never throws) when the run has no journal");

  // --------------------------------------------- B. integration (host)
  console.log("=== B. integration: Host + mock adapter + virtual clock ===");
  const host = new Host({ stateDir: STATE_DIR, adapter: new MockAdapter({ gates: "auto" }), clock: "virtual" });
  const runId = "run-bra165-ledger";
  host.submit(WORKFLOW, { runId, input: {} });
  await host.runQueue();
  const entryRow = readQueue(STATE_DIR).find((e) => e.runId === runId);
  check(entryRow?.status === "done", `INT OK: run done (got ${entryRow?.status ?? "missing"}${entryRow?.error ? `: ${String(entryRow.error).slice(0, 200)}` : ""})`);
  const entries1 = readLedger(STATE_DIR);
  check(entries1.length === 1, `INT OK: exactly one ledger entry after one run (got ${entries1.length})`);
  const le1 = entries1[0];
  check(le1?.runId === runId, `INT OK: entry runId matches (got ${le1?.runId})`);
  check(le1?.workflow === WORKFLOW, `INT OK: entry workflow is the submitted path (got ${le1?.workflow})`);
  check(le1?.status === "done", `INT OK: entry status done (got ${le1?.status})`);
  check(le1?.adapter === "mock", `INT OK: entry adapter mock (got ${le1?.adapter})`);
  check(typeof le1?.wallMs === "number" && le1.wallMs >= 0, `INT OK: entry wallMs is a real number (got ${le1?.wallMs})`);
  check(le1?.traps.total === 3, `INT OK: entry traps.total is 3 (got ${le1?.traps.total})`);
  check(le1?.traps.byType["exec"]?.results === 2, `INT OK: entry byType.exec.results is 2 (got ${le1?.traps.byType["exec"]?.results})`);
  check(le1?.traps.byType["sleep"]?.results === 1, `INT OK: entry byType.sleep.results is 1 (got ${le1?.traps.byType["sleep"]?.results})`);
  check(le1?.traps.jobsCompleted === 0, `INT OK: entry jobsCompleted is 0 (got ${le1?.traps.jobsCompleted})`);
  check(le1?.tokens.total === null, `INT OK: entry tokens.total is null — the mock reports no tokens (got ${le1?.tokens.total})`);
  check(le1?.tokens.reportedTraps === 0, `INT OK: entry tokens.reportedTraps is 0 (got ${le1?.tokens.reportedTraps})`);
  check(le1?.tokens.totalTraps === 3, `INT OK: entry tokens.totalTraps is 3 (got ${le1?.tokens.totalTraps})`);
  check(le1?.error === null, `INT OK: entry error is null (got ${le1?.error})`);

  // Acceptance 3: a second run of the same workflow shows comparable numbers.
  const runId2 = "run-bra165-ledger-2";
  host.submit(WORKFLOW, { runId: runId2, input: {} });
  await host.runQueue();
  const entries2 = readLedger(STATE_DIR);
  check(entries2.length === 2, `INT OK: two ledger entries after two runs (got ${entries2.length})`);
  const le2 = entries2.find((e) => e.runId === runId2);
  check(le2?.status === "done", `INT OK: second run done (got ${le2?.status})`);
  check(
    le2?.traps.total === le1?.traps.total && JSON.stringify(le2?.traps.byType) === JSON.stringify(le1?.traps.byType),
    "INT OK: second run shows the same trap counts as the first",
  );
  check(
    typeof le2?.wallMs === "number" && typeof le1?.wallMs === "number" && le2.wallMs < 5000 && le1.wallMs < 5000,
    `INT OK: both runs' wall times are comparable sub-second numbers (first ${le1?.wallMs}ms, second ${le2?.wallMs}ms)`,
  );

  // A failing run leaves a failed entry with the reason.
  const failRunId = "run-bra165-fail";
  host.submit(FAIL_WORKFLOW, { runId: failRunId, input: { note: "ledger-fail" } });
  await host.runQueue();
  const entries3 = readLedger(STATE_DIR);
  check(entries3.length === 3, `INT OK: three ledger entries after three runs (got ${entries3.length})`);
  const leFail = entries3.find((e) => e.runId === failRunId);
  check(leFail?.status === "failed", `INT OK: failed run's entry status is failed (got ${leFail?.status})`);
  check(
    typeof leFail?.error === "string" && leFail.error.includes("bra110 deliberate failure"),
    `INT OK: failed entry carries the failure reason (got ${String(leFail?.error).slice(0, 120)})`,
  );

  // ------------------------------------------------------- C. e2e (CLI)
  console.log("=== C. e2e: real CLI run, direct adapter, real exec/clock ===");
  if (!process.env.DURABLETS_HOST) {
    fail("E2E FAIL: DURABLETS_HOST is not set — run.sh sets it; refusing to guess a C host");
  } else {
    const cli = spawn(
      [BUN, path.join(ROOT, "src", "cli.ts"), "run", WORKFLOW, "--wait", "--adapter", "direct", "--clock", "real", "--state-dir", E2E_DIR, "--input", "{}"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    const [cliOut, cliErr] = await Promise.all([
      new Response(cli.stdout).text().catch(() => ""),
      new Response(cli.stderr).text().catch(() => ""),
    ]);
    const cliRc = await cli.exited;
    console.log(`CLI run rc=${cliRc}`);
    if (cliRc !== 0) {
      console.log(`CLI stdout: ${cliOut.slice(-1500)}`);
      console.log(`CLI stderr: ${cliErr.slice(-1500)}`);
    }
    check(cliRc === 0, `E2E OK: CLI run --wait exits 0 (got ${cliRc})`);
    const e2eEntries = readLedger(E2E_DIR);
    check(e2eEntries.length === 1, `E2E OK: exactly one ledger entry after the CLI run (got ${e2eEntries.length})`);
    const e2e = e2eEntries[0];
    check(e2e?.status === "done", `E2E OK: CLI run's entry status done (got ${e2e?.status})`);
    check(e2e?.adapter === "direct", `E2E OK: CLI run's entry adapter direct (got ${e2e?.adapter})`);
    check(e2e?.traps.total === 3, `E2E OK: CLI run's entry traps.total is 3 (got ${e2e?.traps.total})`);
    check(
      typeof e2e?.wallMs === "number" && e2e.wallMs >= 50,
      `E2E OK: CLI run's wall time covers the real 50ms sleep (got ${e2e?.wallMs}ms)`,
    );
    check(e2e?.tokens.total === null, `E2E OK: CLI run's entry tokens.total is null — the direct adapter reports none (got ${e2e?.tokens.total})`);
    // Acceptance 2 against the REAL ledger file: the scheduler surface
    // reads this ledger and ranks the real workflow ahead of a slow one.
    appendLedgerEntry(ledgerFile(E2E_DIR), {
      ...e2e!,
      runId: "run-synth-slow",
      workflow: "workflows/slow-synth.ts",
      wallMs: 60_000,
    });
    const reloaded = loadLedger(ledgerFile(E2E_DIR));
    check(reloaded.entries.length === 2, `E2E OK: ledger reloads with both entries (got ${reloaded.entries.length})`);
    const rankedE2E = rankQueueByLedgerCost(
      [{ workflow: "workflows/slow-synth.ts" }, { workflow: WORKFLOW }],
      reloaded.entries,
    );
    check(
      rankedE2E[0].workflow === WORKFLOW,
      `E2E OK: rankQueueByLedgerCost puts the real workflow ahead of the 60s one (got ${rankedE2E.map((q) => q.workflow).join(",")})`,
    );
  }

  if (FAILURES.length > 0) {
    console.log(`\nFAIL bra165 run ledger (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("\nPASS bra165 run ledger (one record per terminal run: wall clock + trap/job counts + tokens, explicit unknown)");
  return 0;
}

process.exit(await main());
