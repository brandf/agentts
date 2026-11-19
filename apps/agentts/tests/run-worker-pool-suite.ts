#!/usr/bin/env bun
/**
 * Worker-pool test driver (Linear BRA-48).
 *
 * Proves the subagent pool end to end through the REAL host with Bun
 * worker processes running the loop script (genuine computation over
 * real inputs, not canned answers). The coordinator runs the TRUE
 * Muse-subagent leg afterwards by spawning real subagents against
 * the same queue (see plugins/muse/WORKER.md for their instructions
 * and plugins/muse/README.md for the commands).
 *
 *   DURABLETS_HOST=<built C host> bun tests/run-worker-pool-suite.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the swap test.)
 *
 * Run outputs go to $WORKER_POOL_WORKDIR (scratch, set by run.sh) or
 * a fresh mkdtemp dir. The host stateDir IS the workdir's state/
 * subdir; the queue server, worker workspaces, and workers config
 * all live under the same scratch dir — never in the staged tree.
 * Exit 0 on PASS, 1 on any mismatch. The server + worker processes
 * are killed in a finally block, even on failure.
 *
 * What is proven (each with its evidence file):
 *   A. Scheduler unit: affinity-reserved / affinity-match /
 *      fallback-oldest / held-for-other decisions.
 *   B. JudgeFixLoop end to end through the pool: 9 jobs, each
 *      delivered EXACTLY ONCE (jobs.log), real scores, converged.
 *   C. Crash/timeout: a killed worker's job re-queues on lease
 *      expiry and completes exactly once on retry.
 *   D. Affinity across runs: the same spec goes to the same worker
 *      (scheduler.log decision "affinity-reserved").
 *   E. Cancel: a queued job and a running job both cancel; the run
 *      resumes by throwing JobCancelled at the call site (workflow
 *      catches it, finally runs, run completes).
 *   F. JSON boundary: a valid-JSON wrong-shape result is accepted by
 *      the server and REJECTED host-side (ValidationError journaled).
 *   G. File effects: a worker's created file returns as full
 *      contents with the completion; its LEARNING line lands in
 *      notes/<spec>.md.
 *   H. Malformed complete-job body is a 400 and the job is untouched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { Host } from "../src/host";
import { MuseAdapter } from "../plugins/muse/src/muse-adapter";
import { AffinityScheduler } from "../src/scheduler";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_WORKER_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const WORKDIR = process.env.WORKER_POOL_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "worker-pool-"));
const STATE_DIR = path.join(WORKDIR, "state");
const WORKSPACES = path.join(WORKDIR, "workspaces");
const WORKERS_JSON = path.join(WORKDIR, "workers.json");
fs.mkdirSync(STATE_DIR, { recursive: true });
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
    await sleep(250);
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

const workerProcs: Subprocess[] = [];
function killWorkers(): void {
  for (const c of workerProcs) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
  workerProcs.length = 0;
}

// ------------------------------------------------------------ A. scheduler
function testSchedulerUnit(): void {
  console.log("\n=== A. scheduler unit (affinity rule) ===");
  const s = new AffinityScheduler({ affinityHoldMs: 8000, affinityTtlMs: 30 * 60_000 });
  const t0 = 1_000_000;
  const affFor = (spec: string): string | null => (spec === "judge" ? "w1" : null);
  const w1 = { id: "w1", lastSpec: "judge", lastCompletedAt: t0 - 1000, completedAtBySpec: { judge: t0 - 1000 } };
  const w2 = { id: "w2", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} };
  const queued = [
    { jobId: "j1", spec: "judge", enqueuedAt: t0 },
    { jobId: "j2", spec: "aggregate", enqueuedAt: t0 + 10 },
  ];
  let sel = s.selectJobForWorker(w1, queued, t0 + 100, affFor);
  check(sel.job?.jobId === "j1" && sel.decision === "affinity-reserved", `RESERVED OK: warm specialist gets its job inside the hold window (got ${sel.decision} ${sel.job?.jobId})`);
  sel = s.selectJobForWorker(w2, queued, t0 + 100, affFor);
  check(sel.job?.jobId === "j2" && sel.decision === "fallback-oldest", `HELD-FOR-OTHER OK: the other worker takes the oldest takeable job, not the reserved one (got ${sel.decision} ${sel.job?.jobId})`);
  sel = s.selectJobForWorker(w2, [{ jobId: "j1", spec: "judge", enqueuedAt: t0 }], t0 + 100, affFor);
  check(sel.job === null && sel.decision === "none-available", `HELD OK: a job reserved for another worker is not takeable (got ${sel.decision})`);
  sel = s.selectJobForWorker(w1, queued, t0 + 9000, affFor);
  check(sel.job?.jobId === "j1" && sel.decision === "affinity-match", `MATCH OK: past the hold window the warm worker still prefers its spec (got ${sel.decision} ${sel.job?.jobId})`);
  const cold = { id: "w3", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} };
  sel = s.selectJobForWorker(cold, queued, t0 + 9000, () => null);
  check(sel.job?.jobId === "j1" && sel.decision === "fallback-oldest", `FALLBACK OK: a cold worker takes the oldest job (got ${sel.decision} ${sel.job?.jobId})`);
  sel = s.selectJobForWorker(cold, [], t0, () => null);
  check(sel.job === null && sel.decision === "none-available", "EMPTY OK: empty queue is none-available");
  // Warmth decay: a completion older than the TTL is not affinity.
  const stale = { id: "w1", lastSpec: "judge", lastCompletedAt: t0 - 31 * 60_000, completedAtBySpec: { judge: t0 - 31 * 60_000 } };
  sel = s.selectJobForWorker(stale, queued, t0 + 9000, () => null);
  check(sel.job?.jobId === "j1" && sel.decision === "fallback-oldest", `DECAY OK: a stale completion (past TTL) is not an affinity match (got ${sel.decision})`);
}

// ------------------------------------------------------------ server + workers
async function startServer(): Promise<Subprocess> {
  const proc = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT), "--lease-ms", "5000", "--max-attempts", "3", "--affinity-hold-ms", "8000", "--affinity-ttl-ms", String(30 * 60_000)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const up = await waitFor(async () => {
    try {
      const r = await http("GET", "/health");
      if (r.status !== 200 || r.body?.ok !== true) return false;
      // A stale server from an earlier run on the same port would
      // answer with a DIFFERENT state dir — refuse it loudly rather
      // than testing against someone else's queue.
      if (r.body?.stateDir !== STATE_DIR) {
        throw new Error(
          `a stale worker server is already on port ${PORT} (state ${r.body?.stateDir}, want ${STATE_DIR}) — kill it and re-run`,
        );
      }
      return true;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("a stale worker server")) throw e;
      return false;
    }
  }, 15_000, "worker server /health");
  if (!up) {
    const err = proc.stderr ? await new Response(proc.stderr).text().catch(() => "") : "";
    fail(`server did not come up: ${err.slice(0, 500)}`);
  } else {
    console.log(`server up on ${SERVER_URL} (lease 5000ms, maxAttempts 3, affinityHold 8000ms)`);
  }
  return proc;
}

function startWorker(workerId: string): Subprocess {
  const proc = spawn(
    [BUN, path.join(ROOT, "plugins", "muse", "worker-loop.ts"), "--server", SERVER_URL, "--worker-id", workerId, "--workspace-root", WORKSPACES, "--workers-config", WORKERS_JSON, "--poll-ms", "300"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  workerProcs.push(proc);
  console.log(`worker ${workerId} started (pid ${proc.pid})`);
  return proc;
}

async function runCli(args: string[], timeoutMs = 120_000): Promise<{ rc: number; out: string; err: string }> {
  const proc = spawn([BUN, path.join(ROOT, "src", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL, AGENTTS_STATE_DIR: STATE_DIR },
  });
  const [out, err, rc] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ].map((p) => Promise.race([p, sleep(timeoutMs).then(() => { try { proc.kill("SIGKILL"); } catch {} return -1 as any; })])));
  return { rc: rc as number, out: out as string, err: err as string };
}

// ------------------------------------------------------------ B. JFL end to end
async function testJflEndToEnd(): Promise<void> {
  console.log("\n=== B. JudgeFixLoop end to end through the pool ===");
  const runId = "run-pool-jfl";
  const host = new Host({ stateDir: STATE_DIR, adapter: new MuseAdapter({ serverUrl: SERVER_URL }) });
  // The pool test drives the run through the host's run path
  // (submit -> queue -> result) with the Muse adapter recorded on
  // the queue entry; runQueue drives with that adapter.
  const input = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "judge-fix-loop-input.json"), "utf8"));
  host.submit(path.join(TESTS, "workflow-judge-fix-loop.ts"), { runId, input });
  await host.runQueue();
  const res = host.result(runId);
  if (res.status !== "done") {
    fail(`jfl-pool: run ended ${res.status} (${res.error ?? "no error"})`);
    console.log(host.output(runId));
    return;
  }
  const out = host.output(runId);
  console.log(out);
  check(out.includes("loop 1: 0 approved, 0 failed, mean 0.67"), "JFL POOL OK: loop 1 aggregate is 0.67 (real worker scores, not canned)");
  check(out.includes("loop 2: converged"), "JFL POOL OK: converged at loop 2");
  const resultLine = out.split("\n").find((l) => l.startsWith("result:"));
  const result = resultLine ? JSON.parse(resultLine.slice("result: ".length)) : null;
  check(result !== null && result.converged === true && result.loops === 2, `JFL POOL OK: converged in 2 loops (got ${JSON.stringify(result)?.slice(0, 120)})`);
  check(
    result !== null && typeof result.item?.text === "string" && result.item.text.includes("russet coat flashed golden"),
    "JFL POOL OK: the revised text carries the fix worker's vivid sentence (a real transformation)",
  );
  const jobs = readLog("jobs.log");
  const completed = jobs.filter((e) => e.event === "job-completed");
  const failed = jobs.filter((e) => e.event === "job-failed");
  const requeued = jobs.filter((e) => e.event === "job-timeout-requeue" || e.event === "job-error-requeue");
  const byId = new Map<string, number>();
  for (const c of completed) byId.set(c.jobId, (byId.get(c.jobId) ?? 0) + 1);
  const dupes = [...byId.entries()].filter(([, n]) => n !== 1);
  check(completed.length === 9, `ONCE OK: 9 job-completed events (got ${completed.length})`);
  check(dupes.length === 0, `ONCE OK: every jobId completed exactly once (dupes: ${JSON.stringify(dupes)})`);
  check(failed.length === 0, `ONCE OK: no job failed (got ${failed.length})`);
  check(requeued.length === 0, `ONCE OK: no job re-queued (got ${requeued.length})`);
  const specs = completed.map((c) => c.spec).sort().join(",");
  check(specs === "aggregate,aggregate,fix,judge,judge,judge,judge,judge,judge", `SPECS OK: 6 judge + 2 aggregate + 1 fix (got ${specs})`);
  check(host.registrySize() === 0, "REGISTRY OK: empty after completion");
}

// ------------------------------------------------------------ C. crash/timeout
async function testCrashRequeue(): Promise<void> {
  console.log("\n=== C. crash/timeout re-queue ===");
  const enq = await http("POST", "/enqueue", {
    spec: "slow-sleeper",
    input: { sleepMs: 8000 },
    runId: "run-pool-crash",
    trapId: "run-pool-crash/trap-0",
  });
  check(enq.status === 200 && typeof enq.body?.jobId === "string", `ENQUEUE OK: slow job ${enq.body?.jobId}`);
  const jobId: string = enq.body.jobId;
  const worker = startWorker("w-crash");
  const running = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${jobId}`);
    return r.body?.status === "running" && r.body?.workerId === "w-crash";
  }, 15_000, `slow job ${jobId} running on w-crash`);
  if (!running) return;
  console.log(`slow job running on w-crash — SIGKILL the worker mid-job`);
  worker.kill("SIGKILL");
  await sleep(500);
  const requeued = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${jobId}`);
    return r.body?.status === "queued" && r.body?.attempts === 1;
  }, 20_000, `slow job ${jobId} re-queued after lease expiry`);
  if (!requeued) return;
  check(true, "REQUEUE OK: lease expiry re-queued the crashed worker's job (attempts 1)");
  const events = readLog("jobs.log").filter((e) => e.jobId === jobId);
  check(events.some((e) => e.event === "job-timeout-requeue"), "LOG OK: jobs.log has job-timeout-requeue for the crashed job");
  const w2 = startWorker("w-crash2");
  const done = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${jobId}`);
    return r.body?.status === "completed";
  }, 20_000, `slow job ${jobId} completed on retry`);
  if (!done) return;
  const completed = readLog("jobs.log").filter((e) => e.jobId === jobId && e.event === "job-completed");
  check(completed.length === 1, `ONCE OK: the crashed job completed exactly once on retry (got ${completed.length})`);
  check(completed[0]?.workerId === "w-crash2", `RETRY OK: a different worker completed the retried job (got ${completed[0]?.workerId})`);
  const status = await http("GET", `/job-status?jobId=${jobId}`);
  check(status.body?.result?.sleptMs === 8000, `RESULT OK: retried job returned its real result (sleptMs 8000, got ${JSON.stringify(status.body?.result)})`);
  w2.kill("SIGKILL");
}

// ------------------------------------------------------------ D. affinity
async function testAffinityAcrossRuns(): Promise<string | null> {
  console.log("\n=== D. affinity across runs (same spec -> same worker) ===");
  // The last judge completed in the JFL run names the specialist.
  const jobs = readLog("jobs.log");
  const judgeCompletions = jobs.filter((e) => e.event === "job-completed" && e.spec === "judge");
  if (!judgeCompletions.length) {
    fail("affinity: no judge completions in jobs.log to name the specialist");
    return null;
  }
  const specialist = judgeCompletions[judgeCompletions.length - 1].workerId as string;
  console.log(`specialist for "judge" is ${specialist} (last judge completion)`);
  const other = specialist === "w1" ? "w2" : "w1";
  startWorker(specialist);
  startWorker(other);
  await sleep(1000); // let both workers register with a poll
  const enq = await http("POST", "/enqueue", {
    spec: "judge",
    input: {
      item: { text: "The quick brown fox jumps over the lazy dog.", goal: "A vivid opening." },
      rubric: { criteria: ["vivid", "concrete", "concise"], threshold: 0.8 },
      judge: 1,
    },
    runId: "run-pool-affinity",
    trapId: "run-pool-affinity/trap-0",
  });
  const jobId: string = enq.body.jobId;
  const done = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${jobId}`);
    return r.body?.status === "completed";
  }, 20_000, `affinity judge job ${jobId} completed`);
  if (!done) return null;
  const status = await http("GET", `/job-status?jobId=${jobId}`);
  check(status.body?.workerId === specialist, `AFFINITY OK: the judge job went to the specialist ${specialist} (got ${status.body?.workerId})`);
  const sched = readLog("scheduler.log").filter((e) => e.jobId === jobId);
  check(sched.some((e) => e.decision === "affinity-reserved"), `SCHEDULER OK: scheduler.log records affinity-reserved for ${jobId} (decisions: ${sched.map((e) => e.decision).join(",")})`);
  check(typeof status.body?.result?.score === "number", `RESULT OK: affinity job returned a real verdict (score ${status.body?.result?.score})`);
  return specialist;
}

// ------------------------------------------------------------ E. cancel
async function testCancelQueued(): Promise<void> {
  console.log("\n=== E1. cancel a QUEUED job (run resumes by throwing) ===");
  // No workers running: the job stays queued, so the cancel is a
  // queued-cancel. (Workers from D are killed by the caller.)
  const runId = "run-pool-cancel-q";
  const cli = runCli(["run", path.join(TESTS, "workflow-muse-cancel.ts"), "--adapter", "muse", "--state-dir", STATE_DIR, "--run-id", runId, "--wait"]);
  const enqueued = await waitFor(async () => {
    const r = await http("GET", "/jobs");
    const list: any[] = r.body?.jobs ?? [];
    return list.some((j) => j.runId === runId && j.status === "queued");
  }, 20_000, `cancel workflow's job queued for ${runId}`);
  if (!enqueued) {
    const res = await cli;
    fail(`cancel-queued: job never queued (cli rc ${res.rc}: ${res.out.slice(0, 300)} ${res.err.slice(0, 300)})`);
    return;
  }
  const jobs = await http("GET", "/jobs");
  const job = (jobs.body.jobs as any[]).find((j) => j.runId === runId);
  const cancel = await http("POST", "/cancel-job", { jobId: job.jobId, reason: "test cancel of queued job" });
  check(cancel.status === 200 && cancel.body?.status === "cancelled", `CANCEL OK: queued job ${job.jobId} cancelled via API`);
  const res = await cli;
  check(res.rc === 0, `RUN OK: the run completed after catching the cancellation (cli rc ${res.rc}, err: ${res.err.slice(0, 200)})`);
  // The workflow's prints live in the run's .out file — the CLI's
  // --wait prints only the result JSON, not the workflow's stdout.
  const out = new Host({ stateDir: STATE_DIR }).output(runId);
  check(out.includes("caught: JobCancelled"), `THROW OK: JobCancelled arrived at the call site (out: ${out.split("\n").filter((l) => l.includes("caught")).join(" | ")})`);
  check(out.includes("caught is Error: true"), "ERROR OK: the caught cancellation is a real Error");
  check(out.includes("finally ran"), "FINALLY OK: finally ran after the cancellation");
  check(out.includes("done, caught: JobCancelled"), "DONE OK: the workflow finished after catching");
  const events = readLog("jobs.log").filter((e) => e.jobId === job.jobId);
  check(events.some((e) => e.event === "job-cancelled"), "LOG OK: jobs.log has job-cancelled for the queued job");
  check(!events.some((e) => e.event === "job-completed"), "NO COMPLETE OK: the cancelled job never completed");
}

async function testCancelRunning(): Promise<void> {
  console.log("\n=== E2. cancel a RUNNING job (worker abandons it) ===");
  const worker = startWorker("w-run");
  const runId = "run-pool-cancel-r";
  const cli = runCli(["run", path.join(TESTS, "workflow-muse-cancel.ts"), "--adapter", "muse", "--state-dir", STATE_DIR, "--run-id", runId, "--wait"]);
  const running = await waitFor(async () => {
    const r = await http("GET", "/jobs");
    const list: any[] = r.body?.jobs ?? [];
    return list.some((j) => j.runId === runId && j.status === "running" && j.workerId === "w-run");
  }, 20_000, `cancel workflow's job running on w-run for ${runId}`);
  if (!running) {
    const res = await cli;
    fail(`cancel-running: job never ran on w-run (cli rc ${res.rc}: ${res.out.slice(0, 300)} ${res.err.slice(0, 300)})`);
    worker.kill("SIGKILL");
    return;
  }
  const jobs = await http("GET", "/jobs");
  const job = (jobs.body.jobs as any[]).find((j) => j.runId === runId);
  const cancel = await http("POST", "/cancel-job", { jobId: job.jobId, reason: "test cancel of running job" });
  check(cancel.status === 200 && cancel.body?.status === "cancelled", `CANCEL OK: running job ${job.jobId} cancelled via API`);
  const res = await cli;
  check(res.rc === 0, `RUN OK: the run completed after catching the running cancellation (cli rc ${res.rc})`);
  const out = new Host({ stateDir: STATE_DIR }).output(runId);
  check(out.includes("caught: JobCancelled"), "THROW OK: JobCancelled arrived at the call site for the running job");
  const events = readLog("jobs.log").filter((e) => e.jobId === job.jobId);
  check(events.some((e) => e.event === "job-cancelled"), "LOG OK: jobs.log has job-cancelled for the running job");
  check(!events.some((e) => e.event === "job-completed"), "NO COMPLETE OK: the cancelled running job never completed");
  // The worker abandoned the job (heartbeat saw cancelled) and is
  // still alive polling for the next job.
  await sleep(1000);
  const alive = worker.exitCode === null;
  check(alive, "WORKER OK: the worker survived the cancel (it abandoned the job, it did not die)");
  worker.kill("SIGKILL");
}

// ------------------------------------------------------------ F. boundary
async function testJsonBoundary(): Promise<void> {
  console.log("\n=== F. JSON boundary (server accepts JSON, host rejects the wrong shape) ===");
  const worker = startWorker("w-bad");
  const runId = "run-pool-bad-shape";
  const host = new Host({ stateDir: STATE_DIR, adapter: new MuseAdapter({ serverUrl: SERVER_URL }) });
  host.submit(path.join(TESTS, "workflow-muse-bad-shape.ts"), { runId });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "failed", `RUN OK: the run failed on the wrong-shape result (status ${res.status})`);
  const errors = host.journal(runId).filter((e) => e.event === "validation-error");
  check(errors.length >= 1, `JOURNAL OK: validation-error journaled (got ${errors.length})`);
  if (errors.length) {
    check(errors[0].phase === "output", `PHASE OK: phase output (got ${errors[0].phase})`);
    const paths = JSON.stringify(errors[0].errors);
    check(paths.includes("$.score") || paths.includes("score"), `PRECISE OK: the error names the missing score field (${paths.slice(0, 200)})`);
  }
  const jobs = readLog("jobs.log");
  const jobEvents = jobs.filter((e) => e.spec === "bad-shape");
  check(jobEvents.some((e) => e.event === "job-completed"), "SERVER OK: the server accepted the valid-JSON result (job-completed) — the rejection is host-side");
  worker.kill("SIGKILL");
}

// ------------------------------------------------------------ G. file effects
async function testFileEffects(): Promise<void> {
  console.log("\n=== G. file effects + learnings ===");
  const worker = startWorker("w-file");
  const enq = await http("POST", "/enqueue", {
    spec: "file-writer",
    input: { text: "pool proof note" },
    runId: "run-pool-file",
    trapId: "run-pool-file/trap-0",
  });
  const jobId: string = enq.body.jobId;
  const done = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${jobId}`);
    return r.body?.status === "completed";
  }, 20_000, `file-writer job ${jobId} completed`);
  if (!done) {
    worker.kill("SIGKILL");
    return;
  }
  const status = await http("GET", `/job-status?jobId=${jobId}`);
  const files: any[] = status.body?.files ?? [];
  check(files.length === 1 && files[0].path === "note.txt", `FILES OK: one file effect returned (got ${JSON.stringify(files.map((f) => f.path))})`);
  check(files[0]?.content === "pool proof note\n", `CONTENT OK: the returned file has the exact bytes the worker wrote (got ${JSON.stringify(files[0]?.content)})`);
  check(status.body?.result?.ok === true, "RESULT OK: the file-writer result crossed with the files");
  const notes = await http("GET", "/notes?spec=file-writer");
  check(
    typeof notes.body?.notes === "string" && notes.body.notes.includes("note.txt is the effect to return"),
    `NOTES OK: the worker's LEARNING line landed in notes/file-writer.md (${JSON.stringify(notes.body?.notes ?? "").slice(0, 120)})`,
  );
  worker.kill("SIGKILL");
}

// ------------------------------------------------------------ H. malformed body
async function testMalformedComplete(): Promise<void> {
  console.log("\n=== H. malformed complete-job body ===");
  const enq = await http("POST", "/enqueue", {
    spec: "slow-sleeper",
    input: { sleepMs: 1000 },
    runId: "run-pool-malformed",
    trapId: "run-pool-malformed/trap-0",
  });
  const jobId: string = enq.body.jobId;
  const res = await fetch(`${SERVER_URL}/complete-job`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check(res.status === 400, `REJECT OK: malformed JSON body is a 400 (got ${res.status})`);
  const status = await http("GET", `/job-status?jobId=${jobId}`);
  check(status.body?.status === "queued", `UNTOUCHED OK: the job is still queued after the rejected completion (got ${status.body?.status})`);
  await http("POST", "/cancel-job", { jobId, reason: "test cleanup" });
}

// ------------------------------------------------------------ main
async function main(): Promise<number> {
  console.log(`Worker pool tests — workdir ${WORKDIR}`);
  if (!process.env.DURABLETS_HOST) {
    console.log("FAIL: DURABLETS_HOST is not set — run via ./run.sh (it builds the C host and sets it)");
    return 1;
  }
  // Workers config: the JFL specs + fixtures, all real scripts.
  const workerScript = path.join(ROOT, "workflows", "library", "worker.ts");
  const fixtures = path.join(ROOT, "tests", "fixtures");
  fs.writeFileSync(
    WORKERS_JSON,
    JSON.stringify(
      {
        judge: workerScript,
        fix: workerScript,
        aggregate: workerScript,
        "rubric-update": workerScript,
        "slow-sleeper": path.join(fixtures, "slow-worker.ts"),
        "bad-shape": path.join(fixtures, "bad-worker.ts"),
        "file-writer": path.join(fixtures, "file-writer.ts"),
      },
      null,
      2,
    ),
  );
  testSchedulerUnit();
  let server: Subprocess | null = null;
  try {
    server = await startServer();
    // B: two workers share the JFL run.
    const w1 = startWorker("w1");
    const w2 = startWorker("w2");
    await testJflEndToEnd();
    w1.kill("SIGKILL");
    w2.kill("SIGKILL");
    await sleep(500);
    // C: crash/re-queue (own workers).
    await testCrashRequeue();
    // D: affinity (restarts w1/w2 by id — history is server-side).
    await testAffinityAcrossRuns();
    // Kill the affinity workers before the queued-cancel test (the
    // job must stay queued until we cancel it). The server stays up.
    killWorkers();
    await sleep(500);
    // E1: queued cancel (no workers running).
    await testCancelQueued();
    // E2: running cancel (one worker).
    await testCancelRunning();
    // F: boundary (own worker).
    await testJsonBoundary();
    // G: file effects (own worker).
    await testFileEffects();
    // H: malformed body (no worker needed).
    await testMalformedComplete();
  } finally {
    killWorkers();
    if (server) {
      try {
        server.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }
  const jobs = readLog("jobs.log");
  const sched = readLog("scheduler.log");
  console.log(`\n--- evidence ---`);
  console.log(`workdir: ${WORKDIR}`);
  console.log(`jobs.log events: ${jobs.length} (${jobs.filter((e) => e.event === "job-completed").length} completed, ${jobs.filter((e) => e.event === "job-cancelled").length} cancelled, ${jobs.filter((e) => e.event === "job-timeout-requeue").length} timeout-requeues)`);
  console.log(`scheduler.log decisions: ${sched.length} (${[...new Set(sched.map((e) => e.decision))].join(", ")})`);
  if (FAILURES.length) {
    console.log(`\nFAIL worker pool suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log("\nPASS worker pool end to end (scheduler unit, JFL through the pool, crash re-queue, affinity, cancel queued+running, JSON boundary, file effects, malformed body)");
  return 0;
}

process.exit(await main());
