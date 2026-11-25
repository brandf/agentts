/**
 * test-bra261.ts — the land-queue workflow (BRA-261).
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh — the land-queue section is wired after daily-brief).
 *   B. `agentts check` passes on land-queue.ts (first-run gate).
 *   C. Pure unit checks: validateLandQueueInput (every guard),
 *      validateQueueFile (old shape + queue-managed shape valid;
 *      duplicate issue, unknown status, malformed verification /
 *      authorization refused; "pending_qa" accepted — Landing ruling
 *      Nov 22 ~03:38 PST), validateQueueFileForRead (the lenient
 *      read: an entry whose only defect is an unknown status is
 *      skipped-with-reason, structural errors still refuse),
 *      copiesOf (copies wins, copy
 *      normalizes), ensureFailureNamed (idempotent),
 *      applyQueueUpdates (unknown issue errors), orderQueueEntries
 *      (ready first by ready_at, blocked with the failure named,
 *      ready -> blocked transitions, landed kept as history,
 *      pending_qa its own bucket — never ordered as ready, never
 *      demoted — order reassigned 1..N, ready_at set from now),
 *      buildLandQueueReport, nowScript / parseNowOutput, and the
 *      rotation (threshold + headroom math, history-file naming,
 *      planRotation: the most-recent-landed boundary, null
 *      landed_at sorts oldest, no landed entries moves nothing;
 *      buildRotationRecord + applyRotationRecord: the record
 *      seeds from an existing singular rotation and appends;
 *      rotationReReadChanged + the refusal note).
 *   D. Live runs through the CLI on direct against scratch queue
 *      files (fixture queue files under the test WORKDIR — never
 *      the real goal file):
 *      D-261a order (a ready entry with a passing verification +
 *        authorization, a second ready entry with an earlier
 *        ready_at, a blocked entry with a named failure, a
 *        paused entry, a landed entry — the report carries the
 *        ordered lists, the file on disk matches the ordered
 *        state, top-level keys preserved, authorization carried
 *        verbatim);
 *      D-261b dry-run (the file is byte-identical after);
 *      D-261c failed verify (a "ready" entry with verification
 *        passed=false + failedReason never orders as ready —
 *        it transitions to blocked with the failure named in
 *        the notes on disk);
 *      D-261d updates (run.updates records a verification +
 *        authorization on an entry with none — it becomes
 *        ready with ready_at set; an update naming an unknown
 *        issue refuses the run);
 *      D-261e cancel (cancelled runId refuses with cancelChecked
 *        true, writes nothing — the cancel check reads
 *        project.stateDir/queue.json, a scratch dir with a
 *        hand-crafted cancelled entry, while the real run lives
 *        in the test's state dir: the bra210a case-H shape, no
 *        timing race, no live cancel needed);
 *      D-261f idempotent re-run (a second run with no updates
 *        produces the same items — only `updated` changes);
 *      D-261g rotation (H1: a near-bound queue rotates — the live
 *        file drops below the bound, live + history is the
 *        original entry for entry, the queue still orders, the
 *        record is written, the report's notes carry it);
 *      D-261h over-bound refusal (H2a: a queue already over the
 *        bound refuses loudly naming the bound and the rotation —
 *        no rotation runs, no history file appears);
 *      D-261i rotated-queue drives (H2b: the rotated queue drives
 *        the throughput-report + bottleneck-detect readers green
 *        via the D-247f/D-248g fallback — the synthetic push names
 *        BRA-247/248 as awaiting Quality, the unknown-status entry is
 *        skipped-with-reason);
 *      D-261j record traceability (H2c: the rotation is traceable
 *        from the file alone — updated set, the record carries
 *        rotated_at / archived_to / archived_count /
 *        archived_issues, the report's notes match the file);
 *      D-261k cross-shift between rotations (X1a: an entry added
 *        to the live file after a rotation survives the next run
 *        exactly once — never lost, never duplicated; the
 *        within-run interleave is covered by the §C re-read tests
 *        and the lead's staged cross-shift reconciliation);
 *      D-261l most-recent-landed boundary (X1b: exactly the 5
 *        most recent landed entries stay, the older ones move);
 *      D-261m dry-run rotation (a near-bound queue in dry-run
 *        names the would-be rotation and writes nothing — the
 *        file is byte-identical, no history file appears).
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra261.ts
 *   (run.sh sets DQUICKTS when it runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 *
 * Every passing check prints a line containing " OK:" — run.sh
 * counts those lines for the tier-1 OK total, so every check
 * (not just §A/§B/submit) is phrased with the marker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import landQueue, {
  validateLandQueueInput,
  validateQueueFile,
  validateQueueFileForRead,
  copiesOf,
  ensureFailureNamed,
  applyQueueUpdates,
  orderQueueEntries,
  buildLandQueueReport,
  nowScript,
  parseNowOutput,
  planRotation,
  buildRotationRecord,
  applyRotationRecord,
  rotationHistoryFileName,
  rotationHistoryPath,
  rotationReReadChanged,
  rotationChangedRefusalNote,
  LAND_QUEUE_KNOWN_LIMIT,
  LAND_QUEUE_READ_MAX_BYTES,
  LAND_QUEUE_ROTATION_THRESHOLD_BYTES,
  LAND_QUEUE_KEEP_RECENT_LANDED,
  type LandQueueInput,
  type LandQueueProjectConfig,
  type LandQueueRunInput,
  type LandQueueEntry,
  type LandQueueEntryUpdate,
  type QueueVerification,
} from "../workflows/library/land-queue";
import type { MergeAuthorization } from "../workflows/library/merge";
import type { ThroughputReportInput } from "../workflows/library/throughput-report";
import type { BottleneckDetectInput } from "../workflows/library/bottleneck-detect";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const LAND_QUEUE = path.join(ROOT, "workflows", "library", "land-queue.ts");
const THROUGHPUT_REPORT = path.join(ROOT, "workflows", "library", "throughput-report.ts");
const BOTTLENECK_DETECT = path.join(ROOT, "workflows", "library", "bottleneck-detect.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA261_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "land-queue-"));
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
/** The Implementation lead owns brief runs (brief: owner is the driving session). */
const IMPL_OWNER = "3e85493f-f748-4bcd-bec6-94be9c25b282";
const NOW = "2026-11-22T07:40:00Z";

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
    if (Date.now() > deadline) throw new Error("land-queue server did not come up");
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

/** Drive one queue pass and return its rc (0 = clean, 1 = some
 * entry failed — the per-run signal is the run's own result,
 * not the exit code). */
function driveQueue(): number {
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--clock", "real", "--gates", "hold"]);
  if (drive.rc !== 0 && drive.rc !== 1) {
    fail(`DRIVE OK: queue run exits ${drive.rc} (expected 0 or 1): ${(drive.out + drive.err).slice(0, 300)}`);
  }
  return drive.rc;
}

/** Submit one land-queue run (no drive yet — D-261e's shape needs
 * the submit separated from the drive). */
function submitQueue(runId: string, input: LandQueueInput): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", LAND_QUEUE,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
}

/** Submit one run of any workflow file (no drive yet). The
 * existing submitQueue hardcodes LAND_QUEUE; the reader drives
 * (H2b) need the same submit shape for other workflows. */
function submitWorkflow(runId: string, workflowPath: string, input: unknown): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", workflowPath,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
}

/** Minimal workflow-baselines fixture for the throughput-report
 * reader drive (H2b): one metric, never violated, so the drive
 * asserts only the pending / skip naming, never totals. */
function fixtureBaselines(): Record<string, any> {
  return {
    version: 1,
    generated: "2026-11-22T00:00:00Z",
    metrics: {
      "test-workflow::wallMs": {
        unit: "ms", kind: "wallMs", baseline: 3_600_000, threshold: 10_800_000,
        multiple: 3, history: [3_600_000], greenStreak: 1, note: "fixture",
      },
    },
  };
}

/** A queue fixture sized to sit between the rotation threshold
 * and the read bound: 8 landed entries with distinct landed_at
 * (oldest first — BRA-247/248 oldest, so the rotation archives
 * it), one ready + one paused entry, notes padded until the
 * serialized size lands in range. The padding is computed,
 * never assumed — the size is asserted in range before the
 * case drives. */
function nearBoundQueueFixture(): { fixture: Record<string, any>; size: number } {
  const landedDefs: [string, string][] = [
    ["BRA-247/248", "2026-11-10T01:00:00Z"],
    ["BRA-910", "2026-11-11T01:00:00Z"],
    ["BRA-911", "2026-11-12T01:00:00Z"],
    ["BRA-912", "2026-11-13T01:00:00Z"],
    ["BRA-913", "2026-11-14T01:00:00Z"],
    ["BRA-914", "2026-11-15T01:00:00Z"],
    ["BRA-915", "2026-11-16T01:00:00Z"],
    ["BRA-916", "2026-11-17T01:00:00Z"],
  ];
  const items: Record<string, any>[] = landedDefs.map(([issue, landedAt], i) => ({
    issue, title: "Landed " + issue, copy: "~/workspace/agentts-copy-r" + i,
    order: i + 1, ready_at: landedAt.replace("T01:00:00Z", "T00:00:00Z"), landed_at: landedAt,
    status: "landed", notes: "Landed.",
  }));
  items.push({
    issue: "BRA-901", title: "Ready one", copy: "~/workspace/agentts-copy-y",
    order: 9, ready_at: "2026-11-21T10:00:00Z", landed_at: null,
    status: "ready", notes: "", verification: PASS_VERIFICATION, authorization: FIXTURE_AUTH,
  });
  items.push({
    issue: "BRA-903", title: "Paused one", copies: ["~/workspace/agentts-copy-w"],
    order: 10, ready_at: null, landed_at: null, status: "paused", notes: "Paused.",
  });
  const fixture: Record<string, any> = {
    items,
    owner: "landing",
    policy: { serial: "One landing at a time, never two merges in flight." },
    queue: "land",
    throughput: { landed: [] },
    updated: "2026-11-21T00:00:00Z",
  };
  const sizeOf = (): number => Buffer.byteLength(JSON.stringify(fixture, null, 1) + "\n", "utf8");
  // Pad the landed notes until the size sits in [threshold+64, bound).
  let pad = 0;
  while (sizeOf() < LAND_QUEUE_ROTATION_THRESHOLD_BYTES + 64) {
    pad += 512;
    for (const e of items) if (e.status === "landed") e.notes = "Landed. " + "x".repeat(pad);
  }
  return { fixture, size: sizeOf() };
}

/** The same fixture pushed past the read bound: the hostile
 * case (H2a) — the rotation must NOT rescue it. */
function overBoundQueueFixture(): { fixture: Record<string, any>; size: number } {
  const { fixture } = nearBoundQueueFixture();
  const items = fixture.items as Record<string, any>[];
  const sizeOf = (): number => Buffer.byteLength(JSON.stringify(fixture, null, 1) + "\n", "utf8");
  while (sizeOf() <= LAND_QUEUE_READ_MAX_BYTES) {
    (items[0] as Record<string, any>).notes += "x".repeat(1024);
  }
  return { fixture, size: sizeOf() };
}

/** Fetch one run's result (after a drive) and return the parsed
 * report, or null on a CLI failure (already recorded). */
function fetchResult(runId: string): Record<string, any> | null {
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

/** Drive one land-queue input through the CLI (submit + queue
 * run + result) and return the parsed report, or null on a CLI
 * failure (the failure is already recorded as a check). */
function driveQueueRun(runId: string, input: LandQueueInput): Record<string, any> | null {
  if (!submitQueue(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: scratch queue files under the test WORKDIR — never the
// real goal file. Both entry shapes appear: the old hand-written
// shape (copies[] + parts[]) and the queue-managed shape (singular
// copy, no parts, flat authorized_at).
// ------------------------------------------------------------------

const FIXTURE_AUTH: MergeAuthorization = {
  authorizer: "LBR",
  authorizedAt: "2026-11-21T22:47:00Z",
  channel: "LBR lead chat, direct to the Implementation lead",
  verificationSummary: "tier-1 60/3,910, Quality PASS",
  expectedNewBaseline: "60 sections / 3,910 OK",
  note: "No Linear issue exists for this change.",
};

const PASS_VERIFICATION: QueueVerification = {
  passed: true,
  summary: "tier-1 60/3,910, Quality PASS",
  evidencePath: "/tmp/bra261/evidence/report.json",
};

const FAIL_VERIFICATION: QueueVerification = {
  passed: false,
  summary: "tier-1 failed",
  failedReason: "Quality FAIL: tier-1 59/60 sections.",
};

/** A scratch queue file with one entry per bucket, in file order
 * (landed, ready-late, blocked, paused, ready-early) — the
 * workflow must return them ordered (ready by ready_at, then
 * blocked, paused, landed) and persist that order. */
function queueFixture(): Record<string, any> {
  return {
    items: [
      {
        issue: "BRA-900", title: "Old landed one", copies: ["~/workspace/agentts-copy-x"],
        order: 1, ready_at: "2026-11-20T00:00:00Z", landed_at: "2026-11-20T01:00:00Z",
        status: "landed", parts: ["a.ts"], notes: "Landed.",
      },
      {
        issue: "BRA-901", title: "Ready one (late)", copy: "~/workspace/agentts-copy-y",
        order: 2, ready_at: "2026-11-21T10:00:00Z", landed_at: null,
        status: "ready", notes: "", verification: PASS_VERIFICATION, authorization: FIXTURE_AUTH,
      },
      {
        issue: "BRA-902", title: "Blocked one", copy: "~/workspace/agentts-copy-z",
        order: 3, ready_at: null, landed_at: null,
        status: "blocked", notes: "Quality FAIL: tier-1 59/60 sections.", verification: FAIL_VERIFICATION,
      },
      {
        issue: "BRA-903", title: "Paused one", copies: ["~/workspace/agentts-copy-w"],
        order: 4, ready_at: null, landed_at: null, status: "paused", notes: "Paused.",
      },
      {
        issue: "BRA-904", title: "Ready one (early)", copy: "~/workspace/agentts-copy-v",
        order: 5, ready_at: "2026-11-21T09:00:00Z", landed_at: null,
        status: "ready", notes: "", verification: PASS_VERIFICATION, authorized_at: "2026-11-21T09:30:00Z",
      },
    ],
    owner: "landing",
    policy: { serial: "One landing at a time, never two merges in flight." },
    queue: "land",
    throughput: { landed: [] },
    updated: "2026-11-21T00:00:00Z",
  };
}

/** Write a fixture queue file under a case dir and return its path. */
function writeQueueFixture(dir: string, fixture: Record<string, any> = queueFixture()): string {
  fs.mkdirSync(dir, { recursive: true });
  const queuePath = path.join(dir, "land-queue.json");
  fs.writeFileSync(queuePath, JSON.stringify(fixture, null, 1) + "\n");
  return queuePath;
}

/** The shared project config for §D cases (stateDir is the
 * test's engine state dir unless the case overrides it — D-261e
 * points project.stateDir at a scratch cancel-state dir). */
function testProject(stateDir: string, workDir: string): LandQueueProjectConfig {
  return {
    linearProject: "P-BRA-2",
    repo: COPY_ROOT,
    stateDir,
    workDir,
    resumeDir: path.join(WORKDIR, "project-resume"),
  };
}

/** Build a land-queue input for one case. */
function caseInput(queuePath: string, workDir: string, extra: Partial<LandQueueRunInput> = {}): LandQueueInput {
  return {
    project: testProject(STATE_DIR, workDir),
    run: {
      queueId: "BRA-261",
      queuePath,
      now: NOW,
      ...extra,
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
  };
}

/** Minimal valid input (the §C base; cases mutate it). */
function validInput(): LandQueueInput {
  return {
    project: testProject(STATE_DIR, path.join(WORKDIR, "valid-work")),
    run: {
      queueId: "BRA-261",
      queuePath: path.join(WORKDIR, "valid-queue.json"),
      now: NOW,
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
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
      const r = cli(["check", LAND_QUEUE, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on land-queue.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("landQueue(LandQueueInput)"), `CHECK OK: entry is landQueue(LandQueueInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure units
    console.log("\n=== §C pure units ===");
    {
      // validateLandQueueInput: every guard.
      check(validateLandQueueInput(validInput()).length === 0, `VALIDATE OK: the minimal valid input validates`);
      check(
        validateLandQueueInput(null).includes("land-queue: input is not an object"),
        `VALIDATE OK: null input is refused (got ${JSON.stringify(validateLandQueueInput(null))})`,
      );
      check(
        validateLandQueueInput({ project: {} }).includes("land-queue: input has no run object"),
        `VALIDATE OK: a missing run object is refused`,
      );
      const noQueueId = validInput();
      (noQueueId.run as Record<string, unknown>).queueId = "";
      check(
        validateLandQueueInput(noQueueId).some((e) => /queueId/.test(e)),
        `VALIDATE OK: an empty queueId is refused (got ${JSON.stringify(validateLandQueueInput(noQueueId))})`,
      );
      const noOwner = validInput();
      (noOwner as Record<string, unknown>).owner = "";
      check(
        validateLandQueueInput(noOwner).some((e) => /owner/.test(e)),
        `VALIDATE OK: a missing owner is refused`,
      );
      const badUpdate = validInput();
      badUpdate.run.updates = [{ issue: "BRA-999", status: "flying" as never }];
      check(
        validateLandQueueInput(badUpdate).some((e) => /status/.test(e)),
        `VALIDATE OK: an update with an unknown status is refused`,
      );
      const badAuth = validInput();
      badAuth.run.updates = [{ issue: "BRA-999", authorization: { authorizer: "", authorizedAt: "", channel: "", verificationSummary: "", expectedNewBaseline: "" } }];
      check(
        validateLandQueueInput(badAuth).some((e) => /authorization is malformed/.test(e)),
        `VALIDATE OK: an update with a malformed authorization is refused`,
      );

      // validateQueueFile: both shapes valid; malformations refused.
      const fixture = queueFixture();
      const { items, errors } = validateQueueFile(fixture);
      check(errors.length === 0, `QUEUE OK: the two-shape fixture validates (got ${JSON.stringify(errors)})`);
      check(items.length === 5, `QUEUE OK: the fixture carries 5 items (got ${items.length})`);
      const dup = queueFixture();
      dup.items.push({ ...dup.items[0] });
      check(
        validateQueueFile(dup).errors.some((e) => /two entries for issue BRA-900/.test(e)),
        `QUEUE OK: a duplicate issue is refused`,
      );
      const badStatus = queueFixture();
      badStatus.items[0].status = "flying";
      check(
        validateQueueFile(badStatus).errors.some((e) => /unknown status/.test(e)),
        `QUEUE OK: an unknown status is refused`,
      );
      const badVer = queueFixture();
      badVer.items[1].verification = { passed: "yes", summary: "x" };
      check(
        validateQueueFile(badVer).errors.some((e) => /verification needs/.test(e)),
        `QUEUE OK: a malformed verification is refused`,
      );
      const badAuthFile = queueFixture();
      badAuthFile.items[1].authorization = { authorizer: "LBR" };
      check(
        validateQueueFile(badAuthFile).errors.some((e) => /authorization is malformed/.test(e)),
        `QUEUE OK: a malformed authorization on an entry is refused`,
      );
      check(
        validateQueueFile({ items: "nope" }).errors.some((e) => /no items array/.test(e)),
        `QUEUE OK: a file with no items array is refused`,
      );
      // "pending_qa" is in the vocabulary (Landing ruling, Nov 22
      // ~03:38 PST): verification done, Quality's verdict outstanding.
      const pendingQa = queueFixture();
      pendingQa.items[3].status = "pending_qa";
      const pendingQaValid = validateQueueFile(pendingQa);
      check(
        pendingQaValid.errors.length === 0 && pendingQaValid.items.length === 5,
        `QUEUE OK: a pending_qa entry validates (got ${JSON.stringify(pendingQaValid.errors)})`,
      );
      const pendingQaUpdate = { project: { linearProject: "P-BRA-2", repo: "/x", stateDir: "/s", workDir: "/w" }, run: { queueId: "q", queuePath: "/q.json", updates: [{ issue: "BRA-900", status: "pending_qa" }] }, owner: "o" };
      check(
        validateLandQueueInput(pendingQaUpdate).length === 0,
        `QUEUE OK: an update may set status pending_qa (got ${JSON.stringify(validateLandQueueInput(pendingQaUpdate))})`,
      );

      // validateQueueFileForRead (the lenient read, BRA-247/248 fix
      // round): an entry whose ONLY defect is an unknown status is
      // skipped-with-reason — excluded from items, named, no error;
      // every structural error still refuses.
      const lenient = queueFixture();
      lenient.items[3].status = "flying";
      const lenientRead = validateQueueFileForRead(lenient);
      check(
        lenientRead.errors.length === 0 && lenientRead.items.length === 4,
        `QUEUE OK: the lenient read passes a file with one unknown-status entry (got errors ${JSON.stringify(lenientRead.errors)}, items ${lenientRead.items.length})`,
      );
      check(
        lenientRead.skipped.length === 1 && lenientRead.skipped[0].issue === "BRA-903" && lenientRead.skipped[0].status === "flying" && /unknown status "flying"/.test(lenientRead.skipped[0].reason),
        `QUEUE OK: the unknown-status entry is skipped-with-reason, named (got ${JSON.stringify(lenientRead.skipped)})`,
      );
      check(
        !lenientRead.items.some((e) => e.issue === "BRA-903"),
        `QUEUE OK: the skipped entry is excluded from the items`,
      );
      const lenientStructural = queueFixture();
      lenientStructural.items[3].status = "flying";
      lenientStructural.items[3].title = "";
      const lenientStructuralRead = validateQueueFileForRead(lenientStructural);
      check(
        lenientStructuralRead.errors.length > 0 && lenientStructuralRead.skipped.length === 0,
        `QUEUE OK: an unknown status PLUS a missing title still refuses (got ${JSON.stringify(lenientStructuralRead.errors)})`,
      );
      const lenientDup = queueFixture();
      lenientDup.items.push({ ...lenientDup.items[0] });
      check(
        validateQueueFileForRead(lenientDup).errors.some((e) => /two entries for issue BRA-900/.test(e)),
        `QUEUE OK: the lenient read still refuses a duplicate issue`,
      );

      // copiesOf: copies wins; copy normalizes; neither is empty.
      check(
        JSON.stringify(copiesOf({ issue: "x", title: "t", copies: ["a", "b"], copy: "c", status: "landed" })) === JSON.stringify(["a", "b"]),
        `COPIES OK: copies wins when both forms are present`,
      );
      check(
        JSON.stringify(copiesOf({ issue: "x", title: "t", copy: "c", status: "landed" })) === JSON.stringify(["c"]),
        `COPIES OK: a lone copy normalizes to one element`,
      );
      check(
        JSON.stringify(copiesOf({ issue: "x", title: "t", status: "landed" })) === JSON.stringify([]),
        `COPIES OK: neither form is empty`,
      );

      // ensureFailureNamed: idempotent.
      const entry: LandQueueEntry = { issue: "BRA-1", title: "t", status: "blocked", notes: "" };
      check(ensureFailureNamed(entry, "boom") === true, `NOTES OK: a new reason is appended`);
      check(entry.notes === "boom", `NOTES OK: the note carries the reason (got ${JSON.stringify(entry.notes)})`);
      check(ensureFailureNamed(entry, "boom") === false, `NOTES OK: the same reason is not appended twice`);
      check(entry.notes === "boom", `NOTES OK: the note is unchanged on the second call`);

      // applyQueueUpdates: unknown issue errors; applied list names issues.
      const updItems = validateQueueFile(queueFixture()).items;
      const upd = applyQueueUpdates(updItems, [
        { issue: "BRA-903", status: "ready", verification: PASS_VERIFICATION },
        { issue: "BRA-999", status: "blocked" },
      ]);
      check(
        upd.errors.length === 1 && /unknown issue BRA-999/.test(upd.errors[0]),
        `UPDATES OK: an update naming an unknown issue errors (got ${JSON.stringify(upd.errors)})`,
      );
      check(
        upd.applied.some((a) => a.startsWith("BRA-903:")),
        `UPDATES OK: the applied list names the updated issue (got ${JSON.stringify(upd.applied)})`,
      );
      check(
        updItems.find((e) => e.issue === "BRA-903")?.status === "ready",
        `UPDATES OK: the update sets the status on the entry`,
      );

      // orderQueueEntries: ready first by ready_at; blocked with
      // the failure named; ready -> blocked transitions; landed
      // kept as history; order reassigned 1..N; ready_at set.
      const ordered = orderQueueEntries(validateQueueFile(queueFixture()).items, NOW);
      check(
        JSON.stringify(ordered.ready) === JSON.stringify(["BRA-904", "BRA-901"]),
        `ORDER OK: ready first by ready_at (got ${JSON.stringify(ordered.ready)})`,
      );
      check(
        JSON.stringify(ordered.blocked) === JSON.stringify(["BRA-902"]),
        `ORDER OK: blocked after ready (got ${JSON.stringify(ordered.blocked)})`,
      );
      check(
        JSON.stringify(ordered.paused) === JSON.stringify(["BRA-903"]),
        `ORDER OK: paused after blocked (got ${JSON.stringify(ordered.paused)})`,
      );
      check(
        JSON.stringify(ordered.landed) === JSON.stringify(["BRA-900"]),
        `ORDER OK: landed kept as history, last (got ${JSON.stringify(ordered.landed)})`,
      );
      check(
        JSON.stringify(ordered.ordered.map((e) => e.issue)) === JSON.stringify(["BRA-904", "BRA-901", "BRA-902", "BRA-903", "BRA-900"]),
        `ORDER OK: the full order is ready, blocked, paused, landed (got ${JSON.stringify(ordered.ordered.map((e) => e.issue))})`,
      );
      check(
        JSON.stringify(ordered.ordered.map((e) => e.order)) === JSON.stringify([1, 2, 3, 4, 5]),
        `ORDER OK: order is reassigned 1..N (got ${JSON.stringify(ordered.ordered.map((e) => e.order))})`,
      );
      // A ready entry with a failed verification transitions.
      const failItems = validateQueueFile(queueFixture()).items;
      const failEntry = failItems.find((e) => e.issue === "BRA-901")!;
      failEntry.verification = FAIL_VERIFICATION;
      const failOrdered = orderQueueEntries(failItems, NOW);
      check(
        !failOrdered.ready.includes("BRA-901") && failOrdered.blocked.includes("BRA-901"),
        `ORDER OK: a ready entry with a failed verification never orders as ready`,
      );
      check(
        failEntry.status === "blocked" && (failEntry.notes ?? "").includes("Quality FAIL: tier-1 59/60 sections."),
        `ORDER OK: the transition names the failure in the notes (got ${JSON.stringify(failEntry.notes)})`,
      );
      check(
        failOrdered.transitions.some((t) => /BRA-901: ready -> blocked/.test(t)),
        `ORDER OK: the transition is recorded (got ${JSON.stringify(failOrdered.transitions)})`,
      );
      // A ready entry with no verification transitions too.
      const noVerItems = validateQueueFile(queueFixture()).items;
      const noVerEntry = noVerItems.find((e) => e.issue === "BRA-904")!;
      delete noVerEntry.verification;
      const noVerOrdered = orderQueueEntries(noVerItems, NOW);
      check(
        !noVerOrdered.ready.includes("BRA-904") && noVerOrdered.blocked.includes("BRA-904"),
        `ORDER OK: a ready entry with no verification never orders as ready`,
      );
      // A ready entry with a passing verification but no ready_at gets it set.
      const noReadyAtItems = validateQueueFile(queueFixture()).items;
      const noReadyAtEntry = noReadyAtItems.find((e) => e.issue === "BRA-904")!;
      noReadyAtEntry.ready_at = null;
      const noReadyAtOrdered = orderQueueEntries(noReadyAtItems, NOW);
      check(
        noReadyAtOrdered.ready.includes("BRA-904") && noReadyAtEntry.ready_at === NOW,
        `ORDER OK: ready_at is set from now when the verification passed (got ${JSON.stringify(noReadyAtEntry.ready_at)})`,
      );
      // Idempotent: ordering twice changes nothing the second time.
      const twice = orderQueueEntries(validateQueueFile(queueFixture()).items, NOW);
      const twiceAgain = orderQueueEntries(twice.ordered, NOW);
      check(
        JSON.stringify(twiceAgain.ordered.map((e) => e.issue)) === JSON.stringify(twice.ordered.map((e) => e.issue)),
        `ORDER OK: ordering is idempotent`,
      );
      check(
        twiceAgain.transitions.length === 0,
        `ORDER OK: the second ordering makes no transitions (got ${JSON.stringify(twiceAgain.transitions)})`,
      );
      // "pending_qa" is its own bucket (Landing ruling, Nov 22 ~03:38
      // PST): never ordered as ready, never demoted to blocked —
      // even with no verification at all. It orders after paused,
      // before landed.
      const pendingQaItems = validateQueueFile(queueFixture()).items;
      const pendingQaEntry = pendingQaItems.find((e) => e.issue === "BRA-903")!;
      pendingQaEntry.status = "pending_qa";
      delete (pendingQaEntry as any).verification;
      const pendingQaOrdered = orderQueueEntries(pendingQaItems, NOW);
      check(
        JSON.stringify(pendingQaOrdered.pendingQa) === JSON.stringify(["BRA-903"]),
        `ORDER OK: a pending_qa entry orders in the pendingQa bucket (got ${JSON.stringify(pendingQaOrdered.pendingQa)})`,
      );
      check(
        !pendingQaOrdered.ready.includes("BRA-903") && !pendingQaOrdered.blocked.includes("BRA-903"),
        `ORDER OK: a pending_qa entry is neither ready nor blocked`,
      );
      check(
        pendingQaEntry.status === "pending_qa",
        `ORDER OK: ordering never demotes a pending_qa entry (got ${JSON.stringify(pendingQaEntry.status)})`,
      );
      check(
        JSON.stringify(pendingQaOrdered.ordered.map((e) => e.issue)) === JSON.stringify(["BRA-904", "BRA-901", "BRA-902", "BRA-903", "BRA-900"]),
        `ORDER OK: the full order is ready, blocked, paused, pending_qa, landed (got ${JSON.stringify(pendingQaOrdered.ordered.map((e) => e.issue))})`,
      );
      check(
        pendingQaOrdered.transitions.length === 0,
        `ORDER OK: ordering a pending_qa entry makes no transitions (got ${JSON.stringify(pendingQaOrdered.transitions)})`,
      );

      // buildLandQueueReport + the clock helpers.
      const report = buildLandQueueReport({
        queueId: "BRA-261", verdict: "ordered", dryRun: false, owner: IMPL_OWNER,
        cancelChecked: true, cancelled: false, queuePath: "/tmp/q.json",
        ready: ["BRA-904"], blocked: [], paused: [], pendingQa: [], landed: ["BRA-900"],
        items: 2, updated: true, transitions: [],
      });
      check(report.verdict === "ordered" && report.ready[0] === "BRA-904", `REPORT OK: the report carries the ordered lists`);
      check(report.knownLimit === LAND_QUEUE_KNOWN_LIMIT, `REPORT OK: the known limit is carried verbatim`);
      check(nowScript().includes("date -u"), `CLOCK OK: the clock script reads the UTC date`);
      check(parseNowOutput("NOW 2026-11-22T07:40:00Z\n") === "2026-11-22T07:40:00Z", `CLOCK OK: the NOW line parses`);
      let clockThrew = false;
      try {
        parseNowOutput("garbage\n");
      } catch {
        clockThrew = true;
      }
      check(clockThrew, `CLOCK OK: a malformed clock line throws loudly`);

      // Rotation: threshold + headroom math, history-file naming,
      // planRotation, the record, the re-read check.
      check(
        LAND_QUEUE_ROTATION_THRESHOLD_BYTES === 36 * 1024,
        `ROTATE OK: the threshold is 36KB (got ${LAND_QUEUE_ROTATION_THRESHOLD_BYTES})`,
      );
      check(
        LAND_QUEUE_READ_MAX_BYTES - LAND_QUEUE_ROTATION_THRESHOLD_BYTES >= 10850,
        `ROTATE OK: the headroom covers one burst-rate merge cycle (got ${LAND_QUEUE_READ_MAX_BYTES - LAND_QUEUE_ROTATION_THRESHOLD_BYTES} bytes)`,
      );
      check(
        LAND_QUEUE_KEEP_RECENT_LANDED === 5,
        `ROTATE OK: 5 most recent landed entries are kept (got ${LAND_QUEUE_KEEP_RECENT_LANDED})`,
      );
      check(
        LAND_QUEUE_KNOWN_LIMIT.includes("rotates landed entries into a dated history file"),
        `ROTATE OK: the known limit names the rotation mechanism`,
      );
      check(
        rotationHistoryFileName("2026-11-22T07:40:00Z") === "land-queue-rotated-20261122T074000Z.json",
        `ROTATE OK: the history name carries the run time (got ${rotationHistoryFileName("2026-11-22T07:40:00Z")})`,
      );
      check(
        rotationHistoryPath("/a/b/land-queue.json", "2026-11-22T07:40:00Z") === "/a/b/land-queue-rotated-20261122T074000Z.json",
        `ROTATE OK: the history path sits next to the queue file (got ${rotationHistoryPath("/a/b/land-queue.json", "2026-11-22T07:40:00Z")})`,
      );
      // planRotation: the most-recent-landed boundary. The
      // fixture has 1 landed entry (BRA-900, landed 2026-11-20);
      // 7 more with distinct landed_at values make 8.
      const rotItems = validateQueueFile(queueFixture()).items;
      for (let i = 0; i < 7; i++) {
        const day = String(i + 1).padStart(2, "0");
        rotItems.push({
          issue: "BRA-92" + i, title: "Landed " + i, copy: "~/workspace/agentts-copy-r" + i,
          order: 10 + i, ready_at: "2026-11-" + day + "T00:00:00Z",
          landed_at: "2026-11-" + day + "T01:00:00Z", status: "landed", notes: "",
        });
      }
      const plan = planRotation(rotItems);
      check(plan.kept.length === 5 && plan.moved.length === 3, `ROTATE OK: 8 landed split 5 kept / 3 moved (got ${plan.kept.length} kept, ${plan.moved.length} moved)`);
      check(
        JSON.stringify(plan.kept.map((e) => e.issue)) === JSON.stringify(["BRA-900", "BRA-926", "BRA-925", "BRA-924", "BRA-923"]),
        `ROTATE OK: the 5 most recent landed stay (got ${JSON.stringify(plan.kept.map((e) => e.issue))})`,
      );
      check(
        JSON.stringify(plan.moved.map((e) => e.issue)) === JSON.stringify(["BRA-920", "BRA-921", "BRA-922"]),
        `ROTATE OK: the 3 older landed move, oldest first (got ${JSON.stringify(plan.moved.map((e) => e.issue))})`,
      );
      // An entry with no landed_at sorts as oldest and moves
      // first (with keep=1 the single most recent landed stays).
      const nullAtItems = validateQueueFile(queueFixture()).items;
      nullAtItems.push({
        issue: "BRA-931", title: "No landed_at", copy: "~/workspace/agentts-copy-n",
        order: 9, ready_at: null, landed_at: null, status: "landed", notes: "",
      });
      const nullPlan = planRotation(nullAtItems, 1);
      check(nullPlan.kept.length === 1 && nullPlan.kept[0].issue === "BRA-900", `ROTATE OK: with keep=1 the most recent landed stays (got ${JSON.stringify(nullPlan.kept.map((e) => e.issue))})`);
      check(nullPlan.moved.some((e) => e.issue === "BRA-931"), `ROTATE OK: an entry with no landed_at sorts as oldest and moves`);
      // No landed entries moves nothing.
      const noLandedItems = validateQueueFile(queueFixture()).items.filter((e) => e.status !== "landed");
      const noLandedPlan = planRotation(noLandedItems);
      check(noLandedPlan.moved.length === 0 && noLandedPlan.kept.length === 0, `ROTATE OK: no landed entries moves nothing`);
      // The record + applying it: an existing singular rotation
      // seeds the array (never lost), the latest record wins.
      const rec = buildRotationRecord({
        now: NOW, rotatedBy: "land-queue workflow",
        archivedTo: "land-queue-rotated-20261122T074000Z.json",
        archivedIssues: ["BRA-900"], note: "test",
      });
      check(rec.rotated_at === NOW && rec.archived_count === 1 && JSON.stringify(rec.archived_issues) === JSON.stringify(["BRA-900"]), `ROTATE OK: the record carries the rotation (got ${JSON.stringify(rec)})`);
      const topWithOne = applyRotationRecord(
        { items: [], rotation: { rotated_at: "2026-11-21T00:00:00Z", rotated_by: "Landing", archived_to: "old.json", archived_count: 1, archived_issues: ["BRA-1"], note: "old" } },
        rec,
      );
      check(Array.isArray(topWithOne.rotations) && (topWithOne.rotations as unknown[]).length === 2, `ROTATE OK: an existing singular rotation seeds the array (got ${(topWithOne.rotations as unknown[]).length})`);
      check(JSON.stringify(topWithOne.rotation) === JSON.stringify(rec), `ROTATE OK: rotation is the latest record`);
      const topFresh = applyRotationRecord({ items: [] }, rec);
      check(Array.isArray(topFresh.rotations) && (topFresh.rotations as unknown[]).length === 1, `ROTATE OK: a fresh file starts the array with the record`);
      // The re-read check: unchanged is stable, an entry added
      // mid-rotation is a change; the refusal note names both.
      const firstRead = JSON.stringify(queueFixture());
      const secondSame = JSON.stringify(queueFixture());
      const secondAdded = JSON.stringify({
        ...queueFixture(),
        items: [...queueFixture().items, { issue: "BRA-999", title: "x", status: "ready" }],
      });
      check(rotationReReadChanged(firstRead, secondSame) === false, `ROTATE OK: an unchanged re-read is stable`);
      check(rotationReReadChanged(firstRead, secondAdded) === true, `ROTATE OK: an entry added mid-rotation is a change`);
      check(
        rotationChangedRefusalNote("land-queue-rotated-20261122T074000Z.json").includes("changed during rotation") &&
          rotationChangedRefusalNote("land-queue-rotated-20261122T074000Z.json").includes("land-queue-rotated-20261122T074000Z.json"),
        `ROTATE OK: the refusal note names the change and the history file`,
      );
    }

    // --------------------------------------------- §D live CLI runs
    console.log("\n=== §D live CLI runs ===");
    {
      // ---- D-261a: order a scratch queue file; the report carries
      // the ordered lists and the file on disk matches the ordered
      // state (top-level keys preserved, authorization verbatim).
      const dirA = path.join(WORKDIR, "cases", "A-order");
      const queueA = writeQueueFixture(dirA);
      const beforeA = read(queueA);
      const outA = driveQueueRun("run-bra261-A", caseInput(queueA, path.join(dirA, "work")));
      if (outA) {
        check(outA.verdict === "ordered", `A verdict ordered (got ${outA.verdict}: ${JSON.stringify(outA.notes)})`);
        check(JSON.stringify(outA.ready) === JSON.stringify(["BRA-904", "BRA-901"]), `A ready is [904, 901] by ready_at (got ${JSON.stringify(outA.ready)})`);
        check(JSON.stringify(outA.blocked) === JSON.stringify(["BRA-902"]), `A blocked is [902] (got ${JSON.stringify(outA.blocked)})`);
        check(JSON.stringify(outA.paused) === JSON.stringify(["BRA-903"]), `A paused is [903] (got ${JSON.stringify(outA.paused)})`);
        check(JSON.stringify(outA.landed) === JSON.stringify(["BRA-900"]), `A landed is [900] (got ${JSON.stringify(outA.landed)})`);
        check(outA.updated === true, `A the file was written`);
        const afterA = readJson(queueA);
        check(afterA !== null, `A the queue file still parses`);
        if (afterA) {
          check(
            JSON.stringify((afterA.items as any[]).map((e) => e.issue)) === JSON.stringify(["BRA-904", "BRA-901", "BRA-902", "BRA-903", "BRA-900"]),
            `A the file on disk matches the ordered state (got ${JSON.stringify((afterA.items as any[]).map((e) => e.issue))})`,
          );
          check(
            JSON.stringify((afterA.items as any[]).map((e) => e.order)) === JSON.stringify([1, 2, 3, 4, 5]),
            `A order is reassigned 1..N on disk`,
          );
          check(afterA.owner === "landing" && afterA.queue === "land", `A top-level keys are preserved (owner/queue)`);
          check(
            JSON.stringify((afterA.policy as any).serial) === JSON.stringify("One landing at a time, never two merges in flight."),
            `A top-level policy is preserved`,
          );
          check(afterA.updated === NOW, `A updated is set to now (got ${JSON.stringify(afterA.updated)})`);
          const entry901 = (afterA.items as any[]).find((e) => e.issue === "BRA-901");
          check(
            JSON.stringify(entry901.authorization) === JSON.stringify(FIXTURE_AUTH),
            `A the authorization is carried verbatim on disk`,
          );
          check(
            JSON.stringify(entry901.verification) === JSON.stringify(PASS_VERIFICATION),
            `A the verification is carried on disk`,
          );
          const entry904 = (afterA.items as any[]).find((e) => e.issue === "BRA-904");
          check(entry904.copy === "~/workspace/agentts-copy-v", `A the singular copy form is preserved (not converted to copies)`);
          check(entry904.authorized_at === "2026-11-21T09:30:00Z", `A the flat authorized_at is preserved`);
          const entry900 = (afterA.items as any[]).find((e) => e.issue === "BRA-900");
          check(JSON.stringify(entry900.parts) === JSON.stringify(["a.ts"]), `A the old-shape parts are preserved`);
          check(beforeA !== read(queueA), `A the file changed (the run wrote)`);
        }
      }

      // ---- D-261b: dry-run leaves the file byte-identical.
      const dirB = path.join(WORKDIR, "cases", "B-dryrun");
      const queueB = writeQueueFixture(dirB);
      const beforeB = read(queueB);
      const outB = driveQueueRun("run-bra261-B", caseInput(queueB, path.join(dirB, "work"), { dryRun: true }));
      if (outB) {
        check(outB.verdict === "dry-run", `B verdict dry-run (got ${outB.verdict})`);
        check(JSON.stringify(outB.ready) === JSON.stringify(["BRA-904", "BRA-901"]), `B the dry-run still orders (got ${JSON.stringify(outB.ready)})`);
        check(outB.updated === false, `B the dry-run reports updated=false`);
        check(read(queueB) === beforeB, `B the file is byte-identical after a dry-run`);
      }

      // ---- D-261c: a "ready" entry with a failed verify never
      // orders as ready — it transitions to blocked with the
      // failure named in the notes on disk.
      const dirC = path.join(WORKDIR, "cases", "C-failed-verify");
      const fixtureC = queueFixture();
      (fixtureC.items as any[]).find((e) => e.issue === "BRA-901").verification = FAIL_VERIFICATION;
      const queueC = writeQueueFixture(dirC, fixtureC);
      const outC = driveQueueRun("run-bra261-C", caseInput(queueC, path.join(dirC, "work")));
      if (outC) {
        check(outC.verdict === "ordered", `C verdict ordered (got ${outC.verdict})`);
        check(!((outC.ready as string[]) ?? []).includes("BRA-901"), `C the failed-verify entry is not ready`);
        check(((outC.blocked as string[]) ?? []).includes("BRA-901"), `C the failed-verify entry is blocked`);
        check(
          (outC.transitions as string[]).some((t) => /BRA-901: ready -> blocked/.test(t)),
          `C the transition is recorded (got ${JSON.stringify(outC.transitions)})`,
        );
        const afterC = readJson(queueC);
        const entryC = (afterC?.items as any[] | undefined)?.find((e) => e.issue === "BRA-901");
        check(entryC?.status === "blocked", `C the entry is blocked on disk`);
        check(
          typeof entryC?.notes === "string" && entryC.notes.includes("Quality FAIL: tier-1 59/60 sections."),
          `C the failure is named in the notes on disk (got ${JSON.stringify(entryC?.notes)})`,
        );
      }

      // ---- D-261d: updates record a verification + authorization
      // on an entry with none — it becomes ready with ready_at
      // set; an update naming an unknown issue refuses the run.
      const dirD = path.join(WORKDIR, "cases", "D-updates");
      const fixtureD = queueFixture();
      const entryD = (fixtureD.items as any[]).find((e) => e.issue === "BRA-903");
      entryD.status = "ready";
      entryD.ready_at = null;
      delete entryD.verification;
      const queueD = writeQueueFixture(dirD, fixtureD);
      const updates: LandQueueEntryUpdate[] = [
        { issue: "BRA-903", verification: PASS_VERIFICATION, authorization: FIXTURE_AUTH },
      ];
      const outD = driveQueueRun("run-bra261-D", caseInput(queueD, path.join(dirD, "work"), { updates }));
      if (outD) {
        check(outD.verdict === "ordered", `D verdict ordered (got ${outD.verdict}: ${JSON.stringify(outD.notes)})`);
        check(((outD.ready as string[]) ?? []).includes("BRA-903"), `D the updated entry is ready (got ${JSON.stringify(outD.ready)})`);
        const afterD = readJson(queueD);
        const entryAfterD = (afterD?.items as any[] | undefined)?.find((e) => e.issue === "BRA-903");
        check(entryAfterD?.ready_at === NOW, `D ready_at is set to now on disk (got ${JSON.stringify(entryAfterD?.ready_at)})`);
        check(
          JSON.stringify(entryAfterD?.authorization) === JSON.stringify(FIXTURE_AUTH),
          `D the authorization is recorded on disk`,
        );
      }
      const dirD2 = path.join(WORKDIR, "cases", "D2-unknown-update");
      const queueD2 = writeQueueFixture(dirD2);
      const beforeD2 = read(queueD2);
      const outD2 = driveQueueRun("run-bra261-D2", caseInput(queueD2, path.join(dirD2, "work"), {
        updates: [{ issue: "BRA-999", status: "blocked" }],
      }));
      if (outD2) {
        check(outD2.verdict === "failed", `D2 verdict failed on an unknown-issue update (got ${outD2.verdict})`);
        check(
          (outD2.notes as string[]).some((n) => /unknown issue BRA-999/.test(n)),
          `D2 the unknown issue is named (got ${JSON.stringify(outD2.notes)})`,
        );
        check(read(queueD2) === beforeD2, `D2 the file is byte-identical after the refusal`);
      }

      // ---- D-261e: cancel (bra210a case-H shape). The cancel
      // check reads project.stateDir/queue.json — a scratch dir
      // with a hand-crafted cancelled entry — while the real run
      // lives in the test's state dir.
      const dirE = path.join(WORKDIR, "cases", "E-cancel");
      const queueE = writeQueueFixture(dirE);
      const beforeE = read(queueE);
      const cancelState = path.join(dirE, "cancel-state");
      fs.mkdirSync(cancelState, { recursive: true });
      fs.writeFileSync(
        path.join(cancelState, "queue.json"),
        JSON.stringify([{ runId: "run-bra261-E", status: "cancelled" }]) + "\n",
      );
      const inputE = caseInput(queueE, path.join(dirE, "work"), { runId: "run-bra261-E" });
      inputE.project = testProject(cancelState, path.join(dirE, "work"));
      if (submitQueue("run-bra261-E", inputE)) {
        driveQueue();
        const outE = fetchResult("run-bra261-E");
        if (outE) {
          check(outE.verdict === "failed", `E verdict failed on a cancelled run (got ${outE.verdict})`);
          check(outE.cancelChecked === true, `E cancelChecked is true (got ${outE.cancelChecked})`);
          check(outE.cancelled === true, `E cancelled is true (got ${outE.cancelled})`);
          check(read(queueE) === beforeE, `E the file is byte-identical after the cancel refusal`);
        }
      }

      // ---- D-261f: a second run with no updates is idempotent —
      // the same items, only `updated` changes.
      const dirF = path.join(WORKDIR, "cases", "F-idempotent");
      const queueF = writeQueueFixture(dirF);
      const outF1 = driveQueueRun("run-bra261-F1", caseInput(queueF, path.join(dirF, "work")));
      const afterF1 = readJson(queueF);
      const outF2 = driveQueueRun("run-bra261-F2", caseInput(queueF, path.join(dirF, "work"), { now: "2026-11-22T08:00:00Z" }));
      const afterF2 = readJson(queueF);
      if (outF1 && outF2 && afterF1 && afterF2) {
        check(outF2.verdict === "ordered", `F verdict ordered on the second run (got ${outF2.verdict})`);
        check(
          JSON.stringify(afterF1.items) === JSON.stringify(afterF2.items),
          `F the items are identical on the second run`,
        );
        check(
          (outF2.transitions as string[]).length === 0,
          `F the second run makes no transitions (got ${JSON.stringify(outF2.transitions)})`,
        );
        check(afterF2.updated === "2026-11-22T08:00:00Z", `F only updated changes on the second run`);
      }

      // ---- D-261g rotation (H1): a near-bound queue rotates —
      // the live file drops below the bound, live + history is
      // the original entry for entry, the queue still orders,
      // the record is written, the report's notes carry it.
      // outG stays in scope for the H2c record case below.
      let outG: Record<string, any> | null = null;
      const dirG = path.join(WORKDIR, "cases", "G-rotation");
      const { fixture: fixtureG, size: sizeG } = nearBoundQueueFixture();
      check(sizeG >= LAND_QUEUE_ROTATION_THRESHOLD_BYTES && sizeG < LAND_QUEUE_READ_MAX_BYTES, `G fixture is near-bound (${sizeG} bytes, threshold ${LAND_QUEUE_ROTATION_THRESHOLD_BYTES}, bound ${LAND_QUEUE_READ_MAX_BYTES})`);
      const queueG = writeQueueFixture(dirG, fixtureG);
      const beforeG = readJson(queueG);
      const beforeGIssues = ((beforeG?.items as any[]) ?? []).map((e) => e.issue).sort();
      outG = driveQueueRun("run-bra261-G", caseInput(queueG, path.join(dirG, "work")));
      if (outG) {
        check(outG.verdict === "ordered", `G verdict ordered (got ${outG.verdict}: ${JSON.stringify(outG.notes)})`);
        check((outG.notes as string[]).some((n) => n.startsWith("rotation: 3 landed entries archived to land-queue-rotated-")), `G the report's notes carry the rotation (got ${JSON.stringify(outG.notes)})`);
        check(JSON.stringify(outG.ready) === JSON.stringify(["BRA-901"]), `G ready is unchanged (got ${JSON.stringify(outG.ready)})`);
        check(JSON.stringify(outG.paused) === JSON.stringify(["BRA-903"]), `G paused is unchanged (got ${JSON.stringify(outG.paused)})`);
        check(JSON.stringify(outG.landed) === JSON.stringify(["BRA-912", "BRA-913", "BRA-914", "BRA-915", "BRA-916"]), `G landed keeps the 5 most recent (got ${JSON.stringify(outG.landed)})`);
        const afterG = readJson(queueG);
        const afterGSize = Buffer.byteLength(read(queueG) ?? "", "utf8");
        check(afterGSize < LAND_QUEUE_ROTATION_THRESHOLD_BYTES, `G the live file drops below the threshold (${afterGSize} bytes)`);
        check(afterG !== null, `G the queue file still parses`);
        if (afterG) {
          const liveIssues = ((afterG.items as any[]) ?? []).map((e) => e.issue);
          check(JSON.stringify(liveIssues) === JSON.stringify(["BRA-901", "BRA-903", "BRA-912", "BRA-913", "BRA-914", "BRA-915", "BRA-916"]), `G the live file keeps the unlanded + 5 most recent landed (got ${JSON.stringify(liveIssues)})`);
          check(JSON.stringify(((afterG.items as any[]) ?? []).map((e) => e.order)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]), `G orders are reassigned 1..7`);
          const histG = fs.readdirSync(dirG).filter((f) => f.startsWith("land-queue-rotated-"));
          check(histG.length === 1 && histG[0] === rotationHistoryFileName(NOW), `G exactly one history file appears, named for the run (got ${JSON.stringify(histG)})`);
          const movedG = readJson(path.join(dirG, rotationHistoryFileName(NOW)));
          check(movedG !== null && JSON.stringify(((movedG?.items as any[]) ?? []).map((e) => e.issue)) === JSON.stringify(["BRA-247/248", "BRA-910", "BRA-911"]), `G the history file holds the 3 moved entries, oldest first`);
          if (movedG) {
            const beforeByIssue = new Map(((beforeG?.items as any[]) ?? []).map((e) => [e.issue, e]));
            for (const e of movedG.items as any[]) {
              check(JSON.stringify(e) === JSON.stringify(beforeByIssue.get(e.issue)), `G the moved entry ${e.issue} is preserved in full`);
            }
            check(JSON.stringify(movedG.rotation) === JSON.stringify((afterG as any).rotation), `G the history file carries the same record as the live file`);
          }
          const allGIssues = [...liveIssues, ...(((movedG?.items as any[]) ?? []).map((e) => e.issue))].sort();
          check(JSON.stringify(allGIssues) === JSON.stringify(beforeGIssues), `G live + history is the original entry for entry`);
        }
      }

      // ---- D-261h over-bound refusal (H2a): a queue already over
      // the bound refuses loudly naming the bound and the
      // rotation — no rotation runs, no history file appears.
      const dirH = path.join(WORKDIR, "cases", "H-overbound");
      const { fixture: fixtureH, size: sizeH } = overBoundQueueFixture();
      check(sizeH > LAND_QUEUE_READ_MAX_BYTES, `H fixture is over-bound (${sizeH} bytes)`);
      const queueH = writeQueueFixture(dirH, fixtureH);
      const beforeH = read(queueH);
      const outH = driveQueueRun("run-bra261-H", caseInput(queueH, path.join(dirH, "work")));
      if (outH) {
        check(outH.verdict === "failed", `H verdict failed on an over-bound file (got ${outH.verdict})`);
        check((outH.notes as string[]).some((n) => n.includes("exceeds the " + LAND_QUEUE_READ_MAX_BYTES + "-byte read bound") && n.includes("rotation needed")), `H the refusal names the bound and the rotation (got ${JSON.stringify(outH.notes)})`);
        check(read(queueH) === beforeH, `H the file is byte-identical after the refusal`);
        const histH = fs.readdirSync(dirH).filter((f) => f.startsWith("land-queue-rotated-"));
        check(histH.length === 0, `H no history file appears (got ${JSON.stringify(histH)})`);
      }

      // ---- D-261i rotated-queue drives (H2b): the rotated queue
      // drives the throughput-report + bottleneck-detect readers
      // green via the D-247f/D-248g fallback — the synthetic push
      // names BRA-247/248 as awaiting Quality, the unknown-status
      // entry is skipped-with-reason.
      const dirI = path.join(WORKDIR, "cases", "I-rotated-drives");
      fs.mkdirSync(dirI, { recursive: true });
      const rotatedCopy = JSON.parse(read(queueG) ?? "{}") as { items: any[] };
      check(!rotatedCopy.items.some((e) => e.issue === "BRA-247/248"), `I BRA-247/248 is archived, not in the rotated live file`);
      // Rewrite every entry's copy dir to a case-local dir with a
      // manifest (copiedAt), so the reader drives compute pickup
      // from real dirs — the rotated fixture's copy paths point
      // at nonexistent copies.
      for (const e of rotatedCopy.items) {
        const copyDir = path.join(dirI, "copies", String(e.issue).replaceAll("/", "-"));
        fs.mkdirSync(copyDir, { recursive: true });
        fs.writeFileSync(path.join(copyDir, "manifest.json"), JSON.stringify({ copiedAt: "2026-11-10T00:00:00Z", root: copyDir, files: {} }, null, 2) + "\n");
        delete (e as any).copies;
        (e as any).copy = copyDir;
      }
      const synCopy = path.join(dirI, "copies", "BRA-303");
      fs.mkdirSync(synCopy, { recursive: true });
      fs.writeFileSync(path.join(synCopy, "manifest.json"), JSON.stringify({ copiedAt: "2026-11-21T00:00:00Z", root: synCopy, files: {} }, null, 2) + "\n");
      rotatedCopy.items.push({ issue: "BRA-247/248", title: "Synthetic pending_qa (the live entry landed)", status: "pending_qa", copy: synCopy, ready_at: "2026-11-22T11:17:44Z" });
      rotatedCopy.items.push({ issue: "BRA-999", title: "Unknown status", status: "flying", copy: synCopy, ready_at: "2026-11-22T11:00:00Z" });
      const queueI = path.join(dirI, "land-queue.json");
      fs.writeFileSync(queueI, JSON.stringify(rotatedCopy, null, 2) + "\n");
      // Minimal scratch project for the readers: an empty ledger
      // + fixture baselines; no serverUrl, no merge reports —
      // the case asserts only the pending / skip naming, never
      // totals.
      const stateI = path.join(dirI, "state");
      fs.mkdirSync(path.join(stateI, "ledger"), { recursive: true });
      fs.writeFileSync(path.join(stateI, "ledger", "run-ledger.jsonl"), "");
      fs.writeFileSync(path.join(stateI, "ledger", "workflow-baselines.json"), JSON.stringify(fixtureBaselines(), null, 2) + "\n");
      const workI = path.join(dirI, "work");
      fs.mkdirSync(path.join(workI, "tmp"), { recursive: true });
      const tpInput: ThroughputReportInput = {
        project: testProject(stateI, workI),
        run: { reportId: "throughput-2026-11-22", date: "2026-11-22", queuePath: queueI, mergeReportPaths: [], reportPath: path.join(dirI, "throughput-2026-11-22.json"), now: NOW },
        owner: IMPL_OWNER,
        launchedBy: "test-director",
      };
      if (submitWorkflow("run-bra261-I-tp", THROUGHPUT_REPORT, tpInput)) {
        driveQueue();
        const outTp = fetchResult("run-bra261-I-tp");
        if (outTp) {
          check(outTp.verdict === "reported", `I throughput verdict reported on the rotated queue (got ${outTp.verdict})`);
          const tpFile = readJson(path.join(dirI, "throughput-2026-11-22.json"));
          check(tpFile !== null && Array.isArray(tpFile.pendingQa) && (tpFile.pendingQa as any[]).some((p: any) => p.issue === "BRA-247/248"), `I the throughput file lists BRA-247/248 as awaiting Quality (got ${JSON.stringify(tpFile?.pendingQa)})`);
          check(tpFile !== null && !((tpFile.items as any[]) ?? []).some((i: any) => i.issue === "BRA-999"), `I the skipped entry has no item line`);
          check(tpFile !== null && Array.isArray(tpFile.missing) && (tpFile.missing as any[]).some((m: any) => m.source === "queue:BRA-999" && m.reason.includes("unknown status")), `I the skipped entry rides the missing sources (got ${JSON.stringify(tpFile?.missing)})`);
          check(Array.isArray(outTp.notes) && (outTp.notes as string[]).some((n) => n.includes("awaiting Quality") && n.includes("BRA-247/248")), `I the throughput report names BRA-247/248 as awaiting Quality (got ${JSON.stringify(outTp.notes)})`);
        }
      }
      // Bottleneck-detect drive (derives from the sources — no
      // throughput report supplied).
      const bdInput: BottleneckDetectInput = {
        project: testProject(stateI, workI),
        run: { bottleneckId: "bottleneck-2026-11-22", date: "2026-11-22", queuePath: queueI, backlogPath: path.join(dirI, "backlog.md"), fixCostMs: 3_600_000, fixProbability: 1, now: NOW },
        owner: IMPL_OWNER,
        launchedBy: "test-director",
      };
      if (submitWorkflow("run-bra261-I-bd", BOTTLENECK_DETECT, bdInput)) {
        driveQueue();
        const outBd = fetchResult("run-bra261-I-bd");
        if (outBd) {
          check(outBd.verdict === "checked", `I bottleneck verdict checked on the rotated queue (got ${outBd.verdict})`);
          check(outBd.filed === false, `I nothing filed (got filed=${outBd.filed})`);
          check((outBd.bottleneck as any).kind === "unknown", `I bottleneck unknown with nothing decomposed (got ${JSON.stringify(outBd.bottleneck)})`);
          check(Array.isArray(outBd.notes) && (outBd.notes as string[]).some((x) => x.includes("awaiting Quality") && x.includes("BRA-247/248")), `I the bottleneck report names BRA-247/248 as awaiting Quality (got ${JSON.stringify(outBd.notes)})`);
          check(Array.isArray(outBd.notes) && (outBd.notes as string[]).some((x) => x.includes("skipped 1 queue entry") && x.includes("BRA-999")), `I the bottleneck report names the skipped entry (got ${JSON.stringify(outBd.notes)})`);
          check(!fs.existsSync(path.join(dirI, "backlog.md")), `I no backlog file written`);
        }
      }

      // ---- D-261j record traceability (H2c): the rotation is
      // traceable from the file alone.
      const afterJ = readJson(queueG);
      const histJ = readJson(path.join(dirG, rotationHistoryFileName(NOW)));
      check(afterJ !== null && afterJ.updated === NOW, `J updated is set to now (got ${JSON.stringify(afterJ?.updated)})`);
      const recJ = (afterJ as any)?.rotation as Record<string, any> | undefined;
      check(recJ !== undefined, `J the live file carries a rotation record`);
      if (recJ) {
        check(recJ.rotated_at === NOW, `J rotated_at is now (got ${JSON.stringify(recJ.rotated_at)})`);
        check(recJ.archived_to === rotationHistoryFileName(NOW), `J archived_to names the history file (got ${JSON.stringify(recJ.archived_to)})`);
        check(recJ.archived_count === 3, `J archived_count is 3 (got ${JSON.stringify(recJ.archived_count)})`);
        check(JSON.stringify(recJ.archived_issues) === JSON.stringify(["BRA-247/248", "BRA-910", "BRA-911"]), `J archived_issues names the moved entries (got ${JSON.stringify(recJ.archived_issues)})`);
        check(typeof recJ.note === "string" && recJ.note.includes("land-queue-rotated-"), `J the record carries a note`);
        check(Array.isArray((afterJ as any).rotations) && (afterJ as any).rotations.length === 1, `J the rotations array holds one record (got ${JSON.stringify((afterJ as any).rotations?.length)})`);
        check(JSON.stringify((afterJ as any).rotations[0]) === JSON.stringify(recJ), `J rotation is the latest rotations entry`);
      }
      check(histJ !== null && Array.isArray(histJ.items) && histJ.items.length === 3, `J the history file holds the 3 moved entries`);
      check((outG?.notes as string[]).some((n) => n.includes("rotation: 3 landed entries archived to " + rotationHistoryFileName(NOW))), `J the report's notes match the file's record`);

      // ---- D-261k cross-shift between rotations (X1a): an entry
      // added to the live file after a rotation survives the
      // next run exactly once — never lost, never duplicated.
      // (The within-run interleave — a write landing between
      // the rotation's read and its write — is covered by the §C
      // re-read tests; the staged cross-shift reconciliation is
      // the lead's, brief §3 step 6.)
      const dirK = path.join(WORKDIR, "cases", "K-cross-shift");
      const { fixture: fixtureK } = nearBoundQueueFixture();
      const queueK = writeQueueFixture(dirK, fixtureK);
      const outK1 = driveQueueRun("run-bra261-K1", caseInput(queueK, path.join(dirK, "work")));
      check(outK1 !== null && outK1.verdict === "ordered", `K first run orders with a rotation (got ${outK1?.verdict})`);
      // An entry arrives after the rotation (a write in the next
      // shift): append it to the live file on disk.
      const liveK = readJson(queueK) as Record<string, any>;
      (liveK.items as any[]).push({
        issue: "BRA-920", title: "Arrived after the rotation", copy: "~/workspace/agentts-copy-k",
        order: 99, ready_at: "2026-11-21T11:00:00Z", landed_at: null,
        status: "ready", notes: "", verification: PASS_VERIFICATION, authorization: FIXTURE_AUTH,
      });
      fs.writeFileSync(queueK, JSON.stringify(liveK, null, 1) + "\n");
      const outK2 = driveQueueRun("run-bra261-K2", caseInput(queueK, path.join(dirK, "work"), { now: "2026-11-22T08:00:00Z" }));
      const afterK = readJson(queueK);
      const histK = fs.readdirSync(dirK).filter((f) => f.startsWith("land-queue-rotated-"));
      const allK = [...((afterK?.items as any[]) ?? []).map((e) => e.issue)];
      for (const h of histK) {
        const hj = readJson(path.join(dirK, h));
        allK.push(...((hj?.items as any[]) ?? []).map((e) => e.issue));
      }
      check(outK2 !== null && outK2.verdict === "ordered", `K second run orders (got ${outK2?.verdict})`);
      check(allK.filter((i) => i === "BRA-920").length === 1, `K the added entry appears exactly once (got ${JSON.stringify(allK)})`);
      check(JSON.stringify([...allK].sort()) === JSON.stringify(["BRA-247/248", "BRA-901", "BRA-903", "BRA-910", "BRA-911", "BRA-912", "BRA-913", "BRA-914", "BRA-915", "BRA-916", "BRA-920"].sort()), `K live + history is the original plus the added entry, nothing lost (got ${JSON.stringify([...allK].sort())})`);

      // ---- D-261l most-recent-landed boundary (X1b): exactly
      // the 5 most recent landed entries stay, the older ones
      // move.
      const dirL = path.join(WORKDIR, "cases", "L-boundary");
      const { fixture: fixtureL } = nearBoundQueueFixture();
      const queueL = writeQueueFixture(dirL, fixtureL);
      const outL = driveQueueRun("run-bra261-L", caseInput(queueL, path.join(dirL, "work")));
      if (outL) {
        check(outL.verdict === "ordered", `L verdict ordered (got ${outL.verdict})`);
        check(JSON.stringify(outL.landed) === JSON.stringify(["BRA-912", "BRA-913", "BRA-914", "BRA-915", "BRA-916"]), `L the 5 most recent landed stay (got ${JSON.stringify(outL.landed)})`);
        const histL = fs.readdirSync(dirL).filter((f) => f.startsWith("land-queue-rotated-"));
        check(histL.length === 1, `L exactly one history file appears (got ${JSON.stringify(histL)})`);
        const hjL = readJson(path.join(dirL, histL[0]));
        check(JSON.stringify(((hjL?.items as any[]) ?? []).map((e) => e.issue)) === JSON.stringify(["BRA-247/248", "BRA-910", "BRA-911"]), `L the 3 older landed move, oldest first (got ${JSON.stringify(((hjL?.items as any[]) ?? []).map((e) => e.issue))})`);
      }

      // ---- D-261m dry-run rotation: a near-bound queue in
      // dry-run names the would-be rotation and writes nothing.
      const dirM = path.join(WORKDIR, "cases", "M-dryrun-rotation");
      const { fixture: fixtureM } = nearBoundQueueFixture();
      const queueM = writeQueueFixture(dirM, fixtureM);
      const beforeM = read(queueM);
      const outM = driveQueueRun("run-bra261-M", caseInput(queueM, path.join(dirM, "work"), { dryRun: true }));
      if (outM) {
        check(outM.verdict === "dry-run", `M verdict dry-run (got ${outM.verdict})`);
        check((outM.notes as string[]).some((n) => n.startsWith("rotation would fire: 3 landed entries would move to land-queue-rotated-")), `M the dry-run names the would-be rotation (got ${JSON.stringify(outM.notes)})`);
        check(read(queueM) === beforeM, `M the file is byte-identical after a dry-run rotation plan`);
        check(fs.readdirSync(dirM).filter((f) => f.startsWith("land-queue-rotated-")).length === 0, `M no history file appears on a dry-run`);
      }
    }
  } finally {
    await stopServer();
  }
  if (FAILURES.length > 0) {
    console.log(`\nFAILURES (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    return 1;
  }
  console.log("\nPASS test-bra261 (land-queue)");
  return 0;
}

main().then((rc) => {
  console.log("TEST EXIT rc=" + rc);
  process.exit(rc);
}).catch((e) => {
  console.log("TEST FAILED:", e);
  process.exit(1);
});
