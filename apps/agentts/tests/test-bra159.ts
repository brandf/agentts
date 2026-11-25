#!/usr/bin/env bun
/**
 * Tests for the merge workflow (Linear BRA-159).
 *
 * The worker-per-copy merge is manual (apply a worker's diff from its
 * copy to main, resolve conflicts, run tier 1). BRA-159 encodes it as
 * the merge workflow (workflows/library/merge.ts): given a worker copy
 * + the claimed files, it refuses loudly, writing nothing, when a
 * real merge carries no Landing authorization or a malformed one, when a
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
 *      named; the authorization carried verbatim when present,
 *      null when absent — the field present on every report),
 *      validateMergeAuthorization (valid, missing, every malformed
 *      shape — each refusal the exact string), parseAppliedLines /
 *      shellQuote / hashScript / applyScript, resumeJournalScript /
 *      parseResumeJournalOutput (valid / missing / invalid shapes,
 *      strict row↔marker correspondence, markers without a journal
 *      are corrupt; agreeing duplicate rows dedupe and count once,
 *      conflicting duplicates — or a row with rc != 0 — are corrupt),
 *      reconcileResumeCounts (resumed + fresh ==
 *      total; a dropped row or a double-counted row fails),
 *      resumePreScript / parseResumePreOutput +
 *      parseResumePreRecord / formatResumePreRecord (the
 *      replay-robust pin: a second pre-check against a grown
 *      journal returns the persisted count; a stale pin is
 *      overwritten; a torn pin is absent),
 *      resumeTier1SummaryScript / parseResumeTier1SummaryOutput +
 *      parseResumeTier1SummaryRecord (the first completed
 *      invocation's summary wins over a replayed one),
 *      failedSectionsScript / parseFailedSectionsOutput (the
 *      workflow driver's FAILED line and the section-runner
 *      fallback), buildMergeReport's resume rules (a verified
 *      resumed run carries resumedSections as data with zero notes
 *      from the resume path; an unverified resume still names the
 *      skipped sections; a failed section is named with the run
 *      kind; a fallback to fresh is data, never a note).
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
 *      L unparsable manifest (refuses loudly), M driver-shape (a
 *      real merge driven with a fixture Landing authorization lands
 *      with the report carrying it verbatim), N no-authorization
 *      refusal (a real merge driven without one refuses before
 *      writing anything — the scratch live tree is byte-identical
 *      after the refusal, the report carries verdict "failed" with
 *      the missing-authorization note and authorization null),
 *      O H1 happy path (a killed merge resumes: the re-drive carries
 *      the resume dir + the copy forward, its tier-1 starts from the
 *      last completed section, the report records the resumed count
 *      as data, verdict "merged" when clean), P H2a hostile (a
 *      section fails in the resumed run — the merge fails with the
 *      section named and the run kind), Q H2b hostile (a missing or
 *      corrupt resume dir refuses loudly and falls back to a fresh
 *      tier-1, recorded as fresh with the reason), R H2c hostile (a
 *      fresh copy against the carried-forward dir — the fingerprint
 *      refuses, the driver runs a fresh tier-1, recorded as fresh),
 *      S X1a cross-shift (the re-drive is itself killed mid-resume —
 *      the next re-drive resumes from the SAME journal again, the
 *      resume is re-entrant), T X1b cross-shift + G0 guardrails (the
 *      journal's rows span three drives and reconcile exactly —
 *      resumed + fresh == total, no section counted twice, none
 *      dropped, no done section re-run; "merged" only when all
 *      sections green and the independent recount matches),
 *      U lost-result retry (a duplicate agreeing journal row
 *      deduplicates and counts once — the re-drive lands with the
 *      section counted once, no section counted twice).
 *      The resume cases (O–U) run tier-1 against a FAKE run.sh
 *      installed in the scratch live tree (it simulates run.sh's
 *      observable contract: --resume-dir, fingerprint file, journal
 *      + markers, the PASS summary line, skip-on-marker, fingerprint
 *      refusal, kill-after-N and fail-slug hooks) — the scratch
 *      trees have no real suite. A killed drive is simulated by the
 *      fake exiting 143 after N sections: the workflow itself
 *      survives to report "failed" (in production the whole merge
 *      run dies with the kill, which is why the re-drive reads the
 *      killed run from the probe dir's merge-state queue, not from
 *      a report). Typecheck is false in the resume cases — the
 *      scratch trees have no TS project; the typecheck-passed half
 *      of G0 is covered by the §C buildMergeReport checks and by
 *      the lead's real acceptance run.
 *      Every real-merge case carries the fixture authorization in
 *      its input (a real merge without one is refused — decision 1);
 *      the two dry-run cases (B, K) carry none and assert the
 *      report's authorization is null. The full-tier
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
 * - Trap-stdout budget: exec-trap stdout caps at ~60KB (Quality probe:
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
  resumeJournalScript,
  parseResumeJournalOutput,
  reconcileResumeCounts,
  resumePreScript,
  parseResumePreOutput,
  parseResumePreRecord,
  formatResumePreRecord,
  resumeTier1SummaryScript,
  parseResumeTier1SummaryOutput,
  parseResumeTier1SummaryRecord,
  RESUME_PRE_FILE,
  RESUME_TIER1_SUMMARY_FILE,
  failedSectionsScript,
  parseFailedSectionsOutput,
  computeChangedFiles,
  classifyMergeFile,
  buildMergePlan,
  buildMergeReport,
  validateMergeAuthorization,
  MERGE_MISSING_AUTHORIZATION,
  MERGE_MALFORMED_AUTHORIZATION,
  parseAppliedLines,
  shellQuote,
  hashScript,
  applyScript,
  MERGE_BASELINES_PATH,
  MERGE_HOST_PATH,
  MERGE_MANIFEST_NAME,
  MERGE_KNOWN_LIMIT,
  type MergeAuthorization,
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

/** The fixture Landing authorization every real-merge §D case carries
 * in its input (a real merge without one is refused — decision 1).
 * The note is present here so the verbatim-carry checks cover all
 * six fields. */
const FIXTURE_AUTH: MergeAuthorization = {
  authorizer: "LBR",
  authorizedAt: "2026-11-21T22:47:00Z",
  channel: "LBR lead chat (a25045a8-6678-417c-bcae-d1248594384a), direct to the Implementation lead",
  verificationSummary: "copy manifest 1,289, diff exactly the 7 files, leg PASS 42/42, tier-1 60/3,876, Quality PASS",
  expectedNewBaseline: "60 sections / 3,876 OK",
  note: "No Linear issue exists for this change while the workspace is at its free-plan issue limit.",
};

/** Snapshot a tree as path -> sha256 (files only, sorted). Pure
 * fixture helper — case N compares the scratch live tree before
 * and after the refused drive to prove it is byte-identical. */
function treeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        out[path.relative(root, p)] = new Bun.CryptoHasher("sha256").update(fs.readFileSync(p)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
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

/** The fake run.sh for the resume §D cases (O–T): it simulates
 * run.sh's observable contract only — --resume-dir handling, the
 * fingerprint file (sha256 over the live tree, stored on first use,
 * refusal on change), the journal (progress.jsonl + logs/ +
 * .done/), the PASS summary line in parseTierSummaryLine's exact
 * shape, skip-on-marker, and the kill-after-N (FAKE_RUN_KILL_AFTER,
 * exit 143 after N fresh sections), fail-slug
 * (FAKE_RUN_FAIL_SLUG, FAILED line + exit 1), and duplicate-row
 * (FAKE_RUN_DUP_SLUG, a second agreeing section row for one slug —
 * the run-tests lost-result retry shape) hooks. It runs no real
 * tests: 5 sections (resume-a..e), each with a fixed log (2 " OK:"
 * lines + a PASS line) and a marker (ok=2), 10 OK total. Every
 * section it RUNS (fresh) is appended to <resumeDir>/fake-run.log,
 * so the tests can prove no done section was re-run. */
const FAKE_RUN_SH = `#!/bin/sh
# Fake run.sh for test-bra159.ts resume cases (O-T). Contract only.
RESUME_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --resume-dir) RESUME_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$RESUME_DIR" ]; then
  echo "fake run.sh: --resume-dir required" >&2
  exit 2
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LIVE_ROOT=$(dirname "$(dirname "$SCRIPT_DIR")")
JOURNAL="$RESUME_DIR/workflow/tier1/resume"
mkdir -p "$JOURNAL/logs" "$JOURNAL/.done"
FP=$(python3 - "$LIVE_ROOT" <<'PYEOF'
import hashlib, os, sys
root = sys.argv[1]
h = hashlib.sha256()
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for name in sorted(filenames):
        p = os.path.join(dirpath, name)
        h.update(os.path.relpath(p, root).encode())
        with open(p, "rb") as f:
            h.update(hashlib.sha256(f.read()).digest())
print(h.hexdigest())
PYEOF
)
if [ -f "$RESUME_DIR/fingerprint" ]; then
  OLD_FP=$(cat "$RESUME_DIR/fingerprint")
  if [ "$OLD_FP" != "$FP" ]; then
    echo "refusing to resume in $RESUME_DIR: tree fingerprint changed since the resume dir was created" >&2
    exit 1
  fi
else
  echo "$FP" > "$RESUME_DIR/fingerprint"
fi
TS="2026-11-22T00:00:00.000000+00:00"
RAN=0
SKIPPED=0
TOTAL_OK=0
for slug in resume-a resume-b resume-c resume-d resume-e; do
  MARK="$JOURNAL/.done/$slug"
  if [ -f "$MARK" ]; then
    OKS=$(sed -n 's/^ok=//p' "$MARK" | head -1)
    if [ -z "$OKS" ]; then OKS=0; fi
    printf '{"event":"skip","section":"%s","ok":%s,"ts":"%s"}\\n' "$slug" "$OKS" "$TS" >> "$JOURNAL/progress.jsonl"
    SKIPPED=$((SKIPPED + 1))
    TOTAL_OK=$((TOTAL_OK + OKS))
    continue
  fi
  if [ "$FAKE_RUN_FAIL_SLUG" = "$slug" ]; then
    echo "PASS tier 1 (quick) — $((RAN + 1)) sections ran, $TOTAL_OK OK, 0s; skipped $SKIPPED via resume, 0 by tier/selection"
    echo "FAILED: $slug"
    echo "section $slug FAILED (rc=1, 0s) — last 40 lines:" >&2
    exit 1
  fi
  echo "PASS $slug fake section" > "$JOURNAL/logs/$slug.log"
  echo "check one OK: passed" >> "$JOURNAL/logs/$slug.log"
  echo "check two OK: passed" >> "$JOURNAL/logs/$slug.log"
  echo "ok=2" > "$MARK"
  echo "elapsed_s=0" >> "$MARK"
  echo "ts=$TS" >> "$MARK"
  printf '{"event":"section","section":"%s","ok":2,"elapsed_s":0,"rc":0,"ts":"%s"}\\n' "$slug" "$TS" >> "$JOURNAL/progress.jsonl"
  if [ "$FAKE_RUN_DUP_SLUG" = "$slug" ]; then
    printf '{"event":"section","section":"%s","ok":2,"elapsed_s":0,"rc":0,"ts":"%s"}\\n' "$slug" "$TS" >> "$JOURNAL/progress.jsonl"
  fi
  echo "RUN $slug" >> "$RESUME_DIR/fake-run.log"
  RAN=$((RAN + 1))
  TOTAL_OK=$((TOTAL_OK + 2))
  if [ -n "$FAKE_RUN_KILL_AFTER" ] && [ "$RAN" -eq "$FAKE_RUN_KILL_AFTER" ]; then
    exit 143
  fi
done
echo "PASS tier 1 (quick) — $RAN sections ran, $TOTAL_OK OK, 0s; skipped $SKIPPED via resume, 0 by tier/selection"
exit 0
`;

/** Install the fake run.sh in a scratch live tree (executable). */
function installFakeRunSh(liveRoot: string): void {
  const p = path.join(liveRoot, "apps", "agentts", "run.sh");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, FAKE_RUN_SH);
  fs.chmodSync(p, 0o755);
}

/** The fake tier-1's section list, in order. */
const FAKE_SECTIONS = ["resume-a", "resume-b", "resume-c", "resume-d", "resume-e"];

/** progress.jsonl rows for a resume dir ([] when the journal is
 * absent — a missing journal, not a throw). */
function journalRows(resumeDir: string): Array<Record<string, any>> {
  const text = read(path.join(resumeDir, "workflow", "tier1", "resume", "progress.jsonl"));
  if (text === null) return [];
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, any>);
}

/** Slugs with a `section`-event row (the verified resumed/fresh
 * sections), in journal order. */
function sectionSlugs(resumeDir: string): string[] {
  return journalRows(resumeDir).filter((r) => r.event === "section").map((r) => r.section as string);
}

/** Slugs the fake run.sh actually RAN (its fake-run.log), in order. */
function fakeRanSlugs(resumeDir: string): string[] {
  const text = read(path.join(resumeDir, "fake-run.log"));
  if (text === null) return [];
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => l.replace(/^RUN /, ""));
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
      check(merged.authorization === null, `REPORT OK: a report built without an authorization carries null (got ${JSON.stringify(merged.authorization)})`);
      check("authorization" in merged, `REPORT OK: the authorization field is present even when null`);
      // With an authorization: carried verbatim into the report.
      const mergedWithAuth = buildMergeReport({
        mergeId: "BRA-159",
        authorization: FIXTURE_AUTH,
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
      check(JSON.stringify(mergedWithAuth.authorization) === JSON.stringify(FIXTURE_AUTH),
        `REPORT OK: an authorization is carried verbatim (got ${JSON.stringify(mergedWithAuth.authorization)})`);
      check(mergedWithAuth.verdict === "merged" && mergedWithAuth.notes.length === 0,
        `REPORT OK: carrying an authorization changes nothing else (got ${mergedWithAuth.verdict}: ${JSON.stringify(mergedWithAuth.notes)})`);
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
      check(resumed.resumedSections === 0 && resumed.resumeFallback === null,
        `REPORT OK: an unverified resumed run defaults resumedSections 0, resumeFallback null (got ${resumed.resumedSections}, ${JSON.stringify(resumed.resumeFallback)})`);
      // A VERIFIED resumed run: the same suite shape, but the journal
      // proved 2 resumed sections — the count is data, never a note.
      const verifiedResumed = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "merged",
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
        suite: fakeSuite({ skippedViaResume: 2, summaryMatchesIndependent: true }),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
        resumedSections: 2,
      });
      check(verifiedResumed.notes.length === 0,
        `REPORT OK: a verified resumed run has zero notes from the resume path (got ${JSON.stringify(verifiedResumed.notes)})`);
      check(verifiedResumed.resumedSections === 2 && verifiedResumed.resumeFallback === null,
        `REPORT OK: a verified resumed run carries resumedSections 2 as data (got ${verifiedResumed.resumedSections}, ${JSON.stringify(verifiedResumed.resumeFallback)})`);
      // A failed section in a resumed run is named with the run kind;
      // without labels the note is byte-identical to the old one.
      const failedResumed = buildMergeReport({
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
        suite: fakeSuite({ allPassed: false, sectionsRan: 3, totalOk: 6, summaryMatchesIndependent: false }),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
        resumedSections: 2,
        failedSectionLabels: ["resume-d (resumed run)"],
      });
      check(failedResumed.notes.some((n) => /failed sections: resume-d \(resumed run\)/.test(n)),
        `REPORT OK: a failed section is named with the run kind (got ${JSON.stringify(failedResumed.notes)})`);
      const failedUnlabeled = buildMergeReport({
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
        suite: fakeSuite({ allPassed: false, sectionsRan: 3, totalOk: 6, summaryMatchesIndependent: false }),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
      });
      check(failedUnlabeled.notes.some((n) => n === "suite did not pass cleanly: 3 sections ran, 6 OK, allPassed=false — the tree was already merged"),
        `REPORT OK: without labels the suite-failure note is byte-identical (got ${JSON.stringify(failedUnlabeled.notes)})`);
      // A fallback to fresh is data, never a note.
      const fallbackFresh = buildMergeReport({
        mergeId: "BRA-159",
        verdict: "merged",
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
        suite: fakeSuite({ summaryMatchesIndependent: true }),
        baseline: fakeBaseline(),
        manifestCopiedAt: "2026-11-20T20:05:25Z",
        resumedSections: 0,
        resumeFallback: "carried-forward resume dir has no progress.jsonl — ran a fresh tier-1 instead",
      });
      check(fallbackFresh.notes.length === 0 && fallbackFresh.resumeFallback !== null,
        `REPORT OK: a fallback to fresh is data with zero notes (got ${JSON.stringify(fallbackFresh.notes)}, ${JSON.stringify(fallbackFresh.resumeFallback)})`);

      // resumeJournalScript shape + parseResumeJournalOutput.
      const rjs = resumeJournalScript("/w/resume/workflow/tier1/resume");
      check(rjs.includes("python3 - '/w/resume/workflow/tier1/resume'") && rjs.includes("progress.jsonl") && rjs.includes(".done") && rjs.includes("print('valid %d %d'") && rjs.includes("print('missing')") && rjs.includes("<<'PYEOF'"),
        `RESUME OK: journal script shape (valid/missing/invalid, one bounded line)`);
      const jValid = parseResumeJournalOutput("valid 3 5\n");
      check(jValid.status === "valid" && jValid.resumed === 3 && jValid.rows === 5 && jValid.reason === null,
        `RESUME OK: "valid 3 5" parses (got ${JSON.stringify(jValid)})`);
      const jEmpty = parseResumeJournalOutput("valid 0 0\n");
      check(jEmpty.status === "valid" && jEmpty.resumed === 0 && jEmpty.rows === 0,
        `RESUME OK: an empty-but-present journal is valid with 0 resumed`);
      const jMissing = parseResumeJournalOutput("missing\n");
      check(jMissing.status === "missing" && jMissing.resumed === 0 && jMissing.rows === 0,
        `RESUME OK: "missing" parses (got ${JSON.stringify(jMissing)})`);
      const jInvalid = parseResumeJournalOutput("invalid: section row without .done marker: bra123\n");
      check(jInvalid.status === "invalid" && jInvalid.reason === "section row without .done marker: bra123",
        `RESUME OK: "invalid: <reason>" parses with the reason (got ${JSON.stringify(jInvalid)})`);
      check(parseResumeJournalOutput("").status === "invalid" && parseResumeJournalOutput("garbage\n").status === "invalid",
        `RESUME OK: empty or unrecognized journal output is invalid, never a crash`);
      // resumeJournalScript EXECUTED against fixture journals: an
      // agreeing duplicate row deduplicates and counts once (the
      // run-tests lost-result retry shape — the staged leg's drive 1
      // journal holds two agreeing checker rows and validates at
      // resumed 67); a conflicting duplicate, or a row with rc != 0,
      // is corrupt. rows counts unique section rows, not skip rows.
      const runJournalScript = (dir: string): ReturnType<typeof parseResumeJournalOutput> => {
        const r = spawnSync("sh", ["-c", resumeJournalScript(dir)], { encoding: "utf8" });
        return parseResumeJournalOutput(r.stdout ?? "");
      };
      const writeJournalFixture = (name: string, rows: Array<Record<string, unknown>>, markers: string[]): string => {
        const dir = path.join(WORKDIR, "cases", "journal-" + name);
        fs.mkdirSync(path.join(dir, ".done"), { recursive: true });
        fs.writeFileSync(path.join(dir, "progress.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
        for (const m of markers) fs.writeFileSync(path.join(dir, ".done", m), "ok=2\n");
        return dir;
      };
      const sectionRow = (slug: string, ok: number, rc = 0): Record<string, unknown> =>
        ({ event: "section", section: slug, ok, elapsed_s: 0, rc, ts: "2026-11-22T00:00:00.000000+00:00" });
      const dupAgree = runJournalScript(writeJournalFixture("dup-agree",
        [sectionRow("resume-a", 2), sectionRow("resume-b", 2), sectionRow("resume-b", 2)], ["resume-a", "resume-b"]));
      check(dupAgree.status === "valid" && dupAgree.resumed === 2 && dupAgree.rows === 2,
        `RESUME OK: agreeing duplicate rows dedupe — valid, resumed 2 (got ${JSON.stringify(dupAgree)})`);
      const dupConflict = runJournalScript(writeJournalFixture("dup-conflict",
        [sectionRow("resume-a", 2), sectionRow("resume-a", 3)], ["resume-a"]));
      check(dupConflict.status === "invalid" && dupConflict.reason === "duplicate section row: resume-a",
        `RESUME OK: conflicting duplicate rows are corrupt (got ${JSON.stringify(dupConflict)})`);
      const dupRc = runJournalScript(writeJournalFixture("dup-rc",
        [sectionRow("resume-a", 2), sectionRow("resume-a", 2, 1)], ["resume-a"]));
      check(dupRc.status === "invalid" && dupRc.reason === "section row with rc != 0: resume-a",
        `RESUME OK: a duplicate row with rc != 0 is corrupt (got ${JSON.stringify(dupRc)})`);
      const withSkips = runJournalScript(writeJournalFixture("with-skips",
        [sectionRow("resume-a", 2), sectionRow("resume-b", 2),
          { event: "skip", section: "resume-a", ok: 2, ts: "2026-11-22T00:00:00.000000+00:00" }], ["resume-a", "resume-b"]));
      check(withSkips.status === "valid" && withSkips.resumed === 2 && withSkips.rows === 2,
        `RESUME OK: rows counts unique section rows, not skip rows (got ${JSON.stringify(withSkips)})`);
      // reconcileResumeCounts: resumed + fresh == total.
      check(reconcileResumeCounts({ resumedPre: 2, resumedPost: 5, sectionsRan: 5 }) === true,
        `RESUME OK: resumed 2 + fresh 3 == total 5 reconciles`);
      check(reconcileResumeCounts({ resumedPre: 0, resumedPost: 5, sectionsRan: 5 }) === true,
        `RESUME OK: a fresh run (resumed 0) reconciles`);
      check(reconcileResumeCounts({ resumedPre: 2, resumedPost: 4, sectionsRan: 5 }) === false,
        `RESUME OK: a dropped row (resumed 2, post 4, total 5) does not reconcile`);
      check(reconcileResumeCounts({ resumedPre: 2, resumedPost: 6, sectionsRan: 5 }) === false,
        `RESUME OK: a double-counted row (resumed 2, post 6, total 5) does not reconcile`);
      // Replay-robust pins (fix round): the engine may re-execute
      // the workflow after the tier-1 has grown the journal, so the
      // pre-check count and the first invocation's summary are
      // pinned at the resume dir's top level with the journal
      // lineage (first N lines, sha256). A second pre-check
      // against a grown journal returns the persisted count; a
      // stale pin (a different journal) is overwritten; a torn
      // pin is treated as absent. Executed against fixture
      // journals (the real scripts, via sh), not just the parsers.
      const rps = resumePreScript({ resumeDir: "/w/resume", journalDir: "/w/resume/workflow/tier1/resume", resumed: 3, mergeId: "RUN-1", workDir: "/w/work-1" });
      check(rps.includes("python3 - '/w/resume'") && rps.includes("'/w/resume/workflow/tier1/resume'") && rps.includes("'/w/work-1'") && rps.includes(RESUME_PRE_FILE) && rps.includes("print('pinned %d'") && rps.includes("print('reused %d'") && rps.includes("print('missing')") && rps.includes("<<'PYEOF'"),
        `RESUME OK: resume-pre script shape (pin/reuse/missing, atomic write, lineage hash, run key)`);
      check(parseResumePreOutput("pinned 3\n").action === "pinned" && parseResumePreOutput("pinned 3\n").resumed === 3,
        `RESUME OK: "pinned 3" parses (got ${JSON.stringify(parseResumePreOutput("pinned 3\n"))})`);
      check(parseResumePreOutput("reused 3\n").action === "reused" && parseResumePreOutput("reused 3\n").resumed === 3,
        `RESUME OK: "reused 3" parses (got ${JSON.stringify(parseResumePreOutput("reused 3\n"))})`);
      check(parseResumePreOutput("missing\n").action === "missing",
        `RESUME OK: "missing" parses as a missing pin`);
      check(parseResumePreOutput("").action === "invalid" && parseResumePreOutput("garbage\n").action === "invalid",
        `RESUME OK: empty or unrecognized pin output is invalid, never a crash`);
      const preRecord = { resumed: 3, lines: 3, journalHash: "a".repeat(64), mergeId: "RUN-1", workDir: "/w/work-1" };
      check(JSON.stringify(parseResumePreRecord(formatResumePreRecord(preRecord))) === JSON.stringify(preRecord),
        `RESUME OK: resume-pre record round-trips through format/parse`);
      check(parseResumePreRecord("") === null && parseResumePreRecord("not json") === null && parseResumePreRecord(JSON.stringify({ resumed: 3 })) === null && parseResumePreRecord(JSON.stringify({ resumed: -1, lines: 3, journalHash: "a".repeat(64), mergeId: "RUN-1", workDir: "/w/work-1" })) === null && parseResumePreRecord(JSON.stringify({ resumed: 3, lines: 3, journalHash: "xyz", mergeId: "RUN-1", workDir: "/w/work-1" })) === null && parseResumePreRecord(JSON.stringify({ resumed: 3, lines: 3, journalHash: "a".repeat(64) })) === null,
        `RESUME OK: a malformed resume-pre record parses to null, never a crash`);
      const runPreScript = (resumeDir: string, journalDir: string, resumed: number, mergeId = "RUN-1", workDir = "/w/work-1") => {
        const r = spawnSync("sh", ["-c", resumePreScript({ resumeDir, journalDir, resumed, mergeId, workDir })], { encoding: "utf8" });
        return parseResumePreOutput(r.stdout ?? "");
      };
      // Replay case: pin at 3 sections, grow the journal to 67
      // (the same first 3 lines + 64 more, as a re-executed
      // pre-check sees it after the tier-1 completes) — the second
      // pre-check returns the persisted 3, not 67.
      const pinResumeDir = path.join(WORKDIR, "cases", "pin-replay");
      const pinJournalDir = path.join(pinResumeDir, "journal");
      fs.mkdirSync(path.join(pinJournalDir, ".done"), { recursive: true });
      const pinRows = [sectionRow("pin-a", 2), sectionRow("pin-b", 2), sectionRow("pin-c", 2)];
      fs.writeFileSync(path.join(pinJournalDir, "progress.jsonl"), pinRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      for (const m of ["pin-a", "pin-b", "pin-c"]) fs.writeFileSync(path.join(pinJournalDir, ".done", m), "ok=2\n");
      const pinFirst = runPreScript(pinResumeDir, pinJournalDir, 3);
      check(pinFirst.action === "pinned" && pinFirst.resumed === 3,
        `RESUME OK: first pre-check pins the killed run's count 3 (got ${JSON.stringify(pinFirst)})`);
      const pinOnDisk = parseResumePreRecord(fs.readFileSync(path.join(pinResumeDir, RESUME_PRE_FILE), "utf8"));
      check(pinOnDisk !== null && pinOnDisk.resumed === 3 && pinOnDisk.lines === 3,
        `RESUME OK: the pin file records resumed 3 over 3 lines (got ${JSON.stringify(pinOnDisk)})`);
      for (let i = 0; i < 64; i++) {
        const slug = "pin-grow-" + String(i).padStart(2, "0");
        fs.appendFileSync(path.join(pinJournalDir, "progress.jsonl"), JSON.stringify(sectionRow(slug, 2)) + "\n");
        fs.writeFileSync(path.join(pinJournalDir, ".done", slug), "ok=2\n");
      }
      const pinSecond = runPreScript(pinResumeDir, pinJournalDir, 67);
      check(pinSecond.action === "reused" && pinSecond.resumed === 3,
        `RESUME OK: second pre-check against the grown 67-section journal returns the persisted 3 (got ${JSON.stringify(pinSecond)})`);
      const pinStill = parseResumePreRecord(fs.readFileSync(path.join(pinResumeDir, RESUME_PRE_FILE), "utf8"));
      check(pinStill !== null && pinStill.resumed === 3,
        `RESUME OK: the replay does not overwrite the pin (still resumed 3, got ${JSON.stringify(pinStill)})`);
      // A NEW drive (a different run key) against the same grown
      // journal derives fresh from it — the journal legitimately
      // accumulated since the last drive — and overwrites the pin.
      // This is the §D X1a shape: drive 3 pins 3 where drive 2
      // pinned 2.
      const pinNewDrive = runPreScript(pinResumeDir, pinJournalDir, 67, "RUN-2", "/w/work-2");
      check(pinNewDrive.action === "pinned" && pinNewDrive.resumed === 67,
        `RESUME OK: a new drive derives fresh from the grown journal (pinned 67, got ${JSON.stringify(pinNewDrive)})`);
      const pinNew = parseResumePreRecord(fs.readFileSync(path.join(pinResumeDir, RESUME_PRE_FILE), "utf8"));
      check(pinNew !== null && pinNew.resumed === 67 && pinNew.mergeId === "RUN-2",
        `RESUME OK: the new drive's pin carries its own run key (got ${JSON.stringify(pinNew && pinNew.mergeId)})`);
      // Stale pin: a different journal (different first lines)
      // overwrites the pin with the current count.
      const staleResumeDir = path.join(WORKDIR, "cases", "pin-stale");
      const staleJournalDir = path.join(staleResumeDir, "journal");
      fs.mkdirSync(path.join(staleJournalDir, ".done"), { recursive: true });
      fs.writeFileSync(path.join(staleJournalDir, "progress.jsonl"), [sectionRow("pin-a", 2), sectionRow("pin-b", 2), sectionRow("pin-c", 2)].map((r) => JSON.stringify(r)).join("\n") + "\n");
      for (const m of ["pin-a", "pin-b", "pin-c"]) fs.writeFileSync(path.join(staleJournalDir, ".done", m), "ok=2\n");
      runPreScript(staleResumeDir, staleJournalDir, 3);
      fs.writeFileSync(path.join(staleJournalDir, "progress.jsonl"), [sectionRow("other-a", 9), sectionRow("other-b", 9)].map((r) => JSON.stringify(r)).join("\n") + "\n");
      const staleSecond = runPreScript(staleResumeDir, staleJournalDir, 2);
      check(staleSecond.action === "pinned" && staleSecond.resumed === 2,
        `RESUME OK: a stale pin (different journal lineage) is overwritten with the current count (got ${JSON.stringify(staleSecond)})`);
      // Torn pin: unparsable JSON is treated as absent.
      fs.writeFileSync(path.join(pinResumeDir, RESUME_PRE_FILE), "{torn json");
      const tornSecond = runPreScript(pinResumeDir, pinJournalDir, 67);
      check(tornSecond.action === "pinned" && tornSecond.resumed === 67,
        `RESUME OK: a torn pin file is treated as absent and re-pinned (got ${JSON.stringify(tornSecond)})`);
      // Tier-1 summary pin: the first completed invocation's
      // summary wins over a replayed invocation's summary (0 ran,
      // all skipped after the journal completes).
      const firstLine = "PASS tier 1 (quick) — 11 sections ran, 4923 OK, 600s; skipped 56 via resume, 35 by tier/selection";
      const replayLine = "PASS tier 1 (quick) — 0 sections ran, 4923 OK, 9s; skipped 67 via resume, 35 by tier/selection";
      const rtss = resumeTier1SummaryScript({ resumeDir: "/w/resume", journalDir: "/w/resume/workflow/tier1/resume", mergeId: "RUN-1", workDir: "/w/work-1", summary: { sectionsRan: 11, skippedViaResume: 56, ok: 4923, summaryLine: firstLine } });
      check(rtss.includes("python3 - '/w/resume'") && rtss.includes(RESUME_TIER1_SUMMARY_FILE) && rtss.includes("print('pinned %d %d %d %s'") && rtss.includes("print('reused %d %d %d %s'") && rtss.includes("print('none')") && rtss.includes("<<'PYEOF'"),
        `RESUME OK: tier-1 summary pin script shape (pin/reuse/none, atomic write, lineage hash)`);
      check(parseResumeTier1SummaryOutput("pinned 11 56 4923 " + firstLine + "\n").action === "pinned",
        `RESUME OK: "pinned 11 56 4923 <line>" parses`);
      const reuseParsed = parseResumeTier1SummaryOutput("reused 11 56 4923 " + firstLine + "\n");
      check(reuseParsed.action === "reused" && reuseParsed.summary !== null && reuseParsed.summary.sectionsRan === 11 && reuseParsed.summary.skippedViaResume === 56 && reuseParsed.summary.ok === 4923 && reuseParsed.summary.summaryLine === firstLine,
        `RESUME OK: "reused 11 56 4923 <line>" parses with the pinned line (got ${JSON.stringify(reuseParsed.summary)})`);
      check(parseResumeTier1SummaryOutput("none\n").action === "none" && parseResumeTier1SummaryOutput("missing\n").action === "missing" && parseResumeTier1SummaryOutput("").action === "invalid",
        `RESUME OK: summary pin none/missing/invalid parse`);
      const summaryRecord = { sectionsRan: 11, skippedViaResume: 56, ok: 4923, summaryLine: firstLine, lines: 67, journalHash: "b".repeat(64), mergeId: "RUN-1", workDir: "/w/work-1" };
      check(JSON.stringify(parseResumeTier1SummaryRecord(JSON.stringify(summaryRecord))) === JSON.stringify(summaryRecord),
        `RESUME OK: tier-1 summary record round-trips through parse`);
      check(parseResumeTier1SummaryRecord("") === null && parseResumeTier1SummaryRecord(JSON.stringify({ sectionsRan: 11 })) === null,
        `RESUME OK: a malformed tier-1 summary record parses to null`);
      const runSummaryScript = (resumeDir: string, journalDir: string, summary: { sectionsRan: number; skippedViaResume: number; ok: number; summaryLine: string } | null, mergeId = "RUN-1", workDir = "/w/work-1") => {
        const r = spawnSync("sh", ["-c", resumeTier1SummaryScript({ resumeDir, journalDir, mergeId, workDir, summary })], { encoding: "utf8" });
        return parseResumeTier1SummaryOutput(r.stdout ?? "");
      };
      const sumResumeDir = path.join(WORKDIR, "cases", "pin-summary");
      const sumJournalDir = path.join(sumResumeDir, "journal");
      fs.mkdirSync(path.join(sumJournalDir, ".done"), { recursive: true });
      fs.writeFileSync(path.join(sumJournalDir, "progress.jsonl"), pinRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      for (const m of ["pin-a", "pin-b", "pin-c"]) fs.writeFileSync(path.join(sumJournalDir, ".done", m), "ok=2\n");
      const sumFirst = runSummaryScript(sumResumeDir, sumJournalDir, { sectionsRan: 11, skippedViaResume: 56, ok: 4923, summaryLine: firstLine });
      check(sumFirst.action === "pinned" && sumFirst.summary !== null && sumFirst.summary.skippedViaResume === 56,
        `RESUME OK: first completed invocation pins its summary (11 ran, 56 skipped) (got ${JSON.stringify(sumFirst.summary)})`);
      for (let i = 0; i < 64; i++) {
        const slug = "pin-grow-" + String(i).padStart(2, "0");
        fs.appendFileSync(path.join(sumJournalDir, "progress.jsonl"), JSON.stringify(sectionRow(slug, 2)) + "\n");
        fs.writeFileSync(path.join(sumJournalDir, ".done", slug), "ok=2\n");
      }
      const sumReplay = runSummaryScript(sumResumeDir, sumJournalDir, { sectionsRan: 0, skippedViaResume: 67, ok: 4923, summaryLine: replayLine });
      check(sumReplay.action === "reused" && sumReplay.summary !== null && sumReplay.summary.skippedViaResume === 56 && sumReplay.summary.summaryLine === firstLine,
        `RESUME OK: replayed invocation reuses the first summary (56 skipped, first line) (got ${JSON.stringify(sumReplay.summary)})`);
      const sumNone = runSummaryScript(sumResumeDir, sumJournalDir, null);
      check(sumNone.action === "none",
        `RESUME OK: an invocation with no summary pins nothing (got ${JSON.stringify(sumNone)})`);
      const sumStill = parseResumeTier1SummaryRecord(fs.readFileSync(path.join(sumResumeDir, RESUME_TIER1_SUMMARY_FILE), "utf8"));
      check(sumStill !== null && sumStill.skippedViaResume === 56 && sumStill.summaryLine === firstLine,
        `RESUME OK: the no-summary invocation keeps the first summary pin (got ${JSON.stringify(sumStill && sumStill.summaryLine)})`);
      // A NEW drive pins its own summary (its own run key).
      const sumNewDrive = runSummaryScript(sumResumeDir, sumJournalDir, { sectionsRan: 0, skippedViaResume: 67, ok: 4923, summaryLine: replayLine }, "RUN-2", "/w/work-2");
      check(sumNewDrive.action === "pinned" && sumNewDrive.summary !== null && sumNewDrive.summary.skippedViaResume === 67 && sumNewDrive.summary.summaryLine === replayLine,
        `RESUME OK: a new drive pins its own summary (67 skipped, replay line) (got ${JSON.stringify(sumNewDrive.summary)})`);
      // failedSectionsScript shape + parseFailedSectionsOutput.
      const fss = failedSectionsScript("/w/tier1.out");
      check(fss.includes("grep -E '^FAILED: |^section [^ ]+ FAILED'") && fss.includes("'/w/tier1.out'") && fss.includes("tail -5"),
        `RESUME OK: failed-sections script shape (bounded, both drivers)`);
      check(JSON.stringify(parseFailedSectionsOutput("FAILED: resume-d, resume-e\n")) === JSON.stringify(["resume-d", "resume-e"]),
        `RESUME OK: the FAILED line parses to slugs`);
      check(JSON.stringify(parseFailedSectionsOutput("section resume-d FAILED (rc=1, 0s)\n")) === JSON.stringify(["resume-d"]),
        `RESUME OK: the section FAILED fallback parses to the slug`);
      check(JSON.stringify(parseFailedSectionsOutput("FAILED: resume-d\nsection resume-d FAILED (rc=1, 0s)\n")) === JSON.stringify(["resume-d"]),
        `RESUME OK: a slug named twice deduplicates`);
      check(parseFailedSectionsOutput("").length === 0,
        `RESUME OK: no failure output parses to no slugs`);
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
      check(dry.authorization === null && "authorization" in dry,
        `REPORT OK: a dry-run report without an authorization carries null, field present (got ${JSON.stringify(dry.authorization)})`);
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

      // validateMergeAuthorization: valid, missing, every malformed
      // shape — each refusal is the exact string, asserted verbatim.
      check(validateMergeAuthorization(FIXTURE_AUTH) === null,
        `AUTH OK: the fixture authorization validates (got ${JSON.stringify(validateMergeAuthorization(FIXTURE_AUTH))})`);
      const { note: _droppedNote, ...noNote } = FIXTURE_AUTH;
      check(validateMergeAuthorization(noNote) === null,
        `AUTH OK: an authorization without the optional note validates`);
      check(validateMergeAuthorization({ ...FIXTURE_AUTH, channel: "", verificationSummary: "", expectedNewBaseline: "" }) === null,
        `AUTH OK: empty channel / verificationSummary / expectedNewBaseline validate (a terse authorization is still an authorization)`);
      check(validateMergeAuthorization(undefined) === MERGE_MISSING_AUTHORIZATION,
        `AUTH OK: undefined is the missing-authorization refusal, verbatim`);
      check(validateMergeAuthorization(null) === MERGE_MISSING_AUTHORIZATION,
        `AUTH OK: null is the missing-authorization refusal, verbatim`);
      const malformed: [string, unknown][] = [
        ["a string", "Landing"],
        ["a number", 42],
        ["an array", [FIXTURE_AUTH]],
        ["an empty object", {}],
        ["missing authorizer", { authorizedAt: "2026-11-21T22:47:00Z", channel: "", verificationSummary: "", expectedNewBaseline: "" }],
        ["empty authorizer", { ...FIXTURE_AUTH, authorizer: "" }],
        ["non-string authorizer", { ...FIXTURE_AUTH, authorizer: 42 }],
        ["missing authorizedAt", { authorizer: "LBR", channel: "", verificationSummary: "", expectedNewBaseline: "" }],
        ["empty authorizedAt", { ...FIXTURE_AUTH, authorizedAt: "" }],
        ["non-string authorizedAt", { ...FIXTURE_AUTH, authorizedAt: 42 }],
        ["non-string channel", { ...FIXTURE_AUTH, channel: 42 }],
        ["non-string verificationSummary", { ...FIXTURE_AUTH, verificationSummary: null }],
        ["non-string expectedNewBaseline", { ...FIXTURE_AUTH, expectedNewBaseline: 42 }],
        ["non-string note", { ...FIXTURE_AUTH, note: 42 }],
      ];
      for (const [label, value] of malformed) {
        check(validateMergeAuthorization(value) === MERGE_MALFORMED_AUTHORIZATION,
          `AUTH OK: ${label} is the malformed-authorization refusal, verbatim (got ${JSON.stringify(validateMergeAuthorization(value))})`);
      }
      check(MERGE_MISSING_AUTHORIZATION === "merge: no Landing authorization in the run input — landings go through Landing first",
        `AUTH OK: the missing-authorization string is the brief's string, verbatim`);
      check(MERGE_MALFORMED_AUTHORIZATION.startsWith("merge: malformed Landing authorization in the run input — "),
        `AUTH OK: the malformed-authorization string names the rule`);

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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
      });
      if (out) {
        check(out.verdict === "merged", `A verdict merged (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.authorization) === JSON.stringify(FIXTURE_AUTH), `A authorization carried verbatim (got ${JSON.stringify(out.authorization)})`);
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
        check(out.authorization === null, `B dry-run without an authorization carries null (got ${JSON.stringify(out.authorization)})`);
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
      });
      if (out) {
        check(out.verdict === "merged", `H verdict merged (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.authorization) === JSON.stringify(FIXTURE_AUTH), `H authorization carried verbatim (got ${JSON.stringify(out.authorization)})`);
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
          typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
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
        check(out.authorization === null, `K dry-run without an authorization carries null (got ${JSON.stringify(out.authorization)})`);
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
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
      });
      if (out) {
        check(out.verdict === "failed", `L verdict failed (got ${out.verdict})`);
        check(out.notes.some((n: string) => /manifest unparsable/.test(n)), `L manifest-unparsable note (got ${JSON.stringify(out.notes)})`);
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 base\n", "L live file1 unchanged");
      }
    }

    // ---- Case M: driver-shape — a real merge driven with a fixture
    // Landing authorization in the input lands with the report carrying
    // it verbatim (this is what the lead's landing driver does: it
    // passes the authorization Landing sent it as workflow input).
    {
      const { live, copy } = buildCase("M-auth", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
      });
      const out = driveRun("run-bra159-M", {
        mergeId: "BRA-159-M", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "M-auth", "work"),
        resumeDir: path.join(WORKDIR, "cases", "M-auth", "resume"),
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: false, authorization: FIXTURE_AUTH,
      });
      if (out) {
        check(out.verdict === "merged", `M verdict merged (got ${out.verdict}: ${JSON.stringify(out.notes)})`);
        check(JSON.stringify(out.authorization) === JSON.stringify(FIXTURE_AUTH), `M authorization carried verbatim (got ${JSON.stringify(out.authorization)})`);
        check(JSON.stringify(out.applied) === JSON.stringify(["apps/agentts/workflows/library/file1.ts"]), `M applied [file1] (got ${JSON.stringify(out.applied)})`);
        check(read(path.join(live, "apps/agentts/workflows/library/file1.ts")) === "// file1 CHANGED\n", "M live file1 has the copy content");
      }
    }

    // ---- Case N: no-authorization refusal — a real merge driven
    // without an authorization refuses before the diff step, before
    // writing anything. The scratch live tree is byte-identical
    // after the refusal (snapshot before vs after the drive), the
    // report carries verdict "failed" with the missing-authorization
    // note verbatim, and authorization null.
    {
      const { live, copy } = buildCase("N-noauth", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file2.ts"), "// file2 new\n");
        fs.rmSync(path.join(copy, "apps/agentts/workflows/library/file3.ts"));
      });
      const before = treeSnapshot(live);
      const out = driveRun("run-bra159-N", {
        mergeId: "BRA-159-N", copyRoot: copy, liveRoot: live,
        workDir: path.join(WORKDIR, "cases", "N-noauth", "work"),
        resumeDir: path.join(WORKDIR, "cases", "N-noauth", "resume"),
        claimedFiles: [
          "apps/agentts/workflows/library/file1.ts",
          "apps/agentts/workflows/library/file2.ts",
          "apps/agentts/workflows/library/file3.ts",
        ],
        typecheck: false, runTier1: false,
      });
      if (out) {
        check(out.verdict === "failed", `N verdict failed (got ${out.verdict})`);
        check(JSON.stringify(out.notes) === JSON.stringify([MERGE_MISSING_AUTHORIZATION]),
          `N missing-authorization note, verbatim and alone (got ${JSON.stringify(out.notes)})`);
        check(out.authorization === null, `N authorization null (got ${JSON.stringify(out.authorization)})`);
        check(out.applied.length === 0 && out.deleted.length === 0, "N applied/deleted empty");
        check(JSON.stringify(treeSnapshot(live)) === JSON.stringify(before),
          "N scratch live tree byte-identical after the refusal");
      }
    }

    // ---- Case O (H1 happy path): a killed merge resumes. Drive 1
    // runs the fake tier-1 with the kill hook after 2 sections: the
    // workflow reports "failed" (its tier-1 died) and the journal
    // holds exactly 2 section rows + markers. Drive 2 re-drives the
    // SAME copyRoot + resumeDir with carryForwardResume: its tier-1
    // skips the 2 done sections, runs the remaining 3, and the report
    // records resumedSections 2 as data with verdict "merged".
    {
      const { live, copy } = buildCase("O-h1", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        installFakeRunSh(live);
      });
      const resumeDir = path.join(WORKDIR, "cases", "O-h1", "resume");
      const workDir = path.join(WORKDIR, "cases", "O-h1", "work");
      process.env.FAKE_RUN_KILL_AFTER = "2";
      const d1 = driveRun("run-bra159-O-D1", {
        mergeId: "BRA-159-O-D1", copyRoot: copy, liveRoot: live,
        workDir, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      if (d1) {
        check(d1.verdict === "failed", `O drive 1 verdict failed (the fake tier-1 was killed) (got ${d1.verdict}: ${JSON.stringify(d1.notes)})`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b"]),
          `O drive 1 journal holds exactly the 2 completed sections (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(JSON.stringify(fakeRanSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b"]),
          `O drive 1 fake ran exactly the 2 completed sections`);
      }
      const d2 = driveRun("run-bra159-O-D2", {
        mergeId: "BRA-159-O-D2", copyRoot: copy, liveRoot: live,
        workDir, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        baseline: { sections: 5, ok: 10, label: "fake tier-1 (5 sections / 10 OK)" },
        authorization: FIXTURE_AUTH,
      });
      if (d2) {
        check(d2.verdict === "merged", `O drive 2 verdict merged (got ${d2.verdict}: ${JSON.stringify(d2.notes)})`);
        check(d2.resumedSections === 2, `O drive 2 resumedSections 2 as data (got ${d2.resumedSections})`);
        check(d2.resumeFallback === null, `O drive 2 resumeFallback null (got ${JSON.stringify(d2.resumeFallback)})`);
        check(d2.notes.length === 0, `O drive 2 zero notes (got ${JSON.stringify(d2.notes)})`);
        check(d2.suite.sectionsRan === 5 && d2.suite.totalOk === 10, `O drive 2 suite 5 sections / 10 OK (got ${d2.suite.sectionsRan} / ${d2.suite.totalOk})`);
        check(d2.suite.skippedViaResume === 2, `O drive 2 skippedViaResume 2 (got ${d2.suite.skippedViaResume})`);
        check(d2.suite.allPassed === true && d2.suite.summaryMatchesIndependent === true, `O drive 2 allPassed + summaryMatchesIndependent`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(FAKE_SECTIONS),
          `O journal reconciles: all 5 sections, in order (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(JSON.stringify(fakeRanSlugs(resumeDir)) === JSON.stringify(FAKE_SECTIONS),
          `O no done section re-run: each section ran exactly once across both drives (got ${JSON.stringify(fakeRanSlugs(resumeDir))})`);
        check(JSON.stringify(d2.applied) === JSON.stringify([]) && JSON.stringify(d2.alreadyApplied) === JSON.stringify(["apps/agentts/workflows/library/file1.ts"]),
          `O drive 2 apply is a no-op (already applied by drive 1) (got applied ${JSON.stringify(d2.applied)}, alreadyApplied ${JSON.stringify(d2.alreadyApplied)})`);
      }
    }

    // ---- Case P (H2a hostile): a section fails in the resumed run.
    // Drive 1 kills after 2 sections; drive 2 resumes and the fake
    // fails resume-d (a fresh section — a resumed section is skipped,
    // never run). The merge fails with the section named and the run
    // kind, the verified resumed count still on the report, and the
    // journal still valid with the 3 completed sections.
    {
      const { live, copy } = buildCase("P-h2a", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        installFakeRunSh(live);
      });
      const resumeDir = path.join(WORKDIR, "cases", "P-h2a", "resume");
      const workDir = path.join(WORKDIR, "cases", "P-h2a", "work");
      process.env.FAKE_RUN_KILL_AFTER = "2";
      const d1 = driveRun("run-bra159-P-D1", {
        mergeId: "BRA-159-P-D1", copyRoot: copy, liveRoot: live,
        workDir, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      if (d1) {
        check(d1.verdict === "failed", `P drive 1 verdict failed (got ${d1.verdict})`);
      }
      process.env.FAKE_RUN_FAIL_SLUG = "resume-d";
      const d2 = driveRun("run-bra159-P-D2", {
        mergeId: "BRA-159-P-D2", copyRoot: copy, liveRoot: live,
        workDir, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_FAIL_SLUG;
      if (d2) {
        check(d2.verdict === "failed", `P drive 2 verdict failed (got ${d2.verdict}: ${JSON.stringify(d2.notes)})`);
        check((d2.notes as string[]).some((n) => /failed sections: resume-d \(resumed run\)/.test(n)),
          `P drive 2 failure note names the section + the run kind (got ${JSON.stringify(d2.notes)})`);
        check(d2.resumedSections === 2, `P drive 2 resumedSections 2 still on the report (got ${d2.resumedSections})`);
        check(d2.suite.sectionsRan === 3 && d2.suite.totalOk === 6, `P drive 2 suite 3 sections / 6 OK (the failed section has no marker) (got ${d2.suite.sectionsRan} / ${d2.suite.totalOk})`);
        check(d2.suite.allPassed === false && d2.suite.summaryMatchesIndependent === false, `P drive 2 allPassed false + summary mismatch`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b", "resume-c"]),
          `P journal still valid: the 3 completed sections (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(JSON.stringify(fakeRanSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b", "resume-c"]),
          `P the failed section never ran to completion (got ${JSON.stringify(fakeRanSlugs(resumeDir))})`);
      }
    }

    // ---- Case Q (H2b hostile): a missing or corrupt resume dir
    // refuses loudly and falls back to a fresh tier-1, recorded as
    // fresh with the reason — never claiming resumed sections it
    // cannot prove. Q1: no journal at all. Q2: a section row whose
    // .done marker was deleted.
    {
      // Q1 — missing: the resume dir does not exist yet.
      const { live: live1, copy: copy1 } = buildCase("Q-h2b-missing", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        installFakeRunSh(live);
      });
      const resumeDir1 = path.join(WORKDIR, "cases", "Q-h2b-missing", "resume");
      const workDir1 = path.join(WORKDIR, "cases", "Q-h2b-missing", "work");
      const q1 = driveRun("run-bra159-Q1", {
        mergeId: "BRA-159-Q1", copyRoot: copy1, liveRoot: live1,
        workDir: workDir1, resumeDir: resumeDir1,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        authorization: FIXTURE_AUTH,
      });
      if (q1) {
        check(q1.verdict === "merged", `Q1 verdict merged (fell back to fresh) (got ${q1.verdict}: ${JSON.stringify(q1.notes)})`);
        check(q1.resumedSections === 0, `Q1 resumedSections 0 — nothing claimed (got ${q1.resumedSections})`);
        check(typeof q1.resumeFallback === "string" && /no progress\.jsonl/.test(q1.resumeFallback),
          `Q1 resumeFallback names the missing journal (got ${JSON.stringify(q1.resumeFallback)})`);
        check(q1.notes.length === 0, `Q1 zero notes — the fallback is data, never a note (got ${JSON.stringify(q1.notes)})`);
        check(JSON.stringify(sectionSlugs(path.join(workDir1, "tier1-fresh-resume"))) === JSON.stringify(FAKE_SECTIONS),
          `Q1 the fresh fallback ran all 5 sections (got ${JSON.stringify(sectionSlugs(path.join(workDir1, "tier1-fresh-resume")))})`);
      }
      // Q2 — corrupt: a valid journal, then one marker deleted.
      const { live: live2, copy: copy2 } = buildCase("Q-h2b-corrupt", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        installFakeRunSh(live);
      });
      const resumeDir2 = path.join(WORKDIR, "cases", "Q-h2b-corrupt", "resume");
      const workDir2 = path.join(WORKDIR, "cases", "Q-h2b-corrupt", "work");
      process.env.FAKE_RUN_KILL_AFTER = "2";
      const q2d1 = driveRun("run-bra159-Q2-D1", {
        mergeId: "BRA-159-Q2-D1", copyRoot: copy2, liveRoot: live2,
        workDir: workDir2, resumeDir: resumeDir2,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      if (q2d1) {
        check(q2d1.verdict === "failed", `Q2 drive 1 verdict failed (got ${q2d1.verdict})`);
        check(JSON.stringify(sectionSlugs(resumeDir2)) === JSON.stringify(["resume-a", "resume-b"]),
          `Q2 drive 1 journal holds the 2 completed sections`);
      }
      fs.rmSync(path.join(resumeDir2, "workflow", "tier1", "resume", ".done", "resume-b"));
      const q2 = driveRun("run-bra159-Q2-D2", {
        mergeId: "BRA-159-Q2-D2", copyRoot: copy2, liveRoot: live2,
        workDir: workDir2, resumeDir: resumeDir2,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        authorization: FIXTURE_AUTH,
      });
      if (q2) {
        check(q2.verdict === "merged", `Q2 verdict merged (fell back to fresh) (got ${q2.verdict}: ${JSON.stringify(q2.notes)})`);
        check(q2.resumedSections === 0, `Q2 resumedSections 0 — the corrupt journal proves nothing (got ${q2.resumedSections})`);
        check(typeof q2.resumeFallback === "string" && /corrupt/.test(q2.resumeFallback),
          `Q2 resumeFallback names the corruption (got ${JSON.stringify(q2.resumeFallback)})`);
        check(q2.notes.length === 0, `Q2 zero notes (got ${JSON.stringify(q2.notes)})`);
        check(JSON.stringify(sectionSlugs(resumeDir2)) === JSON.stringify(["resume-a", "resume-b"]),
          `Q2 the carried-forward journal is untouched by the fallback (got ${JSON.stringify(sectionSlugs(resumeDir2))})`);
        check(JSON.stringify(sectionSlugs(path.join(workDir2, "tier1-fresh-resume"))) === JSON.stringify(FAKE_SECTIONS),
          `Q2 the fresh fallback ran all 5 sections`);
      }
    }

    // ---- Case R (H2c hostile): a fresh copy against the
    // carried-forward dir. Drive 1 builds the journal + fingerprint
    // on live-A; drive 2 uses a different live tree (live-B, a fresh
    // copy with different content) with the SAME resume dir. The
    // fingerprint refuses, the workflow retries once with a fresh
    // dir, and the report records fresh with the reason.
    {
      const { live: liveA, copy: copyA } = buildCase("R-h2c-a", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 H2C-A\n");
        installFakeRunSh(live);
      });
      const resumeDir = path.join(WORKDIR, "cases", "R-h2c-a", "resume");
      const workDirA = path.join(WORKDIR, "cases", "R-h2c-a", "work");
      process.env.FAKE_RUN_KILL_AFTER = "2";
      const r1 = driveRun("run-bra159-R-D1", {
        mergeId: "BRA-159-R-D1", copyRoot: copyA, liveRoot: liveA,
        workDir: workDirA, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      if (r1) {
        check(r1.verdict === "failed", `R drive 1 verdict failed (got ${r1.verdict})`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b"]),
          `R drive 1 journal holds the 2 completed sections`);
      }
      const { live: liveB, copy: copyB } = buildCase("R-h2c-b", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 H2C-B\n");
        installFakeRunSh(live);
      });
      const workDirB = path.join(WORKDIR, "cases", "R-h2c-b", "work");
      const r2 = driveRun("run-bra159-R-D2", {
        mergeId: "BRA-159-R-D2", copyRoot: copyB, liveRoot: liveB,
        workDir: workDirB, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        authorization: FIXTURE_AUTH,
      });
      if (r2) {
        check(r2.verdict === "merged", `R drive 2 verdict merged (fresh retry after the refusal) (got ${r2.verdict}: ${JSON.stringify(r2.notes)})`);
        check(r2.resumedSections === 0, `R drive 2 resumedSections 0 — the refused resume proves nothing (got ${r2.resumedSections})`);
        check(typeof r2.resumeFallback === "string" && /fingerprint/.test(r2.resumeFallback),
          `R drive 2 resumeFallback names the fingerprint refusal (got ${JSON.stringify(r2.resumeFallback)})`);
        check(r2.notes.length === 0, `R drive 2 zero notes (got ${JSON.stringify(r2.notes)})`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b"]),
          `R the carried-forward journal is untouched by the retry (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(JSON.stringify(sectionSlugs(path.join(workDirB, "tier1-fresh-resume"))) === JSON.stringify(FAKE_SECTIONS),
          `R the fresh retry ran all 5 sections`);
        check(read(path.join(resumeDir, "fingerprint")) !== read(path.join(workDirB, "tier1-fresh-resume", "fingerprint")),
          `R the retry wrote a fresh fingerprint for the new tree`);
      }
    }

    // ---- Cases S (X1a) + T (X1b + G0): the re-drive is itself
    // killed mid-resume, and the journal's rows span three drives.
    // Drive 1 kills after 2 sections; drive 2 resumes, runs 1 fresh
    // section, and is killed; drive 3 resumes from the SAME journal
    // again and lands. T reconciles the three drives' journal rows
    // exactly and checks the G0 guardrails on the final report.
    const X1_RESUME = path.join(WORKDIR, "cases", "S-x1a", "resume");
    const X1_WORK = path.join(WORKDIR, "cases", "S-x1a", "work");
    let x1Final: Record<string, any> | null = null;
    {
      const { live, copy } = buildCase("S-x1a", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        installFakeRunSh(live);
      });
      process.env.FAKE_RUN_KILL_AFTER = "2";
      const s1 = driveRun("run-bra159-S-D1", {
        mergeId: "BRA-159-S-D1", copyRoot: copy, liveRoot: live,
        workDir: X1_WORK, resumeDir: X1_RESUME,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      if (s1) {
        check(s1.verdict === "failed", `S drive 1 verdict failed (got ${s1.verdict})`);
        check(JSON.stringify(sectionSlugs(X1_RESUME)) === JSON.stringify(["resume-a", "resume-b"]),
          `S drive 1 journal holds 2 sections`);
      }
      process.env.FAKE_RUN_KILL_AFTER = "1";
      const s2 = driveRun("run-bra159-S-D2", {
        mergeId: "BRA-159-S-D2", copyRoot: copy, liveRoot: live,
        workDir: X1_WORK, resumeDir: X1_RESUME,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      if (s2) {
        check(s2.verdict === "failed", `S drive 2 verdict failed (killed mid-resume) (got ${s2.verdict})`);
        check(s2.resumedSections === 2, `S drive 2 resumedSections 2 (the journal it started from) (got ${s2.resumedSections})`);
        check(JSON.stringify(sectionSlugs(X1_RESUME)) === JSON.stringify(["resume-a", "resume-b", "resume-c"]),
          `S drive 2 journal accumulated to 3 sections (got ${JSON.stringify(sectionSlugs(X1_RESUME))})`);
      }
      const s3 = driveRun("run-bra159-S-D3", {
        mergeId: "BRA-159-S-D3", copyRoot: copy, liveRoot: live,
        workDir: X1_WORK, resumeDir: X1_RESUME,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        baseline: { sections: 5, ok: 10, label: "fake tier-1 (5 sections / 10 OK)" },
        authorization: FIXTURE_AUTH,
      });
      x1Final = s3;
      if (s3) {
        check(s3.verdict === "merged", `S drive 3 verdict merged (re-entrant resume lands) (got ${s3.verdict}: ${JSON.stringify(s3.notes)})`);
        check(s3.resumedSections === 3, `S drive 3 resumedSections 3 (accumulated across both kills) (got ${s3.resumedSections})`);
        check(s3.resumeFallback === null, `S drive 3 resumeFallback null (got ${JSON.stringify(s3.resumeFallback)})`);
        check(s3.suite.skippedViaResume === 3, `S drive 3 skippedViaResume 3 (got ${s3.suite.skippedViaResume})`);
      }
    }
    // ---- Case T (X1b + G0): the journal's rows span three drives.
    {
      const rows = journalRows(X1_RESUME);
      const sections = rows.filter((r) => r.event === "section");
      const skips = rows.filter((r) => r.event === "skip");
      check(sections.length === 5, `T 5 section rows across three drives (got ${sections.length})`);
      check(skips.length === 5, `T 5 skip rows across three drives (2 + 3) (got ${skips.length})`);
      check(rows.length === 10, `T 10 journal rows total (got ${rows.length})`);
      check(JSON.stringify(sectionSlugs(X1_RESUME)) === JSON.stringify(FAKE_SECTIONS),
        `T resumed + fresh == total, exactly the 5 sections in order (got ${JSON.stringify(sectionSlugs(X1_RESUME))})`);
      check(new Set(sections.map((r) => r.section as string)).size === 5,
        `T no section counted twice (got ${JSON.stringify(sections.map((r) => r.section))})`);
      check(JSON.stringify(fakeRanSlugs(X1_RESUME)) === JSON.stringify(FAKE_SECTIONS),
        `T G0 no done section re-run: each section ran exactly once across three drives (got ${JSON.stringify(fakeRanSlugs(X1_RESUME))})`);
      if (x1Final) {
        check(x1Final.verdict === "merged", `T G0 final verdict merged (got ${x1Final.verdict})`);
        check(x1Final.notes.length === 0, `T G0 resumed count is data, never a note (got ${JSON.stringify(x1Final.notes)})`);
        check(x1Final.suite.allPassed === true && x1Final.suite.summaryMatchesIndependent === true,
          `T G0 merged only with all sections green + the independent recount matching`);
        check(x1Final.suite.sectionsRan === 5 && x1Final.suite.totalOk === 10,
          `T G0 final suite 5 sections / 10 OK (got ${x1Final.suite.sectionsRan} / ${x1Final.suite.totalOk})`);
        check(x1Final.resumedSections === 3, `T G0 final resumedSections 3 (got ${x1Final.resumedSections})`);
      } else {
        fail("T G0 final report missing (drive 3 returned no result)");
      }
    }

    // ---- Case U (lost-result retry): a duplicate agreeing journal
    // row deduplicates and counts once. Drive 1 kills after 2
    // sections with the fake re-writing resume-b's row (the
    // run-tests lost-result retry shape from the staged leg: two
    // agreeing rows, same slug, same ok, rc=0). Drive 2 re-drives
    // with carryForwardResume: the journal validates with resumed 2,
    // the merge lands with resumedSections 2, and no section is
    // counted twice.
    {
      const { live, copy } = buildCase("U-dup", ({ live, copy }) => {
        fs.writeFileSync(path.join(copy, "apps/agentts/workflows/library/file1.ts"), "// file1 CHANGED\n");
        installFakeRunSh(live);
      });
      const resumeDir = path.join(WORKDIR, "cases", "U-dup", "resume");
      const workDir = path.join(WORKDIR, "cases", "U-dup", "work");
      process.env.FAKE_RUN_KILL_AFTER = "2";
      process.env.FAKE_RUN_DUP_SLUG = "resume-b";
      const d1 = driveRun("run-bra159-U-D1", {
        mergeId: "BRA-159-U-D1", copyRoot: copy, liveRoot: live,
        workDir, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        authorization: FIXTURE_AUTH,
      });
      delete process.env.FAKE_RUN_KILL_AFTER;
      delete process.env.FAKE_RUN_DUP_SLUG;
      if (d1) {
        check(d1.verdict === "failed", `U drive 1 verdict failed (the fake tier-1 was killed) (got ${d1.verdict}: ${JSON.stringify(d1.notes)})`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b", "resume-b"]),
          `U drive 1 journal holds the duplicate agreeing row (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(JSON.stringify(fakeRanSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b"]),
          `U drive 1 fake ran exactly the 2 completed sections`);
      }
      const d2 = driveRun("run-bra159-U-D2", {
        mergeId: "BRA-159-U-D2", copyRoot: copy, liveRoot: live,
        workDir, resumeDir,
        claimedFiles: ["apps/agentts/workflows/library/file1.ts"],
        typecheck: false, runTier1: true, dryRun: false,
        carryForwardResume: true,
        baseline: { sections: 5, ok: 10, label: "fake tier-1 (5 sections / 10 OK)" },
        authorization: FIXTURE_AUTH,
      });
      if (d2) {
        check(d2.verdict === "merged", `U drive 2 verdict merged (got ${d2.verdict}: ${JSON.stringify(d2.notes)})`);
        check(d2.resumedSections === 2, `U drive 2 resumedSections 2 as data — the duplicate counted once (got ${d2.resumedSections})`);
        check(d2.resumeFallback === null, `U drive 2 resumeFallback null (got ${JSON.stringify(d2.resumeFallback)})`);
        check(d2.notes.length === 0, `U drive 2 zero notes (got ${JSON.stringify(d2.notes)})`);
        check(d2.suite.sectionsRan === 5 && d2.suite.totalOk === 10, `U drive 2 suite 5 sections / 10 OK (got ${d2.suite.sectionsRan} / ${d2.suite.totalOk})`);
        check(d2.suite.skippedViaResume === 2, `U drive 2 skippedViaResume 2 (got ${d2.suite.skippedViaResume})`);
        check(d2.suite.allPassed === true && d2.suite.summaryMatchesIndependent === true, `U drive 2 allPassed + summaryMatchesIndependent`);
        check(JSON.stringify(sectionSlugs(resumeDir)) === JSON.stringify(["resume-a", "resume-b", "resume-b", "resume-c", "resume-d", "resume-e"]),
          `U journal holds the duplicate row + the 3 fresh sections (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(new Set(sectionSlugs(resumeDir)).size === 5,
          `U no section counted twice across both drives (got ${JSON.stringify(sectionSlugs(resumeDir))})`);
        check(JSON.stringify(fakeRanSlugs(resumeDir)) === JSON.stringify(FAKE_SECTIONS),
          `U no done section re-run: each section ran exactly once across both drives (got ${JSON.stringify(fakeRanSlugs(resumeDir))})`);
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
