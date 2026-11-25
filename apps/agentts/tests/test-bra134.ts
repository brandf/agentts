#!/usr/bin/env bun
/** BRA-134 — `agentts snapshot convert`: convert a suspended run's
 * snapshot from one dquickts engine build to another by
 * strip-and-recompile, then rewrite the state dir under the new
 * engine version + format identity, so the run resumes under the new
 * engine with the same result.
 *
 * Engines (BRA-115 artifacts, the brief's named source):
 *   old engine: ~/workspace/bra115/host-old/durablets +
 *     ~/workspace/dquickts-build-minimal (pin 96a9a79, BC_VERSION 7)
 *   new engine: ~/workspace/bra115/host-new/durablets +
 *     ~/workspace/dquickts-build-bra115 (pin fa5fe79, BC_VERSION 8,
 *     OP_push_false/OP_push_true swapped)
 *   new-sig snapshot: ~/workspace/bra115/state-new-sig (suspended
 *     under the new engine; supplies the new build signature +
 *     class table)
 *
 * §A inventory check (suite-inventory + run.sh agree)
 * §B agentts check on the probe workflow
 * §C pure unit checks (roundtrip byte-identity on the real suspended
 *     snapshots, opcode-table swap, target-engine version/identity
 *     computation, byte conversion of state-orig2's blob)
 * §D live runs: the e2e (fresh suspended run under the old engine,
 *     control resumes RIGHT/7 under the old engine, the copy converts
 *     via the CLI and resumes RIGHT/7 — identical — under the new
 *     engine, the unconverted copy is refused by the BRA-132 format
 *     gate under the new engine); the already-converted case
 *     (state-new-sig, plus the stale-record variant); the 7-case
 *     fault matrix (each exit 2, no output, no state touched).
 *
 * The unconverted-resume discriminator: BRA-132's format-identity
 * gate refuses the resume outright (the probe docstring's "WRONG"
 * verdict predates BRA-132 — the engine never executes the
 * unconverted code, it refuses before the first instruction). The
 * converter doing the work is proved by the converted copy resuming
 * RIGHT/7 where the unconverted copy is refused.
 *
 * State dirs are always ABSOLUTE paths: the Host double-joins a
 * relative state dir on resume (frozen-copy-missing). Fixtures are
 * always COPIED to scratch first — never convert in place under
 * ~/workspace/bra115.
 *
 * Run: DQUICKTS=$HOME/workspace/dquickts-build-minimal bun tests/test-bra134.ts
 * (under run.sh, DURABLETS_HOST + AGENTTS_DURABLETS_DIR are already
 * set and the test overrides them per phase with the BRA-115 engines).
 * Env: BRA134_WORKDIR (scratch root; default a mkdtemp under TMPDIR).
 * Exit: 0 PASS, 1 FAIL (check list printed).
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type Subprocess } from "bun";
import { Host } from "../src/host";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";
import {
  ConvertRefusalError,
  buildCompileHelper,
  computeTargetEngine,
  convertSnapshotBytes,
  emitSnapshot,
  encodeFrameBody,
  parseFrameBody,
  parseOpcodeTable,
  parseSnapshotBytes,
  readTargetPin,
} from "../src/snapshot-convert";
import { formatIdentityFor } from "../src/host";

const ROOT = path.resolve(import.meta.dir, "..");
const BUN = process.execPath;
const PROBE = path.join(ROOT, "tests", "workflows", "workflow-bra115-probe.ts");
const PKGDIR = path.resolve(ROOT, "..", "..", "packages", "durablets");

const BRA115 = path.join(os.homedir(), "workspace", "bra115");
const OLD_HOST = path.join(BRA115, "host-old", "durablets");
const NEW_HOST = path.join(BRA115, "host-new", "durablets");
const OLD_TREE = path.join(os.homedir(), "workspace", "dquickts-build-minimal");
const NEW_TREE = path.join(os.homedir(), "workspace", "dquickts-build-bra115");
const NEW_SIG_SNAP = path.join(BRA115, "state-new-sig", "blobs", "bra115-probe.snap");
const ORIG2_SNAP = path.join(BRA115, "state-orig2", "blobs", "bra115-probe.snap");
const FAULTS = path.join(BRA115, "faults");
const RUN_ID = "bra115-probe";

if (!process.env.TMPDIR) process.env.TMPDIR = path.join(os.homedir(), "tmp", "home-tmp");
const WORKDIR =
  process.env.BRA134_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra134-"));
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    if (Date.now() > deadline) throw new Error(`bra134 server did not come up on ${port}`);
    await sleep(50);
  }
}

async function stopServer(server: Subprocess | null): Promise<void> {
  if (!server) return;
  server.kill();
  try {
    await server.exited;
  } catch {
    /* already gone */
  }
}

/** sha256 of every file under dir, sorted by relative path. */
function hashTree(dir: string): string {
  const entries: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else entries.push(`${path.relative(dir, p)}:${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return entries.join("\n");
}

function copyTree(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

/** Set the engine env for a Host phase (the Host reads both at construction). */
function setEngine(hostBin: string, tree: string): void {
  process.env.DURABLETS_HOST = hostBin;
  process.env.DQUICKTS = tree;
}

/** Start a fresh suspended probe run under the given engine. Expects rc 2. */
async function startSuspendedRun(stateDir: string, runId: string): Promise<void> {
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  host.submit(PROBE, { runId });
  const rc = await host.startRun(PROBE, runId);
  check(rc === 2, `D START OK: probe suspends under the engine (rc ${rc})`);
}

/** Resume a state dir under the given engine; returns the run result. */
async function resumeRun(
  stateDir: string,
  runId: string,
): Promise<{ status: string; output?: unknown; error?: string }> {
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  await host.runQueue();
  const r = host.result(runId) as { status: string; output?: unknown; error?: string };
  return r;
}

function convertCli(stateDir: string, runId: string, newSigSnap: string = NEW_SIG_SNAP): { rc: number; out: string; err: string } {
  return cli([
    "snapshot", "convert",
    "--state-dir", stateDir,
    "--run-id", runId,
    "--dquickts", NEW_TREE,
    "--new-sig-snap", newSigSnap,
  ]);
}

async function main(): Promise<number> {
  // Fixtures: the BRA-115 artifacts the brief names as the source.
  for (const [p, what] of [
    [OLD_HOST, "old engine binary"],
    [NEW_HOST, "new engine binary"],
    [path.join(OLD_TREE, "libquickjs.a"), "old engine libquickjs.a"],
    [path.join(NEW_TREE, "libquickjs.a"), "new engine libquickjs.a"],
    [path.join(NEW_TREE, "quickjs-opcode.h"), "new engine opcode table"],
    [NEW_SIG_SNAP, "new-sig snapshot"],
    [ORIG2_SNAP, "state-orig2 suspended snapshot"],
    [path.join(FAULTS, "eval"), "eval fault fixture"],
    [path.join(FAULTS, "sameline"), "sameline fault fixture"],
    [PROBE, "probe workflow"],
  ] as const) {
    check(fs.existsSync(p), `FIXTURE OK: ${what} exists (${p})`);
  }
  if (FAILURES.length) {
    console.log(`BRA134 FAIL: missing fixtures — cannot run`);
    return 1;
  }

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
      const r = cli(["check", PROBE, "--state-dir", STATE_DIR]);
      check(
        r.rc === 0,
        `CHECK OK: agentts check exits 0 on the probe (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`,
      );
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK`);
      check(
        r.out.includes("run(no input): ProbeOutput"),
        `CHECK OK: entry is run(no input): ProbeOutput (got ${JSON.stringify(r.out.slice(0, 160))})`,
      );
    }
  } finally {
    await stopServer(sharedServer);
  }

  // --------------------------------------------- §C pure unit checks
  console.log("\n=== §C pure unit checks ===");
  {
    // Roundtrip byte-identity on the real suspended snapshots.
    for (const [name, snapPath] of [
      ["state-orig2", ORIG2_SNAP],
      ["state-new-sig", NEW_SIG_SNAP],
    ] as const) {
      const raw = fs.readFileSync(snapPath);
      const snap = parseSnapshotBytes(raw);
      const out = emitSnapshot(snap);
      check(
        out.equals(raw),
        `ROUNDTRIP OK: parse -> emit is byte-identical for ${name} (${raw.length} bytes, ${snap.cells.length} cells, sig=0x${snap.sig.toString(16)})`,
      );
    }

    // Opcode-table swap: the new engine swaps push_false/push_true.
    const oldTable = parseOpcodeTable(path.join(OLD_TREE, "quickjs-opcode.h"));
    const newTable = parseOpcodeTable(path.join(NEW_TREE, "quickjs-opcode.h"));
    const oldFalse = oldTable.findIndex((d) => d.name === "push_false");
    const oldTrue = oldTable.findIndex((d) => d.name === "push_true");
    const newFalse = newTable.findIndex((d) => d.name === "push_false");
    const newTrue = newTable.findIndex((d) => d.name === "push_true");
    check(
      oldFalse >= 0 && oldTrue >= 0 && newFalse === oldTrue && newTrue === oldFalse,
      `OPCODE OK: new engine swaps push_false/push_true (old false=${oldFalse} true=${oldTrue}, new false=${newFalse} true=${newTrue})`,
    );

    // Target-engine computation: version + identity from the tree +
    // durablets.c, matching the host's own recipe independently here.
    const newSig = parseSnapshotBytes(fs.readFileSync(NEW_SIG_SNAP)).sig;
    const target = computeTargetEngine(NEW_TREE, path.join(PKGDIR, "src", "durablets.c"), newSig);
    const expectedHash = createHash("sha256")
      .update(fs.readFileSync(path.join(PKGDIR, "src", "durablets.c")))
      .digest("hex")
      .slice(0, 16);
    const expectedPin = readTargetPin(NEW_TREE);
    check(
      target.version === `dquickts-${expectedPin}+durablets-${expectedHash}`,
      `ENGINE OK: computed new version is ${target.version}`,
    );
    check(
      target.formatIdentity === formatIdentityFor(newSig, expectedPin, target.natives),
      `ENGINE OK: format identity is ${target.formatIdentity}`,
    );
    check(
      target.formatIdentity.startsWith(`snapfmt-${newSig.toString(16)}:${expectedPin}:`),
      `ENGINE OK: identity carries the new signature + pin`,
    );

    // Refusal type: a converter refusal is an Error carrying the message.
    const refusal = new ConvertRefusalError("probe refusal");
    check(
      refusal instanceof Error && refusal.message === "probe refusal",
      `REFUSAL OK: ConvertRefusalError is an Error carrying its message`,
    );

    // Byte conversion of state-orig2's real suspended snapshot (no
    // state dir): 13 cells, 3 frames, 0 atoms appended, new signature.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bra134-c-"));
    try {
      const helper = buildCompileHelper(NEW_TREE, workDir);
      const res = convertSnapshotBytes({
        oldBytes: fs.readFileSync(ORIG2_SNAP),
        newSigBytes: fs.readFileSync(NEW_SIG_SNAP),
        helperPath: helper,
        opcodeTablePath: path.join(NEW_TREE, "quickjs-opcode.h"),
        stateDir: path.join(BRA115, "state-orig2"),
        workDir,
      });
      check(res.newSignature === newSig, `CONVERT OK: converted sig is the new engine's (0x${res.newSignature.toString(16)})`);
      check(res.convertedCells === 13, `CONVERT OK: 13 bytecode cells converted (got ${res.convertedCells})`);
      check(res.framesRemapped === 3, `CONVERT OK: 3 frames remapped (got ${res.framesRemapped})`);
      check(res.atomsAppended === 0, `CONVERT OK: 0 atoms appended (got ${res.atomsAppended})`);
      const converted = parseSnapshotBytes(res.bytes);
      check(converted.sig === newSig, `CONVERT OK: converted snapshot parses with the new signature`);
      let pcsInBounds = true;
      for (const [, , body] of converted.frameCells()) {
        const fr = parseFrameBody(body, converted.atomsObj);
        if (!fr.isCompleted && fr.pc !== null) {
          const fn = converted.funcInfo(fr.bytecode!);
          if (fr.pc > fn.byteCodeLen) pcsInBounds = false;
        }
      }
      check(pcsInBounds, `CONVERT OK: every remapped frame pc is within its function's code`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------- §D live runs
  console.log("\n=== §D live runs ===");
  {
    // --- D1 e2e: fresh suspended run, control vs converted vs unconverted.
    const e2e = path.join(WORKDIR, "e2e");
    fs.mkdirSync(e2e, { recursive: true });
    setEngine(OLD_HOST, OLD_TREE);
    await startSuspendedRun(path.join(e2e, "state-old"), RUN_ID);
    const baseHash = hashTree(path.join(e2e, "state-old"));
    copyTree(path.join(e2e, "state-old"), path.join(e2e, "state-control"));
    copyTree(path.join(e2e, "state-old"), path.join(e2e, "state-convert"));
    copyTree(path.join(e2e, "state-old"), path.join(e2e, "state-unconverted"));
    check(
      hashTree(path.join(e2e, "state-control")) === baseHash,
      `D1 COPY OK: the three copies are byte-identical to the fresh suspended run`,
    );

    // Control: resume under the OLD engine -> RIGHT/7.
    setEngine(OLD_HOST, OLD_TREE);
    const control = await resumeRun(path.join(e2e, "state-control"), RUN_ID);
    check(
      control.status === "done" &&
        (control.output as { verdict?: string; total?: number })?.verdict === "RIGHT" &&
        (control.output as { verdict?: string; total?: number })?.total === 7,
      `D1 CONTROL OK: unconverted run resumes under the old engine with {"verdict":"RIGHT","total":7} (got ${JSON.stringify(control)})`,
    );

    // Convert the copy via the CLI.
    const conv = convertCli(path.join(e2e, "state-convert"), RUN_ID);
    check(conv.rc === 0, `D1 CONVERT OK: CLI exits 0 (got ${conv.rc}: ${(conv.out + conv.err).slice(0, 200)})`);
    check(conv.out.includes("CONVERT OK"), `D1 CONVERT OK: CLI prints CONVERT OK`);
    check(conv.out.includes("13 bytecode cells"), `D1 CONVERT OK: 13 bytecode cells converted`);
    check(conv.out.includes("3 frames remapped"), `D1 CONVERT OK: 3 frames remapped`);

    // Surgery: manifest, registry, queue, keyframe files.
    const ckpt = JSON.parse(
      fs.readFileSync(path.join(e2e, "state-convert", "blobs", `${RUN_ID}.checkpoint.json`), "utf8"),
    ) as { keyframeHash: string; baseSize: number; kind: string };
    const newBlob = fs.readFileSync(path.join(e2e, "state-convert", "blobs", `${RUN_ID}.snap`));
    check(
      ckpt.keyframeHash === createHash("sha256").update(newBlob).digest("hex"),
      `D1 SURGERY OK: manifest keyframeHash is the sha256 of the converted blob`,
    );
    check(ckpt.baseSize === newBlob.length, `D1 SURGERY OK: manifest baseSize is the converted length (${newBlob.length})`);
    check(ckpt.kind === "base", `D1 SURGERY OK: manifest kind stays base`);
    const oldKeyHash = JSON.parse(
      fs.readFileSync(path.join(e2e, "state-old", "blobs", `${RUN_ID}.checkpoint.json`), "utf8"),
    ).keyframeHash as string;
    check(
      !fs.existsSync(path.join(e2e, "state-convert", "blobs", "keyframes", `${oldKeyHash}.snap`)),
      `D1 SURGERY OK: old keyframe file is deleted`,
    );
    check(
      fs.existsSync(path.join(e2e, "state-convert", "blobs", "keyframes", `${ckpt.keyframeHash}.snap`)),
      `D1 SURGERY OK: new keyframe file exists under the new hash`,
    );
    const reg = JSON.parse(
      fs.readFileSync(path.join(e2e, "state-convert", "runs", `${RUN_ID}.json`), "utf8"),
    ) as { engineVersion?: string; formatIdentity?: string };
    const queue = JSON.parse(
      fs.readFileSync(path.join(e2e, "state-convert", "queue.json"), "utf8"),
    ) as Array<{ runId: string; engineVersion?: string; formatIdentity?: string }>;
    const qEntry = queue.find((e) => e.runId === RUN_ID)!;
    const newSig = parseSnapshotBytes(fs.readFileSync(NEW_SIG_SNAP)).sig;
    const target = computeTargetEngine(NEW_TREE, path.join(PKGDIR, "src", "durablets.c"), newSig);
    check(reg.engineVersion === target.version, `D1 SURGERY OK: registry engineVersion is ${target.version}`);
    check(reg.formatIdentity === target.formatIdentity, `D1 SURGERY OK: registry formatIdentity is ${target.formatIdentity}`);
    check(qEntry.engineVersion === target.version, `D1 SURGERY OK: queue engineVersion is ${target.version}`);
    check(qEntry.formatIdentity === target.formatIdentity, `D1 SURGERY OK: queue formatIdentity is ${target.formatIdentity}`);

    // Converted: resume under the NEW engine -> RIGHT/7, identical.
    setEngine(NEW_HOST, NEW_TREE);
    const converted = await resumeRun(path.join(e2e, "state-convert"), RUN_ID);
    check(
      converted.status === "done" &&
        (converted.output as { verdict?: string; total?: number })?.verdict === "RIGHT" &&
        (converted.output as { verdict?: string; total?: number })?.total === 7,
      `D1 E2E OK: converted run resumes under the new engine with {"verdict":"RIGHT","total":7} (got ${JSON.stringify(converted)})`,
    );
    check(
      JSON.stringify(converted.output) === JSON.stringify(control.output),
      `D1 E2E OK: converted result is IDENTICAL to the pre-conversion result`,
    );

    // Unconverted: refused by the BRA-132 format gate under the new engine.
    const unconverted = await resumeRun(path.join(e2e, "state-unconverted"), RUN_ID);
    check(
      unconverted.status === "failed" &&
        typeof unconverted.error === "string" &&
        unconverted.error.includes("snapshot format") &&
        unconverted.error.includes("refusing to resume"),
      `D1 GATE OK: unconverted run is refused under the new engine (format mismatch, got ${JSON.stringify((unconverted.error ?? "").slice(0, 160))})`,
    );

    // --- D2 already-converted: state-new-sig converts to itself.
    // Its record is stale (Nov 19 durablets.c hash) against the
    // current durablets.c, so the first convert fixes the record
    // while leaving the snapshot bytes untouched; a second convert
    // then finds everything matching and touches nothing at all.
    const alreadyDir = path.join(WORKDIR, "already");
    copyTree(path.join(BRA115, "state-new-sig"), alreadyDir);
    const alreadySnapBefore = hashTree(path.join(alreadyDir, "blobs"));
    const already = convertCli(alreadyDir, RUN_ID);
    check(already.rc === 0, `D2 ALREADY OK: CLI exits 0 (got ${already.rc})`);
    check(already.out.includes("ALREADY CONVERTED"), `D2 ALREADY OK: CLI prints ALREADY CONVERTED (got ${JSON.stringify(already.out.slice(0, 160))})`);
    check(already.out.includes("record updated"), `D2 ALREADY OK: the first convert names the stale-record update`);
    check(
      hashTree(path.join(alreadyDir, "blobs")) === alreadySnapBefore,
      `D2 ALREADY OK: the snapshot bytes are untouched (blobs/ byte-identical)`,
    );
    const alreadyReg = JSON.parse(
      fs.readFileSync(path.join(alreadyDir, "runs", `${RUN_ID}.json`), "utf8"),
    ) as { engineVersion?: string; formatIdentity?: string };
    check(alreadyReg.engineVersion === target.version, `D2 ALREADY OK: the registry engineVersion is fixed to ${target.version}`);
    check(alreadyReg.formatIdentity === target.formatIdentity, `D2 ALREADY OK: the registry formatIdentity is fixed`);
    const alreadyBefore2 = hashTree(alreadyDir);
    const already2 = convertCli(alreadyDir, RUN_ID);
    check(already2.rc === 0 && already2.out.includes("ALREADY CONVERTED"), `D2 ALREADY2 OK: second convert still reports already-converted (rc ${already2.rc})`);
    check(!already2.out.includes("record updated"), `D2 ALREADY2 OK: the second convert reports no record update`);
    check(
      hashTree(alreadyDir) === alreadyBefore2,
      `D2 ALREADY2 OK: the state dir is byte-identical after the second already-converted convert`,
    );

    // Stale-record variant: the record says the old version, the
    // snapshot is already new-engine — the record is fixed, the
    // snapshot bytes are untouched.
    const staleDir = path.join(WORKDIR, "already-stale");
    copyTree(path.join(BRA115, "state-new-sig"), staleDir);
    const staleBlobBefore = createHash("sha256")
      .update(fs.readFileSync(path.join(staleDir, "blobs", `${RUN_ID}.snap`)))
      .digest("hex");
    const staleRegPath = path.join(staleDir, "runs", `${RUN_ID}.json`);
    const staleReg = JSON.parse(fs.readFileSync(staleRegPath, "utf8")) as Record<string, unknown>;
    staleReg["engineVersion"] = "dquickts-96a9a79+durablets-0000000000000000";
    delete staleReg["formatIdentity"];
    fs.writeFileSync(staleRegPath, JSON.stringify(staleReg, null, 2));
    const stale = convertCli(staleDir, RUN_ID);
    check(stale.rc === 0 && stale.out.includes("ALREADY CONVERTED"), `D2 STALE OK: stale-record convert reports already-converted (rc ${stale.rc})`);
    check(stale.out.includes("record updated"), `D2 STALE OK: the report names the record update`);
    const staleBlobAfter = createHash("sha256")
      .update(fs.readFileSync(path.join(staleDir, "blobs", `${RUN_ID}.snap`)))
      .digest("hex");
    check(staleBlobAfter === staleBlobBefore, `D2 STALE OK: the snapshot bytes are untouched`);
    const staleRegAfter = JSON.parse(fs.readFileSync(staleRegPath, "utf8")) as Record<string, unknown>;
    check(staleRegAfter["engineVersion"] === target.version, `D2 STALE OK: the registry engineVersion is fixed to ${target.version}`);
    check(staleRegAfter["formatIdentity"] === target.formatIdentity, `D2 STALE OK: the registry formatIdentity is fixed`);

    // --- D3 fault matrix: each exit 2, no output, no state touched.
    const faultCases: Array<{
      name: string;
      setup: () => string;
      runId: string;
      expect: string;
    }> = [
      {
        name: "eval",
        setup: () => {
          const d = path.join(WORKDIR, "fault-eval");
          copyTree(path.join(FAULTS, "eval"), d);
          return d;
        },
        runId: "bra115-fault-eval",
        expect: "source file for '<input>' not found",
      },
      {
        name: "sameline",
        setup: () => {
          const d = path.join(WORKDIR, "fault-sameline");
          copyTree(path.join(FAULTS, "sameline"), d);
          return d;
        },
        runId: "bra115-fault-sameline",
        expect: "ambiguous old identity",
      },
      {
        name: "drift",
        setup: () => {
          const d = path.join(WORKDIR, "fault-drift");
          setEngine(OLD_HOST, OLD_TREE);
          return d;
        },
        runId: RUN_ID,
        expect: "source excerpt differs",
      },
      {
        name: "delta",
        setup: () => {
          const d = path.join(WORKDIR, "fault-delta");
          setEngine(OLD_HOST, OLD_TREE);
          return d;
        },
        runId: RUN_ID,
        expect: "checkpoint is not a base",
      },
      {
        name: "pc",
        setup: () => {
          const d = path.join(WORKDIR, "fault-pc");
          setEngine(OLD_HOST, OLD_TREE);
          return d;
        },
        runId: RUN_ID,
        expect: "cannot remap pc 99999",
      },
      {
        name: "class-table",
        setup: () => {
          const d = path.join(WORKDIR, "fault-class");
          setEngine(OLD_HOST, OLD_TREE);
          return d;
        },
        runId: RUN_ID,
        expect: "class table differs",
      },
      {
        name: "missing-checkpoint",
        setup: () => {
          const d = path.join(WORKDIR, "fault-missing");
          copyTree(path.join(BRA115, "state-orig2"), d);
          return d;
        },
        runId: RUN_ID,
        expect: "no checkpoint manifest",
      },
    ];
    for (const fc of faultCases) {
      const dir = fc.setup();
      if (fc.name === "drift" || fc.name === "delta" || fc.name === "pc" || fc.name === "class-table") {
        await startSuspendedRun(dir, RUN_ID);
      }
      if (fc.name === "drift") {
        const bundle = path.join(dir, "slices", `bundle-${RUN_ID}.js`);
        const text = fs.readFileSync(bundle, "utf8");
        check(text.includes("const base = 3;"), `D3 DRIFT SETUP OK: the bundle carries "const base = 3;"`);
        fs.writeFileSync(bundle, text.replace("const base = 3;", "const base = 4;"));
      }
      if (fc.name === "delta") {
        const ckptPath = path.join(dir, "blobs", `${RUN_ID}.checkpoint.json`);
        const ckpt = JSON.parse(fs.readFileSync(ckptPath, "utf8")) as Record<string, unknown>;
        ckpt["kind"] = "delta";
        ckpt["deltaHash"] = "a".repeat(64);
        ckpt["prevCheckpointHash"] = ckpt["keyframeHash"];
        ckpt["sinceKeyframe"] = 1;
        fs.writeFileSync(ckptPath, JSON.stringify(ckpt));
      }
      if (fc.name === "pc") {
        const blobPath = path.join(dir, "blobs", `${RUN_ID}.snap`);
        const snap = parseSnapshotBytes(fs.readFileSync(blobPath));
        let corrupted = false;
        for (const [idx, , body] of snap.frameCells()) {
          const fr = parseFrameBody(body, snap.atomsObj);
          if (!fr.isCompleted && fr.pc !== null) {
            fr.pc = 99999;
            snap.bodies[idx] = encodeFrameBody(fr, snap.atomsObj);
            corrupted = true;
            break;
          }
        }
        check(corrupted, `D3 PC SETUP OK: a suspended frame pc was corrupted to 99999`);
        const bytes = emitSnapshot(snap);
        fs.writeFileSync(blobPath, bytes);
        fs.writeFileSync(path.join(dir, "slices", `${RUN_ID}.snap`), bytes);
        const ckptPath = path.join(dir, "blobs", `${RUN_ID}.checkpoint.json`);
        const ckpt = JSON.parse(fs.readFileSync(ckptPath, "utf8")) as Record<string, unknown>;
        const oldKeyHash = ckpt["keyframeHash"] as string;
        const newHash = createHash("sha256").update(bytes).digest("hex");
        fs.writeFileSync(path.join(dir, "blobs", "keyframes", `${newHash}.snap`), bytes);
        fs.unlinkSync(path.join(dir, "blobs", "keyframes", `${oldKeyHash}.snap`));
        ckpt["keyframeHash"] = newHash;
        ckpt["baseSize"] = bytes.length;
        fs.writeFileSync(ckptPath, JSON.stringify(ckpt));
      }
      let newSig = NEW_SIG_SNAP;
      if (fc.name === "class-table") {
        const doctored = parseSnapshotBytes(fs.readFileSync(NEW_SIG_SNAP));
        doctored.classCount = 106;
        doctored.classTable = [[1, Buffer.from("FakeClass")]];
        newSig = path.join(WORKDIR, "fault-class-newsig.snap");
        fs.writeFileSync(newSig, emitSnapshot(doctored));
      }
      const before = hashTree(dir);
      const r = convertCli(dir, fc.runId, newSig);
      check(r.rc === 2, `D3 ${fc.name.toUpperCase()} OK: CLI exits 2 (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(
        r.err.includes("CONVERT REFUSED:") && r.err.includes(fc.expect),
        `D3 ${fc.name.toUpperCase()} OK: refusal names ${JSON.stringify(fc.expect)} (got ${JSON.stringify(r.err.slice(0, 200))})`,
      );
      check(!r.out.includes("CONVERT OK"), `D3 ${fc.name.toUpperCase()} OK: no CONVERT OK on stdout`);
      check(
        hashTree(dir) === before,
        `D3 ${fc.name.toUpperCase()} OK: no state touched (dir byte-identical)`,
      );
    }
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA134 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    `PASS bra134 snapshot convert (inventory check, agentts check, pure unit checks, live e2e + already-converted + 7-case fault matrix — ${CHECKS.total} checks)`,
  );
  return 0;
}

process.exit(await main());
