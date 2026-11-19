#!/usr/bin/env bun
/**
 * tick-standin — TEST ONLY (BRA-65/66, BRA-116).
 *
 * The production driver is the tick AGENT (a subagent session, see
 * plugins/muse/TICK-AGENT.md) — NOT a loop script. This scripted
 * loop exists so run.sh can exercise the tick mechanism (tick wake,
 * drive, deliver, escalate) without spawning a subagent. It performs
 * the same steps the agent performs — catch-up sweep, tick, drive,
 * deliver, escalate — but with no judgment: a held gate is
 * escalated, never answered; a stuck running entry is escalated,
 * never flipped. Do not run this as the production driver.
 *
 * BRA-116: the standin drives through the worker server's driver
 * endpoints (POST /queue/run, /deliver-result, /escalate, GET
 * /queue/list, /deliveries) over HTTP, exactly as the tick agent
 * does — it holds no in-process Host and spawns no CLI. The one
 * exception is the escalation dedupe: it reads the escalations dir
 * from disk, as the production agent would (it has shell access to
 * the state dir); there is no GET /escalations endpoint, and the
 * dedupe is a local read, not a driver action.
 *
 *   DURABLETS_HOST=<built C host> bun tests/tick-standin.ts
 *       --state-dir <dir> --server <url>
 *       [--tick-timeout-ms N] [--max-cycles N]
 * Exits 0 after max-cycles (the harness kills it earlier once its
 * delivery lands), 1 on error. Logs one line per cycle.
 */
import * as fs from "node:fs";
import * as path from "node:path";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const ARGS = process.argv.slice(2);
const STATE_DIR = path.resolve(flag(ARGS, "--state-dir") ?? process.env.AGENTTS_STATE_DIR ?? path.join(process.cwd(), ".agentts-state"));
const SERVER = (flag(ARGS, "--server") ?? process.env.AGENTTS_WORKER_SERVER ?? "http://127.0.0.1:18741").replace(/\/$/, "");
const TICK_TIMEOUT_MS = Number(flag(ARGS, "--tick-timeout-ms") ?? "2000");
const MAX_CYCLES = Number(flag(ARGS, "--max-cycles") ?? "200");

async function http(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed };
}

/** Escalations already recorded (dedupe for the sweep): read from
 * disk — the production agent has shell access to the state dir,
 * and there is no GET /escalations endpoint. */
function existingEscalations(): Set<string> {
  const dir = path.join(STATE_DIR, "escalations");
  if (!fs.existsSync(dir)) return new Set();
  const out = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (typeof rec?.kind === "string") out.add(`${rec.kind}:${rec.runId ?? ""}`);
    } catch {
      /* a corrupt record is skipped, never fatal */
    }
  }
  return out;
}

/** Catch-up sweep (the tick agent's step 1): deliver terminal runs
 * without a delivery, escalate held/stuck runs (once each — a
 * second escalation for the same run+kind is a duplicate, not new
 * information). Returns what it did. */
async function sweep(): Promise<{ delivered: string[]; escalated: string[] }> {
  const delivered: string[] = [];
  const escalated: string[] = [];
  const existing = existingEscalations();
  const escalateOnce = async (kind: "gate-held" | "stuck-running", runId: string, reason: string): Promise<void> => {
    if (existing.has(`${kind}:${runId}`)) return;
    const r = await http("POST", "/escalate", { kind, runId, reason });
    if (r.status !== 200) throw new Error(`escalate ${kind} ${runId} failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    existing.add(`${kind}:${runId}`);
    escalated.push(`${kind}:${runId}`);
  };
  const list = await http("GET", "/queue/list");
  if (list.status !== 200) throw new Error(`queue list failed: HTTP ${list.status} ${JSON.stringify(list.body).slice(0, 200)}`);
  const entries: any[] = Array.isArray(list.body?.entries) ? list.body.entries : [];
  const del = await http("GET", "/deliveries");
  if (del.status !== 200) throw new Error(`deliveries failed: HTTP ${del.status} ${JSON.stringify(del.body).slice(0, 200)}`);
  const deliveredIds = new Set<string>(
    (Array.isArray(del.body?.deliveries) ? del.body.deliveries : []).map((d: any) => d.runId as string),
  );
  for (const e of entries) {
    if ((e.status === "done" || e.status === "failed") && !deliveredIds.has(e.runId)) {
      const r = await http("POST", "/deliver-result", { runId: e.runId, deliveredBy: "tick-standin" });
      if (r.status !== 200) throw new Error(`deliver-result ${e.runId} failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      delivered.push(e.runId);
      deliveredIds.add(e.runId);
    } else if (e.status === "held") {
      await escalateOnce("gate-held", e.runId, "run is held at a gate — a human must answer it");
    } else if (e.status === "running") {
      await escalateOnce("stuck-running", e.runId, "queue entry stranded at running — a driver died mid-drive; report, never auto-flip");
    }
  }
  return { delivered, escalated };
}

async function tick(): Promise<{ events: Array<{ type: string }>; timedOut: boolean }> {
  const res = await fetch(`${SERVER}/tick?timeoutMs=${TICK_TIMEOUT_MS}`);
  const text = await res.text();
  if (res.status !== 200) throw new Error(`tick HTTP ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  return { events: body.events ?? [], timedOut: body.timedOut === true };
}

/** Drive the queue through the server. A 409 means another driver
 * holds the lock — that is the lock working, not a failure: log it
 * and let the next cycle's sweep see the result. */
async function drive(): Promise<boolean> {
  const r = await http("POST", "/queue/run");
  if (r.status === 409) {
    console.log(`[standin] drive refused: another driver holds the lock (${JSON.stringify(r.body).slice(0, 200)})`);
    return false;
  }
  if (r.status !== 200) throw new Error(`queue run failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return true;
}

async function main(): Promise<number> {
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const s1 = await sweep();
    let ev: { events: Array<{ type: string }>; timedOut: boolean };
    try {
      ev = await tick();
    } catch (e) {
      console.log(`[standin] cycle ${cycle}: tick failed: ${e instanceof Error ? e.message : String(e)}`);
      await Bun.sleep(500);
      continue;
    }
    const types = ev.events.map((e) => e.type);
    let drove = false;
    if (types.includes("run-submitted") || types.includes("gate-answered")) {
      drove = await drive();
    }
    const s2 = drove ? await sweep() : { delivered: [], escalated: [] };
    console.log(
      `[standin] cycle ${cycle}: tick ${ev.timedOut ? "timeout" : `events [${types.join(",")}]`} ` +
        `sweep delivered [${[...s1.delivered, ...s2.delivered].join(",")}] escalated [${[...s1.escalated, ...s2.escalated].join(",")}]` +
        (drove ? " drove queue" : ""),
    );
    await Bun.sleep(100);
  }
  console.log(`[standin] max cycles (${MAX_CYCLES}) reached — exiting`);
  return 0;
}

process.exit(await main());
