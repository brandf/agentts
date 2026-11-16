#!/usr/bin/env bun
/**
 * get-job — one-shot get-job for the true-subagent leg (BRA-48).
 *
 * A Muse subagent worker runs this to ask the queue for work, does
 * the job itself in its own workspace, then posts the result with
 * complete-job.ts. Loop: get-job -> work -> complete-job -> get-job
 * ... until it returns {"job": null} (idle) or the coordinator tells
 * the worker to stop. See plugins/muse/WORKER.md for the standing
 * instructions.
 *
 *   bun plugins/muse/get-job.ts --server http://127.0.0.1:18741 --worker-id w1
 *   # {"job": {"jobId": "...", "spec": "judge", "specPath": "...",
 *   #          "specHash": "...", "input": {...}, ...}}
 *   # or {"job": null} when the queue is empty (or this worker's
 *   # affinity jobs are held for another worker — wait and retry).
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
const res = await fetch(`${SERVER}/get-job?workerId=${encodeURIComponent(WORKER_ID)}`);
const text = await res.text();
if (res.status !== 200) {
  console.error(`get-job: HTTP ${res.status}: ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(text);
