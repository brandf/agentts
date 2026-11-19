#!/usr/bin/env bun
/**
 * Briefing live cutover (Linear BRA-111) — production-path proof.
 *
 * The daily-ai-briefing workflow's job specs (briefing-*) are
 * answered by workflows/dogfood/briefing-worker.ts, registered on
 * the direct adapter via a workers-config (BRA-56). The gap this
 * item closes: the worker server's driver built a plain
 * DirectAdapter per request and never honored a workers-config,
 * so a briefing run submitted with --adapter direct failed loudly
 * at its first job with "no worker registered" — even though the
 * CLI's makeHost honored the config. The fix (BRA-111) carries the
 * workers-config on the Host and applies it to every DirectAdapter
 * the Host uses (own + per-entry fresh loads), and the server
 * driver reads it from `worker serve --workers-config` /
 * AGENTTS_WORKERS_CONFIG.
 *
 *   A. Direct without a workers-config fails loudly: submit
 *      daily-ai-briefing.ts with --adapter direct to a scratch
 *      server with no config; the standin drives it and delivers
 *      the FAILED run; the error names the unregistered
 *      briefing-discover spec.
 *   B. Direct with a workers-config drives briefing jobs: the
 *      render test workflow (briefing-relate + briefing-render,
 *      fixture input, pure computation, no network) is submitted
 *      with --adapter direct to a scratch server started with
 *      AGENTTS_WORKERS_CONFIG pointing at the checked-in
 *      workflows/dogfood/briefing-workers.json; the standin drives
 *      it and delivers it; the delivery carries the real rendered
 *      output.
 *   C. A bad workers-config fails loudly on both paths: a missing
 *      file makes POST /queue/run answer 500 naming the workers
 *      config, and makes the CLI `run --workers-config` exit
 *      nonzero; a malformed file does the same on the CLI.
 *   D. The checked-in briefing-workers.json maps all five specs
 *      to the existing briefing-worker.ts script.
 *
 * The real-day trial (live arXiv fetches, Nov 18 edition, compared
 * against the cron's edition) is NOT in run.sh — it is a one-off
 * proof run outside the suite (~/workspace/bra111-trial.sh), because
 * it takes minutes and depends on live arXiv. This test proves the
 * mechanism deterministically.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra111.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra110 suite.)
 *
 * Run outputs go to $BRA111_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Servers + standins are killed in finally
 * blocks, even on failure. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";
const VENV_PYTHON =
  "/home/hatch/workspace/goals/daily-ai-research-briefing/hidden_files/.venv/bin/python";

const WORKDIR = process.env.BRA111_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra111-"));
const WORKERS_JSON = path.join(ROOT, "workflows", "dogfood", "briefing-workers.json");

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

/** Stable JSON stringify (sorted keys) for deep-equality checks. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

let portSeq = 21000 + Math.floor(Math.random() * 5000);
function nextPort(): number {
  return portSeq++;
}

interface ServerHandle {
  proc: Subprocess;
  url: string;
  stateDir: string;
}

async function startServer(stateDir: string, envExtra: Record<string, string>): Promise<ServerHandle> {
  const port = nextPort();
  const url = `http://127.0.0.1:${port}`;
  fs.mkdirSync(stateDir, { recursive: true });
  const proc = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", stateDir, "--port", String(port)],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...envExtra }, cwd: ROOT },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { proc, url, stateDir };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`bra111 server did not come up on ${port}`);
    await sleep(50);
  }
}

async function stopServer(h: ServerHandle | null): Promise<void> {
  if (!h) return;
  try {
    h.proc.kill(9);
  } catch { /* already dead */ }
  await h.proc.exited;
}

let standin: Subprocess | null = null;
function startStandin(stateDir: string, serverUrl: string): void {
  standin = spawn(
    [BUN, path.join(ROOT, "tests", "tick-standin.ts"), "--state-dir", stateDir, "--server", serverUrl, "--tick-timeout-ms", "1000", "--max-cycles", "300"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env }, cwd: ROOT },
  );
}
async function killStandin(): Promise<void> {
  if (!standin) return;
  const s = standin;
  standin = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
}

async function http(serverUrl: string, method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}${p}`, {
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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: ROOT,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function readQueue(stateDir: string): any[] {
  const p = path.join(stateDir, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}
function queueStatus(stateDir: string, runId: string): string | null {
  return readQueue(stateDir).find((e) => e.runId === runId)?.status ?? null;
}
function queueError(stateDir: string, runId: string): string {
  return readQueue(stateDir).find((e) => e.runId === runId)?.error ?? "";
}
function deliveryFor(stateDir: string, runId: string): any | null {
  const p = path.join(stateDir, "deliveries", `${runId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function deliveryFileCount(stateDir: string, runId: string): number {
  const dir = path.join(stateDir, "deliveries");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f === `${runId}.json`).length;
}
function getResult(stateDir: string, runId: string): any | null {
  const r = cli(["result", runId, "--state-dir", stateDir]);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}

function submit(stateDir: string, serverUrl: string, workflow: string, runId: string, input: unknown, extraArgs: string[] = []): void {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const args = ["run", workflow, "--run-id", runId, "--input-file", inputFile, "--state-dir", stateDir, ...extraArgs];
  const r = cli(args, { AGENTTS_WORKER_SERVER: serverUrl });
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
}

async function sectionA(): Promise<void> {
  console.log("\n=== A. direct without workers-config fails loudly ===");
  const stateDir = path.join(WORKDIR, "state-a");
  const server = await startServer(stateDir, {});
  try {
    const runId = "bra111-a1";
    const scratch = path.join(WORKDIR, "trial-a");
    submit(stateDir, server.url, path.join(ROOT, "workflows", "dogfood", "daily-ai-briefing.ts"), runId, {
      editionDate: "2026-11-18",
      dateLabel: "Wednesday, November 18, 2026",
      scratchDir: scratch,
      windowDays: 3,
      readCount: 2,
      selectCount: 2,
      venvPython: VENV_PYTHON,
      mock: true,
    }, ["--adapter", "direct"]);
    startStandin(stateDir, server.url);
    const delivered = await waitFor(() => deliveryFor(stateDir, runId) !== null, 60_000, `delivery for ${runId}`);
    check(delivered, `A DELIVER OK: standin delivered failed ${runId} to the outbox`);
    await killStandin();
    if (!delivered) return;
    const rec = deliveryFor(stateDir, runId);
    check(rec?.status === "failed", `A FAILED OK: ${runId} delivery status is failed (got ${rec?.status})`);
    const err = String(rec?.error ?? queueError(stateDir, runId) ?? "");
    check(
      err.includes('no worker registered for jobspec "briefing-discover"'),
      `A FAILED OK: ${runId} error names the unregistered briefing-discover spec (got ${err.slice(0, 160)})`,
    );
    check(queueStatus(stateDir, runId) === "failed", `A QUEUE OK: ${runId} queue entry is failed (got ${queueStatus(stateDir, runId)})`);
    check(deliveryFileCount(stateDir, runId) === 1, `A OUTBOX OK: exactly one outbox record file for ${runId} (got ${deliveryFileCount(stateDir, runId)})`);
  } finally {
    await killStandin();
    await stopServer(server);
  }
}

async function sectionB(): Promise<void> {
  console.log("\n=== B. direct with workers-config drives briefing jobs ===");
  const stateDir = path.join(WORKDIR, "state-b");
  const server = await startServer(stateDir, { AGENTTS_WORKERS_CONFIG: WORKERS_JSON });
  try {
    const runId = "bra111-b1";
    const paperId = "2611.90001";
    submit(stateDir, server.url, path.join(TESTS, "workflow-bra111-render.ts"), runId, {
      paper: {
        id: paperId,
        title: "Quantized Lattice Transformers with Recurrent Depth",
        authors: "Fixture Author",
        submitted: "2026-11-18",
        abstract: "We propose quantized lattice transformers with recurrent depth. The quantized recurrence improves memory by 12% over the baseline.",
        numbers: ["Memory improves by 12% over the baseline."],
        method: ["We propose quantized lattice transformers with recurrent depth."],
        caveats: ["Fixture limitation: nothing was tested at scale."],
        topics: ["looped-recurrent", "quantization"],
        fullText: true,
      },
      priorWork: [
        { id: "2611.21608", title: "Latent Lattice Language Models", date: "2026-11-16" },
        { id: "2609.20751", title: "Quantized Transformer Memory with Recurrent State", date: "2026-09-25" },
      ],
      date: "2026-11-18",
      dateLabel: "Wednesday, November 18, 2026",
      scopeNote: "BRA-111 fixture scope note.",
    }, ["--adapter", "direct", "--workers-config", WORKERS_JSON]);
    startStandin(stateDir, server.url);
    const delivered = await waitFor(() => deliveryFor(stateDir, runId) !== null, 60_000, `delivery for ${runId}`);
    check(delivered, `B DELIVER OK: standin delivered ${runId} to the outbox`);
    await killStandin();
    if (!delivered) return;
    const rec = deliveryFor(stateDir, runId);
    check(rec?.status === "done", `B DONE OK: ${runId} delivery status is done (got ${rec?.status})`);
    const out = rec?.output ?? {};
    check(typeof out.relations === "number" && out.relations >= 1, `B RELATE OK: ${runId} found ${out.relations ?? "?"} prior-work relation(s)`);
    check(
      typeof out.threadNote === "string" && out.threadNote.includes("looped"),
      `B THREAD OK: ${runId} thread note names the looped thread (got ${String(out.threadNote ?? "").slice(0, 80)})`,
    );
    check(out.markdownHasTitle === true, `B RENDER OK: ${runId} markdown contains the fixture paper title`);
    check(out.markdownHasMustRead === true, `B RENDER OK: ${runId} markdown carries the must-read line`);
    check(out.mustReadId === paperId && out.paperCount === 1, `B META OK: ${runId} must-read ${out.mustReadId}, paperCount ${out.paperCount}`);
    check(
      Array.isArray(out.metaPapers) && out.metaPapers.length === 1 && out.metaPapers[0] === paperId,
      `B META OK: ${runId} meta papers are [${paperId}]`,
    );
    const result = getResult(stateDir, runId);
    check(
      result !== null && stable(rec?.output) === stable(result),
      `B READ OK: ${runId} delivery output is the validated result`,
    );
    check(deliveryFileCount(stateDir, runId) === 1, `B OUTBOX OK: exactly one outbox record file for ${runId} (got ${deliveryFileCount(stateDir, runId)})`);
  } finally {
    await killStandin();
    await stopServer(server);
  }
}

async function sectionC(): Promise<void> {
  console.log("\n=== C. bad workers-config fails loudly ===");
  const missing = path.join(WORKDIR, "no-such-workers.json");
  const badJson = path.join(WORKDIR, "bad-workers.json");
  fs.writeFileSync(badJson, "{not json");
  const stateDir = path.join(WORKDIR, "state-c");
  const server = await startServer(stateDir, { AGENTTS_WORKERS_CONFIG: missing });
  try {
    const runId = "bra111-c1";
    const inputFile = path.join(WORKDIR, `${runId}.input.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ markerFile: path.join(WORKDIR, "bra111-c1.marker"), sleepMs: 0 }));
    const r = cli(["run", path.join(TESTS, "workflow-bra72-exec.ts"), "--run-id", runId, "--input-file", inputFile, "--state-dir", stateDir, "--adapter", "direct"], { AGENTTS_WORKER_SERVER: server.url });
    check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `C SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
    const drive = await http(server.url, "POST", "/queue/run");
    check(
      drive.status === 500 && String(drive.body?.error ?? "").includes("workers config"),
      `C DRIVE OK: /queue/run answers 500 naming the workers config (got ${drive.status}, ${JSON.stringify(drive.body ?? {}).slice(0, 160)})`,
    );
    check(queueStatus(stateDir, runId) === "queued", `C QUEUE OK: ${runId} still queued after the loud drive failure (got ${queueStatus(stateDir, runId)})`);
  } finally {
    await stopServer(server);
  }
  const cliMissing = cli(["run", path.join(TESTS, "workflow-bra72-exec.ts"), "--run-id", "bra111-c2", "--input-file", path.join(WORKDIR, "bra111-c1.input.json"), "--state-dir", path.join(WORKDIR, "state-c2"), "--adapter", "direct", "--workers-config", missing]);
  check(
    cliMissing.rc !== 0 && (cliMissing.err + cliMissing.out).includes("workers config"),
    `C CLI OK: run --workers-config <missing> exits nonzero naming the workers config (got rc ${cliMissing.rc})`,
  );
  const cliBad = cli(["run", path.join(TESTS, "workflow-bra72-exec.ts"), "--run-id", "bra111-c3", "--input-file", path.join(WORKDIR, "bra111-c1.input.json"), "--state-dir", path.join(WORKDIR, "state-c3"), "--adapter", "direct", "--workers-config", badJson]);
  check(
    cliBad.rc !== 0 && (cliBad.err + cliBad.out).includes("workers config"),
    `C CLI OK: run --workers-config <malformed> exits nonzero naming the workers config (got rc ${cliBad.rc})`,
  );
}

function sectionD(): void {
  console.log("\n=== D. checked-in briefing workers-config ===");
  const raw = fs.readFileSync(WORKERS_JSON, "utf8");
  const cfg = JSON.parse(raw) as Record<string, string>;
  const specs = ["briefing-discover", "briefing-read", "briefing-relate", "briefing-render", "briefing-write"];
  check(
    specs.every((s) => typeof cfg[s] === "string"),
    `D CONFIG OK: briefing-workers.json maps all five specs (${Object.keys(cfg).sort().join(", ")})`,
  );
  const missing = specs.filter((s) => !fs.existsSync(path.resolve(ROOT, cfg[s])));
  check(
    missing.length === 0,
    `D CONFIG OK: every mapped script exists (missing: ${missing.join(", ") || "none"})`,
  );
  check(
    specs.every((s) => cfg[s].endsWith("workflows/dogfood/briefing-worker.ts")),
    `D CONFIG OK: every spec maps to workflows/dogfood/briefing-worker.ts`,
  );
}

try {
  await sectionA();
  await sectionB();
  await sectionC();
  sectionD();
} finally {
  await killStandin();
}

if (FAILURES.length) {
  console.log(`\nFAIL bra111 briefing live cutover (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra111 briefing live cutover (direct adapter fails loudly without a workers-config, drives briefing jobs with one, bad configs fail loudly, checked-in config maps all five specs)");
