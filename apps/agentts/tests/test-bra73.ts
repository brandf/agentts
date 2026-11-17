#!/usr/bin/env bun
/**
 * Journal schema changes for the profiler (Linear BRA-73 — the
 * BRA-63 journal/profiler audit's 4 minimal changes).
 *
 *   (1) Trap site: each trap event carries site {file, line,
 *       column} captured via Error.stack in the agentts wrappers
 *       (wrapper frames skipped). Coordinates refer to the BUNDLE,
 *       so the bundle + its source map are pinned with the run
 *       (runs/<run>.bundle.js(.map), named on the lifecycle-started
 *       event). A workflow with two exec traps at distinct call
 *       sites must produce two trap events whose sites differ — the
 *       two exec traps share the site key `exec`, so the key alone
 *       cannot tell them apart (proven in the BRA-63 audit).
 *       The journaled arg stays exactly the spec the author passed
 *       (the transport key is stripped at ingest and at dispatch).
 *   (2) Run start: the lifecycle-started event carries workflowHash
 *       (the extraction sourceHash — reused, never recomputed),
 *       workflowPath, and submittedAt (the queue entry's
 *       enqueuedAt), plus the pinned bundle paths.
 *   (3) Trap dispatch (already done — BRA-75): a trap-dispatch
 *       event is present with wallTs, so queue-wait =
 *       dispatch.wallTs − trap.wallTs and execution =
 *       result.wallTs − dispatch.wallTs are computable — asserted
 *       here from the journal and from the profiler, not re-built.
 *   (4) Worker lane: a job trap completed through the pool carries
 *       workerId on trap-result.worker, naming the actual worker
 *       that ran it (cross-checked against worker-jobs/jobs.log).
 *       Both answer paths are covered: the sync answer() path
 *       (through a real run) and the async collectJob() path
 *       (direct call — it dropped workerId before this fix).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra73.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra67 suite.)
 *
 * Run outputs go to $BRA73_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. The worker server + worker processes are
 * killed in a finally block, even on failure. Exit 0 on PASS, 1 on
 * any mismatch.
 *
 * What this does NOT prove (stated plainly): the bundle coordinates
 * are translated back to source lines by the profiler UI — the
 * profiler is text/HTML today, not an interactive timeline, so the
 * test proves the coordinates point at the right bundle lines and
 * the map names the workflow source (with embedded sources), not
 * that a UI renders the jump. Direct trap() callers (no wrapper)
 * carry no site — the profiler reports that as unknown.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn, type Subprocess } from "bun";

import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";
import { MuseAdapter } from "../plugins/muse/src/muse-adapter";
import { loadJournalTree, profileTree, renderTreeText } from "../src/profiler";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA73_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra73-"));
const STATE_DIR = path.join(WORKDIR, "state");
const WORKSPACES = path.join(WORKDIR, "workspaces");
const WORKERS_JSON = path.join(WORKDIR, "workers.json");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(WORKSPACES, { recursive: true });

const PORT = Number(process.env.AGENTTS_WORKER_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}
function ok(msg: string): void {
  console.log(msg);
}
function check(cond: boolean, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

const sha256File = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function readJournal(runId: string): any[] {
  const p = path.join(STATE_DIR, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
/** Resolve a stored frozenPath read raw from queue.json: BRA-85
 * stores it state-dir-relative ("frozen/<hash>/..."), legacy dirs
 * store it absolute. */
function resolveFrozenPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(STATE_DIR, stored);
}

function readJobsLog(): any[] {
  const p = path.join(STATE_DIR, "worker-jobs", "jobs.log");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function http(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER_URL}${p}`, {
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

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(250);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

// ------------------------------------------------------------ A/B/C: exec run (site + run-start + dispatch)
async function testExecRun(): Promise<void> {
  console.log("\n=== A/B/C. exec run: trap sites, run-start fields, trap-dispatch ===");
  const workflow = path.join(ROOT, "tests", "workflows", "workflow-bra73-exec.ts");
  const runId = "run-bra73-exec";
  const host = new Host({ stateDir: STATE_DIR, adapter: new DirectAdapter() });
  host.submit(workflow, { runId });
  const queued = readQueue().find((e) => e.runId === runId);
  check(!!queued, "SUBMIT OK: exec run enqueued");
  const submittedAt = queued?.enqueuedAt as string | undefined;
  check(typeof submittedAt === "string" && !!submittedAt, `SUBMIT OK: queue entry carries enqueuedAt (${submittedAt ?? "missing"})`);
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "done", `RUN OK: exec run done (got ${res.status} ${res.error ?? ""})`);
  check(
    (res.output as any)?.first === "first" && (res.output as any)?.second === "second",
    `RUN OK: outputs are first/second (got ${JSON.stringify(res.output)})`,
  );

  const events = readJournal(runId);
  check(events.length > 0, `JOURNAL OK: ${events.length} events`);

  // (2) lifecycle-started carries the run-start fields.
  const started = events.find((e) => e.event === "lifecycle" && e.lifecycle === "started");
  check(!!started, "RUN-START OK: lifecycle-started event present");
  if (started) {
    const q = readQueue().find((e) => e.runId === runId);
    check(
      typeof started.workflowHash === "string" && /^[0-9a-f]{64}$/.test(started.workflowHash),
      `RUN-START OK: workflowHash is a sha256 (${String(started.workflowHash ?? "").slice(0, 12)}…)`,
    );
    check(
      started.workflowPath === path.resolve(workflow),
      `RUN-START OK: workflowPath is the submitted path (got ${started.workflowPath})`,
    );
    check(
      started.submittedAt === submittedAt,
      `RUN-START OK: submittedAt is the queue enqueuedAt (${started.submittedAt})`,
    );
    // workflowHash is the extraction sourceHash: the extraction runs
    // on the frozen copy, so it must equal the sha256 of the frozen
    // entry file — and the cache entry under that hash must hold the
    // same sourceHash (the pointer the profiler follows).
    if (q?.frozenPath && typeof started.workflowHash === "string") {
      check(
        started.workflowHash === sha256File(resolveFrozenPath(q.frozenPath)),
        "RUN-START OK: workflowHash equals sha256 of the frozen entry (the extraction sourceHash, reused not recomputed)",
      );
      const cachePath = path.join(STATE_DIR, "cache", `${started.workflowHash}.json`);
      check(fs.existsSync(cachePath), `RUN-START OK: extraction cache entry exists at cache/${started.workflowHash.slice(0, 12)}….json`);
      if (fs.existsSync(cachePath)) {
        const entry = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        check(entry.sourceHash === started.workflowHash, "RUN-START OK: cache entry sourceHash matches workflowHash");
      }
    } else {
      fail("RUN-START: no frozenPath on the queue entry — cannot verify workflowHash against the frozen copy");
    }
    // (1) the bundle + source map are pinned with the run.
    check(typeof started.bundlePath === "string" && !!started.bundlePath, `RUN-START OK: bundlePath recorded (${started.bundlePath ?? "missing"})`);
    check(typeof started.bundleMapPath === "string" && !!started.bundleMapPath, `RUN-START OK: bundleMapPath recorded (${started.bundleMapPath ?? "missing"})`);
    if (typeof started.bundlePath === "string") {
      check(fs.existsSync(started.bundlePath), `BUNDLE OK: pinned bundle exists at ${started.bundlePath}`);
    }
    if (typeof started.bundleMapPath === "string") {
      check(fs.existsSync(started.bundleMapPath), `BUNDLE OK: pinned source map exists at ${started.bundleMapPath}`);
      if (fs.existsSync(started.bundleMapPath)) {
        const map = JSON.parse(fs.readFileSync(started.bundleMapPath, "utf8"));
        const sources: string[] = Array.isArray(map.sources) ? map.sources.map(String) : [];
        check(
          sources.some((s) => s.endsWith("workflow-bra73-exec.ts")),
          `BUNDLE OK: source map names the workflow source (${sources.filter((s) => s.includes("bra73")).join(", ") || sources.join(", ")})`,
        );
        check(
          Array.isArray(map.sourcesContent) && map.sourcesContent.some((c: unknown) => typeof c === "string" && c.includes("workflow-bra73-exec")),
          "BUNDLE OK: source map embeds the workflow source (sourcesContent present)",
        );
      }
    }
  }

  // (1) two exec traps at distinct call sites carry distinct sites.
  const traps = events.filter((e) => e.event === "trap");
  check(traps.length === 2, `SITE OK: 2 trap events (got ${traps.length})`);
  const sites = traps.map((t) => t.site);
  for (const [i, t] of traps.entries()) {
    const s = t.site;
    check(
      !!s && typeof s.file === "string" && typeof s.line === "number" && typeof s.column === "number" && s.line > 0 && s.column > 0,
      `SITE OK: trap-${i} carries site {file, line, column} (got ${JSON.stringify(s)})`,
    );
  }
  if (sites[0] && sites[1]) {
    check(
      sites[0].line !== sites[1].line || sites[0].column !== sites[1].column,
      `SITE OK: the two exec traps have DIFFERENT sites (trap-0 ${sites[0].line}:${sites[0].column}, trap-1 ${sites[1].line}:${sites[1].column}) — the shared site key 'exec' cannot tell them apart`,
    );
    check(sites[0].file === sites[1].file, `SITE OK: both sites are in the same bundle file (${path.basename(sites[0].file)})`);
    // Coordinates refer to the bundle: the pinned bundle's lines at
    // those coordinates must be the two exec() call sites, and the
    // bundle must be the one the run pinned (same content).
    if (started && typeof started.bundlePath === "string" && fs.existsSync(started.bundlePath)) {
      check(
        sites[0].file.endsWith(`bundle-${runId}.js`),
        `SITE OK: site file is the workdir bundle for this run (${path.basename(sites[0].file)})`,
      );
      check(
        sha256File(sites[0].file) === sha256File(started.bundlePath),
        "SITE OK: site file content is byte-identical to the pinned bundle (the pin is a copy under runs/)",
      );
      const bundleLines = fs.readFileSync(started.bundlePath, "utf8").split("\n");
      for (const [i, s] of sites.entries()) {
        const bundleLine = bundleLines[s.line - 1] ?? "";
        check(
          bundleLine.includes("exec("),
          `SITE OK: bundle line ${s.line} (trap-${i} site) is the exec() call (${bundleLine.trim().slice(0, 80)})`,
        );
      }
    }
  }
  // The journaled arg stays exactly the author's spec — the transport
  // key never survives into the journal (or to the adapter).
  for (const [i, t] of traps.entries()) {
    check(!("__agenttsSite" in (t.arg ?? {})), `SITE OK: trap-${i} journaled arg carries no __agenttsSite key (arg is the spec verbatim: ${JSON.stringify(t.arg)})`);
  }
  check(
    traps[0]?.arg?.cmd === "echo" && traps[0]?.arg?.args?.[0] === "first",
    "SITE OK: trap-0 arg is the first exec spec",
  );
  check(
    traps[1]?.arg?.cmd === "echo" && traps[1]?.arg?.args?.[0] === "second",
    "SITE OK: trap-1 arg is the second exec spec",
  );

  // (3) trap-dispatch exists (BRA-75) with wallTs; queue-wait and
  // execution are computable from trap → dispatch → result.
  for (const t of traps) {
    const dispatch = events.find((e) => e.event === "trap-dispatch" && e.trapId === t.trapId);
    check(!!dispatch, `DISPATCH OK: trap-dispatch present for ${t.trapId}`);
    const result = events.find((e) => (e.event === "trap-result" || e.event === "trap-error") && e.trapId === t.trapId);
    check(!!result, `DISPATCH OK: trap-result present for ${t.trapId}`);
    if (dispatch && result) {
      const trapMs = Date.parse(t.wallTs);
      const dispMs = Date.parse(dispatch.wallTs);
      const resMs = Date.parse(result.wallTs);
      check(
        Number.isFinite(trapMs) && Number.isFinite(dispMs) && Number.isFinite(resMs) && dispMs >= trapMs && resMs >= dispMs,
        `DISPATCH OK: ${t.trapId} wallTs order trap → dispatch → result (queue-wait ${dispMs - trapMs}ms, execution ${resMs - dispMs}ms)`,
      );
    }
  }

  // The profiler surfaces the new fields from the same journal.
  const tree = loadJournalTree(path.join(STATE_DIR, "journals"), runId);
  const p = profileTree(tree);
  check(p.traps.length === 2, `PROFILER OK: profile has 2 traps (got ${p.traps.length})`);
  const [pt0, pt1] = p.traps;
  check(!!pt0?.site && !!pt1?.site, "PROFILER OK: both TrapSpans carry a site");
  if (pt0?.site && pt1?.site) {
    check(
      pt0.site.line !== pt1.site.line,
      `PROFILER OK: TrapSpan sites differ (${pt0.site.line} vs ${pt1.site.line})`,
    );
  }
  for (const [i, pt] of p.traps.entries()) {
    check(
      pt?.queueWaitMs !== null && pt.queueWaitMs >= 0,
      `PROFILER OK: trap-${i} queueWaitMs is computable (${pt?.queueWaitMs}ms)`,
    );
    check(
      pt?.executionMs !== null && pt.executionMs >= 0,
      `PROFILER OK: trap-${i} executionMs is computable (${pt?.executionMs}ms)`,
    );
  }
  check(
    p.runStart?.workflowHash === started?.workflowHash,
    `PROFILER OK: runStart.workflowHash matches the journal (${String(p.runStart?.workflowHash ?? "").slice(0, 12)}…)`,
  );
  check(
    p.runStart?.submittedAt === submittedAt,
    "PROFILER OK: runStart.submittedAt matches the queue enqueuedAt",
  );
  check(
    p.runStart?.submitToStartMs !== null && (p.runStart?.submitToStartMs ?? -1) >= 0,
    `PROFILER OK: submit→start wait is computable (${p.runStart?.submitToStartMs}ms)`,
  );
  const text = renderTreeText(tree, p);
  check(text.includes("site="), "PROFILER OK: rendered timeline shows site=");
  check(text.includes("queue:"), "PROFILER OK: rendered timeline shows the queue/exec split");
  check(text.includes("workflowHash="), "PROFILER OK: rendered header shows workflowHash=");
}

// ------------------------------------------------------------ D: pool worker lane
async function testPoolWorker(): Promise<void> {
  console.log("\n=== D. pool job: trap-result.worker names the actual worker ===");
  fs.writeFileSync(
    WORKERS_JSON,
    JSON.stringify({ "bra73-slow": path.join(ROOT, "tests", "fixtures", "slow-worker.ts") }, null, 2),
  );
  const server = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT), "--lease-ms", "5000", "--max-attempts", "3", "--affinity-hold-ms", "8000", "--affinity-ttl-ms", String(30 * 60_000)],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const workerProcs: Subprocess[] = [];
  try {
    const up = await waitFor(async () => {
      try {
        const r = await http("GET", "/health");
        if (r.status !== 200 || r.body?.ok !== true) return false;
        if (r.body?.stateDir !== STATE_DIR) {
          throw new Error(`a stale worker server is already on port ${PORT} (state ${r.body?.stateDir}, want ${STATE_DIR}) — kill it and re-run`);
        }
        return true;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("a stale worker server")) throw e;
        return false;
      }
    }, 15_000, "worker server /health");
    if (!up) {
      const err = server.stderr ? await new Response(server.stderr).text().catch(() => "") : "";
      fail(`server did not come up: ${err.slice(0, 500)}`);
      return;
    }
    console.log(`server up on ${SERVER_URL}`);
    const worker = spawn(
      [BUN, path.join(ROOT, "plugins", "muse", "worker-loop.ts"), "--server", SERVER_URL, "--worker-id", "w-bra73", "--workspace-root", WORKSPACES, "--workers-config", WORKERS_JSON, "--poll-ms", "300"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    workerProcs.push(worker);
    console.log("worker w-bra73 started");

    // Sync path: a real run through the pool.
    const workflow = path.join(ROOT, "tests", "workflows", "workflow-bra73-job.ts");
    const runId = "run-bra73-job";
    const host = new Host({ stateDir: STATE_DIR, adapter: new MuseAdapter({ serverUrl: SERVER_URL }) });
    host.submit(workflow, { runId, input: { sleepMs: 100 } });
    await host.runQueue();
    const res = host.result(runId);
    check(res.status === "done", `POOL OK: job run done (got ${res.status} ${res.error ?? ""})`);
    check((res.output as any)?.sleptMs === 100, `POOL OK: worker slept 100ms (got ${JSON.stringify(res.output)})`);

    const events = readJournal(runId);
    const jobTrap = events.find((e) => e.event === "trap" && e.type === "job");
    check(!!jobTrap, "POOL OK: job trap in the journal");
    const trapResult = jobTrap ? events.find((e) => e.event === "trap-result" && e.trapId === jobTrap.trapId) : null;
    check(!!trapResult, `POOL OK: trap-result present for ${jobTrap?.trapId ?? "?"}`);
    check(
      trapResult?.worker === "w-bra73",
      `POOL OK: trap-result.worker is the actual worker (got ${JSON.stringify(trapResult?.worker)})`,
    );
    check(
      trapResult?.adapter === "muse",
      `POOL OK: trap-result.adapter is muse (got ${JSON.stringify(trapResult?.adapter)})`,
    );
    // The recorded dispatch answer carries the worker too (the
    // BRA-75 recovery path reads it from there).
    const dispatched = jobTrap ? events.find((e) => e.event === "trap-dispatched" && e.trapId === jobTrap.trapId) : null;
    check(
      (dispatched?.result as any)?.worker === "w-bra73",
      `POOL OK: trap-dispatched answer carries worker w-bra73 (got ${JSON.stringify((dispatched?.result as any)?.worker)})`,
    );
    // Cross-check against the pool's own record: jobs.log must show
    // the same worker completing a bra73-slow job, exactly once.
    // (jobs.log entries carry jobId/spec, not trapId — the trap→job
    // link is the run itself: the trap completed with this worker's
    // result, and trap-result.worker names it.)
    const completed = readJobsLog().filter((e) => e.event === "job-completed");
    check(completed.length === 1, `POOL OK: exactly 1 job-completed in jobs.log (got ${completed.length})`);
    check(
      completed[0]?.workerId === "w-bra73",
      `POOL OK: jobs.log names the same worker (got ${JSON.stringify(completed[0]?.workerId)})`,
    );
    check(
      completed[0]?.spec === "bra73-slow",
      `POOL OK: jobs.log completion is for the bra73-slow spec (got ${JSON.stringify(completed[0]?.spec)})`,
    );

    // Async path: spawnJob + collectJob must also return the worker
    // (collectJob dropped it before this fix — the sync path already
    // had it). A fresh adapter instance, no host wiring.
    const adapter = new MuseAdapter({ serverUrl: SERVER_URL });
    const handle = await adapter.spawnJob(
      { spec: "bra73-slow", trapId: "run-bra73-collect/trap-0", runId: "run-bra73-collect" },
      { sleepMs: 100 },
      "",
    );
    const collected = await adapter.collectJob(handle);
    check(
      (collected as any)?.worker === "w-bra73",
      `POOL OK: collectJob returns worker w-bra73 (got ${JSON.stringify((collected as any)?.worker)})`,
    );
    check(
      (collected as any)?.value?.sleptMs === 100,
      `POOL OK: collectJob value is the worker result (got ${JSON.stringify((collected as any)?.value)})`,
    );
  } finally {
    for (const w of workerProcs) {
      try {
        w.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
    try {
      server.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

// ------------------------------------------------------------ main
async function main(): Promise<number> {
  console.log(`BRA-73 tests — workdir ${WORKDIR}`);
  if (!process.env.DURABLETS_HOST) {
    console.log("FAIL: DURABLETS_HOST is not set — run via ./run.sh (it builds the C host and sets it)");
    return 1;
  }
  await testExecRun();
  await testPoolWorker();
  if (FAILURES.length) {
    console.log(`\nFAIL bra73 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log("\nPASS bra73 journal schema (trap site distinct per call site + bundle pinned, run-start fields, trap-dispatch split, pool worker on trap-result)");
  return 0;
}

process.exit(await main());
