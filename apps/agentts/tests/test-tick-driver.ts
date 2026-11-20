#!/usr/bin/env bun
/**
 * Tick driver test (Linear BRA-65 + BRA-66).
 *
 * Proves the tick-agent driver end to end through the REAL host and
 * the REAL worker server (not canned answers): the blocking
 * long-poll get-job (BRA-66), the tick long-poll + wake events
 * (BRA-65), tick + drive + deliver through the scripted standin
 * (the agent loop's mechanism — the production driver is a subagent
 * session, see plugins/muse/TICK-AGENT.md; the standin is test-only),
 * and the watchdog + VM-replacement recovery simulation.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-tick-driver.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the scheduling
 *   suite.)
 *
 * Run outputs go to $TICK_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The server + standin processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What is proven (each with its evidence):
 *   A. get-job long-poll: a get-job with no job blocks until one is
 *      enqueued (not an immediate null, not a 60s timeout); a queued
 *      job returns at once; an empty queue times out; waitMs=0 is
 *      the old immediate return.
 *   B. tick wake: a tick blocks until a system event arrives (and
 *      carries it); no events -> timedOut; a second concurrent tick
 *      is a 409; an unknown event type is a 400; tick-beat refreshes
 *      the liveness file.
 *   C. tick + drive + deliver: a submitted run is driven by the
 *      standin on the run-submitted event and its output lands in
 *      the delivery outbox.
 *   D. watchdog + VM-replacement simulation: kill every AgentTS
 *      process (server + standin) while home-dir state survives;
 *      the watchdog reports exit 2 (tick dead + pending work: a
 *      held gate and an undelivered result); a fresh server +
 *      standin resumes — the undelivered result is delivered, the
 *      held gate is escalated (never flipped), and the watchdog then
 *      reports healthy (exit 0).
 *   E. lease expiry: a job whose worker goes silent is re-queued
 *      on lease expiry and a "lease-expired" tick event fires.
 *   F. disconnect (BRA-81 fix): a get-job or tick client that
 *      disconnects mid-wait is unregistered — its parked waiter
 *      must not keep being assigned jobs (a dead worker's waiter
 *      would burn the job's attempts), and a dead tick must not
 *      hold the tick slot.
 *
 * What this does NOT prove (stated plainly): a REAL VM
 * replacement. The simulation kills processes and keeps home-dir
 * state — the observable effects of a replacement — but it cannot
 * prove the runtime actually fires the watchdog cron after a real
 * replacement. That is a platform behavior, to be verified by
 * observing a real deployment.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host, flushNotifications } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_TICK_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const WORKDIR = process.env.TICK_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "tick-driver-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
// The host's event POSTs must reach THIS server, not the default
// port: point every in-process Host (and every CLI the test spawns)
// at it.
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

/** Drain the server's pending event queue so the next tick starts
 * clean. Previous sections leave events behind (job-completed from
 * a completed job, workflow-completed from a driven run); a tick
 * returns promptly on ANY pending event, so a test that asserts a
 * specific event must start from an empty queue. */
async function flushEvents(): Promise<void> {
  await http("GET", `/tick?timeoutMs=100`);
}

/** Wait until no tick call is pending on the server. A killed
 * tick client (SIGKILL) leaves its server-side tick handler parked
 * for up to its timeout — the server holds tickPending until that
 * handler resolves — so the next tick would get a 409. The
 * production tick agent retries on 409 (see TICK-AGENT.md); the
 * test waits it out instead. */
async function waitForTickFree(timeoutMs = 5000): Promise<boolean> {
  return waitFor(
    async () => {
      try {
        const r = await http("GET", "/health");
        return r.status === 200 && r.body?.tickPending === false;
      } catch {
        return false;
      }
    },
    timeoutMs,
    "tickPending to clear",
  );
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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

let serverProc: Subprocess | null = null;
let standinProc: Subprocess | null = null;

async function startServer(): Promise<void> {
  serverProc = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)],
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

function killServer(): void {
  if (serverProc) {
    try {
      serverProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    serverProc = null;
  }
}

function startStandin(): void {
  standinProc = spawn(
    [
      BUN,
      path.join(ROOT, "tests", "tick-standin.ts"),
      "--state-dir",
      STATE_DIR,
      "--server",
      SERVER_URL,
      "--tick-timeout-ms",
      "1000",
      "--max-cycles",
      "200",
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
}

function killStandin(): void {
  if (standinProc) {
    try {
      standinProc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    standinProc = null;
  }
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

function escalations(): any[] {
  const dir = path.join(STATE_DIR, "escalations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main(): Promise<number> {
  console.log(`tick driver test: state ${STATE_DIR} server ${SERVER_URL}`);
  await startServer();

  // ---------------------------------------------------------- A. get-job long-poll
  console.log("\n=== A. get-job long-poll (BRA-66) ===");
  {
    // A1: blocks until a job arrives (not immediate, not the timeout).
    const t0 = Date.now();
    const pending = http("GET", `/get-job?workerId=w-long&waitMs=5000`);
    await sleep(1000);
    const enq = await http("POST", "/enqueue", { spec: "judge", input: { item: "x" }, runId: "a1", trapId: "a1/trap-0" });
    check(enq.status === 200 && typeof enq.body?.jobId === "string", `A1: enqueue ok (got ${enq.status})`);
    const r = await pending;
    const elapsed = Date.now() - t0;
    check(r.status === 200 && r.body?.job?.jobId === enq.body.jobId, `A1: long-poll get-job returned the enqueued job (job ${r.body?.job?.jobId ?? "none"})`);
    check(elapsed >= 800 && elapsed < 4500, `A1: get-job blocked ~${elapsed}ms (not immediate, not the 5000ms timeout)`);
    if (r.body?.job) {
      const done = await http("POST", "/complete-job", { jobId: r.body.job.jobId, workerId: "w-long", result: { score: 1 } });
      check(done.status === 200, `A1: cleanup complete-job ok (${done.status})`);
    }
  }
  {
    // A2: a queued job returns at once. Use the affinity worker
    // (w-long completed A1's "judge" job, so the affinity is w-long):
    // a different worker would be held off by the 2s affinity hold.
    const enq = await http("POST", "/enqueue", { spec: "judge", input: { item: "y" }, runId: "a2", trapId: "a2/trap-0" });
    const t0 = Date.now();
    const r = await http("GET", `/get-job?workerId=w-long&waitMs=5000`);
    const elapsed = Date.now() - t0;
    check(r.status === 200 && r.body?.job?.jobId === enq.body.jobId, `A2: queued job returned at once (${elapsed}ms)`);
    check(elapsed < 1000, `A2: immediate return took ${elapsed}ms (< 1000ms)`);
    if (r.body?.job) {
      await http("POST", "/complete-job", { jobId: r.body.job.jobId, workerId: "w-long", result: { score: 1 } });
    }
  }
  {
    // A3: an empty queue times out (returns null after ~waitMs).
    const t0 = Date.now();
    const r = await http("GET", `/get-job?workerId=w-idle&waitMs=500`);
    const elapsed = Date.now() - t0;
    check(r.status === 200 && r.body?.job === null, `A3: empty queue returned {job: null} on timeout`);
    check(elapsed >= 400 && elapsed < 2000, `A3: timeout took ~${elapsed}ms (expected ~500ms)`);
  }
  {
    // A4: waitMs=0 is the old immediate return.
    const t0 = Date.now();
    const r = await http("GET", `/get-job?workerId=w-idle&waitMs=0`);
    const elapsed = Date.now() - t0;
    check(r.status === 200 && r.body?.job === null, `A4: waitMs=0 returned {job: null} immediately (${elapsed}ms)`);
    check(elapsed < 1000, `A4: immediate return took ${elapsed}ms (< 1000ms)`);
  }
  {
    // A5: a park longer than Bun.serve()'s 10s default idleTimeout
    // must NOT reset the connection. (The server sets idleTimeout
    // to cover the 120s max long-poll; without it, any wait over
    // 10s died with ECONNRESET — the scheduling suite caught it.)
    const t0 = Date.now();
    const r = await http("GET", `/get-job?workerId=w-idle&waitMs=12000`);
    const elapsed = Date.now() - t0;
    check(r.status === 200 && r.body?.job === null, `A5: 12s park returned {job: null} (HTTP ${r.status})`);
    check(elapsed >= 11000 && elapsed < 20000, `A5: 12s park took ~${elapsed}ms (not reset at 10s)`);
  }

  // ---------------------------------------------------------- B. tick wake
  console.log("\n=== B. tick wake (BRA-65) ===");
  // BRA-172: B1/B3 post events for runIds that must exist in this
  // state dir — BRA-133 404s events for foreign runIds (runExists:
  // queue entry, registry entry, or journal). Submit real runs for
  // both ids (the section C pattern), so each event is a legit
  // run's event rather than a foreign one. submit() posts
  // run-submitted via fire-and-forget notifyEvent, so wait for the
  // POSTs to land before flushing — a late event would otherwise
  // pollute B1's one-event assertion.
  {
    const host = new Host({ stateDir: STATE_DIR });
    const r1 = host.submit(path.join(TESTS, "workflow-judges.ts"), { runId: "test-run-1" });
    check(r1.runId === "test-run-1", `B: submitted workflow-judges as test-run-1`);
    const r2 = host.submit(path.join(TESTS, "workflow-judges.ts"), { runId: "b3" });
    check(r2.runId === "b3", `B: submitted workflow-judges as b3`);
    await flushNotifications();
  }
  // Flush the stale job-completed events section A left behind
  // (a tick returns on ANY pending event).
  await flushEvents();
  {
    // B1: blocks until an event arrives, and carries it.
    const t0 = Date.now();
    const pending = http("GET", `/tick?timeoutMs=5000`);
    await sleep(1000);
    const ev = await http("POST", "/event", { type: "run-submitted", runId: "test-run-1" });
    check(ev.status === 200, `B1: POST /event ok (${ev.status})`);
    const r = await pending;
    const elapsed = Date.now() - t0;
    check(r.status === 200 && Array.isArray(r.body?.events), `B1: tick returned events (HTTP ${r.status})`);
    check(r.body?.events?.length === 1 && r.body.events[0].type === "run-submitted" && r.body.events[0].runId === "test-run-1", `B1: tick carried the run-submitted event for test-run-1`);
    check(r.body?.timedOut === false, `B1: tick did not time out`);
    check(elapsed >= 800 && elapsed < 4500, `B1: tick blocked ~${elapsed}ms (not immediate, not the 5000ms timeout)`);
  }
  {
    // B2: no events -> timedOut after ~timeoutMs.
    const t0 = Date.now();
    const r = await http("GET", `/tick?timeoutMs=500`);
    const elapsed = Date.now() - t0;
    check(r.status === 200 && r.body?.timedOut === true && Array.isArray(r.body?.events) && r.body.events.length === 0, `B2: idle tick timed out with no events`);
    check(elapsed >= 400 && elapsed < 2000, `B2: timeout took ~${elapsed}ms (expected ~500ms)`);
  }
  {
    // B3: a second concurrent tick is a 409.
    const first = http("GET", `/tick?timeoutMs=5000`);
    await sleep(200);
    const second = await http("GET", `/tick?timeoutMs=500`);
    check(second.status === 409, `B3: second concurrent tick is a 409 (got ${second.status})`);
    const ev3 = await http("POST", "/event", { type: "timer-fired", runId: "b3" });
    check(ev3.status === 200, `B3: POST /event ok (${ev3.status})`);
    const r1 = await first;
    check(r1.status === 200 && r1.body?.events?.some((e: any) => e.type === "timer-fired"), `B3: first tick resolved with the timer-fired event`);
  }
  {
    // B4: an unknown event type is a 400, and tick-beat refreshes liveness.
    const bad = await http("POST", "/event", { type: "bogus" });
    check(bad.status === 400, `B4: unknown event type is a 400 (got ${bad.status})`);
    const beat = await http("POST", "/tick-beat", {});
    check(beat.status === 200 && typeof beat.body?.lastTickAt === "string", `B4: tick-beat ok, lastTickAt ${beat.body?.lastTickAt ?? "missing"}`);
    const stateFile = path.join(STATE_DIR, "tick", "state.json");
    check(fs.existsSync(stateFile), `B4: tick liveness file exists at tick/state.json`);
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      check(Date.now() - Date.parse(st.lastTickAt) < 5000, `B4: tick liveness is fresh (< 5s old)`);
    }
  }

  // ---------------------------------------------------------- C. tick + drive + deliver
  console.log("\n=== C. tick + drive + deliver (BRA-65) ===");
  {
    const host = new Host({ stateDir: STATE_DIR });
    const { runId } = host.submit(path.join(TESTS, "workflow-judges.ts"), { runId: "tick-judges" });
    check(runId === "tick-judges", `C: submitted workflow-judges as ${runId}`);
    startStandin();
    const delivered = await waitFor(() => deliveryFor("tick-judges") !== null, 30_000, "delivery for tick-judges");
    check(delivered, `C: standin delivered tick-judges to the outbox`);
    if (delivered) {
      const rec = deliveryFor("tick-judges");
      check(rec.status === "done" && rec.output?.done === true, `C: delivery is done with output {done: true} (got ${JSON.stringify(rec.output)})`);
      check(rec.needsAttention === false, `C: done delivery needs no attention`);
    }
    const q = new Host({ stateDir: STATE_DIR }).readQueue().find((e) => e.runId === "tick-judges");
    check(q?.status === "done", `C: queue entry tick-judges is done (got ${q?.status ?? "missing"})`);
    killStandin();
  }

  // ---------------------------------------------------------- D. watchdog + VM-replacement simulation
  console.log("\n=== D. watchdog + VM-replacement simulation (BRA-65) ===");
  {
    // D1: an undelivered result — drive a run directly (no standin),
    // so it completes with no delivery record.
    const host = new Host({ stateDir: STATE_DIR });
    host.submit(path.join(TESTS, "workflow-judges.ts"), { runId: "tick-undelivered" });
    await host.runQueue();
    const q1 = host.readQueue().find((e) => e.runId === "tick-undelivered");
    check(q1?.status === "done", `D1: tick-undelivered drove to done directly (got ${q1?.status ?? "missing"})`);
    check(deliveryFor("tick-undelivered") === null, `D1: tick-undelivered has no delivery yet (undelivered)`);
    // D2: a held gate — drive the gate workflow with gates held.
    const gateHost = new Host({ stateDir: STATE_DIR, adapter: new MockAdapter({ gates: "hold" }) });
    gateHost.submit(path.join(TESTS, "workflow-gate-hold.ts"), { runId: "tick-gate" });
    await gateHost.runQueue();
    const q2 = gateHost.readQueue().find((e) => e.runId === "tick-gate");
    check(q2?.status === "held", `D2: tick-gate is held at its gate (got ${q2?.status ?? "missing"})`);
    // D3: simulate a VM replacement — kill every AgentTS process
    // (the server; the standin is already dead) and keep home-dir
    // state. No graceful shutdown: SIGKILL, like a replacement.
    killServer();
    await sleep(100);
    check(serverProc === null, `D3: worker server killed (SIGKILL)`);
    // D4: the watchdog must report exit 2 (tick dead + pending work).
    // The tick state is minutes stale by the test's clock only if we
    // wait; use a short staleness threshold (3s) so the mechanism is
    // tested without waiting 15 minutes.
    await sleep(3500);
    const wd = cli(["watchdog", "--state-dir", STATE_DIR, "--stale-minutes", "0.05", "--json"]);
    check(wd.rc === 2, `D4: watchdog exits 2 after the simulated replacement (got ${wd.rc}: ${wd.out.slice(0, 200)}${wd.err.slice(0, 200)})`);
    let report: any = null;
    try {
      report = JSON.parse(wd.out);
    } catch {
      fail(`D4: watchdog --json output did not parse: ${wd.out.slice(0, 200)}`);
    }
    if (report) {
      check(report.tick?.alive === false, `D4: watchdog says the tick agent is dead`);
      check(report.needsRestart === true, `D4: watchdog says a restart is needed`);
      check(Array.isArray(report.pending?.heldRuns) && report.pending.heldRuns.includes("tick-gate"), `D4: pending work lists the held gate tick-gate`);
      check(Array.isArray(report.pending?.undeliveredResults) && report.pending.undeliveredResults.includes("tick-undelivered"), `D4: pending work lists the undelivered result tick-undelivered`);
    }
    // D5: restart — a fresh server + a fresh standin resumes. The
    // standin's catch-up sweep must deliver the undelivered result
    // and escalate the held gate (never flip it).
    await startServer();
    startStandin();
    const recovered = await waitFor(
      () => deliveryFor("tick-undelivered") !== null && escalations().some((e) => e.kind === "gate-held" && e.runId === "tick-gate"),
      30_000,
      "standin recovery (deliver tick-undelivered + escalate tick-gate)",
    );
    check(recovered, `D5: fresh standin recovered — tick-undelivered delivered, tick-gate escalated`);
    if (recovered) {
      const rec = deliveryFor("tick-undelivered");
      check(rec?.status === "done" && rec?.output?.done === true, `D5: tick-undelivered delivery is done with output {done: true}`);
    }
    const q3 = new Host({ stateDir: STATE_DIR }).readQueue().find((e) => e.runId === "tick-gate");
    check(q3?.status === "held", `D5: tick-gate is STILL held (never flipped by the standin)`);
    // D6: the watchdog now reports healthy — the fresh standin ticks,
    // so the default 15-minute threshold sees it alive. Exit 0 even
    // though the held gate is still pending work (alive = no restart).
    await sleep(1500);
    const wd2 = cli(["watchdog", "--state-dir", STATE_DIR, "--json"]);
    check(wd2.rc === 0, `D6: watchdog exits 0 after recovery (got ${wd2.rc}: ${wd2.out.slice(0, 200)}${wd2.err.slice(0, 200)})`);
    try {
      const report2 = JSON.parse(wd2.out);
      check(report2.tick?.alive === true, `D6: watchdog says the tick agent is alive`);
      check(report2.needsRestart === false, `D6: watchdog says no restart is needed`);
    } catch {
      fail(`D6: watchdog --json output did not parse: ${wd2.out.slice(0, 200)}`);
    }
    killStandin();
    // The killed standin's in-flight tick still holds the server's
    // tick slot for up to its timeout — wait for it to clear so E's
    // tick does not get a 409.
    await waitForTickFree();
  }

  // ---------------------------------------------------------- E. lease expiry
  console.log("\n=== E. lease expiry re-queues + tick event (BRA-65/66) ===");
  // A fresh spec (no affinity from earlier sections) and a clean
  // event queue. BRA-61: the nudge fires first (half the lease) and
  // wakes an earlier tick with a job-nudged event — the tick below
  // therefore loops until the lease-expired event arrives, and
  // asserts the nudge woke a tick first.
  await flushEvents();
  {
    // A job with a 3s lease, taken by a worker that never completes.
    const enq = await http("POST", "/enqueue", {
      spec: "lease-test",
      input: { item: "lease-test" },
      runId: "e1",
      trapId: "e1/trap-0",
      leaseMs: 3000,
    });
    check(enq.status === 200, `E: enqueue ok (${enq.status})`);
    const jobId = enq.body.jobId as string;
    // The tick call is issued BEFORE the expiry, so the lease-expired
    // event must wake it (not the timeout).
    const tickP = http("GET", `/tick?timeoutMs=10000`);
    const got = await http("GET", `/get-job?workerId=w-lease&waitMs=0`);
    check(got.status === 200 && got.body?.job?.jobId === jobId, `E: worker took the job`);
    const tTick0 = Date.now();
    const ticked = await tickP;
    const tickElapsed = Date.now() - tTick0;
    console.log(`E: first tick resolved after ${tickElapsed}ms, timedOut=${ticked.body?.timedOut}, events=${JSON.stringify(ticked.body?.events ?? [])}`);
    // The first tick wakes on the nudge (half the lease), not the
    // expiry — keep ticking until the lease-expired event arrives.
    const sawNudge = (ticked.body?.events ?? []).some((e: any) => e.type === "job-nudged" && e.jobId === jobId);
    check(sawNudge, `E: tick woke on the job-nudged event for ${jobId} first (BRA-61)`);
    let sawLeaseExpired = (ticked.body?.events ?? []).some(
      (e: any) => e.type === "lease-expired" && e.jobId === jobId,
    );
    const tickDeadline = Date.now() + 12_000;
    while (!sawLeaseExpired && Date.now() < tickDeadline) {
      const more = await http("GET", `/tick?timeoutMs=10000`);
      if ((more.body?.events ?? []).some((e: any) => e.type === "lease-expired" && e.jobId === jobId)) {
        sawLeaseExpired = true;
      }
    }
    console.log(`E: lease-expired arrived ${Date.now() - tTick0}ms after the take`);
    check(sawLeaseExpired, `E: tick woke on the lease-expired event for ${jobId}`);
    const st = await http("GET", `/job-status?jobId=${jobId}`);
    check(st.status === 200 && st.body?.status === "queued", `E: expired job re-queued (status ${st.body?.status ?? "?"})`);
    // Cleanup: take it and complete it so no queued job leaks into
    // later assertions.
    const got2 = await http("GET", `/get-job?workerId=w-lease2&waitMs=0`);
    check(got2.status === 200 && got2.body?.job?.jobId === jobId, `E: cleanup re-took the job`);
    if (got2.body?.job) {
      const done = await http("POST", "/complete-job", { jobId, workerId: "w-lease2", result: { score: 1 } });
      check(done.status === 200, `E: cleanup complete-job ok (${done.status})`);
    }
  }

  // ---------------------------------------------------------- F. disconnect unregisters the waiter
  console.log("\n=== F. disconnect unregisters the waiter (BRA-81 fix) ===");
  {
    // F1: a killed get-job waiter stops stealing jobs. A dead
    // worker's parked long-poll used to keep being assigned jobs
    // (burning their attempts on a worker that can never complete
    // them — the pool suite caught it: a crashed job failed after
    // dead workers w1/w2 took it twice before the live worker saw
    // it). Abort the client mid-wait; the waiter must unregister.
    const ac = new AbortController();
    const deadWait = fetch(`${SERVER_URL}/get-job?workerId=w-dead&waitMs=30000`, { signal: ac.signal });
    deadWait.catch(() => {});
    await sleep(500);
    const h1 = await http("GET", "/health");
    check(h1.body?.waiters === 1, `F1: dead waiter's get-job is parked (waiters ${h1.body?.waiters})`);
    ac.abort();
    await sleep(300);
    const h2 = await http("GET", "/health");
    check(h2.body?.waiters === 0, `F1: aborted get-job unregistered (waiters ${h2.body?.waiters})`);
    // Enqueue a job (fresh spec, no affinity): it must stay queued
    // — no dead waiter left to steal it.
    const enq = await http("POST", "/enqueue", {
      spec: "disconnect-test",
      input: {},
      runId: "f1",
      trapId: "f1/trap-0",
    });
    const jobId = enq.body.jobId as string;
    await sleep(1500);
    const st = await http("GET", `/job-status?jobId=${jobId}`);
    check(st.body?.status === "queued", `F1: job stayed queued after the dead waiter's disconnect (got ${st.body?.status})`);
    const got = await http("GET", `/get-job?workerId=w-live&waitMs=0`);
    check(got.body?.job?.jobId === jobId, `F1: live worker took the job`);
    if (got.body?.job) {
      const done = await http("POST", "/complete-job", { jobId, workerId: "w-live", result: { ok: true } });
      check(done.status === 200, `F1: cleanup complete-job ok (${done.status})`);
    }
  }
  {
    // F2: a killed tick frees the tick slot (BRA-81). A dead tick
    // agent's parked tick used to hold tickPending for the full
    // timeout, so the next agent's first tick got a 409. Flush
    // first: F1's complete-job left a job-completed event pending,
    // which would make this tick return at once instead of parking.
    await flushEvents();
    const ac = new AbortController();
    const deadTick = fetch(`${SERVER_URL}/tick?timeoutMs=30000`, { signal: ac.signal });
    deadTick.catch(() => {});
    await sleep(500);
    const h1 = await http("GET", "/health");
    check(h1.body?.tickPending === true, `F2: dead tick is pending (tickPending ${h1.body?.tickPending})`);
    ac.abort();
    const freed = await waitFor(
      async () => {
        const r = await http("GET", "/health");
        return r.body?.tickPending === false;
      },
      5000,
      "tick slot freed after disconnect",
    );
    check(freed, `F2: tick slot freed after the dead tick's disconnect`);
    const r = await http("GET", `/tick?timeoutMs=500`);
    check(r.status === 200 && r.body?.timedOut === true, `F2: fresh tick after disconnect succeeds (HTTP ${r.status})`);
  }

  console.log(`\n${FAILURES.length ? `FAIL tick driver suite: ${FAILURES.length} failure(s)` : "PASS tick driver suite (get-job long-poll, tick wake, tick+drive+deliver, watchdog + VM-replacement simulation, lease expiry, disconnect unregisters the waiter)"}`);
  return FAILURES.length ? 1 : 0;
}

let rc = 1;
try {
  rc = await main();
} catch (e) {
  fail(`uncaught: ${e instanceof Error ? e.message : String(e)}`);
  rc = 1;
} finally {
  killStandin();
  killServer();
}
process.exit(rc);
