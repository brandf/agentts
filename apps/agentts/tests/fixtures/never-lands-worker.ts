#!/usr/bin/env bun
/**
 * never-lands-worker — BRA-67 fault injector for audit row 7
 * ("worker completes but complete-job never lands").
 *
 * A standalone worker (not worker-loop): it long-polls get-job until
 * a job arrives, DOES the work (appends one line to the marker file,
 * sleeps 500ms — the result is computed), then exits 0 WITHOUT ever
 * POSTing complete-job. The job therefore sits "running" until its
 * lease expires, is re-queued, and is redone by a real worker.
 *
 * Usage: bun never-lands-worker.ts <serverUrl> <markerFile> [--worker-id <id>]
 */
import * as fs from "node:fs";

const SERVER_URL = process.argv[2];
const MARKER_FILE = process.argv[3];
let workerId = "w-bra67-ghost";
for (let i = 4; i < process.argv.length; i++) {
  if (process.argv[i] === "--worker-id") workerId = process.argv[i + 1] ?? workerId;
}
if (!SERVER_URL || !MARKER_FILE) {
  console.error("usage: never-lands-worker.ts <serverUrl> <markerFile> [--worker-id <id>]");
  process.exit(2);
}

async function getJob(): Promise<any | null> {
  const r = await fetch(`${SERVER_URL}/get-job?workerId=${encodeURIComponent(workerId)}&waitMs=5000`);
  if (!r.ok) return null;
  const body: any = await r.json().catch(() => null);
  return body?.job ?? null;
}

// Long-poll until a job arrives (the drive enqueues shortly after we start).
let job: any = null;
for (let i = 0; i < 12 && !job; i++) job = await getJob();
if (!job) {
  console.error(`[ghost ${workerId}] no job arrived; exiting`);
  process.exit(1);
}
console.log(`[ghost ${workerId}] took job ${job.jobId} — doing the work, then exiting WITHOUT completing`);
fs.appendFileSync(MARKER_FILE, `ghost-worker ${job.jobId}\n`);
await Bun.sleep(500);
console.log(`[ghost ${workerId}] work done for ${job.jobId} — exiting without complete-job`);
// Deliberately no POST /complete-job: the completion never lands.
process.exit(0);
