#!/usr/bin/env bun
/**
 * notifyEvent without the curl spawn (Linear BRA-96).
 *
 * notifyEvent POSTed every system event through a blocking curl
 * spawnSync (~8.5ms of the ~10.5ms per event was the spawn alone;
 * ~15% of a 69ms warm run, every drive step). The fix is a
 * fire-and-forget in-process fetch: the event is a best-effort wake
 * signal (the queue/journal/store on disk is the source of truth),
 * so the POST's response is never read and a failure is swallowed,
 * exactly as before — but the drive now pays only the ~0.3ms
 * initiation instead of the spawn + round-trip.
 *
 * The one property the fix rests on — and the one this test pins
 * down — is that an un-awaited fetch still lands before a
 * short-lived CLI process exits, because fetch() keeps the Bun
 * event loop alive until it settles. Section E proves it with a
 * child process that calls notifyEvent and exits immediately, with
 * no await and no sleep.
 *
 * What this proves (in-process server, own state dirs):
 *   A. Live server, same payload: the POST arrives as POST /event
 *      with content-type application/json and the exact body
 *      {type, at, runId, ...} — including detail/jobId/trapId
 *      passthrough.
 *   B. Rapid burst: 5 back-to-back notifyEvents all land.
 *   C. Dead port: notifyEvent returns fast (<100ms) and never
 *      throws when nothing listens.
 *   D. Slow server: notifyEvent returns fast (<100ms) even when the
 *      server takes 300ms to answer — the drive never blocks on
 *      delivery — and the event still lands.
 *   E. Child-exit delivery: the load-bearing property. E1 runs off
 *      the end (the event loop drains, the fetch lands). E2 calls
 *      process.exit(0) with no flush — the event is LOST,
 *      deterministically: an explicit exit abandons in-flight
 *      fetches. That loss is the flush contract, not a bug: the CLI
 *      must await flushNotifications() before exiting, and E3 proves
 *      a child that flushes then exits DOES deliver.
 *   F. onEvent sink: still takes precedence, no HTTP at all.
 *   G. Malformed server URL: notifyEvent never throws (fetch throws
 *      synchronously for a bad URL; the try/catch must swallow it).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra96.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra95
 *   suite.) Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "bun";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = 18994;

const WORKDIR = process.env.BRA96_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra96-"));

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

function stateDir(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

interface Hit {
  method: string;
  path: string;
  contentType: string | null;
  body: any;
}
const hits: Hit[] = [];
let delayMs = 0;
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (delayMs > 0) await Bun.sleep(delayMs);
    const text = await req.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text };
    }
    hits.push({ method: req.method, path: url.pathname, contentType: req.headers.get("content-type"), body });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  },
});

async function waitFor(n: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hits.length >= n) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

const SERVER_URL = `http://127.0.0.1:${PORT}`;
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;
const host = new Host({ stateDir: stateDir("main") });

// A. Live server, same payload.
host.notifyEvent("workflow-completed", { runId: "bra96-a" });
check(await waitFor(1), `A PAYLOAD OK: live server received the event (hits ${hits.length})`);
if (hits.length >= 1) {
  const h = hits[0];
  check(h.method === "POST", `A PAYLOAD OK: method is POST (got ${h.method})`);
  check(h.path === "/event", `A PAYLOAD OK: path is /event (got ${h.path})`);
  check(h.contentType === "application/json", `A PAYLOAD OK: content-type is application/json (got ${h.contentType})`);
  check(h.body?.type === "workflow-completed", `A PAYLOAD OK: body.type is workflow-completed (got ${h.body?.type})`);
  check(h.body?.runId === "bra96-a", `A PAYLOAD OK: body.runId is bra96-a (got ${h.body?.runId})`);
  const at = Date.parse(h.body?.at ?? "");
  check(Number.isFinite(at) && Date.now() - at < 60_000, `A PAYLOAD OK: body.at is a recent ISO timestamp (got ${h.body?.at})`);
}
host.notifyEvent("gate-held", { runId: "bra96-a", jobId: "j1", trapId: "t1", detail: { reason: "x" } });
check(await waitFor(2), `A DETAIL OK: second event landed (hits ${hits.length})`);
if (hits.length >= 2) {
  const h = hits[1];
  check(h.body?.type === "gate-held", `A DETAIL OK: body.type is gate-held (got ${h.body?.type})`);
  check(h.body?.jobId === "j1", `A DETAIL OK: body.jobId passes through (got ${h.body?.jobId})`);
  check(h.body?.trapId === "t1", `A DETAIL OK: body.trapId passes through (got ${h.body?.trapId})`);
  check(h.body?.detail?.reason === "x", `A DETAIL OK: body.detail passes through (got ${JSON.stringify(h.body?.detail)})`);
}

// B. Rapid burst: 5 back-to-back notifies all land.
for (let i = 0; i < 5; i++) host.notifyEvent("workflow-completed", { runId: `bra96-burst-${i}` });
check(await waitFor(7), `B BURST OK: all 5 burst events landed (hits ${hits.length})`);
if (hits.length >= 7) {
  const burst = hits.slice(2).map((h) => h.body?.runId).sort();
  check(
    JSON.stringify(burst) === JSON.stringify(["bra96-burst-0", "bra96-burst-1", "bra96-burst-2", "bra96-burst-3", "bra96-burst-4"]),
    `B BURST OK: burst runIds all present (got ${JSON.stringify(burst)})`,
  );
}

// C. Dead port: fast, silent, never throws.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:1";
let threw = false;
const tC = performance.now();
try {
  host.notifyEvent("workflow-completed", { runId: "bra96-dead" });
} catch {
  threw = true;
}
const dtC = performance.now() - tC;
check(!threw, `C DEAD OK: notifyEvent did not throw on a dead port`);
check(dtC < 100, `C DEAD OK: notifyEvent returned in ${dtC.toFixed(2)}ms (< 100ms) on a dead port`);
await Bun.sleep(200);
check(hits.length === 7, `C DEAD OK: no phantom hit on the live server (hits ${hits.length})`);

// D. Slow server: the drive never blocks on delivery.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;
delayMs = 300;
const tD = performance.now();
host.notifyEvent("workflow-completed", { runId: "bra96-slow" });
const dtD = performance.now() - tD;
check(dtD < 100, `D SLOW OK: notifyEvent returned in ${dtD.toFixed(2)}ms (< 100ms) while the server takes 300ms`);
check(await waitFor(8, 5000), `D SLOW OK: the slow-server event still landed (hits ${hits.length})`);
check(hits[7]?.body?.runId === "bra96-slow", `D SLOW OK: the slow hit is the right event (got ${hits[7]?.body?.runId})`);
delayMs = 0;

// E. Child-exit delivery: the load-bearing property.
// E1: the child calls notifyEvent once and runs off the end — the
// event loop drains, the fetch lands.
const childScript = path.join(WORKDIR, "bra96-child.ts");
fs.writeFileSync(
  childScript,
  `import { Host } from ${JSON.stringify(path.join(ROOT, "src", "host.ts"))};\n` +
    `const host = new Host({ stateDir: ${JSON.stringify(stateDir("child"))} });\n` +
    `host.notifyEvent("workflow-completed", { runId: "bra96-child" });\n`,
);
const beforeE = hits.length;
const child = spawn([BUN, childScript], {
  env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL },
  stdout: "ignore",
  stderr: "ignore",
});
await child.exited;
check(await waitFor(beforeE + 1, 5000), `E CHILD OK: the child-exit event landed (hits ${hits.length})`);
if (hits.length > beforeE) {
  check(hits[hits.length - 1]?.body?.runId === "bra96-child", `E CHILD OK: the child hit is the right event (got ${hits[hits.length - 1]?.body?.runId})`);
}

// E2: the child calls notifyEvent then process.exit(0) with NO flush
// — the event is lost, deterministically. An explicit exit abandons
// in-flight fetches; this is the flush contract, not a bug: the CLI
// must await flushNotifications() before exiting (BRA-110 proved
// the loss matters — the standin drives only on run-submitted).
const childNoFlushScript = path.join(WORKDIR, "bra96-child-noflush.ts");
fs.writeFileSync(
  childNoFlushScript,
  `import { Host } from ${JSON.stringify(path.join(ROOT, "src", "host.ts"))};\n` +
    `const host = new Host({ stateDir: ${JSON.stringify(stateDir("child-noflush"))} });\n` +
    `host.notifyEvent("workflow-completed", { runId: "bra96-noflush" });\n` +
    `process.exit(0);\n`,
);
const beforeE2 = hits.length;
const childNoFlush = spawn([BUN, childNoFlushScript], {
  env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL },
  stdout: "ignore",
  stderr: "ignore",
});
await childNoFlush.exited;
await Bun.sleep(500);
check(hits.length === beforeE2, `E NOFLUSH OK: an explicit exit with no flush loses the event (hits ${hits.length}, no bra96-noflush)`);

// E3: the child calls notifyEvent, awaits flushNotifications(), then
// process.exit(0) — the event lands. This is the CLI's contract.
const childFlushScript = path.join(WORKDIR, "bra96-child-flush.ts");
fs.writeFileSync(
  childFlushScript,
  `import { Host, flushNotifications } from ${JSON.stringify(path.join(ROOT, "src", "host.ts"))};\n` +
    `const host = new Host({ stateDir: ${JSON.stringify(stateDir("child-flush"))} });\n` +
    `host.notifyEvent("workflow-completed", { runId: "bra96-flush" });\n` +
    `await flushNotifications();\n` +
    `process.exit(0);\n`,
);
const beforeE3 = hits.length;
const childFlush = spawn([BUN, childFlushScript], {
  env: { ...process.env, AGENTTS_WORKER_SERVER: SERVER_URL },
  stdout: "ignore",
  stderr: "ignore",
});
await childFlush.exited;
check(await waitFor(beforeE3 + 1, 5000), `E FLUSH OK: a flushed exit delivers (hits ${hits.length})`);
if (hits.length > beforeE3) {
  check(hits[hits.length - 1]?.body?.runId === "bra96-flush", `E FLUSH OK: the flushed hit is the right event (got ${hits[hits.length - 1]?.body?.runId})`);
}

// F. onEvent sink still takes precedence — no HTTP at all.
const sink: Array<{ type: string; detail: unknown }> = [];
const sinkHost = new Host({
  stateDir: stateDir("sink"),
  onEvent: (type, detail) => {
    sink.push({ type, detail });
  },
});
const beforeF = hits.length;
sinkHost.notifyEvent("gate-answered", { runId: "bra96-sink" });
check(sink.length === 1 && sink[0].type === "gate-answered", `F SINK OK: onEvent sink received gate-answered (got ${JSON.stringify(sink)})`);
check((sink[0]?.detail as any)?.runId === "bra96-sink", `F SINK OK: sink detail carries the runId`);
await Bun.sleep(200);
check(hits.length === beforeF, `F SINK OK: no HTTP hit for a sunk event (hits ${hits.length})`);
// A throwing sink is swallowed, like a failed POST.
const throwingHost = new Host({
  stateDir: stateDir("throwing"),
  onEvent: () => {
    throw new Error("sink boom");
  },
});
let threwF = false;
try {
  throwingHost.notifyEvent("workflow-completed", { runId: "bra96-throw" });
} catch {
  threwF = true;
}
check(!threwF, `F SINK OK: a throwing sink is swallowed, notifyEvent did not throw`);

// G. Malformed server URL: never throws.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:99999";
let threwG = false;
const tG = performance.now();
try {
  host.notifyEvent("workflow-completed", { runId: "bra96-badurl" });
} catch {
  threwG = true;
}
const dtG = performance.now() - tG;
check(!threwG, `G URL OK: notifyEvent did not throw on a malformed server URL`);
check(dtG < 100, `G URL OK: notifyEvent returned in ${dtG.toFixed(2)}ms (< 100ms) on a malformed server URL`);

server.stop();
if (FAILURES.length > 0) {
  console.log(`\nFAIL bra96 notifyEvent without curl (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log(`\nPASS bra96 notifyEvent without curl (same payload over in-process fetch; dead port, slow server, child-exit delivery, onEvent sink, malformed URL)`);
