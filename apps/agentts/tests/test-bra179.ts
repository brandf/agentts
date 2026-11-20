#!/usr/bin/env bun
/**
 * E2BIG on job-input spawn (Linear BRA-179, input side).
 *
 *   A. Small job input through the direct adapter (echo fixture):
 *      inline delivery unchanged.
 *   B. Large job input (~200KB) through the direct adapter (echo
 *      fixture): the payload JSON exceeds Linux's 128KB
 *      single-argument cap (MAX_ARG_STRLEN), so the worker spawn
 *      fails E2BIG on un-fixed code. The job must run and echo the
 *      whole text back (length + head/tail).
 *   C. Workflow end to end via CLI + direct adapter: the workflow
 *      cats a ~200KB file, then judges its whole text with the real
 *      worker.ts — the judge job input crosses the spawn. The run
 *      must complete with the judge's real verdict (score 0.25:
 *      only "concrete" addressed — the text has digits but no vivid
 *      word and far more than 25 words).
 *   D. Pool leg: the same workflow driven ONLY through
 *      POST /queue/run with a script pool worker (worker-loop.ts
 *      spawns the worker script the same way) — the pool spawn site
 *      has the same shape, and its file-backed payload must land
 *      with the live worker's verdict. No leftover payload scratch
 *      file in the job workspace. This leg also proves the third
 *      site the test found: the muse adapter enqueues the job over
 *      sync curl, whose `--data` argv string E2BIGs on a large job
 *      input before the worker spawn is even reached — large
 *      bodies now travel as `--data-binary @<file>` (worker-http.ts).
 *   E. bugfix-worker + briefing-worker read the marker: spawned
 *      directly with an `agentts-file:` payload naming an unknown
 *      spec, each must fail with `unknown spec "nope"` — proving
 *      the file was read and parsed (on un-fixed code the marker
 *      string itself fails JSON.parse with a SyntaxError instead).
 *   F. Loud failure: worker.ts spawned with a marker pointing at
 *      a nonexistent file must exit nonzero with the path named
 *      ("cannot read job payload file ..."), never run with an
 *      empty input.
 *   G. Cleanup: no `.agentts-job-payload-*.json` scratch files
 *      remain in os.tmpdir() after the direct legs.
 *   H. BRA-167 shape (the original failure): a judge job whose
 *      input carries two full-page texts — the architecture page
 *      (75,646 bytes) and ARCHITECTURE.md (56,195 bytes) — plus the
 *      rubric, ~208KB of payload. The job must complete with a
 *      verdict. On un-fixed code this is the exact E2BIG the first
 *      rubricReview run hit.
 *
 *   DURABLETS_HOST=<built C host> DQUICKTS=<dquickts tree> bun tests/test-bra179.ts
 *   (run.sh sets both.)
 * Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { spawn, type Subprocess } from "bun";

import { Host } from "../src/host";
import { MuseAdapter } from "../plugins/muse/src/muse-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA179_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra179-"));
fs.mkdirSync(WORKDIR, { recursive: true });

// BRA-133 rule: never let an in-process submit post to the production
// worker server (port 18741). A dead port keeps notifyEvent local —
// overridden to the test server in section D before its submit.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:9";

// > 128KB MAX_ARG_STRLEN (131072), < 1MB spawnSync stdout cap
// (BRA-174) — comfortably inside the exec path on both sides.
const BIG_LEN = 200_000;

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

/** Deterministic big file: numbered 100-char lines + "\n". Returns the
 * expected {len, head, tail} read back from the file itself. */
function writeBigFile(filePath: string, targetBytes: number): { len: number; head: string; tail: string } {
  const lines: string[] = [];
  let n = 0;
  let bytes = 0;
  while (bytes < targetBytes) {
    const line = `line-${String(n).padStart(6, "0")}:` + "x".repeat(88);
    lines.push(line);
    bytes += line.length + 1;
    n++;
  }
  const text = lines.join("\n") + "\n";
  fs.writeFileSync(filePath, text);
  const back = fs.readFileSync(filePath, "utf8");
  const split = back.split("\n");
  return { len: back.length, head: split[0], tail: split[split.length - 2] };
}

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function leftoverPayloadFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.includes(".agentts-job-payload-"));
}

async function main(): Promise<number> {
  const bigFile = path.join(WORKDIR, "big.txt");
  const expected = writeBigFile(bigFile, BIG_LEN);
  check(expected.len > 131_072, `SETUP OK: big file is ${expected.len} bytes (> 128KB cap)`);
  const bigText = fs.readFileSync(bigFile, "utf8");
  check(bigText.length === expected.len, `SETUP OK: big text is ${bigText.length} bytes`);

  // --------------------------------------- A + B: direct adapter, echo fixture
  const echoWorker = path.join(ROOT, "tests", "fixtures", "bra179-echo-worker.ts");
  const ctx = { runId: "run-bra179-unit", trapId: "run-bra179-unit/trap-0", ordinal: 0 };
  {
    const adapter = new DirectAdapter({ workers: { "bra179-echo": echoWorker } });
    // A. Small input: inline delivery unchanged.
    const small = adapter.answer("job", { spec: "bra179-echo", input: { text: "hello small" } }, ctx) as any;
    check(
      small.value?.len === 11 && small.value?.head === "hello small" && small.value?.tail === "hello small",
      `A SMALL OK: small job input delivered inline (got ${JSON.stringify(small.value)})`,
    );
    // B. Large input: file-backed delivery.
    let big: any = null;
    let bigErr = "";
    try {
      big = adapter.answer("job", { spec: "bra179-echo", input: { text: bigText } }, ctx) as any;
    } catch (e) {
      bigErr = e instanceof Error ? e.message : String(e);
    }
    check(big !== null, `B BIG OK: large job input did not throw (got ${bigErr.slice(0, 300)})`);
    check(
      big?.value?.len === expected.len,
      `B BIG OK: large job input delivered whole — len ${big?.value?.len} (expected ${expected.len})`,
    );
    check(
      big?.value?.head === expected.head.slice(0, 20) && big?.value?.tail === bigText.slice(-20),
      `B BIG OK: head/tail match (${JSON.stringify(big?.value?.head)} / ${JSON.stringify(big?.value?.tail)})`,
    );
  }

  // --------------------------------------------- C: workflow e2e, CLI + direct
  const cliState = path.join(WORKDIR, "cli-state");
  fs.mkdirSync(cliState, { recursive: true });
  {
    const run = cli([
      "run", path.join(TESTS, "workflow-bra179.ts"),
      "--run-id", "run-bra179-big",
      "--input", JSON.stringify({ filePath: bigFile }),
      "--adapter", "direct", "--state-dir", cliState, "--wait",
    ]);
    let out: any = null;
    try {
      out = JSON.parse(run.out);
    } catch {
      out = null;
    }
    check(run.rc === 0, `C E2E OK: CLI --wait exited 0 (got ${run.rc}; err: ${run.err.slice(0, 300)})`);
    check(out !== null, `C E2E OK: CLI printed parseable result JSON (got ${JSON.stringify(run.out).slice(0, 200)})`);
    check(out?.textLen === expected.len, `C E2E OK: judged text is the whole file — textLen ${out?.textLen} (expected ${expected.len})`);
    check(
      out?.score === 0.25 && out?.label === "weak",
      `C E2E OK: real judge verdict over the full text — score ${out?.score}, label ${out?.label} (expected 0.25 / weak)`,
    );
    check(
      typeof out?.notes === "string" && out.notes.includes("concrete 42: addressed"),
      `C E2E OK: verdict notes name the addressed criterion (got ${JSON.stringify(out?.notes)?.slice(0, 120)})`,
    );
  }

  // --------------------------------------- D: pool leg, POST /queue/run only
  const poolState = path.join(WORKDIR, "pool-state");
  const poolWorkspaces = path.join(WORKDIR, "pool-workspaces");
  const poolWorkersJson = path.join(WORKDIR, "pool-workers.json");
  fs.mkdirSync(poolState, { recursive: true });
  fs.mkdirSync(poolWorkspaces, { recursive: true });
  const PORT = Number(process.env.AGENTTS_WORKER_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
  const SERVER_URL = `http://127.0.0.1:${PORT}`;
  process.env.AGENTTS_WORKER_SERVER = SERVER_URL;
  fs.writeFileSync(
    poolWorkersJson,
    JSON.stringify({ judge: path.join(ROOT, "workflows", "library", "worker.ts") }, null, 2),
  );
  const server = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", poolState, "--port", String(PORT), "--lease-ms", "5000", "--max-attempts", "3"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  const workerProcs: Subprocess[] = [];
  try {
    const up = await waitFor(async () => {
      try {
        const r = await http("GET", "/health", undefined, 5000);
        return r.status === 200 && r.body?.ok === true && r.body?.stateDir === poolState;
      } catch {
        return false;
      }
    }, 15_000, "worker server /health");
    if (!up) {
      const err = server.stderr ? await new Response(server.stderr).text().catch(() => "") : "";
      fail(`D POOL FAIL: server did not come up: ${err.slice(0, 500)}`);
    } else {
      console.log(`server up on ${SERVER_URL}`);
      const worker = spawn(
        [BUN, path.join(ROOT, "plugins", "muse", "worker-loop.ts"), "--server", SERVER_URL, "--worker-id", "w-bra179", "--workspace-root", poolWorkspaces, "--workers-config", poolWorkersJson, "--poll-ms", "300"],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
      );
      workerProcs.push(worker);
      const runId = "run-bra179-pool";
      const host = new Host({ stateDir: poolState, adapter: new MuseAdapter({ serverUrl: SERVER_URL }) });
      host.submit(path.join(TESTS, "workflow-bra179.ts"), { runId, input: { filePath: bigFile } });
      const drive = await http("POST", "/queue/run", {});
      check(drive.status === 200, `D POOL OK: POST /queue/run returns 200 (got ${drive.status}: ${JSON.stringify(drive.body).slice(0, 300)})`);
      check(drive.body?.failed !== true, `D POOL OK: response does not report failed runs (failed=${drive.body?.failed})`);
      const res = host.result(runId);
      check(res.status === "done", `D POOL OK: result done (got ${res.status} ${res.error ?? ""})`);
      check(
        (res.output as any)?.textLen === expected.len,
        `D POOL OK: pool judge saw the whole text — textLen ${(res.output as any)?.textLen} (expected ${expected.len})`,
      );
      check(
        (res.output as any)?.score === 0.25,
        `D POOL OK: pool judge verdict matches the direct verdict — score ${(res.output as any)?.score} (expected 0.25)`,
      );
      const events = readJournal(poolState, runId);
      const jobTrap = events.find((e) => e.event === "trap" && e.type === "job");
      const trapResult = jobTrap ? events.find((e) => e.event === "trap-result" && e.trapId === jobTrap.trapId) : null;
      check(
        trapResult?.worker === "w-bra179",
        `D POOL OK: trap-result.worker is the actual pool worker (got ${JSON.stringify(trapResult?.worker)})`,
      );
      // No leftover payload scratch file in the job workspace.
      const jobWorkspace = path.join(poolWorkspaces, "w-bra179", runId);
      check(
        leftoverPayloadFiles(jobWorkspace).length === 0,
        `D POOL OK: no payload scratch file left in the job workspace (got ${JSON.stringify(leftoverPayloadFiles(jobWorkspace))})`,
      );
    }
  } finally {
    for (const p of workerProcs) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
    try {
      server.kill("SIGTERM");
    } catch {}
  }

  // ----------------------- E: bugfix-worker + briefing-worker read the marker
  {
    const markerPayload = path.join(WORKDIR, "marker-payload.json");
    fs.writeFileSync(markerPayload, JSON.stringify({ spec: "nope", input: {} }));
    for (const [name, script] of [
      ["bugfix-worker", path.join(ROOT, "workflows", "dogfood", "bugfix-worker.ts")],
      ["briefing-worker", path.join(ROOT, "workflows", "dogfood", "briefing-worker.ts")],
    ] as const) {
      const r = spawnSync(BUN, [script, `agentts-file:${markerPayload}`], { encoding: "utf8", env: { ...process.env } });
      check(
        (r.status ?? 0) !== 0 && (r.stderr ?? "").includes('unknown spec "nope"'),
        `E ${name.toUpperCase()} OK: marker payload read and parsed — unknown spec named (rc ${r.status}, stderr: ${(r.stderr ?? "").trim().slice(0, 200)})`,
      );
    }
  }

  // --------------------------------------- F: missing file fails loudly
  {
    const bogus = path.join(WORKDIR, "does-not-exist.json");
    const r = spawnSync(BUN, [path.join(ROOT, "workflows", "library", "worker.ts"), `agentts-file:${bogus}`], {
      encoding: "utf8",
      env: { ...process.env },
    });
    check(
      (r.status ?? 0) !== 0 && (r.stderr ?? "").includes(bogus) && (r.stderr ?? "").includes("cannot read job payload file"),
      `F LOUD OK: missing payload file fails loudly with the path named (rc ${r.status}, stderr: ${(r.stderr ?? "").trim().slice(0, 200)})`,
    );
  }

  // --------------------------------------- G: no scratch files left in tmpdir
  {
    const leftovers = leftoverPayloadFiles(os.tmpdir()).concat(
      fs.existsSync(os.tmpdir()) ? fs.readdirSync(os.tmpdir()).filter((n) => n.includes(".agentts-http-body-")) : [],
    );
    check(
      leftovers.length === 0,
      `G CLEANUP OK: no .agentts-job-payload-*.json or .agentts-http-body-*.json files left in os.tmpdir() (got ${JSON.stringify(leftovers.slice(0, 5))})`,
    );
  }

  // --------------------------------------- H: BRA-167 shape — two full-page texts
  {
    const goodPage = fs.readFileSync(path.join(ROOT, "..", "..", "docs", "architecture-visual.html"), "utf8");
    const archMd = fs.readFileSync(path.join(ROOT, "..", "..", "docs", "ARCHITECTURE.md"), "utf8");
    const payloadBytes = Buffer.byteLength(
      JSON.stringify({
        spec: "judge",
        input: {
          item: { text: goodPage },
          rubric: { criteria: ["vivid fox", "concrete 42", "concise"], threshold: 0.8 },
          referenceGood: goodPage,
          referenceMediocre: archMd,
        },
      }),
      "utf8",
    );
    check(payloadBytes > 131_072, `H SETUP OK: BRA-167-shaped payload is ${payloadBytes} bytes (> 128KB cap)`);
    const adapter = new DirectAdapter();
    let verdict: any = null;
    let verdictErr = "";
    try {
      verdict = adapter.answer(
        "job",
        {
          spec: "judge",
          input: {
            item: { text: goodPage },
            rubric: { criteria: ["vivid fox", "concrete 42", "concise"], threshold: 0.8 },
            referenceGood: goodPage,
            referenceMediocre: archMd,
          },
        },
        { runId: "run-bra179-bra167", trapId: "run-bra179-bra167/trap-0", ordinal: 0 },
      ) as any;
    } catch (e) {
      verdictErr = e instanceof Error ? e.message : String(e);
    }
    check(verdict !== null, `H BRA167 OK: two-full-page judge job did not throw (got ${verdictErr.slice(0, 300)})`);
    check(
      typeof verdict?.value?.score === "number",
      `H BRA167 OK: judge returned a verdict over the full pages — score ${verdict?.value?.score} (expected a number)`,
    );
  }

  if (FAILURES.length > 0) {
    console.log(`\nFAIL bra179 E2BIG job-input spawn (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("\nPASS bra179 E2BIG job-input spawn");
  return 0;
}

async function http(method: "GET" | "POST", p: string, body?: unknown, timeoutMs = 120_000): Promise<{ status: number; body: any }> {
  const port = process.env.AGENTTS_WORKER_SERVER ?? "";
  const res = await fetch(`${port}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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

function readJournal(stateDir: string, runId: string): any[] {
  const p = path.join(stateDir, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

process.exit(await main());
