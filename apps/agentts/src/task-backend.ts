// task-backend — the task-backend seam (BRA-44, v0 minimal).
//
// Layer 2 is generic logic over small interfaces; backends are
// swappable implementations behind them. The task backend interface:
// listTasks, getTask, setTaskRun (task -> runId), setTaskStatus.
// Linear is the implementation for this deployment; GitHub Issues /
// Jira later. The journal (JSONL, layer 2) is the source of truth;
// mirroring run status into the task backend is a separate small sync
// step (syncRunToTask) that reads the journal and writes through the
// interface. The dispatch queue is plugin-internal (NOT Linear tasks);
// Linear holds task->runId + mirrored status only. Admittance (WIP
// limit, priority ordering, task -> workflow mapping) is BRA-49's
// scope, not v0.
//
// Linear notes: Linear has no runId field on an issue, so the link
// and the status mirror are recorded as comments on the issue (one
// comment per setTaskRun / setTaskStatus call, machine-readable
// `[agentts]` prefix). The local JSON mirror (stateDir/task-runs.json)
// is the queryable record; the Linear comment is the human-visible
// one. setTaskStatus also moves the issue state when the run is done
// (status "done" -> the issue's Done state is left to the coordinator;
// v0 mirrors by comment only, never changes issue state — closing
// issues is the coordinator's job).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Task {
  id: string;
  title: string;
  status: string;
  url?: string;
  /** Linear priority: 1 urgent, 2 high, 3 medium, 4 low, 0/absent
   * = no priority (admittance treats it as medium). */
  priority?: number;
  /** Labels on the task (Linear label names; drives the
   * `workflow:<name>` mapping convention in admittance.ts). */
  labels?: string[];
}

export interface TaskRunLink {
  taskId: string;
  runId: string;
  status: string;
  updatedAt: string;
}

export interface TaskBackend {
  readonly name: string;
  listTasks(opts?: { project?: string; state?: string; limit?: number }): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | null>;
  setTaskRun(taskId: string, runId: string): Promise<void>;
  setTaskStatus(taskId: string, status: string, runId?: string): Promise<void>;
}

const LINEAR_BIN = "/opt/hatch/bin/linear";

function linearCall(tool: string, args: Record<string, unknown>): any {
  const r = spawnSync(
    LINEAR_BIN,
    ["call-tool", "--name", tool, "--arguments-json", JSON.stringify(args)],
    {
      encoding: "utf8",
      timeout: 60_000,
      // BRA-174: Bun/Node spawnSync caps captured stdout at ~1MB by
      // default (maxBuffer); anything larger fails the spawn with
      // ENOBUFS. listTasks caps at 200 issues but issue descriptions
      // are unbounded, so a large backlog with long descriptions can
      // cross 1MB. 16MB is ~10x the largest known payload, far below
      // anything that would threaten memory on this VM. Keep in sync
      // with the sibling sites: workflows/dogfood/briefing-worker.ts
      // fetchText, src/host.ts runHost,
      // plugins/mock/src/mock-plugin.ts runHost,
      // plugins/muse/src/muse-adapter.ts exec + runExec,
      // plugins/direct/src/direct-adapter.ts exec, src/worker-http.ts
      // httpSync, src/cli.ts worker get-job/complete-job spawn.
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (r.error) throw new Error(`linear CLI failed: ${String(r.error)}`);
  if (r.status !== 0) {
    throw new Error(`linear ${tool} exited ${r.status}: ${(r.stderr ?? r.stdout ?? "").slice(0, 500)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`linear ${tool} returned non-JSON: ${r.stdout.slice(0, 200)}`);
  }
  if (parsed.ok === false) throw new Error(`linear ${tool} failed: ${JSON.stringify(parsed).slice(0, 500)}`);
  return parsed.result;
}

/** Unwrap a linear MCP result: { content: [{ text: "<json>" }] }. */
function unwrap(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class LinearTaskBackend implements TaskBackend {
  readonly name = "linear";
  private project: string;

  constructor(opts: { project?: string } = {}) {
    this.project = opts.project ?? "P-BRA-2";
  }

  async listTasks(opts: { project?: string; state?: string; limit?: number } = {}): Promise<Task[]> {
    const args: Record<string, unknown> = {
      project: opts.project ?? this.project,
      limit: opts.limit ?? 50,
    };
    if (opts.state) args.state = opts.state;
    const raw = unwrap(linearCall("list_issues", args));
    const issues = Array.isArray(raw) ? raw : (raw?.issues ?? raw?.nodes ?? []);
    return (issues as any[]).map((i) => ({
      id: i.identifier ?? i.id,
      title: i.title,
      status: i.status?.name ?? i.status ?? "",
      url: i.url,
      priority: typeof i.priority?.value === "number" ? i.priority.value : typeof i.priority === "number" ? i.priority : undefined,
      labels: Array.isArray(i.labels) ? i.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean) : undefined,
    }));
  }

  async getTask(taskId: string): Promise<Task | null> {
    const raw = unwrap(linearCall("get_issue", { id: taskId }));
    if (!raw || raw.isError) return null;
    return {
      id: raw.identifier ?? raw.id ?? taskId,
      title: raw.title ?? "",
      status: raw.status?.name ?? raw.status ?? "",
      url: raw.url,
      priority: typeof raw.priority?.value === "number" ? raw.priority.value : typeof raw.priority === "number" ? raw.priority : undefined,
      labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => (typeof l === "string" ? l : l?.name)).filter(Boolean) : undefined,
    };
  }

  async setTaskRun(taskId: string, runId: string): Promise<void> {
    linearCall("save_comment", {
      issueId: taskId,
      body: `[agentts] run linked: ${runId}\n\nTask ${taskId} is now linked to AgentTS run \`${runId}\`. Status mirrors follow as run events land in the journal.`,
    });
  }

  async setTaskStatus(taskId: string, status: string, runId?: string): Promise<void> {
    linearCall("save_comment", {
      issueId: taskId,
      body: `[agentts] run status: ${status}${runId ? ` (run \`${runId}\`)` : ""}\n\nMirrored from the run journal (the journal is the source of truth).`,
    });
  }
}

/** File-backed task backend (tests + local runs): the same interface,
 * recorded in stateDir/task-runs.json. No network, no Linear spam. */
export class LocalTaskBackend implements TaskBackend {
  readonly name = "local";
  private dir: string;
  private tasks = new Map<string, Task>();
  private links: TaskRunLink[] = [];

  constructor(stateDir: string, seed: Task[] = []) {
    this.dir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true });
    for (const t of seed) this.tasks.set(t.id, t);
    this.load();
  }

  private mirrorPath(): string {
    return path.join(this.dir, "task-runs.json");
  }
  private load(): void {
    const p = this.mirrorPath();
    if (!fs.existsSync(p)) return;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(data.links)) this.links = data.links;
      if (Array.isArray(data.tasks)) for (const t of data.tasks) this.tasks.set(t.id, t);
    } catch {
      /* corrupt mirror: start fresh */
    }
  }
  private save(): void {
    fs.writeFileSync(
      this.mirrorPath(),
      JSON.stringify({ tasks: [...this.tasks.values()], links: this.links }, null, 2),
    );
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks.values()];
  }
  async getTask(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }
  async setTaskRun(taskId: string, runId: string): Promise<void> {
    this.links.push({ taskId, runId, status: "linked", updatedAt: new Date().toISOString() });
    this.save();
  }
  async setTaskStatus(taskId: string, status: string, runId?: string): Promise<void> {
    const link = [...this.links].reverse().find((l) => l.taskId === taskId && (!runId || l.runId === runId));
    if (link) link.status = status;
    else this.links.push({ taskId, runId: runId ?? "", status, updatedAt: new Date().toISOString() });
    const t = this.tasks.get(taskId);
    if (t) t.status = status;
    this.save();
  }
  linksFor(taskId: string): TaskRunLink[] {
    return this.links.filter((l) => l.taskId === taskId);
  }
  /** All task->run links (admittance reads these as the in-flight set). */
  allLinks(): TaskRunLink[] {
    return [...this.links];
  }
}

/** Derive a run's status from its journal (the source of truth). */
export function runStatusFromJournal(events: any[]): string {
  const lifecycle = events.filter((e) => e.event === "lifecycle");
  const last = lifecycle[lifecycle.length - 1];
  if (!last) return "unknown";
  if (last.lifecycle === "completed") return "done";
  if (last.lifecycle === "failed") return "failed";
  if (last.lifecycle === "suspended") return "suspended";
  return last.lifecycle ?? "unknown";
}

/** The sync step: read the journal, derive the status, write it
 * through the task-backend interface. The journal is the source of
 * truth; the backend mirror is derived, never the reverse. */
export async function syncRunToTask(
  backend: TaskBackend,
  taskId: string,
  runId: string,
  journalEvents: any[],
): Promise<string> {
  const status = runStatusFromJournal(journalEvents);
  await backend.setTaskStatus(taskId, status, runId);
  return status;
}
