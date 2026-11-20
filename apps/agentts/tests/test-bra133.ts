#!/usr/bin/env bun
/**
 * Tick agent receives events for runs not in the production state
 * dir (Linear BRA-133).
 *
 * Nov 16 17:14-17:35 UTC the tick agent got run-submitted +
 * workflow-completed events for 5 runs that do not exist in the
 * production state dir (runIds matching old host-suite test runs
 * in /tmp/bra44-.../host/queue.json). `ingestEvent` validated only
 * the event type and emitted anything with a runId, with no check
 * that the run exists in this state dir — foreign events woke the
 * tick loop and triggered drives for runs that are not here.
 * Deliver-result already validated (404 `no run ${runId} in
 * ${host.stateDir}`), so the leak was contained at delivery.
 *
 * The fix: ingestEvent applies the same run-existence check before
 * emitting — rejected with 404, the same status and message text
 * as deliver-result — and the check is shared (a `runExists`
 * helper used by both sites) so the two cannot drift. Events with
 * no runId pass through as before. Choice: reject with 404, not
 * drop + log — the poster is fire-and-forget (host.notifyEvent
 * swallows failures), so a 404 cannot break the posting host's
 * run, but it IS a diagnosable signal; drop + log would leave a
 * misconfigured foreign host posting forever with no signal.
 *
 * What this proves (server on a throwaway port + scratch state
 * dir; the production server and state dir are never touched):
 *   A. A foreign runId posted to /event is rejected with 404
 *      (`no run ... in <stateDir>`) for two event types from the
 *      incident (run-submitted, workflow-completed), and the
 *      rejected event never wakes the tick loop — a /tick long-poll
 *      after it times out with no events. Unknown event types are
 *      still a 400 (type validation runs first).
 *   B. A run that exists (queue entry, submitted by an in-process
 *      Host) is accepted (200) and its event DOES wake the tick
 *      loop — a /tick long-poll returns it. No regression on the
 *      live path.
 *   C. An event with no runId (timer-fired) passes through as
 *      before, and an empty-string runId is treated as absent
 *      (200, not 404).
 *   D. Deliver-result still 404s the same foreign runId with the
 *      same error text, and passes the existence check for the
 *      legit run (400 non-terminal, not 404) — the two sites share
 *      one check. At the source level, the three-condition
 *      existence expression appears exactly once (inside
 *      runExists) and runExists is called from both sites.
 *
 * Notes, stated plainly:
 * - AGENTTS_WORKER_SERVER is pointed at the TEST server before
 *   any in-process submit: a Host's notifyEvent posts to the
 *   default port 18741 otherwise — the production server — and
 *   this test must never inject test events into production.
 * - The submit's own run-submitted event lands in the test server
 *   too (fire-and-forget fetch), so the section B tick drain is
 *   asserted as "contains >= 1 run-submitted for the legit runId",
 *   never an exact count.
 * - The tick drain consumes all pending events, so each tick
 *   assertion runs in its own section, after its own posts.
 *
 *   bun tests/test-bra133.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type Subprocess } from "bun";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA133_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra133-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 18995;
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent at the TEST server: the default
// port is the production server, and test events must never land there.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const FOREIGN = "run-foreign-bra133";
const LEGIT = "bra133-legit";

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
    if (Date.now() > deadline) throw new Error("bra133 server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(15);
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

async function tick(timeoutMs: number): Promise<{ status: number; body: any }> {
  return http("GET", `/tick?timeoutMs=${timeoutMs}`);
}

async function main(): Promise<void> {
  await startServer();
  try {
    // ---------------------------------------------------------------- A. foreign rejected
    const h = await http("GET", "/health");
    check(h.status === 200 && h.body?.ok === true, `A HEALTH OK: GET /health 200 ok (got ${h.status})`);

    const foreign = await http("POST", "/event", { type: "run-submitted", runId: FOREIGN });
    check(foreign.status === 404, `A FOREIGN OK: foreign run-submitted 404 (got ${foreign.status})`);
    check(
      typeof foreign.body?.error === "string" && foreign.body.error === `no run ${FOREIGN} in ${STATE_DIR}`,
      `A FOREIGN OK: error is exactly "no run ${FOREIGN} in ${STATE_DIR}" (got ${JSON.stringify(foreign.body).slice(0, 160)})`,
    );
    const t0 = await tick(400);
    check(
      t0.status === 200 && t0.body?.timedOut === true,
      `A NOWAKE OK: /tick after the foreign event times out (got ${t0.status}, timedOut ${t0.body?.timedOut})`,
    );
    check(
      t0.status === 200 && Array.isArray(t0.body?.events) && t0.body.events.length === 0,
      `A NOWAKE OK: /tick after the foreign event returns no events (got ${JSON.stringify(t0.body?.events)})`,
    );
    const foreignCompleted = await http("POST", "/event", { type: "workflow-completed", runId: FOREIGN });
    check(
      foreignCompleted.status === 404,
      `A FOREIGN OK: foreign workflow-completed 404 (got ${foreignCompleted.status})`,
    );
    const unknown = await http("POST", "/event", { type: "not-a-type", runId: FOREIGN });
    check(unknown.status === 400, `A TYPE OK: unknown event type still 400 (got ${unknown.status})`);

    // ---------------------------------------------------------------- B. legit accepted
    const host = new Host({ stateDir: STATE_DIR });
    host.submit(path.join(ROOT, "bench", "workflows", "bench-trivial.ts"), { runId: LEGIT, input: { n: 1000 } });
    check(
      readQueue().some((e) => e.runId === LEGIT),
      `B SUBMIT OK: queue entry exists for ${LEGIT}`,
    );
    // Let the submit's own (fire-and-forget) run-submitted event land first.
    await sleep(300);
    const legit = await http("POST", "/event", { type: "run-submitted", runId: LEGIT });
    check(legit.status === 200 && legit.body?.ok === true, `B LEGIT OK: legit run-submitted 200 ok (got ${legit.status})`);
    const t1 = await tick(5000);
    check(
      t1.status === 200 && t1.body?.timedOut === false,
      `B WAKE OK: /tick after the legit event returns promptly (got ${t1.status}, timedOut ${t1.body?.timedOut})`,
    );
    check(
      t1.status === 200 &&
        Array.isArray(t1.body?.events) &&
        t1.body.events.some((e: any) => e.type === "run-submitted" && e.runId === LEGIT),
      `B WAKE OK: /tick returns a run-submitted event for ${LEGIT} (got ${JSON.stringify(t1.body?.events).slice(0, 300)})`,
    );

    // ---------------------------------------------------------------- C. no runId passes
    const timer = await http("POST", "/event", { type: "timer-fired" });
    check(timer.status === 200 && timer.body?.ok === true, `C NORUN OK: timer-fired with no runId 200 ok (got ${timer.status})`);
    const t2 = await tick(2000);
    check(
      t2.status === 200 &&
        Array.isArray(t2.body?.events) &&
        t2.body.events.some((e: any) => e.type === "timer-fired" && e.runId === undefined),
      `C NORUN OK: /tick returns the timer-fired event with no runId (got ${JSON.stringify(t2.body?.events).slice(0, 200)})`,
    );
    const emptyRunId = await http("POST", "/event", { type: "timer-fired", runId: "" });
    check(
      emptyRunId.status === 200,
      `C NORUN OK: empty-string runId treated as absent, 200 (got ${emptyRunId.status})`,
    );

    // ---------------------------------------------------------------- D. shared check
    const delForeign = await http("POST", "/deliver-result", { runId: FOREIGN });
    check(delForeign.status === 404, `D SHARED OK: deliver-result for the foreign run 404 (got ${delForeign.status})`);
    check(
      typeof delForeign.body?.error === "string" && delForeign.body.error === `no run ${FOREIGN} in ${STATE_DIR}`,
      `D SHARED OK: deliver-result error text matches the /event rejection (got ${JSON.stringify(delForeign.body).slice(0, 160)})`,
    );
    const delLegit = await http("POST", "/deliver-result", { runId: LEGIT });
    check(
      delLegit.status === 400 && typeof delLegit.body?.error === "string" && !delLegit.body.error.includes("no run"),
      `D SHARED OK: deliver-result for the legit (non-terminal) run is 400, not 404 (got ${delLegit.status}, ${JSON.stringify(delLegit.body).slice(0, 160)})`,
    );
    const serverSrc = fs.readFileSync(path.join(ROOT, "src", "worker-server.ts"), "utf8");
    const queueCond = (serverSrc.match(/host\.readQueue\(\)\.some\(\(e\) => e\.runId === runId\)/g) ?? []).length;
    check(
      queueCond === 1,
      `D SHARED OK: the queue-entry condition appears exactly once in worker-server.ts (inside runExists; got ${queueCond})`,
    );
    const callSites = (serverSrc.match(/this\.runExists\(/g) ?? []).length;
    check(
      callSites === 2,
      `D SHARED OK: runExists is called from exactly two sites (deliverResult + ingestEvent; got ${callSites})`,
    );
  } finally {
    await stopServer();
  }

  // ---------------------------------------------------------------- verdict
  if (FAILURES.length) {
    console.log(`\ntest-bra133: ${FAILURES.length} FAILURE(S)`);
    process.exit(1);
  }
  console.log(
    "\nPASS bra133 foreign events rejected (a foreign runId posted to /event gets the same 404 as deliver-result and never wakes the tick loop; a legit run's event is accepted and wakes it; no-runId events pass through; one shared runExists check)",
  );
}

main().catch((e) => {
  console.log(`FAIL: ${String(e?.stack ?? e)}`);
  process.exit(1);
});
