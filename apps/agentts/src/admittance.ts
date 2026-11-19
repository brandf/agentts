// admittance — layer 1 scheduling (BRA-49): which backlog tasks run.
//
// The backlog (Linear, possibly hundreds of tasks) is not the run
// queue. Admittance decides, in priority order and under a WIP
// limit, which tasks are admitted — each admitted task maps to a
// library workflow (or gets AgentTS code written for it) and starts
// as a workflow run carrying the taskId as its input. Every
// in-progress task carries its runId (written back through the
// task backend by the caller); admittance never re-admits a task
// that is already in flight, already queued in the host, or done.
//
// Pure logic: no I/O, no Linear, no host. The caller (CLI `admit`)
// supplies the backlog, the in-flight links, and the workflow map,
// and performs the side effects (setTaskRun + host enqueue) for the
// admitted set. Admission itself becoming a workflow is a someday
// idea — NOT now. (decisionCascade itself exists — BRA-47, in the
// agentts module — but admittance is still pure logic here.)
//
// Priority scale is Linear's: 1 urgent, 2 high, 3 medium, 4 low,
// 0 / absent = no priority, treated as medium (3) for ordering.
// Within a priority, tasks admit in task-id order (deterministic;
// Linear's list order is not a contract).

import type { Task } from "./task-backend";

export const DEFAULT_WIP_LIMIT = 3;
/** Waiting this long improves a task's effective priority by one
 * step (admittance aging — a stale medium eventually outranks a
 * fresh low). Capped at two steps; urgency never drops below 1. */
export const ADMIT_AGING_MS = 7 * 24 * 3_600_000;

export interface InFlightLink {
  taskId: string;
  runId: string;
  /** "linked" | "running" | "done" | "failed" | ... — a terminal
   * status frees the task for re-admission; anything else holds it. */
  status: string;
}

export interface AdmitConfig {
  /** Max runs in flight at once (admitted + already in flight). */
  wipLimit?: number;
  /** Explicit taskId -> workflow path map (library workflows). */
  workflowMap?: Record<string, string>;
  /** One workflow for every admitted task (overrides the map when set). */
  defaultWorkflow?: string;
  /** Workflows live under this dir; bare names resolve against it. */
  workflowsDir?: string;
}

export type AdmitOutcome =
  | { task: Task; outcome: "admitted"; workflow: string; runId: string }
  | { task: Task; outcome: "skipped"; reason: string };

export interface AdmitResult {
  admitted: Extract<AdmitOutcome, { outcome: "admitted" }>[];
  skipped: Extract<AdmitOutcome, { outcome: "skipped" }>[];
  /** Runs already in flight when admittance ran. */
  inFlight: number;
  /** Free WIP slots admittance had to fill. */
  freeSlots: number;
}

export function isTerminalLinkStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "completed";
}

/** Effective priority for ordering: Linear value, aged toward
 * urgent for tasks that have waited (createdAt is not on Task, so
 * the caller may pass a waitedMs hint; without it no aging). */
export function effectivePriority(task: Task, waitedMs?: number): number {
  const base = typeof task.priority === "number" && task.priority >= 1 && task.priority <= 4 ? task.priority : 3;
  if (!waitedMs || waitedMs <= 0) return base;
  const steps = Math.min(2, Math.floor(waitedMs / ADMIT_AGING_MS));
  return Math.max(1, base - steps);
}

/** Is this task a candidate at all? Done / cancelled / completed
 * tasks are not admitted (and never were — they are history). */
export function isAdmittableStatus(status: string): boolean {
  return !/done|cancelled|completed|archived/i.test(status ?? "");
}

/**
 * Resolve a task to a workflow path. Explicit map wins, then
 * --default-workflow, then a `workflow:<name>` label (bare name
 * resolves under workflowsDir, a path is used as-is). Returns null
 * when no workflow is known: that task needs AgentTS code written
 * for it first, so it is skipped with reason "needs-workflow"
 * instead of being admitted to nothing.
 */
export function resolveWorkflow(task: Task, config: AdmitConfig): string | null {
  if (config.workflowMap && typeof config.workflowMap[task.id] === "string") {
    return config.workflowMap[task.id];
  }
  if (config.defaultWorkflow) return config.defaultWorkflow;
  const label = (task.labels ?? []).find((l) => l.startsWith("workflow:"));
  if (label) {
    const name = label.slice("workflow:".length).trim();
    if (!name) return null;
    if (name.includes("/") || name.endsWith(".ts") || name.endsWith(".js")) return name;
    const dir = config.workflowsDir ?? "workflows/library";
    return `${dir}/${name}.ts`;
  }
  return null;
}

export function runIdForTask(taskId: string, nowMs: number): string {
  return `run-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${nowMs.toString(36)}`;
}

export function admitTasks(
  backlog: Task[],
  inFlight: InFlightLink[],
  config: AdmitConfig = {},
  nowMs: number = Date.now(),
): AdmitResult {
  const wipLimit = config.wipLimit ?? DEFAULT_WIP_LIMIT;
  const live = inFlight.filter((l) => !isTerminalLinkStatus(l.status));
  const liveIds = new Set(live.map((l) => l.taskId));
  const freeSlots = Math.max(0, wipLimit - live.length);

  const candidates = backlog
    .filter((t) => isAdmittableStatus(t.status))
    .filter((t) => !liveIds.has(t.id))
    .sort((a, b) => {
      const pa = effectivePriority(a);
      const pb = effectivePriority(b);
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const admitted: AdmitResult["admitted"] = [];
  const skipped: AdmitResult["skipped"] = [];
  let slots = freeSlots;
  for (const task of candidates) {
    if (slots <= 0) {
      skipped.push({ task, outcome: "skipped", reason: `WIP limit reached (${wipLimit} in flight)` });
      continue;
    }
    const workflow = resolveWorkflow(task, config);
    if (!workflow) {
      skipped.push({
        task,
        outcome: "skipped",
        reason: "needs-workflow: no workflow mapped for this task (map it with --map, --workflow, or a workflow:<name> label)",
      });
      continue;
    }
    admitted.push({ task, outcome: "admitted", workflow, runId: runIdForTask(task.id, nowMs) });
    slots -= 1;
  }
  return { admitted, skipped, inFlight: live.length, freeSlots };
}
