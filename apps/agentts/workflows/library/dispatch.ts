// dispatch — match task kinds to the workflows that run them (BRA-176).
//
// The router between the queue and the execution mechanism. It takes
// a list of tasks to route and matches each one's kind to the workflow
// that runs it. It is routing, not execution: it chooses nothing about
// how the work is done (that is the scheduler's job), and it never
// assigns ownership to a session that does not loop.
//
// Settled semantics (BRA-176 issue + Brandon's Nov 19 comments +
// the set design §5):
//
// - The switch key is the triage tag. The tag IS the task kind the
//   switch reads — no separate mapping table, no registry. The tag
//   scheme builds on / subsumes admittance's `workflow:<name>`
//   label: the tag names the workflow (the bare name after the
//   optional `workflow:` prefix), and the switch resolves it against
//   the library inventory. A tag naming a workflow that does not
//   exist in the library refuses loudly with needs-workflow
//   semantics (never silent, nothing routed for that task).
// - Where kind comes from: kind is a property of the TASK — its
//   triage tag — supplied per task in dispatch's input. It is NOT
//   derived from a ranked-queue row: the queue items carry no kind
//   field, and no field on them soundly determines kind (bucket is
//   readiness, codeArea is location, priority is urgency, issueId
//   would be a lookup table). The caller that builds dispatch's
//   input (the role-loop, once it exists; a driver until then)
//   reads the task's tag and supplies it. The pure helper is the
//   switch resolution `resolveWorkflow(tag)` — tag → workflow,
//   unit-tested for every kind. The mapping lives in the workflow
//   as an explicit switch (Brandon's Q5 decision: the mapping IS a
//   workflow). That switch is NOT a project-specific branch under
//   mechanics §4: its cases name SHARED library workflows only,
//   which exist in every project using the library; project-specific
//   values arrive through the input (the project config + the
//   task's fields). A project needing a project-only workflow
//   routed writes a WRAPPER in its own repo (mechanics §4
//   mechanism 2), never a branch in the library switch.
// - Dispatch does NOT submit runs and does NOT call sub-workflows
//   in-run (set design §5: "Steps: match kind → workflow +
//   run-input JSON; hand to the scheduler. Output: the dispatched
//   workflow reference + input."). Dispatch MATCHES and HANDS OFF.
//   The scheduler (BRA-160) owns submission/assignment; dispatch
//   submitting directly would bypass it and blur the boundary the
//   set design draws ("dispatch maps kind → workflow; BRA-160 picks
//   the per-cycle worker set... Dispatch does not rank, and the
//   scheduler does not map kinds"). Dispatch's output is the routing
//   handoff: a JSON file naming, per task, the workflow + the
//   run-input JSON + the owner, which the scheduler consumes. No
//   queue entries are created by dispatch; no CLI submit is invoked.
//   (Quality's no-submit check: after a dispatch run, real or dry-run,
//   the queue is byte-identical — dispatch creates no queue entries
//   and enqueues no jobs anywhere. The §D cases assert it.)
// - The handoff file is written atomically (temp file + rename)
//   and read back, and the write trap returns only a one-line
//   summary — never the routing table. The handoff JSON can exceed
//   the ~60KB trap cap (at ~300 tasks the full table approaches
//   it) and the ~128KB single-argv cap, so it is written in
//   base64 chunks (one small append trap per chunk) and finalized
//   by a rename + read-back trap. The report is the workflow's
//   return value (the host delivers it as the run result); the
//   handoff file is the durable artifact the scheduler consumes.
// - Ownership guard (BRA-211 + BRA-160 comment 9801fe71): the
//   owner for each routed task comes from the assignment the caller
//   supplies (`run.assignments`: task id -> owning session).
//   Dispatch carries the assignment through; it never invents an
//   owner. A task with no assignment refuses loudly (nothing routed
//   for it, the reason named). The assigned owner must be a looping
//   session per the project's roster (the roster in the two-layer
//   input's project object) — an assignment naming a session that
//   is not in the roster refuses loudly; dispatch never silently
//   re-derives the owner to the driving session (the driving
//   session is the dispatch run's own owner, not the task's owner).
// - Bucket guard: dispatch routes READY tasks only. A gated,
//   blocked, or parked task is NOT routed as ready — it appears in
//   `refused` with the reason named (`gated`, `blocked`, `parked`).
//   The input carries `bucket` per task.
// - Order: dispatch processes tasks in input order and never
//   re-sorts. The input order IS the queue rank order (the caller
//   passes tasks in rank order); the report preserves input order.
// - Scope of v0: dispatch routes TASK kinds — the recurring fleet
//   operations, named by triage tag. It does NOT route Linear
//   backlog issues to leads — that is the role-loop's job, which is
//   unbuilt. The owner-assignment guard is what keeps that boundary
//   clean.
//
// The workflow's steps (exec traps, direct adapter):
//
// 0. Validate the input (pure): project + run fields present, owner
//    present (never assume launcher == owner), tasks a non-empty
//    array with unique taskIds, assignments an object, every task
//    carrying a valid bucket. Any failure refuses the run, writing
//    nothing.
// 1. Cancel check (when runId is present): read the run's status
//    from queue.json in stateDir in-shell and refuse, writing
//    nothing, when it is cancelled — check-then-act before the
//    write step. When runId is absent the check is skipped
//    (cancelChecked false). The cancelled-status refusal reports
//    cancelChecked true + cancelled true; a check that cannot
//    complete (no queue entry / unparsable queue) refuses with
//    cancelChecked false — the `refused` helper reads the live
//    flag (the triage lesson).
// 2. Route (pure, in input order): for each task, the bucket guard,
//    the assignment guard, the roster guard, the tag resolution,
//    and the switch case — each producing a routed entry or a
//    per-task refusal with the reason named. Nothing is written in
//    this step.
// 3. Write the handoff (exec traps, unless dry-run): the handoff
//    JSON is written in base64 chunks (one append trap per chunk)
//    and finalized by a rename + read-back trap that returns one
//    `WROTE <bytes> <path>` line. In dry-run mode nothing is
//    written.
// 4. Produce a dispatch report. The verdict is evidence, NOT
//    acceptance: "dispatched" means at least one task was routed;
//    "dry-run" means the plan is clean and nothing was written;
//    "failed" means nothing was routed (the reasons are in
//    refused[] + notes).
//
// Known v0 limits, carried verbatim in every report:
//
// - The case list covers only the workflows routable from a task's
//   fields; a workflow whose input cannot be constructed from a
//   task's fields is refused as needs-workflow, with the reason
//   named.
// - Linear backlog issues are not routed (role-loop, unbuilt);
//   dispatch routes task kinds only.
// - Kind is supplied per task by the caller (the ranked queue
//   carries no kind field — triage emitting one is a follow-up,
//   recorded in BACKLOG.md); dispatch hands the routing to the
//   scheduler and does not submit runs.
// - The handoff names the workflow; dispatch does not verify the
//   workflow file exists — the scheduler refuses loudly at submit
//   time if it is absent.

import { exec } from "../../src/agentts";
import { cancelCheckScript, parseRunStatus, shellQuote } from "./triage";

/** Default bun binary. */
export const DISPATCH_BUN_PATH = "/opt/hatch-image/bin/bun";

/** A JSON value — the concrete type for free-form JSON in the
 * entry's input/output (the checker cannot validate `unknown`).
 * Recursive: objects, arrays, and scalars. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** One task to route: its id, its triage tag (the switch key), its
 * readiness bucket, and the fields its workflow's input is
 * constructed from. The fields are free-form JSON; each switch case
 * validates the fields it needs and refuses the task
 * (needs-workflow) when one is missing. */
export interface DispatchTask {
  taskId: string;
  tag: string;
  /** Readiness bucket, as triaged. Only "ready" tasks route. */
  bucket: "ready" | "gated" | "blocked" | "parked";
  fields: Record<string, JsonValue>;
}

/** Per-project config (mechanics §3 — the same shape for every
 * lead workflow). The workflow never reads agentts.project.json
 * itself; the launcher inlines it here. The roster values are the
 * looping sessions (leads) — an assigned owner must be one of them. */
export interface DispatchProjectConfig {
  /** Linear project id/key (e.g. "P-BRA-2"). */
  linearProject: string;
  /** Absolute path of the project's repo (the live tree). */
  repo: string;
  /** Absolute path of the project's AgentTS state dir. */
  stateDir: string;
  /** Lead roster: role -> chat/session id. */
  roster: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by dispatch
   * v0 — carried for the set). */
  thresholds?: Record<string, number>;
}

/** Per-run dispatch input (the workflow's own contract). */
export interface DispatchRunInput {
  /** e.g. "BRA-176-DISPATCH-2026-11-21". */
  dispatchId: string;
  /** The tasks to route, in input (rank) order. Never re-sorted. */
  tasks: DispatchTask[];
  /** Task id -> owning session for the routed task. Dispatch
   * carries the assignment through; it never invents an owner. */
  assignments: Record<string, string>;
  /** Routing handoff JSON output path (atomic write + read-back). */
  handoffPath: string;
  /** State dir the cancel check reads (project.stateDir is the same
   * value in practice; run.stateDir is the workflow's own field). */
  stateDir: string;
  /** Absolute scratch dir (work files). Created by the workflow. */
  workDir: string;
  /** bun binary (default /opt/hatch-image/bin/bun). */
  bunPath?: string;
  /** Plan the routing but write nothing (default false). */
  dryRun?: boolean;
  /** The run's own id — when present, the workflow checks the run's
   * cancelled flag in stateDir/queue.json before routing. */
  runId?: string;
}

/** Input to the dispatch workflow (two layers, mechanics §3). */
export interface DispatchInput {
  project: DispatchProjectConfig;
  run: DispatchRunInput;
  /** Launching session (provenance). */
  launchedBy?: string;
  /** Owning session — the session that executes and drives the
   * dispatch run. Required: never assume launcher == owner. */
  owner: string;
}

/** One routed task: what it routes to, with the input the scheduler
 * submits verbatim. */
export interface RoutedTask {
  taskId: string;
  tag: string;
  bucket: "ready";
  /** Repo-relative workflow file, e.g. "apps/agentts/workflows/library/triage.ts". */
  workflow: string;
  /** The routed run's full two-layer input JSON (project + run +
   * launchedBy + owner), as the scheduler submits it. */
  input: JsonObject;
  /** The owning session the task is routed with (from the assignment). */
  owner: string;
}

/** One refused task: the task, and why nothing was routed for it. */
export interface RefusedTask {
  taskId: string;
  tag: string;
  reason: string;
}

/** The routing handoff file: what the scheduler consumes. */
export interface DispatchHandoff {
  dispatchId: string;
  routed: RoutedTask[];
  refused: RefusedTask[];
}

/** The dispatch report — the workflow's output. */
export interface DispatchReport {
  dispatchId: string;
  /** "dispatched" means at least one task was routed; "dry-run"
   * means the plan is clean and nothing was written; "failed"
   * means nothing was routed (the reasons are in refused[] +
   * notes). None of these is acceptance. */
  verdict: string;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  /** The cancelled flag was checked before the routing step. */
  cancelChecked: boolean;
  /** The run was cancelled when checked. */
  cancelled: boolean;
  routed: RoutedTask[];
  refused: RefusedTask[];
  /** The routing handoff file path (written, unless dry-run). */
  handoffPath: string;
  /** The known v0 limits, carried verbatim in every report. */
  knownLimit: string;
  /** Every refusal reason, named. Empty when all tasks routed. */
  notes: string[];
}

export const DISPATCH_KNOWN_LIMIT =
  "v0 limit: the case list covers only the workflows routable from a task's fields - a workflow whose input cannot be constructed from a task's fields is refused as needs-workflow, with the reason named; Linear backlog issues are not routed (role-loop, unbuilt) - dispatch routes task kinds only; kind is supplied per task by the caller (the ranked queue carries no kind field - triage emitting one is a follow-up, recorded in BACKLOG.md) - dispatch hands the routing to the scheduler and does not submit runs; the handoff names the workflow - dispatch does not verify the workflow file exists - the scheduler refuses loudly at submit time if it is absent.";

/** The workflows the switch can route, in case order. This literal
 * is the case list for the test to enumerate; the switch in
 * buildRouting is the authority, and the two must agree (the §D
 * case D1 routes every entry here). */
export const ROUTABLE_WORKFLOWS = [
  "hello",
  "triage",
  "breakdown",
  "dependency-mapping",
  "daily-feed",
  "scheduler",
  "worker-lifecycle",
  "merge",
  "verify-fix",
  "gc",
] as const;

/** Resolve a triage tag to the bare workflow name it names. The tag
 * is either the bare name ("triage") or admittance's
 * `workflow:<name>` label form ("workflow:triage") — the tag scheme
 * builds on / subsumes the label. Returns null when the tag names
 * nothing usable (empty, or a bare name with characters a workflow
 * file cannot have). Pure — unit-tested directly for every kind. */
export function resolveWorkflow(tag: string): string | null {
  const bare = tag.startsWith("workflow:") ? tag.slice("workflow:".length) : tag;
  if (bare === "" || !/^[a-z][a-z0-9-]*$/.test(bare)) return null;
  return bare;
}

/** Require a string field from a task's fields. Throws the
 * needs-workflow refusal for the task when it is missing. Pure. */
export function reqString(fields: Record<string, unknown>, name: string, workflow: string): string {
  const v = fields[name];
  if (typeof v !== "string" || v === "") {
    throw new Error("needs-workflow: " + workflow + " needs " + name + " string in the task fields");
  }
  return v;
}

/** Require a string-array field from a task's fields. Throws the
 * needs-workflow refusal for the task when it is missing. Pure. */
export function reqStringArray(fields: Record<string, unknown>, name: string, workflow: string): string[] {
  const v = fields[name];
  if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
    throw new Error("needs-workflow: " + workflow + " needs " + name + " string array in the task fields");
  }
  return v as string[];
}

/** Require an object field from a task's fields. Throws the
 * needs-workflow refusal for the task when it is missing. Pure. */
export function reqObject(fields: Record<string, unknown>, name: string, workflow: string): Record<string, unknown> {
  const v = fields[name];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("needs-workflow: " + workflow + " needs " + name + " object in the task fields");
  }
  return v as Record<string, unknown>;
}

/** Require an array field from a task's fields. Throws the
 * needs-workflow refusal for the task when it is missing. Pure. */
export function reqArray(fields: Record<string, unknown>, name: string, workflow: string): unknown[] {
  const v = fields[name];
  if (!Array.isArray(v)) {
    throw new Error("needs-workflow: " + workflow + " needs " + name + " array in the task fields");
  }
  return v;
}

/** Optional string field: the value when present and a string,
 * undefined otherwise. Pure. */
export function optString(fields: Record<string, unknown>, name: string): string | undefined {
  const v = fields[name];
  return typeof v === "string" ? v : undefined;
}

/** Optional boolean field: the value when present and a boolean,
 * undefined otherwise. Pure. */
export function optBoolean(fields: Record<string, unknown>, name: string): boolean | undefined {
  const v = fields[name];
  return typeof v === "boolean" ? v : undefined;
}

/** Optional number field: the value when present and a number,
 * undefined otherwise. Pure. */
export function optNumber(fields: Record<string, unknown>, name: string): number | undefined {
  const v = fields[name];
  return typeof v === "number" ? v : undefined;
}

/** The run-input JSON for a routed workflow: the workflow's own
 * two-layer input. `run` is built per workflow by the switch cases
 * below; `project` is the dispatch input's project, passed through
 * verbatim (project-specific values arrive through the input). The
 * casts are sound by construction: `project` is a plain JSON
 * object, and every `run` value is built from the task's JSON
 * fields plus derived strings — nothing non-JSON ever enters. */
export interface RoutedInputSpec {
  project: DispatchProjectConfig;
  run: JsonObject;
  launchedBy?: string;
  owner: string;
}

/** Build the routing for one task: resolve its tag, run the switch
 * case for the workflow it names, and construct that workflow's
 * run-input JSON from the task's fields. Returns the routed entry.
 * Throws the needs-workflow refusal (as an Error carrying the
 * reason) when the tag names no workflow or the case's required
 * fields are missing. Pure — the switch, unit-tested per case.
 *
 * Ids derive from `<dispatchId>-<taskId>` and workDirs from the
 * dispatch workDir unless the task's fields override them. */
export function buildRouting(
  task: DispatchTask,
  dispatchId: string,
  project: DispatchProjectConfig,
  workDir: string,
  owner: string,
  launchedBy?: string,
): RoutedTask {
  const name = resolveWorkflow(task.tag);
  if (name === null) {
    throw new Error("needs-workflow: tag " + JSON.stringify(task.tag) + " names no workflow");
  }
  const f = task.fields;
  const baseRunId = dispatchId + "-" + task.taskId;
  // The workflow's own work dir under the dispatch work dir.
  const taskWorkDir = workDir + "/" + task.taskId;
  // The project object, picked per case. The target workflows'
  // project configs are NOT uniform — mapping's requires
  // workDir + resumeDir, while triage / scheduler /
  // worker-lifecycle / gc forbid additional properties — so a
  // single pass-through project can never satisfy both: a
  // project carrying workDir is refused by worker-lifecycle,
  // a project without it is refused by mapping. Each case
  // therefore picks exactly the fields its target's
  // ProjectConfig allows. The caller supplies the union (the
  // loop's project carries workDir + resumeDir); the pick
  // drops what the target forbids and keeps what it requires.
  // Fixed by the lead-loop build (Nov 21, 2026): the loop is
  // the first consumer that submits a routed worker-lifecycle
  // run, and the submit was refused on the extra fields until
  // the pick landed.
  const pickProject = (extra: string[]): JsonObject => {
    const out: Record<string, unknown> = {
      linearProject: project.linearProject,
      repo: project.repo,
      stateDir: project.stateDir,
      roster: project.roster,
    };
    if (project.thresholds !== undefined) out.thresholds = project.thresholds;
    for (const key of extra) {
      const v = (project as unknown as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = v;
    }
    return out as JsonObject;
  };
  // The base pick: the fields every two-layer target allows.
  const baseProject = pickProject([]);
  // The run-input skeleton shared by every case: the two-layer
  // input the scheduler submits verbatim. The casts are sound by
  // construction (see RoutedInputSpec): the value is JSON.
  // The project is the case's pick, never the caller's object
  // verbatim — see pickProject above.
  const spec = (run: Record<string, unknown>, proj: JsonObject = baseProject): JsonObject => {
    const out: JsonObject = {
      project: proj,
      run: run as unknown as JsonObject,
      owner,
    };
    if (launchedBy !== undefined) out.launchedBy = launchedBy;
    return out;
  };
  // File path helper: the repo-relative workflow file.
  const file = (n: string) => "apps/agentts/workflows/library/" + n + ".ts";

  switch (name) {
    case "hello": {
      // Hello is the one routable workflow whose input is NOT
      // two-layer: HelloInput is flat ({name}). The routed input
      // is the target workflow's run-input JSON as that workflow
      // takes it — flat here, two-layer for the lead workflows
      // below. The assigned owner still rides on the routed entry
      // itself (routing metadata), not in hello's input.
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("hello"), input: { name: optString(f, "name") ?? "world" }, owner };
    }
    case "triage": {
      const run: Record<string, unknown> = {
        goalDir: reqString(f, "goalDir", "triage"),
        queuePath: reqString(f, "queuePath", "triage"),
        driftNotePath: reqString(f, "driftNotePath", "triage"),
        stableQueuePath: reqString(f, "stableQueuePath", "triage"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      const limit = optNumber(f, "limit");
      if (limit !== undefined) run.limit = limit;
      const wontFix = optString(f, "wontFix");
      if (wontFix !== undefined) run.wontFix = wontFix;
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("triage"), input: spec(run), owner };
    }
    case "breakdown": {
      const run: Record<string, unknown> = {
        issueId: reqString(f, "issueId", "breakdown"),
        plannedTasks: reqArray(f, "plannedTasks", "breakdown"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("breakdown"), input: spec(run), owner };
    }
    case "dependency-mapping": {
      const run: Record<string, unknown> = {
        // MappingRunInput requires mappingId; workDir is NOT a
        // MappingRunInput field (the workflow reads
        // project.workDir) — a routed input carrying it is
        // refused at the CLI schema gate. Fixed by the lead-loop
        // build (Nov 21, 2026): the loop is the first consumer
        // that submits a routed mapping run, and the submit was
        // refused until mappingId was supplied and workDir
        // dropped. See the BACKLOG.md follow-up for the same
        // audit on the other cases.
        mappingId: optString(f, "mappingId") ?? baseRunId,
        queuePath: reqString(f, "queuePath", "dependency-mapping"),
        goalPath: reqString(f, "goalPath", "dependency-mapping"),
        graphPath: reqString(f, "graphPath", "dependency-mapping"),
        datedGraphPath: reqString(f, "datedGraphPath", "dependency-mapping"),
        runId: optString(f, "runId") ?? baseRunId,
        dryRun: optBoolean(f, "dryRun"),
      };
      // Mapping's project config requires workDir + resumeDir —
      // the only two-layer target that does — so its case picks
      // the full project; every other case uses the base pick.
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("dependency-mapping"), input: spec(run, pickProject(["workDir", "resumeDir"])), owner };
    }
    case "daily-feed": {
      const run: Record<string, unknown> = {
        queuePath: reqString(f, "queuePath", "daily-feed"),
        graphPath: reqString(f, "graphPath", "daily-feed"),
        goalPath: reqString(f, "goalPath", "daily-feed"),
        feedPath: reqString(f, "feedPath", "daily-feed"),
        datedFeedPath: reqString(f, "datedFeedPath", "daily-feed"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("daily-feed"), input: spec(run), owner };
    }
    case "scheduler": {
      const run: Record<string, unknown> = {
        targetRunId: reqString(f, "targetRunId", "scheduler"),
        newOwner: reqString(f, "newOwner", "scheduler"),
        serverUrl: reqString(f, "serverUrl", "scheduler"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("scheduler"), input: spec(run), owner };
    }
    case "worker-lifecycle": {
      const operation = reqString(f, "operation", "worker-lifecycle");
      if (operation !== "register" && operation !== "list" && operation !== "close") {
        throw new Error("needs-workflow: worker-lifecycle needs operation register|list|close, got " + JSON.stringify(operation));
      }
      const run: Record<string, unknown> = {
        // WorkerLifecycleRunInput requires lifecycleId. Fixed by
        // the lead-loop build (Nov 21, 2026) alongside the
        // dependency-mapping case — same cause (the loop is the
        // first consumer that submits a routed run). See the
        // BACKLOG.md follow-up for the same audit on the other
        // cases.
        lifecycleId: optString(f, "lifecycleId") ?? baseRunId,
        operation,
        serverUrl: reqString(f, "serverUrl", "worker-lifecycle"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      if (operation === "register") {
        run.workerId = reqString(f, "workerId", "worker-lifecycle");
        run.ownerSession = reqString(f, "ownerSession", "worker-lifecycle");
      }
      if (operation === "close") {
        run.workerId = reqString(f, "workerId", "worker-lifecycle");
      }
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("worker-lifecycle"), input: spec(run), owner };
    }
    case "merge": {
      const run: Record<string, unknown> = {
        copyRoot: reqString(f, "copyRoot", "merge"),
        liveRoot: reqString(f, "liveRoot", "merge"),
        claimedFiles: reqStringArray(f, "claimedFiles", "merge"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("merge"), input: spec(run), owner };
    }
    case "verify-fix": {
      const run: Record<string, unknown> = {
        repoRoot: reqString(f, "repoRoot", "verify-fix"),
        directTests: reqStringArray(f, "directTests", "verify-fix"),
        claimedFiles: reqStringArray(f, "claimedFiles", "verify-fix"),
        changedFiles: reqStringArray(f, "changedFiles", "verify-fix"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("verify-fix"), input: spec(run), owner };
    }
    case "gc": {
      const run: Record<string, unknown> = {
        stateDir: reqString(f, "stateDir", "gc"),
        archiveDir: reqString(f, "archiveDir", "gc"),
        runId: optString(f, "runId") ?? baseRunId,
        workDir: optString(f, "workDir") ?? taskWorkDir,
        dryRun: optBoolean(f, "dryRun"),
      };
      return { taskId: task.taskId, tag: task.tag, bucket: "ready", workflow: file("gc"), input: spec(run), owner };
    }
    default:
      throw new Error("needs-workflow: no routable workflow " + JSON.stringify(name));
  }
}

/** The handoff JSON (what the scheduler consumes) for a routed +
 * refused set. Deterministic given the inputs: no timestamps. Pure. */
export function buildHandoff(dispatchId: string, routed: RoutedTask[], refused: RefusedTask[]): DispatchHandoff {
  return { dispatchId, routed, refused };
}

/** Base64 alphabet, used by the chunker. */
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode a string as base64 (UTF-8 bytes). Pure — the workflow
 * host has no Buffer/btoa, so the encoder is written out (the
 * decode side runs in-shell, `base64 -d`). */
export function base64EncodeUtf8(s: string): string {
  // UTF-8 encode to a byte array (surrogate pairs combined).
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

const B64_CHUNK_RAW = 24 * 1024; // 24KB raw -> 32KB base64 per chunk

/** Split a JSON string into base64 chunks small enough that the
 * trap script carrying one stays far under the ~128KB single-argv
 * cap. Pure. Returns the chunks in order. */
export function splitHandoffChunks(json: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += B64_CHUNK_RAW) {
    chunks.push(base64EncodeUtf8(json.slice(i, i + B64_CHUNK_RAW)));
  }
  return chunks;
}

/** The script for one chunk-append trap: append one base64 chunk
 * (decoded) to the temp handoff file, and print one `CHUNK <n>`
 * line. Pure. The chunk carries no shell metacharacters (base64
 * alphabet only), so it needs no quoting beyond the single quotes. */
export function appendChunkScript(chunkB64: string, index: number, tmpPath: string): string {
  return "printf '%s' '" + chunkB64 + "' | base64 -d >> " + shellQuote(tmpPath) + "\necho \"CHUNK " + index + "\"\n";
}

/** The finalize script: rename the temp handoff file onto the
 * handoff path (atomic), then read it back and verify it parses
 * and names this dispatchId with the expected routed/refused
 * counts. Prints one `WROTE <bytes> <path>` line. Pure.
 * Exit codes: 0 = wrote + verified; 1 = rename failed; 2 =
 * read-back failed. */
export function finalizeHandoffScript(
  tmpPath: string,
  handoffPath: string,
  dispatchId: string,
  routedCount: number,
  refusedCount: number,
): string {
  return (
    "mkdir -p \"$(dirname " +
    shellQuote(handoffPath) +
    ")\" || exit 1\n" +
    "mv " +
    shellQuote(tmpPath) +
    " " +
    shellQuote(handoffPath) +
    " || exit 1\n" +
    "python3 -c '\n" +
    "import json, sys\n" +
    "p = sys.argv[1]\n" +
    "d = json.load(open(p))\n" +
    "assert d[\"dispatchId\"] == sys.argv[2], \"dispatchId mismatch\"\n" +
    "assert len(d[\"routed\"]) == int(sys.argv[3]), \"routed count mismatch\"\n" +
    "assert len(d[\"refused\"]) == int(sys.argv[4]), \"refused count mismatch\"\n" +
    "print(\"OK\")\n" +
    "' " +
    shellQuote(handoffPath) +
    " " +
    shellQuote(dispatchId) +
    " " +
    String(routedCount) +
    " " +
    String(refusedCount) +
    " > /dev/null || exit 2\n" +
    "bytes=$(wc -c < " +
    shellQuote(handoffPath) +
    ")\n" +
    "printf 'WROTE %s %s\\n' \"$bytes\" " +
    shellQuote(handoffPath) +
    "\n"
  );
}

/** Parse the finalize trap's one-line summary: `WROTE <bytes>
 * <path>`. Throws when the trap printed anything else. Pure. */
export function parseWriteSummary(text: string): { bytes: number; path: string } {
  const line = text.trim().split("\n").filter((l) => l.trim() !== "").pop();
  const m = /^WROTE ([0-9]+) (.+)$/.exec(line ?? "");
  if (!m) throw new Error("unexpected write summary: " + JSON.stringify(text));
  return { bytes: Number(m[1]), path: m[2] };
}

/** Build the dispatch report for a routing outcome. The `cancelChecked`
 * value is taken as given — the workflow's `refused` helper passes
 * the LIVE flag, never a hardcoded false (the triage lesson). Pure. */
export function buildDispatchReport(input: DispatchInput, routed: RoutedTask[], refused: RefusedTask[], cancelChecked: boolean, cancelled: boolean): DispatchReport {
  const notes = refused.map((r) => r.taskId + ": " + r.reason);
  let verdict = "failed";
  if (routed.length > 0) verdict = input.run.dryRun ? "dry-run" : "dispatched";
  return {
    dispatchId: input.run.dispatchId,
    verdict,
    dryRun: input.run.dryRun ?? false,
    owner: input.owner,
    launchedBy: input.launchedBy,
    cancelChecked,
    cancelled,
    routed,
    refused,
    handoffPath: input.run.handoffPath,
    knownLimit: DISPATCH_KNOWN_LIMIT,
    notes,
  };
}

/** Dispatch workflow: match task kinds to the workflows that run
 * them, and write the routing handoff the scheduler consumes.
 * The handoff is the ONLY file this workflow writes (besides the
 * temp chunk file it renames into place); dispatch creates no queue
 * entries and submits nothing. The entry is a plain sync function
 * (the host driver calls it from global code). */
export default function dispatchTasks(input: DispatchInput): DispatchReport {
  const run = input.run;
  const workDir = run.workDir;
  const tmpHandoff = workDir + "/handoff.json.tmp";
  const dryRun = run.dryRun ?? false;
  // The cancel check flag, declared BEFORE the refused helper so the
  // helper reads the live value (the triage lesson: never hardcode
  // it false — when the check has not run, it is false; when it has
  // run, it is true).
  let cancelChecked = false;
  // The report's cancelled flag is set only by the cancel check.
  let cancelled = false;

  // refused() builds a failed report with the LIVE cancelChecked
  // value, used for every refusal path.
  const refusedReport = (notes: string[]): DispatchReport => ({
    dispatchId: run.dispatchId,
    verdict: "failed",
    dryRun,
    owner: input.owner,
    launchedBy: input.launchedBy,
    cancelChecked,
    cancelled,
    routed: [],
    refused: [],
    handoffPath: run.handoffPath,
    knownLimit: DISPATCH_KNOWN_LIMIT,
    notes,
  });

  // Step 0: mkdir the work dir (exec trap), then validate. A mkdir
  // failure is environmental — throw loudly. A validation failure
  // refuses the run with a failed report (the triage pattern:
  // refused(), never a throw for bad input).
  const mk = exec({ cmd: "/bin/sh", args: ["-c", "mkdir -p " + shellQuote(workDir)] });
  if (mk.exitCode !== 0) {
    throw new Error("dispatch: cannot create workDir " + workDir + " (rc " + mk.exitCode + ")");
  }

  if (!input.project || typeof input.project !== "object") {
    return refusedReport(["dispatch: input has no project object"]);
  }
  if (!run || typeof run !== "object") {
    return refusedReport(["dispatch: input has no run object"]);
  }
  if (typeof run.dispatchId !== "string" || run.dispatchId === "") {
    return refusedReport(["dispatch: run has no dispatchId string"]);
  }
  if (typeof input.owner !== "string" || input.owner === "") {
    return refusedReport(["dispatch: input has no owner string — the owner is the driving session, never assumed from the launcher"]);
  }
  if (typeof input.project.linearProject !== "string" || input.project.linearProject === "") {
    return refusedReport(["dispatch: project has no linearProject string"]);
  }
  if (typeof input.project.repo !== "string" || input.project.repo === "") {
    return refusedReport(["dispatch: project has no repo string"]);
  }
  if (typeof input.project.stateDir !== "string" || input.project.stateDir === "") {
    return refusedReport(["dispatch: project has no stateDir string"]);
  }
  if (!input.project.roster || typeof input.project.roster !== "object") {
    return refusedReport(["dispatch: project has no roster object"]);
  }
  if (!Array.isArray(run.tasks) || run.tasks.length === 0) {
    return refusedReport(["dispatch: run.tasks must be a non-empty array"]);
  }
  if (!run.assignments || typeof run.assignments !== "object" || Array.isArray(run.assignments)) {
    return refusedReport(["dispatch: run has no assignments object"]);
  }
  if (typeof run.handoffPath !== "string" || run.handoffPath === "") {
    return refusedReport(["dispatch: run has no handoffPath string"]);
  }
  if (typeof run.stateDir !== "string" || run.stateDir === "") {
    return refusedReport(["dispatch: run has no stateDir string"]);
  }
  const seenTaskIds = new Set<string>();
  const validBuckets = new Set(["ready", "gated", "blocked", "parked"]);
  for (const task of run.tasks) {
    if (typeof task.taskId !== "string" || task.taskId === "") {
      return refusedReport(["dispatch: every task needs a taskId string"]);
    }
    if (seenTaskIds.has(task.taskId)) {
      return refusedReport(["dispatch: duplicate taskId " + task.taskId]);
    }
    seenTaskIds.add(task.taskId);
    if (typeof task.tag !== "string" || task.tag === "") {
      return refusedReport(["dispatch: task " + task.taskId + " needs a tag string"]);
    }
    if (!validBuckets.has(task.bucket)) {
      return refusedReport(["dispatch: task " + task.taskId + " has an unknown bucket " + JSON.stringify(task.bucket)]);
    }
    if (!task.fields || typeof task.fields !== "object" || Array.isArray(task.fields)) {
      return refusedReport(["dispatch: task " + task.taskId + " needs a fields object"]);
    }
  }

  // Step 1: cancel check (when runId is present) — check-then-act
  // before any write. The check reads the run's status from
  // stateDir/queue.json, exactly as triage does. Exit 2 = no queue
  // entry for the run, exit 3 = queue.json missing/unparsable —
  // both refuse with cancelChecked false (the check did not
  // complete). A cancelled status refuses with cancelChecked true
  // + cancelled true.
  if (typeof run.runId === "string" && run.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(run.stateDir, run.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["cancel check: no queue entry for run " + run.runId]);
    }
    if (check.exitCode === 3) {
      return refusedReport(["cancel check: " + (check.stdout ?? "").trim().slice(0, 200)]);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "dispatch: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout);
    } catch (e) {
      throw new Error("dispatch: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["run " + run.runId + " is cancelled — no routing"]);
    }
  }

  // Step 2: route, in input order, never re-sorted. The roster
  // values are the looping sessions; an assigned owner must be one
  // of them.
  const rosterSessions = new Set(Object.values(input.project.roster));
  const routed: RoutedTask[] = [];
  const refused: RefusedTask[] = [];
  for (const task of run.tasks) {
    // Bucket guard: route READY tasks only.
    if (task.bucket !== "ready") {
      refused.push({ taskId: task.taskId, tag: task.tag, reason: task.bucket + " — not routed as ready" });
      continue;
    }
    // Assignment guard: dispatch never invents an owner.
    const taskOwner = run.assignments[task.taskId];
    if (typeof taskOwner !== "string" || taskOwner === "") {
      refused.push({ taskId: task.taskId, tag: task.tag, reason: "no assignment for task " + task.taskId });
      continue;
    }
    // Roster guard: the assigned owner must be a looping session.
    if (!rosterSessions.has(taskOwner)) {
      refused.push({
        taskId: task.taskId,
        tag: task.tag,
        reason: "owner " + taskOwner + " is not in the project roster — not a looping session",
      });
      continue;
    }
    // Tag resolution + switch case.
    try {
      routed.push(buildRouting(task, run.dispatchId, input.project, workDir, taskOwner, input.launchedBy));
    } catch (e) {
      refused.push({ taskId: task.taskId, tag: task.tag, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Dry-run: plan clean, write nothing.
  if (dryRun) {
    return buildDispatchReport(input, routed, refused, cancelChecked, cancelled);
  }

  // Step 3: write the handoff (atomic write + read-back), in
  // base64 chunks — one small append trap per chunk — then a
  // finalize trap that renames + verifies. Each trap returns one
  // line; the routing table never crosses a trap.
  const handoff = buildHandoff(run.dispatchId, routed, refused);
  const json = JSON.stringify(handoff, null, 2);
  const chunks = splitHandoffChunks(json);
  // Start clean: remove any stale temp file from an earlier run.
  exec({ cmd: "/bin/sh", args: ["-c", "rm -f " + shellQuote(tmpHandoff)] });
  for (let i = 0; i < chunks.length; i++) {
    const r = exec({ cmd: "/bin/sh", args: ["-c", appendChunkScript(chunks[i], i, tmpHandoff)] });
    const line = r.stdout.trim();
    if (line !== "CHUNK " + i) {
      throw new Error("handoff chunk " + i + " failed: " + JSON.stringify(r.stdout));
    }
  }
  const fin = exec({
    cmd: "/bin/sh",
    args: ["-c", finalizeHandoffScript(tmpHandoff, run.handoffPath, run.dispatchId, routed.length, refused.length)],
  });
  const summary = parseWriteSummary(fin.stdout);
  if (summary.path !== run.handoffPath) {
    throw new Error("handoff write path mismatch: " + summary.path + " != " + run.handoffPath);
  }

  // Step 4: the report.
  return buildDispatchReport(input, routed, refused, cancelChecked, cancelled);
}
