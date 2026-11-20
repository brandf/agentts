#!/usr/bin/env bun
/**
 * Queue-drive self-deadlock (Linear BRA-175).
 *
 * POST /queue/run drives the queue with a Host INSIDE the server
 * process (driverHost). A run submitted with --adapter muse then
 * dispatches its job traps through the muse adapter — whose sync
 * calls (ensureServer's /health check, /enqueue, /job-status polling)
 * are synchronous curl spawns against THIS server. driveToCompletion
 * is fully synchronous, so the server's event loop is blocked for
 * the whole drive and every one of those calls times out against it:
 * ensureServer throws after the 2s health-check timeout and the run
 * fails, even though the pool is healthy and the worker is waiting.
 *
 * The fix (direction (c) in the brief): the server drives the queue
 * in a CHILD process (agentts queue run), so its event loop stays
 * free and the pool path works exactly as the CLI path does. Skipping
 * the health check alone (direction (a)) cannot fix this — the
 * /enqueue POST and the /job-status polls would deadlock next, on
 * their 10s timeouts. Making the check async (direction (b)) cannot
 * work either — answer() runs inside the synchronous drive loop and
 * cannot await.
 *
 * This test proves the end-to-end path: a muse-adapter run (the
 * BRA-73 job workflow + slow-worker fixture) submitted to a scratch
 * server, driven ONLY through POST /queue/run, must complete with
 * the script pool worker's live verdict. It FAILS on unfixed code
 * (the entry ends "failed" with the ensureServer error) and PASSES
 * on fixed code.
 *
 *   DURABLETS_HOST=<built C host> DQUICKTS=<dquickts tree> bun tests/test-bra175.ts
 *   (run.sh sets both.)
 *
 * Run outputs go to $BRA175_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The worker server + worker processes are killed
 * in a finally block, even on failure. Exit 0 on PASS, 1 on any
 * mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";

import { Host } from "../src/host";
import { MuseAdapter } from "../plugins/muse/src/muse-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA175_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra175-"));
const STATE_DIR = path.join(WORKDIR, "state");
const WORKSPACES = path.join(WORKDIR, "workspaces");
const WORKERS_JSON = path.join(WORKDIR, "workers.json");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });

const PORT = Number(process.env.AGENTTS_WORKER_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// The submitting Host must point at THIS server (standing rule:
// any test that submits in-process sets AGENTTS_WORKER_SERVER first,
// or notifyEvent posts to the production port 18741).
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

function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readJournal(runId: string): any[] {
  const p = path.join(STATE_DIR, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readJobsLog(): any[] {
  const p = path.join(STATE_DIR, "worker-jobs", "jobs.log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function http(method: "GET" | "POST", p: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER_URL}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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

async function main(): Promise<number> {
  console.log("=== BRA-175. pool job driven ONLY through POST /queue/run ===");
  fs.writeFileSync(
    WORKERS_JSON,
    JSON.stringify({ "bra73-slow": path.join(ROOT, "tests", "fixtures", "slow-worker.ts") }, null, 2),
  );
  const server = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT), "--lease-ms", "5000", "--max-attempts", "3"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const workerProcs: Subprocess[] = [];
  try {
    const up = await waitFor(async () => {
      try {
        const r = await http("GET", "/health", undefined, 5000);
        if (r.status !== 200 || r.body?.ok !== true) return false;
        if (r.body?.stateDir !== STATE_DIR) {
          throw new Error(`a stale worker server is already on port ${PORT} (state ${r.body?.stateDir}, want ${STATE_DIR}) — kill it and re-run`);
        }
        return true;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("a stale worker server")) throw e;
        return false;
      }
    }, 15_000, "worker server /health");
    if (!up) {
      const err = server.stderr ? await new Response(server.stderr).text().catch(() => "") : "";
      fail(`server did not come up: ${err.slice(0, 500)}`);
      return 1;
    }
    console.log(`server up on ${SERVER_URL}`);
    const worker = spawn(
      [BUN, path.join(ROOT, "plugins", "muse", "worker-loop.ts"), "--server", SERVER_URL, "--worker-id", "w-bra175", "--workspace-root", WORKSPACES, "--workers-config", WORKERS_JSON, "--poll-ms", "300"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    workerProcs.push(worker);
    console.log("worker w-bra175 started");

    // Submit a muse-adapter run (the BRA-73 job workflow). The
    // submit itself never dispatches a job, so it is safe in-process;
    // the DRIVE below is what must go through the server endpoint.
    const workflow = path.join(ROOT, "tests", "workflows", "workflow-bra73-job.ts");
    const runId = "run-bra175-queue";
    const host = new Host({ stateDir: STATE_DIR, adapter: new MuseAdapter({ serverUrl: SERVER_URL }) });
    host.submit(workflow, { runId, input: { sleepMs: 100 } });
    const queued = readQueue().find((e) => e.runId === runId);
    check(!!queued, "SUBMIT OK: muse run enqueued");
    check(queued?.adapter === "muse", `SUBMIT OK: queue entry records adapter muse (got ${queued?.adapter ?? "missing"})`);

    // THE drive: only through POST /queue/run. No in-process
    // host.runQueue() here — that is the CLI path, which never
    // deadlocked.
    const t0 = Date.now();
    let drive: { status: number; body: any };
    try {
      drive = await http("POST", "/queue/run", {});
    } catch (e) {
      fail(`DRIVE FAIL: POST /queue/run threw (${e instanceof Error ? e.message : String(e)})`);
      return 1;
    }
    const driveMs = Date.now() - t0;
    console.log(`POST /queue/run returned ${drive.status} in ${driveMs}ms`);
    check(drive.status === 200, `DRIVE OK: POST /queue/run returns 200 (got ${drive.status}: ${JSON.stringify(drive.body).slice(0, 300)})`);
    check(Array.isArray(drive.body?.entries), "DRIVE OK: response carries entries");
    check(
      Array.isArray(drive.body?.repair?.actions),
      `DRIVE OK: response carries the repair report (got ${JSON.stringify(drive.body?.repair)?.slice(0, 120) ?? "missing"})`,
    );
    check(drive.body?.failed !== true, `DRIVE OK: response does not report failed runs (failed=${drive.body?.failed})`);

    const entry = readQueue().find((e) => e.runId === runId);
    check(entry?.status === "done", `RUN OK: queue entry done (got ${entry?.status ?? "missing"}${entry?.error ? `: ${String(entry.error).slice(0, 300)}` : ""})`);
    const res = host.result(runId);
    check(res.status === "done", `RUN OK: result done (got ${res.status} ${res.error ?? ""})`);
    check((res.output as any)?.sleptMs === 100, `RUN OK: worker slept 100ms (got ${JSON.stringify(res.output)})`);

    const events = readJournal(runId);
    const jobTrap = events.find((e) => e.event === "trap" && e.type === "job");
    check(!!jobTrap, "POOL OK: job trap in the journal");
    const trapResult = jobTrap ? events.find((e) => e.event === "trap-result" && e.trapId === jobTrap.trapId) : null;
    check(!!trapResult, `POOL OK: trap-result present for ${jobTrap?.trapId ?? "?"}`);
    check(
      trapResult?.worker === "w-bra175",
      `POOL OK: trap-result.worker is the actual pool worker (got ${JSON.stringify(trapResult?.worker)})`,
    );
    check(
      trapResult?.adapter === "muse",
      `POOL OK: trap-result.adapter is muse (got ${JSON.stringify(trapResult?.adapter)})`,
    );
    const dispatched = jobTrap ? events.find((e) => e.event === "trap-dispatched" && e.trapId === jobTrap.trapId) : null;
    check(
      (dispatched?.result as any)?.worker === "w-bra175",
      `POOL OK: trap-dispatched answer carries worker w-bra175 (got ${JSON.stringify((dispatched?.result as any)?.worker)})`,
    );
    check(
      !events.some((e) => e.event === "lifecycle" && e.lifecycle === "failed"),
      "POOL OK: no lifecycle-failed event in the journal",
    );
    const completed = readJobsLog().filter((e) => e.event === "job-completed" && e.spec === "bra73-slow");
    check(completed.length === 1, `POOL OK: jobs.log shows exactly one bra73-slow completion (got ${completed.length})`);
  } finally {
    for (const p of workerProcs) {
      try {
        p.kill();
      } catch {
        /* already dead */
      }
    }
    try {
      server.kill();
    } catch {
      /* already dead */
    }
  }

  if (FAILURES.length > 0) {
    console.log(`\nFAIL bra175 queue-drive pool dispatch (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("\nPASS bra175 queue-drive pool dispatch (muse run driven only through POST /queue/run, live pool verdict)");
  return 0;
}

process.exit(await main());
