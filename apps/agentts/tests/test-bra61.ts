#!/usr/bin/env bun
/**
 * Stuck-worker robustness test (Linear BRA-61, rescoped).
 *
 * Proves the four additions on top of the existing lease/heartbeat/
 * re-queue safety net (which already existed — 5-minute lease,
 * 1-second sweep, /heartbeat, maxAttempts 3, delivery-once):
 *
 *   A. Nudge: a silent worker is messaged before its lease expires
 *      (job-nudged in jobs.log, a "job-nudged" tick event, and the
 *      nudge message on its next heartbeat — delivered once).
 *   B. Idempotency: a non-idempotent jobspec's silent job FAILS on
 *      lease expiry instead of re-queuing (JobNotRetried); an
 *      idempotent spec (declared or default) re-queues as before.
 *   C. Cost-derived lease: the lease comes from the cost-model p90
 *      for the spec (x2, clamped) when actuals exist, the server
 *      default when they do not, and an explicit per-enqueue lease
 *      wins over both.
 *   D. Journal surfacing: a real run driven through the muse
 *      adapter lands job-nudged / job-requeued / job-attempt events
 *      in its run journal as they happen — not only in jobs.log.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra61.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the tick suite.)
 *
 * Run outputs go to $BRA61_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The server + worker + CLI processes are killed
 * in a finally block, even on failure. Exit 0 on PASS, 1 on any
 * mismatch.
 *
 * What this does NOT prove (stated plainly): a heartbeating worker
 * that never completes is nudged once and surfaced to the tick
 * agent, but the server does NOT cancel it on its own — cancelling
 * a live worker is a coordinator decision (see the nudge design in
 * worker-server.ts). The nudge is the warning; the escalation is
 * human/agent judgment.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_BRA61_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

// Lease 4s: nudge at 2s, expiry at 4s — fast enough to test, slow
// enough that the 1s sweep sees each transition exactly once.
const LEASE_MS = 4000;

const WORKDIR = process.env.BRA61_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra61-"));
const STATE_DIR = path.join(WORKDIR, "state");
const JOBSPEC_DIR = path.join(WORKDIR, "jobspecs");
const WORKSPACES = path.join(WORKDIR, "workspaces");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(JOBSPEC_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

// Cost-model actuals for section C (seeded BEFORE the server starts
// — the server loads them in its constructor). Site job:bra61-costly
// has three 60s actuals: p90 60000, so the derived lease is 120000.
fs.mkdirSync(path.join(STATE_DIR, "worker-jobs"), { recursive: true });
fs.writeFileSync(
  path.join(STATE_DIR, "worker-jobs", "cost-model.json"),
  JSON.stringify({
    "job:bra61-costly": { n: 3, sum: 180000, sumSq: 10800000000, tokens: 0, samples: [60000, 60000, 60000] },
  }),
);

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Take a queued job as a fake silent worker (raw HTTP, no loop
 * script, no heartbeat, no completion — the stuck shape). */
async function fakeTake(workerId: string): Promise<string | null> {
  const r = await http("GET", `/get-job?workerId=${encodeURIComponent(workerId)}&waitMs=0`);
  const job = r.body?.job ?? null;
  if (!job) return null;
  return job.jobId as string;
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

// ------------------------------------------------------------ A. nudge
async function testNudge(): Promise<void> {
  console.log("\n=== A. nudge (silent worker warned before expiry) ===");
  // Drain stale tick events so the nudge event is unambiguous.
  await http("GET", "/tick?timeoutMs=100");
  const enq = await http("POST", "/enqueue", {
    spec: "bra61-silent",
    input: {},
    runId: "bra61-a",
    trapId: "bra61-a/trap-0",
  });
  check(enq.status === 200 && typeof enq.body?.jobId === "string", `ENQUEUE OK: silent job ${enq.body?.jobId}`);
  const jobId: string = enq.body.jobId;
  const taken = await fakeTake("w-bra61-silent");
  check(taken === jobId, `TAKE OK: fake worker holds ${jobId} (got ${taken})`);
  // The nudge fires at half the lease (2s) of runtime with no
  // completion — before the lease expires at 4s.
  const nudged = await waitFor(
    () => readLog("jobs.log").some((e) => e.jobId === jobId && e.event === "job-nudged"),
    10_000,
    `job ${jobId} nudged`,
  );
  if (!nudged) return;
  const nudgeEv = readLog("jobs.log").find((e) => e.jobId === jobId && e.event === "job-nudged");
  check(
    typeof nudgeEv?.silentMs === "number" && nudgeEv.silentMs >= 1000,
    `NUDGE OK: jobs.log has job-nudged for ${jobId} (silentMs ${nudgeEv?.silentMs})`,
  );
  const status = await http("GET", `/job-status?jobId=${jobId}`);
  check(status.body?.nudgeCount === 1, `NUDGE OK: job record nudgeCount 1 (got ${status.body?.nudgeCount})`);
  check(typeof status.body?.nudgedAt === "number", `NUDGE OK: job record carries nudgedAt`);
  // The tick agent wakes on the nudge event (the layer that can
  // actually message the worker session).
  const tick = await http("GET", "/tick?timeoutMs=1000");
  const nudgedTick = (tick.body?.events ?? []).some(
    (e: any) => e.type === "job-nudged" && e.jobId === jobId,
  );
  check(nudgedTick, `NUDGE OK: tick carried job-nudged for ${jobId}`);
  // The nudge message arrives on the worker's next heartbeat — and
  // exactly once.
  const beat1 = await http("POST", "/heartbeat", { jobId, workerId: "w-bra61-silent" });
  check(
    beat1.status === 200 && typeof beat1.body?.nudge?.message === "string" && beat1.body.nudge.message.includes(jobId),
    `NUDGE OK: heartbeat delivered the nudge message (${JSON.stringify(beat1.body?.nudge)?.slice(0, 80)}…)`,
  );
  const beat2 = await http("POST", "/heartbeat", { jobId, workerId: "w-bra61-silent" });
  check(beat2.status === 200 && beat2.body?.nudge === undefined, `NUDGE OK: second heartbeat carries no nudge (delivered once)`);
  // The heartbeat extended the lease, so the re-queue lands later —
  // but it still lands, and the nudge preceded it.
  const requeued = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${jobId}`);
    return r.body?.status === "queued" && r.body?.attempts === 1;
  }, 15_000, `job ${jobId} re-queued after lease expiry`);
  if (!requeued) return;
  const log = readLog("jobs.log").filter((e) => e.jobId === jobId);
  const nudgeIdx = log.findIndex((e) => e.event === "job-nudged");
  const requeueIdx = log.findIndex((e) => e.event === "job-timeout-requeue");
  check(nudgeIdx >= 0 && requeueIdx > nudgeIdx, `ORDER OK: nudge (log ${nudgeIdx}) precedes re-queue (log ${requeueIdx})`);
  // Clean up: cancel the re-queued job so it does not linger.
  await http("POST", "/cancel-job", { jobId, reason: "bra61 section A cleanup" });
}

// ------------------------------------------------------------ B. idempotency
async function testIdempotency(): Promise<void> {
  console.log("\n=== B. idempotency policy (non-idempotent fails, idempotent re-queues) ===");
  fs.writeFileSync(
    path.join(JOBSPEC_DIR, "bra61-nonidem.md"),
    `# Job spec: bra61-nonidem\n\n<!-- idempotency: non-idempotent -->\n\nA job with side effects: it must never be silently re-run.\n`,
  );
  fs.writeFileSync(
    path.join(JOBSPEC_DIR, "bra61-idem.md"),
    `# Job spec: bra61-idem\n\n<!-- idempotency: idempotent -->\n\nPure computation: safe to re-run.\n`,
  );
  // B1: non-idempotent — lease expiry FAILS the job, no re-queue.
  const bad = await http("POST", "/enqueue", { spec: "bra61-nonidem", input: {}, runId: "bra61-b1", trapId: "bra61-b1/trap-0" });
  const badId: string = bad.body.jobId;
  const badTaken = await fakeTake("w-bra61-nonidem");
  check(badTaken === badId, `TAKE OK: fake worker holds non-idempotent ${badId}`);
  const failed = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${badId}`);
    return r.body?.status === "failed";
  }, 15_000, `non-idempotent job ${badId} failed on expiry`);
  if (failed) {
    const st = await http("GET", `/job-status?jobId=${badId}`);
    check(st.body?.error?.name === "JobNotRetried", `POLICY OK: failure is JobNotRetried (got ${st.body?.error?.name})`);
    check(
      typeof st.body?.error?.message === "string" && st.body.error.message.includes("non-idempotent"),
      `POLICY OK: failure names the policy`,
    );
    check(st.body?.idempotent === false, `POLICY OK: job record idempotent=false`);
    const log = readLog("jobs.log").filter((e) => e.jobId === badId);
    check(
      log.some((e) => e.event === "job-failed" && e.reason === "lease-expired-non-idempotent"),
      `POLICY OK: jobs.log has job-failed/lease-expired-non-idempotent`,
    );
    check(!log.some((e) => e.event === "job-timeout-requeue"), `POLICY OK: no re-queue for the non-idempotent job`);
  }
  // B2: declared idempotent — lease expiry re-queues as before.
  const good = await http("POST", "/enqueue", { spec: "bra61-idem", input: {}, runId: "bra61-b2", trapId: "bra61-b2/trap-0" });
  const goodId: string = good.body.jobId;
  const goodTaken = await fakeTake("w-bra61-idem");
  check(goodTaken === goodId, `TAKE OK: fake worker holds idempotent ${goodId}`);
  const goodRequeued = await waitFor(async () => {
    const r = await http("GET", `/job-status?jobId=${goodId}`);
    return r.body?.status === "queued" && r.body?.attempts === 1;
  }, 15_000, `idempotent job ${goodId} re-queued`);
  if (goodRequeued) {
    const st = await http("GET", `/job-status?jobId=${goodId}`);
    check(st.body?.idempotent === true, `POLICY OK: declared-idempotent job record idempotent=true`);
    check(st.body?.requeueReason === "lease-expired", `POLICY OK: requeueReason lease-expired (got ${st.body?.requeueReason})`);
  }
  await http("POST", "/cancel-job", { jobId: goodId, reason: "bra61 section B cleanup" });
  // B3: no declaration and no spec file — the default is idempotent.
  const nodecl = await http("POST", "/enqueue", { spec: "bra61-nofile", input: {}, runId: "bra61-b3", trapId: "bra61-b3/trap-0" });
  const nodeclId: string = nodecl.body.jobId;
  const st3 = await http("GET", `/job-status?jobId=${nodeclId}`);
  check(st3.body?.idempotent === true, `DEFAULT OK: undeclared spec defaults to idempotent=true`);
  await http("POST", "/cancel-job", { jobId: nodeclId, reason: "bra61 section B cleanup" });
}

// ------------------------------------------------------------ C. cost-derived lease
async function testCostLease(): Promise<void> {
  console.log("\n=== C. cost-derived lease (p90 x2, clamped; explicit wins; default otherwise) ===");
  // Seeded actuals: job:bra61-costly p90 60000 -> lease 120000.
  const costly = await http("POST", "/enqueue", { spec: "bra61-costly", input: {}, runId: "bra61-c1", trapId: "bra61-c1/trap-0" });
  const costlyId: string = costly.body.jobId;
  const st1 = await http("GET", `/job-status?jobId=${costlyId}`);
  check(st1.body?.leaseMs === 120000, `LEASE OK: cost-derived lease 120000 (got ${st1.body?.leaseMs})`);
  check(st1.body?.leaseSource === "cost-model", `LEASE OK: leaseSource cost-model (got ${st1.body?.leaseSource})`);
  check(st1.body?.estDurationMs === 60000, `LEASE OK: estDurationMs 60000 (got ${st1.body?.estDurationMs})`);
  await http("POST", "/cancel-job", { jobId: costlyId, reason: "bra61 section C cleanup" });
  // No actuals: the server default (the --lease-ms flag, 4000).
  const unknown = await http("POST", "/enqueue", { spec: "bra61-unknown", input: {}, runId: "bra61-c2", trapId: "bra61-c2/trap-0" });
  const unknownId: string = unknown.body.jobId;
  const st2 = await http("GET", `/job-status?jobId=${unknownId}`);
  check(st2.body?.leaseMs === LEASE_MS, `LEASE OK: no actuals -> server default ${LEASE_MS} (got ${st2.body?.leaseMs})`);
  check(st2.body?.leaseSource === "default", `LEASE OK: leaseSource default (got ${st2.body?.leaseSource})`);
  await http("POST", "/cancel-job", { jobId: unknownId, reason: "bra61 section C cleanup" });
  // Explicit per-enqueue lease wins over the cost model.
  const explicit = await http("POST", "/enqueue", { spec: "bra61-costly", input: {}, leaseMs: 7000, runId: "bra61-c3", trapId: "bra61-c3/trap-0" });
  const explicitId: string = explicit.body.jobId;
  const st3 = await http("GET", `/job-status?jobId=${explicitId}`);
  check(st3.body?.leaseMs === 7000, `LEASE OK: explicit lease 7000 wins (got ${st3.body?.leaseMs})`);
  check(st3.body?.leaseSource === "explicit", `LEASE OK: leaseSource explicit (got ${st3.body?.leaseSource})`);
  await http("POST", "/cancel-job", { jobId: explicitId, reason: "bra61 section C cleanup" });
}

// ------------------------------------------------------------ D. journal surfacing
async function testJournalSurfacing(): Promise<void> {
  console.log("\n=== D. journal surfacing (nudge + re-queue + retry land in the run journal) ===");
  const runId = "bra61-journal";
  const inputFile = path.join(WORKDIR, "bra61-input.json");
  fs.writeFileSync(inputFile, JSON.stringify({ sleepMs: 100 }));
  const workersJson = path.join(WORKDIR, "workers.json");
  fs.writeFileSync(
    workersJson,
    JSON.stringify({ "slow-sleeper": path.join(ROOT, "tests", "fixtures", "slow-worker.ts") }, null, 2),
  );
  // Drive the run in a child process (the CLI blocks in the muse
  // adapter's wait loop; this process must stay free to fake-take
  // the job and start the real worker).
  const cliProc = spawn(
    [
      BUN,
      path.join(ROOT, "src", "cli.ts"),
      "run",
      path.join(ROOT, "tests", "workflows", "workflow-bra61-slow.ts"),
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
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL } },
  );
  const cliDone = (async () => {
    await cliProc.exited;
    return cliProc.exitCode ?? 1;
  })();
  try {
    // Wait for the slow-sleeper job to appear, then take it as a
    // fake silent worker (no real worker is running yet, so the
    // take cannot lose a race).
    const jobId = await (async (): Promise<string | null> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const jobs = await http("GET", "/jobs");
        const j = (jobs.body?.jobs ?? []).find((x: any) => x.spec === "slow-sleeper" && x.runId === runId);
        if (j && j.status === "queued") {
          const taken = await fakeTake("w-bra61-fake");
          if (taken) return taken;
        }
        if (j && j.status === "running" && j.workerId === "w-bra61-fake") return j.jobId;
        await sleep(200);
      }
      return null;
    })();
    check(typeof jobId === "string" && !!jobId, `TAKE OK: fake worker holds the run's slow-sleeper job (${jobId})`);
    if (!jobId) return;
    // Let the nudge fire (half the 4s lease), then the expiry.
    const nudged = await waitFor(
      () => readLog("jobs.log").some((e) => e.jobId === jobId && e.event === "job-nudged"),
      10_000,
      `job ${jobId} nudged`,
    );
    if (!nudged) return;
    const requeued = await waitFor(async () => {
      const r = await http("GET", `/job-status?jobId=${jobId}`);
      return r.body?.status === "queued" && r.body?.attempts === 1;
    }, 15_000, `job ${jobId} re-queued`);
    if (!requeued) return;
    // Now the real worker completes the retried job.
    startLoopWorker("w-bra61-real", workersJson);
    const rc = await Promise.race([
      cliDone,
      sleep(60_000).then(() => -1),
    ]);
    check(rc === 0, `RUN OK: CLI run --wait exited 0 (got ${rc})`);
    if (rc !== 0) {
      try {
        cliProc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      return;
    }
    // The run journal must show the mid-flight events as they
    // happened — nudge, re-queue, and the retry attempt on the new
    // worker — with the run's runId and the job's jobId.
    const journalPath = path.join(STATE_DIR, "journals", `${runId}.journal`);
    check(fs.existsSync(journalPath), `JOURNAL OK: journal file exists for ${runId}`);
    if (!fs.existsSync(journalPath)) return;
    const events = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const nudgedEv = events.find((e) => e.event === "job-nudged" && e.jobId === jobId);
    check(!!nudgedEv, `JOURNAL OK: job-nudged in the run journal for ${jobId}`);
    check(nudgedEv?.runId === runId, `JOURNAL OK: job-nudged carries runId ${runId}`);
    const requeuedEv = events.find((e) => e.event === "job-requeued" && e.jobId === jobId);
    check(!!requeuedEv, `JOURNAL OK: job-requeued in the run journal for ${jobId}`);
    check(requeuedEv?.reason === "lease-expired", `JOURNAL OK: job-requeued names lease-expired (got ${requeuedEv?.reason})`);
    check(requeuedEv?.attempts === 1, `JOURNAL OK: job-requeued attempts 1 (got ${requeuedEv?.attempts})`);
    // The retry attempt under the real worker (the first attempt
    // under w-bra61-fake may also appear if the first poll ran while
    // queued — match the retry's worker specifically).
    const attemptEv = events.find(
      (e) => e.event === "job-attempt" && e.jobId === jobId && e.workerId === "w-bra61-real",
    );
    check(!!attemptEv, `JOURNAL OK: job-attempt in the run journal for ${jobId}`);
    check(attemptEv?.attempts === 1, `JOURNAL OK: job-attempt attempts 1 (got ${attemptEv?.attempts})`);
    const nudgeIdx = events.findIndex((e) => e.event === "job-nudged" && e.jobId === jobId);
    const requeueIdx = events.findIndex((e) => e.event === "job-requeued" && e.jobId === jobId);
    check(nudgeIdx >= 0 && requeueIdx > nudgeIdx, `ORDER OK: journal nudge precedes re-queue`);
  } finally {
    if ((await Promise.race([cliDone, sleep(1000).then(() => -2)])) === -2) {
      try {
        cliProc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }
}

async function main(): Promise<number> {
  await startServer();
  try {
    await testNudge();
    await testIdempotency();
    await testCostLease();
    await testJournalSurfacing();
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
    `jobs.log events: ${jobs.length} (${jobs.filter((e) => e.event === "job-nudged").length} nudged, ${jobs.filter((e) => e.event === "job-timeout-requeue").length} timeout-requeues, ${jobs.filter((e) => e.event === "job-failed").length} failed)`,
  );
  if (FAILURES.length) {
    console.log(`\nFAIL bra61 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log("\nPASS bra61 stuck-worker suite (nudge, idempotency policy, cost-derived lease, journal surfacing)");
  return 0;
}

process.exit(await main());
