#!/usr/bin/env bun
/**
 * Scheduling test driver (Linear BRA-49: two-layer scheduling).
 *
 *   DURABLETS_HOST=<built C host> bun tests/test-scheduling.ts
 *   (run.sh sets DURABLETS_HOST and runs this after the worker pool
 *   suite. WORKDIR override: $SCHEDULING_WORKDIR.)
 *
 * Run outputs go to $SCHEDULING_WORKDIR (scratch) or a fresh mkdtemp
 * dir — never into the staged tree. Exit 0 on PASS, 1 on any
 * mismatch. The queue server is killed in a finally block.
 *
 * What is proven (each with its evidence):
 *   A. Admittance unit: WIP limit, priority order, no re-admit of
 *      in-flight tasks, terminal links free a slot, needs-workflow
 *      skips, label + map + default-workflow resolution.
 *   B. Dispatch scheduler unit: priority beats affinity, affinity
 *      inside a tier (reserved/match kept), shortest-first inside a
 *      tier, aging promotes a waited job, unknown cost = tier average.
 *   C. Cost model unit: mean/variance/p90, unknown site is null,
 *      persistence round-trip, corrupt actuals lines skipped.
 *   D. Quotas unit: pool-full, cpu-full, decision-rate window,
 *      token budget, waitMsForDecision.
 *   E. Live server: priority dispatch, CPU-slot exclusion with a
 *      non-CPU job worked around it (quota-blocked logged),
 *      pool-size none-quota, decision-rate none-quota then release,
 *      token-budget none-quota, cost-model endpoint after completion.
 *   F. CLI admit (local backend): dry-run writes nothing, real run
 *      links tasks to runs and enqueues them with priority.
 *   G. Host cost actuals: a mock run appends trap actuals with the
 *      extraction site key (job:<spec> for job traps).
 *   H. Host run queue: priority order — the urgent run's traps land
 *      in cost-actuals.jsonl before the low-priority run's.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync, type Subprocess } from "bun";
import { admitTasks, effectivePriority, resolveWorkflow } from "../src/admittance";
import { DispatchScheduler, AffinityScheduler } from "../src/scheduler";
import { CostModel, loadActualsFile } from "../src/cost-model";
import { QuotaTracker } from "../src/quotas";
import { Host } from "../src/host";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const BUN = "/opt/hatch-image/bin/bun";
const PORT = Number(process.env.AGENTTS_SCHEDULING_TEST_PORT ?? String(20000 + Math.floor(Math.random() * 9000)));
const SERVER_URL = `http://127.0.0.1:${PORT}`;

const WORKDIR = process.env.SCHEDULING_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-"));
const STATE_DIR = path.join(WORKDIR, "state");
const SERVER_STATE = path.join(WORKDIR, "server-state");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(SERVER_STATE, { recursive: true });

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
const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

async function http(method: "GET" | "POST", p: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SERVER_URL}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: parsed };
}

/** Bun spawnSync returns stdout/stderr as Buffers even with
 * encoding set — coerce to string for assertions. */
function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return v == null ? "" : String(v);
}

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- A. admittance
console.log("\n=== A. admittance unit ===");
{
  const backlog = [
    { id: "BRA-101", title: "urgent thing", status: "Todo", priority: 1 },
    { id: "BRA-102", title: "low thing", status: "Todo", priority: 4 },
    { id: "BRA-103", title: "done thing", status: "Done", priority: 1 },
    { id: "BRA-104", title: "already running", status: "In Progress", priority: 1 },
    { id: "BRA-105", title: "medium thing", status: "Todo", priority: 3 },
  ];
  const inFlight = [{ taskId: "BRA-104", runId: "run-old", status: "linked" }];
  const r = admitTasks(backlog, inFlight, {
    wipLimit: 3,
    workflowMap: { "BRA-101": "workflows/library/judge-fix-loop.ts" },
    defaultWorkflow: "workflows/library/worker.ts",
  });
  check(r.inFlight === 1 && r.freeSlots === 2, `WIP OK: 1 in flight, 2 free slots (got ${r.inFlight}/${r.freeSlots})`);
  check(
    r.admitted.map((a) => a.task.id).join(",") === "BRA-101,BRA-105",
    `ORDER OK: urgent first, then medium (got ${r.admitted.map((a) => a.task.id).join(",")})`,
  );
  check(r.admitted[0].workflow === "workflows/library/judge-fix-loop.ts", "MAP OK: explicit map wins for BRA-101");
  check(
    r.skipped.some((s) => s.task.id === "BRA-102" && /WIP limit/.test(s.reason)),
    "WIP OK: low-priority BRA-102 skipped once slots are full",
  );
  check(
    !r.admitted.some((a) => a.task.id === "BRA-104") && !r.skipped.some((s) => s.task.id === "BRA-104"),
    "IN-FLIGHT OK: BRA-104 neither admitted nor skipped (it is already running)",
  );
  check(
    !r.admitted.some((a) => a.task.id === "BRA-103"),
    "DONE OK: done task BRA-103 is not admitted",
  );
  // Terminal link frees the slot (only BRA-104 in the backlog here,
  // so the re-admission is unambiguous).
  const r2 = admitTasks(
    [{ id: "BRA-104", title: "already running", status: "In Progress", priority: 1 }],
    [{ taskId: "BRA-104", runId: "run-old", status: "done" }],
    { wipLimit: 1, defaultWorkflow: "workflows/library/worker.ts" },
  );
  check(
    r2.admitted.map((a) => a.task.id).join(",") === "BRA-104",
    `TERMINAL OK: done link frees the slot, BRA-104 re-admittable (got ${r2.admitted.map((a) => a.task.id).join(",")})`,
  );
  // Needs-workflow: no map, no default, no label.
  const r3 = admitTasks([{ id: "BRA-106", title: "unmapped", status: "Todo", priority: 2 }], [], { wipLimit: 3 });
  check(
    r3.admitted.length === 0 && r3.skipped[0]?.reason.startsWith("needs-workflow"),
    `NEEDS-WORKFLOW OK: unmapped task skipped, not admitted to nothing (${r3.skipped[0]?.reason ?? "?"})`,
  );
  // Label mapping.
  const r4 = admitTasks(
    [{ id: "BRA-107", title: "labelled", status: "Todo", priority: 2, labels: ["workflow:judge-fix-loop"] }],
    [],
    { wipLimit: 3 }, // no workflowsDir: bare labels resolve under the default (workflows/library)
  );
  check(
    r4.admitted[0]?.workflow === "workflows/library/judge-fix-loop.ts",
    `LABEL OK: workflow:<name> label resolves (got ${r4.admitted[0]?.workflow ?? "?"})`,
  );
  check(resolveWorkflow({ id: "X", title: "x", status: "Todo" }, {}) === null, "RESOLVE OK: no mapping returns null");
  check(effectivePriority({ id: "X", title: "x", status: "Todo" }) === 3, "PRIORITY OK: no priority treated as medium (3)");
  check(effectivePriority({ id: "X", title: "x", status: "Todo", priority: 0 }) === 3, "PRIORITY OK: Linear 0 (no priority) treated as medium (3)");
}

// ---------------------------------------------------------------- B. dispatch scheduler
console.log("\n=== B. dispatch scheduler unit ===");
{
  const now = 1_000_000;
  const worker = { id: "w1", lastSpec: "judge", lastCompletedAt: now - 1000, completedAtBySpec: { judge: now - 1000 } };
  const noAffinity = (_spec: string): string | null => null;
  const affinityW1 = (spec: string): string | null => (spec === "judge" ? "w1" : null);
  const s = new DispatchScheduler({ affinityHoldMs: 2000, affinityTtlMs: 30 * 60_000, agingMs: 60_000 });

  // Priority beats affinity: urgent fix for a cold worker beats warm low-priority judge.
  let sel = s.selectJobForWorker(
    { ...worker, lastSpec: "judge" },
    [
      { jobId: "j-low", spec: "judge", enqueuedAt: now - 100, priority: 4 },
      { jobId: "j-urgent", spec: "fix", enqueuedAt: now - 100, priority: 1 },
    ],
    now,
    affinityW1,
  );
  check(sel.job?.jobId === "j-urgent" && sel.decision === "priority", `PRIORITY OK: urgent beats warm low-priority (got ${sel.decision} ${sel.job?.jobId})`);

  // Affinity inside the tier: same priority, warm worker gets its spec (reserved in hold window).
  sel = s.selectJobForWorker(
    worker,
    [
      { jobId: "j1", spec: "judge", enqueuedAt: now - 100, priority: 3 },
      { jobId: "j2", spec: "fix", enqueuedAt: now - 90, priority: 3 },
    ],
    now,
    affinityW1,
  );
  check(sel.job?.jobId === "j1" && sel.decision === "affinity-reserved", `RESERVED OK: warm specialist gets its job in hold window (got ${sel.decision} ${sel.job?.jobId})`);

  // Past the hold window the warm match still wins inside the tier.
  sel = s.selectJobForWorker(
    worker,
    [
      { jobId: "j1", spec: "judge", enqueuedAt: now - 5000, priority: 3 },
      { jobId: "j2", spec: "fix", enqueuedAt: now - 4900, priority: 3 },
    ],
    now,
    noAffinity,
  );
  check(sel.job?.jobId === "j1" && sel.decision === "affinity-match", `MATCH OK: warm match past hold window (got ${sel.decision} ${sel.job?.jobId})`);

  // Shortest-first inside a tier: same priority, no affinity, costs differ.
  sel = s.selectJobForWorker(
    { id: "w9", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} },
    [
      { jobId: "j-long", spec: "slow", enqueuedAt: now - 100, priority: 3, estDurationMs: 9000 },
      { jobId: "j-short", spec: "fast", enqueuedAt: now - 90, priority: 3, estDurationMs: 100 },
    ],
    now,
    noAffinity,
  );
  check(sel.job?.jobId === "j-short" && sel.decision === "shortest-first", `SHORTEST OK: quick job first inside tier (got ${sel.decision} ${sel.job?.jobId})`);

  // Unknown cost sorts as the tier average: an unknown-cost job does
  // not lose to every known-cost job, nor win by being treated as 0.
  sel = s.selectJobForWorker(
    { id: "w9", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} },
    [
      { jobId: "j-known-slow", spec: "slow", enqueuedAt: now - 100, priority: 3, estDurationMs: 9000 },
      { jobId: "j-unknown", spec: "new", enqueuedAt: now - 90, priority: 3, estDurationMs: null },
      { jobId: "j-known-fast", spec: "fast", enqueuedAt: now - 80, priority: 3, estDurationMs: 100 },
    ],
    now,
    noAffinity,
  );
  check(sel.job?.jobId === "j-known-fast" && sel.decision === "shortest-first", `UNKNOWN-COST OK: unknown sorts as tier average, fast still wins (got ${sel.decision} ${sel.job?.jobId})`);

  // Aging: a low-priority job that waited 2 aging steps outranks a fresh medium.
  sel = s.selectJobForWorker(
    { id: "w9", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} },
    [
      { jobId: "j-old-low", spec: "slow", enqueuedAt: now - 130_000, priority: 4 },
      { jobId: "j-fresh-med", spec: "fast", enqueuedAt: now - 100, priority: 3 },
    ],
    now,
    noAffinity,
  );
  check(
    sel.job?.jobId === "j-old-low" && sel.decision === "priority",
    `AGING OK: waited low-priority job (effective 2) beats fresh medium (got ${sel.decision} ${sel.job?.jobId})`,
  );
  check(s.effectivePriority({ jobId: "x", spec: "s", enqueuedAt: now - 130_000, priority: 4 }, now) === 2, "AGING OK: effectivePriority caps at two steps (4 -> 2)");

  // Cold worker, same priority, no costs: oldest (v0 fallback preserved).
  sel = s.selectJobForWorker(
    { id: "w9", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} },
    [
      { jobId: "j1", spec: "a", enqueuedAt: now - 100, priority: 3 },
      { jobId: "j2", spec: "b", enqueuedAt: now - 90, priority: 3 },
    ],
    now,
    noAffinity,
  );
  check(sel.job?.jobId === "j1" && sel.decision === "fallback-oldest", `FALLBACK OK: cold worker takes oldest (got ${sel.decision} ${sel.job?.jobId})`);
  // Empty queue.
  sel = s.selectJobForWorker({ id: "w9", lastSpec: null, lastCompletedAt: null, completedAtBySpec: {} }, [], now, noAffinity);
  check(sel.job === null && sel.decision === "none-available", "EMPTY OK: empty queue is none-available");
  // v0 class still behaves (pool suite section A uses it directly).
  const v0 = new AffinityScheduler({ affinityHoldMs: 8000, affinityTtlMs: 30 * 60_000 });
  const v0sel = v0.selectJobForWorker(worker, [{ jobId: "j1", spec: "judge", enqueuedAt: now - 100 }], now, affinityW1);
  check(v0sel.decision === "affinity-reserved", "V0 OK: AffinityScheduler unchanged");
}

// ---------------------------------------------------------------- C. cost model
console.log("\n=== C. cost model unit ===");
{
  const m = new CostModel();
  check(m.estimate("job:judge") === null, "UNKNOWN OK: no actuals -> null estimate (never invented)");
  for (const ms of [100, 200, 300, 400, 500]) m.record({ site: "job:judge", ms });
  const e = m.estimate("job:judge");
  check(e !== null && Math.round(e.meanMs) === 300 && e.n === 5, `MEAN OK: mean 300ms n=5 (got ${e?.meanMs} n=${e?.n})`);
  check(e !== null && Math.round(e.varianceMs) === 20000, `VARIANCE OK: population variance 20000 (got ${e?.varianceMs})`);
  check(e !== null && e.p90Ms === 500, `P90 OK: p90 500 (got ${e?.p90Ms})`);
  m.record({ site: "job:judge", ms: -5 });
  m.record({ site: "job:judge", ms: Number.NaN });
  check(m.estimate("job:judge")?.n === 5, "INVALID OK: negative/NaN actuals ignored");
  // Persistence round-trip.
  const file = path.join(WORKDIR, "cost-model.json");
  m.saveToFile(file);
  const m2 = CostModel.loadFromFile(file);
  check(m2.estimate("job:judge")?.n === 5 && Math.round(m2.estimate("job:judge")!.meanMs) === 300, "PERSIST OK: save/load round-trips estimates");
  check(CostModel.loadFromFile(path.join(WORKDIR, "missing.json")).allEstimates().length === 0, "PERSIST OK: missing file loads empty");
  // Actuals file with corrupt lines.
  const actuals = path.join(WORKDIR, "actuals.jsonl");
  fs.writeFileSync(actuals, `{"site":"decide","ms":50}\nnot json\n{"site":"decide","ms":150}\n{"site":"decide"}\n`);
  const { model, skipped } = loadActualsFile(actuals);
  check(model.estimate("decide")?.n === 2 && skipped === 2, `ACTUALS-FILE OK: 2 actuals, 2 corrupt lines skipped (got n=${model.estimate("decide")?.n} skipped=${skipped})`);
}

// ---------------------------------------------------------------- D. quotas
console.log("\n=== D. quotas unit ===");
{
  const q = new QuotaTracker({ maxPoolSize: 1, maxCpuSlots: 1, maxDecisionsPerSec: 1, maxTokensPerHour: 100 });
  const now = 2_000_000;
  check(!q.check({}, { running: 1, cpuRunning: 0 }, now).allowed, "POOL OK: 1/1 running blocks");
  check(q.check({}, { running: 0, cpuRunning: 0 }, now).allowed, "POOL OK: 0/1 running allows");
  const cpu = q.check({ cpuHeavy: true }, { running: 0, cpuRunning: 1 }, now);
  check(!cpu.allowed && cpu.reason === "cpu-full", `CPU OK: cpu slots full blocks cpuHeavy (got ${cpu.reason})`);
  check(q.check({ cpuHeavy: false }, { running: 0, cpuRunning: 1 }, now).allowed, "CPU OK: non-cpu job passes a full CPU quota");
  const rate = q.check({ isDecision: true }, { running: 0, cpuRunning: 0 }, now);
  check(rate.allowed, "RATE OK: first decision allowed");
  q.recordDispatch({ isDecision: true }, now);
  const rate2 = q.check({ isDecision: true }, { running: 0, cpuRunning: 0 }, now);
  check(!rate2.allowed && rate2.reason === "decision-rate", `RATE OK: second decision in the same second blocked (got ${rate2.reason})`);
  check(q.waitMsForDecision(now) > 0 && q.waitMsForDecision(now) <= 1000, `WAIT OK: waitMsForDecision in (0,1000] (got ${q.waitMsForDecision(now)})`);
  check(q.waitMsForDecision(now + 1500) === 0, "WAIT OK: window slides, next second is free");
  check(!q.check({ tokensEst: 60 }, { running: 0, cpuRunning: 0 }, now).allowed === false, "TOKENS OK: 60 <= 100 allowed");
  q.recordDispatch({ tokensEst: 60 }, now);
  const tok = q.check({ tokensEst: 60 }, { running: 0, cpuRunning: 0 }, now);
  check(!tok.allowed && tok.reason === "token-budget", `TOKENS OK: 60 used + 60 est exceeds 100 (got ${tok.reason})`);
  check(q.tokensUsedThisHour(now) === 60, "TOKENS OK: tokensUsedThisHour counts debits");
  // Unlimited (0) never blocks.
  const open = new QuotaTracker({});
  check(open.check({ isDecision: true, cpuHeavy: true, tokensEst: 99999 }, { running: 99, cpuRunning: 99 }, now).allowed, "UNLIMITED OK: zero limits never block");
  // Persistence of window state (before the expiry check below,
  // which prunes the debit out of the live tracker by design).
  const restored = QuotaTracker.fromJSON(q.toJSON());
  check(restored.tokensUsedThisHour(now) === 60, "QUOTA-PERSIST OK: token debits survive round-trip");
  check(q.tokensUsedThisHour(now + 3_600_001) === 0, "TOKENS OK: debits expire after an hour");
}

// ---------------------------------------------------------------- E. live server
console.log("\n=== E. live server (quotas + priority + cost model) ===");
let server: Subprocess | null = null;
try {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", SERVER_STATE, "--port", String(PORT),
    "--lease-ms", "60000", "--max-attempts", "2",
    "--max-pool-size", "2", "--max-cpu-slots", "1",
    "--max-decisions-per-sec", "1", "--max-tokens-per-hour", "100"], {
    stdout: "pipe", stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      const h = await http("GET", "/health");
      if (h.status === 200 && h.body?.ok) { up = true; break; }
    } catch { /* not up yet */ }
  }
  check(up, "SERVER OK: worker queue up with BRA-49 quota flags");
  if (up) {
    const health = await http("GET", "/health");
    check(health.body?.scheduler === "dispatch-v1", `HEALTH OK: scheduler dispatch-v1 (got ${health.body?.scheduler})`);
    check(health.body?.quotas?.maxCpuSlots === 1 && health.body?.quotas?.maxPoolSize === 2, `HEALTH OK: quotas visible (cpu ${health.body?.quotas?.maxCpuSlots}, pool ${health.body?.quotas?.maxPoolSize})`);

    // Priority dispatch: urgent beats older low-priority.
    const low = await http("POST", "/enqueue", { spec: "slow-spec", runId: "r-low", trapId: "t-low", priority: 4 });
    const urg = await http("POST", "/enqueue", { spec: "fast-spec", runId: "r-urg", trapId: "t-urg", priority: 1 });
    const got1 = await http("GET", `/get-job?workerId=w1`);
    check(got1.body?.job?.jobId === urg.body?.jobId, `PRIORITY-DISPATCH OK: urgent job dispatched before older low-priority (got ${got1.body?.job?.jobId})`);
    const st1 = await http("GET", `/job-status?jobId=${urg.body?.jobId}`);
    check(st1.body?.priority === 1, `PRIORITY-STORED OK: job carries priority 1 (got ${st1.body?.priority})`);
    // Complete the urgent job after a real delay so the cost model gets a nonzero actual.
    await sleep(30);
    const done1 = await http("POST", "/complete-job", { jobId: urg.body?.jobId, workerId: "w1", result: { ok: true } });
    check(done1.body?.status === "completed", "COMPLETE OK: urgent job completed");
    const cm = await http("GET", "/cost-model");
    const est = (cm.body?.estimates ?? []).find((e: any) => e.site === "job:fast-spec");
    check(!!est && est.n === 1 && est.meanMs >= 0, `COST-MODEL OK: /cost-model has job:fast-spec n=1 (got ${JSON.stringify(est)})`);

    // CPU quota: one cpuHeavy running; a second cpuHeavy is excluded
    // and the non-CPU job is dispatched around it (quota-blocked logged).
    const cpuA = await http("POST", "/enqueue", { spec: "cpu-a", runId: "r-cpu-a", trapId: "t-cpu-a", cpuHeavy: true });
    const cpuB = await http("POST", "/enqueue", { spec: "cpu-b", runId: "r-cpu-b", trapId: "t-cpu-b", cpuHeavy: true });
    const plain = await http("POST", "/enqueue", { spec: "plain", runId: "r-plain", trapId: "t-plain" });
    const gotCpuA = await http("GET", `/get-job?workerId=w1`);
    check(gotCpuA.body?.job?.jobId === cpuA.body?.jobId, `CPU OK: first cpuHeavy dispatched (priority 3 tier beats queued priority-4 low job) (got ${gotCpuA.body?.job?.jobId})`);
    const gotPlain = await http("GET", `/get-job?workerId=w2`);
    check(gotPlain.body?.job?.jobId === plain.body?.jobId, `CPU OK: second cpuHeavy skipped, plain job dispatched around it (got ${gotPlain.body?.job?.jobId})`);
    const schedLog = readJsonl(path.join(SERVER_STATE, "worker-jobs", "scheduler.log"));
    check(
      schedLog.some((e) => e.decision === "quota-blocked" && e.jobId === cpuB.body?.jobId),
      `CPU OK: scheduler.log records quota-blocked for ${cpuB.body?.jobId}`,
    );
    // Pool size: 2 running (cpu-a, plain) — next worker gets none-quota.
    // waitMs=0 (the old immediate return): a bare get-job is a 60s
    // long-poll (BRA-66) and would park until a lease expires.
    const gotNone = await http("GET", `/get-job?workerId=w3&waitMs=0`);
    check(gotNone.body?.job === null, "POOL OK: third worker gets no job at max pool size 2");
    check(
      schedLog.some((e) => e.decision === "none-quota") || readJsonl(path.join(SERVER_STATE, "worker-jobs", "scheduler.log")).some((e) => e.decision === "none-quota"),
      "POOL OK: scheduler.log records none-quota",
    );
    // Free the pool: complete cpu-a and plain; cpu-b (priority 3) goes before low (priority 4).
    await http("POST", "/complete-job", { jobId: cpuA.body?.jobId, workerId: "w1", result: { ok: true } });
    await http("POST", "/complete-job", { jobId: plain.body?.jobId, workerId: "w2", result: { ok: true } });
    const gotCpuB = await http("GET", `/get-job?workerId=w1`);
    check(gotCpuB.body?.job?.jobId === cpuB.body?.jobId, `CPU OK: cpu slot freed, cpu-b dispatches before the low-priority job (got ${gotCpuB.body?.job?.jobId})`);
    await http("POST", "/complete-job", { jobId: cpuB.body?.jobId, workerId: "w1", result: { ok: true } });
    const gotLow = await http("GET", `/get-job?workerId=w2`);
    check(gotLow.body?.job?.jobId === low.body?.jobId, `QUEUE-ORDER OK: low job dispatches once higher tiers drain (got ${gotLow.body?.job?.jobId})`);
    await http("POST", "/complete-job", { jobId: low.body?.jobId, workerId: "w2", result: { ok: true } });

    // Decision rate: one decision job dispatches, the next is blocked for a second.
    const dec1 = await http("POST", "/enqueue", { spec: "decide-a", runId: "r-d1", trapId: "t-d1", isDecision: true });
    const dec2 = await http("POST", "/enqueue", { spec: "decide-b", runId: "r-d2", trapId: "t-d2", isDecision: true });
    const gotDecA = await http("GET", `/get-job?workerId=w1`);
    check(gotDecA.body?.job?.jobId === dec1.body?.jobId, `DECIDE OK: first decision job dispatched (got ${gotDecA.body?.job?.jobId})`);
    const gotDecBlocked = await http("GET", `/get-job?workerId=w2&waitMs=0`);
    check(gotDecBlocked.body?.job === null, "DECIDE OK: second decision job blocked inside the same second");
    await sleep(1100);
    const gotDecB = await http("GET", `/get-job?workerId=w2`);
    check(gotDecB.body?.job?.jobId === dec2.body?.jobId, `DECIDE OK: second decision job dispatches after the window slides (got ${gotDecB.body?.job?.jobId})`);
    await http("POST", "/complete-job", { jobId: dec1.body?.jobId, workerId: "w1", result: { ok: true } });
    await http("POST", "/complete-job", { jobId: dec2.body?.jobId, workerId: "w2", result: { ok: true } });

    // Token budget: 100/hour; a 60-token job dispatches, a second 60-token job is blocked.
    const tok1 = await http("POST", "/enqueue", { spec: "tok-a", runId: "r-t1", trapId: "t-t1", tokensEst: 60 });
    const tok2 = await http("POST", "/enqueue", { spec: "tok-b", runId: "r-t2", trapId: "t-t2", tokensEst: 60 });
    const gotTok1 = await http("GET", `/get-job?workerId=w1`);
    check(gotTok1.body?.job?.jobId === tok1.body?.jobId, `TOKENS OK: first 60-token job dispatched (got ${gotTok1.body?.job?.jobId})`);
    const gotTokBlocked = await http("GET", `/get-job?workerId=w2&waitMs=0`);
    check(gotTokBlocked.body?.job === null, "TOKENS OK: second 60-token job blocked (60 used + 60 est > 100)");
    const h2 = await http("GET", "/health");
    check(h2.body?.quotas?.tokensUsedThisHour === 60, `TOKENS OK: health reports 60 tokens used this hour (got ${h2.body?.quotas?.tokensUsedThisHour})`);
    await http("POST", "/complete-job", { jobId: tok1.body?.jobId, workerId: "w1", result: { ok: true } });
    // Priority stored at enqueue survives a server-side view.
    const tokStatus = await http("GET", `/job-status?jobId=${tok2.body?.jobId}`);
    check(tokStatus.body?.tokensEst === 60 && tokStatus.body?.status === "queued", "TOKENS OK: blocked job stays queued with its tokensEst");
  }
} finally {
  if (server) server.kill();
}

// ---------------------------------------------------------------- F. CLI admit
console.log("\n=== F. CLI admit (local backend) ===");
{
  if (!process.env.DURABLETS_HOST) {
    fail("DURABLETS_HOST not set — run via run.sh");
  } else {
    const seed = {
      tasks: [
        { id: "BRA-201", title: "urgent admit", status: "Todo", priority: 1 },
        { id: "BRA-202", title: "low admit", status: "Todo", priority: 4 },
        { id: "BRA-203", title: "done admit", status: "Done", priority: 1 },
        { id: "BRA-204", title: "already running", status: "In Progress", priority: 1 },
      ],
      links: [{ taskId: "BRA-204", runId: "run-old-204", status: "linked", updatedAt: new Date().toISOString() }],
    };
    fs.writeFileSync(path.join(STATE_DIR, "task-runs.json"), JSON.stringify(seed, null, 2));
    const mapFile = path.join(WORKDIR, "map.json");
    fs.writeFileSync(mapFile, JSON.stringify({ "BRA-201": "workflows/library/judge-fix-loop.ts" }));
    const cli = (args: string[]) =>
      spawnSync([BUN, path.join(ROOT, "src", "cli.ts"), ...args, "--state-dir", STATE_DIR], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, DURABLETS_HOST: process.env.DURABLETS_HOST! },
      });
    const dry = cli(["admit", "--backend", "local", "--wip", "3", "--map", mapFile, "--dry-run"]);
    check(dry.exitCode === 0, `ADMIT-DRY OK: exit 0 (stderr: ${text(dry.stderr).slice(0, 200)})`);
    check(/ADMIT BRA-201/.test(text(dry.stdout)) && /needs-workflow/.test(text(dry.stdout)), `ADMIT-DRY OK: BRA-201 admitted, BRA-202 needs-workflow (out: ${text(dry.stdout).replace(/\n/g, " | ").slice(0, 300)})`);
    const afterDry = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "task-runs.json"), "utf8"));
    check(afterDry.links.length === 1, `ADMIT-DRY OK: dry run wrote nothing (links still ${afterDry.links.length})`);
    const real = cli(["admit", "--backend", "local", "--wip", "3", "--workflow", "workflows/library/judge-fix-loop.ts"]);
    check(real.exitCode === 0, `ADMIT OK: exit 0 (stderr: ${text(real.stderr).slice(0, 200)})`);
    const after = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "task-runs.json"), "utf8"));
    const linked = after.links.filter((l: any) => l.taskId === "BRA-201" || l.taskId === "BRA-202");
    check(linked.length === 2, `ADMIT OK: BRA-201 + BRA-202 linked to runs (got ${linked.length})`);
    check(linked.every((l: any) => l.runId.startsWith("run-bra-20")), `ADMIT OK: runIds carry the task id (got ${linked.map((l: any) => l.runId).join(",")})`);
    const queue = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "queue.json"), "utf8"));
    const q201 = queue.find((e: any) => e.taskId === "BRA-201");
    const q202 = queue.find((e: any) => e.taskId === "BRA-202");
    check(!!q201 && q201.priority === 1 && q201.status === "queued", "ADMIT OK: BRA-201 queued with priority 1");
    check(!!q202 && q202.priority === 4 && q202.status === "queued", "ADMIT OK: BRA-202 queued with priority 4");
    check(!queue.some((e: any) => e.taskId === "BRA-203"), "ADMIT OK: done BRA-203 never queued");
    // Second admit: nothing new — both are already queued/in flight.
    const again = cli(["admit", "--backend", "local", "--wip", "3", "--workflow", "workflows/library/judge-fix-loop.ts"]);
    check(/in flight: 3/.test(text(again.stdout)), `ADMIT-AGAIN OK: second admit sees 3 in flight, admits nothing new (out: ${text(again.stdout).replace(/\n/g, " | ").slice(0, 200)})`);
    const queue2 = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "queue.json"), "utf8"));
    check(queue2.length === queue.length, "ADMIT-AGAIN OK: no duplicate queue entries");
  }
}

// ---------------------------------------------------------------- G+H. host cost actuals + queue priority
console.log("\n=== G+H. host cost actuals + queue priority order ===");
{
  if (!process.env.DURABLETS_HOST) {
    fail("DURABLETS_HOST not set — run via run.sh");
  } else {
    const hostDir = path.join(WORKDIR, "host-state");
    const host = new Host({ stateDir: hostDir });
    const wf = path.join(ROOT, "tests", "workflows", "workflow-trap-types.ts");
    const runId = "run-cost-actuals";
    // The trap-types workflow is a 0-arg function, so it submits
    // with no input; the run path drives it to completion.
    host.submit(wf, { runId });
    await host.runQueue();
    const res = host.result(runId);
    check(res.status === "done", `HOST-RUN OK: trap-types workflow completes (status=${res.status})`);
    const actualsFile = path.join(hostDir, "cost-actuals.jsonl");
    const actuals = readJsonl(actualsFile);
    check(actuals.length >= 6, `COST-ACTUALS OK: ${actuals.length} trap actuals recorded (expected >= 6)`);
    const sites = new Set(actuals.map((a) => a.site));
    check(sites.has("job:score"), `COST-ACTUALS OK: job trap site is job:score (sites: ${[...sites].join(",")})`);
    check(sites.has("decide"), `COST-ACTUALS OK: decide trap site recorded (sites: ${[...sites].join(",")})`);
    check(actuals.every((a) => typeof a.ms === "number" && a.ms >= 0 && typeof a.runId === "string"), "COST-ACTUALS OK: every actual has ms >= 0 and a runId");
    // CLI cost-model reads the same file.
    const cm = spawnSync([BUN, path.join(ROOT, "src", "cli.ts"), "cost-model", "--state-dir", hostDir], { cwd: ROOT, encoding: "utf8", env: process.env });
    check(cm.exitCode === 0 && /job:score/.test(text(cm.stdout)) && /mean/.test(text(cm.stdout)), `COST-MODEL-CLI OK: prints per-site estimates (out: ${text(cm.stdout).replace(/\n/g, " | ").slice(0, 200)})`);

    // H: queue priority order — urgent run's traps precede low run's in the actuals file.
    const host2Dir = path.join(WORKDIR, "host2-state");
    const host2 = new Host({ stateDir: host2Dir });
    host2.enqueue(wf, "run-q-low", { priority: 4 });
    host2.enqueue(wf, "run-q-urgent", { priority: 1 });
    const qres = await host2.runQueue();
    check(qres.every((e) => e.status === "done"), `QUEUE-RUN OK: both queued runs done (got ${qres.map((e) => `${e.runId}:${e.status}`).join(",")})`);
    const lines = readJsonl(path.join(host2Dir, "cost-actuals.jsonl"));
    const firstUrgent = lines.findIndex((a) => a.runId === "run-q-urgent");
    const firstLow = lines.findIndex((a) => a.runId === "run-q-low");
    check(
      firstUrgent >= 0 && firstLow >= 0 && firstUrgent < firstLow,
      `QUEUE-PRIORITY OK: urgent run's first trap (line ${firstUrgent}) precedes low run's (line ${firstLow})`,
    );
  }
}

console.log(`\n${FAILURES.length === 0 ? "PASS" : "FAIL"} scheduling suite (BRA-49): ${FAILURES.length} failure(s)`);
if (FAILURES.length) {
  for (const f of FAILURES) console.log(`  - ${f}`);
  console.log(`workdir kept: ${WORKDIR}`);
  process.exit(1);
}
