// rebase — bring a copy onto the latest tree before merging (BRA-262).
//
// A copy goes stale the moment live moves. The rebase is the step
// that keeps the copy fresh, so the merge applies cleanly against
// current live. Every landing rebases first; no copy merges stale.
// The rebase is the step BEFORE the merge workflow, not a second
// merge path — the merge workflow (BRA-159) stays the one way a
// copy lands. The rebase never writes live. It never merges.
//
// Mechanism (brief ~/workspace/bra261-262-263-impl-brief.md,
// decision 4 — the builder settles the mechanism, the contract
// is the guarantee):
//   1. The three-way diff comes from the merge workflow's own
//      sparse-diff script (`sparseDiffScript` + `parseSparseDiff`)
//      — the manifest is read from disk and both trees are hashed
//      inside one python process, and only the sparse diff crosses
//      the trap boundary (merge design decision 7 — a full hash
//      listing would blow the ~60KB trap cap on the real tree).
//   2. The copy's changed files come from `computeChangedFiles`
//      on the sparse maps (merge.ts proves the sparse maps feed
//      it exactly), and each one is classified with
//      `classifyMergeFile`. A file both sides changed differently
//      (action "conflict") is a rebase conflict.
//   3. On a clean rebase, the new manifest is written in-shell:
//      a python script hashes the live tree with the SAME
//      exclusion set as the sparse diff (node_modules,
//      .agentts-state, .agentts-scratch, .git, the manifest
//      itself) and writes {copiedAt, root, files: live-hashes}
//      to a temp file in the copy root, then renames it onto the
//      copy's manifest — the same format `record-copy-manifest.sh`
//      writes, with root = the copy root and copiedAt = the rebase
//      time. Only one summary line (`REBASED <count> <copiedAt>`)
//      crosses the trap boundary.
//   4. The write is verified by re-running the sparse diff: after
//      a clean rebase every diff entry must have base == live
//      (the new base IS current live). Any entry with base !=
//      live throws loudly — the rebase reports failure, never a
//      silent bad manifest.
//
// Design decisions (brief):
//
// 1. The guarantee is the contract: clean rebase → new manifest
//    against current live, copy's changes intact, live untouched;
//    conflict → refuse loudly before writing anything, the
//    conflicting files named, the copy's manifest byte-identical.
// 2. Drift is handled honestly: a conflict stops the landing.
//    The rebase never silently drops a change to make it apply.
//    A copy change the merge would refuse for another reason
//    (the baselines file) is NOT a rebase conflict — the rebase
//    only asks "does the copy apply cleanly against current
//    live"; the merge workflow refuses baselines at merge time,
//    in the honest sequence.
// 3. The rebase is Landing's step, not Quality's: it does not verify the
//    change — Quality verifies, and the verification stands on its
//    own. A rebased copy still carries its verification with it
//    (the queue entry's `verification` field is untouched by the
//    rebase; the rebase report names the copy and the new base,
//    not a verdict on the change).
// 4. The rebase is idempotent: when the manifest already matches
//    live (every diff entry has base == live), the run reports
//    "rebased" with the note "manifest already current" and
//    writes nothing — a resumed run after an interrupted one
//    does not re-write, and the recovery is recorded in the
//    report's notes.
// 5. Cancel is check-then-act (the triage pattern); a null/absent
//    run is refused, never dereferenced. Dry-run plans the
//    rebase and writes nothing.
// 6. No tier-1-in-flight guard: the rebase writes only the copy's
//    manifest, never live, so a suite running against live is
//    unaffected. Concurrent rebases of the same copy are not
//    guarded: Landing drives one landing at a time.
// 7. The workflow never closes an issue, merges code, or decides
//    acceptance. Predictor-record scoring is out of this build.
//
// Known v0 limits, carried verbatim in every report:
//
// - The rebase re-records the manifest against current live; it
//   never writes live and never merges. A conflict stops the
//   landing — the copy's manifest is left untouched. A baselines
//   change is not a rebase conflict; the merge refuses baselines
//   at merge time. Concurrent rebases of one copy are not guarded.

import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import {
  sparseDiffScript,
  parseSparseDiff,
  sparseDiffErrorMessage,
  computeChangedFiles,
  classifyMergeFile,
  MERGE_MANIFEST_NAME,
  type SparseDiff,
} from "./merge";

/** The known-limit string, carried verbatim in every report. */
export const REBASE_KNOWN_LIMIT =
  "The rebase re-records the manifest against current live; it never writes live and never merges. A conflict stops the landing — the copy's manifest is left untouched. " +
  "A baselines change is not a rebase conflict; the merge refuses baselines at merge time. Concurrent rebases of one copy are not guarded.";

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface RebaseProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster?: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the
   * rebase v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir?: string;
}

export interface RebaseRunInput {
  /** e.g. "BRA-262". */
  rebaseId: string;
  /** Absolute path to the worker copy. */
  copyRoot: string;
  /** Absolute path to the live tree. */
  liveRoot: string;
  /** Absolute scratch dir (work files). Created by the workflow. */
  workDir: string;
  /** Resume dir (carried for the set — the rebase is idempotent,
   * so a resumed run re-reads the manifest rather than the dir). */
  resumeDir: string;
  dryRun?: boolean;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  bunPath?: string;
}

export interface RebaseInput {
  project: RebaseProjectConfig;
  run: RebaseRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

/** One rebase conflict: the file, and why the rebase refuses it. */
export interface RebaseConflict {
  file: string;
  reason: string;
}

export interface RebaseReport {
  rebaseId: string;
  verdict: "rebased" | "dry-run" | "failed";
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  copyRoot: string;
  liveRoot: string;
  /** The copy's changed files, now applying against the new base. */
  rebasedFiles: string[];
  /** Copy-changed files already identical in copy and live. */
  alreadyApplied: string[];
  conflicts: RebaseConflict[];
  /** The new manifest's copiedAt ("" when no manifest was written). */
  manifestCopiedAt: string;
  /** The old manifest's copiedAt ("" when no manifest was read). */
  previousManifestCopiedAt: string;
  notes: string[];
  knownLimit: string;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** Validate the run input. Pure — returns the error strings (empty
 * when valid), each naming the missing or malformed field. The
 * entry converts these into a refused report; nothing throws for
 * bad input. A null/absent run is an error here too, but the entry
 * guards it first (never dereferenced). */
export function validateRebaseInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["rebase: input is not an object"];
  const project = (input as JsonObject).project;
  const run = (input as JsonObject).run;
  if (!isPlainObject(project)) errors.push("rebase: input has no project object");
  else {
    const p = project as JsonObject;
    for (const f of ["linearProject", "repo", "stateDir", "workDir"]) {
      if (!isNonEmptyString(p[f])) errors.push("rebase: project has no " + f + " string");
    }
  }
  if (!isPlainObject(run)) {
    errors.push("rebase: input has no run object");
    return errors;
  }
  const r = run as JsonObject;
  if (!isNonEmptyString(r.rebaseId)) errors.push("rebase: run has no rebaseId string");
  for (const f of ["copyRoot", "liveRoot", "workDir", "resumeDir"]) {
    if (!isNonEmptyString(r[f])) errors.push("rebase: run has no " + f + " string");
  }
  if (r.dryRun !== undefined && typeof r.dryRun !== "boolean") {
    errors.push("rebase: run.dryRun must be a boolean when present");
  }
  if (r.runId !== undefined && typeof r.runId !== "string") {
    errors.push("rebase: run.runId must be a string when present");
  }
  if (!isNonEmptyString((input as JsonObject).owner)) {
    errors.push("rebase: input has no owner string — the owner is the driving session, never assumed from the launcher");
  }
  return errors;
}

/** Classify the copy's changed files against current live. Pure —
 * unit-tested directly. Returns the files that rebase cleanly
 * (apply / delete / already-applied) and the conflicts (both
 * sides changed the file differently). */
export function classifyRebaseChanges(args: {
  base: Record<string, string>;
  copy: Record<string, string>;
  live: Record<string, string>;
}): { rebasedFiles: string[]; alreadyApplied: string[]; conflicts: RebaseConflict[] } {
  const { copyChanged } = computeChangedFiles({ base: args.base, copy: args.copy, live: args.live });
  const rebasedFiles: string[] = [];
  const alreadyApplied: string[] = [];
  const conflicts: RebaseConflict[] = [];
  for (const f of copyChanged) {
    const c = classifyMergeFile({ file: f, base: args.base[f], copy: args.copy[f], live: args.live[f] });
    if (c.action === "conflict") conflicts.push({ file: f, reason: c.reason });
    else if (c.action === "already-applied") alreadyApplied.push(f);
    else rebasedFiles.push(f);
  }
  return { rebasedFiles, alreadyApplied, conflicts };
}

/** Build the sparse hash maps from a parsed sparse diff. Pure. */
export function sparseMaps(sparse: SparseDiff): {
  base: Record<string, string>;
  copy: Record<string, string>;
  live: Record<string, string>;
} {
  const base: Record<string, string> = {};
  const copy: Record<string, string> = {};
  const live: Record<string, string> = {};
  for (const e of sparse.diff) {
    if (e.base !== null) base[e.file] = e.base;
    if (e.copy !== null) copy[e.file] = e.copy;
    if (e.live !== null) live[e.file] = e.live;
  }
  return { base, copy, live };
}

/** The manifest-write script: hash the live tree in-shell (the
 * SAME exclusion set as the sparse diff) and write the new
 * manifest {copiedAt, root, files: live-hashes} to a temp file in
 * the copy root, then rename it onto the copy's manifest — the
 * same format record-copy-manifest.sh writes. Only one summary
 * line (`REBASED <count> <copiedAt>`) crosses the trap boundary.
 * Exit codes: 0 = wrote + verified the JSON parses; 1 = any
 * failure (an error line on stdout). Pure — the script's shape
 * is unit-tested; the §D cases drive it end to end. */
export function rebaseManifestScript(args: {
  liveRoot: string;
  copyRoot: string;
  tmpPath: string;
  manifestPath: string;
}): string {
  const py = [
    "import json, re, subprocess, sys, os",
    "from datetime import datetime, timezone",
    "live_root, tmp_path, manifest_path, root = sys.argv[1:5]",
    "FIND = [\"find\", \".\", \"(\", \"-name\", \"node_modules\", \"-o\", \"-name\", \".agentts-state\", \"-o\", \"-name\", \".agentts-scratch\", \"-o\", \"-name\", \".git\", \")\", \"-prune\", \"-o\", \"-type\", \"f\", \"-not\", \"-name\", \".agentts-copy-manifest.json\", \"-print0\"]",
    "def hashes(root):",
    "    r = subprocess.run(FIND, cwd=root, capture_output=True)",
    "    if r.returncode != 0:",
    "        print(\"REBASE-ERROR find failed in \" + root)",
    "        raise SystemExit(1)",
    "    paths = sorted(p for p in r.stdout.split(b\"\\0\") if p)",
    "    out = {}",
    "    for i in range(0, len(paths), 500):",
    "        rr = subprocess.run([\"sha256sum\"] + [p.decode() for p in paths[i:i+500]], cwd=root, capture_output=True, text=True)",
    "        if rr.returncode != 0:",
    "            print(\"REBASE-ERROR sha256sum failed in \" + root)",
    "            raise SystemExit(1)",
    "        for line in rr.stdout.splitlines():",
    "            parts = line.split(None, 1)",
    "            if len(parts) != 2:",
    "                print(\"REBASE-ERROR cannot parse sha256sum line: \" + repr(line))",
    "                raise SystemExit(1)",
    "            hh, pp = parts",
    "            if pp.startswith(\"./\"): pp = pp[2:]",
    "            out[pp] = hh",
    "    return out",
    "live = hashes(live_root)",
    "copied_at = datetime.now(timezone.utc).isoformat()",
    "manifest = {\"copiedAt\": copied_at, \"root\": root, \"files\": live}",
    "with open(tmp_path, \"w\") as f:",
    "    json.dump(manifest, f, indent=1, sort_keys=True)",
    "    f.write(\"\\n\")",
    "with open(tmp_path) as f:",
    "    check = json.load(f)",
    "if check.get(\"copiedAt\") != copied_at or not isinstance(check.get(\"files\"), dict):",
    "    print(\"REBASE-ERROR written manifest does not parse back\")",
    "    raise SystemExit(1)",
    "os.rename(tmp_path, manifest_path)",
    "print(\"REBASED %d %s\" % (len(live), copied_at))",
  ];
  return (
    "python3 - " +
    shellQuote(args.liveRoot) +
    " " +
    shellQuote(args.tmpPath) +
    " " +
    shellQuote(args.manifestPath) +
    " " +
    shellQuote(args.copyRoot) +
    " <<'REBASE_MANIFEST_PY'\n" +
    py.join("\n") +
    "\nREBASE_MANIFEST_PY"
  );
}

/** Parse the manifest-write trap's one-line summary: `REBASED
 * <count> <copiedAt>`. Throws loudly on anything else. Pure. */
export function parseRebasedOutput(text: string): { count: number; copiedAt: string } {
  const line = text.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  const m = /^REBASED (\d+) (\S+)$/.exec(line);
  if (!m) throw new Error("rebase: manifest write output is not a REBASED line: " + JSON.stringify(text.slice(0, 200)));
  return { count: Number(m[1]), copiedAt: m[2] };
}

/** Assemble the report. Pure. The verdict is "rebased" only when
 * the manifest was re-recorded (or was already current); "dry-run"
 * when the plan is clean and nothing was written; "failed"
 * otherwise. Every failure is named in notes. */
export function buildRebaseReport(args: {
  rebaseId: string;
  verdict: RebaseReport["verdict"];
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  copyRoot: string;
  liveRoot: string;
  rebasedFiles: string[];
  alreadyApplied: string[];
  conflicts: RebaseConflict[];
  manifestCopiedAt: string;
  previousManifestCopiedAt: string;
  extraNotes?: string[];
}): RebaseReport {
  const notes: string[] = [...(args.extraNotes ?? [])];
  if (args.cancelled) {
    notes.push("run cancelled — rebase refused, nothing was written");
  }
  for (const c of args.conflicts) {
    notes.push("conflict on " + c.file + ": " + c.reason);
  }
  return {
    rebaseId: args.rebaseId,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    copyRoot: args.copyRoot,
    liveRoot: args.liveRoot,
    rebasedFiles: args.rebasedFiles,
    alreadyApplied: args.alreadyApplied,
    conflicts: args.conflicts,
    manifestCopiedAt: args.manifestCopiedAt,
    previousManifestCopiedAt: args.previousManifestCopiedAt,
    notes,
    knownLimit: REBASE_KNOWN_LIMIT,
  };
}

export default function rebaseCopy(input: RebaseInput): RebaseReport {
  const dryRun = input?.run?.dryRun ?? false;
  let cancelChecked = false;
  let cancelled = false;
  const refusedReport = (extraNotes: string[], rebaseId?: string): RebaseReport =>
    buildRebaseReport({
      rebaseId: rebaseId ?? (typeof input?.run?.rebaseId === "string" ? input.run.rebaseId : ""),
      verdict: "failed",
      dryRun,
      owner: typeof input?.owner === "string" ? input.owner : "",
      launchedBy: input?.launchedBy,
      cancelChecked,
      cancelled,
      copyRoot: typeof input?.run?.copyRoot === "string" ? input.run.copyRoot : "",
      liveRoot: typeof input?.run?.liveRoot === "string" ? input.run.liveRoot : "",
      rebasedFiles: [],
      alreadyApplied: [],
      conflicts: [],
      manifestCopiedAt: "",
      previousManifestCopiedAt: "",
      extraNotes,
    });

  // Validate first, fail-closed. A null/absent run is refused,
  // never dereferenced (this workflow validates first, so it does
  // not have the defect).
  if (!isPlainObject(input)) return refusedReport(["rebase: input is not an object"]);
  if (!isPlainObject((input as JsonObject).run)) {
    return refusedReport(["rebase: input has no run object"]);
  }
  const run = (input as RebaseInput).run;
  const validationErrors = validateRebaseInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors, run.rebaseId);
  }
  const stateDir = (input as RebaseInput).project.stateDir;

  // Cancel check first (when runId present): check-then-act before
  // any read or write. Exit 2 (no queue entry) and exit 3 (queue
  // missing/unparsable) mean the check did not complete — the run
  // refuses with cancelChecked false. A cancelled run refuses
  // with cancelChecked true + cancelled true.
  if (typeof run.runId === "string" && run.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, run.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["rebase: cancel check: no queue entry for run " + run.runId], run.rebaseId);
    }
    if (check.exitCode === 3) {
      return refusedReport(["rebase: cancel check: " + (check.stdout ?? "").trim().slice(0, 200)], run.rebaseId);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "rebase: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout ?? "");
    } catch (e) {
      throw new Error("rebase: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["rebase: run " + run.runId + " is cancelled — the rebase exits cleanly without advancing"], run.rebaseId);
    }
  }

  // Scratch dir for the suite run's TMPDIR (kept for the set —
  // the rebase itself needs no suite run).
  const mk = exec({ cmd: "mkdir", args: ["-p", run.workDir, run.workDir + "/tmp"] });
  if (mk.exitCode !== 0) {
    throw new Error("rebase: cannot create workDir " + run.workDir + " (rc " + mk.exitCode + ")");
  }
  const manifestPath = run.copyRoot + "/" + MERGE_MANIFEST_NAME;

  // The three-way diff, computed in-shell (the merge workflow's
  // sparse-diff script): only the sparse diff crosses the trap
  // boundary. Exit 2 = manifest missing, 3 = manifest unparsable
  // — both refuse the rebase, writing nothing. Any other failure
  // throws.
  const diffExec = exec({
    cmd: "/bin/sh",
    args: ["-c", sparseDiffScript(run.copyRoot, run.liveRoot, manifestPath)],
  });
  if (diffExec.exitCode === 2) {
    return refusedReport(
      ["manifest missing: " + sparseDiffErrorMessage(diffExec.stdout) + " — record it with scripts/record-copy-manifest.sh at copy time"],
      run.rebaseId,
    );
  }
  if (diffExec.exitCode === 3) {
    return refusedReport(["manifest unparsable: " + sparseDiffErrorMessage(diffExec.stdout)], run.rebaseId);
  }
  if (diffExec.exitCode !== 0) {
    throw new Error(
      "rebase: sparse diff failed (rc " +
        diffExec.exitCode +
        "): " +
        (sparseDiffErrorMessage(diffExec.stdout) + " " + (diffExec.stderr ?? "")).slice(0, 200),
    );
  }
  let sparse: SparseDiff;
  try {
    sparse = parseSparseDiff(diffExec.stdout);
  } catch (e) {
    throw new Error("rebase: sparse diff output is malformed: " + (e as Error).message);
  }
  const { base, copy, live } = sparseMaps(sparse);
  const previousManifestCopiedAt = sparse.copiedAt;

  // Classify the copy's changes. Any conflict refuses the rebase
  // before anything is written.
  const { rebasedFiles, alreadyApplied, conflicts } = classifyRebaseChanges({ base, copy, live });
  if (conflicts.length > 0) {
    return buildRebaseReport({
      rebaseId: run.rebaseId,
      verdict: "failed",
      dryRun,
      owner: (input as RebaseInput).owner,
      launchedBy: (input as RebaseInput).launchedBy,
      cancelChecked,
      cancelled,
      copyRoot: run.copyRoot,
      liveRoot: run.liveRoot,
      rebasedFiles: [],
      alreadyApplied,
      conflicts,
      manifestCopiedAt: "",
      previousManifestCopiedAt,
      extraNotes: ["rebase refused: " + conflicts.length + " conflicting file(s) — the landing stops, the copy's manifest is untouched"],
    });
  }

  // Already current: every diff entry has base == live, so the
  // manifest already matches live. Nothing to write (idempotent
  // re-run after an interrupted one records the recovery here).
  const alreadyCurrent = sparse.diff.every((e) => e.base === e.live);
  if (alreadyCurrent) {
    return buildRebaseReport({
      rebaseId: run.rebaseId,
      verdict: "rebased",
      dryRun,
      owner: (input as RebaseInput).owner,
      launchedBy: (input as RebaseInput).launchedBy,
      cancelChecked,
      cancelled,
      copyRoot: run.copyRoot,
      liveRoot: run.liveRoot,
      rebasedFiles,
      alreadyApplied,
      conflicts: [],
      manifestCopiedAt: previousManifestCopiedAt,
      previousManifestCopiedAt,
      extraNotes: ["manifest already current (base == live) — nothing written"],
    });
  }

  if (dryRun) {
    return buildRebaseReport({
      rebaseId: run.rebaseId,
      verdict: "dry-run",
      dryRun: true,
      owner: (input as RebaseInput).owner,
      launchedBy: (input as RebaseInput).launchedBy,
      cancelChecked,
      cancelled,
      copyRoot: run.copyRoot,
      liveRoot: run.liveRoot,
      rebasedFiles,
      alreadyApplied,
      conflicts: [],
      manifestCopiedAt: "",
      previousManifestCopiedAt,
      extraNotes: ["dry-run: would re-record the manifest against current live (" + rebasedFiles.length + " file(s) applying) — nothing written"],
    });
  }

  // Write the new manifest in-shell (live hashes, temp + rename),
  // then verify by re-running the sparse diff: every entry must
  // now have base == live.
  const tmpManifest = manifestPath + ".tmp";
  const write = exec({
    cmd: "/bin/sh",
    args: ["-c", rebaseManifestScript({ liveRoot: run.liveRoot, copyRoot: run.copyRoot, tmpPath: tmpManifest, manifestPath })],
  });
  if (write.exitCode !== 0) {
    throw new Error(
      "rebase: manifest write failed (rc " +
        write.exitCode +
        "): " +
        ((write.stdout ?? "") + (write.stderr ?? "")).slice(0, 200),
    );
  }
  const rebased = parseRebasedOutput(write.stdout ?? "");
  const verifyExec = exec({
    cmd: "/bin/sh",
    args: ["-c", sparseDiffScript(run.copyRoot, run.liveRoot, manifestPath)],
  });
  if (verifyExec.exitCode !== 0) {
    throw new Error(
      "rebase: manifest verification diff failed (rc " +
        verifyExec.exitCode +
        ") — the manifest was already written, verify it by hand: " +
        (sparseDiffErrorMessage(verifyExec.stdout) + " " + (verifyExec.stderr ?? "")).slice(0, 200),
    );
  }
  let verifySparse: SparseDiff;
  try {
    verifySparse = parseSparseDiff(verifyExec.stdout);
  } catch (e) {
    throw new Error("rebase: manifest verification diff is malformed: " + (e as Error).message);
  }
  if (verifySparse.copiedAt !== rebased.copiedAt) {
    throw new Error(
      "rebase: manifest verification failed — the re-read manifest carries copiedAt " +
        JSON.stringify(verifySparse.copiedAt) +
        ", expected " +
        JSON.stringify(rebased.copiedAt),
    );
  }
  const stale = verifySparse.diff.filter((e) => e.base !== e.live);
  if (stale.length > 0) {
    throw new Error(
      "rebase: manifest verification failed — " +
        stale.length +
        " file(s) still have base != live after the write: " +
        stale.map((e) => e.file).join(", "),
    );
  }

  return buildRebaseReport({
    rebaseId: run.rebaseId,
    verdict: "rebased",
    dryRun: false,
    owner: (input as RebaseInput).owner,
    launchedBy: (input as RebaseInput).launchedBy,
    cancelChecked,
    cancelled,
    copyRoot: run.copyRoot,
    liveRoot: run.liveRoot,
    rebasedFiles,
    alreadyApplied,
    conflicts: [],
    manifestCopiedAt: rebased.copiedAt,
    previousManifestCopiedAt,
    extraNotes: ["manifest re-recorded against current live (" + rebased.count + " files in the new base)"],
  });
}
