#!/usr/bin/env bun
/**
 * Host test driver (Linear BRA-44).
 *
 * Ports the mock suite's tests to the AgentTS host (disk blob store,
 * disk JSONL journal, persisted registry, adapter seam, run queue)
 * plus host-only tests: disk journal/blob durability, compiler
 * refusal, queue, task-backend sync, cross-process gate delivery
 * (CLI twice), real clock + real exec through the direct adapter,
 * JudgeFixLoop end-to-end (mock judges + real worker processes),
 * plugin/adapter loading.
 *
 * Run outputs go to $HOST_WORKDIR (scratch, set by run.sh). The host
 * stateDir IS the workdir: slices/ holds transient .snap/.out/.log,
 * blobs/ the disk blob store, journals/ the JSONL source of truth,
 * cache/ the schema cache. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Host, HostRefusalError, prefixFor } from "../src/host";
import { MockAdapter } from "../src/adapters/mock-adapter";
import { DirectAdapter } from "../src/adapters/direct-adapter";
import { decideLocal } from "../src/decision-model";
import { ExtractionError } from "../src/extract";
import { toJsonValue, JsonBoundaryError } from "../src/agentts";
import { GateError } from "../src/gate";
import { CheckerError } from "../src/checker";
import { LocalTaskBackend, syncRunToTask } from "../src/task-backend";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const WORKDIR = process.env.HOST_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "host-suite-"));
const SLICES = path.join(WORKDIR, "slices");
const BUN = "/opt/hatch-image/bin/bun";

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

function parseOutLines(outPath: string): Record<string, string> {
  const lines: Record<string, string> = {};
  if (!fs.existsSync(outPath)) return lines;
  for (const line of fs.readFileSync(outPath, "utf8").split("\n")) {
    const s = line.replace(/\n$/, "");
    const i = s.indexOf(": ");
    if (i >= 0) lines[s.slice(0, i)] = s.slice(i + 2);
  }
  return lines;
}
function outPathFor(runId: string): string {
  return path.join(SLICES, prefixFor(runId) + ".out");
}
function zipLines(a: string, b: string): [string, string][] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: [string, string][] = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i++) out.push([al[i] ?? "", bl[i] ?? ""]);
  return out;
}

// ---------------------------------------------------------------- runTest
async function runTest(
  name: string,
  workflow: string,
  direct: string,
  runId: string,
  branches: number,
  bundleOut?: string,
): Promise<{ host: Host; runId: string; branches: number } | null> {
  console.log(`\n=== ${name} ===`);
  const d = prefixFor(runId + "-direct");
  // Straight-through reference.
  const directHost = new Host({ stateDir: WORKDIR });
  let rc = directHost.startRun(path.join(TESTS, direct), runId + "-direct");
  rc = directHost.drive(runId + "-direct");
  if (rc !== 0) {
    fail(`${name}: direct reference exited ${rc}`);
    return null;
  }
  console.log(`--- direct output ---`);
  console.log(fs.readFileSync(path.join(SLICES, d + ".out"), "utf8"));
  if (directHost.registrySize() !== 0) {
    fail(`${name}: direct host registry not empty after completion`);
    return null;
  }

  // Fork version: the parent suspends at a combinator (exit 3).
  const host = new Host({ stateDir: WORKDIR });
  if (bundleOut) {
    const { entryPath } = host.prepareRun(path.join(TESTS, workflow), runId);
    let bundle: string;
    try {
      bundle = await host.bundle(entryPath, bundleOut);
    } catch (e) {
      fail(`${name}: Bun.build failed: ${(e as Error).message}`);
      return null;
    }
    console.log(`BUNDLED OK: workflow + agentts module -> one self-contained script (${fs.statSync(bundle).size} bytes)`);
    rc = host.startRunFrom(bundle, runId);
  } else {
    rc = host.startRun(path.join(TESTS, workflow), runId);
  }
  if (rc !== 3) {
    fail(`${name}: parent run exited ${rc}, expected 3 (suspended at a combinator)`);
    return null;
  }
  console.log(
    `parent suspended at a combinator, snapshot ${fs.statSync(path.join(SLICES, prefixFor(runId) + ".snap")).size} bytes`,
  );
  if (!host.registryHas(runId)) {
    fail(`${name}: registry does not hold suspended parent ${runId}`);
    return null;
  }
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`${name}: parent exited ${rc}`);
    return null;
  }
  console.log(`--- parent output ---`);
  console.log(fs.readFileSync(outPathFor(runId), "utf8"));
  const parentOut = fs.readFileSync(outPathFor(runId));
  const directOut = fs.readFileSync(path.join(SLICES, d + ".out"));
  if (parentOut.equals(directOut)) {
    console.log("OUTPUT MATCH: parent byte-identical to direct reference");
  } else {
    fail(`${name}: parent output differs from direct reference`);
    for (const [a, b] of zipLines(parentOut.toString(), directOut.toString())) {
      if (a !== b) console.log(`  parent: ${a}\n  direct: ${b}`);
    }
  }
  if (host.registrySize() !== 0) {
    fail(`${name}: registry not empty after completion: ${host.registryIds().join(", ")}`);
  }
  return { host, runId, branches };
}

function checkJournalPair(
  host: Host,
  name: string,
  runId: string,
  forkId: string,
  branches: number,
  verdicts: any[],
): void {
  const events = host.journal(runId);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  if (forks.length !== 1) {
    fail(`${name}: expected 1 fork event, got ${forks.length}`);
    return;
  }
  const fork = forks[0];
  if (fork.forkId !== forkId) fail(`${name}: fork id ${fork.forkId} != ${forkId}`);
  if (fork.kind !== "all" || fork.branches !== branches)
    fail(`${name}: fork event kind/branches wrong: ${JSON.stringify(fork)}`);
  if ((fork.childRuns || []).length !== branches)
    fail(`${name}: childRuns length != ${branches}: ${JSON.stringify(fork)}`);
  if (joins.length !== 1) {
    fail(`${name}: expected 1 join event, got ${joins.length}`);
    return;
  }
  if (joins[0].forkId !== forkId)
    fail(`${name}: join fork id ${joins[0].forkId} != ${forkId}`);
  if (JSON.stringify(joins[0].outcome) !== JSON.stringify(verdicts))
    fail(`${name}: join outcome != verdicts:\n  ${JSON.stringify(joins[0].outcome)}\n  vs\n  ${JSON.stringify(verdicts)}`);
  for (let i = 0; i < (fork.childRuns || []).length; i++) {
    const child = fork.childRuns[i];
    const cevents = host.journal(child);
    const starts = cevents.filter((e) => e.event === "branch-start");
    const dones = cevents.filter((e) => e.event === "branch-done");
    if (starts.length !== 1 || starts[0].parentForkId !== forkId)
      fail(`${name}: child ${child} branch-start missing/wrong parentForkId: ${JSON.stringify(starts)}`);
    if (dones.length !== 1 || dones[0].parentForkId !== forkId)
      fail(`${name}: child ${child} branch-done missing/wrong parentForkId: ${JSON.stringify(dones)}`);
    else if (JSON.stringify(dones[0].outcome) !== JSON.stringify(verdicts[i]))
      fail(`${name}: child ${child} branch-done outcome != verdicts[${i}]: ${JSON.stringify(dones[0].outcome)}`);
  }
}

function checkCancelEvent(
  events: any[],
  runId: string,
  what: string,
  trigger: string,
  reason: string,
  extra: Record<string, any> = {},
): any | null {
  const cancels = events.filter((e) => e.event === "cancel");
  if (cancels.length !== 1) {
    fail(`${runId}: expected 1 cancel event, got ${cancels.length}: ${JSON.stringify(events)}`);
    return null;
  }
  const c = cancels[0];
  if (c.what !== what) fail(`${runId}: cancel what ${c.what} != ${what}: ${JSON.stringify(c)}`);
  if (c.trigger !== trigger) fail(`${runId}: cancel trigger ${c.trigger} != ${trigger}: ${JSON.stringify(c)}`);
  if (c.reason !== reason) fail(`${runId}: cancel reason ${c.reason} != ${reason}: ${JSON.stringify(c)}`);
  if (typeof c.when !== "number" || c.when <= 0)
    fail(`${runId}: cancel when missing or not a positive integer: ${JSON.stringify(c)}`);
  for (const [k, v] of Object.entries(extra)) {
    if (JSON.stringify(c[k]) !== JSON.stringify(v))
      fail(`${runId}: cancel ${k} ${JSON.stringify(c[k])} != ${JSON.stringify(v)}: ${JSON.stringify(c)}`);
  }
  return c;
}

// ------------------------------------------------------- ported core tests
async function testJudges(): Promise<void> {
  const r = await runTest("judges (3 simulated judges, one throws)", "workflow-judges.ts", "workflow-judges-direct.ts", "run-judges", 3);
  if (!r) return;
  const lines = parseOutLines(outPathFor(r.runId));
  const verdicts = JSON.parse(lines["verdicts"]);
  const expected = [
    { ok: true, value: "approved/verified" },
    { ok: true, value: "weak/retried" },
    { ok: false, error: { name: "Error", message: "judge crashed" } },
  ];
  check(JSON.stringify(verdicts) === JSON.stringify(expected), "OUTCOMES OK: failed branch is { ok: false, error }");
  const agg = JSON.parse(lines["aggregate"]);
  check(
    JSON.stringify(agg) === JSON.stringify({ approved: 2, failed: 1, summary: "2 approved, 1 failed" }),
    "AGGREGATE OK: 2 approved, 1 failed",
  );
  checkJournalPair(r.host, "judges", r.runId, "run-judges/fork-0", 3, verdicts);
}

async function testGlobal(): Promise<void> {
  const r = await runTest("global state (branch write discarded)", "workflow-global.ts", "workflow-global-direct.ts", "run-global", 3);
  if (!r) return;
  const lines = parseOutLines(outPathFor(r.runId));
  const verdicts = JSON.parse(lines["verdicts"]);
  const expected = [
    { ok: true, value: "read:0" },
    { ok: true, value: "read:99" },
    { ok: true, value: "read:0" },
  ];
  check(JSON.stringify(verdicts) === JSON.stringify(expected), "GLOBAL READ OK: branches saw fork-time sharedCount=0; the writing branch read its own 99");
  check(lines["empty all"] === "[]", "EMPTY all([]) OK: [] with no fork");
  check(lines["sharedCount after join"] === "0", "GLOBAL WRITE DISCARDED OK: parent sharedCount still 0");
  checkJournalPair(r.host, "global", r.runId, "run-global/fork-0", 3, verdicts);
}

async function testNested(): Promise<void> {
  const r = await runTest("nested all() (branch fans out again)", "workflow-nested.ts", "workflow-nested-direct.ts", "run-nested", 2);
  if (!r) return;
  const lines = parseOutLines(outPathFor(r.runId));
  const verdicts = JSON.parse(lines["verdicts"]);
  const nested = [
    { ok: true, value: "approved" },
    { ok: true, value: "approved" },
  ];
  const expected = [
    { ok: true, value: "approved/nested=" + JSON.stringify(nested) },
    { ok: true, value: "weak/retried" },
  ];
  check(JSON.stringify(verdicts) === JSON.stringify(expected), "NESTED OK: branch 0 joined its own sub-judges");
  checkJournalPair(r.host, "nested", r.runId, "run-nested/fork-0", 2, verdicts);
  checkJournalPair(r.host, "nested-inner", "run-nested/fork-0/branch-0", "run-nested/fork-0/branch-0/fork-0", 2, nested);
}

async function testFailfast(): Promise<void> {
  const r = await runTest("fail-fast bool on all()", "workflow-failfast.ts", "workflow-failfast-direct.ts", "run-failfast", 3);
  if (!r) return;
  const outLines = fs.readFileSync(outPathFor(r.runId), "utf8").split("\n");
  const lines = parseOutLines(outPathFor(r.runId));
  const values = JSON.parse(lines["values"]);
  check(JSON.stringify(values) === JSON.stringify(["approved/verified", "weak/retried"]), "FAIL-FAST SUCCESS OK: bare values in order");
  const collected = JSON.parse(lines["collected false"]);
  const expectedCollected = [
    { ok: true, value: "approved/verified" },
    { ok: false, error: { name: "Error", message: "judge crashed" } },
  ];
  check(JSON.stringify(collected) === JSON.stringify(expectedCollected), "EXPLICIT FALSE OK: all([...], false) is collect-all");
  check(lines["caught is Error"] === "true", "REHYDRATION OK: caught value is a real Error");
  check(outLines.includes("finally ran"), "FINALLY OK: finally block ran after the throw");
  check(lines["caught"] === "judge crashed", "CATCH OK: parent caught the first branch error");
  const continued = JSON.parse(lines["continued"]);
  check(JSON.stringify(continued) === JSON.stringify({ score: 0.9, label: "approved" }), "CONTINUE OK: parent called a further trap after catching");
  check(lines["first failure"] === "judge timed out", "FIRSTNESS OK: the first failure's error was thrown, not the later one");
  const events = r.host.journal(r.runId);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  check(forks.length === 4 && joins.length === 4, `JOURNAL OK: 4 forks + 4 joins (got ${forks.length} + ${joins.length})`);
  if (forks.length === 4 && joins.length === 4) {
    check(forks[0].failFast === true, "JOURNAL OK: fork-0 failFast true");
    check(JSON.stringify(joins[0].outcome) === JSON.stringify(["approved/verified", "weak/retried"]), "JOURNAL OK: fork-0 join recorded the bare values");
    check(forks[1].failFast === false, "JOURNAL OK: fork-1 failFast false");
    const j2 = joins[2];
    check(
      j2.failedBranch === 1 &&
        JSON.stringify(j2.error) === JSON.stringify({ name: "Error", message: "judge crashed" }) &&
        JSON.stringify(j2.cancelled) === JSON.stringify([2]) &&
        JSON.stringify(j2.completed) === JSON.stringify([{ ok: true, value: "approved/verified" }]),
      "JOURNAL OK: fork-2 join recorded the thrown error, failed branch 1, cancelled [2]",
    );
    const j3 = joins[3];
    check(
      j3.failedBranch === 1 &&
        JSON.stringify(j3.error) === JSON.stringify({ name: "Error", message: "judge timed out" }) &&
        JSON.stringify(j3.cancelled) === JSON.stringify([2]),
      "JOURNAL OK: fork-3 join recorded branch 1's error ('judge timed out'), cancelled [2]",
    );
  }
}

async function testAny(): Promise<void> {
  const r = await runTest("any (first success wins; all-fail throws AggregateError)", "workflow-any.ts", "workflow-any-direct.ts", "run-any", 3);
  if (!r) return;
  const lines = parseOutLines(outPathFor(r.runId));
  check(lines["winner"] === "approved/verified", "ANY SUCCESS OK: first success wins, bare value");
  check(lines["all-fail is AggregateError"] === "true", "AGGREGATE OK: caught value is a real AggregateError");
  const errors = JSON.parse(lines["all-fail errors"]);
  check(JSON.stringify(errors) === JSON.stringify(["judge crashed", "judge timed out"]), "AGGREGATE ERRORS OK: all branch errors, branch order");
  check(lines["empty any is AggregateError"] === "true" && lines["empty any errors"] === "0", "EMPTY any([]) OK: AggregateError with no errors, no fork");
  const events = r.host.journal(r.runId);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  check(forks.length === 2 && joins.length === 2, `JOURNAL OK: 2 forks + 2 joins (got ${forks.length} + ${joins.length})`);
  if (forks.length === 2 && joins.length === 2) {
    const j0 = joins[0];
    check(
      j0.outcome === "approved/verified" &&
        j0.winner === 1 &&
        JSON.stringify(j0.cancelled) === JSON.stringify([2]) &&
        JSON.stringify(j0.completed) === JSON.stringify([{ ok: false, error: { name: "Error", message: "judge crashed" } }]),
      "JOURNAL OK: fork-0 join recorded winner 1, cancelled [2], the failed branch-0 outcome",
    );
    const j1 = joins[1];
    check(
      j1.aggregate === true &&
        JSON.stringify(j1.errors) === JSON.stringify([
          { name: "Error", message: "judge crashed" },
          { name: "Error", message: "judge timed out" },
        ]) &&
        JSON.stringify(j1.cancelled) === JSON.stringify([]),
      "JOURNAL OK: fork-1 join recorded the AggregateError (both errors, branch order), no cancellations",
    );
  }
}

async function testRace(): Promise<void> {
  const r = await runTest("race (first settler wins; failure throws)", "workflow-race.ts", "workflow-race-direct.ts", "run-race", 3);
  if (!r) return;
  const outLines = fs.readFileSync(outPathFor(r.runId), "utf8").split("\n");
  const lines = parseOutLines(outPathFor(r.runId));
  check(lines["winner"] === "approved/verified", "RACE SUCCESS OK: first settler's bare value wins");
  check(lines["caught is Error"] === "true", "RACE THROW OK: caught value is a real Error");
  check(outLines.includes("finally ran"), "FINALLY OK: finally block ran after the throw");
  check(lines["caught"] === "judge crashed", "RACE CATCH OK: parent caught the first settler's error");
  const events = r.host.journal(r.runId);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  check(forks.length === 2 && joins.length === 2, `JOURNAL OK: 2 forks + 2 joins (got ${forks.length} + ${joins.length})`);
  if (forks.length === 2 && joins.length === 2) {
    const j0 = joins[0];
    check(
      j0.outcome === "approved/verified" &&
        j0.winner === 0 &&
        JSON.stringify(j0.cancelled) === JSON.stringify([1, 2]) &&
        JSON.stringify(j0.completed) === JSON.stringify([]),
      "JOURNAL OK: fork-0 join recorded winner 0, cancelled [1, 2]",
    );
    const j1 = joins[1];
    check(
      j1.failedBranch === 0 &&
        JSON.stringify(j1.error) === JSON.stringify({ name: "Error", message: "judge crashed" }) &&
        JSON.stringify(j1.cancelled) === JSON.stringify([1]),
      "JOURNAL OK: fork-1 join recorded the thrown error, failed branch 0, cancelled [1]",
    );
  }
}

function testRaceEmpty(): void {
  console.log("\n=== race([]) never settles (bounded drive) ===");
  const runId = "run-race-empty";
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-race-empty.ts"), runId);
  if (rc !== 3) {
    fail(`race-empty: parent run exited ${rc}, expected 3 (suspended at race([]))`);
    return;
  }
  console.log("parent suspended at race([])");
  const events = host.journal(runId);
  const fork = events.filter((e) => e.event === "fork").pop();
  check(
    !!fork && fork.kind === "race" && fork.branches === 0 && JSON.stringify(fork.childRuns) === "[]",
    "FORK OK: 0-branch race fork, no children",
  );
  rc = host.drive(runId, { allowUnresolved: true });
  check(rc === 3, "BOUNDED DRIVE OK: still suspended (rc 3)");
  check(!host.journal(runId).some((e) => e.event === "join"), "NO JOIN OK: race([]) spuriously resolved");
  check(host.output(runId) === "", "NO OUTPUT OK: the workflow printed nothing");
  check(host.registryHas(runId), "REGISTRY OK: still-suspended run stays in-flight");
  // Clean up: the suite shares one stateDir, so a run left suspended
  // here would make every later registrySize() assertion fail. Cancel
  // the fork; the CancellationError is uncaught in this workflow, so
  // the run FAILS (rc 1) — which still closes it and leaves the
  // registry empty. The print after race([]) must never run.
  const crc = host.cancelRun(runId, "test cleanup", "test cleanup") ?? -1;
  check(crc === 1, `CLEANUP OK: the still-suspended run failed on cancel as expected (rc ${crc})`);
  check(!host.output(runId).includes("resolved:"), "CLEANUP OK: the print after race([]) never ran");
  check(host.registrySize() === 0, "REGISTRY OK: empty after cleanup");
}

function testCancelStep(): void {
  console.log("\n=== 1. cancel a pending trap ===");
  const runId = "run-cancel-step";
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-cancel-step.ts"), runId);
  if (rc !== 2) {
    fail(`cancel-step: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = host.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`cancel-step: cancelled run exited ${rc}, expected 0`);
    return;
  }
  const lines = host.output(runId).split("\n");
  for (const want of ["caught: CancellationError: user abort", "caught is Error: true", "finally ran", "done, caught: CancellationError: user abort"]) {
    if (!lines.includes(want)) fail(`cancel-step: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.startsWith("got:")))
    fail(`cancel-step: the trap returned a value after being cancelled: ${JSON.stringify(lines)}`);
  const events = host.journal(runId);
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 1 && traps[0].ordinal === 0 && traps[0].trapId === "run-cancel-step/trap-0", "TRAP OK: exactly 1 trap event, ordinal 0, trapId run-cancel-step/trap-0");
  check(!events.some((e) => e.event === "trap-result" || e.event === "trap-error"), "NO RESULT OK: no trap-result/trap-error for a cancelled trap");
  const c = checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  if (c) {
    check(events.indexOf(c) > events.indexOf(traps[0]), "ORDER OK: cancel recorded after the trap dispatch");
    console.log("CANCEL EVENT OK: trap ordinal 0, trigger 'user abort', reason 'user abort', when recorded");
  }
  console.log("CATCH OK: CancellationError at the call site, real Error, finally ran");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testCancelCombinator(): void {
  console.log("\n=== 2. cancel a whole all() in flight ===");
  const runId = "run-cancel-combinator";
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-cancel-combinator.ts"), runId);
  if (rc !== 3) {
    fail(`cancel-combinator: run exited ${rc}, expected 3 (suspended at a combinator)`);
    return;
  }
  const fork = host.forkOf(runId);
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const snap = host.snapPath(runId)!;
  const before = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  const started = host.startForkBranches(runId);
  check(JSON.stringify(started) === JSON.stringify(children), "BRANCHES OK: all three children started");
  for (const child of children) {
    if (host.runRc(child) !== 2) fail(`cancel-combinator: child ${child} not suspended at its first trap`);
  }
  const after = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  check(before === after, "SNAPSHOT OK: parent snapshot untouched while children started");
  const cancelled = host.cancelTree(runId, "user abort", "user abort");
  check(
    JSON.stringify(cancelled) === JSON.stringify([...children, runId]),
    `CANCELLED OK: children first, parent last (got ${JSON.stringify(cancelled)})`,
  );
  const lines = host.output(runId).split("\n");
  for (const want of ["caught: CancellationError", "caught is Error: true", "finally ran", "done, caught: CancellationError"]) {
    if (!lines.includes(want)) fail(`cancel-combinator: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.startsWith("verdicts:")), "NO VERDICTS OK: the all() did not return after being cancelled");
  const events = host.journal(runId);
  check(!events.some((e) => e.event === "join"), "NO JOIN OK: the cancelled fork spuriously joined");
  checkCancelEvent(events, runId, "fork", "user abort", "user abort", { forkId, cancelled: children });
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const cevents = host.journal(child);
    const starts = cevents.filter((e) => e.event === "branch-start");
    const dones = cevents.filter((e) => e.event === "branch-done");
    check(starts.length === 1 && starts[0].parentForkId === forkId, `CHILD OK: ${child} branch-start recorded`);
    checkCancelEvent(cevents, child, "trap", "parent cancelled", "user abort", {
      ordinal: 0,
      parentForkId: forkId,
      branch: i,
    });
    check(
      dones.length === 1 &&
        JSON.stringify(dones[0].outcome) === JSON.stringify({ ok: true, value: "cancelled:CancellationError" }),
      `CHILD OK: ${child} caught its cancellation and returned 'cancelled:CancellationError'`,
    );
  }
  console.log("PARENT OK: CancellationError at the all() call site, finally ran; no join event");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testSticky(): void {
  console.log("\n=== 3. sticky cancellation ===");
  const runId = "run-sticky";
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-sticky.ts"), runId);
  if (rc !== 2) {
    fail(`sticky: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = host.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`sticky: cancelled run exited ${rc}, expected 0 (the workflow must not suspend again)`);
    return;
  }
  const lines = host.output(runId).split("\n");
  for (const want of ["caught: CancellationError", "finally ran", "second threw: CancellationError", "all threw: CancellationError", "done"]) {
    if (!lines.includes(want)) fail(`sticky: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.startsWith("ERROR:")), "STICKY OK: the second trap() and the all() both threw at once — neither dispatched");
  const events = host.journal(runId);
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 1 && traps[0].ordinal === 0, "TRAP OK: exactly 1 trap event (ordinal 0)");
  check(!events.some((e) => e.event === "fork"), "NO FORK OK: the all() after the cancel did not fork");
  checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testRaceOrder(): void {
  console.log("\n=== 4a. cancel-vs-complete race: result first ===");
  let runId = "run-race-a";
  let host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-race-order.ts"), runId);
  if (rc !== 2) {
    fail(`race-a: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = host.driveStep(runId);
  if (rc !== 2) {
    fail(`race-a: after the first result the run exited ${rc}, expected 2 (suspended at the second trap)`);
    return;
  }
  rc = host.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`race-a: cancelled run exited ${rc}, expected 0`);
    return;
  }
  let lines = host.output(runId).split("\n");
  for (const want of [
    'first got: {"score":0.92,"label":"approved"}',
    "first finally ran",
    "second threw: CancellationError",
    "second finally ran",
    "done",
  ]) {
    if (!lines.includes(want)) fail(`race-a: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  let events = host.journal(runId);
  const results = events.filter((e) => e.event === "trap-result");
  const cancels = events.filter((e) => e.event === "cancel");
  if (results.length !== 1 || results[0].ordinal !== 0)
    fail(`race-a: expected 1 trap-result (ordinal 0), got ${JSON.stringify(results)}`);
  else if (cancels.length !== 1) fail(`race-a: expected 1 cancel event, got ${cancels.length}`);
  else if (events.indexOf(results[0]) > events.indexOf(cancels[0]))
    fail("race-a: the cancel event precedes the trap-result — the result did not win the race in the journal");
  else if (cancels[0].ordinal !== 1) fail(`race-a: cancel ordinal ${cancels[0].ordinal} != 1`);
  else console.log("RACE OK (result-first): the first result is kept — the trap-result is recorded before the cancel event");

  console.log("\n=== 4b. cancel-vs-complete race: cancel first ===");
  runId = "run-race-b";
  host = new Host({ stateDir: WORKDIR });
  rc = host.startRun(path.join(TESTS, "workflow-race-order.ts"), runId);
  if (rc !== 2) {
    fail(`race-b: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = host.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`race-b: cancelled run exited ${rc}, expected 0 (sticky: the second trap must throw at once, not suspend)`);
    return;
  }
  lines = host.output(runId).split("\n");
  for (const want of ["first threw: CancellationError", "first finally ran", "second threw: CancellationError", "second finally ran", "done"]) {
    if (!lines.includes(want)) fail(`race-b: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.includes("got:")), "RACE OK (cancel-first): no result ever landed, and the second trap threw at once (sticky)");
  events = host.journal(runId);
  check(!events.some((e) => e.event === "trap-result"), "NO RESULT OK: no trap-result for a cancelled trap");
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 1 && traps[0].ordinal === 0, "TRAP OK: exactly 1 trap event (ordinal 0) — the second trap never dispatched");
  checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testNestedCancel(): void {
  console.log("\n=== 5. nested propagation (cancel the whole tree) ===");
  const runId = "run-nested-cancel";
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-nested-cancel.ts"), runId);
  if (rc !== 3) {
    fail(`nested-cancel: run exited ${rc}, expected 3 (suspended at a combinator)`);
    return;
  }
  const fork = host.forkOf(runId);
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const snap = host.snapPath(runId)!;
  const before = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  host.startForkBranches(runId);
  if (host.runRc(children[0]) !== 3) {
    fail(`nested-cancel: branch 0 exited ${host.runRc(children[0])}, expected 3 (suspended at its own all())`);
    return;
  }
  const b0Snap = host.snapPath(children[0])!;
  const before0 = crypto.createHash("sha256").update(fs.readFileSync(b0Snap)).digest("hex");
  const fork0 = host.forkOf(children[0]);
  const fork0Id = fork0.forkId;
  const grandchildren: string[] = fork0.childRuns;
  host.startForkBranches(children[0]);
  for (const gc of grandchildren) {
    if (host.runRc(gc) !== 2) fail(`nested-cancel: grandchild ${gc} not suspended at its trap`);
  }
  const after0 = crypto.createHash("sha256").update(fs.readFileSync(b0Snap)).digest("hex");
  check(before0 === after0, "SNAPSHOT OK: branch-0 snapshot untouched while grandchildren started");
  if (host.runRc(children[1]) !== 2) {
    fail(`nested-cancel: branch 1 exited ${host.runRc(children[1])}, expected 2 (suspended at its trap)`);
    return;
  }
  const after = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  check(before === after, "SNAPSHOT OK: parent snapshot untouched while the tree started");
  const cancelled = host.cancelTree(runId, "user abort", "user abort");
  const expected = [...grandchildren, children[0], children[1], runId];
  check(
    JSON.stringify(cancelled) === JSON.stringify(expected),
    `CANCELLED OK: deepest first, parent last (got ${JSON.stringify(cancelled)})`,
  );
  const lines = host.output(runId).split("\n");
  for (const want of ["caught: CancellationError", "finally ran", "done, caught: CancellationError"]) {
    if (!lines.includes(want)) fail(`nested-cancel: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.startsWith("verdicts:")), "NO VERDICTS OK: the parent all() did not return after being cancelled");
  const events = host.journal(runId);
  check(!events.some((e) => e.event === "join"), "NO JOIN OK: parent journal has no join");
  checkCancelEvent(events, runId, "fork", "user abort", "user abort", { forkId, cancelled: children });
  const b0Events = host.journal(children[0]);
  check(!b0Events.some((e) => e.event === "join"), "NO JOIN OK: branch-0 journal has no join");
  checkCancelEvent(b0Events, children[0], "fork", "parent cancelled", "user abort", {
    forkId: fork0Id,
    cancelled: grandchildren,
    parentForkId: forkId,
    branch: 0,
  });
  const b0Dones = b0Events.filter((e) => e.event === "branch-done");
  check(
    b0Dones.length === 1 &&
      JSON.stringify(b0Dones[0].outcome) === JSON.stringify({ ok: false, error: { name: "CancellationError", message: "user abort" } }),
    "BRANCH 0 OK: cancelled at its own fork, failed outcome is a CancellationError, no join",
  );
  const b1Events = host.journal(children[1]);
  checkCancelEvent(b1Events, children[1], "trap", "parent cancelled", "user abort", {
    ordinal: 0,
    parentForkId: forkId,
    branch: 1,
  });
  const b1Dones = b1Events.filter((e) => e.event === "branch-done");
  check(
    b1Dones.length === 1 &&
      JSON.stringify(b1Dones[0].outcome) === JSON.stringify({ ok: true, value: "cancelled:CancellationError" }),
    "BRANCH 1 OK: caught its cancellation, returned 'cancelled:CancellationError'",
  );
  for (let i = 0; i < grandchildren.length; i++) {
    const gc = grandchildren[i];
    const gcEvents = host.journal(gc);
    checkCancelEvent(gcEvents, gc, "trap", "parent cancelled", "user abort", {
      ordinal: 0,
      parentForkId: fork0Id,
      branch: i,
    });
    const gcDones = gcEvents.filter((e) => e.event === "branch-done");
    check(
      gcDones.length === 1 &&
        JSON.stringify(gcDones[0].outcome) === JSON.stringify({ ok: false, error: { name: "CancellationError", message: "user abort" } }),
      `GRANDCHILD OK: ${gc} cancelled at its trap, failed outcome is a CancellationError`,
    );
  }
  console.log("TREE OK: every journal (parent, both branches, both grandchildren) records exactly one cancel event");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTrapTypes(): void {
  console.log("\n=== trap dispatch by type string (all six types) ===");
  const runId = "run-trap-types";
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(path.join(TESTS, "workflow-trap-types.ts"), runId);
  if (rc !== 2) {
    fail(`trap-types: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  // Blob round-trip through the DISK store: the stored blob is
  // byte-identical, the live blob is deleted, and the run resumes
  // from the stored disk copy alone.
  const storedHash = host.storedBlobHash(runId);
  if (!storedHash) {
    fail("trap-types: no stored blob in the disk store");
    return;
  }
  host.deleteLiveBlob(runId);
  if (fs.existsSync(host.snapPath(runId)!)) {
    fail("trap-types: live blob still exists after deleteLiveBlob");
    return;
  }
  host.restoreBlob(runId);
  const restoredHash = crypto.createHash("sha256").update(fs.readFileSync(host.snapPath(runId)!)).digest("hex");
  check(restoredHash === storedHash, `BLOB ROUND-TRIP OK: disk store holds the blob (${storedHash.slice(0, 16)}…), run resumes from it`);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`trap-types: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  const expected: Record<string, string> = {
    job: '{"score":0.92,"label":"approved"}',
    exec: '{"stdout":"hi\\n","exitCode":0}',
    gate: '{"answer":"yes"}',
    sleep: '{"sleptMs":1000}',
    cron: '{"scheduled":"2027-04-09T00:00:00Z"}',
    decide: '{"choice":"a","confidence":0.9}',
  };
  for (const [k, v] of Object.entries(expected)) {
    if (!out.includes(`${k}: ${v}`)) fail(`trap-types: missing ${k}: ${v} in output:\n${out}`);
  }
  check(out.includes("done"), "TRAP TYPES OK: job/exec/gate/sleep/cron/decide each answered with its canned result");
  const events = host.journal(runId);
  const traps = events.filter((e) => e.event === "trap");
  const types = traps.map((t) => t.type);
  check(
    JSON.stringify(types) === JSON.stringify(["job", "exec", "gate", "sleep", "cron", "decide"]),
    "TRAP IDS OK: runId/trap-N, one per type, in order",
  );
  if (JSON.stringify(types) === JSON.stringify(["job", "exec", "gate", "sleep", "cron", "decide"])) {
    check(
      traps.every((t, i) => t.trapId === `${runId}/trap-${i}`),
      "TRAP IDS OK: trapIds are runId/trap-N",
    );
  }
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

async function testAgenttsBundle(): Promise<void> {
  console.log("\n=== agentts module via Bun.build (TS host bundles, C host evals) ===");
  const runId = "run-agentts";
  const host = new Host({ stateDir: WORKDIR });
  const { entryPath } = host.prepareRun(path.join(TESTS, "workflow-agentts.ts"), runId);
  let bundleOut: string;
  try {
    bundleOut = await host.bundle(entryPath, "bundle-agentts.js");
  } catch (e) {
    fail(`agentts-bundle: ${(e as Error).message}`);
    return;
  }
  console.log(`BUNDLED OK: workflow + agentts module -> one self-contained script (${fs.statSync(bundleOut).size} bytes)`);
  let rc = host.startRunFrom(bundleOut, runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`agentts-bundle: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  const direct = host.output("run-trap-types");
  check(out === direct, "BUNDLE OUTPUT OK: byte-identical to the direct trap() version — the C host never resolved imports");
  if (out !== direct) fail(`agentts-bundle: bundled output != trap-types output:\n${out}\nvs\n${direct}`);
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
  const trapEvents = host.journal(runId).filter((e) => e.event === "trap");
  const expectedArgs: Record<string, any> = {
    job: { spec: "score", input: { value: 7 } },
    exec: { cmd: "echo hi" },
    gate: { question: "approve?" },
    sleep: { ms: 1000 },
    cron: { at: "2027-04-09T00:00:00Z" },
    decide: { question: "pick one", options: ["a", "b"] },
  };
  const types = ["job", "exec", "gate", "sleep", "cron", "decide"];
  check(trapEvents.length === 6, `TRAP ARGS OK: 6 trap events (got ${trapEvents.length})`);
  if (trapEvents.length === 6) {
    let argsOk = true;
    for (let i = 0; i < 6; i++) {
      const ev = trapEvents[i];
      if (ev.type !== types[i] || ev.trapId !== `${runId}/trap-${i}`) {
        fail(`agentts-bundle: trap ${i} type/id wrong: ${JSON.stringify(ev)}`);
        argsOk = false;
      } else if (JSON.stringify(ev.arg) !== JSON.stringify(expectedArgs[types[i]])) {
        fail(`agentts-bundle: ${types[i]} arg != expected: ${JSON.stringify(ev.arg)} vs ${JSON.stringify(expectedArgs[types[i]])}`);
        argsOk = false;
      }
    }
    check(argsOk, "TRAP ARGS OK: every wrapper emitted exactly trap(type, arg) with the right arg shape, verbatim");
  }
}

async function testAgenttsCombinators(): Promise<void> {
  console.log("\n=== agentts module combinators (re-exported all/any/race) ===");
  const cases: [string, string, string, number][] = [
    ["judges", "workflow-judges-direct.ts", "run-judges-module", 3],
    ["global", "workflow-global-direct.ts", "run-global-module", 3],
    ["nested", "workflow-nested-direct.ts", "run-nested-module", 2],
    ["failfast", "workflow-failfast-direct.ts", "run-failfast-module", 3],
    ["any", "workflow-any-direct.ts", "run-any-module", 3],
    ["race", "workflow-race-direct.ts", "run-race-module", 3],
  ];
  for (const [name, direct, runId, branches] of cases) {
    const r = await runTest(
      `${name} via agentts module`,
      `workflow-${name}-module.ts`,
      direct,
      runId,
      branches,
      `bundle-${name}-module.js`,
    );
    if (r) {
      const traps = r.host.journal(runId).filter((e) => e.event === "trap");
      check(
        !traps.some((t) => t.type === "job" && typeof t.arg?.spec !== "string"),
        `MODULE ${name.toUpperCase()} OK: output byte-identical, job traps carry { spec, input }`,
      );
    }
  }
}

async function testJsonBoundary(): Promise<void> {
  console.log("\n=== trap-boundary JSON rule (BRA-46): dirty args throw at the call site ===");
  const runId = "run-json-boundary";
  const host = new Host({ stateDir: WORKDIR });
  const { entryPath } = host.prepareRun(path.join(TESTS, "workflow-json-boundary.ts"), runId);
  let bundleOut: string;
  try {
    bundleOut = await host.bundle(entryPath, "bundle-json-boundary.js");
  } catch (e) {
    fail(`json-boundary: ${(e as Error).message}`);
    return;
  }
  let rc = host.startRunFrom(bundleOut, runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`json-boundary: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  const expectedLines: [string, string][] = [
    ["dirty undefined:", "$.input.missing"],
    ["dirty function:", "$.input.fn"],
    ["dirty symbol:", "$.input.sym"],
    ["dirty bigint:", "$.input.big"],
    ["dirty nan:", "$.input.nan"],
    ["dirty infinity:", "$.input.inf"],
    ["dirty map:", "$.input.map"],
    ["dirty set:", "$.input.set"],
    ["dirty typed-array:", "$.input.buf"],
    ["dirty class-instance:", "$.input.obj"],
    ["dirty circular:", "$.input.self"],
    ["dirty symbol-key:", "$.input"],
    ["dirty invalid-date:", "$.input.when"],
    ["dirty array-hole:", "$.input.items[1]"],
    ["dirty array-extra-key:", "$.input.items.extra"],
    ["dirty nested-undefined:", "$.input.deep.leaf"],
  ];
  let dirtyOk = true;
  for (const [prefix, path] of expectedLines) {
    const line = out.split("\n").find((l) => l.startsWith(prefix));
    if (!line) {
      fail(`json-boundary: missing output line ${prefix}`);
      dirtyOk = false;
    } else if (!line.includes(path)) {
      fail(`json-boundary: ${prefix} lacks path ${path}: ${line}`);
      dirtyOk = false;
    } else if (!line.includes("JSON boundary (job arg)")) {
      fail(`json-boundary: ${prefix} is not a boundary error: ${line}`);
      dirtyOk = false;
    }
  }
  check(dirtyOk, "DIRTY ARGS OK: every rejected category threw synchronously with a precise path");
  const traps = host.journal(runId).filter((e) => e.event === "trap");
  if (traps.length !== 1) {
    fail(`json-boundary: expected exactly 1 trap event (dirty args never dispatch), got ${traps.length}`);
  } else if (traps[0].type !== "job" || traps[0].arg?.input?.when !== "2027-04-09T00:00:00.000Z") {
    fail(`json-boundary: Date did not cross as ISO string: ${JSON.stringify(traps[0]?.arg)}`);
  } else {
    check(true, "DATE OK: Date crossed as its ISO string in the journal trap arg");
    check(
      out.includes('job: {"score":0.92,"label":"approved"}'),
      "CLEAN DATE JOB OK: canned result returned, run completed",
    );
  }
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testErrorRehydration(): void {
  console.log("\n=== error rehydration (BRA-41): throwing traps arrive as real Errors ===");
  const runId = "run-error-rehydration";
  const d = prefixFor(runId + "-direct");
  const directHost = new Host({ stateDir: WORKDIR });
  let rc = directHost.startRun(path.join(TESTS, "workflow-error-rehydration-direct.ts"), runId + "-direct");
  rc = directHost.drive(runId + "-direct");
  if (rc !== 0) {
    fail(`rehydration: direct reference exited ${rc}`);
    return;
  }
  const host = new Host({ stateDir: WORKDIR });
  host.queueAnswer("job", { throw: { name: "Error", message: "boom" } });
  host.queueAnswer("job", { throw: "plain failure" });
  rc = host.startRun(path.join(TESTS, "workflow-error-rehydration.ts"), runId);
  if (rc !== 2) {
    fail(`rehydration: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`rehydration: run exited ${rc}`);
    return;
  }
  const parentOut = fs.readFileSync(outPathFor(runId));
  const directOut = fs.readFileSync(path.join(SLICES, d + ".out"));
  check(parentOut.equals(directOut), "OUTPUT MATCH: driven version byte-identical to direct reference");
  const lines = parseOutLines(outPathFor(runId));
  check(lines["caught is Error"] === "true", "REHYDRATION OK: throwing trap arrived as a real Error (instanceof Error true)");
  check(lines["caught"] === "Error: boom", "REHYDRATION OK: caught == 'Error: boom'");
  check(lines["plain is Error"] === "false", "NON-ERROR OK: a thrown plain string crosses as-is, not rehydrated");
  check(lines["plain"] === "plain failure", "NON-ERROR OK: plain == 'plain failure'");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

// --------------------------------------------------------- mock-only ports
function testJsonBoundaryUnit(): void {
  console.log("\n=== JSON-clean helper (unit matrix, the module's toJsonValue) ===");
  for (const v of [null, true, false, "", "x", 0, -0, 3.14, 1e9, [], [1, "a", null], {}, { a: 1, b: [true] }, Object.create(null)]) {
    try {
      const out = toJsonValue(v, "value");
      check(JSON.stringify(out) === JSON.stringify(v), `JSON-CLEAN OK: accepts ${JSON.stringify(v)}`);
    } catch (e) {
      fail(`json-clean: should accept ${JSON.stringify(v)}: ${(e as Error).message}`);
    }
  }
  const d = new Date("2027-04-09T12:00:00.000Z");
  const converted = toJsonValue({ at: d, nested: [d] }, "value") as any;
  check(
    converted.at === "2027-04-09T12:00:00.000Z" && converted.nested[0] === "2027-04-09T12:00:00.000Z",
    "JSON-CLEAN OK: Date converts to ISO string, deep",
  );
  const shared = { x: 1 };
  check(
    JSON.stringify(toJsonValue({ a: shared, b: shared }, "value")) === JSON.stringify({ a: { x: 1 }, b: { x: 1 } }),
    "JSON-CLEAN OK: shared (non-circular) references are fine",
  );
  const cases: [unknown, string, string][] = [
    [undefined, "$", "undefined"],
    [{ a: undefined }, "$.a", "undefined"],
    [[1, undefined], "$[1]", "undefined"],
    [{ f: () => 1 }, "$.f", "function"],
    [Symbol("s"), "$", "symbol"],
    [10n, "$", "bigint"],
    [NaN, "$", "non-finite-number"],
    [Infinity, "$", "non-finite-number"],
    [-Infinity, "$", "non-finite-number"],
    [new Map([["a", 1]]), "$", "map"],
    [new Set([1]), "$", "set"],
    [new Uint8Array([1, 2]), "$", "typed-array"],
    [new ArrayBuffer(4), "$", "array-buffer"],
    [new (class Foo { x = 1 })(), "$", "class-instance"],
    [new Error("boom"), "$", "class-instance"],
    [new Date(NaN), "$", "invalid-date"],
    [{ items: [1, , 3] }, "$.items[1]", "array-hole"],
    [{ toJSON: () => "x" }, "$.toJSON", "function"],
  ];
  for (const [v, pathWant, kindWant] of cases) {
    let err: JsonBoundaryError | null = null;
    try {
      toJsonValue(v, "value");
    } catch (e) {
      if (e instanceof JsonBoundaryError) err = e;
    }
    check(
      err !== null && err.path === pathWant && err.kind === kindWant && err.message.includes(pathWant),
      `JSON-CLEAN OK: rejects ${kindWant} at ${pathWant} (${err ? `${err.path} ${err.kind}` : "no throw"})`,
    );
  }
  const circ: any = { a: 1 };
  circ.self = circ;
  try {
    toJsonValue(circ, "value");
    fail("json-clean: circular reference did not throw");
  } catch (e) {
    check(
      e instanceof JsonBoundaryError && (e as JsonBoundaryError).path === "$.self" && (e as JsonBoundaryError).kind === "circular",
      "JSON-CLEAN OK: circular reference at $.self",
    );
  }
  const symKey: any = {};
  symKey[Symbol("k")] = 1;
  try {
    toJsonValue(symKey, "value");
    fail("json-clean: symbol key did not throw");
  } catch (e) {
    check(
      e instanceof JsonBoundaryError && (e as JsonBoundaryError).kind === "non-string-key",
      "JSON-CLEAN OK: symbol key rejected",
    );
  }
  const arrExtra: any = [1, 2];
  arrExtra.note = "hi";
  try {
    toJsonValue(arrExtra, "value");
    fail("json-clean: array extra property did not throw");
  } catch (e) {
    check(
      e instanceof JsonBoundaryError && (e as JsonBoundaryError).path === "$.note" && (e as JsonBoundaryError).kind === "array-extra-key",
      "JSON-CLEAN OK: extra property on an array rejected at $.note",
    );
  }
  let deep: any = {};
  let cursor = deep;
  for (let i = 0; i < 1005; i++) {
    cursor.next = {};
    cursor = cursor.next;
  }
  try {
    toJsonValue(deep, "value");
    fail("json-clean: max depth did not throw");
  } catch (e) {
    check(
      e instanceof JsonBoundaryError && (e as JsonBoundaryError).kind === "max-depth",
      "JSON-CLEAN OK: nesting past 1000 levels rejected (max-depth)",
    );
  }
  const host = new Host({ stateDir: WORKDIR });
  host.journalEvent("run-journal-check", { event: "note", runId: "run-journal-check", at: d });
  const dumped = fs.readFileSync(host.journalPath("run-journal-check"), "utf8");
  check(dumped.includes('"at":"2027-04-09T12:00:00.000Z"'), "JOURNAL OK: Date written as ISO string in the disk JSONL journal");
  let journalThrew = false;
  try {
    host.journalEvent("run-journal-check", { event: "note", runId: "run-journal-check", bad: undefined });
  } catch (e) {
    journalThrew = e instanceof JsonBoundaryError;
  }
  check(journalThrew, "JOURNAL OK: an event with undefined fails loudly instead of writing a corrupt line");
}

function testVirtualClock(): void {
  console.log("\n=== virtual clock (sleep advances, cron fires at absolute datetimes) ===");
  const runId = "run-clock";
  const host = new Host({ stateDir: WORKDIR });
  const wallStart = Date.now();
  let rc = host.startRun(path.join(TESTS, "workflow-clock.ts"), runId);
  if (rc !== 2) {
    fail(`clock: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = host.drive(runId);
  const wallMs = Date.now() - wallStart;
  if (rc !== 0) {
    fail(`clock: run exited ${rc}`);
    return;
  }
  check(wallMs < 10000, `VIRTUAL TIME OK: 2h of sleeps + months of cron jumps completed in ${wallMs}ms wall time (no real waiting)`);
  const lines = parseOutLines(outPathFor(runId));
  check(lines["after sleep 1"] === "2027-01-01T01:00:00.000Z", `CLOCK OK: first sleep advanced the clock 1h (got ${lines["after sleep 1"]})`);
  check(lines["after sleep 2"] === "2027-01-01T02:00:00.000Z", `CLOCK OK: second sleep advanced the clock another 1h — sleeps sum (got ${lines["after sleep 2"]})`);
  check(lines["after cron late"] === "2027-03-01T00:00:00.000Z", `CRON OK: later cron fired at its absolute datetime (got ${lines["after cron late"]})`);
  check(lines["after cron early"] === "2027-03-01T00:00:00.000Z", `CRON OK: earlier cron (already past) fired immediately, clock did not move back (got ${lines["after cron early"]})`);
  check(lines["after cron apr"] === "2027-04-01T00:00:00.000Z", `CRON OK: ascending cron stepped to April (got ${lines["after cron apr"]})`);
  check(lines["after cron may"] === "2027-05-01T00:00:00.000Z", `CRON OK: ascending cron stepped to May (got ${lines["after cron may"]})`);
  check(host.output(runId).includes("done"), "CLOCK OK: workflow completed");
  const advances = host.journal(runId).filter((e) => e.event === "clock-advance");
  check(advances.length >= 5, `JOURNAL OK: ${advances.length} clock-advance events recorded`);
  check(
    advances.some((e) => e.reason === "sleep") && advances.some((e) => e.reason === "cron"),
    "JOURNAL OK: clock-advance events carry their reason (sleep/cron)",
  );
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testGateHold(): void {
  console.log("\n=== held gate (the week-long gate in miniature) ===");
  const runId = "run-gate-hold";
  const host = new Host({ stateDir: WORKDIR, adapter: new MockAdapter({ gates: "hold" }) });
  let rc = host.startRun(path.join(TESTS, "workflow-gate-hold.ts"), runId);
  if (rc !== 2) {
    fail(`gate-hold: run exited ${rc}, expected 2 (suspended at the gate)`);
    return;
  }
  rc = host.drive(runId);
  check(rc === 2, "HOLD OK: drive stopped at the gate (rc 2, not completed)");
  check(host.isGatePending(runId), "HOLD OK: the gate is pending");
  check(host.registryHas(runId), "HOLD OK: the run stays suspended in the registry");
  const held = host.journal(runId).filter((e) => e.event === "gate-held");
  check(held.length === 1 && held[0].question === "approve?", "JOURNAL OK: gate-held event recorded with the question");
  check(host.output(runId) === "", "HOLD OK: no output yet — the gate never resolved until the test delivered an answer");
  rc = host.deliverGate(runId, { answer: "no" });
  check(rc === 0, "DELIVER OK: after the answer the run completed");
  const out = host.output(runId);
  check(out.includes('answer: {"answer":"no"}'), "DELIVER OK: the workflow received the delivered answer");
  check(out.includes("done"), "DELIVER OK: workflow completed");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedValid(): void {
  console.log("\n=== typed trap, valid path (configurable canned decide) ===");
  const runId = "run-typed-valid";
  const host = new Host({ stateDir: WORKDIR });
  host.queueAnswer("decide", { choice: "b", confidence: 0.6 });
  let rc = host.startRun(path.join(TESTS, "workflow-typed-valid.ts"), runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`typed-valid: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  check(out.includes('job: {"score":0.92,"label":"approved"}'), "TYPED OK: job validated against the extracted schema");
  check(out.includes('decide: {"choice":"b","confidence":0.6}'), "CANNED OK: the queued decide answer was delivered");
  check(out.includes("done"), "TYPED OK: workflow completed");
  check(!host.journal(runId).some((e) => e.event === "validation-error"), "JOURNAL OK: no validation-error events on the valid path");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedBadOutput(): void {
  console.log("\n=== typed trap, bad output (schema failure throws at the call site) ===");
  const runId = "run-typed-bad-output";
  const host = new Host({ stateDir: WORKDIR });
  host.queueAnswer("job", { score: "high", label: "approved" });
  let rc = host.startRun(path.join(TESTS, "workflow-typed-bad-output.ts"), runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`typed-bad-output: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  check(out.includes("caught: ValidationError:"), "THROW OK: ValidationError at the call site");
  check(out.includes("$.score") && out.includes("must be number"), `PRECISE OK: the error names the path and the failure (got: ${out.split("\n").find((l) => l.startsWith("caught:")) ?? ""})`);
  check(out.includes("caught is Error: true"), "ERROR OK: caught value is a real Error");
  const errors = host.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1, `JOURNAL OK: exactly 1 validation-error event (got ${errors.length})`);
  if (errors.length === 1) {
    check(errors[0].phase === "output" && errors[0].attempt === 0, "JOURNAL OK: phase output, attempt 0");
    check(
      Array.isArray(errors[0].errors) && errors[0].errors.some((i: any) => i.path === "$.score"),
      "JOURNAL OK: the precise error (path $.score) is journaled",
    );
  }
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedRepair(): void {
  console.log("\n=== typed trap, repair loop (same trapId, error attached) ===");
  const runId = "run-typed-repair";
  const host = new Host({ stateDir: WORKDIR });
  host.queueAnswer("job", { score: "high", label: "approved" });
  const seen: any[] = [];
  host.setRepairHandler("job", (ctx) => {
    seen.push(ctx);
    return { value: { score: 0.92, label: "approved" } };
  });
  let rc = host.startRun(path.join(TESTS, "workflow-typed-repair.ts"), runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`typed-repair: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  check(out.includes('job: {"score":0.92,"label":"approved"}'), "REPAIR OK: the workflow completed with the repaired value");
  check(out.includes("done"), "REPAIR OK: workflow completed");
  check(seen.length === 1, `REPAIR OK: the handler was consulted once (got ${seen.length})`);
  if (seen.length === 1) {
    check(seen[0].attempt === 0 && seen[0].phase === "output", "REPAIR OK: handler saw attempt 0, phase output");
    check(
      Array.isArray(seen[0].issues) && seen[0].issues.some((i: any) => i.path === "$.score"),
      "REPAIR OK: the precise error was attached to the retried trap",
    );
    check(
      JSON.stringify(seen[0].previousAnswer) === JSON.stringify({ score: "high", label: "approved" }),
      "REPAIR OK: the failed answer was attached too",
    );
  }
  const errors = host.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1 && errors[0].attempt === 0, "JOURNAL OK: one validation-error (attempt 0), then the trap-result");
  check(host.journal(runId).some((e) => e.event === "trap-result"), "JOURNAL OK: trap-result recorded after the repair");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedRepairExhausted(): void {
  console.log("\n=== typed trap, repair exhausted (throws after max attempts) ===");
  const runId = "run-typed-repair-exhausted";
  const host = new Host({ stateDir: WORKDIR, maxRepairAttempts: 2 });
  host.queueAnswer("job", { score: "high", label: "approved" });
  let calls = 0;
  host.setRepairHandler("job", () => {
    calls++;
    return { value: { score: "high", label: "approved" } };
  });
  let rc = host.startRun(path.join(TESTS, "workflow-typed-repair-exhausted.ts"), runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`typed-repair-exhausted: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  check(out.includes("caught: ValidationError:"), "THROW OK: ValidationError at the call site after exhaustion");
  check(calls === 2, `REPAIR OK: the handler was consulted exactly maxRepairAttempts times (got ${calls})`);
  const errors = host.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 3, `JOURNAL OK: 3 validation-error events (attempts 0, 1, 2; got ${errors.length})`);
  if (errors.length === 3) {
    check(JSON.stringify(errors.map((e) => e.attempt)) === "[0,1,2]", "JOURNAL OK: attempts 0, 1, 2 in order");
  }
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testJsonCleanDate(): void {
  console.log("\n=== JSON-clean ordering (Date converts first, then schema validates) ===");
  const runId = "run-json-clean-date";
  const host = new Host({ stateDir: WORKDIR });
  host.queueAnswer("job", { score: "high", label: "approved" });
  host.setRepairHandler("job", () => ({
    value: { score: 0.92, label: "approved", at: new Date("2027-04-09T12:00:00.000Z") },
  }));
  let rc = host.startRun(path.join(TESTS, "workflow-json-clean-date.ts"), runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`json-clean-date: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  check(
    out.includes('"at":"2027-04-09T12:00:00.000Z"'),
    `ORDER OK: the Date crossed as an ISO string (got: ${out.split("\n").find((l) => l.startsWith("job:")) ?? ""})`,
  );
  const errors = host.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1 && errors[0].phase === "output", "JOURNAL OK: only the first (schema) failure is recorded — the repaired Date converted cleanly, no json-clean error");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testJsonCleanReject(): void {
  console.log("\n=== JSON-clean rejections (precise errors, phase json-clean) ===");
  const runId = "run-json-clean-reject";
  const host = new Host({ stateDir: WORKDIR });
  host.queueAnswer("job", { score: undefined, label: "approved" });
  host.queueAnswer("job", { score: NaN, label: "approved" });
  const circ: any = { score: 0.5, label: "approved" };
  circ.self = circ;
  host.queueAnswer("job", circ);
  host.queueAnswer("job", new Map([["score", 0.5]]));
  class Foo {
    score = 0.5;
    label = "approved";
  }
  host.queueAnswer("job", new Foo());
  let rc = host.startRun(path.join(TESTS, "workflow-json-clean-reject.ts"), runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`json-clean-reject: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  const wants: [string, string][] = [
    ["caught 1:", "$.score: undefined"],
    ["caught 2:", "$.score is NaN"],
    ["caught 3:", "circular reference"],
    ["caught 4:", "$ is a Map"],
    ["caught 5:", "is an instance of Foo"],
  ];
  for (const [prefix, fragment] of wants) {
    const line = out.split("\n").find((l) => l.startsWith(prefix)) ?? "";
    check(line.includes("ValidationError:") && line.includes(fragment), `REJECT OK: ${prefix} ${fragment} (got: ${line})`);
  }
  const errors = host.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 5, `JOURNAL OK: 5 validation-error events (got ${errors.length})`);
  check(errors.every((e) => e.phase === "json-clean" && e.attempt === 0), "JOURNAL OK: all phase json-clean, attempt 0 — the check runs BEFORE schema validation");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testLoudFailures(): void {
  console.log("\n=== loud failures at first run (no extractable type) ===");
  const cases: [string, string][] = [
    ["workflow-no-type.ts", "exactly two"],
    ["workflow-unknown-type.ts", "not a concrete, named type"],
    ["workflow-fn-type.ts", "cannot be validated"],
  ];
  for (const [file, fragment] of cases) {
    const host = new Host({ stateDir: WORKDIR });
    let threw: any = null;
    try {
      host.startRun(path.join(TESTS, file), "run-loud-" + file.replace(".ts", ""));
    } catch (e) {
      threw = e;
    }
    check(threw instanceof ExtractionError, `LOUD OK: ${file} threw ExtractionError (got ${threw?.constructor?.name ?? "no throw"})`);
    if (threw) {
      check(String(threw.message).includes(fragment), `LOUD OK: ${file} names the problem ('${fragment}')`);
      check(!String(threw.message).includes("silently"), `LOUD OK: ${file} fails, never silently skips`);
    }
    check(host.registrySize() === 0, `LOUD OK: ${file} spawned nothing`);
  }
}

function testExtractionCache(): void {
  console.log("\n=== extraction cache (keyed by content hash, pinned with the frozen copy) ===");
  const cacheDir = path.join(WORKDIR, "cache");
  const before = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length : 0;
  const copyPath = path.join(WORKDIR, "workflow-cache-copy.ts");
  const copySrc = fs
    .readFileSync(path.join(TESTS, "workflow-clock.ts"), "utf8")
    .replace("after sleep 1:", "after sleep 1 (copy):");
  fs.writeFileSync(copyPath, copySrc);
  const p1 = new Host({ stateDir: WORKDIR });
  let rc = p1.startRun(copyPath, "run-cache-a");
  rc = p1.drive("run-cache-a");
  check(rc === 0, "CACHE OK: first run of the copy completed");
  const afterFirst = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length;
  check(afterFirst === before + 1, `CACHE OK: one cache entry appeared (was ${before}, now ${afterFirst})`);
  const entries = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  const newest = entries.map((f) => path.join(cacheDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const mtime1 = fs.statSync(newest).mtimeMs;
  const p2 = new Host({ stateDir: WORKDIR });
  rc = p2.startRun(copyPath, "run-cache-b");
  rc = p2.drive("run-cache-b");
  check(rc === 0, "CACHE OK: second run completed");
  check(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length === afterFirst, "CACHE OK: second run added no entry — cache hit");
  check(fs.statSync(newest).mtimeMs === mtime1, "CACHE OK: the entry file was not rewritten — cache hit");
  check(p1.output("run-cache-a") === p2.output("run-cache-b"), "CACHE OK: both runs produced identical output");
  fs.appendFileSync(copyPath, "\n// comment change: content hash must change\n");
  const p3 = new Host({ stateDir: WORKDIR });
  rc = p3.startRun(copyPath, "run-cache-c");
  rc = p3.drive("run-cache-c");
  check(rc === 0, "CACHE OK: mutated copy completed");
  check(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length === afterFirst + 1, "CACHE OK: changed source produced a new cache entry (re-extraction)");
  check(p3.output("run-cache-c") === p1.output("run-cache-a"), "CACHE OK: mutated copy (comment only) produced identical output");
}

async function testGateAgentLoop(): Promise<void> {
  console.log("\n=== first-run gate: agent loop (submit, structured diagnostics, fix, resubmit) ===");
  const agentPath = path.join(WORKDIR, "workflow-gate-agent.ts");
  const moduleImport = path.join(ROOT, "src", "agentts");
  const brokenSrc = [
    `import { job } from ${JSON.stringify(moduleImport)};`,
    `declare function print(...args: unknown[]): void;`,
    `interface ScoreInput { value: number; }`,
    `interface ScoreResult { score: number; label: string; }`,
    `const j = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: "seven" } });`,
    `print("job:", JSON.stringify(j));`,
    `print("done");`,
    "",
  ].join("\n");
  fs.writeFileSync(agentPath, brokenSrc);
  const host = new Host({ stateDir: WORKDIR });
  let threw: any = null;
  try {
    host.prepareRun(agentPath, "run-gate-agent");
  } catch (e) {
    threw = e;
  }
  check(threw instanceof GateError, `GATE OK: broken workflow refused with GateError (got ${threw?.constructor?.name ?? "no throw"})`);
  if (threw instanceof GateError) {
    check(
      Array.isArray(threw.diagnostics) && threw.diagnostics.length >= 1,
      "GATE OK: structured diagnostics returned (not raw log text, not a bare stop)",
    );
    const d = threw.diagnostics[0];
    check(
      typeof d.file === "string" &&
        typeof d.line === "number" &&
        typeof d.column === "number" &&
        typeof d.code === "number" &&
        typeof d.message === "string",
      `GATE OK: diagnostic is a record {file, line, column, code, message} (got ${JSON.stringify(d)})`,
    );
    check(d.code === 2322, `GATE OK: code is TS2322 (got ${d.code})`);
    check(d.file === agentPath, `GATE OK: diagnostic names the submitted file`);
    check(d.message.includes("not assignable"), `GATE OK: message states the mismatch (got: ${d.message})`);
    check(
      d.expected === "number" && d.actual === "string",
      `GATE OK: expected vs actual parsed out (expected ${d.expected}, actual ${d.actual})`,
    );
  }
  check(host.registrySize() === 0, "GATE OK: the run never started — registry empty");
  check(!fs.existsSync(path.join(SLICES, prefixFor("run-gate-agent") + ".snap")), "GATE OK: no snapshot was written");
  check(!fs.existsSync(path.join(SLICES, prefixFor("run-gate-agent") + ".out")), "GATE OK: no output was written");
  check(host.gateRuns === 1, `GATE OK: the gate ran once for the broken version (gateRuns ${host.gateRuns})`);
  fs.writeFileSync(agentPath, brokenSrc.replace('"seven"', "7"));
  const { entryPath } = host.prepareRun(agentPath, "run-gate-agent");
  let bundleOut: string;
  try {
    bundleOut = await host.bundle(entryPath, "bundle-gate-agent.js");
  } catch (e) {
    fail(`gate-agent: bundle failed: ${(e as Error).message}`);
    return;
  }
  let rc = host.startRunFrom(bundleOut, "run-gate-agent");
  rc = host.drive("run-gate-agent");
  check(rc === 0, "GATE OK: the fixed workflow passes the gate and runs");
  check(
    host.output("run-gate-agent").includes('job: {"score":0.92,"label":"approved"}'),
    "GATE OK: the fixed workflow completed with the canned result",
  );
  check(host.gateRuns === 2, `GATE OK: the fix changed the hash, so the new version was re-gated (gateRuns ${host.gateRuns})`);
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testGateCache(): void {
  console.log("\n=== first-run gate: second run of the same version skips the gate from cache ===");
  const copyPath = path.join(WORKDIR, "workflow-gate-cache.ts");
  fs.writeFileSync(
    copyPath,
    fs.readFileSync(path.join(TESTS, "workflow-clock.ts"), "utf8").replace("after sleep 1:", "after sleep 1 (gate):"),
  );
  const p1 = new Host({ stateDir: WORKDIR });
  let rc = p1.startRun(copyPath, "run-gate-cache-a");
  rc = p1.drive("run-gate-cache-a");
  check(rc === 0, "GATE OK: first run completed");
  check(p1.gateRuns === 1, `GATE OK: the gate ran once for the first run (gateRuns ${p1.gateRuns})`);
  const p2 = new Host({ stateDir: WORKDIR });
  rc = p2.startRun(copyPath, "run-gate-cache-b");
  rc = p2.drive("run-gate-cache-b");
  check(rc === 0, "GATE OK: second run completed");
  check(p2.gateRuns === 0, `GATE OK: the second run skipped the gate from cache (gateRuns ${p2.gateRuns})`);
  check(p1.output("run-gate-cache-a") === p2.output("run-gate-cache-b"), "GATE OK: both runs produced identical output");
}

function testGateRegate(): void {
  console.log("\n=== first-run gate: a source-hash change re-gates ===");
  const copyPath = path.join(WORKDIR, "workflow-gate-regate.ts");
  const base = fs
    .readFileSync(path.join(TESTS, "workflow-clock.ts"), "utf8")
    .replace("after sleep 1:", "after sleep 1 (regate):");
  fs.writeFileSync(copyPath, base);
  const host = new Host({ stateDir: WORKDIR });
  let rc = host.startRun(copyPath, "run-gate-regate-a");
  rc = host.drive("run-gate-regate-a");
  check(rc === 0, "GATE OK: first version completed");
  check(host.gateRuns === 1, `GATE OK: gate ran for the first version (gateRuns ${host.gateRuns})`);
  fs.appendFileSync(copyPath, "\n// comment change: content hash must change\n");
  rc = host.startRun(copyPath, "run-gate-regate-b");
  rc = host.drive("run-gate-regate-b");
  check(rc === 0, "GATE OK: comment-only version completed");
  check(host.gateRuns === 2, `GATE OK: the changed version was re-gated (gateRuns ${host.gateRuns})`);
  check(
    host.output("run-gate-regate-b") === host.output("run-gate-regate-a"),
    "GATE OK: comment-only change produced identical output",
  );
  fs.writeFileSync(copyPath, base + "\nconst wrongType: number = s1.sleptMs.toString();\n");
  let threw: any = null;
  try {
    host.startRun(copyPath, "run-gate-regate-c");
  } catch (e) {
    threw = e;
  }
  check(
    threw instanceof GateError,
    `GATE OK: the mistyped version was refused at the gate (got ${threw?.constructor?.name ?? "no throw"})`,
  );
  if (threw instanceof GateError) {
    check(
      threw.diagnostics.some((d) => d.code === 2322),
      `GATE OK: the refusal names TS2322 (got ${threw.diagnostics.map((d) => d.code).join(",")})`,
    );
  }
  check(host.gateRuns === 3, `GATE OK: the mistyped version was gated too (gateRuns ${host.gateRuns})`);
}

// ------------------------------------------------------------------ M2 checker (BRA-29)
async function testCheckerGateLoop(): Promise<void> {
  console.log("\n=== M2 checker: agent loop (submit, structured diagnostics, fix, resubmit) ===");
  // Same shape as the gate agent loop, but the fault is one tsc
  // cannot see: the trap output is typed as a CLASS. The gate's
  // tsc half passes; the checker's M2-CLASS rule refuses it — and
  // the refusal carries the same structured diagnostics (file,
  // line, column, rule, message, fix) so the agent can fix and
  // resubmit.
  const agentPath = path.join(WORKDIR, "workflow-checker-agent.ts");
  const moduleImport = path.join(ROOT, "src", "agentts");
  const brokenSrc = [
    `import { job } from ${JSON.stringify(moduleImport)};`,
    `declare function print(...args: unknown[]): void;`,
    `interface ScoreInput { value: number; }`,
    `class ScoreResult { score = 0; label = ""; }`,
    // Spec "checker-score", not "score": the cache is
    // content-addressed, and the gate agent loop's fixed workflow
    // (spec "score", same shape) already wrote an entry for its
    // hash — reusing it would skip the re-check this test counts.
    `const j = job<ScoreInput, ScoreResult>({ spec: "checker-score", input: { value: 7 } });`,
    `print("job:", JSON.stringify(j));`,
    `print("done");`,
    "",
  ].join("\n");
  fs.writeFileSync(agentPath, brokenSrc);
  const host = new Host({ stateDir: WORKDIR });
  let threw: any = null;
  try {
    host.prepareRun(agentPath, "run-checker-agent");
  } catch (e) {
    threw = e;
  }
  check(threw instanceof CheckerError, `CHECKER OK: class-contract workflow refused with CheckerError (got ${threw?.constructor?.name ?? "no throw"})`);
  if (threw instanceof CheckerError) {
    check(
      threw.diagnostics.some((d) => d.code === "M2-CLASS"),
      `CHECKER OK: the refusal names rule M2-CLASS (got ${threw.diagnostics.map((d) => d.code).join(",")})`,
    );
    const d = threw.diagnostics.find((x) => x.code === "M2-CLASS")!;
    check(d.file === agentPath, `CHECKER OK: diagnostic names the submitted file`);
    check(typeof d.fix === "string" && d.fix.includes("interface"), `CHECKER OK: diagnostic carries a fix hint (got: ${d.fix})`);
    check(d.message.includes("class"), `CHECKER OK: message states the class problem`);
  }
  check(host.registrySize() === 0, "CHECKER OK: the run never started — registry empty");
  check(!fs.existsSync(path.join(SLICES, prefixFor("run-checker-agent") + ".snap")), "CHECKER OK: no snapshot was written");
  check(host.checkerRuns === 1, `CHECKER OK: the checker ran once for the broken version (checkerRuns ${host.checkerRuns})`);
  // Fix: the agent replaces the class with a plain interface and
  // resubmits. Same run path as the gate loop: prepareRun
  // (re-gate + re-check) + bundle + startRunFrom + drive.
  fs.writeFileSync(
    agentPath,
    brokenSrc.replace("class ScoreResult { score = 0; label = \"\"; }", "interface ScoreResult { score: number; label: string; }"),
  );
  const { entryPath } = host.prepareRun(agentPath, "run-checker-agent");
  let bundleOut: string;
  try {
    bundleOut = await host.bundle(entryPath, "bundle-checker-agent.js");
  } catch (e) {
    fail(`checker-agent: bundle failed: ${(e as Error).message}`);
    return;
  }
  // The renamed spec has no entry in the mock adapter's canned
  // table (keyed `spec:value`), so queue the expected answer for
  // the run's one job trap.
  host.queueAnswer("job", { score: 0.92, label: "approved" });
  let rc = host.startRunFrom(bundleOut, "run-checker-agent");
  rc = host.drive("run-checker-agent");
  check(rc === 0, "CHECKER OK: the fixed workflow passes the gate + checker and runs");
  check(
    host.output("run-checker-agent").includes('job: {"score":0.92,"label":"approved"}'),
    "CHECKER OK: the fixed workflow completed with the canned result",
  );
  check(host.checkerRuns === 2, `CHECKER OK: the fix changed the hash, so the new version was re-checked (checkerRuns ${host.checkerRuns})`);
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testCheckerCli(): void {
  console.log("\n=== M2 checker: `agentts check` CLI (write/check/fix without running) ===");
  const cli = path.join(ROOT, "src", "cli.ts");
  const cliState = path.join(WORKDIR, "cli-check-state");
  const badPath = path.join(TESTS, "workflow-checker-wiring-any.ts");
  const goodPath = path.join(TESTS, "workflow-checker-wiring-pass.ts");
  const run = (args: string[]) =>
    spawnSync(BUN, ["run", cli, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
  // Bad workflow: exit 1, structured text diagnostics naming the rule.
  const r1 = run(["check", badPath, "--state-dir", cliState]);
  check(r1.status === 1, `CLI CHECK OK: bad workflow exits 1 (got ${r1.status}): ${(r1.stdout + r1.stderr).slice(0, 200)}`);
  check((r1.stdout + r1.stderr).includes("M2-WIRING"), `CLI CHECK OK: text output names rule M2-WIRING`);
  check((r1.stdout + r1.stderr).includes("job:score"), `CLI CHECK OK: text output names the producer site job:score`);
  // --json: machine-readable diagnostics for the write/check/fix loop.
  const r2 = run(["check", badPath, "--state-dir", cliState, "--json"]);
  let parsed: any = null;
  try {
    parsed = JSON.parse(r2.stdout);
  } catch {
    /* parsed stays null */
  }
  check(
    r2.status === 1 && parsed !== null && parsed.ok === false && Array.isArray(parsed.diagnostics) && parsed.diagnostics.some((d: any) => d.code === "M2-WIRING"),
    `CLI CHECK OK: --json returns parseable diagnostics with rule M2-WIRING (got status ${r2.status}, ${r2.stdout.slice(0, 160)})`,
  );
  // Good workflow: exit 0.
  const r3 = run(["check", goodPath, "--state-dir", cliState]);
  check(r3.status === 0, `CLI CHECK OK: good workflow exits 0 (got ${r3.status}): ${(r3.stdout + r3.stderr).slice(0, 200)}`);
  check(r3.stdout.includes("CHECK OK"), `CLI CHECK OK: good workflow prints CHECK OK`);
  // Layering over the host tree: exit 0.
  const r4 = run(["check", "--layering", path.join(ROOT, "src"), path.join(ROOT, "plugins"), "--state-dir", cliState]);
  check(r4.status === 0, `CLI CHECK OK: --layering over src/ + plugins/ exits 0 (got ${r4.status}): ${(r4.stdout + r4.stderr).slice(0, 200)}`);
  check(r4.stdout.includes("LAYERING OK"), `CLI CHECK OK: --layering prints LAYERING OK`);
}

function testResumeNoReextract(): void {
  console.log("\n=== first-run pipeline: a resumed run never re-extracts ===");
  const runId = "run-resume-no-reextract";
  const host = new Host({ stateDir: WORKDIR });
  const cacheDir = path.join(WORKDIR, "cache");
  let rc = host.startRun(path.join(TESTS, "workflow-clock.ts"), runId);
  check(rc === 2, `RESUME OK: run suspended at the first trap (rc ${rc})`);
  const gatesAfterStart = host.gateRuns;
  const entriesAfterStart = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length;
  rc = host.drive(runId);
  check(rc === 0, "RESUME OK: drive completed the run");
  check(host.gateRuns === gatesAfterStart, `RESUME OK: the resume ran no gate (gateRuns ${host.gateRuns})`);
  check(
    fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length === entriesAfterStart,
    "RESUME OK: the resume added no cache entry — never re-extracted",
  );
  check(host.output(runId).includes("done"), "RESUME OK: workflow completed");
}

// ---------------------------------------------------------- host-only tests
function testDiskJournal(): void {
  console.log("\n=== disk journal + disk blob store (the source of truth is a file) ===");
  const runId = "run-trap-types";
  const journalFile = path.join(WORKDIR, "journals", "run-trap-types.journal");
  check(fs.existsSync(journalFile), `DISK JOURNAL OK: ${journalFile} exists`);
  if (!fs.existsSync(journalFile)) return;
  const lines = fs.readFileSync(journalFile, "utf8").split("\n").filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  const kinds = new Set(events.map((e) => e.event));
  for (const want of ["lifecycle", "trap", "trap-result"]) {
    check(kinds.has(want), `DISK JOURNAL OK: contains ${want} events`);
  }
  check(
    events.every((e) => typeof e.runId === "string"),
    "DISK JOURNAL OK: every line is one JSON event with a runId",
  );
  // BRA-57 (journal format v2): every event carries a wall-clock
  // timestamp, and every trap-result carries the adapter that
  // answered plus the host-measured dispatch wall time. Canned
  // answers carry no worker identity (the adapter name is the
  // identity); pool jobs would carry a worker id here.
  const badTs = events.filter((e) => typeof e.wallTs !== "string" || !Number.isFinite(Date.parse(e.wallTs)));
  check(badTs.length === 0, `DISK JOURNAL OK: every event carries a parseable wallTs (${events.length} events, ${badTs.length} bad)`);
  const results = events.filter((e) => e.event === "trap-result" || e.event === "trap-error");
  check(results.length > 0, `DISK JOURNAL OK: ${results.length} trap-result event(s) to check`);
  check(
    results.every((e) => e.adapter === "mock"),
    "DISK JOURNAL OK: every trap-result names the mock adapter",
  );
  check(
    results.every((e) => typeof e.wallMs === "number" && e.wallMs >= 0),
    "DISK JOURNAL OK: every trap-result carries wallMs >= 0",
  );
  check(
    results.every((e) => e.worker === undefined),
    "DISK JOURNAL OK: canned answers carry no worker identity",
  );
  const blobFile = path.join(WORKDIR, "blobs", "run-trap-types.snap");
  check(fs.existsSync(blobFile), `DISK BLOB OK: ${blobFile} exists`);
  check(
    fs.statSync(blobFile).size > 0,
    `DISK BLOB OK: stored blob is non-empty (${fs.existsSync(blobFile) ? fs.statSync(blobFile).size : 0} bytes)`,
  );
  // The in-memory journal and the disk journal agree (read back).
  const host = new Host({ stateDir: WORKDIR });
  check(
    JSON.stringify(host.journal(runId)) === JSON.stringify(events),
    "DISK JOURNAL OK: a fresh Host over the same stateDir reads the same journal back",
  );
}

function testCompilerRefusal(): void {
  console.log("\n=== host refuses to start a workflow when the compiler is unavailable ===");
  process.env.AGENTTS_NO_COMPILER = "1";
  const host = new Host({ stateDir: WORKDIR });
  let threw: any = null;
  try {
    host.prepareRun(path.join(TESTS, "workflow-clock.ts"), "run-no-compiler");
  } catch (e) {
    threw = e;
  } finally {
    delete process.env.AGENTTS_NO_COMPILER;
  }
  check(threw instanceof HostRefusalError, `REFUSAL OK: prepareRun threw HostRefusalError (got ${threw?.constructor?.name ?? "no throw"})`);
  if (threw) {
    check(
      String(threw.message).includes("refusing to start") && String(threw.message).includes("gate"),
      `REFUSAL OK: the error names the gate as the reason (got: ${threw.message.slice(0, 160)})`,
    );
  }
  check(host.registrySize() === 0, "REFUSAL OK: the run never started — registry empty");
  check(!fs.existsSync(path.join(SLICES, "run-no-compiler.snap")), "REFUSAL OK: no snapshot was written");
  // And the host works again once the compiler is back.
  const host2 = new Host({ stateDir: WORKDIR });
  const rc = host2.startRun(path.join(TESTS, "workflow-clock.ts"), "run-compiler-back");
  check(rc === 2, "REFUSAL OK: with the compiler available the same workflow starts (rc 2, suspended at first trap)");
  check(host2.drive("run-compiler-back") === 0, "REFUSAL OK: it completes");
}

function testQueue(): void {
  console.log("\n=== run queue (plugin-internal dispatch queue) ===");
  const qState = path.join(WORKDIR, "queue-state");
  const host = new Host({ stateDir: qState });
  const a = host.enqueue(path.join(TESTS, "workflow-clock.ts"), "run-queue-a", { taskId: "BRA-44" });
  const b = host.enqueue(path.join(TESTS, "workflow-clock.ts"), "run-queue-b");
  check(a.status === "queued" && b.status === "queued", "QUEUE OK: two runs enqueued");
  check(fs.existsSync(path.join(qState, "queue.json")), "QUEUE OK: queue.json persisted");
  const done = host.runQueue();
  check(done.length === 2, `QUEUE OK: runQueue drove both entries (got ${done.length})`);
  check(done[0].status === "done" && done[1].status === "done", `QUEUE OK: both done (got ${done.map((e) => e.status).join(",")})`);
  check(done[0].runId === "run-queue-a" && done[1].runId === "run-queue-b", "QUEUE OK: FIFO order kept");
  check(host.output("run-queue-a").includes("done") && host.output("run-queue-b").includes("done"), "QUEUE OK: both runs completed with output");
  let threw: any = null;
  try {
    host.enqueue(path.join(TESTS, "workflow-clock.ts"), "run-queue-a");
    host.runQueue();
  } catch (e) {
    threw = e;
  }
  // Re-enqueueing a DONE run is allowed (it is no longer queued/running/held).
  check(threw === null, "QUEUE OK: re-enqueueing a finished run is allowed");
}

async function testTaskBackendLocal(): Promise<void> {
  console.log("\n=== task backend (v0 minimal): link + status mirror ===");
  const tbState = path.join(WORKDIR, "task-state");
  const backend = new LocalTaskBackend(tbState, [{ id: "BRA-44", title: "AgentTS host executable", status: "In Progress" }]);
  const tasks = await backend.listTasks();
  check(tasks.some((t) => t.id === "BRA-44"), "TASK OK: listTasks returns the seeded task");
  const task = await backend.getTask("BRA-44");
  check(task !== null && task.title === "AgentTS host executable", "TASK OK: getTask returns the task");
  await backend.setTaskRun("BRA-44", "run-trap-types");
  const host = new Host({ stateDir: WORKDIR });
  const status = await syncRunToTask(backend, "BRA-44", "run-trap-types", host.journal("run-trap-types"));
  check(status === "done", `TASK OK: sync derived 'done' from the journal (got ${status})`);
  const links = backend.linksFor("BRA-44");
  check(links.length >= 1 && links[0].runId === "run-trap-types", "TASK OK: task->runId link recorded");
  check(links.some((l) => l.status === "done"), "TASK OK: mirrored status recorded");
  check(fs.existsSync(path.join(tbState, "task-runs.json")), "TASK OK: local mirror file written");
  const missing = await backend.getTask("BRA-999");
  check(missing === null, "TASK OK: unknown task returns null");
}

function testCrossProcessGate(): void {
  console.log("\n=== cross-process gate (CLI twice: run holds, deliver-gate resumes) ===");
  const cliState = path.join(WORKDIR, "cli-state");
  const cli = path.join(ROOT, "src", "cli.ts");
  const wf = path.join(TESTS, "workflow-gate-hold.ts");
  // First process: direct adapter holds every gate.
  const r1 = spawnSync(BUN, ["run", cli, "run", wf, "--adapter", "direct", "--state-dir", cliState, "--run-id", "run-cli-gate"], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  });
  check(r1.status === 2, `CLI RUN OK: first process exited 2 (gate pending, got ${r1.status}): ${(r1.stdout + r1.stderr).slice(0, 300)}`);
  check((r1.stdout + r1.stderr).includes("GATE PENDING run-cli-gate"), "CLI RUN OK: it printed GATE PENDING");
  // The held run survives on disk: blob + journal + run entry.
  check(fs.existsSync(path.join(cliState, "blobs", "run-cli-gate.snap")), "CLI RUN OK: blob persisted to disk");
  check(fs.existsSync(path.join(cliState, "journals", "run-cli-gate.journal")), "CLI RUN OK: journal persisted to disk");
  check(fs.existsSync(path.join(cliState, "runs", "run-cli-gate.json")), "CLI RUN OK: run entry persisted to disk");
  // Second process: deliver the answer; the run must resume from the
  // stored blob + the cached extraction (no re-gate).
  const r2 = spawnSync(BUN, ["run", cli, "deliver-gate", "run-cli-gate", '{"answer":"no"}', "--state-dir", cliState], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env },
  });
  check(r2.status === 0, `CLI DELIVER OK: second process exited 0 (got ${r2.status}): ${(r2.stdout + r2.stderr).slice(0, 300)}`);
  check((r2.stdout + r2.stderr).includes('answer: {"answer":"no"}'), "CLI DELIVER OK: the workflow received the delivered answer");
  check((r2.stdout + r2.stderr).includes("DONE run-cli-gate"), "CLI DELIVER OK: the run completed");
  // The journal on disk now shows the whole story: gate-held, then
  // trap-result, then completed.
  const events = fs
    .readFileSync(path.join(cliState, "journals", "run-cli-gate.journal"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  check(events.some((e) => e.event === "gate-held"), "CLI JOURNAL OK: gate-held recorded");
  check(events.some((e) => e.event === "trap-result"), "CLI JOURNAL OK: trap-result recorded after delivery");
  check(events.some((e) => e.event === "lifecycle" && e.lifecycle === "completed"), "CLI JOURNAL OK: completed recorded");
  // status subcommand reads the same journal.
  const r3 = spawnSync(BUN, ["run", cli, "status", "run-cli-gate", "--state-dir", cliState], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env },
  });
  check(r3.status === 0 && r3.stdout.includes("status: done"), `CLI STATUS OK: status reads done from the journal (got: ${r3.stdout.slice(0, 200)})`);
}

async function testRealClock(): Promise<void> {
  console.log("\n=== real clock (direct adapter, clock: real — actually waits) ===");
  const runId = "run-host-real-clock";
  const host = new Host({ stateDir: WORKDIR, adapter: new DirectAdapter(), clock: "real" });
  const wallStart = Date.now();
  const { entryPath } = host.prepareRun(path.join(TESTS, "workflow-host-real-clock.ts"), runId);
  const bundle = await host.bundle(entryPath, "bundle-host-real-clock.js");
  let rc = host.startRunFrom(bundle, runId);
  if (rc !== 2) {
    fail(`real-clock: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = host.drive(runId);
  const wallMs = Date.now() - wallStart;
  if (rc !== 0) {
    fail(`real-clock: run exited ${rc}`);
    return;
  }
  check(wallMs >= 2000, `REAL TIME OK: the run actually waited ${wallMs}ms wall time (>= 2000ms for the 100ms sleep + 2s cron)`);
  check(wallMs < 30000, `REAL TIME OK: the run did not hang (${wallMs}ms)`);
  const lines = parseOutLines(outPathFor(runId));
  const start = Date.parse(lines["start"]);
  const afterSleep = Date.parse(lines["after sleep"]);
  const afterCron = Date.parse(lines["after cron"]);
  check(afterSleep - start >= 100, `REAL SLEEP OK: clock advanced >=100ms across the sleep (got ${afterSleep - start}ms)`);
  check(afterCron - afterSleep >= 1900, `REAL CRON OK: clock advanced >=1900ms to the cron target (got ${afterCron - afterSleep}ms)`);
  check(host.output(runId).includes("done"), "REAL CLOCK OK: workflow completed");
  const advances = host.journal(runId).filter((e) => e.event === "clock-advance");
  check(advances.length >= 2, `JOURNAL OK: ${advances.length} clock-advance events recorded`);
}

async function testRealExec(): Promise<void> {
  console.log("\n=== real exec + local decide (direct adapter) ===");
  const runId = "run-host-real-exec";
  const host = new Host({ stateDir: WORKDIR, adapter: new DirectAdapter() });
  const { entryPath } = host.prepareRun(path.join(TESTS, "workflow-host-real-exec.ts"), runId);
  const bundle = await host.bundle(entryPath, "bundle-host-real-exec.js");
  let rc = host.startRunFrom(bundle, runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`real-exec: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  check(out.includes('exec: {"stdout":"hi\\n","stderr":"","exitCode":0}'), `REAL EXEC OK: the command really ran (got: ${out.split("\n").find((l) => l.startsWith("exec:")) ?? ""})`);
  check(out.includes('sleep: {"sleptMs":50}'), "REAL EXEC OK: virtual sleep answered");
  check(out.includes('decide: {"choice":"converged","confidence":'), `LOCAL DECIDE OK: the local model read mean 0.9 >= threshold 0.8 and chose converged (got: ${out.split("\n").find((l) => l.startsWith("decide:")) ?? ""})`);
  check(out.includes("done"), "REAL EXEC OK: workflow completed");
}

async function testJudgeFixLoopMock(): Promise<void> {
  console.log("\n=== JudgeFixLoop end to end (mock judges + local decide model) ===");
  const runId = "run-jfl-mock";
  const host = new Host({ stateDir: WORKDIR });
  // Mock judges are canned; decide traps use the LOCAL decision model
  // (the mock adapter's canned decide {choice:"a"} cannot answer
  // revise/keep/converged questions — see README).
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  const { entryPath } = host.prepareRun(path.join(TESTS, "workflow-judge-fix-loop.ts"), runId);
  const bundle = await host.bundle(entryPath, "bundle-jfl-mock.js");
  let rc = host.startRunFrom(bundle, runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`jfl-mock: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  console.log(out);
  check(out.includes("loop 1: 0 approved, 0 failed, mean 0.55"), "JFL MOCK OK: loop 1 aggregate is 0.55 (mock judges)");
  check(out.includes("loop 3: rubric updated"), "JFL MOCK OK: the rubric was updated at loop 3 (3 missed criteria)");
  check(out.includes("loop 5: converged"), "JFL MOCK OK: converged at loop 5 — 2 loops after the rubric change");
  const resultLine = out.split("\n").find((l) => l.startsWith("result:"));
  const result = resultLine ? JSON.parse(resultLine.slice("result: ".length)) : null;
  check(result !== null && result.converged === true, "JFL MOCK OK: result.converged is true");
  check(result !== null && result.loops === 5, `JFL MOCK OK: result.loops is 5 (got ${result?.loops})`);
  check(
    result !== null && Array.isArray(result.rubric?.criteria) && result.rubric.criteria.includes("concrete example"),
    "JFL MOCK OK: the updated rubric carries the new 'concrete example' criterion",
  );
  check(
    result !== null && typeof result.item?.text === "string" && (result.item.text.match(/\(revised/g) ?? []).length === 2,
    "JFL MOCK OK: the item was revised twice",
  );
  const events = host.journal(runId);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  check(forks.length === 5, `JFL JOURNAL OK: 5 forks (one all() per loop, got ${forks.length})`);
  check(joins.length === 5, `JFL JOURNAL OK: 5 joins (got ${joins.length})`);
  const decides = events.filter((e) => e.event === "trap" && e.type === "decide");
  check(decides.length === 11, `JFL JOURNAL OK: 11 decide traps (revise+converge per loop, +rubric at loop 3; got ${decides.length})`);
  const decideResults = events.filter((e) => e.event === "trap-result" && decides.some((d) => d.trapId === e.trapId));
  check(decideResults.length === 11, `JFL JOURNAL OK: 11 decide trap-results (got ${decideResults.length})`);
  check(host.gateRuns === 1, `JFL GATE OK: the gate ran once for the library workflow (gateRuns ${host.gateRuns})`);
  // Second run of the same version skips the gate from cache (the
  // library file is part of the cache key via depHash).
  const host2 = new Host({ stateDir: WORKDIR });
  host2.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  const prep2 = host2.prepareRun(path.join(TESTS, "workflow-judge-fix-loop.ts"), "run-jfl-mock-2");
  const bundle2 = await host2.bundle(prep2.entryPath, "bundle-jfl-mock-2.js");
  let rc2 = host2.startRunFrom(bundle2, "run-jfl-mock-2");
  rc2 = host2.drive("run-jfl-mock-2");
  check(rc2 === 0, "JFL GATE OK: second run completed");
  check(host2.gateRuns === 0, `JFL GATE OK: the second run skipped the gate from cache (gateRuns ${host2.gateRuns})`);
  check(host2.output("run-jfl-mock-2") === out, "JFL GATE OK: second run produced identical output");
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

async function testJudgeFixLoopReal(): Promise<void> {
  console.log("\n=== JudgeFixLoop end to end (REAL worker processes + local decide model) ===");
  const runId = "run-jfl-real";
  const host = new Host({ stateDir: WORKDIR, adapter: new DirectAdapter() });
  const { entryPath } = host.prepareRun(path.join(TESTS, "workflow-judge-fix-loop.ts"), runId);
  const bundle = await host.bundle(entryPath, "bundle-jfl-real.js");
  let rc = host.startRunFrom(bundle, runId);
  rc = host.drive(runId);
  if (rc !== 0) {
    fail(`jfl-real: run exited ${rc}`);
    return;
  }
  const out = host.output(runId);
  console.log(out);
  check(out.includes("loop 1: 0 approved, 0 failed, mean 0.67"), "JFL REAL OK: loop 1 aggregate is 0.67 (real worker scores)");
  check(out.includes("loop 2: converged"), "JFL REAL OK: converged at loop 2 (the fix genuinely improved the text)");
  const resultLine = out.split("\n").find((l) => l.startsWith("result:"));
  const result = resultLine ? JSON.parse(resultLine.slice("result: ".length)) : null;
  check(result !== null && result.converged === true, "JFL REAL OK: result.converged is true");
  check(result !== null && result.loops === 2, `JFL REAL OK: result.loops is 2 (got ${result?.loops})`);
  check(
    result !== null && typeof result.item?.text === "string" && result.item.text.includes("russet coat flashed golden"),
    "JFL REAL OK: the revised text carries the fix worker's vivid sentence (a real transformation, not a canned literal)",
  );
  const events = host.journal(runId);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  check(forks.length === 2, `JFL JOURNAL OK: 2 forks (got ${forks.length})`);
  check(joins.length === 2, `JFL JOURNAL OK: 2 joins (got ${joins.length})`);
  // Job traps: the parent journal carries aggregate + fix + aggregate
  // (3); the judges run in branch runs, so their traps live in the
  // branch journals (2 forks x 3 branches = 6). 3 + 6 = 9.
  const parentJobs = events.filter((e) => e.event === "trap" && e.type === "job");
  let branchJobs = 0;
  for (let f = 0; f < 2; f++) {
    for (let b = 0; b < 3; b++) {
      branchJobs += host
        .journal(`${runId}/fork-${f}/branch-${b}`)
        .filter((e) => e.event === "trap" && e.type === "job").length;
    }
  }
  check(
    parentJobs.length + branchJobs === 9,
    `JFL JOURNAL OK: 9 job traps (parent ${parentJobs.length} + branches ${branchJobs}; got ${parentJobs.length + branchJobs})`,
  );
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testBunTypeOnly(): void {
  console.log("\n=== Bun: type-only workflow runs, value workflow refused (BRA-58) ===");
  // The value fixture is refused at prepareRun with CheckerError
  // M2-BUN (the gate's tsc half passes — the refusal is the
  // checker's, not a TS2867).
  const host = new Host({ stateDir: WORKDIR });
  let threw: any = null;
  try {
    host.prepareRun(path.join(TESTS, "workflow-bun-value.ts"), "run-bun-value");
  } catch (e) {
    threw = e;
  }
  check(threw instanceof CheckerError, `BUN OK: value workflow refused with CheckerError (got ${threw?.constructor?.name ?? "no throw"})`);
  if (threw instanceof CheckerError) {
    check(
      threw.diagnostics.some((d) => d.code === "M2-BUN"),
      `BUN OK: the refusal names rule M2-BUN (got ${threw.diagnostics.map((d) => d.code).join(",")})`,
    );
  }
  // The type-only fixture runs end to end: Bun appears only in
  // type positions, types erase, no Bun global is touched at
  // runtime — the run completes and prints the label.
  const runId = "run-bun-type";
  let rc = host.startRun(path.join(TESTS, "workflow-bun-type.ts"), runId);
  if (rc === 2) rc = host.drive(runId);
  check(rc === 0, `BUN OK: type-only workflow completes (rc ${rc})`);
  const out = host.output(runId);
  check(out.includes("label: notes.txt"), `BUN OK: type-only workflow printed the Bun-typed label (got ${JSON.stringify(out.slice(0, 200))})`);
  check(out.includes("done"), "BUN OK: type-only workflow reached done");
}

async function testLoadPlugin(): Promise<void> {
  console.log("\n=== plugin loading (mock plugin as the first plugin) ===");
  const Cls = await Host.loadPlugin("mock");
  check(typeof Cls === "function", `LOAD OK: Host.loadPlugin("mock") returned a class (got ${typeof Cls})`);
  const plugin = new Cls({ workdir: WORKDIR });
  const runId = "run-judges";
  const rc0 = plugin.startRun(path.join(TESTS, "workflow-judges.ts"), runId);
  check(rc0 === 3, `LOAD OK: the loaded mock plugin suspended at the combinator (rc ${rc0})`);
  const rc = plugin.drive(runId);
  check(rc === 0, `LOAD OK: the loaded mock plugin drove the run to completion (rc ${rc})`);
  const host = new Host({ stateDir: WORKDIR });
  check(
    plugin.output(runId) === host.output(runId),
    "LOAD OK: the loaded plugin's output matches the host's own run of the same workflow",
  );
  let threw: any = null;
  try {
    await Host.loadPlugin("no-such-plugin");
  } catch (e) {
    threw = e;
  }
  check(threw instanceof Error && String(threw.message).includes("not found"), `LOAD OK: an unknown plugin fails loudly (got: ${threw?.message?.slice(0, 100) ?? "no throw"})`);
  let threwAdapter: any = null;
  try {
    await Host.loadAdapter("no-such-adapter");
  } catch (e) {
    threwAdapter = e;
  }
  check(
    threwAdapter instanceof Error && String(threwAdapter.message).includes("unknown adapter"),
    `LOAD OK: an unknown adapter fails loudly (got: ${threwAdapter?.message?.slice(0, 100) ?? "no throw"})`,
  );
  // BRA-53: "mock" loads from the plugin dir (plugins/mock/src/
  // adapter.ts), not from a loadAdapter short-circuit — the
  // short-circuit is gone, so a green load here IS the proof the
  // plugin seam was taken. The loaded adapter must behave exactly
  // like the built-in (same canned table, same JFL judges).
  const mockAdapter = await Host.loadAdapter("mock");
  check(mockAdapter.name === "mock", `LOAD OK: loadAdapter("mock") returns the mock adapter (got ${mockAdapter.name})`);
  const ctx = { runId: "run-load-mock", trapId: "run-load-mock/trap-0", ordinal: 0 };
  const scoreAns = mockAdapter.answer("job", { spec: "score", input: { value: 7 } }, ctx) as any;
  check(
    scoreAns?.value?.score === 0.92 && scoreAns?.value?.label === "approved",
    `LOAD OK: plugin mock adapter answers score:7 from the canned table (got ${JSON.stringify(scoreAns?.value)})`,
  );
  const judgeAns = mockAdapter.answer(
    "job",
    { spec: "judge", input: { judge: 0, item: { text: "x", goal: "g" }, rubric: { criteria: [], threshold: 0.8 } } },
    ctx,
  ) as any;
  check(
    typeof judgeAns?.value?.score === "number" && judgeAns.value.score === 0.55,
    `LOAD OK: plugin mock adapter answers judge 0 at base 0.55 (got ${JSON.stringify(judgeAns?.value)})`,
  );
  // Two loads are independent instances (fresh queues): queueing an
  // answer on one must not leak into the other.
  const mockAdapter2 = await Host.loadAdapter("mock");
  check(mockAdapter !== mockAdapter2, "LOAD OK: two loadAdapter(\"mock\") calls return independent instances");
  if (typeof (mockAdapter as any).queueAnswer === "function") {
    (mockAdapter as any).queueAnswer("decide", { value: { choice: "b", confidence: 0.6 } });
    const queued = mockAdapter.answer("decide", { question: "q", options: ["a", "b"] }, ctx) as any;
    check(
      queued?.value?.choice === "b",
      `LOAD OK: plugin mock adapter takes queued answers (got ${JSON.stringify(queued?.value)})`,
    );
    const unqueued = mockAdapter2.answer("decide", { question: "q", options: ["a", "b"] }, ctx) as any;
    check(
      unqueued?.value?.choice === "a",
      `LOAD OK: queued answer did not leak to the second instance (got ${JSON.stringify(unqueued?.value)})`,
    );
  } else {
    check(false, "LOAD OK: plugin mock adapter exposes queueAnswer (canned adapter)");
  }
}

// ----------------------------------------------------------------------- main
async function main(): Promise<number> {
  fs.mkdirSync(WORKDIR, { recursive: true });
  console.log(`Host tests — workdir ${WORKDIR}`);

  await testJudges();
  await testGlobal();
  await testNested();
  await testFailfast();
  await testAny();
  await testRace();
  testRaceEmpty();
  testCancelStep();
  testCancelCombinator();
  testSticky();
  testRaceOrder();
  testNestedCancel();
  testTrapTypes();
  await testAgenttsBundle();
  await testAgenttsCombinators();
  await testJsonBoundary();
  testErrorRehydration();
  testJsonBoundaryUnit();
  testVirtualClock();
  testGateHold();
  testTypedValid();
  testTypedBadOutput();
  testTypedRepair();
  testTypedRepairExhausted();
  testJsonCleanDate();
  testJsonCleanReject();
  testLoudFailures();
  testExtractionCache();
  await testGateAgentLoop();
  testGateCache();
  testGateRegate();
  await testCheckerGateLoop();
  testBunTypeOnly();
  testCheckerCli();
  testResumeNoReextract();
  testDiskJournal();
  testCompilerRefusal();
  testQueue();
  await testTaskBackendLocal();
  testCrossProcessGate();
  await testRealClock();
  await testRealExec();
  await testJudgeFixLoopMock();
  await testJudgeFixLoopReal();
  await testLoadPlugin();

  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS host (ported core suite + agentts module + JSON-boundary rule + virtual clock + held gate + " +
      "typed-trap enforcement + repair loop + extraction cache + first-run gate pipeline + " +
      "M2 checker (class/empty contracts, wiring, layering, `agentts check`) + " +
      "disk journal/blob store + compiler refusal + queue + task-backend sync + cross-process gate + " +
      "real clock/exec + JudgeFixLoop mock + JudgeFixLoop real workers + plugin loading)",
  );
  return 0;
}

process.exit(await main());
