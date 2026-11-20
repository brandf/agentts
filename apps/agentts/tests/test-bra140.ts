#!/usr/bin/env bun
/**
 * Improve-loop CLI+direct e2e test (Linear BRA-140).
 *
 * Automates the manual procedure in
 * `workflows/library/improve-loop.INTEGRATION-TEST.md` — the only
 * CLI+direct e2e proof of improve-loop; `tests/test-improve-loop.ts`
 * covers it via mock + direct (Host API) but has 0 `cli.ts`
 * mentions. The procedure is automated exactly as documented
 * (submit → `queue run` → `result`, plus the `--wait` variant, the
 * converging fixture and the stubborn fixture), with ONE deviation,
 * recorded here rather than silently made:
 *
 *   The doc submits the fixture as-is (`--input-file
 *   tests/fixtures/improve-loop/input-converging.json`), whose
 *   `outDir` is the relative `.agentts-scratch/improve-loop-...`.
 *   Under the CLI that write would land in the tree's
 *   `.agentts-scratch/` — wrong for a committed test in `run.sh`.
 *   This test resolves the fixture first, exactly the way
 *   `tests/test-improve-loop.ts`'s `loadInput` does: the rubric
 *   file reference becomes an absolute path (the exec `cat` reads
 *   it relative to the process cwd) and `outDir` points at a
 *   scratch dir under the test workdir. The commands, the
 *   fixtures, and every check are otherwise the doc's.
 *
 * What this proves, through the real usage path:
 *   A. Converging fixture: submit prints `RUN <runId>` and exits
 *      immediately; `queue run` prints `done`; `result` is the
 *      ImproveLoopResult — 2 rounds (early stop), 3 changes each
 *      with a description and a why, the improved file contains
 *      the three fix sentences, `change-report.json` exists and
 *      its changes match the result's, and the journal shows 2
 *      fork events (2 child runs each — the two parallel judges)
 *      with the fix trap between round 1's judges and round 2's.
 *   B. `--wait` variant: the same path, blocking — prints the
 *      ImproveLoopResult JSON, exit 0.
 *   C. Stubborn fixture: the 3-round cap is honored exactly —
 *      3 rounds, not converged, outstanding is exactly the
 *      concise finding, final mean 0.8, and no 4th round runs.
 *   D. `result` on a pending run prints its status instead of
 *      failing.
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The journal is read through a read-only in-process Host over
 *   the same state dir (construction drives nothing); the runs
 *   themselves are driven only by CLI subprocesses.
 * - The improve-loop's job workers are real worker processes
 *   spawned by the direct adapter; the rubric file is read for
 *   real (`cat` via the direct adapter's exec); the write job
 *   writes real files.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   bun tests/test-bra140.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "workflows", "library", "improve-loop.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "improve-loop");
const WORKDIR = process.env.BRA140_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra140-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

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
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

let server: Subprocess | null = null;
async function startServer(): Promise<void> {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("bra140 server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
}

function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}
function queueStatus(runId: string): string | null {
  return readQueue().find((e) => e.runId === runId)?.status ?? null;
}

/** Read-only journal access through an in-process Host over the
 * same state dir. Constructing a Host drives nothing. */
function readHost(): Host {
  return new Host({ stateDir: STATE_DIR });
}

/** Resolve a fixture the way test-improve-loop.ts's loadInput does:
 * rubric file reference to an absolute path, outDir to a scratch
 * dir. The doc's literal relative outDir would write into the
 * tree's .agentts-scratch/ — see the header. */
function loadInput(name: string, outDirName: string): { file: string; input: any } {
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  if (input.rubric && typeof input.rubric.file === "string" && !path.isAbsolute(input.rubric.file)) {
    input.rubric.file = path.join(ROOT, input.rubric.file);
  }
  input.outDir = path.join(WORKDIR, outDirName);
  const file = path.join(WORKDIR, name);
  fs.writeFileSync(file, JSON.stringify(input, null, 2));
  return { file, input };
}

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

function parseResultJson(res: { rc: number; out: string; err: string }, runId: string): any | null {
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 200)})`);
  try {
    return JSON.parse(res.out);
  } catch {
    fail(`RESULT OK: result prints parseable JSON for ${runId} (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

async function main(): Promise<number> {
  await startServer();
  try {
    // D. result on a pending run prints its status instead of failing.
    console.log("\n=== D. result on a pending run ===");
    {
      const { file } = loadInput("input-converging.json", "improve-loop-pending");
      const runId = "run-bra140-pending";
      const sub = cli(["run", WORKFLOW, "--run-id", runId, "--adapter", "direct", "--input-file", file, "--state-dir", STATE_DIR]);
      check(sub.rc === 0, `PENDING OK: submit exits 0 (got ${sub.rc})`);
      check(sub.out.includes(`RUN ${runId}`), `PENDING OK: submit prints RUN ${runId} before the run completes`);
      const res = cli(["result", runId, "--state-dir", STATE_DIR]);
      check(res.rc === 0, `PENDING OK: result on a pending run exits 0, not 1 (got ${res.rc})`);
      check(res.out.startsWith(`run ${runId}:`), `PENDING OK: result prints the run status (${JSON.stringify(res.out.slice(0, 80))})`);
      // Drive it away so the state dir is clean for the next sections.
      const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
      check(drive.rc === 0 && queueStatus(runId) === "done", `PENDING OK: the pending run drives to done afterwards (got ${queueStatus(runId) ?? "missing"})`);
    }

    // A. Converging fixture, submit → queue run → result.
    console.log("\n=== A. converging fixture (submit, queue run, result) ===");
    {
      const { file, input } = loadInput("input-converging.json", "improve-loop-converging");
      const runId = "run-bra140-converging";
      const sub = cli(["run", WORKFLOW, "--run-id", runId, "--adapter", "direct", "--input-file", file, "--state-dir", STATE_DIR]);
      check(sub.rc === 0, `CONVERGING OK: submit exits 0 (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
      check(sub.out.includes(`RUN ${runId}`), `CONVERGING OK: submit prints RUN ${runId}`);
      const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
      check(drive.rc === 0, `CONVERGING OK: queue run exits 0 (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 200)})`);
      check(queueStatus(runId) === "done", `CONVERGING OK: run done (got ${queueStatus(runId) ?? "missing"})`);
      const out = parseResultJson(cli(["result", runId, "--state-dir", STATE_DIR]), runId);
      if (out) {
        check(out.report.rounds === 2, `CONVERGING OK: early stop at round 2 (got ${out.report.rounds})`);
        check(out.report.converged === true, `CONVERGING OK: converged (got ${out.report.converged})`);
        check(out.report.changes.length === 3, `CONVERGING OK: 3 changes (got ${out.report.changes.length})`);
        check(out.report.finalMeanScore === 1, `CONVERGING OK: final mean score 1.0 (got ${out.report.finalMeanScore})`);
        check(
          out.report.changes.every((c: any) => typeof c.description === "string" && c.description.length > 0 && typeof c.why === "string" && c.why.length > 0),
          "CONVERGING OK: every change lists what changed + why",
        );
        check(
          out.improvedPath === path.join(input.outDir, "improved.md") && out.reportPath === path.join(input.outDir, "change-report.json"),
          `CONVERGING OK: result carries the output paths (${out.improvedPath}, ${out.reportPath})`,
        );
        check(fs.existsSync(out.improvedPath), `CONVERGING OK: improved file written (${out.improvedPath})`);
        if (fs.existsSync(out.improvedPath)) {
          const improved = fs.readFileSync(out.improvedPath, "utf8");
          check(improved.includes("In 2026, 3 pilot teams ran this process end to end."), "CONVERGING OK: improved file carries the concrete-numbers fix");
          check(improved.includes("worked example:"), "CONVERGING OK: improved file carries the worked-example fix");
          check(improved.includes("clear recommendation:"), "CONVERGING OK: improved file carries the clear-recommendation fix");
        }
        check(fs.existsSync(out.reportPath), `CONVERGING OK: change-report.json written (${out.reportPath})`);
        if (fs.existsSync(out.reportPath)) {
          const report = JSON.parse(fs.readFileSync(out.reportPath, "utf8"));
          check(
            JSON.stringify(report.changes) === JSON.stringify(out.report.changes),
            "CONVERGING OK: report file's changes match the result's report.changes",
          );
        }
      }
      const host = readHost();
      const journal = host.journal(runId);
      const forks = journal.filter((e) => e.event === "fork");
      check(forks.length === 2, `CONVERGING OK: 2 fork events (got ${forks.length})`);
      check(forks.every((f) => (f.childRuns ?? []).length === 2), `CONVERGING OK: each fork has 2 child runs — the two parallel judges (got ${JSON.stringify(forks.map((f) => (f.childRuns ?? []).length))})`);
      const fixIdx = journal.findIndex((e) => e.event === "trap" && e.type === "job" && e.arg?.spec === "improve-fix");
      const forkIdxs = journal.map((e, i) => (e.event === "fork" ? i : -1)).filter((i) => i >= 0);
      check(fixIdx >= 0 && forkIdxs.length >= 2 && forkIdxs[1] > fixIdx, `CONVERGING OK: fix trap sits between round 1's judges and round 2's (fix at ${fixIdx}, round-2 fork at ${forkIdxs[1] ?? -1})`);
      const counts = trapCounts(allEvents(host, runId));
      check(counts["job:improve-judge"] === 4, `CONVERGING OK: 4 judge traps (2 per round, got ${counts["job:improve-judge"]})`);
      check(counts["job:improve-fix"] === 1, `CONVERGING OK: 1 fix trap — only round 1 needed fixes (got ${counts["job:improve-fix"]})`);
      check(counts["exec"] === 1, `CONVERGING OK: 1 exec trap — the rubric file read (got ${counts["exec"] ?? 0})`);
    }

    // B. --wait variant, same path, blocking.
    console.log("\n=== B. --wait variant ===");
    {
      const { file } = loadInput("input-converging.json", "improve-loop-wait");
      const runId = "run-bra140-wait";
      const r = cli(["run", WORKFLOW, "--run-id", runId, "--adapter", "direct", "--input-file", file, "--state-dir", STATE_DIR, "--wait"]);
      check(r.rc === 0, `WAIT OK: --wait run exits 0 (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      let out: any = null;
      try {
        out = JSON.parse(r.out);
      } catch {
        fail(`WAIT OK: --wait prints the ImproveLoopResult JSON (got ${JSON.stringify(r.out.slice(0, 200))})`);
      }
      if (out) {
        check(out.report.rounds === 2, `WAIT OK: --wait result is the converging result, 2 rounds (got ${out.report.rounds})`);
        check(out.report.converged === true, `WAIT OK: --wait result converged (got ${out.report.converged})`);
        check(out.report.changes.length === 3, `WAIT OK: --wait result has 3 changes (got ${out.report.changes.length})`);
      }
      check(queueStatus(runId) === "done", `WAIT OK: --wait run is done (got ${queueStatus(runId) ?? "missing"})`);
    }

    // C. Stubborn fixture: the 3-round cap, exactly.
    console.log("\n=== C. stubborn fixture (3-round cap) ===");
    {
      const { file } = loadInput("input-stubborn.json", "improve-loop-stubborn");
      const runId = "run-bra140-stubborn";
      const sub = cli(["run", WORKFLOW, "--run-id", runId, "--adapter", "direct", "--input-file", file, "--state-dir", STATE_DIR]);
      check(sub.rc === 0, `STUBBORN OK: submit exits 0 (got ${sub.rc})`);
      const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
      check(drive.rc === 0, `STUBBORN OK: queue run exits 0 (got ${drive.rc})`);
      check(queueStatus(runId) === "done", `STUBBORN OK: run done (got ${queueStatus(runId) ?? "missing"})`);
      const out = parseResultJson(cli(["result", runId, "--state-dir", STATE_DIR]), runId);
      if (out) {
        check(out.report.rounds === 3, `STUBBORN OK: hard stop at 3 rounds (got ${out.report.rounds})`);
        check(out.report.converged === false, `STUBBORN OK: not converged (got ${out.report.converged})`);
        check(
          out.report.outstanding.length === 1 && out.report.outstanding[0].id === "finding-concise",
          `STUBBORN OK: outstanding is exactly the concise finding (got ${JSON.stringify(out.report.outstanding.map((f: any) => f.id))})`,
        );
        check(out.report.finalMeanScore === 0.8, `STUBBORN OK: final mean score 0.8 (got ${out.report.finalMeanScore})`);
      }
      const host = readHost();
      const counts = trapCounts(allEvents(host, runId));
      check(counts["job:improve-fix"] === 3, `STUBBORN OK: 3 fix traps (one per round — no 4th round, got ${counts["job:improve-fix"]})`);
      check(counts["job:improve-judge"] === 6, `STUBBORN OK: 6 judge traps (2 per round, got ${counts["job:improve-judge"]})`);
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA140 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra140 improve-loop CLI+direct e2e (doc procedure automated: submit, queue run, result, --wait, converging 2 rounds + 3 changes, stubborn 3-round cap at 0.8, pending result prints status)");
  return 0;
}

process.exit(await main());
