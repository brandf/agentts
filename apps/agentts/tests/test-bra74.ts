// BRA-74: G1 + G11 + G14 — resume from last blob, durable sleep, adapter timeout.
//
// Proves, end to end through the CLI (fresh processes, real C host, real on-disk state):
//   A. G1 in-process: the C host is SIGKILLed mid-slice (resume slice, after the exec trap was
//      dispatched). The run resumes from its last intact blob and completes — the exec is NOT
//      re-dispatched (the BRA-75 journal check re-delivers its recorded answer) and the busy
//      loop re-executes from the blob. The journal carries host-crash + host-crash-resumed.
//   B. G1 repair: a run whose registry records a C-host crash (rc 1, no lifecycle event) is
//      re-queued by `queue repair` (not failed, not left-running) and completes on re-drive.
//   C. G11 durable sleep deadline: the sleep deadline is recorded durably at dispatch
//      (sleep-deadline event); a host killed mid-sleep resumes from the recorded deadline —
//      the re-drive waits only the remainder, and the deadline event is reused, not re-recorded.
//   D. G14 adapter timeout: deriveJobTimeoutMs exceeds leaseMs x maxAttempts, and the muse
//      adapter derives its job timeout from the server's /health — a never-settling job fails
//      with JobTimeout in ~lease x attempts + margin, not after the old fixed 600s default.
//   E. G1 first slice: the C host is SIGKILLed mid-slice on the FIRST slice (no blob yet).
//      startRunFrom retries the run from scratch and it completes.
//
// The C host is killed by finding the drive child's durablets child (ps --ppid) and SIGKILLing
// it once. The busy loop (~80M iterations, ~4.5s in QuickJS on this VM — calibrated) keeps the
// slice alive long enough for the kill to land. Killing the C host is a real crash: spawnSync
// returns status null, the host sees rc 1 with no lifecycle event, and the G1 path engages.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { deriveJobTimeoutMs } from "../plugins/muse/src/muse-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_BRA74_TEST_PORT ?? String(21000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const WORKDIR = process.env.BRA74_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra74-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

// Busy-loop iterations for the crash workflows (~4.5s per slice in QuickJS — calibrated;
// the kill window is the whole loop, so the parent polls every 50ms and lands well inside it).
const LOOP_ITERATIONS = 80_000_000;

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

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Drive a run in a child process (this process must stay free to kill the C host). */
function driveChild(args: string[], env: Record<string, string> = {}): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
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

function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
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
function getResultError(runId: string): string {
  const r = cli(["result", runId, "--state-dir", STATE_DIR]);
  return (r.err || r.out || "").trim();
}

function trapDispatches(runId: string, trapId: string): any[] {
  return readJournal(runId).filter((e) => e.event === "trap-dispatch" && e.trapId === trapId);
}
function trapDispatched(runId: string, trapId: string): any[] {
  return readJournal(runId).filter((e) => e.event === "trap-dispatched" && e.trapId === trapId);
}
function readOut(runId: string): string {
  const p = path.join(STATE_DIR, "slices", `${runId}.out`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function writeInput(name: string, input: unknown): string {
  const p = path.join(WORKDIR, name);
  fs.writeFileSync(p, JSON.stringify(input));
  return p;
}

function submit(workflow: string, runId: string, input: unknown, adapter = "direct"): string {
  const inputFile = writeInput(`${runId}.input.json`, input);
  const r = cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", adapter, "--state-dir", STATE_DIR]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
  return runId;
}

/** The drive child's durablets child PIDs (the C host processes it spawned). */
function hostChildPids(proc: Subprocess): number[] {
  if (proc.pid === undefined) return [];
  const r = spawnSync("ps", ["--ppid", String(proc.pid), "-o", "pid=,args="], { encoding: "utf8" });
  const pids: number[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2].includes("durablets")) pids.push(Number(m[1]));
  }
  return pids;
}

/** SIGKILL the drive child's C host once (the currently-running slice), polling until it appears.
 * Returns the killed pid, or null when no C host appeared within the timeout. Kills exactly once:
 * the re-drive after a G1 resume spawns a new C host that must NOT be killed. */
async function killHostChildOnce(proc: Subprocess, timeoutMs = 15_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = hostChildPids(proc);
    if (pids.length) {
      try {
        process.kill(pids[0], "SIGKILL");
      } catch {
        /* already gone */
      }
      return pids[0];
    }
    await sleep(50);
  }
  return null;
}

async function waitExit(proc: Subprocess, timeoutMs: number, what: string): Promise<number | null> {
  const exited = await waitFor(() => proc.exitCode !== null, timeoutMs, what);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    return null;
  }
  return proc.exitCode;
}

// ------------------------------------------------------------ A. G1 resume-slice crash
async function testResumeSliceCrash(): Promise<void> {
  console.log("\n=== A. G1: C host killed mid-slice (resume) — run resumes from its last blob ===");
  const runId = "bra74-a";
  const trapId = "bra74-a/trap-0";
  const marker = path.join(WORKDIR, "bra74-a.marker");
  const inputFile = writeInput("bra74-a-input.json", { markerFile: marker, iterations: LOOP_ITERATIONS });
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra74-crash.ts"),
    "--run-id",
    runId,
    "--input-file",
    inputFile,
    "--wait",
    "--adapter",
    "direct",
    "--state-dir",
    STATE_DIR,
  ]);
  try {
    // Wait for the exec trap to be dispatched (the resume slice starts right after), then kill
    // the C host mid-loop. The loop lasts ~4.5s; the poll lands well inside it.
    const dispatched = await waitFor(
      () => trapDispatched(runId, trapId).length >= 1,
      20_000,
      `exec ${trapId} dispatched`,
    );
    if (!dispatched) return;
    const killed = await killHostChildOnce(driveProc);
    check(killed !== null, `A KILL OK: C host (pid ${killed}) SIGKILLed mid-slice during the resume`);
    const rc = await waitExit(driveProc, 60_000, "drive child exits after the G1 resume");
    check(rc === 0, `A DRIVE OK: drive child exited 0 after the crash + resume (got ${rc})`);
    const out = getResult(runId);
    check(
      out?.marker === "bra74-crash" && out?.looped === true && out?.count === LOOP_ITERATIONS,
      `A RESULT OK: run completed with the loop run to the end (got ${JSON.stringify(out)})`,
    );
    check(queueStatus(runId) === "done", `A QUEUE OK: ${runId} done (got ${queueStatus(runId)})`);
    const crashes = readJournal(runId).filter((e) => e.event === "host-crash");
    check(crashes.length === 1, `A JOURNAL OK: exactly one host-crash event (got ${crashes.length})`);
    check(
      crashes[0]?.slice === "resume" && crashes[0]?.signal === "SIGKILL",
      `A JOURNAL OK: host-crash is the resume slice, signal SIGKILL (got ${JSON.stringify(crashes[0])?.slice(0, 200)})`,
    );
    const resumed = readJournal(runId).filter((e) => e.event === "host-crash-resumed");
    check(resumed.length === 1, `A JOURNAL OK: exactly one host-crash-resumed event (got ${resumed.length})`);
    check(
      resumed[0]?.trapId === trapId,
      `A JOURNAL OK: host-crash-resumed names the exec trap ${trapId} (got ${resumed[0]?.trapId})`,
    );
    check(trapDispatches(runId, trapId).length === 1, `A DEDUPE OK: exec dispatched exactly once (got ${trapDispatches(runId, trapId).length})`);
    check(trapDispatched(runId, trapId).length === 1, `A DEDUPE OK: exactly one trap-dispatched (got ${trapDispatched(runId, trapId).length})`);
    check(markerLines(marker) === 1, `A MARKER OK: exec ran exactly once (got ${markerLines(marker)} line(s))`);
    check(
      readOut(runId).includes(`loop-done: ${LOOP_ITERATIONS}`),
      `A OUT OK: the loop ran to the end in the re-drive (loop-done ${LOOP_ITERATIONS} in .out)`,
    );
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ B. G1 repair path
async function testRepairAfterCrash(): Promise<void> {
  console.log("\n=== B. G1: registry records a C-host crash (rc 1) — repair re-queues, run completes ===");
  const runId = "bra74-b";
  const trapId = "bra74-b/trap-0";
  const marker = path.join(WORKDIR, "bra74-b.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, {
    markerFile: marker,
    sleepMs: 2000,
  });
  // Strand it: drive in a child, wait for the exec to dispatch (marker written — the run is
  // suspended with a registry entry rc 2 and a blob on disk), then SIGKILL the driver.
  const child = driveChild(["queue", "run", "--adapter", "direct", "--state-dir", STATE_DIR]);
  try {
    const flipped = await waitFor(() => queueStatus(runId) === "running", 10_000, `${runId} entry -> running`);
    check(flipped, `B STRAND OK: ${runId} entry flipped to running before the kill`);
    const dispatched = await waitFor(() => markerLines(marker) >= 1, 10_000, `${runId} marker written (exec dispatched)`);
    check(dispatched, `B STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
    child.kill(9);
    await child.exited;
    check(queueStatus(runId) === "running", `B STRAND OK: ${runId} entry still "running" after the kill`);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  // Simulate the recorded C-host crash: the registry entry's rc becomes 1 (the slice crashed,
  // no lifecycle event — the journal has none). The blob stays on disk.
  const regPath = path.join(STATE_DIR, "runs", `${runId}.json`);
  check(fs.existsSync(regPath), `B SETUP OK: registry file exists for ${runId} before the rc edit`);
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  check(reg.rc === 2, `B SETUP OK: registry rc is 2 (suspended) before the edit (got ${reg.rc})`);
  reg.rc = 1;
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  check(
    JSON.parse(fs.readFileSync(regPath, "utf8")).rc === 1,
    `B SETUP OK: registry rc edited to 1 (recorded C-host crash)`,
  );
  check(
    fs.existsSync(path.join(STATE_DIR, "blobs", `${runId}.snap`)),
    `B SETUP OK: snapshot blob on disk for ${runId}`,
  );
  const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0, `B REPAIR OK: queue repair exited 0 (got ${repair.rc})`);
  check(
    repair.out.includes(`REPAIR ${runId}: running -> queued`) && repair.out.includes("C-host crash"),
    `B REPAIR OK: repair re-queued the crashed run (out: ${repair.out.trim().slice(0, 300)})`,
  );
  const r = cli(["queue", "run", "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(r.rc === 0, `B DRIVE OK: queue run exited 0 (got ${r.rc})`);
  const out = getResult(runId);
  check(
    out?.exitCode === 0 && typeof out?.stdout === "string" && out.stdout.includes("done"),
    `B RESULT OK: run completed with the exec output (got ${JSON.stringify(out)?.slice(0, 200)})`,
  );
  check(queueStatus(runId) === "done", `B QUEUE OK: ${runId} done (got ${queueStatus(runId)})`);
  // The first dispatch never completed (driver killed mid-exec), so the re-drive re-dispatches
  // it — the exec is not idempotent, and the re-run is visible (2 marker lines, 2 dispatches
  // with the second marked redispatched), not silent.
  check(markerLines(marker) === 2, `B MARKER OK: exec ran twice — once per dispatch attempt (got ${markerLines(marker)})`);
  check(trapDispatches(runId, trapId).length === 2, `B JOURNAL OK: two trap-dispatch events (got ${trapDispatches(runId, trapId).length})`);
  check(
    trapDispatches(runId, trapId)[1]?.redispatched === true,
    `B JOURNAL OK: second trap-dispatch is redispatched`,
  );
  check(trapDispatched(runId, trapId).length === 1, `B JOURNAL OK: exactly one trap-dispatched (got ${trapDispatched(runId, trapId).length})`);
}

// ------------------------------------------------------------ C. G11 durable sleep deadline
async function testSleepDeadline(): Promise<void> {
  console.log("\n=== C. G11: sleep deadline recorded durably — restart mid-sleep waits only the remainder ===");
  const runId = "bra74-c";
  const trapId = "bra74-c/trap-0";
  const sleepMs = 6000;
  const inputFile = writeInput("bra74-c-input.json", { sleepMs });
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra75-sleep.ts"),
    "--run-id",
    runId,
    "--input-file",
    inputFile,
    "--wait",
    "--adapter",
    "direct",
    "--clock",
    "real",
    "--state-dir",
    STATE_DIR,
  ]);
  try {
    // Wait for the sleep trap to suspend (the trap event in the journal), then wait 3s — half
    // the sleep — and kill the drive.
    const trapped = await waitFor(
      () => readJournal(runId).some((e) => e.event === "trap" && e.trapId === trapId),
      20_000,
      `trap ${trapId} in the journal`,
    );
    if (!trapped) return;
    await sleep(3000);
    check(driveProc.exitCode === null, `C KILL OK: drive child still running before the kill`);
    driveProc.kill("SIGKILL");
    await driveProc.exited;
    check(trapDispatches(runId, trapId).length === 1, `C JOURNAL OK: one trap-dispatch from the crashed attempt`);
    check(trapDispatched(runId, trapId).length === 0, `C JOURNAL OK: no trap-dispatched yet (the dispatch never completed)`);
    // The deadline is a durable fact in the journal, recorded before the wait started: it must
    // equal the trap's suspension wallTs + the sleep duration, exactly.
    const trapEv = readJournal(runId).find((e) => e.event === "trap" && e.trapId === trapId);
    const deadlines = readJournal(runId).filter((e) => e.event === "sleep-deadline" && e.trapId === trapId);
    check(deadlines.length === 1, `C DEADLINE OK: exactly one sleep-deadline event (got ${deadlines.length})`);
    const deadlineMs = deadlines[0]?.deadlineMs;
    const trapWall = Date.parse(trapEv?.wallTs ?? "");
    check(
      typeof deadlineMs === "number" && Math.abs(deadlineMs - trapWall - sleepMs) < 5,
      `C DEADLINE OK: deadline is the trap wallTs + ${sleepMs}ms (deadlineMs ${deadlineMs}, trap wallTs ${trapEv?.wallTs})`,
    );
    // Recover with the real clock in a fresh process. The remaining wait is ~3s, so the re-drive
    // takes ~4s (wait + overhead). A full re-wait would take the 6s sleep plus overhead — 6s is
    // the hard floor for a full re-wait, so <6000ms proves the recorded deadline was used;
    // >2000ms proves the wait was not skipped entirely.
    const t0 = Date.now();
    const rec = cli(["queue", "run", "--clock", "real", "--state-dir", STATE_DIR]);
    const recMs = Date.now() - t0;
    check(rec.rc === 0, `C RECOVER OK: queue run exited 0 (got ${rec.rc})`);
    if (rec.rc !== 0) fail(`C RECOVER ERR: ${rec.err.slice(0, 300)}`);
    check(
      recMs > 2000 && recMs < 6000,
      `C TIMING OK: re-drive took ${recMs}ms (bounds 2000–6000ms — remaining time from the recorded deadline, not a full re-wait)`,
    );
    const out = getResult(runId);
    check(out?.sleptMs === sleepMs, `C RESULT OK: run completed with sleptMs ${sleepMs} (got ${JSON.stringify(out)})`);
    const deadlinesAfter = readJournal(runId).filter((e) => e.event === "sleep-deadline" && e.trapId === trapId);
    check(
      deadlinesAfter.length === 1,
      `C DEADLINE OK: still exactly one sleep-deadline event after recovery — the re-dispatch reused it (got ${deadlinesAfter.length})`,
    );
    const dispatches = trapDispatches(runId, trapId);
    check(dispatches.length === 2, `C JOURNAL OK: two trap-dispatch events (got ${dispatches.length})`);
    check(dispatches[1]?.redispatched === true, `C JOURNAL OK: second trap-dispatch is redispatched`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ D. G14 adapter timeout
let serverProc: Subprocess | null = null;

async function http(pathname: string): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(`${SERVER_URL}${pathname}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

async function startServer(leaseMs: number, maxAttempts: number): Promise<void> {
  serverProc = spawn(
    [
      BUN,
      path.join(ROOT, "src", "worker-server.ts"),
      "--state-dir",
      STATE_DIR,
      "--port",
      String(PORT),
      "--lease-ms",
      String(leaseMs),
      "--max-attempts",
      String(maxAttempts),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const up = await waitFor(async () => {
    const r = await http("/health");
    return r.status === 200 && r.body?.ok === true;
  }, 15_000, "worker server /health");
  if (!up) throw new Error("worker server did not come up");
}

async function testAdapterTimeout(): Promise<void> {
  console.log("\n=== D. G14: adapter timeout derived from the server settle time ===");
  // Unit: the derivation itself. Default lease 300s x 3 attempts + 60s margin = 960s.
  check(deriveJobTimeoutMs(300_000, 3) === 960_000, `D UNIT OK: deriveJobTimeoutMs(300000, 3) is 960000 (got ${deriveJobTimeoutMs(300_000, 3)})`);
  check(deriveJobTimeoutMs(300_000, 3, 0) === 900_000, `D UNIT OK: deriveJobTimeoutMs(300000, 3, 0) is 900000 (got ${deriveJobTimeoutMs(300_000, 3, 0)})`);
  check(deriveJobTimeoutMs(200, 2, 500) === 900, `D UNIT OK: deriveJobTimeoutMs(200, 2, 500) is 900 (got ${deriveJobTimeoutMs(200, 2, 500)})`);
  check(
    deriveJobTimeoutMs(200, 2, 500) > 200 * 2,
    `D UNIT OK: derived timeout exceeds lease x attempts (900 > 400)`,
  );
  // Behavioral: a server with lease 200ms x 2 attempts settles in 400ms; with a 500ms margin the
  // adapter's derived timeout is 900ms. A job with no worker is never picked up and never
  // settles — the adapter must fail it with JobTimeout in ~900ms, not after the old 600s default.
  // The drive runs in a child with a 15s test-side bound, so a non-firing timeout fails the test
  // instead of hanging it for 10 minutes.
  const leaseMs = 200;
  const maxAttempts = 2;
  const marginMs = 500;
  const derivedMs = leaseMs * maxAttempts + marginMs;
  await startServer(leaseMs, maxAttempts);
  const health = await http("/health");
  check(
    health.body?.leaseMs === leaseMs && health.body?.maxAttempts === maxAttempts,
    `D SERVER OK: /health reports lease ${health.body?.leaseMs}ms x ${health.body?.maxAttempts} attempts`,
  );
  const runId = "bra74-d";
  const inputFile = writeInput("bra74-d-input.json", { sleepMs: 1000 });
  const t0 = Date.now();
  const driveProc = driveChild(
    [
      "run",
      path.join(ROOT, "tests", "workflows", "workflow-bra74-job-never.ts"),
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
    { AGENTTS_WORKER_SERVER: SERVER_URL, AGENTTS_MUSE_SETTLE_MARGIN_MS: String(marginMs) },
  );
  const rc = await waitExit(driveProc, 15_000, "drive child fails with JobTimeout");
  const driveMs = Date.now() - t0;
  check(rc === 1, `D DRIVE OK: drive child exited 1 (JobTimeout fails the run) (got ${rc})`);
  check(
    driveMs < 15_000,
    `D TIMING OK: drive finished in ${driveMs}ms — the derived ~${derivedMs}ms timeout fired, not the old 600s default`,
  );
  const err = getResultError(runId);
  check(err.includes("JobTimeout"), `D ERROR OK: result error names JobTimeout (got ${err.slice(0, 300)})`);
  check(
    err.includes(`${derivedMs}ms`) && err.includes(`${leaseMs * maxAttempts}ms`),
    `D ERROR OK: error names the derived timeout ${derivedMs}ms and the settle time ${leaseMs * maxAttempts}ms (got ${err.slice(0, 300)})`,
  );
  const failedEv = readJournal(runId).find((e) => e.event === "lifecycle" && e.lifecycle === "failed");
  check(
    typeof failedEv?.error === "string" && failedEv.error.includes("JobTimeout"),
    `D JOURNAL OK: lifecycle failed event carries the JobTimeout error`,
  );
  check(queueStatus(runId) === "failed", `D QUEUE OK: ${runId} failed (got ${queueStatus(runId)})`);
}

// ------------------------------------------------------------ E. G1 first-slice crash
async function testFirstSliceCrash(): Promise<void> {
  console.log("\n=== E. G1: C host killed mid-slice on the FIRST slice (no blob yet) — run retried from scratch ===");
  const runId = "bra74-e";
  const marker = path.join(WORKDIR, "bra74-e.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra74-firstcrash.ts"), runId, {
    markerFile: marker,
    iterations: LOOP_ITERATIONS,
  });
  const driveProc = driveChild(["queue", "run", "--adapter", "direct", "--state-dir", STATE_DIR]);
  try {
    // Kill the C host as soon as it appears — the first slice's loop lasts ~4.5s, so the kill
    // lands mid-slice. (The drive does extraction first, so the C host appears ~1–2s in.)
    const killed = await killHostChildOnce(driveProc);
    check(killed !== null, `E KILL OK: C host (pid ${killed}) SIGKILLed mid-slice during the first slice`);
    const rc = await waitExit(driveProc, 60_000, "drive child exits after the first-slice retry");
    // queue run returns 1 when ANY entry in the queue is failed — bra74-d (scenario D) is still
    // failed in this shared queue, so the exit code alone does not prove this drive. Assert
    // instead that bra74-d is the ONLY failed entry: this drive itself succeeded.
    const failedEntries = readQueue().filter((e) => e.status === "failed").map((e) => e.runId);
    check(
      rc === 0 || (rc === 1 && failedEntries.length === 1 && failedEntries[0] === "bra74-d"),
      `E DRIVE OK: queue run exit reflects only the earlier failed bra74-d (got rc ${rc}, failed: ${failedEntries.join(",")})`,
    );
    const out = getResult(runId);
    check(
      out?.marker === "bra74-firstcrash" && out?.looped === true && out?.count === LOOP_ITERATIONS,
      `E RESULT OK: run completed with the loop run to the end (got ${JSON.stringify(out)})`,
    );
    check(queueStatus(runId) === "done", `E QUEUE OK: ${runId} done (got ${queueStatus(runId)})`);
    const crashes = readJournal(runId).filter((e) => e.event === "host-crash");
    check(crashes.length >= 1, `E JOURNAL OK: at least one host-crash event (got ${crashes.length})`);
    check(
      crashes[0]?.slice === "run" && crashes[0]?.signal === "SIGKILL",
      `E JOURNAL OK: host-crash is the first slice ("run"), signal SIGKILL (got ${JSON.stringify(crashes[0])?.slice(0, 200)})`,
    );
    check(markerLines(marker) === 1, `E MARKER OK: exec ran exactly once (got ${markerLines(marker)} line(s))`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

async function main(): Promise<number> {
  try {
    await testResumeSliceCrash();
    await testRepairAfterCrash();
    await testSleepDeadline();
    await testAdapterTimeout();
    await testFirstSliceCrash();
  } finally {
    if (serverProc) {
      try {
        serverProc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }
  console.log(`\n--- evidence ---`);
  console.log(`workdir: ${WORKDIR}`);
  if (FAILURES.length) {
    console.log(`\nFAIL bra74 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log(
    "\nPASS bra74 crash-resume suite (resume from last blob after C-host crash, durable sleep deadline, adapter timeout aligned with server settle time)",
  );
  return 0;
}

process.exit(await main());
