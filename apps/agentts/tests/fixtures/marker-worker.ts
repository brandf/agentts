#!/usr/bin/env bun
/**
 * marker-worker — jobspec script for the BRA-67 suite.
 * Appends one line to input.markerFile, sleeps input.sleepMs, and
 * returns { sleptMs }. The marker line is the observable side effect
 * of the work: when the pool re-queues a job whose completion never
 * landed, the work runs twice and the marker has two lines, while
 * the job itself completes exactly once.
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
    throw new Error(`marker-worker: cannot read job payload file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const payload = readPayloadArg(process.argv[2]);
const input: any = payload.input ?? {};
const markerFile: string = input.markerFile ?? "";
const sleepMs: number = typeof input.sleepMs === "number" ? input.sleepMs : 1000;
if (markerFile) fs.appendFileSync(markerFile, `marker-worker\n`);
await Bun.sleep(sleepMs);
console.log(JSON.stringify({ sleptMs: sleepMs }));
export {};
