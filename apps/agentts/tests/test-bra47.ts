#!/usr/bin/env bun
/**
 * Decision shape + decisionCascade (Linear BRA-47).
 *
 * The cascade runs one DecisionSpec through the tiers cheap to
 * expensive (exec -> decide -> job -> gate), same inputs at every
 * tier, stopping at the first tier at or above its threshold, and
 * escalating on low confidence, abstention, or error. The returned
 * Decision carries the deciding tier + the full attempt history.
 *
 * The whole cascade is driven through the Host with a MockAdapter:
 * each scenario queues a canned mock answer per tier (queueAnswer),
 * so the escalation path is the mock answers, not the workflow.
 * The journal is asserted too — every attempt is a trap + trap-result
 * event, so the escalation path is visible audit evidence.
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-bra47.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the bra73 suite.)
 *
 * Scenarios:
 *   S1. exec answers at/above threshold -> stops (decide/job/gate
 *       never run).
 *   S2. exec abstains (unparseable stdout) -> decide answers -> stops
 *       (job/gate never run).
 *   S3. decide below threshold -> job answers at/above threshold ->
 *       stops (gate never runs); exec tier skipped (no exec command).
 *   S4. all tiers below threshold / error -> gate answers with
 *       confidence 1.0 (terminal); full attempt history asserted
 *       exactly (S5: the deciding tier + every attempt, with result
 *       or escalation reason).
 *   S6. per-tier thresholds honored: confidence 0.75 is below the
 *       exec threshold (0.8) but at/above the decide threshold
 *       (0.7) — the same number decides at one tier and escalates
 *       at another.
 *   S7. exec trap throws -> error attempt -> decide answers -> stops.
 *   S8. a spec with no threshold for an enabled tier fails LOUDLY
 *       before any trap fires (no trap events in the journal).
 *   S9. job returns a choice outside the options -> abstention ->
 *       gate answers.
 *   S10. unconfigured job tier under mock: the mock's default
 *       decision answer (first option at 0.5) is below threshold,
 *       so the cascade escalates to the gate.
 *
 * Run outputs go to $BRA47_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
 *
 * What this does NOT prove (stated plainly): the real "decision"
 * jobspec under a live worker (the mock answers the job tier, and
 * the jobspec prose is only exercised by a real agent); the direct
 * adapter's decide path (decideLocal) — the mock answers decide,
 * so the local model's fallback-0.5 escalation is covered only by
 * the below-threshold scenarios with a queued 0.5, not by the model
 * itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { Host } from "../src/host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "tests", "workflows", "workflow-bra47-cascade.ts");

const WORKDIR = process.env.BRA47_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra47-"));
const STATE_DIR = path.join(WORKDIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

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

function readJournal(runId: string): any[] {
  const p = path.join(STATE_DIR, "journals", `${runId}.journal`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function trapTypes(events: any[]): string[] {
  return events.filter((e) => e.event === "trap").map((e) => e.type);
}

async function runScenario(
  runId: string,
  spec: Record<string, unknown>,
  queues: Record<string, unknown>,
): Promise<{ res: any; events: any[] }> {
  const adapter = new MockAdapter();
  for (const [type, answer] of Object.entries(queues)) adapter.queueAnswer(type, answer);
  const host = new Host({ stateDir: STATE_DIR, adapter });
  host.submit(WORKFLOW, { runId, input: spec });
  await host.runQueue();
  return { res: host.result(runId), events: readJournal(runId) };
}

const QUESTION = "Should we converge or keep revising?";
const OPTIONS = ["a", "b"];
const THRESHOLDS = { exec: 0.8, decide: 0.7, job: 0.8 };
const EXEC_CMD = { cmd: "echo", args: ["decision"] };

// ------------------------------------------------------------ S1: exec decides
async function testExecDecides(): Promise<void> {
  console.log("\n=== S1. exec answers at/above threshold -> stops ===");
  const { res, events } = await runScenario(
    "run-bra47-s1",
    { question: QUESTION, options: OPTIONS, exec: EXEC_CMD, thresholds: THRESHOLDS },
    { exec: { value: { stdout: '{"choice":"a","confidence":0.95}', exitCode: 0 } } },
  );
  check(res.status === "done", `S1 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "a" && d?.confidence === 0.95 && d?.tier === "exec", `S1 OK: decision is a/0.95/exec (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "decided", choice: "a", confidence: 0.95, reason: "confidence 0.95 at or above exec threshold 0.8" },
      ]),
    `S1 OK: attempt history is exactly the exec decision (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["exec"]),
    `S1 OK: only the exec trap ran (got ${JSON.stringify(trapTypes(events))}) — decide/job/gate never ran`,
  );
}

// ------------------------------------------------- S2: exec abstains -> decide
async function testExecAbstains(): Promise<void> {
  console.log("\n=== S2. exec abstains (unparseable stdout) -> decide answers ===");
  const { res, events } = await runScenario(
    "run-bra47-s2",
    { question: QUESTION, options: OPTIONS, exec: EXEC_CMD, thresholds: THRESHOLDS },
    {
      exec: { value: { stdout: "not json at all", exitCode: 0 } },
      decide: { value: { choice: "b", confidence: 0.9 } },
    },
  );
  check(res.status === "done", `S2 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "b" && d?.confidence === 0.9 && d?.tier === "decide", `S2 OK: decision is b/0.9/decide (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "abstained", reason: "exec stdout did not parse as JSON {choice, confidence} (stdout: not json at all)" },
        { tier: "decide", status: "decided", choice: "b", confidence: 0.9, reason: "confidence 0.9 at or above decide threshold 0.7" },
      ]),
    `S2 OK: attempt history is exec-abstained + decide-decided (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["exec", "decide"]),
    `S2 OK: exec + decide ran, job/gate never ran (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------- S3: decide below -> job decides
async function testDecideBelowJobDecides(): Promise<void> {
  console.log("\n=== S3. decide below threshold -> job answers -> stops ===");
  const { res, events } = await runScenario(
    "run-bra47-s3",
    { question: QUESTION, options: OPTIONS, thresholds: THRESHOLDS },
    {
      decide: { value: { choice: "a", confidence: 0.6 } },
      job: { value: { choice: "b", confidence: 0.85, reason: "evidence favors b" } },
    },
  );
  check(res.status === "done", `S3 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "b" && d?.confidence === 0.85 && d?.tier === "job", `S3 OK: decision is b/0.85/job (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "skipped", reason: "no exec command in spec — the exec tier is skipped, not attempted" },
        { tier: "decide", status: "below-threshold", choice: "a", confidence: 0.6, reason: "confidence 0.6 below decide threshold 0.7" },
        { tier: "job", status: "decided", choice: "b", confidence: 0.85, reason: "confidence 0.85 at or above job threshold 0.8" },
      ]),
    `S3 OK: attempt history is exec-skipped + decide-below + job-decided (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["decide", "job"]),
    `S3 OK: decide + job ran, gate never ran (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------- S4/S5: all tiers -> gate, history
async function testAllToGate(): Promise<void> {
  console.log("\n=== S4/S5. all tiers below/error -> gate answers 1.0; full history ===");
  const { res, events } = await runScenario(
    "run-bra47-s4",
    { question: QUESTION, options: OPTIONS, exec: EXEC_CMD, thresholds: THRESHOLDS },
    {
      exec: { value: { stdout: "", exitCode: 1, stderr: "boom" } },
      decide: { value: { choice: "a", confidence: 0.5 } },
      job: { value: { choice: "a", confidence: 0.6, reason: "weak evidence" } },
      gate: { value: { answer: "b" } },
    },
  );
  check(res.status === "done", `S4 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "b" && d?.confidence === 1.0 && d?.tier === "gate", `S4 OK: decision is b/1.0/gate — human answer authoritative and terminal (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "error", reason: "exec exited 1: boom" },
        { tier: "decide", status: "below-threshold", choice: "a", confidence: 0.5, reason: "confidence 0.5 below decide threshold 0.7" },
        { tier: "job", status: "below-threshold", choice: "a", confidence: 0.6, reason: "confidence 0.6 below job threshold 0.8" },
        { tier: "gate", status: "decided", choice: "b", confidence: 1, reason: "confidence 1 at or above gate threshold 1" },
      ]),
    `S5 OK: attempt history is the full escalation path, every tier with its result or reason (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["exec", "decide", "job", "gate"]),
    `S4 OK: all four tiers ran, in order (got ${JSON.stringify(trapTypes(events))})`,
  );
  const results = events.filter((e) => e.event === "trap-result");
  check(results.length === 4, `S4 OK: 4 trap-result events — every attempt is journaled (got ${results.length})`);
  // trap-result events carry trapId, not type: join them to the trap
  // events and check the order matches the escalation path.
  const traps = events.filter((e) => e.event === "trap");
  check(
    results.map((r) => r.trapId).join(",") === traps.map((t) => t.trapId).join(","),
    `S4 OK: trap-results arrive in trap order (exec/decide/job/gate) — the escalation path is the journal (got ${results.map((r) => r.trapId).join(",")})`,
  );
}

// ------------------------------------------- S6: per-tier thresholds honored
async function testPerTierThresholds(): Promise<void> {
  console.log("\n=== S6. same confidence 0.75: below exec 0.8, at/above decide 0.7 ===");
  const { res, events } = await runScenario(
    "run-bra47-s6",
    { question: QUESTION, options: OPTIONS, exec: EXEC_CMD, thresholds: THRESHOLDS },
    {
      exec: { value: { stdout: '{"choice":"a","confidence":0.75}', exitCode: 0 } },
      decide: { value: { choice: "b", confidence: 0.75 } },
    },
  );
  check(res.status === "done", `S6 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "b" && d?.confidence === 0.75 && d?.tier === "decide", `S6 OK: 0.75 decides at decide (threshold 0.7) after escalating past exec (threshold 0.8) (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "below-threshold", choice: "a", confidence: 0.75, reason: "confidence 0.75 below exec threshold 0.8" },
        { tier: "decide", status: "decided", choice: "b", confidence: 0.75, reason: "confidence 0.75 at or above decide threshold 0.7" },
      ]),
    `S6 OK: attempt history shows the same confidence escalating at one tier and deciding at the next (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["exec", "decide"]),
    `S6 OK: exec + decide ran, job/gate never ran (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------- S7: exec trap throws -> decide
async function testExecThrows(): Promise<void> {
  console.log("\n=== S7. exec trap throws -> error attempt -> decide answers ===");
  const { res, events } = await runScenario(
    "run-bra47-s7",
    { question: QUESTION, options: OPTIONS, exec: EXEC_CMD, thresholds: THRESHOLDS },
    {
      exec: { throw: { name: "Error", message: "command not found" } },
      decide: { value: { choice: "a", confidence: 0.9 } },
    },
  );
  check(res.status === "done", `S7 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "a" && d?.confidence === 0.9 && d?.tier === "decide", `S7 OK: decision is a/0.9/decide (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "error", reason: "exec trap threw: command not found" },
        { tier: "decide", status: "decided", choice: "a", confidence: 0.9, reason: "confidence 0.9 at or above decide threshold 0.7" },
      ]),
    `S7 OK: attempt history is exec-error + decide-decided (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["exec", "decide"]),
    `S7 OK: exec + decide ran (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------- S8: missing threshold fails loud
async function testMissingThresholdFailsLoud(): Promise<void> {
  console.log("\n=== S8. spec with no threshold for an enabled tier fails before any trap ===");
  const { res, events } = await runScenario(
    "run-bra47-s8",
    { question: QUESTION, options: OPTIONS },
    {},
  );
  check(res.status === "failed", `S8 OK: run failed (got ${res.status})`);
  check(
    typeof res.error === "string" && res.error.includes("no threshold for the decide tier"),
    `S8 OK: failure names the missing decide threshold (got ${JSON.stringify(res.error)})`,
  );
  check(
    trapTypes(events).length === 0,
    `S8 OK: no trap fired — the spec error is loud before any tier runs (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------- S9: job choice outside options
async function testJobChoiceOutsideOptions(): Promise<void> {
  console.log("\n=== S9. job returns a choice outside the options -> abstention -> gate ===");
  const { res, events } = await runScenario(
    "run-bra47-s9",
    { question: QUESTION, options: OPTIONS, thresholds: THRESHOLDS },
    {
      decide: { value: { choice: "a", confidence: 0.5 } },
      job: { value: { choice: "c", confidence: 0.99, reason: "c is best" } },
      gate: { value: { answer: "a" } },
    },
  );
  check(res.status === "done", `S9 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "a" && d?.confidence === 1.0 && d?.tier === "gate", `S9 OK: decision is a/1.0/gate (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "skipped", reason: "no exec command in spec — the exec tier is skipped, not attempted" },
        { tier: "decide", status: "below-threshold", choice: "a", confidence: 0.5, reason: "confidence 0.5 below decide threshold 0.7" },
        { tier: "job", status: "abstained", reason: 'job returned choice "c" which is not one of the options ["a","b"]' },
        { tier: "gate", status: "decided", choice: "a", confidence: 1, reason: "confidence 1 at or above gate threshold 1" },
      ]),
    `S9 OK: attempt history is exec-skipped + decide-below + job-abstained + gate-decided (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["decide", "job", "gate"]),
    `S9 OK: decide + job + gate ran (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------- S10: mock default job answer
async function testMockDefaultJob(): Promise<void> {
  console.log("\n=== S10. unconfigured job tier under mock: default first-option 0.5 escalates ===");
  const { res, events } = await runScenario(
    "run-bra47-s10",
    { question: QUESTION, options: OPTIONS, thresholds: THRESHOLDS },
    {
      decide: { value: { choice: "a", confidence: 0.5 } },
      gate: { value: { answer: "b" } },
    },
  );
  check(res.status === "done", `S10 OK: run done (got ${res.status} ${res.error ?? ""})`);
  const d = res.output;
  check(d?.choice === "b" && d?.confidence === 1.0 && d?.tier === "gate", `S10 OK: decision is b/1.0/gate (got ${JSON.stringify(d)})`);
  check(
    JSON.stringify(d?.attempts) ===
      JSON.stringify([
        { tier: "exec", status: "skipped", reason: "no exec command in spec — the exec tier is skipped, not attempted" },
        { tier: "decide", status: "below-threshold", choice: "a", confidence: 0.5, reason: "confidence 0.5 below decide threshold 0.7" },
        { tier: "job", status: "below-threshold", choice: "a", confidence: 0.5, reason: "confidence 0.5 below job threshold 0.8" },
        { tier: "gate", status: "decided", choice: "b", confidence: 1, reason: "confidence 1 at or above gate threshold 1" },
      ]),
    `S10 OK: mock default job answer (first option, 0.5) is a below-threshold attempt, not a decision (got ${JSON.stringify(d?.attempts)})`,
  );
  check(
    JSON.stringify(trapTypes(events)) === JSON.stringify(["decide", "job", "gate"]),
    `S10 OK: decide + job + gate ran (got ${JSON.stringify(trapTypes(events))})`,
  );
}

// ------------------------------------------------------------ main
async function main(): Promise<number> {
  console.log(`BRA-47 tests — workdir ${WORKDIR}`);
  if (!process.env.DURABLETS_HOST) {
    console.log("FAIL: DURABLETS_HOST is not set — run via ./run.sh (it builds the C host and sets it)");
    return 1;
  }
  await testExecDecides();
  await testExecAbstains();
  await testDecideBelowJobDecides();
  await testAllToGate();
  await testPerTierThresholds();
  await testExecThrows();
  await testMissingThresholdFailsLoud();
  await testJobChoiceOutsideOptions();
  await testMockDefaultJob();
  if (FAILURES.length) {
    console.log(`\nFAIL bra47 suite: ${FAILURES.length} failure(s)`);
    return 1;
  }
  console.log("\nPASS bra47 decision cascade (exec decides, exec-abstain to decide, decide-below to job, all-to-gate with full history, per-tier thresholds, exec-throw escalates, missing threshold fails loud, job-abstain on out-of-options choice, mock default job escalates)");
  return 0;
}

process.exit(await main());
