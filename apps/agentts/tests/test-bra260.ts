// test-bra260 — the push manifest + push workflow (BRA-260).
//
//   A. The inventory check passes (suite-inventory.json agrees
//      with run.sh on the push section).
//   B. `agentts check` passes on push.ts (first-run gate).
//   C. Pure unit checks: validatePushInput (every guard),
//      validatePushAuthorization, queue-entry parse/validate,
//      merge-report file lists, ls-tree / ls-remote / hash /
//      copy / refs / gh-contents parsers, manifest build
//      (to-push vs already-on-dev), delivery payloads, report
//      assembly, script builders.
//   D. Live CLI runs on `direct` against scratch trees + a
//      scratch remote (a local bare repo as the "origin" fixture)
//      — never the real origin, never the dev branch, never a
//      real push in a test:
//      D-260a landed change pushed (manifest rebuilt, files
//        verified against origin, pushed, verified via the refs
//        route, reported with the commit);
//      D-260b a file that doesn't match origin refuses loudly
//        and nothing is pushed;
//      D-260c a push the API can't confirm is reported
//        not-verified, never as landed;
//      D-260d an already-landed push reports already-pushed
//        (the interrupted-push check — no second commit);
//      D-260e a held push reports the hold and stops;
//      D-260f a dry-run writes nothing and pushes nothing;
//      D-260g a blocked queue entry refuses with the failure
//        named;
//      D-260h a real push without an authorization refuses
//        before the push step.
//   Every passing check prints a line containing " OK:" — run.sh
//   counts those lines for the tier-1 OK total, so every check
//   must print exactly one such line. A failing check prints
//   "FAIL: ..." (no " OK:"), so it is not counted.
//   Every §D case asserts the report AND the on-disk outcome
//   separately. All writes go to scratch dirs, never the real
//   goal files, never live, never the production state dir, never
//   the real origin.
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PUSH_KNOWN_LIMIT,
  validatePushInput,
  validatePushAuthorization,
  queueEntryReadScript,
  parseQueueEntryOutput,
  validateQueueEntry,
  parseMergeReportFiles,
  checkoutValidateScript,
  parseCheckoutValidation,
  gitFetchScript,
  devTipScript,
  devTreeScript,
  parseLsTreeOutput,
  parseLsRemoteOutput,
  hashFilesScript,
  parseHashLines,
  buildManifestEntries,
  buildPushManifest,
  copyAndVerifyScript,
  parseCopiedLines,
  commitScript,
  pushScript,
  lsRemoteScript,
  refsVerifyScript,
  parseRefBlobLines,
  ghContentsScript,
  curlContentsScript,
  parseGhContentsOutput,
  buildPushDeliveryPayloads,
  buildPushReport,
  type PushInput,
  type PushManifest,
  type PushReport,
  type PushVerification,
  type MergeAuthorization,
} from "../workflows/library/push";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const COPY_ROOT = path.resolve(ROOT, "..", "..");
const PUSH = path.join(ROOT, "workflows", "library", "push.ts");
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA260_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "push-"));
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
/** The Landing lead owns push runs (brief: owner is the driving session). */
const LBR_OWNER = "a25045a8-6678-417c-bcae-d1248594384a";
const IMPL_OWNER = "3e85493f-f748-4bcd-bec6-94be9c25b282";
const DIRECTOR = "director";

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
    if (Date.now() > deadline) throw new Error("push test server did not come up");
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

/** Submit one push run (no drive yet). */
function submitPush(runId: string, input: PushInput): boolean {
  track(runId);
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", PUSH,
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

/** Drive one push input through the CLI (submit + queue run +
 * result) and return the parsed report, or null on a CLI failure
 * (the failure is already recorded as a check). */
function drivePush(runId: string, input: PushInput): Record<string, any> | null {
  if (!submitPush(runId, input)) return null;
  driveQueue();
  return fetchResult(runId);
}

// ------------------------------------------------------------------
// Fixtures: a local bare repo as the "origin", a fixture checkout,
// a fixture live tree, a fixture queue file, a fixture merge
// report. Never the real origin, never the dev branch, never a
// real push in a test.
// ------------------------------------------------------------------

const AUTH: MergeAuthorization = {
  authorizer: "LBR",
  authorizedAt: "2026-11-23T11:00:00Z",
  channel: "test fixture",
  verificationSummary: "fixture",
  expectedNewBaseline: "68 sections / 4,960 OK",
};

interface PushFixture {
  dir: string;
  bare: string;
  checkout: string;
  liveRoot: string;
  queuePath: string;
  mergeReportPath: string;
  initialTip: string;
}

function git(args: string, cwd?: string): { rc: number; out: string } {
  const r = sh((cwd ? `cd ${JSON.stringify(cwd)} && ` : "") + `git ${args}`);
  if (r.rc !== 0) throw new Error(`fixture git ${args} failed (rc ${r.rc}): ${(r.out + r.err).slice(0, 300)}`);
  return { rc: r.rc, out: r.out };
}

function makeFixture(name: string): PushFixture {
  const dir = path.join(WORKDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const bare = path.join(dir, "origin.git");
  const checkout = path.join(dir, "checkout");
  const liveRoot = path.join(dir, "live");
  fs.mkdirSync(liveRoot, { recursive: true });
  // The bare "origin": dev starts with b.txt (v1) + old.txt.
  git(`init --bare ${JSON.stringify(bare)}`);
  git(`init ${JSON.stringify(checkout)}`);
  git(`remote add origin ${JSON.stringify(bare)}`, checkout);
  fs.writeFileSync(path.join(checkout, "b.txt"), "b v1\n");
  fs.writeFileSync(path.join(checkout, "old.txt"), "old\n");
  git(`add -A`, checkout);
  git(`-c user.name=Fixture -c user.email=fixture@localhost commit -m "initial dev"`, checkout);
  git(`branch -M dev`, checkout);
  git(`push origin dev`, checkout);
  const initialTip = git(`rev-parse refs/heads/dev`, bare).out.trim();
  // The live tree: a.txt is new (to-push), b.txt matches dev
  // (already-on-dev).
  fs.writeFileSync(path.join(liveRoot, "a.txt"), "a new\n");
  fs.writeFileSync(path.join(liveRoot, "b.txt"), "b v1\n");
  // The queue file: one ready entry with the authorization.
  const queuePath = path.join(dir, "land-queue.json");
  fs.writeFileSync(queuePath, JSON.stringify({
    items: [{
      issue: "BRA-260-FIXTURE",
      title: "fixture push",
      copies: ["fixture-copy"],
      order: 1,
      status: "ready",
      authorization: AUTH,
    }],
  }));
  // The merge report: a.txt applied, b.txt alreadyApplied.
  const mergeReportPath = path.join(dir, "merge-report.json");
  fs.writeFileSync(mergeReportPath, JSON.stringify({
    verdict: "merged",
    planned: [],
    applied: ["a.txt"],
    alreadyApplied: ["b.txt"],
  }));
  return { dir, bare, checkout, liveRoot, queuePath, mergeReportPath, initialTip };
}

function devTip(bare: string): string {
  return git(`--git-dir=${JSON.stringify(bare)} rev-parse refs/heads/dev`).out.trim();
}

function devFile(bare: string, file: string): string | null {
  const r = sh(`git --git-dir=${JSON.stringify(bare)} show dev:${JSON.stringify(file)} 2>/dev/null`);
  return r.rc === 0 ? r.out : null;
}

function validInput(f: PushFixture, overrides: Record<string, any> = {}): PushInput {
  const input: PushInput = {
    project: {
      linearProject: "P-BRA-2",
      repo: "brandf/agentts",
      stateDir: STATE_DIR,
      roster: { landing: LBR_OWNER, director: DIRECTOR, implementation: IMPL_OWNER },
      workDir: path.join(f.dir, "work"),
      resumeDir: path.join(f.dir, "resume"),
    },
    run: {
      pushId: "BRA-260",
      queuePath: f.queuePath,
      queueIssue: "BRA-260-FIXTURE",
      mergeReportPath: f.mergeReportPath,
      liveRoot: f.liveRoot,
      checkoutPath: f.checkout,
      branch: "dev",
      workDir: path.join(f.dir, "work"),
      verifyViaRefs: true,
      remoteUrl: f.bare,
      authorization: AUTH,
    },
    owner: LBR_OWNER,
    launchedBy: "test",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (k.startsWith("project.")) (input.project as Record<string, any>)[k.slice("project.".length)] = v;
    else if (k.startsWith("run.")) (input.run as Record<string, any>)[k.slice("run.".length)] = v;
    else (input as Record<string, any>)[k] = v;
  }
  return input;
}

async function main(): Promise<number> {
  // --------------------------------------------- §A inventory
  console.log("=== §A inventory ===");
  {
    const inv = readJson(path.join(ROOT, "suite-inventory.json")) as { sections: { slug: string; file: string; tier: number }[] } | null;
    const runSh = read(path.join(ROOT, "run.sh")) ?? "";
    const slugs = (inv?.sections ?? []).filter((s) => s.tier === 1).map((s) => s.slug);
    check(inv !== null && slugs.includes("push"), "A OK: suite-inventory.json has a tier-1 push section");
    check(inv !== null && slugs.includes("dual-report"), "A OK: suite-inventory.json has a tier-1 dual-report section");
    const pushEntry = (inv?.sections ?? []).find((s) => s.slug === "push");
    check(pushEntry?.file === "tests/test-bra260.ts", `A OK: push section names tests/test-bra260.ts (got ${pushEntry?.file})`);
    const dualEntry = (inv?.sections ?? []).find((s) => s.slug === "dual-report");
    check(dualEntry?.file === "tests/test-bra256.ts", `A OK: dual-report section names tests/test-bra256.ts (got ${dualEntry?.file})`);
    check(runSh.includes("section push 1"), "A OK: run.sh wires the push section");
    check(runSh.includes("section dual-report 1"), "A OK: run.sh wires the dual-report section");
    check(runSh.includes("BRA260_WORKDIR"), "A OK: run.sh passes BRA260_WORKDIR to test-bra260.ts");
    check(runSh.includes("BRA256_WORKDIR"), "A OK: run.sh passes BRA256_WORKDIR to test-bra256.ts");
  }

  // --------------------------------------------- §B agentts check
  console.log("\n=== §B agentts check ===");
  {
    const r = cli(["check", PUSH, "--state-dir", STATE_DIR]);
    check(r.rc === 0 && r.out.includes("CHECK OK"), `B OK: agentts check passes on push.ts (rc ${r.rc}: ${(r.out + r.err).slice(0, 300)})`);
  }

  // --------------------------------------------- §C pure units
  console.log("\n=== §C pure units ===");
  {
    // validatePushInput: every guard.
    const base = validInput(makeFixture("c-fixture"));
    check(validatePushInput(base).length === 0, "C OK: the valid input validates");
    check(validatePushInput(null as unknown as PushInput).includes("push: input is not an object"), "C OK: non-object input refused");
    const noRun = structuredClone(base) as Record<string, unknown>;
    delete noRun.run;
    check(validatePushInput(noRun as unknown as PushInput).some((e) => e.includes("run is not an object")), "C OK: missing run refused");
    const noOwner = { ...base, owner: "" };
    check(validatePushInput(noOwner).some((e) => e.includes("owner must be a non-empty string")), "C OK: missing owner refused");
    for (const field of ["pushId", "queuePath", "queueIssue", "mergeReportPath", "liveRoot", "checkoutPath", "workDir"]) {
      const bad = structuredClone(base);
      (bad.run as Record<string, unknown>)[field] = "";
      check(validatePushInput(bad).some((e) => e.includes(`run.${field}`)), `C OK: missing run.${field} refused`);
    }
    const badHold = structuredClone(base);
    (badHold.run as Record<string, unknown>).holdPush = "yes";
    check(validatePushInput(badHold).some((e) => e.includes("run.holdPush")), "C OK: non-boolean holdPush refused");
    const badAuth = structuredClone(base);
    (badAuth.run as Record<string, unknown>).authorization = { authorizer: "" };
    check(validatePushInput(badAuth).some((e) => e.includes("authorization.authorizer")), "C OK: malformed authorization refused");

    // validatePushAuthorization.
    check(validatePushAuthorization(AUTH).length === 0, "C OK: the valid authorization validates");
    check(validatePushAuthorization({ ...AUTH, authorizer: "" }).some((e) => e.includes("authorizer")), "C OK: empty authorizer refused");
    check(validatePushAuthorization({ ...AUTH, authorizedAt: "" }).some((e) => e.includes("authorizedAt")), "C OK: empty authorizedAt refused");
    check(validatePushAuthorization({ ...AUTH, channel: 7 }).some((e) => e.includes("channel")), "C OK: non-string channel refused");
    check(validatePushAuthorization({ ...AUTH, note: 7 }).some((e) => e.includes("note")), "C OK: non-string note refused");
    check(validatePushAuthorization("nope").includes("push: authorization is not an object"), "C OK: non-object authorization refused");

    // Queue-entry parse/validate.
    const entryJson = JSON.stringify({ issue: "BRA-260-FIXTURE", title: "t", copies: ["c"], order: 1, status: "ready" });
    check(parseQueueEntryOutput("ENTRY " + entryJson + "\n")?.issue === "BRA-260-FIXTURE", "C OK: the ENTRY line parses to the entry");
    check(parseQueueEntryOutput("ENTRY-MISSING BRA-260-FIXTURE\n") === null, "C OK: ENTRY-MISSING parses to null");
    try {
      parseQueueEntryOutput("ENTRY-ERROR queue file not found: /x\n");
      fail("C OK: ENTRY-ERROR throws");
    } catch {
      ok("C OK: ENTRY-ERROR throws");
    }
    try {
      parseQueueEntryOutput("garbage\n");
      fail("C OK: a garbage queue output throws");
    } catch {
      ok("C OK: a garbage queue output throws");
    }
    check(validateQueueEntry({ issue: "BRA-1", status: "ready", copies: ["c"] }).length === 0, "C OK: the valid queue entry validates");
    check(validateQueueEntry({ issue: "", status: "ready" }).some((e) => e.includes("issue")), "C OK: empty entry issue refused");
    check(validateQueueEntry({ issue: "BRA-1", status: 3 }).some((e) => e.includes("status")), "C OK: non-string entry status refused");
    check(validateQueueEntry({ issue: "BRA-1", status: "ready", copies: "c" }).some((e) => e.includes("copies")), "C OK: non-array entry copies refused");
    check(queueEntryReadScript("/q/land-queue.json", "BRA-1").includes("BRA-1"), "C OK: the queue-entry script names the issue");
    check(queueEntryReadScript("/q/land-queue.json", "BRA-1").includes("/q/land-queue.json"), "C OK: the queue-entry script names the queue path");

    // Merge-report file lists.
    check(JSON.stringify(parseMergeReportFiles(JSON.stringify({ applied: ["a.txt"], alreadyApplied: ["b.txt", "a.txt"] }))) === JSON.stringify(["a.txt", "b.txt"]), "C OK: applied + alreadyApplied dedupe in report order");
    check(parseMergeReportFiles(JSON.stringify({ applied: [] })).length === 0, "C OK: an empty applied list parses to no files");
    try {
      parseMergeReportFiles("{not json");
      fail("C OK: a malformed merge report throws");
    } catch {
      ok("C OK: a malformed merge report throws");
    }
    try {
      parseMergeReportFiles(JSON.stringify({ applied: "a.txt" }));
      fail("C OK: a non-array applied list throws");
    } catch {
      ok("C OK: a non-array applied list throws");
    }

    // ls-tree / ls-remote parsers.
    check(JSON.stringify(parseLsTreeOutput("100644 blob abcdef0123456789abcdef0123456789abcdef01\ta.txt\n100644 blob 0123456789abcdef0123456789abcdef01234567\tb.txt\n")) === JSON.stringify({ "a.txt": "abcdef0123456789abcdef0123456789abcdef01", "b.txt": "0123456789abcdef0123456789abcdef01234567" }), "C OK: ls-tree output parses to the path -> blob map");
    check(JSON.stringify(parseLsTreeOutput("")) === JSON.stringify({}), "C OK: empty ls-tree output parses to an empty map");
    check(parseLsRemoteOutput("deadbeef0123456789abcdef0123456789abcdef01\trefs/heads/dev\n", "dev") === "deadbeef0123456789abcdef0123456789abcdef01", "C OK: ls-remote output parses to the tip sha");
    check(parseLsRemoteOutput("", "dev") === null, "C OK: empty ls-remote output parses to a null tip");
    check(parseLsRemoteOutput("deadbeef0123456789abcdef0123456789abcdef01\trefs/heads/main\n", "dev") === null, "C OK: ls-remote for another branch parses to a null tip");
    check(devTreeScript("/c", "dev", ["a.txt", "b.txt"]).includes("a.txt") && devTreeScript("/c", "dev", ["a.txt"]).includes("ls-tree -r"), "C OK: the dev-tree script carries pathspecs for the manifest files");

    // Hash / copy / refs parsers.
    const sha = "a".repeat(64);
    const blob = "b".repeat(40);
    check(parseHashLines(`HASH a.txt ${sha} ${blob}\n`)["a.txt"]?.sha256 === sha, "C OK: the HASH line parses to the sha256 + blob sha");
    try {
      parseHashLines("HASH-MISSING gone.txt\n");
      fail("C OK: HASH-MISSING throws naming the file");
    } catch (e) {
      check((e as Error).message.includes("gone.txt"), "C OK: HASH-MISSING throws naming the file");
    }
    try {
      parseHashLines("HASH a.txt nope\n");
      fail("C OK: a malformed HASH line throws");
    } catch {
      ok("C OK: a malformed HASH line throws");
    }
    check(parseCopiedLines(`COPIED a.txt ${sha} ${blob}\n`)["a.txt"]?.blobSha === blob, "C OK: the COPIED line parses to the blob sha");
    check(parseRefBlobLines(`REFBLOB a.txt ${blob}\n`)["a.txt"] === blob, "C OK: the REFBLOB line parses to the blob sha");
    try {
      parseRefBlobLines("REFBLOB-MISSING gone.txt\n");
      fail("C OK: REFBLOB-MISSING throws naming the file");
    } catch (e) {
      check((e as Error).message.includes("gone.txt"), "C OK: REFBLOB-MISSING throws naming the file");
    }
    check(parseGhContentsOutput(JSON.stringify({ sha: blob, path: "a.txt" })) === blob, "C OK: the contents API response parses to the blob sha");
    check(parseGhContentsOutput(JSON.stringify({ message: "Not Found" })) === null, "C OK: an error payload parses to a null sha");
    check(parseGhContentsOutput("not json") === null, "C OK: malformed API output parses to a null sha");
    check(ghContentsScript("brandf", "agentts", "a.txt", "dev").includes("repos/brandf/agentts/contents/a.txt?ref=dev"), "C OK: the gh script names the contents endpoint");
    check(curlContentsScript("brandf", "agentts", "a.txt", "dev").includes("api.github.com/repos/brandf/agentts/contents/a.txt"), "C OK: the curl script names the contents endpoint");
    check(curlContentsScript("brandf", "agentts", "a.txt", "dev").includes("GH_TOKEN"), "C OK: the curl script reads the token from the environment");
    check(commitScript("/c", ["a.txt"], "msg", { name: "N", email: "e@x" }).includes("user.name"), "C OK: the commit script sets the author");
    check(pushScript("/c", "dev").includes("push origin"), "C OK: the push script pushes to origin");
    check(checkoutValidateScript("/c", "/w/tmp").includes("/w/tmp"), "C OK: the checkout script uses the workDir temp dir, not /tmp");

    // Manifest build: to-push vs already-on-dev.
    const liveHashes = { "a.txt": { sha256: sha, blobSha: blob }, "b.txt": { sha256: sha, blobSha: "c".repeat(40) } };
    const entries = buildManifestEntries(["a.txt", "b.txt"], liveHashes, { "b.txt": "c".repeat(40) });
    check(entries[0].status === "to-push" && entries[1].status === "already-on-dev", "C OK: a file matching dev is already-on-dev, a changed file is to-push");
    try {
      buildManifestEntries(["gone.txt"], liveHashes, {});
      fail("C OK: a file with no live hash throws");
    } catch {
      ok("C OK: a file with no live hash throws");
    }
    const manifest: PushManifest = buildPushManifest({ pushId: "BRA-260", queueIssue: "BRA-260-FIXTURE", copies: ["fixture-copy"], order: 1, devTip: "d".repeat(40), builtAt: "2026-11-23T11:00:00Z", entries });
    check(manifest.copies[0] === "fixture-copy" && manifest.order === 1, "C OK: the manifest records the queue entry's copies + order");
    check(manifest.entries.length === 2, "C OK: the manifest carries the entries");
    check(parseCheckoutValidation("WORKTREE true\nORIGIN https://github.com/brandf/agentts.git\nBRANCH dev\n").branch === "dev", "C OK: the checkout validation parses the branch");
    try {
      parseCheckoutValidation("WORKTREE true\n");
      fail("C OK: a checkout validation missing a line throws");
    } catch {
      ok("C OK: a checkout validation missing a line throws");
    }

    // Delivery payloads + report assembly.
    const verification: PushVerification = { route: "refs", confirmed: true, tipConfirmed: true, filesConfirmed: 2, filesTotal: 2, perFile: [{ path: "a.txt", confirmed: true }] };
    const payloads = buildPushDeliveryPayloads({ pushId: "BRA-260", queueIssue: "BRA-260-FIXTURE", verdict: "pushed", commit: "d".repeat(40), verification, landingTarget: LBR_OWNER });
    check(payloads.length === 2 && payloads[0].target === LBR_OWNER && payloads[1].target === "director", "C OK: the payloads go to Landing + the Director");
    check(payloads[0].message.includes("pushed") && payloads[0].message.includes("BRA-260-FIXTURE"), "C OK: the payload message names the verdict + the issue");
    const report: PushReport = buildPushReport({
      pushId: "BRA-260", verdict: "pushed", dryRun: false, owner: LBR_OWNER, cancelChecked: true, cancelled: false,
      queueIssue: "BRA-260-FIXTURE", manifestPath: "/w/push-manifest.json", manifest, commit: "d".repeat(40),
      verification, authorization: AUTH, deliveryPayloads: payloads, notes: [],
    });
    check(report.verdict === "pushed" && report.knownLimit === PUSH_KNOWN_LIMIT, "C OK: the report assembles with the verdict + the known limit");
    check(report.authorization?.authorizer === "LBR", "C OK: the report carries the authorization verbatim");
  }

  // --------------------------------------------- §D live CLI runs
  console.log("\n=== §D live CLI runs ===");
  await startServer();
  try {
    // ---- D-260a landed change pushed (manifest rebuilt, files
    // verified against origin, pushed, verified via the refs
    // route, reported with the commit).
    const fa = makeFixture("d-260a");
    {
      const out = drivePush("push-d260a", validInput(fa));
      if (out) {
        check(out.verdict === "pushed", `D-260a OK: verdict pushed (got ${out.verdict})`);
        check(out.queueIssue === "BRA-260-FIXTURE", `D-260a OK: the queue issue is named (got ${out.queueIssue})`);
        check(typeof out.commit === "string" && /^[0-9a-f]{40}$/.test(out.commit), `D-260a OK: the commit sha is reported (got ${out.commit})`);
        check(out.commit !== fa.initialTip, "D-260a OK: the push created a new commit on dev");
        check(out.manifest?.devTip === fa.initialTip, `D-260a OK: the manifest was built against the pre-push dev tip (got ${out.manifest?.devTip})`);
        check(out.manifest?.copies?.[0] === "fixture-copy" && out.manifest?.order === 1, "D-260a OK: the manifest records the queue entry's copies + order");
        const byPath = Object.fromEntries((out.manifest?.entries as { path: string; status: string }[]).map((e) => [e.path, e.status]));
        check(byPath["a.txt"] === "to-push" && byPath["b.txt"] === "already-on-dev", `D-260a OK: a.txt to-push, b.txt already-on-dev (got ${JSON.stringify(byPath)})`);
        check(out.verification?.route === "refs" && out.verification?.confirmed === true, `D-260a OK: verification via refs confirmed (got ${JSON.stringify(out.verification?.route)})`);
        check(out.verification?.tipConfirmed === true && out.verification?.filesConfirmed === 2, "D-260a OK: the tip + both files confirmed");
        check(JSON.stringify(out.authorization) === JSON.stringify(AUTH), "D-260a OK: the authorization is carried verbatim");
        const targets = (out.deliveryPayloads as { target: string }[]).map((p) => p.target);
        check(targets.includes(LBR_OWNER) && targets.includes("director"), `D-260a OK: the payloads go to Landing + the Director (got ${targets.join(",")})`);
        check((out.notes as string[]).length === 0 || !(out.notes as string[]).some((n) => n.includes("FAIL")), "D-260a OK: no failure note");
        // On-disk outcome, separately from the report.
        check(devTip(fa.bare) === out.commit, "D-260a OK: the bare repo's dev tip is the reported commit");
        check(devFile(fa.bare, "a.txt") === "a new\n", "D-260a OK: dev has a.txt with the landed content");
        check(devFile(fa.bare, "b.txt") === "b v1\n", "D-260a OK: dev still has b.txt unchanged");
        const manifestOnDisk = readJson(out.manifestPath as string);
        check(manifestOnDisk?.pushId === "BRA-260" && manifestOnDisk?.entries?.length === 2, "D-260a OK: the manifest file exists on disk with both entries");
      }
    }

    // ---- D-260b a file that doesn't match origin refuses loudly
    // and nothing is pushed (the merge report names a file absent
    // from the live tree).
    const fb = makeFixture("d-260b");
    {
      const badReport = path.join(fb.dir, "merge-report-bad.json");
      fs.writeFileSync(badReport, JSON.stringify({ verdict: "merged", applied: ["a.txt", "missing.txt"], alreadyApplied: ["b.txt"] }));
      const out = drivePush("push-d260b", validInput(fb, { "run.mergeReportPath": badReport }));
      if (out) {
        check(out.verdict === "failed", `D-260b OK: verdict failed (got ${out.verdict})`);
        check(JSON.stringify(out.notes).includes("missing.txt"), `D-260b OK: the refusal names the missing file (got ${JSON.stringify(out.notes)})`);
        check(devTip(fb.bare) === fb.initialTip, "D-260b OK: nothing was pushed (the dev tip is unchanged)");
        check(devFile(fb.bare, "a.txt") === null, "D-260b OK: a.txt never landed on dev");
      }
    }

    // ---- D-260c a push the API can't confirm is reported
    // not-verified, never as landed (the github-api route against
    // a repo that doesn't exist: gh is not authed, curl 404s).
    const fc = makeFixture("d-260c");
    {
      const out = drivePush("push-d260c", validInput(fc, { "run.verifyViaRefs": false, "project.repo": "fixture-owner/fixture-repo" }));
      if (out) {
        check(out.verdict === "not-verified", `D-260c OK: verdict not-verified (got ${out.verdict})`);
        check(out.verification?.route === "github-api" && out.verification?.confirmed === false, `D-260c OK: the github-api verification did not confirm (got ${JSON.stringify(out.verification)})`);
        check(devTip(fc.bare) === out.commit, "D-260c OK: the push DID land on the remote — only the confirmation failed");
        check(devFile(fc.bare, "a.txt") === "a new\n", "D-260c OK: dev has a.txt with the landed content");
      }
    }

    // ---- D-260d an already-landed push reports already-pushed
    // (the interrupted-push check — no second commit).
    {
      const out = drivePush("push-d260d", validInput(fa));
      if (out) {
        check(out.verdict === "already-pushed", `D-260d OK: verdict already-pushed (got ${out.verdict})`);
        check(out.commit === devTip(fa.bare), "D-260d OK: the commit is the current dev tip");
        check(devTip(fa.bare) !== fa.initialTip, "D-260d OK: the dev tip is still the D-260a commit (no second commit)");
        const byPath = Object.fromEntries((out.manifest?.entries as { path: string; status: string }[]).map((e) => [e.path, e.status]));
        check(byPath["a.txt"] === "already-on-dev" && byPath["b.txt"] === "already-on-dev", `D-260d OK: both files already-on-dev on the second run (got ${JSON.stringify(byPath)})`);
      }
    }

    // ---- D-260e a held push reports the hold and stops.
    const fe = makeFixture("d-260e");
    {
      const out = drivePush("push-d260e", validInput(fe, { "run.holdPush": true }));
      if (out) {
        check(out.verdict === "held", `D-260e OK: verdict held (got ${out.verdict})`);
        check(JSON.stringify(out.notes).includes("held"), `D-260e OK: the report names the hold (got ${JSON.stringify(out.notes)})`);
        check(out.manifestPath === undefined, "D-260e OK: no manifest was written for a held push");
        check(devTip(fe.bare) === fe.initialTip, "D-260e OK: nothing was pushed (the dev tip is unchanged)");
      }
    }

    // ---- D-260f a dry-run writes nothing and pushes nothing.
    const ff = makeFixture("d-260f");
    {
      const out = drivePush("push-d260f", validInput(ff, { "run.dryRun": true }));
      if (out) {
        check(out.verdict === "dry-run", `D-260f OK: verdict dry-run (got ${out.verdict})`);
        check((out.deliveryPayloads as unknown[]).length === 0, "D-260f OK: no delivery payloads on a dry-run");
        check(!fs.existsSync(path.join(ff.dir, "work", "push-manifest.json")), "D-260f OK: no manifest file was written");
        check(devTip(ff.bare) === ff.initialTip, "D-260f OK: nothing was pushed (the dev tip is unchanged)");
      }
    }

    // ---- D-260g a blocked queue entry refuses with the failure
    // named.
    const fg = makeFixture("d-260g");
    {
      const blockedQueue = path.join(fg.dir, "land-queue-blocked.json");
      fs.writeFileSync(blockedQueue, JSON.stringify({
        items: [{
          issue: "BRA-260-FIXTURE", title: "fixture push", copies: ["fixture-copy"], order: 1,
          status: "blocked", notes: "the merge failed: rebase conflict on merge.ts", authorization: AUTH,
        }],
      }));
      const out = drivePush("push-d260g", validInput(fg, { "run.queuePath": blockedQueue }));
      if (out) {
        check(out.verdict === "failed", `D-260g OK: verdict failed (got ${out.verdict})`);
        check(JSON.stringify(out.notes).includes("rebase conflict on merge.ts"), `D-260g OK: the refusal names the failure (got ${JSON.stringify(out.notes)})`);
        check(devTip(fg.bare) === fg.initialTip, "D-260g OK: nothing was pushed (the dev tip is unchanged)");
      }
    }

    // ---- D-260h a real push without an authorization refuses
    // before the push step.
    const fh = makeFixture("d-260h");
    {
      const noAuthQueue = path.join(fh.dir, "land-queue-noauth.json");
      fs.writeFileSync(noAuthQueue, JSON.stringify({
        items: [{ issue: "BRA-260-FIXTURE", title: "fixture push", copies: ["fixture-copy"], order: 1, status: "ready" }],
      }));
      const input = validInput(fh, { "run.queuePath": noAuthQueue });
      delete (input.run as Record<string, unknown>).authorization;
      const out = drivePush("push-d260h", input);
      if (out) {
        check(out.verdict === "failed", `D-260h OK: verdict failed (got ${out.verdict})`);
        check(JSON.stringify(out.notes).includes("no landing authorization"), `D-260h OK: the refusal names the missing authorization (got ${JSON.stringify(out.notes)})`);
        check(devTip(fh.bare) === fh.initialTip, "D-260h OK: nothing was pushed (the dev tip is unchanged)");
      }
    }
  } finally {
    await stopServer();
  }

  console.log("\n=== summary ===");
  if (FAILURES.length > 0) {
    console.log(`FAIL test-bra260 (${FAILURES.length} failures)`);
    return 1;
  }
  console.log("PASS test-bra260");
  return 0;
}

const code = await main();
process.exit(code);
