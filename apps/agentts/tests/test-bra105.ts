#!/usr/bin/env bun
/**
 * Sub-workflows as child runs (Linear BRA-105): `run<Input, Output>({ workflow, input })`
 * calls a sub-workflow by file path, and the sub-workflow's result IS the trap result.
 *
 *   S1. Value through the trap: a pure child returns its result; the
 *       parent gets it as the trap result. The parent journal carries
 *       a "run-child" event naming the child runId (<trapId>/child);
 *       the child journal shows lifecycle completed.
 *   S2. Child suspends (sleep) and resumes: the child sleeps 50ms
 *       (virtual clock, instant) and the parent receives the result.
 *   S3. Child throws: the failure surfaces loudly at the call site —
 *       the child's error name and message are preserved, the parent
 *       catches it and completes (not failed), and the child journal
 *       records lifecycle failed. No silent drop.
 *   S4. Nested run/call: a child that itself calls a grandchild; the
 *       parent receives the grandchild's result two levels down.
 *   S5. Cancellation propagates down the tree (BRA-40): a gate-held
 *       child is cancelled before its parent (cancelTree returns
 *       [child, parent]); the parent catches CancellationError.
 *   S6. Freeze pinning: the child file is part of the parent's frozen
 *       closure at submit — editing the child after submit does not
 *       change what executes (the original still runs).
 *   S7. Loud refusal: a missing child file, and a non-literal workflow
 *       path, are both refused at submit (extractor), never at runtime.
 *   S8. Fresh-process resume: a gate-held child survives a new Host
 *       over the same stateDir — the parent stays held (not failed),
 *       the child's gate is dispatched exactly once across drives, and
 *       delivering the gate answer to the CHILD re-queues the parent
 *       transitively so the run completes.
 *
 *   BRA105_WORKDIR=<dir> bun tests/test-bra105.ts
 *   (run.sh sets BRA105_WORKDIR and runs this after the bra90 suite.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const TESTS = path.join(ROOT, "tests", "workflows");
const WORKDIR = process.env.BRA105_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra105-"));
fs.mkdirSync(WORKDIR, { recursive: true });

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

function stateDirFor(name: string): string {
  const d = path.join(WORKDIR, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function runToCompletion(host: Host, workflow: string, runId: string): Promise<any> {
  host.submit(workflow, { runId });
  await host.runQueue();
  return host.result(runId);
}

function gateTrapCount(host: Host, runId: string): number {
  return host.journal(runId).filter((e) => e.event === "trap" && e.type === "gate").length;
}

function trapCount(host: Host, runId: string, type: string): number {
  return host.journal(runId).filter((e) => e.event === "trap" && e.type === type).length;
}

async function main(): Promise<void> {
  // S1: value through the trap.
  {
    const sd = stateDirFor("s1");
    const host = new Host({ stateDir: sd });
    const res = await runToCompletion(host, path.join(TESTS, "workflow-bra105-parent.ts"), "run-bra105-value");
    check(res.status === "done", `BRA105 S1 OK: parent done (got ${res.status}: ${res.error ?? ""})`);
    check(
      res.output?.doubled === 42 && res.output?.label === "n=21",
      `BRA105 S1 OK: child result is the trap result (got ${JSON.stringify(res.output)})`,
    );
    const childRunId = "run-bra105-value/trap-0/child";
    const runChild = host.journal("run-bra105-value").find((e) => e.event === "run-child");
    check(
      runChild?.childRunId === childRunId && runChild?.workflow === "./workflow-bra105-child.ts",
      `BRA105 S1 OK: parent journal has the run-child event (childRunId ${runChild?.childRunId ?? "(none)"})`,
    );
    check(
      host.journal(childRunId).some((e) => e.event === "lifecycle" && e.lifecycle === "completed"),
      `BRA105 S1 OK: child journal shows lifecycle completed (own journal, own runId)`,
    );
    check(
      host.output("run-bra105-value").includes('"doubled":42'),
      `BRA105 S1 OK: parent output carries the child result`,
    );
  }

  // S2: child suspends (sleep) and resumes.
  {
    const sd = stateDirFor("s2");
    const host = new Host({ stateDir: sd });
    const res = await runToCompletion(host, path.join(TESTS, "workflow-bra105-parent-sleep.ts"), "run-bra105-sleep");
    check(res.status === "done", `BRA105 S2 OK: parent done (got ${res.status}: ${res.error ?? ""})`);
    check(
      res.output?.slept === true && res.output?.sleptMs === 50,
      `BRA105 S2 OK: sleeping child resumed and returned (got ${JSON.stringify(res.output)})`,
    );
  }

  // S3: child throws — loud, catchable, no silent drop.
  {
    const sd = stateDirFor("s3");
    const host = new Host({ stateDir: sd });
    const res = await runToCompletion(host, path.join(TESTS, "workflow-bra105-parent-throw.ts"), "run-bra105-throw");
    check(res.status === "done", `BRA105 S3 OK: parent done, not failed — it caught the child error (got ${res.status})`);
    check(res.output?.caught === "Error", `BRA105 S3 OK: parent caught the child error by name (got ${JSON.stringify(res.output)})`);
    const out = host.output("run-bra105-throw");
    check(out.includes("caught: Error:"), `BRA105 S3 OK: parent output names the caught error`);
    check(out.includes("boom from child"), `BRA105 S3 OK: the child's message surfaces at the call site`);
    check(
      out.includes("child run run-bra105-throw/trap-0/child"),
      `BRA105 S3 OK: the message carries the child runId for context`,
    );
    const childEvents = host.journal("run-bra105-throw/trap-0/child");
    const failed = childEvents.find((e) => e.event === "lifecycle" && e.lifecycle === "failed");
    check(
      typeof failed?.error === "string" && failed.error.includes("boom from child"),
      `BRA105 S3 OK: child journal records lifecycle failed with the error (no silent drop)`,
    );
  }

  // S4: nested run/call, two levels.
  {
    const sd = stateDirFor("s4");
    const host = new Host({ stateDir: sd });
    const res = await runToCompletion(host, path.join(TESTS, "workflow-bra105-parent-nested.ts"), "run-bra105-nested");
    check(res.status === "done", `BRA105 S4 OK: parent done (got ${res.status}: ${res.error ?? ""})`);
    check(
      res.output?.deep === "grandchild:hello",
      `BRA105 S4 OK: grandchild result arrives two levels down (got ${JSON.stringify(res.output)})`,
    );
    const middleEvents = host.journal("run-bra105-nested/trap-0/child");
    const grandchild = middleEvents.find((e) => e.event === "run-child");
    check(
      grandchild?.childRunId === "run-bra105-nested/trap-0/child/trap-0/child",
      `BRA105 S4 OK: the middle child's journal names the grandchild (got ${grandchild?.childRunId ?? "(none)"})`,
    );
    check(
      host
        .journal("run-bra105-nested/trap-0/child/trap-0/child")
        .some((e) => e.event === "lifecycle" && e.lifecycle === "completed"),
      `BRA105 S4 OK: grandchild journal shows lifecycle completed`,
    );
  }

  // S5: cancellation propagates down the tree (BRA-40).
  {
    const sd = stateDirFor("s5");
    const host = new Host({ stateDir: sd, adapter: new MockAdapter({ gates: "hold" }) });
    const runId = "run-bra105-cancel";
    const childRunId = `${runId}/trap-0/child`;
    let rc = await host.startRun(path.join(TESTS, "workflow-bra105-parent-gate.ts"), runId);
    check(rc === 2, `BRA105 S5 OK: parent suspended at the run trap (rc ${rc})`);
    // startRun runs the first slice only — the run trap is still
    // undispatched. One drive step dispatches it, which starts the
    // child inline and holds the parent at the run trap while the
    // child sits at its gate.
    rc = host.driveStep(runId);
    check(rc === 2, `BRA105 S5 OK: after one drive step the parent is still suspended (rc ${rc})`);
    check(host.runRc(childRunId) === 2, `BRA105 S5 OK: child suspended at its gate (rc ${host.runRc(childRunId)})`);
    const cancelled = host.cancelTree(runId, "user abort", "user abort");
    check(
      JSON.stringify(cancelled) === JSON.stringify([childRunId, runId]),
      `BRA105 S5 OK: child cancelled before parent (got ${JSON.stringify(cancelled)})`,
    );
    const lines = host.output(runId).split("\n");
    check(
      lines.some((l) => l.startsWith("caught: CancellationError:")),
      `BRA105 S5 OK: parent caught CancellationError at the run call site`,
    );
    check(lines.some((l) => l.includes("user abort")), `BRA105 S5 OK: the cancel reason reaches the parent`);
    check(!lines.some((l) => l.startsWith("parent got:")), `BRA105 S5 OK: the run trap never returned a value after cancel`);
  }

  // S6: freeze pinning — edit the child after submit, original still executes.
  {
    const sd = stateDirFor("s6");
    const srcDir = path.join(sd, "freeze-src");
    fs.mkdirSync(srcDir, { recursive: true });
    const agenttsRel = path
      .relative(srcDir, path.join(ROOT, "src", "agentts"))
      .replace(/\\/g, "/");
    const agenttsSpec = agenttsRel.startsWith(".") ? agenttsRel : `./${agenttsRel}`;
    const childPath = path.join(srcDir, "freeze-child.ts");
    const childV1 = `export interface FreezeChildInput { n: number; }\nexport interface FreezeChildOutput { v: number; }\nexport default function run(input: FreezeChildInput): FreezeChildOutput {\n  return { v: input.n };\n}\n`;
    const childV2 = childV1.replace("return { v: input.n };", "return { v: input.n + 100 };");
    fs.writeFileSync(childPath, childV1);
    const parentSrc = `import { run as runChild } from "${agenttsSpec}";\nimport type { FreezeChildInput, FreezeChildOutput } from "./freeze-child";\ndeclare function print(...args: unknown[]): void;\nexport default function run(): FreezeChildOutput {\n  const r = runChild<FreezeChildInput, FreezeChildOutput>({ workflow: "./freeze-child.ts", input: { n: 1 } });\n  print("parent got:", JSON.stringify(r));\n  return r;\n}\n`;
    const parentPath = path.join(srcDir, "freeze-parent.ts");
    fs.writeFileSync(parentPath, parentSrc);
    const host = new Host({ stateDir: sd });
    host.submit(parentPath, { runId: "run-bra105-freeze" });
    // Edit the child AFTER submit: the frozen closure must win.
    fs.writeFileSync(childPath, childV2);
    await host.runQueue();
    const res = host.result("run-bra105-freeze");
    check(res.status === "done", `BRA105 S6 OK: parent done (got ${res.status}: ${res.error ?? ""})`);
    check(
      res.output?.v === 1,
      `BRA105 S6 OK: the ORIGINAL child executed (v=1), not the post-submit edit (v=101) — got ${JSON.stringify(res.output)}`,
    );
    const queue = JSON.parse(fs.readFileSync(path.join(sd, "queue.json"), "utf8")) as Array<{ runId: string; frozenHash?: string }>;
    const entry = queue.find((e) => e.runId === "run-bra105-freeze");
    const frozenDir = entry?.frozenHash ? path.join(sd, "frozen", entry.frozenHash) : "";
    const frozenChild = frozenDir
      ? (function walk(d: string): string[] {
          return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(d, e.name);
            return e.isDirectory() ? walk(p) : [p];
          });
        })(frozenDir).find((f) => f.endsWith("freeze-child.ts"))
      : undefined;
    check(
      frozenChild !== undefined && fs.readFileSync(frozenChild, "utf8") === childV1,
      `BRA105 S6 OK: the frozen closure holds the original child source byte-identical`,
    );
  }

  // S7: loud refusal at submit — missing child, non-literal path.
  {
    const sd = stateDirFor("s7");
    const host = new Host({ stateDir: sd });
    let missing: unknown = null;
    try {
      host.submit(path.join(TESTS, "workflow-bra105-parent-missing.ts"), { runId: "run-bra105-missing" });
    } catch (e) {
      missing = e;
    }
    check(
      missing instanceof Error && missing.message.includes("workflow-bra105-nope.ts") && missing.message.includes("does not exist"),
      `BRA105 S7 OK: missing child refused at submit (got: ${missing instanceof Error ? missing.message.slice(0, 160) : String(missing)})`,
    );
    let nonliteral: unknown = null;
    try {
      host.submit(path.join(TESTS, "workflow-bra105-parent-nonliteral.ts"), { runId: "run-bra105-nonliteral" });
    } catch (e) {
      nonliteral = e;
    }
    check(
      nonliteral instanceof Error && nonliteral.message.includes("must be a string literal"),
      `BRA105 S7 OK: non-literal path refused at submit (got: ${nonliteral instanceof Error ? nonliteral.message.slice(0, 160) : String(nonliteral)})`,
    );
  }

  // S8: fresh-process resume of a gate-held child.
  {
    const sd = stateDirFor("s8");
    const runId = "run-bra105-fresh";
    const childRunId = `${runId}/trap-0/child`;
    const hostA = new Host({ stateDir: sd, adapter: new MockAdapter({ gates: "hold" }) });
    hostA.submit(path.join(TESTS, "workflow-bra105-parent-gate.ts"), { runId });
    await hostA.runQueue();
    const heldA = hostA.result(runId);
    check(heldA.status === "held", `BRA105 S8 OK: parent held, not failed, while the child is gate-held (got ${heldA.status}: ${heldA.error ?? ""})`);
    check(hostA.isGatePending(childRunId), `BRA105 S8 OK: the child's gate is pending`);
    check(gateTrapCount(hostA, childRunId) === 1, `BRA105 S8 OK: child gate dispatched exactly once (first drive)`);
    // Fresh process, same state dir: re-drive without an answer — still
    // held, no re-dispatch, no failure.
    const hostB = new Host({ stateDir: sd, adapter: new MockAdapter({ gates: "hold" }) });
    await hostB.runQueue();
    const heldB = hostB.result(runId);
    check(heldB.status === "held", `BRA105 S8 OK: fresh process still sees the parent held (got ${heldB.status})`);
    check(gateTrapCount(hostB, childRunId) === 1, `BRA105 S8 OK: still exactly one child gate dispatch after the fresh drive`);
    // Deliver the gate answer to the CHILD: the parent re-queues
    // transitively and the run completes with the child's value.
    hostB.deliverGate(childRunId, { answer: "yes" });
    await hostB.runQueue();
    const res = hostB.result(runId);
    check(res.status === "done", `BRA105 S8 OK: parent done after the gate answer (got ${res.status}: ${res.error ?? ""})`);
    check(res.output?.approved === "yes", `BRA105 S8 OK: child answer flows through the trap (got ${JSON.stringify(res.output)})`);
    check(gateTrapCount(hostB, childRunId) === 1, `BRA105 S8 OK: still exactly one child gate dispatch after completion (no double-execution)`);
    check(trapCount(hostB, runId, "run") === 1, `BRA105 S8 OK: the run trap itself was dispatched exactly once across drives`);
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA105 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("BRA105 PASS: run/call child runs — value, sleep-resume, loud throw, nesting, cancellation, freeze pinning, loud refusal, fresh-process gate resume");
  process.exit(0);
}

await main();
