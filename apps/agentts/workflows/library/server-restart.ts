// server-restart — restart a down server/tick/heartbeat loop (BRA-245).
//
// The machine stops. The production worker server goes down, the
// tick/heartbeat loop stops — and today the recovery is a person:
// the Director tasks the lead by hand, Fleet Ops restarts the
// server. This workflow makes it automatic: detect what is down,
// restart it, verify /health answers ok:true, report back.
//
// Detection (decision 4, settled): down = the health check fails
// (GET /health refused, or answers with `ok` not `true`) OR the
// tick is stale (last tick/beat older than `staleMinutes`, default
// 15, with pending work — the watchdog's `needsRestart` shape: a
// dead tick agent with nothing pending needs no restart). The
// workflow reads the tick state file and the health endpoint
// directly; it never constructs a Host for the check (the watchdog
// pattern — the check must be fast and file-based).
//
// Restart (decision 4): the restart is the job — not a report that
// it is down, not a task for someone else. The workflow starts the
// server with the standing command (`bun src/cli.ts worker serve
// --state-dir <dir> --port <N>`, detached via nohup, log to
// `<runs-dir>/server-restart-N.log`), from the run input's server
// command / state dir / port (never hardcoded to production). The
// spawn is one bounded exec trap; the trap returns once the process
// is detached, not once the server is up. The server's stdout and
// stderr go to the log file (not the trap's pipe), so the trap
// returns promptly — the output-drain timeout the brief warns of
// is what happens when a spawned child's stdout stays on the pipe.
//
// Verify (decision 4): a restart that is not verified is not a
// recovery. The workflow polls GET /health until it answers
// `ok: true` or the bounded retry budget is spent — 30 attempts
// one second apart (30s total, settled here; the bound is a
// number, never unbounded). Verified = `ok === true` within the
// budget. Not verified = reported as not-verified, never as up.
//
// Restart-loop guard (decision 4): a down server that won't
// restart is reported as a failure, loudly — not looped silently,
// not reported as up. One run makes at most one restart attempt
// per target; a second attempt in the same run is a new decision
// with the failure named, never a silent retry loop.
//
// Already up (decision 4): if the server is already up, the
// workflow verifies /health, reports that it is up, and does NOT
// restart a running server. Never kill a live server to restart
// it.
//
// The restart target is the worker server. The tick-stale trigger
// fires when /health is OK but the tick is stale with pending
// work — and the already-up rule governs that case: the server
// is UP, so the workflow verifies /health, reports the stale
// tick + pending work, and does NOT restart a running server.
// Restarting the server cannot revive the tick agent anyway:
// the tick agent beats the server via POST /tick-beat and the
// server only records tick/state.json (worker-server.ts:370-383),
// so a dead beater stays dead across a server restart — and the
// new process could not even bind the port the live server
// holds. The tick agent itself is restarted by its own watchdog
// cron; the report names that, and the Director + affected leads
// are notified (their work is stuck). The tick-stale restart in
// decision 4 therefore applies only when the server is also
// down — which is already the health-down trigger.
//
// Trigger (decision 3, settled): the workflow runs on a 15-minute
// cron — the fleet's cron mechanism drives it (the same cron
// system that drives the daily brief), one fresh run-id per
// invocation:
//   bun <engineDir>/src/cli.ts run workflows/library/server-restart.ts \
//     --run-id run-bra245-$(date -u +%Y%m%dT%H%M%SZ) \
//     --input-file <stateDir>/server-restart-input.json \
//     --state-dir <stateDir> --adapter direct --clock real --gates hold
//   bun <engineDir>/src/cli.ts queue run --state-dir <stateDir> \
//     --adapter direct --clock real --gates hold
// The cron is installed by the lead (one-time setup), not by the
// workflow — a workflow does not install crons. The input file
// (<stateDir>/server-restart-input.json) is written once by the
// lead from this header's shape: {project, run: {serverUrl,
// stateDir, engineDir, serverCommand, runsDir, staleMinutes?},
// owner, launchedBy}. 15 minutes matches the staleMinutes
// default: a dead tick is caught within ~15 minutes of going
// stale (plus the cron interval), against the watchdog cron's
// ~30-minute detection latency. The §D cases are driven by the
// same CLI invocation the cron would run.
//
// Reads go through exec traps in the dispatch pattern (base64
// chunks + temp + rename + read-back for writes), never trap
// stdout, never `Buffer`. Per-file read bounds: 48KB generic,
// 16KB for the tick state + ledger tail. An over-bound file is
// recorded missing-with-reason, never truncated into a wrong
// parse. The health check is a bounded curl (the lead-loop's
// shape), never an unbounded wait.
//
// Cancel is check-then-act (the triage pattern); a null/absent
// run is refused, never dereferenced. Dry-run plans the restart
// and writes nothing — this workflow writes nothing to disk
// itself (the server writes its own log); dry-run differs only
// in that it does not spawn.
//
// The workflow sends no messages: the report returns delivery
// payloads for the launcher (the daily-brief pattern) — the
// Director when a restart happened or failed, one per affected
// lead (owner of a pending run) when a restart happened. A
// routine verified-up / no-restart-needed check emits no payload
// (silence is the correct signal for "nothing was wrong").
//
// Known v0 limits, carried verbatim in every report:
//
// - The restart target is the worker server: the workflow
//   restarts the server when /health fails or when the tick is
//   stale with pending work; the tick agent itself is restarted
//   by its own watchdog cron, never by this workflow. One run
//   makes at most one restart attempt per target. A restart that
//   is not verified is reported as not-verified, never as up.
//   The workflow sends no messages — the launcher delivers the
//   payloads. It never closes, merges, or decides acceptance.
import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import { readFileScript, parseReadOutput, ledgerTailScript, parseLedgerTail } from "./daily-brief";

/** The known-limit string, carried verbatim in every report. */
export const SERVER_RESTART_KNOWN_LIMIT =
  "The restart target is the worker server: the workflow restarts the server when /health fails or when the tick is " +
  "stale with pending work; the tick agent itself is restarted by its own watchdog cron, never by this workflow. " +
  "One run makes at most one restart attempt per target. A restart that is not verified is reported as not-verified, " +
  "never as up. The workflow sends no messages — the launcher delivers the payloads. " +
  "It never closes, merges, or decides acceptance.";

/** Per-file read bound (bytes of decoded text): far under the
 * ~60KB exec-trap stdout cap, with headroom for the READ header. */
export const SERVER_RESTART_READ_MAX_BYTES = 48 * 1024;
/** The tick state + registry entries are small; a file over this
 * bound is recorded as missing-with-reason (the bound named). */
export const SERVER_RESTART_SMALL_MAX_BYTES = 16 * 1024;
/** The ledger read is the tail: the last 20 records. */
export const SERVER_RESTART_LEDGER_TAIL_LINES = 20;
/** The delivered-run-ids scan caps at 500 ids in the output —
 * far above any realistic count; truncation is named, never
 * silent. */
export const SERVER_RESTART_DELIVERED_MAX_IDS = 500;
/** The verify budget: attempts × interval. 30s total. */
export const SERVER_RESTART_VERIFY_ATTEMPTS = 30;
export const SERVER_RESTART_VERIFY_INTERVAL_MS = 1000;
/** The tick staleness default: the watchdog's 15 minutes. */
export const SERVER_RESTART_DEFAULT_STALE_MINUTES = 15;

export type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface ServerRestartProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the
   * restart v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir: string;
}

export interface ServerRestartRunInput {
  /** The worker server's base URL, e.g. http://127.0.0.1:18741.
   * Never guessed — the launcher supplies it. */
  serverUrl: string;
  /** The state dir the tick state + queue live under. */
  stateDir: string;
  /** The engine checkout dir the server command runs from
   * (the copy's apps/agentts in tests; the live repo in
   * production). */
  engineDir: string;
  /** The full server argv, run with cwd=engineDir — e.g.
   * ["/opt/hatch-image/bin/bun", "src/cli.ts", "worker",
   * "serve", "--state-dir", "<dir>", "--port", "<N>"].
   * Supplied by the caller, never hardcoded. */
  serverCommand: string[];
  /** Where restart logs go, e.g. <runs-dir>. The workflow
   * names the log server-restart-N.log (N = next free index). */
  runsDir: string;
  /** Tick staleness in minutes (default 15, the watchdog's). */
  staleMinutes?: number;
  /** Verify attempts after a restart (default 30). */
  verifyAttempts?: number;
  /** Verify interval in ms (default 1000). */
  verifyIntervalMs?: number;
  dryRun?: boolean;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  /** Caller-supplied now (ISO), for tests. */
  now?: string;
  bunPath?: string;
}

export interface ServerRestartInput {
  project: ServerRestartProjectConfig;
  run: ServerRestartRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

/** The /health state as observed: reachable + ok are separate —
 * a server that answers but with ok !== true is up and broken,
 * not down-and-gone. */
export interface HealthState {
  reachable: boolean;
  ok: boolean;
  /** "ok" | "not-ok" | "unreachable" — the last observed state. */
  detail: string;
}

export interface TickState {
  alive: boolean;
  lastTickAt: string | null;
  ageMs: number | null;
  staleMinutes: number;
  pendingCount: number;
  needsRestart: boolean;
}

export interface DeliveryPayload {
  /** "director" or a lead chat id (the run owner's session). */
  target: string;
  message: string;
}

export interface MissingSource {
  source: string;
  reason: string;
}

export type ServerRestartVerdict =
  | "restarted"
  | "verified-up"
  | "no-restart-needed"
  | "not-verified"
  | "failed"
  | "dry-run";

export interface ServerRestartReport {
  restartId: string;
  verdict: ServerRestartVerdict;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  /** Which trigger fired: the health check failed, the tick
   * went stale with pending work, or nothing was wrong. */
  trigger: "health-down" | "tick-stale" | "none";
  healthBefore: HealthState;
  tick: TickState;
  restarted: boolean;
  /** Spawn attempts spent (0 or 1 — one run makes at most one
   * restart attempt per target). */
  restartAttempts: number;
  restartLogPath?: string;
  healthAfter: HealthState;
  verified: boolean;
  /** Verify attempts spent (0 when no verify ran). */
  verifyAttemptsSpent: number;
  deliveryPayloads: DeliveryPayload[];
  missing: MissingSource[];
  notes: string[];
  knownLimit: string;
}

/** Validate the run input (validate-first: no `refused()`
 * defect). Returns the error strings; empty means valid. */
export function validateServerRestartInput(input: ServerRestartInput): string[] {
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
    if (r["staleMinutes"] !== undefined && (typeof r["staleMinutes"] !== "number" || r["staleMinutes"] <= 0)) {
      errors.push("run.staleMinutes must be a positive number when present");
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

/** Build the /health poll script: a bounded curl loop printing
 * `HEALTH-OK <n>` or `HEALTH-FAIL <n> <last-state>` (last-state
 * "not-ok" when the endpoint answered with ok !== true,
 * "unreachable" when curl failed). Pure. The interval is seconds
 * (fractional allowed); the attempts cap the total wait. */
export function healthPollScript(serverUrl: string, attempts: number, intervalMs: number): string {
  const url = serverUrl.replace(/\/$/, "") + "/health";
  const intervalS = (intervalMs / 1000).toFixed(3).replace(/\.?0+$/, "");
  const lines = [
    "n=0",
    "last=unreachable",
    "while [ $n -lt " + attempts + " ]; do",
    "  n=$((n+1))",
    "  if curl -s -m 2 " + shellQuote(url) + " | grep -q '\"ok\":true'; then echo \"HEALTH-OK $n\"; exit 0; fi",
    "  if curl -s -m 2 " + shellQuote(url) + " >/dev/null 2>&1; then last=not-ok; else last=unreachable; fi",
    "  if [ $n -lt " + attempts + " ]; then sleep " + intervalS + "; fi",
    "done",
    "echo \"HEALTH-FAIL " + attempts + " $last\"",
    "exit 1",
  ];
  return lines.join("\n") + "\n";
}

/** Parse the health-poll trap's output into a HealthState +
 * attempts spent. Pure. */
export function parseHealthPoll(text: string): { state: HealthState; attemptsSpent: number } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  for (const line of lines) {
    const okMatch = line.match(/^HEALTH-OK (\d+)$/);
    if (okMatch) {
      return { state: { reachable: true, ok: true, detail: "ok" }, attemptsSpent: parseInt(okMatch[1]!, 10) };
    }
    const failMatch = line.match(/^HEALTH-FAIL (\d+) (not-ok|unreachable)$/);
    if (failMatch) {
      const detail = failMatch[2]!;
      return {
        state: { reachable: detail === "not-ok", ok: false, detail },
        attemptsSpent: parseInt(failMatch[1]!, 10),
      };
    }
  }
  return { state: { reachable: false, ok: false, detail: "unreachable" }, attemptsSpent: 0 };
}

/** Classify the tick from its state text + the pending count.
 * Pure. A missing/unparsable tick state is "never ticked"
 * (lastTickAt null, alive false) with the reason named — the
 * watchdog pattern: a missing state is not a crash, it is a
 * dead tick. */
export function classifyTick(args: {
  tickStateText: string | null;
  tickStateMissingReason: string | null;
  pendingCount: number;
  staleMinutes: number;
  nowMs: number;
}): { tick: TickState; note: string | null } {
  let lastTickAt: string | null = null;
  let note: string | null = null;
  if (args.tickStateText !== null) {
    try {
      const parsed: unknown = JSON.parse(args.tickStateText);
      if (isPlainObject(parsed) && typeof parsed["lastTickAt"] === "string") {
        const ms = Date.parse(parsed["lastTickAt"]);
        if (!Number.isNaN(ms)) lastTickAt = parsed["lastTickAt"];
        else note = "tick state lastTickAt is not a valid date; treated as never ticked";
      } else {
        note = "tick state has no lastTickAt string; treated as never ticked";
      }
    } catch {
      note = "tick state is unparsable JSON; treated as never ticked";
    }
  } else if (args.tickStateMissingReason) {
    note = "tick state missing (" + args.tickStateMissingReason + "); treated as never ticked";
  }
  const ageMs = lastTickAt === null ? null : args.nowMs - Date.parse(lastTickAt);
  const alive = ageMs !== null && ageMs <= args.staleMinutes * 60 * 1000;
  const needsRestart = !alive && args.pendingCount > 0;
  return {
    tick: {
      alive,
      lastTickAt,
      ageMs,
      staleMinutes: args.staleMinutes,
      pendingCount: args.pendingCount,
      needsRestart,
    },
    note,
  };
}

/** Parse a queue file's text into entries (tolerant: entries
 * without a runId/status string are skipped and counted).
 * Pure. */
export function parseQueueEntries(text: string): { entries: { runId: string; status: string; owner: string | null }[]; skipped: number } {
  const entries: { runId: string; status: string; owner: string | null }[] = [];
  let skipped = 0;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return { entries, skipped: 1 };
    for (const e of parsed) {
      if (isPlainObject(e) && isNonEmptyString(e["runId"]) && isNonEmptyString(e["status"])) {
        entries.push({
          runId: e["runId"],
          status: e["status"],
          owner: isNonEmptyString(e["owner"]) ? e["owner"] : null,
        });
      } else skipped++;
    }
  } catch {
    return { entries: [], skipped: 1 };
  }
  return { entries, skipped };
}

/** The pending-work count, from the queue entries, the ledger
 * terminal set, and the delivered run ids — the watchdog's
 * shape: queued + held + stuck-running + finished-but-
 * undelivered. Pure. */
export function computePending(args: {
  queueEntries: { runId: string; status: string }[];
  ledgerTerminalRunIds: Set<string>;
  deliveredRunIds: Set<string>;
}): { pendingCount: number; pendingRunIds: string[] } {
  const pending = new Set<string>();
  for (const e of args.queueEntries) {
    if (e.status === "queued" || e.status === "held") pending.add(e.runId);
    else if (e.status === "running") {
      if (!args.ledgerTerminalRunIds.has(e.runId)) pending.add(e.runId);
    } else if (e.status === "done" || e.status === "failed") {
      if (!args.deliveredRunIds.has(e.runId)) pending.add(e.runId);
    }
  }
  return { pendingCount: pending.size, pendingRunIds: [...pending].sort() };
}

/** Build the delivered-run-ids scan script: reads every
 * <stateDir>/deliveries/*.json, prints `DELIVERED <n>` then one
 * runId per line (capped at maxIds; truncation is named in the
 * output). Pure. */
export function deliveredRunIdsScript(stateDir: string, maxIds: number): string {
  return (
    "python3 -c '\n" +
    "import json, os, sys\n" +
    "d = os.path.join(sys.argv[1], \"deliveries\")\n" +
    "ids = []\n" +
    "truncated = False\n" +
    "try:\n" +
    "    names = sorted(os.listdir(d))\n" +
    "except FileNotFoundError:\n" +
    "    print(\"DELIVERED 0\")\n" +
    "    sys.exit(0)\n" +
    "for name in names:\n" +
    "    if not name.endswith(\".json\"):\n" +
    "        continue\n" +
    "    try:\n" +
    "        with open(os.path.join(d, name)) as f:\n" +
    "            obj = json.load(f)\n" +
    "    except Exception:\n" +
    "        continue\n" +
    "    rid = obj.get(\"runId\") if isinstance(obj, dict) else None\n" +
    "    if isinstance(rid, str) and rid:\n" +
    "        if len(ids) < " +
    maxIds +
    ":\n" +
    "            ids.append(rid)\n" +
    "        else:\n" +
    "            truncated = True\n" +
    "print(\"DELIVERED %d%s\" % (len(ids), \" TRUNCATED\" if truncated else \"\"))\n" +
    "for rid in ids:\n" +
    "    print(rid)\n" +
    "' " +
    shellQuote(stateDir) +
    "\n"
  );
}

/** Parse the delivered-run-ids scan output. Pure. */
export function parseDeliveredRunIds(text: string): { ids: Set<string>; truncated: boolean } {
  const ids = new Set<string>();
  let truncated = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("DELIVERED ")) {
      truncated = t.includes("TRUNCATED");
    } else if (t !== "") {
      ids.add(t);
    }
  }
  return { ids, truncated };
}

/** Build the restart-log index script: prints `LOGINDEX <max>`
 * where max is the largest N in <runsDir>/server-restart-N.log
 * (0 when none). Pure. */
export function restartLogIndexScript(runsDir: string): string {
  return (
    "python3 -c '\n" +
    "import os, re, sys\n" +
    "d = sys.argv[1]\n" +
    "mx = 0\n" +
    "try:\n" +
    "    names = os.listdir(d)\n" +
    "except FileNotFoundError:\n" +
    "    print(\"LOGINDEX 0\")\n" +
    "    sys.exit(0)\n" +
    "for name in names:\n" +
    "    m = re.fullmatch(r\"server-restart-(\\d+)\\.log\", name)\n" +
    "    if m:\n" +
    "        mx = max(mx, int(m.group(1)))\n" +
    "print(\"LOGINDEX %d\" % mx)\n" +
    "' " +
    shellQuote(runsDir) +
    "\n"
  );
}

/** Parse the restart-log index output. Pure. */
export function parseRestartLogIndex(text: string): number {
  const m = text.match(/LOGINDEX (\d+)/);
  return m ? parseInt(m[1]!, 10) : 0;
}

/** Build the server-spawn script: mkdir the dirs, cd to the
 * engine checkout, nohup the server command detached with
 * stdout/stderr to the log file and stdin from /dev/null, print
 * `STARTED <pid>`. The trap returns once detached — it does not
 * wait for the server to come up (verify polls separately).
 * Pure. */
export function restartSpawnScript(args: {
  engineDir: string;
  serverCommand: string[];
  stateDir: string;
  runsDir: string;
  logPath: string;
}): string {
  const argv = args.serverCommand.map((a) => shellQuote(a)).join(" ");
  return (
    "mkdir -p " +
    shellQuote(args.stateDir) +
    " " +
    shellQuote(args.runsDir) +
    " || exit 1\n" +
    "cd " +
    shellQuote(args.engineDir) +
    " || exit 1\n" +
    "nohup " +
    argv +
    " > " +
    shellQuote(args.logPath) +
    " 2>&1 < /dev/null &\n" +
    "echo \"STARTED $!\"\n"
  );
}

/** Parse the spawn trap's output: `STARTED <pid>` on success.
 * Pure. */
export function parseSpawnResult(text: string, exitCode: number): { started: boolean; pid: string | null } {
  if (exitCode !== 0) return { started: false, pid: null };
  const m = text.match(/STARTED (\d+)/);
  return m ? { started: true, pid: m[1]! } : { started: false, pid: null };
}

/** Decide which trigger fired, from the health state and the
 * tick classification. Pure. A down health check always wins
 * (the server is the restart target); a healthy server with a
 * stale tick and pending work is the tick-stale trigger; a
 * healthy server with a live tick (or a dead tick with nothing
 * pending) is no trigger. */
export function decideRestartTrigger(args: { health: HealthState; tick: TickState }): "health-down" | "tick-stale" | "none" {
  if (!args.health.ok) return "health-down";
  if (args.tick.needsRestart) return "tick-stale";
  return "none";
}

/** Group the pending run ids by owner (for the delivery
 * payloads). Pure. */
export function groupPendingOwners(
  queueEntries: { runId: string; status: string; owner: string | null }[],
  pendingRunIds: string[],
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const e of queueEntries) {
    if (pendingRunIds.includes(e.runId) && e.owner) {
      const list = owners.get(e.owner) ?? [];
      list.push(e.runId);
      owners.set(e.owner, list);
    }
  }
  return owners;
}

/** Build the delivery payloads for the launcher. Pure. The
 * Director is named whenever a restart happened or failed, and
 * when the tick is stale with pending work (the server is up
 * but the queue is not being driven — the watchdog cron owns
 * the tick agent, and the Director should know it is stuck);
 * each affected lead (owner of a pending run) is named when a
 * restart happened or when the tick is stale. A routine
 * verified-up / no-restart-needed check emits no payload. */
export function buildRestartDeliveryPayloads(args: {
  verdict: ServerRestartVerdict;
  trigger: "health-down" | "tick-stale" | "none";
  restartId: string;
  serverUrl: string;
  healthBefore: HealthState;
  healthAfter: HealthState;
  pendingRunIds: string[];
  pendingOwners: Map<string, string[]>;
  ownerRoster: Record<string, string>;
  restartLogPath?: string;
}): DeliveryPayload[] {
  const payloads: DeliveryPayload[] = [];
  const tickStaleStuck = args.verdict === "verified-up" && args.trigger === "tick-stale";
  const needsDirector =
    args.verdict === "restarted" || args.verdict === "not-verified" || args.verdict === "failed" || tickStaleStuck;
  if (needsDirector) {
    const what = tickStaleStuck
      ? "the worker server at " +
        args.serverUrl +
        " is up and verified, but the tick is stale with " +
        args.pendingRunIds.length +
        " pending run(s) — the tick agent itself is restarted by its own watchdog cron, never by this workflow"
      : args.verdict === "restarted"
        ? "restarted the worker server at " + args.serverUrl + " (trigger: " + args.trigger + ", health was " + args.healthBefore.detail + ") and verified /health ok:true"
        : args.verdict === "not-verified"
          ? "restarted the worker server at " + args.serverUrl + " (trigger: " + args.trigger + ") but /health never answered ok:true within the verify budget — the server is NOT verified up"
          : "failed to restart the worker server at " + args.serverUrl + " (trigger: " + args.trigger + ", health was " + args.healthBefore.detail + ")";
    payloads.push({
      target: "director",
      message:
        "Meroki (server-restart " +
        args.restartId +
        "): " +
        what +
        ". Restart log: " +
        (args.restartLogPath ?? "(none — the spawn never ran)") +
        ". Pending runs at detection: " +
        args.pendingRunIds.length +
        ".",
    });
  }
  if (args.verdict === "restarted" || tickStaleStuck) {
    for (const [owner, runIds] of [...args.pendingOwners.entries()].sort()) {
      const leadName = args.ownerRoster[owner] ?? owner;
      payloads.push({
        target: owner,
        message:
          "Meroki (server-restart " +
          args.restartId +
          "): " +
          (tickStaleStuck
            ? "the worker server at " +
              args.serverUrl +
              " is up, but the tick is stale and your pending runs are stuck until the tick agent restarts (its own watchdog cron owns that restart)"
            : "the worker server at " +
              args.serverUrl +
              " was down (trigger: " +
              args.trigger +
              ") and has been restarted and verified up") +
          ". Your pending runs were: " +
          runIds.join(", ") +
          " (" +
          leadName +
          ").",
      });
    }
  }
  return payloads;
}

/** The refused-report builder: a failed report with the base
 * health/tick defaults, the reasons named in missing + notes.
 * Used for every refusal (validation, cancel, unexpected run
 * status) so a refusal never carries a half-filled verdict. */
function refusedServerRestartReport(args: {
  restartId: string;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  reasons: string[];
}): ServerRestartReport {
  const tick: TickState = {
    alive: false,
    lastTickAt: null,
    ageMs: null,
    staleMinutes: SERVER_RESTART_DEFAULT_STALE_MINUTES,
    pendingCount: 0,
    needsRestart: false,
  };
  return {
    restartId: args.restartId,
    verdict: "failed",
    dryRun: false,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    trigger: "none",
    healthBefore: { reachable: false, ok: false, detail: "unknown" },
    tick,
    restarted: false,
    restartAttempts: 0,
    healthAfter: { reachable: false, ok: false, detail: "unknown" },
    verified: false,
    verifyAttemptsSpent: 0,
    deliveryPayloads: [],
    missing: args.reasons.map((r) => ({ source: "validation", reason: r })),
    notes: args.reasons,
    knownLimit: SERVER_RESTART_KNOWN_LIMIT,
  };
}

export default function restartServer(input: ServerRestartInput): ServerRestartReport {
  const restartId =
    isPlainObject(input) && isPlainObject(input.run) && isNonEmptyString(input.run["runId"])
      ? (input.run["runId"] as string)
      : "server-restart-" + new Date().toISOString();
  const owner =
    isPlainObject(input) && isNonEmptyString(input.owner) ? input.owner : "unknown";
  const launchedBy = isPlainObject(input) && isNonEmptyString(input.launchedBy) ? input.launchedBy : undefined;

  // The workflow never dereferences input without the defensive
  // reads above: a non-object input throws (the daily-brief
  // pattern — a caller bug, not a report).
  if (!isPlainObject(input)) throw new Error("server-restart: input is not an object");
  if (!isPlainObject(input.run)) {
    return refusedServerRestartReport({
      restartId,
      owner,
      launchedBy,
      cancelChecked: false,
      cancelled: false,
      reasons: ["run is not an object"],
    });
  }
  const errors = validateServerRestartInput(input);
  if (errors.length > 0) {
    return refusedServerRestartReport({
      restartId,
      owner,
      launchedBy,
      cancelChecked: false,
      cancelled: false,
      reasons: errors,
    });
  }

  const run = input.run;
  const project = input.project;
  const dryRun = run.dryRun === true;
  const staleMinutes = run.staleMinutes ?? SERVER_RESTART_DEFAULT_STALE_MINUTES;
  const verifyAttempts = run.verifyAttempts ?? SERVER_RESTART_VERIFY_ATTEMPTS;
  const verifyIntervalMs = run.verifyIntervalMs ?? SERVER_RESTART_VERIFY_INTERVAL_MS;
  const nowMs = Date.parse(run.now ?? new Date().toISOString());
  const stateDir = run.stateDir;
  const missing: MissingSource[] = [];
  const notes: string[] = [];

  // mkdir the work dirs first (the daily-brief pattern).
  const mkdir = exec({
    cmd: "/bin/sh",
    args: ["-c", "mkdir -p " + shellQuote(project.workDir) + " " + shellQuote(project.workDir + "/tmp") + "\n"],
  });
  if (mkdir.exitCode !== 0) {
    return refusedServerRestartReport({
      restartId,
      owner,
      launchedBy,
      cancelChecked: false,
      cancelled: false,
      reasons: ["could not create workDir " + project.workDir + " (exit " + mkdir.exitCode + ")"],
    });
  }

  // Cancel check-then-act (the triage pattern): read the live
  // flag, then act on it. The check reads project.stateDir —
  // the state dir the run's queue entry lives in (the monitored
  // dir is run.stateDir; in tests they differ). A null/absent
  // run is refused, never dereferenced.
  let cancelChecked = false;
  let cancelled = false;
  if (run.runId) {
    const cancel = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(project.stateDir, run.runId)] });
    if (cancel.exitCode !== 0) {
      return refusedServerRestartReport({
        restartId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: false,
        reasons: ["cancel check failed for " + run.runId + " (exit " + cancel.exitCode + ")"],
      });
    }
    const runStatus = parseRunStatus(cancel.stdout);
    if (runStatus === "missing") {
      return refusedServerRestartReport({
        restartId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: false,
        reasons: ["run " + run.runId + " not found in " + project.stateDir + "/queue.json"],
      });
    }
    cancelChecked = true;
    if (runStatus === "cancelled") {
      return {
        ...refusedServerRestartReport({
          restartId,
          owner,
          launchedBy,
          cancelChecked: true,
          cancelled: true,
          reasons: ["run " + run.runId + " is cancelled"],
        }),
        cancelled: true,
      };
    }
    if (runStatus !== "active") {
      return refusedServerRestartReport({
        restartId,
        owner,
        launchedBy,
        cancelChecked: true,
        cancelled: false,
        reasons: ["run " + run.runId + " has unexpected status " + JSON.stringify(runStatus)],
      });
    }
  }

  // --- Read the tick state (16KB bound). The read script
  // exits 2 on missing, 1 on error, 0 with a READ header; an
  // over-bound file (total > printed) is recorded
  // missing-with-reason, never truncated into a wrong parse. ---
  let tickText: string | null = null;
  let tickMissingReason: string | null = null;
  const tickRead = exec({ cmd: "/bin/sh", args: ["-c", readFileScript(stateDir + "/tick/state.json", SERVER_RESTART_SMALL_MAX_BYTES)] });
  if (tickRead.exitCode === 2) {
    tickMissingReason = "no tick/state.json";
    missing.push({ source: "tick/state.json", reason: tickMissingReason });
  } else if (tickRead.exitCode !== 0) {
    tickMissingReason = "tick/state.json unreadable (exit " + tickRead.exitCode + ")";
    missing.push({ source: "tick/state.json", reason: tickMissingReason });
  } else {
    try {
      const tickParsed = parseReadOutput(tickRead.stdout);
      if (tickParsed.total > tickParsed.printed) {
        tickMissingReason = "tick/state.json over the 16KB bound";
        missing.push({ source: "tick/state.json", reason: tickMissingReason });
      } else {
        tickText = tickParsed.content;
      }
    } catch (e) {
      tickMissingReason = "tick/state.json read output unparsable: " + String(e).slice(0, 200);
      missing.push({ source: "tick/state.json", reason: tickMissingReason });
    }
  }

  // --- Read the queue (48KB bound). ---
  let queueEntries: { runId: string; status: string; owner: string | null }[] = [];
  let queueUnknown = false;
  const queueRead = exec({ cmd: "/bin/sh", args: ["-c", readFileScript(stateDir + "/queue.json", SERVER_RESTART_READ_MAX_BYTES)] });
  if (queueRead.exitCode === 2) {
    queueUnknown = true;
    missing.push({ source: "queue.json", reason: "no queue.json" });
    notes.push("queue unreadable (no queue.json); pending work is unknown");
  } else if (queueRead.exitCode !== 0) {
    queueUnknown = true;
    missing.push({ source: "queue.json", reason: "queue.json unreadable (exit " + queueRead.exitCode + ")" });
    notes.push("queue unreadable (exit " + queueRead.exitCode + "); pending work is unknown");
  } else {
    try {
      const queueParsed = parseReadOutput(queueRead.stdout);
      if (queueParsed.total > queueParsed.printed) {
        queueUnknown = true;
        missing.push({ source: "queue.json", reason: "queue.json over the 48KB bound" });
        notes.push("queue unreadable (queue.json over the 48KB bound); pending work is unknown");
      } else {
        const q = parseQueueEntries(queueParsed.content);
        queueEntries = q.entries;
        if (q.skipped > 0) notes.push("queue.json: skipped " + q.skipped + " malformed entr" + (q.skipped === 1 ? "y" : "ies"));
      }
    } catch (e) {
      queueUnknown = true;
      missing.push({ source: "queue.json", reason: "queue.json read output unparsable: " + String(e).slice(0, 200) });
      notes.push("queue unreadable (read output unparsable); pending work is unknown");
    }
  }

  // --- Ledger tail: the last 20 records, for the terminal set.
  // The tail is a best-effort corroboration: a run older than
  // the tail is not in it, so a "running" queue entry with no
  // tail record is treated as pending (the safe direction — it
  // errs toward restarting). ---
  const ledgerTerminalRunIds = new Set<string>();
  const ledgerTail = exec({ cmd: "/bin/sh", args: ["-c", ledgerTailScript(stateDir + "/ledger/run-ledger.jsonl", SERVER_RESTART_LEDGER_TAIL_LINES)] });
  if (ledgerTail.exitCode === 2) {
    missing.push({ source: "ledger/run-ledger.jsonl", reason: "no ledger file" });
  } else if (ledgerTail.exitCode !== 0) {
    missing.push({ source: "ledger/run-ledger.jsonl", reason: "ledger unreadable (exit " + ledgerTail.exitCode + ")" });
  } else {
    try {
      const ledgerParsed = parseLedgerTail(ledgerTail.stdout);
      for (const r of ledgerParsed.runs) {
        if (r.status === "done" || r.status === "failed" || r.status === "collected") {
          ledgerTerminalRunIds.add(r.runId);
        }
      }
      if (ledgerParsed.skipped > 0) notes.push("ledger tail: skipped " + ledgerParsed.skipped + " unparsable line" + (ledgerParsed.skipped === 1 ? "" : "s"));
    } catch (e) {
      missing.push({ source: "ledger/run-ledger.jsonl", reason: "ledger tail output unparsable: " + String(e).slice(0, 200) });
    }
  }

  // --- Delivered run ids (scan the deliveries dir). ---
  let deliveredRunIds = new Set<string>();
  const delivered = exec({ cmd: "/bin/sh", args: ["-c", deliveredRunIdsScript(stateDir, SERVER_RESTART_DELIVERED_MAX_IDS)] });
  const deliveredParsed = parseDeliveredRunIds(delivered.stdout);
  deliveredRunIds = deliveredParsed.ids;
  if (deliveredParsed.truncated) {
    notes.push("deliveries scan truncated at " + SERVER_RESTART_DELIVERED_MAX_IDS + " ids; pending count may overcount undelivered runs");
  }

  // --- Pending work + tick classification. ---
  const pending = queueUnknown
    ? { pendingCount: -1, pendingRunIds: [] as string[] }
    : computePending({ queueEntries, ledgerTerminalRunIds, deliveredRunIds });
  const tickClassified = classifyTick({
    tickStateText: tickText,
    tickStateMissingReason: tickMissingReason,
    pendingCount: pending.pendingCount < 0 ? 0 : pending.pendingCount,
    staleMinutes,
    nowMs,
  });
  const tick = tickClassified.tick;
  if (tickClassified.note) notes.push(tickClassified.note);
  if (queueUnknown) notes.push("tick stale check is inconclusive: pending work is unknown (queue unreadable)");

  // --- Health check (one attempt). ---
  const healthBeforeTrap = exec({
    cmd: "/bin/sh",
    args: ["-c", healthPollScript(run.serverUrl, 1, 0)],
  });
  const healthBefore = parseHealthPoll(healthBeforeTrap.stdout);

  const trigger = decideRestartTrigger({ health: healthBefore.state, tick });

  // --- Tick-stale with the server up: verify only, never
  // restart a running server (the header settles this: the
  // already-up rule governs, and restarting the server cannot
  // revive the tick agent). The stale tick + pending work are
  // reported, and the Director + affected leads are named. ---
  if (trigger === "tick-stale") {
    notes.push(
      "tick-stale: the server is up and verified, so it is NOT restarted (never restart a running server); the tick is stale with " +
        tick.pendingCount +
        " pending run(s) — the tick agent itself is restarted by its own watchdog cron, never by this workflow",
    );
    return {
      restartId,
      verdict: "verified-up",
      dryRun,
      owner,
      launchedBy,
      cancelChecked,
      cancelled,
      trigger,
      healthBefore: healthBefore.state,
      tick,
      restarted: false,
      restartAttempts: 0,
      healthAfter: healthBefore.state,
      verified: true,
      verifyAttemptsSpent: 0,
      deliveryPayloads: buildRestartDeliveryPayloads({
        verdict: "verified-up",
        trigger,
        restartId,
        serverUrl: run.serverUrl,
        healthBefore: healthBefore.state,
        healthAfter: healthBefore.state,
        pendingRunIds: pending.pendingRunIds,
        pendingOwners: groupPendingOwners(queueEntries, pending.pendingRunIds),
        ownerRoster: project.roster,
      }),
      missing,
      notes,
      knownLimit: SERVER_RESTART_KNOWN_LIMIT,
    };
  }

  // --- No trigger: verify only, never restart a running server. ---
  if (trigger === "none") {
    const verdict: ServerRestartVerdict = !tick.alive && tick.pendingCount === 0 ? "no-restart-needed" : "verified-up";
    if (verdict === "no-restart-needed") notes.push("tick is dead with nothing pending — no restart needed (the watchdog's shape)");
    return {
      restartId,
      verdict,
      dryRun,
      owner,
      launchedBy,
      cancelChecked,
      cancelled,
      trigger,
      healthBefore: healthBefore.state,
      tick,
      restarted: false,
      restartAttempts: 0,
      healthAfter: healthBefore.state,
      verified: true,
      verifyAttemptsSpent: 0,
      deliveryPayloads: [],
      missing,
      notes,
      knownLimit: SERVER_RESTART_KNOWN_LIMIT,
    };
  }

  // --- Dry-run: plan, write nothing, spawn nothing. ---
  if (dryRun) {
    notes.push("dry-run: would restart the server (trigger: " + trigger + ") and verify /health within " + verifyAttempts + " attempts");
    return {
      restartId,
      verdict: "dry-run",
      dryRun: true,
      owner,
      launchedBy,
      cancelChecked,
      cancelled,
      trigger,
      healthBefore: healthBefore.state,
      tick,
      restarted: false,
      restartAttempts: 0,
      healthAfter: healthBefore.state,
      verified: false,
      verifyAttemptsSpent: 0,
      deliveryPayloads: [],
      missing,
      notes,
      knownLimit: SERVER_RESTART_KNOWN_LIMIT,
    };
  }

  // --- Restart: one attempt, then verify within the budget. ---
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
    const reason = "server spawn failed (exit " + spawn.exitCode + ", stderr: " + (spawn.stderr ?? "").trim().slice(0, 200) + ")";
    notes.push(reason);
    const pendingOwners = groupPendingOwners(queueEntries, pending.pendingRunIds);
    return {
      restartId,
      verdict: "failed",
      dryRun: false,
      owner,
      launchedBy,
      cancelChecked,
      cancelled,
      trigger,
      healthBefore: healthBefore.state,
      tick,
      restarted: false,
      restartAttempts: 1,
      restartLogPath: logPath,
      healthAfter: healthBefore.state,
      verified: false,
      verifyAttemptsSpent: 0,
      deliveryPayloads: buildRestartDeliveryPayloads({
        verdict: "failed",
        trigger,
        restartId,
        serverUrl: run.serverUrl,
        healthBefore: healthBefore.state,
        healthAfter: healthBefore.state,
        pendingRunIds: pending.pendingRunIds,
        pendingOwners,
        ownerRoster: project.roster,
        restartLogPath: logPath,
      }),
      missing,
      notes,
      knownLimit: SERVER_RESTART_KNOWN_LIMIT,
    };
  }
  notes.push("server spawned (pid " + spawnParsed.pid + ", log " + logPath + ")");

  const verifyTrap = exec({
    cmd: "/bin/sh",
    args: ["-c", healthPollScript(run.serverUrl, verifyAttempts, verifyIntervalMs)],
  });
  const verifyParsed = parseHealthPoll(verifyTrap.stdout);
  const verified = verifyParsed.state.ok;
  const verdict: ServerRestartVerdict = verified ? "restarted" : "not-verified";
  if (!verified) {
    notes.push("not verified: /health never answered ok:true within " + verifyAttempts + " attempts (last state: " + verifyParsed.state.detail + ") — the server is NOT verified up");
  }
  const pendingOwners = groupPendingOwners(queueEntries, pending.pendingRunIds);
  return {
    restartId,
    verdict,
    dryRun: false,
    owner,
    launchedBy,
    cancelChecked,
    cancelled,
    trigger,
    healthBefore: healthBefore.state,
    tick,
    restarted: true,
    restartAttempts: 1,
    restartLogPath: logPath,
    healthAfter: verifyParsed.state,
    verified,
    verifyAttemptsSpent: verifyParsed.attemptsSpent,
    deliveryPayloads: buildRestartDeliveryPayloads({
      verdict,
      trigger,
      restartId,
      serverUrl: run.serverUrl,
      healthBefore: healthBefore.state,
      healthAfter: verifyParsed.state,
      pendingRunIds: pending.pendingRunIds,
      pendingOwners,
      ownerRoster: project.roster,
      restartLogPath: logPath,
    }),
    missing,
    notes,
    knownLimit: SERVER_RESTART_KNOWN_LIMIT,
  };
}
