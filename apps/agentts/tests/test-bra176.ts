#!/usr/bin/env bun
/**
 * Tests for the dispatch workflow (Linear BRA-176).
 *
 * Dispatch matches task kinds to the workflows that run them
 * (workflows/library/dispatch.ts): it takes a list of tasks, each
 * carrying its triage tag (the switch key), and matches each tag to
 * the workflow that runs it — then hands the routing to the
 * scheduler as a JSON handoff file. It is routing, not execution:
 * it never submits runs, never calls sub-workflows in-run, never
 * creates queue entries, and never invents an owner. The owner for
 * each routed task comes from the assignment the caller supplies
 * and must be a looping session per the project roster; a task with
 * no assignment, or an assignment naming a non-roster session,
 * refuses loudly. Only READY tasks route; gated/blocked/parked
 * appear in refused with the reason named. Tasks are processed in
 * input order, never re-sorted.
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh's section definitions on slug + tier).
 *   B. `agentts check` passes on dispatch.ts (first-run gate).
 *   C. Pure unit checks: resolveWorkflow (every kind, bare and
 *      `workflow:`-prefixed, plus unknown/malformed tags),
 *      reqString / reqStringArray / reqObject / reqArray /
 *      optString / optBoolean / optNumber, buildRouting (every
 *      switch case builds the right workflow + input, missing
 *      fields and unknown workflows refuse as needs-workflow),
 *      buildHandoff (shape, deterministic), splitHandoffChunks /
 *      appendChunkScript / finalizeHandoffScript / parseWriteSummary
 *      (the chunked write: a 1,200-task handoff is over the ~60KB
 *      trap cap, every chunk script stays far under the ~128KB
 *      single-argv cap, the finalize summary is one line),
 *      buildDispatchReport (dispatched / dry-run / failed verdicts,
 *      known limit verbatim).
 *   D. Live runs through the CLI on direct against scratch trees,
 *      asserting verdicts AND on-disk results: D1 routing per kind
 *      into the handoff (every routable workflow, right workflow +
 *      input + owner, handoff file exists and parses, report
 *      matches the file) AND the no-submit check (the queue is
 *      byte-identical apart from the dispatch run's own entry, and
 *      no jobs are enqueued anywhere — a dispatch that submits
 *      directly fails the boundary outright); D2 unknown tag refuses
 *      loudly, other tasks still route; D3 no assignment refuses;
 *      D4 non-roster owner refuses; D5 gated/blocked/parked are not
 *      routed, each in refused with the reason named; D6 input
 *      order preserved (fixture where input order disagrees with
 *      priority order); D7 dry-run writes nothing; D8 cancel refuses
 *      before any routing (cancelled runId: nothing routed,
 *      cancelChecked true + cancelled true; and the no-entry half:
 *      cancelChecked false — the check did not complete). A live
 *      size case drives 1,200 dummy tasks end to end (multi-chunk
 *      handoff write, verdict dispatched, handoff parses with 1,200
 *      routed). A no-owner case proves a run without an owner never
 *      proceeds (absent owner refused at submit, empty owner
 *      refused by the workflow).
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
 *   it runs this test; TMPDIR is set here when absent).
 * - Trap-stdout budget: exec-trap stdout caps at ~60KB (Quality probe:
 *   59,561 B passes, 64,111 B crashes). The handoff write trap
 *   therefore writes in base64 chunks (one small append trap per
 *   chunk) and the finalize trap returns only a one-line WROTE
 *   summary — the routing table never crosses a trap. The §C size
 *   case proves the chunking on 1,200 dummy tasks; the §D size case
 *   proves it live.
 * - The §D outputs go to scratch paths, NEVER the real goal hidden
 *   files; dispatch never touches Linear, the production queue, or
 *   the production worker server.
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra176.ts
 *   (run.sh sets DQUICKTS when it runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import dispatchTasks, {
  resolveWorkflow,
  reqString,
  reqStringArray,
  reqObject,
  reqArray,
  optString,
  optBoolean,
  optNumber,
  buildRouting,
  buildHandoff,
  base64EncodeUtf8,
  splitHandoffChunks,
  appendChunkScript,
  finalizeHandoffScript,
  parseWriteSummary,
  buildDispatchReport,
  ROUTABLE_WORKFLOWS,
  DISPATCH_KNOWN_LIMIT,
  type DispatchTask,
  type DispatchInput,
  type DispatchProjectConfig,
  type JsonValue,
} from "../workflows/library/dispatch";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const DISPATCH = path.join(ROOT, "workflows", "library", "dispatch.ts");
const WORKDIR = process.env.BRA176_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra176-"));
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
/** The Implementation lead owns dispatch runs (brief: owner is the dispatch run's owner). */
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

function cli(args: string[]): { rc: number; out: string; err: string } {
  const r = spawnSync(BUN, [path.join(ROOT, "src", "cli.ts"), ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
    // The size case's result carries 1,200 routed entries — far
    // over node's 1MB spawnSync default.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Every runId this test submits, in submit order — the no-submit
 * check asserts the queue holds only these. */
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
    if (Date.now() > deadline) throw new Error("bra176 server did not come up");
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

/** Drive one dispatch input through the CLI (submit + queue run +
 * result) and return the parsed result JSON, or null on a CLI failure
 * (the failure is already recorded as a check). */
function driveRun(runId: string, input: unknown): Record<string, any> | null {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", DISPATCH,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  if (sub.rc !== 0) return null;
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(drive.rc === 0, `DRIVE OK: queue run exits 0 for ${runId} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 300)})`);
  if (drive.rc !== 0) return null;
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
/** The worker-jobs store's jobs record, or null when the store
 * does not exist (no jobs were ever enqueued). */
function storeJobs(): Record<string, unknown> | null {
  const s = readJson(path.join(STATE_DIR, "worker-jobs", "store.json"));
  if (s === null) return null;
  const jobs = (s as Record<string, any>).jobs;
  return jobs && typeof jobs === "object" ? (jobs as Record<string, unknown>) : null;
}

/** Drive one dispatch input like driveRun, but capture the queue +
 * worker-jobs store after the submit and again after the drive,
 * and assert the no-submit boundary: the queue is byte-identical
 * apart from the driven run's own entry (whose status legitimately
 * moves queued → completed), the queue holds no run the test did
 * not submit, and no jobs are enqueued anywhere. Returns the parsed
 * result JSON, or null on a CLI failure. */
function driveRunNoSubmit(runId: string, input: unknown): Record<string, any> | null {
  track(runId);
  const knownRunIds = [...submittedRunIds];
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", DISPATCH,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  if (sub.rc !== 0) return null;
  const beforeEntries = queueEntries();
  const beforeJobs = storeJobs();
  check(beforeEntries !== null, `NO-SUBMIT: queue.json exists after the submit for ${runId}`);
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--gates", "hold"]);
  check(drive.rc === 0, `DRIVE OK: queue run exits 0 for ${runId} (got ${drive.rc}: ${(drive.out + drive.err).slice(0, 300)})`);
  if (drive.rc !== 0) return null;
  const afterEntries = queueEntries();
  const afterJobs = storeJobs();
  if (beforeEntries !== null && afterEntries !== null) {
    // Apart from the driven run's own entry, the queue is identical.
    const strip = (es: Record<string, any>[]): Record<string, any>[] =>
      es.filter((e) => e.runId !== runId);
    check(
      JSON.stringify(strip(beforeEntries)) === JSON.stringify(strip(afterEntries)),
      `NO-SUBMIT: queue entries other than ${runId} are byte-identical across the drive`,
    );
    const afterIds = afterEntries.map((e) => e.runId as string);
    check(
      afterIds.every((id) => knownRunIds.includes(id)),
      `NO-SUBMIT: the queue holds only runs the test submitted (got ${JSON.stringify(afterIds)})`,
    );
  } else {
    fail(`NO-SUBMIT: queue.json missing before (${beforeEntries === null}) or after (${afterEntries === null}) the drive for ${runId}`);
  }
  check(
    afterJobs === null || Object.keys(afterJobs).length === 0,
    `NO-SUBMIT: no jobs enqueued anywhere (worker-jobs store ${afterJobs === null ? "absent" : "holds " + Object.keys(afterJobs).length + " jobs"})`,
  );
  check(
    beforeJobs === null || Object.keys(beforeJobs).length === 0,
    `NO-SUBMIT: no jobs enqueued before the drive either (got ${beforeJobs === null ? "absent" : Object.keys(beforeJobs).length + " jobs"})`,
  );
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

/** The shared project config for §D cases. */
function testProject(stateDir: string): DispatchProjectConfig {
  return {
    linearProject: "P-BRA-2",
    repo: COPY_ROOT,
    stateDir,
    roster: { implementation: IMPL_OWNER, pm: PM_OWNER },
    thresholds: {},
  };
}

/** Build a §D case dir: work dir + handoff path + a dispatch run
 * input. The tasks/assignments are filled in per case. */
function buildCase(name: string, dispatchId: string): {
  dir: string;
  workDir: string;
  handoffPath: string;
  input: DispatchInput;
} {
  const dir = path.join(WORKDIR, "cases", name);
  fs.rmSync(dir, { recursive: true, force: true });
  const workDir = path.join(dir, "work");
  const handoffPath = path.join(dir, "handoff.json");
  const input: DispatchInput = {
    project: testProject(STATE_DIR),
    run: {
      dispatchId,
      tasks: [],
      assignments: {},
      handoffPath,
      stateDir: STATE_DIR,
      workDir,
    },
    launchedBy: "test-director",
    owner: IMPL_OWNER,
  };
  return { dir, workDir, handoffPath, input };
}

/** Minimal fields for each routable workflow (the §A enumeration
 * + the §D D1 fixture share this). */
function minimalFields(workflow: string): Record<string, JsonValue> {
  switch (workflow) {
    case "hello":
      return { name: "world" };
    case "triage":
      return { goalDir: "/g", queuePath: "/g/q.json", driftNotePath: "/g/d.md", stableQueuePath: "/g/s.json" };
    case "breakdown":
      return { issueId: "BRA-1", plannedTasks: [{ title: "t" }] };
    case "dependency-mapping":
      return { queuePath: "/g/q.json", goalPath: "/g/GOAL.md", graphPath: "/g/graph.json", datedGraphPath: "/g/graph-2026-11-21.json" };
    case "daily-feed":
      return { queuePath: "/g/q.json", graphPath: "/g/graph.json", goalPath: "/g/GOAL.md", feedPath: "/g/feed.md", datedFeedPath: "/g/feed-2026-11-21.md" };
    case "scheduler":
      return { targetRunId: "run-x", newOwner: PM_OWNER, serverUrl: "http://127.0.0.1:1" };
    case "worker-lifecycle":
      return { operation: "list", serverUrl: "http://127.0.0.1:1" };
    case "merge":
      return { copyRoot: "/c", liveRoot: "/l", claimedFiles: ["a.ts"] };
    case "verify-fix":
      return { repoRoot: "/r", directTests: ["t"], claimedFiles: ["a"], changedFiles: ["a"] };
    case "gc":
      return { stateDir: "/s", archiveDir: "/a" };
    default:
      throw new Error("no minimal fields for " + workflow);
  }
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
      const r = cli(["check", DISPATCH, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on dispatch.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("dispatchTasks(DispatchInput)"), `CHECK OK: entry is dispatchTasks(DispatchInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure unit checks
    console.log("\n=== §C pure unit checks ===");
    {
      const project = testProject("/state");
      const workDir = "/w";

      // resolveWorkflow: every kind, bare and workflow:-prefixed.
      for (const w of ROUTABLE_WORKFLOWS) {
        check(resolveWorkflow(w) === w, `RESOLVE OK: bare tag ${w} resolves`);
        check(resolveWorkflow("workflow:" + w) === w, `RESOLVE OK: workflow:${w} label resolves`);
      }
      check(resolveWorkflow("no-such-workflow") === "no-such-workflow", `RESOLVE OK: unknown name still resolves to its name (the switch refuses it)`);
      check(resolveWorkflow("") === null, `RESOLVE OK: empty tag resolves to null`);
      check(resolveWorkflow("workflow:") === null, `RESOLVE OK: bare workflow: prefix resolves to null`);
      check(resolveWorkflow("Triage") === null, `RESOLVE OK: uppercase tag resolves to null`);
      check(resolveWorkflow("tri age") === null, `RESOLVE OK: tag with a space resolves to null`);
      check(resolveWorkflow("tri_age") === null, `RESOLVE OK: tag with an underscore resolves to null`);

      // Field helpers: valid + missing throws needs-workflow.
      const f: Record<string, JsonValue> = {
        s: "x", arr: ["a", "b"], obj: { k: "v" }, list: [1, "two", true],
        b: true, n: 3,
      };
      check(reqString(f, "s", "w") === "x", `FIELDS OK: reqString returns the value`);
      check(JSON.stringify(reqStringArray(f, "arr", "w")) === JSON.stringify(["a", "b"]), `FIELDS OK: reqStringArray returns the value`);
      check(JSON.stringify(reqObject(f, "obj", "w")) === JSON.stringify({ k: "v" }), `FIELDS OK: reqObject returns the value`);
      check(JSON.stringify(reqArray(f, "list", "w")) === JSON.stringify([1, "two", true]), `FIELDS OK: reqArray returns the value`);
      check(optString(f, "s") === "x" && optString(f, "missing") === undefined && optString(f, "n") === undefined, `FIELDS OK: optString present/absent/wrong-type`);
      check(optBoolean(f, "b") === true && optBoolean(f, "missing") === undefined && optBoolean(f, "s") === undefined, `FIELDS OK: optBoolean present/absent/wrong-type`);
      check(optNumber(f, "n") === 3 && optNumber(f, "missing") === undefined && optNumber(f, "s") === undefined, `FIELDS OK: optNumber present/absent/wrong-type`);
      for (const [helper, name] of [
        [() => reqString(f, "missing", "w"), "reqString"],
        [() => reqStringArray(f, "missing", "w"), "reqStringArray"],
        [() => reqStringArray(f, "s", "w"), "reqStringArray-wrong-type"],
        [() => reqObject(f, "missing", "w"), "reqObject"],
        [() => reqArray(f, "missing", "w"), "reqArray"],
      ] as const) {
        let threw = false;
        try {
          helper();
        } catch (e) {
          threw = /needs-workflow: w needs/.test((e as Error).message);
        }
        check(threw, `FIELDS OK: ${name} missing/wrong-type throws needs-workflow`);
      }

      // buildRouting: every case builds the right workflow + input.
      const task = (id: string, tag: string, fields: Record<string, JsonValue>): DispatchTask =>
        ({ taskId: id, tag, bucket: "ready", fields });
      for (const w of ROUTABLE_WORKFLOWS) {
        const routed = buildRouting(task("t-" + w, w, minimalFields(w)), "D-1", project, workDir, IMPL_OWNER, "test-director");
        check(routed.workflow === "apps/agentts/workflows/library/" + w + ".ts", `ROUTE OK: ${w} routes to library/${w}.ts (got ${routed.workflow})`);
        check(routed.tag === w && routed.owner === IMPL_OWNER, `ROUTE OK: ${w} keeps tag + owner`);
        if (w === "hello") {
          // Hello's input is flat ({name}) — the one routable
          // workflow whose input is not two-layer.
          check(JSON.stringify(routed.input) === JSON.stringify({ name: "world" }), `ROUTE OK: hello input is flat {name} (got ${JSON.stringify(routed.input)})`);
          continue;
        }
        check(
          (routed.input as Record<string, any>).owner === IMPL_OWNER &&
            (routed.input as Record<string, any>).launchedBy === "test-director" &&
            JSON.stringify((routed.input as Record<string, any>).project) === JSON.stringify(project),
          `ROUTE OK: ${w} input carries project + launchedBy + owner`,
        );
        check(
          ((routed.input as Record<string, any>).run as Record<string, any>).runId === "D-1-t-" + w,
          `ROUTE OK: ${w} runId derives from dispatchId-taskId (got ${((routed.input as Record<string, any>).run as Record<string, any>).runId})`,
        );
      }
      // Spot-check the constructed inputs.
      const triageRouted = buildRouting(task("t1", "triage", minimalFields("triage")), "D-1", project, workDir, IMPL_OWNER);
      check(((triageRouted.input as any).run as any).goalDir === "/g", `ROUTE OK: triage input carries goalDir`);
      const schedRouted = buildRouting(task("t2", "scheduler", minimalFields("scheduler")), "D-1", project, workDir, PM_OWNER);
      check(((schedRouted.input as any).run as any).targetRunId === "run-x", `ROUTE OK: scheduler input carries targetRunId`);
      check(schedRouted.owner === PM_OWNER && ((schedRouted.input as any).owner as string) === PM_OWNER, `ROUTE OK: scheduler input owner is the assigned owner`);
      const regRouted = buildRouting(
        task("t3", "worker-lifecycle", { operation: "register", serverUrl: "http://127.0.0.1:1", workerId: "w1", ownerSession: PM_OWNER }),
        "D-1", project, workDir, IMPL_OWNER,
      );
      check(((regRouted.input as any).run as any).operation === "register" && ((regRouted.input as any).run as any).workerId === "w1", `ROUTE OK: worker-lifecycle register carries workerId + ownerSession`);
      const closeRouted = buildRouting(
        task("t4", "worker-lifecycle", { operation: "close", serverUrl: "http://127.0.0.1:1", workerId: "w1" }),
        "D-1", project, workDir, IMPL_OWNER,
      );
      check(((closeRouted.input as any).run as any).operation === "close" && ((closeRouted.input as any).run as any).workerId === "w1", `ROUTE OK: worker-lifecycle close carries workerId`);
      // The lead-loop build's dispatch fix (Nov 21, 2026): the
      // routed inputs must be submittable — the CLI schema gate
      // refuses a run input missing its workflow's required id
      // field or carrying a field its RunInput lacks. The loop
      // is the first consumer that submits a routed run, and
      // its D1/D11 cases proved the dependency-mapping +
      // worker-lifecycle cases were broken until these fields
      // were fixed. The other cases carry the same defect class
      // (see the BACKLOG.md follow-up).
      const depsRouted = buildRouting(task("t-deps", "dependency-mapping", minimalFields("dependency-mapping")), "D-1", project, workDir, IMPL_OWNER);
      check(((depsRouted.input as any).run as any).mappingId === "D-1-t-deps", `ROUTE OK: dependency-mapping input carries mappingId (got ${JSON.stringify(((depsRouted.input as any).run as any).mappingId)})`);
      check(!("workDir" in (((depsRouted.input as any).run as any) as Record<string, unknown>)), `ROUTE OK: dependency-mapping input carries no workDir (MappingRunInput has none)`);
      const lifeRouted = buildRouting(task("t-life", "worker-lifecycle", minimalFields("worker-lifecycle")), "D-1", project, workDir, IMPL_OWNER);
      check(((lifeRouted.input as any).run as any).lifecycleId === "D-1-t-life", `ROUTE OK: worker-lifecycle input carries lifecycleId (got ${JSON.stringify(((lifeRouted.input as any).run as any).lifecycleId)})`);
      // The project pick: the caller's project may carry
      // workDir/resumeDir (the loop's does), but only mapping's
      // target allows them — every other case drops them.
      const wideProject = { ...project, workDir: "/w", resumeDir: "/r" };
      const wideDeps = buildRouting(task("t-wd", "dependency-mapping", minimalFields("dependency-mapping")), "D-1", wideProject, workDir, IMPL_OWNER);
      check(
        ((wideDeps.input as any).project as any).workDir === "/w" && ((wideDeps.input as any).project as any).resumeDir === "/r",
        `ROUTE OK: dependency-mapping keeps the caller's workDir + resumeDir in the project`,
      );
      const wideLife = buildRouting(task("t-wl", "worker-lifecycle", minimalFields("worker-lifecycle")), "D-1", wideProject, workDir, IMPL_OWNER);
      check(
        !("workDir" in ((((wideLife.input as any).project as any) as Record<string, unknown>))) &&
          !("resumeDir" in ((((wideLife.input as any).project as any) as Record<string, unknown>))),
        `ROUTE OK: worker-lifecycle drops the caller's workDir + resumeDir from the project`,
      );
      // The workflow: prefix routes through the switch.
      const prefixed = buildRouting(task("t5", "workflow:triage", minimalFields("triage")), "D-1", project, workDir, IMPL_OWNER);
      check(prefixed.workflow.endsWith("/triage.ts"), `ROUTE OK: workflow:triage routes to triage.ts`);
      // Missing required field refuses as needs-workflow.
      for (const [w, bad] of [
        ["triage", { queuePath: "/q", driftNotePath: "/d", stableQueuePath: "/s" }],
        ["breakdown", { issueId: "BRA-1" }],
        ["scheduler", { targetRunId: "r" }],
        ["worker-lifecycle", { operation: "register", serverUrl: "http://127.0.0.1:1" }],
        ["gc", { stateDir: "/s" }],
      ] as const) {
        let threw = false;
        try {
          buildRouting(task("tb-" + w, w, bad as Record<string, JsonValue>), "D-1", project, workDir, IMPL_OWNER);
        } catch (e) {
          threw = /needs-workflow/.test((e as Error).message);
        }
        check(threw, `ROUTE OK: ${w} with a missing required field refuses as needs-workflow`);
      }
      // Unknown workflow name refuses as needs-workflow; bad
      // operation refuses; unresolvable tag refuses.
      for (const [tag, label] of [
        ["no-such-workflow", "unknown workflow"],
        ["workflow:no-such-workflow", "unknown workflow: label"],
      ] as const) {
        let threw = false;
        try {
          buildRouting(task("tu", tag, {}), "D-1", project, workDir, IMPL_OWNER);
        } catch (e) {
          threw = /needs-workflow: no routable workflow/.test((e as Error).message);
        }
        check(threw, `ROUTE OK: ${label} refuses as needs-workflow`);
      }
      {
        let threw = false;
        try {
          buildRouting(task("tu2", "worker-lifecycle", { operation: "explode", serverUrl: "http://127.0.0.1:1" }), "D-1", project, workDir, IMPL_OWNER);
        } catch (e) {
          threw = /needs operation register\|list\|close/.test((e as Error).message);
        }
        check(threw, `ROUTE OK: worker-lifecycle with a bad operation refuses`);
      }
      {
        let threw = false;
        try {
          buildRouting(task("tu3", "", {}), "D-1", project, workDir, IMPL_OWNER);
        } catch (e) {
          threw = /names no workflow/.test((e as Error).message);
        }
        check(threw, `ROUTE OK: empty tag refuses (names no workflow)`);
      }

      // base64EncodeUtf8: known vectors + cross-check against
      // Buffer (the test runs under bun, where Buffer exists; the
      // workflow host has none, which is why the encoder is pure).
      for (const [plain, b64] of [["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["hello", "aGVsbG8="], ["✓", "4pyT"], ["task-✓-1", "dGFzay3inJMtMQ=="]] as const) {
        check(base64EncodeUtf8(plain) === b64, `B64 OK: ${JSON.stringify(plain)} encodes to ${b64} (got ${base64EncodeUtf8(plain)})`);
        check(base64EncodeUtf8(plain) === Buffer.from(plain, "utf8").toString("base64"), `B64 OK: ${JSON.stringify(plain)} matches Buffer`);
      }

      // buildHandoff: shape + deterministic (no timestamps).
      const h = buildHandoff("D-1", [buildRouting(task("t1", "hello", { name: "w" }), "D-1", project, workDir, IMPL_OWNER)], [{ taskId: "t2", tag: "nope", reason: "needs-workflow: x" }]);
      check(h.dispatchId === "D-1" && h.routed.length === 1 && h.refused.length === 1, `HANDOFF OK: shape (dispatchId + routed + refused)`);
      check(JSON.stringify(h) === JSON.stringify(buildHandoff("D-1", h.routed, h.refused)), `HANDOFF OK: deterministic — same inputs, same JSON`);

      // Chunked write: 1,200 dummy tasks — the handoff JSON is over
      // the ~60KB trap cap, every chunk script stays far under the
      // ~128KB single-argv cap, and the finalize summary is one line.
      const manyRouted = [];
      for (let i = 0; i < 1200; i++) {
        manyRouted.push(buildRouting(task("size-" + i, "hello", { name: "task-" + i }), "D-SIZE", project, workDir, IMPL_OWNER));
      }
      const sizeJson = JSON.stringify(buildHandoff("D-SIZE", manyRouted, []), null, 2);
      check(sizeJson.length > 60000, `SIZE OK: 1,200-task handoff JSON is over the trap cap (${sizeJson.length} bytes)`);
      const chunks = splitHandoffChunks(sizeJson);
      check(chunks.length > 1, `SIZE OK: the handoff splits into ${chunks.length} chunks`);
      let maxScript = 0;
      for (let i = 0; i < chunks.length; i++) {
        const s = appendChunkScript(chunks[i], i, "/w/handoff.json.tmp");
        if (s.length > maxScript) maxScript = s.length;
      }
      check(maxScript < 65536, `SIZE OK: largest chunk script is ${maxScript} bytes (cap 128KB)`);
      const rejoined = chunks.map((c) => Buffer.from(c, "base64").toString("utf8")).join("");
      check(rejoined === sizeJson, `SIZE OK: base64 chunks reassemble to the handoff JSON exactly`);
      const fin = finalizeHandoffScript("/w/handoff.json.tmp", "/w/handoff.json", "D-SIZE", 1200, 0);
      check(fin.includes("WROTE") && fin.includes("mv ") && fin.includes("json.load"), `SIZE OK: finalize script renames + reads back + prints WROTE`);
      check(fin.includes("dispatchId") && fin.includes("routed"), `SIZE OK: finalize script reads back + verifies dispatchId + counts`);
      check(fin.includes("SystemExit") === false && fin.includes("exit 1") && fin.includes("exit 2"), `SIZE OK: finalize script has the rename-failed (1) + read-back-failed (2) exits`);

      // parseWriteSummary: valid + malformed.
      check(JSON.stringify(parseWriteSummary("WROTE 1234 /w/handoff.json\n")) === JSON.stringify({ bytes: 1234, path: "/w/handoff.json" }), `WRITE OK: WROTE line parses`);
      {
        let threw = false;
        try {
          parseWriteSummary("garbage\n");
        } catch (e) {
          threw = /unexpected write summary/.test((e as Error).message);
        }
        check(threw, `WRITE OK: non-WROTE summary throws loudly`);
      }

      // buildDispatchReport: verdicts + known limit + refusals named.
      const baseInput: DispatchInput = {
        project,
        run: {
          dispatchId: "D-1", tasks: [task("t1", "hello", { name: "w" })], assignments: { t1: IMPL_OWNER },
          handoffPath: "/w/handoff.json", stateDir: "/state", workDir,
        },
        owner: IMPL_OWNER,
      };
      const routedOne = [buildRouting(task("t1", "hello", { name: "w" }), "D-1", project, workDir, IMPL_OWNER)];
      const rDispatched = buildDispatchReport(baseInput, routedOne, [], false, false);
      check(rDispatched.verdict === "dispatched" && rDispatched.knownLimit === DISPATCH_KNOWN_LIMIT, `REPORT OK: dispatched report carries the known limit verbatim`);
      const rDry = buildDispatchReport({ ...baseInput, run: { ...baseInput.run, dryRun: true } }, routedOne, [], false, false);
      check(rDry.verdict === "dry-run" && rDry.dryRun === true, `REPORT OK: dry-run report`);
      const rFailed = buildDispatchReport(baseInput, [], [{ taskId: "t1", tag: "nope", reason: "needs-workflow: x" }], false, false);
      check(rFailed.verdict === "failed" && rFailed.notes[0] === "t1: needs-workflow: x", `REPORT OK: failed report names the refusal`);
      const rChecked = buildDispatchReport(baseInput, routedOne, [], true, false);
      check(rChecked.cancelChecked === true && rChecked.cancelled === false, `REPORT OK: cancelChecked passes through live`);
    }

    // --------------------------------------------- §D live CLI runs
    console.log("\n=== §D live CLI runs on direct (scratch trees) ===");

    // ---- Case D1: routing per kind into the handoff (+ no-submit).
    // One task per routable workflow, in a deliberate order (not
    // alphabetical, not priority order), one tag in workflow: form,
    // owners alternating between the two roster sessions. The run
    // carries its own runId with run.stateDir = STATE_DIR, so the
    // cancel check reads the run's own entry (queued/running, not
    // cancelled) and cancelChecked is true on the happy path.
    {
      const c = buildCase("D1-routing", "BRA-176-D1");
      const order: [string, string, Record<string, JsonValue>][] = [
        ["d1-gc", "gc", minimalFields("gc")],
        ["d1-hello", "hello", minimalFields("hello")],
        ["d1-triage", "workflow:triage", minimalFields("triage")],
        ["d1-scheduler", "scheduler", minimalFields("scheduler")],
        ["d1-merge", "merge", minimalFields("merge")],
        ["d1-feed", "daily-feed", minimalFields("daily-feed")],
        ["d1-lifecycle", "worker-lifecycle", minimalFields("worker-lifecycle")],
        ["d1-breakdown", "breakdown", minimalFields("breakdown")],
        ["d1-verify", "verify-fix", minimalFields("verify-fix")],
        ["d1-deps", "dependency-mapping", minimalFields("dependency-mapping")],
      ];
      c.input.run.tasks = order.map(([taskId, tag, fields]) => ({ taskId, tag, bucket: "ready" as const, fields }));
      c.input.run.assignments = {};
      order.forEach(([taskId], i) => {
        c.input.run.assignments[taskId] = i % 2 === 0 ? IMPL_OWNER : PM_OWNER;
      });
      c.input.run.runId = "run-bra176-D1";
      const out = driveRunNoSubmit("run-bra176-D1", c.input);
      if (out) {
        check(out.verdict === "dispatched", `D1 verdict dispatched (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(out.owner === IMPL_OWNER, `D1 owner is the Implementation lead (got ${out.owner})`);
        check(out.launchedBy === "test-director", `D1 launchedBy recorded`);
        check(out.cancelChecked === true && out.cancelled === false, `D1 cancel check ran on the happy path (cancelChecked true, not cancelled)`);
        check(out.routed.length === 10, `D1 routed 10 tasks (got ${out.routed.length})`);
        check(out.refused.length === 0, `D1 refused none (got ${JSON.stringify(out.refused)})`);
        check(
          JSON.stringify((out.routed as any[]).map((r: any) => r.taskId)) ===
            JSON.stringify(order.map(([taskId]) => taskId)),
          `D1 routed order is the input order (got ${JSON.stringify((out.routed as any[]).map((r: any) => r.taskId))})`,
        );
        const byId: Record<string, any> = {};
        for (const r of out.routed as any[]) byId[r.taskId] = r;
        check(byId["d1-gc"].workflow === "apps/agentts/workflows/library/gc.ts", `D1 gc routes to library/gc.ts`);
        check(byId["d1-triage"].workflow === "apps/agentts/workflows/library/triage.ts", `D1 workflow:triage routes to library/triage.ts`);
        check(((byId["d1-triage"].input as any).run as any).goalDir === "/g", `D1 triage input carries goalDir`);
        check(((byId["d1-scheduler"].input as any).run as any).targetRunId === "run-x", `D1 scheduler input carries targetRunId`);
        check(((byId["d1-lifecycle"].input as any).run as any).operation === "list", `D1 worker-lifecycle input carries operation list`);
        check(((byId["d1-gc"].input as any).run as any).stateDir === "/s", `D1 gc input carries stateDir`);
        check(JSON.stringify(((byId["d1-merge"].input as any).run as any).claimedFiles) === JSON.stringify(["a.ts"]), `D1 merge input carries claimedFiles`);
        check(byId["d1-hello"].owner === PM_OWNER && byId["d1-triage"].owner === IMPL_OWNER, `D1 routed owners are the assignments (not the driving session)`);
        check(JSON.stringify(byId["d1-hello"].input) === JSON.stringify({ name: "world" }), `D1 hello routed input is flat {name}`);
        check(((byId["d1-triage"].input as any).owner as string) === IMPL_OWNER, `D1 routed input owner is the assigned owner`);
        check(out.knownLimit === DISPATCH_KNOWN_LIMIT, `D1 report carries the known limit verbatim`);
        const handoff = readJson(c.handoffPath);
        check(handoff !== null, `D1 handoff file exists`);
        if (handoff) {
          check(handoff.dispatchId === "BRA-176-D1", `D1 handoff dispatchId (got ${handoff.dispatchId})`);
          check(JSON.stringify(handoff.routed) === JSON.stringify(out.routed), `D1 handoff routed matches the report routed`);
          check(JSON.stringify(handoff.refused) === JSON.stringify(out.refused), `D1 handoff refused matches the report refused`);
          check(fs.statSync(c.handoffPath).size > 0, `D1 handoff file is non-empty`);
        }
        check(!fs.existsSync(path.join(c.workDir, "handoff.json.tmp")), `D1 no temp handoff file left behind`);
      }
    }

    // ---- Case D2: unknown tag refuses loudly, others still route.
    {
      const c = buildCase("D2-unknown", "BRA-176-D2");
      c.input.run.tasks = [
        { taskId: "d2-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
        { taskId: "d2-nope", tag: "no-such-workflow", bucket: "ready", fields: {} },
        { taskId: "d2-triage", tag: "triage", bucket: "ready", fields: minimalFields("triage") },
      ];
      c.input.run.assignments = { "d2-hello": IMPL_OWNER, "d2-nope": IMPL_OWNER, "d2-triage": PM_OWNER };
      const out = driveRun("run-bra176-D2", c.input);
      if (out) {
        check(out.verdict === "dispatched", `D2 verdict dispatched (got ${out.verdict})`);
        check(out.routed.length === 2, `D2 routed 2 (got ${out.routed.length})`);
        check(out.refused.length === 1 && (out.refused as any[])[0].taskId === "d2-nope", `D2 refused the unknown tag only (got ${JSON.stringify(out.refused)})`);
        check(/needs-workflow: no routable workflow "no-such-workflow"/.test((out.refused as any[])[0].reason), `D2 refusal names the unknown workflow (got ${JSON.stringify((out.refused as any[])[0].reason)})`);
        check(JSON.stringify((out.routed as any[]).map((r: any) => r.taskId)) === JSON.stringify(["d2-hello", "d2-triage"]), `D2 routed order is input order`);
        const handoff = readJson(c.handoffPath);
        check(handoff !== null && (handoff.refused as any[]).length === 1, `D2 handoff carries the refusal`);
      }
    }

    // ---- Case D3: no assignment refuses loudly.
    {
      const c = buildCase("D3-noassignment", "BRA-176-D3");
      c.input.run.tasks = [
        { taskId: "d3-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
        { taskId: "d3-orphan", tag: "triage", bucket: "ready", fields: minimalFields("triage") },
        { taskId: "d3-gc", tag: "gc", bucket: "ready", fields: minimalFields("gc") },
      ];
      c.input.run.assignments = { "d3-hello": IMPL_OWNER, "d3-gc": PM_OWNER };
      const out = driveRun("run-bra176-D3", c.input);
      if (out) {
        check(out.verdict === "dispatched", `D3 verdict dispatched (got ${out.verdict})`);
        check(out.routed.length === 2, `D3 routed 2 (got ${out.routed.length})`);
        check(
          out.refused.length === 1 && (out.refused as any[])[0].taskId === "d3-orphan" &&
            /no assignment for task d3-orphan/.test((out.refused as any[])[0].reason),
          `D3 refusal names the missing assignment (got ${JSON.stringify(out.refused)})`,
        );
      }
    }

    // ---- Case D4: non-roster owner refuses loudly.
    {
      const c = buildCase("D4-nonroster", "BRA-176-D4");
      c.input.run.tasks = [
        { taskId: "d4-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
        { taskId: "d4-stranger", tag: "triage", bucket: "ready", fields: minimalFields("triage") },
        { taskId: "d4-gc", tag: "gc", bucket: "ready", fields: minimalFields("gc") },
      ];
      c.input.run.assignments = { "d4-hello": IMPL_OWNER, "d4-stranger": "session-not-in-roster", "d4-gc": PM_OWNER };
      const out = driveRun("run-bra176-D4", c.input);
      if (out) {
        check(out.verdict === "dispatched", `D4 verdict dispatched (got ${out.verdict})`);
        check(out.routed.length === 2, `D4 routed 2 (got ${out.routed.length})`);
        check(
          out.refused.length === 1 && (out.refused as any[])[0].taskId === "d4-stranger" &&
            /owner session-not-in-roster is not in the project roster/.test((out.refused as any[])[0].reason),
          `D4 refusal names the non-roster owner (got ${JSON.stringify(out.refused)})`,
        );
        check(
          !JSON.stringify(out.routed).includes("session-not-in-roster"),
          `D4 the non-roster session appears nowhere in the routing`,
        );
      }
    }

    // ---- Case D5: gated/blocked/parked are not routed.
    {
      const c = buildCase("D5-buckets", "BRA-176-D5");
      c.input.run.tasks = [
        { taskId: "d5-ready", tag: "hello", bucket: "ready", fields: { name: "w" } },
        { taskId: "d5-gated", tag: "triage", bucket: "gated", fields: minimalFields("triage") },
        { taskId: "d5-blocked", tag: "breakdown", bucket: "blocked", fields: minimalFields("breakdown") },
        { taskId: "d5-parked", tag: "gc", bucket: "parked", fields: minimalFields("gc") },
      ];
      c.input.run.assignments = { "d5-ready": IMPL_OWNER, "d5-gated": IMPL_OWNER, "d5-blocked": PM_OWNER, "d5-parked": PM_OWNER };
      const out = driveRun("run-bra176-D5", c.input);
      if (out) {
        check(out.verdict === "dispatched", `D5 verdict dispatched (got ${out.verdict})`);
        check(out.routed.length === 1 && (out.routed as any[])[0].taskId === "d5-ready", `D5 only the ready task routed (got ${JSON.stringify((out.routed as any[]).map((r: any) => r.taskId))})`);
        check(out.refused.length === 3, `D5 refused 3 (got ${out.refused.length})`);
        const reasons: Record<string, string> = {};
        for (const r of out.refused as any[]) reasons[r.taskId] = r.reason;
        check(/gated — not routed as ready/.test(reasons["d5-gated"] ?? ""), `D5 gated refusal names the bucket (got ${JSON.stringify(reasons["d5-gated"])})`);
        check(/blocked — not routed as ready/.test(reasons["d5-blocked"] ?? ""), `D5 blocked refusal names the bucket (got ${JSON.stringify(reasons["d5-blocked"])})`);
        check(/parked — not routed as ready/.test(reasons["d5-parked"] ?? ""), `D5 parked refusal names the bucket (got ${JSON.stringify(reasons["d5-parked"])})`);
      }
    }

    // ---- Case D6: input order preserved (input order disagrees
    // with priority order — the fields carry a priority dispatch
    // ignores; a priority sort would put the Urgent task first).
    {
      const c = buildCase("D6-order", "BRA-176-D6");
      c.input.run.tasks = [
        { taskId: "d6-low-first", tag: "hello", bucket: "ready", fields: { name: "w", priority: 4 } },
        { taskId: "d6-high-second", tag: "triage", bucket: "ready", fields: { ...minimalFields("triage"), priority: 1 } },
        { taskId: "d6-mid-third", tag: "gc", bucket: "ready", fields: { ...minimalFields("gc"), priority: 2 } },
      ];
      c.input.run.assignments = { "d6-low-first": IMPL_OWNER, "d6-high-second": PM_OWNER, "d6-mid-third": IMPL_OWNER };
      const out = driveRun("run-bra176-D6", c.input);
      if (out) {
        check(out.verdict === "dispatched", `D6 verdict dispatched (got ${out.verdict})`);
        check(
          JSON.stringify((out.routed as any[]).map((r: any) => r.taskId)) ===
            JSON.stringify(["d6-low-first", "d6-high-second", "d6-mid-third"]),
          `D6 routed order is the input order, not priority order (got ${JSON.stringify((out.routed as any[]).map((r: any) => r.taskId))})`,
        );
        const handoff = readJson(c.handoffPath);
        check(
          handoff !== null &&
            JSON.stringify((handoff.routed as any[]).map((r: any) => r.taskId)) ===
              JSON.stringify(["d6-low-first", "d6-high-second", "d6-mid-third"]),
          `D6 handoff preserves input order too`,
        );
      }
    }

    // ---- Case D7: dry-run writes nothing (and submits nothing).
    {
      const c = buildCase("D7-dryrun", "BRA-176-D7");
      c.input.run.tasks = [
        { taskId: "d7-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
        { taskId: "d7-triage", tag: "triage", bucket: "ready", fields: minimalFields("triage") },
      ];
      c.input.run.assignments = { "d7-hello": IMPL_OWNER, "d7-triage": PM_OWNER };
      c.input.run.dryRun = true;
      const out = driveRunNoSubmit("run-bra176-D7", c.input);
      if (out) {
        check(out.verdict === "dry-run", `D7 verdict dry-run (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(out.routed.length === 2, `D7 dry-run still plans 2 routed (got ${out.routed.length})`);
        check(!fs.existsSync(c.handoffPath), `D7 no handoff file written`);
        check(!fs.existsSync(path.join(c.workDir, "handoff.json.tmp")), `D7 no temp handoff file written`);
      }
    }

    // ---- Case D8: cancel refuses before any routing.
    // The cancel check reads run.stateDir/queue.json — a scratch
    // dir with a hand-crafted entry marking this run cancelled,
    // while the real run lives in the test's state dir. Deterministic:
    // no timing race, no live cancel needed.
    {
      const c = buildCase("D8-cancelled", "BRA-176-D8");
      const cancelStateDir = path.join(c.dir, "cancel-state");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(cancelStateDir, "queue.json"),
        JSON.stringify([{ runId: "run-bra176-D8", status: "cancelled" }]),
      );
      c.input.project.stateDir = cancelStateDir;
      c.input.run.stateDir = cancelStateDir;
      c.input.run.runId = "run-bra176-D8";
      c.input.run.tasks = [
        { taskId: "d8-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
        { taskId: "d8-triage", tag: "triage", bucket: "ready", fields: minimalFields("triage") },
      ];
      c.input.run.assignments = { "d8-hello": IMPL_OWNER, "d8-triage": PM_OWNER };
      const out = driveRun("run-bra176-D8", c.input);
      if (out) {
        check(out.verdict === "failed", `D8 verdict failed (got ${out.verdict})`);
        check(out.routed.length === 0, `D8 nothing routed (got ${out.routed.length})`);
        check(out.cancelled === true && out.cancelChecked === true, `D8 report says cancelled + cancelChecked`);
        check(out.notes.some((n: string) => /run run-bra176-D8 is cancelled/.test(n)), `D8 note names the cancellation (got ${JSON.stringify(out.notes)})`);
        check(!fs.existsSync(c.handoffPath), `D8 no handoff file written`);
      }
    }
    // ---- Case D8b: no queue entry for the run — the check did not
    // complete, so cancelChecked is false (the triage lesson: the
    // refused helper reads the live flag, never a hardcoded false).
    {
      const c = buildCase("D8b-noentry", "BRA-176-D8b");
      const cancelStateDir = path.join(c.dir, "cancel-state");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(cancelStateDir, "queue.json"),
        JSON.stringify([{ runId: "some-other-run", status: "queued" }]),
      );
      c.input.project.stateDir = cancelStateDir;
      c.input.run.stateDir = cancelStateDir;
      c.input.run.runId = "run-bra176-D8b";
      c.input.run.tasks = [
        { taskId: "d8b-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
      ];
      c.input.run.assignments = { "d8b-hello": IMPL_OWNER };
      const out = driveRun("run-bra176-D8b", c.input);
      if (out) {
        check(out.verdict === "failed", `D8b verdict failed (got ${out.verdict})`);
        check(out.routed.length === 0, `D8b nothing routed (got ${out.routed.length})`);
        check(out.cancelChecked === false, `D8b report says cancelChecked false — the check did not complete`);
        check(out.cancelled === false, `D8b report says not cancelled`);
        check(out.notes.some((n: string) => /cancel check: no queue entry for run run-bra176-D8b/.test(n)), `D8b note names the missing entry (got ${JSON.stringify(out.notes)})`);
        check(!fs.existsSync(c.handoffPath), `D8b no handoff file written`);
      }
    }

    // ---- Case S: live size regression (1,200 dummy tasks).
    // The handoff is ~500KB — a multi-chunk write end to end — and
    // the report carries 1,200 routed entries.
    {
      const c = buildCase("S-size", "BRA-176-SIZE");
      const tasks: DispatchTask[] = [];
      const assignments: Record<string, string> = {};
      for (let i = 0; i < 1200; i++) {
        const id = "size-" + i;
        tasks.push({ taskId: id, tag: "hello", bucket: "ready", fields: { name: "task-" + i } });
        assignments[id] = IMPL_OWNER;
      }
      c.input.run.tasks = tasks;
      c.input.run.assignments = assignments;
      const out = driveRunNoSubmit("run-bra176-S", c.input);
      if (out) {
        check(out.verdict === "dispatched", `S verdict dispatched with 1,200 tasks (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(out.routed.length === 1200, `S routed 1,200 (got ${out.routed.length})`);
        check((out.routed as any[])[0].taskId === "size-0" && (out.routed as any[])[1199].taskId === "size-1199", `S routed order is input order at the ends`);
        const handoff = readJson(c.handoffPath);
        check(handoff !== null && (handoff.routed as any[]).length === 1200, `S handoff parses with 1,200 routed`);
        check(fs.statSync(c.handoffPath).size > 60000, `S handoff file is over the trap cap (${fs.statSync(c.handoffPath).size} bytes) — the chunked write carried it`);
      }
    }

    // ---- Case G: owner missing.
    // Two halves. Owner ABSENT → the CLI refuses the submit at the
    // input-schema level (owner is required in DispatchInput), so no
    // run exists at all. Owner EMPTY → the schema accepts the
    // string and the workflow's own guard refuses with verdict
    // failed. Either way a run without an owner never proceeds.
    {
      const c = buildCase("G-noowner", "BRA-176-G");
      c.input.run.tasks = [
        { taskId: "g-hello", tag: "hello", bucket: "ready", fields: { name: "w" } },
      ];
      c.input.run.assignments = { "g-hello": IMPL_OWNER };
      const noOwnerInput: Record<string, any> = { ...c.input };
      delete noOwnerInput.owner;
      const absentFile = path.join(WORKDIR, "input-run-bra176-G-absent.json");
      fs.writeFileSync(absentFile, JSON.stringify(noOwnerInput));
      const sub = cli([
        "run", DISPATCH,
        "--run-id", "run-bra176-G-absent",
        "--input-file", absentFile,
        "--state-dir", STATE_DIR,
        "--adapter", "direct", "--clock", "real", "--gates", "hold",
      ]);
      check(sub.rc !== 0, `G submit without owner is refused (got rc ${sub.rc})`);
      check(/must have required property 'owner'/.test(sub.out + sub.err), `G refusal names the missing owner (got ${JSON.stringify((sub.out + sub.err).slice(0, 200))})`);
      const out = driveRun("run-bra176-G", { ...c.input, owner: "" });
      if (out) {
        check(out.verdict === "failed", `G verdict failed with empty owner (got ${out.verdict})`);
        check(out.notes.some((n: string) => /input has no owner string/.test(n)), `G note names the missing owner (got ${JSON.stringify(out.notes)})`);
        check(!fs.existsSync(c.handoffPath), `G nothing written`);
      }
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA176 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra176 dispatch workflow (inventory check, agentts check, pure unit checks, live scratch-tree runs — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
