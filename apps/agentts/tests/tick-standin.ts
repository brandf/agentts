#!/usr/bin/env bun
/**
 * tick-standin — TEST ONLY (BRA-65/66).
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
 *   DURABLETS_HOST=<built C host> bun tests/tick-standin.ts
 *       --state-dir <dir> --server <url>
 *       [--adapter mock|direct] [--tick-timeout-ms N] [--max-cycles N]
 * Exits 0 after max-cycles (the harness kills it earlier once its
 * delivery lands), 1 on error. Logs one line per cycle.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const ARGS = process.argv.slice(2);
const STATE_DIR = path.resolve(flag(ARGS, "--state-dir") ?? process.env.AGENTTS_STATE_DIR ?? path.join(process.cwd(), ".agentts-state"));
const SERVER = (flag(ARGS, "--server") ?? process.env.AGENTTS_WORKER_SERVER ?? "http://127.0.0.1:18741").replace(/\/$/, "");
const ADAPTER = flag(ARGS, "--adapter") ?? "mock";
const TICK_TIMEOUT_MS = Number(flag(ARGS, "--tick-timeout-ms") ?? "2000");
const MAX_CYCLES = Number(flag(ARGS, "--max-cycles") ?? "200");

const host = new Host({
  stateDir: STATE_DIR,
  adapter: ADAPTER === "direct" ? new DirectAdapter() : new MockAdapter({ gates: "hold" }),
  clock: "virtual",
});

/** Catch-up sweep (the tick agent's step 1): deliver terminal runs
 * without a delivery, escalate held/stuck runs (once each — a
 * second escalation for the same run+kind is a duplicate, not new
 * information). Returns what it did. */
function sweep(): { delivered: string[]; escalated: string[] } {
  const delivered: string[] = [];
  const escalated: string[] = [];
  const existing = new Set(
    host.listEscalations().map((e) => `${e.kind}:${e.runId ?? ""}`),
  );
  const escalateOnce = (kind: "gate-held" | "stuck-running", runId: string, reason: string): void => {
    if (existing.has(`${kind}:${runId}`)) return;
    host.writeEscalation({ kind, runId, reason }, "tick-standin");
    existing.add(`${kind}:${runId}`);
    escalated.push(`${kind}:${runId}`);
  };
  for (const e of host.readQueue()) {
    if ((e.status === "done" || e.status === "failed") && !host.deliveryFor(e.runId)) {
      host.recordDelivery(e.runId, "tick-standin");
      delivered.push(e.runId);
    } else if (e.status === "held") {
      escalateOnce("gate-held", e.runId, "run is held at a gate — a human must answer it");
    } else if (e.status === "running") {
      escalateOnce("stuck-running", e.runId, "queue entry stranded at running — a driver died mid-drive; report, never auto-flip");
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

async function main(): Promise<number> {
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const s1 = sweep();
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
      await host.runQueue();
      drove = true;
    }
    const s2 = drove ? sweep() : { delivered: [], escalated: [] };
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
