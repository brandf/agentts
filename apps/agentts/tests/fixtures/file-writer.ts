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
    throw new Error(`file-writer: cannot read job payload file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const payload = readPayloadArg(process.argv[2]);
const input: any = payload.input ?? {};
const text = typeof input.text === "string" ? input.text : "hello from the worker";
fs.writeFileSync("note.txt", text + "\n");
console.log("LEARNING: file-writer learns that note.txt is the effect to return");
console.log(JSON.stringify({ ok: true, wrote: "note.txt", bytes: text.length + 1 }));
