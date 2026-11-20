#!/usr/bin/env bun
/**
 * Snapshot format identity gate (Linear BRA-132).
 *
 * BRA-71 gated resume on the FULL engine version
 * (`dquickts-<pin>+durablets-<hash>`): any durablets.c change, even a
 * logic-only bug fix, refused every parked run. BRA-132 narrows the
 * gate to the snapshot FORMAT identity — the build signature read
 * from the snapshot blob's header, the dquickts pin, and the ordered
 * host native names — while the full version is still recorded for
 * provenance. The pinned cases:
 *
 *   §A — unit: the blob-header signature reader, the native-name
 *      parser (incl. its loud shape/count failures), and the
 *      identity build/split round-trip.
 *   B1 — a snapshot taken under one durablets.c RESUMES under a
 *      logic-only change to it: the host is rebuilt with a
 *      comment-only durablets.c change (the full version string
 *      differs — proven by the differing source hash — while the
 *      format identity is unchanged), and the stranded run
 *      completes with its original output.
 *   B2 — same-engine resume still works, and the run entry carries
 *      a stamped formatIdentity after the first suspension.
 *   B3 — a dquickts pin change still REFUSES (simulated by a
 *      VENDORED_FROM stamp with a different pin; no rebuild — the
 *      pin is a TS-side input to the identity).
 *   B4 — RENAMING a native still REFUSES. The binary is unchanged;
 *      the refusal is computed from the registry the TS side sees
 *      (AGENTTS_DURABLETS_DIR pointing at a durablets.c whose
 *      "trap" registration is renamed "trap2") — exactly what a
 *      rebuilt renamed binary presents to the gate. The rename is
 *      the case the build signature alone would MISS
 *      (snap_natives_push hashes nothing; only native_count is
 *      hashed), so this case proves the names half of the identity.
 *   B5 — ADDING a native still REFUSES (a 7th native in the
 *      registry the TS side sees: new name + array entry + count 7).
 *   B6 — a legacy run with no recorded formatIdentity (pre-BRA-132,
 *      simulated by stripping the field from the run + queue
 *      entries) still PROCEEDS when the live blob's header
 *      signature matches.
 *   B7 — the same legacy run REFUSES on a pin change (the pin is
 *      read from the recorded full version — the pin is NOT a
 *      signature input, so the signature alone would not catch it).
 *   B8 — the AGENTTS_ENGINE_VERSION_OVERRIDE hook still refuses
 *      (test-bra71 B1's assertion set, re-proven under the narrowed
 *      gate: recorded real identity != synthetic current).
 *   §D — probe sensitivity (measured, not asserted from source):
 *      the comment-only binary's probe signature EQUALS the base
 *      binary's, and the 7-native binary's DIFFERS — the signature
 *      covers host->native_count and no logic-only change.
 *   §C — the disk cache: after B1 the cache file exists under
 *      stateDir/cache, keyed by the exact variant full version,
 *      holding the probe signature.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra132.ts
 *   (run.sh sets DURABLETS_HOST and DQUICKTS.)
 *
 * Variant hosts are built from scratch package copies (Makefile +
 * src/ only — the Makefile links against $DQUICKTS/libquickjs.a),
 * so the live tree is never modified. Each end-to-end case uses a
 * fresh state dir. Submits go through the CLI (like test-bra71),
 * so the production tick agent sees only events for runs outside
 * its state dir, which it 404s per BRA-133. The drive child
 * processes are killed in a finally block, even on failure. Exit 0
 * on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): a RENAME in the
 * pre-BRA-132 legacy window is not caught (names were never
 * recorded — the legacy path compares signature + pin only); and
 * durablets.c LOGIC is not in the identity — resume under a
 * native-behavior fix means the run continues under the fixed
 * behavior (accepted by the BRA-132 decision; the native set is
 * six functions, changed rarely and always under review).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import {
  readSnapshotBuildSignature,
  parseHostNativeNames,
  formatIdentityFor,
  splitFormatIdentity,
} from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const DQUICKTS = process.env.DQUICKTS || path.join(os.homedir(), "workspace", "dquickts-build-minimal");
const DURABLETS_PKG = path.resolve(ROOT, "..", "..", "packages", "durablets");

const BASE_HOST = process.env.DURABLETS_HOST;
if (!BASE_HOST) {
  console.log("FAIL: DURABLETS_HOST is not set — run via run.sh (it builds the host and sets the env)");
  process.exit(1);
}

const WORKDIR = process.env.BRA132_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra132-"));
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra132.ts");
const NATIVE_NAMES = ["print", "trap", "all", "any", "race", "__agentts_begin"];
const LIVE_DURABLETS_C = fs.readFileSync(path.join(DURABLETS_PKG, "src", "durablets.c"), "utf8");

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
const shaFile = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** The dquickts pin the TS side computes right now (same regex as
 * readDquicktsPin: $DQUICKTS/VENDORED_FROM first). Used to build
 * the expected full version string of a variant engine. */
function currentPin(): string {
  const stamp = fs.readFileSync(path.join(DQUICKTS, "VENDORED_FROM"), "utf8");
  const m = stamp.match(/Pinned commit:\s*([0-9a-f]{7,40})/);
  if (!m) throw new Error(`cannot read the dquickts pin from ${DQUICKTS}/VENDORED_FROM`);
  return m[1].slice(0, 12);
}

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function driveChild(stateDir: string, env: Record<string, string> = {}): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", stateDir], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

/** Drive a state dir's queue synchronously until the driver exits
 * (the queue drains or the run fails). The exec trap sleeps ~1 s,
 * so a completing drive takes a few seconds. */
function driveSync(stateDir: string, env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", stateDir], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const queuePath = (stateDir: string): string => path.join(stateDir, "queue.json");
const journalPath = (stateDir: string, runId: string): string => path.join(stateDir, "journals", `${runId}.journal`);
const blobPath = (stateDir: string, runId: string): string => path.join(stateDir, "blobs", `${runId}.snap`);
const runEntryPath = (stateDir: string, runId: string): string => path.join(stateDir, "runs", `${runId}.json`);

function readQueue(stateDir: string): any[] {
  return JSON.parse(fs.readFileSync(queuePath(stateDir), "utf8"));
}
function queueEntry(stateDir: string, runId: string): any | null {
  try {
    return readQueue(stateDir).find((e) => e.runId === runId) ?? null;
  } catch {
    return null;
  }
}
function queueStatus(stateDir: string, runId: string): string | null {
  return queueEntry(stateDir, runId)?.status ?? null;
}
function runEntry(stateDir: string, runId: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(runEntryPath(stateDir, runId), "utf8"));
  } catch {
    return null;
  }
}
function readJournal(stateDir: string, runId: string): any[] {
  const p = journalPath(stateDir, runId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        const v = JSON.parse(l);
        return v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as any).event === "string" ? v : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function markerLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
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

function submit(stateDir: string, runId: string, env: Record<string, string> = {}): string {
  const marker = path.join(WORKDIR, `${runId}.marker`);
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ markerFile: marker, sleepMs: 1000 }));
  const r = cli(["run", WORKFLOW, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", stateDir], env);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
  return runId;
}

function getResult(stateDir: string, runId: string): { status: string; output?: unknown; error?: string } | null {
  const r = cli(["result", runId, "--state-dir", stateDir]);
  if (r.rc === 0) {
    try {
      return { status: "done", output: JSON.parse(r.out) };
    } catch {
      return null;
    }
  }
  if (r.rc === 1) {
    const m = r.err.match(/^run \S+ failed: ([\s\S]*)$/);
    return m ? { status: "failed", error: m[1].trim() } : null;
  }
  return null;
}

/** Strand a run: drive it in a child, wait for the entry to flip
 * to "running" AND the marker file to appear (the exec trap has
 * dispatched — the run is suspended with a registry entry and a
 * snapshot blob on disk), then SIGKILL the child. */
async function strandRun(stateDir: string, runId: string, env: Record<string, string> = {}): Promise<Subprocess> {
  const marker = path.join(WORKDIR, `${runId}.marker`);
  const child = driveChild(stateDir, env);
  const flipped = await waitFor(() => queueStatus(stateDir, runId) === "running", 10_000, `${runId} entry -> running`);
  check(flipped, `STRAND OK: ${runId} entry flipped to running before the kill`);
  const dispatched = await waitFor(() => markerLines(marker).length >= 1, 10_000, `${runId} marker written (exec dispatched)`);
  check(dispatched, `STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
  child.kill(9);
  await child.exited;
  check(queueStatus(stateDir, runId) === "running", `STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  return child;
}

const children: Subprocess[] = [];

/** Build a variant host from a scratch package copy (Makefile +
 * src/ only — the Makefile links against $DQUICKTS/libquickjs.a),
 * applying `edit` to durablets.c. The live tree is never touched. */
function buildVariantHost(name: string, edit: (src: string) => string): { pkgDir: string; hostBin: string } {
  const pkgDir = path.join(WORKDIR, `pkg-${name}`);
  fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
  fs.copyFileSync(path.join(DURABLETS_PKG, "Makefile"), path.join(pkgDir, "Makefile"));
  for (const f of ["durablets.c", "durablets.h"]) {
    fs.copyFileSync(path.join(DURABLETS_PKG, "src", f), path.join(pkgDir, "src", f));
  }
  const cPath = path.join(pkgDir, "src", "durablets.c");
  fs.writeFileSync(cPath, edit(fs.readFileSync(cPath, "utf8")));
  const outDir = path.join(WORKDIR, `host-${name}`);
  const r = spawnSync("make", ["-C", pkgDir, `DQUICKTS=${DQUICKTS}`, `OUT_DIR=${outDir}`, "durablets"], { encoding: "utf8" });
  check(r.status === 0, `BUILD OK: variant host ${name} built (rc ${r.status})${r.status !== 0 ? ` — ${r.stderr.slice(-300)}` : ""}`);
  return { pkgDir, hostBin: path.join(outDir, "durablets") };
}

/** Run the BRA-132 probe bundle against a host binary and return
 * its build signature from the blob header it writes. */
function probeSignature(hostBin: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bra132-probe-"));
  try {
    const bundlePath = path.join(dir, "probe.js");
    const blob = path.join(dir, "probe.snap");
    fs.writeFileSync(bundlePath, `__agentts_begin();\ntrap("sleep", { ms: 1000 });\n`);
    const r = spawnSync(hostBin, ["run", bundlePath, blob], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 2) {
      throw new Error(`probe against ${hostBin} exited ${r.status ?? "unknown"}, expected 2: ${(r.stderr ?? "").slice(-300)}`);
    }
    const sig = readSnapshotBuildSignature(blob);
    if (sig === null) throw new Error(`probe against ${hostBin} wrote no blob`);
    return sig;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A scratch $DQUICKTS dir whose VENDORED_FROM stamp carries a
 * different pin — readDquicktsPin reads $DQUICKTS first, so a
 * resume drive under this env computes a different pin (and a
 * different full version) with no rebuild. */
function fakePinTree(pin: string): string {
  const dir = path.join(WORKDIR, `dquickts-fake-${pin.slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "VENDORED_FROM"), `Upstream: https://github.com/stencil-hq/dquickts\nPinned commit: ${pin} (BRA-132 test fake pin)\n`);
  return dir;
}

/** Strip the recorded format identity from a run's run entry +
 * queue entry, simulating a pre-BRA-132 run (engineVersion kept,
 * formatIdentity never recorded). */
function stripFormatIdentity(stateDir: string, runId: string): void {
  const re = runEntryPath(stateDir, runId);
  const reg = JSON.parse(fs.readFileSync(re, "utf8"));
  delete reg.formatIdentity;
  fs.writeFileSync(re, JSON.stringify(reg, null, 2));
  const q = readQueue(stateDir);
  const e = q.find((x) => x.runId === runId);
  if (e) {
    delete e.formatIdentity;
    fs.writeFileSync(queuePath(stateDir), JSON.stringify(q, null, 2));
  }
  check(runEntry(stateDir, runId)?.formatIdentity === undefined && queueEntry(stateDir, runId)?.formatIdentity === undefined, `LEGACY OK: ${runId} formatIdentity stripped from run + queue entries (pre-BRA-132 shape)`);
}

/** Assert a refusal: failed status, the error names the recorded
 * and current engines with "refusing to resume", the journal
 * carries the mismatch event, and the blob is untouched. */
function checkRefusal(stateDir: string, runId: string, blobShaBefore: string, recordedEngine: string, currentNeedle: string): void {
  const res = getResult(stateDir, runId);
  check(res?.status === "failed", `REFUSE OK: ${runId} marked failed (status ${res?.status ?? "null"})`);
  const err = res?.error ?? "";
  check(
    err.includes("refusing to resume") && err.includes(recordedEngine) && err.includes(currentNeedle),
    `REFUSE OK: ${runId} error names the recorded and current engines ("${err.slice(0, 120)}...")`,
  );
  const mismatch = readJournal(stateDir, runId).find((e) => e.event === "engine-version-mismatch");
  check(
    !!mismatch && mismatch.recorded === recordedEngine && typeof mismatch.current === "string" && mismatch.current.includes(currentNeedle),
    `REFUSE OK: ${runId} journal engine-version-mismatch recorded=${mismatch?.recorded ?? "?"} current=${mismatch?.current ?? "?"}`,
  );
  check(
    fs.existsSync(blobPath(stateDir, runId)) && shaFile(blobPath(stateDir, runId)) === blobShaBefore,
    `REFUSE OK: ${runId} snapshot blob untouched on disk after the refusal`,
  );
}

async function main(): Promise<void> {
  fs.writeFileSync(
    WORKFLOW,
    [
      "// BRA-132 test workflow: an exec trap (writes a marker, sleeps in the",
      "// shell so the drive can be stranded mid-dispatch), then returns \"ok\".",
      'import { exec } from "../../src/agentts";',
      "",
      "interface Bra132Input {",
      "  markerFile: string;",
      "  sleepMs: number;",
      "}",
      "export interface RunResult {",
      "  marker: string;",
      "}",
      "",
      "export default function run(input: Bra132Input): RunResult {",
      "  const r = exec({",
      '    cmd: "sh",',
      '    args: ["-c", `echo bra132 >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],',
      "  });",
      '  return { marker: r.stdout.trim() === "done" ? "ok" : "unexpected" };',
      "}",
      "",
    ].join("\n"),
  );

  // ---------------------------------------------------------------- §A unit
  const baseSig = probeSignature(BASE_HOST);
  const baseSig2 = probeSignature(BASE_HOST);
  check(
    Number.isInteger(baseSig) && baseSig >= 0 && baseSig <= 0xffffffff && baseSig === baseSig2,
    `PROBE OK: base host build signature stable across probes (0x${baseSig.toString(16).padStart(8, "0")})`,
  );

  const names = parseHostNativeNames(LIVE_DURABLETS_C);
  check(
    JSON.stringify(names) === JSON.stringify(NATIVE_NAMES),
    `PARSE OK: host native names parsed in order (${names.join(", ")})`,
  );

  let threw = false;
  try {
    parseHostNativeNames("int main() { return 0; }\n");
  } catch {
    threw = true;
  }
  check(threw, "PARSE OK: parseHostNativeNames throws loudly when durablets_register is absent");
  threw = false;
  try {
    parseHostNativeNames(LIVE_DURABLETS_C.replace('    JS_SetPropertyStr(ctx, global, "trap",\n                      JS_NewCFunction(ctx, js_trap, "trap", 2));\n', ""));
  } catch {
    threw = true;
  }
  check(threw, "PARSE OK: parseHostNativeNames throws loudly when a registration is deleted (counts 5 vs 6 vs 6)");
  threw = false;
  try {
    parseHostNativeNames(LIVE_DURABLETS_C.replace(".native_count = 6", ".native_count = 7"));
  } catch {
    threw = true;
  }
  check(threw, "PARSE OK: parseHostNativeNames throws loudly when .native_count disagrees with the registry");

  const pin = currentPin();
  const id = formatIdentityFor(baseSig, pin, NATIVE_NAMES);
  const split = splitFormatIdentity(id);
  check(
    split !== null && split.signature === baseSig.toString(16).padStart(8, "0") && split.pin === pin && JSON.stringify(split.natives) === JSON.stringify(NATIVE_NAMES),
    `IDENTITY OK: formatIdentityFor/split round-trip (${id})`,
  );
  const legacySplit = splitFormatIdentity(`snapfmt-${baseSig.toString(16).padStart(8, "0")}`);
  check(legacySplit !== null && legacySplit.pin === null && legacySplit.natives === null, "IDENTITY OK: legacy signature-only form parses with null pin/natives");
  check(splitFormatIdentity("dquickts-96a9a79+durablets-0123456789abcdef") === null, "IDENTITY OK: a full engine version string is not a format identity (split returns null)");

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bra132-blob-"));
  check(readSnapshotBuildSignature(path.join(fakeDir, "missing.snap")) === null, "BLOB OK: readSnapshotBuildSignature returns null for a missing file");
  const shortPath = path.join(fakeDir, "short.snap");
  fs.writeFileSync(shortPath, Buffer.from("QJSSNAP\n"));
  threw = false;
  try {
    readSnapshotBuildSignature(shortPath);
  } catch {
    threw = true;
  }
  check(threw, "BLOB OK: readSnapshotBuildSignature throws loudly on a truncated blob");
  const badMagicPath = path.join(fakeDir, "badmagic.snap");
  const badMagic = Buffer.alloc(32);
  badMagic.write("NOTASNAP", 0, "latin1");
  fs.writeFileSync(badMagicPath, badMagic);
  threw = false;
  try {
    readSnapshotBuildSignature(badMagicPath);
  } catch {
    threw = true;
  }
  check(threw, "BLOB OK: readSnapshotBuildSignature throws loudly on a bad magic");
  const wrongVersionPath = path.join(fakeDir, "wrongver.snap");
  const wrongVersion = Buffer.alloc(32);
  wrongVersion.write("QJSSNAP\n", 0, "latin1");
  wrongVersion[8] = 10; // LEB128 version 10, not 11
  fs.writeFileSync(wrongVersionPath, wrongVersion);
  threw = false;
  try {
    readSnapshotBuildSignature(wrongVersionPath);
  } catch {
    threw = true;
  }
  check(threw, "BLOB OK: readSnapshotBuildSignature throws loudly on a non-11 format version");

  // ------------------------------------------------- variant hosts (built once)
  const commentVariant = buildVariantHost("comment", (src) => src + "\n/* BRA-132 test: comment-only change — same format, different hash. */\n");
  const addVariantPkg = buildVariantHost("add7", (src) =>
    src
      .replace("    (const void *)js_agentts_begin,\n};", "    (const void *)js_agentts_begin,\n    (const void *)js_print,\n};")
      .replace(
        '                                      "__agentts_begin", 0));\n    JS_FreeValue(ctx, global);',
        '                                      "__agentts_begin", 0));\n    JS_SetPropertyStr(ctx, global, "print2",\n                      JS_NewCFunction(ctx, js_print, "print2", 1));\n    JS_FreeValue(ctx, global);',
      )
      .replace(".native_count = 6", ".native_count = 7"),
  );
  const addNames = parseHostNativeNames(fs.readFileSync(path.join(addVariantPkg.pkgDir, "src", "durablets.c"), "utf8"));
  check(
    JSON.stringify(addNames) === JSON.stringify([...NATIVE_NAMES, "print2"]),
    `PARSE OK: 7-native registry parses to the 7 names in order (${addNames.join(", ")})`,
  );

  // ---------------------------------------------------------------- §B e2e
  const mkState = (name: string): string => {
    const d = path.join(WORKDIR, `state-${name}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // B1 — logic-only durablets.c change RESUMES.
  const s1 = mkState("b1");
  submit(s1, "bra132-b1");
  children.push(await strandRun(s1, "bra132-b1"));
  const recordedEngineB1 = runEntry(s1, "bra132-b1")?.engineVersion as string | undefined;
  const recordedIdentityB1 = runEntry(s1, "bra132-b1")?.formatIdentity as string | undefined;
  check(typeof recordedEngineB1 === "string" && recordedEngineB1.startsWith("dquickts-"), `STAMP OK: bra132-b1 run entry records engineVersion ${recordedEngineB1 ?? "?"}`);
  check(typeof recordedIdentityB1 === "string" && recordedIdentityB1.startsWith("snapfmt-"), `STAMP OK: bra132-b1 run entry stamped formatIdentity ${recordedIdentityB1 ?? "?"}`);
  check(queueEntry(s1, "bra132-b1")?.formatIdentity === recordedIdentityB1, "STAMP OK: bra132-b1 queue entry carries the same formatIdentity");
  const driveB1 = driveSync(s1, { DURABLETS_HOST: commentVariant.hostBin, AGENTTS_DURABLETS_DIR: commentVariant.pkgDir });
  check(driveB1.rc === 0, `RESUME OK: bra132-b1 drive under the comment-only engine exited 0 (rc ${driveB1.rc})`);
  const resB1 = getResult(s1, "bra132-b1");
  check(resB1?.status === "done" && (resB1.output as any)?.marker === "ok", `RESUME OK: bra132-b1 completed with its original output under the logic-only engine change (${JSON.stringify(resB1?.output)})`);
  check(
    shaFile(path.join(commentVariant.pkgDir, "src", "durablets.c")) !== shaFile(path.join(DURABLETS_PKG, "src", "durablets.c")),
    "RESUME OK: the variant durablets.c hash differs from the live one — the full engine version differs, so BRA-71 would have refused this resume",
  );
  check(queueEntry(s1, "bra132-b1")?.formatIdentity === recordedIdentityB1, "RESUME OK: bra132-b1 formatIdentity unchanged across the engine change (same format, new build — the queue entry survives completion; the run entry JSON is deleted on completion)");
  // §C — the disk cache for the variant engine.
  const variantHash = shaFile(path.join(commentVariant.pkgDir, "src", "durablets.c")).slice(0, 16);
  const variantFull = `dquickts-${currentPin()}+durablets-${variantHash}`;
  const cachePath = path.join(s1, "cache", `engine-format-${crypto.createHash("sha256").update(variantFull, "utf8").digest("hex")}.json`);
  let cacheOk = false;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cacheOk = cached.formatSignature === baseSig.toString(16).padStart(8, "0");
  } catch {
    cacheOk = false;
  }
  check(cacheOk, `CACHE OK: variant engine format signature cached at ${path.relative(WORKDIR, cachePath)} with the probe signature`);

  // B2 — same-engine resume still works.
  const s2 = mkState("b2");
  submit(s2, "bra132-b2");
  children.push(await strandRun(s2, "bra132-b2"));
  check(typeof runEntry(s2, "bra132-b2")?.formatIdentity === "string", "STAMP OK: bra132-b2 run entry stamped formatIdentity after suspension");
  const driveB2 = driveSync(s2, {});
  check(driveB2.rc === 0, `RESUME OK: bra132-b2 same-engine drive exited 0 (rc ${driveB2.rc})`);
  const resB2 = getResult(s2, "bra132-b2");
  check(resB2?.status === "done" && (resB2.output as any)?.marker === "ok", `RESUME OK: bra132-b2 completed under the same engine (${JSON.stringify(resB2?.output)})`);

  // B3 — dquickts pin change REFUSES.
  const s3 = mkState("b3");
  submit(s3, "bra132-b3");
  children.push(await strandRun(s3, "bra132-b3"));
  const recordedEngineB3 = runEntry(s3, "bra132-b3")?.engineVersion as string;
  const blobShaB3 = shaFile(blobPath(s3, "bra132-b3"));
  const fakePin = fakePinTree("aaaaaaaabbbbccccdddd");
  driveSync(s3, { DQUICKTS: fakePin });
  checkRefusal(s3, "bra132-b3", blobShaB3, recordedEngineB3, "aaaaaaaabbbb");

  // B4 — native RENAME refuses.
  const renamePkgDir = path.join(WORKDIR, "pkg-rename");
  fs.mkdirSync(path.join(renamePkgDir, "src"), { recursive: true });
  fs.copyFileSync(path.join(DURABLETS_PKG, "Makefile"), path.join(renamePkgDir, "Makefile"));
  for (const f of ["durablets.c", "durablets.h"]) {
    fs.copyFileSync(path.join(DURABLETS_PKG, "src", f), path.join(renamePkgDir, "src", f));
  }
  const renameC = path.join(renamePkgDir, "src", "durablets.c");
  fs.writeFileSync(renameC, fs.readFileSync(renameC, "utf8").replace('JS_SetPropertyStr(ctx, global, "trap",', 'JS_SetPropertyStr(ctx, global, "trap2",'));
  const s4 = mkState("b4");
  submit(s4, "bra132-b4");
  children.push(await strandRun(s4, "bra132-b4"));
  const recordedEngineB4 = runEntry(s4, "bra132-b4")?.engineVersion as string;
  const blobShaB4 = shaFile(blobPath(s4, "bra132-b4"));
  const renameFull = `dquickts-${currentPin()}+durablets-${shaFile(renameC).slice(0, 16)}`;
  driveSync(s4, { AGENTTS_DURABLETS_DIR: renamePkgDir });
  checkRefusal(s4, "bra132-b4", blobShaB4, recordedEngineB4, renameFull);

  // B5 — native ADD refuses.
  const s5 = mkState("b5");
  submit(s5, "bra132-b5");
  children.push(await strandRun(s5, "bra132-b5"));
  const recordedEngineB5 = runEntry(s5, "bra132-b5")?.engineVersion as string;
  const blobShaB5 = shaFile(blobPath(s5, "bra132-b5"));
  const addFull = `dquickts-${currentPin()}+durablets-${shaFile(path.join(addVariantPkg.pkgDir, "src", "durablets.c")).slice(0, 16)}`;
  driveSync(s5, { AGENTTS_DURABLETS_DIR: addVariantPkg.pkgDir });
  checkRefusal(s5, "bra132-b5", blobShaB5, recordedEngineB5, addFull);

  // B6 — legacy (no formatIdentity) PROCEEDS when the signature matches.
  const s6 = mkState("b6");
  submit(s6, "bra132-b6");
  children.push(await strandRun(s6, "bra132-b6"));
  stripFormatIdentity(s6, "bra132-b6");
  const driveB6 = driveSync(s6, {});
  check(driveB6.rc === 0, `LEGACY OK: bra132-b6 drive exited 0 (rc ${driveB6.rc})`);
  const resB6 = getResult(s6, "bra132-b6");
  check(resB6?.status === "done" && (resB6.output as any)?.marker === "ok", `LEGACY OK: bra132-b6 legacy run (no formatIdentity) completed when the blob signature matches (${JSON.stringify(resB6?.output)})`);

  // B7 — legacy REFUSES on a pin change.
  const s7 = mkState("b7");
  submit(s7, "bra132-b7");
  children.push(await strandRun(s7, "bra132-b7"));
  const recordedEngineB7 = runEntry(s7, "bra132-b7")?.engineVersion as string;
  const blobShaB7 = shaFile(blobPath(s7, "bra132-b7"));
  stripFormatIdentity(s7, "bra132-b7");
  driveSync(s7, { DQUICKTS: fakePin });
  checkRefusal(s7, "bra132-b7", blobShaB7, recordedEngineB7, "aaaaaaaabbbb");

  // B8 — the override hook still refuses (bra71-B1 parity).
  const s8 = mkState("b8");
  submit(s8, "bra132-b8");
  children.push(await strandRun(s8, "bra132-b8"));
  const recordedEngineB8 = runEntry(s8, "bra132-b8")?.engineVersion as string;
  const blobShaB8 = shaFile(blobPath(s8, "bra132-b8"));
  driveSync(s8, { AGENTTS_ENGINE_VERSION_OVERRIDE: "FAKE_ENGINE" });
  const resB8 = getResult(s8, "bra132-b8");
  check(resB8?.status === "failed", `OVERRIDE OK: bra132-b8 marked failed under the override (status ${resB8?.status ?? "null"})`);
  check(
    (resB8?.error ?? "").includes("refusing to resume") && (resB8?.error ?? "").includes(recordedEngineB8) && (resB8?.error ?? "").includes("FAKE_ENGINE"),
    `OVERRIDE OK: bra132-b8 error names the recorded engine and FAKE_ENGINE ("${(resB8?.error ?? "").slice(0, 120)}...")`,
  );
  const mismatchB8 = readJournal(s8, "bra132-b8").find((e) => e.event === "engine-version-mismatch");
  check(
    !!mismatchB8 && mismatchB8.recorded === recordedEngineB8 && mismatchB8.current === "FAKE_ENGINE",
    `OVERRIDE OK: bra132-b8 journal mismatch recorded=${mismatchB8?.recorded ?? "?"} current=${mismatchB8?.current ?? "?"}`,
  );
  check(
    fs.existsSync(blobPath(s8, "bra132-b8")) && shaFile(blobPath(s8, "bra132-b8")) === blobShaB8,
    "OVERRIDE OK: bra132-b8 snapshot blob untouched on disk after the refusal",
  );

  // ---------------------------------------------------------------- §D probe sensitivity
  const commentSig = probeSignature(commentVariant.hostBin);
  check(commentSig === baseSig, `PROBE OK: comment-only binary signature equals base (0x${commentSig.toString(16).padStart(8, "0")}) — logic-only changes do not move the signature`);
  const addSig = probeSignature(addVariantPkg.hostBin);
  check(addSig !== baseSig, `PROBE OK: 7-native binary signature differs from base (0x${addSig.toString(16).padStart(8, "0")} vs 0x${baseSig.toString(16).padStart(8, "0")}) — the signature covers host->native_count`);

  // ---------------------------------------------------------------- verdict
  for (const c of children) {
    try {
      c.kill(9);
    } catch {
      // Already dead.
    }
  }
  if (FAILURES.length > 0) {
    console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nPASS bra132: snapshot format identity gate");
}

try {
  await main();
} catch (e) {
  console.log(`FAIL: uncaught error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  for (const c of children) {
    try {
      c.kill(9);
    } catch {
      // Already dead.
    }
  }
  process.exit(1);
}
