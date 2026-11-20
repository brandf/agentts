#!/usr/bin/env bun
/**
 * slow-worker — test fixture for the worker pool suite (BRA-48).
 *
 * Sleeps input.sleepMs then returns { sleptMs }. The pool suite
 * kills the loop mid-sleep to prove lease-expiry re-queue, and
 * cancels it mid-sleep to prove running-cancel. Genuine waiting over
 * a real input, not a canned answer.
 */
import * as fs from "node:fs";

/** BRA-179: same marker-aware payload read as the real worker
 * scripts — a job payload over the inline argv cap arrives as
 * `agentts-file:<path>` (Linux caps any single argv string at
 * 128KB); a missing file fails loudly with the path named. */
function readPayloadArg(raw: string | undefined): any {
  const text = raw ?? "{}";
  if (!text.startsWith("agentts-file:")) return JSON.parse(text);
  const filePath = text.slice("agentts-file:".length);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new Error(`slow-worker: cannot read job payload file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const payload = readPayloadArg(process.argv[2]);
const input: any = payload.input ?? {};
const sleepMs = typeof input.sleepMs === "number" ? input.sleepMs : 1000;
await Bun.sleep(sleepMs);
console.log(JSON.stringify({ sleptMs: sleepMs }));
export {};
