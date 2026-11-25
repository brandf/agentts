#!/usr/bin/env bun
/** BRA-214 — exec-trap stdout cap: a large trap result must not crash
 * the C host on resume, and a stale binary must fail loudly instead.
 *
 * The decision (recorded in the code comments and the build report):
 *   1. The 64KB inline threshold is INTENTIONAL (half Linux's 128KB
 *      MAX_ARG_STRLEN) and stays. Below it a trap result travels
 *      inline as argv[3] of the `resume` spawn.
 *   2. At or above it the result goes through a scratch file (the
 *      `agentts-file:<path>` marker, BRA-171). The file path has no
 *      size limit in the C reader — the Nov 20 crash was the stale
 *      Nov 18 binary trying to JSON-parse the marker, not a size
 *      limit in the file path.
 *   3. Source-hash verification, lazily once per Host, only on the
 *      file-backed path: a binary built from different source — or
 *      built without the hash ("unknown") — fails LOUDLY with a
 *      named BRA-214 error, never as a pass, never as a crash.
 *      Small results keep working on an old binary (inline path).
 *   4. New explicit bound on file-backed results: 16MB (100x the
 *      largest known legitimate result — the real-tree manifest is
 *      ~162KB — and the same bound the codebase already uses for
 *      spawn-stdout capture). Above it, a loud named failure before
 *      any file is written or resume spawned.
 *
 * Sizes: Quality's Nov 20 numbers are the boundary seen through JSON
 * escaping — a 59,561 B manifest passes inline, a 64,111 B manifest
 * goes file-backed (its result JSON is ~66.9KB). The flat cases
 * straddle the same 65,536-byte threshold without escaping growth.
 * The 1MB case is the hostile case (far over the old ~60KB crash
 * zone, far under the 16MB bound). The 20MB case is unit-level only:
 * the direct adapter caps exec stdout at 16MB, so an exec trap can
 * never deliver a >16MB result — the bound is reachable only via
 * non-exec trap results, and is tested on resultArg directly.
 *
 * §A inventory check (suite-inventory + run.sh agree)
 * §B agentts check on the fixture workflow
 * §C pure unit checks (constants, version/hash recipe, resultArg
 *     decisions on the Host and the mock plugin, the unset-var mock
 *     fallback case (fix round: the mock's package-dir fallbacks
 *     must resolve with AGENTTS_DURABLETS_DIR unset), checked-in
 *     binary untouched; the stale binary is a fixture — the Nov 18
 *     pre-fix build — never the checked-in binary, which the
 *     post-landing rebuild replaced with a fresh one)
 * §D live runs through the CLI on direct: flat 66,000 (just over),
 *     manifest 64,111 + 59,561 (Quality's exact sizes), flat 162,000
 *     (real-manifest size), flat 1,000,000 (hostile size, must pass);
 *     hostile stale-binary + manifest 64,111 (must fail LOUDLY with
 *     the mismatch, zero SyntaxError lines); cross-shift kill-and-
 *     resume on a sleep-5 exec (the run is stranded "running" after
 *     the kill and completes on the re-drive, the trap running twice).
 *
 * Run: DQUICKTS=$HOME/workspace/dquickts-build-minimal bun tests/test-bra214.ts
 * (under run.sh, DURABLETS_HOST + AGENTTS_DURABLETS_DIR are already
 * set and the test uses the cache binary instead of building one).
 * Env: BRA214_WORKDIR (scratch root; default a mkdtemp under TMPDIR).
 * Exit: 0 PASS, 1 FAIL (check list printed).
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type Subprocess } from "bun";
import {
  Host,
  RESULT_ARG_FILE_PREFIX,
  RESULT_ARG_INLINE_MAX_BYTES,
  RESULT_FILE_MAX_BYTES,
} from "../src/host";
import {
  MockPlugin,
  RESULT_ARG_FILE_PREFIX as MOCK_PREFIX,
  RESULT_ARG_INLINE_MAX_BYTES as MOCK_INLINE,
  RESULT_FILE_MAX_BYTES as MOCK_FILE_MAX,
} from "../plugins/mock/src/mock-plugin";

const ROOT = path.resolve(import.meta.dir, "..");
const BUN = process.execPath;
const PKGDIR = path.resolve(ROOT, "..", "..", "packages", "durablets");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "bra214-large-exec.ts");
// The stale binary is a fixture, not the checked-in binary: the
// checked-in binary was the Nov 18 pre-fix build when this test
// was written, but the post-landing rebuild (decision A) replaced
// it with a fresh one, so a test that treats it as stale fails on
// a fresh tree. The fixture is a byte copy of that Nov 18 build
// (md5 f08e739ab5c486fd990074398e3f4083, sha256
// 6ffbfef1830eed962f29963bab1b1d91aa4ed00a8eb917495de5b4486e28151b —
// recorded here so a replacement is visible; the stale checks
// below prove it is stale on every run: no `version` subcommand,
// and the loud mismatch on any >=64KB result). It is staged into
// WORKDIR and executed from there, so the repo copy is never
// modified and its mode in the tree does not matter.
const STALE_FIXTURE = path.join(ROOT, "tests", "fixtures", "bra214-stale-durablets");
// The checked-in binary: a build artifact, never a claimed file.
// The BINARY OK check proves this test leaves it untouched.
const CHECKED_IN_BIN = path.join(PKGDIR, "out", "durablets");

if (!process.env.TMPDIR) process.env.TMPDIR = path.join(os.homedir(), "tmp", "home-tmp");
const WORKDIR =
  process.env.BRA214_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra214-"));
const STATE_DIR = path.join(WORKDIR, "state");

const FAILURES: string[] = [];
const CHECKS = { total: 0 };
function check(ok: boolean, label: string): void {
  CHECKS.total++;
  if (ok) console.log(`  ok ${CHECKS.total}: ${label}`);
  else {
    FAILURES.push(label);
    console.log(`  FAIL ${CHECKS.total}: ${label}`);
  }
}
function fail(label: string): void {
  check(false, label);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The C host under test: build it from the copy's source when
// DURABLETS_HOST is unset (the BRA-119 pattern); under run.sh it is
// already set to the cache binary built from this source.
let FRESH_BIN = process.env.DURABLETS_HOST ?? "";
function ensureFreshBinary(): void {
  if (FRESH_BIN) {
    check(fs.existsSync(FRESH_BIN), `BUILD OK: DURABLETS_HOST binary exists (${FRESH_BIN})`);
    return;
  }
  const dquickts =
    process.env.DQUICKTS ?? path.join(os.homedir(), "workspace", "dquickts-build-minimal");
  const outDir = path.join(WORKDIR, "host-bin");
  fs.mkdirSync(outDir, { recursive: true });
  const m = spawnSync(
    "make",
    ["-C", PKGDIR, `DQUICKTS=${dquickts}`, `OUT_DIR=${outDir}`, "durablets"],
    { encoding: "utf8" },
  );
  check(
    m.status === 0,
    `BUILD OK: make durablets exits 0 (got ${m.status}: ${(m.stdout + m.stderr).slice(-300)})`,
  );
  FRESH_BIN = path.join(outDir, "durablets");
  process.env.DURABLETS_HOST = FRESH_BIN;
  check(fs.existsSync(FRESH_BIN), `BUILD OK: fresh binary exists at ${FRESH_BIN}`);
}

function cli(
  args: string[],
  envOverride: Record<string, string> = {},
): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, ...envOverride },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

async function startServer(
  stateDir: string,
  port: number,
  envOverride: Record<string, string> = {},
): Promise<Subprocess> {
  const server = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", stateDir, "--port", String(port)],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...envOverride } },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return server;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`bra214 server did not come up on ${port}`);
    await sleep(50);
  }
}
async function stopServer(server: Subprocess | null): Promise<void> {
  if (!server) return;
  try {
    server.kill(9);
  } catch {
    /* already dead */
  }
  await server.exited;
}

/** A JSON string of exactly `target` bytes: {"data":"<x…>"} is 11 bytes
 * of wrapper plus the payload. */
function jsonOfBytes(target: number): string {
  const s = JSON.stringify({ data: "x".repeat(target - 11) });
  if (Buffer.byteLength(s) !== target)
    throw new Error(`jsonOfBytes(${target}) built ${Buffer.byteLength(s)} bytes`);
  return s;
}

type ResultArgOut = { arg: string; cleanup: () => void };
function callResultArg(
  target: Host | MockPlugin,
  runId: string,
  json: string,
): ResultArgOut {
  return (
    target as unknown as { resultArg(runId: string, json: string): ResultArgOut }
  ).resultArg(runId, json);
}
function filePathOf(arg: string): string | null {
  return arg.startsWith(RESULT_ARG_FILE_PREFIX)
    ? arg.slice(RESULT_ARG_FILE_PREFIX.length)
    : null;
}

/** Drive one fixture input to completion through the CLI (submit +
 * queue run + result) on a per-case server + state dir, and return
 * the parsed result JSON. */
async function driveToCompletion(
  name: string,
  input: unknown,
  binary: string,
): Promise<Record<string, any> | null> {
  const caseDir = path.join(WORKDIR, `case-${name}`);
  const sd = path.join(caseDir, "state");
  fs.mkdirSync(sd, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const envOverride = {
    DURABLETS_HOST: binary,
    AGENTTS_DURABLETS_DIR: PKGDIR,
    AGENTTS_WORKER_SERVER: `http://127.0.0.1:${port}`,
  };
  const server = await startServer(sd, port, envOverride);
  try {
    const runId = `run-bra214-${name}`;
    const inputFile = path.join(caseDir, "input.json");
    fs.writeFileSync(inputFile, JSON.stringify(input));
    const sub = cli(
      [
        "run",
        FIXTURE,
        "--run-id",
        runId,
        "--input-file",
        inputFile,
        "--state-dir",
        sd,
        "--adapter",
        "direct",
        "--clock",
        "real",
        "--gates",
        "hold",
      ],
      envOverride,
    );
    check(
      sub.rc === 0,
      `SUBMIT OK: CLI run exits 0 for ${name} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`,
    );
    if (sub.rc !== 0) return null;
    const drive = cli(["queue", "run", "--state-dir", sd, "--gates", "hold"], envOverride);
    check(
      drive.rc === 0,
      `DRIVE OK: queue run exits 0 for ${name} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 300)})`,
    );
    if (drive.rc !== 0) return null;
    const res = cli(["result", runId, "--state-dir", sd], envOverride);
    check(
      res.rc === 0,
      `RESULT OK: result exits 0 for ${name} (got ${res.rc}: ${(res.out + res.err).slice(0, 300)})`,
    );
    if (res.rc !== 0) return null;
    try {
      const parsed = JSON.parse(res.out) as Record<string, any>;
      const fileParsed = JSON.parse(
        fs.readFileSync(path.join(sd, "slices", `${runId}.result.json`), "utf8"),
      ) as Record<string, any>;
      check(
        JSON.stringify(parsed) === JSON.stringify(fileParsed),
        `RESULT OK: cli result matches the result file for ${name}`,
      );
      return parsed;
    } catch {
      fail(`RESULT OK: result for ${name} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
      return null;
    }
  } finally {
    await stopServer(server);
  }
}

async function main(): Promise<number> {
  // Snapshot the checked-in binary before any build: the BINARY OK
  // check at the end of §C compares against this, not the copy
  // manifest — live has no manifest, so reading it here failed the
  // section in the merge's live tier-1 with ENOENT (fix round 2).
  const checkedInBinHashAtStart = createHash("sha256")
    .update(fs.readFileSync(CHECKED_IN_BIN))
    .digest("hex");
  // Stage the stale fixture into WORKDIR and execute it from there:
  // the repo fixture is never modified, and its mode in the tree
  // does not matter (the merge need not preserve the exec bit).
  if (!fs.existsSync(STALE_FIXTURE))
    throw new Error(`bra214 stale fixture missing: ${STALE_FIXTURE}`);
  const STALE_BIN = path.join(WORKDIR, "stale-bin", "durablets");
  fs.mkdirSync(path.dirname(STALE_BIN), { recursive: true });
  fs.copyFileSync(STALE_FIXTURE, STALE_BIN);
  fs.chmodSync(STALE_BIN, 0o755);
  ensureFreshBinary();
  if (process.env.AGENTTS_DURABLETS_DIR === undefined)
    process.env.AGENTTS_DURABLETS_DIR = PKGDIR;

  // One shared server for §A/§B (the inventory + agentts checks).
  const sharedPort = 20000 + Math.floor(Math.random() * 20000);
  process.env.AGENTTS_WORKER_SERVER = `http://127.0.0.1:${sharedPort}`;
  const sharedServer = await startServer(STATE_DIR, sharedPort);
  try {
    // --------------------------------------------- §A inventory check
    console.log("\n=== §A inventory check ===");
    {
      const r = spawnSync(BUN, [path.join(ROOT, "scripts", "suite-inventory.ts"), "check"], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env },
      });
      check(
        r.status === 0,
        `INVENTORY OK: suite-inventory check exits 0 (got ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)})`,
      );
      check(
        /inventory check passed: \d+ sections, run\.sh agrees/.test(r.stdout ?? ""),
        `INVENTORY OK: check prints the agreement line (got ${JSON.stringify((r.stdout ?? "").slice(0, 120))})`,
      );
    }

    // --------------------------------------------- §B agentts check
    console.log("\n=== §B agentts check ===");
    {
      const r = cli(["check", FIXTURE, "--state-dir", STATE_DIR]);
      check(
        r.rc === 0,
        `CHECK OK: agentts check exits 0 on the fixture (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`,
      );
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK`);
      check(
        r.out.includes("largeExec(LargeExecInput)"),
        `CHECK OK: entry is largeExec(LargeExecInput) (got ${JSON.stringify(r.out.slice(0, 160))})`,
      );
    }
  } finally {
    await stopServer(sharedServer);
  }

  // --------------------------------------------- §C pure unit checks
  console.log("\n=== §C pure unit checks ===");
  {
    // Constants: the 64KB inline threshold and the 16MB file-backed
    // bound, and the mock plugin's copies equal the host's (BRA-88).
    check(
      RESULT_ARG_INLINE_MAX_BYTES === 65536,
      `CONST OK: inline threshold is 64KB (got ${RESULT_ARG_INLINE_MAX_BYTES})`,
    );
    check(
      RESULT_FILE_MAX_BYTES === 16 * 1024 * 1024,
      `CONST OK: file-backed bound is 16MB (got ${RESULT_FILE_MAX_BYTES})`,
    );
    check(
      RESULT_ARG_FILE_PREFIX === "agentts-file:",
      `CONST OK: file marker prefix is agentts-file: (got ${RESULT_ARG_FILE_PREFIX})`,
    );
    check(
      MOCK_INLINE === RESULT_ARG_INLINE_MAX_BYTES &&
        MOCK_FILE_MAX === RESULT_FILE_MAX_BYTES &&
        MOCK_PREFIX === RESULT_ARG_FILE_PREFIX,
      `CONST OK: mock plugin's constants match the host's (BRA-88 verbatim copy)`,
    );

    // The version/hash recipe: the fresh binary reports the sha256
    // of (durablets.c ++ durablets.h), computed independently here.
    const expectedHash = createHash("sha256")
      .update(
        Buffer.concat([
          fs.readFileSync(path.join(PKGDIR, "src", "durablets.c")),
          fs.readFileSync(path.join(PKGDIR, "src", "durablets.h")),
        ]),
      )
      .digest("hex");
    const v = spawnSync(FRESH_BIN, ["version"], { encoding: "utf8" });
    check(
      v.status === 0,
      `VERSION OK: fresh binary 'durablets version' exits 0 (got ${v.status})`,
    );
    let reported = "";
    let reportedFeatures: string[] = [];
    try {
      const parsed = JSON.parse(v.stdout) as { sourceHash: string; features: string[] };
      reported = parsed.sourceHash;
      reportedFeatures = parsed.features;
    } catch {
      /* recorded below */
    }
    check(
      reported === expectedHash,
      `VERSION OK: fresh binary reports the source hash (${reported.slice(0, 12)}… == ${expectedHash.slice(0, 12)}…)`,
    );
    check(
      reportedFeatures.includes("result-file"),
      `VERSION OK: fresh binary advertises the result-file feature (got ${JSON.stringify(reportedFeatures)})`,
    );
    const sv = spawnSync(STALE_BIN, ["version"], { encoding: "utf8" });
    check(
      sv.status !== 0,
      `VERSION OK: stale fixture binary has no version subcommand (rc ${sv.status}) — the Nov 18 pre-fix build predates the source hash, so it reports "unknown"`,
    );

    // The checked-in binary is a build artifact, never a claimed
    // file: its hash was snapshotted before any build at the top of
    // main() and must be unchanged after this test.
    const liveHash = createHash("sha256").update(fs.readFileSync(CHECKED_IN_BIN)).digest("hex");
    check(
      liveHash === checkedInBinHashAtStart,
      `BINARY OK: checked-in binary unchanged by this test (still ${liveHash.slice(0, 12)}…)`,
    );

    // Host resultArg: the inline/file decision at the 65,536-byte
    // boundary, the loud mismatch on a stale binary, the loud bound.
    const hostSd = path.join(WORKDIR, "host-unit", "state");
    fs.mkdirSync(hostSd, { recursive: true });
    const freshHost = new Host({ stateDir: hostSd, hostPath: FRESH_BIN });
    const staleHost = new Host({
      stateDir: path.join(WORKDIR, "host-unit-stale", "state"),
      hostPath: STALE_BIN,
    });
    const small = jsonOfBytes(100);
    const r1 = callResultArg(freshHost, "run-bra214-unit", small);
    check(r1.arg === small, `RESULTARG OK: 100 B result stays inline on the fresh host`);
    r1.cleanup();
    const under = jsonOfBytes(65535);
    const r2 = callResultArg(freshHost, "run-bra214-unit", under);
    check(
      r2.arg === under,
      `RESULTARG OK: 65,535 B result stays inline (one byte under the 64KB threshold)`,
    );
    r2.cleanup();
    const at = jsonOfBytes(65536);
    const r3 = callResultArg(freshHost, "run-bra214-unit", at);
    const fp3 = filePathOf(r3.arg);
    check(
      fp3 !== null && fs.existsSync(fp3) && fs.readFileSync(fp3, "utf8") === at,
      `RESULTARG OK: 65,536 B result goes file-backed (the file holds the exact JSON)`,
    );
    r3.cleanup();
    check(
      fp3 !== null && !fs.existsSync(fp3),
      `RESULTARG OK: cleanup removes the file-backed scratch file`,
    );
    const big = jsonOfBytes(70000);
    const r4 = callResultArg(freshHost, "run-bra214-unit", big);
    check(
      filePathOf(r4.arg) !== null,
      `RESULTARG OK: 70,000 B result goes file-backed on the fresh binary (source hash verified)`,
    );
    r4.cleanup();
    let threw = "";
    try {
      callResultArg(staleHost, "run-bra214-unit", big);
    } catch (e) {
      threw = (e as Error).message;
    }
    check(
      /BRA-214 engine source-hash mismatch/.test(threw) && /reports sourceHash null/.test(threw),
      `RESULTARG OK: stale binary + 70,000 B throws the loud mismatch (got ${JSON.stringify(threw.slice(0, 120))})`,
    );
    const r5 = callResultArg(staleHost, "run-bra214-unit", small);
    check(
      r5.arg === small,
      `RESULTARG OK: small result stays inline on the stale binary too (the inline path needs no verification)`,
    );
    r5.cleanup();
    const over = jsonOfBytes(20 * 1024 * 1024);
    let threwBound = "";
    try {
      callResultArg(freshHost, "run-bra214-unit", over);
    } catch (e) {
      threwBound = (e as Error).message;
    }
    check(
      /BRA-214 trap result of \d+ bytes exceeds the file-backed result bound of 16777216 bytes/.test(
        threwBound,
      ),
      `RESULTARG OK: 20MB result throws the loud bound error naming 16,777,216 (got ${JSON.stringify(threwBound.slice(0, 140))})`,
    );

    // Mock plugin: the same battery (its resultArg is a verbatim
    // copy of the host's, per BRA-88).
    const mockBase = path.join(WORKDIR, "mock-unit");
    fs.mkdirSync(path.join(mockBase, "fresh"), { recursive: true });
    fs.mkdirSync(path.join(mockBase, "stale"), { recursive: true });
    const freshMock = new MockPlugin({
      workdir: path.join(mockBase, "fresh"),
      hostPath: FRESH_BIN,
    });
    const staleMock = new MockPlugin({
      workdir: path.join(mockBase, "stale"),
      hostPath: STALE_BIN,
    });
    const m1 = callResultArg(freshMock, "run-bra214-unit", small);
    check(m1.arg === small, `MOCK OK: 100 B result stays inline on the fresh mock host`);
    m1.cleanup();
    const m2 = callResultArg(freshMock, "run-bra214-unit", big);
    check(
      filePathOf(m2.arg) !== null,
      `MOCK OK: 70,000 B result goes file-backed on the fresh mock host`,
    );
    m2.cleanup();
    let mThrew = "";
    try {
      callResultArg(staleMock, "run-bra214-unit", big);
    } catch (e) {
      mThrew = (e as Error).message;
    }
    check(
      /BRA-214 engine source-hash mismatch/.test(mThrew),
      `MOCK OK: stale binary + 70,000 B throws the loud mismatch on the mock host`,
    );
    let mThrewBound = "";
    try {
      callResultArg(freshMock, "run-bra214-unit", over);
    } catch (e) {
      mThrewBound = (e as Error).message;
    }
    check(
      /exceeds the file-backed result bound of 16777216 bytes/.test(mThrewBound),
      `MOCK OK: 20MB result throws the loud bound error on the mock host`,
    );

    // Regression (BRA-214 fix round): the mock plugin's
    // durabletsPackageDirs() fallbacks must resolve to the real
    // package dir when AGENTTS_DURABLETS_DIR is unset. The
    // original port was two levels short (plugins/mock/src vs
    // src), so engineSourceHash() returned "unknown" and a fresh
    // binary failed with a FALSE mismatch on any >=64KB result.
    // run.sh sets the var, so only an unset-var case exercises
    // the fallbacks.
    {
      const savedDir = process.env.AGENTTS_DURABLETS_DIR;
      delete process.env.AGENTTS_DURABLETS_DIR;
      try {
        fs.mkdirSync(path.join(mockBase, "no-var"), { recursive: true });
        const noVarMock = new MockPlugin({
          workdir: path.join(mockBase, "no-var"),
          hostPath: FRESH_BIN,
        });
        let noVarThrew = "";
        let noVarArg: ResultArgOut | null = null;
        try {
          noVarArg = callResultArg(noVarMock, "run-bra214-unit", big);
        } catch (e) {
          noVarThrew = (e as Error).message;
        }
        check(
          noVarThrew === "" && noVarArg !== null && filePathOf(noVarArg.arg) !== null,
          `MOCK OK: unset AGENTTS_DURABLETS_DIR + 70,000 B goes file-backed on the fresh mock host (fallbacks resolve; threw ${JSON.stringify(noVarThrew.slice(0, 120))})`,
        );
        if (noVarArg) {
          const fpNoVar = filePathOf(noVarArg.arg);
          check(
            fpNoVar !== null && fs.existsSync(fpNoVar) && fs.readFileSync(fpNoVar, "utf8") === big,
            `MOCK OK: unset-var file-backed scratch file holds the exact JSON`,
          );
          noVarArg.cleanup();
        }
      } finally {
        if (savedDir !== undefined) process.env.AGENTTS_DURABLETS_DIR = savedDir;
        else delete process.env.AGENTTS_DURABLETS_DIR;
      }
    }
  }

  // --------------------------------------------- §D live runs
  console.log("\n=== §D live runs ===");
  {
    // Just over the threshold, flat shape (no escaping growth).
    const d1 = await driveToCompletion("flat-66000", { bytes: 66000, shape: "flat" }, FRESH_BIN);
    if (d1) check(d1.stdoutLen === 66000, `D1 OK: flat 66,000 B completes (stdoutLen ${d1.stdoutLen})`);
    // Quality's exact crashing size, manifest shape.
    const d2 = await driveToCompletion(
      "manifest-64111",
      { bytes: 64111, shape: "manifest" },
      FRESH_BIN,
    );
    if (d2) check(d2.stdoutLen === 64111, `D2 OK: manifest 64,111 B completes (stdoutLen ${d2.stdoutLen})`);
    // Quality's exact passing size, manifest shape.
    const d3 = await driveToCompletion(
      "manifest-59561",
      { bytes: 59561, shape: "manifest" },
      FRESH_BIN,
    );
    if (d3) check(d3.stdoutLen === 59561, `D3 OK: manifest 59,561 B completes (stdoutLen ${d3.stdoutLen})`);
    // The real-tree manifest size.
    const d4 = await driveToCompletion("flat-162000", { bytes: 162000, shape: "flat" }, FRESH_BIN);
    if (d4) check(d4.stdoutLen === 162000, `D4 OK: flat 162,000 B completes (stdoutLen ${d4.stdoutLen})`);
    // Hostile size: far over the old ~60KB crash zone, far under
    // the 16MB bound — must complete, never crash.
    const d5 = await driveToCompletion(
      "flat-1000000",
      { bytes: 1000000, shape: "flat" },
      FRESH_BIN,
    );
    if (d5) check(d5.stdoutLen === 1000000, `D5 OK: flat 1,000,000 B completes (stdoutLen ${d5.stdoutLen})`);

    // Hostile: Quality's crashing size on the STALE binary. Must fail
    // LOUDLY with the named mismatch — never a host crash, never a
    // SyntaxError.
    {
      const name = "hostile-stale";
      const caseDir = path.join(WORKDIR, `case-${name}`);
      const sd = path.join(caseDir, "state");
      fs.mkdirSync(sd, { recursive: true });
      const port = 20000 + Math.floor(Math.random() * 20000);
      const envOverride = {
        DURABLETS_HOST: STALE_BIN,
        AGENTTS_DURABLETS_DIR: PKGDIR,
        AGENTTS_WORKER_SERVER: `http://127.0.0.1:${port}`,
      };
      const server = await startServer(sd, port, envOverride);
      try {
        const runId = `run-bra214-${name}`;
        const inputFile = path.join(caseDir, "input.json");
        fs.writeFileSync(inputFile, JSON.stringify({ bytes: 64111, shape: "manifest" }));
        const sub = cli(
          [
            "run",
            FIXTURE,
            "--run-id",
            runId,
            "--input-file",
            inputFile,
            "--state-dir",
            sd,
            "--adapter",
            "direct",
            "--clock",
            "real",
            "--gates",
            "hold",
          ],
          envOverride,
        );
        check(sub.rc === 0, `D6 SUBMIT OK: stale-binary case submits (got ${sub.rc})`);
        const drive = cli(["queue", "run", "--state-dir", sd, "--gates", "hold"], envOverride);
        check(
          drive.rc !== 0,
          `D6 DRIVE OK: queue run FAILS on the stale binary (got rc ${drive.rc})`,
        );
        const driveText = drive.out + drive.err;
        check(
          /BRA-214 engine source-hash mismatch/.test(driveText),
          `D6 OK: the failure names the BRA-214 source-hash mismatch (got ${JSON.stringify(driveText.slice(0, 160))})`,
        );
        const logText = fs.readFileSync(path.join(sd, "slices", `${runId}.log`), "utf8");
        const syntaxErrors = (logText.match(/SyntaxError/g) ?? []).length;
        check(
          syntaxErrors === 0,
          `D6 OK: zero SyntaxError lines in the slice log (the old crash shape is gone; got ${syntaxErrors})`,
        );
        const q = JSON.parse(fs.readFileSync(path.join(sd, "queue.json"), "utf8")) as Array<{
          runId: string;
          status: string;
        }>;
        const entry = q.find((e) => e.runId === runId);
        check(
          entry?.status === "failed",
          `D6 OK: the run is recorded failed, not crashed mid-state (got ${entry?.status})`,
        );
      } finally {
        await stopServer(server);
      }
    }

    // Cross-shift: kill the driver mid-exec (sleep 5), then re-drive.
    // The run is stranded "running" after the kill and completes on
    // the re-drive, the trap running twice.
    {
      const name = "kill-resume";
      const caseDir = path.join(WORKDIR, `case-${name}`);
      const sd = path.join(caseDir, "state");
      fs.mkdirSync(sd, { recursive: true });
      const port = 20000 + Math.floor(Math.random() * 20000);
      const envOverride = {
        DURABLETS_HOST: FRESH_BIN,
        AGENTTS_DURABLETS_DIR: PKGDIR,
        AGENTTS_WORKER_SERVER: `http://127.0.0.1:${port}`,
      };
      const server = await startServer(sd, port, envOverride);
      try {
        const runId = `run-bra214-${name}`;
        const inputFile = path.join(caseDir, "input.json");
        fs.writeFileSync(
          inputFile,
          JSON.stringify({ bytes: 70000, shape: "flat", sleepSec: 5 }),
        );
        const sub = cli(
          [
            "run",
            FIXTURE,
            "--run-id",
            runId,
            "--input-file",
            inputFile,
            "--state-dir",
            sd,
            "--adapter",
            "direct",
            "--clock",
            "real",
            "--gates",
            "hold",
          ],
          envOverride,
        );
        check(sub.rc === 0, `D7 SUBMIT OK: kill-resume case submits (got ${sub.rc})`);
        // Background queue run, detached: its own process group, so
        // the kill takes the C host and the sleeping exec with it.
        const outFd = fs.openSync(path.join(caseDir, "queue-run-1.out"), "w");
        const errFd = fs.openSync(path.join(caseDir, "queue-run-1.err"), "w");
        const child = nodeSpawn(
          BUN,
          [path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", sd, "--gates", "hold"],
          {
            detached: true,
            cwd: ROOT,
            env: { ...process.env, ...envOverride },
            stdio: ["ignore", outFd, errFd],
          },
        );
        // Wait for the trap to suspend (the journal records it),
        // then kill mid-exec: the exec is still in its 5 s sleep.
        const journal = path.join(sd, "journals", `${runId}.journal`);
        const deadline = Date.now() + 15_000;
        let trapped = false;
        while (Date.now() < deadline) {
          try {
            const text = fs.readFileSync(journal, "utf8");
            if (text.includes(`"event":"trap"`) && text.includes(`${runId}/trap-0`)) {
              trapped = true;
              break;
            }
          } catch {
            /* journal not written yet */
          }
          await sleep(100);
        }
        check(trapped, `D7 KILL OK: the exec trap suspended (journal holds the trap-0 row) before the kill`);
        await sleep(1000);
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        const killed = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 10_000);
          child.on("exit", (code, signal) => {
            clearTimeout(t);
            resolve(signal === "SIGKILL" || (code !== null && code !== 0));
          });
        });
        check(killed, `D7 KILL OK: the driver died by the kill`);
        const q = JSON.parse(fs.readFileSync(path.join(sd, "queue.json"), "utf8")) as Array<{
          runId: string;
          status: string;
        }>;
        const entry = q.find((e) => e.runId === runId);
        check(
          entry?.status === "running",
          `D7 KILL OK: the run is stranded as "running" after the kill (got ${entry?.status})`,
        );
        const redrive = cli(["queue", "run", "--state-dir", sd, "--gates", "hold"], envOverride);
        check(
          redrive.rc === 0,
          `D7 RESUME OK: the re-drive exits 0 (got ${redrive.rc}: ${(redrive.out + redrive.err).slice(0, 300)})`,
        );
        const res = cli(["result", runId, "--state-dir", sd], envOverride);
        let parsed: Record<string, any> | null = null;
        try {
          parsed = JSON.parse(res.out) as Record<string, any>;
        } catch {
          /* recorded below */
        }
        check(
          parsed?.stdoutLen === 70000,
          `D7 RESUME OK: the resumed run completes with stdoutLen 70000 (got ${JSON.stringify(parsed)})`,
        );
        const journalText = fs.readFileSync(journal, "utf8");
        const dispatchRows = journalText
          .split("\n")
          .filter((l) => l.includes(`"event":"trap-dispatch"`) && l.includes(`${runId}/trap-0`))
          .length;
        check(
          dispatchRows >= 2,
          `D7 RESUME OK: the exec trap was dispatched twice across the kill (journal holds ${dispatchRows} trap-dispatch rows for trap-0)`,
        );
        check(
          journalText.includes(`"event":"queue-repaired"`),
          `D7 RESUME OK: the journal records the repair of the stranded entry (queue-repaired)`,
        );
        const logText = fs.readFileSync(path.join(sd, "slices", `${runId}.log`), "utf8");
        check(
          !logText.includes("SyntaxError"),
          `D7 RESUME OK: no SyntaxError anywhere in the resumed run's slice log`,
        );
      } finally {
        await stopServer(server);
      }
    }
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA214 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    `PASS bra214 large trap result (inventory check, agentts check, pure unit checks, live runs incl. hostile stale-binary + cross-shift kill-and-resume — ${CHECKS.total} checks)`,
  );
  return 0;
}

process.exit(await main());
