#!/usr/bin/env bun
/**
 * Plan-driven-work template tests (BRA-117).
 *
 * Runs workflows/library/plan-driven-work.ts under the Host with the
 * direct adapter (real worker processes, real exec, held gates,
 * local decision model) and the mock adapter (mirrored plan workers,
 * canned decide via decideLocal). The proof run is the BRA-110 plan
 * (tests/fixtures/plan-driven-work/bra110-plan-input.json): the plan
 * is drafted, reviewed (JudgeFixLoop, 2 loops, converged), held at
 * the human gate, approved, and its opening phases execute for real
 * — the production phases are deferred (executeThrough), not
 * executed; the production deliver proof itself is the next item
 * (BRA-110), not this test. The frozen-vs-executed check
 * reconstructs the approved plan and the executed phase inputs from
 * the journal and compares them: the executed plan is byte-identical
 * to the approved one.
 *
 * Fixtures live in tests/fixtures/plan-driven-work/ (bra110-plan-input.json,
 * mock-plan-input.json, stubborn-plan-input.json). Run outputs go to
 * $BRA117_WORKDIR (scratch, set by run.sh). Exit 0 on PASS, 1 on any
 * mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Host } from "../src/host";
import { decideLocal } from "../src/decision-model";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const WORKFLOW = path.join(ROOT, "workflows", "library", "plan-driven-work.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plan-driven-work");
const WORKDIR = process.env.BRA117_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra117-"));

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

/** Order-insensitive deep equality for JSON values (the journaled
 * phase and the approved plan's phase may list keys in different
 * orders — the comparison is on content, not serialization). */
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

/** A trap result as the journal carries it: trap-dispatched /
 * trap-result events wrap the value in `{ value }`. */
function unwrapResult(e: any): unknown {
  const r = e?.result;
  if (r !== null && typeof r === "object" && !Array.isArray(r) && "value" in r) return r.value;
  return r;
}

/** All events for a run: the parent journal plus every fork-child
 * journal (wave execution traps are dispatched by the `all()`
 * branch thunks, so their trap events live in the child journals,
 * not the parent's — same pattern as test-bra109's allEvents).
 * Run-trap children (phase reviews) are NOT fork children; their
 * results arrive on the parent's run trap-dispatched events. */
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

/** The approved plan, reconstructed from the parent journal: the
 * last plan-shaped trap result (the fix job's result when the loop
 * revised, else the draft). Plan-shaped = an object with a phases
 * array and a request string. */
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

function loadInput(name: string, outDir: string): any {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  return JSON.parse(raw.replaceAll("__OUTDIR__", outDir));
}

/** Seed a scratch outbox with three delivery records (the BRA-110
 * plan's survey phase lists them for real). */
function seedOutbox(outDir: string): void {
  fs.mkdirSync(path.join(outDir, "outbox"), { recursive: true });
  for (const n of ["delivery-run-001.json", "delivery-run-002.json", "delivery-run-003.json"]) {
    fs.writeFileSync(path.join(outDir, "outbox", n), JSON.stringify({ run: n }) + "\n");
  }
}

function mockHost(stateDir: string): Host {
  const host = new Host({ stateDir, adapter: new MockAdapter({ gates: "hold" }) });
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  return host;
}

async function testDirectBra110(): Promise<void> {
  console.log("\n=== plan-driven-work direct: BRA-110 plan (gate holds, approve, execute opening phases) ===");
  const outDir = path.join(WORKDIR, "bra110");
  seedOutbox(outDir);
  const stateDir = path.join(WORKDIR, "direct-bra110");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  const input = loadInput("bra110-plan-input.json", outDir);
  const runId = "run-bra110-plan";
  host.submit(WORKFLOW, { runId, input });

  // Drive to the gate: the run must HOLD, not complete.
  await host.runQueue();
  let q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `GATE OK: run held at the human gate (got ${q?.status ?? "missing"})`);
  check(host.isGateSuspended(runId), "GATE OK: host reports the run suspended at a gate");
  const heldJournal = host.journal(runId);
  const heldCounts = trapCounts(heldJournal);
  check(heldCounts["job:plan-draft"] === 1, `GATE OK: 1 plan-draft trap (got ${heldCounts["job:plan-draft"]})`);
  check(heldCounts["job:aggregate"] === 2, `GATE OK: 2 aggregate traps — plan loop ran 2 loops (got ${heldCounts["job:aggregate"]})`);
  check(heldCounts["job:fix"] === 1, `GATE OK: 1 fix trap — only loop 1 needed fixes (got ${heldCounts["job:fix"]})`);
  check(heldCounts["decide"] === 4, `GATE OK: 4 decide traps — revise + converged per loop (got ${heldCounts["decide"]})`);
  check(heldCounts["gate"] === 1, `GATE OK: 1 gate trap (got ${heldCounts["gate"]})`);
  check((heldCounts["job:judge"] ?? 0) === 0, "GATE OK: no judge traps in the parent journal (they live in the fork children)");
  const heldPlan = approvedPlanFromJournal(heldJournal);
  check(heldPlan !== null, "GATE OK: approved plan reconstructible from the journal");
  if (heldPlan) {
    check(heldPlan.revisions === 1, `GATE OK: plan revised once (got ${heldPlan.revisions})`);
    check(
      Array.isArray(heldPlan.reviewPoints) && heldPlan.reviewPoints.length === 6,
      `GATE OK: fix added 6 review points (got ${heldPlan.reviewPoints?.length})`,
    );
    check(
      heldPlan.gatePlacement === "Human approval at the gate between plan review and phase 1 execution.",
      `GATE OK: fix stated the gate placement (${JSON.stringify(heldPlan.gatePlacement)})`,
    );
    check(heldPlan.phases.length === 6, `GATE OK: plan has 6 phases (got ${heldPlan.phases.length})`);
  }

  // Approve at the gate and drive to completion.
  host.deliverGate(runId, { answer: "approve" });
  await host.runQueue();
  q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "done", `DONE OK: run done after the gate answer (got ${q?.status ?? "missing"})`);
  const res = host.result(runId);
  check(res.status === "done", `DONE OK: result done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
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
  // The evidence is real, not canned: the survey lists the seeded
  // records, the baseline write prints its confirmation, the agent
  // phase's record summarizes the real prior results.
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
  // Real effects on disk.
  check(fs.existsSync(path.join(outDir, "baseline.txt")), "DONE OK: baseline.txt written");
  if (fs.existsSync(path.join(outDir, "baseline.txt"))) {
    const b = fs.readFileSync(path.join(outDir, "baseline.txt"), "utf8");
    check(
      b.includes("delivery-run-001.json") && b.includes("delivery-run-003.json"),
      "DONE OK: baseline.txt carries the outbox listing",
    );
  }
  check(fs.existsSync(path.join(outDir, "delivery-record.txt")), "DONE OK: delivery-record.txt written (commit leg)");
  if (fs.existsSync(path.join(outDir, "delivery-record.txt"))) {
    check(
      fs.readFileSync(path.join(outDir, "delivery-record.txt"), "utf8").includes("3 executed, 3 deferred"),
      "DONE OK: delivery record names the executed/deferred counts",
    );
  }

  // Frozen == executed, proven from the journal: the approved plan
  // (last plan-shaped trap result before the gate) and the executed
  // phase inputs (wave traps in the fork children) are identical,
  // and no trap matches a deferred phase.
  const journal = host.journal(runId);
  const approved = approvedPlanFromJournal(journal);
  check(approved !== null, "FROZEN OK: approved plan reconstructible after completion");
  if (approved) {
    check(deepEqual(approved, out.plan), "FROZEN OK: journaled approved plan equals the result's plan");
    const events = allEvents(host, runId);
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
    // The gate precedes execution in the parent journal: the gate
    // trap event comes before the first run trap and the commit exec.
    const gateIdx = journal.findIndex((e: any) => e.event === "trap" && e.type === "gate");
    const firstRunIdx = journal.findIndex((e: any) => e.event === "trap" && e.type === "run");
    const commitIdx = journal.findIndex(
      (e: any) => e.event === "trap" && e.type === "exec" && JSON.stringify(e.arg?.args ?? []).includes("delivery-record.txt"),
    );
    check(gateIdx >= 0 && firstRunIdx > gateIdx, `FROZEN OK: gate trap precedes the phase reviews (gate ${gateIdx}, first run ${firstRunIdx})`);
    check(gateIdx >= 0 && commitIdx > gateIdx, `FROZEN OK: gate trap precedes the commit (gate ${gateIdx}, commit ${commitIdx})`);
    // The phase reviews ran as child runs with their own journals.
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
  const finalCounts = trapCounts(allEvents(host, runId));
  check(finalCounts["job:judge"] === 6, `DONE OK: 6 judge traps across the plan loop (3 per loop, got ${finalCounts["job:judge"]})`);
  check(finalCounts["job:plan-phase"] === 1, `DONE OK: 1 plan-phase trap (got ${finalCounts["job:plan-phase"]})`);
  check(finalCounts["exec"] === 3, `DONE OK: 3 exec traps — 2 phase commands + commit (got ${finalCounts["exec"]})`);
}

async function testMockAgentOnly(): Promise<void> {
  console.log("\n=== plan-driven-work mock: agent-only plan (mirror alignment) ===");
  const stateDir = path.join(WORKDIR, "mock-agent-only");
  const host = mockHost(stateDir);
  const input = loadInput("mock-plan-input.json", path.join(WORKDIR, "mock-out"));
  const runId = "run-mock-plan";
  host.submit(WORKFLOW, { runId, input });
  await host.runQueue();
  let q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `MOCK OK: run held at the gate (got ${q?.status ?? "missing"})`);
  host.deliverGate(runId, { answer: "approve" });
  await host.runQueue();
  q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "done", `MOCK OK: run done after the gate answer (got ${q?.status ?? "missing"})`);
  const res = host.result(runId);
  check(res.status === "done", `MOCK OK: result done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  check(out.planLoops === 2, `MOCK OK: plan loop converged in 2 loops, same as direct (got ${out.planLoops})`);
  check(out.planConverged === true, `MOCK OK: plan converged (got ${out.planConverged})`);
  check(out.planFinalMeanScore === 0.98, `MOCK OK: plan final mean score 0.98 (got ${out.planFinalMeanScore})`);
  check(
    JSON.stringify(out.executed.map((r: any) => r.phase)) === JSON.stringify(["draft-notes", "summarize-notes"]),
    `MOCK OK: 2 phases executed (got ${JSON.stringify(out.executed.map((r: any) => r.phase))})`,
  );
  check(JSON.stringify(out.deferred) === JSON.stringify(["file-notes"]), `MOCK OK: 1 phase deferred (got ${JSON.stringify(out.deferred)})`);
  check(out.phaseReviews.length === 2, `MOCK OK: 2 phase reviews (got ${out.phaseReviews.length})`);
  // The mock's generic judges are base-score stand-ins (0.55/0.62/
  // 0.48 + 0.15 per revision), not the real worker's containment
  // scoring — so a mock phase review scores 0.55 then 0.70 and hits
  // the 2-loop cap honestly instead of converging. The direct run
  // is the convergence proof; the mock run proves the mirror's plan
  // arc and the review machinery.
  for (const r of out.phaseReviews) {
    check(r.loops === 2 && r.converged === false && r.finalMeanScore === 0.7, `MOCK OK: phase review ${r.phase} hits the cap honestly at 0.70 (got ${JSON.stringify(r)})`);
  }
  check(out.committed === false, `MOCK OK: no commit step configured (got committed=${out.committed})`);
}

async function testDirectStubborn(): Promise<void> {
  console.log("\n=== plan-driven-work direct: stubborn plan (unfixable criteria hit the cap honestly) ===");
  const outDir = path.join(WORKDIR, "stubborn");
  seedOutbox(outDir);
  const stateDir = path.join(WORKDIR, "direct-stubborn");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  const input = loadInput("stubborn-plan-input.json", outDir);
  const runId = "run-stubborn-plan";
  host.submit(WORKFLOW, { runId, input });
  await host.runQueue();
  const q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `STUBBORN OK: run held at the gate (got ${q?.status ?? "missing"})`);
  const journal = host.journal(runId);
  const counts = trapCounts(journal);
  check(counts["job:aggregate"] === 3, `STUBBORN OK: 3 aggregate traps — 3 loops (got ${counts["job:aggregate"]})`);
  check(counts["job:fix"] === 3, `STUBBORN OK: 3 fix traps — every loop revised (got ${counts["job:fix"]})`);
  check(counts["job:rubric-update"] === 1, `STUBBORN OK: 1 rubric-update trap (loop 3, got ${counts["job:rubric-update"]})`);
  check(counts["decide"] === 7, `STUBBORN OK: 7 decide traps — 3 revise + 3 converged + 1 rubric (got ${counts["decide"]})`);
  const lastPlan = approvedPlanFromJournal(journal);
  check(lastPlan !== null, "STUBBORN OK: last plan reconstructible from the journal");
  if (lastPlan) {
    // The fix changed the plan only in loop 1 (review points +
    // gate placement); loops 2–3 ran the fix but it had nothing it
    // knows how to change, so revisions stays 1.
    check(lastPlan.revisions === 1, `STUBBORN OK: plan revised once (loop 1 only, got ${lastPlan.revisions})`);
    check(
      !(lastPlan.text as string).includes("quantum-safe") &&
        !(lastPlan.text as string).includes("zero-trust") &&
        !(lastPlan.text as string).includes("air-gapped"),
      "STUBBORN OK: the fix never addressed the unknown criteria — they stay outstanding",
    );
    check(
      Array.isArray(lastPlan.reviewPoints) && lastPlan.reviewPoints.length === 1 && typeof lastPlan.gatePlacement === "string",
      "STUBBORN OK: the fix still added the review points and gate placement it knows",
    );
  }
}

async function testDirectBadInputs(): Promise<void> {
  console.log("\n=== plan-driven-work direct: invalid inputs fail loudly ===");
  const cases: { name: string; input: any; needle: string; needsGate?: boolean }[] = [
    {
      name: "empty-request",
      input: { request: "  ", phaseOutlines: [{ name: "a", description: "d", acceptance: "x", kind: "agent" }] },
      needle: "request",
    },
    {
      name: "no-acceptance",
      input: {
        request: "Do a thing",
        phaseOutlines: [{ name: "a", description: "d", acceptance: " ", kind: "agent" }],
      },
      needle: "acceptance",
    },
    {
      name: "unknown-dep",
      input: {
        request: "Do a thing",
        phaseOutlines: [
          { name: "a", description: "d", acceptance: "x", kind: "agent", dependsOn: ["nope"] },
        ],
      },
      needle: "depends on",
    },
    {
      name: "cycle-dep",
      input: {
        request: "Do a thing",
        phaseOutlines: [
          { name: "a", description: "d", acceptance: "x", kind: "agent", dependsOn: ["b"] },
          { name: "b", description: "d", acceptance: "x", kind: "agent", dependsOn: ["a"] },
        ],
      },
      needle: "depends on",
    },
    {
      name: "command-no-command",
      input: {
        request: "Do a thing",
        phaseOutlines: [{ name: "a", description: "d", acceptance: "x", kind: "command" }],
      },
      needle: "command",
    },
    {
      name: "bad-execute-through",
      input: {
        request: "Do a thing",
        phaseOutlines: [{ name: "a", description: "d", acceptance: "x", kind: "agent" }],
        executeThrough: "nope",
      },
      needle: "executeThrough",
      needsGate: true,
    },
  ];
  for (const c of cases) {
    const host = new Host({ stateDir: path.join(WORKDIR, `direct-bad-${c.name}`), adapter: new DirectAdapter() });
    const runId = `run-bad-${c.name}`;
    host.submit(WORKFLOW, { runId, input: c.input });
    await host.runQueue();
    if ((c as any).needsGate) {
      // The split failure happens after the gate, so the run holds
      // first — approve it, then drive to the failure.
      const q = host.readQueue().find((e) => e.runId === runId);
      check(q?.status === "held", `BAD-${c.name.toUpperCase()} OK: run held at the gate first (got ${q?.status ?? "missing"})`);
      host.deliverGate(runId, { answer: "approve" });
      await host.runQueue();
    }
    const res = host.result(runId);
    check(res.status === "failed", `BAD-${c.name.toUpperCase()} OK: run failed (got ${res.status})`);
    check(
      (res.error ?? "").toLowerCase().includes(c.needle.toLowerCase()),
      `BAD-${c.name.toUpperCase()} OK: error names the problem (${(res.error ?? "").slice(0, 160)})`,
    );
  }
}

async function testDirectFailingPhase(): Promise<void> {
  console.log("\n=== plan-driven-work direct: a failing phase stops the run loudly ===");
  const stateDir = path.join(WORKDIR, "direct-failing-phase");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });
  const input = {
    request: "A plan with a failing command phase",
    phaseOutlines: [
      { name: "always-fails", description: "A command that always fails", acceptance: "command succeeds", kind: "command", command: "false", args: [] },
      { name: "never-runs", description: "A phase after the failure", acceptance: "runs", kind: "agent", dependsOn: ["always-fails"] },
    ],
    executeThrough: "never-runs",
  };
  const runId = "run-failing-phase";
  host.submit(WORKFLOW, { runId, input });
  await host.runQueue();
  let q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `FAIL-PHASE OK: run held at the gate first (got ${q?.status ?? "missing"})`);
  host.deliverGate(runId, { answer: "approve" });
  await host.runQueue();
  const res = host.result(runId);
  check(res.status === "failed", `FAIL-PHASE OK: run failed (got ${res.status})`);
  check(
    (res.error ?? "").includes("always-fails") && (res.error ?? "").includes("later waves did not execute"),
    `FAIL-PHASE OK: error names the failed phase and the stopped waves (${(res.error ?? "").slice(0, 200)})`,
  );
  const events = allEvents(host, runId);
  const neverRan = events.filter(
    (e: any) => e.event === "trap" && e.type === "job" && e.arg?.spec === "plan-phase" && e.arg?.input?.phase?.name === "never-runs",
  );
  check(neverRan.length === 0, `FAIL-PHASE OK: the later phase never executed (got ${neverRan.length} traps)`);
}

async function main(): Promise<number> {
  await testDirectBra110();
  await testMockAgentOnly();
  await testDirectStubborn();
  await testDirectBadInputs();
  await testDirectFailingPhase();
  console.log();
  if (FAILURES.length) {
    console.log(`FAIL (${FAILURES.length} check(s)):`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log(
    "PASS plan-driven-work (direct BRA-110 plan: gate held + approved + 3 executed / 3 deferred + frozen==executed from the journal + real files; mock agent-only plan runs the same plan arc, phase reviews hit the cap on the mock's base-score judges; stubborn plan hits the 3-loop cap honestly; invalid inputs + failing phase fail loudly)",
  );
  return 0;
}

process.exit(await main());
