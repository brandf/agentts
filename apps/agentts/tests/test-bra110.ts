#!/usr/bin/env bun
/**
 * Production deliver half (Linear BRA-110).
 *
 * Proves drive + deliver end to end on the production path: the
 * tick agent's ACTUAL loop (the scripted standin — the agent loop's
 * mechanism, see tests/tick-standin.ts) long-polls /tick, drives on
 * run-submitted, and delivers on terminal — driving a DIRECT-adapter
 * run with a REAL exec trap, with the delivery landing in the
 * outbox exactly once. Plus the failed-run delivery and the
 * deliver-refusal contract.
 *
 *   A. Tick-loop drive + deliver (done run, direct adapter, real
 *      exec): submit workflow-bra72-exec.ts via the CLI with
 *      --adapter direct; the standin drives it on the
 *      run-submitted event and delivers it. The outbox record's
 *      output is the run's validated REAL result (exitCode 0, the
 *      marker written by the exec); the exec ran exactly once; the
 *      coordinator's three reads (disk file, GET /deliveries, CLI
 *      result) agree.
 *   B. Double-delivery guard (BRA-61 idempotency): two CONCURRENT
 *      deliver-result calls plus a sequential re-delivery with a
 *      different deliveredBy leave exactly ONE outbox record file
 *      for the run, with the output unchanged. The append-only
 *      deliveries.log records one line per delivery ATTEMPT (audit,
 *      by design) — the exactly-once artifact is the record file.
 *   C. Failed-run delivery via the tick loop: the standin drives
 *      workflow-bra110-fail.ts to failed and delivers it; the
 *      record carries status failed, needsAttention true, and the
 *      error.
 *   D. Deliver refusals: unknown run 404, non-terminal run 400,
 *      missing runId 400.
 *   E. Coordinator read-back: the outbox record on disk, the GET
 *      /deliveries entry, and the CLI result output are the same
 *      validated result (same output, same runId, same status).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra110.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra117 suite.)
 *
 * Run outputs go to $BRA110_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The server + standin processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): a delivery in the
 * LIVE production state dir. This proves the production PATH — the
 * same server code, the same direct adapter, the same HTTP tick
 * loop the live tick agent runs — against a scratch server and
 * scratch state dir. The live production outbox
 * (~/workspace/agentts-state/deliveries/) still has no deliveries
 * directory until the live tick agent delivers a real run there;
 * that first live delivery is the follow-on, not this proof.
 * It also does not prove the tick AGENT (a subagent session)
 * itself — the standin is its scripted mechanism, by design.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = 20000 + Math.floor(Math.random() * 9000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const WORKDIR = process.env.BRA110_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra110-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
// CLI submits must notify THIS scratch server (not the production
// one): the submit Host posts run-submitted to AGENTTS_WORKER_SERVER.
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

/** Stable JSON stringify (sorted keys) for deep-equality checks. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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
    if (Date.now() > deadline) throw new Error("bra110 server did not come up");
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

let standin: Subprocess | null = null;
function startStandin(): void {
  standin = spawn(
    [BUN, path.join(ROOT, "tests", "tick-standin.ts"), "--state-dir", STATE_DIR, "--server", SERVER_URL, "--tick-timeout-ms", "1000", "--max-cycles", "200"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
}
async function killStandin(): Promise<void> {
  if (!standin) return;
  const s = standin;
  standin = null;
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
function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}
function deliveryFor(runId: string): any | null {
  const p = path.join(STATE_DIR, "deliveries", `${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
/** Outbox record files for one run — exactly one, or the delivery
 * is not exactly-once. */
function deliveryFileCount(runId: string): number {
  const dir = path.join(STATE_DIR, "deliveries");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f === `${runId}.json`).length;
}
/** Audit lines in deliveries.log naming one run — one per delivery
 * attempt (by design: the log is the audit trail, the .json file
 * is the exactly-once record). */
function deliveryLogLines(runId: string): number {
  const p = path.join(STATE_DIR, "deliveries", "deliveries.log");
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.includes(`"runId":"${runId}"`)).length;
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
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

function submit(workflow: string, runId: string, input: unknown, adapter?: string): void {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const args = ["run", workflow, "--run-id", runId, "--input-file", inputFile, "--state-dir", STATE_DIR];
  if (adapter) args.push("--adapter", adapter);
  const r = cli(args);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
}

async function sectionA(): Promise<void> {
  console.log("\n=== A. tick-loop drive + deliver, direct adapter, real exec ===");
  const runId = "bra110-a1";
  const marker = path.join(WORKDIR, "bra110-a1.marker");
  submit(path.join(TESTS, "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 0 }, "direct");
  startStandin();
  const delivered = await waitFor(() => deliveryFor(runId) !== null, 30_000, `delivery for ${runId}`);
  check(delivered, `A DELIVER OK: standin delivered ${runId} to the outbox`);
  await killStandin();
  if (!delivered) return;
  const rec = deliveryFor(runId);
  check(rec?.status === "done", `A DELIVER OK: ${runId} delivery status is done (got ${rec?.status})`);
  check(rec?.deliveredBy === "tick-standin", `A DELIVER OK: ${runId} deliveredBy is tick-standin (got ${rec?.deliveredBy})`);
  check(rec?.needsAttention === false, `A DELIVER OK: ${runId} done delivery needs no attention`);
  check(typeof rec?.deliveredAt === "string" && rec.deliveredAt.length > 0, `A DELIVER OK: ${runId} delivery carries deliveredAt`);
  const result = getResult(runId);
  check(
    result !== null && stable(rec?.output) === stable(result),
    `A RESULT OK: ${runId} delivery output is the validated result (got ${JSON.stringify(rec?.output)?.slice(0, 120)}, result ${JSON.stringify(result)?.slice(0, 120)})`,
  );
  check(queueStatus(runId) === "done", `A QUEUE OK: ${runId} queue entry is done (got ${queueStatus(runId)})`);
  check(markerLines(marker) === 1, `A EXEC OK: marker has 1 line — the real exec ran exactly once through the HTTP drive (got ${markerLines(marker)})`);
  check(deliveryFileCount(runId) === 1, `A OUTBOX OK: exactly one outbox record file for ${runId} (got ${deliveryFileCount(runId)})`);
  const dels = await http("GET", "/deliveries");
  const listed = (dels.body?.deliveries ?? []).filter((d: any) => d.runId === runId);
  check(dels.status === 200 && listed.length === 1, `A LIST OK: GET /deliveries shows exactly one record for ${runId} (got ${listed.length})`);
  check(
    listed.length === 1 && stable(listed[0]) === stable(rec),
    `A READ OK: GET /deliveries entry for ${runId} equals the disk record`,
  );
}

async function sectionB(): Promise<void> {
  console.log("\n=== B. double-delivery guard (BRA-61 idempotency) ===");
  const runId = "bra110-b2";
  const marker = path.join(WORKDIR, "bra110-b2.marker");
  submit(path.join(TESTS, "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 0 }, "direct");
  const drive = await http("POST", "/queue/run");
  const driven = (drive.body?.entries ?? []).find((e: any) => e.runId === runId);
  check(drive.status === 200 && driven?.status === "done", `B DRIVE OK: ${runId} driven to done over HTTP (got ${drive.status}, ${driven?.status ?? "missing"})`);
  // Two CONCURRENT deliver-result calls, then a sequential one with
  // a different deliveredBy — the guard is the single record file.
  const [c1, c2] = await Promise.all([
    http("POST", "/deliver-result", { runId, deliveredBy: "bra110-test" }),
    http("POST", "/deliver-result", { runId, deliveredBy: "bra110-test" }),
  ]);
  check(c1.status === 200 && c2.status === 200, `B DOUBLE OK: concurrent double delivery both 200 (got ${c1.status}, ${c2.status})`);
  const third = await http("POST", "/deliver-result", { runId, deliveredBy: "bra110-test-2" });
  check(third.status === 200, `B DOUBLE OK: third sequential re-delivery (different deliveredBy) 200 (got ${third.status})`);
  const result = getResult(runId);
  check(deliveryFileCount(runId) === 1, `B GUARD OK: exactly one outbox record file for ${runId} after 3 deliveries (got ${deliveryFileCount(runId)})`);
  const rec = deliveryFor(runId);
  check(
    rec !== null && result !== null && stable(rec.output) === stable(result),
    `B GUARD OK: ${runId} record output unchanged after re-delivery (still the validated result)`,
  );
  const dels = await http("GET", "/deliveries");
  const listed = (dels.body?.deliveries ?? []).filter((d: any) => d.runId === runId);
  check(listed.length === 1, `B GUARD OK: GET /deliveries shows exactly one record for ${runId} after 3 deliveries (got ${listed.length})`);
  check(markerLines(marker) === 1, `B EXEC OK: marker has 1 line — re-delivery never re-executes (got ${markerLines(marker)})`);
  const logLines = deliveryLogLines(runId);
  console.log(`B INFO: deliveries.log has ${logLines} line(s) for ${runId} — one per delivery attempt (audit, by design); the record file is the exactly-once artifact`);
  check(logLines === 3, `B LOG OK: deliveries.log has 3 audit lines for ${runId} (got ${logLines})`);
}

async function sectionC(): Promise<void> {
  console.log("\n=== C. failed-run delivery via the tick loop ===");
  const runId = "bra110-c1";
  submit(path.join(TESTS, "workflow-bra110-fail.ts"), runId, { note: "bra110 deliberate failure" }, "direct");
  startStandin();
  const delivered = await waitFor(() => deliveryFor(runId) !== null, 30_000, `delivery for ${runId}`);
  check(delivered, `C DELIVER OK: standin delivered failed ${runId} to the outbox`);
  await killStandin();
  if (!delivered) return;
  const rec = deliveryFor(runId);
  check(rec?.status === "failed", `C FAILED OK: ${runId} delivery status is failed (got ${rec?.status})`);
  check(rec?.needsAttention === true, `C FAILED OK: ${runId} failed delivery needs attention`);
  check(
    typeof rec?.error === "string" && rec.error.includes("bra110 deliberate failure"),
    `C FAILED OK: ${runId} delivery records the error (got ${String(rec?.error ?? "").slice(0, 120)})`,
  );
  check(rec?.output === undefined, `C FAILED OK: ${runId} failed delivery carries no output`);
  check(queueStatus(runId) === "failed", `C QUEUE OK: ${runId} queue entry is failed (got ${queueStatus(runId)})`);
  check(deliveryFileCount(runId) === 1, `C OUTBOX OK: exactly one outbox record file for ${runId} (got ${deliveryFileCount(runId)})`);
  const dels = await http("GET", "/deliveries");
  const listed = (dels.body?.deliveries ?? []).filter((d: any) => d.runId === runId);
  check(listed.length === 1 && listed[0]?.needsAttention === true, `C LIST OK: GET /deliveries shows the failed ${runId} with needsAttention`);
}

async function sectionD(): Promise<void> {
  console.log("\n=== D. deliver refusals ===");
  const delUnknown = await http("POST", "/deliver-result", { runId: "nope" });
  check(delUnknown.status === 404, `D REFUSE OK: unknown run 404 (got ${delUnknown.status})`);
  const delNoId = await http("POST", "/deliver-result", {});
  check(delNoId.status === 400, `D REFUSE OK: missing runId 400 (got ${delNoId.status})`);
  const runId = "bra110-d1";
  submit(path.join(TESTS, "workflow-bra72-exec.ts"), runId, { markerFile: path.join(WORKDIR, "bra110-d1.marker"), sleepMs: 0 }, "direct");
  const early = await http("POST", "/deliver-result", { runId });
  check(early.status === 400, `D REFUSE OK: non-terminal ${runId} is 400 (got ${early.status})`);
  check(deliveryFor(runId) === null, `D REFUSE OK: refused delivery wrote no outbox record for ${runId}`);
  const drive = await http("POST", "/queue/run");
  const driven = (drive.body?.entries ?? []).find((e: any) => e.runId === runId);
  check(drive.status === 200 && driven?.status === "done", `D DRIVE OK: ${runId} driven to done for cleanup`);
  const del = await http("POST", "/deliver-result", { runId });
  check(del.status === 200, `D DELIVER OK: ${runId} delivered after driving (cleanup)`);
}

async function sectionE(): Promise<void> {
  console.log("\n=== E. coordinator read-back ===");
  // The coordinator reads the outbox three ways — disk file, GET
  // /deliveries, CLI result — and they must all be the same
  // validated result for the section-A run.
  const runId = "bra110-a1";
  const disk = deliveryFor(runId);
  const dels = await http("GET", "/deliveries");
  const listed = (dels.body?.deliveries ?? []).find((d: any) => d.runId === runId);
  const result = getResult(runId);
  check(
    disk !== null && listed !== undefined && result !== null,
    `E READ OK: all three reads exist for ${runId} (disk ${disk !== null}, api ${listed !== undefined}, cli ${result !== null})`,
  );
  check(
    stable(disk?.output) === stable(listed?.output) && stable(listed?.output) === stable(result),
    `E READ OK: disk record, API entry, and CLI result agree on the output for ${runId}`,
  );
  check(
    disk?.runId === runId && listed?.runId === runId && disk?.status === "done" && listed?.status === "done",
    `E READ OK: disk record and API entry agree on runId + status for ${runId}`,
  );
}

try {
  await startServer();
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
} finally {
  await killStandin();
  await stopServer();
}

if (FAILURES.length) {
  console.log(`\nFAIL bra110 production deliver proof (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra110 production deliver proof (tick-loop drive + deliver on the direct adapter with a real exec, double-delivery guard, failed-run delivery, deliver refusals, coordinator read-back)");
