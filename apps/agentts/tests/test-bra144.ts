#!/usr/bin/env bun
/**
 * CLI+direct happy paths for any() and race() (Linear BRA-144).
 *
 * all() has a CLI+direct e2e test (test-bra90.ts FORK, N-branch
 * all()), but any() and race() had only mock coverage plus
 * Host-API-direct failure paths (test-bra121.ts). No CLI+direct
 * happy path existed for either.
 *
 * Fixture tests/workflows/workflow-bra144-any-race.ts suspends its
 * winning branches on real sleep traps (5ms) and proves the losers
 * never run via a marker file only a loser's exec would write:
 *   A. any() — the first branch throws, the 5ms branch returns
 *      "fast", the exec branch would write "slow" to the marker.
 *      Run through the CLI with --wait on direct: done, winner
 *      "fast", marker empty (the loser never ran).
 *   B. race() — the first branch returns "fast" after a 5ms sleep;
 *      the exec branch would write "slow" and the third would
 *      throw. Submitted through the CLI, driven by a separate
 *      `queue run` process, read back with `result`: done, winner
 *      "fast", marker empty.
 * (Sequential driver: the first branch is always the first
 * settler — workflow-race.ts documents that true time-based racing
 * needs the real scheduler (M3). These paths prove the join
 * mechanics in array order, not a wall-clock race.)
 *
 * Notes, stated plainly:
 * - AGENTTS_WORKER_SERVER points at a closed port: these runs have
 *   no job traps, but a Host's notifyEvent must never post test
 *   events to the production server (port 18741) — the BRA-133
 *   lesson. The dead port fails fast and is swallowed.
 * - The 5ms sleep is a real suspension, not a placeholder; the
 *   winner does not depend on wall-clock ordering between branches
 *   (sequential driver), so there is no flaky timing assertion.
 *
 *   bun tests/test-bra144.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const WORKDIR = process.env.BRA144_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "bra144-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
const WF = path.join(ROOT, "tests", "workflows", "workflow-bra144-any-race.ts");
// No job traps in this fixture, but notifyEvent must never reach the
// production server (BRA-133): point it at a closed port.
process.env.AGENTTS_WORKER_SERVER = "http://127.0.0.1:59999";

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

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 120_000,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function parseJson(out: string): any | null {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
function readQueue(): any[] {
  const p = path.join(STATE_DIR, "queue.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- A. any() via --wait
{
  const runId = "bra144-any";
  const marker = path.join(WORKDIR, "bra144-any.marker");
  const r = cli([
    "run", WF, "--adapter", "direct", "--state-dir", STATE_DIR,
    "--run-id", runId, "--input", JSON.stringify({ mode: "any", markerFile: marker }), "--wait",
  ]);
  check(r.rc === 0, `A CLI OK: any() run --wait exited 0 (got ${r.rc}${r.rc !== 0 ? ` — ${(r.out + r.err).trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : ""})`);
  const res = parseJson(r.out);
  check(
    res !== null && res.winner === "fast",
    `A ANY OK: any() returns the first success "fast" (got ${JSON.stringify(res)?.slice(0, 120)})`,
  );
  check(
    readQueue().find((e) => e.runId === runId)?.status === "done",
    `A ANY OK: queue entry for ${runId} is done`,
  );
  check(
    !fs.existsSync(marker),
    `A LOSER OK: the losing exec branch never ran — marker file absent (would contain "slow")`,
  );
}

// ---------------------------------------------------------------- B. race() via submit + queue run + result
{
  const runId = "bra144-race";
  const marker = path.join(WORKDIR, "bra144-race.marker");
  const s = cli([
    "run", WF, "--adapter", "direct", "--state-dir", STATE_DIR,
    "--run-id", runId, "--input", JSON.stringify({ mode: "race", markerFile: marker }),
  ]);
  check(
    s.rc === 0 && s.out.includes(`RUN ${runId}`),
    `B SUBMIT OK: race() submitted through the CLI (rc ${s.rc})`,
  );
  const d = cli(["queue", "run", "--state-dir", STATE_DIR]);
  check(d.rc === 0, `B DRIVE OK: queue run exited 0 (got ${d.rc})`);
  check(
    readQueue().find((e) => e.runId === runId)?.status === "done",
    `B DRIVE OK: queue entry for ${runId} is done`,
  );
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `B RESULT OK: result exited 0 (got ${res.rc})`);
  const out = parseJson(res.out);
  check(
    out !== null && out.winner === "fast",
    `B RACE OK: race() returns the first settler "fast" (got ${JSON.stringify(out)?.slice(0, 120)})`,
  );
  check(
    !fs.existsSync(marker),
    `B LOSER OK: the losing branches never ran — marker file absent (would contain "slow")`,
  );
}

if (FAILURES.length) {
  console.log(`\ntest-bra144: ${FAILURES.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  "\nPASS bra144 any()/race() CLI+direct happy paths (any() returns the first success, race() the first settler, both through the CLI on direct with real sleep traps; the losing branches never ran)",
);
