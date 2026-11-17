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

const payload = JSON.parse(process.argv[2] ?? "{}");
const input: any = payload.input ?? {};
const markerFile: string = input.markerFile ?? "";
const sleepMs: number = typeof input.sleepMs === "number" ? input.sleepMs : 1000;
if (markerFile) fs.appendFileSync(markerFile, `marker-worker\n`);
await Bun.sleep(sleepMs);
console.log(JSON.stringify({ sleptMs: sleepMs }));
export {};
