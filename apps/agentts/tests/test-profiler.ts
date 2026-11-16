#!/usr/bin/env bun
/**
 * Profiler tests (BRA-30): counters must match hand-counted journal
 * values. Every expected number below was counted by hand from the
 * fixture journals (see tests/fixtures/profiler/README.md); the test
 * asserts the profiler's output against them, it does not trust a
 * green summary line.
 *
 *   bun tests/test-profiler.ts [fixturesDir] [outDir]
 *
 * Fixtures default to tests/fixtures/profiler/. Outputs (text + html
 * profiles, scratch state dir, synthetic journals) go to outDir,
 * defaulting to a mkdtemp dir — never into the staged tree.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadJournalTree,
  loadJournalTreeFromFile,
  profileTree,
  renderTreeText,
  renderTreeHtml,
} from "../src/profiler";

const FIXTURES = process.argv[2] ?? path.join(import.meta.dir, "fixtures", "profiler");
const OUT = process.argv[3] ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra30-profiler."));
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
function eq<T>(got: T, want: T, label: string): void {
  check(Object.is(got, want), `${label} (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
}

function load(runId: string) {
  const tree = loadJournalTree(FIXTURES, runId);
  return { tree, p: profileTree(tree) };
}

function writeOutputs(name: string, tree: ReturnType<typeof loadJournalTree>, p: ReturnType<typeof profileTree>): void {
  const text = renderTreeText(tree, p);
  const html = renderTreeHtml(tree, p);
  fs.writeFileSync(path.join(OUT, `${name}.profile.txt`), text);
  fs.writeFileSync(path.join(OUT, `${name}.profile.html`), html);
  check(text.length > 500, `${name}: text profile non-trivial (${text.length} chars)`);
  check(html.includes("<!doctype html>") && !/https?:\/\//.test(html) && !/<script[^>]*src/.test(html),
    `${name}: html is self-contained (no external URLs/scripts — file:// safe)`);
  check(text.includes("wall durations") && text.includes("unknown"), `${name}: text states the wall-time unknown caveat`);
}

// ---------------------------------------------------------------- JFL mock
{
  const { tree, p } = load("run-jfl-mock");
  // Hand count (main 98 events + 15 branch journals x 8): 98 + 120 = 218.
  eq(p.totalEvents, 218, "JFL: total events");
  eq(p.journalCount, 16, "JFL: journals (root + 15 branches)");
  eq(p.totalTraps, 34, "JFL: total traps");
  eq(p.byType.job?.traps, 23, "JFL: job traps (8 main + 15 branch judges)");
  eq(p.byType.decide?.traps, 11, "JFL: decide traps");
  eq(p.trapResults, 34, "JFL: trap results");
  eq(p.errorCount, 0, "JFL: errors");
  eq(p.forkCount, 5, "JFL: forks (one all() per loop)");
  eq(p.joinCount, 5, "JFL: joins");
  eq(p.branchCount, 15, "JFL: branches (3 judges x 5 loops)");
  eq(p.status, "completed", "JFL: status");
  eq(p.unmatchedTraps.length, 0, "JFL: unmatched traps");
  // Decide choices in trap order: loop1 revise/continue, loop2
  // revise/continue, loop3 keep/update/converged, loop4 keep/converged,
  // loop5 keep/converged.
  const choices = p.traps.filter((t) => t.type === "decide").map((t) => t.resultSummary);
  eq(
    choices.join("|"),
    [
      "choice=revise conf=0.8", "choice=continue conf=0.8",
      "choice=revise conf=0.6500000000000001", "choice=continue conf=0.6500000000000001",
      "choice=keep conf=0.6", "choice=update conf=0.8", "choice=converged conf=0.6",
      "choice=keep conf=0.6", "choice=converged conf=0.6",
      "choice=keep conf=0.6", "choice=converged conf=0.6",
    ].join("|"),
    "JFL: decide choices in order (revise x2, rubric update at loop 3, converge at loop 5)",
  );
  const means = p.traps
    .filter((t) => t.argSummary === "spec=aggregate")
    .map((t) => t.resultSummary);
  eq(means.join("|"),
    "mean=0.55 approved=0 failed=0|mean=0.7 approved=0 failed=0|mean=0.85 approved=2 failed=0|mean=0.85 approved=2 failed=0|mean=0.85 approved=2 failed=0",
    "JFL: aggregate means 0.55, 0.7, 0.85, 0.85, 0.85");
  const rubric = p.traps.find((t) => t.argSummary === "spec=rubric-update");
  check(rubric !== undefined && rubric.resultSummary.includes("concrete example"),
    "JFL: rubric-update at loop 3 adds 'concrete example'");
  check(p.traps.every((t) => t.wallMs === null), "JFL: every trap wallMs is null (no timestamps in journal)");
  check(renderTreeText(tree, p).includes("started → (suspend/resume ×24) → completed"),
    "JFL: lifecycle line compresses 24 suspend/resume pairs");
  writeOutputs("run-jfl-mock", tree, p);
}

// ---------------------------------------------------------------- bugfix
{
  const { tree, p } = load("bugfix-direct-3");
  // Hand count: main 38 events + 3 branch journals x 8 = 62.
  eq(p.totalEvents, 62, "BUGFIX: total events");
  eq(p.journalCount, 4, "BUGFIX: journals");
  eq(p.totalTraps, 11, "BUGFIX: total traps");
  eq(p.byType.job?.traps, 9, "BUGFIX: job traps (6 main + 3 branch judges)");
  eq(p.byType.decide?.traps, 2, "BUGFIX: decide traps");
  eq(p.forkCount, 1, "BUGFIX: forks");
  eq(p.joinCount, 1, "BUGFIX: joins");
  eq(p.branchCount, 3, "BUGFIX: branches");
  eq(p.errorCount, 0, "BUGFIX: errors");
  eq(p.status, "completed", "BUGFIX: status");
  const mainSpecs = p.traps.filter((t) => t.journalRunId === "bugfix-direct-3").map((t) => t.argSummary);
  eq(mainSpecs.join("|"),
    "spec=bugfix-reproduce|spec=bugfix-diagnose|spec=bugfix-fix|spec=aggregate|q=loop 1: mean score 0.98 threshold 0.8; 3 of 3 approved. Should the work item be revised or kept?|q=loop 1: mean score 0.98 threshold 0.8, loops since rubric change 99. Converged?|spec=bugfix-test|spec=bugfix-verify",
    "BUGFIX: main-journal phases reproduce -> diagnose -> fix -> judge -> test -> verify");
  const branchSpecs = p.traps.filter((t) => t.journalRunId !== "bugfix-direct-3").map((t) => t.argSummary);
  eq(branchSpecs.join("|"), "spec=judge|spec=judge|spec=judge", "BUGFIX: 3 branch judges");
  const repro = p.traps.find((t) => t.argSummary === "spec=bugfix-reproduce");
  check(repro?.resultSummary.includes("reproduced=true") && repro.resultSummary.includes("loops=6") && repro.resultSummary.includes("converged=false"),
    "BUGFIX: reproduce result (reproduced, 6 loops, unconverged)");
  const verify = p.traps.find((t) => t.argSummary === "spec=bugfix-verify");
  check(verify?.resultSummary.includes("converged=true") && verify.resultSummary.includes("loops=5") && verify.resultSummary.includes("mean=0.85"),
    "BUGFIX: verify result (converged, 5 loops, mean 0.85)");
  writeOutputs("bugfix-direct-3", tree, p);
}

// ---------------------------------------------------------------- briefing
{
  const { tree, p } = load("briefing-proof3-2026-11-16");
  // Hand count: main 50 events + 22 branch journals x 8 = 226... no:
  // 50 + 176 = 226 events total.
  eq(p.totalEvents, 226, "BRIEFING: total events (50 main + 22x8 branches)");
  eq(p.journalCount, 23, "BRIEFING: journals (root + 22 branches)");
  eq(p.totalTraps, 31, "BRIEFING: total traps");
  eq(p.byType.exec?.traps, 2, "BRIEFING: exec traps (prep + html build)");
  eq(p.byType.job?.traps, 26, "BRIEFING: job traps (4 main + 22 branch reads/relates/judges)");
  eq(p.byType.decide?.traps, 3, "BRIEFING: decide traps");
  eq(p.forkCount, 3, "BRIEFING: forks");
  eq(p.joinCount, 3, "BRIEFING: joins");
  eq(p.branchCount, 22, "BRIEFING: branches (12 reads + 7 relates + 3 judges)");
  eq(p.forks.map((f) => f.branches).join(","), "12,7,3", "BRIEFING: fork sizes 12/7/3");
  eq(p.errorCount, 0, "BRIEFING: errors");
  eq(p.status, "completed", "BRIEFING: status");
  const mainSpecs = p.traps.filter((t) => t.journalRunId === "briefing-proof3-2026-11-16").map((t) => t.argSummary);
  // Actual journal order (the task brief's paraphrase had must-read
  // after relates; the journal has it before render/relates).
  check(mainSpecs[0].startsWith("cmd=bun"), "BRIEFING: trap 0 is exec prep");
  eq(mainSpecs[1], "spec=briefing-discover", "BRIEFING: trap 1 discover");
  check(mainSpecs[2].startsWith("q=must-read selection:"), "BRIEFING: trap 2 must-read decide");
  eq(mainSpecs[3], "spec=briefing-render", "BRIEFING: trap 3 render");
  eq(mainSpecs[4], "spec=aggregate", "BRIEFING: trap 4 JFL aggregate");
  check(mainSpecs[5].startsWith("q=loop 1:"), "BRIEFING: trap 5 revise/keep decide");
  check(mainSpecs[6].startsWith("q=loop 1:") && mainSpecs[6].includes("Converged?"), "BRIEFING: trap 6 converged decide");
  eq(mainSpecs[7], "spec=briefing-write", "BRIEFING: trap 7 write");
  check(mainSpecs[8].startsWith("cmd=") && mainSpecs[8].includes("build_briefings_html.py"), "BRIEFING: trap 8 exec html build");
  const mustRead = p.traps.find((t) => t.argSummary.startsWith("q=must-read selection:"));
  check(mustRead?.resultSummary === "choice=2611.18482 conf=0.99", `BRIEFING: must-read is 2611.18482 (got ${mustRead?.resultSummary})`);
  const write = p.traps.find((t) => t.argSummary === "spec=briefing-write");
  check(write?.resultSummary.includes("ok=true"), "BRIEFING: write ok=true");
  writeOutputs("briefing-proof3-2026-11-16", tree, p);
}

// ---------------------------------------------------------------- clock
{
  const { tree, p } = load("run-clock");
  eq(p.totalEvents, 55, "CLOCK: total events");
  eq(p.totalTraps, 12, "CLOCK: total traps");
  eq(p.byType.sleep?.traps, 2, "CLOCK: sleep traps");
  eq(p.byType.cron?.traps, 4, "CLOCK: cron traps");
  eq(p.byType.clock?.traps, 6, "CLOCK: clock traps");
  eq(p.clock.advances.length, 5, "CLOCK: 5 clock-advances (the past Feb-1 cron fires with no advance)");
  eq(p.clock.totalVirtualMs, 120 * 24 * 3600 * 1000, "CLOCK: total virtual advance is 120 days (Jan 1 -> May 1)");
  eq(p.clock.byReason.sleep?.totalMs, 2 * 3600 * 1000, "CLOCK: sleep advances total 2h virtual");
  eq(p.clock.byReason.cron?.count, 3, "CLOCK: 3 cron advances");
  eq(p.clock.virtualStart, "2027-01-01T00:00:00.000Z", "CLOCK: virtual start");
  eq(p.clock.virtualEnd, "2027-05-01T00:00:00.000Z", "CLOCK: virtual end");
  const sleeps = p.traps.filter((t) => t.type === "sleep");
  check(sleeps.every((t) => t.virtualDeltaMs === 3600000), "CLOCK: each sleep trap's virtual delta is 1h");
  const pastCron = p.traps.find((t) => t.type === "cron" && t.argSummary === "at=2027-02-01T00:00:00Z");
  eq(pastCron?.virtualDeltaMs, 0, "CLOCK: past cron (Feb 1) has virtual delta 0 — it fires immediately");
  check(p.traps.every((t) => t.wallMs === null), "CLOCK: wall durations unknown even though virtual time spans 120 days");
  const text = renderTreeText(tree, p);
  check(text.includes("0ms wall"), "CLOCK: text marks clock-advances as 0ms wall");
  writeOutputs("run-clock", tree, p);
}

// ---------------------------------------------------------------- gate
{
  const { tree, p } = load("run-gate");
  eq(p.totalEvents, 7, "GATE: total events");
  eq(p.totalTraps, 1, "GATE: traps");
  eq(p.gates.length, 1, "GATE: one gate-held event");
  eq(p.gates[0]?.question, "approve?", "GATE: held question");
  eq(p.gates[0]?.holdMs, null, "GATE: hold duration is null (no timestamps)");
  eq(p.gatePending, false, "GATE: not pending — the gate was answered and the run completed");
  eq(p.status, "completed", "GATE: status");
  writeOutputs("run-gate", tree, p);
}

// ------------------------------------------------------- synthetic edge cases
{
  const dir = path.join(OUT, "synthetic");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { event: "lifecycle", lifecycle: "started", runId: "synth" },
    { event: "trap", runId: "synth", trapId: "synth/trap-0", ordinal: 0, type: "job", arg: { spec: "boom" } },
    { event: "trap-error", runId: "synth", trapId: "synth/trap-0", ordinal: 0, error: "worker crashed" },
    { event: "trap", runId: "synth", trapId: "synth/trap-1", ordinal: 1, type: "job", arg: { spec: "never-returns" } },
    { event: "trap", runId: "synth", trapId: "synth/trap-2", ordinal: 2, type: "exec", arg: { cmd: "false", args: [] } },
    { event: "trap-result", runId: "synth", trapId: "synth/trap-2", ordinal: 2, result: { ok: false, error: "exit 1", exitCode: 1 } },
    { event: "validation-error", runId: "synth", trapId: "synth/trap-2", kind: "output" },
    { event: "lifecycle", lifecycle: "failed", runId: "synth" },
  ];
  fs.writeFileSync(path.join(dir, "synth.journal"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const tree = loadJournalTreeFromFile(path.join(dir, "synth.journal"));
  const p = profileTree(tree);
  eq(p.totalTraps, 3, "SYNTH: traps");
  eq(p.errorCount, 2, "SYNTH: errors (trap-error + ok:false result)");
  eq(p.unmatchedTraps.join(","), "synth/trap-1", "SYNTH: unmatched trap listed");
  eq(p.status, "failed", "SYNTH: status failed");
  const t0 = p.traps.find((t) => t.trapId === "synth/trap-0");
  eq(t0?.resultKind, "error", "SYNTH: trap-error marks the trap as error");
  check(renderTreeText(tree, p).includes("VALIDATION-ERROR"), "SYNTH: validation-error renders");
  // Corrupt journal line fails loudly, never silently.
  fs.writeFileSync(path.join(dir, "bad.journal"), "{\"event\":\"lifecycle\"}\n{not json\n");
  let threw = false;
  try {
    loadJournalTreeFromFile(path.join(dir, "bad.journal"));
  } catch {
    threw = true;
  }
  check(threw, "SYNTH: corrupt journal line throws");
}

// ------------------------------------------------- synthetic v2 (BRA-57)
// A journal in format v2: every event carries wallTs, trap-results
// carry adapter/worker/wallMs. Wall durations must be REAL numbers:
// the result's wallMs field wins over the wallTs difference, the
// wallTs difference is the fallback, a gate's hold is result −
// gate-held (not the gate trap's dispatch wallMs), and the total is
// last − first over the root journal.
{
  const dir = path.join(OUT, "synthetic-v2");
  fs.mkdirSync(dir, { recursive: true });
  const T = (s: string) => `2026-11-16T00:00:${s}.000Z`;
  const lines = [
    { event: "lifecycle", lifecycle: "started", runId: "synth-v2", wallTs: T("00") },
    { event: "trap", runId: "synth-v2", trapId: "synth-v2/trap-0", ordinal: 0, type: "job", arg: { spec: "score" }, wallTs: T("00") },
    { event: "trap-result", runId: "synth-v2", trapId: "synth-v2/trap-0", ordinal: 0, result: { score: 0.92, label: "approved" }, adapter: "mock", wallMs: 5, wallTs: "2026-11-16T00:00:00.120Z" },
    { event: "trap", runId: "synth-v2", trapId: "synth-v2/trap-1", ordinal: 1, type: "gate", arg: { question: "approve?" }, wallTs: "2026-11-16T00:00:00.200Z" },
    { event: "gate-held", runId: "synth-v2", trapId: "synth-v2/trap-1", question: "approve?", wallTs: "2026-11-16T00:00:00.250Z" },
    { event: "trap-result", runId: "synth-v2", trapId: "synth-v2/trap-1", ordinal: 1, result: { answer: "yes" }, adapter: "host", wallMs: 1, wallTs: "2026-11-16T00:00:02.250Z" },
    { event: "trap", runId: "synth-v2", trapId: "synth-v2/trap-2", ordinal: 2, type: "job", arg: { spec: "judge" }, wallTs: "2026-11-16T00:00:02.300Z" },
    { event: "trap-result", runId: "synth-v2", trapId: "synth-v2/trap-2", ordinal: 2, result: { score: 0.9 }, adapter: "muse", worker: "worker-7", wallMs: 2800, wallTs: "2026-11-16T00:00:05.300Z" },
    { event: "trap", runId: "synth-v2", trapId: "synth-v2/trap-3", ordinal: 3, type: "exec", arg: { cmd: "echo hi" }, wallTs: "2026-11-16T00:00:05.500Z" },
    // No wallMs field: the wallTs difference (250ms) is the fallback.
    { event: "trap-result", runId: "synth-v2", trapId: "synth-v2/trap-3", ordinal: 3, result: { stdout: "hi\n", exitCode: 0 }, adapter: "direct", wallTs: "2026-11-16T00:00:05.750Z" },
    { event: "lifecycle", lifecycle: "completed", runId: "synth-v2", wallTs: "2026-11-16T00:00:05.800Z" },
  ];
  fs.writeFileSync(path.join(dir, "synth-v2.journal"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const tree = loadJournalTreeFromFile(path.join(dir, "synth-v2.journal"));
  const p = profileTree(tree);
  eq(p.totalWallMs, 5800, "V2: total wall time is last-first wallTs");
  const t0 = p.traps.find((t) => t.trapId === "synth-v2/trap-0");
  eq(t0?.wallMs, 5, "V2: wallMs field wins over the 120ms wallTs difference");
  eq(t0?.adapter, "mock", "V2: trap-0 adapter is mock");
  eq(t0?.worker, null, "V2: canned answer carries no worker");
  const t1 = p.traps.find((t) => t.trapId === "synth-v2/trap-1");
  eq(t1?.wallMs, 1, "V2: gate trap's own wallMs is its final dispatch only");
  eq(p.gates[0]?.holdMs, 2000, "V2: gate hold is result-held wallTs difference");
  const t2 = p.traps.find((t) => t.trapId === "synth-v2/trap-2");
  eq(t2?.wallMs, 2800, "V2: pool job wallMs from the field");
  eq(t2?.worker, "worker-7", "V2: pool job worker identity");
  eq(t2?.adapter, "muse", "V2: pool job adapter is muse");
  const t3 = p.traps.find((t) => t.trapId === "synth-v2/trap-3");
  eq(t3?.wallMs, 250, "V2: missing wallMs falls back to the wallTs difference");
  const text = renderTreeText(tree, p);
  check(text.includes("wall time: 5.8s total"), "V2: text shows the real total wall time");
  check(!text.includes("wall time: UNKNOWN"), "V2: text does not claim wall time unknown");
  check(text.includes("(wall: 5ms)") && text.includes("(wall: 2.8s)"), "V2: trap lines show real wall durations");
  check(text.includes("adapter=mock") && text.includes("worker=worker-7"), "V2: trap lines attribute adapter/worker");
  check(text.includes("held 2s"), "V2: gate-held row shows the measured hold");
}

// ------------------------------------------------------- CLI smoke test
{
  const stateDir = path.join(OUT, "state");
  fs.mkdirSync(path.join(stateDir, "journals"), { recursive: true });
  for (const f of fs.readdirSync(FIXTURES)) {
    if (f.startsWith("bugfix-direct-3") && f.endsWith(".journal")) {
      fs.copyFileSync(path.join(FIXTURES, f), path.join(stateDir, "journals", f));
    }
  }
  const res = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts"),
    "profile", "bugfix-direct-3", "--state-dir", stateDir], { stdout: "pipe", stderr: "pipe" });
  const out = res.stdout.toString();
  check(res.exitCode === 0, `CLI: profile exits 0 (got ${res.exitCode}; stderr: ${res.stderr.toString().slice(0, 200)})`);
  check(out.includes("profile: bugfix-direct-3") && out.includes("traps: 11") && out.includes("spec=bugfix-verify"),
    "CLI: profile text output carries the bugfix counters and phases");
  const resHtml = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts"),
    "profile", "bugfix-direct-3", "--state-dir", stateDir, "--format", "html",
    "--out", path.join(OUT, "cli-bugfix.html")], { stdout: "pipe", stderr: "pipe" });
  check(resHtml.exitCode === 0 && fs.existsSync(path.join(OUT, "cli-bugfix.html")),
    "CLI: profile --format html --out writes the file");
  const resMissing = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts"),
    "profile", "no-such-run", "--state-dir", stateDir], { stdout: "pipe", stderr: "pipe" });
  check(resMissing.exitCode === 1, "CLI: profile of a missing run exits 1");
}

console.log(`\nprofiler outputs in ${OUT}`);
if (failures) {
  console.error(`PROFILER TESTS FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log("PASS profiler (counters match hand-counted journal values)");
