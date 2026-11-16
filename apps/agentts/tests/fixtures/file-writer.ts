#!/usr/bin/env bun
/**
 * file-writer — test fixture for the worker pool suite (BRA-48).
 *
 * Writes note.txt into its per-job workspace (cwd), emits one
 * LEARNING line, and returns a JSON result. Proves the file-effects
 * return path (changed files come back as full contents with the
 * completion) and the learnings write-back (/note).
 */
import * as fs from "node:fs";

const payload = JSON.parse(process.argv[2] ?? "{}");
const input: any = payload.input ?? {};
const text = typeof input.text === "string" ? input.text : "hello from the worker";
fs.writeFileSync("note.txt", text + "\n");
console.log("LEARNING: file-writer learns that note.txt is the effect to return");
console.log(JSON.stringify({ ok: true, wrote: "note.txt", bytes: text.length + 1 }));
