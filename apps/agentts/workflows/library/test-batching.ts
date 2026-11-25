// test-batching — verify a stack of changes passes together (BRA-263).
//
// The batcher runs the named higher-tier suites per change,
// batched, and reports per change plus the stack verdict —
// without re-verifying each change from scratch. One landing
// verifies the stack, not N landings each re-running everything.
//
// Mechanism (brief ~/workspace/bra261-262-263-impl-brief.md,
// decision 5 — the builder settles the mechanism, the contract
// is the guarantee):
//   1. Each suite runs as the run.sh leaf: `run.sh --bash --only
//      <slug> --resume-dir <suite-resume-dir>`, its output
//      redirected to a per-suite log file under workDir/logs/
//      (never through the trap — a full section log would blow
//      the ~60KB trap cap). The trap prints only two lines:
//      `RUNSH rc=<n>` and the progress.jsonl section row
//      (`{"event":"section","section":...,"ok":...,"rc":...}`),
//      which is the machine-readable verdict.
//   2. Suites run sequentially, one at a time: the VM has 1.5
//      shared CPUs and two run.sh invocations serialize badly
//      (the tier-1 lesson). Sequential is the v0; parallelism is
//      a later throughput item, not this build.
//   3. Per-suite results are recorded incrementally: after each
//      suite the state file `<resumeDir>/batch-state.json`
//      ({batchId, results}) is re-written atomically (temp +
//      rename) with the new result appended. A resumed batch
//      (same batchId, same resumeDir) reads the state and skips
//      every recorded suite — pass or fail. A recorded failure
//      is a completed suite (run.sh's own rule: a section whose
//      tests ran and failed is recorded failed, never retried);
//      retrying a failure is a new batchId.
//   4. A change whose copy has no apps/agentts/run.sh records
//      each of its suites failed with the reason named and the
//      batch continues — a missing copy is a per-change failure,
//      not a whole-batch refusal.
//   5. The workflow does not edit the queue file; it returns
//      per-change results for the caller (Landing) to apply.
//   6. Cancel is check-then-act (the triage pattern); a
//      null/absent run is refused, never dereferenced. Dry-run
//      plans the batch and writes nothing — no state file, no
//      logs, no suite runs.
//   7. The verdict is "passed" only when every suite of every
//      change passed; "failed" names the failing change + suite
//      in the report. A failed change never rides a passing stack.
//
// Known v0 limits, carried verbatim in every report:
//
// - Suites run sequentially, one at a time — no parallelism in
//   v0. A recorded failure is a completed suite: a resumed batch
//   skips it, it does not re-run it; retrying a failure is a new
//   batchId. The batcher runs suites; it does not decide
//   acceptance and never edits the queue file. The OK count comes
//   from run.sh's progress.jsonl section row; a suite with no
//   section row is failed with the reason named.

import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import { base64EncodeUtf8 } from "./dispatch";

/** The known-limit string, carried verbatim in every report. */
export const BATCHING_KNOWN_LIMIT =
  "Suites run sequentially, one at a time — no parallelism in v0. A recorded failure is a completed suite: a resumed batch skips it, it does not re-run it; retrying a failure is a new batchId. " +
  "The batcher runs suites; it does not decide acceptance and never edits the queue file. The OK count comes from run.sh's progress.jsonl section row; a suite with no section row is failed with the reason named.";

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface BatchTestsProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster?: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the
   * batcher v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir?: string;
}

/** One change in the stack: a copy plus the higher-tier suites
 * (tier-2 and/or full suite) to run for it. */
export interface BatchChange {
  changeId: string;
  copyRoot: string;
  suites: string[];
  note?: string;
}

export interface BatchTestsRunInput {
  /** e.g. "BRA-263". */
  batchId: string;
  changes: BatchChange[];
  /** Absolute scratch dir (work files + suite logs). Created by
   * the workflow. */
  workDir: string;
  /** Resume dir — carries batch-state.json across resumed runs. */
  resumeDir: string;
  dryRun?: boolean;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  bunPath?: string;
  /** dquickts tree for the C host build inside the suite runs.
   * Defaults to /home/hatch/workspace/dquickts-build-minimal. */
  dquicktsPath?: string;
}

export interface BatchTestsInput {
  project: BatchTestsProjectConfig;
  run: BatchTestsRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

/** One suite's result for one change. */
export interface BatchSuiteResult {
  changeId: string;
  suite: string;
  passed: boolean;
  logPath: string;
  /** OK count from run.sh's progress.jsonl section row (0 when
   * the suite did not produce a row). */
  ok: number;
  /** The failure reason, when the suite did not pass. */
  note?: string;
}

export interface BatchChangeResult {
  changeId: string;
  passed: boolean;
  suites: BatchSuiteResult[];
}

export interface BatchTestsReport {
  batchId: string;
  verdict: "passed" | "failed" | "dry-run";
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  changes: BatchChangeResult[];
  stackPassed: boolean;
  /** The first failing change, when the stack did not pass. */
  failingChange?: string;
  /** The first failing suite, when the stack did not pass. */
  failingSuite?: string;
  /** Suites skipped on this run because the state file already
   * recorded them (a resumed batch). */
  resumedSuites: number;
  notes: string[];
  knownLimit: string;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** Validate the run input. Pure — returns the error strings
 * (empty when valid), each naming the missing or malformed
 * field. The entry converts these into a refused report; nothing
 * throws for bad input. A null/absent run is an error here too,
 * but the entry guards it first (never dereferenced). */
export function validateBatchTestsInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["batch-tests: input is not an object"];
  const project = (input as JsonObject).project;
  const run = (input as JsonObject).run;
  if (!isPlainObject(project)) errors.push("batch-tests: input has no project object");
  else {
    const p = project as JsonObject;
    for (const f of ["linearProject", "repo", "stateDir", "workDir"]) {
      if (!isNonEmptyString(p[f])) errors.push("batch-tests: project has no " + f + " string");
    }
  }
  if (!isPlainObject(run)) {
    errors.push("batch-tests: input has no run object");
    return errors;
  }
  const r = run as JsonObject;
  if (!isNonEmptyString(r.batchId)) errors.push("batch-tests: run has no batchId string");
  for (const f of ["workDir", "resumeDir"]) {
    if (!isNonEmptyString(r[f])) errors.push("batch-tests: run has no " + f + " string");
  }
  if (!Array.isArray(r.changes)) {
    errors.push("batch-tests: run has no changes array");
  } else if (r.changes.length === 0) {
    errors.push("batch-tests: run.changes is empty — a batch needs at least one change");
  } else {
    const seen = new Set<string>();
    for (let i = 0; i < r.changes.length; i++) {
      const c = (r.changes as unknown[])[i];
      if (!isPlainObject(c)) {
        errors.push("batch-tests: run.changes[" + i + "] is not an object");
        continue;
      }
      if (!isNonEmptyString(c.changeId)) errors.push("batch-tests: run.changes[" + i + "] has no changeId string");
      else if (seen.has(c.changeId as string)) errors.push("batch-tests: duplicate changeId " + String(c.changeId));
      else seen.add(c.changeId as string);
      if (!isNonEmptyString(c.copyRoot)) errors.push("batch-tests: run.changes[" + i + "] has no copyRoot string");
      if (!Array.isArray(c.suites) || (c.suites as unknown[]).length === 0) {
        errors.push("batch-tests: run.changes[" + i + "] has no suites array (at least one suite per change)");
      } else {
        for (const s of c.suites as unknown[]) {
          if (!isNonEmptyString(s)) errors.push("batch-tests: run.changes[" + i + "] has a non-string suite");
        }
      }
    }
  }
  if (r.dryRun !== undefined && typeof r.dryRun !== "boolean") {
    errors.push("batch-tests: run.dryRun must be a boolean when present");
  }
  if (r.runId !== undefined && typeof r.runId !== "string") {
    errors.push("batch-tests: run.runId must be a string when present");
  }
  if (!isNonEmptyString((input as JsonObject).owner)) {
    errors.push("batch-tests: input has no owner string — the owner is the driving session, never assumed from the launcher");
  }
  return errors;
}

/** The batch state file: {batchId, results}. Pure — the shape
 * the workflow reads and writes incrementally. */
export interface BatchState {
  batchId: string;
  results: BatchSuiteResult[];
}

/** Append a suite result to the state. Pure — throws loudly on a
 * duplicate (changeId, suite): a recorded suite is never
 * re-run, so a duplicate means the caller mixed two batches. */
export function appendSuiteResult(state: BatchState, result: BatchSuiteResult): BatchState {
  if (state.results.some((r) => r.changeId === result.changeId && r.suite === result.suite)) {
    throw new Error(
      "batch-tests: duplicate suite result for " + result.changeId + "/" + result.suite + " — a recorded suite is never re-run",
    );
  }
  return { batchId: state.batchId, results: [...state.results, result] };
}

/** Parse a batch state file's text. Pure — throws loudly on a
 * malformed file (the state is the resume record; a corrupt one
 * refuses the batch rather than silently re-running). */
export function parseBatchState(text: string): BatchState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("batch-tests: batch state does not parse: " + (e as Error).message);
  }
  if (!isPlainObject(parsed) || typeof parsed.batchId !== "string" || !Array.isArray(parsed.results)) {
    throw new Error("batch-tests: batch state has the wrong shape (expected {batchId, results})");
  }
  return parsed as unknown as BatchState;
}

/** The per-suite run script: run run.sh --bash --only <slug>
 * against the change's copy, output to the suite log, and print
 * only `RUNSH rc=<n>` plus the progress.jsonl section row to
 * stdout — the log itself never crosses the trap boundary.
 * The trap always exits 0: a failing suite is a recorded
 * result, not a workflow throw. Pure — the script's shape is
 * unit-tested; the §D cases drive it end to end. */
export function batchSuiteScript(args: {
  dquickts: string;
  tmpdir: string;
  runSh: string;
  suite: string;
  suiteResumeDir: string;
  logPath: string;
}): string {
  return [
    "env DQUICKTS=" +
      shellQuote(args.dquickts) +
      " TMPDIR=" +
      shellQuote(args.tmpdir) +
      " " +
      shellQuote(args.runSh) +
      " --bash --only " +
      shellQuote(args.suite) +
      " --resume-dir " +
      shellQuote(args.suiteResumeDir) +
      " > " +
      shellQuote(args.logPath) +
      " 2>&1; rc=$?",
    "echo \"RUNSH rc=$rc\"",
    "grep '\"event\":\"section\"' " +
      shellQuote(args.suiteResumeDir + "/progress.jsonl") +
      " 2>/dev/null | tail -1 || true",
  ].join("\n");
}

/** Parse the per-suite trap's stdout: the `RUNSH rc=<n>` line
 * plus the optional progress.jsonl section row. Throws loudly
 * when the rc line is missing. Pure. */
export function parseSuiteRunOutput(text: string): { rc: number; sectionRow: { ok: number; rc: number } | null } {
  const m = /RUNSH rc=(-?\d+)/.exec(text);
  if (!m) throw new Error("batch-tests: suite run output has no RUNSH rc line: " + JSON.stringify(text.slice(0, 200)));
  const rc = Number(m[1]);
  let sectionRow: { ok: number; rc: number } | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const row = JSON.parse(t) as JsonObject;
      if (row.event === "section" && typeof row.ok === "number" && typeof row.rc === "number") {
        sectionRow = { ok: row.ok as number, rc: row.rc as number };
      }
    } catch {
      // not a JSON row — ignore
    }
  }
  return { rc, sectionRow };
}

/** The state-write script: decode the base64 state JSON to a
 * temp file in the resume dir, then rename it onto
 * batch-state.json — an atomic write per suite, so a resumed
 * batch skips completed suites. Prints one STATE line. Pure. */
export function batchStateWriteScript(args: { resumeDir: string; stateB64: string }): string {
  return [
    "python3 -c \"import base64,sys; open(sys.argv[1],'wb').write(base64.b64decode(sys.argv[2]))\" " +
      shellQuote(args.resumeDir + "/batch-state.json.tmp") +
      " " +
      shellQuote(args.stateB64),
    "mv " + shellQuote(args.resumeDir + "/batch-state.json.tmp") + " " + shellQuote(args.resumeDir + "/batch-state.json"),
    "echo STATE-WRITTEN",
  ].join("\n");
}

/** The state-read script: print the state file base64-encoded
 * (one line — the file itself never crosses the trap boundary).
 * Prints STATE-MISSING when there is no state file yet. Pure. */
export function batchStateReadScript(resumeDir: string): string {
  return [
    "if [ -f " + shellQuote(resumeDir + "/batch-state.json") + " ]; then",
    "  echo -n STATE-B64:; base64 -w0 " + shellQuote(resumeDir + "/batch-state.json") + "; echo",
    "else",
    "  echo STATE-MISSING",
    "fi",
  ].join("\n");
}

/** The state-decode script: decode the base64 state to stdout
 * (the state file is small — a few KB at most — so it fits the
 * trap cap). Pure. */
export function batchStateDecodeScript(stateB64: string): string {
  return "python3 -c \"import base64,sys; sys.stdout.write(base64.b64decode(sys.argv[1]).decode())\" " + shellQuote(stateB64);
}

/** Assemble the report. Pure — the verdict is "passed" only
 * when every suite of every change passed; "failed" names the
 * first failing change + suite; "dry-run" when the plan is clean
 * and nothing was run. Every failure is named in notes. */
export function buildBatchTestsReport(args: {
  batchId: string;
  verdict: BatchTestsReport["verdict"];
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  changes: BatchChangeResult[];
  resumedSuites: number;
  extraNotes?: string[];
}): BatchTestsReport {
  const notes: string[] = [...(args.extraNotes ?? [])];
  const stackPassed = args.changes.length > 0 && args.changes.every((c) => c.passed);
  let failingChange: string | undefined;
  let failingSuite: string | undefined;
  if (!stackPassed) {
    for (const c of args.changes) {
      if (c.passed) continue;
      failingChange = c.changeId;
      const failed = c.suites.find((s) => !s.passed);
      failingSuite = failed?.suite;
      break;
    }
    if (failingChange) {
      notes.push("stack failed: " + failingChange + "/" + (failingSuite ?? "?") + " — the failing change does not ride a passing stack");
    }
  }
  if (args.cancelled) {
    notes.push("run cancelled — the batch refused, nothing was run");
  }
  return {
    batchId: args.batchId,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    changes: args.changes,
    stackPassed,
    failingChange,
    failingSuite,
    resumedSuites: args.resumedSuites,
    notes,
    knownLimit: BATCHING_KNOWN_LIMIT,
  };
}

export default function batchTests(input: BatchTestsInput): BatchTestsReport {
  const dryRun = input?.run?.dryRun ?? false;
  let cancelChecked = false;
  let cancelled = false;
  const refusedReport = (extraNotes: string[], batchId?: string): BatchTestsReport =>
    buildBatchTestsReport({
      batchId: batchId ?? (typeof input?.run?.batchId === "string" ? input.run.batchId : ""),
      verdict: "failed",
      dryRun,
      owner: typeof input?.owner === "string" ? input.owner : "",
      launchedBy: input?.launchedBy,
      cancelChecked,
      cancelled,
      changes: [],
      resumedSuites: 0,
      extraNotes,
    });

  // Validate first, fail-closed. A null/absent run is refused,
  // never dereferenced (this workflow validates first, so it does
  // not have the defect).
  if (!isPlainObject(input)) return refusedReport(["batch-tests: input is not an object"]);
  if (!isPlainObject((input as JsonObject).run)) {
    return refusedReport(["batch-tests: input has no run object"]);
  }
  const run = (input as BatchTestsInput).run;
  const validationErrors = validateBatchTestsInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors, run.batchId);
  }
  const stateDir = (input as BatchTestsInput).project.stateDir;

  // Cancel check first (when runId present): check-then-act before
  // any run. Exit 2 (no queue entry) and exit 3 (queue
  // missing/unparsable) mean the check did not complete — the run
  // refuses with cancelChecked false. A cancelled run refuses
  // with cancelChecked true + cancelled true.
  if (typeof run.runId === "string" && run.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, run.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["batch-tests: cancel check: no queue entry for run " + run.runId], run.batchId);
    }
    if (check.exitCode === 3) {
      return refusedReport(["batch-tests: cancel check: " + (check.stdout ?? "").trim().slice(0, 200)], run.batchId);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "batch-tests: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout ?? "");
    } catch (e) {
      throw new Error("batch-tests: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["batch-tests: run " + run.runId + " is cancelled — the batch exits cleanly without advancing"], run.batchId);
    }
  }

  // Scratch dirs: workDir/tmp for the suite runs' TMPDIR, logs
  // under workDir/logs, per-suite resume dirs under resumeDir.
  const mk = exec({ cmd: "mkdir", args: ["-p", run.workDir, run.workDir + "/tmp", run.workDir + "/logs", run.resumeDir] });
  if (mk.exitCode !== 0) {
    throw new Error("batch-tests: cannot create work dirs under " + run.workDir + " (rc " + mk.exitCode + ")");
  }
  const dquickts = run.dquicktsPath ?? "/home/hatch/workspace/dquickts-build-minimal";
  const tmpdir = run.workDir + "/tmp";

  // Dry-run: plan the batch (changes + suites) and write nothing.
  if (dryRun) {
    const planned: BatchChangeResult[] = run.changes.map((c) => ({
      changeId: c.changeId,
      passed: false,
      suites: c.suites.map((s) => ({
        changeId: c.changeId,
        suite: s,
        passed: false,
        logPath: run.workDir + "/logs/" + c.changeId + "-" + s + ".log",
        ok: 0,
        note: "dry-run: planned, not run",
      })),
    }));
    return buildBatchTestsReport({
      batchId: run.batchId,
      verdict: "dry-run",
      dryRun: true,
      owner: (input as BatchTestsInput).owner,
      launchedBy: (input as BatchTestsInput).launchedBy,
      cancelChecked,
      cancelled,
      changes: planned,
      resumedSuites: 0,
      extraNotes: ["dry-run: " + run.changes.length + " change(s), " + run.changes.reduce((n, c) => n + c.suites.length, 0) + " suite(s) planned — nothing run, nothing written"],
    });
  }

  // Read the incremental state (a resumed batch reuses it). A
  // state for a different batchId starts fresh — the caller
  // reuses the resumeDir with a new batchId to retry.
  let state: BatchState = { batchId: run.batchId, results: [] };
  let resumedSuites = 0;
  const readExec = exec({ cmd: "/bin/sh", args: ["-c", batchStateReadScript(run.resumeDir)] });
  if (readExec.exitCode !== 0) {
    throw new Error("batch-tests: state read failed (rc " + readExec.exitCode + "): " + ((readExec.stderr ?? "") + (readExec.stdout ?? "")).slice(0, 200));
  }
  const readText = (readExec.stdout ?? "").trim();
  if (readText !== "STATE-MISSING") {
    const m = /^STATE-B64:([A-Za-z0-9+/=]+)$/.exec(readText);
    if (!m) {
      throw new Error("batch-tests: state read output is malformed: " + JSON.stringify(readText.slice(0, 200)));
    }
    const decode = exec({ cmd: "/bin/sh", args: ["-c", batchStateDecodeScript(m[1])] });
    if (decode.exitCode !== 0) {
      throw new Error("batch-tests: state decode failed (rc " + decode.exitCode + ")");
    }
    let prior: BatchState;
    try {
      prior = parseBatchState(decode.stdout ?? "");
    } catch (e) {
      throw new Error("batch-tests: prior batch state is corrupt — refusing rather than re-running silently: " + (e as Error).message);
    }
    if (prior.batchId === run.batchId) {
      state = prior;
      resumedSuites = prior.results.length;
    }
    // A different batchId starts fresh (the state file is
    // overwritten by the first suite result below).
  }

  const recorded = new Map<string, BatchSuiteResult>();
  for (const r of state.results) recorded.set(r.changeId + "/" + r.suite, r);

  const writeState = (next: BatchState): void => {
    const b64 = base64EncodeUtf8(JSON.stringify(next));
    const w = exec({ cmd: "/bin/sh", args: ["-c", batchStateWriteScript({ resumeDir: run.resumeDir, stateB64: b64 })] });
    if (w.exitCode !== 0 || !(w.stdout ?? "").includes("STATE-WRITTEN")) {
      throw new Error(
        "batch-tests: state write failed (rc " + w.exitCode + ") — the batch stops, the recorded results stand: " + ((w.stdout ?? "") + (w.stderr ?? "")).slice(0, 200),
      );
    }
  };

  const changeResults: BatchChangeResult[] = [];
  const notes: string[] = [];
  if (resumedSuites > 0) {
    notes.push("resumed batch: " + resumedSuites + " suite(s) already recorded, skipped");
  }

  for (const change of run.changes) {
    const suiteResults: BatchSuiteResult[] = [];
    const runSh = change.copyRoot + "/apps/agentts/run.sh";
    const hasRunSh = exec({ cmd: "/bin/sh", args: ["-c", "test -x " + shellQuote(runSh) + " && echo HAS-RUNSH || echo NO-RUNSH"] });
    const copyOk = (hasRunSh.stdout ?? "").includes("HAS-RUNSH");
    for (const suite of change.suites) {
      const key = change.changeId + "/" + suite;
      const prior = recorded.get(key);
      if (prior) {
        suiteResults.push(prior);
        continue;
      }
      const logPath = run.workDir + "/logs/" + change.changeId + "-" + suite + ".log";
      if (!copyOk) {
        const failed: BatchSuiteResult = {
          changeId: change.changeId,
          suite,
          passed: false,
          logPath,
          ok: 0,
          note: "copy has no executable apps/agentts/run.sh at " + runSh,
        };
        state = appendSuiteResult(state, failed);
        writeState(state);
        recorded.set(key, failed);
        suiteResults.push(failed);
        continue;
      }
      const suiteResumeDir = run.resumeDir + "/suites/" + change.changeId + "-" + suite;
      const runExec = exec({
        cmd: "/bin/sh",
        args: [
          "-c",
          batchSuiteScript({ dquickts, tmpdir, runSh, suite, suiteResumeDir, logPath }),
        ],
      });
      let parsed: { rc: number; sectionRow: { ok: number; rc: number } | null };
      try {
        parsed = parseSuiteRunOutput(runExec.stdout ?? "");
      } catch (e) {
        throw new Error("batch-tests: suite run for " + key + " produced no verdict: " + (e as Error).message);
      }
      let result: BatchSuiteResult;
      if (parsed.sectionRow === null) {
        result = {
          changeId: change.changeId,
          suite,
          passed: false,
          logPath,
          ok: 0,
          note: "no section row in progress.jsonl (run.sh rc=" + parsed.rc + ") — see " + logPath,
        };
      } else if (parsed.rc !== 0 || parsed.sectionRow.rc !== 0) {
        result = {
          changeId: change.changeId,
          suite,
          passed: false,
          logPath,
          ok: parsed.sectionRow.ok,
          note: "suite failed (run.sh rc=" + parsed.rc + ", section rc=" + parsed.sectionRow.rc + ") — see " + logPath,
        };
      } else {
        result = { changeId: change.changeId, suite, passed: true, logPath, ok: parsed.sectionRow.ok };
      }
      state = appendSuiteResult(state, result);
      writeState(state);
      recorded.set(key, result);
      suiteResults.push(result);
    }
    changeResults.push({
      changeId: change.changeId,
      passed: suiteResults.length > 0 && suiteResults.every((s) => s.passed),
      suites: suiteResults,
    });
  }

  const stackPassed = changeResults.length > 0 && changeResults.every((c) => c.passed);
  return buildBatchTestsReport({
    batchId: run.batchId,
    verdict: stackPassed ? "passed" : "failed",
    dryRun: false,
    owner: (input as BatchTestsInput).owner,
    launchedBy: (input as BatchTestsInput).launchedBy,
    cancelChecked,
    cancelled,
    changes: changeResults,
    resumedSuites,
    extraNotes: notes,
  });
}
