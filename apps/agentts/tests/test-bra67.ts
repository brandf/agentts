#!/usr/bin/env bun
/**
 * BRA-67 — fault-injection coverage map for every BRA-62 failure mode.
 *
 * The BRA-71..77 wave already covers most modes; this suite is the
 * coverage map made executable: it fills the modes that had NO test
 * and re-proves the two modes whose only coverage was a simulation
 * or a same-process check, from a cold shell. The full map (every
 * BRA-62 audit row / gap -> covering test) is in the header of
 * docs/audits/bra67-coverage-map.md; the short version:
 *
 *   G1  C host crash mid-slice ............ bra74 A/B/E
 *   G2  queue entry stranded at running ... bra72 A/F (+ bra75 recover)
 *   G3  TS host crash dispatch->resume .... bra75 A-D (no duplicate trap)
 *   G4  non-atomic snapshot write ......... bra76 A (torn blob untrusted)
 *   G5  corrupt queue.json ................ bra77 A/B
 *   G6  idempotency / stuck worker ........ bra61 A/B/C + pool suite C
 *   G7  corrupt worker store .............. bra76 B
 *   G8  held gate across a restart ........ run-host-suite cross-process
 *       gate + tick-driver C/D (deliver-gate + drive)
 *   G9  no frozen workflow copy ........... bra71 A1-A4
 *   G10 engine upgrade suspend->resume .... bra71 B1/B2
 *   G11 sleep progress not durable ........ bra74 C + bra75 E (sleep);
 *       cron across a restart ............. THIS SUITE, scenario A
 *   G12 50-round drive cap ................ bra76 C
 *   G13 concurrent queue drivers .......... bra72 E
 *   G14 adapter timeout < settle time ..... bra74 D
 *   G15 corrupt journal line .............. bra77 C/D
 *   audit row 6 worker dies mid-job ....... pool suite C
 *   audit row 7 worker completes but
 *       complete-job never lands .......... THIS SUITE, scenario B
 *   audit row 1 VM replacement ............ tick-driver D (SIMULATED);
 *       closest faithful test achievable
 *       from inside this VM ............... THIS SUITE, scenario C
 *       (full kill + clean-shell recovery) and D (missing engine
 *       binary fails loudly — the rebuild-step detector)
 *
 *   A. Cron across a host restart (G11, cron half): the host is
 *      SIGKILLed ~3s into a 15s cron wait (the target is 15s out so
 *      drive startup, ~6s, cannot eat the whole wait). Recovery waits
 *      only the REMAINING time to the absolute target in the
 *      journaled trap arg — the trap-to-completion span is one wait
 *      to the target (not two, not none) and the run completes with
 *      the scheduled target; the journal shows the re-dispatch as
 *      redispatched.
 *   B. Worker completes but complete-job never lands (audit row 7):
 *      a ghost worker takes the job, DOES the work (marker line),
 *      then exits without completing. The lease expires, the job is
 *      re-queued, a real worker redoes it and completes it. The
 *      marker has TWO lines (the duplicate work is visible, not
 *      silent), jobs.log has job-timeout-requeue, the job completes
 *      exactly once (by the second worker), and the run completes
 *      with the second worker's result. Distinct from pool-suite C,
 *      where the worker dies MID-job and no work is proven done.
 *   C. VM-replacement cold start (closest faithful test): a gate run
 *      is held and a sleep run is stranded mid-sleep; then EVERY
 *      AgentTS process is SIGKILLed (server, workers, driver) and
 *      recovery runs entirely from a clean shell — different cwd
 *      (/tmp), scrubbed env, fresh CLI processes only. The watchdog
 *      first reports exit 2 (tick never ticked + pending work);
 *      then deliver-gate + repair + queue run recover both runs to
 *      done, with the full journal history intact.
 *   D. Missing engine binary fails loudly: $DURABLETS_HOST pointing
 *      at a path that no longer exists (what a VM replacement does
 *      to the pinned build) makes any Host construction exit 1 with
 *      "C host binary not found" naming the path — instead of the
 *      old silent fallback to a different repo binary (fixed in
 *      host.ts resolveHostPath as part of this issue).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra67.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra76 suite.)
 *
 * Run outputs go to $BRA67_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The server + worker + CLI processes are killed
 * in a finally block, even on failure. Exit 0 on PASS, 1 on any
 * mismatch.
 *
 * What this does NOT prove (stated plainly): an ACTUAL VM
 * replacement cannot be performed from inside the VM — the VM
 * itself cannot be replaced by a test running on it, and the
 * node_modules reinstall half of the rebuild cannot be tested
 * without deleting node_modules (destructive, minutes-long). C+D
 * cover the two testable halves: state-dir-only survival from a
 * cold shell, and loud detection of the missing engine binary.
 * A state dir RELOCATED to a new path also resumes now (BRA-85:
 * frozenPath is stored state-dir-relative and registry snap/out/
 * log + frozenPath are rebased at load) — covered end to end by
 * tests/test-bra85.ts, not here; a real replacement keeps the path,
 * so this scenario does not depend on relocation either way.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_BRA67_TEST_PORT ?? String(22000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

// Lease 3s: short enough that the re-queue lands fast, long enough
// that the ghost's 500ms of work finishes well inside it.
const LEASE_MS = 3000;

const WORKDIR = process.env.BRA67_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra67-"));
const STATE_DIR = path.join(WORKDIR, "state");
const JOBSPEC_DIR = path.join(WORKDIR, "jobspecs");
const WORKSPACES = path.join(WORKDIR, "workspaces");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(JOBSPEC_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });

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

function readJournal(runId: string, stateDir = STATE_DIR): any[] {
  const p = path.join(stateDir, "journals", `${runId}.journal`);
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

function readQueue(stateDir = STATE_DIR): any[] {
  const p = path.join(stateDir, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}
function queueStatus(runId: string, stateDir = STATE_DIR): string | null {
  return readQueue(stateDir).find((e) => e.runId === runId)?.status ?? null;
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

function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}
function markerText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function cli(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** A clean shell, as after a VM replacement: a different cwd, a
 * scrubbed environment (only PATH/HOME and the pinned engine binary
 * carried over), fresh CLI processes only. */
function cleanShellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/opt/hatch-image/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/home/hatch",
  };
  if (process.env.DURABLETS_HOST) env.DURABLETS_HOST = process.env.DURABLETS_HOST;
  return env;
}
function cliClean(args: string[]): { rc: number; out: string; err: string } {
  return cli(args, cleanShellEnv(), "/tmp");
}

function driveChild(args: string[], env: Record<string, string> = {}): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL, ...env },
  });
}

function getResult(runId: string, stateDir = STATE_DIR): any | null {
  const r = cli(["result", runId, "--state-dir", stateDir]);
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

function writeInput(name: string, input: unknown): string {
  const p = path.join(WORKDIR, name);
  fs.writeFileSync(p, JSON.stringify(input));
  return p;
}

async function http(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  try {
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
  } catch {
    return { status: 0, body: null };
  }
}

async function jobsForTrapId(trapId: string): Promise<any[]> {
  const r = await http("GET", "/jobs");
  return (r.body?.jobs ?? []).filter((j: any) => j.trapId === trapId);
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
    const r = await http("GET", "/health");
    return r.status === 200 && r.body?.ok === true;
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

// ------------------------------------------------------------ A. cron across a host restart
async function testCronAcrossRestart(): Promise<void> {
  console.log("\n=== A. cron across a host restart (G11, cron half): recovery waits only the remainder ===");
  const runId = "bra67-a";
  const trapId = "bra67-a/trap-0";
  // 30s out: drive startup (extraction + gating + bundling) runs
  // before the trap suspends, and on this VM startup is ~8-11s, not
  // the ~6s this test originally assumed (BRA-102). With a 15s
  // target the remaining wait after the 3s kill delay was only
  // ~1-4s — below the noise floor of drive overhead — so A TIMING /
  // A SPAN flipped pass/fail on startup jitter alone (observed span
  // 4976-8107ms against an 8000ms lower bound). A 30s target leaves
  // ~16-19s of remaining wait after the kill, large against the
  // ~1-2s drive overhead, so the bounds below separate one wait
  // from a skipped wait (~4-6s span) and from two waits (~36-48s).
  // The target is absolute, so startup time does not change what
  // the test proves — only that enough wait remains to kill into.
  const at = new Date(Date.now() + 30000).toISOString();
  const inputFile = writeInput("bra67-a-input.json", { at });
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra67-cron.ts"),
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
    // Wait for the cron trap to suspend (the trap event in the
    // journal), then wait 3s — half the wait — and kill the drive.
    const trapped = await waitFor(
      () => readJournal(runId).some((e) => e.event === "trap" && e.trapId === trapId),
      20_000,
      `trap ${trapId} in the journal`,
    );
    if (!trapped) return;
    // The absolute target is the durable fact: the journaled trap
    // arg carries it, so a re-dispatch recomputes target - now.
    const trapEv = readJournal(runId).find((e) => e.event === "trap" && e.trapId === trapId);
    check(trapEv?.arg?.at === at, `A JOURNAL OK: trap arg carries the absolute target ${at} (got ${trapEv?.arg?.at})`);
    await sleep(3000);
    check(driveProc.exitCode === null, `A KILL OK: drive child still running before the kill`);
    driveProc.kill("SIGKILL");
    await driveProc.exited;
    check(trapDispatches(runId, trapId).length === 1, `A JOURNAL OK: one trap-dispatch from the crashed attempt`);
    check(trapDispatched(runId, trapId).length === 0, `A JOURNAL OK: no trap-dispatched yet (the dispatch never completed)`);
    // Recover with the real clock in a fresh process. The remaining
    // wait is ~16-19s (30s target minus ~8-11s startup minus ~3s
    // waited), so the re-drive takes ~16-19s + overhead — but the
    // re-drive duration alone cannot prove the remainder was waited
    // (a re-dispatch recomputes target - now either way). The proving
    // assertion is the trap-to-completion span: one wait to the
    // target (~19-22s from the trap, which dispatched ~8-11s after
    // the target was set), not two waits (~36-48s) and not a skipped
    // wait (~4-6s).
    const repair = cli(["queue", "repair", "--state-dir", STATE_DIR]);
    check(repair.rc === 0 && repair.out.includes(`REPAIR ${runId}: running -> queued`), `A REPAIR OK: queue repair re-queued ${runId}`);
    const t0 = Date.now();
    const rec = cli(["queue", "run", "--clock", "real", "--state-dir", STATE_DIR]);
    const recMs = Date.now() - t0;
    check(rec.rc === 0, `A RECOVER OK: queue run exited 0 (got ${rec.rc})`);
    if (rec.rc !== 0) fail(`A RECOVER ERR: ${rec.err.slice(0, 300)}`);
    check(
      recMs > 12000 && recMs < 28000,
      `A TIMING OK: re-drive took ${recMs}ms (bounds 12000–28000ms — the remaining wait, not a skipped wait)`,
    );
    const out = getResult(runId);
    check(out?.scheduled === at, `A RESULT OK: run completed with scheduled ${at} (got ${JSON.stringify(out)})`);
    check(queueStatus(runId) === "done", `A QUEUE OK: ${runId} done (got ${queueStatus(runId)})`);
    const completedEv = readJournal(runId).find((e) => e.event === "lifecycle" && e.lifecycle === "completed");
    const spanMs = Date.parse(completedEv?.wallTs ?? "") - Date.parse(trapEv?.wallTs ?? "");
    check(
      spanMs > 15000 && spanMs < 28000,
      `A SPAN OK: trap to completion took ${spanMs}ms (bounds 15000–28000ms — one wait to the target, not two and not none)`,
    );
    const dispatches = trapDispatches(runId, trapId);
    check(dispatches.length === 2, `A JOURNAL OK: two trap-dispatch events (got ${dispatches.length})`);
    check(dispatches[1]?.redispatched === true, `A JOURNAL OK: second trap-dispatch is redispatched`);
    check(trapDispatched(runId, trapId).length === 1, `A JOURNAL OK: one trap-dispatched (the recovery's)`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ B. complete-job never lands
async function testCompleteNeverLands(): Promise<void> {
  console.log("\n=== B. worker completes but complete-job never lands: lease re-queue, work redone once ===");
  const runId = "bra67-b";
  const trapId = "bra67-b/trap-0";
  const markerFile = path.join(WORKDIR, "bra67-b.marker");
  // The real worker for the retry (spec bra67-marker -> marker-worker.ts).
  const workersJson = path.join(WORKDIR, "workers.json");
  fs.writeFileSync(
    workersJson,
    JSON.stringify({ "bra67-marker": path.join(ROOT, "tests", "fixtures", "marker-worker.ts") }, null, 2),
  );
  // The ghost takes the job first (no real worker running yet), does
  // the work, and exits without completing.
  const ghost = spawn(
    [BUN, path.join(ROOT, "tests", "fixtures", "never-lands-worker.ts"), SERVER_URL, markerFile, "--worker-id", "w-bra67-ghost"],
    { stdout: "pipe", stderr: "pipe" },
  );
  workerProcs.push(ghost);
  const inputFile = writeInput("bra67-b-input.json", { markerFile, sleepMs: 1000 });
  const t0 = Date.now();
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra67-job.ts"),
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
    // Wait until the ghost has taken the job (it is running in the
    // pool), then wait for it to exit on its own — work done,
    // completion never sent.
    const taken = await waitFor(async () => {
      const jobs = await jobsForTrapId(trapId);
      return jobs.some((j) => j.status === "running" && j.workerId === "w-bra67-ghost");
    }, 20_000, `job ${trapId} running on the ghost`);
    if (!taken) return;
    check(driveProc.exitCode === null, `B KILL OK: drive child still running while the ghost works`);
    const ghostGone = await waitFor(() => ghost.exitCode !== null, 10_000, "ghost worker exits");
    check(ghostGone, `B GHOST OK: ghost exited after doing the work (exit ${ghost.exitCode})`);
    check(markerLines(markerFile) === 1, `B MARKER OK: ghost did the work — one marker line (got ${markerLines(markerFile)})`);
    check(markerText(markerFile).includes("ghost-worker"), `B MARKER OK: the line is the ghost's`);
    // The job sits "running" until the 3s lease expires, then the
    // sweep re-queues it (attempts 1). Only then start the real
    // worker — it must be the retry, not the first take.
    const requeued = await waitFor(async () => {
      const jobs = await jobsForTrapId(trapId);
      return jobs.some((j) => j.status === "queued" && j.attempts === 1);
    }, 20_000, `job ${trapId} re-queued after lease expiry`);
    if (!requeued) return;
    check(true, `B REQUEUE OK: lease expiry re-queued the ghost's job (attempts 1)`);
    const requeuedJobs = await jobsForTrapId(trapId);
    const events = readLog("jobs.log").filter((e) => e.jobId === requeuedJobs[0]?.jobId);
    check(events.some((e) => e.event === "job-timeout-requeue"), `B LOG OK: jobs.log has job-timeout-requeue for the ghost's job`);
    startLoopWorker("w-bra67-second", workersJson);
    // The retry takes ~1s of work. The derived adapter timeout is
    // lease x attempts + 60s margin (~69s) — a 90s bound lets a
    // broken retry surface as JobTimeout (rc 1) instead of a hang.
    const rc = await waitExit(driveProc, 90_000, "drive child completes after the retry");
    const driveMs = Date.now() - t0;
    check(rc === 0, `B DRIVE OK: drive child exited 0 after the retry (got ${rc})`);
    check(driveMs < 30_000, `B TIMING OK: drive finished in ${driveMs}ms — the retry path, not the ~69s JobTimeout`);
    const out = getResult(runId);
    check(out?.sleptMs === 1000, `B RESULT OK: run completed with the second worker's result, sleptMs 1000 (got ${JSON.stringify(out)})`);
    check(queueStatus(runId) === "done", `B QUEUE OK: ${runId} done (got ${queueStatus(runId)})`);
    // The duplicate work is visible, not silent: the marker has the
    // ghost's line AND the retry's line. The job itself completed
    // exactly once, by the second worker.
    check(markerLines(markerFile) === 2, `B MARKER OK: two lines — the work was done twice (got ${markerLines(markerFile)})`);
    check(markerText(markerFile).includes("marker-worker"), `B MARKER OK: the second line is the retry's`);
    const jobs = await jobsForTrapId(trapId);
    check(jobs.length === 1, `B DEDUPE OK: still exactly one job for ${trapId} (got ${jobs.length})`);
    const jobId = jobs[0]?.jobId;
    const completed = readLog("jobs.log").filter((e) => e.jobId === jobId && e.event === "job-completed");
    check(completed.length === 1, `B ONCE OK: the job completed exactly once (got ${completed.length})`);
    check(completed[0]?.workerId === "w-bra67-second", `B ONCE OK: the second worker completed it (got ${completed[0]?.workerId})`);
    check(trapDispatches(runId, trapId).length === 1, `B JOURNAL OK: one trap-dispatch — the host never crashed, the pool retried transparently`);
    check(trapDispatched(runId, trapId).length === 1, `B JOURNAL OK: one trap-dispatched`);
    check(
      readJournal(runId).some((e) => e.event === "lifecycle" && e.lifecycle === "completed"),
      `B JOURNAL OK: lifecycle completed recorded`,
    );
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ C. VM-replacement cold start
async function testColdStartAfterFullKill(): Promise<void> {
  console.log("\n=== C. VM-replacement cold start: full kill, then recovery from a clean shell ===");
  const gateRun = "bra67-c-gate";
  const sleepRun = "bra67-c-sleep";
  const sleepTrap = "bra67-c-sleep/trap-0";
  // C1: a gate run, held. Submit + drive in separate CLI processes.
  const r1 = cli(["run", path.join(ROOT, "tests", "workflows", "workflow-gate-hold.ts"), "--run-id", gateRun, "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(r1.rc === 0 && r1.out.includes(`RUN ${gateRun}`), `C SUBMIT OK: ${gateRun} submitted (rc ${r1.rc})`);
  const r2 = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(r2.rc === 0 && (r2.out + r2.err).includes(`held ${gateRun}`), `C HOLD OK: ${gateRun} held at its gate`);
  check(queueStatus(gateRun) === "held", `C HOLD OK: queue says ${gateRun} held (got ${queueStatus(gateRun)})`);
  check(fs.existsSync(path.join(STATE_DIR, "blobs", `${gateRun}.snap`)), `C HOLD OK: blob persisted for ${gateRun}`);
  check(fs.existsSync(path.join(STATE_DIR, "journals", `${gateRun}.journal`)), `C HOLD OK: journal persisted for ${gateRun}`);
  // C2: a sleep run, stranded mid-sleep. Drive in a child, wait for
  // the trap, wait 4s into the 12s sleep (remaining ~8s — long
  // enough that the watchdog + clean-shell calls below, ~3s, cannot
  // eat the whole remainder before the re-drive), kill it.
  const sleepInput = writeInput("bra67-c-sleep-input.json", { sleepMs: 12000 });
  const driveProc = driveChild([
    "run",
    path.join(ROOT, "tests", "workflows", "workflow-bra75-sleep.ts"),
    "--run-id",
    sleepRun,
    "--input-file",
    sleepInput,
    "--wait",
    "--adapter",
    "direct",
    "--clock",
    "real",
    "--state-dir",
    STATE_DIR,
  ]);
  try {
    const trapped = await waitFor(
      () => readJournal(sleepRun).some((e) => e.event === "trap" && e.trapId === sleepTrap),
      20_000,
      `trap ${sleepTrap} in the journal`,
    );
    if (!trapped) return;
    await sleep(4000);
    check(driveProc.exitCode === null, `C KILL OK: sleep drive still running before the kill`);
    driveProc.kill("SIGKILL");
    await driveProc.exited;
    check(queueStatus(sleepRun) === "running", `C STRAND OK: ${sleepRun} entry stranded at "running" after the kill`);
  } finally {
    try {
      driveProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  // C3: the replacement itself — SIGKILL every AgentTS process
  // (the worker server, every loop worker, the ghost is long gone).
  // No graceful shutdown, like a VM going away.
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
    serverProc = null;
  }
  await sleep(500);
  const health = await http("GET", "/health");
  check(health.status === 0, `C KILL OK: worker server is dead — /health no longer answers (got ${health.status})`);
  // C4: the watchdog, from the clean shell, reports the replacement:
  // the tick agent never ticked here and there is pending work.
  const wd = cliClean(["watchdog", "--state-dir", STATE_DIR, "--json"]);
  check(wd.rc === 2, `C WATCHDOG OK: watchdog exits 2 after the full kill (got ${wd.rc})`);
  let report: any = null;
  try {
    report = JSON.parse(wd.out);
  } catch {
    fail(`C WATCHDOG OK: watchdog --json output did not parse: ${wd.out.slice(0, 200)}`);
  }
  if (report) {
    check(report.tick?.alive === false, `C WATCHDOG OK: watchdog says the tick agent is dead`);
    check(report.needsRestart === true, `C WATCHDOG OK: watchdog says a restart is needed`);
    check(
      Array.isArray(report.pending?.heldRuns) && report.pending.heldRuns.includes(gateRun),
      `C WATCHDOG OK: pending work lists the held gate ${gateRun}`,
    );
    check(
      Array.isArray(report.pending?.stuckRunning) && report.pending.stuckRunning.includes(sleepRun),
      `C WATCHDOG OK: pending work lists the stranded run ${sleepRun}`,
    );
  }
  // C5: recovery — everything from the clean shell (cwd /tmp,
  // scrubbed env, fresh CLI processes). No in-process Host, no
  // leftover ambient state: the state dir alone carries the runs.
  const list = cliClean(["queue", "list", "--state-dir", STATE_DIR]);
  check(list.rc === 0 && list.out.includes(gateRun) && list.out.includes(sleepRun), `C CLEAN OK: queue list from /tmp sees both runs (rc ${list.rc})`);
  const res1 = cliClean(["result", gateRun, "--state-dir", STATE_DIR]);
  check(res1.rc === 2 && (res1.out + res1.err).includes("GATE PENDING"), `C CLEAN OK: result on the held run from /tmp exits 2, GATE PENDING`);
  const del = cliClean(["deliver-gate", gateRun, '{"answer":"no"}', "--state-dir", STATE_DIR]);
  check(del.rc === 0, `C CLEAN OK: deliver-gate from /tmp exited 0 (got ${del.rc})`);
  check(queueStatus(gateRun) === "queued", `C CLEAN OK: ${gateRun} re-queued after delivery (got ${queueStatus(gateRun)})`);
  const repair = cliClean(["queue", "repair", "--state-dir", STATE_DIR]);
  check(repair.rc === 0 && repair.out.includes(`REPAIR ${sleepRun}: running -> queued`), `C CLEAN OK: repair re-queued ${sleepRun} from /tmp`);
  // The sleep's remaining wait is ~5s (12s sleep, 4s waited, ~3s
  // of pre-recovery calls). A full re-wait would be 12s + overhead.
  // Bounds 2500–9500ms prove the remainder was waited, not the full
  // duration and not nothing; the trap-to-completion span below
  // proves the same thing from the journal alone.
  const t0 = Date.now();
  const rec = cliClean(["queue", "run", "--clock", "real", "--state-dir", STATE_DIR]);
  const recMs = Date.now() - t0;
  check(rec.rc === 0, `C RECOVER OK: queue run from /tmp exited 0 (got ${rec.rc})`);
  if (rec.rc !== 0) fail(`C RECOVER ERR: ${rec.err.slice(0, 300)}`);
  check(
    recMs > 2500 && recMs < 9500,
    `C TIMING OK: clean-shell re-drive took ${recMs}ms (bounds 2500–9500ms — remaining sleep, not a full re-wait)`,
  );
  const gateOut = getResult(gateRun);
  check(gateOut?.done === true, `C RESULT OK: ${gateRun} completed with done true (got ${JSON.stringify(gateOut)})`);
  const sleepOut = getResult(sleepRun);
  check(sleepOut?.sleptMs === 12000, `C RESULT OK: ${sleepRun} completed with sleptMs 12000 (got ${JSON.stringify(sleepOut)})`);
  check(queueStatus(gateRun) === "done", `C QUEUE OK: ${gateRun} done (got ${queueStatus(gateRun)})`);
  check(queueStatus(sleepRun) === "done", `C QUEUE OK: ${sleepRun} done (got ${queueStatus(sleepRun)})`);
  const gateEvents = readJournal(gateRun);
  check(gateEvents.some((e) => e.event === "gate-held"), `C JOURNAL OK: ${gateRun} journal has gate-held`);
  check(gateEvents.some((e) => e.event === "trap-result"), `C JOURNAL OK: ${gateRun} journal has trap-result after delivery`);
  check(gateEvents.some((e) => e.event === "lifecycle" && e.lifecycle === "completed"), `C JOURNAL OK: ${gateRun} journal has completed`);
  const sleepDispatches = trapDispatches(sleepRun, sleepTrap);
  check(sleepDispatches.length === 2, `C JOURNAL OK: ${sleepRun} has two trap-dispatch events (got ${sleepDispatches.length})`);
  check(sleepDispatches[1]?.redispatched === true, `C JOURNAL OK: ${sleepRun} second trap-dispatch is redispatched`);
  // The journal alone proves one 12s sleep, not two: trap to
  // completion is ~12s (kill at 4s + ~5s remainder + overhead), not
  // ~16s (a full 12s re-wait after the kill) and not ~5s (skipped).
  const sleepTrapEv = readJournal(sleepRun).find((e) => e.event === "trap" && e.trapId === sleepTrap);
  const sleepDoneEv = readJournal(sleepRun).find((e) => e.event === "lifecycle" && e.lifecycle === "completed");
  const sleepSpanMs = Date.parse(sleepDoneEv?.wallTs ?? "") - Date.parse(sleepTrapEv?.wallTs ?? "");
  check(
    sleepSpanMs > 10000 && sleepSpanMs < 14000,
    `C SPAN OK: ${sleepRun} trap to completion took ${sleepSpanMs}ms (bounds 10000–14000ms — one 12s sleep across both attempts)`,
  );
}

// ------------------------------------------------------------ D. missing engine binary
async function testMissingEngineBinary(): Promise<void> {
  console.log("\n=== D. missing engine binary fails loudly (the replacement rebuild-step detector) ===");
  const missing = path.join(WORKDIR, "durablets-gone");
  // Control: the real binary (via run.sh's $DURABLETS_HOST) works.
  const good = cli(["queue", "list", "--state-dir", STATE_DIR]);
  check(good.rc === 0, `D CONTROL OK: queue list with the real binary exited 0 (got ${good.rc})`);
  // Fault: $DURABLETS_HOST points at a path that no longer exists —
  // what a VM replacement does to the pinned build. The host must
  // fail LOUDLY naming the path, not silently run a different
  // binary from the repo tree (the old resolveHostPath fallback).
  const bad = cli(["queue", "list", "--state-dir", STATE_DIR], { DURABLETS_HOST: missing });
  check(bad.rc !== 0, `D LOUD OK: queue list with a missing binary exited non-zero (got ${bad.rc})`);
  check(
    (bad.out + bad.err).includes("C host binary not found") && (bad.out + bad.err).includes(missing),
    `D LOUD OK: error names the missing binary path (got ${(bad.out + bad.err).trim().slice(0, 300)})`,
  );
}

async function main(): Promise<number> {
  await testCronAcrossRestart();
  await startServer();
  try {
    await testCompleteNeverLands();
    await testColdStartAfterFullKill();
    await testMissingEngineBinary();
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
  console.log(`\n--- evidence ---`);
  console.log(`workdir: ${WORKDIR}`);
  if (FAILURES.length) {
    console.log(`\nFAIL bra67 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log(
    "\nPASS bra67 fault-injection coverage suite (cron across restart, complete-job never lands, VM-replacement cold start from a clean shell, missing engine binary fails loudly)",
  );
  return 0;
}

process.exit(await main());
