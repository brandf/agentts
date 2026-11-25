// test-bra262 — rebase workflow suite (BRA-262).
//
// The rebase brings a copy onto the latest tree before merging —
// never writes live, never merges.
//
// §A inventory check: workflows/library/rebase.ts registered in
//     suite-inventory.json (slug "rebase", tier 1), and run.sh
//     carries a section for it.
// §B `agentts check`: rebaseCopy(RebaseInput): RebaseReport, a
//     clean workflow with no errors, no unused imports, no
//     unknown job() types, no trap-cap violations.
// §C pure units: validateRebaseInput (null run, missing copyRoot,
//     bad dryRun type, missing owner — all refused loudly; a
//     valid input passes); classifyRebaseChanges (clean apply,
//     conflict, already-applied, delete); sparseMaps; parse-
//     RebasedOutput (valid line parses, garbage throws);
//     rebaseManifestScript shape (python heredoc, the manifest
//     exclusion, no Buffer); buildRebaseReport (verdicts,
//     conflicts named in notes, knownLimit verbatim).
// §D live CLI runs on `direct` against scratch trees (a throwaway
//     worker server on a random port, never production port
//     18741): D-262a clean rebase (new manifest against current
//     live, copy's changes intact, live untouched); D-262b
//     conflicting rebase refusal (files named, manifest
//     byte-identical); D-262c dry-run writes nothing; D-262d
//     already-current (manifest already matches live) writes
//     nothing; D-262e cancel; D-262f idempotent re-run;
//     D-262g already-applied. Every §D case asserts the report
//     AND the on-disk outcome separately. All writes to scratch
//     dirs, never live.
//
// No mock server here: the §D cases drive the real workflow
// through the real worker server on a random port — the rebase
// reads and writes scratch trees only, so no external service
// is involved.
//
// Run: `bun tests/test-bra262.ts` (BRA262_WORKDIR env or
// /tmp/bra262). Needs DQUICKTS=$HOME/workspace/dquickts-build-minimal
// for the C host build.

import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { RebaseInput, RebaseReport, RebaseConflict } from "../workflows/library/rebase";
import {
  validateRebaseInput,
  classifyRebaseChanges,
  sparseMaps,
  parseRebasedOutput,
  rebaseManifestScript,
  buildRebaseReport,
  REBASE_KNOWN_LIMIT,
} from "../workflows/library/rebase";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const REBASE = path.join(ROOT, "workflows", "library", "rebase.ts");
const BUN = "/opt/hatch-image/bin/bun";
const HOME_TMP = path.join(os.homedir(), "tmp", "home-tmp");
fs.mkdirSync(HOME_TMP, { recursive: true });
const WORKDIR = process.env.BRA262_WORKDIR || fs.mkdtempSync(path.join(HOME_TMP, "rebase-"));
fs.mkdirSync(WORKDIR, { recursive: true });
fs.mkdirSync(path.join(WORKDIR, "tmp"), { recursive: true });
if (!process.env.TMPDIR) process.env.TMPDIR = path.join(WORKDIR, "tmp");
const tmpDir = path.join(WORKDIR, "tmp");
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

const FAILURES: string[] = [];
function check(cond: boolean, label: string) {
  console.log((cond ? " OK: " : "FAIL: ") + label);
  if (!cond) FAILURES.push(label);
}

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = prefix ? prefix + "/" + name : name;
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out[rel] = sha256(fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

/** Write a scratch tree: dir with the given path -> content map. */
function writeTree(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

/** Write the copy manifest for a base tree: {copiedAt, root,
 * files: hashes of the base contents}. The copy's files on disk
 * are the caller's responsibility. */
function writeManifest(copyRoot: string, baseFiles: Record<string, string>, copiedAt = "2026-11-22T07:00:00.000000+00:00"): void {
  const files: Record<string, string> = {};
  for (const [rel, content] of Object.entries(baseFiles)) files[rel] = sha256(content);
  fs.writeFileSync(
    path.join(copyRoot, ".agentts-copy-manifest.json"),
    JSON.stringify({ copiedAt, root: copyRoot, files }, null, 1) + "\n",
  );
}

/** Build a three-tree fixture: base (the manifest's base), copy
 * (base + the copy's changes), live (base + live's changes).
 * Returns {copyRoot, liveRoot, manifestPath}. */
function threeTreeFixture(dir: string, args: {
  base: Record<string, string>;
  copy: Record<string, string>;
  live: Record<string, string>;
}): { copyRoot: string; liveRoot: string; manifestPath: string } {
  const copyRoot = path.join(dir, "copy");
  const liveRoot = path.join(dir, "live");
  writeTree(copyRoot, args.copy);
  writeTree(liveRoot, args.live);
  writeManifest(copyRoot, args.base);
  return { copyRoot, liveRoot, manifestPath: path.join(copyRoot, ".agentts-copy-manifest.json") };
}

function testProject(stateDir: string, workDir: string): RebaseInput["project"] {
  return {
    linearProject: "BRA",
    repo: "/tmp/bra262-repo",
    stateDir,
    workDir,
    resumeDir: path.join(workDir, "resume"),
  };
}

function caseInput(copyRoot: string, liveRoot: string, workDir: string, extra?: Partial<RebaseInput["run"]>): RebaseInput {
  return {
    project: testProject(path.join(workDir, "state"), workDir),
    run: {
      rebaseId: "BRA-262",
      copyRoot,
      liveRoot,
      workDir,
      resumeDir: path.join(workDir, "resume"),
      ...(extra ?? {}),
    },
    owner: "test-session",
    launchedBy: "test-session",
  };
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
    if (Date.now() > deadline) throw new Error("rebase server did not come up");
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

function submitRebase(runId: string, input: RebaseInput): boolean {
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", REBASE,
    "--run-id", runId,
    "--input-file", inputFile,
    "--state-dir", STATE_DIR,
    "--adapter", "direct", "--clock", "real", "--gates", "hold",
  ]);
  check(sub.rc === 0, `SUBMIT OK: CLI run exits 0 for ${runId} (got ${sub.rc}: ${(sub.out + sub.err).slice(0, 200)})`);
  check(sub.out.includes(`RUN ${runId}`), `SUBMIT OK: submit prints RUN ${runId} (got ${JSON.stringify(sub.out.slice(0, 120))})`);
  return sub.rc === 0;
}

/** Drive one queue pass and return its rc (0 = clean, 1 = some
 * entry failed — the per-run signal is the run's own result,
 * not the exit code). */
function driveRebase(): number {
  const drive = cli(["queue", "run", "--state-dir", STATE_DIR, "--clock", "real", "--gates", "hold"]);
  if (drive.rc !== 0 && drive.rc !== 1) {
    check(false, `DRIVE OK: queue run exits ${drive.rc} (expected 0 or 1): ${(drive.out + drive.err).slice(0, 300)}`);
  }
  return drive.rc;
}

function fetchResult(runId: string): RebaseReport | null {
  const res = cli(["result", runId, "--state-dir", STATE_DIR]);
  check(res.rc === 0, `RESULT OK: result exits 0 for ${runId} (got ${res.rc}: ${(res.out + res.err).slice(0, 300)})`);
  if (res.rc !== 0) return null;
  try {
    return JSON.parse(res.out) as RebaseReport;
  } catch {
    check(false, `RESULT OK: result for ${runId} is not JSON (got ${JSON.stringify(res.out.slice(0, 200))})`);
    return null;
  }
}

function driveRebaseRun(runId: string, input: RebaseInput): RebaseReport | null {
  if (!submitRebase(runId, input)) return null;
  driveRebase();
  return fetchResult(runId);
}

async function main(): Promise<number> {
  // --------------------------------------------- §A inventory check
  console.log("=== §A inventory check ===");
  {
    const inventoryPath = path.resolve(import.meta.dir, "../suite-inventory.json");
    const inventory = JSON.parse(read(inventoryPath)) as { sections: { slug: string; file: string; tier: number }[] };
    const section = inventory.sections.find((s) => s.slug === "rebase");
    check(section !== undefined, "suite-inventory.json has a rebase section");
    if (section) {
      check(section.file === "tests/test-bra262.ts", "rebase section points at tests/test-bra262.ts (got " + section.file + ")");
      check(section.tier === 1, "rebase section is tier 1 (got " + section.tier + ")");
    }
    const runSh = read(path.resolve(import.meta.dir, "../run.sh"));
    check(/section rebase 1 /.test(runSh), "run.sh carries a section rebase line");
    check(runSh.includes("tests/test-bra262.ts"), "run.sh rebase section runs tests/test-bra262.ts");
    check(runSh.includes('BRA262_WORKDIR="$SCRATCH/rebase"'), "run.sh rebase section uses BRA262_WORKDIR");
  }

  // --------------------------------------------- §B agentts check
  console.log("\n=== §B agentts check ===");
  {
    const r = cli(["check", REBASE, "--state-dir", STATE_DIR]);
    const text = r.out + r.err;
    check(r.rc === 0, "CHECK OK: agentts check exits 0 on rebase.ts (got " + r.rc + ": " + text.slice(0, 200) + ")");
    check(text.includes("rebaseCopy(RebaseInput): RebaseReport"), "CHECK OK: check lists the entry rebaseCopy(RebaseInput): RebaseReport");
    check(text.includes("CHECK OK"), "CHECK OK: check prints CHECK OK");
  }

  // --------------------------------------------- §C pure units
  console.log("\n=== §C pure units ===");
  {
    const valid: RebaseInput = {
      project: testProject("/tmp/bra262-state", "/tmp/bra262-work"),
      run: { rebaseId: "BRA-262", copyRoot: "/tmp/c", liveRoot: "/tmp/l", workDir: "/tmp/w", resumeDir: "/tmp/r" },
      owner: "test-session",
    };
    check(validateRebaseInput(valid).length === 0, "C valid input passes validation");
    check(validateRebaseInput(null).length > 0, "C null input is refused");
    check(validateRebaseInput({}).some((e) => /no run object/.test(e)), "C missing run is refused");
    check(
      validateRebaseInput({ ...valid, run: { ...valid.run, copyRoot: "" } }).some((e) => /no copyRoot/.test(e)),
      "C missing copyRoot is refused",
    );
    check(
      validateRebaseInput({ ...valid, run: { ...valid.run, dryRun: "yes" } }).some((e) => /dryRun must be a boolean/.test(e)),
      "C non-boolean dryRun is refused",
    );
    check(
      validateRebaseInput({ ...valid, owner: "" }).some((e) => /no owner string/.test(e)),
      "C missing owner is refused",
    );

    // classifyRebaseChanges: clean apply, conflict, already-applied, delete.
    const base = { "a.txt": "A1", "b.txt": "B1", "c.txt": "C1", "d.txt": "D1" };
    const copy = { "a.txt": "A2", "b.txt": "B1", "c.txt": "C2", "d.txt": "D1" };
    const live = { "a.txt": "A1", "b.txt": "B2", "c.txt": "C2" };
    const cls = classifyRebaseChanges({ base, copy, live });
    check(JSON.stringify(cls.rebasedFiles) === JSON.stringify(["a.txt"]), "C clean apply is rebased (got " + JSON.stringify(cls.rebasedFiles) + ")");
    check(JSON.stringify(cls.alreadyApplied) === JSON.stringify(["c.txt"]), "C same-change-both-sides is already-applied (got " + JSON.stringify(cls.alreadyApplied) + ")");
    check(cls.conflicts.length === 0, "C no conflicts when live only moves other files");
    const conflicted = classifyRebaseChanges({ base, copy, live: { ...live, "a.txt": "ALIVE" } });
    check(conflicted.conflicts.length === 1 && conflicted.conflicts[0].file === "a.txt", "C both-sides-different is a conflict on a.txt");
    check(/both the copy and live changed/.test(conflicted.conflicts[0].reason), "C the conflict reason names the rule");
    const deleted = classifyRebaseChanges({ base, copy: { "a.txt": "A2", "b.txt": "B1", "c.txt": "C1" }, live: { ...live, "d.txt": "D1" } });
    check(JSON.stringify(deleted.rebasedFiles) === JSON.stringify(["a.txt", "d.txt"]), "C a copy deletion is a rebased file (got " + JSON.stringify(deleted.rebasedFiles) + ")");

    // sparseMaps.
    const maps = sparseMaps({
      copiedAt: "2026-11-22T07:00:00.000000+00:00",
      diff: [
        { file: "a.txt", base: "A1", copy: "A2", live: "A1" },
        { file: "b.txt", base: null, copy: "B1", live: null },
      ],
    });
    check(JSON.stringify(maps.base) === JSON.stringify({ "a.txt": "A1" }), "C sparseMaps base drops nulls");
    check(JSON.stringify(maps.copy) === JSON.stringify({ "a.txt": "A2", "b.txt": "B1" }), "C sparseMaps copy keeps additions");
    check(JSON.stringify(maps.live) === JSON.stringify({ "a.txt": "A1" }), "C sparseMaps live drops nulls");

    // parseRebasedOutput.
    const parsed = parseRebasedOutput("REBASED 12 2026-11-22T07:40:00.123456+00:00\n");
    check(parsed.count === 12 && parsed.copiedAt === "2026-11-22T07:40:00.123456+00:00", "C parseRebasedOutput parses the summary line");
    let threw = false;
    try {
      parseRebasedOutput("REBASE-ERROR find failed in /tmp/x\n");
    } catch {
      threw = true;
    }
    check(threw, "C parseRebasedOutput throws on an error line");

    // rebaseManifestScript shape.
    const script = rebaseManifestScript({ liveRoot: "/tmp/live", copyRoot: "/tmp/copy", tmpPath: "/tmp/copy/.agentts-copy-manifest.json.tmp", manifestPath: "/tmp/copy/.agentts-copy-manifest.json" });
    check(script.includes("REBASE_MANIFEST_PY"), "C the manifest script is a python heredoc");
    check(script.includes("\"-name\", \".agentts-copy-manifest.json\""), "C the manifest script excludes the manifest itself");
    check(script.includes("os.rename(tmp_path, manifest_path)"), "C the manifest script renames temp onto the manifest");
    check(!script.includes("Buffer"), "C the manifest script never uses Buffer");
    check(script.includes("REBASED %d %s"), "C the manifest script prints one REBASED summary line");

    // buildRebaseReport.
    const rep = buildRebaseReport({
      rebaseId: "BRA-262",
      verdict: "failed",
      dryRun: false,
      owner: "test-session",
      cancelChecked: true,
      cancelled: false,
      copyRoot: "/tmp/c",
      liveRoot: "/tmp/l",
      rebasedFiles: [],
      alreadyApplied: [],
      conflicts: [{ file: "a.txt", reason: "both live and the copy changed a.txt differently" }],
      manifestCopiedAt: "",
      previousManifestCopiedAt: "2026-11-22T07:00:00.000000+00:00",
    });
    check(rep.verdict === "failed", "C buildRebaseReport keeps the failed verdict");
    check(rep.notes.some((n) => /conflict on a\.txt/.test(n)), "C the conflict is named in the report notes");
    check(rep.knownLimit === REBASE_KNOWN_LIMIT, "C the known limit is carried verbatim");
    const ok = buildRebaseReport({
      rebaseId: "BRA-262",
      verdict: "rebased",
      dryRun: false,
      owner: "test-session",
      cancelChecked: false,
      cancelled: false,
      copyRoot: "/tmp/c",
      liveRoot: "/tmp/l",
      rebasedFiles: ["a.txt"],
      alreadyApplied: [],
      conflicts: [],
      manifestCopiedAt: "2026-11-22T07:40:00.000000+00:00",
      previousManifestCopiedAt: "2026-11-22T07:00:00.000000+00:00",
    });
    check(ok.manifestCopiedAt !== ok.previousManifestCopiedAt, "C a rebased report carries the new manifest time");
  }

  // --------------------------------------------- §D live CLI runs
  console.log("\n=== §D live CLI runs ===");
  await startServer();
  try {
    const BASE = { "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n" };

    // ---- D-262a: clean rebase. The copy changed a.txt; live
    // changed b.txt only. The new manifest is recorded against
    // current live, the copy's change is intact, live untouched.
    {
      const dir = path.join(WORKDIR, "cases", "A-clean");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: { ...BASE, "b.txt": "b2\n" },
      });
      const beforeLive = hashTree(liveRoot);
      const beforeManifest = read(manifestPath);
      const out = driveRebaseRun("run-bra262-A", caseInput(copyRoot, liveRoot, path.join(dir, "work")));
      if (out) {
        check(out.verdict === "rebased", `A verdict rebased (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.rebasedFiles) === JSON.stringify(["a.txt"]), `A rebasedFiles is [a.txt] (got ${JSON.stringify(out.rebasedFiles)})`);
        check(out.conflicts.length === 0, `A no conflicts`);
        check(out.manifestCopiedAt !== "" && out.manifestCopiedAt !== out.previousManifestCopiedAt, `A the manifest time moved (got ${out.manifestCopiedAt})`);
        check(read(path.join(copyRoot, "a.txt")) === "a2\n", `A the copy's change is intact after the rebase`);
        check(JSON.stringify(hashTree(liveRoot)) === JSON.stringify(beforeLive), `A live is untouched`);
        const afterManifest = JSON.parse(read(manifestPath)) as { copiedAt: string; root: string; files: Record<string, string> };
        check(afterManifest.copiedAt === out.manifestCopiedAt, `A the manifest on disk carries the report's copiedAt`);
        check(afterManifest.root === copyRoot, `A the manifest root is still the copy root`);
        check(JSON.stringify(afterManifest.files) === JSON.stringify(beforeLive), `A the new manifest hashes current live`);
        check(beforeManifest !== read(manifestPath), `A the manifest changed`);
      }
    }

    // ---- D-262b: conflicting rebase. Live also changed a.txt,
    // differently — the rebase refuses before writing anything.
    {
      const dir = path.join(WORKDIR, "cases", "B-conflict");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: { ...BASE, "a.txt": "aLIVE\n" },
      });
      const beforeManifest = read(manifestPath);
      const beforeLive = hashTree(liveRoot);
      const out = driveRebaseRun("run-bra262-B", caseInput(copyRoot, liveRoot, path.join(dir, "work")));
      if (out) {
        check(out.verdict === "failed", `B verdict failed (got ${out.verdict})`);
        check(out.conflicts.length === 1 && out.conflicts[0].file === "a.txt", `B the conflict names a.txt (got ${JSON.stringify(out.conflicts)})`);
        check(out.notes.some((n) => /conflict on a\.txt/.test(n)), `B the conflict is named in the notes`);
        check(read(manifestPath) === beforeManifest, `B the manifest is byte-identical after the refusal`);
        check(read(path.join(copyRoot, "a.txt")) === "a2\n", `B the copy's change is intact after the refusal`);
        check(JSON.stringify(hashTree(liveRoot)) === JSON.stringify(beforeLive), `B live is untouched`);
      }
    }

    // ---- D-262c: dry-run plans the rebase and writes nothing.
    {
      const dir = path.join(WORKDIR, "cases", "C-dryrun");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: { ...BASE, "b.txt": "b2\n" },
      });
      const beforeManifest = read(manifestPath);
      const out = driveRebaseRun("run-bra262-C", caseInput(copyRoot, liveRoot, path.join(dir, "work"), { dryRun: true }));
      if (out) {
        check(out.verdict === "dry-run", `C verdict dry-run (got ${out.verdict})`);
        check(JSON.stringify(out.rebasedFiles) === JSON.stringify(["a.txt"]), `C the dry-run still plans [a.txt]`);
        check(out.manifestCopiedAt === "", `C the dry-run writes no manifest time`);
        check(read(manifestPath) === beforeManifest, `C the manifest is byte-identical after a dry-run`);
      }
    }

    // ---- D-262d: already current — the manifest already matches
    // live, so the run reports rebased and writes nothing.
    {
      const dir = path.join(WORKDIR, "cases", "D-current");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: BASE,
      });
      const beforeManifest = read(manifestPath);
      const out = driveRebaseRun("run-bra262-D", caseInput(copyRoot, liveRoot, path.join(dir, "work")));
      if (out) {
        check(out.verdict === "rebased", `D verdict rebased (got ${out.verdict})`);
        check(out.manifestCopiedAt === out.previousManifestCopiedAt, `D the manifest time is unchanged`);
        check(out.notes.some((n) => /manifest already current/.test(n)), `D the note records the already-current recovery`);
        check(read(manifestPath) === beforeManifest, `D the manifest is byte-identical`);
        check(read(path.join(copyRoot, "a.txt")) === "a2\n", `D the copy's change is intact`);
      }
    }

    // ---- D-262e: cancel (bra210a case-H shape). The cancel
    // check reads project.stateDir/queue.json — a scratch dir
    // with a hand-crafted cancelled entry.
    {
      const dir = path.join(WORKDIR, "cases", "E-cancel");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: { ...BASE, "b.txt": "b2\n" },
      });
      const beforeManifest = read(manifestPath);
      const cancelState = path.join(dir, "cancel-state");
      fs.mkdirSync(cancelState, { recursive: true });
      fs.writeFileSync(
        path.join(cancelState, "queue.json"),
        JSON.stringify([{ runId: "run-bra262-E", status: "cancelled" }]) + "\n",
      );
      const input = caseInput(copyRoot, liveRoot, path.join(dir, "work"), { runId: "run-bra262-E" });
      input.project = testProject(cancelState, path.join(dir, "work"));
      const out = driveRebaseRun("run-bra262-E", input);
      if (out) {
        check(out.verdict === "failed", `E verdict failed on a cancelled run (got ${out.verdict})`);
        check(out.cancelChecked === true, `E cancelChecked is true (got ${out.cancelChecked})`);
        check(out.cancelled === true, `E cancelled is true (got ${out.cancelled})`);
        check(read(manifestPath) === beforeManifest, `E the manifest is byte-identical after the cancel refusal`);
      }
    }

    // ---- D-262f: a second run is idempotent — the first run
    // rebases, the second finds the manifest already current and
    // writes nothing.
    {
      const dir = path.join(WORKDIR, "cases", "F-idempotent");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: { ...BASE, "b.txt": "b2\n" },
      });
      const out1 = driveRebaseRun("run-bra262-F1", caseInput(copyRoot, liveRoot, path.join(dir, "work")));
      const afterFirst = read(manifestPath);
      const out2 = driveRebaseRun("run-bra262-F2", caseInput(copyRoot, liveRoot, path.join(dir, "work")));
      if (out1 && out2) {
        check(out1.verdict === "rebased", `F first run rebased (got ${out1.verdict})`);
        check(out2.verdict === "rebased", `F second run rebased (got ${out2.verdict})`);
        check(out2.manifestCopiedAt === out1.manifestCopiedAt, `F the second run keeps the first run's manifest time`);
        check(out2.notes.some((n) => /manifest already current/.test(n)), `F the second run records the already-current recovery`);
        check(read(manifestPath) === afterFirst, `F the manifest is byte-identical after the second run`);
      }
    }

    // ---- D-262g: already-applied — live already carries the
    // copy's change, so there is nothing to apply, but the
    // manifest still moves onto current live.
    {
      const dir = path.join(WORKDIR, "cases", "G-applied");
      const { copyRoot, liveRoot, manifestPath } = threeTreeFixture(dir, {
        base: BASE,
        copy: { ...BASE, "a.txt": "a2\n" },
        live: { ...BASE, "a.txt": "a2\n", "b.txt": "b2\n" },
      });
      const beforeLive = hashTree(liveRoot);
      const out = driveRebaseRun("run-bra262-G", caseInput(copyRoot, liveRoot, path.join(dir, "work")));
      if (out) {
        check(out.verdict === "rebased", `G verdict rebased (got ${out.verdict})`);
        check(JSON.stringify(out.alreadyApplied) === JSON.stringify(["a.txt"]), `G alreadyApplied is [a.txt] (got ${JSON.stringify(out.alreadyApplied)})`);
        check(out.rebasedFiles.length === 0, `G no files to apply`);
        const afterManifest = JSON.parse(read(manifestPath)) as { files: Record<string, string> };
        check(JSON.stringify(afterManifest.files) === JSON.stringify(beforeLive), `G the new manifest hashes current live`);
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
  console.log("\nPASS test-bra262 (rebase)");
  return 0;
}

main().then((rc) => {
  console.log("TEST EXIT rc=" + rc);
  process.exit(rc);
}).catch((e) => {
  console.log("TEST FAILED:", e);
  process.exit(1);
});
