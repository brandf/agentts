// dual-report — re-verify a fixed item end to end and dual-report
// the verdict to the owning lead's chat AND to the Director
// (BRA-256).
//
// On Nov 20 a FAIL verdict sat unrouted ~5 hours because routing
// was a chat message. This workflow is the verdict route in the
// commit mechanism: the verdict reaches the owning lead and the
// Director in the same run, every time — never only in Quality's own
// chat, never by a chat message that can sit unrouted.
//
// The workflow sends no messages. The report returns one delivery
// payload per recipient (the owning lead's chat id from the roster
// + the Director; the server-restart pattern) and the launcher
// delivers them.
//
// Design decisions (brief ~/workspace/bra260-256-impl-brief.md,
// decisions 4 + 5, settled by the builder):
//
// 1. The re-verification mechanism: the test-batching workflow
//    (BRA-263) driven in-run as a child run via the `run` trap
//    (the plan-driven-work precedent — `run<In, Out>
//    ({workflow: "./test-batching.ts", input})`, the path a
//    string literal so the freeze pins the child file with the
//    parent's closure). One BatchChange per item (changeId = the
//    item key, copyRoot = the scratch tree containing the fix,
//    suites = the item's tier-1 section slugs). The child's
//    workDir/resumeDir live under the parent's workDir. The
//    verdict is taken from the child's report: stackPassed ->
//    PASS; a failing suite -> FAIL with the suite + the failure
//    named (from the child's failingSuite + the suite log's tail,
//    read bounded). A child-run throw (the batch itself couldn't
//    run) -> unable-to-verify with the reason named. The child
//    input shape is mirrored locally (BatchChildInput /
//    BatchChildReport) rather than imported — the run trap needs
//    only JSON, and the mirror keeps this file free of a value
//    import on test-batching.ts.
// 2. The verdict's evidence shape: the report carries the item,
//    the verdict (PASS / FAIL / unable-to-verify), the per-suite
//    results (suite, passed, ok, logPath, note), the failing
//    suite when one failed, the failing log's tail (last 20
//    lines, bounded), and the batch id. A FAIL names the failure
//    so the owning lead can act on it without asking Quality for the
//    detail.
// 3. The roster's chat-id lookup: the owning lead is a role
//    (run.owningLead, e.g. "implementation"); its chat id comes
//    from project.roster[role]. The Director's target is the
//    literal "director" (the server-restart pattern).
// 4. No owning lead: a verdict for an item with no owning lead
//    (run.owningLead absent, or absent from the roster) still
//    goes to the Director — never only to Quality's own chat. The
//    Director is the fallback recipient; the report records that
//    the owning-lead payload was not produced and why
//    (owningLeadPayloadProduced: false + the reason).
// 5. Unable to verify: a re-verification that can't run (the
//    item's evidence is missing — the tree is absent, a suite is
//    not a registered tier-1 section in the tree) is still
//    reported — as unable-to-verify with the reason named — not
//    silently dropped. A dropped verdict is indistinguishable
//    from a PASS. The payloads are still produced for an
//    unable-to-verify verdict: the verdict IS the report.
// 6. The workflow never files a bug (257) and never packages a
//    handoff (253) — it reports the verdict; the filing and the
//    handoff are separate workflows. It never merges, never
//    closes, never decides acceptance. Predictor-record scoring
//    is out of this build.
// 7. Cancel is check-then-act (the triage pattern); a null/absent
//    run is refused, never dereferenced. Dry-run plans the
//    re-verification and writes nothing — no batch, no payloads.
//
// Reads go through exec traps in the dispatch pattern, never trap
// stdout, never `Buffer`. Per-file read bounds: 48KB generic; the
// suite inventory is read by an extraction script that prints the
// tier-1 slugs only (one per line — the inventory file itself is
// never read whole). The failing log's tail is the last 20 lines
// only. The child batch's suite logs live under the parent's
// workDir and are never read whole.
import { exec, run } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";

/** The known-limit string, carried verbatim in every report. */
export const DUAL_REPORT_KNOWN_LIMIT =
  "The verdict is re-verified end to end by the test-batching workflow driven in-run as a child run. " +
  "The workflow sends no messages — the launcher delivers the payloads. " +
  "A verdict with no owning lead still goes to the Director. An unable-to-verify verdict is reported, never dropped. " +
  "This workflow never files a bug and never packages a handoff. Predictor-record scoring is out of this build.";

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface DualReportProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster?: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the
   * dual-report v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir?: string;
}

export interface DualReportRunInput {
  /** e.g. "BRA-256". */
  reportId: string;
  /** The fixed item being re-verified, e.g. "BRA-260". */
  itemKey: string;
  itemTitle?: string;
  /** The owning lead's role (a roster key, e.g.
   * "implementation"). Absent (or absent from the roster) means
   * no owning lead — the Director is the fallback recipient. */
  owningLead?: string;
  /** The tier-1 section slugs to re-verify, in run order. */
  suites: string[];
  /** A scratch tree containing the fix (the batch runs the suites
   * in this tree, never the live tree). */
  copyRoot: string;
  /** Absolute scratch dir (the child batch lives under it).
   * Created by the workflow. */
  workDir: string;
  /** dquickts tree for the C host build inside the suite runs.
   * Defaults to /home/hatch/workspace/dquickts-build-minimal. */
  dquicktsPath?: string;
  dryRun?: boolean;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  /** Caller-supplied now (ISO). When absent, the workflow reads
   * the clock. */
  now?: string;
  bunPath?: string;
}

export interface DualReportInput {
  project: DualReportProjectConfig;
  run: DualReportRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

export interface DeliveryPayload {
  /** "director" or a lead chat id (the run owner's session). */
  target: string;
  message: string;
}

export interface DualReportSuiteResult {
  suite: string;
  passed: boolean;
  ok: number;
  logPath: string;
  note?: string;
}

export type DualReportVerdict = "PASS" | "FAIL" | "unable-to-verify" | "dry-run" | "failed";

export interface DualReportReport {
  reportId: string;
  itemKey: string;
  itemTitle?: string;
  verdict: DualReportVerdict;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  suites: DualReportSuiteResult[];
  /** The first failing suite, when the verdict is FAIL. */
  failingSuite?: string;
  /** The failing suite log's tail (last 20 lines), when the
   * verdict is FAIL. */
  failingLogTail?: string[];
  /** The reason, when the verdict is unable-to-verify or failed. */
  reason?: string;
  batchId?: string;
  deliveryPayloads: DeliveryPayload[];
  /** False when there is no owning lead (Director-only). */
  owningLeadPayloadProduced: boolean;
  /** The reason, when no owning-lead payload was produced. */
  owningLeadReason?: string;
  notes: string[];
  knownLimit: string;
}

/** The child batch's input, mirrored from test-batching.ts
 * (BatchTestsInput) — the run trap needs only JSON, so this file
 * carries the mirror rather than a value import on
 * test-batching.ts. */
export interface BatchChildInput {
  project: {
    linearProject: string;
    repo: string;
    stateDir: string;
    roster?: Record<string, string>;
    thresholds?: Record<string, number>;
    workDir: string;
    resumeDir?: string;
  };
  run: {
    batchId: string;
    changes: { changeId: string; copyRoot: string; suites: string[]; note?: string }[];
    workDir: string;
    resumeDir: string;
    dryRun?: boolean;
    runId?: string;
    bunPath?: string;
    dquicktsPath?: string;
  };
  owner: string;
  launchedBy?: string;
}

/** The child batch's report, mirrored from test-batching.ts
 * (BatchTestsReport). */
export interface BatchChildReport {
  batchId: string;
  verdict: "passed" | "failed" | "dry-run";
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  changes: {
    changeId: string;
    passed: boolean;
    suites: { changeId: string; suite: string; passed: boolean; logPath: string; ok: number; note?: string }[];
  }[];
  stackPassed: boolean;
  failingChange?: string;
  failingSuite?: string;
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
 * (empty when valid), each naming the missing or malformed field.
 * The entry converts these into a refused report; nothing throws
 * for bad input. A null/absent run is an error here too, but the
 * entry guards it first (never dereferenced). */
export function validateDualReportInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["dual-report: input is not an object"];
  if (!isPlainObject(input.project)) errors.push("dual-report: project is not an object");
  else {
    if (!isNonEmptyString(input.project.linearProject)) errors.push("dual-report: project.linearProject must be a non-empty string");
    if (!isNonEmptyString(input.project.repo)) errors.push("dual-report: project.repo must be a non-empty string");
    if (!isNonEmptyString(input.project.stateDir)) errors.push("dual-report: project.stateDir must be a non-empty string");
    if (!isNonEmptyString(input.project.workDir)) errors.push("dual-report: project.workDir must be a non-empty string");
  }
  if (!isPlainObject(input.run)) errors.push("dual-report: run is not an object");
  else {
    const run = input.run as JsonObject;
    if (!isNonEmptyString(run.reportId)) errors.push("dual-report: run.reportId must be a non-empty string");
    if (!isNonEmptyString(run.itemKey)) errors.push("dual-report: run.itemKey must be a non-empty string");
    if (run.itemTitle !== undefined && typeof run.itemTitle !== "string") errors.push("dual-report: run.itemTitle must be a string when present");
    if (run.owningLead !== undefined && !isNonEmptyString(run.owningLead)) errors.push("dual-report: run.owningLead must be a non-empty string when present");
    if (!Array.isArray(run.suites) || run.suites.length === 0 || !run.suites.every((s) => typeof s === "string" && s !== "")) {
      errors.push("dual-report: run.suites must be a non-empty array of non-empty strings");
    }
    if (!isNonEmptyString(run.copyRoot)) errors.push("dual-report: run.copyRoot must be a non-empty string");
    if (!isNonEmptyString(run.workDir)) errors.push("dual-report: run.workDir must be a non-empty string");
    if (run.dquicktsPath !== undefined && !isNonEmptyString(run.dquicktsPath)) errors.push("dual-report: run.dquicktsPath must be a non-empty string when present");
    if (run.dryRun !== undefined && typeof run.dryRun !== "boolean") errors.push("dual-report: run.dryRun must be a boolean when present");
    if (run.runId !== undefined && typeof run.runId !== "string") errors.push("dual-report: run.runId must be a string when present");
    if (run.now !== undefined && typeof run.now !== "string") errors.push("dual-report: run.now must be a string when present");
  }
  if (typeof input.owner !== "string" || input.owner === "") errors.push("dual-report: owner must be a non-empty string");
  return errors;
}

// ------------------------------------------------------------------
// Pure script builders + parsers (unit-tested; the §D cases drive
// them end to end). Every script prints small, bounded output — a
// file's content never crosses the trap boundary.
// ------------------------------------------------------------------

/** The inventory-slugs script: load the tree's
 * suite-inventory.json and print the tier-1 section slugs, one
 * per line. Prints `SLUGS-MISSING` when the file is absent and
 * `SLUGS-ERROR <reason>` when it doesn't parse. Pure. */
export function suiteInventorySlugsScript(treeRoot: string): string {
  return [
    "python3 -c '",
    "import json, sys",
    "p = sys.argv[1]",
    "try:",
    "    d = json.load(open(p))",
    "except FileNotFoundError:",
    "    print(\"SLUGS-MISSING \" + p)",
    "    raise SystemExit(2)",
    "except ValueError as e:",
    "    print(\"SLUGS-ERROR \" + str(e)[:150])",
    "    raise SystemExit(2)",
    "for s in d.get(\"sections\", []):",
    "    if s.get(\"tier\") == 1:",
    "        print(s.get(\"slug\", \"\"))",
    "' " + shellQuote(treeRoot + "/apps/agentts/suite-inventory.json"),
  ].join("\n");
}

/** Parse the inventory-slugs output into the tier-1 slug list.
 * Throws loudly on the SLUGS-MISSING / SLUGS-ERROR lines. Pure. */
export function parseInventorySlugs(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 1 && lines[0].startsWith("SLUGS-MISSING")) {
    throw new Error("dual-report: suite inventory is missing: " + lines[0].slice("SLUGS-MISSING ".length));
  }
  if (lines.length === 1 && lines[0].startsWith("SLUGS-ERROR")) {
    throw new Error("dual-report: suite inventory does not parse: " + lines[0].slice("SLUGS-ERROR ".length));
  }
  return lines;
}

/** The log-tail script: print the last `maxLines` lines of a log
 * file, prefixed `TAIL <n>`. Prints `TAIL-MISSING` when the file
 * is absent. Pure. */
export function logTailScript(logPath: string, maxLines: number): string {
  return [
    "if [ -f " + shellQuote(logPath) + " ]; then",
    "  tail -" + String(maxLines) + " " + shellQuote(logPath),
    "else",
    "  echo TAIL-MISSING",
    "fi",
  ].join("\n");
}

/** Build the child batch input for one item: one change, the
 * item's suites, the batch dirs under the parent's workDir. Pure. */
export function buildBatchChildInput(args: {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster?: Record<string, string>;
  owner: string;
  launchedBy?: string;
  batchId: string;
  itemKey: string;
  copyRoot: string;
  suites: string[];
  batchWorkDir: string;
  batchResumeDir: string;
  dquicktsPath?: string;
}): BatchChildInput {
  // The `run` trap's JSON boundary refuses undefined values, so
  // optional fields are omitted entirely when unset — never
  // passed as undefined.
  return {
    project: {
      linearProject: args.linearProject,
      repo: args.repo,
      stateDir: args.stateDir,
      ...(args.roster !== undefined ? { roster: args.roster } : {}),
      workDir: args.batchWorkDir,
      resumeDir: args.batchResumeDir,
    },
    run: {
      batchId: args.batchId,
      changes: [{ changeId: args.itemKey, copyRoot: args.copyRoot, suites: args.suites }],
      workDir: args.batchWorkDir,
      resumeDir: args.batchResumeDir,
      dryRun: false,
      ...(args.dquicktsPath !== undefined ? { dquicktsPath: args.dquicktsPath } : {}),
    },
    owner: args.owner,
    ...(args.launchedBy !== undefined ? { launchedBy: args.launchedBy } : {}),
  };
}

/** Check the child batch report's shape (the run trap returns
 * JSON — a malformed child report is unable-to-verify, never a
 * crash). Pure. */
export function isBatchChildReport(v: unknown): v is BatchChildReport {
  if (!isPlainObject(v)) return false;
  if (typeof v.batchId !== "string") return false;
  if (v.verdict !== "passed" && v.verdict !== "failed" && v.verdict !== "dry-run") return false;
  if (!Array.isArray(v.changes)) return false;
  return true;
}

/** Take the verdict from the child batch report: PASS when the
 * stack passed, FAIL when it didn't (naming the first failing
 * suite), unable-to-verify when the child itself is malformed.
 * Pure. */
export function verdictFromBatch(child: BatchChildReport): {
  verdict: "PASS" | "FAIL" | "unable-to-verify";
  failingSuite?: string;
  reason?: string;
} {
  if (child.verdict === "passed" && child.stackPassed) return { verdict: "PASS" };
  if (child.verdict === "dry-run") return { verdict: "unable-to-verify", reason: "the child batch returned dry-run — the re-verification did not run" };
  return {
    verdict: "FAIL",
    failingSuite: child.failingSuite,
    reason: child.failingSuite
      ? "suite " + child.failingSuite + " failed" + (child.failingChange ? " for change " + child.failingChange : "")
      : "the batch failed with no failing suite named",
  };
}

/** Build the delivery payloads: the owning lead's chat (from the
 * roster) + the Director, in the same run. When there is no
 * owning lead, the Director payload only. The message names the
 * item, the verdict, and the evidence — a FAIL names the failure
 * so the owning lead can act without asking Quality for the detail.
 * Pure. */
export function buildDualReportPayloads(args: {
  reportId: string;
  itemKey: string;
  itemTitle?: string;
  verdict: DualReportVerdict;
  suites: DualReportSuiteResult[];
  failingSuite?: string;
  reason?: string;
  owningLeadTarget?: string;
}): DeliveryPayload[] {
  const passed = args.suites.filter((s) => s.passed).length;
  const line =
    "dual-report " + args.reportId + " (" + args.itemKey + (args.itemTitle ? ": " + args.itemTitle : "") + "): " + args.verdict +
    " — " + passed + "/" + args.suites.length + " suite(s) passed" +
    (args.failingSuite ? " — failing suite: " + args.failingSuite : "") +
    (args.reason ? " — " + args.reason : "");
  const payloads: DeliveryPayload[] = [];
  if (args.owningLeadTarget !== undefined) {
    payloads.push({ target: args.owningLeadTarget, message: line });
  }
  payloads.push({ target: "director", message: line });
  return payloads;
}

/** Assemble the report. Pure — the verdict is taken as given by
 * the entry (the entry is the only place verdicts are decided). */
export function buildDualReportReport(args: {
  reportId: string;
  itemKey: string;
  itemTitle?: string;
  verdict: DualReportVerdict;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  suites: DualReportSuiteResult[];
  failingSuite?: string;
  failingLogTail?: string[];
  reason?: string;
  batchId?: string;
  deliveryPayloads: DeliveryPayload[];
  owningLeadPayloadProduced: boolean;
  owningLeadReason?: string;
  notes: string[];
}): DualReportReport {
  return {
    reportId: args.reportId,
    itemKey: args.itemKey,
    itemTitle: args.itemTitle,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    suites: args.suites,
    failingSuite: args.failingSuite,
    failingLogTail: args.failingLogTail,
    reason: args.reason,
    batchId: args.batchId,
    deliveryPayloads: args.deliveryPayloads,
    owningLeadPayloadProduced: args.owningLeadPayloadProduced,
    owningLeadReason: args.owningLeadReason,
    notes: args.notes,
    knownLimit: DUAL_REPORT_KNOWN_LIMIT,
  };
}

export default function dualReportVerdict(input: DualReportInput): DualReportReport {
  const dryRun = input?.run?.dryRun ?? false;
  let cancelChecked = false;
  let cancelled = false;
  const refusedReport = (extraNotes: string[], verdict: DualReportVerdict = "failed"): DualReportReport =>
    buildDualReportReport({
      reportId: typeof input?.run?.reportId === "string" ? input.run.reportId : "",
      itemKey: typeof input?.run?.itemKey === "string" ? input.run.itemKey : "",
      verdict,
      dryRun,
      owner: typeof input?.owner === "string" ? input.owner : "",
      launchedBy: input?.launchedBy,
      cancelChecked,
      cancelled,
      suites: [],
      deliveryPayloads: [],
      owningLeadPayloadProduced: false,
      notes: extraNotes,
    });

  // Validate first, fail-closed. A null/absent run is refused,
  // never dereferenced (this workflow validates first, so it does
  // not have the defect).
  if (!isPlainObject(input)) return refusedReport(["dual-report: input is not an object"]);
  if (!isPlainObject((input as JsonObject).run)) {
    return refusedReport(["dual-report: input has no run object"]);
  }
  const runInput = (input as DualReportInput).run;
  const validationErrors = validateDualReportInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors);
  }
  const stateDir = (input as DualReportInput).project.stateDir;

  // Cancel check first (when runId present): check-then-act before
  // any read or write. Exit 2 (no queue entry) and exit 3 (queue
  // missing/unparsable) mean the check did not complete — the run
  // refuses with cancelChecked false. A cancelled run refuses
  // with cancelChecked true + cancelled true.
  if (typeof runInput.runId === "string" && runInput.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, runInput.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["dual-report: cancel check: no queue entry for run " + runInput.runId]);
    }
    if (check.exitCode === 3) {
      return refusedReport(["dual-report: cancel check: " + (check.stdout ?? "").trim().slice(0, 200)]);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "dual-report: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout ?? "");
    } catch (e) {
      throw new Error("dual-report: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["dual-report: run " + runInput.runId + " is cancelled — the re-verification exits cleanly without advancing"]);
    }
  }

  // The owning lead's chat id (from the roster) — resolved up
  // front so the no-owning-lead case is recorded once, in one
  // place, and every verdict below carries the same payload set.
  const owningLeadTarget =
    runInput.owningLead !== undefined ? (input as DualReportInput).project.roster?.[runInput.owningLead] : undefined;
  const owningLeadPayloadProduced = owningLeadTarget !== undefined;
  const owningLeadReason =
    runInput.owningLead === undefined
      ? "no owning lead named for " + runInput.itemKey
      : owningLeadTarget === undefined
        ? "owning lead " + runInput.owningLead + " is not in the roster"
        : undefined;

  // Scratch dirs: workDir for the child batch + temp files.
  const batchWorkDir = runInput.workDir + "/batch";
  const batchResumeDir = runInput.workDir + "/batch-resume";
  const mk = exec({ cmd: "mkdir", args: ["-p", runInput.workDir, runInput.workDir + "/tmp", batchWorkDir, batchResumeDir] });
  if (mk.exitCode !== 0) {
    throw new Error("dual-report: cannot create work dir under " + runInput.workDir + " (rc " + mk.exitCode + ")");
  }

  // Dry-run: plan the re-verification (item + suites) and write
  // nothing — no batch, no payloads.
  if (dryRun) {
    return buildDualReportReport({
      reportId: runInput.reportId,
      itemKey: runInput.itemKey,
      itemTitle: runInput.itemTitle,
      verdict: "dry-run",
      dryRun: true,
      owner: (input as DualReportInput).owner,
      launchedBy: input.launchedBy,
      cancelChecked,
      cancelled,
      suites: runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: batchWorkDir + "/logs/" + runInput.itemKey + "-" + s + ".log", note: "dry-run: planned, not run" })),
      deliveryPayloads: [],
      owningLeadPayloadProduced,
      owningLeadReason,
      notes: ["dry-run: " + runInput.itemKey + " would be re-verified end to end (" + runInput.suites.length + " suite(s): " + runInput.suites.join(", ") + ") — nothing run, nothing written"],
    });
  }

  // The evidence check (unable-to-verify): the tree must exist,
  // and every suite must be a registered tier-1 section in the
  // tree. A verdict that can't run is still reported — as
  // unable-to-verify with the reason named — not silently
  // dropped. The payloads are still produced: the verdict IS the
  // report.
  const unableToVerify = (
    reason: string,
    suites: DualReportSuiteResult[],
  ): DualReportReport =>
    buildDualReportReport({
      reportId: runInput.reportId,
      itemKey: runInput.itemKey,
      itemTitle: runInput.itemTitle,
      verdict: "unable-to-verify",
      dryRun,
      owner: (input as DualReportInput).owner,
      launchedBy: input.launchedBy,
      cancelChecked,
      cancelled,
      suites,
      reason,
      deliveryPayloads: buildDualReportPayloads({
        reportId: runInput.reportId,
        itemKey: runInput.itemKey,
        itemTitle: runInput.itemTitle,
        verdict: "unable-to-verify",
        suites,
        reason,
        owningLeadTarget,
      }),
      owningLeadPayloadProduced,
      owningLeadReason,
      notes: ["dual-report: " + reason],
    });
  const treeCheck = exec({ cmd: "/bin/sh", args: ["-c", "test -d " + shellQuote(runInput.copyRoot) + " || exit 1\necho TREE-OK\n"] });
  if (treeCheck.exitCode !== 0) {
    return unableToVerify(
      "the tree at " + runInput.copyRoot + " does not exist — the fix is not in a tree to re-verify",
      runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: "", note: "unable-to-verify: tree missing" })),
    );
  }
  const slugsOut = exec({ cmd: "/bin/sh", args: ["-c", suiteInventorySlugsScript(runInput.copyRoot)] });
  if (slugsOut.exitCode !== 0) {
    return unableToVerify(
      "the suite inventory in the tree at " + runInput.copyRoot + " could not be read: " + (slugsOut.stdout ?? "").trim().slice(0, 200),
      runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: "", note: "unable-to-verify: inventory unreadable" })),
    );
  }
  let registered: string[];
  try {
    registered = parseInventorySlugs(slugsOut.stdout ?? "");
  } catch (e) {
    return unableToVerify(
      (e as Error).message,
      runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: "", note: "unable-to-verify: inventory unreadable" })),
    );
  }
  const unregistered = runInput.suites.filter((s) => !registered.includes(s));
  if (unregistered.length > 0) {
    return unableToVerify(
      "suite(s) not registered as tier-1 sections in the tree: " + unregistered.join(", "),
      runInput.suites.map((s) => ({
        suite: s,
        passed: false,
        ok: 0,
        logPath: "",
        note: registered.includes(s) ? "unable-to-verify: sibling suite unregistered" : "unable-to-verify: suite not registered",
      })),
    );
  }

  // Drive the re-verification: the test-batching workflow as a
  // child run (one change, the item's suites, in the tree). The
  // child's report is the verdict's evidence.
  const batchId = "dual-" + runInput.itemKey;
  let child: BatchChildReport;
  try {
    child = run<BatchChildInput, BatchChildReport>({
      workflow: "./test-batching.ts",
      input: buildBatchChildInput({
        linearProject: (input as DualReportInput).project.linearProject,
        repo: (input as DualReportInput).project.repo,
        stateDir,
        roster: (input as DualReportInput).project.roster,
        owner: (input as DualReportInput).owner,
        launchedBy: input.launchedBy,
        batchId,
        itemKey: runInput.itemKey,
        copyRoot: runInput.copyRoot,
        suites: runInput.suites,
        batchWorkDir,
        batchResumeDir,
        dquicktsPath: runInput.dquicktsPath,
      }),
    });
  } catch (e) {
    return unableToVerify(
      "the re-verification batch could not run: " + (e as Error).message.slice(0, 300),
      runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: "", note: "unable-to-verify: batch threw" })),
    );
  }
  if (!isBatchChildReport(child)) {
    return unableToVerify(
      "the re-verification batch returned a malformed report — the verdict cannot be taken from it",
      runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: "", note: "unable-to-verify: malformed batch report" })),
    );
  }
  const change = child.changes.find((c) => c.changeId === runInput.itemKey);
  if (!change) {
    return unableToVerify(
      "the re-verification batch returned no result for " + runInput.itemKey,
      runInput.suites.map((s) => ({ suite: s, passed: false, ok: 0, logPath: "", note: "unable-to-verify: no batch result" })),
    );
  }
  const suites: DualReportSuiteResult[] = change.suites.map((s) => ({
    suite: s.suite,
    passed: s.passed,
    ok: s.ok,
    logPath: s.logPath,
    note: s.note,
  }));
  // A suite the batch never recorded (missing from the change) is
  // a failure with the reason named, never a silent pass.
  for (const s of runInput.suites) {
    if (!suites.some((r) => r.suite === s)) {
      suites.push({ suite: s, passed: false, ok: 0, logPath: "", note: "the batch recorded no result for this suite" });
    }
  }
  const taken = verdictFromBatch(child);
  const verdict: DualReportVerdict = taken.verdict;
  const failing = suites.find((s) => !s.passed);
  const failingSuite = taken.failingSuite ?? failing?.suite;
  let failingLogTail: string[] | undefined;
  const notes: string[] = [];
  if (verdict === "FAIL" && failingSuite) {
    const failingResult = suites.find((s) => s.suite === failingSuite);
    const failingNote = failingResult?.note ?? taken.reason ?? "suite failed";
    notes.push("dual-report: " + runInput.itemKey + " FAIL — suite " + failingSuite + " failed: " + failingNote);
    if (failingResult && failingResult.logPath !== "") {
      const tailOut = exec({ cmd: "/bin/sh", args: ["-c", logTailScript(failingResult.logPath, 20)] });
      if (tailOut.exitCode === 0) {
        const tail = (tailOut.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "" && l !== "TAIL-MISSING");
        if (tail.length > 0) failingLogTail = tail;
      }
    }
  }
  if (verdict === "PASS") {
    notes.push("dual-report: " + runInput.itemKey + " PASS — " + suites.length + " suite(s) re-verified end to end");
  }
  if (!owningLeadPayloadProduced) {
    notes.push("dual-report: no owning-lead payload — " + (owningLeadReason ?? "no owning lead"));
  }
  return buildDualReportReport({
    reportId: runInput.reportId,
    itemKey: runInput.itemKey,
    itemTitle: runInput.itemTitle,
    verdict,
    dryRun,
    owner: (input as DualReportInput).owner,
    launchedBy: input.launchedBy,
    cancelChecked,
    cancelled,
    suites,
    failingSuite,
    failingLogTail,
    reason: taken.reason,
    batchId,
    deliveryPayloads: buildDualReportPayloads({
      reportId: runInput.reportId,
      itemKey: runInput.itemKey,
      itemTitle: runInput.itemTitle,
      verdict,
      suites,
      failingSuite,
      reason: taken.reason,
      owningLeadTarget,
    }),
    owningLeadPayloadProduced,
    owningLeadReason,
    notes,
  });
}
