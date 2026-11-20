// plan-driven-work — the plan-driven work template (BRA-117).
//
// Brandon's 6-step loop (plan, review, execute, review, commit,
// push) as a reusable AgentTS workflow: a caller supplies a request
// + phase outlines and gets plan -> gate -> execution -> review.
//
// Shape (settled):
//   1. Plan = a `job` trap (spec `plan-draft`): validates the phase
//      outlines, sequences them (dependsOn, defaulting to a serial
//      chain), renders the plan text. The v0 worker does the
//      structural draft; a real drafting agent (muse adapter,
//      plan-draft jobspec) authors phases from prose.
//   2. Improve plan = `judgeFixLoop` with a plan rubric (default
//      criteria: covers-request, sequenced, jobspec, acceptance,
//      review-points, gate-placement; threshold 0.8). The fix edits
//      the plan structurally (adds review points, gate placement,
//      repairs a broken sequence) — it does not rewrite prose
//      (BRA-44 append-only limitation, stated in the README).
//   3. Gate = a `gate` trap between plan and execution: a human
//      approves, asks for a revision (one more JudgeFixLoop pass,
//      then a second gate, at most 2 rounds), or rejects (the run
//      fails loudly without executing any phase). The approved plan
//      is journaled, and execution rehydrates it from the journal —
//      the executed plan is byte-identical to the approved one, and
//      tests/test-bra117.ts proves it from the journal.
//      BRA-119: this gate only holds when the run is driven by an
//      adapter that holds gates. The direct and muse adapters
//      always hold. Under the mock adapter (the default outside
//      the production state dir) the gate auto-answers "yes" unless
//      the driver passes `--gates hold` on BOTH the submit (`run`)
//      and the drive (`queue run`) — the two commands build
//      separate Hosts, so a flag passed to only one does nothing.
//      A template run whose plan checkpoint is real must be driven
//      with `--gates hold` on both commands, or the gate never
//      holds and the plan executes unreviewed on an auto-"yes"
//      (logged as GATE AUTO-ANSWERED, journal events marked
//      `auto: true`).
//   4. Execute = phases as `job` traps (kind "agent", spec
//      `plan-phase`, with prior phase results as context) or `exec`
//      traps (kind "command"), grouped into dependency waves:
//      phases in a wave run in parallel via `all([...])`, waves run
//      serially. A failed phase stops the run loudly — later waves
//      never execute. The failure throw fails cleanly with the real
//      message (BRA-121 fixed the join slice so an uncaught throw
//      after an all() join journals a lifecycle "failed" event
//      instead of crashing the slice). `executeThrough` bounds the run: phases after
//      it are recorded deferred, never executed (staged execution —
//      the BRA-110 proof runs the plan's opening phases this way).
//   5. Review per phase = `judgeFixLoop` in a CHILD workflow
//      (`./phase-review.ts`, via the `run` trap, BRA-105 form B):
//      the phase's evidence text is judged against its acceptance
//      criterion. It lives in a child run because two JudgeFixLoop
//      instantiations with different item types in ONE workflow
//      would hit the extractor's one-key-one-contract conflict on
//      `job:judge` — the child run carries its own extraction, so
//      the plan loop (Plan) and the phase loop (PhaseEvidence) never
//      share a key. The child workflow is referenced by literal path
//      only; its types are deliberately NOT imported here (importing
//      them would pull its trap sites into this file's extraction).
//   6. Commit/push = `exec` traps, when the input carries a commit
//      command. A non-zero exit fails the run loudly — the work is
//      not reported complete when the commit failed.
//
// Result (PlanDrivenWorkResult): the approved plan, the plan-loop
// outcome, gate rounds, executed + deferred phases, per-phase
// review outcomes, and the commit outcome. The approved plan is in
// the result (the form-A return-value channel) and in the journal.
//
// v1 limits, stated plainly (see workflows/README.md §1.7):
// - The v0 plan-draft worker sequences + validates caller-supplied
//   phase outlines; it does not author phases from prose.
// - The v0 plan-phase worker produces an execution record (validate
//   + content hash + a summary of prior results); real agent
//   execution arrives with worker agents following the plan-phase
//   jobspec.
// - Phases are job/exec traps only — a phase that is itself a
//   sub-workflow is not supported in v1.
// - The commit/push leg is an exec trap the caller supplies; the
//   production deliver half rides on BRA-110.

import { job, exec, gate, run, all, type Outcome } from "../../src/agentts";
import { judgeFixLoop, type JudgeFixLoopResult } from "./judge-fix-loop";
import type { Diagnosis } from "./diagnosis";

declare function print(...args: unknown[]): void;

// ---------------------------------------------------------------- types
/** How a phase executes: "agent" (a worker session, spec
 * `plan-phase`) or "command" (a shell command, `exec` trap). */
export type PhaseKind = "agent" | "command";

/** One phase as the caller outlines it. `dependsOn` names earlier
 * phases; omitted means "the previous phase" (a serial chain);
 * an explicit empty array means "no dependencies" (first wave). */
export interface PhaseOutline {
  name: string;
  description: string;
  acceptance: string;
  kind: PhaseKind;
  command?: string;
  args?: string[];
  cwd?: string;
  dependsOn?: string[];
}

/** One phase as drafted: dependsOn is always filled in. */
export interface PlanPhase {
  name: string;
  description: string;
  acceptance: string;
  kind: PhaseKind;
  command?: string;
  args?: string[];
  cwd?: string;
  dependsOn: string[];
}

/** The plan: the request, the sequenced phases, the review points
 * and gate placement the review loop adds, the rendered text the
 * judges score, and a revision counter the fix bumps when it
 * actually changes something. reviewPoints / gatePlacement start
 * absent — the JudgeFixLoop fix adds them, which is the plan loop's
 * improving arc (a plan that already carries them converges in
 * loop 1). */
export interface Plan {
  request: string;
  context?: string;
  phases: PlanPhase[];
  reviewPoints?: string[];
  gatePlacement?: string;
  text: string;
  revisions: number;
}

/** A plan rubric: criteria as bare strings (the JudgeFixLoop
 * shape), plus the mean-score threshold. */
export interface PlanRubric {
  criteria: string[];
  threshold: number;
}

/** The evidence the phase-review loop judges: the phase's evidence
 * text against its acceptance criterion (the goal). */
export interface PhaseEvidence {
  text: string;
  goal: string;
}

// Job trap contracts (concrete, named types at every call site).
export interface PlanDraftInput {
  request: string;
  context?: string;
  phaseOutlines: PhaseOutline[];
}

export interface PhaseExecutionInput {
  phase: PlanPhase;
  prior: PhaseRecord[];
}

/** One phase's execution record. `status` is "executed" for a
 * phase that ran (job or exec) and "deferred" for a phase past
 * `executeThrough` — deferred phases never reach a trap. */
export interface PhaseRecord {
  phase: string;
  status: "executed" | "deferred";
  ok: boolean;
  evidence: string;
  detail: string;
}

// Child-run contracts (the phase-review workflow, ./phase-review.ts).
export interface PhaseReviewInput {
  phase: string;
  evidence: string;
  acceptance: string;
  threshold?: number;
  maxLoops?: number;
}

export interface PhaseReviewResult {
  phase: string;
  loops: number;
  converged: boolean;
  finalMeanScore: number;
  evidence: string;
  /** Root-cause diagnosis (BRA-126), re-declared here like the
   * rest of the child's result (see the header): null when the
   * review converged, otherwise the levels named with reasons and
   * fix routing. Must stay in sync with phase-review.ts — the run
   * trap validates the child's result against this type. */
  diagnosis: Diagnosis | null;
}

export interface CommitSpec {
  cmd: string;
  args?: string[];
  cwd?: string;
}

export interface PlanDrivenWorkInput {
  request: string;
  context?: string;
  phaseOutlines: PhaseOutline[];
  planRubric?: PlanRubric;
  maxLoops?: number;
  phaseReviewLoops?: number;
  /** Execute phases up to and including this phase name; later
   * phases are recorded deferred. Omitted: execute all phases. */
  executeThrough?: string;
  commit?: CommitSpec;
}

export interface PhaseReviewSummary {
  phase: string;
  loops: number;
  converged: boolean;
  finalMeanScore: number;
  /** The phase review's root-cause diagnosis (BRA-126), carried
   * through from the child run: null when the review converged,
   * otherwise the levels named (work / workflow / rubric) with a
   * reason and a fix routing per level. */
  diagnosis: Diagnosis | null;
}

export interface PlanDrivenWorkResult {
  plan: Plan;
  planLoops: number;
  planConverged: boolean;
  planFinalMeanScore: number;
  gateRounds: number;
  executed: PhaseRecord[];
  deferred: string[];
  phaseReviews: PhaseReviewSummary[];
  committed: boolean;
  commitDetail: string;
}

/** The default plan rubric (decided by the BRA-117 implementer —
 * the issue left the rubric undecided): six criteria the v0
 * workers can genuinely check and fix. "covers-request": the plan
 * text carries the request. "sequenced": the phases form a valid
 * dependency DAG. "jobspec": every phase names how it executes
 * (kind + command for command phases). "acceptance": every phase
 * has a testable acceptance criterion. "review-points": review
 * points are stated. "gate-placement": the gate placement is
 * stated. */
export const DEFAULT_PLAN_RUBRIC: PlanRubric = {
  criteria: ["covers-request", "sequenced", "jobspec", "acceptance", "review-points", "gate-placement"],
  threshold: 0.8,
};

export const MAX_LOOPS = 3;
export const MAX_PHASE_REVIEW_LOOPS = 2;
export const MAX_GATE_ROUNDS = 2;

// ------------------------------------------------------- plan structure
/** Group the executed phases into dependency waves (Kahn's
 * algorithm over dependsOn): phases in a wave may run in parallel,
 * waves run serially. A dependency naming an unknown phase, a
 * self-dependency, or a cycle fails loudly — a plan that cannot be
 * sequenced cannot execute. */
export function planWaves(phases: PlanPhase[]): PlanPhase[][] {
  const byName = new Map<string, PlanPhase>();
  for (const p of phases) {
    if (byName.has(p.name)) {
      throw new Error(`plan-driven-work: duplicate phase name "${p.name}"`);
    }
    byName.set(p.name, p);
  }
  for (const p of phases) {
    for (const dep of p.dependsOn) {
      if (dep === p.name) {
        throw new Error(`plan-driven-work: phase "${p.name}" depends on itself`);
      }
      if (!byName.has(dep)) {
        throw new Error(`plan-driven-work: phase "${p.name}" depends on unknown phase "${dep}"`);
      }
    }
  }
  const remaining = new Map(byName);
  const done = new Set<string>();
  const waves: PlanPhase[][] = [];
  while (remaining.size > 0) {
    const wave: PlanPhase[] = [];
    for (const [name, p] of remaining) {
      if (p.dependsOn.every((d) => done.has(d))) wave.push(p);
    }
    if (wave.length === 0) {
      throw new Error(
        `plan-driven-work: phase dependencies contain a cycle among: ${[...remaining.keys()].join(", ")}`,
      );
    }
    // Keep the plan's phase order inside the wave (stable, readable).
    wave.sort((a, b) => phases.indexOf(a) - phases.indexOf(b));
    for (const p of wave) {
      remaining.delete(p.name);
      done.add(p.name);
    }
    waves.push(wave);
  }
  return waves;
}

/** Split the approved plan into the phases this run executes and
 * the phases it defers, by `executeThrough`. An executed phase may
 * only depend on executed phases — a phase whose dependency is
 * deferred could never run. */
export function splitExecuted(phases: PlanPhase[], executeThrough: string | undefined): {
  executed: PlanPhase[];
  deferred: string[];
} {
  let executed = phases;
  let deferred: string[] = [];
  if (executeThrough !== undefined) {
    const idx = phases.findIndex((p) => p.name === executeThrough);
    if (idx < 0) {
      throw new Error(`plan-driven-work: executeThrough names unknown phase "${executeThrough}"`);
    }
    executed = phases.slice(0, idx + 1);
    deferred = phases.slice(idx + 1).map((p) => p.name);
  }
  const executedNames = new Set(executed.map((p) => p.name));
  for (const p of executed) {
    for (const dep of p.dependsOn) {
      if (!executedNames.has(dep)) {
        throw new Error(
          `plan-driven-work: executed phase "${p.name}" depends on deferred phase "${dep}" — move executeThrough past "${dep}" or reorder the plan`,
        );
      }
    }
  }
  return { executed, deferred };
}

// ------------------------------------------- exec failure reporting (BRA-122)
/** How much of a failed command's output the failure error carries:
 * stdout is reported as a TAIL (the failure reason is usually at
 * the end — a test runner's summary, a script's FAIL line), stderr
 * as a HEAD (as before). Both bounds keep the error readable; the
 * full streams live in the run's journal as the exec trap's
 * dispatched/result events. */
export const EXEC_STDOUT_TAIL_CHARS = 2048;
export const EXEC_STDERR_HEAD_CHARS = 300;

/** The failure line for a non-zero exec: the exit code, the stdout
 * tail, and the stderr head, each labeled so the reader can tell
 * which stream a line came from. A stream that is empty contributes
 * nothing; when BOTH are empty the line keeps the old "(no stderr)"
 * text. A truncated stdout tail is prefixed with "..." so the reader
 * knows there was more above the cut.
 *
 * (BRA-122: the phase error used to carry stderr only, so a command
 * that reported its failure on stdout — the common case — left no
 * trace of why it failed. The error is the failed phase's execution
 * record: the run throws, so no PhaseRecord is returned, and the
 * journal's lifecycle-"failed" event carries this message — the
 * wave-failure aggregation embeds each phase's error verbatim, so
 * the streams reach the run's record through it.) */
export function formatExecFailure(
  label: string,
  r: { stdout?: string; stderr?: string; exitCode: number },
): string {
  const stdoutRaw = (r.stdout ?? "").trim();
  const stdoutTail = stdoutRaw.slice(-EXEC_STDOUT_TAIL_CHARS);
  const stderrHead = (r.stderr ?? "").trim().slice(0, EXEC_STDERR_HEAD_CHARS);
  const parts: string[] = [];
  if (stdoutTail) {
    parts.push(`stdout tail: ${stdoutRaw.length > EXEC_STDOUT_TAIL_CHARS ? "..." : ""}${stdoutTail}`);
  }
  if (stderrHead) parts.push(`stderr: ${stderrHead}`);
  if (parts.length === 0) parts.push("(no stderr)");
  return `${label} exited ${r.exitCode}: ${parts.join(" | ")}`;
}

// ---------------------------------------------------------- phase execute
/** Execute one phase. Command phases run for real through the
 * `exec` trap — a non-zero exit throws at the call site (the wave
 * records it as a failed outcome, and the run stops loudly).
 * Agent phases go through the `plan-phase` job with the results of
 * the already-executed phases as context. */
export function executePhase(phase: PlanPhase, prior: PhaseRecord[]): PhaseRecord {
  if (phase.kind === "command") {
    if (typeof phase.command !== "string" || !phase.command) {
      throw new Error(`plan-driven-work: command phase "${phase.name}" has no command`);
    }
    const r = exec({ cmd: phase.command, args: phase.args ?? [], ...(phase.cwd ? { cwd: phase.cwd } : {}) });
    if (r.exitCode !== 0) {
      throw new Error(`plan-driven-work: ${formatExecFailure(`phase "${phase.name}" command`, r)}`);
    }
    const evidence = (r.stdout ?? "").trim();
    return {
      phase: phase.name,
      status: "executed",
      ok: true,
      evidence,
      detail: `command exit 0, ${evidence.length} chars stdout`,
    };
  }
  return job<PhaseExecutionInput, PhaseRecord>({
    spec: "plan-phase",
    input: { phase, prior },
  });
}

// -------------------------------------------------------- workflow entry
/** The workflow: one JSON-capable input in, one JSON-capable output
 * out. The host generates a driver (global code) that calls this
 * with the input JSON; the C host captures the return value as the
 * run result. */
export default function planDrivenWork(input: PlanDrivenWorkInput): PlanDrivenWorkResult {
  const rubric = input.planRubric ?? DEFAULT_PLAN_RUBRIC;
  const maxLoops = input.maxLoops ?? MAX_LOOPS;
  print(`request: ${input.request.slice(0, 120)}`);

  // 1. Draft the plan.
  const draft = job<PlanDraftInput, Plan>({
    spec: "plan-draft",
    input: {
      request: input.request,
      ...(input.context !== undefined ? { context: input.context } : {}),
      phaseOutlines: input.phaseOutlines,
    },
  });
  print(`plan: ${draft.phases.length} phase(s), revisions ${draft.revisions}`);

  // 2. Improve the plan against the rubric.
  let plan = judgeFixLoop<Plan, PlanRubric>(draft, rubric, maxLoops);
  print(`plan review: ${plan.loops} loop(s), converged ${plan.converged}`);

  // 3. The human gate: approve, revise (one more review pass, then
  // a second gate), or reject (fail loudly, execute nothing).
  // At most MAX_GATE_ROUNDS rounds — a plan that is still not
  // approved after the last round fails loudly instead of looping
  // on the human forever. An answer outside the options is a loud
  // failure, never a silent approval (the mock adapter's auto-yes
  // is not an approval here).
  let approvedPlan = plan.item;
  let gateRounds = 0;
  for (let round = 1; round <= MAX_GATE_ROUNDS; round++) {
    gateRounds = round;
    const ans = gate({
      question:
        `Approve this plan for execution? ${approvedPlan.phases.length} phase(s): ` +
        `${approvedPlan.phases.map((p) => p.name).join(", ")}. ` +
        `Gate: ${approvedPlan.gatePlacement ?? "not stated"}. ` +
        `Review points: ${(approvedPlan.reviewPoints ?? []).join(" ") || "none stated"}.`,
      options: ["approve", "revise", "reject"],
    });
    if (ans.answer === "approve") break;
    if (ans.answer === "reject") {
      throw new Error("plan-driven-work: plan rejected at the human gate — the run ends without executing any phase");
    }
    if (ans.answer !== "revise") {
      throw new Error(
        `plan-driven-work: unexpected gate answer ${JSON.stringify(ans.answer)} — expected approve, revise, or reject`,
      );
    }
    if (round === MAX_GATE_ROUNDS) {
      throw new Error(
        `plan-driven-work: plan not approved after ${MAX_GATE_ROUNDS} gate rounds — the run ends without executing any phase`,
      );
    }
    print(`gate round ${round}: revise requested — reviewing the plan again`);
    plan = judgeFixLoop<Plan, PlanRubric>(approvedPlan, rubric, maxLoops);
    approvedPlan = plan.item;
    print(`plan review (round ${round}): ${plan.loops} loop(s), converged ${plan.converged}`);
  }
  print(`gate: approved after ${gateRounds} round(s)`);

  // 4. Execute the approved plan in dependency waves. The executed
  // plan is the journaled approved plan — execution rehydrates it
  // from the run's own state, so it is byte-identical to what the
  // gate approved (proven from the journal in test-bra117.ts).
  const { executed: executedPhases, deferred } = splitExecuted(approvedPlan.phases, input.executeThrough);
  const waves = planWaves(executedPhases);
  const executed: PhaseRecord[] = [];
  // A failed wave stops the run — the failure is recorded, the loop
  // breaks, and the throw fails the run cleanly with the real
  // message (BRA-121: the join slice now journals a lifecycle
  // "failed" event when the resumed workflow throws, so no
  // sleep(0) is needed to move the throw into a fresh slice).
  let waveFailure: { phase: string; error: string }[] | null = null;
  for (const wave of waves) {
    print(`executing wave: ${wave.map((p) => p.name).join(", ")}`);
    const outcomes: Outcome<PhaseRecord>[] = all(wave.map((p) => () => executePhase(p, [...executed])));
    const failed: { phase: string; error: string }[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o.ok) {
        executed.push(o.value);
      } else {
        const err = o.error;
        failed.push({
          phase: wave[i].name,
          error:
            typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
              ? (err as { message: string }).message
              : String(err),
        });
      }
    }
    if (failed.length > 0) {
      waveFailure = failed;
      break;
    }
  }
  if (waveFailure !== null) {
    throw new Error(
      `plan-driven-work: ${waveFailure.length} phase(s) failed — ${waveFailure.map((f) => `${f.phase}: ${f.error}`).join("; ")} — later waves did not execute`,
    );
  }
  const deferredRecords: PhaseRecord[] = deferred.map((name) => ({
    phase: name,
    status: "deferred",
    ok: true,
    evidence: `deferred — not executed in this run (executeThrough=${input.executeThrough ?? "none"})`,
    detail: "deferred",
  }));

  // 5. Review each executed phase in a child run (phase-review.ts).
  // Deferred phases have no evidence to review. A review that fails
  // to converge carries a root-cause diagnosis (BRA-126: work /
  // workflow / rubric, with a reason and a fix routing per level),
  // recorded in the summary — the template asks the question every
  // time instead of depending on anyone remembering to.
  const phaseReviewLoops = input.phaseReviewLoops ?? MAX_PHASE_REVIEW_LOOPS;
  const phaseReviews: PhaseReviewSummary[] = [];
  for (const rec of executed) {
    const phase = executedPhases.find((p) => p.name === rec.phase);
    if (!phase) throw new Error(`plan-driven-work: executed record for unknown phase "${rec.phase}"`);
    const reviewed = run<PhaseReviewInput, PhaseReviewResult>({
      workflow: "./phase-review.ts",
      input: {
        phase: rec.phase,
        evidence: rec.evidence,
        acceptance: phase.acceptance,
        threshold: 0.8,
        maxLoops: phaseReviewLoops,
      },
    });
    print(`phase review ${rec.phase}: ${reviewed.loops} loop(s), converged ${reviewed.converged}`);
    phaseReviews.push({
      phase: reviewed.phase,
      loops: reviewed.loops,
      converged: reviewed.converged,
      finalMeanScore: reviewed.finalMeanScore,
      diagnosis: reviewed.diagnosis,
    });
  }

  // 6. Commit/push, when the input carries a commit command.
  let committed = false;
  let commitDetail = "no commit step configured";
  if (input.commit) {
    const r = exec({
      cmd: input.commit.cmd,
      args: input.commit.args ?? [],
      ...(input.commit.cwd ? { cwd: input.commit.cwd } : {}),
    });
    if (r.exitCode !== 0) {
      throw new Error(`plan-driven-work: ${formatExecFailure("commit step", r)}`);
    }
    committed = true;
    commitDetail = `commit exit 0, ${(r.stdout ?? "").trim().slice(0, 200)}`;
    print(`commit: ${commitDetail}`);
  }

  return {
    plan: approvedPlan,
    planLoops: plan.loops,
    planConverged: plan.converged,
    planFinalMeanScore: plan.lastAggregate?.meanScore ?? 0,
    gateRounds,
    executed,
    deferred,
    phaseReviews,
    committed,
    commitDetail,
  };
}
