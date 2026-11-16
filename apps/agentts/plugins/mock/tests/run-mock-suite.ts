#!/usr/bin/env bun
/**
 * Mock-plugin test driver (Linear BRA-45).
 *
 * Ports the core suite's tests (packages/durablets/plugin/driver.ts)
 * to the mock plugin — same workflows (typed ports), same assertions —
 * plus the mock-only tests: virtual clock, held gates, typed-trap
 * enforcement (extraction, AJV validation, repair loop), the JSON-clean
 * boundary rule, extraction cache, and loud failures.
 *
 * Run outputs go to $MOCK_WORKDIR (scratch, set by run.sh). Exit 0 on
 * PASS, 1 on any mismatch. The swap test (swap-test.ts) compares the
 * .out files written here against the reference driver's.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { MockPlugin, prefixFor } from "../src/mock-plugin";
import { ExtractionError } from "../src/extract";
import { toJsonValue, JsonBoundaryError } from "../src/agentts";
import { GateError } from "../src/gate";
import { CheckerError } from "../src/checker";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const WORKDIR = process.env.MOCK_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "mock-suite-"));

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
  return path.join(WORKDIR, prefixFor(runId) + ".out");
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
): Promise<{ plugin: MockPlugin; runId: string; branches: number } | null> {
  console.log(`\n=== ${name} ===`);
  const d = prefixFor(runId + "-direct");
  // Straight-through reference.
  const directPlugin = new MockPlugin({ workdir: WORKDIR });
  let rc = directPlugin.startRun(path.join(TESTS, direct), runId + "-direct");
  rc = directPlugin.drive(runId + "-direct");
  if (rc !== 0) {
    fail(`${name}: direct reference exited ${rc}`);
    return null;
  }
  console.log(`--- direct output ---`);
  console.log(fs.readFileSync(path.join(WORKDIR, d + ".out"), "utf8"));
  if (directPlugin.registrySize() !== 0) {
    fail(`${name}: direct plugin registry not empty after completion`);
    return null;
  }

  // Fork version: the parent suspends at a combinator (exit 3).
  const plugin = new MockPlugin({ workdir: WORKDIR });
  if (bundleOut) {
    // Module variant: bundle workflow + agentts module first (the C
    // host never resolves imports), then run the bundle.
    const { entryPath } = plugin.prepareRun(path.join(TESTS, workflow), runId);
    let bundle: string;
    try {
      bundle = await plugin.bundle(entryPath, bundleOut);
    } catch (e) {
      fail(`${name}: Bun.build failed: ${(e as Error).message}`);
      return null;
    }
    console.log(`BUNDLED OK: workflow + agentts module -> one self-contained script (${fs.statSync(bundle).size} bytes)`);
    rc = plugin.startRunFrom(bundle, runId);
  } else {
    rc = plugin.startRun(path.join(TESTS, workflow), runId);
  }
  if (rc !== 3) {
    fail(`${name}: parent run exited ${rc}, expected 3 (suspended at a combinator)`);
    return null;
  }
  console.log(
    `parent suspended at a combinator, snapshot ${fs.statSync(path.join(WORKDIR, prefixFor(runId) + ".snap")).size} bytes`,
  );
  if (!plugin.registryHas(runId)) {
    fail(`${name}: registry does not hold suspended parent ${runId}`);
    return null;
  }
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`${name}: parent exited ${rc}`);
    return null;
  }
  console.log(`--- parent output ---`);
  console.log(fs.readFileSync(outPathFor(runId), "utf8"));
  const parentOut = fs.readFileSync(outPathFor(runId));
  const directOut = fs.readFileSync(path.join(WORKDIR, d + ".out"));
  if (parentOut.equals(directOut)) {
    console.log("OUTPUT MATCH: parent byte-identical to direct reference");
  } else {
    fail(`${name}: parent output differs from direct reference`);
    for (const [a, b] of zipLines(parentOut.toString(), directOut.toString())) {
      if (a !== b) console.log(`  parent: ${a}\n  direct: ${b}`);
    }
  }
  if (plugin.registrySize() !== 0) {
    fail(`${name}: registry not empty after completion: ${plugin.registryIds().join(", ")}`);
  }
  return { plugin, runId, branches };
}

function checkJournalPair(
  plugin: MockPlugin,
  name: string,
  runId: string,
  forkId: string,
  branches: number,
  verdicts: any[],
): void {
  const events = plugin.journal(runId);
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
    const cevents = plugin.journal(child);
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
  check(
    JSON.stringify(verdicts) === JSON.stringify(expected),
    "OUTCOMES OK: failed branch is { ok: false, error }",
  );
  if (JSON.stringify(verdicts) !== JSON.stringify(expected))
    fail(`judges: verdicts != expected:\n  ${JSON.stringify(verdicts)}\n  vs\n  ${JSON.stringify(expected)}`);
  const agg = JSON.parse(lines["aggregate"]);
  check(
    JSON.stringify(agg) === JSON.stringify({ approved: 2, failed: 1, summary: "2 approved, 1 failed" }),
    "AGGREGATE OK: 2 approved, 1 failed",
  );
  checkJournalPair(r.plugin, "judges", r.runId, "run-judges/fork-0", 3, verdicts);
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
  checkJournalPair(r.plugin, "global", r.runId, "run-global/fork-0", 3, verdicts);
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
  checkJournalPair(r.plugin, "nested", r.runId, "run-nested/fork-0", 2, verdicts);
  checkJournalPair(r.plugin, "nested-inner", "run-nested/fork-0/branch-0", "run-nested/fork-0/branch-0/fork-0", 2, nested);
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
  const events = r.plugin.journal(r.runId);
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
    for (const [forkI, failedMsg] of [[2, "judge crashed"], [3, "judge timed out"]] as const) {
      const forkId = `run-failfast/fork-${forkI}`;
      const child = `${forkId}/branch-2`;
      const cevents = r.plugin.journal(child);
      const cancels = cevents.filter((e) => e.event === "cancel");
      const starts = cevents.filter((e) => e.event === "branch-start");
      const c = cancels[0];
      check(
        cancels.length === 1 &&
          c?.parentForkId === forkId &&
          c?.trigger === "sibling failed with fail-fast on" &&
          c?.failedBranch === 1 &&
          JSON.stringify(c?.error) === JSON.stringify({ name: "Error", message: failedMsg }) &&
          starts.length === 0,
        `JOURNAL OK: ${child} cancelled before starting, trigger recorded`,
      );
    }
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
  const events = r.plugin.journal(r.runId);
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
    const child = "run-any/fork-0/branch-2";
    const cevents = r.plugin.journal(child);
    const cancels = cevents.filter((e) => e.event === "cancel");
    const starts = cevents.filter((e) => e.event === "branch-start");
    check(
      cancels.length === 1 &&
        cancels[0].parentForkId === "run-any/fork-0" &&
        cancels[0].trigger === "loser in any" &&
        cancels[0].winner === 1 &&
        starts.length === 0,
      `JOURNAL OK: ${child} cancelled before starting, trigger 'loser in any', winner 1`,
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
  const events = r.plugin.journal(r.runId);
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
    for (const [forkI, losers] of [[0, [1, 2]], [1, [1]]] as const) {
      const forkId = `run-race/fork-${forkI}`;
      for (const j of losers) {
        const child = `${forkId}/branch-${j}`;
        const cevents = r.plugin.journal(child);
        const cancels = cevents.filter((e) => e.event === "cancel");
        const starts = cevents.filter((e) => e.event === "branch-start");
        check(
          cancels.length === 1 &&
            cancels[0].parentForkId === forkId &&
            cancels[0].trigger === "loser in race" &&
            cancels[0].winner === 0 &&
            starts.length === 0,
          `JOURNAL OK: ${child} cancelled before starting, trigger 'loser in race', winner 0`,
        );
      }
    }
  }
}

function testRaceEmpty(): void {
  console.log("\n=== race([]) never settles (bounded drive) ===");
  const runId = "run-race-empty";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-race-empty.ts"), runId);
  if (rc !== 3) {
    fail(`race-empty: parent run exited ${rc}, expected 3 (suspended at race([]))`);
    return;
  }
  console.log("parent suspended at race([])");
  const events = plugin.journal(runId);
  const fork = events.filter((e) => e.event === "fork").pop();
  check(
    !!fork && fork.kind === "race" && fork.branches === 0 && JSON.stringify(fork.childRuns) === "[]",
    "FORK OK: 0-branch race fork, no children",
  );
  rc = plugin.drive(runId, { allowUnresolved: true });
  check(rc === 3, "BOUNDED DRIVE OK: still suspended (rc 3)");
  check(!plugin.journal(runId).some((e) => e.event === "join"), "NO JOIN OK: race([]) spuriously resolved");
  check(plugin.output(runId) === "", "NO OUTPUT OK: the workflow printed nothing");
  check(plugin.registryHas(runId), "REGISTRY OK: still-suspended run stays in-flight");
}

function testCancelStep(): void {
  console.log("\n=== 1. cancel a pending trap ===");
  const runId = "run-cancel-step";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-cancel-step.ts"), runId);
  if (rc !== 2) {
    fail(`cancel-step: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = plugin.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`cancel-step: cancelled run exited ${rc}, expected 0`);
    return;
  }
  const lines = plugin.output(runId).split("\n");
  for (const want of ["caught: CancellationError: user abort", "caught is Error: true", "finally ran", "done, caught: CancellationError: user abort"]) {
    if (!lines.includes(want)) fail(`cancel-step: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.startsWith("got:")))
    fail(`cancel-step: the trap returned a value after being cancelled: ${JSON.stringify(lines)}`);
  const events = plugin.journal(runId);
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 1 && traps[0].ordinal === 0 && traps[0].trapId === "run-cancel-step/trap-0", "TRAP OK: exactly 1 trap event, ordinal 0, trapId run-cancel-step/trap-0");
  check(!events.some((e) => e.event === "trap-result" || e.event === "trap-error"), "NO RESULT OK: no trap-result/trap-error for a cancelled trap");
  const c = checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  if (c) {
    check(events.indexOf(c) > events.indexOf(traps[0]), "ORDER OK: cancel recorded after the trap dispatch");
    console.log("CANCEL EVENT OK: trap ordinal 0, trigger 'user abort', reason 'user abort', when recorded");
  }
  console.log("CATCH OK: CancellationError at the call site, real Error, finally ran");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testCancelCombinator(): void {
  console.log("\n=== 2. cancel a whole all() in flight ===");
  const runId = "run-cancel-combinator";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-cancel-combinator.ts"), runId);
  if (rc !== 3) {
    fail(`cancel-combinator: run exited ${rc}, expected 3 (suspended at a combinator)`);
    return;
  }
  const fork = plugin.forkOf(runId);
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const snap = plugin.snapPath(runId)!;
  const before = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  // Start each child so it suspends at its first trap.
  const started = plugin.startForkBranches(runId);
  check(JSON.stringify(started) === JSON.stringify(children), "BRANCHES OK: all three children started");
  for (const child of children) {
    if (plugin.runRc(child) !== 2) fail(`cancel-combinator: child ${child} not suspended at its first trap`);
  }
  const after = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  check(before === after, "SNAPSHOT OK: parent snapshot untouched while children started");
  const cancelled = plugin.cancelTree(runId, "user abort", "user abort");
  check(
    JSON.stringify(cancelled) === JSON.stringify([...children, runId]),
    `CANCELLED OK: children first, parent last (got ${JSON.stringify(cancelled)})`,
  );
  const lines = plugin.output(runId).split("\n");
  for (const want of ["caught: CancellationError", "caught is Error: true", "finally ran", "done, caught: CancellationError"]) {
    if (!lines.includes(want)) fail(`cancel-combinator: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.startsWith("verdicts:")), "NO VERDICTS OK: the all() did not return after being cancelled");
  const events = plugin.journal(runId);
  check(!events.some((e) => e.event === "join"), "NO JOIN OK: the cancelled fork spuriously joined");
  checkCancelEvent(events, runId, "fork", "user abort", "user abort", { forkId, cancelled: children });
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const cevents = plugin.journal(child);
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
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testSticky(): void {
  console.log("\n=== 3. sticky cancellation ===");
  const runId = "run-sticky";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-sticky.ts"), runId);
  if (rc !== 2) {
    fail(`sticky: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = plugin.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`sticky: cancelled run exited ${rc}, expected 0 (the workflow must not suspend again)`);
    return;
  }
  const lines = plugin.output(runId).split("\n");
  for (const want of ["caught: CancellationError", "finally ran", "second threw: CancellationError", "all threw: CancellationError", "done"]) {
    if (!lines.includes(want)) fail(`sticky: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.startsWith("ERROR:")), "STICKY OK: the second trap() and the all() both threw at once — neither dispatched");
  const events = plugin.journal(runId);
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 1 && traps[0].ordinal === 0, "TRAP OK: exactly 1 trap event (ordinal 0)");
  check(!events.some((e) => e.event === "fork"), "NO FORK OK: the all() after the cancel did not fork");
  checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testRaceOrder(): void {
  console.log("\n=== 4a. cancel-vs-complete race: result first ===");
  let runId = "run-race-a";
  let plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-race-order.ts"), runId);
  if (rc !== 2) {
    fail(`race-a: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  // Stepwise: answer the first trap only, then cancel at the second.
  rc = plugin.driveStep(runId);
  if (rc !== 2) {
    fail(`race-a: after the first result the run exited ${rc}, expected 2 (suspended at the second trap)`);
    return;
  }
  rc = plugin.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`race-a: cancelled run exited ${rc}, expected 0`);
    return;
  }
  let lines = plugin.output(runId).split("\n");
  for (const want of [
    'first got: {"score":0.92,"label":"approved"}',
    "first finally ran",
    "second threw: CancellationError",
    "second finally ran",
    "done",
  ]) {
    if (!lines.includes(want)) fail(`race-a: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  let events = plugin.journal(runId);
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
  plugin = new MockPlugin({ workdir: WORKDIR });
  rc = plugin.startRun(path.join(TESTS, "workflow-race-order.ts"), runId);
  if (rc !== 2) {
    fail(`race-b: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = plugin.cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`race-b: cancelled run exited ${rc}, expected 0 (sticky: the second trap must throw at once, not suspend)`);
    return;
  }
  lines = plugin.output(runId).split("\n");
  for (const want of ["first threw: CancellationError", "first finally ran", "second threw: CancellationError", "second finally ran", "done"]) {
    if (!lines.includes(want)) fail(`race-b: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.includes("got:")), "RACE OK (cancel-first): no result ever landed, and the second trap threw at once (sticky)");
  events = plugin.journal(runId);
  check(!events.some((e) => e.event === "trap-result"), "NO RESULT OK: no trap-result for a cancelled trap");
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 1 && traps[0].ordinal === 0, "TRAP OK: exactly 1 trap event (ordinal 0) — the second trap never dispatched");
  checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testNestedCancel(): void {
  console.log("\n=== 5. nested propagation (cancel the whole tree) ===");
  const runId = "run-nested-cancel";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-nested-cancel.ts"), runId);
  if (rc !== 3) {
    fail(`nested-cancel: run exited ${rc}, expected 3 (suspended at a combinator)`);
    return;
  }
  const fork = plugin.forkOf(runId);
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const snap = plugin.snapPath(runId)!;
  const before = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  // Branch 0 fans out again: it suspends at its own all().
  plugin.startForkBranches(runId);
  if (plugin.runRc(children[0]) !== 3) {
    fail(`nested-cancel: branch 0 exited ${plugin.runRc(children[0])}, expected 3 (suspended at its own all())`);
    return;
  }
  const b0Snap = plugin.snapPath(children[0])!;
  const before0 = crypto.createHash("sha256").update(fs.readFileSync(b0Snap)).digest("hex");
  const fork0 = plugin.forkOf(children[0]);
  const fork0Id = fork0.forkId;
  const grandchildren: string[] = fork0.childRuns;
  plugin.startForkBranches(children[0]);
  for (const gc of grandchildren) {
    if (plugin.runRc(gc) !== 2) fail(`nested-cancel: grandchild ${gc} not suspended at its trap`);
  }
  const after0 = crypto.createHash("sha256").update(fs.readFileSync(b0Snap)).digest("hex");
  check(before0 === after0, "SNAPSHOT OK: branch-0 snapshot untouched while grandchildren started");
  if (plugin.runRc(children[1]) !== 2) {
    fail(`nested-cancel: branch 1 exited ${plugin.runRc(children[1])}, expected 2 (suspended at its trap)`);
    return;
  }
  const after = crypto.createHash("sha256").update(fs.readFileSync(snap)).digest("hex");
  check(before === after, "SNAPSHOT OK: parent snapshot untouched while the tree started");
  const cancelled = plugin.cancelTree(runId, "user abort", "user abort");
  const expected = [...grandchildren, children[0], children[1], runId];
  check(
    JSON.stringify(cancelled) === JSON.stringify(expected),
    `CANCELLED OK: deepest first, parent last (got ${JSON.stringify(cancelled)})`,
  );
  const lines = plugin.output(runId).split("\n");
  for (const want of ["caught: CancellationError", "finally ran", "done, caught: CancellationError"]) {
    if (!lines.includes(want)) fail(`nested-cancel: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  check(!lines.some((l) => l.startsWith("verdicts:")), "NO VERDICTS OK: the parent all() did not return after being cancelled");
  const events = plugin.journal(runId);
  check(!events.some((e) => e.event === "join"), "NO JOIN OK: parent journal has no join");
  checkCancelEvent(events, runId, "fork", "user abort", "user abort", { forkId, cancelled: children });
  const b0Events = plugin.journal(children[0]);
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
  const b1Events = plugin.journal(children[1]);
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
    const gcEvents = plugin.journal(gc);
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
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTrapTypes(): void {
  console.log("\n=== trap dispatch by type string (all six types) ===");
  const runId = "run-trap-types";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(path.join(TESTS, "workflow-trap-types.ts"), runId);
  if (rc !== 2) {
    fail(`trap-types: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  // Blob round-trip through the IN-MEMORY store, explicitly: the
  // stored blob is byte-identical, the live blob is deleted, and the
  // run resumes from the stored copy alone.
  const storedHash = plugin.storedBlobHash(runId);
  if (!storedHash) {
    fail("trap-types: no stored blob in the in-memory store");
    return;
  }
  plugin.deleteLiveBlob(runId);
  if (fs.existsSync(plugin.snapPath(runId)!)) {
    fail("trap-types: live blob still exists after deleteLiveBlob");
    return;
  }
  plugin.restoreBlob(runId);
  const restoredHash = crypto.createHash("sha256").update(fs.readFileSync(plugin.snapPath(runId)!)).digest("hex");
  check(restoredHash === storedHash, `BLOB ROUND-TRIP OK: in-memory store holds the blob (${storedHash.slice(0, 16)}…), run resumes from it`);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`trap-types: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
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
  const events = plugin.journal(runId);
  const traps = events.filter((e) => e.event === "trap");
  const types = traps.map((t) => t.type);
  check(
    JSON.stringify(types) === JSON.stringify(["job", "exec", "gate", "sleep", "cron", "decide"]),
    "TRAP IDS OK: runId/trap-N, one per type, in order",
  );
  // BRA-57 (journal format v2): every event carries wallTs, every
  // trap-result carries the adapter + measured wallMs.
  const badTs = events.filter((e) => typeof e.wallTs !== "string" || !Number.isFinite(Date.parse(e.wallTs)));
  check(badTs.length === 0, `JOURNAL V2 OK: every event carries a parseable wallTs (${events.length} events, ${badTs.length} bad)`);
  const results = events.filter((e) => e.event === "trap-result" || e.event === "trap-error");
  check(results.length === 6, `JOURNAL V2 OK: 6 trap-result events (got ${results.length})`);
  check(
    results.every((e) => e.adapter === "mock"),
    "JOURNAL V2 OK: every trap-result names the mock adapter",
  );
  check(
    results.every((e) => typeof e.wallMs === "number" && e.wallMs >= 0),
    "JOURNAL V2 OK: every trap-result carries wallMs >= 0",
  );
  if (JSON.stringify(types) === JSON.stringify(["job", "exec", "gate", "sleep", "cron", "decide"])) {
    check(
      traps.every((t, i) => t.trapId === `${runId}/trap-${i}`),
      "TRAP IDS OK: trapIds are runId/trap-N",
    );
  }
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

async function testAgenttsBundle(): Promise<void> {
  console.log("\n=== agentts module via Bun.build (TS host bundles, C host evals) ===");
  const runId = "run-agentts";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  const { entryPath } = plugin.prepareRun(path.join(TESTS, "workflow-agentts.ts"), runId);
  let bundleOut: string;
  try {
    bundleOut = await plugin.bundle(entryPath, "bundle-agentts.js");
  } catch (e) {
    fail(`agentts-bundle: ${(e as Error).message}`);
    return;
  }
  console.log(`BUNDLED OK: workflow + agentts module -> one self-contained script (${fs.statSync(bundleOut).size} bytes)`);
  let rc = plugin.startRunFrom(bundleOut, runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`agentts-bundle: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
  const direct = plugin.output("run-trap-types");
  check(out === direct, "BUNDLE OUTPUT OK: byte-identical to the direct trap() version — the C host never resolved imports");
  if (out !== direct) fail(`agentts-bundle: bundled output != trap-types output:\n${out}\nvs\n${direct}`);
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
  // The journal's trap events carry the spec verbatim — job's new
  // { spec, input } shape, the others their fixed spec shapes. The
  // landed module guarantees the trap arg is exactly what the author
  // passed; the plugin never wraps it (no boxing — the v1 transform
  // is gone, reconciled with BRA-46).
  const trapEvents = plugin.journal(runId).filter((e) => e.event === "trap");
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
  // Each core-suite combinator workflow has a module variant that
  // imports the combinator (and the job wrapper) from the agentts
  // module instead of using the core globals / direct trap().
  // Bundled, driven, and compared byte-identical against the same
  // direct reference the original uses — the re-exports must behave
  // identically to the builtins, including inside branch thunks.
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
      // The module variant's journal must show the new job arg shape
      // (the branches call job(), not trap() directly).
      const traps = r.plugin.journal(runId).filter((e) => e.event === "trap");
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
  const plugin = new MockPlugin({ workdir: WORKDIR });
  const { entryPath } = plugin.prepareRun(path.join(TESTS, "workflow-json-boundary.ts"), runId);
  let bundleOut: string;
  try {
    bundleOut = await plugin.bundle(entryPath, "bundle-json-boundary.js");
  } catch (e) {
    fail(`json-boundary: ${(e as Error).message}`);
    return;
  }
  let rc = plugin.startRunFrom(bundleOut, runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`json-boundary: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
  // Every rejected category throws synchronously at the call site with
  // a precise error (path + what it was); the workflow catches and
  // prints it. The error is the module's JsonBoundaryError, thrown
  // inside job() before trap() is ever called.
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
  // A Date in a clean arg crosses as its ISO string — visible in the
  // journal trap arg, not just in the workflow's printout. Dirty args
  // never dispatch, so exactly one trap event exists.
  const traps = plugin.journal(runId).filter((e) => e.event === "trap");
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
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testErrorRehydration(): void {
  console.log("\n=== error rehydration (BRA-41): throwing traps arrive as real Errors ===");
  const runId = "run-error-rehydration";
  const d = prefixFor(runId + "-direct");
  const directPlugin = new MockPlugin({ workdir: WORKDIR });
  let rc = directPlugin.startRun(path.join(TESTS, "workflow-error-rehydration-direct.ts"), runId + "-direct");
  rc = directPlugin.drive(runId + "-direct");
  if (rc !== 0) {
    fail(`rehydration: direct reference exited ${rc}`);
    return;
  }
  const plugin = new MockPlugin({ workdir: WORKDIR });
  // The plugin answers this run's traps with throws: an Error record,
  // then a plain string (a non-Error throw crosses as-is).
  plugin.queueAnswer("job", { throw: { name: "Error", message: "boom" } });
  plugin.queueAnswer("job", { throw: "plain failure" });
  rc = plugin.startRun(path.join(TESTS, "workflow-error-rehydration.ts"), runId);
  if (rc !== 2) {
    fail(`rehydration: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`rehydration: run exited ${rc}`);
    return;
  }
  const parentOut = fs.readFileSync(outPathFor(runId));
  const directOut = fs.readFileSync(path.join(WORKDIR, d + ".out"));
  check(parentOut.equals(directOut), "OUTPUT MATCH: driven version byte-identical to direct reference");
  const lines = parseOutLines(outPathFor(runId));
  check(lines["caught is Error"] === "true", "REHYDRATION OK: throwing trap arrived as a real Error (instanceof Error true)");
  check(lines["caught"] === "Error: boom", "REHYDRATION OK: caught == 'Error: boom'");
  check(lines["plain is Error"] === "false", "NON-ERROR OK: a thrown plain string crosses as-is, not rehydrated");
  check(lines["plain"] === "plain failure", "NON-ERROR OK: plain == 'plain failure'");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

// --------------------------------------------------------- mock-only tests
function testJsonBoundaryUnit(): void {
  console.log("\n=== JSON-clean helper (unit matrix, the module's toJsonValue) ===");
  // The plugin reuses the agentts module's toJsonValue — ONE
  // implementation defines "clean JSON" everywhere (BRA-46). It
  // throws JsonBoundaryError (fail-fast, first bad value) with a
  // precise path + kind + message, and returns a fresh clean copy.
  // Accept: null, boolean, string, finite number, array, plain object.
  for (const v of [null, true, false, "", "x", 0, -0, 3.14, 1e9, [], [1, "a", null], {}, { a: 1, b: [true] }, Object.create(null)]) {
    try {
      const out = toJsonValue(v, "value");
      check(JSON.stringify(out) === JSON.stringify(v), `JSON-CLEAN OK: accepts ${JSON.stringify(v)}`);
    } catch (e) {
      fail(`json-clean: should accept ${JSON.stringify(v)}: ${(e as Error).message}`);
    }
  }
  // Date is the ONE sanctioned conversion.
  const d = new Date("2027-04-09T12:00:00.000Z");
  const converted = toJsonValue({ at: d, nested: [d] }, "value") as any;
  check(
    converted.at === "2027-04-09T12:00:00.000Z" && converted.nested[0] === "2027-04-09T12:00:00.000Z",
    "JSON-CLEAN OK: Date converts to ISO string, deep",
  );
  // A DAG (shared non-circular reference) is copied at each occurrence.
  const shared = { x: 1 };
  check(
    JSON.stringify(toJsonValue({ a: shared, b: shared }, "value")) === JSON.stringify({ a: { x: 1 }, b: { x: 1 } }),
    "JSON-CLEAN OK: shared (non-circular) references are fine",
  );
  // Reject, each with path + kind + fix in the message.
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
  // Circular references + symbol keys + array extra props.
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
  // Nesting past 1000 levels: a precise error, not a stack overflow.
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
  // The journal writer uses the same helper: a Date serializes as ISO,
  // an undefined event fails LOUDLY instead of writing a corrupt line.
  const plugin = new MockPlugin({ workdir: WORKDIR });
  plugin.journalEvent("run-journal-check", { event: "note", runId: "run-journal-check", at: d });
  const dumpDir = path.join(WORKDIR, "journal-dump");
  plugin.dumpJournals(dumpDir);
  const dumped = fs.readFileSync(path.join(dumpDir, "run-journal-check.journal"), "utf8");
  check(dumped.includes('"at":"2027-04-09T12:00:00.000Z"'), "JOURNAL OK: Date written as ISO string in the JSONL dump");
  let journalThrew = false;
  try {
    plugin.journalEvent("run-journal-check", { event: "note", runId: "run-journal-check", bad: undefined });
  } catch (e) {
    journalThrew = e instanceof JsonBoundaryError;
  }
  check(journalThrew, "JOURNAL OK: an event with undefined fails loudly instead of writing a corrupt line");
}

function testVirtualClock(): void {
  console.log("\n=== virtual clock (sleep advances, cron fires at absolute datetimes) ===");
  const runId = "run-clock";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  const wallStart = Date.now();
  let rc = plugin.startRun(path.join(TESTS, "workflow-clock.ts"), runId);
  if (rc !== 2) {
    fail(`clock: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = plugin.drive(runId);
  const wallMs = Date.now() - wallStart;
  if (rc !== 0) {
    fail(`clock: run exited ${rc}`);
    return;
  }
  // Two 1-hour sleeps + cron jumps of months: all instant in real time.
  check(wallMs < 10000, `VIRTUAL TIME OK: 2h of sleeps + months of cron jumps completed in ${wallMs}ms wall time (no real waiting)`);
  const out = plugin.output(runId);
  const lines = parseOutLines(outPathFor(runId));
  check(lines["after sleep 1"] === "2027-01-01T01:00:00.000Z", `CLOCK OK: first sleep advanced the clock 1h (got ${lines["after sleep 1"]})`);
  check(lines["after sleep 2"] === "2027-01-01T02:00:00.000Z", `CLOCK OK: second sleep advanced the clock another 1h — sleeps sum (got ${lines["after sleep 2"]})`);
  check(lines["after cron late"] === "2027-03-01T00:00:00.000Z", `CRON OK: later cron fired at its absolute datetime (got ${lines["after cron late"]})`);
  check(lines["after cron early"] === "2027-03-01T00:00:00.000Z", `CRON OK: earlier cron (already past) fired immediately, clock did not move back (got ${lines["after cron early"]})`);
  check(lines["after cron apr"] === "2027-04-01T00:00:00.000Z", `CRON OK: ascending cron stepped to April (got ${lines["after cron apr"]})`);
  check(lines["after cron may"] === "2027-05-01T00:00:00.000Z", `CRON OK: ascending cron stepped to May (got ${lines["after cron may"]})`);
  check(out.includes("done"), "CLOCK OK: workflow completed");
  const advances = plugin.journal(runId).filter((e) => e.event === "clock-advance");
  check(advances.length >= 5, `JOURNAL OK: ${advances.length} clock-advance events recorded`);
  check(
    advances.some((e) => e.reason === "sleep") && advances.some((e) => e.reason === "cron"),
    "JOURNAL OK: clock-advance events carry their reason (sleep/cron)",
  );
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testGateHold(): void {
  console.log("\n=== held gate (the week-long gate in miniature) ===");
  const runId = "run-gate-hold";
  const plugin = new MockPlugin({ workdir: WORKDIR, gates: "hold" });
  let rc = plugin.startRun(path.join(TESTS, "workflow-gate-hold.ts"), runId);
  if (rc !== 2) {
    fail(`gate-hold: run exited ${rc}, expected 2 (suspended at the gate)`);
    return;
  }
  rc = plugin.drive(runId);
  check(rc === 2, "HOLD OK: drive stopped at the gate (rc 2, not completed)");
  check(plugin.isGatePending(runId), "HOLD OK: the gate is pending");
  check(plugin.registryHas(runId), "HOLD OK: the run stays suspended in the registry");
  const held = plugin.journal(runId).filter((e) => e.event === "gate-held");
  check(held.length === 1 && held[0].question === "approve?", "JOURNAL OK: gate-held event recorded with the question");
  check(plugin.output(runId) === "", "HOLD OK: no output yet — the gate never resolved until the test delivered an answer");
  rc = plugin.deliverGate(runId, { answer: "no" });
  check(rc === 0, "DELIVER OK: after the answer the run completed");
  const out = plugin.output(runId);
  check(out.includes('answer: {"answer":"no"}'), "DELIVER OK: the workflow received the delivered answer");
  check(out.includes("done"), "DELIVER OK: workflow completed");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedValid(): void {
  console.log("\n=== typed trap, valid path (configurable canned decide) ===");
  const runId = "run-typed-valid";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  // "The next decide returns X at confidence 0.6."
  plugin.queueAnswer("decide", { choice: "b", confidence: 0.6 });
  let rc = plugin.startRun(path.join(TESTS, "workflow-typed-valid.ts"), runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`typed-valid: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
  check(out.includes('job: {"score":0.92,"label":"approved"}'), "TYPED OK: job validated against the extracted schema");
  check(out.includes('decide: {"choice":"b","confidence":0.6}'), "CANNED OK: the queued decide answer was delivered");
  check(out.includes("done"), "TYPED OK: workflow completed");
  check(!plugin.journal(runId).some((e) => e.event === "validation-error"), "JOURNAL OK: no validation-error events on the valid path");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedBadOutput(): void {
  console.log("\n=== typed trap, bad output (schema failure throws at the call site) ===");
  const runId = "run-typed-bad-output";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  plugin.queueAnswer("job", { score: "high", label: "approved" });
  let rc = plugin.startRun(path.join(TESTS, "workflow-typed-bad-output.ts"), runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`typed-bad-output: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
  check(out.includes("caught: ValidationError:"), "THROW OK: ValidationError at the call site");
  check(out.includes("$.score") && out.includes("must be number"), `PRECISE OK: the error names the path and the failure (got: ${out.split("\n").find((l) => l.startsWith("caught:")) ?? ""})`);
  check(out.includes("caught is Error: true"), "ERROR OK: caught value is a real Error");
  const errors = plugin.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1, `JOURNAL OK: exactly 1 validation-error event (got ${errors.length})`);
  if (errors.length === 1) {
    check(errors[0].phase === "output" && errors[0].attempt === 0, "JOURNAL OK: phase output, attempt 0");
    check(
      Array.isArray(errors[0].errors) && errors[0].errors.some((i: any) => i.path === "$.score"),
      "JOURNAL OK: the precise error (path $.score) is journaled",
    );
  }
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedRepair(): void {
  console.log("\n=== typed trap, repair loop (same trapId, error attached) ===");
  const runId = "run-typed-repair";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  plugin.queueAnswer("job", { score: "high", label: "approved" });
  const seen: any[] = [];
  plugin.setRepairHandler("job", (ctx) => {
    seen.push(ctx);
    return { value: { score: 0.92, label: "approved" } };
  });
  let rc = plugin.startRun(path.join(TESTS, "workflow-typed-repair.ts"), runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`typed-repair: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
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
  const errors = plugin.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1 && errors[0].attempt === 0, "JOURNAL OK: one validation-error (attempt 0), then the trap-result");
  check(plugin.journal(runId).some((e) => e.event === "trap-result"), "JOURNAL OK: trap-result recorded after the repair");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testTypedRepairExhausted(): void {
  console.log("\n=== typed trap, repair exhausted (throws after max attempts) ===");
  const runId = "run-typed-repair-exhausted";
  const plugin = new MockPlugin({ workdir: WORKDIR, maxRepairAttempts: 2 });
  plugin.queueAnswer("job", { score: "high", label: "approved" });
  let calls = 0;
  plugin.setRepairHandler("job", () => {
    calls++;
    return { value: { score: "high", label: "approved" } };
  });
  let rc = plugin.startRun(path.join(TESTS, "workflow-typed-repair-exhausted.ts"), runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`typed-repair-exhausted: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
  check(out.includes("caught: ValidationError:"), "THROW OK: ValidationError at the call site after exhaustion");
  check(calls === 2, `REPAIR OK: the handler was consulted exactly maxRepairAttempts times (got ${calls})`);
  const errors = plugin.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 3, `JOURNAL OK: 3 validation-error events (attempts 0, 1, 2; got ${errors.length})`);
  if (errors.length === 3) {
    check(JSON.stringify(errors.map((e) => e.attempt)) === "[0,1,2]", "JOURNAL OK: attempts 0, 1, 2 in order");
  }
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testJsonCleanDate(): void {
  console.log("\n=== JSON-clean ordering (Date converts first, then schema validates) ===");
  const runId = "run-json-clean-date";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  plugin.queueAnswer("job", { score: "high", label: "approved" });
  plugin.setRepairHandler("job", () => ({
    value: { score: 0.92, label: "approved", at: new Date("2027-04-09T12:00:00.000Z") },
  }));
  let rc = plugin.startRun(path.join(TESTS, "workflow-json-clean-date.ts"), runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`json-clean-date: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
  check(
    out.includes('"at":"2027-04-09T12:00:00.000Z"'),
    `ORDER OK: the Date crossed as an ISO string (got: ${out.split("\n").find((l) => l.startsWith("job:")) ?? ""})`,
  );
  const errors = plugin.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 1 && errors[0].phase === "output", "JOURNAL OK: only the first (schema) failure is recorded — the repaired Date converted cleanly, no json-clean error");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testJsonCleanReject(): void {
  console.log("\n=== JSON-clean rejections (precise errors, phase json-clean) ===");
  const runId = "run-json-clean-reject";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  plugin.queueAnswer("job", { score: undefined, label: "approved" });
  plugin.queueAnswer("job", { score: NaN, label: "approved" });
  const circ: any = { score: 0.5, label: "approved" };
  circ.self = circ;
  plugin.queueAnswer("job", circ);
  plugin.queueAnswer("job", new Map([["score", 0.5]]));
  class Foo {
    score = 0.5;
    label = "approved";
  }
  plugin.queueAnswer("job", new Foo());
  let rc = plugin.startRun(path.join(TESTS, "workflow-json-clean-reject.ts"), runId);
  rc = plugin.drive(runId);
  if (rc !== 0) {
    fail(`json-clean-reject: run exited ${rc}`);
    return;
  }
  const out = plugin.output(runId);
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
  const errors = plugin.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length === 5, `JOURNAL OK: 5 validation-error events (got ${errors.length})`);
  check(errors.every((e) => e.phase === "json-clean" && e.attempt === 0), "JOURNAL OK: all phase json-clean, attempt 0 — the check runs BEFORE schema validation");
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testLoudFailures(): void {
  console.log("\n=== loud failures at first run (no extractable type) ===");
  const cases: [string, string][] = [
    ["workflow-no-type.ts", "exactly two"],
    ["workflow-unknown-type.ts", "not a concrete, named type"],
    ["workflow-fn-type.ts", "cannot be validated"],
  ];
  for (const [file, fragment] of cases) {
    const plugin = new MockPlugin({ workdir: WORKDIR });
    let threw: any = null;
    try {
      plugin.startRun(path.join(TESTS, file), "run-loud-" + file.replace(".ts", ""));
    } catch (e) {
      threw = e;
    }
    check(threw instanceof ExtractionError, `LOUD OK: ${file} threw ExtractionError (got ${threw?.constructor?.name ?? "no throw"})`);
    if (threw) {
      check(String(threw.message).includes(fragment), `LOUD OK: ${file} names the problem ('${fragment}')`);
      check(!String(threw.message).includes("silently"), `LOUD OK: ${file} fails, never silently skips`);
    }
    check(plugin.registrySize() === 0, `LOUD OK: ${file} spawned nothing`);
  }
}

function testExtractionCache(): void {
  console.log("\n=== extraction cache (keyed by content hash, pinned with the frozen copy) ===");
  const cacheDir = path.join(WORKDIR, ".schema-cache");
  const before = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length : 0;
  // A scratch copy of a workflow, made unique (one label changed) so
  // its content hash differs from every workflow the suite already
  // extracted. Mutating it cannot touch the tree.
  const copyPath = path.join(WORKDIR, "workflow-cache-copy.ts");
  const copySrc = fs
    .readFileSync(path.join(TESTS, "workflow-clock.ts"), "utf8")
    .replace("after sleep 1:", "after sleep 1 (copy):");
  fs.writeFileSync(copyPath, copySrc);
  const p1 = new MockPlugin({ workdir: WORKDIR });
  let rc = p1.startRun(copyPath, "run-cache-a");
  rc = p1.drive("run-cache-a");
  check(rc === 0, "CACHE OK: first run of the copy completed");
  const afterFirst = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length;
  check(afterFirst === before + 1, `CACHE OK: one cache entry appeared (was ${before}, now ${afterFirst})`);
  const entries = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
  const newest = entries.map((f) => path.join(cacheDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const mtime1 = fs.statSync(newest).mtimeMs;
  // Second run, new plugin instance, same workdir (shared cache): a hit.
  const p2 = new MockPlugin({ workdir: WORKDIR });
  rc = p2.startRun(copyPath, "run-cache-b");
  rc = p2.drive("run-cache-b");
  check(rc === 0, "CACHE OK: second run completed");
  check(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length === afterFirst, "CACHE OK: second run added no entry — cache hit");
  check(fs.statSync(newest).mtimeMs === mtime1, "CACHE OK: the entry file was not rewritten — cache hit");
  check(p1.output("run-cache-a") === p2.output("run-cache-b"), "CACHE OK: both runs produced identical output");
  // Mutate the source (append a comment): the hash changes, re-extract.
  fs.appendFileSync(copyPath, "\n// comment change: content hash must change\n");
  const p3 = new MockPlugin({ workdir: WORKDIR });
  rc = p3.startRun(copyPath, "run-cache-c");
  rc = p3.drive("run-cache-c");
  check(rc === 0, "CACHE OK: mutated copy completed");
  check(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length === afterFirst + 1, "CACHE OK: changed source produced a new cache entry (re-extraction)");
  check(p3.output("run-cache-c") === p1.output("run-cache-a"), "CACHE OK: mutated copy (comment only) produced identical output");
}

// ------------------------------------------------------------------ first-run gate
async function testGateAgentLoop(): Promise<void> {
  console.log("\n=== first-run gate: agent loop (submit, structured diagnostics, fix, resubmit) ===");
  // An agent submits a workflow with a type error. The gate is a
  // FEEDBACK CHANNEL: the failure comes back as structured
  // diagnostics the agent can act on — file, line, column, code,
  // message, expected vs actual — not raw log text, not a bare stop.
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
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let threw: any = null;
  try {
    // The submission goes through prepareRun — the gate is IN the
    // run path, so the refusal happens before anything starts.
    plugin.prepareRun(agentPath, "run-gate-agent");
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
  check(plugin.registrySize() === 0, "GATE OK: the run never started — registry empty");
  check(!fs.existsSync(path.join(WORKDIR, prefixFor("run-gate-agent") + ".snap")), "GATE OK: no snapshot was written");
  check(!fs.existsSync(path.join(WORKDIR, prefixFor("run-gate-agent") + ".out")), "GATE OK: no output was written");
  check(plugin.gateRuns === 1, `GATE OK: the gate ran once for the broken version (gateRuns ${plugin.gateRuns})`);
  // Fix: the agent corrects the value and resubmits the same file.
  // A module workflow must be bundled before it runs (the C host
  // never resolves imports), so the resubmission goes through
  // prepareRun (re-gate) + bundle + startRunFrom.
  fs.writeFileSync(agentPath, brokenSrc.replace('"seven"', "7"));
  const { entryPath } = plugin.prepareRun(agentPath, "run-gate-agent");
  let bundleOut: string;
  try {
    bundleOut = await plugin.bundle(entryPath, "bundle-gate-agent.js");
  } catch (e) {
    fail(`gate-agent: bundle failed: ${(e as Error).message}`);
    return;
  }
  let rc = plugin.startRunFrom(bundleOut, "run-gate-agent");
  rc = plugin.drive("run-gate-agent");
  check(rc === 0, "GATE OK: the fixed workflow passes the gate and runs");
  check(
    plugin.output("run-gate-agent").includes('job: {"score":0.92,"label":"approved"}'),
    "GATE OK: the fixed workflow completed with the canned result",
  );
  check(plugin.gateRuns === 2, `GATE OK: the fix changed the hash, so the new version was re-gated (gateRuns ${plugin.gateRuns})`);
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testGateCache(): void {
  console.log("\n=== first-run gate: second run of the same version skips the gate from cache ===");
  // A scratch copy, made unique so its content hash differs from the
  // clock workflow the suite already ran.
  const copyPath = path.join(WORKDIR, "workflow-gate-cache.ts");
  fs.writeFileSync(
    copyPath,
    fs.readFileSync(path.join(TESTS, "workflow-clock.ts"), "utf8").replace("after sleep 1:", "after sleep 1 (gate):"),
  );
  const p1 = new MockPlugin({ workdir: WORKDIR });
  let rc = p1.startRun(copyPath, "run-gate-cache-a");
  rc = p1.drive("run-gate-cache-a");
  check(rc === 0, "GATE OK: first run completed");
  check(p1.gateRuns === 1, `GATE OK: the gate ran once for the first run (gateRuns ${p1.gateRuns})`);
  // Second run, new plugin instance, same workdir (shared cache): the
  // cached gate result + schemas are reused, tsc never re-runs.
  const p2 = new MockPlugin({ workdir: WORKDIR });
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
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let rc = plugin.startRun(copyPath, "run-gate-regate-a");
  rc = plugin.drive("run-gate-regate-a");
  check(rc === 0, "GATE OK: first version completed");
  check(plugin.gateRuns === 1, `GATE OK: gate ran for the first version (gateRuns ${plugin.gateRuns})`);
  // Comment-only change: new hash, still clean — re-gated, passes.
  fs.appendFileSync(copyPath, "\n// comment change: content hash must change\n");
  rc = plugin.startRun(copyPath, "run-gate-regate-b");
  rc = plugin.drive("run-gate-regate-b");
  check(rc === 0, "GATE OK: comment-only version completed");
  check(plugin.gateRuns === 2, `GATE OK: the changed version was re-gated (gateRuns ${plugin.gateRuns})`);
  check(
    plugin.output("run-gate-regate-b") === plugin.output("run-gate-regate-a"),
    "GATE OK: comment-only change produced identical output",
  );
  // Introduce a type error: the agent mistypes a value — the new
  // version is refused at the gate. (A mistyped sleep duration
  // alone is NOT a type error here: the ported direct-trap
  // workflows declare trap's arg as unknown, so tsc cannot see it —
  // the module wrappers are the ones that check args at the gate.
  // The mistyped assignment below is a genuine TS2322.)
  fs.writeFileSync(copyPath, base + "\nconst wrongType: number = s1.sleptMs.toString();\n");
  let threw: any = null;
  try {
    plugin.startRun(copyPath, "run-gate-regate-c");
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
  check(plugin.gateRuns === 3, `GATE OK: the mistyped version was gated too (gateRuns ${plugin.gateRuns})`);
}

// ------------------------------------------------------------------ M2 checker (BRA-29)
async function testCheckerGateLoop(): Promise<void> {
  console.log("\n=== M2 checker: agent loop (submit, structured diagnostics, fix, resubmit) ===");
  // Same shape as the gate agent loop, but the fault is one tsc
  // cannot see: the trap output is typed as a CLASS. The gate's
  // tsc half passes; the checker's M2-CLASS rule refuses it — with
  // the same structured diagnostics (file, line, column, rule,
  // message, fix) so the agent can fix and resubmit. The mock
  // plugin runs the same checker as the host (shared verbatim),
  // so a bad workflow is refused identically on both sides of the
  // swap.
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
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let threw: any = null;
  try {
    plugin.prepareRun(agentPath, "run-checker-agent");
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
  }
  check(plugin.registrySize() === 0, "CHECKER OK: the run never started — registry empty");
  check(!fs.existsSync(path.join(WORKDIR, prefixFor("run-checker-agent") + ".snap")), "CHECKER OK: no snapshot was written");
  check(plugin.checkerRuns === 1, `CHECKER OK: the checker ran once for the broken version (checkerRuns ${plugin.checkerRuns})`);
  fs.writeFileSync(
    agentPath,
    brokenSrc.replace("class ScoreResult { score = 0; label = \"\"; }", "interface ScoreResult { score: number; label: string; }"),
  );
  const { entryPath } = plugin.prepareRun(agentPath, "run-checker-agent");
  let bundleOut: string;
  try {
    bundleOut = await plugin.bundle(entryPath, "bundle-checker-agent.js");
  } catch (e) {
    fail(`checker-agent: bundle failed: ${(e as Error).message}`);
    return;
  }
  // The renamed spec has no table entry in the mock plugin's canned
  // MOCK table (keyed `spec:value`), so queue the expected answer
  // for the run's one job trap.
  plugin.queueAnswer("job", { score: 0.92, label: "approved" });
  let rc = plugin.startRunFrom(bundleOut, "run-checker-agent");
  rc = plugin.drive("run-checker-agent");
  check(rc === 0, "CHECKER OK: the fixed workflow passes the gate + checker and runs");
  check(
    plugin.output("run-checker-agent").includes('job: {"score":0.92,"label":"approved"}'),
    "CHECKER OK: the fixed workflow completed with the canned result",
  );
  check(plugin.checkerRuns === 2, `CHECKER OK: the fix changed the hash, so the new version was re-checked (checkerRuns ${plugin.checkerRuns})`);
  check(plugin.registrySize() === 0, "REGISTRY OK: empty after completion");
}

function testBunTypeOnly(): void {
  console.log("\n=== Bun: type-only workflow runs, value workflow refused (BRA-58) ===");
  // The mock plugin runs the same checker as the host (shared
  // verbatim), so a bad workflow is refused identically on both
  // sides of the swap. The value fixture is refused at prepareRun
  // with CheckerError M2-BUN (the gate's tsc half passes — the
  // refusal is the checker's, not a TS2867).
  const plugin = new MockPlugin({ workdir: WORKDIR });
  let threw: any = null;
  try {
    plugin.prepareRun(path.join(TESTS, "workflow-bun-value.ts"), "run-bun-value");
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
  let rc = plugin.startRun(path.join(TESTS, "workflow-bun-type.ts"), runId);
  if (rc === 2) rc = plugin.drive(runId);
  check(rc === 0, `BUN OK: type-only workflow completes (rc ${rc})`);
  const out = plugin.output(runId);
  check(out.includes("label: notes.txt"), `BUN OK: type-only workflow printed the Bun-typed label (got ${JSON.stringify(out.slice(0, 200))})`);
  check(out.includes("done"), "BUN OK: type-only workflow reached done");
}

function testResumeNoReextract(): void {
  console.log("\n=== first-run pipeline: a resumed run never re-extracts ===");
  const runId = "run-resume-no-reextract";
  const plugin = new MockPlugin({ workdir: WORKDIR });
  const cacheDir = path.join(WORKDIR, ".schema-cache");
  // workflow-clock suspends at its first trap (rc 2); drive resumes
  // it from the stored blob. Neither step may re-run the gate or the
  // extraction — the contract was pinned with the run at first run.
  let rc = plugin.startRun(path.join(TESTS, "workflow-clock.ts"), runId);
  check(rc === 2, `RESUME OK: run suspended at the first trap (rc ${rc})`);
  const gatesAfterStart = plugin.gateRuns;
  const entriesAfterStart = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length;
  rc = plugin.drive(runId);
  check(rc === 0, "RESUME OK: drive completed the run");
  check(plugin.gateRuns === gatesAfterStart, `RESUME OK: the resume ran no gate (gateRuns ${plugin.gateRuns})`);
  check(
    fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).length === entriesAfterStart,
    "RESUME OK: the resume added no cache entry — never re-extracted",
  );
  check(plugin.output(runId).includes("done"), "RESUME OK: workflow completed");
}

// ----------------------------------------------------------------------- main
async function main(): Promise<number> {
  fs.mkdirSync(WORKDIR, { recursive: true });
  console.log(`Mock-plugin tests — workdir ${WORKDIR}`);

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
  testResumeNoReextract();

  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS mock-plugin (swap-ported core suite + agentts module workflows + JSON-boundary rule + " +
      "virtual clock + held gate + typed-trap enforcement + repair loop + JSON-clean boundary + " +
      "extraction cache + loud failures + first-run gate pipeline: check, extract, checker, cache, erase, validate)",
  );
  return 0;
}

process.exit(await main());
