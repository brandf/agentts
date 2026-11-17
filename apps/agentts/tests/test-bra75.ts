#!/usr/bin/env bun
/**
 * Crash-recovery test (Linear BRA-75 — G3, the largest BRA-62 gap).
 *
 * Proves the host checks the journal before re-dispatching a trap
 * after a crash, so a trap that already dispatched does not execute
 * a second time:
 *
 *   A. Crash AFTER dispatch (job): the host is killed between
 *      dispatch and resume (the AGENTTS_CRASH_AFTER_DISPATCH hook,
 *      exit 137). Recovery delivers the recorded trap-dispatched
 *      result — exactly ONE job for the trapId, exactly ONE
 *      trap-dispatch and ONE trap-dispatched in the journal, no
 *      re-dispatch.
 *   B. Crash AFTER dispatch (exec): same window, for an exec trap.
 *      The marker file has exactly ONE line after recovery — the
 *      command did not re-run.
 *   C. Crash DURING dispatch (job): the host is SIGKILLed while
 *      the job is running in the pool (the worker is a separate
 *      process and keeps going). Recovery re-dispatches, the pool
 *      dedupes on trapId (job-enqueue-deduped in jobs.log) and
 *      returns the existing job — exactly ONE job for the trapId,
 *      the run completes with that job's result.
 *   D. Crash DURING dispatch (exec): the host is SIGKILLed while
 *      the command sleeps (the marker is already written). The
 *      command re-runs — unavoidable, its output was lost — and
 *      the marker has TWO lines, but the journal shows TWO
 *      trap-dispatch events (the second redispatched: true): the
 *      duplicate is visible, not silent.
 *   E. Sleep remaining time (real clock): the host is SIGKILLed
 *      ~3s into a 6s sleep. Recovery waits only the REMAINING
 *      ~3s (from the trap's journaled wallTs), not the full 6s —
 *      the re-drive takes clearly less than 6s and the run
 *      completes with sleptMs 6000.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra75.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra61 suite.)
 *
 * Run outputs go to $BRA75_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The server + worker + CLI processes are killed
 * in a finally block, even on failure. Exit 0 on PASS, 1 on any
 * mismatch.
 *
 * Recovery (BRA-72, now implemented): after a crash mid-drive the
 * queue entry is durably "running" and runQueue skips every entry
 * whose status is not "queued" (BRA-62 G2). Recovery runs the real
 * `queue repair` command (BRA-72), which re-drives the entry after
 * verifying its state under the driver lock. The fix under test is
 * the journal check, not the queue repair — the repair is only the
 * recovery path.
 *
 * What this does NOT prove (stated plainly): a crash during an
 * exec's spawnSync leaves the child shell orphaned — it keeps
 * sleeping and exits on its own, so the re-run in D is the only
 * option and the marker shows both attempts. And a crash between
 * the gate answer being consumed (takeGateAnswer) and the
 * trap-dispatched write loses that answer — recoverable by
 * re-delivering it, not silently lost forever, but not exercised
 * here (a sub-millisecond window, not worth restructuring the
 * gate flow for).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_BRA75_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

// Lease 30s: generous, so no lease expiry or nudge interferes —
// the jobs here take 2s and 5s, and the test kills the drive
// itself, not the lease.
const LEASE_MS = 30000;

const WORKDIR = process.env.BRA75_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra75-"));
const STATE_DIR = path.join(WORKDIR, "state");
const JOBSPEC_DIR = path.join(WORKDIR, "jobspecs");
const WORKSPACES = path.join(WORKDIR, "workspaces");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(JOBSPEC_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

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

async function http(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER_URL}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(200);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

function readLog(name: string): any[] {
  const p = path.join(STATE_DIR, "worker-jobs", name);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJournal(runId: string): any[] {
  const p = path.join(STATE_DIR, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Drive a run in a child process (the CLI blocks in the adapter's
 * wait loop; this process must stay free to kill it). */
function driveChild(args: string[], env: Record<string, string> = {}): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL, ...env },
  });
}

async function jobsForTrapId(trapId: string): Promise<any[]> {
  const r = await http("GET", "/jobs");
  return (r.body?.jobs ?? []).filter((j: any) => j.trapId === trapId);
}

function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}

/** Repair the stranded queue entry with the real `queue repair`
 * command (BRA-72), then re-drive with `queue run`.
 * clockReal passes --clock real (the sleep scenario's recovery). */
function recover(runId: string, clockReal = false): { rc: number; out: string; err: string; ms: number } {
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  if (repair.rc !== 0 || !repair.out.includes(`REPAIR ${runId}: running -> queued`)) {
    fail(`QUEUE: repair did not re-queue ${runId} (rc ${repair.rc}, out: ${repair.out.trim()} / err: ${repair.err.trim()})`);
    return { rc: 1, out: repair.out, err: repair.err, ms: 0 };
  }
  const args = ["queue", "run"];
  if (clockReal) args.push("--clock", "real");
  args.push("--state-dir", STATE_DIR);
  const t0 = Date.now();
  const r = cli(args);
  return { ...r, ms: Date.now() - t0 };
}

function getResult(runId: string): any | null {
  const r = cli(["result", runId, "--state-dir", STATE_DIR]);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

function trapDispatches(runId: string, trapId: string): any[] {
  return readJournal(runId).filter((e) => e.event === "trap-dispatch" && e.trapId === trapId);
}
function trapDispatched(runId: string, trapId: string): any[] {
  return readJournal(runId).filter((e) => e.event === "trap-dispatched" && e.trapId === trapId);
}

let serverProc: Subprocess | null = null;
const workerProcs: Subprocess[] = [];

async function startServer(): Promise<void> {
  serverProc = spawn(
    [
      BUN,
      path.join(ROOT, "src", "worker-server.ts"),
      "--state-dir",
      STATE_DIR,
      "--port",
      String(PORT),
      "--lease-ms",
      String(LEASE_MS),
      "--max-attempts",
      "3",
      "--jobspec-dir",
      JOBSPEC_DIR,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const up = await waitFor(async () => {
    try {
      const r = await http("GET", "/health");
      return r.status === 200 && r.body?.ok === true;
    } catch {
      return false;
    }
  }, 15_000, "worker server /health");
  if (!up) throw new Error("worker server did not come up");
}

function startLoopWorker(workerId: string, workersJson: string): Subprocess {
  const proc = spawn(
    [
      BUN,
      path.join(ROOT, "plugins", "muse", "worker-loop.ts"),
      "--server",
      SERVER_URL,
      "--worker-id",
      workerId,
      "--workspace-root",
      WORKSPACES,
      "--workers-config",
      workersJson,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  workerProcs.push(proc);
  return proc;
}

function writeInput(name: string, input: unknown): string {
  const p = path.join(WORKDIR, name);
  fs.writeFileSync(p, JSON.stringify(input));
  return p;
}

// ------------------------------------------------------------ A. crash after dispatch (job)
async function testCrashAfterDispatchJob(): Promise<void> {
  console.log("\n=== A. crash AFTER dispatch (job): the recorded result is delivered, no re-dispatch ===");
  const runId = "bra75-a";
  const trapId = "bra75-a/trap-0";
  const inputFile = writeInput("bra75-a-input.json", { sleepMs: 2000 });
  const r = cli(
    [
      "run",
      path.join(ROOT, "tests", "workflows", "workflow-bra75-job.ts"),
      "--run-id",
      runId,
      "--input-file",
      inputFile,
      "--wait",
      "--adapter",
      "muse",
      "--state-dir",
      STATE_DIR,
    ],
    { AGENTTS_CRASH_AFTER_DISPATCH: "1" },
  );
  check(r.rc === 137, `A CRASH OK: drive child exited 137 (got ${r.rc})`);
  const jobs = await jobsForTrapId(trapId);
  check(jobs.length === 1, `A DEDUPE OK: exactly one job for ${trapId} (got ${jobs.length})`);
  check(trapDispatches(runId, trapId).length === 1, `A JOURNAL OK: exactly one trap-dispatch (got ${trapDispatches(runId, trapId).length})`);
  check(trapDispatched(runId, trapId).length === 1, `A JOURNAL OK: exactly one trap-dispatched (got ${trapDispatched(runId, trapId).length})`);
  const rec = recover(runId);
  check(rec.rc === 0, `A RECOVER OK: queue run exited 0 (got ${rec.rc})`);
  if (rec.rc !== 0) fail(`A RECOVER ERR: ${rec.err.slice(0, 300)}`);
  const out = getResult(runId);
  check(out?.sleptMs === 2000, `A RESULT OK: run completed with sleptMs 2000 (got ${JSON.stringify(out)})`);
  const jobs2 = await jobsForTrapId(trapId);
  check(jobs2.length === 1, `A DEDUPE OK: still exactly one job after recovery (got ${jobs2.length})`);
  check(trapDispatches(runId, trapId).length === 1, `A JOURNAL OK: still one trap-dispatch after recovery — no re-dispatch`);
  check(trapDispatched(runId, trapId).length === 1, `A JOURNAL OK: still one trap-dispatched after recovery`);
}

// ------------------------------------------------------------ B. crash after dispatch (exec)
async function testCrashAfterDispatchExec(): Promise<void> {
  console.log("\n=== B. crash AFTER dispatch (exec): the command does not re-run ===");
  const runId = "bra75-b";
  const trapId = "bra75-b/trap-0";
  const markerFile = path.join(WORKDIR, "bra75-b.marker");
  const inputFile = writeInput("bra75-b-input.json", { markerFile, sleepMs: 100 });
  const r = cli(
    [
      "run",
      path.join(ROOT, "tests", "workflows", "workflow-bra75-exec.ts"),
      "--run-id",
      runId,
      "--input-file",
      inputFile,
      "--wait",
      "--adapter",
      "muse",
      "--state-dir",
      STATE_DIR,
    ],
    { AGENTTS_CRASH_AFTER_DISPATCH: "1" },
  );
  check(r.rc === 137, `B CRASH OK: drive child exited 137 (got ${r.rc})`);
  check(markerLines(markerFile) === 1, `B MARKER OK: exactly one line after the crash (got ${markerLines(markerFile)})`);
  check(trapDispatches(runId, trapId).length === 1, `B JOURNAL OK: exactly one trap-dispatch`);
  check(trapDispatched(runId, trapId).length === 1, `B JOURNAL OK: exactly one trap-dispatched`);
  const rec = recover(runId);
  check(rec.rc === 0, `B RECOVER OK: queue run exited 0 (got ${rec.rc})`);
  if (rec.rc !== 0) fail(`B RECOVER ERR: ${rec.err.slice(0, 300)}`);
  const out = getResult(runId);
  check(out?.exitCode === 0, `B RESULT OK: run completed with exitCode 0 (got ${JSON.stringify(out)})`);
  check(markerLines(markerFile) === 1, `B MARKER OK: still one line after recovery — no re-run (got ${markerLines(markerFile)})`);
  check(trapDispatches(runId, trapId).length === 1, `B JOURNAL OK: still one trap-dispatch after recovery — no re-dispatch`);
  check(trapDispatched(runId, trapId).length === 1, `B JOURNAL OK: still one trap-dispatched after recovery`);
}

// ------------------------------------------------------------ C. crash during dispatch (job)
async function testCrashDuringDispatchJob(): Promise<void> {
  console.log("\n=== C. crash DURING dispatch (job): the pool dedupes on trapId, the existing job is adopted ===");
  const runId = "bra75-c";
  const trapId = "bra75-c/trap-0";
  const inputFile = writeInput("bra75-c-input.json", { sleepMs: 5000 });
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra75-job.ts"),
    "--run-id",
    runId,
    "--input-file",
    inputFile,
    "--wait",
    "--adapter",
    "muse",
    "--state-dir",
    STATE_DIR,
  ]);
  try {
    // Wait until the worker has taken the job (it is running in
    // the pool, in a separate process), then kill the drive.
    const running = await waitFor(async () => {
      const jobs = await jobsForTrapId(trapId);
      return jobs.some((j) => j.status === "running");
    }, 20_000, `job ${trapId} running`);
    if (!running) return;
    check(driveProc.exitCode === null, `C KILL OK: drive child still running before the kill`);
    driveProc.kill("SIGKILL");
    await driveProc.exited;
    const jobs = await jobsForTrapId(trapId);
    check(jobs.length === 1, `C DEDUPE OK: exactly one job for ${trapId} (got ${jobs.length})`);
    check(trapDispatches(runId, trapId).length === 1, `C JOURNAL OK: one trap-dispatch from the crashed attempt`);
    check(trapDispatched(runId, trapId).length === 0, `C JOURNAL OK: no trap-dispatched yet (the dispatch never completed)`);
    // Recover — the worker is still running the job; the
    // re-dispatch adopts it via the trapId dedupe.
    const rec = recover(runId);
    check(rec.rc === 0, `C RECOVER OK: queue run exited 0 (got ${rec.rc})`);
    if (rec.rc !== 0) fail(`C RECOVER ERR: ${rec.err.slice(0, 300)}`);
    const out = getResult(runId);
    check(out?.sleptMs === 5000, `C RESULT OK: run completed with the first job's result, sleptMs 5000 (got ${JSON.stringify(out)})`);
    const jobs2 = await jobsForTrapId(trapId);
    check(jobs2.length === 1, `C DEDUPE OK: still exactly one job after recovery (got ${jobs2.length})`);
    const deduped = readLog("jobs.log").some(
      (e) => e.event === "job-enqueue-deduped" && e.jobId === jobs[0]?.jobId,
    );
    check(deduped, `C DEDUPE OK: jobs.log has job-enqueue-deduped for ${jobs[0]?.jobId}`);
    const dispatches = trapDispatches(runId, trapId);
    check(dispatches.length === 2, `C JOURNAL OK: two trap-dispatch events (got ${dispatches.length})`);
    check(dispatches[1]?.redispatched === true, `C JOURNAL OK: second trap-dispatch is redispatched`);
    check(trapDispatched(runId, trapId).length === 1, `C JOURNAL OK: one trap-dispatched (the recovery's)`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ D. crash during dispatch (exec)
async function testCrashDuringDispatchExec(): Promise<void> {
  console.log("\n=== D. crash DURING dispatch (exec): the command re-runs, and the journal shows it ===");
  const runId = "bra75-d";
  const trapId = "bra75-d/trap-0";
  const markerFile = path.join(WORKDIR, "bra75-d.marker");
  const inputFile = writeInput("bra75-d-input.json", { markerFile, sleepMs: 5000 });
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra75-exec.ts"),
    "--run-id",
    runId,
    "--input-file",
    inputFile,
    "--wait",
    "--adapter",
    "muse",
    "--state-dir",
    STATE_DIR,
  ]);
  try {
    // Wait until the marker appears (the echo ran; the shell sleep
    // is now running), then kill the drive.
    const marked = await waitFor(() => markerLines(markerFile) === 1, 20_000, "marker file has 1 line");
    if (!marked) return;
    check(driveProc.exitCode === null, `D KILL OK: drive child still running before the kill`);
    driveProc.kill("SIGKILL");
    await driveProc.exited;
    check(markerLines(markerFile) === 1, `D MARKER OK: one line after the kill (got ${markerLines(markerFile)})`);
    check(trapDispatches(runId, trapId).length === 1, `D JOURNAL OK: one trap-dispatch from the crashed attempt`);
    check(trapDispatched(runId, trapId).length === 0, `D JOURNAL OK: no trap-dispatched yet (the dispatch never completed)`);
    // Recover — the exec re-runs (unavoidable: its output was
    // lost), so the marker gets a second line.
    const rec = recover(runId);
    check(rec.rc === 0, `D RECOVER OK: queue run exited 0 (got ${rec.rc})`);
    if (rec.rc !== 0) fail(`D RECOVER ERR: ${rec.err.slice(0, 300)}`);
    const out = getResult(runId);
    check(out?.exitCode === 0, `D RESULT OK: run completed with exitCode 0 (got ${JSON.stringify(out)})`);
    check(markerLines(markerFile) === 2, `D MARKER OK: two lines after recovery — the re-run happened (got ${markerLines(markerFile)})`);
    const dispatches = trapDispatches(runId, trapId);
    check(dispatches.length === 2, `D JOURNAL OK: two trap-dispatch events (got ${dispatches.length})`);
    check(dispatches[1]?.redispatched === true, `D JOURNAL OK: second trap-dispatch is redispatched — the duplicate is visible, not silent`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ E. sleep remaining time (real clock)
async function testSleepRemaining(): Promise<void> {
  console.log("\n=== E. sleep remaining time (real clock): recovery waits only what is left ===");
  const runId = "bra75-e";
  const trapId = "bra75-e/trap-0";
  const sleepMs = 6000;
  const inputFile = writeInput("bra75-e-input.json", { sleepMs });
  const driveProc = driveChild(
    [
      "run",
      path.join(ROOT, "tests", "workflows", "workflow-bra75-sleep.ts"),
      "--run-id",
      runId,
      "--input-file",
      inputFile,
      "--wait",
      "--adapter",
      "muse",
      "--clock",
      "real",
      "--state-dir",
      STATE_DIR,
    ],
  );
  try {
    // Wait for the sleep trap to suspend (the trap event in the
    // journal), then wait 3s — half the sleep — and kill the drive.
    const trapped = await waitFor(
      () =>
        readJournal(runId).some((e) => e.event === "trap" && e.trapId === trapId),
      20_000,
      `trap ${trapId} in the journal`,
    );
    if (!trapped) return;
    await sleep(3000);
    check(driveProc.exitCode === null, `E KILL OK: drive child still running before the kill`);
    driveProc.kill("SIGKILL");
    await driveProc.exited;
    check(trapDispatches(runId, trapId).length === 1, `E JOURNAL OK: one trap-dispatch from the crashed attempt`);
    check(trapDispatched(runId, trapId).length === 0, `E JOURNAL OK: no trap-dispatched yet (the dispatch never completed)`);
    // Recover with the real clock. The remaining wait is ~3s, so
    // the re-drive takes ~4s (wait + overhead). A full re-wait
    // would take the 6s sleep plus overhead — 6s is the hard floor
    // for a full re-wait, so <6000ms proves the remaining time was
    // used; >2000ms proves the wait was not skipped entirely.
    const rec = recover(runId, true);
    check(rec.rc === 0, `E RECOVER OK: queue run exited 0 (got ${rec.rc})`);
    if (rec.rc !== 0) fail(`E RECOVER ERR: ${rec.err.slice(0, 300)}`);
    check(
      rec.ms > 2000 && rec.ms < 6000,
      `E TIMING OK: re-drive took ${rec.ms}ms (bounds 2000–6000ms — remaining time, not a full re-wait)`,
    );
    const out = getResult(runId);
    check(out?.sleptMs === sleepMs, `E RESULT OK: run completed with sleptMs ${sleepMs} (got ${JSON.stringify(out)})`);
    const dispatches = trapDispatches(runId, trapId);
    check(dispatches.length === 2, `E JOURNAL OK: two trap-dispatch events (got ${dispatches.length})`);
    check(dispatches[1]?.redispatched === true, `E JOURNAL OK: second trap-dispatch is redispatched`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

async function main(): Promise<number> {
  await startServer();
  // The real worker for the job traps (spec bra75-slow ->
  // tests/fixtures/slow-worker.ts). It runs for the whole suite.
  const workersJson = path.join(WORKDIR, "workers.json");
  fs.writeFileSync(
    workersJson,
    JSON.stringify({ "bra75-slow": path.join(ROOT, "tests", "fixtures", "slow-worker.ts") }, null, 2),
  );
  startLoopWorker("w-bra75-real", workersJson);
  try {
    await testCrashAfterDispatchJob();
    await testCrashAfterDispatchExec();
    await testCrashDuringDispatchJob();
    await testCrashDuringDispatchExec();
    await testSleepRemaining();
  } finally {
    for (const p of workerProcs) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
    if (serverProc) {
      try {
        serverProc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }
  const jobs = readLog("jobs.log");
  console.log(`\n--- evidence ---`);
  console.log(`workdir: ${WORKDIR}`);
  console.log(
    `jobs.log events: ${jobs.length} (${jobs.filter((e) => e.event === "job-enqueue-deduped").length} enqueue-deduped)`,
  );
  if (FAILURES.length) {
    console.log(`\nFAIL bra75 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log(
    "\nPASS bra75 crash-recovery suite (journal check before re-dispatch, trapId enqueue dedupe, sleep remaining time)",
  );
  return 0;
}

process.exit(await main());
