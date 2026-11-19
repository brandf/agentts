#!/usr/bin/env bun
/**
 * Phase-review root-cause diagnosis (Linear BRA-126).
 *
 * When a phase review fails to converge, the template must diagnose
 * the root-cause level itself — work, workflow, rubric, possibly
 * several at once — record the diagnosis with a reason and a fix
 * routing per level, and carry it into the plan-driven-work result.
 * The diagnosis is a deterministic classification of the recorded
 * review data (workflows/library/diagnosis.ts): work is the default
 * (a failing review means the work did not satisfy the acceptance),
 * workflow fires when the evidence shares no content word with the
 * acceptance (wrong subject), rubric fires when the acceptance
 * criterion as written cannot be checked (empty, single-word, or
 * stopword-first).
 *
 * Runs workflows/library/phase-review.ts directly under the Host
 * with the direct adapter (real worker processes; decide traps are
 * answered by the direct adapter's decideLocal) and the full
 * plan-driven-work template under the mock adapter (whose phase
 * reviews hit the loop cap honestly at 0.70 — the mock's base-score
 * stand-ins — so every mock phase review carries a diagnosis).
 * Run outputs go to $BRA126_WORKDIR (scratch, set by run.sh) or a
 * fresh mkdtemp dir. Exit 0 on PASS, 1 on any mismatch.
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
const PHASE_REVIEW = path.join(ROOT, "workflows", "library", "phase-review.ts");
const TEMPLATE = path.join(ROOT, "workflows", "library", "plan-driven-work.ts");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "plan-driven-work");
const WORKDIR = process.env.BRA126_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra126-"));

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

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Run phase-review.ts once under the direct adapter and return
 * its output (or null when the run did not complete). */
async function reviewOnce(
  host: Host,
  runId: string,
  phase: string,
  evidence: string,
  acceptance: string,
): Promise<any | null> {
  host.submit(PHASE_REVIEW, {
    runId,
    input: { phase, evidence, acceptance, threshold: 0.8, maxLoops: 2 },
  });
  await host.runQueue();
  const q = host.readQueue().find((e) => e.runId === runId);
  if (q?.status !== "done") {
    fail(`RUN FAIL: phase review ${runId} status ${q?.status ?? "missing"} (expected done)`);
    return null;
  }
  const res = host.result(runId);
  if (res.status !== "done") {
    fail(`RUN FAIL: phase review ${runId} result ${res.status}${res.error ? ` — ${res.error}` : ""}`);
    return null;
  }
  return res.output;
}

/** A diagnosis is well-formed: levels non-empty, reasons and fix
 * routing parallel to levels, work always named on failure. */
function checkDiagnosis(out: any, label: string): void {
  const d = out?.diagnosis;
  check(d !== null && typeof d === "object", `${label} OK: diagnosis recorded (got ${JSON.stringify(d)})`);
  if (!d || typeof d !== "object") return;
  check(Array.isArray(d.levels) && d.levels.length >= 1, `${label} OK: at least one level named (got ${JSON.stringify(d.levels)})`);
  check(
    Array.isArray(d.reasons) && d.reasons.length === d.levels.length,
    `${label} OK: one reason per level (got ${d.reasons?.length} reasons for ${d.levels?.length} levels)`,
  );
  check(
    Array.isArray(d.fixRouting) && d.fixRouting.length === d.levels.length,
    `${label} OK: one fix routing per level (got ${d.fixRouting?.length} routings for ${d.levels?.length} levels)`,
  );
  check(d.levels.includes("work"), `${label} OK: work named (got ${JSON.stringify(d.levels)})`);
  for (const r of d.reasons ?? []) {
    check(typeof r === "string" && r.length > 0, `${label} OK: reason is a non-empty string (${JSON.stringify(r)})`);
  }
  for (const f of d.fixRouting ?? []) {
    check(typeof f === "string" && f.length > 0, `${label} OK: fix routing is a non-empty string (${JSON.stringify(f)})`);
  }
}

async function testDirect(): Promise<void> {
  console.log("\n=== phase-review diagnosis direct: failing reviews are diagnosed, passing ones are not ===");
  const stateDir = path.join(WORKDIR, "direct");
  const host = new Host({ stateDir, adapter: new DirectAdapter() });

  // 1. Work only: on-subject, substantial evidence that misses the
  // acceptance's key term ("survey" never appears) — the work fell
  // short, the evidence is about the right subject, the criterion
  // is well-formed.
  const workOnly = await reviewOnce(
    host,
    "bra126-work-only",
    "survey",
    "the delivery records were listed in the outbox",
    "survey lists all delivery records",
  );
  if (workOnly) {
    check(workOnly.converged === false, `WORK OK: review did not converge (got converged=${workOnly.converged})`);
    check(workOnly.loops === 2, `WORK OK: hit the 2-loop cap (got ${workOnly.loops})`);
    checkDiagnosis(workOnly, "WORK");
    check(
      same(workOnly.diagnosis.levels, ["work"]),
      `WORK OK: work only (got ${JSON.stringify(workOnly.diagnosis.levels)})`,
    );
    check(
      (workOnly.diagnosis.reasons[0] ?? "").includes('"survey"'),
      `WORK OK: reason cites the missing key term (${JSON.stringify(workOnly.diagnosis.reasons[0])})`,
    );
  }

  // 2. Work + workflow: substantial evidence about a different
  // subject (no content word shared with the acceptance) — the
  // step produced the wrong evidence, and the work still did not
  // satisfy the acceptance.
  const workFlow = await reviewOnce(
    host,
    "bra126-work-workflow",
    "survey",
    "the baseline was written to the outbox and the commit succeeded with a clean tree",
    "survey lists all delivery records",
  );
  if (workFlow) {
    check(workFlow.converged === false, `WORKFLOW OK: review did not converge (got converged=${workFlow.converged})`);
    checkDiagnosis(workFlow, "WORKFLOW");
    check(
      same(workFlow.diagnosis.levels, ["work", "workflow"]),
      `WORKFLOW OK: work + workflow (got ${JSON.stringify(workFlow.diagnosis.levels)})`,
    );
    check(
      (workFlow.diagnosis.reasons[1] ?? "").includes("different subject"),
      `WORKFLOW OK: workflow reason names the wrong subject (${JSON.stringify(workFlow.diagnosis.reasons[1])})`,
    );
  }

  // 3. All three at once (the BRA-111 trial shape): almost no
  // evidence, about the wrong subject, against a single-word
  // criterion — diagnosed as all three, not as a single-level
  // work failure.
  const allThree = await reviewOnce(host, "bra126-all-three", "survey", "done", "survey");
  if (allThree) {
    check(allThree.converged === false, `THREE OK: review did not converge (got converged=${allThree.converged})`);
    checkDiagnosis(allThree, "THREE");
    check(
      same(allThree.diagnosis.levels, ["work", "workflow", "rubric"]),
      `THREE OK: all three levels named (got ${JSON.stringify(allThree.diagnosis.levels)})`,
    );
    check(
      (allThree.diagnosis.reasons[0] ?? "").includes("almost no evidence"),
      `THREE OK: work reason cites thin evidence (${JSON.stringify(allThree.diagnosis.reasons[0])})`,
    );
    check(
      (allThree.diagnosis.reasons[2] ?? "").includes("single word"),
      `THREE OK: rubric reason cites the single-word criterion (${JSON.stringify(allThree.diagnosis.reasons[2])})`,
    );
  }

  // 4. Converged: the evidence names what the acceptance asks for —
  // no failure, no diagnosis.
  const passing = await reviewOnce(
    host,
    "bra126-passing",
    "survey",
    "the survey lists all delivery records from the outbox",
    "survey lists all delivery records",
  );
  if (passing) {
    check(passing.converged === true, `PASS OK: review converged (got converged=${passing.converged})`);
    check(
      passing.diagnosis === null,
      `PASS OK: no diagnosis on a converged review (got ${JSON.stringify(passing.diagnosis)})`,
    );
  }
}

async function testMockTemplateFlow(): Promise<void> {
  console.log("\n=== plan-driven-work mock: phase-review diagnoses flow into the template result ===");
  const stateDir = path.join(WORKDIR, "mock-template");
  const host = new Host({ stateDir, adapter: new MockAdapter({ gates: "hold" }) });
  host.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  const input = JSON.parse(fs.readFileSync(path.join(FIXTURES, "mock-plan-input.json"), "utf8"));
  const runId = "bra126-mock-template";
  host.submit(TEMPLATE, { runId, input });
  await host.runQueue();
  let q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "held", `MOCK OK: run held at the human gate (got ${q?.status ?? "missing"})`);
  host.deliverGate(runId, { answer: "approve" });
  await host.runQueue();
  q = host.readQueue().find((e) => e.runId === runId);
  check(q?.status === "done", `MOCK OK: run done after the gate answer (got ${q?.status ?? "missing"})`);
  const res = host.result(runId);
  check(res.status === "done", `MOCK OK: result done (got ${res.status}${res.error ? ` — ${res.error}` : ""})`);
  if (res.status !== "done") return;
  const out = res.output;
  // The mock's phase reviews hit the cap honestly at 0.70, so every
  // executed phase carries a diagnosis in its summary.
  check(out.phaseReviews.length === 2, `MOCK OK: 2 phase reviews (got ${out.phaseReviews.length})`);
  for (const r of out.phaseReviews) {
    check(r.converged === false, `MOCK OK: phase review ${r.phase} hit the cap (got converged=${r.converged})`);
    checkDiagnosis(r, `MOCK ${r.phase}`);
    check(
      same(r.diagnosis.levels, ["work"]),
      `MOCK OK: phase review ${r.phase} diagnosed as work (got ${JSON.stringify(r.diagnosis.levels)})`,
    );
  }
}

await testDirect();
await testMockTemplateFlow();

if (FAILURES.length) {
  console.log(`\nFAIL: ${FAILURES.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nPASS bra126 phase-review diagnosis (failing reviews diagnosed at work / workflow / rubric, three-level failures named as such, diagnoses carried into the template result)`);
