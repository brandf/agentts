#!/usr/bin/env bun
/**
 * AgentTS host CLI (BRA-44, v0).
 *
 *   agentts run <workflow> [--run-id ID] [--input-file FILE | --input JSON] [--wait]
 *           [--adapter mock|direct] [--clock virtual|real] [--state-dir DIR]
 *           [--task TASK] [--gates auto|hold] [--workers-config workers.json]
 *           [--mock-answers answers.json]
 *   agentts run - [--input-file FILE | --input JSON] [--wait] [...]
 *           (BRA-112: "-" reads the workflow source from stdin and
 *           materializes it, content-addressed, to
 *           .agentts-scratch/inline/<sha256[0:16]>.ts under the cwd;
 *           the frozen copy is the durable record and nothing is
 *           ever deleted. Relative imports resolve against
 *           .agentts-scratch/inline/ — prefix ../../ to reach the
 *           repo tree, e.g. ../../workflows/library/judge-fix-loop from
 *           apps/agentts. Empty stdin is a loud error.)
 *   agentts result <runId> [--state-dir DIR]
 *   agentts check <workflow> [--state-dir DIR] [--json]
 *           (first-run gate + extraction + M2 checker, no run:
 *           exit 0 when the workflow would start, 1 with structured
 *           diagnostics when it would be refused)
 *   agentts check --layering [dirs...] [--json]
 *           (the layering boundary over a source tree: core + host
 *           never import Muse-specific things; default dirs
 *           src + plugins under the cwd)
 *   agentts deliver-gate <runId> <answer-json> [--state-dir DIR]
  agentts deliver-result <runId> [--state-dir DIR]
           (record a terminal run's delivery in the outbox — the
           tick agent's delivery path; exit 1 when the run is not
           terminal yet)
  agentts deliveries [--state-dir DIR] [--json]
           (list the delivery outbox)
  agentts escalate '<json>' [--state-dir DIR]
           (write an escalation record: {"kind":"gate-held"|
           "stuck-running"|"other","runId"?,"reason","detail"?})
  agentts watchdog [--state-dir DIR] [--stale-minutes N] [--json]
           (tick-agent health check: exit 0 healthy / nothing
           pending, 2 tick agent dead AND pending work — restart
           it, 1 error)
 *   agentts status <runId> [--state-dir DIR]
 *   agentts queue list [--state-dir DIR]
 *   agentts queue run [--state-dir DIR]
 *   agentts queue repair [--force] [--state-dir DIR]
 *           (repair stranded "running" entries without driving;
 *            --force breaks a held lock — human-only, never the
 *            tick agent)
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
 *   agentts snapshot convert --state-dir DIR --run-id ID
 *           --dquickts TREE --new-sig-snap SNAP [--durablets-c PATH]
 *           (BRA-134: convert a suspended run's snapshot from one
 *           dquickts engine build to another by strip-and-recompile,
 *           then rewrite the state dir under the new engine version +
 *           format identity so the run resumes under the new engine
 *           with the same result. --dquickts is the target engine
 *           tree (its VENDORED_FROM pin + quickjs-opcode.h +
 *           libquickjs.a); --new-sig-snap is a snapshot written by the
 *           new engine (its build signature + class table); the new
 *           engine version and format identity are computed from the
 *           target tree + durablets.c, never taken on faith.
 *           --durablets-c overrides the durablets.c the version and
 *           identity are computed from, for an upgrade that also
 *           changes it. A snapshot already at the target version is
 *           reported as already-converted, not rewritten. A converter
 *           refusal exits 2 with CONVERT REFUSED: on stderr and no
 *           output written and no state touched.)
 *
 * Exit codes: 0 done, 2 held at a gate (run again after delivering
 * an answer) or converter refusal (snapshot convert), 1 error / refusal. State defaults to ./.agentts-state
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
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Host, HostRefusalError, defaultAdapterName, flushNotifications, loadWorkersConfig, type RepairReport } from "./host";
import { MockAdapter } from "../plugins/mock/src/mock-adapter";
import { DirectAdapter } from "../plugins/direct/src/direct-adapter";
import {
  LinearTaskBackend,
  LocalTaskBackend,
  runStatusFromJournal,
  syncRunToTask,
} from "./task-backend";
import { compilerVersion, CHECKER_VERSION, GateError } from "./gate";
import {
  ConvertRefusalError,
  convertStateDir,
  makeConvertWorkDir,
} from "./snapshot-convert";
import { checkWorkflowFile, checkLayeringFiles, CheckerError, type CheckerDiagnostic } from "./checker";
import { ExtractionError } from "./extract";
import { decideLocal } from "./decision-model";
import { loadActualsFile } from "./cost-model";
import { admitTasks, type InFlightLink } from "./admittance";
import { workerServerUrl } from "./worker-protocol";
import { httpAsync } from "./worker-http";
import { serverConfigFromArgs, WorkerServer } from "./worker-server";
import { checkWatchdog, DEFAULT_WATCHDOG_STALE_MINUTES } from "./watchdog";
import {
  loadJournalTree,
  loadJournalTreeFromFile,
  profileTree,
  renderTreeHtml,
  renderTreeText,
} from "./profiler";

function usage(): never {
  console.error(`usage:
  agentts run <workflow> [--run-id ID] [--input-file FILE | --input JSON] [--wait] [--adapter mock|direct] [--clock virtual|real] [--state-dir DIR] [--task TASK] [--gates auto|hold] [--workers-config workers.json] [--mock-answers answers.json] [--launched-by SESSION] [--owner SESSION] [--keep]
  agentts run - [--input-file FILE | --input JSON] [--wait] [...] (BRA-112: "-" reads the workflow source from stdin; materialized content-addressed to .agentts-scratch/inline/<hash>.ts under the cwd; relative imports resolve against .agentts-scratch/inline/)
  (--adapter default: direct on the production state dir ~/workspace/agentts-state, mock elsewhere)
  (--launched-by default: $AGENTTS_LAUNCHED_BY; --owner default: $AGENTTS_OWNER. BRA-211: launchedBy is provenance — the session that submitted the run; owner is the session that executes and drives it. Only a job-looping session (a lead) can be an owner; the engine records the owner as given and does not validate lead-ness. The Director launches with owner set to the lead and never owns. Either field absent = legacy, nothing recorded. The owner OR the launcher may cancel the run; 'agentts runs --owner' lists the runs a lead drives, '--launched-by' the runs a session submitted. BRA-178: --keep marks the run kept past GC — a kept run is never collected, at any age; default false.)
  agentts runs [--owner SESSION] [--launched-by SESSION] [--limit N] [--json]
  agentts cancel <runId> [--reason R] [--launched-by SESSION | --owner SESSION] [--server URL]
  (--gates default auto: the mock adapter answers gates "yes" at once and logs GATE AUTO-ANSWERED; a real human checkpoint needs --gates hold on BOTH run/submit and queue run — run and queue run build separate Hosts (BRA-119). The direct and muse adapters always hold.)
  agentts result <runId> [--state-dir DIR]
  agentts check <workflow> [--state-dir DIR] [--json]
  agentts check --layering [dirs...] [--json]
  agentts deliver-gate <runId> <answer-json> [--state-dir DIR]
  agentts deliver-result <runId> [--state-dir DIR]
  agentts deliveries [--state-dir DIR] [--json]
  agentts escalate '<json>' [--state-dir DIR]
  agentts watchdog [--state-dir DIR] [--stale-minutes N] [--json]
  agentts status <runId> [--state-dir DIR]
  agentts queue list [--state-dir DIR]
  agentts queue run [--state-dir DIR]
  agentts queue repair [--force] [--state-dir DIR]
  agentts sync-task <taskId> <runId> [--state-dir DIR] [--backend linear|local]
  agentts admit [--state-dir DIR] [--backend linear|local] [--wip N] [--map FILE] [--workflow PATH] [--dry-run]
  agentts cost-model [--state-dir DIR]
  agentts profile <runId> [--state-dir DIR] [--format text|html] [--journal FILE] [--out FILE]
  agentts worker serve [--port N] [--state-dir DIR] [--lease-ms N] [--max-attempts N] [--affinity-hold-ms N] [--affinity-ttl-ms N] [--max-pool-size N] [--max-cpu-slots N] [--max-decisions-per-sec N] [--max-tokens-per-hour N] [--dispatch-aging-ms N] [--workers-config FILE]
  (BRA-111: --workers-config / AGENTTS_WORKERS_CONFIG on the server registers worker scripts on the driver Host's DirectAdapters, so runs submitted with --adapter direct + a workers-config keep their workers through the queue drive; a missing/bad file fails the drive loudly with 500.)
  agentts worker status [--server URL]
  agentts worker cancel <jobId> [--reason R] [--server URL]
  agentts worker get-job --worker-id W [--server URL]
  agentts worker complete-job --job-id J --worker-id W (--result JSON | --result-file F | --error MSG) [--files-dir D] [--server URL]
  agentts version
  agentts snapshot convert --state-dir DIR --run-id ID --dquickts TREE --new-sig-snap SNAP [--durablets-c PATH]
  (BRA-134: convert a suspended run's snapshot to a new dquickts engine build and rewrite the state dir under the new engine version + format identity; exit 2 with CONVERT REFUSED: on a converter refusal, no output and no state touched; an already-converted snapshot is reported, not rewritten)`);
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
  // Production default (Brandon, Nov 16, 2026 — smoke-test finding 1):
  // runs submitted to the production state dir execute for real (the
  // direct adapter) by default. The mock adapter's canned exec results
  // silently fake success, so a production submit that forgets
  // --adapter must not fake it. Tests and scratch state dirs keep the
  // mock default. An explicit --adapter always wins over this default.
  // The default adapter is one rule, shared with the worker server's
  // driver endpoints (defaultAdapterName, src/host.ts) — direct on
  // the production state dir, mock elsewhere.
  const adapterName =
    flag(args, "--adapter") ?? defaultAdapterName(stateDir(args));
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
  // BRA-111: the config is parsed once (loadWorkersConfig, shared
  // with the worker server's driver host) and carried on the Host,
  // which applies it to its own adapter AND to every fresh
  // DirectAdapter it loads for a queued entry — so a run submitted
  // with --adapter direct + a workers-config keeps its workers no
  // matter which process drives it.
  const workersConfigPath = flag(args, "--workers-config") ?? process.env.AGENTTS_WORKERS_CONFIG;
  let workersConfig: Record<string, string> | undefined;
  if (workersConfigPath) {
    if (!(adapter instanceof DirectAdapter)) {
      console.error(`--workers-config applies to the direct adapter, not "${adapterName}"`);
      process.exit(1);
    }
    try {
      workersConfig = loadWorkersConfig(workersConfigPath);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
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
  return new Host({ stateDir: stateDir(args), adapter, clock, workersConfig });
}

/** BRA-112: materialize a stdin workflow source under the cwd so its
 * relative imports resolve from a real file path. Content-addressed
 * (.agentts-scratch/inline/<sha256[0:16]>.ts): an identical re-submit
 * reuses the same file, and nothing is ever deleted — the file
 * persists in scratch (ephemeral by convention) and the frozen copy
 * is the durable, auditable record. The file lives under the cwd
 * (NOT the state dir) because the file's directory is the
 * import-resolution base. Note the base is the materialized file's
 * directory, .agentts-scratch/inline/ — not the cwd root — so a
 * one-shot reaching the repo tree writes ../../workflows/... . */
function materializeInlineWorkflow(source: string): string {
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dir = path.resolve(".agentts-scratch", "inline");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.ts`);
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== source) {
    fs.writeFileSync(file, source);
  }
  return file;
}

/** Submit a workflow + input: gate + extract + validate the input,
 * enqueue, print the runId immediately. --wait is a blocking fetch
 * on that SAME path (submit, then `queue run`, then result) — NOT a
 * separate in-process drive mode. There is no in-process drive mode
 * anymore. Input comes from --input-file (a JSON file) or --input
 * (inline JSON); giving both is refused. */
async function cmdRun(args: string[]): Promise<number> {
  let workflow = args[0];
  if (!workflow) usage();
  // BRA-112: "-" reads the workflow source from stdin (Unix
  // convention). A TTY with no piped input is a loud error, not a
  // silent block waiting for EOF; empty stdin is a loud error too.
  let runId = flag(args, "--run-id");
  if (workflow === "-") {
    if (process.stdin.isTTY) {
      console.error(`agentts run - reads the workflow from stdin: pipe the source in (heredoc or here-string), do not run it on a terminal`);
      return 1;
    }
    const source = await Bun.stdin.text();
    if (!source.trim()) {
      console.error(`agentts run -: no workflow source on stdin (empty input)`);
      return 1;
    }
    try {
      workflow = materializeInlineWorkflow(source);
    } catch (e) {
      console.error(`agentts run -: could not materialize the stdin workflow: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    runId ??= `run-inline-${Date.now()}`;
  }
  runId ??= `run-${path.basename(workflow, ".ts")}-${Date.now()}`;
  const taskId = flag(args, "--task");
  // BRA-211: the launching session (provenance) and the owning
  // session (the one that executes and drives the run). Flags win,
  // $AGENTTS_LAUNCHED_BY / $AGENTTS_OWNER are the fallbacks (a lead's
  // long-lived worker sets them once); absent = legacy, nothing
  // recorded. The engine records the owner as given and does not
  // validate lead-ness — the launcher names a lead as owner.
  const launchedBy = flag(args, "--launched-by") ?? process.env.AGENTTS_LAUNCHED_BY ?? undefined;
  const owner = flag(args, "--owner") ?? process.env.AGENTTS_OWNER ?? undefined;
  // BRA-178: --keep marks the run kept past GC — a kept run is
  // never collected, at any age. Default false (absent = not kept).
  const keep = has(args, "--keep");
  const host = await makeHost(args);
  const inputFile = flag(args, "--input-file");
  const inputInline = flag(args, "--input");
  let input: unknown;
  if (inputFile && inputInline) {
    console.error(`--input and --input-file conflict: give exactly one input source`);
    return 1;
  }
  if (inputFile) {
    try {
      input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
    } catch (e) {
      console.error(`--input-file ${inputFile} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (inputInline) {
    try {
      input = JSON.parse(inputInline);
    } catch (e) {
      console.error(`--input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  try {
    const { runId: submitted } = host.submit(workflow, { runId, input, taskId, launchedBy, owner, keep: keep ? true : undefined });
    if (!has(args, "--wait")) {
      console.log(`RUN ${submitted}`);
      if (launchedBy) console.log(`launched by: ${launchedBy}`);
      if (owner) console.log(`owner: ${owner}`);
      if (keep) console.log(`kept: true`);
      return 0;
    }
    // --wait: submit, then drive the queue, then fetch the result —
    // the same path `queue run` + `result` take, not a second mode.
    const q = await host.runQueue();
    const entry = q.find((e) => e.runId === submitted);
    if (entry && entry.status === "held") {
      console.log(`GATE PENDING ${submitted} — deliver an answer with:`);
      console.log(`  agentts deliver-gate ${submitted} '{"answer":"yes"}' --state-dir ${host.stateDir}`);
      return 2;
    }
    return printResult(host, submitted);
  } catch (e) {
    if (e instanceof HostRefusalError) {
      console.error(`REFUSED: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** Print a run's result (or its status). Exit 0 done, 2 held,
 * 1 failed, 0 pending/running with the status printed. */
function printResult(host: Host, runId: string): number {
  const res = host.result(runId);
  if (res.status === "done") {
    console.log(JSON.stringify(res.output, null, 2));
    return 0;
  }
  if (res.status === "failed") {
    console.error(`run ${runId} failed: ${res.error ?? "unknown error"}`);
    return 1;
  }
  if (res.status === "held") {
    console.log(`GATE PENDING ${runId} — deliver an answer with:`);
    console.log(`  agentts deliver-gate ${runId} '{"answer":"yes"}' --state-dir ${host.stateDir}`);
    return 2;
  }
  // BRA-211: a cancelled run is a settled outcome, not a failure —
  // report it and exit 0, like pending/running.
  if (res.status === "cancelled") {
    console.log(`run ${runId}: cancelled${res.error ? ` (${res.error})` : ""}`);
    return 0;
  }
  console.log(`run ${runId}: ${res.status}`);
  return 0;
}

async function cmdResult(args: string[]): Promise<number> {
  const runId = args[0];
  if (!runId) usage();
  const host = await makeHost(args);
  return printResult(host, runId);
}

async function cmdDeliverResult(args: string[]): Promise<number> {
  const runId = args[0];
  if (!runId) usage();
  const host = await makeHost(args);
  try {
    const record = host.recordDelivery(runId);
    console.log(JSON.stringify(record, null, 2));
    return 0;
  } catch (e) {
    console.error(`deliver-result: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cmdDeliveries(args: string[]): Promise<number> {
  const host = await makeHost(args);
  const records = host.listDeliveries();
  if (has(args, "--json")) {
    console.log(JSON.stringify(records, null, 2));
    return 0;
  }
  if (!records.length) {
    console.log(`no deliveries in ${host.stateDir}`);
    return 0;
  }
  for (const r of records) {
    const what =
      r.status === "done"
        ? JSON.stringify(r.output)
        : `FAILED: ${r.error ?? "unknown error"}`;
    console.log(
      `${r.status} ${r.runId} delivered ${r.deliveredAt} by ${r.deliveredBy}${r.needsAttention ? " NEEDS ATTENTION" : ""} — ${String(what).slice(0, 300)}`,
    );
  }
  return 0;
}

async function cmdEscalate(args: string[]): Promise<number> {
  const raw = args[0];
  if (!raw) usage();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`escalate: not valid JSON: ${raw}`);
    return 1;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`escalate: expected a JSON object {"kind","runId"?,"reason","detail"?}`);
    return 1;
  }
  const rec = parsed as { kind?: unknown; runId?: unknown; reason?: unknown; detail?: unknown };
  if (typeof rec.kind !== "string" || typeof rec.reason !== "string" || !rec.reason) {
    console.error(`escalate: requires a kind and a non-empty reason`);
    return 1;
  }
  const host = await makeHost(args);
  try {
    const p = host.writeEscalation({
      kind: rec.kind as "gate-held" | "stuck-running" | "other",
      ...(typeof rec.runId === "string" ? { runId: rec.runId } : {}),
      reason: rec.reason,
      ...(rec.detail !== undefined ? { detail: rec.detail } : {}),
    });
    console.log(`escalation written: ${p}`);
    return 0;
  } catch (e) {
    console.error(`escalate: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** The watchdog check (BRA-65): tick-agent liveness + pending work.
 * Exit 0 healthy / nothing pending, 2 tick agent dead AND pending
 * work (restart it), 1 error. The check itself never drives the
 * queue or flips state — it reports, and the runtime cron that runs
 * it restarts the tick agent when the report says to. */
async function cmdWatchdog(args: string[]): Promise<number> {
  const dir = stateDir(args);
  const staleArg = flag(args, "--stale-minutes");
  const staleMinutes =
    staleArg !== undefined ? Number(staleArg) : DEFAULT_WATCHDOG_STALE_MINUTES;
  if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
    console.error(`--stale-minutes must be a positive number (got "${staleArg}")`);
    return 1;
  }
  const report = checkWatchdog(dir, staleMinutes);
  if (has(args, "--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.summary);
    const p = report.pending;
    if (p.queuedRuns.length) console.log(`  queued: ${p.queuedRuns.join(", ")}`);
    if (p.heldRuns.length) console.log(`  held: ${p.heldRuns.join(", ")}`);
    if (p.undeliveredResults.length) console.log(`  undelivered results: ${p.undeliveredResults.join(", ")}`);
    if (p.stuckRunning.length) console.log(`  stuck running (report, never auto-flip): ${p.stuckRunning.join(", ")}`);
    for (const e of p.escalations) {
      console.log(`  escalation ${e.kind}${e.runId ? ` ${e.runId}` : ""}: ${e.reason}`);
    }
  }
  return report.needsRestart ? 2 : 0;
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
  host.deliverGate(runId, answer);
  console.log(`gate answer delivered for ${runId} — drive it with:`);
  console.log(`  agentts queue run --state-dir ${host.stateDir}`);
  return 0;
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
  const attribution = host.runAttribution(runId);
  console.log(`run: ${runId}`);
  console.log(`status: ${runStatusFromJournal(events)}`);
  console.log(`launchedBy: ${attribution?.launchedBy ?? "(none)"}`);
  console.log(`owner: ${attribution?.owner ?? "(none)"}`);
  console.log(`events: ${events.length}`);
  for (const e of events.slice(-8)) console.log(`  ${JSON.stringify(e)}`);
  return 0;
}

/** List runs in the state dir (BRA-211): newest first, default 50
 * rows — the list is bounded, so a state dir with years of runs
 * cannot blow the ~60KB exec-trap stdout cap through a caller.
 * --owner filters to the runs a session drives (the primary query
 * for a lead checking its own work); --launched-by filters to the
 * runs a session submitted (provenance). The two filters combine
 * (AND). --json prints the same rows as JSON. Status is
 * journal-derived, as `status` does it, falling back to the queue
 * entry's status when the run has no journal yet. Visibility is
 * pull-only: no push/notification path, no long-poll watch. */
async function cmdRuns(args: string[]): Promise<number> {
  const host = await makeHost(args);
  const ownerFilter = flag(args, "--owner") ?? process.env.AGENTTS_OWNER ?? undefined;
  const launchedByFilter = flag(args, "--launched-by") ?? process.env.AGENTTS_LAUNCHED_BY ?? undefined;
  const limitRaw = flag(args, "--limit");
  const limit = limitRaw === undefined ? 50 : Math.max(0, Number.parseInt(limitRaw, 10) || 0);
  const asJson = has(args, "--json");
  const entries = host
    .readQueue()
    .filter((e) => (!ownerFilter || e.owner === ownerFilter) && (!launchedByFilter || e.launchedBy === launchedByFilter))
    .sort((a, b) => (a.enqueuedAt < b.enqueuedAt ? 1 : a.enqueuedAt > b.enqueuedAt ? -1 : 0));
  const total = entries.length;
  const rows = entries.slice(0, limit).map((e) => {
    const events = host.journal(e.runId);
    const status = events.length ? runStatusFromJournal(events) : e.status;
    return {
      runId: e.runId,
      status,
      launchedBy: e.launchedBy ?? null,
      owner: e.owner ?? null,
      workflow: e.workflowPath,
      enqueuedAt: e.enqueuedAt,
    };
  });
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    const filterDesc = [
      ...(ownerFilter ? [`owned by ${ownerFilter}`] : []),
      ...(launchedByFilter ? [`launched by ${launchedByFilter}`] : []),
    ].join(", ");
    console.log(
      total === 0
        ? filterDesc
          ? `no runs ${filterDesc} in ${host.stateDir}`
          : `no runs in ${host.stateDir}`
        : `no runs shown (limit ${limit} of ${total} run(s))`,
    );
    return 0;
  }
  for (const r of rows) {
    console.log(`${r.status} ${r.runId} launchedBy=${r.launchedBy ?? "-"} owner=${r.owner ?? "-"} ${r.workflow}`);
  }
  return 0;
}

/** Cancel a workflow run (BRA-211): flip the queue entry (the Host
 * enforces the attribution rule — the owner OR the launcher may
 * cancel an attributed run; any other session is refused), then
 * cancel the run's queued/running server jobs, best-effort. The run
 * cancel itself is the authority: a worker server that cannot be
 * reached is a warning on stderr, not a failure of the cancel —
 * the run will never drive again, and a cancelled job's late
 * completion is a 409. The caller identifies as one session:
 * --launched-by wins, then --owner, then the env fallbacks — the
 * identity is one session either way, and the Host checks it
 * against owner-or-launcher. */
async function cmdCancel(args: string[]): Promise<number> {
  const runId = args[0];
  if (!runId) usage();
  const host = await makeHost(args);
  const reason = flag(args, "--reason") ?? "cancelled via CLI";
  const cancelledBy =
    flag(args, "--launched-by") ??
    flag(args, "--owner") ??
    process.env.AGENTTS_LAUNCHED_BY ??
    process.env.AGENTTS_OWNER ??
    undefined;
  try {
    host.cancelWorkflowRun(runId, { reason, cancelledBy });
  } catch (e) {
    console.error(`cancel: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const serverUrl = (flag(args, "--server") ?? workerServerUrl()).replace(/\/$/, "");
  let jobsCancelled = 0;
  try {
    const jobsRes = await httpAsync("GET", `${serverUrl}/jobs`);
    if (jobsRes.status !== 200) throw new Error(`GET /jobs returned HTTP ${jobsRes.status}`);
    const list: any[] = Array.isArray(jobsRes.body?.jobs) ? jobsRes.body.jobs : [];
    const mine = list.filter((j) => j.runId === runId && (j.status === "queued" || j.status === "running"));
    for (const j of mine) {
      const r = await httpAsync("POST", `${serverUrl}/cancel-job`, { jobId: j.jobId, reason });
      if (r.status === 200) jobsCancelled += 1;
    }
  } catch (e) {
    console.error(
      `warning: worker server ${serverUrl} unreachable — the run is cancelled but its server jobs were not: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  console.log(`CANCELLED ${runId} (${jobsCancelled} job(s) cancelled)`);
  return 0;
}

/** Print a queue-repair report (BRA-72). Verbose (the `queue repair`
 * command) names the empty case too; `queue run` stays quiet when
 * nothing was stranded. */
function printRepairReport(report: RepairReport | null, verbose: boolean): void {
  if (!report) return;
  for (const a of report.actions) {
    console.log(`REPAIR ${a.runId}: running -> ${a.to} — ${a.reason}`);
  }
  if (verbose && report.actions.length === 0) {
    console.log("REPAIR: no stranded running entries");
  }
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
  if (sub === "repair") {
    // BRA-72: repair stranded "running" entries (re-drive them after
    // verifying their state) without driving the queue. --force breaks
    // an ambiguous (or live) lock — human-only, after confirming the
    // holder is dead; never the tick agent, never automation.
    const report = host.repairQueue({ force: has(args, "--force") });
    printRepairReport(report, true);
    return 0;
  }
  if (sub === "run") {
    const q = await host.runQueue();
    // runQueue repairs stranded entries itself before driving (under
    // the lock — see host.ts); print what it repaired, never silently.
    printRepairReport(host.lastRepairReport, false);
    // BRA-175: the worker server drives the queue in a child process
    // (POST /queue/run) and reads the repair report back from this
    // file — the report is computed inside runQueue and cannot cross
    // the process boundary any other way. Written after runQueue
    // returns, next to the human-readable print above; a missing
    // file tells the server the drive never completed.
    const repairReportPath = flag(args, "--repair-report");
    if (repairReportPath) {
      fs.writeFileSync(repairReportPath, JSON.stringify(host.lastRepairReport));
    }
    for (const e of q) {
      console.log(`${e.status} ${e.runId}${e.error ? ` — ${e.error}` : ""}`);
      // A run submitted with --task syncs to the task when the queue
      // drives it to a terminal status (the run path is async, so
      // the sync cannot live in `run` anymore).
      if (e.taskId && (e.status === "done" || e.status === "failed")) {
        const backend = new LocalTaskBackend(host.stateDir);
        await backend.setTaskRun(e.taskId, e.runId);
        await syncRunToTask(backend, e.taskId, e.runId, host.journal(e.runId));
      }
    }
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
    const r = spawnSync("/opt/hatch-image/bin/bun", [script, ...rest], {
      encoding: "utf8",
      // BRA-174: Bun/Node spawnSync caps captured stdout at ~1MB by
      // default (maxBuffer); anything larger fails the spawn with
      // ENOBUFS. get-job prints one job record including its whole
      // input — and job inputs have no protocol-level cap (BRA-179
      // already showed 145KB inputs). 16MB is ~10x the largest known
      // payload, far below anything that would threaten memory on
      // this VM. Keep in sync with the sibling sites:
      // workflows/dogfood/briefing-worker.ts fetchText, src/host.ts
      // runHost, plugins/mock/src/mock-plugin.ts runHost,
      // plugins/muse/src/muse-adapter.ts exec + runExec,
      // plugins/direct/src/direct-adapter.ts exec, src/worker-http.ts
      // httpSync, src/task-backend.ts linearCall.
      maxBuffer: 16 * 1024 * 1024,
    });
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
  const workflowsDir = path.resolve("workflows", "library");
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
    const roots = dirs.length ? dirs : ["src", "plugins", "workflows"];
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
      `CHECK OK ${workflow}: ${sites} trap site(s), entry ${extraction.entry.name}(${extraction.entry.inputType ?? "no input"}): ${extraction.entry.outputType}, gate + checker passed (typescript ${compilerVersion()}, checker ${CHECKER_VERSION})`,
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

async function cmdSnapshot(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "convert") {
    console.error("usage: agentts snapshot convert --state-dir DIR --run-id ID --dquickts TREE --new-sig-snap SNAP [--durablets-c PATH]");
    return 1;
  }
  return cmdSnapshotConvert(rest);
}

async function cmdSnapshotConvert(args: string[]): Promise<number> {
  const stateDirArg = flag(args, "--state-dir");
  const runId = flag(args, "--run-id");
  const dquicktsDir = flag(args, "--dquickts");
  const newSigSnap = flag(args, "--new-sig-snap");
  const durabletsC = flag(args, "--durablets-c");
  const missing = [
    ["--state-dir", stateDirArg],
    ["--run-id", runId],
    ["--dquickts", dquicktsDir],
    ["--new-sig-snap", newSigSnap],
  ].filter(([, v]) => !v).map(([name]) => name);
  if (missing.length) {
    console.error(`snapshot convert: missing required ${missing.join(", ")}`);
    console.error("usage: agentts snapshot convert --state-dir DIR --run-id ID --dquickts TREE --new-sig-snap SNAP [--durablets-c PATH]");
    return 1;
  }
  const workDir = makeConvertWorkDir();
  try {
    const result = convertStateDir({
      stateDir: stateDirArg!,
      runId: runId!,
      dquicktsDir: dquicktsDir!,
      newSigSnapPath: newSigSnap!,
      durabletsCPath: durabletsC,
      workDir,
      onProgress: (line) => console.log(line),
    });
    if (result.alreadyConverted) {
      console.log(
        `ALREADY CONVERTED: ${runId} is already at ${result.newVersion}${result.recordUpdated ? " (record updated)" : ""} — snapshot not rewritten`,
      );
      return 0;
    }
    console.log(
      `CONVERT OK: ${runId} converted to ${result.newVersion} (${result.bytesLength} bytes, sig=0x${result.newSignature.toString(16)}, ${result.convertedCells} bytecode cells, ${result.framesRemapped} frames remapped, ${result.atomsAppended} atoms appended)`,
    );
    return 0;
  } catch (e) {
    if (e instanceof ConvertRefusalError) {
      console.error(`CONVERT REFUSED: ${e.message}`);
      return 2;
    }
    throw e;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best-effort */
    }
  }
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(args);
      case "result":
        return await cmdResult(args);
      case "check":
        return await cmdCheck(args);
      case "deliver-gate":
        return await cmdDeliverGate(args);
      case "deliver-result":
        return await cmdDeliverResult(args);
      case "deliveries":
        return await cmdDeliveries(args);
      case "escalate":
        return await cmdEscalate(args);
      case "watchdog":
        return await cmdWatchdog(args);
      case "status":
        return await cmdStatus(args);
      case "runs":
        return await cmdRuns(args);
      case "cancel":
        return await cmdCancel(args);
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
      case "snapshot":
        return await cmdSnapshot(args);
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
  } finally {
    // BRA-96: notifyEvent POSTs are fire-and-forget fetches — an
    // explicit process.exit() abandons them, so flush every
    // in-flight notification before the process exits. Without
    // this, a submit's run-submitted event is lost and the tick
    // agent never wakes to drive the run (BRA-110). All
    // process.exit(1) calls in this file happen before any Host
    // exists, so there is nothing to flush on those paths.
    await flushNotifications();
  }
}

process.exit(await main());
