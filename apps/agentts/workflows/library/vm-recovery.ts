// vm-recovery — recover a VM replacement (BRA-246).
//
// A VM replacement kills the production worker server mid-run:
// runs are stranded at "running" in the queue, journals stop
// mid-slice, the tick goes dead. Today the recovery is a person
// (the Director tasks the lead by hand). This workflow makes it
// automatic: detect the replacement, restart the server, name
// every interrupted run with its resume point, and tell the
// affected leads which of their runs resumed and which could not.
//
// Detection (decision 5, settled): the workflow keeps a boot-id
// record at `<stateDir>/boot-id` — the kernel's boot id
// (`/proc/sys/kernel/random/boot_id`), written by this workflow
// on real runs. The first run with no record ESTABLISHES it
// (not a replacement — a fresh state dir has no baseline). A
// later run whose current boot id differs from the recorded one
// IS a replacement. A run whose boot id matches reports
// no-replacement and exits (a down server with no replacement
// is 245's job, not this workflow's). The current boot id is
// read from /proc, never guessed; a run that cannot read it
// refuses loudly (it cannot detect replacements without it).
// A corrupt recorded id (not a boot-id shape) refuses loudly
// rather than re-establishing silently — a corrupt record could
// mask a replacement.
//
// Restart (decision 5): on a replacement the workflow restarts
// the server with 245's helpers (the same standing command, the
// same spawn + verify budget — 30 attempts one second apart)
// and verifies /health answers ok:true — UNLESS the server is
// already up: then it verifies /health, reports that it is up,
// and does NOT restart a running server (never kill a live
// server to restart it, never spawn a second one on a bound
// port — the spawn would die on the bind and the report would
// claim a restart that never happened). The systemd unit starts
// the server before running 246, so on a real replacement the
// server is already up when this workflow runs. The boot-id
// record is updated on DETECTION, before the restart — so a
// failed restart does not re-fire detection on the same boot
// (the replacement is real regardless of the restart outcome,
// and 245's cron restarts a still-down server). A restart that
// is not verified is reported as not-verified, never as up.
//
// Resume (decision 5): the workflow does NOT drive the queue
// itself (the driver lock is held by its own drive — a nested
// `queue run` would refuse) and does NOT execute a full tier-1
// inside an exec trap (unbounded time). It CLASSIFIES each
// interrupted run and names the resume dir + resume point; the
// launcher drives the resumes. The classification mirrors the
// engine's `classifyStrandedEntry` (src/host.ts) evidence,
// run by run:
//   - journal lifecycle "completed" → finished (the run
//     finished; the driver crashed before the queue write).
//   - journal lifecycle "failed" → failed (the error named).
//   - registry rc 2/3 (suspended at a trap/fork) + snapshot
//     blob present → resumable: the restarted server's queue
//     drive re-drives from the blob (repair + drive).
//   - registry rc 2/3 + blob missing → could-not-resume
//     (snapshot lost; nothing to resume from).
//   - registry rc 0 → finished (the registry shows completed).
//   - registry rc 1 (C-host crash mid-slice) + blob →
//     resumable from the blob; + no blob → could-not-resume.
//   - registry other rc → failed (exited N).
//   - no registry entry + trap activity in the journal →
//     could-not-resume: state is inconsistent (registry lost);
//     re-driving would restart from scratch and could
//     double-execute the dispatched trap. Left for a human.
//   - no registry entry + no trap activity → resumable: the
//     run never started; re-drive starts it fresh.
// Candidates are the queue entries stranded at "running"
// (the engine's repair iterates the queue, and so does this
// workflow — a journal with no queue entry is not stranded).
// A run with no/corrupt resume dir is reported and its lead
// notified, never silently dropped (decision 5): the
// caller-supplied `run.resumeDirs` mapping (runId → resume
// dir) names the resume dir; a run with no mapping is a
// workflow run (resume via the queue drive from its blob), and
// a suite run is one WITH a mapping (resume via
// `run.sh --resume-dir`, next section = the first tier-1
// section without a `.done/` marker, from suite-inventory.json
// + a bounded `.done/` listing).
//
// Trigger (decision 3, settled): the workflow runs at boot from
// a systemd user unit — the unit file is DELIVERED by the
// workflow to `<stateDir>/vm-recovery.service` on real runs
// (idempotent content, written with the dispatch chunked-write
// pattern); the lead enables it once by hand (the workflow
// never installs systemd units itself):
//   cp <stateDir>/vm-recovery.service ~/.config/systemd/user/agentts-vm-recovery.service
//   systemctl --user daemon-reload
//   systemctl --user enable agentts-vm-recovery.service
// The unit runs at boot (WantedBy=default.target): it starts
// the worker server (the standing command, log to
// <runsDir>/server-restart-boot.log), waits 2s, runs the 246
// recovery workflow via the CLI with the input file
// <stateDir>/vm-recovery-input.json (written once by the lead
// from this header's shape — the workflow never writes its own
// input file), then drives the queue:
//   ExecStart=/bin/sh -c 'nohup <serverCommand> > <runsDir>/server-restart-boot.log 2>&1 < /dev/null & sleep 2; <bun> src/cli.ts run workflows/library/vm-recovery.ts --run-id run-bra246-boot-$(cat /proc/sys/kernel/random/boot_id | cut -c1-8) --input-file <stateDir>/vm-recovery-input.json --state-dir <stateDir> --adapter direct --clock real --gates hold; <bun> src/cli.ts queue run --state-dir <stateDir> --adapter direct --clock real --gates hold'
// The run-id uses the boot id's first 8 characters (unique per
// boot, no `%` — systemd would try to expand `%Y` et al in a
// date format). The unit's server start is belt-and-braces:
// 246 restarts the server itself when it is down, so a failed
// unit-side start is retried by the workflow; a successful one
// means 246 only verifies. The §D cases are driven by the same
// CLI invocation the unit would run.
// The 245 watchdog cron (every 15 min, see server-restart.ts)
// is the second half of the trigger: a replacement the unit
// misses (unit not enabled, boot before the unit existed) is
// still caught by 245's restart + 246's next manual run — the
// boot-id record persists, so the replacement is detected
// whenever 246 next runs.
//
// Reads go through exec traps in the dispatch pattern, never
// trap stdout, never `Buffer`. Per-file read bounds: 48KB
// generic (queue, suite inventory), 16KB for the tick state +
// registry entries + boot-id record. The journal is never read
// whole: a scan script walks it and prints one bounded summary
// line. An over-bound file is recorded missing-with-reason,
// never truncated into a wrong parse.
//
// Cancel is check-then-act (the triage pattern); a null/absent
// run is refused, never dereferenced. Dry-run writes nothing —
// not the boot-id record, not the unit file, and it does not
// start the server; it still computes the classification (reads
// only) and reports what would resume.
//
// The workflow sends no messages: the report returns delivery
// payloads for the launcher (the daily-brief pattern) — the
// Director when a replacement was detected or the trigger was
// established, one per affected lead (owner of a resumed or
// could-not-resume run) when a replacement was detected. A
// routine no-replacement check emits no payload.
//
// Known v0 limits, carried verbatim in every report:
//
// - The workflow detects a replacement from the boot-id
//   record it writes itself; the first run establishes the
//   record (not a replacement). It restarts the server and
//   NAMES the interrupted runs with their resume points — it
//   does not drive the resumes itself (the launcher does, via
//   run.sh --resume-dir for suite runs and the queue drive for
//   workflow runs). A run with no resume dir recorded is
//   reported as could-not-resume and its lead notified, never
//   silently dropped. The workflow sends no messages — the
//   launcher delivers the payloads. It never closes, merges,
//   or decides acceptance.
import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import { readFileScript, parseReadOutput, chunkWriteScript, finalizeWriteScript } from "./daily-brief";
import { splitHandoffChunks, parseWriteSummary } from "./dispatch";
import {
  SERVER_RESTART_READ_MAX_BYTES,
  SERVER_RESTART_SMALL_MAX_BYTES,
  SERVER_RESTART_VERIFY_ATTEMPTS,
  SERVER_RESTART_VERIFY_INTERVAL_MS,
  healthPollScript,
  parseHealthPoll,
  restartSpawnScript,
  parseSpawnResult,
  restartLogIndexScript,
  parseRestartLogIndex,
  parseQueueEntries,
  type HealthState,
  type DeliveryPayload,
  type MissingSource,
} from "./server-restart";

/** The known-limit string, carried verbatim in every report. */
export const VM_RECOVERY_KNOWN_LIMIT =
  "The workflow detects a replacement from the boot-id record it writes itself; the first run establishes the " +
  "record (not a replacement). It restarts the server and NAMES the interrupted runs with their resume points — it " +
  "does not drive the resumes itself (the launcher does, via run.sh --resume-dir for suite runs and the queue drive " +
  "for workflow runs). A run with no resume dir recorded is reported as could-not-resume and its lead notified, never " +
  "silently dropped. The workflow sends no messages — the launcher delivers the payloads. " +
  "It never closes, merges, or decides acceptance.";

/** The boot-id record + unit file live under the state dir. */
export const VM_RECOVERY_BOOT_ID_FILE = "boot-id";
export const VM_RECOVERY_UNIT_FILE = "vm-recovery.service";
export const VM_RECOVERY_UNIT_NAME = "agentts-vm-recovery.service";
export const VM_RECOVERY_INPUT_FILE = "vm-recovery-input.json";

export type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** A kernel boot id is 32 hex chars in 8-4-4-4-12 groups. */
export function isBootIdShape(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

/** The engine's filename stem for a runId (src/host.ts:520):
 * runId with `/` replaced by `_`. */
export function prefixForRunId(runId: string): string {
  return runId.replace(/\//g, "_");
}

export interface VmRecoveryProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster: Record<string, string>;
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir: string;
}

export interface VmRecoveryRunInput {
  /** The worker server's base URL (for the health check). */
  serverUrl: string;
  /** The state dir the boot-id record + queue + journals live under. */
  stateDir: string;
  /** The engine checkout dir the server command runs from. */
  engineDir: string;
  /** The full server argv (see server-restart.ts). */
  serverCommand: string[];
  /** Where restart logs go. */
  runsDir: string;
  /** Caller-supplied resume-dir mapping (runId → resume dir)
   * for suite runs. A run with no mapping is a workflow run. */
  resumeDirs?: Record<string, string>;
  /** Verify attempts after a restart (default 30). */
  verifyAttempts?: number;
  /** Verify interval in ms (default 1000). */
  verifyIntervalMs?: number;
  dryRun?: boolean;
  runId?: string;
  now?: string;
  bunPath?: string;
}

export interface VmRecoveryInput {
  project: VmRecoveryProjectConfig;
  run: VmRecoveryRunInput;
  owner: string;
  launchedBy?: string;
}

export interface ResumedRun {
  runId: string;
  owner: string | null;
  lead: string | null;
  kind: "workflow" | "suite";
  resumeDir: string | null;
  /** The journal's last event (workflow) or the next tier-1
   * section slug (suite). */
  resumePoint: string;
  resumeMechanism: "queue-drive" | "run.sh --resume-dir";
  reason: string;
}

export interface CouldNotResumeRun {
  runId: string;
  owner: string | null;
  lead: string | null;
  kind: "workflow" | "suite";
  reason: string;
}

export interface FailedRun {
  runId: string;
  owner: string | null;
  error: string;
}

export interface TriggerInfo {
  /** The delivered unit file (<stateDir>/vm-recovery.service). */
  unitPath: string;
  /** Whether the unit is enabled in ~/.config/systemd/user/. */
  unitEnabled: boolean;
  /** The exact commands the lead runs once to enable it. */
  enableCommands: string[];
  /** The 245 cron command + schedule (the second half of the
   * trigger — see server-restart.ts). */
  cron245: string;
  /** The input file the unit's 246 invocation reads. */
  inputFilePath: string;
}

export type VmRecoveryVerdict = "recovered" | "no-replacement" | "established" | "failed" | "dry-run";

export interface VmRecoveryReport {
  recoveryId: string;
  verdict: VmRecoveryVerdict;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  oldBootId: string | null;
  newBootId: string;
  replacement: boolean;
  firstRun: boolean;
  server: {
    restarted: boolean;
    verified: boolean;
    healthBefore: HealthState;
    healthAfter: HealthState;
    restartLogPath?: string;
  };
  resumed: ResumedRun[];
  couldNotResume: CouldNotResumeRun[];
  /** Runs whose journals show lifecycle completed. */
  finished: string[];
  /** Runs whose journals show lifecycle failed. */
  failedRuns: string[];
  deliveryPayloads: DeliveryPayload[];
  trigger: TriggerInfo;
  missing: MissingSource[];
  notes: string[];
  knownLimit: string;
}

/** Validate the run input (validate-first: no `refused()`
 * defect). Returns the error strings; empty means valid. */
export function validateVmRecoveryInput(input: VmRecoveryInput): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["input is not an object"];
  if (!isPlainObject(input.project)) errors.push("project is not an object");
  else {
    if (!isNonEmptyString(input.project.linearProject)) errors.push("project.linearProject must be a non-empty string");
    if (!isNonEmptyString(input.project.repo)) errors.push("project.repo must be a non-empty string");
    if (!isNonEmptyString(input.project.stateDir)) errors.push("project.stateDir must be a non-empty string");
    if (!isPlainObject(input.project.roster)) errors.push("project.roster must be an object");
    if (!isNonEmptyString(input.project.workDir)) errors.push("project.workDir must be a non-empty string");
    if (!isNonEmptyString(input.project.resumeDir)) errors.push("project.resumeDir must be a non-empty string");
  }
  if (!isPlainObject(input.run)) errors.push("run is not an object");
  else {
    const r = input.run as JsonObject;
    if (!isNonEmptyString(r["serverUrl"])) errors.push("run.serverUrl must be a non-empty string");
    if (!isNonEmptyString(r["stateDir"])) errors.push("run.stateDir must be a non-empty string");
    if (!isNonEmptyString(r["engineDir"])) errors.push("run.engineDir must be a non-empty string");
    if (!Array.isArray(r["serverCommand"]) || r["serverCommand"].length === 0) {
      errors.push("run.serverCommand must be a non-empty array of strings");
    } else if (!r["serverCommand"].every((e) => isNonEmptyString(e))) {
      errors.push("run.serverCommand entries must be non-empty strings");
    }
    if (!isNonEmptyString(r["runsDir"])) errors.push("run.runsDir must be a non-empty string");
    if (r["resumeDirs"] !== undefined) {
      if (!isPlainObject(r["resumeDirs"])) errors.push("run.resumeDirs must be an object when present");
      else {
        for (const [k, v] of Object.entries(r["resumeDirs"])) {
          if (!isNonEmptyString(v)) errors.push("run.resumeDirs[" + JSON.stringify(k) + "] must be a non-empty string");
        }
      }
    }
    if (r["verifyAttempts"] !== undefined && (typeof r["verifyAttempts"] !== "number" || r["verifyAttempts"] < 1)) {
      errors.push("run.verifyAttempts must be a number >= 1 when present");
    }
    if (r["verifyIntervalMs"] !== undefined && (typeof r["verifyIntervalMs"] !== "number" || r["verifyIntervalMs"] < 0)) {
      errors.push("run.verifyIntervalMs must be a number >= 0 when present");
    }
    if (r["dryRun"] !== undefined && typeof r["dryRun"] !== "boolean") errors.push("run.dryRun must be a boolean when present");
    if (r["runId"] !== undefined && !isNonEmptyString(r["runId"])) errors.push("run.runId must be a non-empty string when present");
    if (r["now"] !== undefined && (typeof r["now"] !== "string" || Number.isNaN(Date.parse(r["now"])))) {
      errors.push("run.now must be an ISO date string when present");
    }
  }
  if (!isNonEmptyString(input.owner)) errors.push("owner is required and must be a non-empty string");
  if (input.launchedBy !== undefined && !isNonEmptyString(input.launchedBy)) {
    errors.push("launchedBy must be a non-empty string when present");
  }
  return errors;
}

/** Build the current-boot-id read script: prints
 * `BOOTID <id>`. Exit 1 when /proc has no boot id. Pure. */
export function bootIdScript(): string {
  return "id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d ' \\n'); if [ -z \"$id\" ]; then echo 'BOOTID-MISSING'; exit 1; fi; echo \"BOOTID $id\"\n";
}

/** Parse the boot-id trap's output. Pure. */
export function parseBootId(text: string): string | null {
  const m = text.match(/BOOTID ([0-9a-f-]+)/);
  return m ? m[1]! : null;
}

/** Build the journal-summary script: scans the whole journal
 * file (streaming, one line at a time — the file is never read
 * whole into the trap output) and prints one bounded summary
 * line plus, when the journal shows a lifecycle failure, the
 * error on a second line:
 *   JOURNAL <total> <completed 0/1> <failed 0/1> <trapActivity 0/1> <lastEvent> <lastWallTs>
 *   FAILED-ERROR <error, first 200 chars, newlines stripped>
 * Exit 2 = file missing, 1 = unreadable. Pure. */
export function journalSummaryScript(journalPath: string): string {
  const trapEvents = JSON.stringify(["trap", "trap-dispatch", "trap-dispatched", "trap-result", "trap-error", "fork"]);
  return (
    "python3 -c '\n" +
    "import json, sys\n" +
    "p = sys.argv[1]\n" +
    "trap_events = set(json.loads(sys.argv[2]))\n" +
    "total = 0\n" +
    "completed = 0\n" +
    "failed = 0\n" +
    "trap_activity = 0\n" +
    "last_event = \"-\"\n" +
    "last_wall_ts = \"-\"\n" +
    "fail_error = \"\"\n" +
    "try:\n" +
    "    f = open(p, \"rb\")\n" +
    "except FileNotFoundError:\n" +
    "    print(\"JOURNAL-MISSING \" + p)\n" +
    "    sys.exit(2)\n" +
    "except OSError as e:\n" +
    "    print(\"JOURNAL-ERROR \" + str(e)[:200])\n" +
    "    sys.exit(1)\n" +
    "for raw in f:\n" +
    "    line = raw.decode(\"utf-8\", \"replace\").strip()\n" +
    "    if not line:\n" +
    "        continue\n" +
    "    try:\n" +
    "        obj = json.loads(line)\n" +
    "    except Exception:\n" +
    "        continue\n" +
    "    if not isinstance(obj, dict):\n" +
    "        continue\n" +
    "    total += 1\n" +
    "    ev = obj.get(\"event\")\n" +
    "    if isinstance(ev, str) and ev:\n" +
    "        last_event = ev\n" +
    "    wt = obj.get(\"wallTs\")\n" +
    "    if isinstance(wt, str) and wt:\n" +
    "        last_wall_ts = wt\n" +
    "    if ev == \"lifecycle\":\n" +
    "        if obj.get(\"lifecycle\") == \"completed\":\n" +
    "            completed = 1\n" +
    "        elif obj.get(\"lifecycle\") == \"failed\":\n" +
    "            failed = 1\n" +
    "            err = obj.get(\"error\")\n" +
    "            if isinstance(err, str) and err:\n" +
    "                fail_error = err.replace(\"\\n\", \" \")[:200]\n" +
    "    if ev in trap_events:\n" +
    "        trap_activity = 1\n" +
    "print(\"JOURNAL %d %d %d %d %s %s\" % (total, completed, failed, trap_activity, last_event, last_wall_ts))\n" +
    "if failed:\n" +
    "    print(\"FAILED-ERROR \" + (fail_error if fail_error else \"run failed (see journal)\"))\n" +
    "' " +
    shellQuote(journalPath) +
    " " +
    shellQuote(trapEvents) +
    "\n"
  );
}

export interface JournalSummary {
  total: number;
  completed: boolean;
  failed: boolean;
  trapActivity: boolean;
  lastEvent: string;
  lastWallTs: string;
  failError: string | null;
}

/** Parse the journal-summary trap's output. Pure. Returns
 * null when the output carries no JOURNAL line (missing /
 * unreadable — the caller records the reason from the trap's
 * exit code). */
export function parseJournalSummary(text: string): JournalSummary | null {
  const lines = text.split("\n").map((l) => l.trim());
  const summaryLine = lines.find((l) => l.startsWith("JOURNAL "));
  if (!summaryLine) return null;
  const m = /^JOURNAL (\d+) ([01]) ([01]) ([01]) (\S+) (\S+)$/.exec(summaryLine);
  if (!m) return null;
  const errorLine = lines.find((l) => l.startsWith("FAILED-ERROR "));
  return {
    total: parseInt(m[1]!, 10),
    completed: m[2] === "1",
    failed: m[3] === "1",
    trapActivity: m[4] === "1",
    lastEvent: m[5]!,
    lastWallTs: m[6]!,
    failError: errorLine ? errorLine.slice("FAILED-ERROR ".length) : null,
  };
}

/** Build a bounded directory-stems listing script: prints
 * `LIST <count>` then one stem per line (the filename minus
 * the suffix, or the whole filename when the suffix is "").
 * Missing dir → `LIST 0`. Capped at maxEntries (truncation is
 * named). Pure. */
export function listStemsScript(dir: string, suffix: string, maxEntries: number): string {
  return (
    "python3 -c '\n" +
    "import os, sys\n" +
    "d = sys.argv[1]\n" +
    "suffix = sys.argv[2]\n" +
    "mx = int(sys.argv[3])\n" +
    "try:\n" +
    "    names = sorted(os.listdir(d))\n" +
    "except FileNotFoundError:\n" +
    "    print(\"LIST 0\")\n" +
    "    sys.exit(0)\n" +
    "stems = []\n" +
    "truncated = False\n" +
    "for name in names:\n" +
    "    if suffix and not name.endswith(suffix):\n" +
    "        continue\n" +
    "    stem = name[:-len(suffix)] if suffix else name\n" +
    "    if len(stems) < mx:\n" +
    "        stems.append(stem)\n" +
    "    else:\n" +
    "        truncated = True\n" +
    "print(\"LIST %d%s\" % (len(stems), \" TRUNCATED\" if truncated else \"\"))\n" +
    "for s in stems:\n" +
    "    print(s)\n" +
    "' " +
    shellQuote(dir) +
    " " +
    shellQuote(suffix) +
    " " +
    String(maxEntries) +
    "\n"
  );
}

/** Parse a LIST trap's output. Pure. */
export function parseListStems(text: string): { stems: string[]; truncated: boolean } {
  const stems: string[] = [];
  let truncated = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("LIST ")) truncated = t.includes("TRUNCATED");
    else if (t !== "") stems.push(t);
  }
  return { stems, truncated };
}

/** Build the file-exists script: prints `EXISTS 1` / `EXISTS 0`.
 * Pure. */
export function existsScript(path: string): string {
  return "if [ -f " + shellQuote(path) + " ]; then echo 'EXISTS 1'; else echo 'EXISTS 0'; fi\n";
}

/** Parse an EXISTS trap's output. Pure. */
export function parseExists(text: string): boolean {
  return text.includes("EXISTS 1");
}

/** Build the unit-enabled check script: tests the systemd
 * user unit path under $HOME (the shell expands $HOME — the
 * workflow never needs to know the home dir). Pure. */
export function unitEnabledScript(unitName: string): string {
  return "if [ -f \"$HOME/.config/systemd/user/" + unitName + "\" ]; then echo 'EXISTS 1'; else echo 'EXISTS 0'; fi\n";
}

/** Classify one interrupted run from the engine's evidence —
 * the mirror of `classifyStrandedEntry` (src/host.ts). Pure.
 * Returns a resume (workflow or suite), a finished/failed
 * verdict, or a could-not-resume with the reason named. */
export function classifyInterruptedRun(args: {
  runId: string;
  owner: string | null;
  lead: string | null;
  journal: JournalSummary | null;
  journalMissing: boolean;
  registryRc: number | null;
  registryMissing: boolean;
  blobExists: boolean;
  resumeDir: string | null;
  nextSuiteSection: string | null;
}): { outcome: "resumed"; resumed: ResumedRun } | { outcome: "finished" } | { outcome: "failed"; error: string } | { outcome: "could-not-resume"; reason: string } {
  const { runId, owner, lead } = args;
  // A missing journal means no evidence at all: the run never
  // wrote a journal, so there is nothing to classify from —
  // could-not-resume with the reason named (never silently
  // dropped, never assumed finished).
  if (args.journalMissing || args.journal === null) {
    return {
      outcome: "could-not-resume",
      reason: "no journal file for this run — nothing to classify from (the run never wrote a journal or its journal is lost)",
    };
  }
  const j = args.journal;
  if (j.completed) return { outcome: "finished" };
  if (j.failed) {
    return { outcome: "failed", error: j.failError ?? "run failed (see journal)" };
  }
  const suite = args.resumeDir !== null;
  const resumePoint = suite ? args.nextSuiteSection ?? "(all sections done — nothing left to resume)" : j.lastEvent;
  const mechanism: "queue-drive" | "run.sh --resume-dir" = suite ? "run.sh --resume-dir" : "queue-drive";
  const makeResumed = (reason: string): { outcome: "resumed"; resumed: ResumedRun } => ({
    outcome: "resumed",
    resumed: {
      runId,
      owner,
      lead,
      kind: suite ? "suite" : "workflow",
      resumeDir: args.resumeDir,
      resumePoint,
      resumeMechanism: mechanism,
      reason,
    },
  });
  const makeCouldNot = (reason: string): { outcome: "could-not-resume"; reason: string } => ({ outcome: "could-not-resume", reason });

  if (!args.registryMissing) {
    const rc = args.registryRc;
    if (rc === 2 || rc === 3) {
      if (args.blobExists) {
        return makeResumed(
          suite
            ? "suspended at a trap/fork (registry rc " + rc + ") with its snapshot blob on disk — suite resume from " + args.resumeDir + " (next section " + resumePoint + ")"
            : "suspended at a trap/fork (registry rc " + rc + ") with its snapshot blob on disk — re-drive resumes from the blob (the BRA-75 journal check guards re-dispatch)",
        );
      }
      return makeCouldNot("suspended at a trap/fork (registry rc " + rc + ") but the snapshot blob is missing — the run cannot be resumed");
    }
    if (rc === 0) return { outcome: "finished" };
    if (rc === 1) {
      if (args.blobExists) {
        return makeResumed(
          suite
            ? "C-host crash mid-slice (registry rc 1, no lifecycle-failed event) with the snapshot blob intact — suite resume from " + args.resumeDir + " (next section " + resumePoint + ")"
            : "C-host crash mid-slice (registry rc 1, no lifecycle-failed event) — last snapshot blob intact, re-drive resumes from the blob",
        );
      }
      return makeCouldNot("C-host crash mid-slice (registry rc 1) but the snapshot blob is missing — the run cannot be resumed");
    }
    if (rc !== null) {
      return { outcome: "failed", error: "registry shows the run exited " + rc };
    }
    return makeCouldNot("registry entry exists but carries no exit code — state is inconsistent; left for a human to inspect");
  }
  // No registry entry: trap activity is the tell (the engine's
  // rule) — re-driving would restart from scratch and could
  // double-execute the dispatched trap.
  if (j.trapActivity) {
    return makeCouldNot(
      "journal shows trap/fork activity but there is no registry entry — state is inconsistent (registry lost); re-driving would restart from scratch and could double-execute the dispatched trap. Left for a human to inspect.",
    );
  }
  return makeResumed("no registry entry and no trap activity in the journal — the run never started; re-drive starts it fresh");
}

/** The next tier-1 section from the suite inventory + the
 * done-marker set: the first tier-1 slug without a `.done/`
 * marker, in inventory order. Null when every tier-1 section
 * is done. Pure. */
export function nextSuiteSection(args: {
  inventoryText: string;
  doneMarkers: Set<string>;
}): { next: string | null; reason: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.inventoryText);
  } catch {
    return { next: null, reason: "suite-inventory.json is unparsable JSON" };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed["sections"])) {
    return { next: null, reason: "suite-inventory.json has no sections array" };
  }
  const tier1: string[] = [];
  for (const s of parsed["sections"]) {
    if (isPlainObject(s) && isNonEmptyString(s["slug"]) && s["tier"] === 1) tier1.push(s["slug"]);
  }
  for (const slug of tier1) {
    if (!args.doneMarkers.has(slug)) return { next: slug, reason: null };
  }
  return { next: null, reason: null };
}

/** Build the systemd user unit file content (pure). The
 * run-id uses the boot id's first 8 characters — unique per
 * boot, and with no `%` (systemd would try to expand a date
 * format's `%Y` et al as specifiers). */
export function vmRecoveryUnitContent(args: {
  engineDir: string;
  serverCommand: string[];
  runsDir: string;
  stateDir: string;
  bunPath: string;
}): string {
  const serverCmd = args.serverCommand.map((a) => shellQuote(a)).join(" ");
  const lines = [
    "# AgentTS VM-replacement recovery (BRA-246).",
    "# Delivered by the vm-recovery workflow to <stateDir>/vm-recovery.service.",
    "# Enable once by hand (the lead, not the workflow):",
    "#   cp " + args.stateDir + "/" + VM_RECOVERY_UNIT_FILE + " ~/.config/systemd/user/" + VM_RECOVERY_UNIT_NAME,
    "#   systemctl --user daemon-reload",
    "#   systemctl --user enable " + VM_RECOVERY_UNIT_NAME,
    "# (The copy step matters: systemd reads the unit from",
    "# ~/.config/systemd/user/, not from the state dir.)",
    "# The unit runs at boot (WantedBy=default.target): it starts",
    "# the worker server, then runs the 246 recovery workflow via",
    "# the CLI with the input file " + args.stateDir + "/" + VM_RECOVERY_INPUT_FILE + ", then drives the queue.",
    "[Unit]",
    "Description=AgentTS VM-replacement recovery (BRA-246)",
    "After=network.target",
    "",
    "[Service]",
    "Type=oneshot",
    "WorkingDirectory=" + args.engineDir,
    "ExecStart=/bin/sh -c 'nohup " +
      serverCmd +
      " > " +
      args.runsDir +
      "/server-restart-boot.log 2>&1 < /dev/null & sleep 2; " +
      args.bunPath +
      " src/cli.ts run workflows/library/vm-recovery.ts --run-id run-bra246-boot-$(cat /proc/sys/kernel/random/boot_id | cut -c1-8) --input-file " +
      args.stateDir +
      "/" +
      VM_RECOVERY_INPUT_FILE +
      " --state-dir " +
      args.stateDir +
      " --adapter direct --clock real --gates hold; " +
      args.bunPath +
      " src/cli.ts queue run --state-dir " +
      args.stateDir +
      " --adapter direct --clock real --gates hold'",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

/** Build the delivery payloads for the launcher. Pure. The
 * Director is named when a replacement was detected (or the
 * trigger was established); each affected lead is named when a
 * replacement was detected, with their runs (resumed vs
 * could-not-resume with the reason, failed with the error).
 * A routine no-replacement check emits no payload. */
export function buildVmRecoveryDeliveryPayloads(args: {
  verdict: VmRecoveryVerdict;
  recoveryId: string;
  oldBootId: string | null;
  newBootId: string;
  serverVerified: boolean;
  resumed: ResumedRun[];
  couldNotResume: CouldNotResumeRun[];
  failed: FailedRun[];
  ownerRoster: Record<string, string>;
}): DeliveryPayload[] {
  const payloads: DeliveryPayload[] = [];
  if (args.verdict === "established") {
    payloads.push({
      target: "director",
      message:
        "Meroki (vm-recovery " +
        args.recoveryId +
        "): the VM-replacement trigger is armed — boot-id record established (" +
        args.newBootId.slice(0, 8) +
        "…), unit file delivered to the state dir. Enable it once with the commands in the report.",
    });
    return payloads;
  }
  if (args.verdict !== "recovered" && args.verdict !== "failed") return payloads;
  const what =
    args.verdict === "recovered"
      ? "a VM replacement was detected (boot " + (args.oldBootId ?? "(none)").slice(0, 8) + "… → " + args.newBootId.slice(0, 8) + "…) and the server is back up and verified"
      : "a VM replacement was detected (boot " + (args.oldBootId ?? "(none)").slice(0, 8) + "… → " + args.newBootId.slice(0, 8) + "…) but the recovery FAILED — the server is " + (args.serverVerified ? "verified up" : "NOT verified up") + "; see the report";
  payloads.push({
    target: "director",
    message:
      "Meroki (vm-recovery " +
      args.recoveryId +
      "): " +
      what +
      ". Resumed: " +
      args.resumed.length +
      " runs; could-not-resume: " +
      args.couldNotResume.length +
      " runs; failed: " +
      args.failed.length +
      " runs.",
  });
  const byOwner = new Map<string, { resumed: string[]; couldNot: { runId: string; reason: string }[]; failed: FailedRun[] }>();
  const bucketFor = (owner: string): { resumed: string[]; couldNot: { runId: string; reason: string }[]; failed: FailedRun[] } => {
    const bucket = byOwner.get(owner) ?? { resumed: [], couldNot: [], failed: [] };
    byOwner.set(owner, bucket);
    return bucket;
  };
  for (const r of args.resumed) {
    if (!r.owner) continue;
    bucketFor(r.owner).resumed.push(r.runId + " (" + r.resumeMechanism + " from " + r.resumePoint + ")");
  }
  for (const r of args.couldNotResume) {
    if (!r.owner) continue;
    bucketFor(r.owner).couldNot.push({ runId: r.runId, reason: r.reason });
  }
  for (const r of args.failed) {
    if (!r.owner) continue;
    bucketFor(r.owner).failed.push(r);
  }
  for (const [owner, bucket] of [...byOwner.entries()].sort()) {
    const leadName = args.ownerRoster[owner] ?? owner;
    const parts: string[] = [];
    if (bucket.resumed.length > 0) parts.push("resumed: " + bucket.resumed.join("; "));
    if (bucket.couldNot.length > 0) {
      parts.push(
        "could NOT resume: " +
          bucket.couldNot.map((c) => c.runId + " — " + c.reason).join("; "),
      );
    }
    if (bucket.failed.length > 0) {
      parts.push("failed: " + bucket.failed.map((c) => c.runId + " — " + c.error).join("; "));
    }
    payloads.push({
      target: owner,
      message:
        "Meroki (vm-recovery " +
        args.recoveryId +
        "): a VM replacement interrupted your runs (" +
        leadName +
        "). " +
        parts.join(". ") +
        ".",
    });
  }
  return payloads;
}

/** The trigger info for a state dir (pure): the unit path,
 * the enable commands, the 245 cron, the input file path.
 * unitEnabled is filled in by the entry (a trap read). */
export function baseTriggerInfo(stateDir: string): TriggerInfo {
  return {
    unitPath: stateDir + "/" + VM_RECOVERY_UNIT_FILE,
    unitEnabled: false,
    enableCommands: [
      "cp " + stateDir + "/" + VM_RECOVERY_UNIT_FILE + " ~/.config/systemd/user/" + VM_RECOVERY_UNIT_NAME,
      "systemctl --user daemon-reload",
      "systemctl --user enable " + VM_RECOVERY_UNIT_NAME,
    ],
    cron245:
      "bun <engineDir>/src/cli.ts run workflows/library/server-restart.ts " +
      "--run-id run-bra245-$(date -u +%Y%m%dT%H%M%SZ) " +
      "--input-file <stateDir>/server-restart-input.json --state-dir <stateDir> " +
      "--adapter direct --clock real --gates hold && " +
      "bun <engineDir>/src/cli.ts queue run --state-dir <stateDir> " +
      "--adapter direct --clock real --gates hold (every 15 minutes)",
    inputFilePath: stateDir + "/" + VM_RECOVERY_INPUT_FILE,
  };
}

/** The refused-report builder: a failed report with the base
 * defaults, the reasons named in missing + notes. */
function refusedVmRecoveryReport(args: {
  recoveryId: string;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  stateDir: string;
  newBootId: string;
  reasons: string[];
}): VmRecoveryReport {
  return {
    recoveryId: args.recoveryId,
    verdict: "failed",
    dryRun: false,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    oldBootId: null,
    newBootId: args.newBootId,
    replacement: false,
    firstRun: false,
    server: {
      restarted: false,
      verified: false,
      healthBefore: { reachable: false, ok: false, detail: "unknown" },
      healthAfter: { reachable: false, ok: false, detail: "unknown" },
    },
    resumed: [],
    couldNotResume: [],
    finished: [],
    failedRuns: [],
    deliveryPayloads: [],
    trigger: baseTriggerInfo(args.stateDir),
    missing: args.reasons.map((r) => ({ source: "validation", reason: r })),
    notes: args.reasons,
    knownLimit: VM_RECOVERY_KNOWN_LIMIT,
  };
}

type ReadResult =
  | { kind: "ok"; total: number; printed: number; content: string }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/** Read one file through a bounded exec trap (the daily-brief
 * pattern). A missing file is a result, not a throw. */
function readFileViaTrap(filePath: string, maxBytes: number): ReadResult {
  const r = exec({ cmd: "/bin/sh", args: ["-c", readFileScript(filePath, maxBytes)] });
  if (r.exitCode === 2) return { kind: "missing" };
  if (r.exitCode === 1) {
    return { kind: "error", reason: (r.stdout ?? "").trim().slice(0, 200) || "read failed (rc 1)" };
  }
  if (r.exitCode !== 0) {
    throw new Error(
      "vm-recovery: read trap failed unexpectedly for " +
        filePath +
        " (rc " +
        r.exitCode +
        "): " +
        ((r.stderr ?? "") + (r.stdout ?? "")).slice(0, 200),
    );
  }
  const parsed = parseReadOutput(r.stdout ?? "");
  return { kind: "ok", total: parsed.total, printed: parsed.printed, content: parsed.content };
}

/** Write one text file through chunked base64 traps + rename +
 * read-back (the dispatch pattern). Throws loudly on any
 * failure. */
function writeTextFile(tmpPath: string, destPath: string, content: string, kind: "json" | "html" | "text"): void {
  const chunks = splitHandoffChunks(content);
  for (let i = 0; i < chunks.length; i++) {
    const r = exec({ cmd: "/bin/sh", args: ["-c", chunkWriteScript(chunks[i]!, i, tmpPath)] });
    if (r.exitCode !== 0 || (r.stdout ?? "").trim() !== "CHUNK " + i) {
      throw new Error(
        "vm-recovery: write chunk " + i + " failed for " + destPath + ": " + JSON.stringify((r.stdout ?? "").slice(0, 200)),
      );
    }
  }
  const fin = exec({ cmd: "/bin/sh", args: ["-c", finalizeWriteScript(tmpPath, destPath, kind)] });
  if (fin.exitCode !== 0) {
    throw new Error("vm-recovery: write finalize failed for " + destPath + " (rc " + fin.exitCode + ")");
  }
  const summary = parseWriteSummary(fin.stdout ?? "");
  if (summary.path !== destPath) {
    throw new Error("vm-recovery: write path mismatch: " + summary.path + " != " + destPath);
  }
}

interface Classification {
  resumed: ResumedRun[];
  couldNotResume: CouldNotResumeRun[];
  finished: string[];
  failedRuns: FailedRun[];
  queueUnknown: boolean;
}
/** Classify every queue entry stranded at "running" (reads
 * only). The queue is the source of candidates — the engine's
 * repair iterates the queue, and so does this workflow. The
 * suite inventory text is supplied by the entry (read from the
 * engine dir); a null inventory means suite runs cannot be
 * given a next section and are could-not-resume with the
 * reason named. */
function classifyAll(args: {
  stateDir: string;
  engineDir: string;
  resumeDirs: Record<string, string>;
  roster: Record<string, string>;
  missing: MissingSource[];
  notes: string[];
}): Classification {
  const out: Classification = { resumed: [], couldNotResume: [], finished: [], failedRuns: [], queueUnknown: false };
  const queueRead = readFileViaTrap(args.stateDir + "/queue.json", SERVER_RESTART_READ_MAX_BYTES);
  if (queueRead.kind !== "ok") {
    out.queueUnknown = true;
    const reason = queueRead.kind === "missing" ? "no queue.json" : "queue.json unreadable: " + queueRead.reason;
    args.missing.push({ source: "queue.json", reason });
    args.notes.push("classification could not run: queue unreadable (" + reason + ")");
    return out;
  }
  if (queueRead.total > queueRead.printed) {
    out.queueUnknown = true;
    args.missing.push({ source: "queue.json", reason: "queue.json over the 48KB bound" });
    args.notes.push("classification could not run: queue.json over the 48KB bound");
    return out;
  }
  const parsed = parseQueueEntries(queueRead.content);
  if (parsed.skipped > 0) args.notes.push("queue.json: skipped " + parsed.skipped + " malformed entr" + (parsed.skipped === 1 ? "y" : "ies"));
  const candidates = parsed.entries.filter((e) => e.status === "running");

  // The suite inventory is read once, lazily, when the first
  // suite run (a candidate with a resume-dir mapping) appears.
  let inventoryText: string | null = null;
  let inventoryReason: string | null = null;
  let inventoryLoaded = false;
  const loadInventory = (): void => {
    if (inventoryLoaded) return;
    inventoryLoaded = true;
    const inv = readFileViaTrap(args.engineDir + "/suite-inventory.json", SERVER_RESTART_READ_MAX_BYTES);
    if (inv.kind === "ok" && inv.total <= inv.printed) inventoryText = inv.content;
    else if (inv.kind === "missing") inventoryReason = "no suite-inventory.json in the engine dir";
    else if (inv.kind === "error") inventoryReason = "suite-inventory.json unreadable: " + inv.reason;
    else inventoryReason = "suite-inventory.json over the 48KB bound";
    if (inventoryReason) args.missing.push({ source: "suite-inventory.json", reason: inventoryReason });
  };

  for (const entry of candidates) {
    const owner = entry.owner;
    const lead = owner ? args.roster[owner] ?? null : null;
    const resumeDir = args.resumeDirs[entry.runId] ?? null;
    const journalPath = args.stateDir + "/journals/" + prefixForRunId(entry.runId) + ".journal";
    const journalTrap = exec({ cmd: "/bin/sh", args: ["-c", journalSummaryScript(journalPath)] });
    const journalMissing = journalTrap.exitCode === 2;
    const journal = journalMissing ? null : parseJournalSummary(journalTrap.stdout);
    if (!journalMissing && journal === null) {
      args.notes.push("journal for " + entry.runId + " is unreadable (exit " + journalTrap.exitCode + "); treated as no journal");
    }
    const registryPath = args.stateDir + "/runs/" + prefixForRunId(entry.runId) + ".json";
    const registryRead = readFileViaTrap(registryPath, SERVER_RESTART_SMALL_MAX_BYTES);
    let registryRc: number | null = null;
    let registryMissing = true;
    if (registryRead.kind === "ok") {
      if (registryRead.total > registryRead.printed) {
        args.notes.push("registry entry for " + entry.runId + " over the 16KB bound; treated as missing");
      } else {
        try {
          const reg: unknown = JSON.parse(registryRead.content);
          if (isPlainObject(reg) && (typeof reg["rc"] === "number" || reg["rc"] === null)) {
            registryMissing = false;
            registryRc = reg["rc"] as number | null;
          } else {
            args.notes.push("registry entry for " + entry.runId + " has no rc field; treated as missing");
          }
        } catch {
          args.notes.push("registry entry for " + entry.runId + " is unparsable JSON; treated as missing");
        }
      }
    } else if (registryRead.kind === "error") {
      args.notes.push("registry entry for " + entry.runId + " unreadable (" + registryRead.reason + "); treated as missing");
    }
    const blobTrap = exec({ cmd: "/bin/sh", args: ["-c", existsScript(args.stateDir + "/blobs/" + prefixForRunId(entry.runId) + ".snap")] });
    const blobExists = parseExists(blobTrap.stdout);
    // A suite run needs its next section: the first tier-1
    // slug without a `.done/` marker. Without a readable
    // inventory the point cannot be named, so the run is
    // could-not-resume with the reason named.
    let nextSection: string | null = null;
    let suiteBlockedReason: string | null = null;
    if (resumeDir) {
      loadInventory();
      if (inventoryText === null) {
        suiteBlockedReason = "suite inventory unreadable (" + (inventoryReason ?? "unknown reason") + ") — the next section cannot be named";
      } else {
        const doneTrap = exec({ cmd: "/bin/sh", args: ["-c", listStemsScript(resumeDir + "/.done", "", 200)] });
        const doneParsed = parseListStems(doneTrap.stdout);
        if (doneParsed.truncated) args.notes.push("resume dir " + resumeDir + "/.done has more than 200 markers; the listing is truncated");
        const next = nextSuiteSection({ inventoryText, doneMarkers: new Set(doneParsed.stems) });
        if (next.reason) suiteBlockedReason = next.reason;
        else nextSection = next.next;
      }
    }
    if (suiteBlockedReason) {
      out.couldNotResume.push({
        runId: entry.runId,
        owner,
        lead,
        kind: "suite",
        reason: suiteBlockedReason,
      });
      continue;
    }
    const classified = classifyInterruptedRun({
      runId: entry.runId,
      owner,
      lead,
      journal,
      journalMissing: journalMissing || journal === null,
      registryRc,
      registryMissing,
      blobExists,
      resumeDir,
      nextSuiteSection: nextSection,
    });
    if (classified.outcome === "resumed") out.resumed.push(classified.resumed);
    else if (classified.outcome === "finished") out.finished.push(entry.runId);
    else if (classified.outcome === "failed") {
      out.failedRuns.push({ runId: entry.runId, owner, error: classified.error });
      args.notes.push(entry.runId + " failed: " + classified.error);
    } else {
      out.couldNotResume.push({
        runId: entry.runId,
        owner,
        lead,
        kind: resumeDir ? "suite" : "workflow",
        reason: classified.reason,
      });
    }
  }
  return out;
}

export default function recoverVmReplacement(input: VmRecoveryInput): VmRecoveryReport {
  const recoveryId =
    isPlainObject(input) && isPlainObject(input.run) && isNonEmptyString(input.run["runId"])
      ? (input.run["runId"] as string)
      : "vm-recovery-" + new Date().toISOString();
  const owner = isPlainObject(input) && isNonEmptyString(input.owner) ? input.owner : "unknown";
  const launchedBy = isPlainObject(input) && isNonEmptyString(input.launchedBy) ? input.launchedBy : undefined;
  const stateDirGuess =
    isPlainObject(input) && isPlainObject(input.run) && isNonEmptyString(input.run["stateDir"])
      ? (input.run["stateDir"] as string)
      : "";

  if (!isPlainObject(input)) throw new Error("vm-recovery: input is not an object");
  if (!isPlainObject(input.run)) {
    return refusedVmRecoveryReport({
      recoveryId,
      owner,
      launchedBy,
      cancelChecked: false,
      cancelled: false,
      stateDir: stateDirGuess,
      newBootId: "",
      reasons: ["run is not an object"],
    });
  }
  const errors = validateVmRecoveryInput(input);
  if (errors.length > 0) {
    return refusedVmRecoveryReport({
      recoveryId,
      owner,
      launchedBy,
      cancelChecked: false,
      cancelled: false,
      stateDir: input.run.stateDir,
      newBootId: "",
      reasons: errors,
    });
  }

  const run = input.run;
  const project = input.project;
  const dryRun = run.dryRun === true;
  const verifyAttempts = run.verifyAttempts ?? SERVER_RESTART_VERIFY_ATTEMPTS;
  const verifyIntervalMs = run.verifyIntervalMs ?? SERVER_RESTART_VERIFY_INTERVAL_MS;
  const stateDir = run.stateDir;
  const missing: MissingSource[] = [];
  const notes: string[] = [];
  const trigger = baseTriggerInfo(stateDir);

  // mkdir the work dirs first (the daily-brief pattern).
  const mkdir = exec({
    cmd: "/bin/sh",
    args: ["-c", "mkdir -p " + shellQuote(project.workDir) + " " + shellQuote(project.workDir + "/tmp") + "\n"],
  });
  if (mkdir.exitCode !== 0) {
    return refusedVmRecoveryReport({
      recoveryId,
      owner,
      launchedBy,
      cancelChecked: false,
      cancelled: false,
      stateDir,
      newBootId: "",
      reasons: ["could not create workDir " + project.workDir + " (exit " + mkdir.exitCode + ")"],
    });
  }
  const tmpDir = project.workDir + "/tmp";

  // Cancel check-then-act (the triage pattern). The check reads
  // project.stateDir — the state dir the run's queue entry lives
  // in (the monitored dir is run.stateDir; in tests they differ).
  let cancelChecked = false;
  if (run.runId) {
    const cancel = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(project.stateDir, run.runId)] });
    if (cancel.exitCode !== 0) {
      return refusedVmRecoveryReport({
        recoveryId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: false,
        stateDir,
        newBootId: "",
        reasons: ["cancel check failed for " + run.runId + " (exit " + cancel.exitCode + ")"],
      });
    }
    const runStatus = parseRunStatus(cancel.stdout);
    if (runStatus === "missing") {
      return refusedVmRecoveryReport({
        recoveryId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: false,
        stateDir,
        newBootId: "",
        reasons: ["run " + run.runId + " not found in " + project.stateDir + "/queue.json"],
      });
    }
    cancelChecked = true;
    if (runStatus === "cancelled") {
      const r = refusedVmRecoveryReport({
        recoveryId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: true,
        stateDir,
        newBootId: "",
        reasons: ["run " + run.runId + " is cancelled"],
      });
      r.cancelled = true;
      return r;
    }
    if (runStatus !== "active") {
      return refusedVmRecoveryReport({
        recoveryId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: false,
        stateDir,
        newBootId: "",
        reasons: ["run " + run.runId + " has unexpected status " + JSON.stringify(runStatus)],
      });
    }
  }

  // --- The current boot id (from /proc, never guessed). ---
  const bootTrap = exec({ cmd: "/bin/sh", args: ["-c", bootIdScript()] });
  const newBootId = parseBootId(bootTrap.stdout);
  if (newBootId === null || !isBootIdShape(newBootId)) {
    return refusedVmRecoveryReport({
      recoveryId,
      owner,
      launchedBy,
      cancelChecked,
      cancelled: false,
      stateDir,
      newBootId: "",
      reasons: ["cannot read the current boot id from /proc/sys/kernel/random/boot_id (exit " + bootTrap.exitCode + ")"],
    });
  }

  // --- The trigger: is the unit enabled? (a trap read of
  // $HOME — the workflow never needs to know the home dir). ---
  const unitTrap = exec({ cmd: "/bin/sh", args: ["-c", unitEnabledScript(VM_RECOVERY_UNIT_NAME)] });
  trigger.unitEnabled = parseExists(unitTrap.stdout);
  if (!trigger.unitEnabled) {
    notes.push("the systemd unit is not enabled yet (no ~/.config/systemd/user/" + VM_RECOVERY_UNIT_NAME + ") — enable it once with the commands in trigger.enableCommands");
  }

  // --- Deliver the unit file (real runs only, idempotent
  // content). This runs before detection so the trigger is in
  // place even if detection fails; a failed write is recorded
  // and the recovery continues (retried next run). ---
  const unitContent = vmRecoveryUnitContent({
    engineDir: run.engineDir,
    serverCommand: run.serverCommand,
    runsDir: run.runsDir,
    stateDir,
    bunPath: run.bunPath ?? run.serverCommand[0]!,
  });
  if (dryRun) {
    notes.push("dry-run: unit file not written");
  } else {
    try {
      writeTextFile(tmpDir + "/" + VM_RECOVERY_UNIT_FILE, stateDir + "/" + VM_RECOVERY_UNIT_FILE, unitContent, "text");
      notes.push("unit file written to " + stateDir + "/" + VM_RECOVERY_UNIT_FILE);
    } catch (e) {
      missing.push({ source: trigger.unitPath, reason: "unit file write failed: " + String(e).slice(0, 200) });
      notes.push("unit file write failed (" + String(e).slice(0, 200) + ") — retried next run");
    }
  }

  // --- The recorded boot id. ---
  const recorded = readFileViaTrap(stateDir + "/" + VM_RECOVERY_BOOT_ID_FILE, SERVER_RESTART_SMALL_MAX_BYTES);
  let oldBootId: string | null = null;
  let firstRun = false;
  if (recorded.kind === "missing") {
    firstRun = true;
  } else if (recorded.kind === "error") {
    return refusedVmRecoveryReport({
      recoveryId,
      owner,
      launchedBy,
      cancelChecked,
      cancelled: false,
      stateDir,
      newBootId,
      reasons: ["recorded boot-id unreadable: " + recorded.reason],
    });
  } else if (recorded.total > recorded.printed) {
    return refusedVmRecoveryReport({
      recoveryId,
      owner,
      launchedBy,
      cancelChecked,
      cancelled: false,
      stateDir,
      newBootId,
      reasons: ["recorded boot-id over the 16KB bound"],
    });
  } else {
    oldBootId = recorded.content.trim();
    if (!isBootIdShape(oldBootId)) {
      return refusedVmRecoveryReport({
        recoveryId,
        owner,
        launchedBy,
        cancelChecked,
        cancelled: false,
        stateDir,
        newBootId,
        reasons: ["recorded boot-id is corrupt (not a boot-id shape): " + JSON.stringify(oldBootId.slice(0, 80))],
      });
    }
  }

  // --- Health check (one attempt) — the server state is named
  // in every report. ---
  const healthBeforeTrap = exec({ cmd: "/bin/sh", args: ["-c", healthPollScript(run.serverUrl, 1, 0)] });
  const healthBefore = parseHealthPoll(healthBeforeTrap.stdout);

  const reportBase = {
    recoveryId,
    dryRun,
    owner,
    launchedBy,
    cancelChecked,
    cancelled: false,
    oldBootId,
    newBootId,
    trigger,
    missing,
    notes,
    knownLimit: VM_RECOVERY_KNOWN_LIMIT,
  };

  // --- First run: establish the record (not a replacement).
  // No restart, no classification — the runs in the queue are
  // from this boot. ---
  if (firstRun) {
    if (dryRun) {
      notes.push("dry-run: boot-id record not written");
    } else {
      try {
        writeTextFile(tmpDir + "/" + VM_RECOVERY_BOOT_ID_FILE, stateDir + "/" + VM_RECOVERY_BOOT_ID_FILE, newBootId + "\n", "text");
        notes.push("boot-id record established (" + newBootId.slice(0, 8) + "…)");
      } catch (e) {
        return {
          ...reportBase,
          verdict: "failed" as const,
          replacement: false,
          firstRun: true,
          server: { restarted: false, verified: healthBefore.state.ok, healthBefore: healthBefore.state, healthAfter: healthBefore.state },
          resumed: [],
          couldNotResume: [],
          finished: [],
          failedRuns: [],
          deliveryPayloads: [],
          notes: [...notes, "boot-id record write failed: " + String(e).slice(0, 200)],
          missing: [...missing, { source: stateDir + "/" + VM_RECOVERY_BOOT_ID_FILE, reason: "write failed: " + String(e).slice(0, 200) }],
        };
      }
    }
    return {
      ...reportBase,
      verdict: "established" as const,
      replacement: false,
      firstRun: true,
      server: { restarted: false, verified: healthBefore.state.ok, healthBefore: healthBefore.state, healthAfter: healthBefore.state },
      resumed: [],
      couldNotResume: [],
      finished: [],
      failedRuns: [],
      deliveryPayloads: buildVmRecoveryDeliveryPayloads({
        verdict: "established",
        recoveryId,
        oldBootId,
        newBootId,
        serverVerified: healthBefore.state.ok,
        resumed: [],
        couldNotResume: [],
        failed: [],
        ownerRoster: project.roster,
      }),
    };
  }

  // --- No replacement: report and exit. A down server with no
  // replacement is 245's job. ---
  if (oldBootId === newBootId) {
    if (!healthBefore.state.ok) {
      notes.push("server is down with no replacement — that is 245's job (the 15-minute cron restarts it)");
    }
    return {
      ...reportBase,
      verdict: "no-replacement" as const,
      replacement: false,
      firstRun: false,
      server: { restarted: false, verified: healthBefore.state.ok, healthBefore: healthBefore.state, healthAfter: healthBefore.state },
      resumed: [],
      couldNotResume: [],
      finished: [],
      failedRuns: [],
      deliveryPayloads: [],
    };
  }

  // --- Replacement: update the record on DETECTION (before
  // the restart, so a failed restart does not re-fire
  // detection on the same boot), then classify, then restart. ---
  notes.push("replacement detected: boot " + (oldBootId ?? "").slice(0, 8) + "… → " + newBootId.slice(0, 8) + "…");
  if (dryRun) {
    notes.push("dry-run: boot-id record not updated, server not restarted");
  } else {
    try {
      writeTextFile(tmpDir + "/" + VM_RECOVERY_BOOT_ID_FILE, stateDir + "/" + VM_RECOVERY_BOOT_ID_FILE, newBootId + "\n", "text");
      notes.push("boot-id record updated to " + newBootId.slice(0, 8) + "…");
    } catch (e) {
      missing.push({ source: stateDir + "/" + VM_RECOVERY_BOOT_ID_FILE, reason: "record update failed: " + String(e).slice(0, 200) });
      notes.push("boot-id record update failed (" + String(e).slice(0, 200) + ") — the next run will re-detect this replacement");
    }
  }

  const classification = classifyAll({
    stateDir,
    engineDir: run.engineDir,
    resumeDirs: run.resumeDirs ?? {},
    roster: project.roster,
    missing,
    notes,
  });

  // The already-up rule (decision 5): if the server is already
  // up, verify /health, report that it is up, and do NOT restart
  // a running server. The systemd unit starts the server before
  // running 246, so on a real replacement the server is already
  // up when this workflow runs — spawning a second server would
  // die on the bind and the report would claim a restart that
  // never happened.
  const serverAlreadyUp = healthBefore.state.ok;
  if (serverAlreadyUp) {
    notes.push(
      "server already up (health ok:true before the restart) — verified only, no restart (decision 5: do not restart a running server)",
    );
  }

  if (dryRun) {
    notes.push(
      (serverAlreadyUp
        ? "dry-run: server already up — would verify only, no restart; would resume "
        : "dry-run: would restart the server and resume ") +
        classification.resumed.length +
        " runs (" +
        classification.couldNotResume.length +
        " could-not-resume, " +
        classification.finished.length +
        " finished, " +
        classification.failedRuns.length +
        " failed)",
    );
    return {
      ...reportBase,
      verdict: "dry-run" as const,
      replacement: true,
      firstRun: false,
      server: { restarted: false, verified: false, healthBefore: healthBefore.state, healthAfter: healthBefore.state },
      resumed: classification.resumed,
      couldNotResume: classification.couldNotResume,
      finished: classification.finished,
      failedRuns: classification.failedRuns.map((f) => f.runId),
      deliveryPayloads: [],
    };
  }

  // A classification that could not run is a failed recovery
  // even when the server comes up — the runs were never named,
  // and a human must look.
  if (classification.queueUnknown) {
    const restartResult = serverAlreadyUp
      ? { server: { restarted: false, verified: true, healthBefore: healthBefore.state, healthAfter: healthBefore.state } }
      : restartTheServer(run, stateDir, healthBefore.state, verifyAttempts, verifyIntervalMs, notes);
    return {
      ...reportBase,
      verdict: "failed" as const,
      replacement: true,
      firstRun: false,
      server: restartResult.server,
      resumed: [],
      couldNotResume: [],
      finished: [],
      failedRuns: [],
      deliveryPayloads: buildVmRecoveryDeliveryPayloads({
        verdict: "failed",
        recoveryId,
        oldBootId,
        newBootId,
        serverVerified: restartResult.server.verified,
        resumed: [],
        couldNotResume: [],
        failed: [],
        ownerRoster: project.roster,
      }),
      notes: [...notes, "recovery failed: the classification could not run (queue unreadable) — a human must inspect the stranded runs"],
    };
  }

  const restartResult = serverAlreadyUp
    ? { server: { restarted: false, verified: true, healthBefore: healthBefore.state, healthAfter: healthBefore.state } }
    : restartTheServer(run, stateDir, healthBefore.state, verifyAttempts, verifyIntervalMs, notes);
  const verified = restartResult.server.verified;
  const verdict: VmRecoveryVerdict = verified ? "recovered" : "failed";
  if (!verified) {
    notes.push("recovery failed: the server is NOT verified up after the restart");
  }
  return {
    ...reportBase,
    verdict,
    replacement: true,
    firstRun: false,
    server: restartResult.server,
    resumed: classification.resumed,
    couldNotResume: classification.couldNotResume,
    finished: classification.finished,
    failedRuns: classification.failedRuns.map((f) => f.runId),
    deliveryPayloads: buildVmRecoveryDeliveryPayloads({
      verdict,
      recoveryId,
      oldBootId,
      newBootId,
      serverVerified: verified,
      resumed: classification.resumed,
      couldNotResume: classification.couldNotResume,
      failed: classification.failedRuns,
      ownerRoster: project.roster,
    }),
  };
}

/** Restart the server once (245's helpers) and verify /health
 * within the budget. Returns the server block for the report.
 * Not pure (exec traps). */
function restartTheServer(
  run: VmRecoveryRunInput,
  stateDir: string,
  healthBefore: HealthState,
  verifyAttempts: number,
  verifyIntervalMs: number,
  notes: string[],
): { server: { restarted: boolean; verified: boolean; healthBefore: HealthState; healthAfter: HealthState; restartLogPath?: string } } {
  const logIndex = exec({ cmd: "/bin/sh", args: ["-c", restartLogIndexScript(run.runsDir)] });
  const nextIndex = parseRestartLogIndex(logIndex.stdout) + 1;
  const logPath = run.runsDir + "/server-restart-" + nextIndex + ".log";
  const spawn = exec({
    cmd: "/bin/sh",
    args: [
      "-c",
      restartSpawnScript({
        engineDir: run.engineDir,
        serverCommand: run.serverCommand,
        stateDir,
        runsDir: run.runsDir,
        logPath,
      }),
    ],
  });
  const spawnParsed = parseSpawnResult(spawn.stdout, spawn.exitCode);
  if (!spawnParsed.started) {
    notes.push("server spawn failed (exit " + spawn.exitCode + ", stderr: " + (spawn.stderr ?? "").trim().slice(0, 200) + ")");
    return {
      server: { restarted: false, verified: false, healthBefore, healthAfter: healthBefore, restartLogPath: logPath },
    };
  }
  notes.push("server spawned (pid " + spawnParsed.pid + ", log " + logPath + ")");
  const verifyTrap = exec({ cmd: "/bin/sh", args: ["-c", healthPollScript(run.serverUrl, verifyAttempts, verifyIntervalMs)] });
  const verifyParsed = parseHealthPoll(verifyTrap.stdout);
  if (!verifyParsed.state.ok) {
    notes.push("not verified: /health never answered ok:true within " + verifyAttempts + " attempts (last state: " + verifyParsed.state.detail + ") — the server is NOT verified up");
  }
  return {
    server: {
      restarted: true,
      verified: verifyParsed.state.ok,
      healthBefore,
      healthAfter: verifyParsed.state,
      restartLogPath: logPath,
    },
  };
}
