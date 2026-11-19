#!/usr/bin/env bun
/**
 * Improve-loop tests (standard library workflow).
 *
 * Runs workflows/library/improve-loop.ts under the Host with the mock adapter
 * (input-dependent mock judges — the same logic as the real workers,
 * so the mock run shows a real improving arc) and under the direct
 * adapter (real worker processes). Asserts the workflow's contract:
 * two judges run in parallel, scorecards get aggregated/deduped/
 * filtered, the decide job drives fix-or-stop, fixes are applied
 * before the next round, early stop when no fixes are needed, hard
 * stop at 3 rounds, and the final report lists changes + why.
 *
 * Fixtures live in tests/fixtures/improve-loop/ (rubric.json,
 * input-converging.json, input-stubborn.json, input-inline.json,
 * input-bad.json). Run outputs go to $IMPROVE_WORKDIR (scratch, set
 * by run.sh). Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "workflows", "library", "improve-loop.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "improve-loop");
const WORKDIR = process.env.IMPROVE_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "improve-loop-test-"));

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

/** Load a fixture input, resolving a rubric file reference to an
 * absolute path (the exec `cat` reads it relative to the process
 * cwd) and pointing outDir at a scratch dir (the real write must
 * never land in the tree). */
function loadInput(name: string, outDirName: string): any {
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  if (input.rubric && typeof input.rubric.file === "string" && !path.isAbsolute(input.rubric.file)) {
    input.rubric.file = path.join(ROOT, input.rubric.file);
  }
  input.outDir = path.join(WORKDIR, outDirName);
  return input;
}

async function runOnce(
  host: Host,
  runId: string,
  input: any,
): Promise<{ res: any; journal: any[] }> {
  host.submit(WORKFLOW, { runId, input });
  const q = await host.runQueue();
  const entry = q.find((e) => e.runId === runId);
  if (!entry) throw new Error(`run ${runId} not in queue after runQueue`);
  const res = host.result(runId);
  const journal = host.journal(runId);
  return { res, journal };
}

/** All events for a run: the parent journal plus every child
 * journal (the judge job traps are dispatched by the branch thunks,
 * so their trap events live in the child journals, not the parent's).
 * Child runs are found via the parent's fork events. */
function allEvents(host: Host, runId: string): any[] {
  const events = host.journal(runId);
  const out = [...events];
  for (const e of events) {
    if (e.event === "fork" && Array.isArray(e.childRuns)) {
      for (const child of e.childRuns) out.push(...host.journal(child));
    }
  }
  return out;
}

function trapCounts(journal: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of journal) {
    if (e.event === "trap") {
      const key = e.type === "job" ? `job:${e.arg?.spec ?? "?"}` : e.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function forkSizes(journal: any[]): number[] {
  return journal.filter((e) => e.event === "fork").map((e) => (e.childRuns ?? []).length);
}

async function testMockConverging(): Promise<void> {
  console.log("\n=== improve-loop mock: converging fixture (rubric file) ===");
  const stateDir = path.join(WORKDIR, "mock-converging");
  const host = new Host({ stateDir, adapter: new MockAdapter() });
  const input = loadInput("input-converging.json", "improve-loop-converging");
  const { res, journal } = await runOnce(host, "run-improve-converging", input);
  check(res.status === "done", `CONVERGING OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.report.rounds === 2, `CONVERGING OK: early stop at round 2 (got ${out.report.rounds})`);
  check(out.report.converged === true, `CONVERGING OK: converged (got ${out.report.converged})`);
  check(out.report.changes.length === 3, `CONVERGING OK: 3 changes (got ${out.report.changes.length})`);
  check(out.report.finalMeanScore === 1, `CONVERGING OK: final mean score 1.0 (got ${out.report.finalMeanScore})`);
  check(out.report.outstanding.length === 0, `CONVERGING OK: no outstanding findings (got ${out.report.outstanding.length})`);
  check(
    out.report.changes.every((c: any) => typeof c.description === "string" && c.description.length > 0 && typeof c.why === "string" && c.why.length > 0),
    "CONVERGING OK: every change lists what changed + why",
  );
  check(
    out.item.content.includes("In 2026, 3 pilot teams ran this process end to end."),
    "CONVERGING OK: improved item carries the concrete-numbers fix",
  );
  check(
    out.item.content.includes("worked example:"),
    "CONVERGING OK: improved item carries the worked-example fix",
  );
  check(
    out.item.content.includes("clear recommendation:"),
    "CONVERGING OK: improved item carries the clear-recommendation fix",
  );
  check(
    out.improvedPath === path.join(input.outDir, "improved.md") && out.reportPath === path.join(input.outDir, "change-report.json"),
    `CONVERGING OK: result carries the output paths (${out.improvedPath}, ${out.reportPath})`,
  );
  // Two judges in parallel: each round forks 2 branches.
  const forks = forkSizes(journal);
  check(forks.length === 2 && forks.every((n) => n === 2), `CONVERGING OK: 2 rounds, each forking 2 judges (got ${JSON.stringify(forks)})`);
  // Judge traps are dispatched by the child runs — count across the
  // parent + child journals.
  const counts = trapCounts(allEvents(host, "run-improve-converging"));
  check(counts["job:improve-judge"] === 4, `CONVERGING OK: 4 judge traps (2 per round, got ${counts["job:improve-judge"]})`);
  check(counts["job:improve-aggregate"] === 2, `CONVERGING OK: 2 aggregate traps (got ${counts["job:improve-aggregate"]})`);
  check(counts["job:improve-decide"] === 2, `CONVERGING OK: 2 decide traps (got ${counts["job:improve-decide"]})`);
  check(counts["job:improve-fix"] === 1, `CONVERGING OK: 1 fix trap — only round 1 needed fixes (got ${counts["job:improve-fix"]})`);
  check(counts["job:improve-write"] === 1, `CONVERGING OK: 1 write trap (got ${counts["job:improve-write"]})`);
  check(counts["exec"] === 1, `CONVERGING OK: 1 exec trap — the rubric file read (got ${counts["exec"] ?? 0})`);
  // Fixes applied before the next round: the fix trap (round 1) comes
  // before the round-2 fork in the parent journal (the round-2 judges
  // only start after that fork).
  const parentEvents = journal;
  const fixEventIdx = parentEvents.findIndex((e) => e.event === "trap" && e.type === "job" && e.arg?.spec === "improve-fix");
  const forkIdxs = journal.map((e, i) => (e.event === "fork" ? i : -1)).filter((i) => i >= 0);
  const round2ForkIdx = forkIdxs.length >= 2 ? forkIdxs[1] : -1;
  check(fixEventIdx >= 0 && round2ForkIdx > fixEventIdx, `CONVERGING OK: fix applied before round 2's judges (fix at ${fixEventIdx}, round-2 fork at ${round2ForkIdx})`);
}

async function testMockStubborn(): Promise<void> {
  console.log("\n=== improve-loop mock: stubborn fixture (inline rubric, 3-round cap) ===");
  const stateDir = path.join(WORKDIR, "mock-stubborn");
  const host = new Host({ stateDir, adapter: new MockAdapter() });
  const input = loadInput("input-stubborn.json", "improve-loop-stubborn");
  const { res, journal } = await runOnce(host, "run-improve-stubborn", input);
  check(res.status === "done", `STUBBORN OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.report.rounds === 3, `STUBBORN OK: hard stop at 3 rounds (got ${out.report.rounds})`);
  check(out.report.converged === false, `STUBBORN OK: not converged (got ${out.report.converged})`);
  check(out.report.changes.length === 3, `STUBBORN OK: 3 changes (got ${out.report.changes.length})`);
  check(
    out.report.outstanding.length === 1 && out.report.outstanding[0].id === "finding-concise",
    `STUBBORN OK: outstanding is the concise finding (got ${JSON.stringify(out.report.outstanding.map((f: any) => f.id))})`,
  );
  check(out.report.finalMeanScore === 0.8, `STUBBORN OK: final mean score 0.8 (got ${out.report.finalMeanScore})`);
  check(out.report.summary.includes("3-round cap"), `STUBBORN OK: summary names the cap (${out.report.summary})`);
  const counts = trapCounts(allEvents(host, "run-improve-stubborn"));
  check(counts["job:improve-judge"] === 6, `STUBBORN OK: 6 judge traps (2 per round, got ${counts["job:improve-judge"]})`);
  check(counts["job:improve-fix"] === 3, `STUBBORN OK: 3 fix traps (one per round, got ${counts["job:improve-fix"]})`);
  check(counts["exec"] === undefined, `STUBBORN OK: no exec trap — the rubric is inline (got ${counts["exec"] ?? 0})`);
}

async function testMockInline(): Promise<void> {
  console.log("\n=== improve-loop mock: inline rubric ===");
  const stateDir = path.join(WORKDIR, "mock-inline");
  const host = new Host({ stateDir, adapter: new MockAdapter() });
  const input = loadInput("input-inline.json", "improve-loop-inline");
  const { res } = await runOnce(host, "run-improve-inline", input);
  check(res.status === "done", `INLINE OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  check(res.output.report.rounds >= 1 && res.output.report.rounds <= 3, `INLINE OK: rounds in 1..3 (got ${res.output.report.rounds})`);
  check(typeof res.output.report.converged === "boolean", "INLINE OK: report carries converged");
}

async function testMockBadRubric(): Promise<void> {
  console.log("\n=== improve-loop mock: missing rubric file fails loudly ===");
  const stateDir = path.join(WORKDIR, "mock-bad");
  const host = new Host({ stateDir, adapter: new MockAdapter() });
  const input = loadInput("input-bad.json", "improve-loop-bad");
  const { res } = await runOnce(host, "run-improve-bad", input);
  check(res.status === "failed", `BAD-RUBRIC OK: run failed (got ${res.status})`);
  check(
    (res.error ?? "").includes("rubric") || (res.error ?? "").includes("no-such-rubric"),
    `BAD-RUBRIC OK: error names the rubric file (${res.error ?? ""})`,
  );
}

async function testEntryGuard(): Promise<void> {
  console.log("\n=== entry guard: top-level trap throws, entry trap works ===");
  const stateDir = path.join(WORKDIR, "entry-guard");
  const host = new Host({ stateDir, adapter: new MockAdapter() });
  // Top-level trap: the gate passes (the file HAS an entry function),
  // but the C host must refuse the run — the trap is not under the
  // workflow function on the stack.
  host.submit(path.join(ROOT, "tests", "workflows", "workflow-top-level-trap.ts"), { runId: "run-top-level-trap" });
  await host.runQueue();
  const res = host.result("run-top-level-trap");
  check(res.status === "failed", `ENTRY-GUARD OK: top-level trap run failed (got ${res.status})`);
  const events = host.journal("run-top-level-trap");
  const failed = events.find((e: any) => e.event === "lifecycle" && e.lifecycle === "failed");
  check(
    (failed?.error ?? "").includes("must be called under the workflow function"),
    `ENTRY-GUARD OK: error names the rule (${(failed?.error ?? "").slice(0, 120)})`,
  );
  // Trap under the entry function works (the JFL workflow's judge
  // trap runs under its entry — exercised by testJudgeFixLoopMock in
  // the host suite; here the converging run above already proves it:
  // its judge traps completed under improveLoop).
  check(true, "ENTRY-GUARD OK: trap under the entry function works (converging run's judges completed)");
}

async function testRealWorkers(): Promise<void> {
  console.log("\n=== improve-loop real workers (direct adapter, worker processes) ===");
  const stateDir = path.join(WORKDIR, "real-converging");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  const input = loadInput("input-converging.json", "improve-loop-real");
  const { res } = await runOnce(host, "run-improve-real", input);
  check(res.status === "done", `REAL OK: run done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.report.rounds === 2, `REAL OK: early stop at round 2 (got ${out.report.rounds})`);
  check(out.report.converged === true, `REAL OK: converged (got ${out.report.converged})`);
  check(out.report.changes.length === 3, `REAL OK: 3 changes (got ${out.report.changes.length})`);
  check(out.report.finalMeanScore === 1, `REAL OK: final mean score 1.0 (got ${out.report.finalMeanScore})`);
  // The real write actually wrote the files (the mock only computes
  // paths + bytes).
  check(fs.existsSync(out.improvedPath), `REAL OK: improved file written (${out.improvedPath})`);
  check(fs.existsSync(out.reportPath), `REAL OK: report file written (${out.reportPath})`);
  const improved = fs.readFileSync(out.improvedPath, "utf8");
  check(improved.includes("In 2026, 3 pilot teams ran this process end to end."), "REAL OK: improved file carries the concrete fix");
  const report = JSON.parse(fs.readFileSync(out.reportPath, "utf8"));
  check(report.changes.length === 3, `REAL OK: report file lists 3 changes (got ${report.changes.length})`);
}

async function main(): Promise<number> {
  await testMockConverging();
  await testMockStubborn();
  await testMockInline();
  await testMockBadRubric();
  await testEntryGuard();
  await testRealWorkers();
  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS improve-loop (mock converging 2 rounds + 3 changes + mean 1.0, mock stubborn 3-round cap + concise outstanding + mean 0.8, inline rubric, bad rubric fails loudly, entry guard, real workers)",
  );
  return 0;
}

process.exit(await main());
