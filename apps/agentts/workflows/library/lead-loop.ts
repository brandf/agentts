// lead-loop — the generic lead-loop skeleton (the entry-point
// workflow every lead boots as its main run).
//
// One generic workflow, configured per lead — not eight bespoke
// loops. The per-role part is data, not code: a dispatch table in
// the run input mapping job kinds to sub-workflows.
//
// The loop is the mechanism by which an owner drives its runs —
// the lead's working day, automated: claim the next piece of their
// job, delegate its steps to the pool, check progress, repeat. It
// is NOT a lead: it holds no judgment — the lead session reads the
// reports and decides. Verdicts from sub-workflows are evidence,
// never acceptance, and the loop never closes an issue, never
// merges code, never decides acceptance.
//
// The loop's steps (exec traps, direct adapter):
//
// 0. Validate the input (pure): project + run fields present,
//    owner present (never assume launcher == owner), jobs an
//    array with unique jobIds, dispatch table an object with a
//    workflow + parallel flag per kind, periodic entries well
//    formed. Any failure refuses the run, writing nothing.
// 1. Per iteration, in order:
//    a. Cancel check (when runId is present): read the run's
//       status from stateDir/queue.json in-shell and refuse,
//       writing nothing, when it is cancelled — check-then-act
//       before advancing any run. The cancelled-status refusal
//       reports cancelChecked true + cancelled true; a check that
//       cannot complete (no queue entry / unparsable queue)
//       refuses with cancelChecked false — the `refused` helper
//       reads the live flag (the triage lesson).
//    b. Progress check (pull-only): one inline-python trap reads
//       queue.json + the liveness file's collected-run record and
//       returns one JSON line of FACTS (never decisions) about
//       the sub-runs this loop submitted (entries with
//       launchedBy == loopId): queue depth, each sub-run's
//       status, and for held runs the pending decide's trap id
//       + question from the run's journal. The brief's
//       "decide step" is a `gate` trap in engine terms: the
//       gate is the holdable human checkpoint (MockAdapter
//       with --gates hold; a `decide` trap is answered locally
//       by decideLocal and never holds). The loop never
//       answers a decide — decide is owner-only; the loop
//       surfaces it and the owning lead answers via
//       deliver-gate.
//    c. Collect: for each done sub-run not yet collected, one
//       exec trap reads its result via `agentts result`
//       (bounded — a result over 48KB is recorded as truncated
//       with a pointer, never pushed through the ~60KB trap
//       cap); the collected report becomes the job's result.
//       A collected report carrying a `fileFirst` field files
//       its items to backlogPath in the same iteration (one
//       BACKLOG.md entry per item, idempotent on re-run); when
//       backlogPath is absent the items are recorded unfiled
//       with the reason named, never dropped silently.
//    d. Claim (pure): the next job in input order whose owner
//       is this loop's owner, whose bucket is ready, and whose
//       kind is not waiting on a sequential sub-run (a
//       parallel=false kind with a submitted-but-uncollected
//       sub-run waits). Jobs for other owners are counted, not
//       listed; owned jobs that cannot be claimed are recorded
//       with the reason named.
//    e. Periodic: entries whose cron is due at this
//       iteration's `now` and not yet run this loop run become
//       synthetic jobs (kind = the workflow name) through the
//       same dispatch + submit path.
//    f. Dispatch: for each work item, call dispatchTasks
//       IN-RUN (import + call) with one task (kind = the job's
//       kind, fields built by the table entry's inputBuilder).
//       Dispatch's switch is the single source of truth for
//       kind → workflow. The loop checks dispatch's resolution
//       against the table entry's declared `workflow` and fails
//       the JOB loudly on a mismatch, so the two can never
//       drift silently — the loop never invokes a workflow from
//       the table directly.
//    g. Submit: the loop submits each routed run through the
//       scheduler — one exec trap invoking the CLI (`agentts
//       run <workflow> --adapter direct --run-id <id>
//       --input-file <routed input> --state-dir <stateDir>
//       --owner <job owner> --launched-by <loopId>`), creating
//       the queue entry the scheduler drives. The submit passes
//       --adapter direct: sub-runs are real work, and the mock
//       adapter's canned exec results would silently fake
//       success (a production submit that forgets --adapter
//       must not fake it — the CLI's own default rule, applied
//       here explicitly because the loop's state dir is a
//       scratch dir in tests). The drive-time clock comes from
//       whoever drives the queue, not the submit. The
//       routed input is extracted from dispatch's handoff file
//       (the scheduler's input, written by dispatch). The
//       submit is idempotent: a runId already in the queue is
//       recorded as already-submitted, never re-submitted.
//       Sub-runs are submitted with launchedBy = loopId (the
//       loop's stable id, not a session) precisely so the
//       progress check can find them across shifts by scanning
//       queue.json; the true provenance rides on the loop run's
//       own launchedBy.
//    h. Parked: when an iteration claims nothing and nothing
//       periodic is due, the loop runs cheap reads (ledger
//       tail, queue depth from the progress check, /health
//       against serverUrl when supplied) instead of
//       idle-spinning, then sleeps `parkSeconds` (default 60)
//       before the next iteration — only when another
//       iteration will follow.
//    i. Liveness: after each iteration's work, the loop writes
//       `<stateDir>/liveness/<loopId>.json` atomically (chunked
//       base64 write + rename + read-back), carrying the
//       heartbeat, last-claim timestamp, last report summary,
//       the submitted-run records, and the collected-run ids.
//       The Director's supervision check reads this file; the
//       queue server's owner/worker last-seen (from the
//       get-job touch path) is the other signal. The file is
//       also the loop's durable cross-shift state: a later
//       loop run seeds its submitted-run map + collected-run
//       set from it at start, so it attributes a sub-run's
//       result to the right job and never re-collects it —
//       and the claim step skips jobs already collected in a
//       prior run, so re-issuing the same jobs list is safe.
//       The file is keyed by loopId, not role: one loop per
//       role, and a replacement loopId for the same role must
//       not inherit (and be blocked by) the dead loop's
//       record. The file grows with every submitted sub-run
//       (one record each); rotation is a follow-up.
// 2. Produce a loop report. The verdict is evidence, NOT
//    acceptance: "completed" means the loop ran its iterations
//    and exited cleanly (maxIterations reached, or the loop
//    ended idle); "dry-run" means the plan is clean and nothing
//    was written; "failed" means the run was refused
//    (validation, cancel, or a guard failure) or every claimed
//    job failed. Per-job failures are recorded per job + in
//    notes; the loop never dies for one bad job.
//
// Decisions settled by the builder (brief's decisions 1–4):
//
// 1. Termination. The loop runs until cancelled: the Director
//    cancels the loop's run, the loop checks the cancelled flag
//    before advancing (step 1a) and exits cleanly, reporting
//    its final status. No infinite loop without an exit: when
//    `maxIterations` is absent the loop parks with a sleep
//    between iterations (step 1h) and only exits on cancel;
//    `maxIterations` caps iterations for scratch/test runs.
//    A cancelled loop exits with verdict "failed",
//    cancelled true, cancelChecked true (the set's pattern).
// 2. Liveness location. `<stateDir>/liveness/<loopId>.json`
//    (loopId from the run input), written atomically after each
//    iteration's work. Keyed by loopId, not role: the file is
//    the loop's own cross-shift state, and a replacement loopId
//    for the same role must not inherit (and be blocked by) the
//    dead loop's record. The Director's supervision check reads
//    it by loopId (the stable id it launched the loop with).
// 3. The dispatch seam with BRA-176 — SETTLED (Implementation
//    lead, Nov 21, 14:24 PST; dispatch landed Nov 21). The
//    loop calls dispatch; it never duplicates the kind →
//    workflow lookup. Dispatch's switch is the single source
//    of truth. The loop supplies kind per task in dispatch's
//    input — the ranked queue carries no kind field (the
//    triage kind gap is a BACKLOG.md item), so the loop's
//    table attaches the kind to each job it hands to dispatch
//    (the table key is the kind; the inputBuilder builds the
//    task fields). The table's `workflow` field is the lead's
//    declared expectation for that kind: the loop checks
//    dispatch's resolution against it and fails the JOB loudly
//    on a mismatch, so the two can never drift silently — the
//    loop never invokes a workflow from the table directly.
//    After dispatch resolves the workflow, the loop submits
//    the sub-workflow run through the scheduler (dispatch
//    hands the routing to the scheduler as a handoff file; it
//    never submits). Dispatch owns the mapping; the loop owns
//    the kind-per-task supply and the submission.
//
//    The loop is the first consumer that SUBMITS a routed run
//    (BRA-176 tested routing only — the handoff shape, never
//    the submit), and submitting flushed out a dispatch defect:
//    every two-layer case built `runId + workDir` and omitted
//    the target workflow's own required `<id>` field, so the
//    CLI schema gate refused the routed input. This build fixes
//    the two cases the loop exercises — dependency-mapping
//    (`mappingId` added, `workDir` dropped: MappingRunInput
//    has no workDir) and worker-lifecycle (`lifecycleId`
//    added) — plus the per-case project pick (`pickProject`:
//    mapping's case picks the full project with `workDir` +
//    `resumeDir`, every other two-layer case picks the base
//    project without them — the target project configs are not
//    uniform, mapping alone requires them and the rest forbid
//    additional properties) and the loop's `runId` injection
//    (the task fields always carry `runId` = the submit run
//    id, so the sub-workflow's cancel check looks its own
//    queue entry up by it). Regression checks in
//    test-bra176.ts §C and the lead-loop test §C.
//    The remaining cases (triage, breakdown, daily-feed,
//    scheduler, merge, verify-fix, gc) carry the same defect
//    class and are filed as a BACKLOG.md follow-up; only hello,
//    dependency-mapping, and worker-lifecycle submit today.
// 4. The dispatch table at boot. The table at boot covers the
//    workflows that exist today; the acceptance table covers
//    hello + dependency-mapping (two routable workflows, one
//    flat-input and one file-driven). The table grows as Wave
//    2+ workflows land; the loop runs with whatever table it
//    is given and never hardcodes the workflow list.
//
// V0 claim source (a judgment call, recorded here for Quality to
// challenge): the loop claims from the launcher-supplied
// `run.jobs` list, not from the shared run queue
// (`queue.json`) or the ranked queue. The engine as it stands
// gives the loop no claimable task queue: run-queue entries
// are already-submitted runs (nothing for the loop to submit
// for them — dispatching one would double-execute it),
// ranked-queue items carry no kind field (the triage kind
// gap), and worker-server jobs are trap jobs for worker
// agents (prose specs), not workflow kinds. The launcher
// (Director) reads the shared queue and hands the loop its
// jobs with kinds attached. The shared run queue IS where the
// loop's submissions land and where its progress check reads.
// Claiming directly from the shared queue is filed as a
// BACKLOG.md follow-up (claim-from-queue), for when queue
// items carry kinds.
//
// Known v0 limits, carried verbatim in every report:
//
// - The loop claims from the launcher-supplied job list; it
//   does not read the shared queue for claimable jobs (see
//   the v0 claim-source note above). The progress check DOES
//   read the shared run queue for the loop's submitted
//   sub-runs.
// - A sub-run result over 48KB is recorded as truncated with
//   a pointer (read it with `agentts result <runId>`) rather
//   than collected — the ~60KB trap cap bounds the collection
//   trap. The job stays collected-with-truncation, never
//   silently dropped.
// - File-first files to BACKLOG.md in the complete form while
//   the Linear limit holds; the Linear filing path is a
//   follow-up for when the limit lifts. A filing entry over
//   100KB is recorded unfiled (the single-trap append cannot
//   carry it) rather than written.
// - The loop's `parallel` flag is carried through to the
//   handoff/report and enforced for sequential gating (a
//   parallel=false kind waits while its sub-run is pending);
//   the loop's own iteration is always in input order.
// - The dead-owner drill's Director-side half (reassignment
//   via liveness + lease expiry, retagging a pending decide)
//   is boot validation, not this build: the loop emits the
//   liveness the drill reads; the Director performs the
//   reassignment.

import { exec, sleep } from "../../src/agentts";
import dispatchTasks, {
  base64EncodeUtf8,
  splitHandoffChunks,
  appendChunkScript,
  parseWriteSummary,
  type DispatchInput,
  type JsonValue,
  type JsonObject,
} from "./dispatch";
import { cancelCheckScript, parseRunStatus, shellQuote } from "./triage";

/** Default bun binary. */
export const LEAD_LOOP_BUN_PATH = "/opt/hatch-image/bin/bun";

/** A sub-run result over this many bytes is recorded as
 * truncated with a pointer, never pushed through the ~60KB
 * trap cap. */
export const LEAD_LOOP_COLLECT_MAX_BYTES = 48 * 1024;

/** A filing entry over this many bytes is recorded unfiled —
 * the single-trap append cannot carry it. */
export const LEAD_LOOP_FILING_MAX_BYTES = 100 * 1024;

/** The progress-check facts line over this many bytes refuses
 * loudly rather than truncating (the gc sweep pattern). */
export const LEAD_LOOP_PROGRESS_MAX_BYTES = 48 * 1024;

/** One job the loop may claim: its id, its kind (the dispatch
 * table key), its owning session, its readiness bucket, and
 * the fields its workflow's input is built from. */
export interface LoopJob {
  jobId: string;
  kind: string;
  owner: string;
  /** Readiness bucket, as triaged. Only "ready" jobs claim. */
  bucket: "ready" | "gated" | "blocked" | "parked";
  fields: Record<string, JsonValue>;
}

/** One dispatch-table entry: the lead's declared expectation
 * for a kind, the field mapping that builds the dispatch
 * task's fields from the job, and whether jobs of this kind
 * dispatch in parallel or in sequence. `workflow` is the
 * repo-relative workflow file dispatch must resolve to (e.g.
 * "apps/agentts/workflows/library/triage.ts"). `inputBuilder`
 * maps output field names to dotted paths into the job
 * ("fields.<name>" into the job's fields, or "jobId" /
 * "kind" / "owner" at the job level); absent means the task
 * fields are the job's fields verbatim. */
export interface DispatchTableEntry {
  workflow: string;
  inputBuilder?: Record<string, string>;
  parallel: boolean;
}

/** One periodic entry: a workflow (kind, bare name) run on
 * cron, with optional fields for its job. */
export interface PeriodicEntry {
  workflow: string;
  cron: string;
  fields?: Record<string, JsonValue>;
}

/** Per-project config (mechanics §3 — the same shape for every
 * lead workflow). The workflow never reads agentts.project.json
 * itself; the launcher inlines it here. The project object is
 * passed through verbatim to dispatch and from there into every
 * routed sub-workflow's input, so it must satisfy the routed
 * workflows' project schemas — dependency-mapping's requires
 * workDir + resumeDir (supplied by the launcher), and a routed
 * submit is refused at the CLI schema gate when they are
 * absent. */
export interface LeadLoopProjectConfig {
  /** Linear project id/key (e.g. "P-BRA-2"). */
  linearProject: string;
  /** Absolute path of the project's repo (the live tree). */
  repo: string;
  /** Absolute path of the project's AgentTS state dir. */
  stateDir: string;
  /** Lead roster: role -> chat/session id. */
  roster: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the
   * loop v0 — carried for the set). */
  thresholds?: Record<string, number>;
  /** Per-run scratch dir, supplied by the launcher (routed
   * sub-workflows' project schemas require it). */
  workDir: string;
  /** Per-run resume dir, supplied by the launcher (routed
   * sub-workflows' project schemas require it). */
  resumeDir: string;
}

/** Per-run loop input (the workflow's own contract). */
export interface LeadLoopRunInput {
  /** Stable id for this lead's loop, e.g. "implementation-loop".
   * Sub-runs are submitted with launchedBy = loopId so the
   * progress check can find them across shifts. */
  loopId: string;
  /** The lead role, e.g. "implementation". Names the liveness
   * file (<stateDir>/liveness/<loopId>.json). */
  role: string;
  /** Launcher-supplied job list, in rank order. The loop claims
   * from this list in v0 (see the header's claim-source note). */
  jobs: LoopJob[];
  /** The dispatch table: kind -> {workflow, inputBuilder,
   * parallel}. The per-role part, data not code. */
  dispatchTable: Record<string, DispatchTableEntry>;
  /** Periodic sub-workflows, run on cron. */
  periodic?: PeriodicEntry[];
  /** Absolute scratch dir (work files). Created by the workflow. */
  workDir: string;
  /** State dir the cancel check + progress check read
   * (project.stateDir is the same value in practice; run.stateDir
   * is the workflow's own field). */
  stateDir: string;
  /** BACKLOG.md path for the file-first step. Absent: file-first
   * items are recorded unfiled with the reason named, never
   * dropped silently. */
  backlogPath?: string;
  /** Worker-server URL for the parked /health step (e.g.
   * "http://127.0.0.1:18741"). The launcher passes it; the
   * workflow never guesses the production port. Absent: the
   * health step is skipped with a note. */
  serverUrl?: string;
  /** Path to the agentts CLI (default
   * <repo>/apps/agentts/src/cli.ts). */
  cliPath?: string;
  /** bun binary (default /opt/hatch-image/bin/bun). */
  bunPath?: string;
  /** ISO "now" for the periodic cron evaluation + liveness
   * timestamps. Absent: the wall clock is read once per
   * iteration. Tests set it for determinism. */
  now?: string;
  /** Cap iterations (default: unbounded — the loop runs until
   * cancelled). Scratch/test runs set it. */
  maxIterations?: number;
  /** Seconds to sleep at the end of a parked iteration when
   * another iteration will follow (default 60). */
  parkSeconds?: number;
  /** Plan the loop but write nothing (default false). */
  dryRun?: boolean;
  /** The loop run's own id — when present, the workflow checks
   * the run's cancelled flag in stateDir/queue.json before
   * advancing each iteration. */
  runId?: string;
}

/** Input to the lead-loop workflow (two layers, mechanics §3). */
export interface LeadLoopInput {
  project: LeadLoopProjectConfig;
  run: LeadLoopRunInput;
  /** Launching session (provenance). */
  launchedBy?: string;
  /** Owning session — the session that executes and drives this
   * loop run (the lead). Required: never assume launcher ==
   * owner. */
  owner: string;
}

/** One job's outcome in the report (latest outcome per job). */
export interface JobOutcome {
  jobId: string;
  kind: string;
  outcome: "submitted" | "collected" | "refused" | "skipped" | "planned" | "pending";
  /** The sub-run id, when submitted. */
  runId?: string;
  /** The workflow file dispatch resolved to, when routed. */
  workflow?: string;
  /** Why the job was refused/skipped, when it was. */
  reason?: string;
}
/** One submitted sub-run. */
export interface SubRunRecord {
  jobId: string;
  kind: string;
  runId: string;
  workflow: string;
  /** Already in the queue when the loop submitted (idempotent
   * re-submit) — the loop did not create a second entry. */
  alreadySubmitted: boolean;
}

/** One collected sub-run result. */
export interface CollectedResult {
  jobId: string;
  kind: string;
  runId: string;
  /** The sub-report's verdict, when the result carries one. */
  verdict?: string;
  /** The full sub-report, null when truncated (see
   * resultTruncated). */
  result: JsonObject | null;
  /** True when the result was over the collect bound and only
   * a pointer was recorded. */
  resultTruncated: boolean;
  /** Items filed from this result by the file-first step. */
  filed: FiledItem[];
}

/** One filed item (file-first step). */
export interface FiledItem {
  jobId: string;
  kind: string;
  title: string;
  /** The BACKLOG.md path the entry went to. */
  backlogPath: string;
  /** The entry's idempotency marker. */
  marker: string;
}

/** One skipped job (owned by this loop, not claimed). */
export interface SkippedJob {
  jobId: string;
  kind: string;
  reason: string;
}

/** One pending decide surfaced by the progress check. */
export interface PendingDecide {
  runId: string;
  jobId: string;
  /** The gate trap id. */
  trapId: string;
  /** The gate's question, when the journal carries one. */
  question: string | null;
}

/** The parked-steps summary (latest parked iteration). */
export interface ParkedSummary {
  iterations: number;
  /** Ledger-tail lines (bounded, ≤200 chars each). */
  ledgerTail: string[];
  /** Queue depth from the last progress check. */
  queueDepth: number;
  /** /health answered ok (false when the server was unreachable
   * or serverUrl was absent — see healthNote). */
  healthOk: boolean;
  healthNote: string;
}

/** The loop's liveness file content (also the durable
 * collected-run record). The loop seeds its submitted-run
 * map + collected-run set + collected-run map (as
 * placeholders — the result lives in the run that collected
 * it) from this file at start, so a later loop run attributes
 * a sub-run's result to the right job and never re-collects
 * it — the file is the loop's cross-shift state, not just a
 * heartbeat. */
export interface LoopLiveness {
  role: string;
  owner: string;
  loopId: string;
  heartbeatAt: string;
  lastClaimAt: string | null;
  lastClaimJobId: string | null;
  lastReportAt: string | null;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsPending: number;
  periodicRunsDone: string[];
  queueDepth: number;
  collectedRunIds: string[];
  /** Sub-runs this loop (across runs) submitted, in submit
   * order — the cross-shift job mapping. */
  submittedRuns: SubRunRecord[];
}

/** The loop report — the workflow's output. */
export interface LeadLoopReport {
  loopId: string;
  role: string;
  /** "completed" means the loop ran its iterations and exited
   * cleanly; "dry-run" means the plan is clean and nothing was
   * written; "failed" means the run was refused or every
   * claimed job failed. None of these is acceptance. */
  verdict: string;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  /** The cancelled flag was checked before advancing. */
  cancelChecked: boolean;
  /** The run was cancelled when checked. */
  cancelled: boolean;
  /** Iterations run (claim attempts). */
  iterations: number;
  /** Latest outcome per job, in input order. */
  jobs: JobOutcome[];
  /** Sub-runs submitted by this loop, cumulative across loop
   * runs (seeded from the liveness file). */
  submitted: SubRunRecord[];
  /** Sub-runs collected by this loop, cumulative across loop
   * runs (seeded from the liveness file); entries collected in
   * a prior run carry result null — the result lives in the
   * run that collected it. */
  collected: CollectedResult[];
  /** Items filed by the file-first step this loop run. */
  filed: FiledItem[];
  /** Owned jobs not claimed, with reasons. */
  skipped: SkippedJob[];
  /** Pending decides surfaced (never answered) this loop run. */
  pendingDecides: PendingDecide[];
  /** Periodic workflows run this loop run. */
  periodicRunsDone: string[];
  /** Latest parked-steps summary (null when no parked
   * iteration ran). */
  parked: ParkedSummary | null;
  /** The liveness file path ("" when never written, e.g.
   * dry-run). */
  livenessPath: string;
  /** Queue depth from the last progress check. */
  queueDepth: number;
  /** The known v0 limits, carried verbatim in every report. */
  knownLimit: string;
  /** Every failure, named. Empty when clean. */
  notes: string[];
}

export const LEAD_LOOP_KNOWN_LIMIT =
  "v0 limit: the loop claims from the launcher-supplied job list - it does not read the shared queue for claimable jobs (the shared run queue is where its submissions land and where its progress check reads); a sub-run result over 48KB is recorded as truncated with a pointer rather than collected; file-first files to BACKLOG.md in the complete form while the Linear limit holds (the Linear filing path is a follow-up for when the limit lifts); a filing entry over 100KB is recorded unfiled rather than written; the loop's parallel flag is carried through and enforced for sequential gating, and the loop's own iteration is always in input order; the liveness file grows with every submitted sub-run (one record each) - a loop that submits hundreds of sub-runs without rotation will fail loudly at the seeding read, and rotation is a follow-up; periodic entries run once per loop run when due (a due periodic whose synthetic job was already collected is skipped, a pending one re-submits idempotently); the dead-owner drill's Director-side half (reassignment via liveness + lease expiry) is boot validation, not this build.";

/** Validate the loop input (pure). Returns the error strings;
 * empty means valid. The workflow refuses the run with these
 * (never throws for bad input). */
export function validateLeadLoopInput(input: LeadLoopInput): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return ["lead-loop: input is not an object"];
  if (!input.project || typeof input.project !== "object") errors.push("lead-loop: input has no project object");
  if (!input.run || typeof input.run !== "object") {
    errors.push("lead-loop: input has no run object");
    return errors;
  }
  const run = input.run;
  if (typeof run.loopId !== "string" || run.loopId === "") errors.push("lead-loop: run has no loopId string");
  if (typeof run.role !== "string" || run.role === "") errors.push("lead-loop: run has no role string");
  if (typeof input.owner !== "string" || input.owner === "") {
    errors.push("lead-loop: input has no owner string — the owner is the driving session, never assumed from the launcher");
  }
  if (input.project) {
    if (typeof input.project.linearProject !== "string" || input.project.linearProject === "") {
      errors.push("lead-loop: project has no linearProject string");
    }
    if (typeof input.project.repo !== "string" || input.project.repo === "") {
      errors.push("lead-loop: project has no repo string");
    }
    if (typeof input.project.stateDir !== "string" || input.project.stateDir === "") {
      errors.push("lead-loop: project has no stateDir string");
    }
    if (!input.project.roster || typeof input.project.roster !== "object") {
      errors.push("lead-loop: project has no roster object");
    }
    if (typeof input.project.workDir !== "string" || input.project.workDir === "") {
      errors.push("lead-loop: project has no workDir string — the launcher supplies it, and routed sub-workflows' project schemas require it");
    }
    if (typeof input.project.resumeDir !== "string" || input.project.resumeDir === "") {
      errors.push("lead-loop: project has no resumeDir string — the launcher supplies it, and routed sub-workflows' project schemas require it");
    }
  }
  if (!Array.isArray(run.jobs)) {
    errors.push("lead-loop: run.jobs must be an array");
  } else {
    const seen = new Set<string>();
    const validBuckets = new Set(["ready", "gated", "blocked", "parked"]);
    for (const job of run.jobs) {
      if (!job || typeof job !== "object") {
        errors.push("lead-loop: every job must be an object");
        continue;
      }
      if (typeof job.jobId !== "string" || job.jobId === "") {
        errors.push("lead-loop: every job needs a jobId string");
        continue;
      }
      if (seen.has(job.jobId)) errors.push("lead-loop: duplicate jobId " + job.jobId);
      seen.add(job.jobId);
      if (typeof job.kind !== "string" || job.kind === "") {
        errors.push("lead-loop: job " + job.jobId + " needs a kind string");
      }
      if (typeof job.owner !== "string" || job.owner === "") {
        errors.push("lead-loop: job " + job.jobId + " needs an owner string");
      }
      if (!validBuckets.has(job.bucket)) {
        errors.push("lead-loop: job " + job.jobId + " has an unknown bucket " + JSON.stringify(job.bucket));
      }
      if (!job.fields || typeof job.fields !== "object" || Array.isArray(job.fields)) {
        errors.push("lead-loop: job " + job.jobId + " needs a fields object");
      }
    }
  }
  if (!run.dispatchTable || typeof run.dispatchTable !== "object" || Array.isArray(run.dispatchTable)) {
    errors.push("lead-loop: run has no dispatchTable object");
  } else {
    for (const [kind, entry] of Object.entries(run.dispatchTable)) {
      if (!entry || typeof entry !== "object") {
        errors.push("lead-loop: dispatch table entry for kind " + kind + " must be an object");
        continue;
      }
      if (typeof entry.workflow !== "string" || entry.workflow === "") {
        errors.push("lead-loop: dispatch table entry for kind " + kind + " needs a workflow string");
      }
      if (typeof entry.parallel !== "boolean") {
        errors.push("lead-loop: dispatch table entry for kind " + kind + " needs a parallel boolean");
      }
      if (entry.inputBuilder !== undefined && (typeof entry.inputBuilder !== "object" || Array.isArray(entry.inputBuilder))) {
        errors.push("lead-loop: dispatch table entry for kind " + kind + " has a non-object inputBuilder");
      }
    }
  }
  if (run.periodic !== undefined) {
    if (!Array.isArray(run.periodic)) {
      errors.push("lead-loop: run.periodic must be an array");
    } else {
      for (const p of run.periodic) {
        if (!p || typeof p !== "object") {
          errors.push("lead-loop: every periodic entry must be an object");
          continue;
        }
        if (typeof p.workflow !== "string" || p.workflow === "") {
          errors.push("lead-loop: every periodic entry needs a workflow string");
        }
        if (typeof p.cron !== "string" || p.cron === "") {
          errors.push("lead-loop: every periodic entry needs a cron string");
        }
        if (p.fields !== undefined && (typeof p.fields !== "object" || Array.isArray(p.fields))) {
          errors.push("lead-loop: periodic entry for workflow " + String(p.workflow) + " has non-object fields");
        }
      }
    }
  }
  if (typeof run.workDir !== "string" || run.workDir === "") {
    errors.push("lead-loop: run has no workDir string");
  }
  if (typeof run.stateDir !== "string" || run.stateDir === "") {
    errors.push("lead-loop: run has no stateDir string");
  }
  if (run.maxIterations !== undefined && (typeof run.maxIterations !== "number" || run.maxIterations < 0 || !Number.isInteger(run.maxIterations))) {
    errors.push("lead-loop: run.maxIterations must be a non-negative integer");
  }
  if (run.parkSeconds !== undefined && (typeof run.parkSeconds !== "number" || run.parkSeconds < 0)) {
    errors.push("lead-loop: run.parkSeconds must be a non-negative number");
  }
  if (run.now !== undefined && (typeof run.now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(run.now))) {
    errors.push("lead-loop: run.now must be an ISO UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)");
  }
  return errors;
}

/** Build the dispatch task's fields from a job, through the
 * table entry's inputBuilder (a field map: output field ->
 * dotted path into the job). Paths are "fields.<name>" (into
 * the job's fields, dotted paths walk nested objects),
 * "jobId" / "kind" / "owner" (job level). A path that does
 * not resolve omits the field — dispatch's switch case then
 * refuses the task as needs-workflow, loud + named. Absent
 * inputBuilder means the task fields are the job's fields
 * verbatim. Pure. */
export function buildTaskFields(
  inputBuilder: Record<string, string> | undefined,
  job: LoopJob,
): Record<string, JsonValue> {
  if (inputBuilder === undefined) return { ...job.fields };
  const out: Record<string, JsonValue> = {};
  for (const [outField, path] of Object.entries(inputBuilder)) {
    const parts = path.split(".");
    let cur: unknown = job as unknown;
    // "fields.x.y" walks from the job object (job.fields is the
    // first step); "jobId"/"kind"/"owner" are job-level fields.
    let ok = true;
    for (const part of parts) {
      if (cur !== null && typeof cur === "object" && !Array.isArray(cur) && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        ok = false;
        break;
      }
    }
    if (!ok || cur === undefined) continue;
    // The input crossed JSON, so the value is JSON by
    // construction; functions cannot appear.
    out[outField] = cur as JsonValue;
  }
  return out;
}

/** Claim the next job (pure). In input order: the first job
 * whose owner is this loop's owner, whose bucket is ready,
 * that has not been claimed yet, whose result has not already
 * been collected in a prior loop run (a re-issued jobs list
 * never re-claims a collected job — the idempotent re-run
 * rule), and whose kind is not waiting on a sequential
 * sub-run (a parallel=false kind with a submitted-but-
 * uncollected sub-run waits). Returns the claimed job (or
 * null) plus the owned jobs that could not be claimed this
 * iteration, each with its reason, and the count of jobs for
 * other owners (counted, not listed). Pure — unit-tested
 * directly. */
export function claimJob(
  jobs: LoopJob[],
  owner: string,
  claimedIds: Set<string>,
  waitingKinds: Set<string>,
  collectedJobIds: Set<string>,
): { claimed: LoopJob | null; skipped: SkippedJob[]; otherOwnerCount: number } {
  const skipped: SkippedJob[] = [];
  let otherOwnerCount = 0;
  let claimed: LoopJob | null = null;
  for (const job of jobs) {
    if (job.owner !== owner) {
      otherOwnerCount++;
      continue;
    }
    if (claimedIds.has(job.jobId)) continue;
    if (collectedJobIds.has(job.jobId)) {
      skipped.push({ jobId: job.jobId, kind: job.kind, reason: "already-collected — its result was recorded in a prior loop run" });
      continue;
    }
    if (job.bucket !== "ready") {
      skipped.push({ jobId: job.jobId, kind: job.kind, reason: job.bucket + " — not claimed as ready" });
      continue;
    }
    if (waitingKinds.has(job.kind)) {
      skipped.push({ jobId: job.jobId, kind: job.kind, reason: "waiting-sequential — a sub-run for kind " + job.kind + " is still pending" });
      continue;
    }
    if (claimed === null) {
      claimed = job;
      continue;
    }
  }
  return { claimed, skipped, otherOwnerCount };
}

/** Validate a cron expression (pure). Supports "@hourly"
 * (minute 0), "@daily" (00:00), "@weekly" (Sunday 00:00),
 * and 5-field "M H DOM MON DOW" with `*`, numbers, comma
 * lists, and ranges. Returns the error string, or null when
 * the expression is valid. */
export function validateCron(cron: string): string | null {
  if (cron === "@hourly" || cron === "@daily" || cron === "@weekly") return null;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "cron " + JSON.stringify(cron) + " is not @hourly/@daily/@weekly or 5 fields";
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  for (let i = 0; i < 5; i++) {
    const f = fields[i];
    if (f === "*") continue;
    for (const part of f.split(",")) {
      if (/^\d+$/.test(part)) {
        const n = Number(part);
        if (n < ranges[i][0] || n > ranges[i][1]) {
          return "cron " + JSON.stringify(cron) + " field " + (i + 1) + " out of range";
        }
      } else if (/^(\d+)-(\d+)$/.test(part)) {
        const m = /^(\d+)-(\d+)$/.exec(part)!;
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        if (lo < ranges[i][0] || hi > ranges[i][1] || lo > hi) {
          return "cron " + JSON.stringify(cron) + " field " + (i + 1) + " has a bad range";
        }
      } else {
        return "cron " + JSON.stringify(cron) + " field " + (i + 1) + " is not *, a number, a list, or a range";
      }
    }
  }
  return null;
}

/** Is a cron expression due at `now` (ISO UTC)? Pure. A
 * 5-field cron matches when every field matches the
 * timestamp's minute/hour/day/month/weekday; @hourly matches
 * at minute 0, @daily at 00:00, @weekly at Sunday 00:00.
 * An invalid cron is never due (validation names it
 * separately). */
export function isCronDue(cron: string, now: string): boolean {
  if (validateCron(cron) !== null) return false;
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return false;
  const minute = d.getUTCMinutes();
  const hour = d.getUTCHours();
  const dom = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const dow = d.getUTCDay();
  if (cron === "@hourly") return minute === 0;
  if (cron === "@daily") return minute === 0 && hour === 0;
  if (cron === "@weekly") return minute === 0 && hour === 0 && dow === 0;
  const fields = cron.trim().split(/\s+/);
  const values = [minute, hour, dom, month, dow];
  const matchField = (f: string, v: number): boolean => {
    if (f === "*") return true;
    for (const part of f.split(",")) {
      if (/^\d+$/.test(part)) {
        if (Number(part) === v) return true;
      } else {
        // A range "lo-hi" (validated by validateCron before this
        // runs). Parsed with split, never RegExp.exec — the
        // extractor reads `.exec(` as the exec trap, and this
        // helper runs inside Array.every's callback.
        const rangeParts = part.split("-");
        if (rangeParts.length === 2) {
          const lo = Number(rangeParts[0]);
          const hi = Number(rangeParts[1]);
          if (v >= lo && v <= hi) return true;
        }
      }
    }
    return false;
  };
  return fields.every((f, i) => matchField(f, values[i]));
}

/** The wall-clock script: one `date` line, UTC ISO. Pure. */
export function wallClockScript(): string {
  return "date -u +%Y-%m-%dT%H:%M:%SZ\n";
}

/** Parse the wall-clock trap's one line. Pure — throws on a
 * malformed line (the clock is environmental; a bad read is
 * loud, not a silent wrong time). */
export function parseWallClock(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(line)) {
    throw new Error("lead-loop: wall clock is not an ISO UTC timestamp: " + JSON.stringify(line.slice(0, 100)));
  }
  return line;
}

/** One sub-run as the progress check sees it. */
export interface ProgressSubRun {
  runId: string;
  status: string;
  /** The queue entry's error, when failed. */
  error?: string;
  /** The pending decide's trap id (held runs only). */
  pendingDecideTrapId?: string;
  /** The pending decide's question (held runs only). */
  pendingDecideQuestion?: string | null;
}

/** The progress-check facts (one JSON line from the trap). */
export interface ProgressFacts {
  queueDepth: number;
  ownedQueued: number;
  subRuns: ProgressSubRun[];
}

/** The progress-check script: inline python that reads
 * queue.json + the liveness file's collected-run record and
 * prints one JSON line of FACTS (never decisions). For held
 * sub-runs it reads the run's journal for the latest
 * gate-held event (trap id + question). Exit codes: 0 =
 * facts line on stdout; 2 = the facts line would exceed the
 * bound (refuse loudly rather than truncate); 3 = queue.json
 * missing or unparsable, or the liveness file unparsable
 * (refuse the whole run — the loop never advances blind).
 * Pure — the script's shape is unit-tested; the §D cases
 * drive it end to end. */
export function progressCheckScript(args: {
  stateDir: string;
  loopId: string;
  livenessPath: string;
  maxBytes: number;
}): string {
  const py = [
    "import json, os, sys",
    "state_dir, loop_id, liveness_path, max_bytes = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])",
    "def die(code, msg):",
    "    print(\"PROGRESS-ERROR \" + msg[:200])",
    "    raise SystemExit(code)",
    "queue_path = os.path.join(state_dir, \"queue.json\")",
    "try:",
    "    with open(queue_path) as f:",
    "        queue = json.load(f)",
    "except FileNotFoundError:",
    "    die(3, \"queue.json not found: \" + queue_path)",
    "except ValueError as e:",
    "    die(3, \"queue.json is not valid JSON: \" + str(e)[:150])",
    "if not isinstance(queue, list):",
    "    die(3, \"queue.json is not a JSON array\")",
    "collected = set()",
    "if os.path.exists(liveness_path):",
    "    try:",
    "        with open(liveness_path) as f:",
    "            live = json.load(f)",
    "    except ValueError as e:",
    "        die(3, \"liveness file is not valid JSON: \" + str(e)[:150])",
    "    if isinstance(live, dict) and isinstance(live.get(\"collectedRunIds\"), list):",
    "        collected = set(x for x in live[\"collectedRunIds\"] if isinstance(x, str))",
    "def journal_gate(journal_path):",
    "    trap_id = None",
    "    question = None",
    "    if not os.path.exists(journal_path):",
    "        return (trap_id, question)",
    "    try:",
    "        with open(journal_path) as f:",
    "            for line in f:",
    "                line = line.strip()",
    "                if not line:",
    "                    continue",
    "                try:",
    "                    ev = json.loads(line)",
    "                except ValueError:",
    "                    continue",
    "                if isinstance(ev, dict) and ev.get(\"event\") == \"gate-held\" and isinstance(ev.get(\"trapId\"), str):",
    "                    trap_id = ev[\"trapId\"]",
    "                    question = ev.get(\"question\") if isinstance(ev.get(\"question\"), str) else None",
    "                if isinstance(ev, dict) and ev.get(\"event\") in (\"trap-result\", \"trap-error\") and isinstance(ev.get(\"trapId\"), str) and ev.get(\"trapId\") == trap_id:",
    "                    trap_id = None",
    "                    question = None",
    "    except OSError:",
    "        return (None, None)",
    "    return (trap_id, question)",
    "sub_runs = []",
    "queue_depth = 0",
    "owned_queued = 0",
    "for e in queue:",
    "    if not isinstance(e, dict) or not isinstance(e.get(\"runId\"), str) or not isinstance(e.get(\"status\"), str):",
    "        die(3, \"corrupt queue entry (no runId/status string): \" + json.dumps(e)[:150])",
    "    if e[\"status\"] == \"queued\":",
    "        queue_depth += 1",
    "    if e.get(\"launchedBy\") != loop_id:",
    "        continue",
    "    if e[\"status\"] == \"queued\":",
    "        owned_queued += 1",
    "    rec = {\"runId\": e[\"runId\"], \"status\": e[\"status\"]}",
    "    if isinstance(e.get(\"error\"), str) and e[\"error\"] != \"\":",
    "        rec[\"error\"] = e[\"error\"][:200]",
    "    if e[\"status\"] == \"held\":",
    "        jp = os.path.join(state_dir, \"journals\", e[\"runId\"].replace(\"/\", \"_\") + \".journal\")",
    "        tid, q = journal_gate(jp)",
    "        if tid is not None:",
    "            rec[\"pendingDecideTrapId\"] = tid",
    "            rec[\"pendingDecideQuestion\"] = q",
    "    sub_runs.append(rec)",
    "facts = {\"queueDepth\": queue_depth, \"ownedQueued\": owned_queued, \"subRuns\": sub_runs, \"collectedRunIds\": sorted(collected)}",
    "line = json.dumps(facts)",
    "if len(line) > max_bytes:",
    "    die(2, \"progress facts would exceed the bound (%d bytes)\" % len(line))",
    "print(line)",
  ];
  return (
    "python3 - " +
    shellQuote(args.stateDir) +
    " " +
    shellQuote(args.loopId) +
    " " +
    shellQuote(args.livenessPath) +
    " " +
    String(args.maxBytes) +
    " <<'LEADLOOP_PROGRESS_PY'\n" +
    py.join("\n") +
    "\nLEADLOOP_PROGRESS_PY"
  );
}

/** Parse the progress-check trap's one JSON facts line. Pure —
 * throws on any malformation (a misparsed progress check
 * would claim sub-runs that never existed). */
export function parseProgressFacts(text: string): ProgressFacts & { collectedRunIds: string[] } {
  const line = text.trim().split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error("lead-loop: progress check printed no JSON line: " + JSON.stringify(text.slice(0, 200)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new Error("lead-loop: progress facts are not valid JSON: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("lead-loop: progress facts are not a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.queueDepth !== "number" || typeof o.ownedQueued !== "number" || !Array.isArray(o.subRuns)) {
    throw new Error("lead-loop: progress facts are missing queueDepth/ownedQueued/subRuns");
  }
  for (const s of o.subRuns as unknown[]) {
    if (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>).runId !== "string" || typeof (s as Record<string, unknown>).status !== "string") {
      throw new Error("lead-loop: progress facts carry a sub-run with no runId/status string");
    }
  }
  return {
    queueDepth: o.queueDepth as number,
    ownedQueued: o.ownedQueued as number,
    subRuns: o.subRuns as ProgressSubRun[],
    collectedRunIds: Array.isArray(o.collectedRunIds) ? (o.collectedRunIds as string[]) : [],
  };
}

/** The submit script: extract the routed run's input from
 * dispatch's handoff file, check the queue for the runId
 * (idempotent re-submit), and invoke the CLI to submit it.
 * Prints exactly one of: `ALREADY-SUBMITTED <runId>` (the
 * queue already holds the run — no second entry is created),
 * `RUN <runId>` (the CLI submitted it), or `SUBMIT-ERROR
 * <message>` (exit 1). The routed input never crosses a trap
 * boundary — it moves file to file. Pure — the script's shape
 * is unit-tested; the §D cases drive it end to end. */
export function submitScript(args: {
  bunPath: string;
  cliPath: string;
  workflowAbs: string;
  runId: string;
  handoffPath: string;
  routedIndex: number;
  inputFile: string;
  stateDir: string;
  owner: string;
  launchedBy: string;
}): string {
  const py = [
    "import json, sys",
    "handoff_path, routed_index, input_file, queue_path, run_id = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]",
    "try:",
    "    h = json.load(open(handoff_path))",
    "except Exception as e:",
    "    print(\"SUBMIT-ERROR handoff unreadable: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "try:",
    "    routed = h[\"routed\"][routed_index]",
    "    inp = routed[\"input\"]",
    "except Exception as e:",
    "    print(\"SUBMIT-ERROR handoff has no routed[\" + str(routed_index) + \"].input: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "try:",
    "    with open(input_file, \"w\") as f:",
    "        json.dump(inp, f)",
    "except Exception as e:",
    "    print(\"SUBMIT-ERROR cannot write routed input: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "try:",
    "    q = json.load(open(queue_path))",
    "except FileNotFoundError:",
    "    q = []",
    "except ValueError as e:",
    "    print(\"SUBMIT-ERROR queue.json is not valid JSON: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "if isinstance(q, list) and any(isinstance(e, dict) and e.get(\"runId\") == run_id for e in q):",
    "    raise SystemExit(2)",
  ];
  return (
    "python3 - " +
    shellQuote(args.handoffPath) +
    " " +
    String(args.routedIndex) +
    " " +
    shellQuote(args.inputFile) +
    " " +
    shellQuote(args.stateDir + "/queue.json") +
    " " +
    shellQuote(args.runId) +
    " <<'LEADLOOP_SUBMIT_PY'\n" +
    py.join("\n") +
    "\nLEADLOOP_SUBMIT_PY\n" +
    "rc=$?\n" +
    "if [ $rc -eq 2 ]; then echo \"ALREADY-SUBMITTED " +
    args.runId +
    "\"; exit 0; fi\n" +
    "if [ $rc -ne 0 ]; then exit 1; fi\n" +
    shellQuote(args.bunPath) +
    " " +
    shellQuote(args.cliPath) +
    " run " +
    shellQuote(args.workflowAbs) +
    " --adapter direct " +
    "--run-id " +
    shellQuote(args.runId) +
    " --input-file " +
    shellQuote(args.inputFile) +
    " --state-dir " +
    shellQuote(args.stateDir) +
    " --owner " +
    shellQuote(args.owner) +
    " --launched-by " +
    shellQuote(args.launchedBy) +
    " 2>/tmp/leadloop-submit-err-$$ || { echo \"SUBMIT-ERROR $(head -c 200 /tmp/leadloop-submit-err-$$ 2>/dev/null)\"; rm -f /tmp/leadloop-submit-err-$$; exit 1; }\n" +
    "rm -f /tmp/leadloop-submit-err-$$\n"
  );
}

/** Parse the submit trap's output. The CLI prints `RUN
 * <runId>` first, then `launched by:` / `owner:` lines, so the
 * parser scans every line for the confirmation (never the
 * last line). Returns "submitted" with the runId, or
 * "already-submitted". Throws when the trap printed anything
 * else (a submit that cannot be confirmed is a failure, never
 * a silent success). Pure. */
export function parseSubmitOutput(text: string, expectedRunId: string): { status: "submitted" | "already-submitted"; runId: string } {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  for (const line of lines) {
    if (line === "ALREADY-SUBMITTED " + expectedRunId) {
      return { status: "already-submitted", runId: expectedRunId };
    }
    if (line === "RUN " + expectedRunId) {
      return { status: "submitted", runId: expectedRunId };
    }
  }
  const err = lines.find((l) => l.startsWith("SUBMIT-ERROR"));
  if (err !== undefined) {
    throw new Error("lead-loop: submit failed for " + expectedRunId + ": " + err.slice(0, 200));
  }
  throw new Error("lead-loop: submit output did not confirm " + expectedRunId + ": " + JSON.stringify(lines.join(" | ").slice(0, 200)));
}

/** The collect script: read a done sub-run's result via
 * `agentts result` and print it when it fits the bound, or
 * print `TOO-BIG <bytes> <runId>` when it does not. The
 * result never crosses a trap boundary over the bound.
 * Exit 1 = the result command failed (the message names it).
 * Pure — the script's shape is unit-tested; the §D cases
 * drive it end to end. */
export function collectScript(args: { bunPath: string; cliPath: string; runId: string; stateDir: string }): string {
  return (
    "out=$(" +
    shellQuote(args.bunPath) +
    " " +
    shellQuote(args.cliPath) +
    " result " +
    shellQuote(args.runId) +
    " --state-dir " +
    shellQuote(args.stateDir) +
    " 2>/tmp/leadloop-collect-err-$$); rc=$?\n" +
    "if [ $rc -ne 0 ]; then echo \"RESULT-ERROR $(head -c 200 /tmp/leadloop-collect-err-$$ 2>/dev/null)\"; rm -f /tmp/leadloop-collect-err-$$; exit 1; fi\n" +
    "rm -f /tmp/leadloop-collect-err-$$\n" +
    "n=$(printf '%s' \"$out\" | wc -c)\n" +
    "if [ \"$n\" -gt " +
    String(LEAD_LOOP_COLLECT_MAX_BYTES) +
    " ]; then echo \"TOO-BIG $n " +
    args.runId +
    "\"; else printf '%s' \"$out\"; fi\n"
  );
}

/** Parse the collect trap's output. Returns the parsed result
 * object, or {tooBig: true, bytes} when the result exceeded
 * the bound. Throws on a RESULT-ERROR or malformed JSON. Pure. */
export function parseCollectedResult(
  text: string,
  runId: string,
): { tooBig: false; result: JsonObject } | { tooBig: true; bytes: number } {
  const trimmed = text.trim();
  const m = /^TOO-BIG ([0-9]+) (\S+)$/.exec(trimmed.split("\n")[0] ?? "");
  if (m) {
    if (m[2] !== runId) throw new Error("lead-loop: TOO-BIG names run " + m[2] + " but collecting " + runId);
    return { tooBig: true, bytes: Number(m[1]) };
  }
  if (trimmed.startsWith("RESULT-ERROR")) {
    throw new Error("lead-loop: result read failed for " + runId + ": " + trimmed.slice(0, 200));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error("lead-loop: collected result for " + runId + " is not valid JSON: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("lead-loop: collected result for " + runId + " is not a JSON object");
  }
  return { tooBig: false, result: parsed as JsonObject };
}

/** The ledger-tail script: the last 5 ledger lines, each cut
 * to 200 chars (bounded). Missing ledger file prints nothing
 * (exit 0). Pure. */
export function ledgerTailScript(stateDir: string): string {
  return (
    "if [ -f " +
    shellQuote(stateDir + "/ledger/run-ledger.jsonl") +
    " ]; then tail -n 5 " +
    shellQuote(stateDir + "/ledger/run-ledger.jsonl") +
    " | cut -c1-200; fi\n"
  );
}

/** Parse the ledger-tail trap's lines (each a ledger JSON
 * line, or empty). Pure — unparsable lines are kept verbatim
 * (the tail is informational, never a decision). */
export function parseLedgerTail(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The /health script: one curl with a short timeout, printing
 * `HEALTH ok` / `HEALTH not-ok` / `HEALTH unreachable`. Pure. */
export function healthScript(serverUrl: string): string {
  return (
    "if curl -s -m 5 " +
    shellQuote(serverUrl.replace(/\/$/, "") + "/health") +
    " | grep -q '\"ok\":true'; then echo 'HEALTH ok'; elif curl -s -m 5 " +
    shellQuote(serverUrl.replace(/\/$/, "") + "/health") +
    " >/dev/null 2>&1; then echo 'HEALTH not-ok'; else echo 'HEALTH unreachable'; fi\n"
  );
}

/** Parse the /health trap's one line. Pure. */
export function parseHealth(text: string): boolean {
  return text.trim().split("\n").some((l) => l.trim() === "HEALTH ok");
}

/** Build the liveness record for a write (pure). */
export function buildLiveness(args: {
  role: string;
  owner: string;
  loopId: string;
  heartbeatAt: string;
  lastClaimAt: string | null;
  lastClaimJobId: string | null;
  lastReportAt: string | null;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsPending: number;
  periodicRunsDone: string[];
  queueDepth: number;
  collectedRunIds: string[];
  submittedRuns: SubRunRecord[];
}): LoopLiveness {
  return {
    role: args.role,
    owner: args.owner,
    loopId: args.loopId,
    heartbeatAt: args.heartbeatAt,
    lastClaimAt: args.lastClaimAt,
    lastClaimJobId: args.lastClaimJobId,
    lastReportAt: args.lastReportAt,
    jobsClaimed: args.jobsClaimed,
    jobsCompleted: args.jobsCompleted,
    jobsPending: args.jobsPending,
    periodicRunsDone: [...args.periodicRunsDone],
    queueDepth: args.queueDepth,
    collectedRunIds: [...args.collectedRunIds].sort(),
    submittedRuns: [...args.submittedRuns],
  };
}

/** Parse a liveness file's content (pure). Throws on any
 * malformation — a liveness file the loop cannot read is a
 * broken cross-shift record, and the loop must fail loudly
 * rather than collect blind. A file written before
 * submittedRuns existed (no such files exist in v0) is
 * accepted with an empty submittedRuns list. */
export function parseLiveness(text: string): LoopLiveness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("lead-loop: liveness file is not valid JSON: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("lead-loop: liveness file is not a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  for (const f of ["role", "owner", "loopId", "heartbeatAt"]) {
    if (typeof o[f] !== "string" || (o[f] as string) === "") {
      throw new Error("lead-loop: liveness file is missing " + f);
    }
  }
  if (!Array.isArray(o.collectedRunIds) || !o.collectedRunIds.every((x) => typeof x === "string")) {
    throw new Error("lead-loop: liveness file has no collectedRunIds string array");
  }
  const submittedRuns: SubRunRecord[] = [];
  if (o.submittedRuns !== undefined) {
    if (!Array.isArray(o.submittedRuns)) {
      throw new Error("lead-loop: liveness file has a non-array submittedRuns");
    }
    for (const s of o.submittedRuns as unknown[]) {
      if (
        typeof s !== "object" ||
        s === null ||
        typeof (s as Record<string, unknown>).jobId !== "string" ||
        typeof (s as Record<string, unknown>).kind !== "string" ||
        typeof (s as Record<string, unknown>).runId !== "string" ||
        typeof (s as Record<string, unknown>).workflow !== "string" ||
        typeof (s as Record<string, unknown>).alreadySubmitted !== "boolean"
      ) {
        throw new Error("lead-loop: liveness file carries a malformed submitted run");
      }
      submittedRuns.push(s as SubRunRecord);
    }
  }
  return {
    role: o.role as string,
    owner: o.owner as string,
    loopId: o.loopId as string,
    heartbeatAt: o.heartbeatAt as string,
    lastClaimAt: typeof o.lastClaimAt === "string" ? o.lastClaimAt : null,
    lastClaimJobId: typeof o.lastClaimJobId === "string" ? o.lastClaimJobId : null,
    lastReportAt: typeof o.lastReportAt === "string" ? o.lastReportAt : null,
    jobsClaimed: typeof o.jobsClaimed === "number" ? o.jobsClaimed : 0,
    jobsCompleted: typeof o.jobsCompleted === "number" ? o.jobsCompleted : 0,
    jobsPending: typeof o.jobsPending === "number" ? o.jobsPending : 0,
    periodicRunsDone: Array.isArray(o.periodicRunsDone) ? (o.periodicRunsDone as string[]) : [],
    queueDepth: typeof o.queueDepth === "number" ? o.queueDepth : 0,
    collectedRunIds: o.collectedRunIds as string[],
    submittedRuns,
  };
}

/** The liveness finalize script: rename the temp liveness
 * file onto the liveness path (atomic), then read it back
 * and verify it parses and names this loopId. Prints one
 * `WROTE <bytes> <path>` line. Pure. Exit codes: 0 = wrote
 * + verified; 1 = rename failed; 2 = read-back failed. */
export function finalizeLivenessScript(tmpPath: string, livenessPath: string, loopId: string): string {
  return (
    "mkdir -p \"$(dirname " +
    shellQuote(livenessPath) +
    ")\" || exit 1\n" +
    "mv " +
    shellQuote(tmpPath) +
    " " +
    shellQuote(livenessPath) +
    " || exit 1\n" +
    "python3 -c '\n" +
    "import json, sys\n" +
    "d = json.load(open(sys.argv[1]))\n" +
    "assert d[\"loopId\"] == sys.argv[2], \"loopId mismatch\"\n" +
    "print(\"OK\")\n" +
    "' " +
    shellQuote(livenessPath) +
    " " +
    shellQuote(loopId) +
    " > /dev/null || exit 2\n" +
    "bytes=$(wc -c < " +
    shellQuote(livenessPath) +
    ")\n" +
    "printf 'WROTE %s %s\\n' \"$bytes\" " +
    shellQuote(livenessPath) +
    "\n"
  );
}

/** The filing marker for one item: deterministic, so a re-run
 * finds it and never files twice. Pure. */
export function filingMarker(loopId: string, jobId: string, itemIndex: number): string {
  return "loop-filing: " + loopId + "/" + jobId + "/" + itemIndex;
}

/** Render one BACKLOG.md entry for a filed item (pure). The
 * entry is in the same complete form as the hand-filed
 * entries (title, priority, estimate, code area, acceptance
 * criteria, parent, source); fields the sub-report did not
 * supply are recorded as unknown, never invented. */
export function renderLoopFilingEntry(args: {
  loopId: string;
  jobId: string;
  kind: string;
  itemIndex: number;
  title: string;
  priority?: string;
  estimate?: number;
  codeArea?: string;
  acceptance?: string[];
  parent?: string;
  recorded: string;
}): string {
  const lines: string[] = [];
  lines.push("## " + args.title);
  lines.push("");
  lines.push("- **Recorded:** " + args.recorded + " (by the lead loop " + args.loopId + ", file-first step for job " + args.jobId + ", kind " + args.kind + ").");
  lines.push(
    "- **Source:** a dispatched sub-workflow's report carried a fileFirst item (job " +
      args.jobId +
      ", kind " +
      args.kind +
      (args.parent !== undefined && args.parent !== "" ? ", parent " + args.parent : "") +
      "); the loop filed it in the same iteration — one issue per item.",
  );
  lines.push("- **Priority:** " + (args.priority ?? "unknown") + ".");
  if (args.estimate !== undefined) lines.push("- **Estimate:** " + args.estimate + ".");
  lines.push("- **Code area:** " + (args.codeArea ?? "unknown") + ".");
  if (args.acceptance !== undefined && args.acceptance.length > 0) {
    lines.push("- **Acceptance criteria:**");
    for (const a of args.acceptance) lines.push("  - " + a);
  } else {
    lines.push("- **Acceptance criteria:** unknown — the sub-report's fileFirst item carried none.");
  }
  lines.push("<!-- " + filingMarker(args.loopId, args.jobId, args.itemIndex) + " -->");
  return lines.join("\n") + "\n";
}

/** The filing script: decode one base64 entry and append it
 * to BACKLOG.md when its marker is not already present
 * (idempotent — a re-run prints EXISTS and writes nothing),
 * ensuring a blank-line separator first. Prints exactly one
 * of `FILED <marker>` / `EXISTS <marker>`. Exit 1 = the
 * backlog file is unreadable or unwritable. Pure — the
 * script's shape is unit-tested; the §D cases drive it end
 * to end. */
export function filingScript(backlogPath: string, entryB64: string, marker: string): string {
  const py = [
    "import base64, sys",
    "backlog_path, entry_b64, marker = sys.argv[1], sys.argv[2], sys.argv[3]",
    "try:",
    "    entry = base64.b64decode(entry_b64).decode(\"utf-8\")",
    "except Exception as e:",
    "    print(\"FILING-ERROR entry is not base64: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "try:",
    "    with open(backlog_path) as f:",
    "        text = f.read()",
    "except FileNotFoundError:",
    "    text = \"\"",
    "except OSError as e:",
    "    print(\"FILING-ERROR backlog unreadable: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "if marker in text:",
    "    print(\"EXISTS \" + marker)",
    "    raise SystemExit(0)",
    "sep = \"\"",
    "if text != \"\" and not text.endswith(\"\\n\\n\"):",
    "    sep = \"\\n\" if text.endswith(\"\\n\") else \"\\n\\n\"",
    "try:",
    "    with open(backlog_path, \"a\") as f:",
    "        f.write(sep + entry)",
    "except OSError as e:",
    "    print(\"FILING-ERROR backlog unwritable: \" + str(e)[:150])",
    "    raise SystemExit(1)",
    "with open(backlog_path) as f:",
    "    check = f.read()",
    "if marker not in check:",
    "    print(\"FILING-ERROR marker missing after append\")",
    "    raise SystemExit(1)",
    "print(\"FILED \" + marker)",
  ];
  return (
    "python3 - " +
    shellQuote(backlogPath) +
    " " +
    shellQuote(entryB64) +
    " " +
    shellQuote(marker) +
    " <<'LEADLOOP_FILING_PY'\n" +
    py.join("\n") +
    "\nLEADLOOP_FILING_PY"
  );
}

/** Parse the filing trap's one line. Pure — throws on
 * anything else (a filing that cannot be confirmed is a
 * failure, never a silent success). */
export function parseFilingResult(text: string, marker: string): "FILED" | "EXISTS" {
  const line = text.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  if (line === "FILED " + marker) return "FILED";
  if (line === "EXISTS " + marker) return "EXISTS";
  throw new Error("lead-loop: filing result did not confirm " + marker + ": " + JSON.stringify(line.slice(0, 200)));
}

/** Build the dispatch input for one work item (pure). The
 * task's kind is the job's kind; the fields come from the
 * table entry's inputBuilder (or the job's fields verbatim);
 * the assignment names the job's owner; the handoff goes to
 * the loop work dir. The task fields ALWAYS carry `runId` =
 * the submit run id (`<loopId>-<jobId>`, the id the loop
 * submits the routed run with): dispatch's cases default the
 * sub-workflow's own `runId` from the task fields, and the
 * sub-workflow's cancel check looks its own queue entry up by
 * that id — a routed run whose input carries dispatch's
 * derived id (`<dispatchId>-<taskId>`, which doubles the
 * job id) fails its cancel check with "no queue entry" and
 * refuses before doing any work. The loop's submit id is
 * authoritative, so it overrides any `runId` the job's fields
 * carry (the inputBuilder cannot rename it away). */
export function buildDispatchInput(args: {
  loopId: string;
  job: LoopJob;
  tableEntry: DispatchTableEntry;
  project: LeadLoopProjectConfig;
  workDir: string;
  stateDir: string;
  owner: string;
  launchedBy?: string;
  dryRun: boolean;
  runId?: string;
  bunPath?: string;
}): DispatchInput {
  const dispatchId = args.loopId + "-" + args.job.jobId;
  const submitRunId = args.loopId + "-" + args.job.jobId;
  const fields = buildTaskFields(args.tableEntry.inputBuilder, args.job);
  fields.runId = submitRunId;
  return {
    project: args.project,
    run: {
      dispatchId,
      tasks: [
        {
          taskId: args.job.jobId,
          tag: args.job.kind,
          bucket: "ready",
          fields,
        },
      ],
      assignments: { [args.job.jobId]: args.job.owner },
      handoffPath: args.workDir + "/handoff-" + args.job.jobId + ".json",
      stateDir: args.stateDir,
      workDir: args.workDir + "/dispatch-" + args.job.jobId,
      dryRun: args.dryRun,
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
      ...(args.bunPath !== undefined ? { bunPath: args.bunPath } : {}),
    },
    ...(args.launchedBy !== undefined ? { launchedBy: args.launchedBy } : {}),
    owner: args.owner,
  };
}

/** Assemble the loop report and its verdict from the step
 * results. Pure — unit-tested directly. The verdict is
 * "completed" when the loop ran its iterations and exited
 * cleanly; "dry-run" when the plan is clean and nothing was
 * written; "failed" when the run was refused (validation,
 * cancel, guard) or every claimed job failed. Per-job
 * failures are recorded per job + in notes. */
export function buildLeadLoopReport(args: {
  loopId: string;
  role: string;
  verdict: "completed" | "failed" | "dry-run";
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  iterations: number;
  jobs: JobOutcome[];
  submitted: SubRunRecord[];
  collected: CollectedResult[];
  filed: FiledItem[];
  skipped: SkippedJob[];
  pendingDecides: PendingDecide[];
  periodicRunsDone: string[];
  parked: ParkedSummary | null;
  livenessPath: string;
  queueDepth: number;
  extraNotes?: string[];
}): LeadLoopReport {
  const notes: string[] = [...(args.extraNotes ?? [])];
  for (const j of args.jobs) {
    if (j.outcome === "refused" && j.reason) notes.push(j.jobId + ": " + j.reason);
  }
  for (const c of args.collected) {
    if (c.resultTruncated) {
      notes.push("collected result for " + c.jobId + " (" + c.runId + ") exceeded the collect bound — recorded as truncated, read it with agentts result " + c.runId);
    }
  }
  for (const p of args.pendingDecides) {
    notes.push("pending decide on " + p.runId + " (job " + p.jobId + ", trap " + p.trapId + ") — decide is owner-only, the loop never answers it");
  }
  return {
    loopId: args.loopId,
    role: args.role,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    iterations: args.iterations,
    jobs: args.jobs,
    submitted: args.submitted,
    collected: args.collected,
    filed: args.filed,
    skipped: args.skipped,
    pendingDecides: args.pendingDecides,
    periodicRunsDone: args.periodicRunsDone,
    parked: args.parked,
    livenessPath: args.livenessPath,
    queueDepth: args.queueDepth,
    knownLimit: LEAD_LOOP_KNOWN_LIMIT,
    notes,
  };
}

/** Lead-loop workflow: claim the next job for this loop's
 * owner, dispatch it per the table (dispatch's switch is the
 * single source of truth), submit the routed run through the
 * scheduler, progress-check the owned runs pull-only,
 * collect completed reports, file first, run periodic work
 * on cron, park cheaply between jobs, and emit liveness the
 * Director's supervision check reads. The entry is a plain
 * sync function (the host driver calls it from global code). */
export default function leadLoop(input: LeadLoopInput): LeadLoopReport {
  const run = input.run;
  const bun = run.bunPath ?? LEAD_LOOP_BUN_PATH;
  const cliPath = run.cliPath ?? input.project.repo + "/apps/agentts/src/cli.ts";
  const dryRun = run.dryRun ?? false;
  const maxIterations = run.maxIterations;
  const parkSeconds = run.parkSeconds ?? 60;
  const workDir = run.workDir;
  const stateDir = run.stateDir;
  const livenessPath = stateDir + "/liveness/" + run.loopId + ".json";
  const livenessTmp = workDir + "/liveness.json.tmp";
  // The cancel check flag, declared BEFORE the refused helper
  // so the helper reads the live value (the triage lesson).
  let cancelChecked = false;
  let cancelled = false;
  // Outcome state, accumulated across iterations.
  const claimedIds = new Set<string>();
  const jobOutcomes = new Map<string, JobOutcome>();
  const submittedByRunId = new Map<string, SubRunRecord>();
  const collectedByRunId = new Map<string, CollectedResult>();
  const collectedRunIds = new Set<string>();
  const filed: FiledItem[] = [];
  // fileFirst items the collect step could not file, with the
  // reason named — surfaced in the report's notes (a
  // directly-submitted sub-run's job outcome never reaches
  // the report's jobs list, so the outcome reason alone is
  // not observable for it; the truncation note is the
  // precedent for a collect-step record in notes).
  const unfiledNotes: string[] = [];
  const skippedByJobId = new Map<string, SkippedJob>();
  const pendingDecides: PendingDecide[] = [];
  const periodicDone = new Set<string>();
  let parked: ParkedSummary | null = null;
  let parkedIterations = 0;
  let queueDepth = 0;
  let iterations = 0;
  let lastClaimAt: string | null = null;
  let lastClaimJobId: string | null = null;
  let lastReportAt: string | null = null;
  let jobsClaimed = 0;
  let otherOwnerCount = 0;

  // refused() builds a failed report with the LIVE
  // cancelChecked value, used for every refusal path.
  const refusedReport = (notes: string[]): LeadLoopReport =>
    buildLeadLoopReport({
      loopId: run.loopId,
      role: run.role,
      verdict: "failed",
      dryRun,
      owner: input.owner,
      launchedBy: input.launchedBy,
      cancelChecked,
      cancelled,
      iterations,
      jobs: [...jobOutcomes.values()],
      submitted: [...submittedByRunId.values()],
      collected: [...collectedByRunId.values()],
      filed,
      skipped: [...skippedByJobId.values()],
      pendingDecides,
      periodicRunsDone: [...periodicDone],
      parked,
      livenessPath: "",
      queueDepth,
      extraNotes: [...notes, ...unfiledNotes],
    });

  // Step 0: mkdir the work dir (exec trap), then validate. A
  // mkdir failure is environmental — throw loudly. A validation
  // failure refuses the run with a failed report (the triage
  // pattern: refused(), never a throw for bad input).
  const mk = exec({ cmd: "/bin/sh", args: ["-c", "mkdir -p " + shellQuote(workDir)] });
  if (mk.exitCode !== 0) {
    throw new Error("lead-loop: cannot create workDir " + workDir + " (rc " + mk.exitCode + ")");
  }
  // run may be null (the BACKLOG.md refused() nit: validate
  // defensively — a null run yields a failed report, never a
  // throw). The checks below read run.* only after this guard.
  if (!input.run || typeof input.run !== "object") {
    return refusedReport(["lead-loop: input has no run object"]);
  }
  const validationErrors = validateLeadLoopInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors);
  }
  // The dispatch table entries' cron expressions are validated
  // up front: a malformed cron refuses the run (a periodic
  // entry that can never be due is a broken table, not a
  // runtime surprise).
  for (const p of run.periodic ?? []) {
    const err = validateCron(p.cron);
    if (err !== null) {
      return refusedReport(["lead-loop: periodic entry for workflow " + p.workflow + " has a bad cron — " + err]);
    }
  }

  // Kinds waiting on a sequential sub-run (parallel=false with
  // a submitted-but-uncollected sub-run). Recomputed from the
  // submitted/collected sets each iteration — the collected
  // set is the durable one, so a kind unblocks when its
  // sub-run was collected in a prior loop run too.
  const waitingKinds = (): Set<string> => {
    const kinds = new Set<string>();
    for (const s of submittedByRunId.values()) {
      if (collectedRunIds.has(s.runId)) continue;
      const entry = run.dispatchTable[s.kind];
      if (entry && entry.parallel === false) kinds.add(s.kind);
    }
    return kinds;
  };

  // Write the liveness file (chunked base64 write + rename +
  // read-back), unless dry-run. Throws loudly on a write
  // failure — a loop that cannot emit liveness is failing its
  // supervision contract, and the failure must not be silent.
  const writeLiveness = (now: string): void => {
    if (dryRun) return;
    const liveness = buildLiveness({
      role: run.role,
      owner: input.owner,
      loopId: run.loopId,
      heartbeatAt: now,
      lastClaimAt,
      lastClaimJobId,
      lastReportAt,
      jobsClaimed,
      // The counters come from the DURABLE sets, not the
      // per-run map: jobsCompleted is every run this loop has
      // collected across runs, jobsPending is every run it
      // submitted and has not yet collected. A per-run map
      // under-counts completed after a cross-shift collection.
      jobsCompleted: collectedRunIds.size,
      jobsPending: [...submittedByRunId.values()].filter((s) => !collectedRunIds.has(s.runId)).length,
      periodicRunsDone: [...periodicDone],
      queueDepth,
      collectedRunIds: [...collectedRunIds],
      submittedRuns: [...submittedByRunId.values()],
    });
    const json = JSON.stringify(liveness, null, 2);
    const chunks = splitHandoffChunks(json);
    exec({ cmd: "/bin/sh", args: ["-c", "rm -f " + shellQuote(livenessTmp)] });
    for (let i = 0; i < chunks.length; i++) {
      const r = exec({ cmd: "/bin/sh", args: ["-c", appendChunkScript(chunks[i], i, livenessTmp)] });
      if (r.stdout.trim() !== "CHUNK " + i) {
        throw new Error("lead-loop: liveness chunk " + i + " failed: " + JSON.stringify(r.stdout));
      }
    }
    const fin = exec({
      cmd: "/bin/sh",
      args: ["-c", finalizeLivenessScript(livenessTmp, livenessPath, run.loopId)],
    });
    const summary = parseWriteSummary(fin.stdout);
    if (summary.path !== livenessPath) {
      throw new Error("lead-loop: liveness write path mismatch: " + summary.path + " != " + livenessPath);
    }
  };

  // File one fileFirst item to backlogPath (idempotent).
  // Returns the FiledItem, or null when the item was recorded
  // unfiled (no backlogPath, or the entry is over the bound).
  // A filing-trap failure throws loudly — a half-filed
  // iteration must not report success.
  const fileItem = (args: {
    jobId: string;
    kind: string;
    itemIndex: number;
    item: Record<string, unknown>;
    recorded: string;
  }): FiledItem | null => {
    const title = typeof args.item.title === "string" && args.item.title !== "" ? args.item.title : null;
    if (title === null) return null;
    const marker = filingMarker(run.loopId, args.jobId, args.itemIndex);
    if (run.backlogPath === undefined || run.backlogPath === "") return null;
    const acceptance =
      Array.isArray(args.item.acceptance) && args.item.acceptance.every((a) => typeof a === "string")
        ? (args.item.acceptance as string[])
        : undefined;
    const entry = renderLoopFilingEntry({
      loopId: run.loopId,
      jobId: args.jobId,
      kind: args.kind,
      itemIndex: args.itemIndex,
      title,
      priority: typeof args.item.priority === "string" ? args.item.priority : undefined,
      estimate: typeof args.item.estimate === "number" ? args.item.estimate : undefined,
      codeArea: typeof args.item.codeArea === "string" ? args.item.codeArea : undefined,
      acceptance,
      parent: typeof args.item.parent === "string" ? args.item.parent : undefined,
      recorded: args.recorded,
    });
    if (entry.length > LEAD_LOOP_FILING_MAX_BYTES) return null;
    const r = exec({
      cmd: "/bin/sh",
      args: ["-c", filingScript(run.backlogPath, base64EncodeUtf8(entry), marker)],
    });
    const outcome = parseFilingResult(r.stdout, marker);
    if (outcome === "FILED" || outcome === "EXISTS") {
      return { jobId: args.jobId, kind: args.kind, title, backlogPath: run.backlogPath, marker };
    }
    return null;
  };

  // Seed the cross-shift record from the liveness file (when
  // this is not a dry-run and a prior loop run wrote one): the
  // submitted-run map (so a later run attributes a sub-run's
  // result to the right job), the collected-run set (so a
  // later run never re-collects), and the claim counters. A
  // liveness file that exists but does not parse fails loudly
  // — the loop never collects blind. A missing file is a
  // fresh start. The file grows with every submitted sub-run
  // (one record each); rotation is a follow-up (see the known
  // limits in the header).
  if (!dryRun) {
    const seed = exec({
      cmd: "/bin/sh",
      args: ["-c", "if [ -f " + shellQuote(livenessPath) + " ]; then cat " + shellQuote(livenessPath) + "; else echo 'NO-LIVENESS'; fi"],
    });
    if (seed.exitCode !== 0) {
      throw new Error("lead-loop: liveness seed read failed (rc " + seed.exitCode + ")");
    }
    const seedText = seed.stdout.trim();
    if (seedText !== "" && seedText !== "NO-LIVENESS") {
      const prior = parseLiveness(seedText);
      if (prior.loopId !== run.loopId) {
        throw new Error("lead-loop: liveness file names loop " + prior.loopId + " but this run is " + run.loopId);
      }
      for (const s of prior.submittedRuns) submittedByRunId.set(s.runId, s);
      for (const id of prior.collectedRunIds) collectedRunIds.add(id);
      // The report's collected list is cumulative across loop
      // runs: seed the collected map with placeholder entries
      // for runs collected in a prior shift (the result lives
      // in the run that collected it, so a placeholder carries
      // result null). A run collected this run was not in the
      // file at start, so a real entry never collides with a
      // placeholder.
      for (const id of prior.collectedRunIds) {
        const sub = submittedByRunId.get(id);
        collectedByRunId.set(id, {
          jobId: sub !== undefined ? sub.jobId : id,
          kind: sub !== undefined ? sub.kind : "unknown",
          runId: id,
          result: null,
          resultTruncated: false,
          filed: [],
        });
      }
      jobsClaimed = prior.jobsClaimed;
      lastClaimAt = prior.lastClaimAt;
      lastClaimJobId = prior.lastClaimJobId;
    }
  }
  // Jobs whose results were already collected in a prior loop
  // run (derived from the seeded submitted-run map): the
  // claim step skips them, and the periodic step skips their
  // synthetic jobs.
  const collectedJobIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const s of submittedByRunId.values()) {
      if (collectedRunIds.has(s.runId)) ids.add(s.jobId);
    }
    return ids;
  };

  // The main loop: cancel check → progress check → collect →
  // claim → periodic → dispatch + submit → liveness, until
  // maxIterations or cancel. A dry-run plans (claim +
  // dispatch with dryRun propagated) and writes nothing.
  while (maxIterations === undefined || iterations < maxIterations) {
    // 1a. Cancel check before advancing (when runId present).
    if (typeof run.runId === "string" && run.runId !== "") {
      const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, run.runId)] });
      if (check.exitCode === 2) {
        return refusedReport(["cancel check: no queue entry for run " + run.runId]);
      }
      if (check.exitCode === 3) {
        return refusedReport(["cancel check: " + (check.stdout ?? "").trim().slice(0, 200)]);
      }
      if (check.exitCode !== 0) {
        throw new Error(
          "lead-loop: cancel check failed unexpectedly (rc " +
            check.exitCode +
            "): " +
            ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
        );
      }
      let status: string;
      try {
        status = parseRunStatus(check.stdout);
      } catch (e) {
        throw new Error("lead-loop: cancel status is malformed: " + (e as Error).message);
      }
      cancelChecked = true;
      if (status === "cancelled") {
        cancelled = true;
        return refusedReport(["run " + run.runId + " is cancelled — the loop exits cleanly without advancing"]);
      }
    }

    // 1b. Now for this iteration (launcher-supplied when
    // present, else the wall clock, read once per iteration).
    let now: string;
    if (typeof run.now === "string" && run.now !== "") {
      now = run.now;
    } else {
      const clock = exec({ cmd: "/bin/sh", args: ["-c", wallClockScript()] });
      if (clock.exitCode !== 0) {
        throw new Error("lead-loop: wall clock read failed (rc " + clock.exitCode + ")");
      }
      now = parseWallClock(clock.stdout);
    }

    // 1c. Progress check (pull-only): one trap, facts only.
    // A failed progress check refuses the whole run — the
    // loop never advances blind.
    const prog = exec({
      cmd: "/bin/sh",
      args: ["-c", progressCheckScript({ stateDir, loopId: run.loopId, livenessPath, maxBytes: LEAD_LOOP_PROGRESS_MAX_BYTES })],
    });
    if (prog.exitCode === 2) {
      return refusedReport(["progress check: " + (prog.stdout ?? "").trim().slice(0, 200)]);
    }
    if (prog.exitCode === 3) {
      return refusedReport(["progress check: " + (prog.stdout ?? "").trim().slice(0, 200)]);
    }
    if (prog.exitCode !== 0) {
      throw new Error(
        "lead-loop: progress check failed unexpectedly (rc " +
          prog.exitCode +
          "): " +
          ((prog.stderr ?? "") + (prog.stdout ?? "")).slice(0, 200),
      );
    }
    let facts: ProgressFacts & { collectedRunIds: string[] };
    try {
      facts = parseProgressFacts(prog.stdout);
    } catch (e) {
      throw new Error("lead-loop: progress facts are malformed: " + (e as Error).message);
    }
    queueDepth = facts.queueDepth;
    for (const id of facts.collectedRunIds) collectedRunIds.add(id);
    // Surface pending decides (held sub-runs). The loop never
    // answers one — it records it for the owning lead.
    for (const s of facts.subRuns) {
      if (s.status === "held" && s.pendingDecideTrapId !== undefined) {
        const sub = submittedByRunId.get(s.runId);
        const jobId = sub !== undefined ? sub.jobId : s.runId;
        if (!pendingDecides.some((p) => p.runId === s.runId && p.trapId === s.pendingDecideTrapId)) {
          pendingDecides.push({
            runId: s.runId,
            jobId,
            trapId: s.pendingDecideTrapId,
            question: s.pendingDecideQuestion ?? null,
          });
        }
      }
    }

    // 1d. Collect done sub-runs not yet collected (skip in
    // dry-run — a dry-run writes nothing, including filings).
    // A cancelled sub-run is terminal, not still-running: it
    // is recorded as such and never waited on.
    if (!dryRun) {
      for (const s of facts.subRuns) {
        if (s.status !== "done" && s.status !== "cancelled") continue;
        if (collectedRunIds.has(s.runId)) continue;
        const sub = submittedByRunId.get(s.runId);
        // A done sub-run the loop did not submit this run but
        // launched by this loop in an earlier shift: the job
        // id is the run id (the earlier shift's record is not
        // in this run's memory).
        const jobId = sub !== undefined ? sub.jobId : s.runId;
        const kind = sub !== undefined ? sub.kind : "unknown";
        if (s.status === "cancelled") {
          // Terminal: record the cancellation so the job does
          // not strand as pending and the kind unblocks (the
          // run id joins collectedRunIds, so waitingKinds and
          // the liveness counters see it as terminal too).
          collectedByRunId.set(s.runId, {
            jobId,
            kind,
            runId: s.runId,
            verdict: "cancelled",
            result: null,
            resultTruncated: false,
            filed: [],
          });
          collectedRunIds.add(s.runId);
          jobOutcomes.set(jobId, {
            jobId,
            kind,
            outcome: "refused",
            runId: s.runId,
            reason: "sub-run " + s.runId + " was cancelled",
          });
          lastReportAt = now;
          continue;
        }
        const collect = exec({
          cmd: "/bin/sh",
          args: ["-c", collectScript({ bunPath: bun, cliPath, runId: s.runId, stateDir })],
        });
        if (collect.exitCode !== 0) {
          jobOutcomes.set(jobId, {
            jobId,
            kind,
            outcome: "refused",
            runId: s.runId,
            reason: "collect failed for " + s.runId + ": " + (collect.stdout ?? "").trim().slice(0, 200),
          });
          continue;
        }
        let parsed: { tooBig: false; result: JsonObject } | { tooBig: true; bytes: number };
        try {
          parsed = parseCollectedResult(collect.stdout, s.runId);
        } catch (e) {
          jobOutcomes.set(jobId, {
            jobId,
            kind,
            outcome: "refused",
            runId: s.runId,
            reason: "collected result for " + s.runId + " is malformed: " + (e as Error).message.slice(0, 200),
          });
          continue;
        }
        const filedHere: FiledItem[] = [];
        // An unfiled fileFirst item is recorded, not dropped:
        // the reason is carried into the final outcome below.
        // (A plain jobOutcomes.set inside the loop would be
        // overwritten by that final set — the reason must ride
        // the flag, not the map.)
        let fileFirstReason: string | null = null;
        if (!parsed.tooBig) {
          // File-first: a collected report carrying fileFirst
          // files its items in the same iteration.
          const ff = parsed.result.fileFirst;
          if (ff !== undefined && typeof ff === "object" && ff !== null && !Array.isArray(ff)) {
            const items = (ff as Record<string, unknown>).items;
            if (Array.isArray(items)) {
              // A plain for loop, not forEach: fileItem runs an
              // exec trap, and traps cannot suspend from inside a
              // native-builtin callback (the extractor refuses it).
              for (let idx = 0; idx < items.length; idx++) {
                const item = items[idx];
                if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
                const rec = item as Record<string, unknown>;
                if (typeof rec.title !== "string" || rec.title === "") {
                  fileFirstReason = "fileFirst item " + idx + " has no title — skipped";
                  continue;
                }
                if (run.backlogPath === undefined || run.backlogPath === "") {
                  fileFirstReason = "fileFirst item " + JSON.stringify(rec.title) + " unfiled — no backlogPath in the run input";
                  continue;
                }
                const filedItem = fileItem({ jobId, kind, itemIndex: idx, item: rec, recorded: now.slice(0, 10) });
                if (filedItem !== null) {
                  filed.push(filedItem);
                  filedHere.push(filedItem);
                } else {
                  fileFirstReason = "fileFirst item " + JSON.stringify(rec.title) + " unfiled — entry over the filing bound or untitled";
                }
              }
            }
          }
        }
        const verdict =
          !parsed.tooBig && typeof parsed.result.verdict === "string" ? parsed.result.verdict : undefined;
        // The unfiled reason is recorded in notes as well as
        // on the job outcome (see the declaration of
        // unfiledNotes): a directly-submitted sub-run's outcome
        // never reaches the report's jobs list.
        if (fileFirstReason !== null) unfiledNotes.push(jobId + ": " + fileFirstReason);
        collectedByRunId.set(s.runId, {
          jobId,
          kind,
          runId: s.runId,
          verdict,
          result: parsed.tooBig ? null : parsed.result,
          resultTruncated: parsed.tooBig,
          filed: filedHere,
        });
        collectedRunIds.add(s.runId);
        jobOutcomes.set(jobId, {
          jobId,
          kind,
          outcome: "collected",
          runId: s.runId,
          ...(fileFirstReason !== null ? { reason: fileFirstReason } : {}),
        });
        lastReportAt = now;
      }
    }

    // 1e. Claim (pure).
    const claim = claimJob(run.jobs, input.owner, claimedIds, waitingKinds(), collectedJobIds());
    otherOwnerCount += claim.otherOwnerCount;
    for (const s of claim.skipped) {
      if (!skippedByJobId.has(s.jobId)) skippedByJobId.set(s.jobId, s);
    }

    // 1f. Periodic due this iteration (pure, using now).
    const duePeriodic: Array<{ job: LoopJob; tableEntry: DispatchTableEntry }> = [];
    const alreadyCollected = collectedJobIds();
    for (const p of run.periodic ?? []) {
      if (periodicDone.has(p.workflow)) continue;
      if (alreadyCollected.has("periodic-" + p.workflow)) continue;
      if (!isCronDue(p.cron, now)) continue;
      const entry = run.dispatchTable[p.workflow];
      if (entry === undefined) {
        skippedByJobId.set("periodic-" + p.workflow, {
          jobId: "periodic-" + p.workflow,
          kind: p.workflow,
          reason: "no dispatch-table entry for periodic workflow " + p.workflow,
        });
        continue;
      }
      const job: LoopJob = {
        jobId: "periodic-" + p.workflow,
        kind: p.workflow,
        owner: input.owner,
        bucket: "ready",
        fields: p.fields ?? {},
      };
      duePeriodic.push({ job, tableEntry: entry });
    }

    // 1g. Parked iteration: nothing claimed, nothing periodic
    // due. Cheap reads + liveness + sleep when another
    // iteration will follow.
    if (claim.claimed === null && duePeriodic.length === 0) {
      const tail = exec({ cmd: "/bin/sh", args: ["-c", ledgerTailScript(stateDir)] });
      const ledgerTail = tail.exitCode === 0 ? parseLedgerTail(tail.stdout) : [];
      let healthOk = false;
      let healthNote = "no serverUrl in the run input — health step skipped";
      if (typeof run.serverUrl === "string" && run.serverUrl !== "") {
        const h = exec({ cmd: "/bin/sh", args: ["-c", healthScript(run.serverUrl)] });
        healthOk = h.exitCode === 0 && parseHealth(h.stdout);
        healthNote = healthOk ? "server /health ok" : "server /health did not answer ok";
      }
      parked = {
        iterations: parkedIterations + 1,
        ledgerTail,
        queueDepth,
        healthOk,
        healthNote,
      };
      parkedIterations++;
      writeLiveness(now);
      iterations++;
      if (maxIterations === undefined || iterations < maxIterations) {
        sleep({ ms: Math.round(parkSeconds * 1000) });
      }
      continue;
    }

    // 1h. Dispatch + submit each work item (claimed job first,
    // then due periodic as synthetic jobs).
    const workItems: Array<{ job: LoopJob; tableEntry: DispatchTableEntry }> = [];
    if (claim.claimed !== null) {
      const entry = run.dispatchTable[claim.claimed.kind];
      if (entry === undefined) {
        // A refused job is claimed for this run: without the
        // mark the claim step re-claims it every iteration and
        // the loop never reaches the next job.
        claimedIds.add(claim.claimed.jobId);
        jobOutcomes.set(claim.claimed.jobId, {
          jobId: claim.claimed.jobId,
          kind: claim.claimed.kind,
          outcome: "refused",
          reason: "no dispatch-table entry for kind " + claim.claimed.kind,
        });
      } else {
        workItems.push({ job: claim.claimed, tableEntry: entry });
      }
    }
    for (const d of duePeriodic) workItems.push(d);
    for (const item of workItems) {
      const { job, tableEntry } = item;
      claimedIds.add(job.jobId);
      lastClaimAt = now;
      lastClaimJobId = job.jobId;
      jobsClaimed++;
      // Dispatch in-run: dispatch's switch is the single
      // source of truth. Check its resolution against the
      // table's declared workflow — fail the JOB loudly on a
      // mismatch, never the whole loop run.
      const dispatchInput = buildDispatchInput({
        loopId: run.loopId,
        job,
        tableEntry,
        project: input.project,
        workDir,
        stateDir,
        owner: input.owner,
        launchedBy: input.launchedBy,
        dryRun,
        runId: run.runId,
        bunPath: run.bunPath,
      });
      let dispatchReport;
      try {
        dispatchReport = dispatchTasks(dispatchInput);
      } catch (e) {
        jobOutcomes.set(job.jobId, {
          jobId: job.jobId,
          kind: job.kind,
          outcome: "refused",
          reason: "dispatch threw for " + job.jobId + ": " + (e as Error).message.slice(0, 200),
        });
        continue;
      }
      if (dispatchReport.routed.length === 0) {
        const reason =
          dispatchReport.refused.length > 0
            ? dispatchReport.refused[0].reason
            : "dispatch routed nothing for " + job.jobId;
        jobOutcomes.set(job.jobId, { jobId: job.jobId, kind: job.kind, outcome: "refused", reason });
        continue;
      }
      const routed = dispatchReport.routed[0];
      if (routed.workflow !== tableEntry.workflow) {
        jobOutcomes.set(job.jobId, {
          jobId: job.jobId,
          kind: job.kind,
          outcome: "refused",
          workflow: routed.workflow,
          reason:
            "dispatch mismatch: table expects " +
            tableEntry.workflow +
            " for kind " +
            job.kind +
            ", dispatch resolved " +
            routed.workflow,
        });
        continue;
      }
      if (dryRun) {
        jobOutcomes.set(job.jobId, {
          jobId: job.jobId,
          kind: job.kind,
          outcome: "planned",
          workflow: routed.workflow,
          reason: "dry-run: would submit " + routed.workflow,
        });
        if (job.jobId.startsWith("periodic-")) periodicDone.add(job.kind);
        continue;
      }
      // Submit through the scheduler: one CLI trap, extracting
      // the routed input from dispatch's handoff file. The
      // submit is idempotent on the runId.
      const subRunId = run.loopId + "-" + job.jobId;
      const submit = exec({
        cmd: "/bin/sh",
        args: [
          "-c",
          submitScript({
            bunPath: bun,
            cliPath,
            workflowAbs: input.project.repo + "/" + routed.workflow,
            runId: subRunId,
            handoffPath: dispatchInput.run.handoffPath,
            routedIndex: 0,
            inputFile: workDir + "/routed-" + job.jobId + ".json",
            stateDir,
            owner: job.owner,
            launchedBy: run.loopId,
          }),
        ],
      });
      if (submit.exitCode !== 0) {
        jobOutcomes.set(job.jobId, {
          jobId: job.jobId,
          kind: job.kind,
          outcome: "refused",
          workflow: routed.workflow,
          reason: "submit failed for " + job.jobId + ": " + (submit.stdout ?? "").trim().slice(0, 200),
        });
        continue;
      }
      let submitParsed: { status: "submitted" | "already-submitted"; runId: string };
      try {
        submitParsed = parseSubmitOutput(submit.stdout, subRunId);
      } catch (e) {
        jobOutcomes.set(job.jobId, {
          jobId: job.jobId,
          kind: job.kind,
          outcome: "refused",
          workflow: routed.workflow,
          reason: "submit output did not confirm " + subRunId + ": " + (e as Error).message.slice(0, 200),
        });
        continue;
      }
      submittedByRunId.set(subRunId, {
        jobId: job.jobId,
        kind: job.kind,
        runId: subRunId,
        workflow: routed.workflow,
        alreadySubmitted: submitParsed.status === "already-submitted",
      });
      jobOutcomes.set(job.jobId, {
        jobId: job.jobId,
        kind: job.kind,
        outcome: "pending",
        runId: subRunId,
        workflow: routed.workflow,
      });
      if (job.jobId.startsWith("periodic-")) periodicDone.add(job.kind);
    }

    // 1i. Liveness after this iteration's work.
    writeLiveness(now);
    iterations++;
  }

  // 2. Report. The verdict is evidence, NOT acceptance.
  const jobsOrdered: JobOutcome[] = [];
  for (const job of run.jobs) {
    const o = jobOutcomes.get(job.jobId);
    if (o !== undefined) jobsOrdered.push(o);
  }
  // Periodic synthetic jobs are not in run.jobs; append their
  // outcomes after the claimed jobs.
  for (const [jobId, o] of jobOutcomes) {
    if (jobId.startsWith("periodic-") && !jobsOrdered.some((j) => j.jobId === jobId)) {
      jobsOrdered.push(o);
    }
  }
  const claimedCount = [...jobOutcomes.values()].filter((o) => o.outcome !== "skipped").length;
  const failedCount = [...jobOutcomes.values()].filter((o) => o.outcome === "refused").length;
  let verdict: "completed" | "failed" | "dry-run" = "completed";
  if (dryRun) verdict = "dry-run";
  else if (claimedCount > 0 && failedCount === claimedCount) verdict = "failed";
  const extraNotes: string[] = [];
  if (otherOwnerCount > 0) {
    extraNotes.push(otherOwnerCount + " job(s) in the input belonged to other owners — counted, not claimed");
  }
  extraNotes.push(...unfiledNotes);
  return buildLeadLoopReport({
    loopId: run.loopId,
    role: run.role,
    verdict,
    dryRun,
    owner: input.owner,
    launchedBy: input.launchedBy,
    cancelChecked,
    cancelled,
    iterations,
    jobs: jobsOrdered,
    submitted: [...submittedByRunId.values()],
    collected: [...collectedByRunId.values()],
    filed,
    skipped: [...skippedByJobId.values()],
    pendingDecides,
    periodicRunsDone: [...periodicDone],
    parked,
    livenessPath: dryRun ? "" : livenessPath,
    queueDepth,
    extraNotes,
  });
}
