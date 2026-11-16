#!/usr/bin/env bun
/**
 * AgentTS host CLI (BRA-44, v0).
 *
 *   agentts run <workflow> [--run-id ID] [--adapter mock|direct]
 *           [--clock virtual|real] [--state-dir DIR] [--task TASK]
 *           [--gates auto|hold] [--enqueue]
 *           [--workers-config workers.json] [--mock-answers answers.json]
 *   agentts check <workflow> [--state-dir DIR] [--json]
 *           (first-run gate + extraction + M2 checker, no run:
 *           exit 0 when the workflow would start, 1 with structured
 *           diagnostics when it would be refused)
 *   agentts check --layering [dirs...] [--json]
 *           (the layering boundary over a source tree: core + host
 *           never import Muse-specific things; default dirs
 *           src + plugins under the cwd)
 *   agentts deliver-gate <runId> <answer-json> [--state-dir DIR]
 *   agentts status <runId> [--state-dir DIR]
 *   agentts queue list [--state-dir DIR]
 *   agentts queue run [--state-dir DIR]
 *   agentts sync-task <taskId> <runId> [--state-dir DIR]
 *           [--backend linear|local]
 *   agentts admit [--state-dir DIR] [--backend linear|local]
 *           [--wip N] [--map FILE] [--workflow PATH] [--dry-run]
 *   agentts cost-model [--state-dir DIR]
 *   agentts profile <runId> [--state-dir DIR] [--format text|html]
 *           [--journal FILE] [--out FILE]
 *   agentts worker serve [--port N] [--state-dir DIR]
 *           [--lease-ms N] [--max-attempts N]
 *           [--affinity-hold-ms N] [--affinity-ttl-ms N]
 *           [--max-pool-size N] [--max-cpu-slots N]
 *           [--max-decisions-per-sec N] [--max-tokens-per-hour N]
 *           [--dispatch-aging-ms N]
 *   agentts worker status [--server URL]
 *   agentts worker cancel <jobId> [--reason R] [--server URL]
 *   agentts worker get-job --worker-id W [--server URL]
 *   agentts worker complete-job --job-id J --worker-id W
 *           (--result JSON | --result-file F | --error MSG)
 *           [--files-dir D] [--server URL]
 *   agentts version
 *
 * Exit codes: 0 done, 2 held at a gate (run again after delivering
 * an answer), 1 error / refusal. State defaults to ./.agentts-state
 * (or $AGENTTS_STATE_DIR). The journal under stateDir/journals is the
 * source of truth; blobs under stateDir/blobs let a later process
 * resume a held gate.
 *
 * --workers-config / --mock-answers (BRA-56 fix): the proper fix for
 * registering workers for new job specs without a per-workflow
 * plugin. --workers-config is JSON { spec: workerScriptPath } and
 * registers each spec on the direct adapter (paths resolve against
 * the cwd); the muse worker loop reads the same file format.
 * --mock-answers is JSON { spec: cannedValue } and answers those
 * specs on the mock adapter. Both fail loudly on a missing file or
 * bad JSON, never silently.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Host, HostRefusalError } from "./host";
import { MockAdapter } from "./adapters/mock-adapter";
import { DirectAdapter } from "./adapters/direct-adapter";
import {
  LinearTaskBackend,
  LocalTaskBackend,
  runStatusFromJournal,
  syncRunToTask,
} from "./task-backend";
import { compilerVersion, CHECKER_VERSION, GateError } from "./gate";
import { checkWorkflowFile, checkLayeringFiles, CheckerError, type CheckerDiagnostic } from "./checker";
import { ExtractionError } from "./extract";
import { decideLocal } from "./decision-model";
import { loadActualsFile } from "./cost-model";
import { admitTasks, type InFlightLink } from "./admittance";
import { workerServerUrl } from "./worker-protocol";
import { httpAsync } from "./worker-http";
import { serverConfigFromArgs, WorkerServer } from "./worker-server";
import {
  loadJournalTree,
  loadJournalTreeFromFile,
  profileTree,
  renderTreeHtml,
  renderTreeText,
} from "./profiler";

function usage(): never {
  console.error(`usage:
  agentts run <workflow> [--run-id ID] [--adapter mock|direct] [--clock virtual|real] [--state-dir DIR] [--task TASK] [--gates auto|hold] [--enqueue] [--workers-config workers.json] [--mock-answers answers.json]
  agentts check <workflow> [--state-dir DIR] [--json]
  agentts check --layering [dirs...] [--json]
  agentts deliver-gate <runId> <answer-json> [--state-dir DIR]
  agentts status <runId> [--state-dir DIR]
  agentts queue list [--state-dir DIR]
  agentts queue run [--state-dir DIR]
  agentts sync-task <taskId> <runId> [--state-dir DIR] [--backend linear|local]
  agentts admit [--state-dir DIR] [--backend linear|local] [--wip N] [--map FILE] [--workflow PATH] [--dry-run]
  agentts cost-model [--state-dir DIR]
  agentts profile <runId> [--state-dir DIR] [--format text|html] [--journal FILE] [--out FILE]
  agentts worker serve [--port N] [--state-dir DIR] [--lease-ms N] [--max-attempts N] [--affinity-hold-ms N] [--affinity-ttl-ms N] [--max-pool-size N] [--max-cpu-slots N] [--max-decisions-per-sec N] [--max-tokens-per-hour N] [--dispatch-aging-ms N]
  agentts worker status [--server URL]
  agentts worker cancel <jobId> [--reason R] [--server URL]
  agentts worker get-job --worker-id W [--server URL]
  agentts worker complete-job --job-id J --worker-id W (--result JSON | --result-file F | --error MSG) [--files-dir D] [--server URL]
  agentts version`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function stateDir(args: string[]): string {
  return flag(args, "--state-dir") ?? process.env.AGENTTS_STATE_DIR ?? path.join(process.cwd(), ".agentts-state");
}

/** Read a JSON config file (workers config / mock answers). A
 * missing file or bad JSON exits loudly — a config that silently
 * did not load would make jobs fail for the wrong reason. */
function readJsonConfig(file: string, what: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    console.error(`${what}: cannot read ${file}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch (e) {
    console.error(`${what}: ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`${what}: ${file} must be a JSON object { spec: ... }`);
    process.exit(1);
  }
  return parsed as Record<string, unknown>;
}

async function makeHost(args: string[]): Promise<Host> {
  const adapterName = flag(args, "--adapter") ?? "mock";
  const clock = (flag(args, "--clock") ?? "virtual") as "virtual" | "real";
  if (clock !== "virtual" && clock !== "real") {
    console.error(`unknown clock mode "${clock}" (virtual|real)`);
    process.exit(1);
  }
  const gates = (flag(args, "--gates") ?? "auto") as "auto" | "hold";
  // The muse adapter auto-starts its queue server in this state dir
  // when none is running; resolve it before the adapter is built so
  // the server and the host share one state dir by construction.
  if (!process.env.AGENTTS_STATE_DIR) process.env.AGENTTS_STATE_DIR = stateDir(args);
  let adapter;
  if (adapterName === "mock") adapter = new MockAdapter({ gates });
  else if (adapterName === "direct") adapter = new DirectAdapter();
  else adapter = await Host.loadAdapter(adapterName);
  // BRA-56 fix: a CLI/env way to register workers for new job specs.
  // --workers-config { spec: scriptPath } on the direct adapter;
  // --mock-answers { spec: value } as canned job answers on the mock
  // adapter. A missing file or bad JSON is a loud error, never a
  // silent skip — an unregistered spec must still fail loudly.
  const workersConfigPath = flag(args, "--workers-config") ?? process.env.AGENTTS_WORKERS_CONFIG;
  if (workersConfigPath) {
    if (!(adapter instanceof DirectAdapter)) {
      console.error(`--workers-config applies to the direct adapter, not "${adapterName}"`);
      process.exit(1);
    }
    const cfg = readJsonConfig(workersConfigPath, "workers config");
    for (const [spec, script] of Object.entries(cfg)) {
      if (typeof script !== "string") {
        console.error(`workers config: spec "${spec}" has a non-string script path`);
        process.exit(1);
      }
      const resolved = path.isAbsolute(script) ? script : path.resolve(script);
      if (!fs.existsSync(resolved)) {
        console.error(`workers config: script for spec "${spec}" not found: ${resolved}`);
        process.exit(1);
      }
      adapter.registerWorker(spec, resolved);
    }
  }
  const mockAnswersPath = flag(args, "--mock-answers") ?? process.env.AGENTTS_MOCK_ANSWERS;
  if (mockAnswersPath) {
    if (!(adapter instanceof MockAdapter)) {
      console.error(`--mock-answers applies to the mock adapter, not "${adapterName}"`);
      process.exit(1);
    }
    const answers = readJsonConfig(mockAnswersPath, "mock answers");
    adapter.setCanned("job", (_type, arg) => {
      const spec = arg?.spec;
      if (typeof spec === "string" && spec in answers) return { value: answers[spec] };
      return undefined;
    });
  }
  // BRA-54: the mock adapter's canned decide {choice:"a"} cannot
  // answer revise/keep/converged questions, so the CLI mock path
  // could not drive decide-heavy workflows (the JudgeFixLoop
  // workflow looped 6 times unconverged, mean stuck at 0.55). Wire
  // the local decision model in by default — a queued or setCanned
  // answer still wins, since the adapter consults those first.
  if (adapter instanceof MockAdapter) {
    adapter.setCanned("decide", (_type, arg) => ({ value: decideLocal(arg.question, arg.options) }));
  }
  return new Host({ stateDir: stateDir(args), adapter, clock });
}

async function cmdRun(args: string[]): Promise<number> {
  const workflow = args[0];
  if (!workflow) usage();
  const runId = flag(args, "--run-id") ?? `run-${path.basename(workflow, ".ts")}-${Date.now()}`;
  const taskId = flag(args, "--task");
  const host = await makeHost(args);
  if (has(args, "--enqueue")) {
    host.enqueue(workflow, runId, { taskId });
    console.log(`enqueued ${runId} (workflow ${workflow})`);
    return 0;
  }
  try {
    // Module workflows (imports) must be bundled: the C host never
    // resolves imports. Direct-trap workflows run as-is.
    const src = fs.readFileSync(workflow, "utf8");
    let rc: number;
    if (/^\s*import\s/m.test(src) || src.includes('from "') || src.includes("from '")) {
      const { entryPath } = host.prepareRun(workflow, runId);
      const bundle = await host.bundle(entryPath, `bundle-${runId.replace(/\//g, "_")}.js`);
      rc = host.startRunFrom(bundle, runId);
    } else {
      rc = host.startRun(workflow, runId);
    }
    rc = host.drive(runId);
    if (taskId) {
      const backend = new LocalTaskBackend(host.stateDir);
      await backend.setTaskRun(taskId, runId);
      await syncRunToTask(backend, taskId, runId, host.journal(runId));
    }
    if (host.isGatePending(runId)) {
      console.log(`GATE PENDING ${runId} — deliver an answer with:`);
      console.log(`  agentts deliver-gate ${runId} '{"answer":"yes"}' --state-dir ${host.stateDir}`);
      return 2;
    }
    if (rc === 0) {
      console.log(host.output(runId));
      console.log(`DONE ${runId}`);
      return 0;
    }
    console.error(`run ${runId} exited ${rc}`);
    return 1;
  } catch (e) {
    if (e instanceof HostRefusalError) {
      console.error(`REFUSED: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function cmdDeliverGate(args: string[]): Promise<number> {
  const runId = args[0];
  const answerJson = args[1];
  if (!runId || !answerJson) usage();
  let answer: unknown;
  try {
    answer = JSON.parse(answerJson);
  } catch {
    console.error(`answer is not valid JSON: ${answerJson}`);
    return 1;
  }
  const host = await makeHost(args);
  if (!host.registryHas(runId)) {
    console.error(`no suspended run ${runId} in ${host.stateDir}`);
    return 1;
  }
  const rc = host.deliverGate(runId, answer);
  if (host.isGatePending(runId)) {
    console.log(`GATE PENDING ${runId} (another gate)`);
    return 2;
  }
  if (rc === 0) {
    console.log(host.output(runId));
    console.log(`DONE ${runId}`);
    return 0;
  }
  console.error(`run ${runId} exited ${rc}`);
  return 1;
}

async function cmdStatus(args: string[]): Promise<number> {
  const runId = args[0];
  if (!runId) usage();
  const host = await makeHost(args);
  const events = host.journal(runId);
  if (!events.length) {
    console.log(`no journal for ${runId} in ${host.stateDir}`);
    return 1;
  }
  console.log(`run: ${runId}`);
  console.log(`status: ${runStatusFromJournal(events)}`);
  console.log(`events: ${events.length}`);
  for (const e of events.slice(-8)) console.log(`  ${JSON.stringify(e)}`);
  return 0;
}

async function cmdQueue(args: string[]): Promise<number> {
  const sub = args[0];
  const host = await makeHost(args);
  if (sub === "list") {
    for (const e of host.readQueue()) {
      console.log(`${e.status} ${e.runId} ${e.workflowPath}${e.taskId ? ` task=${e.taskId}` : ""}${typeof e.priority === "number" ? ` priority=${e.priority}` : ""}`);
    }
    return 0;
  }
  if (sub === "run") {
    const q = host.runQueue();
    for (const e of q) console.log(`${e.status} ${e.runId}${e.error ? ` — ${e.error}` : ""}`);
    return q.some((e) => e.status === "failed") ? 1 : 0;
  }
  usage();
}

async function cmdProfile(args: string[]): Promise<number> {
  const runId = args[0];
  if (!runId) usage();
  const format = flag(args, "--format") ?? "text";
  if (format !== "text" && format !== "html") {
    console.error(`unknown format "${format}" (text|html)`);
    return 1;
  }
  const journalFile = flag(args, "--journal");
  const outFile = flag(args, "--out");
  try {
    // Read-only: the profiler never constructs a Host and never
    // touches state beyond reading the journal files.
    const tree = journalFile
      ? loadJournalTreeFromFile(journalFile)
      : loadJournalTree(path.join(stateDir(args), "journals"), runId);
    const profile = profileTree(tree);
    const rendered = format === "html" ? renderTreeHtml(tree, profile) : renderTreeText(tree, profile);
    if (outFile) {
      fs.writeFileSync(outFile, rendered);
      console.log(`profile written to ${outFile}`);
    } else {
      process.stdout.write(rendered);
    }
    return 0;
  } catch (e) {
    console.error(`profile failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cmdWorker(args: string[]): Promise<number> {
  const sub = args[0];
  const serverUrl = (flag(args, "--server") ?? workerServerUrl()).replace(/\/$/, "");
  if (sub === "serve") {
    const config = serverConfigFromArgs(args);
    const server = new WorkerServer(config);
    server.start();
    console.log(`worker queue state dir: ${path.join(config.stateDir, "worker-jobs")}`);
    console.log(`jobspec dir: ${config.jobspecDir}`);
    console.log("serving (Ctrl-C to stop)…");
    await new Promise(() => {});
    return 0;
  }
  if (sub === "status") {
    const health = await httpAsync("GET", `${serverUrl}/health`);
    if (health.status !== 200) {
      console.error(`worker server ${serverUrl} is not answering (HTTP ${health.status})`);
      return 1;
    }
    const jobs = await httpAsync("GET", `${serverUrl}/jobs`);
    const list: any[] = Array.isArray(jobs.body?.jobs) ? jobs.body.jobs : [];
    const counts: Record<string, number> = {};
    for (const j of list) counts[j.status] = (counts[j.status] ?? 0) + 1;
    console.log(`server: ${serverUrl} (lease ${health.body.leaseMs}ms, maxAttempts ${health.body.maxAttempts}, affinityHold ${health.body.affinityHoldMs}ms)`);
    console.log(`jobs: ${list.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`);
    for (const j of list) {
      console.log(`  ${j.status} ${j.jobId} spec=${j.spec} worker=${j.workerId ?? "-"} attempts=${j.attempts} run=${j.runId} trap=${j.trapId}`);
    }
    return 0;
  }
  if (sub === "cancel") {
    const jobId = args[1];
    if (!jobId) usage();
    const r = await httpAsync("POST", `${serverUrl}/cancel-job`, {
      jobId,
      reason: flag(args, "--reason") ?? "cancelled via CLI",
    });
    console.log(JSON.stringify(r.body));
    return r.status === 200 ? 0 : 1;
  }
  if (sub === "get-job" || sub === "complete-job") {
    // One-shot worker CLIs live in plugins/muse/ (single
    // implementation, shared with subagents); the CLI is a thin
    // wrapper that resolves the script and passes args through.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
      path.resolve(here, "..", "plugins", "muse", `${sub}.ts`),
      path.resolve(here, "..", "..", "agentts-repo", "apps", "agentts", "plugins", "muse", `${sub}.ts`),
    ];
    const script = candidates.find((c) => fs.existsSync(c));
    if (!script) {
      console.error(`worker ${sub}: script not found (tried ${candidates.join(", ")})`);
      return 1;
    }
    const rest = args.slice(1);
    if (!rest.includes("--server")) rest.push("--server", serverUrl);
    const r = spawnSync("/opt/hatch-image/bin/bun", [script, ...rest], { encoding: "utf8" });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return r.status ?? 1;
  }
  usage();
}

async function cmdSyncTask(args: string[]): Promise<number> {
  const taskId = args[0];
  const runId = args[1];
  if (!taskId || !runId) usage();
  const host = await makeHost(args);
  const backendName = flag(args, "--backend") ?? "local";
  const backend =
    backendName === "linear" ? new LinearTaskBackend() : new LocalTaskBackend(host.stateDir);
  const status = await syncRunToTask(backend, taskId, runId, host.journal(runId));
  console.log(`task ${taskId} <- run ${runId}: ${status} (via ${backend.name})`);
  return 0;
}

/**
 * Layer-1 admittance (BRA-49): admit backlog tasks into runs.
 *
 *   agentts admit [--backend linear|local] [--wip N] [--map FILE]
 *           [--workflow PATH] [--dry-run] [--state-dir DIR]
 *
 * --map is JSON { taskId: workflowPath }; --workflow forces one
 * workflow for every admitted task; a `workflow:<name>` label on a
 * task also maps it (see admittance.ts). Admitting links the task
 * to its run (setTaskRun through the backend — a `[agentts]` comment
 * on Linear, a row in task-runs.json locally) and enqueues the run
 * in the host queue with the task's priority; `agentts queue run`
 * drives the queue in priority order. Admit never executes a run
 * itself, so it stays fast and non-blocking. --dry-run prints the
 * plan and writes nothing.
 */
async function cmdAdmit(args: string[]): Promise<number> {
  const host = await makeHost(args);
  const backendName = flag(args, "--backend") ?? "local";
  const backend =
    backendName === "linear" ? new LinearTaskBackend() : new LocalTaskBackend(host.stateDir);
  const wip = flag(args, "--wip");
  const wipLimit = wip !== undefined ? Number(wip) : undefined;
  if (wipLimit !== undefined && (!Number.isFinite(wipLimit) || wipLimit < 0)) {
    console.error(`--wip must be a non-negative number (got "${wip}")`);
    return 1;
  }
  let workflowMap: Record<string, string> = {};
  const mapFile = flag(args, "--map");
  if (mapFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mapFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
      workflowMap = parsed as Record<string, string>;
    } catch (e) {
      console.error(`--map ${mapFile}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const defaultWorkflow = flag(args, "--workflow");
  const dryRun = has(args, "--dry-run");
  const backlog = await backend.listTasks({ limit: 200 });
  // In-flight set: the local mirror (written by `run --task` and by
  // admit itself) plus the host queue — a task already queued in
  // the host is in flight even before its mirror row lands. For the
  // linear backend, issues in an active "In Progress"-ish state are
  // also in flight: the mirror is the runId record, the state is
  // the human signal, and re-admitting an in-progress issue would
  // double-run it.
  const mirror = new LocalTaskBackend(host.stateDir);
  const inFlight: InFlightLink[] = mirror.allLinks().map((l) => ({ taskId: l.taskId, runId: l.runId, status: l.status }));
  const queuedTaskIds = new Set(
    host
      .readQueue()
      .filter((e) => (e.status === "queued" || e.status === "running" || e.status === "held") && !!e.taskId)
      .map((e) => e.taskId as string),
  );
  for (const taskId of queuedTaskIds) {
    if (!inFlight.some((l) => l.taskId === taskId)) {
      inFlight.push({ taskId, runId: "", status: "running" });
    }
  }
  if (backendName === "linear") {
    for (const t of backlog) {
      if (/in progress|started|doing/i.test(t.status) && !inFlight.some((l) => l.taskId === t.id)) {
        inFlight.push({ taskId: t.id, runId: "", status: "running" });
      }
    }
  }
  const workflowsDir = path.resolve("workflows");
  const result = admitTasks(
    backlog,
    inFlight,
    { wipLimit, workflowMap, defaultWorkflow, workflowsDir },
  );
  console.log(`backlog: ${backlog.length} task(s), in flight: ${result.inFlight}, free WIP slots: ${result.freeSlots}${dryRun ? " (dry run — nothing written)" : ""}`);
  for (const a of result.admitted) {
    console.log(`ADMIT ${a.task.id} [priority ${a.task.priority ?? "-"}] "${a.task.title}" -> ${a.workflow} (run ${a.runId})`);
  }
  for (const s of result.skipped) {
    console.log(`SKIP ${s.task.id} [priority ${s.task.priority ?? "-"}] "${s.task.title}" — ${s.reason}`);
  }
  if (dryRun) return 0;
  for (const a of result.admitted) {
    const workflowPath = path.isAbsolute(a.workflow) ? a.workflow : path.resolve(a.workflow);
    if (!fs.existsSync(workflowPath)) {
      console.error(`ADMIT FAILED ${a.task.id}: workflow not found: ${a.workflow}`);
      return 1;
    }
    await backend.setTaskRun(a.task.id, a.runId);
    host.enqueue(workflowPath, a.runId, { taskId: a.task.id, priority: a.task.priority });
    console.log(`linked + enqueued ${a.task.id} -> ${a.runId}`);
  }
  if (result.admitted.length) console.log(`run them with: agentts queue run --state-dir ${host.stateDir}`);
  return 0;
}

/** Cost-model estimates from the host trap-actuals log (BRA-49).
 * Prints one line per call site: mean / variance / p90 / n. The
 * pool server's per-spec estimates live behind GET /cost-model. */
async function cmdCostModel(args: string[]): Promise<number> {
  const dir = stateDir(args);
  const file = path.join(dir, "cost-actuals.jsonl");
  const { model, skipped } = loadActualsFile(file);
  const estimates = model.allEstimates();
  if (!estimates.length) {
    console.log(`no cost actuals in ${file}${skipped ? ` (${skipped} skipped line(s))` : ""}`);
    return 0;
  }
  console.log(`cost model: ${estimates.length} site(s) from ${file}${skipped ? ` (${skipped} skipped line(s))` : ""}`);
  for (const e of estimates) {
    console.log(
      `  ${e.site}: mean ${Math.round(e.meanMs)}ms variance ${Math.round(e.varianceMs)}ms^2 p90 ${Math.round(e.p90Ms)}ms n=${e.n}`,
    );
  }
  return 0;
}

/** Format one refusal's diagnostics for the authoring agent: the
 * same structured records the gate returns in-process (file, line,
 * column, code/rule, message, expected, actual, fix), as text or
 * JSON. The JSON form is the write/check/fix loop's machine
 * interface: an agent parses it, fixes the named file:line, and
 * resubmits — no log scraping. */
function printCheckFailure(
  workflow: string,
  diagnostics: Array<Record<string, unknown>>,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify({ workflow, ok: false, diagnostics }, null, 2));
    return;
  }
  for (const d of diagnostics) {
    const where = `${d.file}:${d.line}:${d.column}`;
    console.error(`${where}: error ${d.code}: ${d.message}`);
    if (d.expected !== null && d.expected !== undefined) {
      console.error(`  expected: ${d.expected}; actual: ${d.actual}`);
    }
    if (d.fix) console.error(`  fix: ${d.fix}`);
  }
}

/** Collect .ts files under dirs (recursive, skipping
 * node_modules). */
function collectTsFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
    }
  };
  for (const d of dirs) walk(path.resolve(d));
  return out.sort();
}

async function cmdCheck(args: string[]): Promise<number> {
  const json = has(args, "--json");
  if (has(args, "--layering")) {
    // `agentts check --layering [dirs...]`: the CI import lint.
    const dirs = args.filter((a) => !a.startsWith("--") && a !== "--layering");
    const roots = dirs.length ? dirs : ["src", "plugins"];
    const files = collectTsFiles(roots);
    const diagnostics = checkLayeringFiles(files);
    if (!diagnostics.length) {
      console.log(`LAYERING OK: ${files.length} file(s) under ${roots.join(", ")} — no layering violations`);
      return 0;
    }
    printCheckFailure(roots.join(","), diagnostics as unknown as Array<Record<string, unknown>>, json);
    return 1;
  }
  const workflow = args.find((a) => !a.startsWith("--"));
  if (!workflow) usage();
  const cacheDir = path.join(stateDir(args), "cache");
  try {
    const extraction = checkWorkflowFile(workflow, cacheDir);
    const sites = Object.keys(extraction.sites).length;
    console.log(
      `CHECK OK ${workflow}: ${sites} trap site(s), gate + checker passed (typescript ${compilerVersion()}, checker ${CHECKER_VERSION})`,
    );
    return 0;
  } catch (e) {
    if (e instanceof GateError) {
      printCheckFailure(
        workflow,
        e.diagnostics.map((d) => ({ ...d, code: `TS${d.code}` })),
        json,
      );
      return 1;
    }
    if (e instanceof CheckerError) {
      printCheckFailure(workflow, e.diagnostics as unknown as Array<Record<string, unknown>>, json);
      return 1;
    }
    if (e instanceof ExtractionError) {
      printCheckFailure(
        workflow,
        e.details.map((message) => ({ file: workflow, line: 1, column: 1, code: "EXTRACTION", message, expected: null, actual: null, fix: null })),
        json,
      );
      return 1;
    }
    throw e;
  }
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(args);
      case "check":
        return await cmdCheck(args);
      case "deliver-gate":
        return await cmdDeliverGate(args);
      case "status":
        return await cmdStatus(args);
      case "queue":
        return await cmdQueue(args);
      case "sync-task":
        return await cmdSyncTask(args);
      case "admit":
        return await cmdAdmit(args);
      case "cost-model":
        return await cmdCostModel(args);
      case "profile":
        return await cmdProfile(args);
      case "worker":
        return await cmdWorker(args);
      case "version":
        console.log(`agentts-host v0 (BRA-44), typescript ${compilerVersion()}`);
        return 0;
      default:
        usage();
    }
  } catch (e) {
    if (e instanceof HostRefusalError) {
      console.error(`REFUSED: ${e.message}`);
      return 1;
    }
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
