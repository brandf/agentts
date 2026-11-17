#!/usr/bin/env bun
/**
 * get-job — one-shot get-job for the true-subagent leg (BRA-48).
 *
 * A Muse subagent worker runs this to ask the queue for work, does
 * the job itself in its own workspace, then posts the result with
 * complete-job.ts. Loop: get-job -> work -> complete-job -> get-job
 * ... until the coordinator tells the worker to stop. See
 * plugins/muse/WORKER.md for the standing instructions.
 *
 * get-job is a LONG-POLL (BRA-66): the call blocks until a job is
 * assignable to this worker, or the wait expires (default 60s) and
 * it returns {"job": null}. A worker neither spins when idle nor
 * waits out a poll interval when a job arrives — it just calls
 * get-job again. --wait-ms 0 is the old immediate return, for
 * scripts that need it.
 *
 *   bun plugins/muse/get-job.ts --server http://127.0.0.1:18741 --worker-id w1 [--wait-ms 60000]
 *   # {"job": {"jobId": "...", "spec": "judge", "specPath": "...",
 *   #          "specHash": "...", "input": {...}, ...}}
 *   # or {"job": null} when no job arrived within the wait (ask again).
 * Env: AGENTTS_WORKER_SERVER, AGENTTS_WORKER_ID.
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
export {};
const ARGS = process.argv.slice(2);
const SERVER = (flag(ARGS, "--server") ?? process.env.AGENTTS_WORKER_SERVER ?? "http://127.0.0.1:18741").replace(/\/$/, "");
const WORKER_ID = flag(ARGS, "--worker-id") ?? process.env.AGENTTS_WORKER_ID ?? "";
if (!WORKER_ID) {
  console.error("get-job: --worker-id is required (a stable id keeps your affinity warm; e.g. w1)");
  process.exit(2);
}
const WAIT_MS = flag(ARGS, "--wait-ms") ?? "60000";
const res = await fetch(`${SERVER}/get-job?workerId=${encodeURIComponent(WORKER_ID)}&waitMs=${encodeURIComponent(WAIT_MS)}`);
const text = await res.text();
if (res.status !== 200) {
  console.error(`get-job: HTTP ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(text);
