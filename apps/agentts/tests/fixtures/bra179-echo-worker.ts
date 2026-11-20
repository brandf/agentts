#!/usr/bin/env bun
/**
 * bra179-echo-worker — test fixture for the BRA-179 suite.
 *
 * Echoes back the shape of input.text ({ len, head, tail }) so the
 * test can prove a job payload crossed the spawn whole — inline for
 * small payloads, via the `agentts-file:` scratch file for large
 * ones. Reads the payload with the same marker-aware reader as the
 * real worker scripts.
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
    throw new Error(`bra179-echo-worker: cannot read job payload file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
const payload = readPayloadArg(process.argv[2]);
const input: any = payload.input ?? {};
const text: string = typeof input.text === "string" ? input.text : "";
console.log(JSON.stringify({ len: text.length, head: text.slice(0, 20), tail: text.slice(-20) }));
export {};
