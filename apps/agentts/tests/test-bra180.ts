#!/usr/bin/env bun
/**
 * Queue drive with --workers-config (Linear BRA-180 — BRA-175
 * child-process regression).
 *
 * BRA-175 moved the queue drive into a child process (`agentts queue
 * run`). driveQueue() spawned the child with `--workers-config` but
 * no `--adapter`, so makeHost() defaulted the child to mock on a
 * scratch state dir and refused the config: every drive on a server
 * started with --workers-config failed 100% before runQueue ever
 * ran, with `--workers-config applies to the direct adapter, not
 * "mock"`. The old in-process driverHost() carried the config
 * without re-parsing CLI args, so no trial had exercised this path
 * since BRA-175 landed, and test-bra175.ts doesn't cover it.
 *
 * The fix: driveQueue() appends `--adapter direct` alongside
 * `--workers-config` (src/worker-server.ts, one line + comment).
 * The workers-config mechanism is defined as direct-only (cli.ts:139
 * — it registers worker scripts on the driver Host's DirectAdapters),
 * so forcing direct on the child is consistent, not a behavior
 * change; servers without a workers-config are untouched.
 *
 * This test proves the end-to-end path: a direct-adapter run (the
 * BRA-73 job workflow + slow-worker fixture, registered through the
 * workers-config) submitted to a scratch server started WITH
 * --workers-config, driven ONLY through POST /queue/run, must
 * complete with the worker script's live result. It FAILS on unfixed
 * code (POST /queue/run returns 500 with the exact regression error)
 * and PASSES on fixed code.
 *
 *   DURABLETS_HOST=<built C host> DQUICKTS=<dquickts tree> bun tests/test-bra180.ts
 *   (run.sh sets both.)
 *
 * Run outputs go to $BRA180_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The worker server is killed in a finally block,
 * even on failure. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "bun";

import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA180_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra180-"));
const STATE_DIR = path.join(WORKDIR, "state");
const WORKERS_JSON = path.join(WORKDIR, "workers.json");
fs.mkdirSync(STATE_DIR, { recursive: true });

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
  console.log("=== BRA-180. direct job driven ONLY through POST /queue/run on a --workers-config server ===");
  fs.writeFileSync(
    WORKERS_JSON,
    JSON.stringify({ "bra73-slow": path.join(ROOT, "tests", "fixtures", "slow-worker.ts") }, null, 2),
  );
  const server = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT), "--lease-ms", "5000", "--max-attempts", "3", "--workers-config", WORKERS_JSON],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
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
    console.log(`server up on ${SERVER_URL} (workers-config ${WORKERS_JSON})`);

    // Submit a direct-adapter run (the BRA-73 job workflow). The
    // submit itself never dispatches a job, so it is safe in-process;
    // the DRIVE below is what must go through the server endpoint.
    // The submitting Host carries the same workers-config the server
    // does (the CLI path does this too), so the trap pin records the
    // registered worker.
    const workflow = path.join(ROOT, "tests", "workflows", "workflow-bra73-job.ts");
    const runId = "run-bra180-queue";
    const host = new Host({
      stateDir: STATE_DIR,
      adapter: new DirectAdapter(),
      workersConfig: { "bra73-slow": path.join(ROOT, "tests", "fixtures", "slow-worker.ts") },
    });
    host.submit(workflow, { runId, input: { sleepMs: 100 } });
    const queued = readQueue().find((e) => e.runId === runId);
    check(!!queued, "SUBMIT OK: direct run enqueued");
    check(queued?.adapter === "direct", `SUBMIT OK: queue entry records adapter direct (got ${queued?.adapter ?? "missing"})`);

    // THE drive: only through POST /queue/run. No in-process
    // host.runQueue() here — that is the CLI path, which never
    // refused the config.
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
    check(
      !JSON.stringify(drive.body ?? {}).includes("--workers-config applies to the direct adapter"),
      "DRIVE OK: response carries no workers-config regression error",
    );
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
    check(!!jobTrap, "WORKER OK: job trap in the journal");
    const trapResult = jobTrap ? events.find((e) => e.event === "trap-result" && e.trapId === jobTrap.trapId) : null;
    check(!!trapResult, `WORKER OK: trap-result present for ${jobTrap?.trapId ?? "?"}`);
    check(
      (trapResult?.result as any)?.sleptMs === 100,
      `WORKER OK: trap-result carries the worker script's live result (got ${JSON.stringify(trapResult?.result)})`,
    );
    check(
      !events.some((e) => e.event === "lifecycle" && e.lifecycle === "failed"),
      "WORKER OK: no lifecycle-failed event in the journal",
    );
  } finally {
    try {
      server.kill();
    } catch {
      /* already dead */
    }
  }

  if (FAILURES.length > 0) {
    console.log(`\nFAIL bra180 queue-drive with workers-config (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("\nPASS bra180 queue-drive with workers-config (direct run driven only through POST /queue/run on a --workers-config server)");
  return 0;
}

process.exit(await main());
