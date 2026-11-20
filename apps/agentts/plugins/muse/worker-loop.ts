#!/usr/bin/env bun
/**
 * worker-loop — the worker-side loop for the BRA-48 pool (script mode).
 *
 * A generic thread-pool worker, but an agent: it long-polls get-job
 * (BRA-66: the call blocks until a job is assignable, up to 60s —
 * the worker neither spins when idle nor waits out a poll interval),
 * does the work in its OWN per-worker workspace (never shared with
 * another worker), and posts complete-job with a JSON result or an
 * exception. Two tools + standing instructions — see
 * plugins/muse/WORKER.md for the subagent version of this same loop.
 *
 * Script mode (this file): the work for a spec is a registered Bun
 * worker script (workers config: JSON { spec: scriptPath }), run as
 * `bun <script> '<json {spec, input}>'` with cwd = the per-job
 * workspace — or, for a payload at or above 64KB, as
 * `bun <script> 'agentts-file:<path>'` (BRA-179: Linux caps any
 * single argv string at 128KB, so large payloads travel through a
 * scratch file in the job workspace, read by the worker script and
 * unlinked after the spawn; small payloads stay inline). The
 * script's last stdout line is the result JSON. This is the PROOF
 * leg: genuine computation over real inputs by Bun processes. The
 * TRUE leg is a Muse subagent running the same loop by hand
 * (get-job.ts / complete-job.ts + WORKER.md).
 *
 * Per job:
 *   1. GET /get-job?workerId=... — the server picks the job for this
 *      worker (affinity preference + load-balancing fallback).
 *   2. Jobspec hash check: if the spec's hash changed since this
 *      worker last read it, GET /jobspec and cache it under
 *      <workspace-root>/specs/<spec>.md (content-addressed caching —
 *      the spec is read once, not on every job).
 *   3. Fresh per-job workspace <root>/<workerId>/<jobId>/ with
 *      input.json; run the worker script there with a heartbeat
 *      (lease extension) while it runs.
 *   4. File effects: every file the worker created/modified in its
 *      workspace (minus input.json) is returned with the completion
 *      as full contents + manifest (see below) — never auto-applied
 *      anywhere; the coordinator applies them after review.
 *   5. POST /complete-job { result } or { error }. A nonzero worker
 *      exit is an error, never an invented result. An unknown spec
 *      (no script registered) is an error too.
 *   6. Learnings: lines the worker prints as `LEARNING: <text>` are
 *      posted to /note — the specialist's experience becomes
 *      institutional and survives context resets.
 *
 * File-effects return path (decided BRA-48): RETURN THE CHANGED
 * FILES' FULL CONTENTS with the completion (not a branch push, not
 * a textual patch, not a plugin file copy). Rationale: a push needs
 * git remote/auth per worker and conflates execution with
 * publication; a textual patch can fail to apply on drift; a plugin
 * copy needs a shared filesystem and breaks the multi-VM future.
 * Full contents are exact bytes, trivially reviewable, and apply
 * cleanly anywhere. The adapter stores them on the job record; the
 * host never auto-applies them — application is a separate,
 * reviewable step by the coordinator. Capped at 1MB per completion
 * (server-enforced); larger effects are noted and the coordinator
 * fetches them from the worker's workspace.
 *
 *   bun plugins/muse/worker-loop.ts --server http://127.0.0.1:18741 \
 *       --worker-id w1 --workspace-root <dir> \
 *       --workers-config <spec->script.json> [--once] [--max-jobs N]
 *       [--poll-ms 500] [--idle-exit-ms N]
 * Env: AGENTTS_WORKER_SERVER, AGENTTS_WORKER_ID.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const BUN = "/opt/hatch-image/bin/bun";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}

const ARGS = process.argv.slice(2);
const SERVER = (flag(ARGS, "--server") ?? process.env.AGENTTS_WORKER_SERVER ?? "http://127.0.0.1:18741").replace(/\/$/, "");
const WORKER_ID =
  flag(ARGS, "--worker-id") ?? process.env.AGENTTS_WORKER_ID ?? `bun-worker-${process.pid}`;
const WORKSPACE_ROOT = path.resolve(
  flag(ARGS, "--workspace-root") ?? path.join(process.cwd(), "worker-workspaces"),
);
const WORKERS_CONFIG_PATH = flag(ARGS, "--workers-config") ?? process.env.AGENTTS_WORKERS_CONFIG ?? "";
const POLL_MS = Number(flag(ARGS, "--poll-ms") ?? "500");
const ONCE = has(ARGS, "--once");
const MAX_JOBS = Number(flag(ARGS, "--max-jobs") ?? "0");
const IDLE_EXIT_MS = Number(flag(ARGS, "--idle-exit-ms") ?? "0");

const SPECS_DIR = path.join(WORKSPACE_ROOT, "specs");
const CACHE_DIR = path.join(WORKSPACE_ROOT, ".spec-cache");
fs.mkdirSync(SPECS_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

function loadWorkersConfig(): Record<string, string> {
  if (!WORKERS_CONFIG_PATH) return {};
  const raw = JSON.parse(fs.readFileSync(WORKERS_CONFIG_PATH, "utf8")) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [spec, script] of Object.entries(raw)) {
    out[spec] = path.isAbsolute(script) ? script : path.resolve(script);
  }
  return out;
}
const WORKERS = loadWorkersConfig();
console.log(`[worker ${WORKER_ID}] server=${SERVER} root=${WORKSPACE_ROOT} specs=${Object.keys(WORKERS).join(",") || "(none)"}`);

async function api(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

/** Content-addressed spec read: fetch the spec text only when its
 * hash changed since this worker last cached it. The hash goes on
 * the request (BRA-89) so the server serves the enqueue-time
 * snapshot for that hash — the prose as enqueued — instead of the
 * live file, which may have changed since the job was dispatched. */
async function ensureSpec(spec: string, hash: string | null): Promise<void> {
  if (!hash) return; // no spec file on the server: proceed from spec name + input
  const cachePath = path.join(CACHE_DIR, `${spec}.json`);
  let cached: string | null = null;
  try {
    cached = (JSON.parse(fs.readFileSync(cachePath, "utf8")) as any).hash ?? null;
  } catch {
    cached = null;
  }
  if (cached === hash) return;
  const r = await api("GET", `/jobspec?spec=${encodeURIComponent(spec)}&hash=${encodeURIComponent(hash)}`);
  if (r.status !== 200 || typeof r.body?.text !== "string") {
    console.log(`[worker ${WORKER_ID}] WARNING: could not fetch jobspec "${spec}" (HTTP ${r.status}); proceeding from spec name`);
    return;
  }
  fs.writeFileSync(path.join(SPECS_DIR, `${spec}.md`), r.body.text);
  fs.writeFileSync(cachePath, JSON.stringify({ spec, hash: r.body.hash }));
  console.log(`[worker ${WORKER_ID}] spec-read ${spec} ${String(r.body.hash).slice(0, 12)}`);
}

function collectFiles(dir: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  let bytes = 0;
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p, r);
      } else if (r !== "input.json") {
        const content = fs.readFileSync(p, "utf8");
        bytes += Buffer.byteLength(content, "utf8");
        if (bytes > 1_000_000) {
          console.log(`[worker ${WORKER_ID}] file effects exceed 1MB cap — truncating list at ${r}`);
          return;
        }
        out.push({ path: r, content });
      }
    }
  };
  walk(dir, "");
  return out;
}

async function runOneJob(job: any): Promise<boolean> {
  const jobId: string = job.jobId;
  const spec: string = job.spec;
  const workspace = path.join(WORKSPACE_ROOT, WORKER_ID, jobId);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "input.json"), JSON.stringify(job.input ?? null, null, 2));
  await ensureSpec(spec, job.specHash ?? null);

  const script = WORKERS[spec];
  if (!script || !fs.existsSync(script)) {
    const msg = `no worker script registered for jobspec "${spec}"`;
    console.log(`[worker ${WORKER_ID}] ${jobId} ERROR: ${msg}`);
    await api("POST", "/complete-job", { jobId, workerId: WORKER_ID, error: { name: "UnknownSpec", message: msg } });
    return true;
  }

  // Heartbeat while the worker runs (lease extension). If the server
  // says the job was cancelled, kill the worker and do NOT complete.
  let cancelled = false;
  let procRef: ReturnType<typeof Bun.spawn> | null = null;
  const leaseMs: number = job.leaseMs ?? 300_000;
  const beatEvery = Math.min(30_000, Math.max(1000, Math.floor(leaseMs / 3)));
  const timer = setInterval(async () => {
    try {
      const r = await api("POST", "/heartbeat", { jobId, workerId: WORKER_ID });
      if (r.body?.cancelled === true) {
        cancelled = true;
        procRef?.kill("SIGTERM");
        setTimeout(() => procRef?.kill("SIGKILL"), 5000);
      }
      // Nudge (BRA-61): the server says this job is running long
      // past its estimate (or silent) — surface it loudly. The
      // heartbeat that carries the nudge is the delivery; the
      // server will not repeat it. A subagent worker sees the same
      // field in its own heartbeat call (see WORKER.md).
      if (r.body?.nudge?.message) {
        console.log(`[worker ${WORKER_ID}] ${jobId} NUDGE: ${r.body.nudge.message}`);
      }
    } catch {
      /* a missed heartbeat is not fatal; the lease may still hold */
    }
  }, beatEvery);

  let result: unknown = null;
  let error: { name: string; message: string } | null = null;
  // BRA-179: a job payload is passed to the worker script as argv[2]
  // of the spawn, and Linux caps any single argv string at 128KB
  // (MAX_ARG_STRLEN = 131072 bytes). Payloads at or above 64KB go
  // through a scratch file in the job workspace instead (marker
  // `agentts-file:<path>`, read by the worker script) — same
  // threshold + marker as the direct adapter
  // (plugins/direct/src/direct-adapter.ts) and as
  // RESULT_ARG_INLINE_MAX_BYTES / RESULT_ARG_FILE_PREFIX in
  // src/host.ts (BRA-171, the output side of this same argv
  // boundary); keep the three in sync, per the BRA-88 verbatim-copy
  // rule. The file is unlinked in the finally below, so a dispatched
  // job never litters the workspace.
  const JOB_ARG_INLINE_MAX_BYTES = 64 * 1024;
  const JOB_ARG_FILE_PREFIX = "agentts-file:";
  let payloadCleanup: () => void = () => {};
  try {
    const payload = JSON.stringify({ spec, input: job.input ?? null });
    let payloadArg = payload;
    if (Buffer.byteLength(payload, "utf8") >= JOB_ARG_INLINE_MAX_BYTES) {
      const filePath = path.join(workspace, `.agentts-job-payload-${crypto.randomUUID()}.json`);
      fs.writeFileSync(filePath, payload, "utf8");
      payloadArg = `${JOB_ARG_FILE_PREFIX}${filePath}`;
      payloadCleanup = () => {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* already gone */
        }
      };
    }
    const proc = Bun.spawn([BUN, script, payloadArg], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    procRef = proc;
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (cancelled) {
      console.log(`[worker ${WORKER_ID}] ${jobId} cancelled mid-run — abandoning, not completing`);
      return true;
    }
    // Learnings: `LEARNING: ...` lines become institutional notes.
    for (const line of stdout.split("\n")) {
      if (line.startsWith("LEARNING: ")) {
        await api("POST", "/note", { spec, workerId: WORKER_ID, text: line.slice("LEARNING: ".length) });
      }
    }
    if (exitCode !== 0) {
      error = { name: "WorkerExit", message: `worker for "${spec}" exited ${exitCode}: ${(stderr || "").trim().slice(0, 500)}` };
    } else {
      const last = stdout.trim().split("\n").pop() ?? "";
      if (!last) {
        error = { name: "WorkerExit", message: `worker for "${spec}" printed nothing` };
      } else {
        try {
          result = JSON.parse(last);
        } catch {
          error = { name: "WorkerExit", message: `worker for "${spec}" did not print JSON: ${last.slice(0, 200)}` };
        }
      }
    }
    if (stderr.trim()) console.log(`[worker ${WORKER_ID}] ${jobId} worker stderr: ${stderr.trim().slice(0, 300)}`);
  } catch (e) {
    error = { name: "WorkerExit", message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearInterval(timer);
    payloadCleanup();
  }
  if (cancelled) {
    console.log(`[worker ${WORKER_ID}] ${jobId} cancelled mid-run — abandoning, not completing`);
    return true;
  }
  const files = collectFiles(workspace);
  const r = await api("POST", "/complete-job", {
    jobId,
    workerId: WORKER_ID,
    ...(error ? { error } : { result }),
    ...(files.length ? { files } : {}),
  });
  if (r.status === 409) {
    console.log(`[worker ${WORKER_ID}] ${jobId} complete rejected (409): ${JSON.stringify(r.body).slice(0, 200)} — late completion ignored`);
  } else if (r.status !== 200) {
    console.log(`[worker ${WORKER_ID}] ${jobId} complete failed HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  } else {
    console.log(`[worker ${WORKER_ID}] ${jobId} spec=${spec} ${error ? `error: ${error.message.slice(0, 120)}` : `done (${r.body.status})`} files=${files.length}`);
  }
  return true;
}

async function main(): Promise<number> {
  let done = 0;
  let lastJobAt = Date.now();
  for (;;) {
    let r: { status: number; body: any };
    try {
      r = await api("GET", `/get-job?workerId=${encodeURIComponent(WORKER_ID)}`);
    } catch (e) {
      console.log(`[worker ${WORKER_ID}] get-job failed: ${e instanceof Error ? e.message : String(e)} — retrying`);
      await Bun.sleep(POLL_MS);
      continue;
    }
    if (r.status !== 200) {
      console.log(`[worker ${WORKER_ID}] get-job HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)} — retrying`);
      await Bun.sleep(POLL_MS);
      continue;
    }
    const job = r.body?.job ?? null;
    if (!job) {
      if (IDLE_EXIT_MS > 0 && Date.now() - lastJobAt > IDLE_EXIT_MS) {
        console.log(`[worker ${WORKER_ID}] idle ${IDLE_EXIT_MS}ms — exiting`);
        return 0;
      }
      await Bun.sleep(POLL_MS);
      continue;
    }
    lastJobAt = Date.now();
    await runOneJob(job);
    done += 1;
    if (ONCE || (MAX_JOBS > 0 && done >= MAX_JOBS)) {
      console.log(`[worker ${WORKER_ID}] done ${done} job(s) — exiting`);
      return 0;
    }
  }
}

process.exit(await main());
