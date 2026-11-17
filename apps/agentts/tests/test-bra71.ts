#!/usr/bin/env bun
/**
 * Run integrity across time (Linear BRA-71 — G9 + G10, the BRA-62
 * audit's time-passing gaps).
 *
 *   G9 — frozen workflow copy: editing a workflow while a run is
 *   suspended must not change what the resumed run executes or
 *   validates against. The run executes and validates against the
 *   frozen closure (entry + transitive relative imports + the
 *   agentts module) recorded at submit, keyed by content hash.
 *      A1. Edit the workflow file mid-run (output type gains a
 *          required field + the echo marker changes): the resumed
 *          run completes with the ORIGINAL output, validated
 *          against the FROZEN schemas — and the edited marker never
 *          appears in the marker file.
 *      A2. Edit the workflow file mid-run to a type error: the
 *          resumed run still completes (no re-gate on the edited
 *          file).
 *      A3. Registry-loss re-drive: strand a run, delete its registry
 *          entry, re-queue it by hand, edit the workflow: the
 *          re-drive executes the FROZEN copy (original marker,
 *          original output — the edited code never runs).
 *      A4. Edit a LIBRARY file the workflow imports mid-run (its
 *          type flows into the output schema): the resumed run
 *          completes with the ORIGINAL output (frozen closure, not
 *          just the entry file).
 *   G10 — snapshot version check: a snapshot is same-engine-only.
 *      B1. Resume with a different engine build (override hook):
 *          the run is refused LOUDLY — marked failed with a clear
 *          error naming the recorded vs current engine versions, an
 *          engine-version-mismatch journal event, and the snapshot
 *          blob left untouched on disk.
 *      B2. Happy path: suspend and resume under the SAME engine —
 *          completes exactly as before.
 *      B3. Structural: the queue entry records frozenHash,
 *          frozenPath and engineVersion; the frozen dir holds the
 *          entry + lib + agentts module byte-identical to the
 *          submitted source; the engine version is stable across
 *          runs (two runs record the same version).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra71.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra77 suite.)
 *
 * The test edits tests/workflows/workflow-bra71.ts and bra71-lib.ts
 * mid-run. It writes the known originals at startup (so a leftover
 * edit from a killed run is repaired) and restores them in a finally
 * block. Run outputs go to $BRA71_WORKDIR (scratch, set by run.sh)
 * or a fresh mkdtemp dir. The drive child processes are killed in a
 * finally block, even on failure. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): legacy runs submitted
 * before BRA-71 carry no frozen copy or engine version, so they
 * resume from the live file with no version check (grandfathered —
 * there is nothing to compare against). And the engine version reads
 * the dquickts pin from $DQUICKTS when set, else the vendored
 * tree's VENDORED_FROM stamp (packages/durablets/vendor/dquickts),
 * else the legacy VM-local minimal tree: a binary built against a
 * tree that is neither (and not named by $DQUICKTS) is not
 * distinguished by pin (the durablets.c hash still applies).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA71_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra71-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra71.ts");
const LIB = path.join(ROOT, "tests", "workflows", "bra71-lib.ts");
const AGENTTS = path.join(ROOT, "src", "agentts.ts");

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Drive the queue in a child process (the CLI blocks in the exec
 * trap; this process must stay free to kill it). */
function driveChild(): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", STATE_DIR], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}

const queuePath = path.join(STATE_DIR, "queue.json");
const journalPath = (runId: string): string => path.join(STATE_DIR, "journals", `${runId}.journal`);
const blobPath = (runId: string): string => path.join(STATE_DIR, "blobs", `${runId}.snap`);
const runEntryPath = (runId: string): string => path.join(STATE_DIR, "runs", `${runId}.json`);

function readQueueStrict(): any[] {
  return JSON.parse(fs.readFileSync(queuePath, "utf8"));
}
/** Resolve a stored frozenPath read raw from queue.json: BRA-85
 * stores it state-dir-relative ("frozen/<hash>/..."), legacy dirs
 * store it absolute. */
function resolveFrozenPath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(STATE_DIR, stored);
}
function queueEntry(runId: string): any | null {
  try {
    return readQueueStrict().find((e) => e.runId === runId) ?? null;
  } catch {
    return null;
  }
}
function queueStatus(runId: string): string | null {
  return queueEntry(runId)?.status ?? null;
}
function setQueueStatus(runId: string, status: string): boolean {
  if (!fs.existsSync(queuePath)) return false;
  const q = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  const e = q.find((x: any) => x.runId === runId);
  if (!e) return false;
  e.status = status;
  fs.writeFileSync(queuePath, JSON.stringify(q, null, 2));
  return true;
}
/** Good journal events only (tolerant parse, as the Host loads). */
function readJournal(runId: string): any[] {
  const p = journalPath(runId);
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

function submit(workflow: string, runId: string, input: unknown): string {
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const r = cli(["run", workflow, "--run-id", runId, "--input-file", inputFile, "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT OK: ${runId} submitted (rc ${r.rc})`);
  return runId;
}

function getResult(runId: string): { status: string; output?: unknown; error?: string } | null {
  // printResult (cli.ts): done -> stdout is the OUTPUT JSON, rc 0;
  // failed -> stderr is "run <id> failed: <error>", rc 1.
  const r = cli(["result", runId, "--state-dir", STATE_DIR]);
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
 * snapshot blob on disk), then SIGKILL the child. Waiting for the
 * marker matters: killing right after the "running" flip can land
 * before the first slice returns, leaving a never-started run
 * instead of a suspended one. Returns the child (already dead). */
async function strandRun(runId: string, marker: string): Promise<Subprocess> {
  const child = driveChild();
  const flipped = await waitFor(() => queueStatus(runId) === "running", 10_000, `${runId} entry -> running`);
  check(flipped, `STRAND OK: ${runId} entry flipped to running before the kill`);
  const dispatched = await waitFor(() => markerLines(marker).length >= 1, 10_000, `${runId} marker written (exec dispatched)`);
  check(dispatched, `STRAND OK: ${runId} exec dispatched (marker written) before the kill`);
  child.kill(9);
  await child.exited;
  check(queueStatus(runId) === "running", `STRAND OK: ${runId} entry still "running" after the kill (stranded, not driven)`);
  return child;
}

const children: Subprocess[] = [];

// ---------------------------------------------------------------- fixtures
// The known-original contents, as single-quoted lines (no template
// literal, so the workflow's own ${...} needs no escaping). The test
// writes these to the repo files at startup (self-healing) and
// restores them in a finally block.
const ORIGINAL_WORKFLOW = [
  "// BRA-71 test workflow: an exec trap (writes a marker, sleeps in the",
  "// shell so the drive can be stranded mid-dispatch), then returns the",
  "// marker + the lib's value. The lib's TYPE flows into the output",
  "// schema (the workflow returns LibInfo), so editing the lib mid-run",
  "// changes the schemas a resumed run validates against — the frozen",
  "// closure must prevent that. The test edits this file mid-run and",
  "// restores the original in a finally block (and writes the original",
  "// at startup, so a leftover edit from a killed run is repaired).",
  'import { exec } from "../../src/agentts";',
  'import { libMarker, type LibInfo } from "./bra71-lib";',
  "",
  "interface Bra71Input {",
  "  markerFile: string;",
  "  sleepMs: number;",
  "}",
  "export interface RunResult {",
  "  marker: string;",
  "  lib: LibInfo;",
  "}",
  "",
  "export default function run(input: Bra71Input): RunResult {",
  "  const r = exec({",
  '    cmd: "sh",',
  '    args: ["-c", `echo bra71-original >> "${input.markerFile}" && sleep ${Math.floor(input.sleepMs / 1000)} && echo done`],',
  "  });",
  '  return { marker: r.stdout.trim() === "done" ? "original" : "unexpected", lib: libMarker() };',
  "}",
  "",
].join("\n");

const ORIGINAL_LIB = [
  "// BRA-71 test lib: its TYPE flows into the workflow's output schema",
  "// (workflow-bra71 returns LibInfo), so editing this file mid-run",
  "// changes the schemas a resumed run validates against — unless the",
  "// frozen closure is used. The test edits this file mid-run and",
  "// restores the original in a finally block (and writes the original",
  "// at startup, so a leftover edit from a killed run is repaired).",
  "export interface LibInfo {",
  "  value: string;",
  "}",
  "",
  "export function libMarker(): LibInfo {",
  '  return { value: "original-lib" };',
  "}",
  "",
].join("\n");

function mustReplace(src: string, from: string, to: string, what: string): string {
  if (!src.includes(from)) {
    fail(`EDIT SETUP: replacement for ${what} did not match — the fixture literal drifted`);
    return src;
  }
  return src.replace(from, to);
}

/** Edited workflow: output type gains a required field, the echo
 * marker changes, the return value changes. Without the frozen
 * copy, the resumed run would validate its (original) result
 * against the NEW schema (missing `edited`) and fail. */
function editedWorkflow(): string {
  let s = ORIGINAL_WORKFLOW;
  s = mustReplace(s, 'echo bra71-original >> "${input.markerFile}"', 'echo bra71-edited >> "${input.markerFile}"', "edited echo");
  s = mustReplace(
    s,
    "export interface RunResult {\n  marker: string;\n  lib: LibInfo;\n}",
    "export interface RunResult {\n  marker: string;\n  lib: LibInfo;\n  edited: boolean;\n}",
    "edited output type",
  );
  s = mustReplace(
    s,
    'return { marker: r.stdout.trim() === "done" ? "original" : "unexpected", lib: libMarker() };',
    'return { marker: "EDITED", lib: libMarker(), edited: true };',
    "edited return",
  );
  return s;
}

/** Type-error workflow: the return type is wrong (number where the
 * output schema wants a string). Without the frozen copy, the
 * resume would re-run the gate on the edited file and fail. */
function typeErrorWorkflow(): string {
  return mustReplace(
    ORIGINAL_WORKFLOW,
    'return { marker: r.stdout.trim() === "done" ? "original" : "unexpected", lib: libMarker() };',
    'return { marker: 42, lib: libMarker() };',
    "type-error return",
  );
}

/** Edited lib: the type gains a required field and the value
 * changes. Without the frozen closure, depHash changes, the cache
 * misses, and the resumed run validates against the NEW schema. */
function editedLib(): string {
  let s = ORIGINAL_LIB;
  s = mustReplace(s, "export interface LibInfo {\n  value: string;\n}", "export interface LibInfo {\n  value: string;\n  edited: boolean;\n}", "edited lib type");
  s = mustReplace(s, 'return { value: "original-lib" };', 'return { value: "edited-lib", edited: true };', "edited lib value");
  return s;
}

function writeOriginals(): void {
  fs.writeFileSync(WORKFLOW, ORIGINAL_WORKFLOW);
  fs.writeFileSync(LIB, ORIGINAL_LIB);
}

const EXPECTED_OUTPUT = { marker: "original", lib: { value: "original-lib" } };
const FAKE_ENGINE = "dquickts-000000000000+durablets-0000000000000000";

function assertOriginalOutput(runId: string, scenario: string): void {
  const res = getResult(runId);
  check(res !== null && res.status === "done", `${scenario} RESULT: run done (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    res !== null && JSON.stringify(res.output) === JSON.stringify(EXPECTED_OUTPUT),
    `${scenario} OUTPUT: original output ${JSON.stringify(EXPECTED_OUTPUT)} (got ${JSON.stringify(res?.output)})`,
  );
}

function assertMarkerOriginalOnly(marker: string, scenario: string): void {
  const lines = markerLines(marker);
  check(lines.length >= 1, `${scenario} MARKER: at least one marker line (got ${lines.length})`);
  check(
    lines.every((l) => l === "bra71-original"),
    `${scenario} MARKER: only the original marker, never the edited one (got ${JSON.stringify(lines)})`,
  );
}

function frozenRoot(hash: string): string {
  return path.join(STATE_DIR, "frozen", hash);
}

async function scenarioB3(): Promise<string> {
  console.log("\n=== B3. structural: frozen copy + engine version recorded ===");
  const runId = "bra71-b3";
  const marker = path.join(WORKDIR, "bra71-b3.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 0 });
  const e = queueEntry(runId);
  check(e !== null, `B3 ENTRY: queue entry exists for ${runId}`);
  check(typeof e?.frozenHash === "string" && /^[0-9a-f]{64}$/.test(e.frozenHash), `B3 FROZENHASH: queue entry records a sha256 frozen hash (got ${e?.frozenHash})`);
  check(
    typeof e?.frozenPath === "string" &&
      resolveFrozenPath(e.frozenPath).startsWith(path.join(STATE_DIR, "frozen", e.frozenHash ?? "")),
    `B3 FROZENPATH: queue entry records a frozen path under stateDir/frozen/<hash> (got ${e?.frozenPath})`,
  );
  check(
    typeof e?.engineVersion === "string" && /^dquickts-[0-9a-f]{7,12}\+durablets-[0-9a-f]{16}$/.test(e.engineVersion),
    `B3 ENGINE: queue entry records an engine version (got ${e?.engineVersion})`,
  );
  const root = frozenRoot(e.frozenHash);
  const frozenEntry = path.join(root, "tests", "workflows", "workflow-bra71.ts");
  const frozenLib = path.join(root, "tests", "workflows", "bra71-lib.ts");
  const frozenModule = path.join(root, "src", "agentts.ts");
  check(
    typeof e?.frozenPath === "string" && resolveFrozenPath(e.frozenPath) === frozenEntry,
    `B3 FROZENPATH: recorded path is the frozen entry (got ${e?.frozenPath})`,
  );
  check(fs.existsSync(frozenEntry) && fs.readFileSync(frozenEntry, "utf8") === ORIGINAL_WORKFLOW, "B3 FROZEN ENTRY: frozen entry is byte-identical to the submitted workflow");
  check(fs.existsSync(frozenLib) && fs.readFileSync(frozenLib, "utf8") === ORIGINAL_LIB, "B3 FROZEN LIB: frozen lib is byte-identical to the submitted lib");
  check(
    fs.existsSync(frozenModule) && fs.readFileSync(frozenModule, "utf8") === fs.readFileSync(AGENTTS, "utf8"),
    "B3 FROZEN MODULE: frozen closure includes the agentts module at its relative position",
  );
  // Drive it to completion normally (sleepMs 0: fast) so no queued run is left behind.
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `B3 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  assertOriginalOutput(runId, "B3");
  return e.engineVersion as string;
}

async function scenarioInputInline(): Promise<void> {
  console.log("\n=== INPUT. inline --input JSON + --input/--input-file conflict ===");
  const runId = "bra71-input-inline";
  const marker = path.join(WORKDIR, "bra71-input-inline.marker");
  // Inline JSON submits identically to --input-file: same workflow, same input shape.
  const r = cli(["run", WORKFLOW, "--run-id", runId, "--input", JSON.stringify({ markerFile: marker, sleepMs: 0 }), "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `INPUT INLINE: submit with --input exited 0 (rc ${r.rc})`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `INPUT INLINE DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  assertOriginalOutput(runId, "INPUT INLINE");
  // Both input sources at once is refused.
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ markerFile: marker, sleepMs: 0 }));
  const conflict = cli(["run", WORKFLOW, "--run-id", `${runId}-conflict`, "--input-file", inputFile, "--input", JSON.stringify({ markerFile: marker, sleepMs: 0 }), "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(conflict.rc === 1 && conflict.err.includes("--input and --input-file conflict"), `INPUT CONFLICT: both sources refused rc 1 (rc ${conflict.rc})`);
  // Invalid inline JSON is refused.
  const bad = cli(["run", WORKFLOW, "--run-id", `${runId}-bad`, "--input", "{not json", "--adapter", "direct", "--state-dir", STATE_DIR]);
  check(bad.rc === 1 && bad.err.includes("--input is not valid JSON"), `INPUT BAD JSON: invalid --input refused rc 1 (rc ${bad.rc})`);
}

async function scenarioA1(): Promise<void> {
  console.log("\n=== A1. edit the workflow mid-run (output type change): frozen schemas win ===");
  const runId = "bra71-a1";
  const marker = path.join(WORKDIR, "bra71-a1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  // Edit the live file: new required output field + edited marker + edited return.
  fs.writeFileSync(WORKFLOW, editedWorkflow());
  const e = queueEntry(runId);
  check(
    e !== null &&
      typeof e.frozenPath === "string" &&
      fs.existsSync(resolveFrozenPath(e.frozenPath)) &&
      fs.readFileSync(resolveFrozenPath(e.frozenPath), "utf8") === ORIGINAL_WORKFLOW,
    "A1 FROZEN UNCHANGED: the frozen entry still holds the original source after the live edit",
  );
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A1 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  assertOriginalOutput(runId, "A1");
  assertMarkerOriginalOnly(marker, "A1");
  writeOriginals();
}

async function scenarioA2(): Promise<void> {
  console.log("\n=== A2. edit the workflow mid-run to a type error: no re-gate ===");
  const runId = "bra71-a2";
  const marker = path.join(WORKDIR, "bra71-a2.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  fs.writeFileSync(WORKFLOW, typeErrorWorkflow());
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A2 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  assertOriginalOutput(runId, "A2");
  assertMarkerOriginalOnly(marker, "A2");
  writeOriginals();
}

async function scenarioA3(): Promise<void> {
  console.log("\n=== A3. registry-loss re-drive executes the frozen copy ===");
  const runId = "bra71-a3";
  const marker = path.join(WORKDIR, "bra71-a3.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  // Simulate registry loss (runs/<run>.json deleted), then a human
  // re-queueing the stranded run after inspection.
  check(fs.existsSync(runEntryPath(runId)), `A3 REGISTRY: registry entry exists before deletion`);
  fs.rmSync(runEntryPath(runId));
  check(setQueueStatus(runId, "queued"), `A3 REQUEUE: entry set back to queued by hand`);
  fs.writeFileSync(WORKFLOW, editedWorkflow());
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A3 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  assertOriginalOutput(runId, "A3");
  assertMarkerOriginalOnly(marker, "A3");
  writeOriginals();
}

async function scenarioA4(): Promise<void> {
  console.log("\n=== A4. edit the LIB mid-run (type change): frozen closure wins ===");
  const runId = "bra71-a4";
  const marker = path.join(WORKDIR, "bra71-a4.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  fs.writeFileSync(LIB, editedLib());
  const e = queueEntry(runId);
  const frozenLib = path.join(frozenRoot(e.frozenHash), "tests", "workflows", "bra71-lib.ts");
  check(
    fs.existsSync(frozenLib) && fs.readFileSync(frozenLib, "utf8") === ORIGINAL_LIB,
    "A4 FROZEN LIB UNCHANGED: the frozen lib still holds the original source after the live edit",
  );
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(drive.rc === 0, `A4 DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  assertOriginalOutput(runId, "A4");
  assertMarkerOriginalOnly(marker, "A4");
  writeOriginals();
}

async function scenarioB1(engineVersion: string): Promise<void> {
  console.log("\n=== B1. resume under a different engine build: loud refusal ===");
  const runId = "bra71-b1";
  const marker = path.join(WORKDIR, "bra71-b1.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  check(fs.existsSync(blobPath(runId)), `B1 BLOB: snapshot blob exists before the refused resume`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR], { AGENTTS_ENGINE_VERSION_OVERRIDE: FAKE_ENGINE });
  // cmdQueue "run" returns 1 when ANY entry in the queue is failed —
  // the b1 entry failed on this drive, so 1 is the expected rc.
  check(drive.rc === 1, `B1 DRIVE RC: queue run exited 1 (the b1 entry failed on this drive, got ${drive.rc})`);
  check(queueStatus(runId) === "failed", `B1 FAILED: entry marked failed (got ${queueStatus(runId)})`);
  const res = getResult(runId);
  check(res !== null && res.status === "failed", `B1 RESULT: result reports failed (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    typeof res?.error === "string" && res.error.includes("refusing to resume") && res.error.includes(engineVersion) && res.error.includes(FAKE_ENGINE),
    `B1 ERROR: refusal names the recorded engine (${engineVersion}) and the current engine (${FAKE_ENGINE}) (got ${JSON.stringify(res?.error)?.slice(0, 200)})`,
  );
  const evs = readJournal(runId);
  const mismatch = evs.find((e) => e.event === "engine-version-mismatch");
  check(mismatch !== undefined, "B1 JOURNAL: engine-version-mismatch event recorded");
  check(
    mismatch !== undefined && mismatch.recorded === engineVersion && mismatch.current === FAKE_ENGINE,
    `B1 JOURNAL: mismatch event carries recorded=${engineVersion} current=${FAKE_ENGINE}`,
  );
  check(fs.existsSync(blobPath(runId)), "B1 BLOB KEPT: snapshot blob still on disk after the refusal (restoring the matching engine can still resume it)");
  check(markerLines(marker).every((l) => l === "bra71-original"), "B1 MARKER: no edited marker ran (the resume never started)");
  writeOriginals();
}

async function scenarioB2(engineVersion: string): Promise<void> {
  console.log("\n=== B2. happy path: same engine resumes exactly as before ===");
  const runId = "bra71-b2";
  const marker = path.join(WORKDIR, "bra71-b2.marker");
  submit(WORKFLOW, runId, { markerFile: marker, sleepMs: 5000 });
  const child = await strandRun(runId, marker);
  children.push(child);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR]);
  // rc 1, not 0: the queue still holds the failed b1 entry from B1,
  // and cmdQueue "run" returns 1 when ANY entry is failed. b2 itself
  // completing is what this scenario asserts (below).
  check(drive.rc === 1, `B2 DRIVE RC: queue run exited 1 (stale failed b1 entry still in the queue, got ${drive.rc})`);
  assertOriginalOutput(runId, "B2");
  assertMarkerOriginalOnly(marker, "B2");
  // Engine-version stability: this run recorded the same version as B3's.
  const e = queueEntry(runId);
  check(e?.engineVersion === engineVersion, `B2 STABLE: recorded engine version matches B3's (${engineVersion})`);
  writeOriginals();
}

async function main(): Promise<void> {
  writeOriginals();
  try {
    const engineVersion = await scenarioB3();
    await scenarioInputInline();
    await scenarioA1();
    await scenarioA2();
    await scenarioA3();
    await scenarioA4();
    await scenarioB1(engineVersion);
    await scenarioB2(engineVersion);
  } finally {
    writeOriginals();
    for (const c of children) {
      try {
        c.kill(9);
      } catch {
        /* already dead */
      }
    }
  }
  console.log("");
  if (FAILURES.length) {
    console.log(`BRA71 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("BRA71 PASS: frozen copy + engine version check (G9+G10)");
  process.exit(0);
}

await main();
