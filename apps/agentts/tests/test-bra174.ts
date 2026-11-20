#!/usr/bin/env bun
/**
 * Bun spawnSync caps stdout at ~1 MB (Linear BRA-174).
 *
 * Bun/Node spawnSync buffers the child's whole stdout in memory with
 * a default maxBuffer of ~1MB; anything larger fails the spawn with
 * ENOBUFS. briefing-worker.ts fetchText runs curl first (proven
 * reliable through this VM's egress proxy) with no maxBuffer, so the
 * three big arXiv list pages (~1.58-1.7MB) always failed the
 * curl-first path and every discover relied on the Bun fetch fallback
 * — no redundancy there, and two failed curl attempts of latency on
 * those pages.
 *
 *   A. fetchText against a local server serving a 2MB body: the
 *      curl-first path must return it whole, with NO failed-curl log
 *      lines at all (on un-fixed code the body still arrives via the
 *      fallback, but the ENOBUFS log lines give the failure away).
 *   B. fetchText small body: inline path unchanged, no fallback.
 *   C. Fallback still works: with curl replaced by a failing shim
 *      (PATH doctored for the call), fetchText must still return the
 *      body via Bun fetch — and log the failed curl attempts, proving
 *      curl was tried first.
 *   D. Direct adapter exec of `cat` on a 2MB file (reuses the
 *      workflow-bra171 fixture): the exec trap's spawnSync stdout is
 *      the same uncapped shape — on un-fixed code the trap comes back
 *      exitCode 1 with ENOBUFS in stderr, so len is 0. Must return
 *      the whole file (len + head/tail).
 *   E. runHost stdout: a fork branch returning a 2MB string. The C
 *      host prints each branch outcome on its stdout as
 *      `branch <i> outcome: <json>` (durablets.c write_outcome) and
 *      the host reads it back from the child's captured stdout, so
 *      the branch run's spawn fails ENOBUFS on un-fixed code and the
 *      whole run dies with "host spawn failed". Must complete with
 *      the 2MB string joined.
 *
 * AUDIT (all spawnSync sites under src/, plugins/, workflows/):
 *   FIXED (maxBuffer 16MB — ~10x the largest known payload, far
 *   below anything that would threaten memory on this VM; a runaway
 *   command still fails loudly instead of OOMing the host):
 *   - workflows/dogfood/briefing-worker.ts fetchText (this bug)
 *   - src/host.ts runHost (workflow console output + branch outcomes)
 *   - plugins/mock/src/mock-plugin.ts runHost (verbatim twin, BRA-88)
 *   - plugins/muse/src/muse-adapter.ts exec + runExec (real user
 *     commands; BRA-171 covers result delivery, not this capture)
 *   - plugins/direct/src/direct-adapter.ts exec (same shape)
 *   - src/worker-http.ts httpSync (/get-job carries whole job inputs,
 *     no protocol cap; BRA-179 already showed 145KB)
 *   - src/cli.ts worker get-job/complete-job spawn (same payload as
 *     /get-job: one job record including its input)
 *   - src/task-backend.ts linearCall (listTasks caps at 200 issues
 *     but descriptions are unbounded)
 *   NOT FIXED (size bounded by construction or contract):
 *   - src/host.ts engine probe (4-line bundle, prints nothing)
 *   - src/host.ts bundleSync (bun build prints a short summary;
 *     bundle bytes go to a file)
 *   - plugins/direct/src/direct-adapter.ts runJob (stdout is exactly
 *     one JSON line — worker.ts prints only the final result, all
 *     logging is console.error — and every current worker spec
 *     returns KB-scale results)
 *   - workflows/dogfood/bugfix-worker.ts spawn() (run.sh in driver
 *     mode prints ~1KB for a full tier-1; make/bun install output
 *     is small)
 *
 *   DURABLETS_HOST=<built C host> DQUICKTS=<dquickts tree> bun tests/test-bra174.ts
 *   (run.sh sets both.)
 * Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

import { fetchText } from "../workflows/dogfood/briefing-worker";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA174_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra174-"));
fs.mkdirSync(WORKDIR, { recursive: true });

// BRA-133 rule: never let an in-process submit post to the production
// worker server (port 18741). A dead port keeps notifyEvent local.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:9";

// > 1MB spawnSync stdout cap (1,048,576), > 128KB argv cap — the
// payloads below cross the stdout cap but not the 16MB fix cap.
const BIG_LEN = 2_000_000;

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
    // Section E's result JSON is itself ~2MB (the joined branch
    // outcome), so this helper needs the same 16MB cap as the
    // production sites — without it the helper's own spawn ENOBUFS
    // and the run looks failed even though it completed.
    maxBuffer: 16 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Capture console.error lines emitted while f runs. fetchText logs
 * via console.error("[briefing-worker]", ...). */
async function capturingStderr<T>(f: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const value = await f();
    return { value, lines };
  } finally {
    console.error = orig;
  }
}

async function main(): Promise<number> {
  const bigFile = path.join(WORKDIR, "big.txt");
  const expected = writeBigFile(bigFile, BIG_LEN);
  check(expected.len > 1_048_576, `SETUP OK: big file is ${expected.len} bytes (> 1MB stdout cap)`);
  const bigText = fs.readFileSync(bigFile, "utf8");
  const smallText = "hello small\n";

  // Local server: /big serves the 2MB body, /small the small one.
  // The server runs as a SEPARATE bun process (not Bun.serve in
  // this process): fetchText's curl runs under a blocking spawnSync,
  // which would stall this process's event loop — and an in-process
  // server could never answer curl while the loop is blocked, so
  // every curl attempt would time out (status 28) and the test would
  // measure the fallback, not curl-first. The server writes its port
  // to a file; the test polls for it, then kills the child at the end.
  const serverScript = path.join(WORKDIR, "server-bra174.ts");
  fs.writeFileSync(
    serverScript,
    `import * as fs from "node:fs";
const [bigFile, smallFile, portFile] = process.argv.slice(2);
const big = fs.readFileSync(bigFile, "utf8");
const small = fs.readFileSync(smallFile, "utf8");
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/big") return new Response(big);
    if (u.pathname === "/small") return new Response(small);
    return new Response("not found", { status: 404 });
  },
});
fs.writeFileSync(portFile, String(server.port));
`,
  );
  const portFile = path.join(WORKDIR, "server.port");
  fs.writeFileSync(path.join(WORKDIR, "small.txt"), smallText);
  const serverProc = Bun.spawn([BUN, serverScript, bigFile, path.join(WORKDIR, "small.txt"), portFile], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let port = 0;
    for (let i = 0; i < 100 && port === 0; i++) {
      if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8"));
      else await Bun.sleep(100);
    }
    check(port > 0, `SETUP OK: local test server listening on port ${port}`);
    const base = `http://127.0.0.1:${port}`;

  // --------------------------------------------- A: fetchText, 2MB body
  {
    const { value: r, lines } = await capturingStderr(() => fetchText(`${base}/big`, 30_000));
    check(r.ok && r.status === 200, `A BIG OK: fetchText returned ok status 200 (got ok=${r.ok} status=${r.status})`);
    check(r.text === bigText, `A BIG OK: fetchText returned the whole 2MB body (got ${r.text.length} bytes)`);
    check(
      !lines.some((l) => l.includes("curl spawn failed") || l.includes("curl attempt")),
      `A BIG OK: no failed-curl log lines — curl-first carried it (saw ${lines.length} log lines)`,
    );
  }

  // ------------------------------------------ B: fetchText, small body
  {
    const { value: r, lines } = await capturingStderr(() => fetchText(`${base}/small`, 30_000));
    check(r.ok && r.status === 200, `B SMALL OK: fetchText returned ok status 200 (got ok=${r.ok} status=${r.status})`);
    check(r.text === smallText, `B SMALL OK: fetchText returned the small body whole (got ${JSON.stringify(r.text)})`);
    check(
      !lines.some((l) => l.includes("curl spawn failed") || l.includes("curl attempt")),
      `B SMALL OK: no failed-curl log lines (saw ${lines.length} log lines)`,
    );
  }

  // --------------------------- C: fallback still works (curl broken)
  {
    const shimDir = path.join(WORKDIR, "no-curl");
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, "curl");
    fs.writeFileSync(shim, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(shim, 0o755);
    const savedPath = process.env.PATH ?? "";
    process.env.PATH = shimDir;
    try {
      const { value: r, lines } = await capturingStderr(() => fetchText(`${base}/small`, 30_000));
      check(r.ok && r.status === 200, `C FALLBACK OK: fetchText returned ok status 200 with curl broken (got ok=${r.ok} status=${r.status})`);
      check(r.text === smallText, `C FALLBACK OK: Bun fetch carried the body (got ${JSON.stringify(r.text)})`);
      check(
        lines.some((l) => l.includes("curl attempt 1 failed")),
        `C FALLBACK OK: curl was tried first and logged its failure (saw ${lines.length} log lines)`,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  }

  } finally {
    serverProc.kill();
    await serverProc.exited;
  }

  // ----------------------- D: direct adapter exec, cat a 2MB file
  const cliState = path.join(WORKDIR, "cli-state");
  fs.mkdirSync(cliState, { recursive: true });
  {
    const big = cli([
      "run", path.join(TESTS, "workflow-bra171.ts"),
      "--run-id", "run-bra174-big-exec",
      "--input", JSON.stringify({ filePath: bigFile }),
      "--adapter", "direct", "--state-dir", cliState, "--wait",
    ]);
    let bigOut: any = null;
    try {
      bigOut = JSON.parse(big.out);
    } catch {
      bigOut = null;
    }
    check(big.rc === 0, `D EXEC OK: CLI --wait exited 0 (got ${big.rc}; err: ${big.err.slice(0, 300)})`);
    check(bigOut !== null, `D EXEC OK: CLI printed parseable result JSON (got ${JSON.stringify(big.out).slice(0, 200)})`);
    check(bigOut?.len === expected.len, `D EXEC OK: exec result delivered whole — len ${bigOut?.len} (expected ${expected.len})`);
    check(
      bigOut?.head === expected.head && bigOut?.tail === expected.tail,
      `D EXEC OK: head/tail match (${JSON.stringify(bigOut?.head)} / ${JSON.stringify(bigOut?.tail)})`,
    );
  }

  // ----------------------- E: runHost stdout, 2MB branch outcome
  {
    const fork = cli([
      "run", path.join(TESTS, "workflow-bra174-fork-big.ts"),
      "--run-id", "run-bra174-fork-big",
      "--input", JSON.stringify({ size: BIG_LEN }),
      "--adapter", "direct", "--state-dir", cliState, "--wait",
    ]);
    let forkOut: any = null;
    try {
      forkOut = JSON.parse(fork.out);
    } catch {
      forkOut = null;
    }
    check(fork.rc === 0, `E FORK OK: CLI --wait exited 0 (got ${fork.rc}; err: ${fork.err.slice(0, 300)})`);
    check(forkOut !== null, `E FORK OK: CLI printed parseable result JSON (got ${JSON.stringify(fork.out).slice(0, 200)})`);
    check(
      forkOut?.totalLen === BIG_LEN && forkOut?.parts?.[0]?.length === BIG_LEN,
      `E FORK OK: 2MB branch outcome joined whole (totalLen ${forkOut?.totalLen})`,
    );
  }

  if (FAILURES.length) {
    console.log(`FAILURES: ${FAILURES.length}`);
    return 1;
  }
  console.log("PASS");
  return 0;
}

process.exit(await main());
