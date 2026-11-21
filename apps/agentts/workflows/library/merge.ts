// merge — encode the worker-per-copy merge as a workflow (BRA-159).
//
// After the BRA-156 pilot the merge (apply a worker's diff from its copy
// to main, resolve conflicts, run tier 1) is still manual — the commit
// stage is hand-executed. This workflow encodes it. It complements
// BRA-158 (verify-fix): verification runs on the copy before the merge,
// this workflow performs the merge itself and proves the merged tree
// with a fresh tier-1 run.
//
// What the manual merge does (the spec, from the fleet-ops skill):
//
// 1. Diff copy vs live = exactly the claimed files. A live-only file
//    added after the copy was made stays; a merge must never delete it.
// 2. Copy the changed files to live; confirm the post-merge diff is
//    empty (or exactly the intended delta).
// 3. Never merge while a tier-1 runs against the live tree.
// 4. Fresh live tier-1 with a fresh --resume-dir; independently count
//    via parseSectionOutput over the raw section logs and compare with
//    the driver's PASS line (a resume-skipped run proves nothing). The
//    delta vs the previous baseline is exactly the new section's checks.
// 5. Baselines byte-identical; never re-baseline without a human
//    decision. host.ts conflicts need resolution at merge time.
//
// The workflow's steps (exec traps, direct adapter):
//
// 0. Refuse loudly, writing nothing, when a tier-1 is in flight
//    (a run.sh process running against the live tree), when the
//    copy-time manifest is missing or unparsable, when the diff is
//    not confined to the claimed files, when any file conflicts, or
//    when the baselines file differs.
// 1. Compute the three-way diff IN SHELL (sparseDiffScript): the
//    manifest is read from disk and both trees are hashed inside one
//    python process, and only the SPARSE diff crosses the trap
//    boundary — the files whose base/copy/live hashes are not all
//    equal, plus the manifest's copiedAt. A full manifest (~162KB
//    for the real tree) or a full hash listing would crash the C
//    host: exec-trap stdout caps at ~60KB (QA probe: 59,561 B
//    passes, 64,111 B crashes). Classify every claimed file
//    three-way against the manifest base (see classifyMergeFile),
//    plan the apply, then apply it (cp/rm), then re-diff in-shell
//    and verify the post-merge diff is empty except live-only files
//    and live modifications/deletions the copy never touched.
// 2. Typecheck the merged tree (bun x tsc --noEmit), its output
//    redirected to a file in workDir with only the first 4000 bytes
//    returned — the same trap-stdout cap.
// 3. Run tier 1 with a fresh --resume-dir, its output redirected to
//    a file with only the PASS summary line returned, and grep the
//    on-disk section logs for the OK count and the ^PASS count — from
//    the logs, never from the runner's summary line (the driver's
//    printed PASS line is parsed separately and compared against the
//    independent counts; a mismatch fails the verdict). Compare
//    against the pre-merge baseline and explain any delta.
// 4. Produce a merge report. The verdict is evidence, NOT acceptance:
//    Meroki reviews the report and closes. (Workers never close — that
//    rule extends to this workflow. It applies the diff — that is its
//    job — but it never decides acceptance.)
//
// Design decisions:
//
// 1. The base is a manifest, recorded at copy time by
//    scripts/record-copy-manifest.sh (one sha256 per file, same
//    exclusion set the workflow's diff uses). Without a base the
//    workflow could not tell a live-tree change since the copy was
//    made from a copy change, and copying blind would clobber live
//    work. A copy that changed after its manifest was recorded is
//    still handled: the manifest is the base, the copy is hashed
//    fresh, so post-manifest copy edits read as copy changes. The
//    manifest is read in-shell by the sparse-diff script, never
//    catted through a trap (design decision 7).
// 2. Confinement is computed on the COPY's changes vs the base (files
//    the copy changed), not on copy-vs-live differences. A file live
//    changed after the copy (or added live-only) is not the copy's
//    change, so it is never a confinement extra — it is classified
//    live-only and preserved. The same rule as verify-fix's
//    checkDiffConfinement, applied to the right change set.
// 3. Classify everything first, then apply. A conflict anywhere
//    aborts the whole apply before any file is written.
// 4. Counts come from the logs, never from a summary — the same rule
//    as verify-fix, reusing its exported parsers and its aggregation
//    script (tier1AggregationScript), so there is one counting rule
//    and one aggregation rule in the repo.
// 5. The workflow never reads process.env — every path it needs
//    arrives in the input. The tier-1 step passes DQUICKTS and TMPDIR
//    to run.sh with an `env` prefix (the exec trap has no env
//    override), because run.sh's sections build a C host internally
//    (the Makefile's default vendor dir is absent) and use mktemp
//    under TMPDIR (/tmp is a 512M tmpfs).
// 6. The tier-1-in-flight guard sees run.sh processes running
//    against the live tree: a matching pid refuses the merge only
//    when its cwd is inside liveRoot or its command line mentions
//    liveRoot. A run.sh elsewhere (the suite runner driving this
//    workflow's own test against scratch trees, an unrelated
//    run.sh) must not refuse the merge — the unscoped guard did
//    exactly that and the bra159 section could never pass under
//    tier 1. A suite driven without run.sh in its command line
//    would not be seen — recorded as a known limit, not papered
//    over.
// 7. Trap-stdout budget: exec-trap stdout caps at ~60KB (QA probe:
//    59,561 B passes, 64,111 B crashes — the manifest cat died
//    deterministically at trap-2 on the real tree). Every exec
//    trap's stdout is therefore bounded IN SHELL, never by slicing
//    after the trap returns (too late — the host is already dead):
//    the guard returns only an exit code; the sparse-diff script
//    returns only the sparse JSON (target < 5KB for the real tree);
//    the apply echoes one APPLIED line per planned file (bounded by
//    the claim list — a merge with thousands of claimed files would
//    approach the cap, a stated bound, not a tested one); the
//    typecheck returns only the first 4000 bytes of its output; the
//    tier-1 run returns only its PASS summary line; the log
//    aggregation returns one line per section log (~1KB for 47
//    sections). No trap returns a full listing, a full manifest, a
//    full tsc log, or a full suite log.
//
// Known v0 limits, carried verbatim in every report:
//
// - A partial apply is NOT rolled back: applied-so-far is reported
//   instead, and the tree must be repaired by hand. A rollback is v1.
// - The tier-1 guard sees only run.sh processes running against
//   the live tree (cwd inside liveRoot, or liveRoot in the command
//   line).
// - A false pass — a test that passes for the wrong reason — is NOT
//   diagnosed by this workflow (same limit as BRA-126/verify-fix).
//
// Environment: the leaf execs inherit the CLI process's env, so the
// driver must export TMPDIR (scratch under /home — /tmp is a 512M
// tmpfs) before invoking the workflow when it runs tier 1; the
// workflow itself creates workDir/tmp and passes it to run.sh.

import { exec } from "../../src/agentts";
import {
  parseTierSummaryLine,
  parseTier1Aggregation,
  checkDiffConfinement,
  compareBaseline,
  tier1AggregationScript,
  type SuiteResult,
  type BaselineResult,
  type ConfinementResult,
  type TypecheckResult,
  type SuiteBaseline,
  type ExpectedAddition,
} from "./verify-fix";

/** The baselines file is never merged from a copy. */
export const MERGE_BASELINES_PATH = "apps/agentts/bench/baselines.json";
/** The god-file: conflicts on it need a human at merge time. */
export const MERGE_HOST_PATH = "apps/agentts/src/host.ts";
/** The copy-time manifest, at the copy root. */
export const MERGE_MANIFEST_NAME = ".agentts-copy-manifest.json";

/** Input to the merge workflow. */
export interface MergeCopyInput {
  /** e.g. "BRA-159". */
  mergeId: string;
  /** Absolute path to the worker copy. */
  copyRoot: string;
  /** Absolute path to the live tree. */
  liveRoot: string;
  /** Absolute scratch dir (work files, TMPDIR for the suite run).
   * Created by the workflow. */
  workDir: string;
  /** Fresh --resume-dir for the tier-1 run. Must be fresh: a resumed
   * run that skips sections proves nothing (skippedViaResume > 0
   * fails the verdict). */
  resumeDir: string;
  /** Files the merge claims the copy changes (repo-relative paths). */
  claimedFiles: string[];
  /** dquickts tree for the C host build inside the suite run
   * (default the standard minimal tree). */
  dquicktsPath?: string;
  /** bun binary (default /opt/hatch-image/bin/bun). */
  bunPath?: string;
  /** Run `bun x tsc --noEmit` on the merged tree (default true). */
  typecheck?: boolean;
  /** Run tier 1 after the merge (default true). False skips the
   * suite step with a note — the test's scratch-tree runs use this,
   * because a scratch tree has no suite to run. */
  runTier1?: boolean;
  /** Plan the merge but write nothing and run no suite
   * (default false). */
  dryRun?: boolean;
  /** Suite tier (default 1). */
  tier?: number;
  /** Pre-merge baseline. Absent means no comparison (noted). */
  baseline?: SuiteBaseline;
  /** Growth the merge itself is expected to add (the merged fix's
   * own new section and checks). Absent means no growth expected. */
  expectedAdditions?: ExpectedAddition[];
}

/** One file's three-way classification. */
export interface FileClassification {
  file: string;
  action: "apply" | "delete" | "already-applied" | "live-only" | "conflict";
  reason: string;
}

/** One conflict: the file, and why the merge refuses it. */
export interface MergeConflict {
  file: string;
  reason: string;
}

/** The copy-time manifest (scripts/record-copy-manifest.sh). */
export interface CopyManifest {
  copiedAt: string;
  root: string;
  /** Repo-relative path -> sha256 hex. */
  files: Record<string, string>;
}

/** The merge plan: what the apply step will (and will not) do. */
export interface MergePlan {
  /** Files the copy changed vs the base (the confinement set). */
  copyChanged: string[];
  /** Files present in live only (in neither base nor copy) — preserved. */
  liveOnly: string[];
  /** Files in the base that live changed (modified or deleted) and the
   * copy did not touch — preserved, never overwritten or restored. */
  liveModified: string[];
  confinement: ConfinementResult;
  /** Files the copy's baselines differ on — refused, never merged. */
  baselinesRefused: string[];
  /** Per-file classification for every claimed file the copy changed. */
  classified: FileClassification[];
  /** Files the plan would copy to live (apply). */
  plannedApply: string[];
  /** Files the plan would remove from live (delete). */
  plannedDelete: string[];
  /** Files already identical in copy and live — nothing to do. */
  alreadyApplied: string[];
  /** Claimed files live changed and the copy did not touch — left alone. */
  liveOnlyClaimed: string[];
  /** Files both sides changed differently — the merge refuses. */
  conflicts: MergeConflict[];
}

/** The merge report — the workflow's output, for Meroki's review + close. */
export interface MergeReport {
  mergeId: string;
  /** "merged" means the apply + typecheck + tier-1 evidence checks
   * out. It is NOT acceptance: Meroki reviews this report and closes.
   * "dry-run" means the plan is clean and nothing was written.
   * "failed" means the merge did not happen or its evidence failed. */
  verdict: string;
  dryRun: boolean;
  /** A tier-1 run was in flight when the workflow started. */
  tier1InFlight: boolean;
  /** Files copied to live (apply). Empty when nothing was written. */
  applied: string[];
  /** Files removed from live (delete). Empty when nothing was written. */
  deleted: string[];
  /** Files the dry-run plan would apply or delete. */
  planned: string[];
  /** Files already identical in copy and live — nothing was done. */
  alreadyApplied: string[];
  /** Live-only files preserved (never deleted, never overwritten). */
  liveOnlyPreserved: string[];
  conflicts: MergeConflict[];
  baselinesRefused: string[];
  confinement: ConfinementResult;
  typecheck: TypecheckResult;
  suite: SuiteResult;
  baseline: BaselineResult;
  /** When the manifest was recorded ("" when no manifest was read). */
  manifestCopiedAt: string;
  /** The known v0 limits, carried verbatim in every report. */
  knownLimit: string;
  /** Every discrepancy, named with its counts. Empty when merged. */
  notes: string[];
}

export const MERGE_KNOWN_LIMIT =
  "v0 limit: a partial apply is NOT rolled back - applied-so-far is reported instead, and the tree must be repaired by hand; the tier-1 guard sees only run.sh processes running against the live tree; a false pass - a test that passes for the wrong reason - is NOT diagnosed by this workflow (same limit as BRA-126/verify-fix).";

/** Single-quote a string for /bin/sh. Pure. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Parse the copy-time manifest. Pure — unit-tested directly.
 * Throws loudly on any malformation: a merge without a trustworthy
 * base is worse than no merge at all. */
export function parseCopyManifest(text: string): CopyManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("merge: manifest is not valid JSON: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("merge: manifest is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.copiedAt !== "string" || obj.copiedAt === "") {
    throw new Error("merge: manifest has no copiedAt string");
  }
  if (typeof obj.root !== "string" || obj.root === "") {
    throw new Error("merge: manifest has no root string");
  }
  if (typeof obj.files !== "object" || obj.files === null || Array.isArray(obj.files)) {
    throw new Error("merge: manifest has no files object");
  }
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj.files as Record<string, unknown>)) {
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) {
      throw new Error("merge: manifest file " + JSON.stringify(k) + " has no sha256 hex value");
    }
    files[k] = v;
  }
  return { copiedAt: obj.copiedAt as string, root: obj.root as string, files };
}

/** Parse one `sha256sum` listing into a path -> hash map. Pure —
 * unit-tested directly. Throws loudly on a malformed line: a diff
 * computed from a misparsed listing cannot be trusted.
 * Lines are `<sha256>  <relpath>` (relpath without the leading ./). */
export function parseHashOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const m = line.match(/^([0-9a-f]{64}) +(.+)$/);
    if (!m) {
      throw new Error("merge: cannot parse hash line: " + JSON.stringify(line));
    }
    let p = m[2];
    if (p.startsWith("./")) p = p.slice(2);
    out[p] = m[1];
  }
  return out;
}

/** One entry of the sparse three-way diff: a file whose base/copy/
/ live hashes are not all equal (or which is absent on some side).
// A hash is null when the file is absent on that side. */
export interface SparseDiffEntry {
  file: string;
  base: string | null;
  copy: string | null;
  live: string | null;
}

/** The sparse three-way diff: the manifest's copiedAt plus only the
 * files that differ anywhere. Files absent from the diff have
 * base == copy == live — the workflow builds sparse maps from this
 * and feeds the existing pure functions, which classify only on
 * differences (proved by the sparse-vs-full §C check). */
export interface SparseDiff {
  copiedAt: string;
  diff: SparseDiffEntry[];
}

/** Parse a sparse-diff JSON payload. Pure — unit-tested directly.
 * Throws loudly on any malformation: a diff that cannot be trusted
 * is worse than no diff at all. */
export function parseSparseDiff(text: string): SparseDiff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("merge: sparse diff is not valid JSON: " + (e as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("merge: sparse diff is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.copiedAt !== "string" || obj.copiedAt === "") {
    throw new Error("merge: sparse diff has no copiedAt string");
  }
  if (!Array.isArray(obj.diff)) {
    throw new Error("merge: sparse diff has no diff array");
  }
  const diff: SparseDiffEntry[] = [];
  for (const entry of obj.diff as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("merge: sparse diff entry is not a JSON object");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.file !== "string" || e.file === "") {
      throw new Error("merge: sparse diff entry has no file string");
    }
    for (const side of ["base", "copy", "live"] as const) {
      const v = e[side];
      if (v !== null && (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))) {
        throw new Error(
          "merge: sparse diff entry " + JSON.stringify(e.file) + " has no sha256 hex value for " + side,
        );
      }
    }
    diff.push({
      file: e.file as string,
      base: (e.base ?? null) as string | null,
      copy: (e.copy ?? null) as string | null,
      live: (e.live ?? null) as string | null,
    });
  }
  return { copiedAt: obj.copiedAt as string, diff };
}

/** Extract the message from a sparse-diff error payload
 * ({"error": ..., "message": ...}, one JSON line on stdout). Falls
 * back to the raw text, trimmed, when the payload is not an error
 * JSON — the workflow's refusal notes stay informative either way.
 * Pure — unit-tested directly. */
export function sparseDiffErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed === "object" && parsed !== null && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.trim().slice(0, 200);
}

/** The sparse-diff script: one /bin/sh -c invocation that reads the
 * manifest from disk (never through a trap's stdout), hashes the
 * copy and the live tree with the fixed -name prune, and prints ONLY
 * the sparse-diff JSON — the files whose base/copy/live hashes are
 * not all equal, plus the manifest's copiedAt. Everything large
 * (the manifest, both hash listings) stays inside the python
 * process; only the small diff crosses the trap boundary.
 * Exit codes, same protocol as the guard: 0 = success (sparse JSON
 * on stdout), 2 = manifest missing, 3 = manifest unparsable, 1 =
 * any other failure (an {"error": ..., "message": ...} line on
 * stdout, the detail in the message). Pure — the script's shape is
 * unit-tested; the §D cases drive it end to end. */
export function sparseDiffScript(copyRoot: string, liveRoot: string, manifestPath: string): string {
  const py = [
    "import json, re, subprocess, sys",
    "copy_root, live_root, manifest_path = sys.argv[1:4]",
    "def err(kind, message, code):",
    "    print(json.dumps({\"error\": kind, \"message\": message}))",
    "    raise SystemExit(code)",
    "try:",
    "    with open(manifest_path) as f:",
    "        manifest = json.load(f)",
    "except FileNotFoundError:",
    "    err(\"manifest-missing\", \"manifest not found: \" + manifest_path, 2)",
    "except (OSError, ValueError) as e:",
    "    err(\"manifest-unparsable\", \"manifest is not valid JSON: \" + str(e), 3)",
    "if not isinstance(manifest, dict) or not isinstance(manifest.get(\"copiedAt\"), str) or not manifest.get(\"copiedAt\") or not isinstance(manifest.get(\"files\"), dict):",
    "    err(\"manifest-unparsable\", \"manifest has no copiedAt string or files object\", 3)",
    "base = manifest[\"files\"]",
    "for k, v in base.items():",
    "    if not isinstance(v, str) or not re.fullmatch(r\"[0-9a-f]{64}\", v):",
    "        err(\"manifest-unparsable\", \"manifest file \" + json.dumps(k) + \" has no sha256 hex value\", 3)",
    "FIND = [\"find\", \".\", \"(\", \"-name\", \"node_modules\", \"-o\", \"-name\", \".agentts-state\", \"-o\", \"-name\", \".agentts-scratch\", \"-o\", \"-name\", \".git\", \")\", \"-prune\", \"-o\", \"-type\", \"f\", \"-not\", \"-name\", \".agentts-copy-manifest.json\", \"-print0\"]",
    "def hashes(root):",
    "    r = subprocess.run(FIND, cwd=root, capture_output=True)",
    "    if r.returncode != 0:",
    "        err(\"hash-failed\", \"find failed in \" + root, 1)",
    "    paths = sorted(p for p in r.stdout.split(b\"\\0\") if p)",
    "    out = {}",
    "    for i in range(0, len(paths), 500):",
    "        rr = subprocess.run([\"sha256sum\"] + [p.decode() for p in paths[i:i+500]], cwd=root, capture_output=True, text=True)",
    "        if rr.returncode != 0:",
    "            err(\"hash-failed\", \"sha256sum failed in \" + root, 1)",
    "        for line in rr.stdout.splitlines():",
    "            parts = line.split(None, 1)",
    "            if len(parts) != 2:",
    "                err(\"hash-failed\", \"cannot parse sha256sum line: \" + repr(line), 1)",
    "            hh, pp = parts",
    "            if pp.startswith(\"./\"): pp = pp[2:]",
    "            out[pp] = hh",
    "    return out",
    "copy = hashes(copy_root)",
    "live = hashes(live_root)",
    "diff = []",
    "for k in sorted(set(base) | set(copy) | set(live)):",
    "    b, c, l = base.get(k), copy.get(k), live.get(k)",
    "    if b is not None and b == c == l:",
    "        continue",
    "    diff.append({\"file\": k, \"base\": b, \"copy\": c, \"live\": l})",
    "print(json.dumps({\"copiedAt\": manifest[\"copiedAt\"], \"diff\": diff}, sort_keys=True))",
  ];
  return (
    "python3 - " +
    shellQuote(copyRoot) +
    " " +
    shellQuote(liveRoot) +
    " " +
    shellQuote(manifestPath) +
    " <<'MERGE_SPARSE_PY'\n" +
    py.join("\n") +
    "\nMERGE_SPARSE_PY"
  );
}

/** The hash script: one /bin/sh -c invocation that lists every file
 * under a root with its sha256, in the manifest's exclusion set
 * (node_modules, .agentts-state, .agentts-scratch, .git, and the
 * manifest itself). Only the hashes cross the trap boundary.
 * Note: paths with newlines would break the line-based parse — repo
 * paths have none; the parser throws loudly if one ever appears.
 * The prune is -name-based (any depth): the junk dirs live under
 * apps/agentts/, so a top-level -path prune never fired and the
 * manifest held 3,279 node_modules entries (QA FAIL). */
export function hashScript(root: string): string {
  return (
    "cd " +
    shellQuote(root) +
    " && find . \\( -name node_modules -o -name .agentts-state -o -name .agentts-scratch -o -name .git \\) -prune -o -type f -not -name " +
    shellQuote(MERGE_MANIFEST_NAME) +
    " -print0 | sort -z | xargs -0 -r sha256sum"
  );
}

/** The tier-1-in-flight guard script: exit 0 when a run.sh process
 * is running against the given live root, 1 when none is, anything
 * else never (no set -e, so a vanished pid or a missing /proc entry
 * just skips that pid). A matching pid counts only when its cwd is
 * the live root or inside it, or its command line mentions the live
 * root — a run.sh elsewhere (the suite runner driving a scratch-tree
 * merge, an unrelated run.sh) must not refuse the merge. The [r]
 * spelling keeps pgrep from matching this script's own command line
 * (its text contains the pattern, never the literal "run.sh").
 * Pure — the guard's shape is testable without running it. */
export function tier1GuardScript(liveRoot: string): string {
  return [
    "LIVE=" + shellQuote(liveRoot),
    "for pid in $(pgrep -f '[r]un\\.sh' 2>/dev/null); do",
    "  cwd=$(readlink \"/proc/$pid/cwd\" 2>/dev/null) || continue",
    "  case \"$cwd\" in \"$LIVE\"|\"$LIVE\"/*) exit 0;; esac",
    "  if tr '\\0' ' ' < \"/proc/$pid/cmdline\" 2>/dev/null | grep -F -q -- \"$LIVE\"; then exit 0; fi",
    "done",
    "exit 1",
  ].join("\n");
}

/** Split the three hash maps into the copy's changes vs the base, the
 * live-only files, and the files live changed that the copy did not
 * touch. Pure — unit-tested directly.
 * copyChanged = every file whose copy hash differs from its base hash
 * (a copy add, a copy edit, or a copy delete — absent counts as a
 * hash of its own). liveOnly = files present in live but in neither
 * base nor copy. liveModified = files in the base that live changed
 * (modified or deleted — absent counts as changed) and the copy did
 * not touch (copy hash equals base hash). A live-modified file is
 * live's work: the merge preserves it and never reports it as a
 * remaining diff (a live modification or deletion of a file the copy
 * never touched is not a merge failure). */
export function computeChangedFiles(args: {
  base: Record<string, string>;
  copy: Record<string, string>;
  live: Record<string, string>;
}): { copyChanged: string[]; liveOnly: string[]; liveModified: string[] } {
  const copyChanged: string[] = [];
  const keys = new Set<string>([...Object.keys(args.base), ...Object.keys(args.copy)]);
  for (const k of keys) {
    if ((args.copy[k] ?? undefined) !== (args.base[k] ?? undefined)) copyChanged.push(k);
  }
  copyChanged.sort();
  const liveOnly: string[] = [];
  for (const k of Object.keys(args.live)) {
    if (args.base[k] === undefined && args.copy[k] === undefined) liveOnly.push(k);
  }
  liveOnly.sort();
  const liveModified: string[] = [];
  for (const k of Object.keys(args.base)) {
    if ((args.copy[k] ?? undefined) === args.base[k] && (args.live[k] ?? undefined) !== args.base[k]) {
      liveModified.push(k);
    }
  }
  liveModified.sort();
  return { copyChanged, liveOnly, liveModified };
}

/** Three-way classify one file. Pure — unit-tested directly.
 * base/copy/live are sha256 hex strings, or undefined when the file
 * is absent on that side. Total: every combination lands in exactly
 * one action. */
export function classifyMergeFile(args: {
  file: string;
  base?: string;
  copy?: string;
  live?: string;
}): FileClassification {
  const { file, base, copy, live } = args;
  if (copy === live) {
    return {
      file,
      action: "already-applied",
      reason: "copy and live agree on this file (same content, or both deleted it) — nothing to do",
    };
  }
  if (live === base) {
    if (copy === undefined) {
      return {
        file,
        action: "delete",
        reason: "the copy deleted this file and live is unchanged since the copy was made — remove it from live",
      };
    }
    return {
      file,
      action: "apply",
      reason:
        base === undefined
          ? "the copy added this file and live does not have it — copy it to live"
          : "the copy changed this file and live is unchanged since the copy was made — copy it to live",
    };
  }
  if (copy === base) {
    return {
      file,
      action: "live-only",
      reason: "live changed this file since the copy was made and the copy did not touch it — left alone",
    };
  }
  return {
    file,
    action: "conflict",
    reason: "both the copy and live changed this file differently since the copy was made — human resolves",
  };
}

/** Build the merge plan from the three hash maps. Pure — unit-tested
 * directly. The baselines rule fires before the generic
 * classification: any copy-vs-live difference on the baselines file
 * is refused, never merged. A host.ts conflict carries the
 * merge-time-resolution note. */
export function buildMergePlan(args: {
  claimedFiles: string[];
  base: Record<string, string>;
  copy: Record<string, string>;
  live: Record<string, string>;
}): MergePlan {
  const { copyChanged, liveOnly, liveModified } = computeChangedFiles({
    base: args.base,
    copy: args.copy,
    live: args.live,
  });
  const confinement = checkDiffConfinement(copyChanged, args.claimedFiles);
  const baselinesRefused: string[] = [];
  if ((args.copy[MERGE_BASELINES_PATH] ?? undefined) !== (args.live[MERGE_BASELINES_PATH] ?? undefined)) {
    baselinesRefused.push(MERGE_BASELINES_PATH);
  }
  const classified: FileClassification[] = [];
  const plannedApply: string[] = [];
  const plannedDelete: string[] = [];
  const alreadyApplied: string[] = [];
  const liveOnlyClaimed: string[] = [];
  const conflicts: MergeConflict[] = [];
  const claimedSet = new Set(args.claimedFiles);
  for (const f of copyChanged) {
    if (!claimedSet.has(f)) continue;
    const c = classifyMergeFile({
      file: f,
      base: args.base[f],
      copy: args.copy[f],
      live: args.live[f],
    });
    classified.push(c);
    if (c.action === "apply") plannedApply.push(f);
    else if (c.action === "delete") plannedDelete.push(f);
    else if (c.action === "already-applied") alreadyApplied.push(f);
    else if (c.action === "live-only") liveOnlyClaimed.push(f);
    else {
      let reason = c.reason;
      if (f === MERGE_HOST_PATH) {
        reason += " (host.ts conflicts need resolution at merge time)";
      }
      conflicts.push({ file: f, reason });
    }
  }
  return {
    copyChanged,
    liveOnly,
    liveModified,
    confinement,
    baselinesRefused,
    classified,
    plannedApply,
    plannedDelete,
    alreadyApplied,
    liveOnlyClaimed,
    conflicts,
  };
}

/** The apply script: one /bin/sh -c invocation that copies every
 * planned apply (mkdir -p the parent first, cp -p the file) and
 * removes every planned delete, echoing "APPLIED <file>" after each
 * one so the caller knows how far a failed apply got. `set -e`
 * stops at the first failure — a partial apply is reported, not
 * rolled back (a v0 limit). */
export function applyScript(args: {
  copyRoot: string;
  liveRoot: string;
  plannedApply: string[];
  plannedDelete: string[];
}): string {
  const lines: string[] = ["set -e"];
  for (const f of args.plannedApply) {
    const parent = f.split("/").slice(0, -1).join("/");
    if (parent !== "") lines.push("mkdir -p " + shellQuote(args.liveRoot + "/" + parent));
    lines.push(
      "cp -p " +
        shellQuote(args.copyRoot + "/" + f) +
        " " +
        shellQuote(args.liveRoot + "/" + f),
    );
    lines.push("echo " + shellQuote("APPLIED " + f));
  }
  for (const f of args.plannedDelete) {
    lines.push("rm " + shellQuote(args.liveRoot + "/" + f));
    lines.push("echo " + shellQuote("APPLIED " + f));
  }
  return lines.join("\n");
}

/** Parse the apply script's APPLIED lines. Pure. */
export function parseAppliedLines(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("APPLIED ")) out.push(line.slice("APPLIED ".length));
  }
  return out;
}

/** The typecheck script: run tsc in the live apps dir, its output
 * redirected to a file, and return only the first 4000 bytes. A
 * failing tsc can print thousands of error lines — returning the
 * raw output through the trap would blow the ~60KB cap exactly when
 * the evidence matters most. The exit code is tsc's (the head
 * never masks it): `head` failing on a missing file still exits
 * with tsc's code. Pure — the script's shape is unit-tested. */
export function typecheckScript(bunPath: string, liveApps: string, outPath: string): string {
  return [
    "cd " + shellQuote(liveApps) + " || exit 1",
    shellQuote(bunPath) + " x tsc --noEmit > " + shellQuote(outPath) + " 2>&1; rc=$?",
    "head -c 4000 " + shellQuote(outPath) + " 2>/dev/null || true",
    "exit $rc",
  ].join("\n");
}

/** The tier-1 run script: run run.sh with the suite env, its output
 * redirected to a file, and return only the PASS summary line.
 * run.sh tees every section's full output to its stdout, so a full
 * tier-1 run's stdout is megabytes — returning it through the trap
 * would crash the host. The exit code is run.sh's; when there is no
 * PASS line (the run died before the summary) the trap returns
 * empty stdout, parseTierSummaryLine finds nothing, and the verdict
 * fails loudly. Pure — the script's shape is unit-tested. */
export function tier1RunScript(args: {
  dquickts: string;
  tmpdir: string;
  runSh: string;
  resumeDir: string;
  outPath: string;
}): string {
  return [
    "env DQUICKTS=" +
      shellQuote(args.dquickts) +
      " TMPDIR=" +
      shellQuote(args.tmpdir) +
      " " +
      shellQuote(args.runSh) +
      " --resume-dir " +
      shellQuote(args.resumeDir) +
      " > " +
      shellQuote(args.outPath) +
      " 2>&1; rc=$?",
    "grep -E '^PASS tier [0-9]+ \\(' " + shellQuote(args.outPath) + " 2>/dev/null | tail -1 || true",
    "exit $rc",
  ].join("\n");
}

/** Assemble the report and its verdict from the step results. Pure —
 * unit-tested directly. The verdict is "merged" only when every check
 * passes; "dry-run" when the plan is clean and nothing was written;
 * "failed" otherwise. Every failure is named in notes with its counts.
 * A typecheck or suite failure after a successful apply is still
 * "failed" — but the report says the tree was already merged, so the
 * PM knows the repair starts from the merged tree. */
export function buildMergeReport(args: {
  mergeId: string;
  verdict: "merged" | "failed" | "dry-run";
  dryRun: boolean;
  tier1InFlight: boolean;
  applied: string[];
  deleted: string[];
  planned: string[];
  alreadyApplied: string[];
  liveOnlyPreserved: string[];
  conflicts: MergeConflict[];
  baselinesRefused: string[];
  confinement: ConfinementResult;
  typecheck: TypecheckResult;
  suite: SuiteResult;
  baseline: BaselineResult;
  manifestCopiedAt: string;
  /** Refusal reasons from before the diff step (guard, manifest) —
   * carried verbatim at the head of notes. */
  extraNotes?: string[];
}): MergeReport {
  const notes: string[] = [...(args.extraNotes ?? [])];
  if (args.tier1InFlight) {
    notes.push("tier-1 in flight — merge refused, nothing was written");
  }
  if (args.baselinesRefused.length > 0) {
    notes.push(
      "baselines refused (never merged from a copy — re-baselining needs a human decision): " +
        args.baselinesRefused.join(", "),
    );
  }
  if (!args.confinement.confined) {
    if (args.confinement.extras.length > 0) {
      notes.push(
        "diff not confined: extras (copy changed, not claimed): " +
          args.confinement.extras.join(", "),
      );
    }
    if (args.confinement.missing.length > 0) {
      notes.push(
        "diff not confined: missing (claimed, copy did not change): " +
          args.confinement.missing.join(", "),
      );
    }
  }
  for (const c of args.conflicts) {
    notes.push("conflict on " + c.file + ": " + c.reason);
  }
  if (args.typecheck.ran && !args.typecheck.passed) {
    notes.push(
      "typecheck failed on the merged tree (exit " +
        args.typecheck.exitCode +
        ") — the tree was already merged; repair starts from the merged tree",
    );
  }
  if (args.suite.mode === "full" && !args.suite.allPassed) {
    notes.push(
      "suite did not pass cleanly: " +
        args.suite.sectionsRan +
        " sections ran, " +
        args.suite.totalOk +
        " OK, allPassed=false — the tree was already merged",
    );
  }
  if (args.suite.mode === "full" && args.suite.skippedViaResume !== 0) {
    notes.push(
      "suite skipped " +
        args.suite.skippedViaResume +
        " sections via resume — a resumed run proves nothing",
    );
  }
  if (args.suite.mode === "full" && !args.suite.summaryMatchesIndependent) {
    notes.push("suite summary line does not match the independent log counts");
  }
  if (args.baseline.compared && !args.baseline.explained) {
    notes.push("baseline: " + args.baseline.explanation);
  }
  return {
    mergeId: args.mergeId,
    verdict: args.verdict,
    dryRun: args.dryRun,
    tier1InFlight: args.tier1InFlight,
    applied: args.applied,
    deleted: args.deleted,
    planned: args.planned,
    alreadyApplied: args.alreadyApplied,
    liveOnlyPreserved: args.liveOnlyPreserved,
    conflicts: args.conflicts,
    baselinesRefused: args.baselinesRefused,
    confinement: args.confinement,
    typecheck: args.typecheck,
    suite: args.suite,
    baseline: args.baseline,
    manifestCopiedAt: args.manifestCopiedAt,
    knownLimit: MERGE_KNOWN_LIMIT,
    notes,
  };
}

/** An empty (skipped) suite result — runTier1 false, or a refusal
 * before the suite step. The mode says "skipped"; the verdict logic
 * in buildMergeReport only gates on mode "full". */
function skippedSuite(tier: number): SuiteResult {
  return {
    mode: "skipped",
    tier,
    sectionsRan: 0,
    totalOk: 0,
    passLines: 0,
    sections: [],
    allPassed: true,
    skippedViaResume: 0,
    summaryLine: "",
    summaryMatchesIndependent: true,
    elapsedMs: 0,
  };
}

/** An uncompared baseline — no baseline given, or the suite skipped. */
function uncomparedBaseline(baseline: SuiteBaseline | undefined, reason: string): BaselineResult {
  return {
    compared: false,
    baselineLabel: baseline === undefined ? "" : baseline.label,
    baselineSections: baseline === undefined ? 0 : baseline.sections,
    baselineOk: baseline === undefined ? 0 : baseline.ok,
    deltaSections: 0,
    deltaOk: 0,
    expectedSections: 0,
    expectedOk: 0,
    explained: true,
    explanation: reason,
  };
}

export default function mergeCopy(input: MergeCopyInput): MergeReport {
  const bun = input.bunPath ?? "/opt/hatch-image/bin/bun";
  const dquickts = input.dquicktsPath ?? "/home/hatch/workspace/dquickts-build-minimal";
  const tier = input.tier ?? 1;
  const runTier1 = input.runTier1 ?? true;
  const doTypecheck = input.typecheck ?? true;
  const dryRun = input.dryRun ?? false;
  const liveApps = input.liveRoot + "/apps/agentts";
  const runSh = liveApps + "/run.sh";
  const noConfinement: ConfinementResult = { confined: false, extras: [], missing: [] };
  const noTypecheck: TypecheckResult = { ran: false, exitCode: -1, passed: false, stderrHead: "" };

  // 0. Scratch dir for the suite run's TMPDIR.
  const mk = exec({ cmd: "mkdir", args: ["-p", input.workDir, input.workDir + "/tmp"] });
  if (mk.exitCode !== 0) {
    throw new Error("merge: cannot create workDir " + input.workDir + " (rc " + mk.exitCode + ")");
  }
  const refused = (extraNotes: string[], tier1InFlight = false): MergeReport =>
    buildMergeReport({
      mergeId: input.mergeId,
      verdict: "failed",
      dryRun,
      tier1InFlight,
      applied: [],
      deleted: [],
      planned: [],
      alreadyApplied: [],
      liveOnlyPreserved: [],
      conflicts: [],
      baselinesRefused: [],
      confinement: noConfinement,
      typecheck: noTypecheck,
      suite: skippedSuite(tier),
      baseline: uncomparedBaseline(input.baseline, "merge refused before the suite step"),
      manifestCopiedAt: "",
      extraNotes,
    });

  // 1. Tier-1-in-flight guard: a run.sh process running against the
  // live tree means a suite is running against it — writing the
  // tree now would invalidate its resume. Scoped to liveRoot (see
  // tier1GuardScript): a run.sh elsewhere does not refuse. Exit 0
  // = a match, 1 = none, anything else = the guard itself failed,
  // loudly. The refusal carries the note exactly once: the flag
  // alone triggers it in buildMergeReport, so no extraNotes here.
  const guard = exec({
    cmd: "/bin/sh",
    args: ["-c", tier1GuardScript(input.liveRoot)],
  });
  if (guard.exitCode !== 0 && guard.exitCode !== 1) {
    throw new Error(
      "merge: tier-1 guard failed (rc " +
        guard.exitCode +
        "): " +
        ((guard.stderr ?? "") + (guard.stdout ?? "")).slice(0, 200),
    );
  }
  if (guard.exitCode === 0) {
    return refused([], true);
  }

  // 2+3. The three-way diff, computed in-shell (sparseDiffScript):
  // the manifest is read from disk and both trees are hashed inside
  // one python process; only the sparse diff crosses the trap
  // boundary (design decision 7 — a cat of the manifest or a raw
  // hash listing would blow the ~60KB trap cap on the real tree).
  // Exit 2 = manifest missing, 3 = manifest unparsable — both
  // refuse the merge, writing nothing. Any other failure throws.
  const diffExec = exec({
    cmd: "/bin/sh",
    args: ["-c", sparseDiffScript(input.copyRoot, input.liveRoot, input.copyRoot + "/" + MERGE_MANIFEST_NAME)],
  });
  if (diffExec.exitCode === 2) {
    return refused([
      "manifest missing: " +
        sparseDiffErrorMessage(diffExec.stdout) +
        " — record it with scripts/record-copy-manifest.sh at copy time",
    ]);
  }
  if (diffExec.exitCode === 3) {
    return refused(["manifest unparsable: " + sparseDiffErrorMessage(diffExec.stdout)]);
  }
  if (diffExec.exitCode !== 0) {
    throw new Error(
      "merge: sparse diff failed (rc " +
        diffExec.exitCode +
        "): " +
        (sparseDiffErrorMessage(diffExec.stdout) + " " + (diffExec.stderr ?? "")).slice(0, 200),
    );
  }
  let sparse: SparseDiff;
  try {
    sparse = parseSparseDiff(diffExec.stdout);
  } catch (e) {
    throw new Error("merge: sparse diff output is malformed: " + (e as Error).message);
  }
  // Sparse maps: only files that differ anywhere are present. A file
  // absent from all three maps has base == copy == live — the plan
  // functions classify only on differences, so the sparse maps feed
  // them exactly (proved by the sparse-vs-full §C check).
  const baseFiles: Record<string, string> = {};
  const copyFiles: Record<string, string> = {};
  const liveFiles: Record<string, string> = {};
  for (const e of sparse.diff) {
    if (e.base !== null) baseFiles[e.file] = e.base;
    if (e.copy !== null) copyFiles[e.file] = e.copy;
    if (e.live !== null) liveFiles[e.file] = e.live;
  }
  const manifestCopiedAt = sparse.copiedAt;

  // 4. Plan: confinement, baselines, classification — everything
  // before any write. Any failure here refuses the merge.
  const plan = buildMergePlan({
    claimedFiles: input.claimedFiles,
    base: baseFiles,
    copy: copyFiles,
    live: liveFiles,
  });
  const liveOnlyPreserved = [...plan.liveOnly, ...plan.liveOnlyClaimed, ...plan.liveModified];
  if (plan.baselinesRefused.length > 0 || !plan.confinement.confined || plan.conflicts.length > 0) {
    const r = buildMergeReport({
      mergeId: input.mergeId,
      verdict: "failed",
      dryRun,
      tier1InFlight: false,
      applied: [],
      deleted: [],
      planned: [...plan.plannedApply, ...plan.plannedDelete],
      alreadyApplied: plan.alreadyApplied,
      liveOnlyPreserved,
      conflicts: plan.conflicts,
      baselinesRefused: plan.baselinesRefused,
      confinement: plan.confinement,
      typecheck: noTypecheck,
      suite: skippedSuite(tier),
      baseline: uncomparedBaseline(input.baseline, "merge refused before the suite step"),
      manifestCopiedAt,
    });
    return r;
  }

  // 5. Dry-run: the plan is clean; report it, write nothing.
  const planned = [...plan.plannedApply, ...plan.plannedDelete];
  if (dryRun) {
    return buildMergeReport({
      mergeId: input.mergeId,
      verdict: "dry-run",
      dryRun: true,
      tier1InFlight: false,
      applied: [],
      deleted: [],
      planned,
      alreadyApplied: plan.alreadyApplied,
      liveOnlyPreserved,
      conflicts: [],
      baselinesRefused: [],
      confinement: plan.confinement,
      typecheck: noTypecheck,
      suite: skippedSuite(tier),
      baseline: uncomparedBaseline(input.baseline, "dry run — no suite run"),
      manifestCopiedAt,
    });
  }

  // 6. Apply, in claimed-file order (plannedApply then plannedDelete
  // are already in copyChanged order, which is sorted). A failure
  // mid-apply throws with the applied-so-far list — v0 does not roll
  // back (see the known limit).
  const apply = exec({
    cmd: "/bin/sh",
    args: [
      "-c",
      applyScript({ copyRoot: input.copyRoot, liveRoot: input.liveRoot, plannedApply: plan.plannedApply, plannedDelete: plan.plannedDelete }),
    ],
  });
  const appliedSoFar = parseAppliedLines(apply.stdout);
  if (apply.exitCode !== 0) {
    throw new Error(
      "merge: apply failed after " +
        appliedSoFar.length +
        " files (applied: " +
        appliedSoFar.join(", ") +
        ") — partial apply, NOT rolled back (rc " +
        apply.exitCode +
        "): " +
        ((apply.stderr ?? "") + (apply.stdout ?? "")).slice(0, 500),
    );
  }
  const applied = plan.plannedApply.filter((f) => appliedSoFar.includes(f));
  const deleted = plan.plannedDelete.filter((f) => appliedSoFar.includes(f));
  if (applied.length !== plan.plannedApply.length || deleted.length !== plan.plannedDelete.length) {
    throw new Error(
      "merge: apply reported success but only " +
        appliedSoFar.length +
        " of " +
        planned.length +
        " files echoed APPLIED (applied: " +
        appliedSoFar.join(", ") +
        ") — partial apply, NOT rolled back",
    );
  }

  // 7. Post-merge diff verification: re-diff in-shell; every file
  // the copy changed must now agree with the copy (an applied file
  // has the copy's content, a deleted file is gone, an
  // already-applied file still agrees). Files outside copyChanged
  // are live's business — live-only additions and live
  // modifications/deletions the copy never touched are preserved,
  // reported in liveOnlyPreserved, and never counted as a remaining
  // diff. A copyChanged file is necessarily in the post-apply diff
  // (copy != base means the triple is not all-equal), so checking
  // only the diff entries is complete.
  const liveHash2 = exec({
    cmd: "/bin/sh",
    args: ["-c", sparseDiffScript(input.copyRoot, input.liveRoot, input.copyRoot + "/" + MERGE_MANIFEST_NAME)],
  });
  if (liveHash2.exitCode !== 0) {
    throw new Error(
      "merge: re-diffing live after the apply failed (rc " +
        liveHash2.exitCode +
        ") — the tree was already merged (applied: " +
        appliedSoFar.join(", ") +
        ")",
    );
  }
  let postDiff: SparseDiff;
  try {
    postDiff = parseSparseDiff(liveHash2.stdout);
  } catch (e) {
    throw new Error("merge: post-apply sparse diff is malformed: " + (e as Error).message);
  }
  const remaining: string[] = [];
  for (const e of postDiff.diff) {
    if (plan.copyChanged.includes(e.file) && e.copy !== e.live) remaining.push(e.file);
  }
  remaining.sort();
  if (remaining.length > 0) {
    throw new Error(
      "merge: post-merge diff is not empty (remaining: " +
        remaining.join(", ") +
        ") — the tree was already merged (applied: " +
        appliedSoFar.join(", ") +
        "), NOT rolled back",
    );
  }

  // 8. Typecheck the merged tree. The output is bounded in-shell
  // (typecheckScript returns only the first 4000 bytes — a failing
  // tsc can print thousands of lines, and the raw output would blow
  // the trap cap). stderrHead therefore carries the head of the
  // combined diagnostic output, not stderr alone; the report shape
  // is unchanged.
  let typecheck: TypecheckResult = noTypecheck;
  if (doTypecheck) {
    const r = exec({
      cmd: "/bin/sh",
      args: ["-c", typecheckScript(bun, liveApps, input.workDir + "/typecheck.out")],
    });
    typecheck = {
      ran: true,
      exitCode: r.exitCode,
      passed: r.exitCode === 0,
      stderrHead: (r.stdout ?? "").slice(0, 500),
    };
  }

  // 9. Tier-1 on the merged tree, fresh resume dir. Counts come from
  // the on-disk logs; the driver's PASS line is parsed separately and
  // compared against the independent counts. The run's output is
  // bounded in-shell (tier1RunScript redirects it to a file and
  // returns only the PASS summary line — run.sh tees every section's
  // full output to its stdout, megabytes for a full tier-1, which
  // would blow the trap cap). An empty summary line means the run
  // died before its summary, and the verdict fails loudly.
  let suite: SuiteResult = skippedSuite(tier);
  if (runTier1) {
    const suiteStarted = Date.now();
    let suiteAllPassed = true;
    const r = exec({
      cmd: "/bin/sh",
      args: [
        "-c",
        tier1RunScript({
          dquickts,
          tmpdir: input.workDir + "/tmp",
          runSh,
          resumeDir: input.resumeDir,
          outPath: input.workDir + "/tier1.out",
        }),
      ],
      cwd: liveApps,
    });
    const summaryLine = r.stdout;
    if (r.exitCode !== 0) suiteAllPassed = false;
    const logDir = input.resumeDir + "/workflow/tier" + tier + "/resume/logs";
    const doneDir = input.resumeDir + "/workflow/tier" + tier + "/resume/.done";
    const agg = exec({ cmd: "/bin/sh", args: ["-c", tier1AggregationScript(logDir, doneDir)] });
    if (agg.exitCode !== 0) {
      throw new Error(
        "merge: tier log aggregation failed (rc " +
          agg.exitCode +
          ") — the tree was already merged (applied: " +
          appliedSoFar.join(", ") +
          "): " +
          (agg.stderr ?? "").slice(0, 500),
      );
    }
    const aggParsed = parseTier1Aggregation(agg.stdout);
    const suiteSections: SuiteResult["sections"] = [];
    for (let i = 0; i < aggParsed.perSection.length; i++) {
      const s = aggParsed.perSection[i];
      const verdictPresent = s.ok > 0 || s.passLines > 0;
      if (!verdictPresent) suiteAllPassed = false;
      suiteSections.push({ slug: s.slug, ok: s.ok, passLines: s.passLines, verdictPresent });
    }
    let skippedViaResume = 0;
    let summaryMatchesIndependent = true;
    const summary = parseTierSummaryLine(summaryLine);
    if (summary === null) {
      summaryMatchesIndependent = false;
    } else {
      skippedViaResume = summary.skippedViaResume;
      if (summary.sectionsRan !== aggParsed.sectionsRan) summaryMatchesIndependent = false;
      if (summary.ok !== aggParsed.totalOk) summaryMatchesIndependent = false;
      if (summary.skippedViaResume !== 0) summaryMatchesIndependent = false;
    }
    suite = {
      mode: "full",
      tier,
      sectionsRan: aggParsed.sectionsRan,
      totalOk: aggParsed.totalOk,
      passLines: aggParsed.passLines,
      sections: suiteSections,
      allPassed: suiteAllPassed,
      skippedViaResume,
      summaryLine,
      summaryMatchesIndependent,
      elapsedMs: Date.now() - suiteStarted,
    };
  }

  // 10. Baseline comparison (only when the full tier ran).
  let baseline: BaselineResult;
  if (!runTier1) {
    baseline = uncomparedBaseline(input.baseline, "suite skipped — baseline comparison not applicable");
  } else if (input.baseline === undefined) {
    baseline = uncomparedBaseline(undefined, "no baseline given — comparison skipped");
  } else {
    baseline = compareBaseline(
      { sections: suite.sectionsRan, ok: suite.totalOk },
      input.baseline,
      input.expectedAdditions ?? [],
    );
  }

  // 11. Report. The verdict is evidence, not acceptance.
  const report = buildMergeReport({
    mergeId: input.mergeId,
    verdict: "merged",
    dryRun: false,
    tier1InFlight: false,
    applied,
    deleted,
    planned,
    alreadyApplied: plan.alreadyApplied,
    liveOnlyPreserved,
    conflicts: [],
    baselinesRefused: [],
    confinement: plan.confinement,
    typecheck,
    suite,
    baseline,
    manifestCopiedAt,
  });
  if (report.notes.length > 0) report.verdict = "failed";
  return report;
}
