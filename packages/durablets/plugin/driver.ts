#!/usr/bin/env bun
/**
 * DurableTS reference plugin + test driver (Linear BRA-43).
 *
 * TypeScript — C ONLY where the engine forces it. The C core is the thin
 * host CLI (src/durablets.c); everything policy lives here: the plugin's
 * trap handlers (canned, standing in for the environment adapter — see
 * plugin/adapter.ts, which is NOT built here), the scheduler (fork/join
 * orchestration), the queue (sequential in this reference driver), the
 * journal writer (plugin-side; the core writes no journal), the run
 * registry (maintained from the core's lifecycle events), and all CLI
 * tooling. No Muse knowledge anywhere in this package: the driver talks
 * to the core only through the blob + JSON over process spawn (v0, the
 * proven experiment shape — the TS host spawns the C host per run-slice).
 *
 * Ports the experiment drivers (agentts-all/drive.py, BRA-24/25/26, and
 * agentts-cancellation/drive.py, BRA-27) to TypeScript. The experiment
 * behavior is the spec; the language changes. Journal event shapes are
 * preserved, with two renames: step -> trap ({"event":"trap",...} with
 * a trapId) and "type" -> "event" (the core emits {"event":...} lines).
 *
 * Exit 0 on PASS, 1 on any mismatch. Run via ./run.sh (which builds
 * the C host first, then runs this file with bun).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
// The C host binary: run.sh sets DURABLETS_HOST to the scratch build;
// a direct `bun plugin/driver.ts` falls back to an in-tree build.
const HOST = process.env.DURABLETS_HOST || path.join(ROOT, "durablets");
const TESTS = path.join(ROOT, "tests");
// Test outputs (logs/snapshots/journals/blobs): run.sh sets
// DURABLETS_WORKDIR to a scratch dir; a direct run falls back to the
// in-tree test-runs dir. Either way the staged tree stays sources-only.
const WORKDIR = process.env.DURABLETS_WORKDIR || path.join(ROOT, "test-runs");
const STORE = path.join(WORKDIR, "store");

const FAILURES: string[] = [];
function fail(msg: string): void {
  console.log(`FAIL: ${msg}`);
  FAILURES.push(msg);
}

const prefixFor = (runId: string): string => runId.replace(/\//g, "_");
const sha = (p: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function readJournal(p: string): any[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function appendJournal(p: string, event: any): void {
  // BRA-57: stamp the wall-clock time, as the host and mock plugin
  // do — every journal event carries `wallTs` (journal format v2).
  if (event !== null && typeof event === "object" && !("wallTs" in event)) {
    event.wallTs = new Date().toISOString();
  }
  fs.appendFileSync(p, JSON.stringify(event) + "\n");
}

// ---------------------------------------------------------------- registry
// The run registry, maintained ONLY from the core's lifecycle events
// (started / suspended / resumed / completed / failed). The core is
// invoked per-slice and exits, so it cannot hold the registry across
// slices — the plugin owns it. A run leaves the registry on completed
// or failed. Harness fields (snap/out/log/env/kind/ordinal/fork) ride
// on the same entries; they are driver bookkeeping, not registry state.
interface RunEntry {
  runId: string;
  status: "running" | "suspended" | "done" | "failed";
  snap: string;
  out: string;
  log: string;
  env: Record<string, string>;
  rc: number | null;
  kind: "trap" | "combinator" | "done" | "error" | null;
  ordinal: number | null;
  fork: any | null;
  parentForkId: string | null;
  branch: number | null;
}
const REGISTRY = new Map<string, RunEntry>();
// Byte offsets consumed per log file, so each [durablets] event line is
// ingested exactly once.
const logOffsets = new Map<string, number>();

function journalPath(runId: string): string {
  return path.join(WORKDIR, prefixFor(runId) + ".journal");
}

function ingestLog(logPath: string): void {
  const prev = logOffsets.get(logPath) || 0;
  if (!fs.existsSync(logPath)) return;
  const buf = fs.readFileSync(logPath);
  if (buf.length <= prev) return;
  const text = buf.subarray(prev).toString("utf8");
  logOffsets.set(logPath, buf.length);
  for (const line of text.split("\n")) {
    const m = line.match(/^\[durablets\] (\{.*\})\s*$/);
    if (!m) continue;
    let ev: any;
    try {
      ev = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const runId: string = ev.runId;
    if (!runId) continue;
    // The plugin journals every core event (its journal, plugin-side).
    appendJournal(journalPath(runId), ev);
    // The registry follows lifecycle events only.
    if (ev.event === "lifecycle") {
      const e = REGISTRY.get(runId);
      if (e) {
        if (ev.lifecycle === "completed") e.status = "done";
        else if (ev.lifecycle === "failed") e.status = "failed";
        else if (ev.lifecycle === "suspended") e.status = "suspended";
        else e.status = "running"; // started / resumed
      }
      if (ev.lifecycle === "completed" || ev.lifecycle === "failed") {
        REGISTRY.delete(runId);
      }
    }
  }
}

function refresh(entry: RunEntry): void {
  const events = readJournal(journalPath(entry.runId));
  if (entry.rc === 2) {
    const traps = events.filter((e) => e.event === "trap");
    entry.kind = "trap";
    entry.ordinal = traps.length ? traps[traps.length - 1].ordinal : null;
    entry.fork = null;
  } else if (entry.rc === 3) {
    entry.kind = "combinator";
    const forks = events.filter((e) => e.event === "fork");
    entry.fork = forks.length ? forks[forks.length - 1] : null;
    entry.ordinal = null;
  } else if (entry.rc === 0) {
    entry.kind = "done";
  } else {
    entry.kind = "error";
  }
}

// ------------------------------------------------------------------- blobs
// The blob store is the plugin's. The core produces/consumes blob bytes
// at a path the plugin passes on the command line; it never chooses,
// lists, or stores blobs. After every suspension the plugin stores the
// blob (byte-identical copy, hash-checked); before every resume the
// plugin restores it from the store (hash-checked again). That is the
// suspend-to-blob / resume-blob round-trip, exercised on every slice.
function blobPath(runId: string): string {
  return path.join(STORE, prefixFor(runId) + ".blob");
}
function storeBlob(runId: string, snap: string): void {
  const b = blobPath(runId);
  fs.mkdirSync(STORE, { recursive: true });
  fs.copyFileSync(snap, b);
  if (sha(b) !== sha(snap)) fail(`blob store mismatch for ${runId}`);
}
function loadBlob(runId: string, snap: string): void {
  const b = blobPath(runId);
  if (!fs.existsSync(b)) {
    fail(`no stored blob for ${runId}`);
    return;
  }
  fs.copyFileSync(b, snap);
  if (sha(snap) !== sha(b)) fail(`blob restore mismatch for ${runId}`);
}

// -------------------------------------------------------------------- spawn
function runHost(
  args: string[],
  outPath: string,
  logPath: string,
  envExtra: Record<string, string>,
): number {
  const env = { ...process.env, ...envExtra } as Record<string, string>;
  fs.appendFileSync(outPath, "");
  fs.appendFileSync(logPath, "");
  const r = spawnSync(HOST, args, { env, encoding: "utf8" });
  if (r.stdout) fs.appendFileSync(outPath, r.stdout);
  if (r.stderr) fs.appendFileSync(logPath, r.stderr);
  if (r.error) {
    fail(`host spawn failed: ${r.error}`);
    return 1;
  }
  ingestLog(logPath);
  return r.status ?? 1;
}

// ------------------------------------------------------------ trap handlers
// Canned trap handlers — the reference plugin's stand-in for the
// environment adapter (plugin/adapter.ts). In the real host these call
// the adapter (spawnJob / runExec / deliverGate / ...); here they answer
// from a table, exactly as the experiments' mock did.
const MOCK: Record<string, any> = {
  "score:7": { score: 0.92, label: "approved" },
  "verify:7": { score: 0.97, label: "verified" },
  "score:3": { score: 0.41, label: "weak" },
  "verify:3": { score: 0.88, label: "retried" },
  "score:5": { score: 0.63, label: "approved" },
  "score:9": { score: 0.31, label: "slow" },
  "score:11": { score: 0.9, label: "approved" },
  "score:12": { score: 0.85, label: "approved" },
  "score:21": { score: 0.21, label: "g21" },
  "score:22": { score: 0.22, label: "g22" },
  "score:23": { score: 0.23, label: "g23" },
};

function mockJob(arg: any): any {
  // New agentts-module shape (BRA-46): { spec, input }. The jobspec name
  // selects the canned result; the input carries the parameters.
  if (arg && typeof arg.spec === "string") {
    // BRA-47: the cascade's job tier ("decision" jobspec). No canned
    // decision exists — the mock answers the first option at 0.5, a
    // deliberate guess: a cascade tier at/above its threshold would
    // need a queued answer, and an unconfigured mock run escalates
    // instead of deciding on a made-up confidence. (Same answer as
    // the host mock adapter and the mock plugin.)
    if (arg.spec === "decision") {
      const options: string[] = Array.isArray(arg.input?.options) ? arg.input.options : [];
      return {
        choice: options[0] ?? "yes",
        confidence: 0.5,
        reason: "mock default: no canned decision answer; first option at 0.5",
      };
    }
    if (arg.spec === "aggregate") {
      const verdicts = arg.input?.verdicts || [];
      const ok = verdicts.filter((v: any) => v.ok).length;
      return {
        approved: ok,
        failed: verdicts.length - ok,
        summary: `${ok} approved, ${verdicts.length - ok} failed`,
      };
    }
    const key = `${arg.spec}:${arg.input?.value}`;
    if (key in MOCK) return MOCK[key];
    console.error(`[mock] no canned result for ${key}; using default`);
    return { score: 0.5, label: "default" };
  }
  // Old direct-trap shape { op, value, verdicts } (workflow-*.ts).
  if (arg && arg.op === "aggregate") {
    const verdicts = arg.verdicts || [];
    const ok = verdicts.filter((v: any) => v.ok).length;
    return {
      approved: ok,
      failed: verdicts.length - ok,
      summary: `${ok} approved, ${verdicts.length - ok} failed`,
    };
  }
  const key = `${arg?.op}:${arg?.value}`;
  if (key in MOCK) return MOCK[key];
  console.error(`[mock] no canned result for ${key}; using default`);
  return { score: 0.5, label: "default" };
}

/** A trap answer: { value } to resume with a value, { throw: err } to
 * resume throwing. `throwOverrides` lets one test force throws. */
const throwOverrides = new Map<string, (type: string, arg: any) => any>();
function dispatchTrap(
  runId: string,
  type: string,
  arg: any,
): { value?: any; throw?: any } {
  const over = throwOverrides.get(runId);
  if (over) {
    const t = over(type, arg);
    if (t !== undefined) return t;
  }
  switch (type) {
    case "job":
      return { value: mockJob(arg) };
    case "exec":
      return {
        value:
          arg?.cmd === "echo hi"
            ? { stdout: "hi\n", exitCode: 0 }
            : { stdout: "", exitCode: 0 },
      };
    case "gate":
      return { value: { answer: "yes" } };
    case "sleep":
      return { value: { sleptMs: arg?.ms ?? 0 } };
    case "cron":
      return { value: { scheduled: arg?.at } };
    case "decide":
      return { value: { choice: "a", confidence: 0.9 } };
    default:
      console.error(`[mock] unknown trap type ${type}; using default`);
      return { value: { score: 0.5, label: "default" } };
  }
}

function lastTrap(logPath: string): any | null {
  if (!fs.existsSync(logPath)) return null;
  let last: any = null;
  for (const line of fs.readFileSync(logPath, "utf8").split("\n")) {
    const m = line.match(/^\[durablets\] (\{.*\})\s*$/);
    if (!m) continue;
    try {
      const ev = JSON.parse(m[1]);
      if (ev.event === "trap") last = ev;
    } catch {
      /* ignore */
    }
  }
  return last;
}
function lastFork(journal: string): any | null {
  const forks = readJournal(journal).filter((e) => e.event === "fork");
  return forks.length ? forks[forks.length - 1] : null;
}
function forksOf(journal: string): any[] {
  return readJournal(journal).filter((e) => e.event === "fork");
}
function parseOutLines(outPath: string): Record<string, string> {
  const lines: Record<string, string> = {};
  if (!fs.existsSync(outPath)) return lines;
  for (const line of fs.readFileSync(outPath, "utf8").split("\n")) {
    const s = line.replace(/\n$/, "");
    const i = s.indexOf(": ");
    if (i >= 0) lines[s.slice(0, i)] = s.slice(i + 2);
  }
  return lines;
}
function branchOutcome(outPath: string, index: number): any | null {
  if (!fs.existsSync(outPath)) return null;
  const prefix = `branch ${index} outcome: `;
  for (const line of fs.readFileSync(outPath, "utf8").split("\n")) {
    if (line.startsWith(prefix)) {
      try {
        return JSON.parse(line.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// -------------------------------------------------------------------- drive
function clean(prefix: string): void {
  for (const f of fs.readdirSync(WORKDIR)) {
    if (f.startsWith(prefix + ".")) {
      fs.rmSync(path.join(WORKDIR, f));
      logOffsets.delete(path.join(WORKDIR, f));
    }
  }
}

/** Generate the driver for a workflow and bundle it (sync — the
 * driver's startRun is sync, so the build goes through `bun build`
 * as a subprocess, not the async Bun.build API). The driver is
 * global code that arms the entry guard (__agentts_begin) and calls
 * the workflow's exported entry function with no arguments (core
 * workflows are 0-arg; they take no input). Refuses loudly when the
 * bundle still contains export/import syntax after the build — a
 * bundle the C host would eval as a module (which cannot suspend)
 * is a broken run, not a run to ship. Returns the bundle path. */
function bundleWorkflow(workflow: string, runId: string): string {
  const p = prefixFor(runId);
  const abs = path.resolve(workflow);
  const driverPath = path.join(WORKDIR, `${p}.driver.ts`);
  const bundlePath = path.join(WORKDIR, `${p}.bundle.js`);
  const driver =
    `// Core-driver-generated driver for ${runId} (not author code): arm the\n` +
    `// entry guard, then call the workflow's exported entry function\n` +
    `// from global code.\n` +
    `import entry from ${JSON.stringify(abs)};\n` +
    `declare function __agentts_begin(): void;\n` +
    `__agentts_begin();\n` +
    `entry();\n`;
  fs.writeFileSync(driverPath, driver);
  const r = spawnSync(process.execPath, [
    "build",
    driverPath,
    "--outfile",
    bundlePath,
    "--target",
    "bun",
  ], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(bundlePath)) {
    fail(`bundleWorkflow: bun build failed for ${runId}: ${r.stderr ?? r.error ?? ""}`);
    throw new Error(`bun build failed for ${runId}`);
  }
  const text = fs.readFileSync(bundlePath, "utf8");
  if (/^\s*export\s/m.test(text) || /^\s*import\s/m.test(text)) {
    fail(`bundleWorkflow: bundle ${bundlePath} still contains export/import syntax — refusing to run it`);
    throw new Error(`bundle ${bundlePath} still contains export/import syntax`);
  }
  return bundlePath;
}

function startRunFrom(bundle: string, runId: string): number {
  const p = prefixFor(runId);
  const env = { AGENTTS_RUN_ID: runId };
  const rc = runHost(
    ["run", bundle, path.join(WORKDIR, p + ".snap")],
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    env,
  );
  const entry: RunEntry = {
    runId,
    status: rc === 0 ? "done" : rc === 2 || rc === 3 ? "suspended" : "running",
    snap: path.join(WORKDIR, p + ".snap"),
    out: path.join(WORKDIR, p + ".out"),
    log: path.join(WORKDIR, p + ".log"),
    env,
    rc,
    kind: null,
    ordinal: null,
    fork: null,
    parentForkId: null,
    branch: null,
  };
  REGISTRY.set(runId, entry);
  refresh(entry);
  if (rc === 2 || rc === 3) storeBlob(runId, entry.snap);
  else REGISTRY.delete(runId); // completed in one slice: closed already
  return rc;
}

function startRun(workflow: string, runId: string): number {
  // Clean BEFORE bundling: clean() deletes <prefix>.* in WORKDIR,
  // which now includes the driver + bundle (same prefix, same dir)
  // — bundling first would delete the bundle before the C host runs.
  clean(prefixFor(runId));
  const bundle = bundleWorkflow(workflow, runId);
  return startRunFrom(bundle, runId);
}

function deliverResult(runId: string, result: any): number {
  const entry = REGISTRY.get(runId)!;
  loadBlob(runId, entry.snap);
  const rc = runHost(
    ["resume", entry.snap, JSON.stringify(result)],
    entry.out,
    entry.log,
    entry.env,
  );
  entry.rc = rc;
  refresh(entry);
  if (rc === 2 || rc === 3) storeBlob(runId, entry.snap);
  return rc;
}

function deliverThrow(runId: string, err: any): number {
  const entry = REGISTRY.get(runId)!;
  loadBlob(runId, entry.snap);
  const rc = runHost(
    ["resume", entry.snap, "throw:" + JSON.stringify(err)],
    entry.out,
    entry.log,
    entry.env,
  );
  entry.rc = rc;
  refresh(entry);
  if (rc === 2 || rc === 3) storeBlob(runId, entry.snap);
  return rc;
}

function recordCancel(child: string, forkId: string, branch: number, trigger: string, extra: any = {}): void {
  // The scheduler (this plugin) cancels a never-spawned sibling by
  // refusing to spawn it and recording the cancellation in its journal
  // — same as the experiments; in the real host the same decision kills
  // a live child process (Q14).
  const event = {
    event: "cancel",
    runId: child,
    parentForkId: forkId,
    branch,
    trigger,
    ...extra,
  };
  appendJournal(journalPath(child), event);
}

function startBranch(
  child: string,
  snap: string,
  index: number,
  env: Record<string, string>,
  forkId: string,
): number {
  const cprefix = prefixFor(child);
  const csnap = path.join(WORKDIR, cprefix + ".snap");
  clean(cprefix);
  fs.copyFileSync(snap, csnap);
  fs.writeFileSync(path.join(WORKDIR, cprefix + ".out"), "");
  fs.writeFileSync(path.join(WORKDIR, cprefix + ".log"), "");
  const cenv = {
    ...env,
    AGENTTS_RUN_ID: child,
    AGENTTS_PARENT_FORK: forkId,
  };
  const rc = runHost(
    ["branch", csnap, String(index)],
    path.join(WORKDIR, cprefix + ".out"),
    path.join(WORKDIR, cprefix + ".log"),
    cenv,
  );
  const entry: RunEntry = {
    runId: child,
    status: rc === 0 ? "done" : rc === 2 || rc === 3 ? "suspended" : "running",
    snap: csnap,
    out: path.join(WORKDIR, cprefix + ".out"),
    log: path.join(WORKDIR, cprefix + ".log"),
    env: cenv,
    rc,
    kind: null,
    ordinal: null,
    fork: null,
    parentForkId: forkId,
    branch: index,
  };
  REGISTRY.set(child, entry);
  refresh(entry);
  if (rc === 2 || rc === 3) storeBlob(child, csnap);
  else REGISTRY.delete(child); // completed in one slice: closed already
  return rc;
}

function runOneBranch(
  children: string[],
  i: number,
  snap: string,
  env: Record<string, string>,
  forkId: string,
): { outcome: any; outcomePath: string } | null {
  const child = children[i];
  const cprefix = prefixFor(child);
  const crc = startBranch(child, snap, i, env, forkId);
  const rc = drive(
    path.join(WORKDIR, cprefix + ".snap"),
    path.join(WORKDIR, cprefix + ".out"),
    path.join(WORKDIR, cprefix + ".log"),
    crc,
    child,
  );
  if (rc !== 0) {
    fail(`branch ${child} exited ${rc}`);
    return null;
  }
  const outcome = branchOutcome(path.join(WORKDIR, cprefix + ".out"), i);
  if (outcome === null) {
    fail(`no outcome for ${child}`);
    return null;
  }
  const outcomePath = path.join(WORKDIR, cprefix + ".outcome.json");
  fs.writeFileSync(outcomePath, JSON.stringify(outcome));
  return { outcome, outcomePath };
}

function snapUntouched(snap: string, before: string): boolean {
  if (sha(snap) !== before) {
    fail(`${snap} changed while children ran (parent snapshot not untouched)`);
    return false;
  }
  return true;
}

function doAllJoin(
  snap: string,
  outPath: string,
  logPath: string,
  env: Record<string, string>,
  fork: any,
): number {
  const prefix = prefixFor(fork.runId);
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const failFast = !!fork.failFast;
  const before = sha(snap);
  const outcomes: string[] = [];
  const completed: any[] = [];
  let failedBranch: number | null = null;
  let failedError: any = null;
  const cancelled: number[] = [];
  for (let i = 0; i < children.length; i++) {
    const r = runOneBranch(children, i, snap, env, forkId);
    if (!r) return 1;
    completed.push(r.outcome);
    outcomes.push(r.outcomePath);
    if (failFast && !r.outcome.ok) {
      failedBranch = i;
      failedError = r.outcome.error;
      for (let j = i + 1; j < children.length; j++) {
        cancelled.push(j);
        recordCancel(children[j], forkId, j, "sibling failed with fail-fast on", {
          failedBranch,
          error: failedError,
        });
      }
      break;
    }
  }
  if (!snapUntouched(snap, before)) return 1;
  if (failFast && failedBranch !== null) {
    const record = {
      failedBranch,
      error: failedError,
      cancelled,
      completed: completed.slice(0, -1),
    };
    const recordPath = path.join(WORKDIR, prefix + ".join-throw.json");
    fs.writeFileSync(recordPath, JSON.stringify(record));
    loadBlob(fork.runId, snap);
    return runHost(["join-throw", snap, recordPath], outPath, logPath, env);
  }
  if (failFast) {
    const valueFiles: string[] = [];
    for (let k = 0; k < completed.length; k++) {
      const vpath = path.join(WORKDIR, `${prefix}.join-value-${k}.json`);
      fs.writeFileSync(vpath, JSON.stringify(completed[k].value));
      valueFiles.push(vpath);
    }
    loadBlob(fork.runId, snap);
    return runHost(["join", snap, ...valueFiles], outPath, logPath, env);
  }
  loadBlob(fork.runId, snap);
  return runHost(["join", snap, ...outcomes], outPath, logPath, env);
}

function doAnyJoin(
  snap: string,
  outPath: string,
  logPath: string,
  env: Record<string, string>,
  fork: any,
): number {
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const before = sha(snap);
  const errors: any[] = [];
  const completed: any[] = [];
  for (let i = 0; i < children.length; i++) {
    const r = runOneBranch(children, i, snap, env, forkId);
    if (!r) return 1;
    if (r.outcome.ok) {
      const cancelled: number[] = [];
      for (let j = i + 1; j < children.length; j++) {
        cancelled.push(j);
        recordCancel(children[j], forkId, j, "loser in any", { winner: i });
      }
      if (!snapUntouched(snap, before)) return 1;
      const record = { value: r.outcome.value, winner: i, cancelled, completed };
      const recordPath = path.join(WORKDIR, prefixFor(forkId) + ".join-value.json");
      fs.writeFileSync(recordPath, JSON.stringify(record));
      loadBlob(fork.runId, snap);
      return runHost(["join-value", snap, recordPath], outPath, logPath, env);
    }
    errors.push(r.outcome.error);
    completed.push(r.outcome);
  }
  if (!snapUntouched(snap, before)) return 1;
  const record = { errors, completed, cancelled: [] };
  const recordPath = path.join(WORKDIR, prefixFor(forkId) + ".join-aggregate.json");
  fs.writeFileSync(recordPath, JSON.stringify(record));
  loadBlob(fork.runId, snap);
  return runHost(["join-aggregate", snap, recordPath], outPath, logPath, env);
}

function doRaceJoin(
  snap: string,
  outPath: string,
  logPath: string,
  env: Record<string, string>,
  fork: any,
): number {
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const before = sha(snap);
  const r = runOneBranch(children, 0, snap, env, forkId);
  if (!r) return 1;
  const cancelled: number[] = [];
  for (let j = 1; j < children.length; j++) {
    cancelled.push(j);
    recordCancel(children[j], forkId, j, "loser in race", { winner: 0 });
  }
  if (!snapUntouched(snap, before)) return 1;
  if (r.outcome.ok) {
    const record = { value: r.outcome.value, winner: 0, cancelled, completed: [] };
    const recordPath = path.join(WORKDIR, prefixFor(forkId) + ".join-value.json");
    fs.writeFileSync(recordPath, JSON.stringify(record));
    loadBlob(fork.runId, snap);
    return runHost(["join-value", snap, recordPath], outPath, logPath, env);
  }
  const record = {
    failedBranch: 0,
    error: r.outcome.error,
    cancelled,
    completed: [],
  };
  const recordPath = path.join(WORKDIR, prefixFor(forkId) + ".join-throw.json");
  fs.writeFileSync(recordPath, JSON.stringify(record));
  loadBlob(fork.runId, snap);
  return runHost(["join-throw", snap, recordPath], outPath, logPath, env);
}

/** Drive one run to completion. rc is the exit code of the invocation
 * that started it (2 = suspended at a trap, 3 = suspended at a
 * combinator). allowUnresolved is only for race([]): a 0-branch fork
 * never settles, so a bounded drive observes it still suspended. */
function drive(
  snap: string,
  outPath: string,
  logPath: string,
  rc: number,
  runId: string,
  allowUnresolved = false,
): number {
  const journal = journalPath(runId);
  const env = { AGENTTS_RUN_ID: runId };
  let rounds = 0;
  while (rc === 2 || rc === 3) {
    rounds++;
    if (rounds > 50) {
      fail(`drive loop exceeded for ${runId}`);
      return 1;
    }
    if (rc === 2) {
      const trapEv = lastTrap(logPath);
      if (!trapEv) {
        fail(`no trap event in ${logPath} for ${runId}`);
        return 1;
      }
      const ans = dispatchTrap(runId, trapEv.type, trapEv.arg);
      if ("throw" in ans) rc = deliverThrow(runId, ans.throw);
      else rc = deliverResult(runId, ans.value);
    } else {
      const fork = lastFork(journal);
      if (!fork) {
        fail(`no fork event in ${journal} for ${runId}`);
        return 1;
      }
      if (!fork.childRuns.length) {
        if (allowUnresolved) return 3;
        fail(`fork ${fork.forkId} has no children and the drive is not bounded`);
        return 1;
      }
      if (fork.kind === "all") rc = doAllJoin(snap, outPath, logPath, env, fork);
      else if (fork.kind === "any") rc = doAnyJoin(snap, outPath, logPath, env, fork);
      else if (fork.kind === "race") rc = doRaceJoin(snap, outPath, logPath, env, fork);
      else {
        fail(`unknown fork kind ${fork.kind} in ${journal}`);
        return 1;
      }
      // A join/resume that suspends again produced a fresh blob: store it.
      const entry = REGISTRY.get(runId);
      if (entry) {
        entry.rc = rc;
        refresh(entry);
        if (rc === 2 || rc === 3) storeBlob(runId, snap);
      }
    }
  }
  return rc;
}

// --------------------------------------------------------------- cancellation
function cancelRun(runId: string, reason: string, trigger: string, cancelled: string[] | null = null): number | null {
  const entry = REGISTRY.get(runId)!;
  if (entry.rc !== 2 && entry.rc !== 3) return null;
  const p = prefixFor(runId);
  const record: any = { reason, trigger };
  if (entry.kind === "trap") {
    record.what = "trap";
    record.ordinal = entry.ordinal;
  } else {
    record.what = "fork";
    record.forkId = entry.fork.forkId;
    record.cancelled = cancelled || [];
  }
  if (entry.parentForkId !== null) {
    record.parentForkId = entry.parentForkId;
    record.branch = entry.branch;
  }
  const recordPath = path.join(WORKDIR, p + ".cancel.json");
  fs.writeFileSync(recordPath, JSON.stringify(record));
  loadBlob(runId, entry.snap);
  const rc = runHost(["cancel", entry.snap, recordPath], entry.out, entry.log, entry.env);
  entry.rc = rc;
  refresh(entry);
  if (rc === 2 || rc === 3) storeBlob(runId, entry.snap);
  return rc;
}

function cancelTree(runId: string, reason: string, trigger: string): string[] {
  const cancelled: string[] = [];
  const entry = REGISTRY.get(runId);
  if (!entry || (entry.rc !== 2 && entry.rc !== 3)) return cancelled;
  const direct: string[] = [];
  for (const fork of forksOf(journalPath(runId))) {
    for (const child of fork.childRuns || []) {
      const ce = REGISTRY.get(child);
      if (ce && (ce.rc === 2 || ce.rc === 3)) {
        cancelled.push(...cancelTree(child, reason, "parent cancelled"));
        direct.push(child);
      }
    }
  }
  const rc = cancelRun(runId, reason, trigger, direct);
  if (rc !== null) cancelled.push(runId);
  return cancelled;
}

function checkCancelEvent(
  events: any[],
  runId: string,
  what: string,
  trigger: string,
  reason: string,
  extra: Record<string, any> = {},
): any | null {
  const cancels = events.filter((e) => e.event === "cancel");
  if (cancels.length !== 1) {
    fail(`${runId}: expected 1 cancel event, got ${cancels.length}: ${JSON.stringify(events)}`);
    return null;
  }
  const c = cancels[0];
  if (c.what !== what) fail(`${runId}: cancel what ${c.what} != ${what}: ${JSON.stringify(c)}`);
  if (c.trigger !== trigger) fail(`${runId}: cancel trigger ${c.trigger} != ${trigger}: ${JSON.stringify(c)}`);
  if (c.reason !== reason) fail(`${runId}: cancel reason ${c.reason} != ${reason}: ${JSON.stringify(c)}`);
  if (typeof c.when !== "number" || c.when <= 0)
    fail(`${runId}: cancel when missing or not a positive integer: ${JSON.stringify(c)}`);
  for (const [k, v] of Object.entries(extra)) {
    if (JSON.stringify(c[k]) !== JSON.stringify(v))
      fail(`${runId}: cancel ${k} ${JSON.stringify(c[k])} != ${JSON.stringify(v)}: ${JSON.stringify(c)}`);
  }
  return c;
}

// --------------------------------------------------------------------- tests
function runTest(
  name: string,
  workflow: string,
  direct: string,
  runId: string,
  branches: number,
): { parentOut: string; parentJournal: string; runId: string; branches: number } | null {
  console.log(`\n=== ${name} ===`);
  const p = prefixFor(runId);
  const d = prefixFor(runId + "-direct");
  // Straight-through reference.
  let rc = startRun(path.join(TESTS, direct), runId + "-direct");
  rc = drive(
    path.join(WORKDIR, d + ".snap"),
    path.join(WORKDIR, d + ".out"),
    path.join(WORKDIR, d + ".log"),
    rc,
    runId + "-direct",
  );
  if (rc !== 0) {
    fail(`${name}: direct reference exited ${rc}`);
    return null;
  }
  console.log(`--- direct output ---`);
  console.log(fs.readFileSync(path.join(WORKDIR, d + ".out"), "utf8"));

  // Fork version: the parent suspends at a combinator (exit 3).
  // Every workflow goes through the driver + bundle now (a function
  // workflow is not runnable as a bare script) — startRun bundles
  // the driver for it.
  if (REGISTRY.size !== 0) {
    fail(`${name}: registry not empty before fork run (leftover runs)`);
    return null;
  }
  rc = startRun(path.join(TESTS, workflow), runId);
  if (rc !== 3) {
    fail(`${name}: parent run exited ${rc}, expected 3 (suspended at a combinator)`);
    return null;
  }
  console.log(
    `parent suspended at a combinator, snapshot ${fs.statSync(path.join(WORKDIR, p + ".snap")).size} bytes`,
  );
  // Registry: the parent is in-flight while suspended.
  if (!REGISTRY.has(runId) || REGISTRY.get(runId)!.status !== "suspended") {
    fail(`${name}: registry does not hold suspended parent ${runId}`);
    return null;
  }
  rc = drive(
    path.join(WORKDIR, p + ".snap"),
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    rc,
    runId,
  );
  if (rc !== 0) {
    fail(`${name}: parent exited ${rc}`);
    return null;
  }
  console.log(`--- parent output ---`);
  console.log(fs.readFileSync(path.join(WORKDIR, p + ".out"), "utf8"));
  const parentOut = fs.readFileSync(path.join(WORKDIR, p + ".out"));
  const directOut = fs.readFileSync(path.join(WORKDIR, d + ".out"));
  if (parentOut.equals(directOut)) {
    console.log("OUTPUT MATCH: parent byte-identical to direct reference");
  } else {
    fail(`${name}: parent output differs from direct reference`);
    for (const [a, b] of zipLines(parentOut.toString(), directOut.toString())) {
      if (a !== b) console.log(`  parent: ${a}\n  direct: ${b}`);
    }
  }
  // Registry: every run closed on finish.
  if (REGISTRY.size !== 0) {
    fail(`${name}: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
  }
  return {
    parentOut: path.join(WORKDIR, p + ".out"),
    parentJournal: path.join(WORKDIR, p + ".journal"),
    runId,
    branches,
  };
}
function zipLines(a: string, b: string): [string, string][] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const out: [string, string][] = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i++) out.push([al[i] ?? "", bl[i] ?? ""]);
  return out;
}

function checkJournalPair(
  name: string,
  journalPath_: string,
  forkId: string,
  branches: number,
  verdicts: any[],
): void {
  const events = readJournal(journalPath_);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  if (forks.length !== 1) {
    fail(`${name}: expected 1 fork event, got ${forks.length}`);
    return;
  }
  const fork = forks[0];
  if (fork.forkId !== forkId) fail(`${name}: fork id ${fork.forkId} != ${forkId}`);
  if (fork.kind !== "all" || fork.branches !== branches)
    fail(`${name}: fork event kind/branches wrong: ${JSON.stringify(fork)}`);
  if ((fork.childRuns || []).length !== branches)
    fail(`${name}: childRuns length != ${branches}: ${JSON.stringify(fork)}`);
  if (joins.length !== 1) {
    fail(`${name}: expected 1 join event, got ${joins.length}`);
    return;
  }
  if (joins[0].forkId !== forkId)
    fail(`${name}: join fork id ${joins[0].forkId} != ${forkId}`);
  if (JSON.stringify(joins[0].outcome) !== JSON.stringify(verdicts))
    fail(`${name}: join outcome != verdicts:\n  ${JSON.stringify(joins[0].outcome)}\n  vs\n  ${JSON.stringify(verdicts)}`);
  for (let i = 0; i < (fork.childRuns || []).length; i++) {
    const child = fork.childRuns[i];
    const cevents = readJournal(journalPath(child));
    const starts = cevents.filter((e) => e.event === "branch-start");
    const dones = cevents.filter((e) => e.event === "branch-done");
    if (starts.length !== 1 || starts[0].parentForkId !== forkId)
      fail(`${name}: child ${child} branch-start missing/wrong parentForkId: ${JSON.stringify(starts)}`);
    if (dones.length !== 1 || dones[0].parentForkId !== forkId)
      fail(`${name}: child ${child} branch-done missing/wrong parentForkId: ${JSON.stringify(dones)}`);
    else if (JSON.stringify(dones[0].outcome) !== JSON.stringify(verdicts[i]))
      fail(`${name}: child ${child} branch-done outcome != verdicts[${i}]: ${JSON.stringify(dones[0].outcome)}`);
  }
}

function testJudges(): void {
  const r = runTest(
    "judges (3 simulated judges, one throws)",
    "workflow-judges.ts",
    "workflow-judges-direct.ts",
    "run-judges",
    3,
  );
  if (!r) return;
  const lines = parseOutLines(r.parentOut);
  const verdicts = JSON.parse(lines["verdicts"]);
  const expected = [
    { ok: true, value: "approved/verified" },
    { ok: true, value: "weak/retried" },
    { ok: false, error: { name: "Error", message: "judge crashed" } },
  ];
  if (JSON.stringify(verdicts) !== JSON.stringify(expected))
    fail(`judges: verdicts != expected:\n  ${JSON.stringify(verdicts)}\n  vs\n  ${JSON.stringify(expected)}`);
  else console.log("OUTCOMES OK: failed branch is { ok: false, error }");
  const agg = JSON.parse(lines["aggregate"]);
  if (JSON.stringify(agg) !== JSON.stringify({ approved: 2, failed: 1, summary: "2 approved, 1 failed" }))
    fail(`judges: aggregate != expected: ${JSON.stringify(agg)}`);
  else console.log("AGGREGATE OK: 2 approved, 1 failed");
  checkJournalPair("judges", r.parentJournal, "run-judges/fork-0", 3, verdicts);
}

function testGlobal(): void {
  const r = runTest(
    "global state (branch write discarded)",
    "workflow-global.ts",
    "workflow-global-direct.ts",
    "run-global",
    3,
  );
  if (!r) return;
  const lines = parseOutLines(r.parentOut);
  const verdicts = JSON.parse(lines["verdicts"]);
  const expected = [
    { ok: true, value: "read:0" },
    { ok: true, value: "read:99" },
    { ok: true, value: "read:0" },
  ];
  if (JSON.stringify(verdicts) !== JSON.stringify(expected))
    fail(`global: verdicts != expected:\n  ${JSON.stringify(verdicts)}\n  vs\n  ${JSON.stringify(expected)}`);
  else console.log("GLOBAL READ OK: branches saw fork-time sharedCount=0; the writing branch read its own 99");
  if (lines["empty all"] !== "[]") fail(`global: all([]) != []: ${lines["empty all"]}`);
  else console.log("EMPTY all([]) OK: [] with no fork");
  if (lines["sharedCount after join"] !== "0")
    fail(`global: sharedCount after join != 0: ${lines["sharedCount after join"]}`);
  else console.log("GLOBAL WRITE DISCARDED OK: parent sharedCount still 0");
  checkJournalPair("global", r.parentJournal, "run-global/fork-0", 3, verdicts);
}

function testNested(): void {
  const r = runTest(
    "nested all() (branch fans out again)",
    "workflow-nested.ts",
    "workflow-nested-direct.ts",
    "run-nested",
    2,
  );
  if (!r) return;
  const lines = parseOutLines(r.parentOut);
  const verdicts = JSON.parse(lines["verdicts"]);
  const nested = [
    { ok: true, value: "approved" },
    { ok: true, value: "approved" },
  ];
  const expected = [
    { ok: true, value: "approved/nested=" + JSON.stringify(nested) },
    { ok: true, value: "weak/retried" },
  ];
  if (JSON.stringify(verdicts) !== JSON.stringify(expected))
    fail(`nested: verdicts != expected:\n  ${JSON.stringify(verdicts)}\n  vs\n  ${JSON.stringify(expected)}`);
  else console.log("NESTED OK: branch 0 joined its own sub-judges");
  checkJournalPair("nested", r.parentJournal, "run-nested/fork-0", 2, verdicts);
  const nestedFork = "run-nested/fork-0/branch-0/fork-0";
  checkJournalPair("nested-inner", journalPath("run-nested/fork-0/branch-0"), nestedFork, 2, nested);
}

function testFailfast(): void {
  const r = runTest(
    "fail-fast bool on all()",
    "workflow-failfast.ts",
    "workflow-failfast-direct.ts",
    "run-failfast",
    3,
  );
  if (!r) return;
  const outLines = fs.readFileSync(r.parentOut, "utf8").split("\n");
  const lines = parseOutLines(r.parentOut);
  const values = JSON.parse(lines["values"]);
  if (JSON.stringify(values) !== JSON.stringify(["approved/verified", "weak/retried"]))
    fail(`fail-fast: values != bare values in order: ${JSON.stringify(values)}`);
  else console.log("FAIL-FAST SUCCESS OK: bare values in order");
  const collected = JSON.parse(lines["collected false"]);
  const expectedCollected = [
    { ok: true, value: "approved/verified" },
    { ok: false, error: { name: "Error", message: "judge crashed" } },
  ];
  if (JSON.stringify(collected) !== JSON.stringify(expectedCollected))
    fail(`fail-fast: collected false != collect-all outcomes:\n  ${JSON.stringify(collected)}\n  vs\n  ${JSON.stringify(expectedCollected)}`);
  else console.log("EXPLICIT FALSE OK: all([...], false) is collect-all");
  if (lines["caught is Error"] !== "true") fail("fail-fast: caught error is not a rehydrated Error");
  else console.log("REHYDRATION OK: caught value is a real Error");
  if (!outLines.includes("finally ran")) fail("fail-fast: finally block did not run after the throw");
  else console.log("FINALLY OK: finally block ran after the throw");
  if (lines["caught"] !== "judge crashed") fail(`fail-fast: caught != 'judge crashed': ${lines["caught"]}`);
  else console.log("CATCH OK: parent caught the first branch error");
  const continued = JSON.parse(lines["continued"]);
  if (JSON.stringify(continued) !== JSON.stringify({ score: 0.9, label: "approved" }))
    fail(`fail-fast: parent did not continue after the catch: ${JSON.stringify(continued)}`);
  else console.log("CONTINUE OK: parent called a further trap after catching");
  if (lines["first failure"] !== "judge timed out")
    fail(`fail-fast: first failure != branch 1's error ('judge timed out'): ${lines["first failure"]}`);
  else console.log("FIRSTNESS OK: the first failure's error was thrown, not the later one");
  checkFailfastJournal(r.parentJournal, "run-failfast");
}

function checkFailfastJournal(journalPath_: string, runId: string): void {
  const events = readJournal(journalPath_);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  if (forks.length !== 4 || joins.length !== 4) {
    fail(`fail-fast journal: expected 4 forks + 4 joins, got ${forks.length} + ${joins.length}`);
    return;
  }
  if (forks[0].failFast !== true) fail(`fail-fast journal: fork-0 failFast != true`);
  if (JSON.stringify(joins[0].outcome) !== JSON.stringify(["approved/verified", "weak/retried"]))
    fail(`fail-fast journal: fork-0 join outcome != bare values: ${JSON.stringify(joins[0].outcome)}`);
  else console.log("JOURNAL OK: fork-0 join recorded the bare values");
  if (forks[1].failFast !== false) fail(`fail-fast journal: fork-1 failFast != false`);
  if (JSON.stringify(joins[1].outcome) !== JSON.stringify([
    { ok: true, value: "approved/verified" },
    { ok: false, error: { name: "Error", message: "judge crashed" } },
  ]))
    fail(`fail-fast journal: fork-1 join outcome != outcomes: ${JSON.stringify(joins[1].outcome)}`);
  else console.log("JOURNAL OK: fork-1 join recorded the outcome objects");
  const j2 = joins[2];
  if (j2.failedBranch !== 1) fail(`fail-fast journal: fork-2 failedBranch != 1: ${JSON.stringify(j2)}`);
  if (JSON.stringify(j2.error) !== JSON.stringify({ name: "Error", message: "judge crashed" }))
    fail(`fail-fast journal: fork-2 error wrong: ${JSON.stringify(j2)}`);
  if (JSON.stringify(j2.cancelled) !== JSON.stringify([2]))
    fail(`fail-fast journal: fork-2 cancelled != [2]: ${JSON.stringify(j2)}`);
  if (JSON.stringify(j2.completed) !== JSON.stringify([{ ok: true, value: "approved/verified" }]))
    fail(`fail-fast journal: fork-2 completed wrong: ${JSON.stringify(j2)}`);
  else console.log("JOURNAL OK: fork-2 join recorded the thrown error, failed branch 1, cancelled [2]");
  const j3 = joins[3];
  if (j3.failedBranch !== 1) fail(`fail-fast journal: fork-3 failedBranch != 1: ${JSON.stringify(j3)}`);
  if (JSON.stringify(j3.error) !== JSON.stringify({ name: "Error", message: "judge timed out" }))
    fail(`fail-fast journal: fork-3 error wrong: ${JSON.stringify(j3)}`);
  if (JSON.stringify(j3.cancelled) !== JSON.stringify([2]))
    fail(`fail-fast journal: fork-3 cancelled != [2]: ${JSON.stringify(j3)}`);
  else console.log("JOURNAL OK: fork-3 join recorded branch 1's error ('judge timed out'), cancelled [2]");
  for (const [forkI, failedMsg] of [[2, "judge crashed"], [3, "judge timed out"]] as const) {
    const forkId = `${runId}/fork-${forkI}`;
    const child = `${forkId}/branch-2`;
    const cevents = readJournal(journalPath(child));
    const cancels = cevents.filter((e) => e.event === "cancel");
    const starts = cevents.filter((e) => e.event === "branch-start");
    if (cancels.length !== 1) {
      fail(`fail-fast journal: ${child} expected 1 cancel event, got ${cancels.length}`);
      continue;
    }
    const c = cancels[0];
    if (
      c.parentForkId !== forkId ||
      c.trigger !== "sibling failed with fail-fast on" ||
      c.failedBranch !== 1 ||
      JSON.stringify(c.error) !== JSON.stringify({ name: "Error", message: failedMsg })
    )
      fail(`fail-fast journal: ${child} cancel event wrong: ${JSON.stringify(c)}`);
    else if (starts.length)
      fail(`fail-fast journal: ${child} was cancelled but ran anyway (branch-start present)`);
    else console.log(`JOURNAL OK: ${child} cancelled before starting, trigger recorded`);
  }
}

function testAny(): void {
  const r = runTest(
    "any (first success wins; all-fail throws AggregateError)",
    "workflow-any.ts",
    "workflow-any-direct.ts",
    "run-any",
    3,
  );
  if (!r) return;
  const lines = parseOutLines(r.parentOut);
  if (lines["winner"] !== "approved/verified")
    fail(`any: winner != first success's bare value: ${lines["winner"]}`);
  else console.log("ANY SUCCESS OK: first success wins, bare value");
  if (lines["all-fail is AggregateError"] !== "true")
    fail("any: all-fail caught value is not a real AggregateError");
  else console.log("AGGREGATE OK: caught value is a real AggregateError");
  const errors = JSON.parse(lines["all-fail errors"]);
  if (JSON.stringify(errors) !== JSON.stringify(["judge crashed", "judge timed out"]))
    fail(`any: AggregateError errors != branch errors in order: ${JSON.stringify(errors)}`);
  else console.log("AGGREGATE ERRORS OK: all branch errors, branch order");
  if (lines["empty any is AggregateError"] !== "true")
    fail("any: any([]) caught value is not a real AggregateError");
  else if (lines["empty any errors"] !== "0")
    fail(`any: any([]) errors != 0: ${lines["empty any errors"]}`);
  else console.log("EMPTY any([]) OK: AggregateError with no errors, no fork");
  checkAnyJournal(r.parentJournal, "run-any");
}

function checkAnyJournal(journalPath_: string, runId: string): void {
  const events = readJournal(journalPath_);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  if (forks.length !== 2 || joins.length !== 2) {
    fail(`any journal: expected 2 forks + 2 joins, got ${forks.length} + ${joins.length}`);
    return;
  }
  if (forks[0].kind !== "any" || forks[0].branches !== 3)
    fail(`any journal: fork-0 kind/branches wrong: ${JSON.stringify(forks[0])}`);
  if (forks[1].kind !== "any" || forks[1].branches !== 2)
    fail(`any journal: fork-1 kind/branches wrong: ${JSON.stringify(forks[1])}`);
  const j0 = joins[0];
  if (j0.outcome !== "approved/verified") fail(`any journal: fork-0 join outcome != winner's value: ${JSON.stringify(j0)}`);
  if (j0.winner !== 1) fail(`any journal: fork-0 winner != 1: ${JSON.stringify(j0)}`);
  if (JSON.stringify(j0.cancelled) !== JSON.stringify([2]))
    fail(`any journal: fork-0 cancelled != [2]: ${JSON.stringify(j0)}`);
  if (JSON.stringify(j0.completed) !== JSON.stringify([{ ok: false, error: { name: "Error", message: "judge crashed" } }]))
    fail(`any journal: fork-0 completed != branch-0's failure: ${JSON.stringify(j0)}`);
  else console.log("JOURNAL OK: fork-0 join recorded winner 1, cancelled [2], the failed branch-0 outcome");
  const j1 = joins[1];
  if (j1.aggregate !== true) fail(`any journal: fork-1 join is not aggregate: ${JSON.stringify(j1)}`);
  if (JSON.stringify(j1.errors) !== JSON.stringify([
    { name: "Error", message: "judge crashed" },
    { name: "Error", message: "judge timed out" },
  ]))
    fail(`any journal: fork-1 errors != branch errors in order: ${JSON.stringify(j1)}`);
  if (JSON.stringify(j1.cancelled) !== JSON.stringify([]))
    fail(`any journal: fork-1 cancelled != []: ${JSON.stringify(j1)}`);
  if (JSON.stringify(j1.completed) !== JSON.stringify([
    { ok: false, error: { name: "Error", message: "judge crashed" } },
    { ok: false, error: { name: "Error", message: "judge timed out" } },
  ]))
    fail(`any journal: fork-1 completed != both failures: ${JSON.stringify(j1)}`);
  else console.log("JOURNAL OK: fork-1 join recorded the AggregateError (both errors, branch order), no cancellations");
  const child = `${runId}/fork-0/branch-2`;
  const cevents = readJournal(journalPath(child));
  const cancels = cevents.filter((e) => e.event === "cancel");
  const starts = cevents.filter((e) => e.event === "branch-start");
  if (cancels.length !== 1) fail(`any journal: ${child} expected 1 cancel event, got ${cancels.length}`);
  else {
    const c = cancels[0];
    if (c.parentForkId !== `${runId}/fork-0` || c.trigger !== "loser in any" || c.winner !== 1)
      fail(`any journal: ${child} cancel event wrong: ${JSON.stringify(c)}`);
    else if (starts.length) fail(`any journal: ${child} was cancelled but ran anyway (branch-start present)`);
    else console.log(`JOURNAL OK: ${child} cancelled before starting, trigger 'loser in any', winner 1`);
  }
  let allRan = true;
  for (const i of [0, 1]) {
    const ch = `${runId}/fork-1/branch-${i}`;
    const evs = readJournal(journalPath(ch));
    const st = evs.filter((e) => e.event === "branch-start");
    const dn = evs.filter((e) => e.event === "branch-done");
    const cn = evs.filter((e) => e.event === "cancel");
    if (st.length !== 1 || dn.length !== 1 || cn.length || dn[0].outcome?.ok !== false) {
      fail(`any journal: ${ch} should have run and failed with no cancellation: ${JSON.stringify(evs)}`);
      allRan = false;
    }
  }
  if (allRan) console.log("JOURNAL OK: both fork-1 branches ran and failed (no cancellations)");
}

function testRace(): void {
  const r = runTest(
    "race (first settler wins; failure throws)",
    "workflow-race.ts",
    "workflow-race-direct.ts",
    "run-race",
    3,
  );
  if (!r) return;
  const outLines = fs.readFileSync(r.parentOut, "utf8").split("\n");
  const lines = parseOutLines(r.parentOut);
  if (lines["winner"] !== "approved/verified")
    fail(`race: winner != first settler's bare value: ${lines["winner"]}`);
  else console.log("RACE SUCCESS OK: first settler's bare value wins");
  if (lines["caught is Error"] !== "true") fail("race: caught value is not a rehydrated Error");
  else console.log("RACE THROW OK: caught value is a real Error");
  if (!outLines.includes("finally ran")) fail("race: finally block did not run after the throw");
  else console.log("FINALLY OK: finally block ran after the throw");
  if (lines["caught"] !== "judge crashed") fail(`race: caught != 'judge crashed': ${lines["caught"]}`);
  else console.log("RACE CATCH OK: parent caught the first settler's error");
  checkRaceJournal(r.parentJournal, "run-race");
}

function checkRaceJournal(journalPath_: string, runId: string): void {
  const events = readJournal(journalPath_);
  const forks = events.filter((e) => e.event === "fork");
  const joins = events.filter((e) => e.event === "join");
  if (forks.length !== 2 || joins.length !== 2) {
    fail(`race journal: expected 2 forks + 2 joins, got ${forks.length} + ${joins.length}`);
    return;
  }
  if (forks[0].kind !== "race" || forks[0].branches !== 3)
    fail(`race journal: fork-0 kind/branches wrong: ${JSON.stringify(forks[0])}`);
  if (forks[1].kind !== "race" || forks[1].branches !== 2)
    fail(`race journal: fork-1 kind/branches wrong: ${JSON.stringify(forks[1])}`);
  const j0 = joins[0];
  if (j0.outcome !== "approved/verified") fail(`race journal: fork-0 join outcome != winner's value: ${JSON.stringify(j0)}`);
  if (j0.winner !== 0) fail(`race journal: fork-0 winner != 0: ${JSON.stringify(j0)}`);
  if (JSON.stringify(j0.cancelled) !== JSON.stringify([1, 2]))
    fail(`race journal: fork-0 cancelled != [1, 2]: ${JSON.stringify(j0)}`);
  if (JSON.stringify(j0.completed) !== JSON.stringify([]))
    fail(`race journal: fork-0 completed != []: ${JSON.stringify(j0)}`);
  else console.log("JOURNAL OK: fork-0 join recorded winner 0, cancelled [1, 2]");
  const j1 = joins[1];
  if (j1.failedBranch !== 0) fail(`race journal: fork-1 failedBranch != 0: ${JSON.stringify(j1)}`);
  if (JSON.stringify(j1.error) !== JSON.stringify({ name: "Error", message: "judge crashed" }))
    fail(`race journal: fork-1 error wrong: ${JSON.stringify(j1)}`);
  if (JSON.stringify(j1.cancelled) !== JSON.stringify([1]))
    fail(`race journal: fork-1 cancelled != [1]: ${JSON.stringify(j1)}`);
  if (JSON.stringify(j1.completed) !== JSON.stringify([]))
    fail(`race journal: fork-1 completed != []: ${JSON.stringify(j1)}`);
  else console.log("JOURNAL OK: fork-1 join recorded the thrown error, failed branch 0, cancelled [1]");
  for (const [forkI, losers] of [[0, [1, 2]], [1, [1]]] as const) {
    const forkId = `${runId}/fork-${forkI}`;
    for (const j of losers) {
      const child = `${forkId}/branch-${j}`;
      const cevents = readJournal(journalPath(child));
      const cancels = cevents.filter((e) => e.event === "cancel");
      const starts = cevents.filter((e) => e.event === "branch-start");
      if (cancels.length !== 1) {
        fail(`race journal: ${child} expected 1 cancel event, got ${cancels.length}`);
        continue;
      }
      const c = cancels[0];
      if (c.parentForkId !== forkId || c.trigger !== "loser in race" || c.winner !== 0)
        fail(`race journal: ${child} cancel event wrong: ${JSON.stringify(c)}`);
      else if (starts.length) fail(`race journal: ${child} was cancelled but ran anyway (branch-start present)`);
      else console.log(`JOURNAL OK: ${child} cancelled before starting, trigger 'loser in race', winner 0`);
    }
  }
}

function testRaceEmpty(): void {
  console.log("\n=== race([]) never settles (bounded drive) ===");
  const runId = "run-race-empty";
  const p = prefixFor(runId);
  let rc = startRun(path.join(TESTS, "workflow-race-empty.ts"), runId);
  if (rc !== 3) {
    fail(`race-empty: parent run exited ${rc}, expected 3 (suspended at race([]))`);
    return;
  }
  console.log("parent suspended at race([])");
  const fork = lastFork(journalPath(runId));
  if (!fork || fork.kind !== "race" || fork.branches !== 0 || JSON.stringify(fork.childRuns) !== "[]") {
    fail(`race-empty: fork event wrong: ${JSON.stringify(fork)}`);
    return;
  }
  console.log("FORK OK: 0-branch race fork, no children");
  rc = drive(
    path.join(WORKDIR, p + ".snap"),
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    rc,
    runId,
    true,
  );
  if (rc !== 3) {
    fail(`race-empty: bounded drive returned ${rc}, expected 3 (still suspended)`);
    return;
  }
  const events = readJournal(journalPath(runId));
  if (events.some((e) => e.event === "join")) {
    fail("race-empty: a join event appeared — race([]) spuriously resolved");
    return;
  }
  if (fs.readFileSync(path.join(WORKDIR, p + ".out"), "utf8") !== "") {
    fail("race-empty: the workflow printed output — race([]) resolved");
    return;
  }
  // The run is still suspended in the registry — it never settles.
  if (!REGISTRY.has(runId)) fail("race-empty: registry lost the still-suspended run");
  else console.log("REGISTRY OK: still-suspended run stays in-flight");
  // Test teardown: this run never completes, so the test closes its
  // registry entry explicitly (a real host would keep it in-flight).
  REGISTRY.delete(runId);
  console.log("BOUNDED DRIVE OK: still suspended, no join, no output, no crash — race([]) never settles");
}

// ---------------------------------------------------------- cancellation tests
function outLinesOf(runId: string): string[] {
  return fs.readFileSync(REGISTRY.get(runId)?.out ?? journalPath(runId).replace(".journal", ".out"), "utf8").split("\n");
}

function testCancelStep(): void {
  console.log("\n=== 1. cancel a pending trap ===");
  const runId = "run-cancel-step";
  let rc = startRun(path.join(TESTS, "workflow-cancel-step.ts"), runId);
  if (rc !== 2) {
    fail(`cancel-step: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`cancel-step: cancelled run exited ${rc}, expected 0`);
    return;
  }
  const lines = fs.readFileSync(path.join(WORKDIR, prefixFor(runId) + ".out"), "utf8").split("\n");
  for (const want of ["caught: CancellationError: user abort", "caught is Error: true", "finally ran", "done, caught: CancellationError: user abort"]) {
    if (!lines.includes(want)) fail(`cancel-step: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.startsWith("got:")))
    fail(`cancel-step: the trap returned a value after being cancelled: ${JSON.stringify(lines)}`);
  const events = readJournal(journalPath(runId));
  const traps = events.filter((e) => e.event === "trap");
  if (traps.length !== 1 || traps[0].ordinal !== 0)
    fail(`cancel-step: expected 1 trap event (ordinal 0), got ${JSON.stringify(traps)}`);
  if (traps[0] && traps[0].trapId !== "run-cancel-step/trap-0")
    fail(`cancel-step: trapId wrong: ${traps[0].trapId}`);
  if (events.some((e) => e.event === "trap-result" || e.event === "trap-error"))
    fail(`cancel-step: a trap-result/trap-error appeared for a cancelled trap: ${JSON.stringify(events)}`);
  const c = checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  if (c) {
    if (events.indexOf(c) < events.indexOf(traps[0]))
      fail("cancel-step: cancel event precedes the trap event — the cancellation was recorded before the dispatch");
    else console.log("CANCEL EVENT OK: trap ordinal 0, trigger 'user abort', reason 'user abort', when recorded");
  }
  console.log("CATCH OK: CancellationError at the call site, real Error, finally ran");
  if (REGISTRY.size !== 0) fail(`cancel-step: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

function testCancelCombinator(): void {
  console.log("\n=== 2. cancel a whole all() in flight ===");
  const runId = "run-cancel-combinator";
  let rc = startRun(path.join(TESTS, "workflow-cancel-combinator.ts"), runId);
  if (rc !== 3) {
    fail(`cancel-combinator: run exited ${rc}, expected 3 (suspended at a combinator)`);
    return;
  }
  const env = REGISTRY.get(runId)!.env;
  const snap = REGISTRY.get(runId)!.snap;
  const fork = lastFork(journalPath(runId));
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const before = sha(snap);
  for (let i = 0; i < children.length; i++) {
    const crc = startBranch(children[i], snap, i, env, forkId);
    if (crc !== 2) {
      fail(`cancel-combinator: child ${children[i]} exited ${crc}, expected 2 (suspended at its first trap)`);
      return;
    }
  }
  if (!snapUntouched(snap, before)) return;
  const cancelled = cancelTree(runId, "user abort", "user abort");
  if (JSON.stringify(cancelled) !== JSON.stringify([...children, runId]))
    fail(`cancel-combinator: cancelled order ${JSON.stringify(cancelled)} != ${JSON.stringify([...children, runId])} (children first, parent last)`);
  const lines = fs.readFileSync(path.join(WORKDIR, prefixFor(runId) + ".out"), "utf8").split("\n");
  for (const want of ["caught: CancellationError", "caught is Error: true", "finally ran", "done, caught: CancellationError"]) {
    if (!lines.includes(want)) fail(`cancel-combinator: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.startsWith("verdicts:")))
    fail(`cancel-combinator: the all() returned verdicts after being cancelled: ${JSON.stringify(lines)}`);
  const events = readJournal(journalPath(runId));
  if (events.some((e) => e.event === "join"))
    fail("cancel-combinator: a join event appeared — the cancelled fork spuriously joined");
  checkCancelEvent(events, runId, "fork", "user abort", "user abort", { forkId, cancelled: children });
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const cevents = readJournal(journalPath(child));
    const starts = cevents.filter((e) => e.event === "branch-start");
    const dones = cevents.filter((e) => e.event === "branch-done");
    if (starts.length !== 1 || starts[0].parentForkId !== forkId)
      fail(`cancel-combinator: child ${child} branch-start missing/wrong parentForkId: ${JSON.stringify(starts)}`);
    checkCancelEvent(cevents, child, "trap", "parent cancelled", "user abort", {
      ordinal: 0,
      parentForkId: forkId,
      branch: i,
    });
    if (dones.length !== 1) fail(`cancel-combinator: child ${child} expected 1 branch-done, got ${dones.length}`);
    else if (JSON.stringify(dones[0].outcome) !== JSON.stringify({ ok: true, value: "cancelled:CancellationError" }))
      fail(`cancel-combinator: child ${child} outcome != cancelled-cleanly: ${JSON.stringify(dones[0].outcome)}`);
    else console.log(`CHILD OK: ${child} caught its cancellation and returned 'cancelled:CancellationError'`);
  }
  console.log("PARENT OK: CancellationError at the all() call site, finally ran; no join event");
  if (REGISTRY.size !== 0) fail(`cancel-combinator: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

function testSticky(): void {
  console.log("\n=== 3. sticky cancellation ===");
  const runId = "run-sticky";
  let rc = startRun(path.join(TESTS, "workflow-sticky.ts"), runId);
  if (rc !== 2) {
    fail(`sticky: run exited ${rc}, expected 2 (suspended at the trap)`);
    return;
  }
  rc = cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`sticky: cancelled run exited ${rc}, expected 0 (the workflow must not suspend again)`);
    return;
  }
  const lines = fs.readFileSync(path.join(WORKDIR, prefixFor(runId) + ".out"), "utf8").split("\n");
  for (const want of ["caught: CancellationError", "finally ran", "second threw: CancellationError", "all threw: CancellationError", "done"]) {
    if (!lines.includes(want)) fail(`sticky: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.startsWith("ERROR:")))
    fail(`sticky: a call after the cancel dispatched anyway: ${JSON.stringify(lines)}`);
  else console.log("STICKY OK: the second trap() and the all() both threw at once — neither dispatched");
  const events = readJournal(journalPath(runId));
  const traps = events.filter((e) => e.event === "trap");
  if (traps.length !== 1 || traps[0].ordinal !== 0)
    fail(`sticky: expected exactly 1 trap event (ordinal 0), got ${JSON.stringify(traps)}`);
  if (events.some((e) => e.event === "fork"))
    fail(`sticky: a fork event appeared — the all() after the cancel forked: ${JSON.stringify(events)}`);
  checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  if (REGISTRY.size !== 0) fail(`sticky: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

function testRaceOrder(): void {
  console.log("\n=== 4a. cancel-vs-complete race: result first ===");
  let runId = "run-race-a";
  let rc = startRun(path.join(TESTS, "workflow-race-order.ts"), runId);
  if (rc !== 2) {
    fail(`race-a: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  const trapEv = lastTrap(REGISTRY.get(runId)!.log);
  if (!trapEv) {
    fail("race-a: no trap event in the log");
    return;
  }
  const ans = dispatchTrap(runId, trapEv.type, trapEv.arg);
  rc = deliverResult(runId, ans.value);
  if (rc !== 2) {
    fail(`race-a: after the first result the run exited ${rc}, expected 2 (suspended at the second trap)`);
    return;
  }
  rc = cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`race-a: cancelled run exited ${rc}, expected 0`);
    return;
  }
  let lines = fs.readFileSync(path.join(WORKDIR, prefixFor(runId) + ".out"), "utf8").split("\n");
  for (const want of [
    'first got: {"score":0.92,"label":"approved"}',
    "first finally ran",
    "second threw: CancellationError",
    "second finally ran",
    "done",
  ]) {
    if (!lines.includes(want)) fail(`race-a: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  let events = readJournal(journalPath(runId));
  const results = events.filter((e) => e.event === "trap-result");
  const cancels = events.filter((e) => e.event === "cancel");
  if (results.length !== 1 || results[0].ordinal !== 0)
    fail(`race-a: expected 1 trap-result (ordinal 0), got ${JSON.stringify(results)}`);
  else if (cancels.length !== 1) fail(`race-a: expected 1 cancel event, got ${cancels.length}`);
  else if (events.indexOf(results[0]) > events.indexOf(cancels[0]))
    fail("race-a: the cancel event precedes the trap-result — the result did not win the race in the journal");
  else if (cancels[0].ordinal !== 1) fail(`race-a: cancel ordinal ${cancels[0].ordinal} != 1`);
  else console.log("RACE OK (result-first): the first result is kept — the trap-result is recorded before the cancel event");

  console.log("\n=== 4b. cancel-vs-complete race: cancel first ===");
  runId = "run-race-b";
  rc = startRun(path.join(TESTS, "workflow-race-order.ts"), runId);
  if (rc !== 2) {
    fail(`race-b: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  rc = cancelRun(runId, "user abort", "user abort") ?? -1;
  if (rc !== 0) {
    fail(`race-b: cancelled run exited ${rc}, expected 0 (sticky: the second trap must throw at once, not suspend)`);
    return;
  }
  lines = fs.readFileSync(path.join(WORKDIR, prefixFor(runId) + ".out"), "utf8").split("\n");
  for (const want of ["first threw: CancellationError", "first finally ran", "second threw: CancellationError", "second finally ran", "done"]) {
    if (!lines.includes(want)) fail(`race-b: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.includes("got:")))
    fail(`race-b: a trap returned a value after the cancel: ${JSON.stringify(lines)}`);
  else console.log("RACE OK (cancel-first): no result ever landed, and the second trap threw at once (sticky)");
  events = readJournal(journalPath(runId));
  if (events.some((e) => e.event === "trap-result"))
    fail(`race-b: a trap-result appeared for a cancelled trap: ${JSON.stringify(events)}`);
  const traps = events.filter((e) => e.event === "trap");
  if (traps.length !== 1 || traps[0].ordinal !== 0)
    fail(`race-b: expected exactly 1 trap event (ordinal 0) — the second trap never dispatched: ${JSON.stringify(traps)}`);
  checkCancelEvent(events, runId, "trap", "user abort", "user abort", { ordinal: 0 });
  if (REGISTRY.size !== 0) fail(`race-order: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

function testNestedCancel(): void {
  console.log("\n=== 5. nested propagation (cancel the whole tree) ===");
  const runId = "run-nested-cancel";
  let rc = startRun(path.join(TESTS, "workflow-nested-cancel.ts"), runId);
  if (rc !== 3) {
    fail(`nested-cancel: run exited ${rc}, expected 3 (suspended at a combinator)`);
    return;
  }
  const env = REGISTRY.get(runId)!.env;
  const snap = REGISTRY.get(runId)!.snap;
  const fork = lastFork(journalPath(runId));
  const forkId = fork.forkId;
  const children: string[] = fork.childRuns;
  const before = sha(snap);
  const rc0 = startBranch(children[0], snap, 0, env, forkId);
  if (rc0 !== 3) {
    fail(`nested-cancel: branch 0 exited ${rc0}, expected 3 (suspended at its own all())`);
    return;
  }
  const b0Snap = REGISTRY.get(children[0])!.snap;
  const before0 = sha(b0Snap);
  const fork0 = lastFork(journalPath(children[0]));
  const fork0Id = fork0.forkId;
  const grandchildren: string[] = fork0.childRuns;
  for (let i = 0; i < grandchildren.length; i++) {
    const crc = startBranch(grandchildren[i], b0Snap, i, REGISTRY.get(children[0])!.env, fork0Id);
    if (crc !== 2) {
      fail(`nested-cancel: grandchild ${grandchildren[i]} exited ${crc}, expected 2 (suspended at its trap)`);
      return;
    }
  }
  if (!snapUntouched(b0Snap, before0)) return;
  const rc1 = startBranch(children[1], snap, 1, env, forkId);
  if (rc1 !== 2) {
    fail(`nested-cancel: branch 1 exited ${rc1}, expected 2 (suspended at its trap)`);
    return;
  }
  if (!snapUntouched(snap, before)) return;
  const cancelled = cancelTree(runId, "user abort", "user abort");
  const expected = [...grandchildren, children[0], children[1], runId];
  if (JSON.stringify(cancelled) !== JSON.stringify(expected))
    fail(`nested-cancel: cancelled order ${JSON.stringify(cancelled)} != ${JSON.stringify(expected)} (deepest first, parent last)`);
  const lines = fs.readFileSync(path.join(WORKDIR, prefixFor(runId) + ".out"), "utf8").split("\n");
  for (const want of ["caught: CancellationError", "finally ran", "done, caught: CancellationError"]) {
    if (!lines.includes(want)) fail(`nested-cancel: missing output line ${JSON.stringify(want)}: ${JSON.stringify(lines)}`);
  }
  if (lines.some((l) => l.startsWith("verdicts:")))
    fail(`nested-cancel: the parent all() returned verdicts after being cancelled: ${JSON.stringify(lines)}`);
  const events = readJournal(journalPath(runId));
  if (events.some((e) => e.event === "join"))
    fail("nested-cancel: a join event appeared in the parent journal — the cancelled fork spuriously joined");
  checkCancelEvent(events, runId, "fork", "user abort", "user abort", { forkId, cancelled: children });
  const b0Events = readJournal(journalPath(children[0]));
  if (b0Events.some((e) => e.event === "join"))
    fail("nested-cancel: a join event appeared in branch 0's journal — its cancelled fork spuriously joined");
  checkCancelEvent(b0Events, children[0], "fork", "parent cancelled", "user abort", {
    forkId: fork0Id,
    cancelled: grandchildren,
    parentForkId: forkId,
    branch: 0,
  });
  const b0Dones = b0Events.filter((e) => e.event === "branch-done");
  if (b0Dones.length !== 1) fail(`nested-cancel: branch 0 expected 1 branch-done, got ${b0Dones.length}`);
  else if (JSON.stringify(b0Dones[0].outcome) !== JSON.stringify({ ok: false, error: { name: "CancellationError", message: "user abort" } }))
    fail(`nested-cancel: branch 0 outcome != failed CancellationError: ${JSON.stringify(b0Dones[0].outcome)}`);
  else console.log("BRANCH 0 OK: cancelled at its own fork, failed outcome is a CancellationError, no join");
  const b1Events = readJournal(journalPath(children[1]));
  checkCancelEvent(b1Events, children[1], "trap", "parent cancelled", "user abort", {
    ordinal: 0,
    parentForkId: forkId,
    branch: 1,
  });
  const b1Dones = b1Events.filter((e) => e.event === "branch-done");
  if (b1Dones.length !== 1) fail(`nested-cancel: branch 1 expected 1 branch-done, got ${b1Dones.length}`);
  else if (JSON.stringify(b1Dones[0].outcome) !== JSON.stringify({ ok: true, value: "cancelled:CancellationError" }))
    fail(`nested-cancel: branch 1 outcome != cancelled-cleanly: ${JSON.stringify(b1Dones[0].outcome)}`);
  else console.log("BRANCH 1 OK: caught its cancellation, returned 'cancelled:CancellationError'");
  for (let i = 0; i < grandchildren.length; i++) {
    const gc = grandchildren[i];
    const gcEvents = readJournal(journalPath(gc));
    checkCancelEvent(gcEvents, gc, "trap", "parent cancelled", "user abort", {
      ordinal: 0,
      parentForkId: fork0Id,
      branch: i,
    });
    const gcDones = gcEvents.filter((e) => e.event === "branch-done");
    if (gcDones.length !== 1) fail(`nested-cancel: grandchild ${gc} expected 1 branch-done, got ${gcDones.length}`);
    else if (JSON.stringify(gcDones[0].outcome) !== JSON.stringify({ ok: false, error: { name: "CancellationError", message: "user abort" } }))
      fail(`nested-cancel: grandchild ${gc} outcome != failed CancellationError: ${JSON.stringify(gcDones[0].outcome)}`);
    else console.log(`GRANDCHILD OK: ${gc} cancelled at its trap, failed outcome is a CancellationError`);
  }
  console.log("TREE OK: every journal (parent, both branches, both grandchildren) records exactly one cancel event");
  if (REGISTRY.size !== 0) fail(`nested-cancel: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

// ------------------------------------------------------------- new core tests
function testTrapTypes(): void {
  console.log("\n=== trap dispatch by type string (all six types) ===");
  const runId = "run-trap-types";
  const p = prefixFor(runId);
  let rc = startRun(path.join(TESTS, "workflow-trap-types.ts"), runId);
  if (rc !== 2) {
    fail(`trap-types: run exited ${rc}, expected 2 (suspended at the first trap)`);
    return;
  }
  // Blob round-trip through the plugin's store, explicitly: the stored
  // blob is byte-identical, the live blob is deleted, and the run
  // resumes from the stored copy alone.
  const snap = path.join(WORKDIR, p + ".snap");
  const storedHash = sha(blobPath(runId));
  if (storedHash !== sha(snap)) fail("trap-types: stored blob hash != live blob hash");
  fs.rmSync(snap);
  loadBlob(runId, snap);
  if (sha(snap) !== storedHash) fail("trap-types: restored blob hash != stored blob hash");
  else console.log(`BLOB ROUND-TRIP OK: plugin store holds the blob (${storedHash.slice(0, 16)}…), run resumes from it`);
  rc = drive(snap, path.join(WORKDIR, p + ".out"), path.join(WORKDIR, p + ".log"), rc, runId);
  if (rc !== 0) {
    fail(`trap-types: run exited ${rc}`);
    return;
  }
  const lines = parseOutLines(path.join(WORKDIR, p + ".out"));
  const expected: Record<string, string> = {
    job: '{"score":0.92,"label":"approved"}',
    exec: '{"stdout":"hi\\n","exitCode":0}',
    gate: '{"answer":"yes"}',
    sleep: '{"sleptMs":1000}',
    cron: '{"scheduled":"2027-04-09T00:00:00Z"}',
    decide: '{"choice":"a","confidence":0.9}',
  };
  const out = fs.readFileSync(path.join(WORKDIR, p + ".out"), "utf8");
  for (const [k, v] of Object.entries(expected)) {
    if (!out.includes(`${k}: ${v}`)) fail(`trap-types: missing ${k}: ${v} in output:\n${out}`);
  }
  if (FAILURES.length === 0 || !out.includes("done")) {
    // no-op guard
  }
  if (!out.includes("done")) fail("trap-types: workflow did not complete");
  else console.log("TRAP TYPES OK: job/exec/gate/sleep/cron/decide each answered with its canned result");
  // The journal carries one trap event per type, each with a trapId.
  const events = readJournal(journalPath(runId));
  const traps = events.filter((e) => e.event === "trap");
  const types = traps.map((t) => t.type);
  if (JSON.stringify(types) !== JSON.stringify(["job", "exec", "gate", "sleep", "cron", "decide"]))
    fail(`trap-types: journal trap types != six types in order: ${JSON.stringify(types)}`);
  else if (traps.some((t, i) => t.trapId !== `${runId}/trap-${i}`))
    fail(`trap-types: trapIds wrong: ${JSON.stringify(traps.map((t) => t.trapId))}`);
  else console.log("TRAP IDS OK: runId/trap-N, one per type, in order");
  if (REGISTRY.size !== 0) fail(`trap-types: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

async function testAgenttsBundle(): Promise<void> {
  console.log("\n=== agentts module via Bun.build (TS host bundles, C host evals) ===");
  const runId = "run-agentts";
  const p = prefixFor(runId);
  // startRun bundles the driver for the workflow (the workflow is a
  // function; the driver calls its entry) — the bundle is the thing
  // the C host evals. The bundle file lands in WORKDIR as
  // <prefix>.bundle.js.
  let rc = startRun(path.join(TESTS, "workflow-agentts.ts"), runId);
  const bundleOut = path.join(WORKDIR, `${p}.bundle.js`);
  if (!fs.existsSync(bundleOut)) {
    fail("agentts-bundle: no bundle output");
    return;
  }
  console.log(`BUNDLED OK: workflow + agentts module -> one self-contained script (${fs.statSync(bundleOut).size} bytes)`);
  rc = drive(
    path.join(WORKDIR, p + ".snap"),
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    rc,
    runId,
  );
  if (rc !== 0) {
    fail(`agentts-bundle: run exited ${rc}`);
    return;
  }
  const out = fs.readFileSync(path.join(WORKDIR, p + ".out"), "utf8");
  const direct = fs.readFileSync(path.join(WORKDIR, prefixFor("run-trap-types") + ".out"), "utf8");
  if (out !== direct) fail(`agentts-bundle: bundled output != trap-types output:\n${out}\nvs\n${direct}`);
  else console.log("BUNDLE OUTPUT OK: byte-identical to the direct trap() version — the C host never resolved imports");
  // Every wrapper emits exactly trap(type, arg) with the right arg shape:
  // the journal's trap events carry the spec verbatim — job's new
  // { spec, input } shape, the others their fixed spec shapes — plus,
  // since BRA-88 landed the BRA-73 call-site capture in the canonical
  // module, the transport key `__agenttsSite` the wrappers attach.
  // This is the RAW C-host journal (no host ingest here to promote the
  // site to a top-level `site` field), so the site is asserted where
  // it rides — inside the arg under `__agenttsSite` — and the arg
  // comparison strips that one key first. The site check proves the
  // capture works in the C-host-bundled (QuickJS) context, not just
  // under Bun.
  const trapEvents = readJournal(journalPath(runId)).filter((e) => e.event === "trap");
  const bundleLines = fs.readFileSync(bundleOut, "utf8").split("\n");
  const expectedArgs: Record<string, any> = {
    job: { spec: "score", input: { value: 7 } },
    exec: { cmd: "echo hi" },
    gate: { question: "approve?" },
    sleep: { ms: 1000 },
    cron: { at: "2027-04-09T00:00:00Z" },
    decide: { question: "pick one", options: ["a", "b"] },
  };
  const types = ["job", "exec", "gate", "sleep", "cron", "decide"];
  const failuresBeforeArgs = FAILURES.length;
  if (trapEvents.length !== 6) {
    fail(`agentts-bundle: expected 6 trap events, got ${trapEvents.length}`);
  } else {
    for (let i = 0; i < 6; i++) {
      const ev = trapEvents[i];
      if (ev.type !== types[i] || ev.trapId !== `${runId}/trap-${i}`) {
        fail(`agentts-bundle: trap ${i} type/id wrong: ${JSON.stringify(ev)}`);
        continue;
      }
      // BRA-73 site: present, well-formed, in this bundle, on the
      // line of the wrapper call itself. It rides inside the arg in
      // the raw journal (promotion to a top-level `site` is the
      // host/mock ingest's job, not the core's).
      const site = ev.arg?.__agenttsSite;
      const siteOk =
        site &&
        typeof site.file === "string" &&
        site.file.endsWith(`${p}.bundle.js`) &&
        Number.isFinite(site.line) &&
        site.line >= 1 &&
        site.line <= bundleLines.length &&
        Number.isFinite(site.column) &&
        site.column >= 1;
      if (!siteOk) {
        fail(`agentts-bundle: ${types[i]} has no well-formed trap site: ${JSON.stringify(site)}`);
      } else if (!bundleLines[site.line - 1].includes(`${types[i]}(`)) {
        fail(
          `agentts-bundle: ${types[i]} site line ${site.line} is not its wrapper call: ${(bundleLines[site.line - 1] ?? "").trim().slice(0, 80)}`,
        );
      }
      // The spec verbatim, minus the one transport key.
      const arg = { ...(ev.arg ?? {}) };
      delete (arg as Record<string, unknown>).__agenttsSite;
      if (JSON.stringify(arg) !== JSON.stringify(expectedArgs[types[i]])) {
        fail(`agentts-bundle: ${types[i]} arg != expected: ${JSON.stringify(ev.arg)} vs ${JSON.stringify(expectedArgs[types[i]])}`);
      }
    }
    if (FAILURES.length === failuresBeforeArgs)
      console.log("TRAP ARGS OK: every wrapper emitted exactly trap(type, arg) with the right arg shape, and every trap event carries a well-formed site on its wrapper-call line in the bundle");
  }
  if (REGISTRY.size !== 0) fail(`agentts-bundle: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

async function testAgenttsCombinators(): Promise<void> {
  console.log("\n=== agentts module combinators (re-exported all/any/race) ===");
  // Each core-suite combinator workflow has a module variant that imports
  // the combinator (and the job wrapper) from the agentts module instead
  // of using the core globals / direct trap(). Bundled, driven, and
  // compared byte-identical against the same direct reference the
  // original uses — the re-exports must behave identically to the
  // builtins, including inside branch thunks.
  const cases: [string, string, string, number][] = [
    ["judges", "workflow-judges-direct.ts", "run-judges-module", 3],
    ["global", "workflow-global-direct.ts", "run-global-module", 3],
    ["nested", "workflow-nested-direct.ts", "run-nested-module", 2],
    ["failfast", "workflow-failfast-direct.ts", "run-failfast-module", 3],
    ["any", "workflow-any-direct.ts", "run-any-module", 3],
    ["race", "workflow-race-direct.ts", "run-race-module", 3],
  ];
  for (const [name, direct, runId, branches] of cases) {
    // The module variant is a normal workflow (it imports the
    // combinators from the agentts module); startRun bundles the
    // driver for it — no pre-bundling here anymore.
    const r = runTest(
      `${name} via agentts module`,
      `workflow-${name}-module.ts`,
      direct,
      runId,
      branches,
    );
    if (r) {
      // The module variant's journal must show the new job arg shape
      // (the branches call job(), not trap() directly).
      const traps = readJournal(r.parentJournal).filter((e) => e.event === "trap");
      if (traps.some((t) => t.type === "job" && typeof t.arg?.spec !== "string")) {
        fail(`agentts-${name}-module: a job trap arg lacks the { spec, input } shape: ${JSON.stringify(traps)}`);
      } else {
        console.log(`MODULE ${name.toUpperCase()} OK: output byte-identical, job traps carry { spec, input }`);
      }
    }
  }
}

async function testJsonBoundary(): Promise<void> {
  console.log("\n=== trap-boundary JSON rule (BRA-46): dirty args throw at the call site ===");
  const runId = "run-json-boundary";
  const p = prefixFor(runId);
  // startRun bundles the driver for the workflow — no pre-bundling.
  let rc = startRun(path.join(TESTS, "workflow-json-boundary.ts"), runId);
  rc = drive(
    path.join(WORKDIR, p + ".snap"),
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    rc,
    runId,
  );
  if (rc !== 0) {
    fail(`json-boundary: run exited ${rc}`);
    return;
  }
  const out = fs.readFileSync(path.join(WORKDIR, p + ".out"), "utf8");
  const failuresBeforeDirty = FAILURES.length;
  // Every rejected category throws synchronously at the call site with a
  // precise error (path + what it was); the workflow catches and prints.
  const expectedLines: [string, string][] = [
    ["dirty undefined:", "$.input.missing"],
    ["dirty function:", "$.input.fn"],
    ["dirty symbol:", "$.input.sym"],
    ["dirty bigint:", "$.input.big"],
    ["dirty nan:", "$.input.nan"],
    ["dirty infinity:", "$.input.inf"],
    ["dirty map:", "$.input.map"],
    ["dirty set:", "$.input.set"],
    ["dirty typed-array:", "$.input.buf"],
    ["dirty class-instance:", "$.input.obj"],
    ["dirty circular:", "$.input.self"],
    ["dirty symbol-key:", "$.input"],
    ["dirty invalid-date:", "$.input.when"],
    ["dirty array-hole:", "$.input.items[1]"],
    ["dirty array-extra-key:", "$.input.items.extra"],
    ["dirty nested-undefined:", "$.input.deep.leaf"],
  ];
  for (const [prefix, path] of expectedLines) {
    const line = out.split("\n").find((l) => l.startsWith(prefix));
    if (!line) fail(`json-boundary: missing output line ${prefix}`);
    else if (!line.includes(path)) fail(`json-boundary: ${prefix} lacks path ${path}: ${line}`);
    else if (!line.includes("JSON boundary (job arg)")) fail(`json-boundary: ${prefix} is not a boundary error: ${line}`);
  }
  if (FAILURES.length === failuresBeforeDirty) console.log("DIRTY ARGS OK: every rejected category threw synchronously with a precise path");
  // A Date in a clean arg crosses as its ISO string — visible in the
  // journal trap arg, not just in the workflow's printout.
  const traps = readJournal(journalPath(runId)).filter((e) => e.event === "trap");
  if (traps.length !== 1) {
    fail(`json-boundary: expected exactly 1 trap event (dirty args never dispatch), got ${traps.length}`);
  } else if (traps[0].type !== "job" || traps[0].arg?.input?.when !== "2027-04-09T00:00:00.000Z") {
    fail(`json-boundary: Date did not cross as ISO string: ${JSON.stringify(traps[0]?.arg)}`);
  } else {
    console.log("DATE OK: Date crossed as its ISO string in the journal trap arg");
    if (!out.includes('job: {"score":0.92,"label":"approved"}')) fail(`json-boundary: clean Date job did not return its canned result:\n${out}`);
    else console.log("CLEAN DATE JOB OK: canned result returned, run completed");
  }
  if (REGISTRY.size !== 0) fail(`json-boundary: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

async function testTrapArgBoundary(): Promise<void> {
  console.log("\n=== trap arg-in JSON rule, direct trap() (BRA-43 follow-up): dirty args throw at the call site ===");
  const runId = "run-trap-arg-boundary";
  const p = prefixFor(runId);
  let rc = startRun(path.join(TESTS, "workflow-trap-arg-boundary.ts"), runId);
  rc = drive(
    path.join(WORKDIR, p + ".snap"),
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    rc,
    runId,
  );
  if (rc !== 0) {
    fail(`trap-arg-boundary: run exited ${rc}`);
    return;
  }
  const out = fs.readFileSync(path.join(WORKDIR, p + ".out"), "utf8");
  const failuresBeforeDirty = FAILURES.length;
  // Every rejected category throws synchronously at the call site with
  // a precise error (path + what it was); the workflow catches and
  // prints. Paths are root-relative here — the direct trap arg has no
  // { spec, input } wrapper, unlike the module test.
  const expectedLines: [string, string][] = [
    ["dirty undefined:", "$.missing"],
    ["dirty root-undefined:", "$"],
    ["dirty function:", "$.fn"],
    ["dirty symbol:", "$.sym"],
    ["dirty bigint:", "$.big"],
    ["dirty nan:", "$.nan"],
    ["dirty infinity:", "$.inf"],
    ["dirty map:", "$.map"],
    ["dirty set:", "$.set"],
    ["dirty typed-array:", "$.buf"],
    ["dirty array-buffer:", "$.ab"],
    ["dirty dataview:", "$.dv"],
    ["dirty class-instance:", "$.obj"],
    ["dirty circular:", "$.self"],
    ["dirty symbol-key:", "$"],
    ["dirty invalid-date:", "$.when"],
    ["dirty array-hole:", "$.items[1]"],
    ["dirty array-extra-key:", "$.items.extra"],
    ["dirty nested-undefined:", "$.deep.leaf"],
    ["dirty proto-setter:", "$"],
  ];
  for (const [prefix, path] of expectedLines) {
    const line = out.split("\n").find((l) => l.startsWith(prefix));
    if (!line) fail(`trap-arg-boundary: missing output line ${prefix}`);
    else if (!line.includes(path)) fail(`trap-arg-boundary: ${prefix} lacks path ${path}: ${line}`);
    else if (!line.includes("JSON boundary (trap arg)")) fail(`trap-arg-boundary: ${prefix} is not a core boundary error: ${line}`);
    else if (line.includes("NO THROW")) fail(`trap-arg-boundary: ${prefix} did not throw: ${line}`);
  }
  if (FAILURES.length === failuresBeforeDirty) console.log("DIRTY DIRECT ARGS OK: every rejected category threw synchronously with a precise path");
  // Exactly two trap events (the two clean traps): dirty args never
  // dispatched, and none of them consumed a trap ordinal — the second
  // clean trap is ordinal 1, not 21.
  const traps = readJournal(journalPath(runId)).filter((e) => e.event === "trap");
  if (traps.length !== 2) {
    fail(`trap-arg-boundary: expected exactly 2 trap events (dirty args never dispatch), got ${traps.length}`);
  } else if (traps[0].ordinal !== 0 || traps[1].ordinal !== 1) {
    fail(`trap-arg-boundary: dirty calls consumed ordinals: ${JSON.stringify(traps.map((t: any) => t.ordinal))}`);
  } else if (traps[0].type !== "job" || traps[0].arg?.when !== "2027-04-09T00:00:00.000Z") {
    fail(`trap-arg-boundary: Date did not cross as ISO string: ${JSON.stringify(traps[0]?.arg)}`);
  } else if (JSON.stringify(traps[1].arg?.dag?.a) !== '{"x":1}' || JSON.stringify(traps[1].arg?.dag?.b) !== '{"x":1}') {
    fail(`trap-arg-boundary: DAG was not duplicated at both occurrences: ${JSON.stringify(traps[1]?.arg?.dag)}`);
  } else if (JSON.stringify(traps[1].arg?.ownProto?.["__proto__"]) !== '{"polluted":true}') {
    fail(`trap-arg-boundary: own __proto__ data property did not cross: ${JSON.stringify(traps[1]?.arg?.ownProto)}`);
  } else {
    console.log("DATE OK: Date crossed as its ISO string in the journal trap arg");
    console.log("ORDINALS OK: dirty calls consumed no ordinal (clean traps are 0 and 1)");
    console.log("DAG + __PROTO__ OK: shared object duplicated, own __proto__ data property preserved");
    if (!out.includes('job: {"score":0.92,"label":"approved"}')) fail(`trap-arg-boundary: clean Date job did not return its canned result:\n${out}`);
    else if (!out.includes('dag job: {"score":0.41,"label":"weak"}')) fail(`trap-arg-boundary: second clean job did not return its canned result:\n${out}`);
    else console.log("CLEAN JOBS OK: both clean traps returned their canned results, run completed");
  }
  if (REGISTRY.size !== 0) fail(`trap-arg-boundary: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);

  // A dirty arg that is never caught: the run fails synchronously at
  // the call site — no trap event, no blob, exit 1 (never suspends).
  // The workflow is a function (the trap is under the entry, so the
  // entry guard passes and the JSON boundary check is what throws).
  const dir = path.join(WORKDIR, "dirty-only");
  fs.mkdirSync(dir, { recursive: true });
  const wf = path.join(dir, "w.ts");
  fs.writeFileSync(
    wf,
    `declare function trap(type: string, arg: unknown): unknown;\ndeclare function print(...args: unknown[]): void;\nexport default function run(): { done: boolean } {\n  trap("job", { op: "score", value: undefined });\n  print("unreachable");\n  return { done: true };\n}\n`,
  );
  const bundle = bundleWorkflow(wf, "dirty-only");
  const r = spawnSync(HOST, ["run", bundle, path.join(dir, "w.blob")], {
    env: { ...process.env, AGENTTS_RUN_ID: "dirty-only" },
    encoding: "utf8",
  });
  if (r.status !== 1) fail(`trap-arg-boundary: dirty-only run exited ${r.status}, expected 1 (synchronous throw)`);
  else if (fs.existsSync(path.join(dir, "w.blob"))) fail("trap-arg-boundary: dirty-only run wrote a blob — a dirty arg must never suspend");
  else if ((r.stderr || "").includes('[durablets] {"event":"trap"')) fail("trap-arg-boundary: dirty-only run emitted a trap event — a dirty arg must never dispatch");
  else if (!(r.stderr || "").includes("JsonBoundaryError")) fail(`trap-arg-boundary: dirty-only run did not throw JsonBoundaryError: ${r.stderr}`);
  else console.log("DIRTY-ONLY OK: uncaught dirty arg failed synchronously (exit 1), no trap event, no blob");
}

function testErrorRehydration(): void {
  console.log("\n=== error rehydration (BRA-41): throwing traps arrive as real Errors ===");
  const runId = "run-error-rehydration";
  const p = prefixFor(runId);
  const d = prefixFor(runId + "-direct");
  // Straight-through reference (throws locally).
  let rc = startRun(path.join(TESTS, "workflow-error-rehydration-direct.ts"), runId + "-direct");
  rc = drive(
    path.join(WORKDIR, d + ".snap"),
    path.join(WORKDIR, d + ".out"),
    path.join(WORKDIR, d + ".log"),
    rc,
    runId + "-direct",
  );
  if (rc !== 0) {
    fail(`rehydration: direct reference exited ${rc}`);
    return;
  }
  // The plugin answers this run's traps with throws: an Error record,
  // then a plain string (a non-Error throw crosses as-is).
  throwOverrides.set(runId, (type, arg) => {
    if (arg?.op === "score" && arg?.value === 7)
      return { throw: { name: "Error", message: "boom" } };
    if (arg?.op === "score" && arg?.value === 3) return { throw: "plain failure" };
    return undefined;
  });
  rc = startRun(path.join(TESTS, "workflow-error-rehydration.ts"), runId);
  if (rc !== 2) {
    fail(`rehydration: run exited ${rc}, expected 2 (suspended at the trap)`);
    throwOverrides.delete(runId);
    return;
  }
  rc = drive(
    path.join(WORKDIR, p + ".snap"),
    path.join(WORKDIR, p + ".out"),
    path.join(WORKDIR, p + ".log"),
    rc,
    runId,
  );
  throwOverrides.delete(runId);
  if (rc !== 0) {
    fail(`rehydration: run exited ${rc}`);
    return;
  }
  const parentOut = fs.readFileSync(path.join(WORKDIR, p + ".out"));
  const directOut = fs.readFileSync(path.join(WORKDIR, d + ".out"));
  if (!parentOut.equals(directOut)) {
    fail(`rehydration: output differs from direct reference:\n${parentOut.toString()}\nvs\n${directOut.toString()}`);
    return;
  }
  console.log("OUTPUT MATCH: driven version byte-identical to direct reference");
  const lines = parseOutLines(path.join(WORKDIR, p + ".out"));
  if (lines["caught is Error"] !== "true") fail("rehydration: caught value is not a real Error");
  else console.log("REHYDRATION OK: throwing trap arrived as a real Error (instanceof Error true)");
  if (lines["caught"] !== "Error: boom") fail(`rehydration: caught != 'Error: boom': ${lines["caught"]}`);
  if (lines["plain is Error"] !== "false") fail("rehydration: plain-string throw became an Error");
  else console.log("NON-ERROR OK: a thrown plain string crosses as-is, not rehydrated");
  if (lines["plain"] !== "plain failure") fail(`rehydration: plain != 'plain failure': ${lines["plain"]}`);
  if (REGISTRY.size !== 0) fail(`rehydration: registry not empty after completion: ${[...REGISTRY.keys()].join(", ")}`);
}

function testNoJournalByCore(): void {
  console.log("\n=== core writes no journal (core-only invocation, no plugin) ===");
  const dir = path.join(WORKDIR, "core-only");
  fs.mkdirSync(dir, { recursive: true });
  const wf = path.join(dir, "w.ts");
  // A function workflow (the trap is under the entry, so the entry
  // guard passes) — run through the driver, as every workflow is now.
  fs.writeFileSync(
    wf,
    `declare function trap(type: string, arg: unknown): unknown;\ndeclare function print(...args: unknown[]): void;\nexport default function run(): { done: boolean } {\n  const r = trap("job", { op: "score", value: 7 });\n  print("got:", JSON.stringify(r));\n  return { done: true };\n}\n`,
  );
  const bundle = bundleWorkflow(wf, "core-only");
  // Spawn the C host directly on the bundle — no plugin, no journal
  // writer anywhere.
  const r = spawnSync(HOST, ["run", bundle, path.join(dir, "w.blob")], {
    env: { ...process.env, AGENTTS_RUN_ID: "core-only" },
    encoding: "utf8",
  });
  if (r.status !== 2) fail(`core-only: host exited ${r.status}, expected 2 (suspended at the trap)`);
  const files = fs.readdirSync(dir);
  if (files.some((f) => f.endsWith(".journal")))
    fail(`core-only: a .journal file appeared in ${dir}: ${files.join(", ")}`);
  else console.log(`CORE-ONLY OK: no journal file; dir holds only ${files.sort().join(", ")}`);
  if (!files.includes("w.blob")) fail("core-only: no blob file — the core must still write the blob it was told to");
  if (!(r.stderr || "").includes('[durablets] {"event":"trap"'))
    fail("core-only: no [durablets] trap event on stderr — the plugin would have nothing to journal");
  else console.log("EVENT CHANNEL OK: the trap event went to stderr for the plugin, not to a core journal");
  // Static check: the core source must not reference any journal path.
  const src = fs.readFileSync(path.join(ROOT, "src", "durablets.c"), "utf8");
  for (const bad of ["__journal_path", "journal_line", "AGENTTS_JOURNAL"]) {
    if (src.includes(bad)) fail(`core-only: source still references ${bad}`);
  }
  if (!src.includes("durablets_emit_event")) fail("core-only: source lost its event channel");
  else console.log("SOURCE OK: no journal-path identifiers in src/durablets.c");
}

// ----------------------------------------------------------------------- main
async function main(): Promise<number> {
  if (!fs.existsSync(HOST)) {
    fail(`C host binary missing: ${HOST} (run make first)`);
    return 1;
  }
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.mkdirSync(STORE, { recursive: true });
  console.log(`DurableTS core tests — host ${HOST}, workdir ${WORKDIR}`);

  testJudges();
  testGlobal();
  testNested();
  testFailfast();
  testAny();
  testRace();
  testRaceEmpty();
  testCancelStep();
  testCancelCombinator();
  testSticky();
  testRaceOrder();
  testNestedCancel();
  testTrapTypes();
  await testAgenttsBundle();
  await testAgenttsCombinators();
  await testJsonBoundary();
  await testTrapArgBoundary();
  testErrorRehydration();
  testNoJournalByCore();

  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS durablets (trap x6 types + all/any/race + fail-fast + nested + global-state + " +
      "cancellation x5 + blob round-trip + registry + error rehydration + no core journal + agentts bundle + " +
      "agentts combinators x6 + trap-boundary JSON rule + direct-trap arg-in JSON rule)",
  );
  return 0;
}

process.exit(await main());
