// watchdog — the tick-agent health check (BRA-65).
//
// The watchdog is the supervisor, not the driver. It answers one
// question: is the tick agent alive, and is there pending work? It
// never drives the queue, never flips a queue entry, never delivers
// a result — it reports, and the runtime cron that runs it restarts
// the tick agent when the report says to.
//
//   - Tick alive: <stateDir>/tick/state.json carries lastTickAt,
//     written on every tick call and every tick-beat. Alive means
//     the last tick/beat is within `staleMinutes` (default 15).
//     15 minutes is 15x the normal beat interval (a live agent
//     ticks every ~60s and beats every ~20s while acting), so a
//     false restart needs 15 minutes of silence — i.e. the agent
//     is actually stuck or dead. Detection latency is the cron
//     interval (30 min): a session that dies just after a cron tick
//     is caught at the next one, ~30 min later, staleness ~30 min
//     > 15 min. Stated plainly: up to ~30 min before a dead session
//     is noticed.
//   - Pending work: queued runs, held gates, undelivered results
//     (a done/failed queue entry with no delivery record), and
//     queue entries stranded at "running" (a driver died mid-drive;
//     reported, never auto-flipped — BRA-62 G2). Escalations are
//     listed so the cron surfaces them.
//   - needsRestart: the tick agent is dead AND there is pending
//     work. A dead tick agent with nothing pending needs no restart
//     (nothing would do); a live tick agent with pending work is
//     already on it.
//
// The check reads files directly (queue.json, deliveries/,
// escalations/, tick/state.json) and never constructs a Host — it
// must not need the C host binary, and it must be fast enough to
// run every 30 minutes from a cron.

import * as fs from "node:fs";
import * as path from "node:path";

/** Default staleness: a tick agent silent this long is presumed dead. */
export const DEFAULT_WATCHDOG_STALE_MINUTES = 15;

export interface WatchdogTick {
  alive: boolean;
  lastTickAt: string | null;
  ageMs: number | null;
  staleMinutes: number;
}

export interface WatchdogPending {
  queuedRuns: string[];
  heldRuns: string[];
  undeliveredResults: string[];
  stuckRunning: string[];
  escalations: Array<{ kind: string; runId?: string; reason: string; at: string }>;
}

export interface WatchdogReport {
  stateDir: string;
  tick: WatchdogTick;
  pending: WatchdogPending;
  pendingCount: number;
  needsRestart: boolean;
  summary: string;
}

function readJsonFile(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readQueue(stateDir: string): Array<{ runId: string; status: string }> {
  const q = readJsonFile(path.join(stateDir, "queue.json"));
  if (!Array.isArray(q)) return [];
  return q.filter(
    (e): e is { runId: string; status: string } =>
      !!e && typeof e === "object" && typeof (e as any).runId === "string" && typeof (e as any).status === "string",
  );
}

function deliveredRunIds(stateDir: string): Set<string> {
  const dir = path.join(stateDir, "deliveries");
  const out = new Set<string>();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = readJsonFile(path.join(dir, f)) as { runId?: unknown } | null;
    if (rec && typeof rec.runId === "string") out.add(rec.runId);
  }
  return out;
}

function readEscalations(stateDir: string): WatchdogPending["escalations"] {
  const dir = path.join(stateDir, "escalations");
  const out: WatchdogPending["escalations"] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const rec = readJsonFile(path.join(dir, f)) as { kind?: unknown; runId?: unknown; reason?: unknown; at?: unknown } | null;
    if (rec && typeof rec.kind === "string" && typeof rec.reason === "string") {
      out.push({
        kind: rec.kind,
        ...(typeof rec.runId === "string" ? { runId: rec.runId } : {}),
        reason: rec.reason,
        at: typeof rec.at === "string" ? rec.at : "",
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/** Check tick liveness + pending work. Never throws on missing or
 * corrupt state: missing state is "nothing pending", corrupt state
 * is reported as a stuck/unknown entry, never a crash. */
export function checkWatchdog(stateDir: string, staleMinutes: number = DEFAULT_WATCHDOG_STALE_MINUTES): WatchdogReport {
  const tickFile = readJsonFile(path.join(stateDir, "tick", "state.json")) as { lastTickAt?: unknown } | null;
  const lastTickAt = typeof tickFile?.lastTickAt === "string" ? tickFile.lastTickAt : null;
  const ageMs = lastTickAt === null ? null : Date.now() - Date.parse(lastTickAt);
  const alive = ageMs !== null && ageMs <= staleMinutes * 60_000;

  const queue = readQueue(stateDir);
  const delivered = deliveredRunIds(stateDir);
  const queuedRuns = queue.filter((e) => e.status === "queued").map((e) => e.runId);
  const heldRuns = queue.filter((e) => e.status === "held").map((e) => e.runId);
  const stuckRunning = queue.filter((e) => e.status === "running").map((e) => e.runId);
  const undeliveredResults = queue
    .filter((e) => (e.status === "done" || e.status === "failed") && !delivered.has(e.runId))
    .map((e) => e.runId);
  const escalations = readEscalations(stateDir);

  const pendingCount = queuedRuns.length + heldRuns.length + undeliveredResults.length + stuckRunning.length;
  const needsRestart = !alive && pendingCount > 0;

  const parts: string[] = [];
  parts.push(
    alive
      ? `tick agent alive (last tick ${ageMs === null ? "?" : `${Math.round(ageMs / 1000)}s ago`})`
      : lastTickAt === null
        ? "tick agent never ticked (no tick state)"
        : `tick agent DEAD (last tick ${Math.round((ageMs ?? 0) / 1000)}s ago, stale > ${staleMinutes}m)`,
  );
  parts.push(
    `pending: ${queuedRuns.length} queued, ${heldRuns.length} held, ${undeliveredResults.length} undelivered result(s), ${stuckRunning.length} stuck running, ${escalations.length} escalation(s)`,
  );
  parts.push(
    needsRestart
      ? "RESTART NEEDED: tick agent is dead and there is pending work — spawn a new tick agent (see plugins/muse/TICK-AGENT.md)"
      : alive
        ? "no restart: tick agent is alive"
        : "no restart: tick agent is dead but there is no pending work",
  );
  return {
    stateDir,
    tick: { alive, lastTickAt, ageMs, staleMinutes },
    pending: { queuedRuns, heldRuns, undeliveredResults, stuckRunning, escalations },
    pendingCount,
    needsRestart,
    summary: parts.join(" — "),
  };
}
