#!/usr/bin/env bun
/**
 * tick — the tick agent's two calls (BRA-65).
 *
 * NOTE (BRA-116): the tick agent itself calls the server with curl
 * now (see plugins/muse/TICK-AGENT.md) — this script is the
 * operator/human wrapper for the same two calls, kept because its
 * exit codes (1 on 409 / transport failure) and its client-side
 * abort bound are handy outside the agent loop. The bench measures
 * the curl path, not this script.
 *
 *   bun plugins/muse/tick.ts --server <URL> [--timeout-ms N]
 *       # the tick call: blocks until a system event arrives or the
 *       # timeout fires (default 60000ms, max 120000ms). Prints the
 *       # response JSON: {"events": [...], "timedOut": bool, "at": ...}
 *       # Exit 0 on a response (events or timeout), 1 on a 409 (a
 *       # tick call is already pending — another tick agent may be
 *       # running; wait and retry, escalate if it persists) or a
 *       # transport failure.
 *   bun plugins/muse/tick.ts --server <URL> --beat
 *       # the liveness heartbeat: refreshes the tick liveness file
 *       # the watchdog reads. Call it before and after a long action
 *       # (a queue drive) and every ~20s while one runs (background
 *       # loop) — otherwise the watchdog presumes the agent dead
 *       # mid-drive.
 * Env: AGENTTS_WORKER_SERVER, AGENTTS_TICK_TIMEOUT_MS.
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}
export {};
const ARGS = process.argv.slice(2);
const SERVER = (flag(ARGS, "--server") ?? process.env.AGENTTS_WORKER_SERVER ?? "http://127.0.0.1:18741").replace(/\/$/, "");

if (has(ARGS, "--beat")) {
  const res = await fetch(`${SERVER}/tick-beat`, { method: "POST" });
  const text = await res.text();
  if (res.status !== 200) {
    console.error(`tick-beat: HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(text);
  process.exit(0);
}

const TIMEOUT_MS = Number(flag(ARGS, "--timeout-ms") ?? process.env.AGENTTS_TICK_TIMEOUT_MS ?? "60000");
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 0) {
  console.error(`tick: --timeout-ms must be a non-negative number (got "${flag(ARGS, "--timeout-ms")}")`);
  process.exit(2);
}
// Client-side bound: the server resolves within timeoutMs; if it
// does not (a hung connection), abort 10s later rather than hanging
// forever — a hung tick is worse than a timed-out one.
const ctl = new AbortController();
const abortTimer = setTimeout(() => ctl.abort(), TIMEOUT_MS + 10_000);
let res: Response;
try {
  res = await fetch(`${SERVER}/tick?timeoutMs=${TIMEOUT_MS}`, { signal: ctl.signal });
} catch (e) {
  console.error(`tick: request failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  clearTimeout(abortTimer);
}
const text = await res.text();
if (res.status === 409) {
  console.error(`tick: 409: ${text.slice(0, 300)}`);
  process.exit(1);
}
if (res.status !== 200) {
  console.error(`tick: HTTP ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(text);
