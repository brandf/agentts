/**
 * test-bra245.ts — the server auto-restart workflow (BRA-245).
 *
 *   A. The inventory check passes (suite-inventory.json agrees
 *      with run.sh — the server-restart section is wired after
 *      bottleneck-detect).
 *   B. `agentts check` passes on server-restart.ts (first-run gate).
 *   C. Pure unit checks: validateServerRestartInput (every guard),
 *      healthPollScript + parseHealthPoll (run through sh: a dead
 *      port is unreachable, a live ok-server is ok, a live
 *      not-ok server is not-ok), classifyTick (fresh / stale
 *      with pending / stale with nothing pending / missing /
 *      unparsable), parseQueueEntries (valid, malformed skipped,
 *      non-array, unparsable), computePending (queued, held,
 *      stuck-running, finished-but-undelivered — the watchdog's
 *      shape), deliveredRunIdsScript + parseDeliveredRunIds
 *      (through sh), restartLogIndexScript + parseRestartLogIndex
 *      (through sh), restartSpawnScript + parseSpawnResult
 *      (through sh: a harmless command starts detached, the log
 *      exists), decideRestartTrigger (all four combinations),
 *      buildRestartDeliveryPayloads (Director on restart/fail,
 *      affected leads on restart, silence on verified-up).
 *   D. Live runs through the CLI on direct, each against a
 *      scratch fixture state dir + a scratch server on a random
 *      port — never the production state dir, never port 18741,
 *      never the real server. Every case asserts the report AND
 *      the on-disk outcome separately. The cases are driven by
 *      the exact CLI invocation the 15-minute cron would run
 *      (submit + queue run):
 *      D-245a server down → restarted (the server is spawned,
 *        the log file exists, /health answers ok:true after);
 *      D-245b server already up → verified-up (no restart, no
 *        new log, the same server pid is still alive);
 *      D-245c tick stale with pending work + server up →
 *        verified-up, trigger tick-stale (the server is NOT
 *        restarted — the already-up rule governs; the note
 *        names the watchdog cron for the tick agent itself,
 *        and the Director + affected lead are notified);
 *      D-245d tick dead with nothing pending + server up →
 *        no-restart-needed;
 *      D-245e dry-run with the server down → dry-run (no
 *        server started, no log, /health still down after);
 *      D-245f spawn failure (bad engine dir) → failed, the
 *        Director payload names the failure;
 *      D-245g spawn succeeds but the server never answers →
 *        not-verified (restarted, never reported as up);
 *      D-245h cancel (hand-crafted cancelled entry, the
 *        bra210a case-H shape) → failed, cancelChecked +
 *        cancelled true, nothing written;
 *      D-245i validation, live (a run missing serverUrl is
 *        refused with the field named).
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra245.ts
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
import restartServer, {
  validateServerRestartInput,
  healthPollScript,
  parseHealthPoll,
  classifyTick,
  parseQueueEntries,
  computePending,
  deliveredRunIdsScript,
  parseDeliveredRunIds,
  restartLogIndexScript,
  parseRestartLogIndex,
  restartSpawnScript,
  parseSpawnResult,
  decideRestartTrigger,
  groupPendingOwners,
  buildRestartDeliveryPayloads,
  SERVER_RESTART_KNOWN_LIMIT,
  SERVER_RESTART_VERIFY_ATTEMPTS,
  SERVER_RESTART_VERIFY_INTERVAL_MS,
  type ServerRestartInput,
  type ServerRestartProjectConfig,
  type ServerRestartRunInput,
  type HealthState,
  type TickState,
} from "../workflows/library/server-restart";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const SERVER_RESTART = path.join(ROOT, "workflows", "library", "server-restart.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA245_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "server-restart-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const STATE_DIR = path.join(WORKDIR, "state");
// Hermetic re-runs: the queue registry keeps run IDs forever, so a
// second run against the same state dir would fail every submit as
// "already queued". Wipe our own throwaway state dir at startup.
fs.rmSync(STATE_DIR, { recursive: true, force: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const PORT = 22000 + Math.floor(Math.random() * 8000);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
// Point this process's notifyEvent (and every CLI subprocess's) at
// the TEST server: the default port is the production server.
process.env.AGENTTS_WORKER_SERVER = SERVER_URL;

const BUN = "/opt/hatch-image/bin/bun";
/** The Implementation lead owns restart runs (brief: owner is the driving session). */
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
    if (Date.now() > deadline) throw new Error("server-restart test server did not come up");
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

/** Submit one server-restart run (no drive yet). */
function submitRestart(runId: string, input: ServerRestartInput): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", SERVER_RESTART,
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

/** Drive one server-restart input through the CLI (submit +
 * queue run + result) and return the parsed report, or null on
 * a CLI failure (the failure is already recorded as a check). */
function driveRestart(runId: string, input: ServerRestartInput): Record<string, any> | null {
  if (!submitRestart(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: scratch fixture state dirs + scratch servers.
// ------------------------------------------------------------------

interface Fixture {
  dir: string;
  runsDir: string;
  port: number;
  serverUrl: string;
}

let fixtureCounter = 0;
function makeFixture(opts: {
  tickAgeMs?: number | null;
  queue?: { runId: string; status: string; owner?: string }[];
  ledger?: string[];
  now?: string;
}): Fixture {
  fixtureCounter++;
  const dir = path.join(WORKDIR, `fixture-${fixtureCounter}`);
  const runsDir = path.join(WORKDIR, `fixture-${fixtureCounter}-runs`);
  fs.mkdirSync(path.join(dir, "tick"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ledger"), { recursive: true });
  fs.mkdirSync(path.join(dir, "deliveries"), { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  if (opts.tickAgeMs !== null && opts.tickAgeMs !== undefined) {
    fs.writeFileSync(
      path.join(dir, "tick", "state.json"),
      JSON.stringify({ lastTickAt: new Date(nowMs - opts.tickAgeMs).toISOString() }),
    );
  }
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(opts.queue ?? []));
  if (opts.ledger && opts.ledger.length > 0) {
    fs.writeFileSync(path.join(dir, "ledger", "run-ledger.jsonl"), opts.ledger.join("\n") + "\n");
  }
  const port = 23000 + Math.floor(Math.random() * 7000) + fixtureCounter;
  return { dir, runsDir, port, serverUrl: `http://127.0.0.1:${port}` };
}

function testProject(workDir: string): ServerRestartProjectConfig {
  return {
    linearProject: "AgentTS",
    repo: COPY_ROOT,
    stateDir: STATE_DIR,
    roster: { [QA_OWNER]: "quality", [PM_OWNER]: "program-management", [IMPL_OWNER]: "implementation" },
    workDir,
    resumeDir: path.join(workDir, "resume"),
  };
}

function restartInput(f: Fixture, extra: Partial<ServerRestartRunInput> = {}): ServerRestartInput {
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
function validInput(): ServerRestartInput {
  const f = makeFixture({});
  return restartInput(f);
}

/** Start a fixture server directly (the test's own spawn, for
 * the already-up cases) and wait for /health. Returns the
 * subprocess. */
async function startFixtureServer(f: Fixture): Promise<Subprocess> {
  const proc = spawn(
    [BUN, path.join(ROOT, "src", "worker-server.ts"), "--state-dir", f.dir, "--port", String(f.port)],
    { stdout: "ignore", stderr: "ignore", env: { ...process.env } },
  );
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${f.serverUrl}/health`);
      if (res.ok) return proc;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`fixture server did not come up on ${f.port}`);
    await sleep(50);
  }
}

async function stopFixtureServer(proc: Subprocess): Promise<void> {
  try {
    proc.kill(9);
  } catch { /* already dead */ }
  await proc.exited;
}

/** Kill a server by pid (the pid the workflow's spawn reported
 * in its notes). Returns true when the pid is gone. */
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

// ------------------------------------------------------------------
// §A inventory, §B check, §C pure units, §D live CLI runs.
// ------------------------------------------------------------------

const OK_SERVER_PY = [
  "import json, sys",
  "from http.server import BaseHTTPRequestHandler, HTTPServer",
  "mode = sys.argv[2]",
  "class H(BaseHTTPRequestHandler):",
  "    def do_GET(self):",
  "        if self.path == '/health':",
  "            body = b'{\"ok\":true, \"service\": \"agentts-worker-queue\"}' if mode == 'ok' else b'{\"ok\":false, \"service\": \"agentts-worker-queue\"}'",
  "            self.send_response(200)",
  "            self.send_header('Content-Type', 'application/json')",
  "            self.send_header('Content-Length', str(len(body)))",
  "            self.end_headers()",
  "            self.wfile.write(body)",
  "        else:",
  "            self.send_response(404)",
  "            self.end_headers()",
  "    def log_message(self, *a):",
  "        pass",
  "HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()",
].join("\n");

async function main(): Promise<number> {
  // --------------------------------------------- §A inventory
  console.log("=== §A inventory ===");
  {
    const inv = readJson(path.join(ROOT, "suite-inventory.json")) as { sections: { slug: string; tier: number }[] } | null;
    const runSh = read(path.join(ROOT, "run.sh")) ?? "";
    const slugs = (inv?.sections ?? []).filter((s) => s.tier === 1).map((s) => s.slug);
    check(inv !== null && slugs.includes("server-restart"), "A OK: suite-inventory.json has a tier-1 server-restart section");
    const idx = slugs.indexOf("server-restart");
    const bottleneckIdx = slugs.indexOf("bottleneck-detect");
    check(idx === bottleneckIdx + 1, `A OK: server-restart follows bottleneck-detect in tier-1 order (got ${bottleneckIdx} -> ${idx})`);
    check(runSh.includes('"server-restart"') || runSh.includes("server-restart"), "A OK: run.sh wires the server-restart section");
  }

  // --------------------------------------------- §B agentts check
  console.log("\n=== §B agentts check ===");
  {
    const r = cli(["check", SERVER_RESTART, "--state-dir", STATE_DIR]);
    check(r.rc === 0 && r.out.includes("CHECK OK"), `B OK: agentts check passes on server-restart.ts (rc ${r.rc}: ${(r.out + r.err).slice(0, 300)})`);
  }

  // --------------------------------------------- §C pure units
  console.log("\n=== §C pure units ===");
  {
    // validateServerRestartInput: every guard.
    const base = validInput();
    check(validateServerRestartInput(base).length === 0, "C OK: the valid input validates");
    check(validateServerRestartInput(null as unknown as ServerRestartInput).includes("input is not an object"), "C OK: non-object input refused");
    const noOwner = { ...base, owner: "" };
    check(validateServerRestartInput(noOwner).some((e) => e.includes("owner is required")), "C OK: missing owner refused");
    const noUrl = structuredClone(base);
    (noUrl.run as Record<string, unknown>)["serverUrl"] = "";
    check(validateServerRestartInput(noUrl).some((e) => e.includes("run.serverUrl")), "C OK: missing serverUrl refused");
    const noState = structuredClone(base);
    (noState.run as Record<string, unknown>)["stateDir"] = "";
    check(validateServerRestartInput(noState).some((e) => e.includes("run.stateDir")), "C OK: missing stateDir refused");
    const noEngine = structuredClone(base);
    (noEngine.run as Record<string, unknown>)["engineDir"] = "";
    check(validateServerRestartInput(noEngine).some((e) => e.includes("run.engineDir")), "C OK: missing engineDir refused");
    const noCmd = structuredClone(base);
    (noCmd.run as Record<string, unknown>)["serverCommand"] = [];
    check(validateServerRestartInput(noCmd).some((e) => e.includes("run.serverCommand")), "C OK: empty serverCommand refused");
    const badCmd = structuredClone(base);
    (badCmd.run as Record<string, unknown>)["serverCommand"] = ["/bin/true", ""];
    check(validateServerRestartInput(badCmd).some((e) => e.includes("run.serverCommand")), "C OK: empty serverCommand entry refused");
    const noRuns = structuredClone(base);
    (noRuns.run as Record<string, unknown>)["runsDir"] = "";
    check(validateServerRestartInput(noRuns).some((e) => e.includes("run.runsDir")), "C OK: missing runsDir refused");
    const badStale = structuredClone(base);
    (badStale.run as Record<string, unknown>)["staleMinutes"] = 0;
    check(validateServerRestartInput(badStale).some((e) => e.includes("run.staleMinutes")), "C OK: non-positive staleMinutes refused");
    const badVerify = structuredClone(base);
    (badVerify.run as Record<string, unknown>)["verifyAttempts"] = 0;
    check(validateServerRestartInput(badVerify).some((e) => e.includes("run.verifyAttempts")), "C OK: verifyAttempts < 1 refused");
    const badNow = structuredClone(base);
    (badNow.run as Record<string, unknown>)["now"] = "not-a-date";
    check(validateServerRestartInput(badNow).some((e) => e.includes("run.now")), "C OK: non-date now refused");
    const noProject = structuredClone(base);
    (noProject as Record<string, unknown>)["project"] = null;
    check(validateServerRestartInput(noProject).some((e) => e.includes("project is not an object")), "C OK: missing project refused");

    // healthPollScript + parseHealthPoll, run through sh.
    const deadPort = 24000 + Math.floor(Math.random() * 5000);
    const dead = sh(healthPollScript(`http://127.0.0.1:${deadPort}`, 1, 0));
    const deadParsed = parseHealthPoll(dead.out);
    check(dead.rc === 1 && deadParsed.state.ok === false && deadParsed.state.detail === "unreachable" && deadParsed.attemptsSpent === 1, `C OK: a dead port polls unreachable (rc ${dead.rc}, ${JSON.stringify(deadParsed.state)})`);
    // A live ok-server and a live not-ok server (python, on
    // random ports, killed after).
    const okPy = path.join(WORKDIR, "ok-server.py");
    fs.writeFileSync(okPy, OK_SERVER_PY);
    const okPort = 25000 + Math.floor(Math.random() * 4000);
    const notOkPort = okPort + 1;
    const okProc = spawn(["python3", okPy, String(okPort), "ok"], { stdout: "ignore", stderr: "ignore" });
    const notOkProc = spawn(["python3", okPy, String(notOkPort), "not-ok"], { stdout: "ignore", stderr: "ignore" });
    try {
      await sleep(500);
      const okRun = sh(healthPollScript(`http://127.0.0.1:${okPort}`, 1, 0));
      const okParsed = parseHealthPoll(okRun.out);
      check(okRun.rc === 0 && okParsed.state.ok === true && okParsed.state.detail === "ok", `C OK: a live ok-server polls ok (rc ${okRun.rc}, ${JSON.stringify(okParsed.state)})`);
      const notOkRun = sh(healthPollScript(`http://127.0.0.1:${notOkPort}`, 2, 100));
      const notOkParsed = parseHealthPoll(notOkRun.out);
      check(notOkRun.rc === 1 && notOkParsed.state.ok === false && notOkParsed.state.detail === "not-ok" && notOkParsed.attemptsSpent === 2, `C OK: a live not-ok server polls not-ok after both attempts (rc ${notOkRun.rc}, ${JSON.stringify(notOkParsed.state)})`);
      check(parseHealthPoll("garbage\n").state.detail === "unreachable" && parseHealthPoll("garbage\n").attemptsSpent === 0, "C OK: unparsable poll output is unreachable with 0 attempts");
    } finally {
      try { okProc.kill(9); } catch { /* already dead */ }
      try { notOkProc.kill(9); } catch { /* already dead */ }
      await okProc.exited;
      await notOkProc.exited;
    }

    // classifyTick: fresh / stale+pending / stale+none / missing / unparsable.
    const nowMs = Date.parse("2026-11-22T14:00:00Z");
    const fresh = classifyTick({ tickStateText: JSON.stringify({ lastTickAt: "2026-11-22T13:55:00Z" }), tickStateMissingReason: null, pendingCount: 3, staleMinutes: 15, nowMs });
    check(fresh.tick.alive === true && fresh.tick.needsRestart === false && fresh.tick.ageMs === 300_000, `C OK: a 5-minute-old tick is alive (ageMs ${fresh.tick.ageMs})`);
    const stalePending = classifyTick({ tickStateText: JSON.stringify({ lastTickAt: "2026-11-22T13:30:00Z" }), tickStateMissingReason: null, pendingCount: 2, staleMinutes: 15, nowMs });
    check(stalePending.tick.alive === false && stalePending.tick.needsRestart === true, "C OK: a 30-minute-old tick with pending work needs a restart");
    const staleNone = classifyTick({ tickStateText: JSON.stringify({ lastTickAt: "2026-11-22T13:30:00Z" }), tickStateMissingReason: null, pendingCount: 0, staleMinutes: 15, nowMs });
    check(staleNone.tick.alive === false && staleNone.tick.needsRestart === false, "C OK: a stale tick with nothing pending needs no restart");
    const missingTick = classifyTick({ tickStateText: null, tickStateMissingReason: "no tick/state.json", pendingCount: 1, staleMinutes: 15, nowMs });
    check(missingTick.tick.lastTickAt === null && missingTick.tick.alive === false && missingTick.tick.needsRestart === true && (missingTick.note ?? "").includes("never ticked"), `C OK: a missing tick state is never-ticked with the reason named (got ${JSON.stringify(missingTick.note)})`);
    const badTick = classifyTick({ tickStateText: "{not json", tickStateMissingReason: null, pendingCount: 0, staleMinutes: 15, nowMs });
    check(badTick.tick.lastTickAt === null && (badTick.note ?? "").includes("unparsable"), "C OK: an unparsable tick state is never-ticked with the reason named");

    // parseQueueEntries: valid, malformed skipped, non-array, unparsable.
    const q = parseQueueEntries(JSON.stringify([{ runId: "a", status: "queued", owner: QA_OWNER }, { runId: "b", status: "running" }, { status: "queued" }, "junk"]));
    check(q.entries.length === 2 && q.skipped === 2 && q.entries[0].owner === QA_OWNER && q.entries[1].owner === null, `C OK: queue entries parse with malformed ones skipped (got ${q.entries.length} + ${q.skipped})`);
    check(parseQueueEntries("{}").skipped === 1 && parseQueueEntries("{bad").skipped === 1, "C OK: a non-array / unparsable queue is one skip");

    // computePending: the watchdog's shape.
    const pending = computePending({
      queueEntries: [
        { runId: "q1", status: "queued" },
        { runId: "h1", status: "held" },
        { runId: "r1", status: "running" },
        { runId: "r2", status: "running" },
        { runId: "d1", status: "done" },
        { runId: "d2", status: "done" },
        { runId: "f1", status: "failed" },
      ],
      ledgerTerminalRunIds: new Set(["r2", "d1"]),
      deliveredRunIds: new Set(["d1"]),
    });
    check(
      pending.pendingCount === 5 && pending.pendingRunIds.join(",") === "d2,f1,h1,q1,r1",
      `C OK: pending = queued + held + stuck-running + finished-undelivered (got ${JSON.stringify(pending.pendingRunIds)})`,
    );

    // deliveredRunIdsScript + parseDeliveredRunIds, through sh.
    const delDir = path.join(WORKDIR, "deliveries-case");
    fs.mkdirSync(path.join(delDir, "deliveries"), { recursive: true });
    fs.writeFileSync(path.join(delDir, "deliveries", "a.json"), JSON.stringify({ runId: "run-a" }));
    fs.writeFileSync(path.join(delDir, "deliveries", "b.json"), JSON.stringify({ runId: "run-b" }));
    fs.writeFileSync(path.join(delDir, "deliveries", "junk.json"), "{not json");
    fs.writeFileSync(path.join(delDir, "deliveries", "notes.txt"), "not json");
    const delRun = sh(deliveredRunIdsScript(delDir, 500));
    const delParsed = parseDeliveredRunIds(delRun.out);
    check(delParsed.ids.size === 2 && delParsed.ids.has("run-a") && delParsed.ids.has("run-b") && delParsed.truncated === false, `C OK: the deliveries scan names both runIds and skips junk (got ${[...delParsed.ids].join(",")})`);
    const delMissing = parseDeliveredRunIds(sh(deliveredRunIdsScript(path.join(WORKDIR, "no-such-dir"), 500)).out);
    check(delMissing.ids.size === 0, "C OK: a missing deliveries dir scans to zero ids");

    // restartLogIndexScript + parseRestartLogIndex, through sh.
    const logDir = path.join(WORKDIR, "log-index-case");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "server-restart-1.log"), "");
    fs.writeFileSync(path.join(logDir, "server-restart-3.log"), "");
    fs.writeFileSync(path.join(logDir, "other.log"), "");
    check(parseRestartLogIndex(sh(restartLogIndexScript(logDir)).out) === 3, "C OK: the log index is the max N (3)");
    check(parseRestartLogIndex(sh(restartLogIndexScript(path.join(WORKDIR, "no-logs"))).out) === 0, "C OK: a missing runs dir indexes 0");

    // restartSpawnScript + parseSpawnResult, through sh: a
    // harmless command starts detached and the log exists.
    const spawnDir = path.join(WORKDIR, "spawn-case");
    fs.mkdirSync(spawnDir, { recursive: true });
    const spawnLog = path.join(spawnDir, "server-restart-1.log");
    const spawnRun = sh(restartSpawnScript({ engineDir: ROOT, serverCommand: ["/usr/bin/true"], stateDir: spawnDir, runsDir: spawnDir, logPath: spawnLog }));
    const spawnParsed = parseSpawnResult(spawnRun.out, spawnRun.rc);
    check(spawnParsed.started === true && spawnParsed.pid !== null, `C OK: the spawn trap starts detached (got ${JSON.stringify(spawnParsed)})`);
    check(fs.existsSync(spawnLog), "C OK: the spawn log file exists on disk");
    const badSpawn = parseSpawnResult("", 1);
    check(badSpawn.started === false && badSpawn.pid === null, "C OK: a non-zero spawn exit is not started");

    // decideRestartTrigger: all four combinations.
    const upHealth: HealthState = { reachable: true, ok: true, detail: "ok" };
    const downHealth: HealthState = { reachable: false, ok: false, detail: "unreachable" };
    const liveTick: TickState = { alive: true, lastTickAt: "2026-11-22T13:59:00Z", ageMs: 60_000, staleMinutes: 15, pendingCount: 0, needsRestart: false };
    const staleTick: TickState = { alive: false, lastTickAt: "2026-11-22T13:00:00Z", ageMs: 3_600_000, staleMinutes: 15, pendingCount: 2, needsRestart: true };
    check(decideRestartTrigger({ health: downHealth, tick: liveTick }) === "health-down", "C OK: down health is health-down even with a live tick");
    check(decideRestartTrigger({ health: upHealth, tick: staleTick }) === "tick-stale", "C OK: up health + stale tick with pending is tick-stale");
    check(decideRestartTrigger({ health: upHealth, tick: liveTick }) === "none", "C OK: up health + live tick is no trigger");
    const staleNoPending: TickState = { ...staleTick, pendingCount: 0, needsRestart: false };
    check(decideRestartTrigger({ health: upHealth, tick: staleNoPending }) === "none", "C OK: up health + stale tick with nothing pending is no trigger");

    // buildRestartDeliveryPayloads: Director on restart/fail,
    // affected leads on restart, silence on verified-up.
    const payloadsRestarted = buildRestartDeliveryPayloads({
      verdict: "restarted",
      trigger: "health-down",
      restartId: "restart-1",
      serverUrl: "http://127.0.0.1:18741",
      healthBefore: downHealth,
      healthAfter: upHealth,
      pendingRunIds: ["run-a", "run-b"],
      pendingOwners: new Map([[QA_OWNER, ["run-a"]], [PM_OWNER, ["run-b"]]]),
      ownerRoster: { [QA_OWNER]: "quality", [PM_OWNER]: "program-management" },
      restartLogPath: "/tmp/server-restart-1.log",
    });
    check(payloadsRestarted.length === 3 && payloadsRestarted[0].target === "director" && payloadsRestarted.some((p) => p.target === QA_OWNER) && payloadsRestarted.some((p) => p.target === PM_OWNER), `C OK: a restart names the Director + both affected leads (got ${payloadsRestarted.map((p) => p.target).join(",")})`);
    const payloadsFailed = buildRestartDeliveryPayloads({
      verdict: "failed",
      trigger: "health-down",
      restartId: "restart-2",
      serverUrl: "http://127.0.0.1:18741",
      healthBefore: downHealth,
      healthAfter: downHealth,
      pendingRunIds: ["run-a"],
      pendingOwners: new Map([[QA_OWNER, ["run-a"]]]),
      ownerRoster: { [QA_OWNER]: "quality" },
    });
    check(payloadsFailed.length === 1 && payloadsFailed[0].target === "director" && payloadsFailed[0].message.includes("failed"), "C OK: a failed restart names only the Director");
    const payloadsQuiet = buildRestartDeliveryPayloads({
      verdict: "verified-up",
      trigger: "none",
      restartId: "restart-3",
      serverUrl: "http://127.0.0.1:18741",
      healthBefore: upHealth,
      healthAfter: upHealth,
      pendingRunIds: [],
      pendingOwners: new Map(),
      ownerRoster: {},
    });
    check(payloadsQuiet.length === 0, "C OK: a verified-up check with no trigger emits no payload");
    const payloadsStale = buildRestartDeliveryPayloads({
      verdict: "verified-up",
      trigger: "tick-stale",
      restartId: "restart-4",
      serverUrl: "http://127.0.0.1:18741",
      healthBefore: upHealth,
      healthAfter: upHealth,
      pendingRunIds: ["run-a"],
      pendingOwners: new Map([[QA_OWNER, ["run-a"]]]),
      ownerRoster: { [QA_OWNER]: "quality" },
    });
    check(payloadsStale.length === 2 && payloadsStale[0].target === "director" && payloadsStale[0].message.includes("tick is stale") && payloadsStale.some((p) => p.target === QA_OWNER), `C OK: a tick-stale verified-up names the Director + the affected lead (got ${payloadsStale.map((p) => p.target).join(",")})`);
    const grouped = groupPendingOwners(
      [
        { runId: "a", status: "queued", owner: QA_OWNER },
        { runId: "b", status: "queued", owner: null },
        { runId: "c", status: "queued", owner: QA_OWNER },
      ],
      ["a", "c"],
    );
    check(grouped.size === 1 && (grouped.get(QA_OWNER) ?? []).join(",") === "a,c", "C OK: pending owners group by owner, ownerless runs skipped");
    check(SERVER_RESTART_KNOWN_LIMIT.includes("never by this workflow") && SERVER_RESTART_KNOWN_LIMIT.includes("not-verified, never as up"), "C OK: the known-limit string carries the v0 limits verbatim");
    check(SERVER_RESTART_VERIFY_ATTEMPTS === 30 && SERVER_RESTART_VERIFY_INTERVAL_MS === 1000, "C OK: the verify budget is 30 attempts x 1000ms");
  }

  // --------------------------------------------- §D live CLI runs
  console.log("\n=== §D live CLI runs ===");
  await startServer();
  try {
    // ---- D-245a server down → restarted (spawned, logged,
    // verified; /health answers after).
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const out = driveRestart("restart-d245a", restartInput(f));
      if (out) {
        check(out.verdict === "restarted", `D-245a OK: verdict restarted (got ${out.verdict})`);
        check(out.trigger === "health-down", `D-245a OK: trigger health-down (got ${out.trigger})`);
        check(out.restarted === true && out.verified === true, `D-245a OK: restarted + verified (got ${out.restarted}/${out.verified})`);
        check(out.healthAfter?.ok === true, `D-245a OK: healthAfter ok (got ${JSON.stringify(out.healthAfter)})`);
        check(out.restartAttempts === 1, `D-245a OK: one restart attempt (got ${out.restartAttempts})`);
        check(typeof out.restartLogPath === "string" && fs.existsSync(out.restartLogPath), `D-245a OK: the restart log exists on disk (got ${out.restartLogPath})`);
        check(await healthOk(f.serverUrl), "D-245a OK: /health answers ok:true after the restart");
        check((out.deliveryPayloads as { target: string }[]).some((p) => p.target === "director"), "D-245a OK: the Director payload is present");
        check((out.notes as string[]).some((n) => n.includes("server spawned (pid")), "D-245a OK: the notes name the spawned pid");
        const pid = spawnPidFromNotes(out.notes as string[]);
        check(pid !== null && pidAlive(pid), `D-245a OK: the spawned server pid is alive (got ${pid})`);
        if (pid !== null) killPid(pid);
        await sleep(200);
        check(!(await healthOk(f.serverUrl)), "D-245a OK: /health is down again after killing the spawned server (the restart was real)");
      }
    }

    // ---- D-245b server already up → verified-up (no restart,
    // no new log, the same pid is still alive).
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const proc = await startFixtureServer(f);
      try {
        const pidBefore = proc.pid;
        const out = driveRestart("restart-d245b", restartInput(f));
        if (out) {
          check(out.verdict === "verified-up", `D-245b OK: verdict verified-up (got ${out.verdict})`);
          check(out.trigger === "none", `D-245b OK: trigger none (got ${out.trigger})`);
          check(out.restarted === false && out.restartAttempts === 0, `D-245b OK: nothing restarted (got ${out.restarted}/${out.restartAttempts})`);
          check(out.restartLogPath === undefined, `D-245b OK: no restart log path (got ${out.restartLogPath})`);
          check(fs.readdirSync(f.runsDir).filter((n) => n.startsWith("server-restart-")).length === 0, "D-245b OK: no restart log file was written");
          check((out.deliveryPayloads as unknown[]).length === 0, "D-245b OK: no delivery payload for a routine verified-up");
          check(pidBefore !== undefined && pidAlive(pidBefore), `D-245b OK: the same server pid is still alive (got ${pidBefore})`);
          check(await healthOk(f.serverUrl), "D-245b OK: /health still answers ok:true");
        }
      } finally {
        await stopFixtureServer(proc);
      }
    }

    // ---- D-245c tick stale with pending work + server up →
    // verified-up, trigger tick-stale (no restart — the
    // already-up rule governs; the watchdog cron owns the tick
    // agent; the Director + affected lead are notified).
    {
      const f = makeFixture({
        tickAgeMs: 30 * 60_000,
        queue: [{ runId: "lead-run-1", status: "queued", owner: QA_OWNER }],
      });
      const proc = await startFixtureServer(f);
      try {
        const pidBefore = proc.pid;
        const out = driveRestart("restart-d245c", restartInput(f));
        if (out) {
          check(out.verdict === "verified-up", `D-245c OK: verdict verified-up (got ${out.verdict})`);
          check(out.trigger === "tick-stale", `D-245c OK: trigger tick-stale (got ${out.trigger})`);
          check(out.restarted === false, `D-245c OK: the running server was NOT restarted (got ${out.restarted})`);
          check(out.tick?.needsRestart === true && out.tick?.pendingCount === 1, `D-245c OK: the tick needs a restart with 1 pending run (got ${JSON.stringify(out.tick)})`);
          check((out.notes as string[]).some((n) => n.includes("watchdog cron")), "D-245c OK: the notes name the watchdog cron for the tick agent");
          check((out.notes as string[]).some((n) => n.includes("NOT restarted")), "D-245c OK: the notes say the server was not restarted");
          const targets = (out.deliveryPayloads as { target: string }[]).map((p) => p.target);
          check(targets.includes("director") && targets.includes(QA_OWNER), `D-245c OK: the Director + affected lead are notified (got ${targets.join(",")})`);
          check(fs.readdirSync(f.runsDir).filter((n) => n.startsWith("server-restart-")).length === 0, "D-245c OK: no restart log file was written");
          check(pidBefore !== undefined && pidAlive(pidBefore), `D-245c OK: the same server pid is still alive (got ${pidBefore})`);
        }
      } finally {
        await stopFixtureServer(proc);
      }
    }

    // ---- D-245d tick dead with nothing pending + server up →
    // no-restart-needed.
    {
      const f = makeFixture({ tickAgeMs: 30 * 60_000, queue: [] });
      const proc = await startFixtureServer(f);
      try {
        const out = driveRestart("restart-d245d", restartInput(f));
        if (out) {
          check(out.verdict === "no-restart-needed", `D-245d OK: verdict no-restart-needed (got ${out.verdict})`);
          check(out.restarted === false, `D-245d OK: nothing restarted (got ${out.restarted})`);
          check((out.notes as string[]).some((n) => n.includes("nothing pending")), "D-245d OK: the notes name the empty pending set");
          check((out.deliveryPayloads as unknown[]).length === 0, "D-245d OK: no delivery payload");
        }
      } finally {
        await stopFixtureServer(proc);
      }
    }

    // ---- D-245e dry-run with the server down → dry-run (no
    // server started, no log, /health still down after).
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const out = driveRestart("restart-d245e", restartInput(f, { dryRun: true }));
      if (out) {
        check(out.verdict === "dry-run", `D-245e OK: verdict dry-run (got ${out.verdict})`);
        check(out.dryRun === true && out.restarted === false, `D-245e OK: dry-run, nothing restarted (got ${out.dryRun}/${out.restarted})`);
        check(fs.readdirSync(f.runsDir).filter((n) => n.startsWith("server-restart-")).length === 0, "D-245e OK: no restart log file was written");
        check(!(await healthOk(f.serverUrl)), "D-245e OK: /health is still down after the dry-run");
      }
    }

    // ---- D-245f spawn failure (bad engine dir) → failed, the
    // Director payload names the failure.
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const out = driveRestart("restart-d245f", restartInput(f, { engineDir: "/nonexistent/engine-dir" }));
      if (out) {
        check(out.verdict === "failed", `D-245f OK: verdict failed (got ${out.verdict})`);
        check(out.restarted === false && out.restartAttempts === 1, `D-245f OK: one failed attempt, nothing restarted (got ${out.restarted}/${out.restartAttempts})`);
        check((out.notes as string[]).some((n) => n.includes("spawn failed")), `D-245f OK: the notes name the spawn failure (got ${JSON.stringify(out.notes)})`);
        const director = (out.deliveryPayloads as { target: string; message: string }[]).find((p) => p.target === "director");
        check(director !== undefined && director.message.includes("failed"), "D-245f OK: the Director payload names the failure");
      }
    }

    // ---- D-245g spawn succeeds but the server never answers →
    // not-verified (restarted, never reported as up).
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const input = restartInput(f, {
        serverCommand: ["/usr/bin/true"],
        verifyAttempts: 3,
        verifyIntervalMs: 100,
      });
      const out = driveRestart("restart-d245g", input);
      if (out) {
        check(out.verdict === "not-verified", `D-245g OK: verdict not-verified (got ${out.verdict})`);
        check(out.restarted === true && out.verified === false, `D-245g OK: restarted but not verified (got ${out.restarted}/${out.verified})`);
        check(out.healthAfter?.ok === false, `D-245g OK: healthAfter is not ok (got ${JSON.stringify(out.healthAfter)})`);
        check((out.notes as string[]).some((n) => n.includes("NOT verified up")), "D-245g OK: the notes say the server is NOT verified up");
        check(typeof out.restartLogPath === "string" && fs.existsSync(out.restartLogPath), "D-245g OK: the restart log exists on disk");
        check(!(await healthOk(f.serverUrl)), "D-245g OK: /health is still down (nothing is serving)");
      }
    }

    // ---- D-245h cancel: hand-crafted cancelled entry (the
    // bra210a case-H shape) → failed, cancelChecked +
    // cancelled true, nothing written.
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const cancelStateDir = path.join(WORKDIR, "cancel-state-245h");
      fs.mkdirSync(cancelStateDir, { recursive: true });
      fs.writeFileSync(
        path.join(cancelStateDir, "queue.json"),
        JSON.stringify([{ runId: "restart-d245h", status: "cancelled" }]),
      );
      const input = restartInput(f, { runId: "restart-d245h" });
      input.project.stateDir = cancelStateDir;
      const out = driveRestart("restart-d245h", input);
      if (out) {
        check(out.verdict === "failed", `D-245h OK: verdict failed for the cancelled run (got ${out.verdict})`);
        check(out.cancelChecked === true && out.cancelled === true, `D-245h OK: cancelChecked true + cancelled true (got ${out.cancelChecked}/${out.cancelled})`);
        check((out.notes as string[]).some((n) => n.includes("is cancelled")), `D-245h OK: the refusal names the cancellation (got ${JSON.stringify(out.notes)})`);
        check(fs.readdirSync(f.runsDir).filter((n) => n.startsWith("server-restart-")).length === 0, "D-245h OK: the cancelled run writes no restart log");
      }
    }

    // ---- D-245i validation, live: a run missing serverUrl is
    // refused with the field named.
    {
      const f = makeFixture({ tickAgeMs: 60_000, queue: [] });
      const input = restartInput(f);
      (input.run as Record<string, unknown>)["serverUrl"] = "";
      const out = driveRestart("restart-d245i", input);
      if (out) {
        check(out.verdict === "failed", `D-245i OK: verdict failed for the invalid run (got ${out.verdict})`);
        check((out.notes as string[]).some((n) => n.includes("run.serverUrl")), `D-245i OK: the refusal names run.serverUrl (got ${JSON.stringify(out.notes)})`);
        check(out.restarted === false, `D-245i OK: nothing restarted (got ${out.restarted})`);
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
