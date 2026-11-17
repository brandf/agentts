#!/usr/bin/env bun
/**
 * Enqueue race test (Linear BRA-82 — queue enqueue
 * read-modify-write race loses an entry under concurrent submit).
 *
 * BRA-77 made each queue.json write atomic (tmp+rename), but two
 * processes could still interleave read -> modify -> write and the
 * last writer won — one enqueued entry silently vanished. BRA-82
 * adds a separate short-lived enqueue lock (`<stateDir>/queue.lock/`,
 * mkdir-atomic, same pattern as the BRA-72 driver lock) around
 * every queue read-modify-write, and makes `queue run`'s status
 * writes re-read the queue under that lock instead of writing back
 * the drive's snapshot (which would clobber entries enqueued
 * mid-drive).
 *
 * Proves, all through separate CLI processes (an in-memory mutex
 * would not cover any of this):
 *
 *   A. Ten concurrent submits all land: 10 parallel `run`
 *      (submit) processes, distinct runIds, same workflow — the
 *      queue holds exactly those 10 entries, no duplicates, no
 *      lost entries, valid JSON. A second wave of 5 more lands
 *      exactly too (15 total).
 *   B. The lock is actually taken: with a live holder's lock dir
 *      in place, a submit blocks (still running after 2s, queue
 *      unchanged) instead of overwriting — and completes with its
 *      entry landing once the lock is released. The lock dir is
 *      gone afterwards.
 *   C. A stale lock does not wedge the queue:
 *      C1. Holder pid dead — the next submit proceeds at once.
 *      C2. Holder pid alive but the lock aged past
 *          ENQUEUE_LOCK_STALE_MS (dir mtime backdated 60s) — the
 *          next submit breaks it and proceeds.
 *   D. Concurrent submits during a live drive (the issue's
 *      reproduction): drive a 10s exec run in a child; while it
 *      holds the driver lock, submit 5 runs concurrently — all 5
 *      are in queue.json while the drive is still running, and
 *      still there (queued) after the drive finishes with the
 *      driven run done. The drive's status writes must not
 *      clobber them, and the submits must not be mistaken for a
 *      stuck driver (no "driver already running" refusal).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra82.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra52 suite.)
 *
 * Run outputs go to $BRA82_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The drive child process is killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the stale-live-pid
 * break for a holder that is genuinely stopped (SIGSTOP) mid-
 * section and resumes after the break — that needs a process
 * stopped >30s resuming at exactly the wrong moment, and the
 * accepted residual risk is documented on ENQUEUE_LOCK_STALE_MS
 * in host.ts. C2 proves the age rule fires; it does not prove a
 * resumed stopped holder cannot write a stale snapshot.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA82_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra82-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Submit in a child process, asynchronously (so N can run in
 * parallel). Resolves with the child's exit code + output. */
function submitAsync(workflow: string, runId: string, input: unknown, stateDir: string = STATE_DIR): Promise<{ runId: string; rc: number; out: string; err: string }> {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const child = spawn(
    [BUN, path.join(ROOT, "src", "cli.ts"), "run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", stateDir],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  return (async () => {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return { runId, rc: child.exitCode ?? 1, out, err };
  })();
}

function submitSync(workflow: string, runId: string, input: unknown, stateDir: string = STATE_DIR): { rc: number; out: string; err: string } {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  return cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", stateDir]);
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to submit concurrently). */
function driveChild(stateDir: string = STATE_DIR): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", stateDir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

function readQueue(stateDir: string = STATE_DIR): any[] {
  const p = path.join(stateDir, "queue.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function queueRunIds(stateDir: string = STATE_DIR): string[] {
  return readQueue(stateDir).map((e) => e.runId);
}
function queueStatus(runId: string, stateDir: string = STATE_DIR): string | null {
  return readQueue(stateDir).find((e) => e.runId === runId)?.status ?? null;
}
function queueLockDir(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, "queue.lock");
}
function plantQueueLock(pid: number, ageMs = 0, stateDir: string = STATE_DIR): void {
  const dir = queueLockDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "holder.json"),
    JSON.stringify({ pid, startedAt: new Date(Date.now() - ageMs).toISOString(), command: "bra82-test-planted-lock" }, null, 2),
  );
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, t, t);
  }
}
function removeQueueLock(stateDir: string = STATE_DIR): void {
  fs.rmSync(queueLockDir(stateDir), { recursive: true, force: true });
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts");
const children: Subprocess[] = [];

async function scenarioA(): Promise<void> {
  console.log("\n=== A. ten concurrent submits all land (exact union, no dupes) ===");
  // Pre-seed the frozen workflow copy so the parallel submits all
  // hit the already-complete path in freezeWorkflow.
  const seed = submitSync(WORKFLOW, "bra82-seed", { markerFile: path.join(WORKDIR, "seed.marker"), sleepMs: 0 });
  check(seed.rc === 0 && seed.out.includes("RUN bra82-seed"), `SEED OK: bra82-seed submitted (rc ${seed.rc})`);
  const ids = Array.from({ length: 10 }, (_, i) => `bra82-a-${i}`);
  const results = await Promise.all(
    ids.map((id) => submitAsync(WORKFLOW, id, { markerFile: path.join(WORKDIR, `${id}.marker`), sleepMs: 0 })),
  );
  for (const r of results) {
    check(r.rc === 0 && r.out.includes(`RUN ${r.runId}`), `SUBMIT OK: ${r.runId} submitted (rc ${r.rc})${r.rc !== 0 ? ` err=${r.err.slice(0, 300)}` : ""}`);
  }
  const got = queueRunIds();
  const missing = ids.filter((id) => !got.includes(id));
  const dupes = got.filter((id, i) => got.indexOf(id) !== i);
  check(missing.length === 0, `NO LOST ENTRIES: all 10 concurrent submits in queue.json (missing: ${missing.join(",") || "none"})`);
  check(dupes.length === 0, `NO DUPLICATES: queue.json has no duplicate runIds (dupes: ${dupes.join(",") || "none"})`);
  check(got.length === 11, `EXACT UNION: queue.json holds exactly seed + 10 (got ${got.length})`);
  // Second wave: 5 more concurrent submits land exactly too.
  const wave2 = Array.from({ length: 5 }, (_, i) => `bra82-a2-${i}`);
  const results2 = await Promise.all(
    wave2.map((id) => submitAsync(WORKFLOW, id, { markerFile: path.join(WORKDIR, `${id}.marker`), sleepMs: 0 })),
  );
  check(results2.every((r) => r.rc === 0), `WAVE2 OK: all 5 second-wave submits exited 0`);
  const got2 = queueRunIds();
  const missing2 = wave2.filter((id) => !got2.includes(id));
  check(missing2.length === 0 && got2.length === 16, `WAVE2 UNION: queue.json holds exactly 16 entries (got ${got2.length}, missing: ${missing2.join(",") || "none"})`);
  check(!fs.existsSync(queueLockDir()), `LOCK CLEAN: no queue.lock left behind after concurrent submits`);
}

async function scenarioB(): Promise<void> {
  console.log("\n=== B. a live enqueue lock makes a submit block, not overwrite ===");
  const before = queueRunIds();
  plantQueueLock(process.pid);
  const inputFile = path.join(WORKDIR, "bra82-b.input.json");
  fs.writeFileSync(inputFile, JSON.stringify({ markerFile: path.join(WORKDIR, "bra82-b.marker"), sleepMs: 0 }));
  const child = spawn(
    [BUN, path.join(ROOT, "src", "cli.ts"), "run", WORKFLOW, "--run-id", "bra82-b", "--input-file", inputFile, "--adapter", "direct", "--state-dir", STATE_DIR],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  children.push(child);
  // 2s is far longer than freeze/extract/validate take, so the
  // child has reached the enqueue lock by now — if it were going
  // to overwrite, it would have done so.
  await sleep(2000);
  check(child.exitCode === null, `BLOCKED: submit with a live lock held is still running after 2s (exitCode ${child.exitCode})`);
  check(JSON.stringify(queueRunIds()) === JSON.stringify(before), `NOT OVERWRITTEN: queue.json unchanged while the submit blocks`);
  removeQueueLock();
  await child.exited;
  const out = await new Response(child.stdout).text();
  check((child.exitCode ?? 1) === 0 && out.includes("RUN bra82-b"), `RELEASED: submit completes once the lock is released (rc ${child.exitCode})`);
  check(queueRunIds().includes("bra82-b"), `LANDED: bra82-b in queue.json after the lock release`);
  check(!fs.existsSync(queueLockDir()), `LOCK CLEAN: no queue.lock left behind after the blocked submit`);
}

async function scenarioC(): Promise<void> {
  console.log("\n=== C. a stale enqueue lock does not wedge submits ===");
  // C1: holder pid dead (a short-lived process, reaped before use).
  const deadPid = await (async () => {
    const p = spawn(["sh", "-c", "true"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    return p.pid;
  })();
  plantQueueLock(deadPid);
  const r1 = submitSync(WORKFLOW, "bra82-c1", { markerFile: path.join(WORKDIR, "bra82-c1.marker"), sleepMs: 0 });
  check(r1.rc === 0 && r1.out.includes("RUN bra82-c1"), `C1 DEAD PID: submit proceeds past a lock whose holder pid is dead (rc ${r1.rc})`);
  check(queueRunIds().includes("bra82-c1"), `C1 LANDED: bra82-c1 in queue.json`);
  check(!fs.existsSync(queueLockDir()), `C1 LOCK CLEAN: no queue.lock left behind`);
  // C2: holder pid alive but the lock is aged past the stale
  // threshold (dir mtime backdated 60s).
  plantQueueLock(process.pid, 60_000);
  const r2 = submitSync(WORKFLOW, "bra82-c2", { markerFile: path.join(WORKDIR, "bra82-c2.marker"), sleepMs: 0 });
  check(r2.rc === 0 && r2.out.includes("RUN bra82-c2"), `C2 AGED LOCK: submit breaks a 60s-old lock held by a live pid and proceeds (rc ${r2.rc})${r2.rc !== 0 ? ` err=${r2.err.slice(0, 300)}` : ""}`);
  check(queueRunIds().includes("bra82-c2"), `C2 LANDED: bra82-c2 in queue.json`);
  check(!fs.existsSync(queueLockDir()), `C2 LOCK CLEAN: no queue.lock left behind`);
}

async function scenarioD(): Promise<void> {
  console.log("\n=== D. concurrent submits during a live drive are not lost ===");
  // Fresh state dir: scenarios A-C leave 19 queued entries behind,
  // and a drive here would work through all of them (FIFO) before
  // reaching the slow run.
  const D_STATE = path.join(WORKDIR, "state-d");
  fs.mkdirSync(D_STATE, { recursive: true });
  const driveId = "bra82-d-drive";
  const marker = path.join(WORKDIR, "bra82-d.marker");
  const s = submitSync(WORKFLOW, driveId, { markerFile: marker, sleepMs: 10_000 }, D_STATE);
  // sleepMs is milliseconds: the workflow does `sleep ${floor(sleepMs/1000)}`,
  // so 10_000 is a real 10s exec — the run must stay "running" long
  // enough for waitFor (100ms polls) to observe it and for the
  // concurrent submits to land mid-drive. (sleepMs: 10 slept 0s: the
  // run completed in ~14ms and the "running" window was unobservable.)
  check(s.rc === 0, `DRIVE SUBMIT OK: ${driveId} submitted (rc ${s.rc})`);
  const child = driveChild(D_STATE);
  children.push(child);
  const flipped = await waitFor(() => queueStatus(driveId, D_STATE) === "running", 10_000, `${driveId} entry -> running`);
  check(flipped, `DRIVE LIVE: ${driveId} entry flipped to running before concurrent submits`);
  const ids = Array.from({ length: 5 }, (_, i) => `bra82-d-${i}`);
  const results = await Promise.all(
    ids.map((id) => submitAsync(WORKFLOW, id, { markerFile: path.join(WORKDIR, `${id}.marker`), sleepMs: 0 }, D_STATE)),
  );
  check(results.every((r) => r.rc === 0), `MID-DRIVE SUBMITS OK: all 5 concurrent submits exited 0 during the live drive`);
  check(!results.some((r) => r.err.includes("driver already running")), `NOT A STUCK DRIVER: no submit was refused as a concurrent driver`);
  const midDrive = queueRunIds(D_STATE);
  const missingMid = ids.filter((id) => !midDrive.includes(id));
  check(missingMid.length === 0, `MID-DRIVE PRESENT: all 5 submits in queue.json while the drive is still running (missing: ${missingMid.join(",") || "none"})`);
  await child.exited;
  check((child.exitCode ?? 1) === 0, `DRIVE DONE: queue run exited 0 (rc ${child.exitCode})`);
  const after = queueRunIds(D_STATE);
  const missingAfter = ids.filter((id) => !after.includes(id));
  check(missingAfter.length === 0, `AFTER DRIVE PRESENT: all 5 mid-drive submits still in queue.json after the drive finished (missing: ${missingAfter.join(",") || "none"})`);
  check(queueStatus(driveId, D_STATE) === "done", `DRIVE COMPLETED: ${driveId} is done (status ${queueStatus(driveId, D_STATE)})`);
  check(ids.every((id) => queueStatus(id, D_STATE) === "queued"), `NOT DRIVEN THIS PASS: the 5 mid-drive submits are still queued (not clobbered, not driven off the stale snapshot)`);
  check(!fs.existsSync(queueLockDir(D_STATE)), `LOCK CLEAN: no queue.lock left behind after the drive`);
  check(!fs.existsSync(path.join(D_STATE, "driver.lock")), `DRIVER LOCK CLEAN: no driver.lock left behind after the drive`);
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
} finally {
  for (const c of children) {
    try {
      if (c.exitCode === null) c.kill(9);
    } catch {
      /* already gone */
    }
  }
  // A planted lock must never survive the suite (a leftover would
  // wedge the next run's submits for 30s).
  removeQueueLock();
}

if (FAILURES.length > 0) {
  console.log(`\nBRA82 FAIL: ${FAILURES.length} failure(s)`);
  process.exit(1);
}
console.log("\nBRA82 PASS: concurrent submits all land, live lock blocks, stale lock breaks, mid-drive submits survive");
