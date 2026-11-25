/**
 * test-bra246.ts — the VM-replacement recovery workflow (BRA-246).
 *
 *   A. The inventory check passes (suite-inventory.json agrees
 *      with run.sh — the vm-recovery section is wired after
 *      server-restart).
 *   B. `agentts check` passes on vm-recovery.ts (first-run gate).
 *   C. Pure unit checks: validateVmRecoveryInput (every guard),
 *      isBootIdShape, prefixForRunId, bootIdScript +
 *      parseBootId (through sh: the live /proc boot id parses),
 *      journalSummaryScript + parseJournalSummary (through sh:
 *      completed / failed with the error named / trap activity
 *      / empty journal / missing journal), listStemsScript +
 *      parseListStems (through sh), existsScript + parseExists
 *      (through sh), classifyInterruptedRun (every engine
 *      branch: lifecycle completed → finished, lifecycle failed
 *      → failed, rc 2/3 + blob → resumed, rc 2/3 without blob →
 *      could-not-resume, rc 0 → finished, rc 1 + blob →
 *      resumed, rc 1 without blob → could-not-resume, other rc
 *      → failed, no registry + trap activity → could-not-resume
 *      (left for a human), no registry + no trap activity →
 *      resumed, missing journal → could-not-resume, the suite
 *      variant with the next section named),
 *      nextSuiteSection (first unfinished tier-1 slug, all-done,
 *      unparsable inventory), vmRecoveryUnitContent (the unit
 *      carries the server start + the 246 CLI invocation + the
 *      queue drive, the run-id uses the boot id with no `%`
 *      specifier, WantedBy=default.target),
 *      buildVmRecoveryDeliveryPayloads (established → Director
 *      only; recovered → Director + per-lead runs; failed →
 *      Director; no-replacement → none).
 *   D. Live runs through the CLI on direct, each against a
 *      scratch fixture state dir + a scratch server on a random
 *      port — never the production state dir, never port 18741,
 *      never the real server. A replacement is simulated by
 *      writing a fake-old recorded boot id (the test controls
 *      the RECORDED id, never the current one). Every case
 *      asserts the report AND the on-disk outcome separately:
 *      D-246a first run (no record) → established (the record
 *        is written with the current boot id, the unit file is
 *        written, the server is NOT restarted);
 *      D-246b no replacement (record == current boot id) →
 *        no-replacement (the record is unchanged, nothing
 *        restarted, no payloads);
 *      D-246c replacement, server down, no stranded runs →
 *        recovered (the server is spawned + verified, the
 *        record is updated to the current boot id);
 *      D-246d replacement with stranded runs (the full
 *        classification matrix live: finished / resumed
 *        workflow / could-not-resume blob-missing / resumed
 *        never-started / could-not-resume inconsistent /
 *        resumed suite with the next section named / failed) —
 *        the per-lead payloads name each lead's runs;
 *      D-246e dry-run with a replacement → dry-run (the record
 *        is NOT updated, the unit file is NOT written, the
 *        server is NOT started, but the classification is
 *        computed and reported);
 *      D-246f cancel (hand-crafted cancelled entry, the
 *        bra210a case-H shape) → failed, cancelChecked +
 *        cancelled true, nothing written;
 *      D-246g validation, live (a run missing serverCommand is
 *        refused with the field named);
 *      D-246h corrupt recorded boot id → failed, names the
 *        corruption;
 *      D-246i trigger proof: the workflow is driven by the
 *        exact CLI invocation the systemd unit would run
 *        (--input-file + a boot-style run-id) and lands
 *        established;
 *      D-246j suite continuation, live: run.sh --bash
 *        --resume-dir skips the marked sections (SKIP lines
 *        for the done slugs) and starts the next one.
 *      D-246k replacement, server ALREADY UP → recovered,
 *        verified only (restarted false, the same pid alive,
 *        no restart log, the note names the already-up state
 *        — decision 5: do not restart a running server).
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra246.ts
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
import recoverVmReplacement, {
  validateVmRecoveryInput,
  isBootIdShape,
  prefixForRunId,
  bootIdScript,
  parseBootId,
  journalSummaryScript,
  parseJournalSummary,
  listStemsScript,
  parseListStems,
  existsScript,
  parseExists,
  classifyInterruptedRun,
  nextSuiteSection,
  vmRecoveryUnitContent,
  buildVmRecoveryDeliveryPayloads,
  VM_RECOVERY_KNOWN_LIMIT,
  VM_RECOVERY_BOOT_ID_FILE,
  VM_RECOVERY_UNIT_FILE,
  VM_RECOVERY_INPUT_FILE,
  type VmRecoveryInput,
  type VmRecoveryProjectConfig,
  type VmRecoveryRunInput,
  type JournalSummary,
} from "../workflows/library/vm-recovery";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const VM_RECOVERY = path.join(ROOT, "workflows", "library", "vm-recovery.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA246_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "vm-recovery-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const STATE_DIR = path.join(WORKDIR, "state");
// Hermetic re-runs: the queue registry keeps run IDs forever, so a
// second run against the same state dir would fail every submit as
// "already queued". Wipe our own throwaway state dir at startup.
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 26000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
/** The Implementation lead owns recovery runs (brief: owner is the driving session). */
const IMPL_OWNER = "3e85493f-f748-4bcd-bec6-94be9c25b282";
const QA_OWNER = "0bc9a8c5-18fa-430c-b6c4-85a54c92b209";
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
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Run a shell script through /bin/sh and return its output. */
function sh(script: string): { rc: number; out: string; err: string } {
  const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
    if (Date.now() > deadline) throw new Error("vm-recovery test server did not come up");
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

/** Submit one vm-recovery run (no drive yet). */
function submitRecovery(runId: string, input: VmRecoveryInput, inputFileName?: string): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, inputFileName ?? `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", VM_RECOVERY,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
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

/** Drive one vm-recovery input through the CLI (submit + queue
 * run + result) and return the parsed report, or null on a CLI
 * failure (the failure is already recorded as a check). */
function driveRecovery(runId: string, input: VmRecoveryInput): Record<string, any> | null {
  if (!submitRecovery(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: scratch fixture state dirs.
// ------------------------------------------------------------------

interface Fixture {
  dir: string;
  runsDir: string;
  port: number;
  serverUrl: string;
}

let fixtureCounter = 0;
function makeFixture(opts: {
  bootId?: string | null;
  queue?: { runId: string; status: string; owner?: string }[];
  journals?: Record<string, string>;
  registry?: Record<string, string>;
  blobs?: string[];
}): Fixture {
  fixtureCounter++;
  const dir = path.join(WORKDIR, `fixture-${fixtureCounter}`);
  const runsDir = path.join(WORKDIR, `fixture-${fixtureCounter}-runs`);
  fs.mkdirSync(path.join(dir, "journals"), { recursive: true });
  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ledger"), { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  if (opts.bootId !== undefined && opts.bootId !== null) {
    fs.writeFileSync(path.join(dir, VM_RECOVERY_BOOT_ID_FILE), opts.bootId + "\n");
  }
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(opts.queue ?? []));
  for (const [runId, content] of Object.entries(opts.journals ?? {})) {
    fs.writeFileSync(path.join(dir, "journals", prefixForRunId(runId) + ".journal"), content);
  }
  for (const [runId, content] of Object.entries(opts.registry ?? {})) {
    fs.writeFileSync(path.join(dir, "runs", prefixForRunId(runId) + ".json"), content);
  }
  for (const runId of opts.blobs ?? []) {
    fs.writeFileSync(path.join(dir, "blobs", prefixForRunId(runId) + ".snap"), "SNAP");
  }
  const port = 27000 + Math.floor(Math.random() * 6000) + fixtureCounter;
  return { dir, runsDir, port, serverUrl: `http://127.0.0.1:${port}` };
}

/** One journal fixture: lifecycle events + trap events. */
function journalFixture(events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function testProject(workDir: string): VmRecoveryProjectConfig {
  return {
    linearProject: "AgentTS",
    repo: COPY_ROOT,
    stateDir: STATE_DIR,
    roster: { [QA_OWNER]: "quality", [PM_OWNER]: "program-management", [IMPL_OWNER]: "implementation" },
    workDir,
    resumeDir: path.join(workDir, "resume"),
  };
}

function recoveryInput(f: Fixture, extra: Partial<VmRecoveryRunInput> = {}): VmRecoveryInput {
  const workDir = path.join(WORKDIR, `work-${fixtureCounter}`);
  fs.mkdirSync(workDir, { recursive: true });
  return {
    project: testProject(workDir),
    run: {
      serverUrl: f.serverUrl,
      stateDir: f.dir,
      engineDir: ROOT,
      serverCommand: [BUN, "src/cli.ts", "worker", "serve", "--state-dir", f.dir, "--port", String(f.port)],
      runsDir: f.runsDir,
      ...extra,
    },
    owner: IMPL_OWNER,
    launchedBy: "test-director",
  };
}

/** Minimal valid input (the §C base; cases mutate it). */
function validInput(): VmRecoveryInput {
  const f = makeFixture({});
  return recoveryInput(f);
}

/** The live boot id (read from /proc by the test itself). */
function currentBootId(): string {
  const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!isBootIdShape(id)) throw new Error("test: /proc boot id is not a boot-id shape: " + id);
  return id;
}

/** A fake-old boot id (a valid shape, never the current one). */
const FAKE_OLD_BOOT_ID = "11111111-2222-3333-4444-555555555555";

/** Is the fixture server answering /health with ok:true? */
async function healthOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return body["ok"] === true;
  } catch {
    return false;
  }
}

function killPid(pid: number): boolean {
  try {
    process.kill(pid, 9);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid the workflow's spawn reported in the report notes
 * ("server spawned (pid N, log ...)"). */
function spawnPidFromNotes(notes: string[]): number | null {
  for (const n of notes) {
    const m = n.match(/server spawned \(pid (\d+),/);
    if (m) return parseInt(m[1]!, 10);
  }
  return null;
}

/** The first N tier-1 slugs from the copy's inventory, in order. */
function firstTier1Slugs(n: number): string[] {
  const inv = readJson(path.join(ROOT, "suite-inventory.json")) as { sections: { slug: string; tier: number }[] };
  return inv.sections.filter((s) => s.tier === 1).map((s) => s.slug).slice(0, n);
}

// ------------------------------------------------------------------
// §A inventory, §B check, §C pure units, §D live CLI runs.
// ------------------------------------------------------------------

async function main(): Promise<number> {
  // --------------------------------------------- §A inventory
  console.log("=== §A inventory ===");
  {
    const inv = readJson(path.join(ROOT, "suite-inventory.json")) as { sections: { slug: string; tier: number }[] } | null;
    const runSh = read(path.join(ROOT, "run.sh")) ?? "";
    const slugs = (inv?.sections ?? []).filter((s) => s.tier === 1).map((s) => s.slug);
    check(inv !== null && slugs.includes("vm-recovery"), "A OK: suite-inventory.json has a tier-1 vm-recovery section");
    const idx = slugs.indexOf("vm-recovery");
    const restartIdx = slugs.indexOf("server-restart");
    check(idx === restartIdx + 1, `A OK: vm-recovery follows server-restart in tier-1 order (got ${restartIdx} -> ${idx})`);
    check(runSh.includes("vm-recovery"), "A OK: run.sh wires the vm-recovery section");
  }

  // --------------------------------------------- §B agentts check
  console.log("\n=== §B agentts check ===");
  {
    const r = cli(["check", VM_RECOVERY, "--state-dir", STATE_DIR]);
    check(r.rc === 0 && r.out.includes("CHECK OK"), `B OK: agentts check passes on vm-recovery.ts (rc ${r.rc}: ${(r.out + r.err).slice(0, 300)})`);
  }

  // --------------------------------------------- §C pure units
  console.log("\n=== §C pure units ===");
  {
    // validateVmRecoveryInput: every guard.
    const base = validInput();
    check(validateVmRecoveryInput(base).length === 0, "C OK: the valid input validates");
    check(validateVmRecoveryInput(null as unknown as VmRecoveryInput).includes("input is not an object"), "C OK: non-object input refused");
    const noOwner = { ...base, owner: "" };
    check(validateVmRecoveryInput(noOwner).some((e) => e.includes("owner is required")), "C OK: missing owner refused");
    const noUrl = structuredClone(base);
    (noUrl.run as Record<string, unknown>)["serverUrl"] = "";
    check(validateVmRecoveryInput(noUrl).some((e) => e.includes("run.serverUrl")), "C OK: missing serverUrl refused");
    const noCmd = structuredClone(base);
    (noCmd.run as Record<string, unknown>)["serverCommand"] = [];
    check(validateVmRecoveryInput(noCmd).some((e) => e.includes("run.serverCommand")), "C OK: empty serverCommand refused");
    const badResume = structuredClone(base);
    (badResume.run as Record<string, unknown>)["resumeDirs"] = { "run-a": "" };
    check(validateVmRecoveryInput(badResume).some((e) => e.includes("run.resumeDirs")), "C OK: empty resumeDirs entry refused");
    const badVerify = structuredClone(base);
    (badVerify.run as Record<string, unknown>)["verifyAttempts"] = 0;
    check(validateVmRecoveryInput(badVerify).some((e) => e.includes("run.verifyAttempts")), "C OK: verifyAttempts < 1 refused");

    // isBootIdShape + prefixForRunId.
    check(isBootIdShape("11111111-2222-3333-4444-555555555555") === true, "C OK: a well-formed boot id matches");
    check(isBootIdShape("not-a-boot-id") === false && isBootIdShape("") === false, "C OK: malformed boot ids do not match");
    check(prefixForRunId("run-bra210c-accept/real") === "run-bra210c-accept_real", "C OK: prefixFor replaces / with _");

    // bootIdScript + parseBootId, through sh (the live /proc id).
    const bootRun = sh(bootIdScript());
    const bootParsed = parseBootId(bootRun.out);
    check(bootRun.rc === 0 && bootParsed !== null && isBootIdShape(bootParsed) && bootParsed === currentBootId(), `C OK: the live /proc boot id parses (got ${bootParsed})`);
    check(parseBootId("BOOTID-MISSING\n") === null, "C OK: a missing boot id parses to null");

    // journalSummaryScript + parseJournalSummary, through sh.
    const jDir = path.join(WORKDIR, "journal-cases");
    fs.mkdirSync(jDir, { recursive: true });
    const jCompleted = path.join(jDir, "completed.journal");
    fs.writeFileSync(jCompleted, journalFixture([
      { event: "run-started", runId: "r1", wallTs: "2026-11-22T13:00:00Z" },
      { event: "trap-dispatched", runId: "r1", wallTs: "2026-11-22T13:01:00Z" },
      { event: "lifecycle", lifecycle: "completed", runId: "r1", wallTs: "2026-11-22T13:02:00Z" },
    ]));
    const sumCompleted = parseJournalSummary(sh(journalSummaryScript(jCompleted)).out);
    check(sumCompleted !== null && sumCompleted.total === 3 && sumCompleted.completed === true && sumCompleted.failed === false && sumCompleted.trapActivity === true && sumCompleted.lastEvent === "lifecycle" && sumCompleted.lastWallTs === "2026-11-22T13:02:00Z", `C OK: a completed journal summarizes (got ${JSON.stringify(sumCompleted)})`);
    const jFailed = path.join(jDir, "failed.journal");
    fs.writeFileSync(jFailed, journalFixture([
      { event: "trap-result", runId: "r2", wallTs: "2026-11-22T13:00:00Z" },
      { event: "lifecycle", lifecycle: "failed", error: "boom: the workflow threw", runId: "r2", wallTs: "2026-11-22T13:01:00Z" },
    ]));
    const sumFailed = parseJournalSummary(sh(journalSummaryScript(jFailed)).out);
    check(sumFailed !== null && sumFailed.failed === true && sumFailed.failError === "boom: the workflow threw" && sumFailed.trapActivity === true, `C OK: a failed journal names the error (got ${JSON.stringify(sumFailed?.failError)})`);
    const jEmpty = path.join(jDir, "empty.journal");
    fs.writeFileSync(jEmpty, "");
    const sumEmpty = parseJournalSummary(sh(journalSummaryScript(jEmpty)).out);
    check(sumEmpty !== null && sumEmpty.total === 0 && sumEmpty.lastEvent === "-" && sumEmpty.lastWallTs === "-", "C OK: an empty journal summarizes to zero with - markers");
    const jJunk = path.join(jDir, "junk.journal");
    fs.writeFileSync(jJunk, "not json\n{\"event\":\"trap\",\"wallTs\":\"2026-11-22T13:00:00Z\"}\n{bad\n");
    const sumJunk = parseJournalSummary(sh(journalSummaryScript(jJunk)).out);
    check(sumJunk !== null && sumJunk.total === 1 && sumJunk.trapActivity === true, `C OK: unparsable journal lines are quarantined, good lines counted (got total ${sumJunk?.total})`);
    const missingJournal = sh(journalSummaryScript(path.join(jDir, "no-such.journal")));
    check(missingJournal.rc === 2 && parseJournalSummary(missingJournal.out) === null, "C OK: a missing journal exits 2 and parses to null");

    // listStemsScript + parseListStems, through sh.
    const listDir = path.join(jDir, "list-case");
    fs.mkdirSync(listDir, { recursive: true });
    fs.writeFileSync(path.join(listDir, "alpha.journal"), "");
    fs.writeFileSync(path.join(listDir, "beta.journal"), "");
    fs.writeFileSync(path.join(listDir, "gamma.txt"), "");
    const listed = parseListStems(sh(listStemsScript(listDir, ".journal", 200)).out);
    check(listed.stems.join(",") === "alpha,beta" && listed.truncated === false, `C OK: the listing names the .journal stems (got ${listed.stems.join(",")})`);
    const listedMissing = parseListStems(sh(listStemsScript(path.join(jDir, "no-dir"), ".journal", 200)).out);
    check(listedMissing.stems.length === 0, "C OK: a missing dir lists zero stems");

    // existsScript + parseExists, through sh.
    check(parseExists(sh(existsScript(jCompleted)).out) === true, "C OK: an existing file exists");
    check(parseExists(sh(existsScript(path.join(jDir, "no-such"))).out) === false, "C OK: a missing file does not exist");

    // classifyInterruptedRun: every engine branch.
    const baseArgs = {
      runId: "run-x",
      owner: QA_OWNER,
      lead: "quality",
      journalMissing: false,
      registryRc: null as number | null,
      registryMissing: true,
      blobExists: false,
      resumeDir: null as string | null,
      nextSuiteSection: null as string | null,
    };
    const jSummary = (over: Partial<JournalSummary>): JournalSummary => ({
      total: 3, completed: false, failed: false, trapActivity: true, lastEvent: "trap-result", lastWallTs: "2026-11-22T13:01:00Z", failError: null, ...over,
    });
    const done = classifyInterruptedRun({ ...baseArgs, journal: jSummary({ completed: true }) });
    check(done.outcome === "finished", "C OK: lifecycle completed → finished");
    const failedRun = classifyInterruptedRun({ ...baseArgs, journal: jSummary({ failed: true, failError: "boom" }) });
    check(failedRun.outcome === "failed" && (failedRun as { error: string }).error === "boom", "C OK: lifecycle failed → failed with the error");
    const suspended = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 2, blobExists: true });
    check(suspended.outcome === "resumed" && (suspended as { resumed: { resumeMechanism: string } }).resumed.resumeMechanism === "queue-drive", "C OK: rc 2 + blob → resumed via the queue drive");
    const suspendedNoBlob = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 3, blobExists: false });
    check(suspendedNoBlob.outcome === "could-not-resume" && (suspendedNoBlob as { reason: string }).reason.includes("snapshot blob is missing"), "C OK: rc 3 without a blob → could-not-resume");
    const regDone = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 0 });
    check(regDone.outcome === "finished", "C OK: rc 0 → finished");
    const crashBlob = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 1, blobExists: true });
    check(crashBlob.outcome === "resumed", "C OK: rc 1 + blob → resumed (C-host crash mid-slice)");
    const crashNoBlob = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 1, blobExists: false });
    check(crashNoBlob.outcome === "could-not-resume", "C OK: rc 1 without a blob → could-not-resume");
    const regOther = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 7 });
    check(regOther.outcome === "failed" && (regOther as { error: string }).error.includes("exited 7"), "C OK: other rc → failed with the exit code");
    const inconsistent = classifyInterruptedRun({ ...baseArgs, journal: jSummary({ trapActivity: true }) });
    check(inconsistent.outcome === "could-not-resume" && (inconsistent as { reason: string }).reason.includes("double-execute"), "C OK: no registry + trap activity → could-not-resume (left for a human)");
    const neverStarted = classifyInterruptedRun({ ...baseArgs, journal: jSummary({ trapActivity: false }) });
    check(neverStarted.outcome === "resumed" && (neverStarted as { resumed: { resumePoint: string } }).resumed.resumePoint === "trap-result", "C OK: no registry + no trap activity → resumed from the last event");
    const noJournal = classifyInterruptedRun({ ...baseArgs, journal: null, journalMissing: true });
    check(noJournal.outcome === "could-not-resume" && (noJournal as { reason: string }).reason.includes("no journal"), "C OK: a missing journal → could-not-resume");
    const suiteRun = classifyInterruptedRun({ ...baseArgs, journal: jSummary({}), registryMissing: false, registryRc: 2, blobExists: true, resumeDir: "/tmp/resume-1", nextSuiteSection: "layering" });
    check(
      suiteRun.outcome === "resumed" &&
        (suiteRun as { resumed: { kind: string; resumeMechanism: string; resumePoint: string; resumeDir: string } }).resumed.kind === "suite" &&
        (suiteRun as { resumed: { resumeMechanism: string } }).resumed.resumeMechanism === "run.sh --resume-dir" &&
        (suiteRun as { resumed: { resumePoint: string } }).resumed.resumePoint === "layering",
      "C OK: a suite run resumes via run.sh --resume-dir at the next section",
    );

    // nextSuiteSection: first unfinished, all-done, unparsable.
    const invText = JSON.stringify({ version: 1, sections: [{ slug: "mock", tier: 1 }, { slug: "profiler", tier: 1 }, { slug: "checker", tier: 1 }, { slug: "ref", tier: 2 }] });
    check(nextSuiteSection({ inventoryText: invText, doneMarkers: new Set(["mock", "profiler"]) }).next === "checker", "C OK: the next section is the first unfinished tier-1 slug");
    check(nextSuiteSection({ inventoryText: invText, doneMarkers: new Set(["mock", "profiler", "checker"]) }).next === null, "C OK: all tier-1 sections done → null");
    check(nextSuiteSection({ inventoryText: "{bad", doneMarkers: new Set() }).reason !== null, "C OK: an unparsable inventory names the reason");

    // vmRecoveryUnitContent: the trigger, verbatim.
    const unit = vmRecoveryUnitContent({
      engineDir: "/home/hatch/workspace/agentts-repo/apps/agentts",
      serverCommand: ["/opt/hatch-image/bin/bun", "src/cli.ts", "worker", "serve", "--state-dir", "/home/hatch/workspace/agentts-state", "--port", "18741"],
      runsDir: "/home/hatch/workspace/agentts-runs",
      stateDir: "/home/hatch/workspace/agentts-state",
      bunPath: "/opt/hatch-image/bin/bun",
    });
    check(unit.includes("WorkingDirectory=/home/hatch/workspace/agentts-repo/apps/agentts"), "C OK: the unit sets the engine working directory");
    check(unit.includes("run-bra246-boot-$(cat /proc/sys/kernel/random/boot_id | cut -c1-8)"), "C OK: the unit run-id uses the boot id");
    check(!unit.includes("%Y") && !unit.includes("%m") && !unit.includes("%d"), "C OK: the unit carries no % date specifiers (systemd would expand them)");
    check(unit.includes("vm-recovery.ts") && unit.includes("--input-file /home/hatch/workspace/agentts-state/vm-recovery-input.json"), "C OK: the unit invokes 246 with the input file");
    check(unit.includes("queue run --state-dir /home/hatch/workspace/agentts-state"), "C OK: the unit drives the queue after 246");
    check(unit.includes("WantedBy=default.target"), "C OK: the unit is wanted by default.target");
    check(unit.includes("server-restart-boot.log"), "C OK: the unit's server start logs to server-restart-boot.log");

    // buildVmRecoveryDeliveryPayloads: per verdict.
    const pEstablished = buildVmRecoveryDeliveryPayloads({
      verdict: "established", recoveryId: "rec-1", oldBootId: null, newBootId: currentBootId(), serverVerified: true, resumed: [], couldNotResume: [], failed: [], ownerRoster: {},
    });
    check(pEstablished.length === 1 && pEstablished[0].target === "director" && pEstablished[0].message.includes("trigger is armed"), "C OK: established names only the Director");
    const pRecovered = buildVmRecoveryDeliveryPayloads({
      verdict: "recovered", recoveryId: "rec-2", oldBootId: FAKE_OLD_BOOT_ID, newBootId: currentBootId(), serverVerified: true,
      resumed: [{ runId: "run-a", owner: QA_OWNER, lead: "quality", kind: "workflow", resumeDir: null, resumePoint: "trap-result", resumeMechanism: "queue-drive", reason: "r" }],
      couldNotResume: [{ runId: "run-b", owner: PM_OWNER, lead: "program-management", kind: "workflow", reason: "blob missing" }],
      failed: [{ runId: "run-c", owner: PM_OWNER, error: "the workflow threw" }],
      ownerRoster: { [QA_OWNER]: "quality", [PM_OWNER]: "program-management" },
    });
    check(pRecovered.length === 3 && pRecovered[0].target === "director" && pRecovered.some((p) => p.target === QA_OWNER && p.message.includes("run-a")) && pRecovered.some((p) => p.target === PM_OWNER && p.message.includes("run-b") && p.message.includes("run-c")), `C OK: recovered names the Director + each affected lead, failed runs included (got ${pRecovered.map((p) => p.target).join(",")})`);
    const pNone = buildVmRecoveryDeliveryPayloads({
      verdict: "no-replacement", recoveryId: "rec-3", oldBootId: currentBootId(), newBootId: currentBootId(), serverVerified: true, resumed: [], couldNotResume: [], failed: [], ownerRoster: {},
    });
    check(pNone.length === 0, "C OK: no-replacement emits no payload");
    check(VM_RECOVERY_KNOWN_LIMIT.includes("does not drive the resumes itself") && VM_RECOVERY_KNOWN_LIMIT.includes("never silently dropped"), "C OK: the known-limit string carries the v0 limits verbatim");
  }

  // --------------------------------------------- §D live CLI runs
  console.log("\n=== §D live CLI runs ===");
  await startServer();
  try {
    // ---- D-246a first run (no record) → established (the
    // record + unit file are written, the server is NOT
    // restarted).
    {
      const f = makeFixture({});
      const out = driveRecovery("recovery-d246a", recoveryInput(f));
      if (out) {
        check(out.verdict === "established", `D-246a OK: verdict established (got ${out.verdict})`);
        check(out.firstRun === true && out.replacement === false, `D-246a OK: first run, not a replacement (got ${out.firstRun}/${out.replacement})`);
        check(out.newBootId === currentBootId(), `D-246a OK: the new boot id is the live one (got ${out.newBootId})`);
        const record = read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE));
        check(record !== null && record.trim() === currentBootId(), `D-246a OK: the boot-id record is written on disk (got ${JSON.stringify(record)})`);
        const unit = read(path.join(f.dir, VM_RECOVERY_UNIT_FILE));
        check(unit !== null && unit.includes("vm-recovery.ts") && unit.includes("WantedBy=default.target"), "D-246a OK: the unit file is written on disk");
        check(out.server?.restarted === false, `D-246a OK: the server was NOT restarted (got ${out.server?.restarted})`);
        check(fs.readdirSync(f.runsDir).filter((n) => n.startsWith("server-restart-")).length === 0, "D-246a OK: no restart log was written");
        check((out.deliveryPayloads as { target: string }[]).some((p) => p.target === "director"), "D-246a OK: the Director payload is present");
        check(out.trigger?.unitPath === path.join(f.dir, VM_RECOVERY_UNIT_FILE), `D-246a OK: the trigger names the unit path (got ${out.trigger?.unitPath})`);
        check(Array.isArray(out.trigger?.enableCommands) && (out.trigger.enableCommands as string[]).some((c) => c.includes("systemctl --user enable")), "D-246a OK: the trigger names the enable commands");
      }
    }

    // ---- D-246b no replacement (record == current boot id) →
    // no-replacement (the record is unchanged, nothing
    // restarted, no payloads).
    {
      const f = makeFixture({ bootId: currentBootId() });
      const before = read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE));
      const out = driveRecovery("recovery-d246b", recoveryInput(f));
      if (out) {
        check(out.verdict === "no-replacement", `D-246b OK: verdict no-replacement (got ${out.verdict})`);
        check(out.replacement === false && out.firstRun === false, `D-246b OK: not a replacement, not a first run (got ${out.replacement}/${out.firstRun})`);
        check(out.oldBootId === currentBootId() && out.newBootId === currentBootId(), "D-246b OK: old and new boot ids match");
        check(read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE)) === before, "D-246b OK: the record is unchanged on disk");
        check(out.server?.restarted === false, `D-246b OK: the server was NOT restarted (got ${out.server?.restarted})`);
        check((out.deliveryPayloads as unknown[]).length === 0, "D-246b OK: no delivery payload for a routine no-replacement");
      }
    }

    // ---- D-246c replacement, server down, no stranded runs →
    // recovered (the server is spawned + verified, the record
    // is updated).
    {
      const f = makeFixture({ bootId: FAKE_OLD_BOOT_ID });
      const out = driveRecovery("recovery-d246c", recoveryInput(f));
      if (out) {
        check(out.verdict === "recovered", `D-246c OK: verdict recovered (got ${out.verdict})`);
        check(out.replacement === true && out.oldBootId === FAKE_OLD_BOOT_ID, `D-246c OK: a replacement from the fake-old id (got ${out.oldBootId})`);
        check(out.server?.restarted === true && out.server?.verified === true, `D-246c OK: the server restarted + verified (got ${out.server?.restarted}/${out.server?.verified})`);
        check(out.server?.healthAfter?.ok === true, "D-246c OK: healthAfter ok");
        check(read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE))?.trim() === currentBootId(), "D-246c OK: the record is updated to the current boot id on disk");
        check(typeof out.server?.restartLogPath === "string" && fs.existsSync(out.server.restartLogPath), "D-246c OK: the restart log exists on disk");
        check(await healthOk(f.serverUrl), "D-246c OK: /health answers ok:true after the recovery");
        check((out.deliveryPayloads as { target: string }[]).some((p) => p.target === "director"), "D-246c OK: the Director payload is present");
        const pid = spawnPidFromNotes(out.notes as string[]);
        check(pid !== null && pidAlive(pid), `D-246c OK: the spawned server pid is alive (got ${pid})`);
        if (pid !== null) killPid(pid);
        await sleep(200);
        check(!(await healthOk(f.serverUrl)), "D-246c OK: /health is down again after killing the spawned server");
      }
    }

    // ---- D-246d replacement with stranded runs — the full
    // classification matrix, live.
    {
      const resumeDir = path.join(WORKDIR, "resume-d246d");
      fs.mkdirSync(path.join(resumeDir, ".done"), { recursive: true });
      const doneSlugs = firstTier1Slugs(3);
      for (const slug of doneSlugs) fs.writeFileSync(path.join(resumeDir, ".done", slug), "ok=10\n");
      const nextSlug = firstTier1Slugs(4)[3]!;
      const f = makeFixture({
        bootId: FAKE_OLD_BOOT_ID,
        queue: [
          { runId: "run-wf-1", status: "running", owner: QA_OWNER },
          { runId: "run-wf-2", status: "running", owner: QA_OWNER },
          { runId: "run-wf-3", status: "running", owner: PM_OWNER },
          { runId: "run-wf-4", status: "running", owner: PM_OWNER },
          { runId: "run-wf-5", status: "running", owner: QA_OWNER },
          { runId: "run-suite-1", status: "running", owner: QA_OWNER },
          { runId: "run-wf-6", status: "running", owner: PM_OWNER },
          { runId: "run-done-1", status: "done", owner: QA_OWNER },
        ],
        journals: {
          "run-wf-1": journalFixture([
            { event: "trap-dispatched", runId: "run-wf-1", wallTs: "2026-11-22T13:00:00Z" },
            { event: "lifecycle", lifecycle: "completed", runId: "run-wf-1", wallTs: "2026-11-22T13:01:00Z" },
          ]),
          "run-wf-2": journalFixture([
            { event: "trap-dispatched", runId: "run-wf-2", wallTs: "2026-11-22T13:00:00Z" },
            { event: "trap-result", runId: "run-wf-2", wallTs: "2026-11-22T13:01:00Z" },
          ]),
          "run-wf-3": journalFixture([
            { event: "trap-dispatched", runId: "run-wf-3", wallTs: "2026-11-22T13:00:00Z" },
          ]),
          "run-wf-4": journalFixture([
            { event: "run-started", runId: "run-wf-4", wallTs: "2026-11-22T13:00:00Z" },
          ]),
          "run-wf-5": journalFixture([
            { event: "trap-dispatched", runId: "run-wf-5", wallTs: "2026-11-22T13:00:00Z" },
          ]),
          "run-suite-1": journalFixture([
            { event: "trap-dispatched", runId: "run-suite-1", wallTs: "2026-11-22T13:00:00Z" },
            { event: "trap-result", runId: "run-suite-1", wallTs: "2026-11-22T13:01:00Z" },
          ]),
          "run-wf-6": journalFixture([
            { event: "trap-result", runId: "run-wf-6", wallTs: "2026-11-22T13:00:00Z" },
            { event: "lifecycle", lifecycle: "failed", error: "the workflow threw", runId: "run-wf-6", wallTs: "2026-11-22T13:01:00Z" },
          ]),
        },
        registry: {
          "run-wf-2": JSON.stringify({ runId: "run-wf-2", rc: 2 }),
          "run-wf-3": JSON.stringify({ runId: "run-wf-3", rc: 1 }),
          "run-suite-1": JSON.stringify({ runId: "run-suite-1", rc: 3 }),
        },
        blobs: ["run-wf-2", "run-suite-1"],
      });
      const out = driveRecovery("recovery-d246d", recoveryInput(f, { resumeDirs: { "run-suite-1": resumeDir } }));
      if (out) {
        check(out.verdict === "recovered", `D-246d OK: verdict recovered (got ${out.verdict})`);
        check(out.server?.verified === true, "D-246d OK: the server is verified up");
        const resumedIds = (out.resumed as { runId: string }[]).map((r) => r.runId).sort();
        check(resumedIds.join(",") === "run-suite-1,run-wf-2,run-wf-4", `D-246d OK: resumed runs named (got ${resumedIds.join(",")})`);
        const couldNotIds = (out.couldNotResume as { runId: string }[]).map((r) => r.runId).sort();
        check(couldNotIds.join(",") === "run-wf-3,run-wf-5", `D-246d OK: could-not-resume runs named (got ${couldNotIds.join(",")})`);
        check((out.finished as string[]).join(",") === "run-wf-1", `D-246d OK: finished runs named (got ${(out.finished as string[]).join(",")})`);
        check((out.failedRuns as string[]).join(",") === "run-wf-6", `D-246d OK: failed runs named (got ${(out.failedRuns as string[]).join(",")})`);
        const suite = (out.resumed as { runId: string; kind: string; resumeMechanism: string; resumePoint: string; resumeDir: string }[]).find((r) => r.runId === "run-suite-1");
        check(suite !== undefined && suite.kind === "suite" && suite.resumeMechanism === "run.sh --resume-dir" && suite.resumePoint === nextSlug && suite.resumeDir === resumeDir, `D-246d OK: the suite run names its resume dir + next section (got ${JSON.stringify(suite)})`);
        const wf2 = (out.resumed as { runId: string; kind: string; resumeMechanism: string; resumePoint: string }[]).find((r) => r.runId === "run-wf-2");
        check(wf2 !== undefined && wf2.kind === "workflow" && wf2.resumeMechanism === "queue-drive" && wf2.resumePoint === "trap-result", `D-246d OK: the workflow run names the queue drive + last event (got ${JSON.stringify(wf2)})`);
        const wf3 = (out.couldNotResume as { runId: string; reason: string }[]).find((r) => r.runId === "run-wf-3");
        check(wf3 !== undefined && wf3.reason.includes("snapshot blob is missing"), `D-246d OK: the blob-missing run names the reason (got ${JSON.stringify(wf3?.reason)})`);
        const wf5 = (out.couldNotResume as { runId: string; reason: string }[]).find((r) => r.runId === "run-wf-5");
        check(wf5 !== undefined && wf5.reason.includes("double-execute"), "D-246d OK: the inconsistent run names the double-execute reason");
        const qaPayload = (out.deliveryPayloads as { target: string; message: string }[]).find((p) => p.target === QA_OWNER);
        check(qaPayload !== undefined && qaPayload.message.includes("run-wf-2") && qaPayload.message.includes("run-suite-1") && qaPayload.message.includes("run-wf-5"), "D-246d OK: the Quality payload names its resumed + could-not-resume runs");
        const pmPayload = (out.deliveryPayloads as { target: string; message: string }[]).find((p) => p.target === PM_OWNER);
        check(pmPayload !== undefined && pmPayload.message.includes("run-wf-4") && pmPayload.message.includes("run-wf-3") && pmPayload.message.includes("run-wf-6"), "D-246d OK: the PM payload names its resumed + could-not-resume + failed runs");
        const pid = spawnPidFromNotes(out.notes as string[]);
        if (pid !== null) killPid(pid);
      }
    }

    // ---- D-246e dry-run with a replacement → dry-run (nothing
    // written, nothing started, the classification computed).
    {
      const f = makeFixture({
        bootId: FAKE_OLD_BOOT_ID,
        queue: [{ runId: "run-wf-9", status: "running", owner: QA_OWNER }],
        journals: {
          "run-wf-9": journalFixture([{ event: "trap-dispatched", runId: "run-wf-9", wallTs: "2026-11-22T13:00:00Z" }]),
        },
        registry: { "run-wf-9": JSON.stringify({ runId: "run-wf-9", rc: 2 }) },
        blobs: ["run-wf-9"],
      });
      const out = driveRecovery("recovery-d246e", recoveryInput(f, { dryRun: true }));
      if (out) {
        check(out.verdict === "dry-run", `D-246e OK: verdict dry-run (got ${out.verdict})`);
        check(out.replacement === true && out.dryRun === true, `D-246e OK: a dry-run replacement (got ${out.replacement}/${out.dryRun})`);
        check(read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE))?.trim() === FAKE_OLD_BOOT_ID, "D-246e OK: the record is NOT updated on disk");
        check(!fs.existsSync(path.join(f.dir, VM_RECOVERY_UNIT_FILE)), "D-246e OK: the unit file is NOT written");
        check(out.server?.restarted === false, `D-246e OK: the server was NOT started (got ${out.server?.restarted})`);
        check(!(await healthOk(f.serverUrl)), "D-246e OK: /health is still down after the dry-run");
        check((out.resumed as { runId: string }[]).some((r) => r.runId === "run-wf-9"), "D-246e OK: the dry-run still computes the classification");
        check((out.deliveryPayloads as unknown[]).length === 0, "D-246e OK: no delivery payload for a dry-run");
      }
    }

    // ---- D-246f cancel: hand-crafted cancelled entry (the
    // bra210a case-H shape) → failed, cancelChecked +
    // cancelled true, nothing written.
    {
      const f = makeFixture({ bootId: FAKE_OLD_BOOT_ID });
      const cancelStateDir = path.join(WORKDIR, "cancel-state-246f");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(cancelStateDir, "queue.json"),
        JSON.stringify([{ runId: "recovery-d246f", status: "cancelled" }]),
      );
      const input = recoveryInput(f, { runId: "recovery-d246f" });
      input.project.stateDir = cancelStateDir;
      const out = driveRecovery("recovery-d246f", input);
      if (out) {
        check(out.verdict === "failed", `D-246f OK: verdict failed for the cancelled run (got ${out.verdict})`);
        check(out.cancelChecked === true && out.cancelled === true, `D-246f OK: cancelChecked true + cancelled true (got ${out.cancelChecked}/${out.cancelled})`);
        check((out.notes as string[]).some((n) => n.includes("is cancelled")), `D-246f OK: the refusal names the cancellation (got ${JSON.stringify(out.notes)})`);
        check(read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE))?.trim() === FAKE_OLD_BOOT_ID, "D-246f OK: the cancelled run writes no record");
        check(!fs.existsSync(path.join(f.dir, VM_RECOVERY_UNIT_FILE)), "D-246f OK: the cancelled run writes no unit file");
      }
    }

    // ---- D-246g validation, live: a run missing serverCommand
    // is refused with the field named.
    {
      const f = makeFixture({ bootId: FAKE_OLD_BOOT_ID });
      const input = recoveryInput(f);
      (input.run as Record<string, unknown>)["serverCommand"] = [];
      const out = driveRecovery("recovery-d246g", input);
      if (out) {
        check(out.verdict === "failed", `D-246g OK: verdict failed for the invalid run (got ${out.verdict})`);
        check((out.notes as string[]).some((n) => n.includes("run.serverCommand")), `D-246g OK: the refusal names run.serverCommand (got ${JSON.stringify(out.notes)})`);
        check(out.server?.restarted === false, `D-246g OK: nothing restarted (got ${out.server?.restarted})`);
      }
    }

    // ---- D-246h corrupt recorded boot id → failed, names the
    // corruption.
    {
      const f = makeFixture({ bootId: "garbage-not-a-boot-id" });
      const out = driveRecovery("recovery-d246h", recoveryInput(f));
      if (out) {
        check(out.verdict === "failed", `D-246h OK: verdict failed for the corrupt record (got ${out.verdict})`);
        check((out.notes as string[]).some((n) => n.includes("corrupt")), `D-246h OK: the refusal names the corruption (got ${JSON.stringify(out.notes)})`);
        check(out.server?.restarted === false, `D-246h OK: nothing restarted (got ${out.server?.restarted})`);
      }
    }

    // ---- D-246i trigger proof: the workflow is driven by the
    // exact CLI invocation the systemd unit would run
    // (--input-file + a boot-style run-id) and lands
    // established.
    {
      const f = makeFixture({});
      const input = recoveryInput(f);
      const bootShort = currentBootId().slice(0, 8);
      const runId = `run-bra246-boot-${bootShort}`;
      const inputFile = path.join(f.dir, VM_RECOVERY_INPUT_FILE);
      fs.writeFileSync(inputFile, JSON.stringify(input));
      track(runId);
      const sub = cli([
        "run", VM_RECOVERY,
        "--run-id", runId,
        "--input-file", inputFile,
        "--state-dir", STATE_DIR,
        "--adapter", "direct", "--clock", "real", "--gates", "hold",
      ]);
      check(sub.rc === 0 && sub.out.includes(`RUN ${runId}`), `D-246i OK: the unit's CLI invocation submits (rc ${sub.rc})`);
      driveQueue();
      const out = fetchResult(runId);
      if (out) {
        check(out.verdict === "established", `D-246i OK: the unit's invocation lands established (got ${out.verdict})`);
        check(read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE))?.trim() === currentBootId(), "D-246i OK: the record is written by the unit's invocation");
      }
    }

    // ---- D-246j suite continuation, live: run.sh --bash
    // --resume-dir skips the marked sections and starts the
    // next one.
    {
      const resumeDir = path.join(WORKDIR, "resume-d246j");
      fs.mkdirSync(path.join(resumeDir, ".done"), { recursive: true });
      fs.mkdirSync(path.join(resumeDir, "logs"), { recursive: true });
      const doneSlugs = firstTier1Slugs(3);
      for (const slug of doneSlugs) fs.writeFileSync(path.join(resumeDir, ".done", slug), "ok=10\n");
      const nextSlug = firstTier1Slugs(4)[3]!;
      const runLogPath = path.join(WORKDIR, "resume-d246j.log");
      const runLogFd = fs.openSync(runLogPath, "w");
      const proc = spawn(["/bin/bash", path.join(ROOT, "run.sh"), "--bash", "--resume-dir", resumeDir], {
        stdout: runLogFd,
        stderr: runLogFd,
        cwd: ROOT,
        env: { ...process.env, DQUICKTS: process.env.DQUICKTS ?? path.join(os.homedir(), "workspace", "dquickts-build-minimal") },
      });
      const deadline = Date.now() + 60_000;
      let sawSkips = false;
      let sawNextLog = false;
      while (Date.now() < deadline) {
        await sleep(500);
        const captured = read(runLogPath) ?? "";
        if (doneSlugs.every((s) => captured.includes(`SKIP ${s} (done,`))) sawSkips = true;
        if (fs.existsSync(path.join(resumeDir, "logs", nextSlug + ".log"))) sawNextLog = true;
        if (sawSkips && sawNextLog) break;
      }
      try { proc.kill(9); } catch { /* already dead */ }
      await proc.exited;
      fs.closeSync(runLogFd);
      const captured = read(runLogPath) ?? "";
      check(sawSkips, `D-246j OK: run.sh skips the marked sections (saw ${doneSlugs.map((s) => captured.includes(`SKIP ${s}`)).join(",")})`);
      check(sawNextLog, `D-246j OK: run.sh starts the next section (${nextSlug}) after the skips — its log file exists`);
    }

    // ---- D-246k replacement, server ALREADY UP → recovered,
    // verified only: restarted false, the same pid alive, no
    // restart log, the note names the already-up state
    // (decision 5 — do not restart a running server). The
    // systemd unit starts the server before running 246, so
    // on a real replacement the server is already up when
    // this workflow runs — spawning a second server would die
    // on the bind and the report would claim a restart that
    // never happened.
    {
      const f = makeFixture({ bootId: FAKE_OLD_BOOT_ID });
      const fixtureServer = spawn([BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", f.dir, "--port", String(f.port)], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env },
      });
      const fixturePid = fixtureServer.pid;
      try {
        const deadline = Date.now() + 10_000;
        for (;;) {
          if (await healthOk(f.serverUrl)) break;
          if (Date.now() > deadline) throw new Error("D-246k fixture server did not come up");
          await sleep(50);
        }
        check(fixturePid !== undefined && pidAlive(fixturePid), `D-246k OK: the fixture server pid is alive before the drive (got ${fixturePid})`);
        const out = driveRecovery("recovery-d246k", recoveryInput(f));
        if (out) {
          check(out.verdict === "recovered", `D-246k OK: verdict recovered (got ${out.verdict})`);
          check(out.replacement === true && out.oldBootId === FAKE_OLD_BOOT_ID, `D-246k OK: a replacement from the fake-old id (got ${out.oldBootId})`);
          check(out.server?.restarted === false, `D-246k OK: the server was NOT restarted (got ${out.server?.restarted})`);
          check(out.server?.verified === true, `D-246k OK: the server is verified up (got ${out.server?.verified})`);
          check(out.server?.healthBefore?.ok === true, "D-246k OK: healthBefore ok — the server was up before the run");
          check(out.server?.restartLogPath === undefined, `D-246k OK: no restart log path in the report (got ${out.server?.restartLogPath})`);
          check(fs.readdirSync(f.runsDir).filter((n) => n.startsWith("server-restart-")).length === 0, "D-246k OK: no restart log was written");
          check((out.notes as string[]).some((n) => n.includes("already up")), `D-246k OK: the notes name that the server was already up (got ${JSON.stringify(out.notes)})`);
          check(read(path.join(f.dir, VM_RECOVERY_BOOT_ID_FILE))?.trim() === currentBootId(), "D-246k OK: the record is still updated to the current boot id on disk");
          check(fixturePid !== undefined && pidAlive(fixturePid), `D-246k OK: the same server pid is still alive after the drive (got ${fixturePid})`);
          check(await healthOk(f.serverUrl), "D-246k OK: /health still answers ok:true after the recovery");
          check(spawnPidFromNotes(out.notes as string[]) === null, "D-246k OK: no spawn is named in the notes");
        }
      } finally {
        try { fixtureServer.kill(9); } catch { /* already dead */ }
        await fixtureServer.exited;
      }
    }
  } finally {
    await stopServer();
  }

  if (FAILURES.length > 0) {
    console.log(`\n${FAILURES.length} FAILURE(S)`);
    return 1;
  }
  console.log("\nALL OK");
  return 0;
}

const code = await main();
process.exit(code);
