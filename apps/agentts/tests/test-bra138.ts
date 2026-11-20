#!/usr/bin/env bun
/**
 * Plan-driven-work CLI e2e test (Linear BRA-138).
 *
 * `tests/test-bra117.ts` proves plan-driven-work through the Host API
 * (mock mirror + direct with real workers and held gates) but never
 * through the CLI: it has 0 `cli.ts` mentions. The only CLI run was
 * the ad-hoc `~/workspace/verify-bra117.ts`, which is not in
 * `run.sh`. This test commits the CLI procedure that script
 * documents — submit, gate hold, `deliver-gate`, execute, result,
 * all through `bun src/cli.ts` on the direct adapter — over the
 * same proof run test-bra117 drives in-process: the BRA-110 plan
 * (`tests/fixtures/plan-driven-work/bra110-plan-input.json`).
 *
 * What this proves, through the real usage path:
 *   A. Submit through the CLI returns a runId immediately
 *      (`RUN <runId>`, exit 0) and the run is queued, not driven.
 *   B. `queue run --gates hold` drives it to the human gate and
 *      stops: the queue entry is `held`, `result` prints
 *      GATE PENDING (rc 2), and the journal at the gate shows the
 *      plan loop ran (1 plan-draft, 2 aggregates, 1 fix, 4 decide,
 *      1 gate) with the approved plan reconstructible.
 *   C. `deliver-gate` with `{"answer":"approve"}` through the CLI
 *      is accepted, and a second `queue run` drives the run to
 *      `done` — the result JSON is the plan output (2 loops,
 *      converged at 0.98, 3 phases executed in order, 3 deferred,
 *      3 phase reviews, commit ran) with real evidence, not canned
 *      text, and real effects on disk (baseline.txt,
 *      delivery-record.txt).
 *   D. Frozen == executed, proven from the journal: the journaled
 *      approved plan equals the result's plan, exactly one trap
 *      executed each approved phase, no trap executed a deferred
 *      phase, the gate precedes the phase reviews and the commit,
 *      and the phase reviews ran as child runs with their own
 *      journals.
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133).
 * - The journal is read through a read-only in-process Host over
 *   the same state dir (construction drives nothing); the run
 *   itself is driven only by CLI subprocesses.
 * - The plan's job workers are real worker processes spawned by
 *   the direct adapter, exactly as in test-bra117's direct run.
 *
 *   DURABLETS_HOST=<built C host> AGENTTS_DURABLETS_DIR=<durablets>
 *   bun tests/test-bra138.ts
 *   (run.sh sets DURABLETS_HOST and AGENTTS_DURABLETS_DIR and runs
 *   this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "workflows", "library", "plan-driven-work.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plan-driven-work");
const WORKDIR = process.env.BRA138_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra138-"));
fs.mkdirSync(WORKDIR, { recursive: true });
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
const RUN_ID = "run-bra138-plan";

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

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

let server: Subprocess | null = null;
async function startServer(): Promise<void> {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("bra138 server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
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
function queueStatus(runId: string): string | null {
  return readQueue().find((e) => e.runId === runId)?.status ?? null;
}

/** Order-insensitive deep equality for JSON values (copied from
 * test-bra117.ts — the journaled phase and the approved plan's
 * phase may list keys in different orders). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k, i) =>
      k === bk[i] &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function unwrapResult(e: any): unknown {
  const r = e?.result;
  if (r !== null && typeof r === "object" && !Array.isArray(r) && "value" in r) return r.value;
  return r;
}

/** Read-only journal access through an in-process Host over the
 * same state dir. Constructing a Host drives nothing — the run is
 * driven only by CLI subprocesses. */
function readHost(): Host {
  return new Host({ stateDir: STATE_DIR });
}

function allEvents(host: Host, runId: string): any[] {
  const events = host.journal(runId);
  const out = [...events];
  for (const e of events) {
    if (e.event === "fork" && Array.isArray(e.childRuns)) {
      for (const child of e.childRuns) out.push(...host.journal(child));
    }
  }
  return out;
}

function trapCounts(journal: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of journal) {
    if (e.event === "trap") {
      const key = e.type === "job" ? `job:${e.arg?.spec ?? "?"}` : e.type;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function approvedPlanFromJournal(journal: any[]): any | null {
  const plans: any[] = [];
  for (const e of journal) {
    if (e.event !== "trap-dispatched" && e.event !== "trap-result") continue;
    const v = unwrapResult(e);
    if (v !== null && typeof v === "object" && Array.isArray((v as any).phases) && typeof (v as any).request === "string") {
      plans.push(v);
    }
  }
  return plans.length ? plans[plans.length - 1] : null;
}

function loadInput(outDir: string): string {
  const raw = fs.readFileSync(path.join(FIXTURES, "bra110-plan-input.json"), "utf8");
  const resolved = raw.replaceAll("__OUTDIR__", outDir);
  const p = path.join(WORKDIR, "bra110-plan-input.json");
  fs.writeFileSync(p, resolved);
  return p;
}

function seedOutbox(outDir: string): void {
  fs.mkdirSync(path.join(outDir, "outbox"), { recursive: true });
  for (const n of ["delivery-run-001.json", "delivery-run-002.json", "delivery-run-003.json"]) {
    fs.writeFileSync(path.join(outDir, "outbox", n), JSON.stringify({ run: n }) + "\n");
  }
}

async function main(): Promise<number> {
  await startServer();
  try {
    const outDir = path.join(WORKDIR, "bra110");
    seedOutbox(outDir);
    const inputFile = loadInput(outDir);

    // A. Submit through the CLI.
    console.log("\n=== A. CLI submit ===");
    const sub = cli(["run", WORKFLOW, "--run-id", RUN_ID, "--adapter", "direct", "--input-file", inputFile, "--state-dir", STATE_DIR, "--gates", "hold"]);
    check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
    check(sub.out.includes(`RUN ${RUN_ID}`), `SUBMIT OK: submit prints RUN ${RUN_ID} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
    check(queueStatus(RUN_ID) !== null, `SUBMIT OK: run ${RUN_ID} is queued (got ${queueStatus(RUN_ID) ?? "missing"})`);

    // B. Drive to the gate.
    console.log("\n=== B. queue run holds at the human gate ===");
    const drive1 = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
    check(drive1.rc === 0, `GATE OK: first queue run exits 0 (got ${drive1.rc}: ${(drive1.out + drive1.err).slice(0, 200)})`);
    check(queueStatus(RUN_ID) === "held", `GATE OK: run held at the human gate (got ${queueStatus(RUN_ID) ?? "missing"})`);
    const pending = cli(["result", RUN_ID, "--state-dir", STATE_DIR]);
    check(pending.rc === 2 && pending.out.includes("GATE PENDING"), `GATE OK: result on the held run prints GATE PENDING with rc 2 (got rc ${pending.rc})`);
    {
      const host = readHost();
      const journal = host.journal(RUN_ID);
      const counts = trapCounts(journal);
      check(counts["job:plan-draft"] === 1, `GATE OK: 1 plan-draft trap (got ${counts["job:plan-draft"]})`);
      check(counts["job:aggregate"] === 2, `GATE OK: 2 aggregate traps — plan loop ran 2 loops (got ${counts["job:aggregate"]})`);
      check(counts["job:fix"] === 1, `GATE OK: 1 fix trap — only loop 1 needed fixes (got ${counts["job:fix"]})`);
      check(counts["decide"] === 4, `GATE OK: 4 decide traps — revise + converged per loop (got ${counts["decide"]})`);
      check(counts["gate"] === 1, `GATE OK: 1 gate trap (got ${counts["gate"]})`);
      const plan = approvedPlanFromJournal(journal);
      check(plan !== null, "GATE OK: approved plan reconstructible from the journal");
      if (plan) {
        check(plan.revisions === 1, `GATE OK: plan revised once (got ${plan.revisions})`);
        check(Array.isArray(plan.reviewPoints) && plan.reviewPoints.length === 6, `GATE OK: fix added 6 review points (got ${plan.reviewPoints?.length})`);
        check(plan.phases.length === 6, `GATE OK: plan has 6 phases (got ${plan.phases.length})`);
      }
    }

    // C. Approve at the gate, drive to completion.
    console.log("\n=== C. deliver-gate approve, drive to done ===");
    const ans = cli(["deliver-gate", RUN_ID, '{"answer":"approve"}', "--state-dir", STATE_DIR, "--adapter", "direct", "--gates", "hold"]);
    check(ans.rc === 0, `APPROVE OK: deliver-gate exits 0 (got ${ans.rc}: ${(ans.out + ans.err).slice(0, 200)})`);
    check(ans.out.includes("gate answer delivered"), `APPROVE OK: deliver-gate confirms the answer (got ${JSON.stringify(ans.out.slice(0, 120))})`);
    const drive2 = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
    check(drive2.rc === 0, `DONE OK: second queue run exits 0 (got ${drive2.rc}: ${(drive2.out + drive2.err).slice(0, 200)})`);
    check(queueStatus(RUN_ID) === "done", `DONE OK: run done after the gate answer (got ${queueStatus(RUN_ID) ?? "missing"})`);
    const res = cli(["result", RUN_ID, "--state-dir", STATE_DIR]);
    check(res.rc === 0, `DONE OK: result exits 0 (got ${res.rc}: ${(res.out + res.err).slice(0, 200)})`);
    let out: any = null;
    try {
      out = JSON.parse(res.out);
    } catch {
      fail(`DONE OK: result prints parseable JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    }
    if (out) {
      check(out.planLoops === 2, `DONE OK: plan loop converged in 2 loops (got ${out.planLoops})`);
      check(out.planConverged === true, `DONE OK: plan converged (got ${out.planConverged})`);
      check(out.planFinalMeanScore === 0.98, `DONE OK: plan final mean score 0.98 (got ${out.planFinalMeanScore})`);
      check(out.gateRounds === 1, `DONE OK: approved on the first gate round (got ${out.gateRounds})`);
      check(
        JSON.stringify(out.executed.map((r: any) => r.phase)) === JSON.stringify(["survey-outbox", "record-baseline", "summarize-baseline"]),
        `DONE OK: 3 phases executed, in order (got ${JSON.stringify(out.executed.map((r: any) => r.phase))})`,
      );
      check(
        JSON.stringify(out.deferred) === JSON.stringify(["submit-production-run", "drive-and-verify-delivery", "record-delivery"]),
        `DONE OK: 3 production phases deferred (got ${JSON.stringify(out.deferred)})`,
      );
      check(out.phaseReviews.length === 3, `DONE OK: 3 phase reviews (got ${out.phaseReviews.length})`);
      for (const r of out.phaseReviews) {
        check(r.loops === 1 && r.converged === true && r.finalMeanScore === 0.98, `DONE OK: phase review ${r.phase} converged in 1 loop at 0.98 (got ${JSON.stringify(r)})`);
      }
      check(out.committed === true, `DONE OK: commit step ran (got ${out.committed})`);
      const survey = out.executed.find((r: any) => r.phase === "survey-outbox");
      check(
        survey?.evidence?.includes("delivery-run-001.json") && survey?.evidence?.includes("delivery-run-003.json"),
        `DONE OK: survey evidence lists the seeded delivery records (${JSON.stringify(survey?.evidence)})`,
      );
      const baseline = out.executed.find((r: any) => r.phase === "record-baseline");
      check(baseline?.evidence === "baseline written", `DONE OK: baseline evidence is the real command output (${JSON.stringify(baseline?.evidence)})`);
      const summary = out.executed.find((r: any) => r.phase === "summarize-baseline");
      check(
        (summary?.evidence ?? "").includes("survey-outbox: ok") && (summary?.evidence ?? "").includes("record-baseline: ok") && (summary?.evidence ?? "").includes("Content hash"),
        `DONE OK: agent phase evidence summarizes the real prior results (${JSON.stringify(summary?.evidence)?.slice(0, 160)})`,
      );
      check(fs.existsSync(path.join(outDir, "baseline.txt")), "DONE OK: baseline.txt written");
      if (fs.existsSync(path.join(outDir, "baseline.txt"))) {
        const b = fs.readFileSync(path.join(outDir, "baseline.txt"), "utf8");
        check(b.includes("delivery-run-001.json") && b.includes("delivery-run-003.json"), "DONE OK: baseline.txt carries the outbox listing");
      }
      check(fs.existsSync(path.join(outDir, "delivery-record.txt")), "DONE OK: delivery-record.txt written (commit leg)");
      if (fs.existsSync(path.join(outDir, "delivery-record.txt"))) {
        check(
          fs.readFileSync(path.join(outDir, "delivery-record.txt"), "utf8").includes("3 executed, 3 deferred"),
          "DONE OK: delivery record names the executed/deferred counts",
        );
      }
    }

    // D. Frozen == executed, from the journal.
    console.log("\n=== D. frozen == executed (journal) ===");
    if (out) {
      const host = readHost();
      const journal = host.journal(RUN_ID);
      const approved = approvedPlanFromJournal(journal);
      check(approved !== null, "FROZEN OK: approved plan reconstructible after completion");
      if (approved) {
        check(deepEqual(approved, out.plan), "FROZEN OK: journaled approved plan equals the result's plan");
        const events = allEvents(host, RUN_ID);
        const executedPhases = approved.phases.filter((p: any) => !out.deferred.includes(p.name));
        check(executedPhases.length === 3, `FROZEN OK: 3 executed phases in the approved plan (got ${executedPhases.length})`);
        for (const phase of executedPhases) {
          if (phase.kind === "command") {
            const match = events.filter(
              (e: any) =>
                e.event === "trap" && e.type === "exec" && e.arg?.cmd === phase.command && deepEqual(e.arg?.args ?? [], phase.args ?? []),
            );
            check(match.length === 1, `FROZEN OK: exactly 1 exec trap for command phase "${phase.name}" (got ${match.length})`);
          } else {
            const match = events.filter(
              (e: any) => e.event === "trap" && e.type === "job" && e.arg?.spec === "plan-phase" && deepEqual(e.arg?.input?.phase, phase),
            );
            check(match.length === 1, `FROZEN OK: exactly 1 plan-phase trap carrying the approved phase "${phase.name}" (got ${match.length})`);
          }
        }
        for (const name of out.deferred) {
          const phase = approved.phases.find((p: any) => p.name === name);
          const match = events.filter(
            (e: any) =>
              e.event === "trap" &&
              ((e.type === "job" && e.arg?.spec === "plan-phase" && e.arg?.input?.phase?.name === name) ||
                (e.type === "exec" && phase?.kind === "command" && e.arg?.cmd === phase.command && deepEqual(e.arg?.args ?? [], phase.args ?? []))),
          );
          check(match.length === 0, `FROZEN OK: no trap executed deferred phase "${name}" (got ${match.length})`);
        }
        const gateIdx = journal.findIndex((e: any) => e.event === "trap" && e.type === "gate");
        const firstRunIdx = journal.findIndex((e: any) => e.event === "trap" && e.type === "run");
        const commitIdx = journal.findIndex(
          (e: any) => e.event === "trap" && e.type === "exec" && JSON.stringify(e.arg?.args ?? []).includes("delivery-record.txt"),
        );
        check(gateIdx >= 0 && firstRunIdx > gateIdx, `FROZEN OK: gate trap precedes the phase reviews (gate ${gateIdx}, first run ${firstRunIdx})`);
        check(gateIdx >= 0 && commitIdx > gateIdx, `FROZEN OK: gate trap precedes the commit (gate ${gateIdx}, commit ${commitIdx})`);
        const runTrapEvents = journal.filter((e: any) => e.event === "trap" && e.type === "run");
        check(runTrapEvents.length === 3, `FROZEN OK: 3 run traps (phase reviews as child runs, got ${runTrapEvents.length})`);
        for (const t of runTrapEvents) {
          const cj = host.journal(`${t.trapId}/child`);
          const cc = trapCounts(cj);
          check(
            (cc["job:aggregate"] ?? 0) === 1 && (cc["decide"] ?? 0) === 2,
            `FROZEN OK: child ${t.trapId}/child ran its own review loop (aggregate ${cc["job:aggregate"]}, decide ${cc["decide"]})`,
          );
        }
      }
      const finalCounts = trapCounts(allEvents(host, RUN_ID));
      check(finalCounts["job:judge"] === 6, `DONE OK: 6 judge traps across the plan loop (3 per loop, got ${finalCounts["job:judge"]})`);
      check(finalCounts["job:plan-phase"] === 1, `DONE OK: 1 plan-phase trap (got ${finalCounts["job:plan-phase"]})`);
      check(finalCounts["exec"] === 3, `DONE OK: 3 exec traps — 2 phase commands + commit (got ${finalCounts["exec"]})`);
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA138 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra138 plan-driven-work CLI e2e (submit, gate hold, deliver-gate approve, execute, result — all through the CLI on direct; frozen == executed from the journal)");
  return 0;
}

process.exit(await main());
