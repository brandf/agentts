#!/usr/bin/env bun
/**
 * Tests for the lead-loop skeleton (no BRA number — this build is
 * unfiled while the Linear limit holds, so the test-braNNN.ts
 * convention has no number to use).
 *
 * Naming settled by the builder: tests/test-lead-loop.ts, run.sh
 * section + suite-inventory.json entry "lead-loop". Recorded here,
 * in the README §1.22 section, and in the workflow header.
 *
 * The lead loop (workflows/library/lead-loop.ts) is the generic
 * skeleton every lead boots as its main entry point: claim the
 * next job for its owner, dispatch it per the table (dispatch's
 * switch is the single source of truth — the loop never duplicates
 * the kind → workflow lookup), submit the routed run through the
 * scheduler, progress-check the owned runs pull-only, collect
 * completed reports, file first, run periodic work on cron, park
 * cheaply between jobs, and emit liveness the Director's
 * supervision check reads. One generic workflow, configured per
 * lead by a dispatch table in the run input (data, not code).
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh's section definitions on slug + tier).
 *   B. `agentts check` passes on lead-loop.ts (first-run gate).
 *   C. Pure unit checks: validateLeadLoopInput (every guard, exact
 *      error strings), buildTaskFields (mapping, nested paths,
 *      missing field omitted, verbatim passthrough), claimJob
 *      (happy path, other-owner counted, gated skipped, waiting-
 *      sequential skipped, already-collected skipped, 1,200-job
 *      size case), validateCron / isCronDue (@hourly/@daily/
 *      @weekly + 5-field lists/ranges, invalid crons named),
 *      wallClockScript / parseWallClock, progressCheckScript /
 *      parseProgressFacts (shape, malformed inputs throw, 1,200
 *      sub-run facts line exceeds the bound), submitScript /
 *      parseSubmitOutput (the CLI prints RUN first, then
 *      launched-by/owner lines — the parser scans every line,
 *      never the last), collectScript / parseCollectedResult
 *      (TOO-BIG, RESULT-ERROR, malformed JSON), ledgerTailScript
 *      / parseLedgerTail, healthScript / parseHealth,
 *      buildLiveness / parseLiveness (round-trip, malformed
 *      throws), filingMarker / renderLoopFilingEntry /
 *      filingScript / parseFilingResult, buildDispatchInput,
 *      buildLeadLoopReport (verdict matrix, known limit verbatim).
 *   D. Live runs through the CLI on direct against scratch trees,
 *      asserting verdicts AND on-disk results: D1 happy path
 *      (hello + dependency-mapping, two loop runs — first submits,
 *      queue driven, second collects; dispatch resolutions match
 *      the table, sub-run queue entries carry owner +
 *      launchedBy==loopId, handoff files, liveness file, exact
 *      hello greeting); D2 dispatch mismatch (table expects the
 *      wrong file → job refused, mismatch named, no submit); D3
 *      unknown kind (needs-workflow refusal); D4 gated job skipped
 *      + other-owner job counted, not claimed; D5 dry-run writes
 *      nothing; D6 cancel (cancelled → failed/cancelled true/
 *      cancelChecked true; no-entry → cancelChecked false); D7
 *      no-owner (absent → CLI schema refusal; empty → workflow
 *      refusal); D8 progress-check collect + decide surfacing +
 *      file-first + too-big result (scratch sub-workflows submitted
 *      directly with --launched-by <loopId>: a gate workflow driven
 *      to held, a fileFirst workflow (one titled item + one
 *      untitled item, recorded as skipped with the reason named),
 *      a 55KB-result workflow; the loop surfaces the pending decide
 *      and never answers it, files the fileFirst items, records the
 *      big result truncated; the owner then answers via deliver-gate
 *      and a later loop run collects it — its collected list is
 *      cumulative, prior-run entries seeding in as placeholders);
 *      D9 parked steps (ledger tail + queue depth +
 *      /health ok, and the no-serverUrl half); D10 periodic
 *      due/not-due via run.now + a bad-cron refusal; D11 sequential
 *      gating (parallel=false kind waits, parallel=true claims);
 *      D12 live progress-size case (1,200 fake done sub-runs in
 *      the queue → the progress check refuses loudly, the loop
 *      never advances blind); D13 cross-shift liveness counters
 *      (run A submits, run B collects + submits, run C collects —
 *      jobsCompleted == len(collectedRunIds), jobsPending == truly
 *      pending, collected cumulative with prior-run placeholders);
 *      D14 continuation after refusal (unknown kind refused, the
 *      next job submitted in the same run); D15 cancelled sub-run
 *      (cancelled mid-flight → job refused with the cancellation
 *      named, the kind unblocks, the next same-kind job claimed).
 *
 * Notes, stated plainly:
 * - A throwaway worker server runs on a random port and
 *   AGENTTS_WORKER_SERVER points at it before any submit: a
 *   Host's notifyEvent posts to the default port 18741 otherwise
 *   — the production server — and test events must never land
 *   there (BRA-133). The state dir is wiped at startup so re-runs
 *   are hermetic (the queue registry keeps run IDs forever).
 * - The live runs' leaf execs inherit this process's env, so
 *   DQUICKTS and TMPDIR must be set (run.sh sets DQUICKTS when
 *   it runs this test; TMPDIR is set here when absent). WORKDIR
 *   defaults under ~/tmp/home-tmp (never /tmp — the 512 MB tmpfs
 *   fills and tier-1 dies with ENOSPC); run.sh sets
 *   LEADLOOP_WORKDIR to the scratch dir.
 * - Trap-stdout budget: exec-trap stdout caps at ~60KB (Quality probe:
 *   59,561 B passes, 64,111 B crashes). The progress-check facts,
 *   the collect trap, and the liveness write are all bounded at
 *   48KB or chunked; the §C size cases + D12 prove the bounds.
 * - The §D outputs go to scratch paths, NEVER the real goal hidden
 *   files; the loop never touches Linear, the production queue, or
 *   the production worker server.
 * - The brief's "decide step" is a `gate` trap in engine terms:
 *   the gate is the holdable human checkpoint (a `decide` trap is
 *   answered locally by decideLocal and never holds). D8's scratch
 *   sub-workflow uses a gate trap, driven with --gates hold on
 *   both submit and queue run, and the owner answers via
 *   deliver-gate.
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-lead-loop.ts
 *   (run.sh sets DQUICKTS when it runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import leadLoop, {
  validateLeadLoopInput,
  buildTaskFields,
  claimJob,
  validateCron,
  isCronDue,
  wallClockScript,
  parseWallClock,
  progressCheckScript,
  parseProgressFacts,
  submitScript,
  parseSubmitOutput,
  collectScript,
  parseCollectedResult,
  ledgerTailScript,
  parseLedgerTail,
  healthScript,
  parseHealth,
  buildLiveness,
  parseLiveness,
  filingMarker,
  renderLoopFilingEntry,
  filingScript,
  parseFilingResult,
  buildDispatchInput,
  buildLeadLoopReport,
  LEAD_LOOP_KNOWN_LIMIT,
  LEAD_LOOP_COLLECT_MAX_BYTES,
  LEAD_LOOP_PROGRESS_MAX_BYTES,
  type LeadLoopInput,
  type LeadLoopProjectConfig,
  type LoopJob,
  type DispatchTableEntry,
  type JsonValue,
} from "../workflows/library/lead-loop";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const LEAD_LOOP = path.join(ROOT, "workflows", "library", "lead-loop.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.LEADLOOP_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "lead-loop-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const STATE_DIR = path.join(WORKDIR, "state");
// Hermetic re-runs: the queue registry keeps run IDs forever, so a
// second run against the same state dir would fail every submit as
// "already queued". Wipe our own throwaway state dir at startup.
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
/** The Implementation lead owns loop runs (brief: owner is the driving session). */
const IMPL_OWNER = "3e85493f-f748-4bcd-bec6-94be9c25b282";
const PM_OWNER = "eea685c3-230e-4c26-a286-b7ea60687c70";

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

function cli(args: string[], stdinText?: string): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
    input: stdinText,
    // A result can carry a 55KB blob (D8) — far over node's 1MB
    // spawnSync default is not needed, but the loop report with
    // many jobs is large; keep the headroom.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Every runId this test submits, in submit order. */
const submittedRunIds: string[] = [];
function track(runId: string): string[] {
  submittedRunIds.push(runId);
  return [...submittedRunIds];
}

let server: Subprocess | null = null;
async function startServer(): Promise<void> {
  server = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", STATE_DIR, "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("lead-loop server did not come up");
    await sleep(50);
  }
}
async function stopServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  try {
    s.kill(9);
  } catch { /* already dead */ }
  await s.exited;
}

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function readJson(p: string): Record<string, any> | null {
  const t = read(p);
  if (t === null) return null;
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    return null;
  }
}

/** The queue entries (parsed) at this moment, or null when the
 * queue file does not exist yet. */
function queueEntries(): Record<string, any>[] | null {
  const q = readJson(path.join(STATE_DIR, "queue.json"));
  return Array.isArray(q) ? (q as Record<string, any>[]) : null;
}
function queueEntry(runId: string): Record<string, any> | null {
  const es = queueEntries();
  if (es === null) return null;
  return es.find((e) => e.runId === runId) ?? null;
}

/** Drive one queue pass and return its rc (0 = clean, 1 = some
 * entry failed — the per-run signal is the run's own result,
 * not the exit code). */
function driveQueue(): number {
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--clock", "real", "--gates", "hold"]);
  if (drive.rc !== 0 && drive.rc !== 1) {
    fail(`DRIVE: queue run exits ${drive.rc} (expected 0 or 1): ${(drive.out + drive.err).slice(0, 300)}`);
  }
  return drive.rc;
}

/** Drive one lead-loop input through the CLI (submit + queue run
 * + result) and return the parsed report, or null on a CLI failure
 * (the failure is already recorded as a check). */
function driveLoop(runId: string, input: LeadLoopInput): Record<string, any> | null {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", LEAD_LOOP,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  if (sub.rc !== 0) return null;
  driveQueue();
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 300)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as Record<string, any>;
  } catch {
    fail(`RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

/** Submit one scratch sub-workflow directly (not via the loop),
 * with --launched-by <loopId> so the loop's progress check finds
 * it. `source` is inline workflow source (agentts run -).
 * Returns the runId. */
function submitScratchSubRun(args: {
  runId: string;
  source: string;
  input: unknown;
  loopId: string;
  gatesHold?: boolean;
}): string {
  track(args.runId);
  const inputFile = path.join(WORKDIR, `input-${args.runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(args.input));
  const cliArgs = [
    "run", "-",
    "--run-id", args.runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real",
    "--launched-by", args.loopId,
    "--owner", IMPL_OWNER,
  ];
  if (args.gatesHold) cliArgs.push("--gates", "hold");
  const sub = cli(cliArgs, args.source);
  check(sub.rc === 0, `SUBMIT OK: scratch sub-run ${args.runId} submits (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${args.runId}`), `SUBMIT OK: scratch sub-run prints RUN ${args.runId}`);
  return args.runId;
}

/** The shared project config for §D cases. */
function testProject(stateDir: string): LeadLoopProjectConfig {
  return {
    linearProject: "P-BRA-2",
    repo: COPY_ROOT,
    stateDir,
    roster: { implementation: IMPL_OWNER, pm: PM_OWNER },
    thresholds: {},
    workDir: path.join(WORKDIR, "project-work"),
    resumeDir: path.join(WORKDIR, "project-resume"),
  };
}

/** Build a §D case dir + a loop run input. The jobs/table are
 * filled in per case. */
function buildCase(args: {
  name: string;
  loopId: string;
  runId?: string;
  jobs: LoopJob[];
  dispatchTable: Record<string, DispatchTableEntry>;
  periodic?: Array<{ workflow: string; cron: string; fields?: Record<string, JsonValue> }>;
  maxIterations: number;
  now?: string;
  dryRun?: boolean;
  backlogPath?: string;
  serverUrl?: string;
  stateDir?: string;
  includeRunId?: boolean;
}): { dir: string; workDir: string; input: LeadLoopInput } {
  const dir = path.join(WORKDIR, "cases", args.name);
  fs.rmSync(dir, { recursive: true, force: true });
  const workDir = path.join(dir, "work");
  const stateDir = args.stateDir ?? STATE_DIR;
  const input: LeadLoopInput = {
    project: testProject(stateDir),
    run: {
      loopId: args.loopId,
      role: "implementation",
      jobs: args.jobs,
      dispatchTable: args.dispatchTable,
      workDir,
      stateDir,
      maxIterations: args.maxIterations,
      parkSeconds: 0,
      ...(args.periodic !== undefined ? { periodic: args.periodic } : {}),
      ...(args.now !== undefined ? { now: args.now } : {}),
      ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
      ...(args.backlogPath !== undefined ? { backlogPath: args.backlogPath } : {}),
      ...(args.serverUrl !== undefined ? { serverUrl: args.serverUrl } : {}),
      ...(args.includeRunId !== false && args.runId !== undefined ? { runId: args.runId } : {}),
    },
    launchedBy: "test-director",
    owner: IMPL_OWNER,
  };
  return { dir, workDir, input };
}

/** Minimal valid loop input (the §C base; cases mutate it). */
function validInput(): LeadLoopInput {
  return {
    project: testProject(STATE_DIR),
    run: {
      loopId: "impl-loop",
      role: "implementation",
      jobs: [{ jobId: "j1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } }],
      dispatchTable: {
        hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
      },
      workDir: path.join(WORKDIR, "valid-work"),
      stateDir: STATE_DIR,
      maxIterations: 1,
      parkSeconds: 0,
    },
    launchedBy: "test-director",
    owner: IMPL_OWNER,
  };
}

async function main(): Promise<number> {
  await startServer();
  try {
    // --------------------------------------------- §A inventory check
    console.log("\n=== §A inventory check ===");
    {
      const r = spawnSync(BUN, [path.join(ROOT, "scripts", "suite-inventory.ts"), "check"], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env },
      });
      check(r.status === 0, `INVENTORY OK: suite-inventory check exits 0 (got ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)})`);
      check(
        /inventory check passed: \d+ sections, run\.sh agrees/.test(r.stdout ?? ""),
        `INVENTORY OK: check prints the agreement line (got ${JSON.stringify((r.stdout ?? "").slice(0, 120))})`,
      );
    }

    // --------------------------------------------- §B agentts check
    console.log("\n=== §B agentts check ===");
    {
      const r = cli(["check", LEAD_LOOP, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on lead-loop.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("leadLoop(LeadLoopInput)"), `CHECK OK: entry is leadLoop(LeadLoopInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure units
    console.log("\n=== §C pure units ===");
    {
      // ---- validateLeadLoopInput: valid + every guard.
      check(validateLeadLoopInput(validInput()).length === 0, "C valid input passes validation");
      const noOwner = validInput();
      delete (noOwner as Record<string, any>).owner;
      check(
        validateLeadLoopInput(noOwner).some((e) => e === "lead-loop: input has no owner string — the owner is the driving session, never assumed from the launcher"),
        "C absent owner refused with the exact string",
      );
      const emptyOwner = validInput();
      emptyOwner.owner = "";
      check(
        validateLeadLoopInput(emptyOwner).some((e) => e === "lead-loop: input has no owner string — the owner is the driving session, never assumed from the launcher"),
        "C empty owner refused with the exact string",
      );
      const noLoopId = validInput();
      noLoopId.run.loopId = "";
      check(
        validateLeadLoopInput(noLoopId).includes("lead-loop: run has no loopId string"),
        "C empty loopId refused",
      );
      const noRole = validInput();
      noRole.run.role = "";
      check(validateLeadLoopInput(noRole).includes("lead-loop: run has no role string"), "C empty role refused");
      const dupJobs = validInput();
      dupJobs.run.jobs = [
        { jobId: "j1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: {} },
        { jobId: "j1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: {} },
      ];
      check(validateLeadLoopInput(dupJobs).includes("lead-loop: duplicate jobId j1"), "C duplicate jobId refused");
      const badBucket = validInput();
      badBucket.run.jobs = [{ jobId: "j1", kind: "hello", owner: IMPL_OWNER, bucket: "weird" as "ready", fields: {} }];
      check(
        validateLeadLoopInput(badBucket).includes('lead-loop: job j1 has an unknown bucket "weird"'),
        "C unknown bucket refused",
      );
      const noTable = validInput();
      delete (noTable.run as Record<string, any>).dispatchTable;
      check(validateLeadLoopInput(noTable).includes("lead-loop: run has no dispatchTable object"), "C missing dispatch table refused");
      const badParallel = validInput();
      (badParallel.run.dispatchTable.hello as Record<string, any>).parallel = "yes";
      check(
        validateLeadLoopInput(badParallel).includes("lead-loop: dispatch table entry for kind hello needs a parallel boolean"),
        "C non-boolean parallel refused",
      );
      const badMax = validInput();
      badMax.run.maxIterations = -1;
      check(
        validateLeadLoopInput(badMax).includes("lead-loop: run.maxIterations must be a non-negative integer"),
        "C negative maxIterations refused",
      );
      const badNow = validInput();
      badNow.run.now = "2026-11-21 12:00";
      check(
        validateLeadLoopInput(badNow).includes("lead-loop: run.now must be an ISO UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)"),
        "C malformed now refused",
      );
      const badPeriodic = validInput();
      badPeriodic.run.periodic = [{ workflow: "", cron: "@daily" }];
      check(
        validateLeadLoopInput(badPeriodic).some((e) => e.includes("every periodic entry needs a workflow string")),
        "C periodic entry without a workflow refused",
      );
      const noRun = { project: testProject(STATE_DIR), owner: IMPL_OWNER } as unknown as LeadLoopInput;
      check(validateLeadLoopInput(noRun).includes("lead-loop: input has no run object"), "C missing run object refused");
      const noProjectWorkDir = validInput();
      delete (noProjectWorkDir.project as Record<string, any>).workDir;
      check(
        validateLeadLoopInput(noProjectWorkDir).some((e) => e.includes("project has no workDir string")),
        "C missing project workDir refused (routed sub-workflows require it)",
      );
      const noProjectResumeDir = validInput();
      delete (noProjectResumeDir.project as Record<string, any>).resumeDir;
      check(
        validateLeadLoopInput(noProjectResumeDir).some((e) => e.includes("project has no resumeDir string")),
        "C missing project resumeDir refused (routed sub-workflows require it)",
      );

      // ---- buildTaskFields: mapping, nested paths, missing omitted, verbatim.
      const job: LoopJob = {
        jobId: "j1",
        kind: "hello",
        owner: IMPL_OWNER,
        bucket: "ready",
        fields: { name: "world", nested: { deep: "v" }, n: 3 },
      };
      check(
        JSON.stringify(buildTaskFields({ name: "fields.name", who: "fields.nested.deep", id: "jobId", k: "kind", o: "owner" }, job)) ===
          JSON.stringify({ name: "world", who: "v", id: "j1", k: "hello", o: IMPL_OWNER }),
        "C buildTaskFields maps fields + nested + job-level paths",
      );
      check(
        JSON.stringify(buildTaskFields({ name: "fields.name", missing: "fields.absent", alsoMissing: "fields.nested.nope" }, job)) ===
          JSON.stringify({ name: "world" }),
        "C buildTaskFields omits unresolvable paths",
      );
      check(
        JSON.stringify(buildTaskFields(undefined, job)) === JSON.stringify(job.fields),
        "C buildTaskFields without a builder passes fields verbatim",
      );

      // ---- claimJob: happy path, other-owner, gated, waiting, collected, size.
      const jobs: LoopJob[] = [
        { jobId: "a", kind: "hello", owner: PM_OWNER, bucket: "ready", fields: {} },
        { jobId: "b", kind: "hello", owner: IMPL_OWNER, bucket: "gated", fields: {} },
        { jobId: "c", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: {} },
        { jobId: "d", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: {} },
      ];
      const cl = claimJob(jobs, IMPL_OWNER, new Set(), new Set(), new Set());
      check(cl.claimed?.jobId === "c", "C claimJob claims the first ready owned job");
      check(cl.otherOwnerCount === 1, "C claimJob counts other-owner jobs, not lists them");
      check(cl.skipped.some((s) => s.jobId === "b" && s.reason === "gated — not claimed as ready"), "C claimJob skips gated with the reason named");
      const clWaiting = claimJob(jobs, IMPL_OWNER, new Set(), new Set(["hello"]), new Set());
      check(clWaiting.claimed === null, "C claimJob claims nothing when the kind is waiting-sequential");
      check(clWaiting.skipped.some((s) => s.jobId === "c" && s.reason.includes("waiting-sequential")), "C claimJob names the waiting-sequential skip");
      const clCollected = claimJob(jobs, IMPL_OWNER, new Set(), new Set(), new Set(["c"]));
      check(clCollected.claimed?.jobId === "d", "C claimJob skips already-collected jobs and claims the next");
      check(clCollected.skipped.some((s) => s.jobId === "c" && s.reason.includes("already-collected")), "C claimJob names the already-collected skip");
      const clClaimed = claimJob(jobs, IMPL_OWNER, new Set(["c"]), new Set(), new Set());
      check(clClaimed.claimed?.jobId === "d", "C claimJob skips already-claimed ids");
      // Size case: 1,200 dummy jobs claim the first, in input order.
      const bigJobs: LoopJob[] = Array.from({ length: 1200 }, (_, i) => ({
        jobId: `big-${i}`,
        kind: "hello",
        owner: IMPL_OWNER,
        bucket: "ready" as const,
        fields: {},
      }));
      const clBig = claimJob(bigJobs, IMPL_OWNER, new Set(), new Set(), new Set());
      check(clBig.claimed?.jobId === "big-0", "C claimJob size case claims the first of 1,200 jobs");

      // ---- validateCron / isCronDue.
      check(validateCron("@hourly") === null && validateCron("@daily") === null && validateCron("@weekly") === null, "C @hourly/@daily/@weekly validate");
      check(validateCron("0 0 * * *") === null, "C 5-field cron validates");
      check(validateCron("0,30 9-17 * * 1-5") === null, "C lists + ranges validate");
      check(validateCron("not a cron") === 'cron "not a cron" is not @hourly/@daily/@weekly or 5 fields', "C malformed cron refused with the exact string");
      check(validateCron("61 * * * *") === 'cron "61 * * * *" field 1 out of range', "C out-of-range minute refused");
      check(validateCron("* * * * 7") === 'cron "* * * * 7" field 5 out of range', "C out-of-range weekday refused");
      check(validateCron("5-2 * * * *") === 'cron "5-2 * * * *" field 1 has a bad range', "C reversed range refused");
      check(isCronDue("@hourly", "2026-11-21T12:00:00Z") === true, "C @hourly due at minute 0");
      check(isCronDue("@hourly", "2026-11-21T12:30:00Z") === false, "C @hourly not due at minute 30");
      check(isCronDue("@daily", "2026-11-21T00:00:00Z") === true, "C @daily due at midnight");
      check(isCronDue("@daily", "2026-11-21T12:00:00Z") === false, "C @daily not due at noon");
      check(isCronDue("@weekly", "2026-11-22T00:00:00Z") === true, "C @weekly due Sunday midnight (2026-11-22 is a Sunday)");
      check(isCronDue("@weekly", "2026-11-21T00:00:00Z") === false, "C @weekly not due Saturday midnight");
      check(isCronDue("30 9 * * 1-5", "2026-11-20T09:30:00Z") === true, "C 5-field cron due Friday 09:30");
      check(isCronDue("30 9 * * 1-5", "2026-11-21T09:30:00Z") === false, "C 5-field cron not due Saturday 09:30");
      check(isCronDue("not a cron", "2026-11-21T00:00:00Z") === false, "C invalid cron is never due");

      // ---- wall clock.
      check(wallClockScript().includes("date -u +%Y-%m-%dT%H:%M:%SZ"), "C wallClockScript is one date line");
      check(parseWallClock("2026-11-21T12:00:00Z\n") === "2026-11-21T12:00:00Z", "C parseWallClock parses the line");
      let threwClock = false;
      try {
        parseWallClock("not a date\n");
      } catch (e) {
        threwClock = (e as Error).message.includes("wall clock is not an ISO UTC timestamp");
      }
      check(threwClock, "C parseWallClock throws on a malformed line");

      // ---- progress check script + parser.
      const progScript = progressCheckScript({ stateDir: "/s", loopId: "impl-loop", livenessPath: "/s/liveness/implementation.json", maxBytes: 49152 });
      check(progScript.includes("/s") && progScript.includes("impl-loop") && progScript.includes("49152"), "C progressCheckScript carries state dir + loopId + bound");
      check(progScript.includes("gate-held"), "C progressCheckScript reads gate-held journal events");
      const factsLine = JSON.stringify({ queueDepth: 2, ownedQueued: 1, subRuns: [{ runId: "r1", status: "done" }], collectedRunIds: [] });
      const facts = parseProgressFacts(factsLine + "\n");
      check(facts.queueDepth === 2 && facts.subRuns[0].runId === "r1", "C parseProgressFacts parses the facts line");
      let threwFacts = false;
      try {
        parseProgressFacts("no json here\n");
      } catch (e) {
        threwFacts = (e as Error).message.includes("progress check printed no JSON line");
      }
      check(threwFacts, "C parseProgressFacts throws when no JSON line");
      let threwFacts2 = false;
      try {
        parseProgressFacts('{"queueDepth": 1}\n');
      } catch (e) {
        threwFacts2 = (e as Error).message.includes("missing queueDepth/ownedQueued/subRuns");
      }
      check(threwFacts2, "C parseProgressFacts throws when fields are missing");
      // Size case: 1,200 sub-runs make the facts line exceed the bound.
      const bigFacts = JSON.stringify({
        queueDepth: 0,
        ownedQueued: 0,
        subRuns: Array.from({ length: 1200 }, (_, i) => ({ runId: `fake-progress-size-${String(i).padStart(4, "0")}`, status: "done" })),
        collectedRunIds: [],
      });
      check(bigFacts.length > LEAD_LOOP_PROGRESS_MAX_BYTES, `C progress facts size case: 1,200 sub-runs is ${bigFacts.length} bytes, over the ${LEAD_LOOP_PROGRESS_MAX_BYTES} bound`);

      // ---- submit script + parser (the RUN-first regression).
      const subScript = submitScript({
        bunPath: BUN,
        cliPath: path.join(ROOT, "src", "cli.ts"),
        workflowAbs: COPY_ROOT + "/apps/agentts/workflows/library/hello.ts",
        runId: "impl-loop-j1",
        handoffPath: "/w/handoff.json",
        routedIndex: 0,
        inputFile: "/w/routed.json",
        stateDir: "/s",
        owner: IMPL_OWNER,
        launchedBy: "impl-loop",
      });
      check(subScript.includes("--adapter direct"), "C submitScript passes --adapter direct (sub-runs are real work, never mock-canned)");
      check(subScript.includes("ALREADY-SUBMITTED"), "C submitScript handles the idempotent re-submit");
      check(subScript.includes("impl-loop-j1") && subScript.includes("--launched-by"), "C submitScript carries the runId + launchedBy");
      // The CLI prints RUN first, then launched-by/owner — the parser must scan every line.
      const parsed = parseSubmitOutput("RUN impl-loop-j1\nlaunched by: impl-loop\nowner: " + IMPL_OWNER + "\n", "impl-loop-j1");
      check(parsed.status === "submitted" && parsed.runId === "impl-loop-j1", "C parseSubmitOutput finds RUN among the launched-by/owner lines");
      const parsedAlready = parseSubmitOutput("ALREADY-SUBMITTED impl-loop-j1\n", "impl-loop-j1");
      check(parsedAlready.status === "already-submitted", "C parseSubmitOutput parses ALREADY-SUBMITTED");
      let threwSubmit = false;
      try {
        parseSubmitOutput("SUBMIT-ERROR handoff unreadable: boom\n", "impl-loop-j1");
      } catch (e) {
        threwSubmit = (e as Error).message.includes("submit failed for impl-loop-j1");
      }
      check(threwSubmit, "C parseSubmitOutput throws on SUBMIT-ERROR");
      let threwSubmit2 = false;
      try {
        parseSubmitOutput("launched by: impl-loop\nowner: x\n", "impl-loop-j1");
      } catch (e) {
        threwSubmit2 = (e as Error).message.includes("submit output did not confirm impl-loop-j1");
      }
      check(threwSubmit2, "C parseSubmitOutput throws when no line confirms the run");

      // ---- collect script + parser.
      const colScript = collectScript({ bunPath: BUN, cliPath: path.join(ROOT, "src", "cli.ts"), runId: "r1", stateDir: "/s" });
      check(colScript.includes("TOO-BIG") && colScript.includes(String(LEAD_LOOP_COLLECT_MAX_BYTES)), "C collectScript bounds the result at the collect bound");
      const collected = parseCollectedResult(JSON.stringify({ verdict: "completed", greeting: "Hello, world!" }), "r1");
      check(collected.tooBig === false && (collected as { result: Record<string, unknown> }).result.verdict === "completed", "C parseCollectedResult parses a result object");
      const tooBig = parseCollectedResult("TOO-BIG 60000 r1\n", "r1");
      check(tooBig.tooBig === true && (tooBig as { bytes: number }).bytes === 60000, "C parseCollectedResult parses TOO-BIG");
      let threwCollect = false;
      try {
        parseCollectedResult("TOO-BIG 60000 r2\n", "r1");
      } catch (e) {
        threwCollect = (e as Error).message.includes("TOO-BIG names run r2 but collecting r1");
      }
      check(threwCollect, "C parseCollectedResult throws when TOO-BIG names another run");
      let threwCollect2 = false;
      try {
        parseCollectedResult("RESULT-ERROR boom\n", "r1");
      } catch (e) {
        threwCollect2 = (e as Error).message.includes("result read failed for r1");
      }
      check(threwCollect2, "C parseCollectedResult throws on RESULT-ERROR");

      // ---- ledger tail + health.
      check(ledgerTailScript("/s").includes("run-ledger.jsonl") && ledgerTailScript("/s").includes("cut -c1-200"), "C ledgerTailScript tails + cuts to 200 chars");
      check(JSON.stringify(parseLedgerTail("a\nb\n\n")) === JSON.stringify(["a", "b"]), "C parseLedgerTail drops blank lines");
      check(healthScript("http://127.0.0.1:18741").includes("/health") && healthScript("http://127.0.0.1:18741").includes("HEALTH ok"), "C healthScript curls /health");
      check(parseHealth("HEALTH ok\n") === true && parseHealth("HEALTH unreachable\n") === false, "C parseHealth reads the one line");

      // ---- liveness build + parse (round-trip + malformed).
      const live = buildLiveness({
        role: "implementation",
        owner: IMPL_OWNER,
        loopId: "impl-loop",
        heartbeatAt: "2026-11-21T12:00:00Z",
        lastClaimAt: "2026-11-21T12:00:00Z",
        lastClaimJobId: "j1",
        lastReportAt: null,
        jobsClaimed: 1,
        jobsCompleted: 0,
        jobsPending: 1,
        periodicRunsDone: [],
        queueDepth: 0,
        collectedRunIds: [],
        submittedRuns: [{ jobId: "j1", kind: "hello", runId: "impl-loop-j1", workflow: "apps/agentts/workflows/library/hello.ts", alreadySubmitted: false }],
      });
      const liveBack = parseLiveness(JSON.stringify(live));
      check(liveBack.loopId === "impl-loop" && liveBack.submittedRuns[0].runId === "impl-loop-j1", "C liveness round-trips including the submitted-run map");
      let threwLive = false;
      try {
        parseLiveness("{not json");
      } catch (e) {
        threwLive = (e as Error).message.includes("liveness file is not valid JSON");
      }
      check(threwLive, "C parseLiveness throws on invalid JSON");
      let threwLive2 = false;
      try {
        parseLiveness(JSON.stringify({ role: "implementation" }));
      } catch (e) {
        threwLive2 = (e as Error).message.includes("liveness file is missing owner");
      }
      check(threwLive2, "C parseLiveness throws when fields are missing");

      // ---- filing marker + entry + script + parser.
      check(filingMarker("impl-loop", "j1", 0) === "loop-filing: impl-loop/j1/0", "C filingMarker is deterministic");
      const entry = renderLoopFilingEntry({
        loopId: "impl-loop",
        jobId: "j1",
        kind: "hello",
        itemIndex: 0,
        title: "Do the thing",
        priority: "Low",
        estimate: 1,
        codeArea: "test",
        acceptance: ["it is done"],
        recorded: "2026-11-21",
      });
      check(entry.includes("## Do the thing") && entry.includes("<!-- loop-filing: impl-loop/j1/0 -->"), "C renderLoopFilingEntry carries the title + marker");
      check(entry.includes("**Priority:** Low.") && entry.includes("it is done"), "C renderLoopFilingEntry carries priority + acceptance");
      const unknownEntry = renderLoopFilingEntry({
        loopId: "impl-loop",
        jobId: "j1",
        kind: "hello",
        itemIndex: 1,
        title: "Unknown fields",
        recorded: "2026-11-21",
      });
      check(unknownEntry.includes("**Priority:** unknown.") && unknownEntry.includes("unknown — the sub-report's fileFirst item carried none"), "C renderLoopFilingEntry records unknown fields as unknown, never invents them");
      const fScript = filingScript("/b/BACKLOG.md", "QUJD", "loop-filing: impl-loop/j1/0");
      check(fScript.includes("FILED") && fScript.includes("EXISTS") && fScript.includes("/b/BACKLOG.md"), "C filingScript is idempotent on the marker");
      check(parseFilingResult("FILED loop-filing: impl-loop/j1/0\n", "loop-filing: impl-loop/j1/0") === "FILED", "C parseFilingResult parses FILED");
      check(parseFilingResult("EXISTS loop-filing: impl-loop/j1/0\n", "loop-filing: impl-loop/j1/0") === "EXISTS", "C parseFilingResult parses EXISTS");
      let threwFiling = false;
      try {
        parseFilingResult("something else\n", "loop-filing: impl-loop/j1/0");
      } catch (e) {
        threwFiling = (e as Error).message.includes("filing result did not confirm");
      }
      check(threwFiling, "C parseFilingResult throws when unconfirmed");

      // ---- buildDispatchInput.
      const di = buildDispatchInput({
        loopId: "impl-loop",
        job,
        tableEntry: { workflow: "apps/agentts/workflows/library/hello.ts", inputBuilder: { name: "fields.name" }, parallel: true },
        project: testProject(STATE_DIR),
        workDir: "/w",
        stateDir: "/s",
        owner: IMPL_OWNER,
        launchedBy: "test-director",
        dryRun: false,
      });
      check(di.run.tasks[0].tag === "hello" && (di.run.tasks[0].fields as Record<string, unknown>).name === "world", "C buildDispatchInput builds the task kind + fields");
      check(di.run.assignments["j1"] === IMPL_OWNER && di.run.handoffPath === "/w/handoff-j1.json", "C buildDispatchInput assigns the job owner + handoff path");
      check(
        (di.run.tasks[0].fields as Record<string, unknown>).runId === "impl-loop-j1",
        "C buildDispatchInput injects runId = the submit run id (the sub-workflow's cancel check looks its own entry up by it)",
      );

      // ---- buildLeadLoopReport: verdict matrix + known limit verbatim.
      const base = {
        loopId: "impl-loop",
        role: "implementation",
        dryRun: false,
        owner: IMPL_OWNER,
        cancelChecked: true,
        cancelled: false,
        iterations: 1,
        jobs: [],
        submitted: [],
        collected: [],
        filed: [],
        skipped: [],
        pendingDecides: [],
        periodicRunsDone: [],
        parked: null,
        livenessPath: "/s/liveness/implementation.json",
        queueDepth: 0,
      };
      const rCompleted = buildLeadLoopReport({ ...base, verdict: "completed" });
      check(rCompleted.verdict === "completed" && rCompleted.knownLimit === LEAD_LOOP_KNOWN_LIMIT, "C report carries the known limit verbatim");
      const rDry = buildLeadLoopReport({ ...base, verdict: "dry-run", dryRun: true });
      check(rDry.verdict === "dry-run", "C dry-run verdict");
      const rFailed = buildLeadLoopReport({
        ...base,
        verdict: "failed",
        jobs: [{ jobId: "j1", kind: "hello", outcome: "refused", reason: "no dispatch-table entry for kind hello" }],
      });
      check(rFailed.verdict === "failed" && rFailed.notes.some((n) => n.includes("no dispatch-table entry")), "C failed report names the refused job in notes");
      const rTrunc = buildLeadLoopReport({
        ...base,
        verdict: "completed",
        collected: [{ jobId: "j1", kind: "hello", runId: "r1", result: null, resultTruncated: true, filed: [] }],
        pendingDecides: [{ runId: "r1", jobId: "j1", trapId: "t1", question: "go?" }],
      });
      check(
        rTrunc.notes.some((n) => n.includes("exceeded the collect bound")) && rTrunc.notes.some((n) => n.includes("decide is owner-only")),
        "C report notes truncation + pending decides",
      );
    }

    // --------------------------------------------- §D live runs
    console.log("\n=== §D live runs ===");

    // ---- Case D1: happy path — hello + dependency-mapping, two loop runs.
    {
      const loopId = "impl-loop-d1";
      const runId1 = "loop-d1-run1";
      const runId2 = "loop-d1-run2";
      const c = buildCase({
        name: "D1-happy",
        loopId,
        runId: runId1,
        jobs: [
          { jobId: "d1-hello", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } },
          {
            jobId: "d1-depmap",
            kind: "dependency-mapping",
            owner: IMPL_OWNER,
            bucket: "ready",
            fields: {
              mappingId: "impl-loop-d1-d1-depmap",
              queuePath: path.join(WORKDIR, "cases", "D1-happy", "ranked-queue.json"),
              goalPath: path.join(WORKDIR, "cases", "D1-happy", "GOAL.md"),
              graphPath: path.join(WORKDIR, "cases", "D1-happy", "graph.json"),
              datedGraphPath: path.join(WORKDIR, "cases", "D1-happy", "graph-2026-11-21.json"),
            },
          },
        ],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", inputBuilder: { name: "fields.name" }, parallel: false },
          "dependency-mapping": { workflow: "apps/agentts/workflows/library/dependency-mapping.ts", parallel: true },
        },
        maxIterations: 2,
        now: "2026-11-21T12:00:00Z",
      });
      // The dependency-mapping fixture: a two-item ranked queue + GOAL.md.
      fs.mkdirSync(path.join(WORKDIR, "cases", "D1-happy"), { recursive: true });
      fs.writeFileSync(
        path.join(WORKDIR, "cases", "D1-happy", "ranked-queue.json"),
        JSON.stringify({
          generatedAt: "2026-11-21T00:00:00Z",
          triageId: "triage-d1",
          source: "test",
          counts: { open: 2, ready: 2, gatedButSpeculable: 0, blocked: 0, parked: 0, duplicates: 0, wontFix: 0 },
          items: [
            { issueId: "BRA-1", title: "first", priority: "High", bucket: "ready", dependencies: [], codeArea: "loop", blocks: ["BRA-2"], decisionGated: false },
            { issueId: "BRA-2", title: "second", priority: "Medium", bucket: "ready", dependencies: ["BRA-1"], codeArea: "other", blocks: [], decisionGated: false },
          ],
        }),
      );
      fs.writeFileSync(path.join(WORKDIR, "cases", "D1-happy", "GOAL.md"), "# r2\n");
      const out1 = driveLoop(runId1, c.input);
      if (out1) {
        check(out1.verdict === "completed", `D1 run 1 verdict completed (got ${out1.verdict})`);
        check(out1.iterations === 2, `D1 run 1 ran 2 iterations (got ${out1.iterations})`);
        check(out1.submitted.length === 2, `D1 run 1 submitted 2 sub-runs (got ${out1.submitted.length})`);
        const byJob: Record<string, any> = Object.fromEntries((out1.submitted as any[]).map((s: any) => [s.jobId, s]));
        check(byJob["d1-hello"]?.workflow === "apps/agentts/workflows/library/hello.ts", "D1 hello dispatched per the table");
        check(byJob["d1-depmap"]?.workflow === "apps/agentts/workflows/library/dependency-mapping.ts", "D1 dependency-mapping dispatched per the table");
        check(byJob["d1-hello"]?.runId === "impl-loop-d1-d1-hello", "D1 hello sub-run id is deterministic");
        const helloEntry = queueEntry("impl-loop-d1-d1-hello");
        const depmapEntry = queueEntry("impl-loop-d1-d1-depmap");
        check(helloEntry?.launchedBy === loopId && helloEntry?.owner === IMPL_OWNER, "D1 hello queue entry carries launchedBy==loopId + owner");
        check(depmapEntry?.launchedBy === loopId && depmapEntry?.owner === IMPL_OWNER, "D1 depmap queue entry carries launchedBy==loopId + owner");
        check(fs.existsSync(path.join(c.workDir, "handoff-d1-hello.json")), "D1 hello handoff file exists");
        check(fs.existsSync(path.join(c.workDir, "handoff-d1-depmap.json")), "D1 depmap handoff file exists");
        const live = readJson(path.join(STATE_DIR, "liveness", "impl-loop-d1.json"));
        check(live !== null && live.jobsClaimed === 2, `D1 liveness file exists with jobsClaimed 2 (got ${JSON.stringify(live?.jobsClaimed)})`);
        check(live !== null && live.submittedRuns.length === 2, "D1 liveness carries both submitted runs");
        check(live !== null && live.lastClaimJobId === "d1-depmap", "D1 liveness last claim is the depmap job");
        check((out1.jobs as any[]).every((j: any) => j.outcome === "pending"), "D1 run 1 jobs are pending (submitted, not yet collected)");
      }
      // Drive the sub-runs to done.
      driveQueue();
      check(queueEntry("impl-loop-d1-d1-hello")?.status === "done", "D1 hello sub-run is done after the queue drive");
      check(queueEntry("impl-loop-d1-d1-depmap")?.status === "done", "D1 depmap sub-run is done after the queue drive");
      check(fs.existsSync(path.join(WORKDIR, "cases", "D1-happy", "graph.json")), "D1 depmap graph file exists");
      check(fs.existsSync(path.join(WORKDIR, "cases", "D1-happy", "graph-2026-11-21.json")), "D1 depmap dated graph file exists");
      const helloRes = cli(["result", "impl-loop-d1-d1-hello", "--state-dir", STATE_DIR]);
      check(helloRes.rc === 0, `D1 hello result exits 0 (got ${helloRes.rc})`);
      if (helloRes.rc === 0) {
        check(JSON.parse(helloRes.out).greeting === "Hello, world!", "D1 hello result greeting is exactly Hello, world!");
      }
      // Second loop run, same loopId + same jobs list: collects both.
      const c2 = buildCase({
        name: "D1-collect",
        loopId,
        runId: runId2,
        jobs: c.input.run.jobs,
        dispatchTable: c.input.run.dispatchTable,
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      const out2 = driveLoop(runId2, c2.input);
      if (out2) {
        check(out2.verdict === "completed", `D1 run 2 verdict completed (got ${out2.verdict})`);
        check(out2.collected.length === 2, `D1 run 2 collected 2 sub-runs (got ${out2.collected.length})`);
        const byJob: Record<string, any> = Object.fromEntries((out2.collected as any[]).map((s: any) => [s.jobId, s]));
        check(byJob["d1-hello"]?.result?.greeting === "Hello, world!", "D1 run 2 collected the hello report as the job's result");
        check(byJob["d1-hello"]?.verdict === undefined, "D1 run 2 hello carries no verdict (hello returns only a greeting)");
        check(byJob["d1-depmap"]?.result !== null && byJob["d1-depmap"]?.verdict === "mapped", "D1 run 2 collected the depmap report with verdict mapped");
        check((out2.jobs as any[]).every((j: any) => j.outcome === "collected"), "D1 run 2 jobs are collected");
        check((out2.skipped as any[]).every((s: any) => s.reason.includes("already-collected")), "D1 run 2 re-issued jobs skip as already-collected");
        const live = readJson(path.join(STATE_DIR, "liveness", "impl-loop-d1.json"));
        check(
          live !== null &&
            (live.collectedRunIds as string[]).includes("impl-loop-d1-d1-hello") &&
            (live.collectedRunIds as string[]).includes("impl-loop-d1-d1-depmap"),
          "D1 liveness collectedRunIds holds both sub-runs",
        );
        check(live !== null && live.jobsCompleted === 2, "D1 liveness jobsCompleted is 2");
      }
    }

    // ---- Case D2: dispatch mismatch — the table expects the wrong file.
    {
      const loopId = "impl-loop-d2";
      const c = buildCase({
        name: "D2-mismatch",
        loopId,
        runId: "loop-d2-run1",
        jobs: [{ jobId: "d2-hello", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } }],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/triage.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      const out = driveLoop("loop-d2-run1", c.input);
      if (out) {
        check(out.verdict === "failed", `D2 verdict failed (got ${out.verdict})`);
        const job = (out.jobs as any[])[0];
        check(job?.outcome === "refused", "D2 job refused");
        check(
          typeof job?.reason === "string" &&
            job.reason.includes("dispatch mismatch") &&
            job.reason.includes("apps/agentts/workflows/library/hello.ts") &&
            job.reason.includes("apps/agentts/workflows/library/triage.ts"),
          `D2 refusal names the mismatch (got ${JSON.stringify(job?.reason)})`,
        );
        check(queueEntry("impl-loop-d2-d2-hello") === null, "D2 no queue entry for the mismatched job — nothing submitted");
        check(fs.existsSync(path.join(c.workDir, "handoff-d2-hello.json")), "D2 dispatch still wrote its handoff (the mismatch is the loop's check, after dispatch)");
      }
    }

    // ---- Case D3: unknown kind.
    {
      const loopId = "impl-loop-d3";
      const c = buildCase({
        name: "D3-unknown-kind",
        loopId,
        runId: "loop-d3-run1",
        jobs: [{ jobId: "d3-job", kind: "no-such-kind", owner: IMPL_OWNER, bucket: "ready", fields: {} }],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      const out = driveLoop("loop-d3-run1", c.input);
      if (out) {
        check(out.verdict === "failed", `D3 verdict failed (got ${out.verdict})`);
        const job = (out.jobs as any[])[0];
        check(
          job?.outcome === "refused" && typeof job?.reason === "string" && job.reason.includes("no dispatch-table entry for kind no-such-kind"),
          `D3 refusal names the unknown kind (got ${JSON.stringify(job?.reason)})`,
        );
        check(queueEntry("impl-loop-d3-d3-job") === null, "D3 nothing submitted for the unknown kind");
      }
    }

    // ---- Case D4: gated job skipped, other-owner job counted.
    {
      const loopId = "impl-loop-d4";
      const c = buildCase({
        name: "D4-skipped",
        loopId,
        runId: "loop-d4-run1",
        jobs: [
          { jobId: "d4-gated", kind: "hello", owner: IMPL_OWNER, bucket: "gated", fields: { name: "world" } },
          { jobId: "d4-other", kind: "hello", owner: PM_OWNER, bucket: "ready", fields: { name: "world" } },
        ],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      const out = driveLoop("loop-d4-run1", c.input);
      if (out) {
        check(out.verdict === "completed", `D4 verdict completed (got ${out.verdict})`);
        check(out.submitted.length === 0, "D4 nothing submitted");
        check(
          (out.skipped as any[]).some((s: any) => s.jobId === "d4-gated" && s.reason === "gated — not claimed as ready"),
          "D4 gated job skipped with the reason named",
        );
        check(
          (out.notes as string[]).some((n) => n.includes("1 job(s) in the input belonged to other owners")),
          "D4 other-owner job counted in notes, not claimed",
        );
        check(queueEntry("impl-loop-d4-d4-gated") === null && queueEntry("impl-loop-d4-d4-other") === null, "D4 no queue entries for skipped jobs");
      }
    }

    // ---- Case D5: dry-run writes nothing.
    {
      const loopId = "impl-loop-d5";
      const c = buildCase({
        name: "D5-dry-run",
        loopId,
        runId: "loop-d5-run1",
        jobs: [{ jobId: "d5-hello", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } }],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        dryRun: true,
      });
      const livenessPath = path.join(STATE_DIR, "liveness", "impl-loop-d5.json");
      const liveBefore = read(livenessPath);
      const out = driveLoop("loop-d5-run1", c.input);
      if (out) {
        check(out.verdict === "dry-run", `D5 verdict dry-run (got ${out.verdict})`);
        check((out.jobs as any[])[0]?.outcome === "planned", "D5 job planned, not submitted");
        check(out.livenessPath === "", "D5 liveness path is empty");
        check(read(livenessPath) === liveBefore, "D5 liveness file untouched by the dry-run");
        check(!fs.existsSync(path.join(c.workDir, "handoff-d5-hello.json")), "D5 no handoff file written");
        check(queueEntry("impl-loop-d5-d5-hello") === null, "D5 no queue entry for the planned job");
      }
    }

    // ---- Case D6: cancel check-then-act.
    {
      // (a) cancelled runId refuses before any work.
      // buildCase FIRST: it wipes the case dir, so the
      // hand-crafted cancel queue must be written after it.
      const cancelStateDir = path.join(WORKDIR, "cases", "D6-cancelled", "cancel-state");
      const c = buildCase({
        name: "D6-cancelled",
        loopId: "impl-loop-d6",
        runId: "loop-d6-cancelled",
        jobs: [{ jobId: "d6-hello", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } }],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        stateDir: cancelStateDir,
      });
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(path.join(cancelStateDir, "queue.json"), JSON.stringify([{ runId: "loop-d6-cancelled", status: "cancelled" }]));
      const out = driveLoop("loop-d6-cancelled", c.input);
      if (out) {
        check(out.verdict === "failed", `D6 cancelled verdict failed (got ${out.verdict})`);
        check(out.cancelled === true && out.cancelChecked === true, "D6 report says cancelled + cancelChecked");
        check(out.submitted.length === 0, "D6 nothing submitted for the cancelled run");
        check(!fs.existsSync(path.join(c.workDir, "handoff-d6-hello.json")), "D6 no handoff written for the cancelled run");
      }
      // (b) no queue entry: the check did not complete.
      const noEntryDir = path.join(WORKDIR, "cases", "D6-noentry", "cancel-state");
      const c2 = buildCase({
        name: "D6-noentry",
        loopId: "impl-loop-d6",
        runId: "loop-d6-noentry",
        jobs: [{ jobId: "d6-hello", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } }],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        stateDir: noEntryDir,
      });
      fs.mkdirSync(noEntryDir, { recursive: true });
      fs.writeFileSync(path.join(noEntryDir, "queue.json"), JSON.stringify([]));
      const out2 = driveLoop("loop-d6-noentry", c2.input);
      if (out2) {
        check(out2.verdict === "failed", `D6 no-entry verdict failed (got ${out2.verdict})`);
        check(out2.cancelChecked === false, "D6 no-entry report says cancelChecked false — the check did not complete");
        check((out2.notes as string[]).some((n) => n.includes("no queue entry for run loop-d6-noentry")), "D6 no-entry note names the missing entry");
      }
    }

    // ---- Case D7: no-owner.
    {
      const c = buildCase({
        name: "D7-no-owner",
        loopId: "impl-loop-d7",
        runId: "loop-d7-absent",
        jobs: [{ jobId: "d7-hello", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } }],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      // (a) absent owner: refused at submit by the CLI schema.
      const noOwnerInput: Record<string, any> = { ...c.input };
      delete noOwnerInput.owner;
      const absentFile = path.join(WORKDIR, "input-loop-d7-absent.json");
      fs.writeFileSync(absentFile, JSON.stringify(noOwnerInput));
      const sub = cli([
        "run", LEAD_LOOP,
        "--run-id", "loop-d7-absent",
        "--input-file", absentFile,
        "--state-dir", STATE_DIR,
        "--adapter", "direct", "--clock", "real", "--gates", "hold",
      ]);
      check(sub.rc !== 0, `D7 submit without owner is refused (got rc ${sub.rc})`);
      check(/must have required property 'owner'/.test(sub.out + sub.err), `D7 refusal names the missing owner (got ${JSON.stringify((sub.out + sub.err).slice(0, 200))})`);
      // (b) empty owner: the workflow refuses.
      const out = driveLoop("loop-d7-empty", { ...c.input, owner: "" });
      if (out) {
        check(out.verdict === "failed", `D7 verdict failed with empty owner (got ${out.verdict})`);
        check((out.notes as string[]).some((n) => /input has no owner string/.test(n)), `D7 note names the missing owner (got ${JSON.stringify(out.notes)})`);
        check(!fs.existsSync(path.join(c.workDir, "handoff-d7-hello.json")), "D7 nothing written with empty owner");
      }
    }

    // ---- Case D8: progress-check collect + decide surfacing + file-first + too-big.
    {
      const loopId = "impl-loop-d8";
      const gateRunId = "impl-loop-d8-gate-1";
      const fileRunId = "impl-loop-d8-file-1";
      const bigRunId = "impl-loop-d8-big-1";
      const helloRunId = "impl-loop-d8-hello-1";
      const backlogPath = path.join(WORKDIR, "cases", "D8-collect", "BACKLOG.md");
      fs.mkdirSync(path.join(WORKDIR, "cases", "D8-collect"), { recursive: true });
      fs.writeFileSync(backlogPath, "# BACKLOG\n");
      // The gate sub-workflow: a gate trap (the brief's decide step in
      // engine terms — a decide trap never holds, the gate does).
      const gateSource = [
        'import { gate } from "../../src/agentts";',
        "export interface GateWorkflowInput { question: string; }",
        "export interface GateWorkflowResult { verdict: string; answer: string; }",
        "export default function gateWorkflow(input: GateWorkflowInput): GateWorkflowResult {",
        "  const a = gate({ question: input.question });",
        '  return { verdict: "completed", answer: a.answer };',
        "}",
        "",
      ].join("\n");
      submitScratchSubRun({
        runId: gateRunId,
        source: gateSource,
        input: { question: "approve the test gate?" },
        loopId,
        gatesHold: true,
      });
      driveQueue();
      check(queueEntry(gateRunId)?.status === "held", "D8 gate sub-run is held after the drive");
      // The fileFirst sub-workflow: returns a fileFirst item
      // list — a titled item plus a second item with no title,
      // which the loop must record as skipped, not drop.
      const fileSource = [
        "export interface FileFirstInput { title: string; }",
        "export interface FileFirstResult { verdict: string; fileFirst: { items: Array<{ title?: string; priority: string; estimate: number; codeArea: string; acceptance: string[] }> }; }",
        "export default function fileFirstWorkflow(input: FileFirstInput): FileFirstResult {",
        '  return { verdict: "completed", fileFirst: { items: [{ title: input.title, priority: "Low", estimate: 1, codeArea: "test", acceptance: ["filed by the loop"] }, { priority: "Low", estimate: 1, codeArea: "test", acceptance: ["no title"] }] } };',
        "}",
        "",
      ].join("\n");
      submitScratchSubRun({ runId: fileRunId, source: fileSource, input: { title: "File this from the loop" }, loopId });
      // The big-result sub-workflow: a 55KB result (over the 48KB collect bound).
      const bigSource = [
        "export interface BigInput { note: string; }",
        "export interface BigResult { verdict: string; blob: string; }",
        "export default function bigWorkflow(_input: BigInput): BigResult {",
        '  return { verdict: "completed", blob: "x".repeat(55000) };',
        "}",
        "",
      ].join("\n");
      submitScratchSubRun({ runId: bigRunId, source: bigSource, input: { note: "big" }, loopId });
      // A plain hello sub-workflow, submitted by path (not stdin).
      track(helloRunId);
      const helloInputFile = path.join(WORKDIR, "input-" + helloRunId + ".json");
      fs.writeFileSync(helloInputFile, JSON.stringify({ name: "world" }));
      const helloSub = cli([
        "run", path.join(ROOT, "workflows", "library", "hello.ts"),
        "--run-id", helloRunId,
        "--input-file", helloInputFile,
        "--state-dir", STATE_DIR,
        "--adapter", "direct", "--clock", "real",
        "--launched-by", loopId,
        "--owner", IMPL_OWNER,
      ]);
      check(helloSub.rc === 0, `SUBMIT OK: hello sub-run submits (got ${helloSub.rc})`);
      driveQueue();
      check(queueEntry(fileRunId)?.status === "done", "D8 fileFirst sub-run is done");
      check(queueEntry(bigRunId)?.status === "done", "D8 big sub-run is done");
      check(queueEntry(helloRunId)?.status === "done", "D8 hello sub-run is done");
      check(queueEntry(gateRunId)?.status === "held", "D8 gate sub-run is still held (not driven to done)");
      // Loop run 1: no jobs to claim — it collects + surfaces the decide.
      const c = buildCase({
        name: "D8-collect",
        loopId,
        runId: "loop-d8-run1",
        jobs: [],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        backlogPath,
      });
      const out = driveLoop("loop-d8-run1", c.input);
      if (out) {
        check(out.verdict === "completed", `D8 run 1 verdict completed (got ${out.verdict})`);
        check(out.collected.length === 3, `D8 run 1 collected 3 done sub-runs (got ${out.collected.length})`);
        const byRun: Record<string, any> = Object.fromEntries((out.collected as any[]).map((s: any) => [s.runId, s]));
        check(byRun[fileRunId]?.verdict === "completed", "D8 fileFirst collected with verdict completed");
        check(byRun[fileRunId]?.filed.length === 1, "D8 fileFirst filed one item");
        check(
          (out.notes as string[]).some((n) => n.includes(fileRunId + ": fileFirst item 1 has no title — skipped")),
          "D8 untitled fileFirst item recorded in notes with the reason named",
        );
        check(byRun[helloRunId]?.result?.greeting === "Hello, world!", "D8 hello collected with the exact greeting");
        check(byRun[bigRunId]?.resultTruncated === true && byRun[bigRunId]?.result === null, "D8 big result recorded as truncated, not collected");
        check(
          (out.notes as string[]).some((n) => n.includes("exceeded the collect bound") && n.includes(bigRunId)),
          "D8 truncation named in notes with the run id",
        );
        check(out.pendingDecides.length === 1, `D8 one pending decide surfaced (got ${out.pendingDecides.length})`);
        const pd = (out.pendingDecides as any[])[0];
        check(pd?.runId === gateRunId, "D8 pending decide names the gate sub-run");
        check(pd?.question === "approve the test gate?", `D8 pending decide carries the question (got ${JSON.stringify(pd?.question)})`);
        check(typeof pd?.trapId === "string" && pd.trapId !== "", "D8 pending decide carries a trap id");
        check(
          (out.notes as string[]).some((n) => n.includes("decide is owner-only")),
          "D8 notes say the decide is owner-only",
        );
        check(queueEntry(gateRunId)?.status === "held", "D8 the loop never answered the gate — it is still held");
        const backlog = read(backlogPath) ?? "";
        check(backlog.includes("## File this from the loop"), "D8 BACKLOG.md carries the filed entry");
        check(backlog.includes("<!-- loop-filing: impl-loop-d8/"), "D8 filed entry carries the loop-filing marker");
        check(backlog.includes("filed by the loop"), "D8 filed entry carries the acceptance criterion");
        check(out.filed.length === 1 && (out.filed as any[])[0].backlogPath === backlogPath, "D8 report lists the filed item with its backlog path");
      }
      // The owner answers via deliver-gate; a later loop run collects it.
      const deliver = cli(["deliver-gate", gateRunId, '{"answer":"yes"}', "--state-dir", STATE_DIR]);
      check(deliver.rc === 0, `D8 deliver-gate exits 0 (got ${deliver.rc}: ${(deliver.out + deliver.err).slice(0, 200)})`);
      driveQueue();
      check(queueEntry(gateRunId)?.status === "done", "D8 gate sub-run is done after the owner answers");
      const c2 = buildCase({
        name: "D8-collect-2",
        loopId,
        runId: "loop-d8-run2",
        jobs: [],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        backlogPath,
      });
      const out2 = driveLoop("loop-d8-run2", c2.input);
      if (out2) {
        // collected is cumulative across loop runs: run 1's
        // three collections seed in as placeholders (result
        // null), plus the gate run collected here.
        check(out2.collected.length === 4, `D8 run 2 collected is cumulative (3 placeholders + gate, got ${out2.collected.length})`);
        const got = (out2.collected as any[]).find((s: any) => s.runId === gateRunId);
        check(got?.runId === gateRunId && got?.result?.answer === "yes", "D8 run 2 collected the gate answer yes");
        const placeholders = (out2.collected as any[]).filter((s: any) => s.runId !== gateRunId);
        check(
          placeholders.length === 3 && placeholders.every((s: any) => s.result === null),
          "D8 run 2 prior-run entries are placeholders with result null",
        );
        check(out2.pendingDecides.length === 0, "D8 run 2 surfaces no pending decide — the gate is answered");
        check(read(backlogPath)?.split("File this from the loop").length === 2, "D8 re-run did not file the same item twice");
      }
    }

    // ---- Case D9: parked steps (ledger tail + queue depth + /health).
    {
      const ledgerDir = path.join(STATE_DIR, "ledger");
      fs.mkdirSync(ledgerDir, { recursive: true });
      const longLine = '{"event":"run","runId":"x","note":"' + "y".repeat(300) + '"}';
      const lines = [
        '{"event":"run","runId":"a"}',
        '{"event":"run","runId":"b"}',
        '{"event":"run","runId":"c"}',
        '{"event":"run","runId":"d"}',
        longLine,
      ];
      fs.writeFileSync(path.join(ledgerDir, "run-ledger.jsonl"), lines.join("\n") + "\n");
      const c = buildCase({
        name: "D9-parked",
        loopId: "impl-loop-d9",
        runId: "loop-d9-run1",
        jobs: [],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        serverUrl: SERVER_URL,
      });
      const out = driveLoop("loop-d9-run1", c.input);
      if (out) {
        check(out.verdict === "completed", `D9 verdict completed (got ${out.verdict})`);
        check(out.parked !== null && (out.parked as any).iterations === 1, "D9 one parked iteration ran");
        const parked = out.parked as any;
        check(JSON.stringify(parked.ledgerTail) === JSON.stringify([...lines.slice(0, 4), longLine.slice(0, 200)]), "D9 ledger tail is the last 5 lines, each cut to 200 chars");
        check(typeof parked.queueDepth === "number", "D9 parked carries the queue depth from the progress check");
        check(parked.healthOk === true, "D9 /health answered ok against the test server");
        check(typeof parked.healthNote === "string" && parked.healthNote.includes("ok"), "D9 health note says ok");
      }
      // No serverUrl: the health step is skipped with a note.
      const c2 = buildCase({
        name: "D9-no-server",
        loopId: "impl-loop-d9b",
        runId: "loop-d9-run2",
        jobs: [],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      const out2 = driveLoop("loop-d9-run2", c2.input);
      if (out2) {
        const parked = out2.parked as any;
        check(parked !== null && parked.healthOk === false, "D9 no-server healthOk false");
        check(typeof parked.healthNote === "string" && parked.healthNote.includes("no serverUrl"), "D9 no-server health note names the missing serverUrl");
      }
    }

    // ---- Case D10: periodic due / not-due / bad cron.
    {
      const table = { hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true } };
      const periodic = [{ workflow: "hello", cron: "@daily", fields: { name: "periodic" } }];
      const cDue = buildCase({
        name: "D10-due",
        loopId: "impl-loop-d10-due",
        runId: "loop-d10-due",
        jobs: [],
        dispatchTable: table,
        periodic,
        maxIterations: 1,
        now: "2026-11-21T00:00:00Z",
      });
      const outDue = driveLoop("loop-d10-due", cDue.input);
      if (outDue) {
        check(outDue.submitted.length === 1, `D10 due submitted the periodic hello (got ${outDue.submitted.length})`);
        const s = (outDue.submitted as any[])[0];
        check(s?.jobId === "periodic-hello" && s?.runId === "impl-loop-d10-due-periodic-hello", "D10 due periodic job + run ids are synthetic");
        check(queueEntry("impl-loop-d10-due-periodic-hello")?.launchedBy === "impl-loop-d10-due", "D10 due periodic queue entry carries launchedBy==loopId");
        check((outDue.periodicRunsDone as string[]).includes("hello"), "D10 due periodicRunsDone names hello");
      }
      const cNotDue = buildCase({
        name: "D10-notdue",
        loopId: "impl-loop-d10-notdue",
        runId: "loop-d10-notdue",
        jobs: [],
        dispatchTable: table,
        periodic,
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
      });
      const outNotDue = driveLoop("loop-d10-notdue", cNotDue.input);
      if (outNotDue) {
        check(outNotDue.submitted.length === 0, "D10 not-due submitted nothing");
        check((outNotDue.periodicRunsDone as string[]).length === 0, "D10 not-due periodicRunsDone empty");
        check(queueEntry("impl-loop-d10-notdue-periodic-hello") === null, "D10 not-due no queue entry");
      }
      const cBad = buildCase({
        name: "D10-bad-cron",
        loopId: "impl-loop-d10-bad",
        runId: "loop-d10-bad",
        jobs: [],
        dispatchTable: table,
        periodic: [{ workflow: "hello", cron: "not a cron" }],
        maxIterations: 1,
        now: "2026-11-21T00:00:00Z",
      });
      const outBad = driveLoop("loop-d10-bad", cBad.input);
      if (outBad) {
        check(outBad.verdict === "failed", `D10 bad cron verdict failed (got ${outBad.verdict})`);
        check((outBad.notes as string[]).some((n) => n.includes("bad cron") && n.includes("not a cron")), "D10 bad cron note names the cron");
      }
    }

    // ---- Case D11: sequential gating (parallel=false waits, parallel=true claims).
    // The parallel:true kind must be one dispatch knows
    // (worker-lifecycle, operation list against the test server)
    // — the loop can only dispatch kinds in dispatch's switch.
    {
      const loopId = "impl-loop-d11";
      const c = buildCase({
        name: "D11-gating",
        loopId,
        runId: "loop-d11-run1",
        jobs: [
          { jobId: "d11-h1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "one" } },
          { jobId: "d11-h2", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "two" } },
          { jobId: "d11-w1", kind: "worker-lifecycle", owner: IMPL_OWNER, bucket: "ready", fields: { operation: "list", serverUrl: SERVER_URL } },
          { jobId: "d11-w2", kind: "worker-lifecycle", owner: IMPL_OWNER, bucket: "ready", fields: { operation: "list", serverUrl: SERVER_URL } },
        ],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: false },
          "worker-lifecycle": { workflow: "apps/agentts/workflows/library/worker-lifecycle.ts", parallel: true },
        },
        maxIterations: 3,
        now: "2026-11-21T12:00:00Z",
      });
      const out = driveLoop("loop-d11-run1", c.input);
      if (out) {
        check(out.verdict === "completed", `D11 verdict completed (got ${out.verdict})`);
        const submittedIds = (out.submitted as any[]).map((s: any) => s.runId);
        check(
          JSON.stringify(submittedIds) === JSON.stringify(["impl-loop-d11-d11-h1", "impl-loop-d11-d11-w1", "impl-loop-d11-d11-w2"]),
          `D11 submitted h1, w1, w2 in order (got ${JSON.stringify(submittedIds)})`,
        );
        check(
          (out.skipped as any[]).some((s: any) => s.jobId === "d11-h2" && s.reason.includes("waiting-sequential")),
          "D11 h2 skipped as waiting-sequential while h1 is pending",
        );
        check(queueEntry("impl-loop-d11-d11-h2") === null, "D11 h2 never submitted");
      }
    }

    // ---- Case D12: live progress-size case — 1,200 fake done sub-runs refuse loudly.
    {
      const loopId = "impl-loop-d12";
      const runId = "loop-d12-run1";
      const c = buildCase({
        name: "D12-progress-size",
        loopId,
        runId,
        jobs: [],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", parallel: true },
        },
        maxIterations: 1,
        now: "2026-11-21T12:00:00Z",
        includeRunId: false,
      });
      // Submit the loop run first (its own entry lands in the queue),
      // then append 1,200 fake DONE sub-runs for this loopId. Done
      // entries are never driven (runQueue only drives queued ones),
      // but the progress check reads them all — and must refuse
      // loudly instead of truncating the facts line.
      track(runId);
      const inputFile = path.join(WORKDIR, `input-${runId}.json`);
      fs.writeFileSync(inputFile, JSON.stringify(c.input));
      const sub = cli([
        "run", LEAD_LOOP,
        "--run-id", runId,
        "--input-file", inputFile,
        "--state-dir", STATE_DIR,
        "--adapter", "direct", "--clock", "real", "--gates", "hold",
      ]);
      check(sub.rc === 0, `SUBMIT OK: D12 loop submits (got ${sub.rc})`);
      const queuePath = path.join(STATE_DIR, "queue.json");
      const entries = JSON.parse(fs.readFileSync(queuePath, "utf8")) as Record<string, any>[];
      for (let i = 0; i < 1200; i++) {
        entries.push({
          runId: `fake-progress-size-${String(i).padStart(4, "0")}`,
          workflowPath: "apps/agentts/workflows/library/hello.ts",
          adapter: "direct",
          status: "done",
          launchedBy: loopId,
          owner: IMPL_OWNER,
          enqueuedAt: "2026-11-21T00:00:00Z",
          input: { name: "fake" },
        });
      }
      fs.writeFileSync(queuePath, JSON.stringify(entries));
      driveQueue();
      const res = cli(["result", runId, "--state-dir", STATE_DIR]);
      check(res.rc === 0, `RESULT OK: D12 result exits 0 (got ${res.rc})`);
      if (res.rc === 0) {
        const out = JSON.parse(res.out) as Record<string, any>;
        check(out.verdict === "failed", `D12 verdict failed (got ${out.verdict})`);
        check(
          (out.notes as string[]).some((n) => n.includes("progress check") && n.includes("exceed the bound")),
          `D12 note names the progress bound refusal (got ${JSON.stringify(out.notes)})`,
        );
        check(out.submitted.length === 0, "D12 nothing submitted — the loop never advanced blind");
      }
    }

    // ---- Case D13: cross-shift liveness counters — run A
    // submits h1; run B collects h1 and submits w1 + w2; run C
    // collects w1 + w2. The liveness counters and the report's
    // collected list are cumulative across loop runs.
    {
      const loopId = "impl-loop-d13";
      const jobs: LoopJob[] = [
        { jobId: "d13-h1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "one" } },
        { jobId: "d13-w1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "two" } },
        { jobId: "d13-w2", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "three" } },
      ];
      const table = {
        hello: { workflow: "apps/agentts/workflows/library/hello.ts", inputBuilder: { name: "fields.name" }, parallel: true },
      };
      const live = () => readJson(path.join(STATE_DIR, "liveness", "impl-loop-d13.json"));
      // Run A: submits h1.
      const cA = buildCase({ name: "D13-run-a", loopId, runId: "loop-d13-run-a", jobs: [jobs[0]], dispatchTable: table, maxIterations: 1, now: "2026-11-21T12:00:00Z" });
      const outA = driveLoop("loop-d13-run-a", cA.input);
      if (outA) {
        check(outA.submitted.length === 1, `D13 run A submitted 1 (got ${outA.submitted.length})`);
        check(live()?.jobsCompleted === 0 && live()?.jobsPending === 1, "D13 run A liveness 0 completed / 1 pending");
      }
      driveQueue();
      check(queueEntry("impl-loop-d13-d13-h1")?.status === "done", "D13 h1 is done after the drive");
      // Run B: collects h1, submits w1 + w2.
      const cB = buildCase({ name: "D13-run-b", loopId, runId: "loop-d13-run-b", jobs, dispatchTable: table, maxIterations: 2, now: "2026-11-21T12:00:00Z" });
      const outB = driveLoop("loop-d13-run-b", cB.input);
      if (outB) {
        check(outB.collected.length === 1, `D13 run B collected 1 (h1, got ${outB.collected.length})`);
        check(outB.submitted.length === 3, `D13 run B submitted is cumulative (3, got ${outB.submitted.length})`);
        check(live()?.jobsCompleted === 1 && live()?.jobsPending === 2, "D13 run B liveness 1 completed / 2 pending");
      }
      driveQueue();
      check(queueEntry("impl-loop-d13-d13-w1")?.status === "done", "D13 w1 is done after the drive");
      check(queueEntry("impl-loop-d13-d13-w2")?.status === "done", "D13 w2 is done after the drive");
      // Run C: collects w1 + w2.
      const cC = buildCase({ name: "D13-run-c", loopId, runId: "loop-d13-run-c", jobs, dispatchTable: table, maxIterations: 1, now: "2026-11-21T12:00:00Z" });
      const outC = driveLoop("loop-d13-run-c", cC.input);
      if (outC) {
        check(outC.collected.length === 3, `D13 run C collected is cumulative (3, got ${outC.collected.length})`);
        check(outC.submitted.length === 3, `D13 run C submitted is cumulative (3, got ${outC.submitted.length})`);
        const byJob: Record<string, any> = Object.fromEntries((outC.collected as any[]).map((s: any) => [s.jobId, s]));
        check(byJob["d13-h1"]?.result === null, "D13 run C h1 entry is a prior-run placeholder (result null)");
        check(byJob["d13-w1"]?.result?.greeting === "Hello, two!", "D13 run C w1 collected with its greeting");
        check(byJob["d13-w2"]?.result?.greeting === "Hello, three!", "D13 run C w2 collected with its greeting");
        check(live()?.jobsCompleted === 3, `D13 run C liveness jobsCompleted is 3 (got ${JSON.stringify(live()?.jobsCompleted)})`);
        check(live()?.jobsPending === 0, `D13 run C liveness jobsPending is 0 (got ${JSON.stringify(live()?.jobsPending)})`);
        check((live()?.collectedRunIds as string[]).length === 3, "D13 run C liveness collectedRunIds holds all 3 runs");
      }
    }

    // ---- Case D14: continuation after refusal — an unknown
    // kind is refused and the loop moves on to the next job in
    // the same run instead of re-claiming the refused job.
    {
      const loopId = "impl-loop-d14";
      const c = buildCase({
        name: "D14-refusal-continue",
        loopId,
        runId: "loop-d14-run1",
        jobs: [
          { jobId: "d14-u1", kind: "no-such-kind", owner: IMPL_OWNER, bucket: "ready", fields: {} },
          { jobId: "d14-h9", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "world" } },
        ],
        dispatchTable: {
          hello: { workflow: "apps/agentts/workflows/library/hello.ts", inputBuilder: { name: "fields.name" }, parallel: true },
        },
        maxIterations: 2,
        now: "2026-11-21T12:00:00Z",
      });
      const out = driveLoop("loop-d14-run1", c.input);
      if (out) {
        check(out.verdict === "completed", `D14 verdict completed (got ${out.verdict})`);
        check(out.iterations === 2, `D14 ran both iterations (got ${out.iterations})`);
        const byJob: Record<string, any> = Object.fromEntries((out.jobs as any[]).map((j: any) => [j.jobId, j]));
        check(
          byJob["d14-u1"]?.outcome === "refused" &&
            typeof byJob["d14-u1"]?.reason === "string" &&
            byJob["d14-u1"].reason.includes("no dispatch-table entry for kind no-such-kind"),
          `D14 unknown kind refused with the kind named (got ${JSON.stringify(byJob["d14-u1"]?.reason)})`,
        );
        check(byJob["d14-h9"]?.outcome === "pending", "D14 good job submitted after the refusal (pending, not starved)");
        check(out.submitted.length === 1, `D14 submitted exactly the good job (got ${out.submitted.length})`);
        check(queueEntry("impl-loop-d14-d14-h9") !== null, "D14 queue entry exists for the good job");
        check(queueEntry("impl-loop-d14-d14-u1") === null, "D14 no queue entry for the refused job");
        check(
          (out.notes as string[]).some((n) => n.includes("no dispatch-table entry for kind no-such-kind")),
          "D14 refusal is in the report's notes",
        );
      }
    }

    // ---- Case D15: cancelled sub-run — a dispatched sub-run
    // cancelled mid-flight is terminal, not still-running: the
    // job is refused with the cancellation named, the kind
    // unblocks, and the next same-kind job is claimed.
    {
      const loopId = "impl-loop-d15";
      const jobs: LoopJob[] = [
        { jobId: "d15-h1", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "one" } },
        { jobId: "d15-h2", kind: "hello", owner: IMPL_OWNER, bucket: "ready", fields: { name: "two" } },
      ];
      const table = {
        hello: { workflow: "apps/agentts/workflows/library/hello.ts", inputBuilder: { name: "fields.name" }, parallel: false },
      };
      // Run 1: submits h1 (sequential — h2 waits behind it).
      const c1 = buildCase({ name: "D15-cancel", loopId, runId: "loop-d15-run1", jobs, dispatchTable: table, maxIterations: 1, now: "2026-11-21T12:00:00Z" });
      const out1 = driveLoop("loop-d15-run1", c1.input);
      if (out1) {
        check(out1.submitted.length === 1, `D15 run 1 submitted h1 (got ${out1.submitted.length})`);
        check(queueEntry("impl-loop-d15-d15-h1")?.status === "queued", "D15 h1 is queued after run 1");
      }
      // Cancel h1's queue entry directly (the D6 shape).
      const queuePath = path.join(STATE_DIR, "queue.json");
      const entries = JSON.parse(fs.readFileSync(queuePath, "utf8")) as Record<string, any>[];
      const h1Entry = entries.find((e) => e.runId === "impl-loop-d15-d15-h1");
      check(h1Entry !== undefined, "D15 h1 queue entry exists to cancel");
      if (h1Entry !== undefined) {
        h1Entry.status = "cancelled";
        fs.writeFileSync(queuePath, JSON.stringify(entries));
      }
      // Run 2: collects the cancellation, unblocks the kind, claims h2.
      const c2 = buildCase({ name: "D15-collect", loopId, runId: "loop-d15-run2", jobs, dispatchTable: table, maxIterations: 1, now: "2026-11-21T12:00:00Z" });
      const out2 = driveLoop("loop-d15-run2", c2.input);
      if (out2) {
        const byJob: Record<string, any> = Object.fromEntries((out2.jobs as any[]).map((j: any) => [j.jobId, j]));
        check(
          byJob["d15-h1"]?.outcome === "refused" &&
            typeof byJob["d15-h1"]?.reason === "string" &&
            byJob["d15-h1"].reason.includes("was cancelled"),
          `D15 h1 refused with the cancellation named (got ${JSON.stringify(byJob["d15-h1"]?.reason)})`,
        );
        check(byJob["d15-h2"]?.outcome === "pending", "D15 h2 submitted after the cancellation unblocked the kind");
        check(out2.verdict === "completed", `D15 verdict completed — h1 refused, not stranded (got ${out2.verdict})`);
        check(out2.submitted.length === 2, `D15 submitted is cumulative (h1 + h2, got ${out2.submitted.length})`);
        check(queueEntry("impl-loop-d15-d15-h2") !== null, "D15 queue entry exists for h2");
        check(
          (out2.notes as string[]).some((n) => n.includes("was cancelled") && n.includes("impl-loop-d15-d15-h1")),
          "D15 cancellation is in the report's notes with the run id",
        );
        const live = readJson(path.join(STATE_DIR, "liveness", "impl-loop-d15.json"));
        check(live?.jobsCompleted === 1 && live?.jobsPending === 1, "D15 liveness counts the cancelled run as collected (1 completed / 1 pending)");
      }
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`LEADLOOP FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS lead-loop skeleton (inventory check, agentts check, pure unit checks, live scratch-tree runs — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
