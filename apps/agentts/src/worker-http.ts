// worker-http — HTTP clients for the worker queue (BRA-48).
//
// Two clients, one API shape, because the host's adapter interface
// is SYNCHRONOUS (answer() runs inside the sync drive loop — it
// cannot await) while the CLI and the async adapter methods can:
//
//   - httpSync: spawnSync curl (loopback, short timeouts). Used by
//     MuseAdapter.answer(). curl is /usr/bin/curl on this VM; if it
//     ever disappears this module fails loudly with the path, never
//     silently falls back to a different transport.
//   - httpAsync: fetch. Used by the CLI worker commands and the
//     async EnvironmentAdapter methods.
//
// Both return { status, body } with body parsed as JSON when
// possible; a non-JSON body surfaces as { _raw } so a server error
// is never mistaken for a job payload.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workerServerUrl } from "./worker-protocol";

export interface HttpResult {
  status: number;
  body: any;
}

function parseBody(text: string): any {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return { _raw: text.slice(0, 500) };
  }
}

/** BRA-179: a POST body travels to curl as a `--data` argv string,
 * and Linux caps any single argv string at 128KB (MAX_ARG_STRLEN =
 * 131072 bytes). Bodies at or above this many bytes go through a
 * scratch file instead (`--data-binary @<path>`, exact bytes) —
 * 64KB is half the cap, leaving margin for argv overhead. Same
 * threshold as RESULT_ARG_INLINE_MAX_BYTES in src/host.ts (BRA-171)
 * and the job-payload cap in plugins/direct/src/direct-adapter.ts;
 * keep the three in sync, per the BRA-88 verbatim-copy rule. The
 * file is unlinked after the spawn, so a request never litters the
 * temp dir. (The /enqueue body carries the whole job input, so a
 * large job E2BIGs here before the worker spawn is even reached.) */
const HTTP_BODY_INLINE_MAX_BYTES = 64 * 1024;

/** Synchronous POST/GET over curl. Throws on transport failure. */
export function httpSync(method: "GET" | "POST", url: string, body?: unknown, timeoutMs = 10_000): HttpResult {
  const args = ["-sS", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "-w", "\n%{http_code}"];
  let bodyFile: string | null = null;
  if (method === "POST") {
    const data = JSON.stringify(body ?? {});
    if (Buffer.byteLength(data, "utf8") >= HTTP_BODY_INLINE_MAX_BYTES) {
      bodyFile = path.join(os.tmpdir(), `.agentts-http-body-${crypto.randomUUID()}.json`);
      fs.writeFileSync(bodyFile, data, "utf8");
      args.push("-X", "POST", "-H", "content-type: application/json", "--data-binary", `@${bodyFile}`);
    } else {
      args.push("-X", "POST", "-H", "content-type: application/json", "--data", data);
    }
  }
  args.push(url);
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync("/usr/bin/curl", args, { encoding: "utf8" });
  } finally {
    if (bodyFile !== null) {
      try {
        fs.unlinkSync(bodyFile);
      } catch {
        /* already gone */
      }
    }
  }
  if (r.error) {
    throw new Error(`worker queue request failed (${method} ${url}): ${String(r.error)} — is the worker server running? (agentts worker serve)`);
  }
  const out = (r.stdout ?? "").trimEnd();
  const nl = out.lastIndexOf("\n");
  const statusText = nl >= 0 ? out.slice(nl + 1).trim() : "";
  const status = Number(statusText);
  const text = nl >= 0 ? out.slice(0, nl) : out;
  if (r.status !== 0 || !Number.isFinite(status)) {
    throw new Error(
      `worker queue request failed (${method} ${url}): curl exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 300) || text.slice(0, 300)}`,
    );
  }
  return { status, body: parseBody(text) };
}

export function httpGetSync(url: string, timeoutMs = 10_000): HttpResult {
  return httpSync("GET", url, undefined, timeoutMs);
}

export function httpPostSync(url: string, body: unknown, timeoutMs = 10_000): HttpResult {
  return httpSync("POST", url, body, timeoutMs);
}

/** Async fetch client (CLI + async adapter methods). */
export async function httpAsync(method: "GET" | "POST", url: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text) };
}

export function serverBaseUrl(): string {
  return workerServerUrl();
}

/** True when the queue server answers /health. Never throws. */
export function serverHealthy(url: string): boolean {
  try {
    const r = httpGetSync(`${url}/health`, 2000);
    return r.status === 200 && r.body?.ok === true;
  } catch {
    return false;
  }
}
