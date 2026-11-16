#!/usr/bin/env bun
/**
 * slow-worker — test fixture for the worker pool suite (BRA-48).
 *
 * Sleeps input.sleepMs then returns { sleptMs }. The pool suite
 * kills the loop mid-sleep to prove lease-expiry re-queue, and
 * cancels it mid-sleep to prove running-cancel. Genuine waiting over
 * a real input, not a canned answer.
 */
const payload = JSON.parse(process.argv[2] ?? "{}");
const input: any = payload.input ?? {};
const sleepMs = typeof input.sleepMs === "number" ? input.sleepMs : 1000;
await Bun.sleep(sleepMs);
console.log(JSON.stringify({ sleptMs: sleepMs }));
export {};
