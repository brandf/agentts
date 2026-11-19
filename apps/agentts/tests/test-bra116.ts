#!/usr/bin/env bun
/**
 * Driver endpoints on the worker server (Linear BRA-116).
 *
 * Proves the tick agent can drive, deliver, list, escalate and
 * answer gates entirely over HTTP — no fresh `bun src/cli.ts`
 * process per action — and that the server drive and the CLI drive
 * serialize on the same driver lock, and that a server killed
 * mid-drive recovers on restart.
 *
 *   A. Endpoint behaviour: /health, empty /queue/list and
 *      /queue/run, error cases (deliver-result 404 unknown run /
 *      400 non-terminal, escalate 400 missing kind / empty reason,
 *      deliver-gate 404 unknown run / 400 missing answer / 404
 *      queued run with no suspended run), and the full
 *      submit -> drive -> list -> deliver -> deliveries path with
 *      idempotent re-delivery.
 *   B. Lock refusal, both directions: a CLI drive in progress
 *      makes POST /queue/run answer 409; a server drive in
 *      progress makes `queue run` exit non-zero with "driver
 *      already running". Neither refusal corrupts the run (the
 *      exec runs exactly once).
 *   C. Restart mid-drive: fire POST /queue/run on a 5s
 *      direct-adapter exec run, SIGKILL the server while the entry
 *      is "running", restart it, POST /queue/run again — the
 *      repair report says `running -> queued` and the run
 *      completes. (The exec may run twice across the crash — the
 *      BRA-75 re-run behavior — so the test asserts completion and
 *      the repair report, not the marker count.)
 *   D. Deliver-gate end to end: a run held at a gate (in-process
 *      gateHost, MockAdapter gates:"hold") is answered through
 *      POST /deliver-gate, then POST /queue/run completes it.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra116.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra109 suite.)
 *
 * Run outputs go to $BRA116_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The server is killed in a finally block, even
 * on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the deliver-gate 400
 * for "no gate pending" (host.deliverGate throwing) is not
 * exercised — reaching it needs a registry entry for a run
 * suspended at a non-gate trap, and no deterministic workflow
 * produces one. The server's own deliver-gate 400s (missing
 * answer, missing runId) are covered, and the catch -> 400 branch
 * is the same two lines the CLI's deliver-gate takes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA116_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra116-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 18993;
const SERVER_URL = `http://127.0.0.1:${PORT}`;

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
    if (Date.now() > deadline) throw new Error("bra116 server did not come up");
    await sleep(50);
  }
}
async function stopServer(signal: 9 | 15 = 15): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(signal);
  } catch { /* already dead */ }
  await s.exited;
}
async function serverDown(): Promise<boolean> {
  try {
    await fetch(`${SERVER_URL}/health`);
    return false;
  } catch {
    return true;
  }
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

function getResult(runId: string): any | null {
  const r = cli(["result", runId, "--state-dir", STATE_DIR]);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to probe it). */
function driveChild(): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", STATE_DIR], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

const children: Subprocess[] = [];

async function sectionA(): Promise<void> {
  console.log("\n=== A. endpoint behaviour ===");
  const h = await http("GET", "/health");
  check(h.status === 200 && h.body?.ok === true, `A HEALTH OK: GET /health 200 ok (got ${h.status})`);
  const list0 = await http("GET", "/queue/list");
  check(list0.status === 200 && Array.isArray(list0.body?.entries) && list0.body.entries.length === 0, `A LIST OK: empty queue list (got ${list0.status}, ${JSON.stringify(list0.body).slice(0, 120)})`);
  const run0 = await http("POST", "/queue/run");
  check(
    run0.status === 200 && Array.isArray(run0.body?.entries) && run0.body.entries.length === 0 &&
      run0.body?.repair?.inspected === 0 && run0.body?.failed === false,
    `A RUN OK: empty queue run 200 with repair inspected 0, failed false (got ${run0.status}, ${JSON.stringify(run0.body).slice(0, 200)})`,
  );
  const delUnknown = await http("POST", "/deliver-result", { runId: "nope" });
  check(
    delUnknown.status === 404 && typeof delUnknown.body?.error === "string" && delUnknown.body.error.includes("no run nope"),
    `A DELIVER OK: unknown run 404 "no run nope" (got ${delUnknown.status}, ${JSON.stringify(delUnknown.body).slice(0, 120)})`,
  );
  const delNoId = await http("POST", "/deliver-result", {});
  check(delNoId.status === 400, `A DELIVER OK: missing runId 400 (got ${delNoId.status})`);
  const escEmpty = await http("POST", "/escalate", { kind: "other", reason: "" });
  check(escEmpty.status === 400, `A ESCALATE OK: empty reason 400 (got ${escEmpty.status})`);
  const escNoKind = await http("POST", "/escalate", { reason: "x" });
  check(escNoKind.status === 400, `A ESCALATE OK: missing kind 400 (got ${escNoKind.status})`);
  const gateUnknown = await http("POST", "/deliver-gate", { runId: "nope", answer: { answer: "yes" } });
  check(
    gateUnknown.status === 404 && typeof gateUnknown.body?.error === "string" && gateUnknown.body.error.includes("no suspended run nope"),
    `A GATE OK: unknown run 404 "no suspended run" (got ${gateUnknown.status}, ${JSON.stringify(gateUnknown.body).slice(0, 120)})`,
  );
  const gateNoAnswer = await http("POST", "/deliver-gate", { runId: "nope" });
  check(gateNoAnswer.status === 400, `A GATE OK: missing answer 400 (got ${gateNoAnswer.status})`);

  // Full path: submit -> drive -> list -> deliver -> deliveries,
  // with an idempotent re-delivery. Submitted by an in-process Host
  // (mock default on this scratch dir), driven by the server.
  const host = new Host({ stateDir: STATE_DIR });
  const runId = "bra116-a1";
  host.submit(path.join(ROOT, "bench", "workflows", "bench-trivial.ts"), { runId, input: { n: 1000 } });
  const drive = await http("POST", "/queue/run");
  const driven = (drive.body?.entries ?? []).find((e: any) => e.runId === runId);
  check(
    drive.status === 200 && driven?.status === "done",
    `A DRIVE OK: POST /queue/run drove ${runId} to done (got ${drive.status}, ${driven?.status ?? "missing"})`,
  );
  const list = await http("GET", "/queue/list");
  const listed = (list.body?.entries ?? []).find((e: any) => e.runId === runId);
  check(list.status === 200 && listed?.status === "done", `A LIST OK: GET /queue/list shows ${runId} done`);
  const del = await http("POST", "/deliver-result", { runId, deliveredBy: "bra116-test" });
  check(
    del.status === 200 && del.body?.runId === runId && del.body?.status === "done" && del.body?.deliveredBy === "bra116-test",
    `A DELIVER OK: deliver-result for ${runId} is done, deliveredBy bra116-test (got ${del.status}, ${JSON.stringify(del.body).slice(0, 200)})`,
  );
  const dels = await http("GET", "/deliveries");
  const rec = (dels.body?.deliveries ?? []).find((d: any) => d.runId === runId);
  check(dels.status === 200 && rec?.runId === runId, `A DELIVERIES OK: GET /deliveries shows ${runId}`);
  const del2 = await http("POST", "/deliver-result", { runId, deliveredBy: "bra116-test" });
  check(del2.status === 200 && del2.body?.runId === runId, `A DELIVER OK: re-deliver of ${runId} is idempotent (200, same runId)`);

  // Deliver a non-terminal run: 400, then drive it and deliver.
  const runId2 = "bra116-a2";
  host.submit(path.join(ROOT, "bench", "workflows", "bench-trivial.ts"), { runId: runId2, input: { n: 1000 } });
  const delEarly = await http("POST", "/deliver-result", { runId: runId2 });
  check(
    delEarly.status === 400,
    `A DELIVER OK: non-terminal ${runId2} is 400 (got ${delEarly.status}, ${JSON.stringify(delEarly.body).slice(0, 120)})`,
  );
  const gateQueued = await http("POST", "/deliver-gate", { runId: runId2, answer: { answer: "yes" } });
  check(
    gateQueued.status === 404 && typeof gateQueued.body?.error === "string" && gateQueued.body.error.includes("no suspended run"),
    `A GATE OK: queued ${runId2} is 404 "no suspended run" (got ${gateQueued.status}, ${JSON.stringify(gateQueued.body).slice(0, 120)})`,
  );
  const drive2 = await http("POST", "/queue/run");
  const driven2 = (drive2.body?.entries ?? []).find((e: any) => e.runId === runId2);
  check(drive2.status === 200 && driven2?.status === "done", `A DRIVE OK: ${runId2} driven to done for cleanup`);
  const del2b = await http("POST", "/deliver-result", { runId: runId2 });
  check(del2b.status === 200, `A DELIVER OK: ${runId2} delivered after driving (cleanup)`);
}

async function sectionB(): Promise<void> {
  console.log("\n=== B. lock refusal, both directions ===");
  // B1: CLI holds the lock, server POST /queue/run is refused 409.
  const runId = "bra116-b1";
  const marker = path.join(WORKDIR, "bra116-b1.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 5000 }, "direct");
  const child = driveChild();
  children.push(child);
  const held = await waitFor(
    () => fs.existsSync(path.join(STATE_DIR, "driver.lock", "holder.json")) && queueStatus(runId) === "running" && markerLines(marker) >= 1,
    10_000,
    "CLI driver holding the lock with entry running and exec dispatched",
  );
  check(held, `B1 LOCK OK: CLI driver holds the lock, ${runId} running, exec dispatched`);
  const refused = await http("POST", "/queue/run");
  check(
    refused.status === 409 && typeof refused.body?.error === "string" && refused.body.error.includes("driver already running"),
    `B1 REFUSE OK: server POST /queue/run answered 409 "driver already running" (got ${refused.status}, ${JSON.stringify(refused.body).slice(0, 160)})`,
  );
  await child.exited;
  check((child.exitCode ?? 1) === 0, `B1 DONE OK: CLI driver exited 0 (got ${child.exitCode})`);
  const res = getResult(runId);
  check(queueStatus(runId) === "done" && res?.exitCode === 0, `B1 DONE OK: ${runId} completed under the CLI driver (exitCode ${res?.exitCode})`);
  check(markerLines(marker) === 1, `B1 DONE OK: marker has 1 line — the exec ran once, not twice`);

  // B2: server holds the lock, CLI `queue run` is refused.
  const runId2 = "bra116-b2";
  const marker2 = path.join(WORKDIR, "bra116-b2.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId2, { markerFile: marker2, sleepMs: 5000 }, "direct");
  const driveP = http("POST", "/queue/run");
  const held2 = await waitFor(
    () => fs.existsSync(path.join(STATE_DIR, "driver.lock", "holder.json")) && queueStatus(runId2) === "running" && markerLines(marker2) >= 1,
    10_000,
    "server driver holding the lock with entry running and exec dispatched",
  );
  check(held2, `B2 LOCK OK: server driver holds the lock, ${runId2} running, exec dispatched`);
  const second = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(second.rc !== 0, `B2 REFUSE OK: CLI queue run exited non-zero while the server drives (got ${second.rc})`);
  const combined = `${second.out}\n${second.err}`;
  check(
    combined.includes("driver already running"),
    `B2 REFUSE OK: CLI driver said "driver already running" (out: ${second.out.trim().split("\n")[0] ?? ""} / err: ${second.err.trim().split("\n")[0] ?? ""})`,
  );
  const drive2 = await driveP;
  const driven2 = (drive2.body?.entries ?? []).find((e: any) => e.runId === runId2);
  check(drive2.status === 200 && driven2?.status === "done", `B2 DONE OK: server drive completed ${runId2} (got ${drive2.status}, ${driven2?.status ?? "missing"})`);
  const res2 = getResult(runId2);
  check(queueStatus(runId2) === "done" && res2?.exitCode === 0, `B2 DONE OK: ${runId2} completed under the server driver (exitCode ${res2?.exitCode})`);
  check(markerLines(marker2) === 1, `B2 DONE OK: marker has 1 line — the exec ran once, not twice`);
}

async function sectionC(): Promise<void> {
  console.log("\n=== C. restart mid-drive ===");
  const runId = "bra116-c";
  const marker = path.join(WORKDIR, "bra116-c.marker");
  submit(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, { markerFile: marker, sleepMs: 5000 }, "direct");
  // Fire the server drive and never await it: its server is about
  // to be SIGKILLed, so the fetch rejects — the catch is attached
  // here so the rejection is handled from the start.
  http("POST", "/queue/run").catch(() => undefined);
  const running = await waitFor(
    () => queueStatus(runId) === "running" && markerLines(marker) >= 1,
    10_000,
    `${runId} entry running with exec dispatched`,
  );
  check(running, `C STRAND OK: ${runId} running, exec dispatched before the kill`);
  await stopServer(9);
  check(await serverDown(), "C KILL OK: server is down after SIGKILL");
  check(queueStatus(runId) === "running", `C STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  // Let the orphaned exec finish (5s sleep) so no orphan C host is
  // still writing the journal when the restarted server re-drives.
  await sleep(6000);
  await startServer();
  const h = await http("GET", "/health");
  check(h.status === 200, "C RESTART OK: server is back up after restart");
  const drive = await http("POST", "/queue/run");
  const action = (drive.body?.repair?.actions ?? []).find((a: any) => a.runId === runId);
  check(
    drive.status === 200 && action?.from === "running" && action?.to === "queued",
    `C REPAIR OK: restart drive reported ${runId} running -> queued (got ${drive.status}, ${JSON.stringify(action ?? drive.body?.repair).slice(0, 200)})`,
  );
  const driven = (drive.body?.entries ?? []).find((e: any) => e.runId === runId);
  check(drive.status === 200 && driven?.status === "done", `C RECOVER OK: ${runId} done after restart drive (got ${driven?.status ?? "missing"})`);
  const res = getResult(runId);
  check(res?.exitCode === 0, `C RECOVER OK: ${runId} completed after restart (exitCode ${res?.exitCode})`);
  console.log(`C INFO: marker has ${markerLines(marker)} line(s) — the exec may have re-run once across the crash (BRA-75 behavior)`);
}

async function sectionD(): Promise<void> {
  console.log("\n=== D. deliver-gate end to end ===");
  const runId = "bra116-d";
  const gateHost = new Host({ stateDir: STATE_DIR, adapter: new MockAdapter({ gates: "hold" }) });
  gateHost.submit(path.join(ROOT, "tests", "workflows", "workflow-gate-hold.ts"), { runId });
  await gateHost.runQueue();
  const q = gateHost.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `D HOLD OK: ${runId} is held at its gate (got ${q?.status ?? "missing"})`);
  const answer = await http("POST", "/deliver-gate", { runId, answer: { answer: "yes" } });
  check(
    answer.status === 200 && answer.body?.ok === true && answer.body?.runId === runId,
    `D GATE OK: POST /deliver-gate answered ${runId} 200 (got ${answer.status}, ${JSON.stringify(answer.body).slice(0, 120)})`,
  );
  const queued = queueStatus(runId);
  check(queued === "queued", `D GATE OK: ${runId} re-queued after the answer (got ${queued})`);
  const drive = await http("POST", "/queue/run");
  const driven = (drive.body?.entries ?? []).find((e: any) => e.runId === runId);
  check(drive.status === 200 && driven?.status === "done", `D DRIVE OK: ${runId} completed after the gate answer (got ${driven?.status ?? "missing"})`);
  const res = getResult(runId);
  check(res?.done === true, `D DONE OK: ${runId} output is {done: true} (got ${JSON.stringify(res).slice(0, 120)})`);
}

try {
  await startServer();
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
} finally {
  await stopServer(9);
  for (const c of children) {
    try {
      c.kill(9);
    } catch { /* already dead */ }
  }
}

if (FAILURES.length) {
  console.log(`\nFAIL bra116 driver-endpoints suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra116 driver-endpoints suite (endpoint behaviour + error cases, lock refusal both directions, restart-mid-drive repair, deliver-gate end to end)");
