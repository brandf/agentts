#!/usr/bin/env bun
/**
 * Gates auto-answered "yes" by default, silently (Linear BRA-119).
 *
 * The mock adapter — the default outside the production state dir —
 * answered every gate trap with "yes" at once, with no log line and
 * no journal marking: a human checkpoint that never held unless the
 * submitter passed --gates hold. Found while verifying BRA-116 with
 * an ad-hoc workflow: the journal showed the gate trap dispatched
 * with {"answer": "yes"} 2ms after dispatch, with no human input.
 *
 * The fix is (a) loud + (b) documented — the default stays "auto"
 * (right for tests and unattended runs):
 *   - an auto-answered gate logs GATE AUTO-ANSWERED on stderr,
 *     naming the run and the trap, and the journal's trap-dispatched
 *     and trap-result events carry `auto: true` (host-side-only
 *     provenance on TrapAnswer, carried through repairs and the
 *     BRA-75 re-dispatch check, like worker/tokens);
 *   - the gate trap docs, the run help, the plan-driven-work
 *     template header and README §1.7, and the usage skill all say
 *     a real human checkpoint needs --gates hold on BOTH run/submit
 *     and queue run (the two commands build separate Hosts).
 *
 * What this proves (CLI-driven, mock adapter, own state dirs,
 * workflow-gate-hold.ts — the week-long gate in miniature):
 *   A. Auto-answer is loud + marked (the issue reproduction):
 *      submit with no --gates flag, drive with no --gates flag —
 *      the run completes on "yes", the queue-run stderr carries
 *      GATE AUTO-ANSWERED naming the run and the trap, and the
 *      journal's trap-dispatched AND trap-result events for the
 *      gate carry `auto: true`.
 *   B. Hold actually holds: submit AND drive with --gates hold —
 *      the run stays held (queue entry "held", gate-held event, no
 *      trap-dispatched for the gate, no AUTO-ANSWERED line), then
 *      deliver-gate '{"answer":"approve"}' + drive again completes
 *      the run with the human answer — and that journal's
 *      trap-dispatched event carries NO auto marking.
 *   C. A queued gate answer is deliberate, not auto: in-process,
 *      a MockAdapter with gates "auto" + a queued gate answer
 *      delivers the queued answer with no auto marking anywhere
 *      (no log line — the drive is in-process so there is no CLI
 *      stderr to read — and no `auto` on either journal event).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra119.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra96
 *   suite.) Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA119_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra119-"));
fs.mkdirSync(WORKDIR, { recursive: true });

const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-gate-hold.ts");

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function stateDirFor(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function queueStatus(stateDir: string, runId: string): string | null {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(stateDir, "queue.json"), "utf8"));
    return q.find((e: any) => e.runId === runId)?.status ?? null;
  } catch {
    return null;
  }
}

function journalEvents(stateDir: string, runId: string): any[] {
  const p = path.join(stateDir, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function getResult(stateDir: string, runId: string): { status: string; output?: unknown; error?: string } | null {
  const r = cli(["result", runId, "--state-dir", stateDir]);
  if (r.rc === 0) {
    try {
      return { status: "done", output: JSON.parse(r.out) };
    } catch {
      return null;
    }
  }
  return null;
}

function gateEvents(events: any[]): { dispatched: any | undefined; result: any | undefined; held: any | undefined } {
  const dispatched = events.find((e) => e.event === "trap-dispatched" && e.type === "gate");
  const trapId = dispatched?.trapId;
  const result = trapId ? events.find((e) => e.event === "trap-result" && e.trapId === trapId) : undefined;
  const held = events.find((e) => e.event === "gate-held");
  return { dispatched, result, held };
}

// ---------------------------------------------------------------- A. auto-answer is loud + marked
{
  const sd = stateDirFor("auto");
  const runId = "bra119-auto";
  const sub = cli(["run", WORKFLOW, "--run-id", runId, "--state-dir", sd]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `A SUBMIT OK: ${runId} submitted with no --gates flag (rc ${sub.rc})`);
  const drive = cli(["queue", "run", "--state-dir", sd]);
  check(drive.rc === 0, `A DRIVE OK: queue run exited 0 (got ${drive.rc})`);
  const res = getResult(sd, runId);
  check(res?.status === "done" && (res.output as any)?.done === true, `A RESULT OK: run completed on the auto answer (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(
    drive.err.includes("GATE AUTO-ANSWERED") && drive.err.includes(runId),
    `A LOUD OK: queue-run stderr logs GATE AUTO-ANSWERED naming the run (stderr: ${drive.err.slice(0, 200)})`,
  );
  const events = journalEvents(sd, runId);
  const { dispatched, result } = gateEvents(events);
  check(dispatched !== undefined, `A JOURNAL OK: a trap-dispatched event exists for the gate trap`);
  check(
    dispatched?.result?.value?.answer === "yes",
    `A ANSWER OK: the auto answer is "yes" (got ${JSON.stringify(dispatched?.result?.value)})`,
  );
  check(dispatched?.auto === true, `A MARKED OK: trap-dispatched carries auto: true (got auto=${dispatched?.auto})`);
  check(result?.auto === true, `A MARKED OK: trap-result carries auto: true (got auto=${result?.auto})`);
  // The workflow itself sees exactly the old shape — the marking
  // never crosses into the engine.
  check(
    result?.result?.answer === "yes" && !("auto" in (result?.result ?? {})),
    `A SHAPE OK: the workflow-visible result is exactly {answer:"yes"} (got ${JSON.stringify(result?.result)})`,
  );
}

// ---------------------------------------------------------------- B. hold actually holds
{
  const sd = stateDirFor("hold");
  const runId = "bra119-hold";
  const sub = cli(["run", WORKFLOW, "--run-id", runId, "--gates", "hold", "--state-dir", sd]);
  check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `B SUBMIT OK: ${runId} submitted with --gates hold (rc ${sub.rc})`);
  const drive1 = cli(["queue", "run", "--gates", "hold", "--state-dir", sd]);
  check(drive1.rc === 0, `B DRIVE OK: queue run exited 0 (got ${drive1.rc})`);
  check(queueStatus(sd, runId) === "held", `B HELD OK: entry is held at the gate (got ${queueStatus(sd, runId)})`);
  check(!drive1.err.includes("GATE AUTO-ANSWERED"), `B QUIET OK: no GATE AUTO-ANSWERED line on a held drive`);
  const events1 = journalEvents(sd, runId);
  const g1 = gateEvents(events1);
  check(g1.held !== undefined, `B JOURNAL OK: a gate-held event exists for the run`);
  check(g1.dispatched === undefined, `B JOURNAL OK: no trap-dispatched event for the gate — it never dispatched`);
  check(getResult(sd, runId) === null, `B RESULT OK: no result while held`);
  const dg = cli(["deliver-gate", runId, '{"answer":"approve"}', "--state-dir", sd]);
  check(dg.rc === 0, `B DELIVER OK: deliver-gate exited 0 (got ${dg.rc})`);
  const drive2 = cli(["queue", "run", "--gates", "hold", "--state-dir", sd]);
  check(drive2.rc === 0, `B DRIVE2 OK: queue run exited 0 after delivery (got ${drive2.rc})`);
  const res = getResult(sd, runId);
  check(res?.status === "done" && (res.output as any)?.done === true, `B RESULT OK: run completed after the human answer (got ${JSON.stringify(res)?.slice(0, 120)})`);
  check(!drive2.err.includes("GATE AUTO-ANSWERED"), `B QUIET OK: no GATE AUTO-ANSWERED line on the delivered drive`);
  const events2 = journalEvents(sd, runId);
  const g2 = gateEvents(events2);
  check(g2.dispatched?.result?.value?.answer === "approve", `B ANSWER OK: the delivered answer is "approve" (got ${JSON.stringify(g2.dispatched?.result?.value)})`);
  check(g2.dispatched?.auto !== true, `B UNMARKED OK: the human answer carries no auto marking (got auto=${g2.dispatched?.auto})`);
  check(g2.result?.auto !== true, `B UNMARKED OK: the human trap-result carries no auto marking (got auto=${g2.result?.auto})`);
}

// ---------------------------------------------------------------- C. a queued answer is deliberate, not auto
{
  const sd = stateDirFor("queued");
  const adapter = new MockAdapter({ gates: "auto" });
  const host = new Host({ stateDir: sd, adapter });
  const runId = "bra119-queued";
  adapter.queueGateAnswer({ answer: "approve" });
  host.submit(WORKFLOW, { runId });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "done" && (res.output as any)?.done === true, `C RESULT OK: run completed on the queued answer (got ${res.status})`);
  const events = journalEvents(sd, runId);
  const { dispatched, result } = gateEvents(events);
  check(dispatched?.result?.value?.answer === "approve", `C ANSWER OK: the queued answer is "approve" (got ${JSON.stringify(dispatched?.result?.value)})`);
  check(dispatched?.auto !== true, `C UNMARKED OK: the queued answer carries no auto marking (got auto=${dispatched?.auto})`);
  check(result?.auto !== true, `C UNMARKED OK: the queued trap-result carries no auto marking (got auto=${result?.auto})`);
}

// ---------------------------------------------------------------- verdict
if (FAILURES.length) {
  console.log(`\nFAIL bra119 gate auto-answer loud + marked (${FAILURES.length} failures)`);
  process.exit(1);
}
console.log(`\nPASS bra119 gate auto-answer loud + marked (auto-answer logs GATE AUTO-ANSWERED and marks trap-dispatched/trap-result auto:true; --gates hold holds until deliver-gate; queued answers unmarked)`);
