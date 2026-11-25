#!/usr/bin/env bun
/**
 * Direct handler tests for the driver endpoints (Linear BRA-153).
 *
 * The driver HTTP endpoints have e2e coverage (test-bra116.ts) but no
 * unit-level handler tests — this is the unit layer: the six handler
 * methods on WorkerServer are called directly, in-process, no HTTP,
 * no mocks of the handlers themselves.
 *
 *   A. queueList / deliveries on a fresh state, driveQueue on an
 *      empty queue, the workers-config arg (valid config 200, invalid
 *      config 500 — proving the child actually loads it), and the
 *      500 when the child cannot write its repair report.
 *   B. deliverResult validation: missing / non-string / empty runId
 *      400, unknown run 404.
 *   C. Runs end to end at the handler: a throwing run (failed),
 *      driveQueue reporting failed true, deliverResult on the failed
 *      run, the non-terminal 400, deliverResult on done runs
 *      (explicit + default deliveredBy, idempotent re-delivery),
 *      queueList / deliveries showing the records.
 *   D. escalate: non-object / array / string body 400, missing kind
 *      400, empty reason 400, missing reason 400, empty kind 400
 *      (the host throws — the handler's own check passes it), valid
 *      minimal + with runId/detail 200 with the record on disk.
 *   E. deliverGate: missing runId / non-string runId / missing
 *      answer 400, unknown run 404, queued run 404, a null answer
 *      present-by-key 404, the held run answered 200 and driven to
 *      done, and a parent suspended at a fork (not a gate) 400.
 *   F. driveQueue lock refusal: a CLI drive in progress makes the
 *      direct call answer 409, and the run completes exactly once.
 *
 * MEASUREMENT (brief step 1, settled here before any test was
 * added): branch-exercise count over the six handlers' decision
 * points — option (b) in the brief, not (a) `bun test --coverage`.
 * (a) does not apply: these tests are standalone scripts run by
 * run.sh, not `bun test` files, so there is no coverage harness to
 * scope; and file-level coverage of the 2,100-line worker-server.ts
 * would drown the six handlers' signal in noise (the handlers are
 * ~200 lines of the file — a percentage on the file says nothing
 * about whether their branches are exercised). (b) is exact and
 * auditable: 20 named decision points, each mapped to the checks
 * that exercise it. BEFORE: 0/20 (no direct handler test existed;
 * the e2e exercises most of these over HTTP, but that is a
 * different layer — the unit layer was 0). AFTER: 20/20.
 *
 * BRANCH MAP (20 decision points -> checks):
 *   driveQueue (5):
 *     DQ-409  child stderr has REFUSED: -> 409           [F2]
 *     DQ-500  no repair report / bad repair -> 500       [A6, A5]
 *     DQ-200-empty  success, failed false                [A3]
 *     DQ-200-failed success, failed true                 [C2]
 *     DQ-workers-config config passed to the child        [A4, A5]
 *   deliverResult (5):
 *     DR-400-noid  runId missing / non-string / empty    [B1, B2, B3]
 *     DR-404  run not exists -> 404                      [B4]
 *     DR-400-nonterminal  recordDelivery throws -> 400   [C4]
 *     DR-200-done  success, done record                  [C6, C7, C8]
 *     DR-200-failed success, failed record               [C3]
 *   queueList (1):
 *     QL-200  200 with entries                            [A1, C9]
 *   deliveries (1):
 *     DL-200  200 with deliveries                         [A2, C10]
 *   escalate (4):
 *     ES-400-body  body not an object -> 400              [D1, D2, D3]
 *     ES-400-kind-reason  kind/reason invalid -> 400      [D4, D5, D6]
 *     ES-400-host  host throws (empty kind) -> 400        [D7]
 *     ES-200  success, record on disk                    [D8, D9]
 *   deliverGate (4):
 *     DG-400  validation (runId / answer) -> 400          [E1, E2, E3]
 *     DG-404  no suspended run -> 404                     [E4, E5, E6]
 *     DG-400-nogate  host throws, no gate pending -> 400  [E15]
 *     DG-200  success, run re-queued                     [E9, E10]
 *
 * What this does NOT prove (stated plainly): nothing is left
 * uncovered among the 20 branches — DG-400-nogate IS covered here,
 * via a parent suspended at a fork (not a gate), which goes beyond
 * test-bra116.ts's stated limitation ("no deterministic workflow
 * produces one"). The fork-suspension case is the deterministic
 * workflow: a parent calling a sleeping child.
 *
 * No production change was needed: WorkerServer is already exported
 * and importable as-is; the six methods are private and are called
 * through a cast in this test, so the diff is the test + inventory
 * + run.sh + CHANGELOG only. No export was added to worker-server.ts.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra153.ts
 *   (run.sh builds the host and sets DURABLETS_HOST; the test also
 *   needs DQUICKTS for the child CLI drives.)
 *
 * Run outputs go to $BRA153_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir under $TMPDIR. The server is never started (no
 * socket) — the handlers are called directly on the in-process
 * instance. Child CLI drivers are killed in a finally block, even
 * on failure. Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import { WorkerServer, serverConfigFromArgs } from "../src/worker-server";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";

const WORKDIR = process.env.BRA153_WORKDIR || fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "bra153-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 0; // never started; the handlers are called directly

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

function cli(args: string[], env: Record<string, string> = {}): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
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
function markerLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  fail(`timeout waiting for: ${what}`);
  return false;
}
function driveChild(): Subprocess {
  return spawn([BUN, path.join(ROOT, "src", "cli.ts"), "queue", "run", "--state-dir", STATE_DIR], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
}
function submitCli(workflow: string, runId: string, inputFile?: string, adapter?: string): void {
  const args = ["run", workflow, "--run-id", runId, "--state-dir", STATE_DIR];
  if (inputFile) args.push("--input-file", inputFile);
  if (adapter) args.push("--adapter", adapter);
  const r = cli(args);
  check(r.rc === 0 && r.out.includes(`RUN ${runId}`), `SUBMIT: ${runId} submitted (rc ${r.rc})`);
}

const children: Subprocess[] = [];

// Fixture workflows, written into the test's scratch dir (not the repo).
const THROW_WF = path.join(WORKDIR, "workflow-bra153-throw.ts");
fs.writeFileSync(
  THROW_WF,
  `export interface ThrowResult { done: boolean; }\n\nexport default function run(): ThrowResult { throw new Error("bra153 boom"); }\n`,
);
const CHILD_SLEEP_WF = path.join(WORKDIR, "workflow-bra153-child-sleep.ts");
fs.writeFileSync(
  CHILD_SLEEP_WF,
  `import { sleep } from "${ROOT}/src/agentts";\n` +
    `export interface ChildInput { ms: number; }\n` +
    `export interface ChildOutput { slept: boolean; sleptMs: number; }\n` +
    `export default function run(input: ChildInput): ChildOutput {\n` +
    `  const r = sleep({ ms: input.ms });\n` +
    `  return { slept: true, sleptMs: r.sleptMs };\n` +
    `}\n`,
);
const PARENT_SLEEP_WF = path.join(WORKDIR, "workflow-bra153-parent-sleep.ts");
fs.writeFileSync(
  PARENT_SLEEP_WF,
  `import { run as runChild } from "${ROOT}/src/agentts";\n` +
    `import type { ChildInput, ChildOutput } from "./workflow-bra153-child-sleep";\n` +
    `export default function run(): ChildOutput {\n` +
    `  const r = runChild<ChildInput, ChildOutput>({ workflow: "./workflow-bra153-child-sleep.ts", input: { ms: 5000 } });\n` +
    `  return r;\n` +
    `}\n`,
);

// The server under test: in-process, never started. serverConfigFromArgs
// is the real construction path; workersConfigPath is forced off here
// so a stray AGENTTS_WORKERS_CONFIG in the environment cannot leak
// into the main server (the workers-config branch has its own server).
const serverConfig = serverConfigFromArgs(["--state-dir", STATE_DIR, "--port", String(PORT)]);
serverConfig.workersConfigPath = undefined;
const server = new WorkerServer(serverConfig);
const h = server as any;

async function sectionA(): Promise<void> {
  console.log("\n=== A. lists, empty drive, workers-config, 500 ===");
  const list0 = await h.queueList();
  check(
    list0.status === 200 && Array.isArray(list0.body?.entries) && list0.body.entries.length === 0,
    `A QUEUE OK: empty queue list 200, entries [] (got ${list0.status})`,
  );
  const dels0 = await h.deliveries();
  check(
    dels0.status === 200 && Array.isArray(dels0.body?.deliveries) && dels0.body.deliveries.length === 0,
    `A DELIVERIES OK: empty deliveries 200, deliveries [] (got ${dels0.status})`,
  );
  const run0 = await h.driveQueue();
  check(
    run0.status === 200 && Array.isArray(run0.body?.entries) && run0.body.entries.length === 0 &&
      run0.body?.repair?.inspected === 0 && run0.body?.failed === false,
    `A DRIVE OK: empty queue drive 200, repair inspected 0, failed false (got ${run0.status})`,
  );

  // Workers-config branch: a valid config is passed to the child and
  // the drive succeeds; an invalid one fails the child loudly (500),
  // proving the child actually loads the config rather than ignoring it.
  const cfgPath = path.join(WORKDIR, "workers.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ "bench-trivial": path.join(ROOT, "bench", "workflows", "bench-trivial.ts") }),
  );
  const serverWc = new WorkerServer(
    serverConfigFromArgs(["--state-dir", STATE_DIR, "--port", "0", "--workers-config", cfgPath]),
  );
  const wc = await (serverWc as any).driveQueue();
  check(
    wc.status === 200 && wc.body?.failed === false,
    `A WORKERS OK: drive with a valid workers-config 200, failed false (got ${wc.status})`,
  );
  const badCfg = path.join(WORKDIR, "bad-workers.json");
  fs.writeFileSync(badCfg, "{ not valid json");
  const serverBad = new WorkerServer(
    serverConfigFromArgs(["--state-dir", STATE_DIR, "--port", "0", "--workers-config", badCfg]),
  );
  const bad = await (serverBad as any).driveQueue();
  check(
    bad.status === 500 && typeof bad.body?.error === "string" && bad.body.error.includes("queue drive failed") &&
      bad.body.error.includes("not valid JSON"),
    `A WORKERS OK: drive with an invalid workers-config 500 "queue drive failed ... not valid JSON" (got ${bad.status}, ${JSON.stringify(bad.body).slice(0, 140)})`,
  );

  // 500: the child cannot write its repair report (TMPDIR unusable).
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = path.join(WORKDIR, "does-not-exist");
  try {
    const fiveHundred = await h.driveQueue();
    check(
      fiveHundred.status === 500 && typeof fiveHundred.body?.error === "string" &&
        fiveHundred.body.error.includes("queue drive failed") && fiveHundred.body.error.includes("child exit 1"),
      `A DRIVE OK: bad TMPDIR drive 500 "queue drive failed (child exit 1)" (got ${fiveHundred.status}, ${JSON.stringify(fiveHundred.body).slice(0, 140)})`,
    );
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
}

async function sectionB(): Promise<void> {
  console.log("\n=== B. deliverResult validation ===");
  const noId = await h.deliverResult({});
  check(noId.status === 400, `B DELIVER OK: missing runId 400 (got ${noId.status})`);
  const numId = await h.deliverResult({ runId: 123 });
  check(numId.status === 400, `B DELIVER OK: non-string runId 400 (got ${numId.status})`);
  const emptyId = await h.deliverResult({ runId: "" });
  check(emptyId.status === 400, `B DELIVER OK: empty runId 400 (got ${emptyId.status})`);
  const unknown = await h.deliverResult({ runId: "nope" });
  check(
    unknown.status === 404 && typeof unknown.body?.error === "string" && unknown.body.error.includes("no run nope"),
    `B DELIVER OK: unknown run 404 "no run nope" (got ${unknown.status}, ${JSON.stringify(unknown.body).slice(0, 120)})`,
  );
}

async function sectionC(): Promise<void> {
  console.log("\n=== C. runs end to end at the handler ===");
  const host = new Host({ stateDir: STATE_DIR });
  // Throwing run: driven in-process, fails.
  host.submit(THROW_WF, { runId: "bra153-fail" });
  await host.runQueue();
  check(queueStatus("bra153-fail") === "failed", `C FAILRUN OK: throwing run failed (got ${queueStatus("bra153-fail") ?? "missing"})`);
  const driveFailed = await h.driveQueue();
  const failedEntry = (driveFailed.body?.entries ?? []).find((e: any) => e.runId === "bra153-fail");
  check(
    driveFailed.status === 200 && driveFailed.body?.failed === true && failedEntry?.status === "failed",
    `C DRIVE OK: drive with a failed entry 200, failed true (got ${driveFailed.status}, failed ${driveFailed.body?.failed})`,
  );
  const delFail = await h.deliverResult({ runId: "bra153-fail", deliveredBy: "bra153-test" });
  check(
    delFail.status === 200 && delFail.body?.runId === "bra153-fail" && delFail.body?.status === "failed" &&
      delFail.body?.needsAttention === true && typeof delFail.body?.error === "string" &&
      delFail.body.error.includes("bra153 boom") && delFail.body?.deliveredBy === "bra153-test",
    `C DELIVER OK: failed run delivered 200, status failed, needsAttention, deliveredBy bra153-test (got ${delFail.status})`,
  );

  // Non-terminal run: submitted, not driven.
  host.submit(path.join(ROOT, "bench", "workflows", "bench-trivial.ts"), { runId: "bra153-done-a", input: { n: 100 } });
  const delEarly = await h.deliverResult({ runId: "bra153-done-a" });
  check(
    delEarly.status === 400 && typeof delEarly.body?.error === "string" && delEarly.body.error.includes("nothing to deliver yet"),
    `C DELIVER OK: non-terminal run 400 "nothing to deliver yet" (got ${delEarly.status}, ${JSON.stringify(delEarly.body).slice(0, 120)})`,
  );
  await host.runQueue();
  check(queueStatus("bra153-done-a") === "done", `C DRIVE OK: trivial run driven to done (got ${queueStatus("bra153-done-a") ?? "missing"})`);
  const delDone = await h.deliverResult({ runId: "bra153-done-a", deliveredBy: "bra153-test" });
  check(
    delDone.status === 200 && delDone.body?.runId === "bra153-done-a" && delDone.body?.status === "done" &&
      delDone.body?.needsAttention === false && delDone.body?.deliveredBy === "bra153-test" &&
      delDone.body?.output?.n === 4950,
    `C DELIVER OK: done run delivered 200, output n 4950, deliveredBy bra153-test (got ${delDone.status})`,
  );

  // Default deliveredBy + idempotent re-delivery.
  host.submit(path.join(ROOT, "bench", "workflows", "bench-trivial.ts"), { runId: "bra153-done-b", input: { n: 100 } });
  await host.runQueue();
  const delDefault = await h.deliverResult({ runId: "bra153-done-b" });
  check(
    delDefault.status === 200 && delDefault.body?.deliveredBy === "tick-agent",
    `C DELIVER OK: deliveredBy defaults to tick-agent (got ${delDefault.body?.deliveredBy})`,
  );
  const delAgain = await h.deliverResult({ runId: "bra153-done-b" });
  check(
    delAgain.status === 200 && delAgain.body?.runId === "bra153-done-b",
    `C DELIVER OK: re-delivery is idempotent 200, same runId (got ${delAgain.status})`,
  );

  const list = await h.queueList();
  const ids = (list.body?.entries ?? []).map((e: any) => e.runId);
  check(
    list.status === 200 && ids.includes("bra153-fail") && ids.includes("bra153-done-a") && ids.includes("bra153-done-b"),
    `C LIST OK: queue list shows all three runs (got ${list.status}, ${JSON.stringify(ids)})`,
  );
  const dels = await h.deliveries();
  const dids = (dels.body?.deliveries ?? []).map((d: any) => d.runId);
  check(
    dels.status === 200 && dids.includes("bra153-fail") && dids.includes("bra153-done-a") && dids.includes("bra153-done-b"),
    `C DELIVERIES OK: deliveries show all three records (got ${dels.status}, ${JSON.stringify(dids)})`,
  );
}

async function sectionD(): Promise<void> {
  console.log("\n=== D. escalate ===");
  const nullBody = await h.escalate(null);
  check(nullBody.status === 400, `D ESCALATE OK: null body 400 (got ${nullBody.status})`);
  const arrBody = await h.escalate(["other"]);
  check(arrBody.status === 400, `D ESCALATE OK: array body 400 (got ${arrBody.status})`);
  const strBody = await h.escalate("other");
  check(strBody.status === 400, `D ESCALATE OK: string body 400 (got ${strBody.status})`);
  const noKind = await h.escalate({ reason: "x" });
  check(noKind.status === 400, `D ESCALATE OK: missing kind 400 (got ${noKind.status})`);
  const emptyReason = await h.escalate({ kind: "other", reason: "" });
  check(emptyReason.status === 400, `D ESCALATE OK: empty reason 400 (got ${emptyReason.status})`);
  const noReason = await h.escalate({ kind: "other" });
  check(noReason.status === 400, `D ESCALATE OK: missing reason 400 (got ${noReason.status})`);
  // Empty kind passes the handler's own check (typeof string) and the
  // host throws — the catch -> 400 branch.
  const emptyKind = await h.escalate({ kind: "", reason: "x" });
  check(
    emptyKind.status === 400 && typeof emptyKind.body?.error === "string" &&
      emptyKind.body.error.includes("escalation requires a kind"),
    `D ESCALATE OK: empty kind 400 "escalation requires a kind" (got ${emptyKind.status})`,
  );
  const minimal = await h.escalate({ kind: "other", reason: "bra153 minimal" });
  let minimalRec: any = null;
  try {
    minimalRec = JSON.parse(fs.readFileSync(minimal.body?.path ?? "", "utf8"));
  } catch {
    minimalRec = null;
  }
  check(
    minimal.status === 200 && typeof minimal.body?.path === "string" && fs.existsSync(minimal.body.path) &&
      minimalRec?.kind === "other" && minimalRec?.reason === "bra153 minimal",
    `D ESCALATE OK: minimal escalation 200, record on disk (got ${minimal.status})`,
  );
  const full = await h.escalate({ kind: "stuck-running", runId: "bra153-done-a", reason: "bra153 full", detail: { a: 1 } });
  let fullRec: any = null;
  try {
    fullRec = JSON.parse(fs.readFileSync(full.body?.path ?? "", "utf8"));
  } catch {
    fullRec = null;
  }
  check(
    full.status === 200 && fullRec?.kind === "stuck-running" && fullRec?.runId === "bra153-done-a" &&
      fullRec?.reason === "bra153 full" && fullRec?.detail?.a === 1,
    `D ESCALATE OK: escalation with runId+detail 200, record carries them (got ${full.status})`,
  );
}

async function sectionE(): Promise<void> {
  console.log("\n=== E. deliverGate ===");
  const noId = await h.deliverGate({ answer: { answer: "yes" } });
  check(noId.status === 400, `E GATE OK: missing runId 400 (got ${noId.status})`);
  const numId = await h.deliverGate({ runId: 7, answer: { answer: "yes" } });
  check(numId.status === 400, `E GATE OK: non-string runId 400 (got ${numId.status})`);
  const noAnswer = await h.deliverGate({ runId: "nope" });
  check(noAnswer.status === 400, `E GATE OK: missing answer 400 (got ${noAnswer.status})`);
  const unknown = await h.deliverGate({ runId: "nope", answer: { answer: "yes" } });
  check(
    unknown.status === 404 && typeof unknown.body?.error === "string" && unknown.body.error.includes("no suspended run nope"),
    `E GATE OK: unknown run 404 "no suspended run" (got ${unknown.status})`,
  );
  // Queued (submitted, never driven) run: not in the registry -> 404.
  const host = new Host({ stateDir: STATE_DIR });
  host.submit(path.join(ROOT, "bench", "workflows", "bench-trivial.ts"), { runId: "bra153-gate-queued", input: { n: 100 } });
  const queued = await h.deliverGate({ runId: "bra153-gate-queued", answer: { answer: "yes" } });
  check(
    queued.status === 404 && typeof queued.body?.error === "string" && queued.body.error.includes("no suspended run"),
    `E GATE OK: queued run 404 "no suspended run" (got ${queued.status})`,
  );
  // A null answer IS present (checked by key, not truthiness), so the
  // validation passes and the 404 fires for the unregistered run.
  const nullAnswer = await h.deliverGate({ runId: "bra153-gate-queued", answer: null });
  check(
    nullAnswer.status === 404,
    `E GATE OK: null answer present-by-key, still 404 for the unregistered run (got ${nullAnswer.status})`,
  );
  await host.runQueue();
  check(queueStatus("bra153-gate-queued") === "done", `E CLEANUP OK: queued run driven to done (got ${queueStatus("bra153-gate-queued") ?? "missing"})`);

  // Held run: answered through the handler, re-queued, driven to done.
  const gateHost = new Host({ stateDir: STATE_DIR, adapter: new MockAdapter({ gates: "hold" }) });
  const gateRunId = "bra153-gate";
  gateHost.submit(path.join(ROOT, "tests", "workflows", "workflow-gate-hold.ts"), { runId: gateRunId });
  await gateHost.runQueue();
  check(queueStatus(gateRunId) === "held", `E HOLD OK: run is held at its gate (got ${queueStatus(gateRunId) ?? "missing"})`);
  const answered = await h.deliverGate({ runId: gateRunId, answer: { answer: "yes" } });
  check(
    answered.status === 200 && answered.body?.ok === true && answered.body?.runId === gateRunId,
    `E GATE OK: held run answered 200 (got ${answered.status})`,
  );
  check(queueStatus(gateRunId) === "queued", `E GATE OK: run re-queued after the answer (got ${queueStatus(gateRunId) ?? "missing"})`);
  const driveGate = await h.driveQueue();
  check(
    driveGate.status === 200 && queueStatus(gateRunId) === "done",
    `E DRIVE OK: run completed after the gate answer (got ${queueStatus(gateRunId) ?? "missing"})`,
  );

  // No gate pending: a parent suspended at a fork (not a gate).
  // The parent calls a child that sleeps 5s; while the child sleeps
  // the parent is suspended at the "run" trap (rc 2, last journal
  // trap type "run"), so isGateSuspended is false and the host throws.
  // Wait for the suspension AND the registry entry: the journal trap
  // event lands ~80ms before the parent's registry entry is saved
  // (measured: the entry file appears one or two polls after the
  // trap event), so polling the journal alone can catch the window
  // where the run is suspended but not yet registered.
  const parentRunId = "bra153-fork";
  submitCli(PARENT_SLEEP_WF, parentRunId);
  const forkChild = driveChild();
  children.push(forkChild);
  const suspended = await waitFor(
    () => {
      const probe = new Host({ stateDir: STATE_DIR });
      const events = probe.journal(parentRunId);
      let lastTrap: any = null;
      let resolvedAfter = false;
      for (const e of events) {
        if ((e as any).event === "trap") {
          lastTrap = e;
          resolvedAfter = false;
        } else if ((e as any).event === "trap-result" || (e as any).event === "trap-error") {
          resolvedAfter = true;
        }
      }
      const atFork = lastTrap !== null && (lastTrap as any).type === "run" && !resolvedAfter;
      return atFork && probe.registryHas(parentRunId);
    },
    10_000,
    `${parentRunId} suspended at the fork and registered`,
  );
  check(suspended, `E FORK OK: parent suspended at the fork (child sleeping)`);
  if (suspended) {
    const probe = new Host({ stateDir: STATE_DIR });
    check(probe.isGateSuspended(parentRunId) === false, `E FORK OK: parent is not gate-suspended`);
    check(probe.registryHas(parentRunId) === true, `E FORK OK: parent is in the registry`);
    const noGate = await h.deliverGate({ runId: parentRunId, answer: { answer: "yes" } });
    check(
      noGate.status === 400 && typeof noGate.body?.error === "string" && noGate.body.error.includes("no gate pending"),
      `E GATE OK: fork-suspended parent 400 "no gate pending" (got ${noGate.status}, ${JSON.stringify(noGate.body).slice(0, 120)})`,
    );
  }
  await forkChild.exited;
  // The run's outcome is the queue status, not the child's exit
  // code: `queue run` exits 1 whenever ANY queue entry is failed
  // (cli.ts: the failed throwing run from section C is still
  // failed), so the child exits 1 on a clean drive here too.
  check(
    queueStatus(parentRunId) === "done",
    `E FORK OK: parent completed after the child slept (got ${queueStatus(parentRunId) ?? "missing"})`,
  );
}

async function sectionF(): Promise<void> {
  console.log("\n=== F. driveQueue lock refusal ===");
  const runId = "bra153-lock";
  const marker = path.join(WORKDIR, "bra153-lock.marker");
  const inputFile = path.join(WORKDIR, `${runId}.input.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ markerFile: marker, sleepMs: 5000 }));
  submitCli(path.join(ROOT, "tests", "workflows", "workflow-bra72-exec.ts"), runId, inputFile, "direct");
  const child = driveChild();
  children.push(child);
  const held = await waitFor(
    () =>
      fs.existsSync(path.join(STATE_DIR, "driver.lock", "holder.json")) &&
      queueStatus(runId) === "running" &&
      markerLines(marker) >= 1,
    10_000,
    "CLI driver holding the lock with entry running and exec dispatched",
  );
  check(held, `F LOCK OK: CLI driver holds the lock, ${runId} running, exec dispatched`);
  const refused = await h.driveQueue();
  check(
    refused.status === 409 && typeof refused.body?.error === "string" && refused.body.error.includes("driver already running"),
    `F REFUSE OK: direct driveQueue answered 409 "driver already running" (got ${refused.status}, ${JSON.stringify(refused.body).slice(0, 160)})`,
  );
  await child.exited;
  // Same exit-code rule as section E: the child exits 1 because
  // the throwing run from section C is still failed — the run's
  // outcome is the queue status.
  check(
    queueStatus(runId) === "done",
    `F DONE OK: CLI driver finished, ${runId} done (child exit ${child.exitCode})`,
  );
  check(markerLines(marker) === 1, `F DONE OK: marker has 1 line — the exec ran once, not twice`);
  const quiescent = await h.driveQueue();
  // `failed` is "any queue entry failed" (worker-server.ts), and
  // section C's throwing run is still failed — so a quiescent drive
  // still reports failed true. The drive itself is healthy: 200.
  check(
    quiescent.status === 200 && quiescent.body?.failed === true &&
      (quiescent.body?.entries ?? []).find((e: any) => e.runId === runId)?.status === "done",
    `F QUIET OK: final drive 200, failed true (the throwing run is still failed), ${runId} done (got ${quiescent.status})`,
  );
}

try {
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  await sectionF();
} finally {
  for (const c of children) {
    try {
      c.kill(9);
    } catch { /* already dead */ }
  }
}

if (FAILURES.length) {
  console.log(`\nFAIL bra153 direct-handler suite (${FAILURES.length} failure(s))`);
  process.exit(1);
}
console.log("\nPASS bra153 direct-handler suite (queueList/deliveries, empty + failed + locked + 500 drives, workers-config, deliverResult validation + done/failed/idempotent, escalate validation + host throw, deliverGate validation + held + fork-suspended 400)");
