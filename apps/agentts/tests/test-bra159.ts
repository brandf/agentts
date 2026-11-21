#!/usr/bin/env bun
/**
 * Tests for the merge workflow (Linear BRA-159).
 *
 * The worker-per-copy merge is manual (apply a worker's diff from its
 * copy to main, resolve conflicts, run tier 1). BRA-159 encodes it as
 * the merge workflow (workflows/library/merge.ts): given a worker copy
 * + the claimed files, it refuses loudly, writing nothing, when a
 * tier-1 runs against the live tree, when the copy-time manifest is
 * missing or unparsable, when the diff is not confined to the claimed
 * files, when any file conflicts three-way against the manifest base,
 * or when the baselines file differs; otherwise it applies the diff,
 * verifies the post-merge diff is empty except live-only files and
 * live modifications/deletions the copy never touched, typechecks,
 * and runs tier 1 with a fresh resume dir, reporting the counts
 * against the pre-merge baseline. It applies the diff — that is its
 * job — but it never decides acceptance: Meroki reviews the report
 * and closes.
 *
 *   A. The inventory check passes (suite-inventory.json agrees with
 *      run.sh's section definitions on slug + tier).
 *   B. `agentts check` passes on merge.ts (first-run gate).
 *   C. Pure unit checks: parseCopyManifest (valid + malformed),
 *      parseHashOutput (valid + malformed), parseSparseDiff (valid
 *      + malformed), sparseDiffErrorMessage, sparseDiffScript /
 *      typecheckScript / tier1RunScript (shape), computeChangedFiles
 *      (copy edit/add/delete, live-only addition, live-modified and
 *      live-deleted base files), sparse-vs-full plan equivalence
 *      (the same plan from sparse maps as from full maps),
 *      hashScript (nested node_modules / .agentts-state /
 *      .agentts-scratch excluded at any depth), classifyMergeFile
 *      (the full three-way matrix), buildMergePlan (confinement,
 *      baselines refusal, host.ts note, liveModified preserved),
 *      buildMergeReport (merged / failed / dry-run, every failure
 *      named), parseAppliedLines / shellQuote / hashScript /
 *      applyScript.
 *   D. Live runs through the CLI on direct against scratch trees
 *      (fake live + fake copy + manifest via
 *      record-copy-manifest.sh; runTier1 false, typecheck false —
 *      scratch trees have no suite or TS project), asserting verdicts
 *      AND on-disk results: A apply (edit + add + delete, live-only
 *      addition preserved, live-modified + live-deleted base files
 *      preserved — the regression case for the step-7 fix, where the
 *      post-merge check compared ALL keys and threw after the apply),
 *      B dry-run (nothing written), C conflict (nothing written),
 *      D baselines refusal, E host.ts conflict with the note,
 *      F missing manifest, G stale claim (claimed but the copy did
 *      not change it), H already-applied (no-op, verdict merged),
 *      I live-modified + live-deleted in isolation, J tier-1 guard
 *      (a run.sh alive with its cwd inside the scratch live tree
 *      refuses the merge, nothing written), K size regression
 *      (~1,200 dummy files, manifest over the ~60KB trap cap — a
 *      dry-run must succeed, the pre-fix manifest cat crashed it),
 *      L unparsable manifest (refuses loudly). The full-tier
 *      acceptance run (one real merge executed by the workflow with
 *      tier 1 green after it) is a separate script, not this test.
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
 * - The merge workflow's tier-1 guard is scoped to the live tree:
 *   a run.sh process only refuses the merge when it runs against
 *   the tree being merged (its cwd inside liveRoot, or its command
 *   line mentioning liveRoot). The suite runner itself therefore
 *   never trips the guard on these scratch-tree merges; case J
 *   covers the guard positively with a fake run.sh whose cwd is
 *   inside the scratch live tree.
 * - Trap-stdout budget: exec-trap stdout caps at ~60KB (QA probe:
 *   59,561 B passes, 64,111 B crashes — the manifest cat died at
 *   trap-2 on the real tree). The workflow therefore computes the
 *   three-way diff in-shell and returns only the sparse JSON, caps
 *   the typecheck output at 4000 bytes, and returns only run.sh's
 *   PASS summary line. Case K proves the budget holds with a
 *   manifest over the cap.
 *
 *   DQUICKTS=$HOME/workspace/dquickts-build-minimal
 *   bun tests/test-bra159.ts
 *   (run.sh sets DQUICKTS when it runs this in tier 1.)
 *   Exit 0 on PASS, 1 on any mismatch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type Subprocess } from "bun";
import { spawnSync } from "node:child_process";
import {
  parseCopyManifest,
  parseHashOutput,
  parseSparseDiff,
  sparseDiffErrorMessage,
  sparseDiffScript,
  typecheckScript,
  tier1RunScript,
  computeChangedFiles,
  classifyMergeFile,
  buildMergePlan,
  buildMergeReport,
  parseAppliedLines,
  shellQuote,
  hashScript,
  applyScript,
  MERGE_BASELINES_PATH,
  MERGE_HOST_PATH,
  MERGE_MANIFEST_NAME,
  MERGE_KNOWN_LIMIT,
  type BaselineResult,
  type ConfinementResult,
  type SuiteResult,
  type TypecheckResult,
} from "../workflows/library/merge";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, "..");
const MERGE = path.join(ROOT, "workflows", "library", "merge.ts");
const WORKDIR = process.env.BRA159_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), "bra159-"));
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

/** Deterministic 64-hex hash of a string (test fixtures only). */
function h(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

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
    if (Date.now() > deadline) throw new Error("bra159 server did not come up");
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

/** Drive one merge-copy input through the CLI (submit + queue run +
 * result) and return the parsed result JSON, or null on a CLI failure
 * (the failure is already recorded as a check). */
function driveRun(runId: string, input: unknown): Record<string, any> | null {
  const inputFile = path.join(WORKDIR, `input-${runId}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const sub = cli([
    "run", MERGE,
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

function fakeSuite(over: Partial<SuiteResult> = {}): SuiteResult {
  return {
    mode: "full",
    tier: 1,
    sectionsRan: 46,
    totalOk: 1637,
    passLines: 44,
    sections: [],
    allPassed: true,
    skippedViaResume: 0,
    summaryLine: "",
    summaryMatchesIndependent: true,
    elapsedMs: 844000,
    ...over,
  };
}
function fakeBaseline(over: Partial<BaselineResult> = {}): BaselineResult {
  return {
    compared: true,
    baselineLabel: "pre-BRA-159 tier-1",
    baselineSections: 46,
    baselineOk: 1637,
    deltaSections: 1,
    deltaOk: 0,
    expectedSections: 1,
    expectedOk: 0,
    explained: true,
    explanation: "expected growth",
    ...over,
  };
}
function fakeConfinement(over: Partial<ConfinementResult> = {}): ConfinementResult {
  return { confined: true, extras: [], missing: [], ...over };
}
function fakeTypecheck(over: Partial<TypecheckResult> = {}): TypecheckResult {
  return { ran: true, exitCode: 0, passed: true, stderrHead: "", ...over };
}

/** Build one §D case: base/ -> live/ + copy/, manifest recorded on
 * the copy, then mutate() runs against {live, copy} before the merge. */
function buildCase(
  name: string,
  mutate: (dirs: { live: string; copy: string }) => void,
  withManifest = true,
): { live: string; copy: string } {
  const dir = path.join(WORKDIR, "cases", name);
  fs.rmSync(dir, { recursive: true, force: true });
  const base = path.join(dir, "base");
  const live = path.join(dir, "live");
  const copy = path.join(dir, "copy");
  const files: Record<string, string> = {
    "apps/agentts/bench/baselines.json": '{"v":1}\n',
    "apps/agentts/src/host.ts": "// host base\n",
    "apps/agentts/workflows/library/file1.ts": "// file1 base\n",
    "apps/agentts/workflows/library/file3.ts": "// file3 base\n",
    "apps/agentts/workflows/library/file5.ts": "// file5 base\n",
    "apps/agentts/workflows/library/file6.ts": "// file6 base\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.cpSync(base, live, { recursive: true });
  fs.cpSync(base, copy, { recursive: true });
  if (withManifest) {
    const r = spawnSync("sh", [path.join(ROOT, "scripts", "record-copy-manifest.sh"), copy], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`record manifest failed for ${name}: ${r.stdout} ${r.stderr}`);
  }
  mutate({ live, copy });
  return { live, copy };
}

function read(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
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
      const r = cli(["check", MERGE, "--state-dir", STATE_DIR]);
      check(r.rc === 0, `CHECK OK: agentts check exits 0 on merge.ts (got ${r.rc}: ${(r.out + r.err).slice(0, 200)})`);
      check(r.out.includes("CHECK OK"), `CHECK OK: check prints CHECK OK (got ${JSON.stringify(r.out.slice(0, 160))})`);
      check(r.out.includes("mergeCopy(MergeCopyInput)"), `CHECK OK: entry is mergeCopy(MergeCopyInput) (got ${JSON.stringify(r.out.slice(0, 160))})`);
    }

    // --------------------------------------------- §C pure unit checks
    console.log("\n=== §C pure unit checks ===");
    {
      // parseCopyManifest: valid, then every malformation throws loudly.
      const goodManifest = JSON.stringify({
        copiedAt: "2026-11-20T20:05:25.131741+00:00",
        root: "/home/hatch/workspace/agentts-copy-bra159a",
        files: { "apps/agentts/src/host.ts": h("host base"), "CHANGELOG.md": h("changelog") },
      });
      const pm = parseCopyManifest(goodManifest);
      check(pm.copiedAt === "2026-11-20T20:05:25.131741+00:00", `PARSE OK: manifest copiedAt parses (got ${pm.copiedAt})`);
      check(pm.root === "/home/hatch/workspace/agentts-copy-bra159a", `PARSE OK: manifest root parses (got ${pm.root})`);
      check(pm.files["apps/agentts/src/host.ts"] === h("host base"), `PARSE OK: manifest file hash parses (got ${pm.files["apps/agentts/src/host.ts"]})`);
      let threw = false;
      try {
        parseCopyManifest("{not json");
      } catch (e) {
        threw = /not valid JSON/.test((e as Error).message);
      }
      check(threw, `PARSE OK: non-JSON manifest throws loudly`);
      threw = false;
      try {
        parseCopyManifest(JSON.stringify(["an", "array"]));
      } catch (e) {
        threw = /not a JSON object/.test((e as Error).message);
      }
      check(threw, `PARSE OK: array manifest throws loudly`);
      threw = false;
      try {
        parseCopyManifest(JSON.stringify({ root: "/x", files: {} }));
      } catch (e) {
        threw = /no copiedAt/.test((e as Error).message);
      }
      check(threw, `PARSE OK: manifest without copiedAt throws loudly`);
      threw = false;
      try {
        parseCopyManifest(JSON.stringify({ copiedAt: "t", root: "/x", files: { "a.ts": "not-a-hash" } }));
      } catch (e) {
        threw = /no sha256 hex value/.test((e as Error).message);
      }
      check(threw, `PARSE OK: manifest with a non-sha256 file value throws loudly`);

      // parseHashOutput: a real sha256sum listing, ./ stripped;
      // a malformed line throws loudly; empty input is an empty map.
      const listing = [
        h("one") + "  ./apps/agentts/src/host.ts",
        h("two") + "  CHANGELOG.md",
        "",
      ].join("\n");
      const hm = parseHashOutput(listing);
      check(hm["apps/agentts/src/host.ts"] === h("one"), `PARSE OK: hash listing strips ./ (got ${hm["apps/agentts/src/host.ts"]})`);
      check(hm["CHANGELOG.md"] === h("two"), `PARSE OK: hash listing keeps bare paths (got ${hm["CHANGELOG.md"]})`);
      check(Object.keys(parseHashOutput("")).length === 0, `PARSE OK: empty hash output is an empty map`);
      threw = false;
      try {
        parseHashOutput(h("one") + "  ok.ts\ngarbage line\n");
      } catch (e) {
        threw = /cannot parse hash line/.test((e as Error).message);
      }
      check(threw, `PARSE OK: malformed hash line throws loudly`);

      // parseSparseDiff: valid (nulls for absent sides), then every
      // malformation throws loudly. sparseDiffErrorMessage: an
      // error JSON yields its message, anything else yields the raw
      // text trimmed.
      const goodSparse = JSON.stringify({
        copiedAt: "2026-11-20T20:07:33.723674+00:00",
        diff: [
          { file: "a.ts", base: h("a base"), copy: h("a copy"), live: h("a base") },
          { file: "b.ts", base: h("b base"), copy: h("b base"), live: null },
          { file: "c.ts", base: null, copy: h("c new"), live: null },
        ],
      });
      const sd = parseSparseDiff(goodSparse);
      check(sd.copiedAt === "2026-11-20T20:07:33.723674+00:00", `SPARSE OK: copiedAt parses (got ${sd.copiedAt})`);
      check(sd.diff.length === 3, `SPARSE OK: three entries parse (got ${sd.diff.length})`);
      check(sd.diff[1]?.live === null && sd.diff[2]?.base === null,
        `SPARSE OK: nulls survive for absent sides (got ${JSON.stringify(sd.diff[1])} / ${JSON.stringify(sd.diff[2])})`);
      threw = false;
      try {
        parseSparseDiff("{not json");
      } catch (e) {
        threw = /not valid JSON/.test((e as Error).message);
      }
      check(threw, `SPARSE OK: non-JSON sparse diff throws loudly`);
      threw = false;
      try {
        parseSparseDiff(JSON.stringify({ diff: [] }));
      } catch (e) {
        threw = /no copiedAt/.test((e as Error).message);
      }
      check(threw, `SPARSE OK: sparse diff without copiedAt throws loudly`);
      threw = false;
      try {
        parseSparseDiff(JSON.stringify({ copiedAt: "t", diff: [{ file: "a.ts", base: "not-a-hash", copy: null, live: null }] }));
      } catch (e) {
        threw = /no sha256 hex value for base/.test((e as Error).message);
      }
      check(threw, `SPARSE OK: sparse diff with a non-sha256 hash throws loudly`);
      threw = false;
      try {
        parseSparseDiff(JSON.stringify({ copiedAt: "t", diff: [{ base: null, copy: null, live: null }] }));
      } catch (e) {
        threw = /no file string/.test((e as Error).message);
      }
      check(threw, `SPARSE OK: sparse diff entry without a file throws loudly`);
      check(sparseDiffErrorMessage(JSON.stringify({ error: "manifest-missing", message: "manifest not found: /x" })) === "manifest not found: /x",
        `SPARSE OK: error JSON yields its message`);
      check(sparseDiffErrorMessage("  some raw text\n") === "some raw text",
        `SPARSE OK: non-JSON error text yields the raw text trimmed`);

      // sparseDiffScript / typecheckScript / tier1RunScript: shape
      // (the §D cases drive the real behaviour end to end).
      const sds = sparseDiffScript("/c", "/l", "/c/.agentts-copy-manifest.json");
      check(sds.includes("python3 - '/c' '/l' '/c/.agentts-copy-manifest.json'") && sds.includes("<<'MERGE_SPARSE_PY'") && sds.includes("-name") && sds.includes("node_modules"),
        `SCRIPT OK: sparseDiffScript runs python3 on the three paths with the -name prune (got ${JSON.stringify(sds.slice(0, 120))})`);
      check(sds.includes("manifest-missing") && sds.includes("manifest-unparsable"),
        `SCRIPT OK: sparseDiffScript distinguishes manifest-missing from manifest-unparsable`);
      const tcs = typecheckScript("/opt/hatch-image/bin/bun", "/l/apps/agentts", "/w/typecheck.out");
      check(tcs.includes("x tsc --noEmit") && tcs.includes("head -c 4000") && tcs.includes("exit $rc"),
        `SCRIPT OK: typecheckScript caps tsc output at 4000 bytes and keeps tsc's exit code`);
      const t1s = tier1RunScript({ dquickts: "/dq", tmpdir: "/w/tmp", runSh: "/l/apps/agentts/run.sh", resumeDir: "/w/resume", outPath: "/w/tier1.out" });
      check(t1s.includes("'/l/apps/agentts/run.sh'") && t1s.includes("--resume-dir '/w/resume'") && t1s.includes("grep -E '^PASS tier") && t1s.includes("exit $rc"),
        `SCRIPT OK: tier1RunScript redirects run.sh to a file and returns only its PASS line`);

      // hashScript nested prune: a scratch tree with junk dirs at
      // any depth (apps/agentts/node_modules, .agentts-state,
      // .agentts-scratch, top-level .git) hashes only the real files.
      {
        const pt = path.join(WORKDIR, "prune-tree");
        fs.rmSync(pt, { recursive: true, force: true });
        const junk = [
          "apps/agentts/node_modules/pkg/index.js",
          "apps/agentts/.agentts-state/x.json",
          "apps/agentts/.agentts-scratch/y.json",
          ".git/config",
          "node_modules/top-pkg/index.js",
        ];
        for (const j of junk) {
          const p = path.join(pt, j);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, "// junk\n");
        }
        for (const [rel, content] of Object.entries({ "apps/agentts/real.ts": "// real\n", "top.ts": "// top\n" })) {
          const p = path.join(pt, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content);
        }
        const hr = spawnSync("/bin/sh", ["-c", hashScript(pt)], { encoding: "utf8" });
        check(hr.status === 0, `PRUNE OK: hashScript exits 0 on the prune tree (got ${hr.status})`);
        const hm2 = parseHashOutput(hr.stdout ?? "");
        check(JSON.stringify(Object.keys(hm2).sort()) === JSON.stringify(["apps/agentts/real.ts", "top.ts"]),
          `PRUNE OK: nested junk dirs excluded at any depth (got ${JSON.stringify(Object.keys(hm2).sort())})`);
      }

      // computeChangedFiles: copy edit/add/delete, live-only addition,
      // live-modified and live-deleted base files, and the exclusions
      // (a file both sides changed is not live-modified; a file only
      // the copy changed is not live-modified).
      const base = { f1: h("f1 base"), f3: h("f3 base"), f5: h("f5 base"), f6: h("f6 base"), f7: h("f7 base") };
      const copy = { f1: h("f1 copy"), f2: h("f2 new"), f5: h("f5 base"), f6: h("f6 base"), f7: h("f7 copy") };
      const live = { f1: h("f1 live"), f4: h("f4 new"), f5: h("f5 live"), f7: h("f7 base") };
      const ch = computeChangedFiles({ base, copy, live });
      check(JSON.stringify(ch.copyChanged) === JSON.stringify(["f1", "f2", "f3", "f7"]),
        `CHANGED OK: copyChanged is [f1 edit, f2 add, f3 delete, f7 edit] (got ${JSON.stringify(ch.copyChanged)})`);
      check(JSON.stringify(ch.liveOnly) === JSON.stringify(["f4"]),
        `CHANGED OK: liveOnly is [f4] (got ${JSON.stringify(ch.liveOnly)})`);
      check(JSON.stringify(ch.liveModified) === JSON.stringify(["f5", "f6"]),
        `CHANGED OK: liveModified is [f5 modified, f6 deleted] (got ${JSON.stringify(ch.liveModified)})`);
      check(!ch.liveModified.includes("f1") && !ch.liveModified.includes("f7"),
        `CHANGED OK: liveModified excludes f1 (both changed) and f7 (copy-only change)`);

      // classifyMergeFile: the full three-way matrix. Base/copy/live
      // are hashes, or undefined when the file is absent that side.
      const B = h("base");
      const C = h("copy");
      const L = h("live");
      const cls = (file: string, base?: string, copy?: string, live?: string) =>
        classifyMergeFile({ file, base, copy, live });
      check(cls("f", B, C, C).action === "already-applied",
        `CLASSIFY OK: copy == live is already-applied (got ${JSON.stringify(cls("f", B, C, C))})`);
      check(cls("f", B, undefined, undefined).action === "already-applied",
        `CLASSIFY OK: both sides deleted is already-applied (got ${JSON.stringify(cls("f", B, undefined, undefined))})`);
      check(cls("f", B, C, B).action === "apply",
        `CLASSIFY OK: copy changed + live unchanged is apply (got ${JSON.stringify(cls("f", B, C, B))})`);
      const add = cls("f", undefined, C, undefined);
      check(add.action === "apply" && /added this file/.test(add.reason),
        `CLASSIFY OK: copy added + live absent is apply (got ${JSON.stringify(add)})`);
      check(cls("f", B, undefined, B).action === "delete",
        `CLASSIFY OK: copy deleted + live unchanged is delete (got ${JSON.stringify(cls("f", B, undefined, B))})`);
      check(cls("f", B, B, L).action === "live-only",
        `CLASSIFY OK: copy untouched + live changed is live-only (got ${JSON.stringify(cls("f", B, B, L))})`);
      check(cls("f", B, B, undefined).action === "live-only",
        `CLASSIFY OK: copy untouched + live deleted is live-only (got ${JSON.stringify(cls("f", B, B, undefined))})`);
      const conf = cls("f", B, C, L);
      check(conf.action === "conflict" && /both the copy and live changed/.test(conf.reason),
        `CLASSIFY OK: both changed differently is conflict (got ${JSON.stringify(conf)})`);
      const confDel = cls("f", B, C, undefined);
      check(confDel.action === "conflict",
        `CLASSIFY OK: copy changed + live deleted is conflict (got ${JSON.stringify(confDel)})`);

      // buildMergePlan: confinement, classification, baselines,
      // host.ts note, liveModified. Claimed files are a/b/c/g/h;
      // f is copy-changed but unclaimed (a confinement extra).
      const planBase = { a: h("a"), b: h("b"), c: h("c"), d: h("d"), e: h("e"), f: h("f"), h: h("h") };
      const planCopy = { a: h("a2"), b: h("b2"), d: h("d"), e: h("e"), f: h("f2"), h: h("h2"), g: h("g") };
      const planLive = { a: h("a"), b: h("b2"), c: h("c"), d: h("d2"), f: h("f3"), h: h("h3") };
      const plan = buildMergePlan({
        claimedFiles: ["a", "b", "c", "g", "h"],
        base: planBase,
        copy: planCopy,
        live: planLive,
      });
      check(JSON.stringify(plan.copyChanged) === JSON.stringify(["a", "b", "c", "f", "g", "h"]),
        `PLAN OK: copyChanged is [a, b, c, f, g, h] (got ${JSON.stringify(plan.copyChanged)})`);
      check(JSON.stringify(plan.liveModified) === JSON.stringify(["d", "e"]),
        `PLAN OK: liveModified is [d modified, e deleted] (got ${JSON.stringify(plan.liveModified)})`);
      check(plan.liveOnly.length === 0, `PLAN OK: liveOnly is empty (got ${JSON.stringify(plan.liveOnly)})`);
      check(plan.confinement.confined === false && JSON.stringify(plan.confinement.extras) === JSON.stringify(["f"]) && plan.confinement.missing.length === 0,
        `PLAN OK: confinement names extra [f], no missing (got ${JSON.stringify(plan.confinement)})`);
      check(JSON.stringify(plan.plannedApply) === JSON.stringify(["a", "g"]),
        `PLAN OK: plannedApply is [a, g] (got ${JSON.stringify(plan.plannedApply)})`);
      check(JSON.stringify(plan.plannedDelete) === JSON.stringify(["c"]),
        `PLAN OK: plannedDelete is [c] (got ${JSON.stringify(plan.plannedDelete)})`);
      check(JSON.stringify(plan.alreadyApplied) === JSON.stringify(["b"]),
        `PLAN OK: alreadyApplied is [b] (got ${JSON.stringify(plan.alreadyApplied)})`);
      check(plan.conflicts.length === 1 && plan.conflicts[0]?.file === "h",
        `PLAN OK: conflicts is [h] (got ${JSON.stringify(plan.conflicts)})`);
      check(JSON.stringify(plan.liveOnlyClaimed) === JSON.stringify([]),
        `PLAN OK: liveOnlyClaimed is empty — the live-only action is unreachable from the plan (copyChanged implies copy != base), so a claimed file the copy did not touch is a confinement missing instead`);
      // Baselines: any copy-vs-live difference refuses the merge.
      const planB = buildMergePlan({
        claimedFiles: [MERGE_BASELINES_PATH],
        base: { [MERGE_BASELINES_PATH]: h("v1") },
        copy: { [MERGE_BASELINES_PATH]: h("v2") },
        live: { [MERGE_BASELINES_PATH]: h("v1") },
      });
      check(JSON.stringify(planB.baselinesRefused) === JSON.stringify([MERGE_BASELINES_PATH]),
        `PLAN OK: changed baselines are refused (got ${JSON.stringify(planB.baselinesRefused)})`);
      const planB2 = buildMergePlan({
        claimedFiles: [MERGE_BASELINES_PATH],
        base: { [MERGE_BASELINES_PATH]: h("v1") },
        copy: { [MERGE_BASELINES_PATH]: h("v1") },
        live: { [MERGE_BASELINES_PATH]: h("v1") },
      });
      check(planB2.baselinesRefused.length === 0,
        `PLAN OK: identical baselines are not refused (got ${JSON.stringify(planB2.baselinesRefused)})`);
      // host.ts: a conflict carries the merge-time-resolution note.
      const planH = buildMergePlan({
        claimedFiles: [MERGE_HOST_PATH],
        base: { [MERGE_HOST_PATH]: h("host") },
        copy: { [MERGE_HOST_PATH]: h("host copy") },
        live: { [MERGE_HOST_PATH]: h("host live") },
      });
      check(planH.conflicts.length === 1 && /host\.ts conflicts need resolution at merge time/.test(planH.conflicts[0]?.reason ?? ""),
        `PLAN OK: host.ts conflict carries the merge-time note (got ${JSON.stringify(planH.conflicts)})`);
      // Sparse-vs-full equivalence: the workflow feeds buildMergePlan
      // sparse maps (only files that differ anywhere). Adding an
      // all-equal file z to all three full maps and dropping it from
      // the sparse maps must not change the plan — classification
      // only depends on differences.
      const sparsify = (
        b: Record<string, string>, c: Record<string, string>, l: Record<string, string>,
      ): { base: Record<string, string>; copy: Record<string, string>; live: Record<string, string> } => {
        const sb: Record<string, string> = {};
        const sc: Record<string, string> = {};
        const sl: Record<string, string> = {};
        for (const k of new Set([...Object.keys(b), ...Object.keys(c), ...Object.keys(l)])) {
          if (b[k] !== undefined && b[k] === c[k] && b[k] === l[k]) continue;
          if (b[k] !== undefined) sb[k] = b[k];
          if (c[k] !== undefined) sc[k] = c[k];
          if (l[k] !== undefined) sl[k] = l[k];
        }
        return { base: sb, copy: sc, live: sl };
      };
      const fullZ = {
        base: { ...planBase, z: h("z same") },
        copy: { ...planCopy, z: h("z same") },
        live: { ...planLive, z: h("z same") },
      };
      const planFull = buildMergePlan({ claimedFiles: ["a", "b", "c", "g", "h"], ...fullZ });
      const sp = sparsify(fullZ.base, fullZ.copy, fullZ.live);
      check(!("z" in sp.base) && !("z" in sp.copy) && !("z" in sp.live),
        `PLAN OK: sparsify drops the all-equal file z from every map`);
      const planSparse = buildMergePlan({ claimedFiles: ["a", "b", "c", "g", "h"], ...sp });
      check(
        JSON.stringify(planSparse.copyChanged) === JSON.stringify(planFull.copyChanged) &&
        JSON.stringify(planSparse.liveOnly) === JSON.stringify(planFull.liveOnly) &&
        JSON.stringify(planSparse.liveModified) === JSON.stringify(planFull.liveModified) &&
        JSON.stringify(planSparse.plannedApply) === JSON.stringify(planFull.plannedApply) &&
        JSON.stringify(planSparse.plannedDelete) === JSON.stringify(planFull.plannedDelete) &&
        JSON.stringify(planSparse.alreadyApplied) === JSON.stringify(planFull.alreadyApplied) &&
        JSON.stringify(planSparse.conflicts) === JSON.stringify(planFull.conflicts) &&
        JSON.stringify(planSparse.confinement) === JSON.stringify(planFull.confinement),
        `PLAN OK: sparse maps give the same plan as full maps (copyChanged ${JSON.stringify(planSparse.copyChanged)}, conflicts ${JSON.stringify(planSparse.conflicts)})`,
      );

      // buildMergeReport: merged / failed / dry-run, every failure named.
      const merged = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "merged",
        dryRun: false,
        tier1InFlight: false,
        applied: ["a"],
        deleted: [],
        planned: ["a"],
        alreadyApplied: [],
        liveOnlyPreserved: ["d"],
        conflicts: [],
        baselinesRefused: [],
        confinement: fakeConfinement(),
        typecheck: fakeTypecheck(),
        suite: fakeSuite(),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(merged.verdict === "merged", `REPORT OK: clean evidence merges (got ${merged.verdict})`);
      check(merged.notes.length === 0, `REPORT OK: clean evidence has no notes (got ${JSON.stringify(merged.notes)})`);
      check(merged.knownLimit === MERGE_KNOWN_LIMIT && /NOT rolled back/.test(merged.knownLimit) && /false pass/.test(merged.knownLimit),
        `REPORT OK: the known v0 limit is carried verbatim`);
      const withConflict = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "failed",
        dryRun: false,
        tier1InFlight: false,
        applied: [],
        deleted: [],
        planned: ["h"],
        alreadyApplied: [],
        liveOnlyPreserved: [],
        conflicts: [{ file: "h", reason: "both the copy and live changed this file differently" }],
        baselinesRefused: [],
        confinement: fakeConfinement(),
        typecheck: fakeTypecheck(),
        suite: fakeSuite(),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(withConflict.notes.some((n) => /conflict on h/.test(n)),
        `REPORT OK: a conflict is named with its file (got ${JSON.stringify(withConflict.notes)})`);
      const withBaselines = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "failed",
        dryRun: false,
        tier1InFlight: false,
        applied: [],
        deleted: [],
        planned: [],
        alreadyApplied: [],
        liveOnlyPreserved: [],
        conflicts: [],
        baselinesRefused: [MERGE_BASELINES_PATH],
        confinement: fakeConfinement(),
        typecheck: fakeTypecheck(),
        suite: fakeSuite(),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(withBaselines.notes.some((n) => /baselines refused/.test(n) && n.includes(MERGE_BASELINES_PATH)),
        `REPORT OK: a baselines refusal is named (got ${JSON.stringify(withBaselines.notes)})`);
      const badTypecheck = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "failed",
        dryRun: false,
        tier1InFlight: false,
        applied: ["a"],
        deleted: [],
        planned: ["a"],
        alreadyApplied: [],
        liveOnlyPreserved: [],
        conflicts: [],
        baselinesRefused: [],
        confinement: fakeConfinement(),
        typecheck: fakeTypecheck({ passed: false, exitCode: 2 }),
        suite: fakeSuite(),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(badTypecheck.notes.some((n) => /typecheck failed.*already merged/.test(n)),
        `REPORT OK: a typecheck failure says the tree was already merged (got ${JSON.stringify(badTypecheck.notes)})`);
      const resumed = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "failed",
        dryRun: false,
        tier1InFlight: false,
        applied: ["a"],
        deleted: [],
        planned: ["a"],
        alreadyApplied: [],
        liveOnlyPreserved: [],
        conflicts: [],
        baselinesRefused: [],
        confinement: fakeConfinement(),
        typecheck: fakeTypecheck(),
        suite: fakeSuite({ skippedViaResume: 2, summaryMatchesIndependent: false }),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(resumed.notes.some((n) => /skipped 2 sections via resume/.test(n)),
        `REPORT OK: a resumed suite run is named (got ${JSON.stringify(resumed.notes)})`);
      const dry = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "dry-run",
        dryRun: true,
        tier1InFlight: false,
        applied: [],
        deleted: [],
        planned: ["a"],
        alreadyApplied: [],
        liveOnlyPreserved: [],
        conflicts: [],
        baselinesRefused: [],
        confinement: fakeConfinement(),
        typecheck: { ran: false, exitCode: -1, passed: false, stderrHead: "" },
        suite: fakeSuite({ mode: "skipped", sectionsRan: 0, totalOk: 0, passLines: 0 }),
        baseline: fakeBaseline({ compared: false, explained: true, explanation: "dry run — no suite run" }),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(dry.verdict === "dry-run" && dry.notes.length === 0,
        `REPORT OK: a clean dry-run reports dry-run with no notes (got ${dry.verdict}: ${JSON.stringify(dry.notes)})`);
      const inFlight = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "failed",
        dryRun: false,
        tier1InFlight: true,
        applied: [],
        deleted: [],
        planned: [],
        alreadyApplied: [],
        liveOnlyPreserved: [],
        conflicts: [],
        baselinesRefused: [],
        confinement: { confined: false, extras: [], missing: [] },
        typecheck: { ran: false, exitCode: -1, passed: false, stderrHead: "" },
        suite: fakeSuite({ mode: "skipped", sectionsRan: 0, totalOk: 0, passLines: 0 }),
        baseline: fakeBaseline({ compared: false, explained: true, explanation: "merge refused before the suite step" }),
        manifestCopiedAt: "",
        extraNotes: ["tier-1 in flight — merge refused, nothing was written"],
      });
      check(inFlight.notes.some((n) => /tier-1 in flight/.test(n)),
        `REPORT OK: a tier-1-in-flight refusal is named (got ${JSON.stringify(inFlight.notes)})`);

      // parseAppliedLines / shellQuote / hashScript / applyScript.
      check(JSON.stringify(parseAppliedLines("APPLIED a.ts\nsome noise\nAPPLIED b.ts\n")) === JSON.stringify(["a.ts", "b.ts"]),
        `SCRIPT OK: parseAppliedLines extracts APPLIED lines (got ${JSON.stringify(parseAppliedLines("APPLIED a.ts\nnoise\nAPPLIED b.ts\n"))})`);
      check(shellQuote("plain") === "'plain'", `SCRIPT OK: shellQuote quotes a plain string (got ${shellQuote("plain")})`);
      check(shellQuote("a'b") === "'a'\\''b'", `SCRIPT OK: shellQuote escapes a single quote (got ${shellQuote("a'b")})`);
      const hs = hashScript("/some/root");
      check(hs.includes("'/some/root'") && hs.includes("node_modules") && hs.includes(MERGE_MANIFEST_NAME),
        `SCRIPT OK: hashScript cds to the root and excludes node_modules + the manifest (got ${JSON.stringify(hs.slice(0, 120))})`);
      const as = applyScript({ copyRoot: "/c", liveRoot: "/l", plannedApply: ["x/y.ts"], plannedDelete: ["z.ts"] });
      check(as.split("\n")[0] === "set -e", `SCRIPT OK: applyScript starts with set -e`);
      check(as.includes("cp -p '/c/x/y.ts' '/l/x/y.ts'") && as.includes("mkdir -p '/l/x'"),
        `SCRIPT OK: applyScript copies applies with mkdir -p (got ${JSON.stringify(as)})`);
      check(as.includes("rm '/l/z.ts'") && as.includes("APPLIED x/y.ts") && as.includes("APPLIED z.ts"),
        `SCRIPT OK: applyScript removes deletes and echoes APPLIED per file`);
    }

    // --------------------------------------------- §D live scratch-tree runs
    console.log("\n=== §D live scratch-tree runs ===");
    // ---- Case A: apply (edit + add + delete; live-only addition,
    // live-modified + live-deleted base files preserved)
    {
      const { live, copy } = buildCase("A-apply", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file2.ts"), "// file2 new\n");
        fs.rmSync(path.join(copy, "apps/agentts/workflows/library/file3.ts"));
        fs.writeFileSync(path.join(live, "apps/agentts/workflows/library/file4.ts"), "// file4 live-only\n");
        fs.writeFileSync(path.join(live, "apps/agentts/workflows/library/file5.ts"), "// file5 LIVE\n");
        fs.rmSync(path.join(live, "apps/agentts/workflows/library/file6.ts"));
      });
      const out = driveRun("run-bra159-A", {
        mergeId: "BRA-159-A", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "A-apply", "work"),
        resumeDir: path.join(WORKDIR, "cases", "A-apply", "resume"),
        claimedFiles: [
          "apps/agentts/workflows/library/file1.ts",
          "apps/agentts/workflows/library/file2.ts",
          "apps/agentts/workflows/library/file3.ts",
        ],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "merged", `A verdict merged (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.applied) === JSON.stringify(["apps/agentts/workflows/library/file1.ts", "apps/agentts/workflows/library/file2.ts"]), `A applied [file1, file2] (got ${JSON.stringify(out.applied)})`);
        check(JSON.stringify(out.deleted) === JSON.stringify(["apps/agentts/workflows/library/file3.ts"]), `A deleted [file3] (got ${JSON.stringify(out.deleted)})`);
        check(JSON.stringify(out.liveOnlyPreserved) === JSON.stringify(["apps/agentts/workflows/library/file4.ts", "apps/agentts/workflows/library/file5.ts", "apps/agentts/workflows/library/file6.ts"]), `A liveOnlyPreserved [file4, file5, file6] (got ${JSON.stringify(out.liveOnlyPreserved)})`);
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 CHANGED\n", "A live file1 has the copy content");
        check(read(path.join(live, "apps/agentts/workflows/library/file2.ts")) === "// file2 new\n", "A live file2 was created");
        check(read(path.join(live, "apps/agentts/workflows/library/file3.ts")) === null, "A live file3 was deleted");
        check(read(path.join(live, "apps/agentts/workflows/library/file4.ts")) === "// file4 live-only\n", "A live file4 untouched");
        check(read(path.join(live, "apps/agentts/workflows/library/file5.ts")) === "// file5 LIVE\n", "A live file5 keeps its live content");
        check(read(path.join(live, "apps/agentts/workflows/library/file6.ts")) === null, "A live file6 stays deleted");
        check(typeof out.manifestCopiedAt === "string" && out.manifestCopiedAt !== "", "A manifestCopiedAt recorded");
      }
    }

    // ---- Case B: dry-run (same change, nothing written)
    {
      const { live, copy } = buildCase("B-dryrun", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
      });
      const out = driveRun("run-bra159-B", {
        mergeId: "BRA-159-B", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "B-dryrun", "work"),
        resumeDir: path.join(WORKDIR, "cases", "B-dryrun", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: false, dryRun: true,
      });
      if (out) {
        check(out.verdict === "dry-run", `B verdict dry-run (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.planned) === JSON.stringify(["apps/agentts/workflows/library/file1.ts"]), `B planned [file1] (got ${JSON.stringify(out.planned)})`);
        check(out.applied.length === 0 && out.deleted.length === 0, "B applied/deleted empty");
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 base\n", "B live file1 unchanged");
      }
    }

    // ---- Case C: conflict (both sides changed file1 differently)
    {
      const { live, copy } = buildCase("C-conflict", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 COPY\n");
        fs.writeFileSync(path.join(live, "apps/agentts/workflows/library/file1.ts"), "// file1 LIVE\n");
      });
      const out = driveRun("run-bra159-C", {
        mergeId: "BRA-159-C", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "C-conflict", "work"),
        resumeDir: path.join(WORKDIR, "cases", "C-conflict", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `C verdict failed (got ${out.verdict})`);
        check(out.conflicts.length === 1 && out.conflicts[0].file === "apps/agentts/workflows/library/file1.ts", `C conflict on file1 (got ${JSON.stringify(out.conflicts)})`);
        check(out.applied.length === 0, "C nothing applied");
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 LIVE\n", "C live file1 unchanged");
      }
    }

    // ---- Case D: baselines refusal
    {
      const { live, copy } = buildCase("D-baselines", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/bench/baselines.json"), '{"v":2}\n');
      });
      const out = driveRun("run-bra159-D", {
        mergeId: "BRA-159-D", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "D-baselines", "work"),
        resumeDir: path.join(WORKDIR, "cases", "D-baselines", "resume"),
        claimedFiles: ["apps/agentts/bench/baselines.json"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `D verdict failed (got ${out.verdict})`);
        check(JSON.stringify(out.baselinesRefused) === JSON.stringify(["apps/agentts/bench/baselines.json"]), `D baselines refused (got ${JSON.stringify(out.baselinesRefused)})`);
        check(read(path.join(live, "apps/agentts/bench/baselines.json")) === '{"v":1}\n', "D live baselines unchanged");
      }
    }

    // ---- Case E: host.ts conflict carries the merge-time note
    {
      const { live, copy } = buildCase("E-host", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/src/host.ts"), "// host COPY\n");
        fs.writeFileSync(path.join(live, "apps/agentts/src/host.ts"), "// host LIVE\n");
      });
      const out = driveRun("run-bra159-E", {
        mergeId: "BRA-159-E", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "E-host", "work"),
        resumeDir: path.join(WORKDIR, "cases", "E-host", "resume"),
        claimedFiles: ["apps/agentts/src/host.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `E verdict failed (got ${out.verdict})`);
        check(out.conflicts.length === 1 && /host\.ts conflicts need resolution at merge time/.test(out.conflicts[0].reason), `E host.ts note present (got ${JSON.stringify(out.conflicts)})`);
        check(read(path.join(live, "apps/agentts/src/host.ts")) === "// host LIVE\n", "E live host.ts unchanged");
      }
    }

    // ---- Case F: missing manifest
    {
      const { live, copy } = buildCase("F-nomanifest", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
      }, false);
      const out = driveRun("run-bra159-F", {
        mergeId: "BRA-159-F", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "F-nomanifest", "work"),
        resumeDir: path.join(WORKDIR, "cases", "F-nomanifest", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `F verdict failed (got ${out.verdict})`);
        check(out.notes.some((n: string) => /manifest missing/.test(n)), `F manifest-missing note (got ${JSON.stringify(out.notes)})`);
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 base\n", "F live file1 unchanged");
      }
    }

    // ---- Case G: stale claim (claimed but the copy did not change it)
    {
      const { live, copy } = buildCase("G-stale", ({ live, copy }) => {
        fs.writeFileSync(path.join(live, "apps/agentts/workflows/library/file5.ts"), "// file5 LIVE\n");
      });
      const out = driveRun("run-bra159-G", {
        mergeId: "BRA-159-G", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "G-stale", "work"),
        resumeDir: path.join(WORKDIR, "cases", "G-stale", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file5.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `G verdict failed (got ${out.verdict})`);
        check(out.confinement.missing.includes("apps/agentts/workflows/library/file5.ts"), `G missing names file5 (got ${JSON.stringify(out.confinement)})`);
        check(read(path.join(live, "apps/agentts/workflows/library/file5.ts")) === "// file5 LIVE\n", "G live file5 unchanged");
      }
    }

    // ---- Case H: already-applied (both sides changed identically)
    {
      const { live, copy } = buildCase("H-applied", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file6.ts"), "// file6 SAME\n");
        fs.writeFileSync(path.join(live, "apps/agentts/workflows/library/file6.ts"), "// file6 SAME\n");
      });
      const out = driveRun("run-bra159-H", {
        mergeId: "BRA-159-H", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "H-applied", "work"),
        resumeDir: path.join(WORKDIR, "cases", "H-applied", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file6.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "merged", `H verdict merged (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.alreadyApplied) === JSON.stringify(["apps/agentts/workflows/library/file6.ts"]), `H alreadyApplied [file6] (got ${JSON.stringify(out.alreadyApplied)})`);
        check(out.applied.length === 0, "H nothing copied (already identical)");
      }
    }

    // ---- Case I: live modifies + deletes base files the copy never
    // touched, in isolation (the step-7 regression case: the
    // pre-fix post-merge check compared ALL keys, so these
    // legitimate live-only differences read as a non-empty diff
    // and the run threw AFTER the apply).
    {
      const { live, copy } = buildCase("I-livemod", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        fs.writeFileSync(path.join(live, "apps/agentts/workflows/library/file5.ts"), "// file5 LIVE\n");
        fs.rmSync(path.join(live, "apps/agentts/workflows/library/file6.ts"));
      });
      const out = driveRun("run-bra159-I", {
        mergeId: "BRA-159-I", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "I-livemod", "work"),
        resumeDir: path.join(WORKDIR, "cases", "I-livemod", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "merged", `I verdict merged (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.applied) === JSON.stringify(["apps/agentts/workflows/library/file1.ts"]), `I applied [file1] (got ${JSON.stringify(out.applied)})`);
        check(
          JSON.stringify(out.liveOnlyPreserved) === JSON.stringify(["apps/agentts/workflows/library/file5.ts", "apps/agentts/workflows/library/file6.ts"]),
          `I liveOnlyPreserved [file5, file6] (got ${JSON.stringify(out.liveOnlyPreserved)})`,
        );
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 CHANGED\n", "I live file1 has the copy content");
        check(read(path.join(live, "apps/agentts/workflows/library/file5.ts")) === "// file5 LIVE\n", "I live file5 keeps its live content");
        check(read(path.join(live, "apps/agentts/workflows/library/file6.ts")) === null, "I live file6 stays deleted");
      }
    }

    // ---- Case J: tier-1 guard (a run.sh alive with its cwd inside
    // the scratch live tree refuses the merge, nothing written).
    // The fake run.sh is a sleeping shell script named run.sh,
    // spawned with cwd = live: the guard must see a tier-1 running
    // against the tree being merged. Killed right after the drive.
    {
      const { live, copy } = buildCase("J-guard", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
      });
      const fakeDir = path.join(WORKDIR, "cases", "J-guard", "fake");
      fs.mkdirSync(fakeDir, { recursive: true });
      const fakeRunSh = path.join(fakeDir, "run.sh");
      fs.writeFileSync(fakeRunSh, "#!/bin/sh\nsleep 30\n");
      const fake = spawn(["/bin/sh", fakeRunSh], { cwd: live, stdout: "ignore", stderr: "ignore" });
      await sleep(300);
      try {
        const out = driveRun("run-bra159-J", {
          mergeId: "BRA-159-J", copyRoot: copy, liveRoot: live,
          workDir: path.join(WORKDIR, "cases", "J-guard", "work"),
          resumeDir: path.join(WORKDIR, "cases", "J-guard", "resume"),
          claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
          typecheck: false, runTier1: false,
        });
        if (out) {
          check(out.verdict === "failed", `J verdict failed (got ${out.verdict})`);
          check(out.tier1InFlight === true, `J tier1InFlight true (got ${out.tier1InFlight})`);
          check(out.applied.length === 0, "J nothing applied");
          check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 base\n", "J live file1 unchanged");
        }
      } finally {
        try {
          fake.kill(9);
        } catch { /* already dead */ }
        await fake.exited;
      }
    }

    // ---- Case K: size regression (~1,200 dummy files, manifest
    // over the ~60KB trap cap — the pre-fix manifest cat crashed
    // the C host at trap-2; the sparse diff must succeed).
    {
      const dir = path.join(WORKDIR, "cases", "K-size");
      fs.rmSync(dir, { recursive: true, force: true });
      const base = path.join(dir, "base");
      const live = path.join(dir, "live");
      const copy = path.join(dir, "copy");
      const files: Record<string, string> = {
        "apps/agentts/bench/baselines.json": '{"v":1}\n',
        "apps/agentts/src/host.ts": "// host base\n",
        "lib/a.ts": "// a base\n",
      };
      for (let i = 0; i < 1200; i++) {
        files[`lib/dummy-${String(i).padStart(4, "0")}.ts`] = "// dummy\n";
      }
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(base, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
      fs.cpSync(base, live, { recursive: true });
      fs.cpSync(base, copy, { recursive: true });
      const mr = spawnSync("sh", [path.join(ROOT, "scripts", "record-copy-manifest.sh"), copy], { encoding: "utf8" });
      if (mr.status !== 0) throw new Error(`record manifest failed for K-size: ${mr.stdout} ${mr.stderr}`);
      const manifestBytes = fs.statSync(path.join(copy, ".agentts-copy-manifest.json")).size;
      check(manifestBytes > 60000, `K manifest over the cap regime (got ${manifestBytes} bytes)`);
      fs.writeFileSync(path.join(copy, "lib/a.ts"), "// a COPY\n");
      const out = driveRun("run-bra159-K", {
        mergeId: "BRA-159-K", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "K-size", "work"),
        resumeDir: path.join(WORKDIR, "cases", "K-size", "resume"),
        claimedFiles: ["lib/a.ts"],
        typecheck: false, runTier1: false, dryRun: true,
      });
      if (out) {
        check(out.verdict === "dry-run", `K verdict dry-run (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.planned) === JSON.stringify(["lib/a.ts"]), `K planned [lib/a.ts] (got ${JSON.stringify(out.planned)})`);
      }
    }

    // ---- Case L: unparsable manifest (refuses loudly, nothing written).
    {
      const { live, copy } = buildCase("L-badmanifest", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
      }, false);
      fs.writeFileSync(path.join(copy, ".agentts-copy-manifest.json"), "{not json");
      const out = driveRun("run-bra159-L", {
        mergeId: "BRA-159-L", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "L-badmanifest", "work"),
        resumeDir: path.join(WORKDIR, "cases", "L-badmanifest", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `L verdict failed (got ${out.verdict})`);
        check(out.notes.some((n: string) => /manifest unparsable/.test(n)), `L manifest-unparsable note (got ${JSON.stringify(out.notes)})`);
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 base\n", "L live file1 unchanged");
      }
    }
  } finally {
    await stopServer();
  }

  console.log("");
  if (FAILURES.length) {
    console.log(`BRA159 FAIL: ${FAILURES.length} check(s) failed`);
    for (const f of FAILURES) console.log(`  - ${f}`);
    return 1;
  }
  console.log("PASS bra159 merge workflow (inventory check, agentts check, pure unit checks, live scratch-tree runs — all through the CLI on direct)");
  return 0;
}

process.exit(await main());
