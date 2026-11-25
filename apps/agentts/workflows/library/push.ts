// push — rebuild the push manifest from the dev baseline, verify
// every file against origin, push to dev, verify what landed via
// the GitHub API, report back with the commit (BRA-260).
//
// The land path's last step: merges land to the live tree, but the
// push to dev is still done by hand — twice so far (post-r1 push,
// skill-move push), by the same procedure, each time a person
// rebuilding the manifest, verifying files against origin, pushing,
// verifying via the GitHub API. This workflow makes it repeatable
// and machine-driven, under Landing's landing authorization — never
// under a per-push approval from Brandon (his standing preference,
// Nov 17, 2026: push frequently without approving 3–4 approval
// cards per push; a durable fix so future pushes don't each
// require his approval).
//
// The workflow sends no messages. The report returns one delivery
// payload per recipient (Landing + the Director; target "director" or
// a lead chat id from the roster — the server-restart pattern) and
// the launcher delivers them.
//
// Design decisions (brief ~/workspace/bra260-256-impl-brief.md,
// decisions 3 + 5, settled by the builder):
//
// 1. The push's checkout: the run input's `checkoutPath` — a git
//    clone of brandf/agentts checked out at `dev`, prepared by the
//    launcher (Landing) before driving the workflow. The workflow
//    validates it (a git work tree, remote origin as expected,
//    checked out at the branch) and refuses loudly otherwise. It
//    never clones origin itself and never handles credentials: the
//    push uses the checkout's own remote / credential
//    configuration as prepared by the launcher. Evidence: on this
//    VM there is no git checkout of agentts anywhere (the live
//    tree has no .git, and no .git exists under ~/workspace except
//    the dquickts builds) and `gh` is not logged in — so the
//    workflow cannot assume a checkout exists. In §D the fixture
//    checkout is prepared by the test (git init + a local bare
//    repo as origin).
// 2. The dev baseline: the state of origin's `dev` branch at
//    manifest-build time — the dev tip commit sha plus the
//    (path -> git blob sha) map from `git ls-tree -r origin/dev`,
//    read live from the checkout's origin remote after a bounded
//    `git fetch`, and recorded in the manifest as `devTip`. It is
//    not a file on disk. The manifest is rebuilt fresh from the
//    dev baseline on every run, never carried forward.
// 3. The manifest: JSON at `<workDir>/push-manifest.json` —
//    {pushId, queueIssue, copies, order, devTip, builtAt,
//    entries}. Its input is the land queue's order: the queue
//    `run.queueIssue` (its `copies` + `order`); the file list
//    comes from the merge report at `run.mergeReportPath`
//    (applied + alreadyApplied — the files that landed); the
//    content comes from the live tree at `run.liveRoot` (each file
//    read and hashed). One row per file: {path, sha256, blobSha,
//    status: "to-push" | "already-on-dev"} — a file whose blob sha
//    already matches dev's tree is already on dev and is not
//    re-pushed (still reported).
// 4. Verify against origin, before pushing: every file in the
//    manifest is read from the live tree and hashed (sha256 +
//    git blob sha), copied into the checkout, re-read and
//    re-hashed there — a mismatch (or a missing/unreadable file)
//    refuses loudly, naming the file, and nothing is pushed.
//    After pushing: the workflow checks via the GitHub API that
//    what was pushed is what landed on dev (the dev tip must
//    equal the pushed commit, and every file's blob sha on dev
//    must equal the manifest's) and reports back with the commit.
//    A push the API can't confirm is reported as not-verified,
//    never as landed.
// 5. The GitHub API verification route: `gh api` first (the gh
//    CLI, when authed in the run's environment — one contents
//    call per file, `repos/<owner>/<repo>/contents/<path>?ref=dev`,
//    which returns the blob sha); fallback `curl` to
//    api.github.com with GH_TOKEN / GITHUB_TOKEN from the
//    environment (never from the input, never logged, never in
//    the report). When neither is available, the push is reported
//    not-verified with the reason named. When the remote is not
//    github.com (fixtures: `verifyViaRefs`, a local bare repo as
//    origin), verification reads the remote's refs instead
//    (`git ls-remote` for the tip, `git --git-dir=<remote> show
//    dev:<path> | git hash-object --stdin` per file). The route
//    used is recorded in the report.
// 6. The hold flag: run input `holdPush` (a boolean, never a
//    hardcoded branch name). A held push reports the hold and
//    stops — checked right after validation + the cancel check,
//    before any read or write, so a held push pushes nothing and
//    writes nothing.
// 7. Interrupted push: before any push attempt, the workflow
//    re-reads the dev baseline (fresh fetch) and compares every
//    manifest file's blob sha against dev's tree — if every file
//    already matches, the push already landed and the workflow
//    reports already-pushed (verified) instead of pushing twice.
//    A retry after an interrupted push runs the same check first
//    — never blind-retry. A partial landing (some files already
//    on dev) commits only the rest, and the report names both.
// 8. The push runs under Landing's landing authorization — the merge
//    authorization for the landing, taken from the queue entry's
//    `authorization` field, else `run.authorization`. A real push
//    without an authorization refuses before the push step (the
//    merge workflow's decision-1 rule); a dry-run without one is
//    fine, because Landing needs the dry-run plan to verify before
//    authorizing. The authorization is carried verbatim in the
//    report.
// 9. The queue file is never rewritten by this workflow. A
//    blocked queue entry refuses with the failure named (the entry
//    stays in the file with the failure named — the verdict route
//    carries it). The workflow never merges, never closes, never
//    decides acceptance. Predictor-record scoring is out of this
//    build.
// 10. Cancel is check-then-act (the triage pattern); a null/absent
//     run is refused, never dereferenced. Dry-run plans the push
//     and writes nothing — no manifest, no commit, no push, no
//     delivery payloads.
//
// Reads and writes go through exec traps in the dispatch pattern,
// never trap stdout, never `Buffer`. Per-file read bounds: 48KB
// generic, 16KB for the queue entry (the extraction script prints
// one entry only — the queue file itself is 46KB and growing, so
// it is never read whole). The dev tree is read with pathspecs
// for exactly the manifest files, never the whole tree (the full
// `ls-tree -r` output would exceed the ~60KB exec-trap stdout
// cap). The GitHub API check is a bounded `gh`/`curl` call per
// file, never an unbounded wait.
import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import { splitHandoffChunks, appendChunkScript, parseWriteSummary, base64EncodeUtf8 } from "./dispatch";
import { readFileScript, parseReadOutput, chunkWriteScript, finalizeWriteScript } from "./daily-brief";
import { type MergeAuthorization } from "./merge";

/** The known-limit string, carried verbatim in every report. */
export const PUSH_KNOWN_LIMIT =
  "The push runs under Landing's landing authorization, never a per-push Brandon approval. " +
  "The checkout is prepared by the launcher — the workflow never clones origin and never handles credentials. " +
  "A push the GitHub API can't confirm is reported as not-verified, never as landed. " +
  "The queue file is never rewritten by this workflow. Predictor-record scoring is out of this build.";

/** Per-file read bound (bytes of decoded text): far under the
 * ~60KB exec-trap stdout cap, with headroom for the READ header. */
export const PUSH_READ_MAX_BYTES = 48 * 1024;
/** The queue-entry extraction bound: the script prints one entry
 * only, so the bound is on the entry JSON, not the queue file. */
export const PUSH_QUEUE_ENTRY_MAX_BYTES = 16 * 1024;

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface PushProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster?: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the push
   * v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir?: string;
}

export interface PushRunInput {
  /** e.g. "BRA-260". */
  pushId: string;
  /** Absolute path to the land-queue file. */
  queuePath: string;
  /** The queue entry to push, e.g. "BRA-256". */
  queueIssue: string;
  /** Absolute path to the merge report for that entry — the file
   * list (applied + alreadyApplied) comes from it. */
  mergeReportPath: string;
  /** The live tree root — the landed content is read from here. */
  liveRoot: string;
  /** A git clone of brandf/agentts checked out at the branch,
   * prepared by the launcher. */
  checkoutPath: string;
  /** The branch to push to. Default "dev". */
  branch?: string;
  /** Absolute scratch dir (the manifest lives here). Created by
   * the workflow. */
  workDir: string;
  /** The dev push is held: report the hold and stop, push
   * nothing. A run-input flag, never a hardcoded branch name. */
  holdPush?: boolean;
  /** Verify what landed via the remote's refs instead of the
   * GitHub API (fixtures: a local bare repo as origin). */
  verifyViaRefs?: boolean;
  /** Overrides the checkout's origin (fixtures: the local bare
   * repo path). When absent, the checkout's own origin is used. */
  remoteUrl?: string;
  /** The authorization the push runs under (the merge
   * authorization for the landing). The queue entry's
   * `authorization` field takes precedence when present. */
  authorization?: MergeAuthorization;
  /** The commit author (git needs user.name/user.email). */
  commitAuthor?: { name: string; email: string };
  dryRun?: boolean;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  /** Caller-supplied now (ISO), for the manifest's builtAt. When
   * absent, the workflow reads the clock. */
  now?: string;
  bunPath?: string;
}

export interface PushInput {
  project: PushProjectConfig;
  run: PushRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

export interface DeliveryPayload {
  /** "director" or a lead chat id (the run owner's session). */
  target: string;
  message: string;
}

export interface PushManifestEntry {
  path: string;
  sha256: string;
  blobSha: string;
  status: "to-push" | "already-on-dev";
}

export interface PushManifest {
  pushId: string;
  queueIssue: string;
  /** The queue entry's copies + order — the push step's input
   * (the queue orders what the push step pushes). */
  copies: string[];
  order?: number;
  devTip: string;
  builtAt: string;
  entries: PushManifestEntry[];
}

export interface PushFileVerification {
  path: string;
  confirmed: boolean;
  /** The reason, when not confirmed. */
  reason?: string;
}

export interface PushVerification {
  route: "github-api" | "refs" | "none";
  /** True when the dev tip equals the pushed commit AND every
   * file's blob sha on dev equals the manifest's. */
  confirmed: boolean;
  tipConfirmed: boolean;
  filesConfirmed: number;
  filesTotal: number;
  perFile: PushFileVerification[];
  /** The reason, when the route is "none" or not confirmed. */
  reason?: string;
}

export type PushVerdict = "pushed" | "already-pushed" | "held" | "not-verified" | "failed" | "dry-run";

export interface PushReport {
  pushId: string;
  verdict: PushVerdict;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  queueIssue: string;
  /** The manifest path, when the manifest was built. */
  manifestPath?: string;
  manifest?: PushManifest;
  /** The pushed commit sha, or the dev tip for already-pushed. */
  commit?: string;
  devTip?: string;
  verification?: PushVerification;
  authorization?: MergeAuthorization | null;
  deliveryPayloads: DeliveryPayload[];
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

/** Light authorization validation (the merge workflow's
 * decision-2 shape): authorizer and authorizedAt must be
 * non-empty strings; channel, verificationSummary, and
 * expectedNewBaseline must be strings (empty allowed); note,
 * when present, must be a string. Pure. */
export function validatePushAuthorization(auth: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(auth)) return ["push: authorization is not an object"];
  if (!isNonEmptyString(auth.authorizer)) errors.push("push: authorization.authorizer must be a non-empty string");
  if (!isNonEmptyString(auth.authorizedAt)) errors.push("push: authorization.authorizedAt must be a non-empty string");
  if (typeof auth.channel !== "string") errors.push("push: authorization.channel must be a string");
  if (typeof auth.verificationSummary !== "string") errors.push("push: authorization.verificationSummary must be a string");
  if (typeof auth.expectedNewBaseline !== "string") errors.push("push: authorization.expectedNewBaseline must be a string");
  if (auth.note !== undefined && typeof auth.note !== "string") errors.push("push: authorization.note must be a string when present");
  return errors;
}

/** Validate the run input. Pure — returns the error strings
 * (empty when valid), each naming the missing or malformed field.
 * The entry converts these into a refused report; nothing throws
 * for bad input. A null/absent run is an error here too, but the
 * entry guards it first (never dereferenced). */
export function validatePushInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["push: input is not an object"];
  if (!isPlainObject(input.project)) errors.push("push: project is not an object");
  else {
    if (!isNonEmptyString(input.project.linearProject)) errors.push("push: project.linearProject must be a non-empty string");
    if (!isNonEmptyString(input.project.repo)) errors.push("push: project.repo must be a non-empty string");
    if (!isNonEmptyString(input.project.stateDir)) errors.push("push: project.stateDir must be a non-empty string");
    if (!isNonEmptyString(input.project.workDir)) errors.push("push: project.workDir must be a non-empty string");
  }
  if (!isPlainObject(input.run)) errors.push("push: run is not an object");
  else {
    const run = input.run as JsonObject;
    if (!isNonEmptyString(run.pushId)) errors.push("push: run.pushId must be a non-empty string");
    if (!isNonEmptyString(run.queuePath)) errors.push("push: run.queuePath must be a non-empty string");
    if (!isNonEmptyString(run.queueIssue)) errors.push("push: run.queueIssue must be a non-empty string");
    if (!isNonEmptyString(run.mergeReportPath)) errors.push("push: run.mergeReportPath must be a non-empty string");
    if (!isNonEmptyString(run.liveRoot)) errors.push("push: run.liveRoot must be a non-empty string");
    if (!isNonEmptyString(run.checkoutPath)) errors.push("push: run.checkoutPath must be a non-empty string");
    if (!isNonEmptyString(run.workDir)) errors.push("push: run.workDir must be a non-empty string");
    if (run.branch !== undefined && !isNonEmptyString(run.branch)) errors.push("push: run.branch must be a non-empty string when present");
    if (run.holdPush !== undefined && typeof run.holdPush !== "boolean") errors.push("push: run.holdPush must be a boolean when present");
    if (run.verifyViaRefs !== undefined && typeof run.verifyViaRefs !== "boolean") errors.push("push: run.verifyViaRefs must be a boolean when present");
    if (run.remoteUrl !== undefined && !isNonEmptyString(run.remoteUrl)) errors.push("push: run.remoteUrl must be a non-empty string when present");
    if (run.authorization !== undefined) {
      for (const e of validatePushAuthorization(run.authorization)) errors.push(e);
    }
    if (run.commitAuthor !== undefined) {
      if (!isPlainObject(run.commitAuthor) || !isNonEmptyString(run.commitAuthor.name) || !isNonEmptyString(run.commitAuthor.email)) {
        errors.push("push: run.commitAuthor must be {name, email} with non-empty strings when present");
      }
    }
    if (run.dryRun !== undefined && typeof run.dryRun !== "boolean") errors.push("push: run.dryRun must be a boolean when present");
    if (run.runId !== undefined && typeof run.runId !== "string") errors.push("push: run.runId must be a string when present");
    if (run.now !== undefined && typeof run.now !== "string") errors.push("push: run.now must be a string when present");
  }
  if (typeof input.owner !== "string" || input.owner === "") errors.push("push: owner must be a non-empty string");
  return errors;
}

// ------------------------------------------------------------------
// Pure script builders (unit-tested; the §D cases drive them end
// to end). Every script prints small, bounded output — a file's
// content never crosses the trap boundary.
// ------------------------------------------------------------------

/** The queue-entry extraction script: load the queue file (a dict
 * with an `items` list, or a bare list — both shapes are
 * accepted), find the entry by issue, print it as one compact
 * JSON line prefixed `ENTRY `. Prints `ENTRY-MISSING` when no
 * entry matches. Exit codes: 0 = read; 2 = file missing or
 * unparsable. The output is bounded by one entry, never the whole
 * queue file. Pure. */
export function queueEntryReadScript(queuePath: string, issue: string): string {
  return [
    "python3 -c '",
    "import json, sys",
    "p = sys.argv[1]",
    "want = sys.argv[2]",
    "try:",
    "    d = json.load(open(p))",
    "except FileNotFoundError:",
    "    print(\"ENTRY-ERROR queue file not found: \" + p)",
    "    raise SystemExit(2)",
    "except ValueError as e:",
    "    print(\"ENTRY-ERROR queue file does not parse: \" + str(e)[:150])",
    "    raise SystemExit(2)",
    "items = d if isinstance(d, list) else d.get(\"items\", d.get(\"queue\", []))",
    "for e in items:",
    "    if isinstance(e, dict) and e.get(\"issue\") == want:",
    "        print(\"ENTRY \" + json.dumps(e, separators=(\",\", \":\")))",
    "        raise SystemExit(0)",
    "print(\"ENTRY-MISSING \" + want)",
    "' " + shellQuote(queuePath) + " " + shellQuote(issue),
  ].join("\n");
}

/** Parse the queue-entry script's output. Returns the entry object,
 * or null when the script printed ENTRY-MISSING. Throws loudly on
 * anything else (including the ENTRY-ERROR lines). Pure. */
export function parseQueueEntryOutput(text: string): Record<string, unknown> | null {
  const line = text.trim().split("\n").find((l) => l.trim() !== "");
  if (!line) throw new Error("push: queue entry output is empty");
  if (line.startsWith("ENTRY-MISSING")) return null;
  if (line.startsWith("ENTRY-ERROR")) throw new Error("push: " + line);
  if (!line.startsWith("ENTRY ")) throw new Error("push: queue entry output is not an ENTRY line: " + JSON.stringify(line.slice(0, 200)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice("ENTRY ".length));
  } catch (e) {
    throw new Error("push: queue entry does not parse: " + (e as Error).message);
  }
  if (!isPlainObject(parsed)) throw new Error("push: queue entry has the wrong shape (expected an object)");
  return parsed;
}

/** Validate one queue entry's fields (the queue file is never
 * rewritten by this workflow — the entry is read-only input).
 * Returns the error strings (empty when valid). Pure. */
export function validateQueueEntry(entry: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(entry)) return ["push: queue entry is not an object"];
  if (!isNonEmptyString(entry.issue)) errors.push("push: queue entry.issue must be a non-empty string");
  if (typeof entry.status !== "string") errors.push("push: queue entry.status must be a string");
  if (entry.copies !== undefined && (!Array.isArray(entry.copies) || !entry.copies.every((c) => typeof c === "string"))) {
    errors.push("push: queue entry.copies must be an array of strings when present");
  }
  return errors;
}

/** Parse a merge report's text into its file lists (applied +
 * alreadyApplied, deduped, in report order). Throws loudly on a
 * malformed report. Pure. */
export function parseMergeReportFiles(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("push: merge report does not parse: " + (e as Error).message);
  }
  if (!isPlainObject(parsed)) throw new Error("push: merge report has the wrong shape (expected an object)");
  const files: string[] = [];
  for (const key of ["applied", "alreadyApplied"]) {
    const list = parsed[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((f) => typeof f === "string")) {
      throw new Error("push: merge report." + key + " must be an array of strings when present");
    }
    for (const f of list as string[]) {
      if (!files.includes(f)) files.push(f);
    }
  }
  return files;
}

/** The checkout-validation script: the path must be a git work
 * tree, with a remote origin, on the branch (or able to check it
 * out — the caller checks out when the branch differs). Prints
 * one line each: `WORKTREE true`, `ORIGIN <url>`, `BRANCH
 * <name>`. Exit non-zero when any step fails. Pure. */
export function checkoutValidateScript(checkoutPath: string, tmpDir: string): string {
  const work = tmpDir + "/push-worktree.txt";
  const origin = tmpDir + "/push-origin.txt";
  const branch = tmpDir + "/push-branch.txt";
  return [
    "git -C " + shellQuote(checkoutPath) + " rev-parse --is-inside-work-tree > " + shellQuote(work) + " 2>&1 || exit 1",
    "echo \"WORKTREE $(cat " + shellQuote(work) + ")\"",
    "git -C " + shellQuote(checkoutPath) + " remote get-url origin > " + shellQuote(origin) + " 2>&1 || exit 1",
    "echo \"ORIGIN $(cat " + shellQuote(origin) + ")\"",
    "git -C " + shellQuote(checkoutPath) + " branch --show-current > " + shellQuote(branch) + " 2>&1 || exit 1",
    "echo \"BRANCH $(cat " + shellQuote(branch) + ")\"",
  ].join("\n");
}

/** Parse the checkout-validation output. Throws loudly on a
 * missing line or a non-work-tree. Pure. */
export function parseCheckoutValidation(text: string): { workTree: boolean; origin: string; branch: string } {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const work = lines.find((l) => l.startsWith("WORKTREE "));
  const origin = lines.find((l) => l.startsWith("ORIGIN "));
  const branch = lines.find((l) => l.startsWith("BRANCH "));
  if (!work || !origin || !branch) {
    throw new Error("push: checkout validation output is missing a line: " + JSON.stringify(text.slice(0, 200)));
  }
  return {
    workTree: work.slice("WORKTREE ".length).trim() === "true",
    origin: origin.slice("ORIGIN ".length).trim(),
    branch: branch.slice("BRANCH ".length).trim(),
  };
}

/** The fetch script: fetch the branch from origin into the
 * checkout. Prints `FETCHED`. Exit non-zero on failure. Pure. */
export function gitFetchScript(checkoutPath: string, branch: string): string {
  return "git -C " + shellQuote(checkoutPath) + " fetch origin " + shellQuote(branch) + " > /dev/null 2>&1 || exit 1\necho FETCHED\n";
}

/** The dev-tip script: the tip commit of origin/<branch> in the
 * checkout. Prints `TIP <sha>`. Pure. */
export function devTipScript(checkoutPath: string, branch: string): string {
  return "git -C " + shellQuote(checkoutPath) + " rev-parse " + shellQuote("origin/" + branch) + " || exit 1\n";
}

/** The dev-tree script: `git ls-tree -r` for exactly the manifest
 * files (pathspecs — never the whole tree, whose output would
 * exceed the ~60KB trap cap). Prints one line per file:
 * `<mode> blob <sha>\t<path>`. Pure. */
export function devTreeScript(checkoutPath: string, branch: string, files: string[]): string {
  const paths = files.map((f) => shellQuote(f)).join(" ");
  return "git -C " + shellQuote(checkoutPath) + " ls-tree -r " + shellQuote("origin/" + branch) + " -- " + paths + " || exit 1\n";
}

/** Parse `git ls-tree -r` output into a path -> blob-sha map.
 * Lines that don't match are ignored (an empty tree is an empty
 * map, not an error). Pure. */
export function parseLsTreeOutput(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^[0-9]+ blob ([0-9a-f]+)\t(.+)$/.exec(line.trim());
    if (m) map[m[2]] = m[1];
  }
  return map;
}

/** Parse `git ls-remote <remote> <branch>` output into the tip
 * sha (null when the branch is absent on the remote). Pure. */
export function parseLsRemoteOutput(text: string, branch: string): string | null {
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === "refs/heads/" + branch) return parts[0];
  }
  return null;
}

/** The hash-files script: for each file under a root, print one
 * `HASH <path> <sha256> <blobSha>` line (sha256sum + git
 * hash-object, which works outside a repository). Exit 1 naming
 * the file when one is missing or unreadable. Pure. */
export function hashFilesScript(root: string, files: string[]): string {
  const lines: string[] = [];
  for (const f of files) {
    const p = root + "/" + f;
    lines.push("if [ ! -f " + shellQuote(p) + " ]; then echo \"HASH-MISSING " + f.replace(/"/g, "") + "\"; exit 1; fi");
    lines.push("echo \"HASH " + f.replace(/"/g, "") + " $(sha256sum " + shellQuote(p) + " | cut -d' ' -f1) $(git hash-object " + shellQuote(p) + ")\"");
  }
  return lines.join("\n") + "\n";
}

/** Parse the hash-files output into path -> {sha256, blobSha}.
 * Throws loudly on a HASH-MISSING line or a malformed line. Pure. */
export function parseHashLines(text: string): Record<string, { sha256: string; blobSha: string }> {
  const out: Record<string, { sha256: string; blobSha: string }> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("HASH-MISSING")) throw new Error("push: file missing or unreadable: " + t.slice("HASH-MISSING ".length));
    const m = /^HASH (.+) ([0-9a-f]{64}) ([0-9a-f]{40})$/.exec(t);
    if (!m) throw new Error("push: hash output line is malformed: " + JSON.stringify(t.slice(0, 200)));
    out[m[1]] = { sha256: m[2], blobSha: m[3] };
  }
  return out;
}

/** Build the manifest entries from the file list, the live-tree
 * hashes, and the dev tree map. A file whose blob sha already
 * matches dev's tree is already-on-dev and is not re-pushed.
 * Throws loudly when a file has no live hash (the caller must
 * hash every file first). Pure. */
export function buildManifestEntries(
  files: string[],
  liveHashes: Record<string, { sha256: string; blobSha: string }>,
  devBlobs: Record<string, string>,
): PushManifestEntry[] {
  return files.map((f) => {
    const h = liveHashes[f];
    if (!h) throw new Error("push: no live hash for file " + f);
    return {
      path: f,
      sha256: h.sha256,
      blobSha: h.blobSha,
      status: devBlobs[f] === h.blobSha ? "already-on-dev" : "to-push",
    };
  });
}

/** Assemble the manifest. Pure. */
export function buildPushManifest(args: {
  pushId: string;
  queueIssue: string;
  copies: string[];
  order?: number;
  devTip: string;
  builtAt: string;
  entries: PushManifestEntry[];
}): PushManifest {
  return {
    pushId: args.pushId,
    queueIssue: args.queueIssue,
    copies: args.copies,
    order: args.order,
    devTip: args.devTip,
    builtAt: args.builtAt,
    entries: args.entries,
  };
}

/** The copy-and-verify script: copy each file from the live root
 * into the checkout at the same relative path (creating parent
 * dirs), then re-hash it there and print one `COPIED <path>
 * <sha256> <blobSha>` line per file. The workflow compares each
 * line against the manifest — a mismatch refuses loudly, naming
 * the file, and nothing is pushed. Pure. */
export function copyAndVerifyScript(liveRoot: string, checkoutPath: string, files: string[]): string {
  const lines: string[] = [];
  for (const f of files) {
    const src = liveRoot + "/" + f;
    const dst = checkoutPath + "/" + f;
    lines.push("mkdir -p \"$(dirname " + shellQuote(dst) + ")\" || exit 1");
    lines.push("cp " + shellQuote(src) + " " + shellQuote(dst) + " || exit 1");
    lines.push("echo \"COPIED " + f.replace(/"/g, "") + " $(sha256sum " + shellQuote(dst) + " | cut -d' ' -f1) $(git hash-object " + shellQuote(dst) + ")\"");
  }
  return lines.join("\n") + "\n";
}

/** Parse the copy-and-verify output into path -> {sha256,
 * blobSha}. Throws loudly on a malformed line. Pure. */
export function parseCopiedLines(text: string): Record<string, { sha256: string; blobSha: string }> {
  const out: Record<string, { sha256: string; blobSha: string }> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const m = /^COPIED (.+) ([0-9a-f]{64}) ([0-9a-f]{40})$/.exec(t);
    if (!m) throw new Error("push: copy output line is malformed: " + JSON.stringify(t.slice(0, 200)));
    out[m[1]] = { sha256: m[2], blobSha: m[3] };
  }
  return out;
}

/** The commit script: stage the files, commit with the supplied
 * author (git needs user.name/user.email — passed with -c, never
 * from the repo config), print `COMMIT <sha>`. Pure. */
export function commitScript(
  checkoutPath: string,
  files: string[],
  message: string,
  author: { name: string; email: string },
): string {
  const paths = files.map((f) => shellQuote(f)).join(" ");
  return [
    "git -C " + shellQuote(checkoutPath) + " add -- " + paths + " || exit 1",
    "git -C " + shellQuote(checkoutPath) + " -c user.name=" + shellQuote(author.name) + " -c user.email=" + shellQuote(author.email) +
      " commit -m " + shellQuote(message) + " > /dev/null 2>&1 || exit 1",
    "echo \"COMMIT $(git -C " + shellQuote(checkoutPath) + " rev-parse HEAD)\"",
  ].join("\n") + "\n";
}

/** The push script: push the branch to origin. Prints `PUSHED`.
 * Exit non-zero on failure (the workflow reports the failure
 * with the reason named; a retry re-checks what landed first —
 * never blind-retry). Pure. */
export function pushScript(checkoutPath: string, branch: string): string {
  return "git -C " + shellQuote(checkoutPath) + " push origin " + shellQuote(branch) + " > /dev/null 2>&1 || exit 1\necho PUSHED\n";
}

/** The ls-remote script: the tip commit of the branch on the
 * remote. Prints the raw `git ls-remote` output (one line).
 * Pure. */
export function lsRemoteScript(remote: string, branch: string): string {
  return "git ls-remote " + shellQuote(remote) + " " + shellQuote("refs/heads/" + branch) + " || exit 1\n";
}

/** The refs-verification script (fixtures: the remote is a local
 * bare repo): for each file, print one `REFBLOB <path> <sha>`
 * line — the blob sha of the file on the branch in the bare repo
 * (`git --git-dir=<remote> show <branch>:<path>`, hashed with
 * `git hash-object --stdin`). Exit 1 naming the file when it is
 * absent on the branch. Pure. */
export function refsVerifyScript(remotePath: string, branch: string, files: string[], tmpDir: string): string {
  const blobFile = tmpDir + "/push-refblob.txt";
  const lines: string[] = [];
  for (const f of files) {
    lines.push(
      "git --git-dir=" + shellQuote(remotePath) + " show " + shellQuote(branch + ":" + f) + " 2>/dev/null | git hash-object --stdin > " + shellQuote(blobFile) + " 2>/dev/null || { echo \"REFBLOB-MISSING " + f.replace(/"/g, "") + "\"; exit 1; }",
    );
    lines.push("echo \"REFBLOB " + f.replace(/"/g, "") + " $(cat " + shellQuote(blobFile) + ")\"");
  }
  return lines.join("\n") + "\n";
}

/** Parse the refs-verification output into path -> blob sha.
 * Throws loudly on a REFBLOB-MISSING line or a malformed line.
 * Pure. */
export function parseRefBlobLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("REFBLOB-MISSING")) throw new Error("push: file absent on the remote branch: " + t.slice("REFBLOB-MISSING ".length));
    const m = /^REFBLOB (.+) ([0-9a-f]{40})$/.exec(t);
    if (!m) throw new Error("push: refs output line is malformed: " + JSON.stringify(t.slice(0, 200)));
    out[m[1]] = m[2];
  }
  return out;
}

/** The GitHub contents script: one `gh api` call for one file —
 * `repos/<owner>/<repo>/contents/<path>?ref=<branch>` — which
 * returns JSON carrying the blob sha. Prints the raw JSON (small).
 * Exit non-zero when gh fails (not authed, no network). Pure. */
export function ghContentsScript(owner: string, repo: string, path: string, branch: string): string {
  return "gh api " + shellQuote("repos/" + owner + "/" + repo + "/contents/" + path + "?ref=" + branch) + " || exit 1\n";
}

/** The curl fallback for the same endpoint (GH_TOKEN /
 * GITHUB_TOKEN from the environment — never from the input,
 * never logged). Prints the raw JSON. Exit non-zero on failure.
 * Pure. */
export function curlContentsScript(owner: string, repo: string, path: string, branch: string): string {
  return (
    "curl -s -f --max-time 30 -H \"Authorization: Bearer ${GH_TOKEN:-${GITHUB_TOKEN:-}}\" " +
    shellQuote("https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + path + "?ref=" + branch) +
    " || exit 1\n"
  );
}

/** Parse a GitHub contents-API response into the blob sha (the
 * `sha` field). Returns null when the response has no sha (an
 * error payload — the caller treats it as unconfirmed, never as
 * a match). Pure. */
export function parseGhContentsOutput(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return typeof parsed.sha === "string" ? parsed.sha : null;
}

/** Build the delivery payloads (Landing + the Director). The
 * Director's target is the literal "director"; Landing's is the
 * landing chat id from the roster, or the literal "landing" when
 * the roster lacks it (recorded in the notes by the caller).
 * Pure. */
export function buildPushDeliveryPayloads(args: {
  pushId: string;
  queueIssue: string;
  verdict: PushVerdict;
  commit?: string;
  verification?: PushVerification;
  landingTarget: string;
}): DeliveryPayload[] {
  const line =
    "push " + args.pushId + " (" + args.queueIssue + "): " + args.verdict +
    (args.commit ? " — commit " + args.commit : "") +
    (args.verification ? " — verification " + args.verification.route + ": " + (args.verification.confirmed ? "confirmed" : "NOT confirmed") : "");
  return [
    { target: args.landingTarget, message: line },
    { target: "director", message: line },
  ];
}

/** Assemble the report. Pure — the verdict is taken as given by
 * the entry (the entry is the only place verdicts are decided). */
export function buildPushReport(args: {
  pushId: string;
  verdict: PushVerdict;
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  queueIssue: string;
  manifestPath?: string;
  manifest?: PushManifest;
  commit?: string;
  devTip?: string;
  verification?: PushVerification;
  authorization?: MergeAuthorization | null;
  deliveryPayloads: DeliveryPayload[];
  notes: string[];
}): PushReport {
  return {
    pushId: args.pushId,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    queueIssue: args.queueIssue,
    manifestPath: args.manifestPath,
    manifest: args.manifest,
    commit: args.commit,
    devTip: args.devTip,
    verification: args.verification,
    authorization: args.authorization ?? null,
    deliveryPayloads: args.deliveryPayloads,
    notes: args.notes,
    knownLimit: PUSH_KNOWN_LIMIT,
  };
}

/** The now script: print the current time as ISO (the manifest's
 * builtAt). Pure. */
export function nowScript(): string {
  return "date -u +%Y-%m-%dT%H:%M:%SZ\n";
}

export default function pushToDev(input: PushInput): PushReport {
  const dryRun = input?.run?.dryRun ?? false;
  let cancelChecked = false;
  let cancelled = false;
  const refusedReport = (extraNotes: string[], verdict: PushVerdict = "failed"): PushReport =>
    buildPushReport({
      pushId: typeof input?.run?.pushId === "string" ? input.run.pushId : "",
      verdict,
      dryRun,
      owner: typeof input?.owner === "string" ? input.owner : "",
      launchedBy: input?.launchedBy,
      cancelChecked,
      cancelled,
      queueIssue: typeof input?.run?.queueIssue === "string" ? input.run.queueIssue : "",
      deliveryPayloads: [],
      notes: extraNotes,
    });

  // Validate first, fail-closed. A null/absent run is refused,
  // never dereferenced (this workflow validates first, so it does
  // not have the defect).
  if (!isPlainObject(input)) return refusedReport(["push: input is not an object"]);
  if (!isPlainObject((input as JsonObject).run)) {
    return refusedReport(["push: input has no run object"]);
  }
  const run = (input as PushInput).run;
  const validationErrors = validatePushInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors);
  }
  const branch = run.branch ?? "dev";
  const stateDir = (input as PushInput).project.stateDir;

  // Cancel check first (when runId present): check-then-act before
  // any read or write. Exit 2 (no queue entry) and exit 3 (queue
  // missing/unparsable) mean the check did not complete — the run
  // refuses with cancelChecked false. A cancelled run refuses
  // with cancelChecked true + cancelled true.
  if (typeof run.runId === "string" && run.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, run.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["push: cancel check: no queue entry for run " + run.runId]);
    }
    if (check.exitCode === 3) {
      return refusedReport(["push: cancel check: " + (check.stdout ?? "").trim().slice(0, 200)]);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "push: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout ?? "");
    } catch (e) {
      throw new Error("push: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["push: run " + run.runId + " is cancelled — the push exits cleanly without advancing"]);
    }
  }

  // The hold: checked right after validation + the cancel check,
  // before any read or write — a held push reports the hold and
  // stops, pushing nothing and writing nothing.
  if (run.holdPush === true) {
    return buildPushReport({
      pushId: run.pushId,
      verdict: "held",
      dryRun,
      owner: (input as PushInput).owner,
      launchedBy: input.launchedBy,
      cancelChecked,
      cancelled,
      queueIssue: run.queueIssue,
      authorization: run.authorization ?? null,
      deliveryPayloads: buildPushDeliveryPayloads({
        pushId: run.pushId,
        queueIssue: run.queueIssue,
        verdict: "held",
        landingTarget: (input as PushInput).project.roster?.landing ?? "landing",
      }),
      notes: ["push: the dev push is held (run.holdPush) — reported and stopped, nothing pushed"],
    });
  }

  // Scratch dirs: workDir for the manifest + temp files.
  const mk = exec({ cmd: "mkdir", args: ["-p", run.workDir, run.workDir + "/tmp"] });
  if (mk.exitCode !== 0) {
    throw new Error("push: cannot create work dir under " + run.workDir + " (rc " + mk.exitCode + ")");
  }
  const tmpDir = run.workDir + "/tmp";

  // Read the queue entry (one entry only — the queue file is never
  // read whole). A missing entry refuses loudly.
  const entryOut = exec({ cmd: "/bin/sh", args: ["-c", queueEntryReadScript(run.queuePath, run.queueIssue)] });
  if (entryOut.exitCode !== 0) {
    return refusedReport([
      "push: cannot read the queue entry for " + run.queueIssue + ": " + (entryOut.stdout ?? "").trim().slice(0, 200),
    ]);
  }
  let entry: Record<string, unknown> | null;
  try {
    entry = parseQueueEntryOutput(entryOut.stdout ?? "");
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }
  if (entry === null) {
    return refusedReport(["push: no queue entry for " + run.queueIssue]);
  }
  const entryErrors = validateQueueEntry(entry);
  if (entryErrors.length > 0) {
    return refusedReport(entryErrors);
  }
  const entryStatus = entry.status as string;
  if (entryStatus === "blocked") {
    const reason =
      (typeof entry.notes === "string" && entry.notes !== "" ? entry.notes : null) ??
      (isPlainObject(entry.verification) && typeof entry.verification.failedReason === "string" ? entry.verification.failedReason : null) ??
      "no reason recorded";
    return refusedReport([
      "push: queue entry " + run.queueIssue + " is blocked — the push refuses with the failure named: " + reason,
    ]);
  }
  if (entryStatus !== "ready" && entryStatus !== "landed") {
    return refusedReport(["push: queue entry " + run.queueIssue + " has status " + entryStatus + " — only ready or landed entries push"]);
  }

  // The authorization: the queue entry's field first, else the run
  // input's. A real push without one refuses before the push step;
  // a dry-run without one is fine.
  const authorization: MergeAuthorization | undefined =
    (isPlainObject(entry.authorization) ? (entry.authorization as unknown as MergeAuthorization) : undefined) ?? run.authorization;
  if (!dryRun && authorization === undefined) {
    return refusedReport(["push: no landing authorization — a real push refuses before the push step (dry-run without one is fine)"]);
  }
  if (authorization !== undefined) {
    const authErrors = validatePushAuthorization(authorization);
    if (authErrors.length > 0) {
      return refusedReport(authErrors);
    }
  }

  // Read the merge report's file lists (bounded read).
  const reportOut = exec({ cmd: "/bin/sh", args: ["-c", readFileScript(run.mergeReportPath, PUSH_READ_MAX_BYTES)] });
  if (reportOut.exitCode !== 0) {
    return refusedReport(["push: cannot read the merge report at " + run.mergeReportPath + " (rc " + reportOut.exitCode + ")"]);
  }
  let files: string[];
  try {
    const read = parseReadOutput(reportOut.stdout ?? "");
    files = parseMergeReportFiles(read.content);
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }
  if (files.length === 0) {
    return refusedReport(["push: the merge report names no files to push for " + run.queueIssue]);
  }

  // Dry-run: plan the push (entry + files + the manifest shape)
  // and write nothing — no manifest, no commit, no push, no
  // delivery payloads.
  if (dryRun) {
    return buildPushReport({
      pushId: run.pushId,
      verdict: "dry-run",
      dryRun: true,
      owner: (input as PushInput).owner,
      launchedBy: input.launchedBy,
      cancelChecked,
      cancelled,
      queueIssue: run.queueIssue,
      authorization: authorization ?? null,
      deliveryPayloads: [],
      notes: [
        "dry-run: " + files.length + " file(s) would be pushed for " + run.queueIssue + " (" + files.join(", ") + ") — nothing written, nothing pushed",
      ],
    });
  }

  // Validate the checkout (a git work tree, remote origin, on the
  // branch or able to check it out). The remote must be the
  // caller's override when one is supplied, else a github.com
  // remote for brandf/agentts.
  const checkoutOut = exec({ cmd: "/bin/sh", args: ["-c", checkoutValidateScript(run.checkoutPath, tmpDir)] });
  if (checkoutOut.exitCode !== 0) {
    return refusedReport(["push: the checkout at " + run.checkoutPath + " is not a usable git work tree (rc " + checkoutOut.exitCode + ")"]);
  }
  let checkout: { workTree: boolean; origin: string; branch: string };
  try {
    checkout = parseCheckoutValidation(checkoutOut.stdout ?? "");
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }
  if (!checkout.workTree) {
    return refusedReport(["push: the checkout at " + run.checkoutPath + " is not a git work tree"]);
  }
  const remote = run.remoteUrl ?? checkout.origin;
  if (run.remoteUrl !== undefined && checkout.origin !== run.remoteUrl) {
    return refusedReport([
      "push: the checkout's origin (" + checkout.origin + ") is not the run's remoteUrl (" + run.remoteUrl + ")",
    ]);
  }
  if (run.remoteUrl === undefined && !(checkout.origin.includes("github.com") && checkout.origin.includes("agentts"))) {
    return refusedReport(["push: the checkout's origin (" + checkout.origin + ") is not a github.com remote for agentts"]);
  }
  if (checkout.branch !== branch) {
    const co = exec({ cmd: "/bin/sh", args: ["-c", "git -C " + shellQuote(run.checkoutPath) + " checkout " + shellQuote(branch) + " > /dev/null 2>&1 || git -C " + shellQuote(run.checkoutPath) + " checkout -b " + shellQuote(branch) + " " + shellQuote("origin/" + branch) + " > /dev/null 2>&1 || exit 1\necho CHECKED-OUT\n"] });
    if (co.exitCode !== 0) {
      return refusedReport(["push: the checkout at " + run.checkoutPath + " cannot check out branch " + branch]);
    }
  }

  // Fetch the dev baseline, then read the dev tip + the dev tree
  // for exactly the manifest files (pathspecs — never the whole
  // tree, whose output would exceed the trap cap).
  const fetch = exec({ cmd: "/bin/sh", args: ["-c", gitFetchScript(run.checkoutPath, branch)] });
  if (fetch.exitCode !== 0) {
    return refusedReport(["push: cannot fetch origin/" + branch + " into the checkout"]);
  }
  const tipOut = exec({ cmd: "/bin/sh", args: ["-c", devTipScript(run.checkoutPath, branch)] });
  if (tipOut.exitCode !== 0) {
    return refusedReport(["push: cannot read the dev tip (origin/" + branch + " has no tip — is the branch pushed yet?)"]);
  }
  const devTip = (tipOut.stdout ?? "").trim();
  const treeOut = exec({ cmd: "/bin/sh", args: ["-c", devTreeScript(run.checkoutPath, branch, files)] });
  if (treeOut.exitCode !== 0) {
    return refusedReport(["push: cannot read the dev tree for the manifest files"]);
  }
  const devBlobs = parseLsTreeOutput(treeOut.stdout ?? "");

  // Hash every file from the live tree, then build the manifest.
  const hashOut = exec({ cmd: "/bin/sh", args: ["-c", hashFilesScript(run.liveRoot, files)] });
  if (hashOut.exitCode !== 0) {
    return refusedReport(["push: cannot hash the manifest files from the live tree: " + (hashOut.stdout ?? "").trim().slice(0, 200)]);
  }
  let liveHashes: Record<string, { sha256: string; blobSha: string }>;
  try {
    liveHashes = parseHashLines(hashOut.stdout ?? "");
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }
  let entries: PushManifestEntry[];
  try {
    entries = buildManifestEntries(files, liveHashes, devBlobs);
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }
  const nowOut = exec({ cmd: "/bin/sh", args: ["-c", nowScript()] });
  const builtAt = run.now ?? (nowOut.stdout ?? "").trim() ?? "";
  const manifest = buildPushManifest({
    pushId: run.pushId,
    queueIssue: run.queueIssue,
    copies: Array.isArray(entry.copies) ? (entry.copies as string[]) : [],
    order: typeof entry.order === "number" ? entry.order : undefined,
    devTip,
    builtAt,
    entries,
  });
  const manifestPath = run.workDir + "/push-manifest.json";

  // Write the manifest (chunked base64 + rename + read-back) —
  // the record of what will be pushed, written before the push.
  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  const chunks = splitHandoffChunks(manifestJson);
  const tmpPath = manifestPath + ".tmp";
  for (let i = 0; i < chunks.length; i++) {
    const w = exec({ cmd: "/bin/sh", args: ["-c", chunkWriteScript(chunks[i], i, tmpPath)] });
    if (w.exitCode !== 0) {
      return refusedReport(["push: cannot write the manifest chunk " + i + " (rc " + w.exitCode + ")"]);
    }
  }
  const fin = exec({ cmd: "/bin/sh", args: ["-c", finalizeWriteScript(tmpPath, manifestPath, "json")] });
  if (fin.exitCode !== 0) {
    return refusedReport(["push: cannot finalize the manifest at " + manifestPath + " (rc " + fin.exitCode + ")"]);
  }
  try {
    parseWriteSummary(fin.stdout ?? "");
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }

  const toPush = entries.filter((e) => e.status === "to-push");
  const alreadyOnDev = entries.filter((e) => e.status === "already-on-dev");
  const landingTarget = (input as PushInput).project.roster?.landing ?? "landing";
  const notes: string[] = [];
  if (alreadyOnDev.length > 0) {
    notes.push("push: " + alreadyOnDev.length + " file(s) already on dev (" + alreadyOnDev.map((e) => e.path).join(", ") + ") — not re-pushed");
  }

  // The interrupted-push check, from the fresh fetch above: if
  // every file already matches dev, the push already landed —
  // report already-pushed (verified) instead of pushing twice.
  if (toPush.length === 0) {
    const verification: PushVerification = {
      route: run.verifyViaRefs === true ? "refs" : "github-api",
      confirmed: true,
      tipConfirmed: true,
      filesConfirmed: entries.length,
      filesTotal: entries.length,
      perFile: entries.map((e) => ({ path: e.path, confirmed: true })),
    };
    return buildPushReport({
      pushId: run.pushId,
      verdict: "already-pushed",
      dryRun,
      owner: (input as PushInput).owner,
      launchedBy: input.launchedBy,
      cancelChecked,
      cancelled,
      queueIssue: run.queueIssue,
      manifestPath,
      manifest,
      commit: devTip,
      devTip,
      verification,
      authorization: authorization ?? null,
      deliveryPayloads: buildPushDeliveryPayloads({
        pushId: run.pushId,
        queueIssue: run.queueIssue,
        verdict: "already-pushed",
        commit: devTip,
        verification,
        landingTarget,
      }),
      notes: [...notes, "push: every manifest file already matches dev — the push already landed, nothing pushed"],
    });
  }

  // Copy the to-push files into the checkout and verify them there
  // (re-hash and compare with the manifest) — a mismatch refuses
  // loudly, naming the file, and nothing is pushed.
  const copyOut = exec({
    cmd: "/bin/sh",
    args: ["-c", copyAndVerifyScript(run.liveRoot, run.checkoutPath, toPush.map((e) => e.path))],
  });
  if (copyOut.exitCode !== 0) {
    return refusedReport(["push: cannot copy the to-push files into the checkout (rc " + copyOut.exitCode + ")"]);
  }
  let copied: Record<string, { sha256: string; blobSha: string }>;
  try {
    copied = parseCopiedLines(copyOut.stdout ?? "");
  } catch (e) {
    return refusedReport(["push: " + (e as Error).message]);
  }
  for (const e of toPush) {
    const c = copied[e.path];
    if (!c || c.sha256 !== e.sha256 || c.blobSha !== e.blobSha) {
      return refusedReport([
        "push: file " + e.path + " does not match the manifest after copying into the checkout — refusing loudly, nothing pushed",
      ]);
    }
  }

  // Commit + push. The commit message names the push + the queue
  // entry; the author comes from the run input (default AgentTS).
  const author = run.commitAuthor ?? { name: "AgentTS", email: "agentts@localhost" };
  const commitOut = exec({
    cmd: "/bin/sh",
    args: ["-c", commitScript(run.checkoutPath, toPush.map((e) => e.path), "Push " + run.pushId + " (" + run.queueIssue + ") to " + branch, author)],
  });
  if (commitOut.exitCode !== 0) {
    return refusedReport(["push: cannot commit the to-push files in the checkout (rc " + commitOut.exitCode + ")"]);
  }
  const commitMatch = /COMMIT ([0-9a-f]{40})/.exec(commitOut.stdout ?? "");
  if (!commitMatch) {
    return refusedReport(["push: the commit step printed no COMMIT line: " + JSON.stringify((commitOut.stdout ?? "").slice(0, 200))]);
  }
  const commit = commitMatch[1];
  const pushOut = exec({ cmd: "/bin/sh", args: ["-c", pushScript(run.checkoutPath, branch)] });
  if (pushOut.exitCode !== 0) {
    return refusedReport([
      "push: the push to origin/" + branch + " failed (rc " + pushOut.exitCode + ") — the commit " + commit + " is in the checkout; a retry re-checks what landed first, never blind-retries",
    ]);
  }

  // Verify what landed. The tip must equal the pushed commit, and
  // every file's blob sha on dev must equal the manifest's.
  const verifyViaRefs = run.verifyViaRefs === true;
  const perFile: PushFileVerification[] = [];
  let tipConfirmed = false;
  let route: PushVerification["route"] = verifyViaRefs ? "refs" : "github-api";
  let verifyReason: string | undefined;
  const remoteOut = exec({ cmd: "/bin/sh", args: ["-c", lsRemoteScript(remote, branch)] });
  if (remoteOut.exitCode === 0) {
    const remoteTip = parseLsRemoteOutput(remoteOut.stdout ?? "", branch);
    tipConfirmed = remoteTip === commit;
    if (!tipConfirmed) {
      verifyReason = "the dev tip (" + (remoteTip ?? "absent") + ") is not the pushed commit (" + commit + ")";
    }
  } else {
    verifyReason = "git ls-remote failed (rc " + remoteOut.exitCode + ") — the tip could not be checked";
  }
  if (tipConfirmed) {
    if (verifyViaRefs) {
      const refsOut = exec({
        cmd: "/bin/sh",
        args: ["-c", refsVerifyScript(remote, branch, toPush.map((e) => e.path), tmpDir)],
      });
      if (refsOut.exitCode === 0) {
        try {
          const refBlobs = parseRefBlobLines(refsOut.stdout ?? "");
          for (const e of toPush) {
            const match = refBlobs[e.path] === e.blobSha;
            perFile.push({ path: e.path, confirmed: match, reason: match ? undefined : "the blob sha on dev (" + (refBlobs[e.path] ?? "absent") + ") is not the manifest's (" + e.blobSha + ")" });
          }
        } catch (e) {
          verifyReason = (e as Error).message;
        }
      } else {
        verifyReason = "the refs verification failed (rc " + refsOut.exitCode + "): " + (refsOut.stdout ?? "").trim().slice(0, 200);
      }
    } else {
      // GitHub API: one contents call per file (gh first, curl +
      // token fallback). The repo comes from project.repo
      // ("owner/name").
      const [owner, repo] = ((input as PushInput).project.repo ?? "").split("/");
      if (!owner || !repo) {
        verifyReason = "project.repo is not owner/name — the GitHub API route cannot run";
      } else {
        for (const e of toPush) {
          let sha: string | null = null;
          let attempted = false;
          const ghOut = exec({ cmd: "/bin/sh", args: ["-c", ghContentsScript(owner, repo, e.path, branch)] });
          if (ghOut.exitCode === 0) {
            attempted = true;
            sha = parseGhContentsOutput(ghOut.stdout ?? "");
          }
          if (!attempted || sha === null) {
            const curlOut = exec({ cmd: "/bin/sh", args: ["-c", curlContentsScript(owner, repo, e.path, branch)] });
            if (curlOut.exitCode === 0) {
              attempted = true;
              sha = parseGhContentsOutput(curlOut.stdout ?? "");
            }
          }
          if (!attempted) {
            verifyReason = "neither gh nor curl could reach the GitHub API for " + e.path + " — the push cannot be confirmed";
            perFile.push({ path: e.path, confirmed: false, reason: verifyReason });
          } else {
            const match = sha === e.blobSha;
            perFile.push({ path: e.path, confirmed: match, reason: match ? undefined : "the blob sha on dev (" + (sha ?? "absent") + ") is not the manifest's (" + e.blobSha + ")" });
          }
        }
      }
    }
  }
  // Files already on dev need no post-push check — they were
  // confirmed against the dev tree at manifest build time.
  for (const e of alreadyOnDev) {
    perFile.push({ path: e.path, confirmed: true });
  }
  const filesConfirmed = perFile.filter((p) => p.confirmed).length;
  const confirmed = tipConfirmed && perFile.length === entries.length && filesConfirmed === entries.length && verifyReason === undefined;
  if (perFile.length === 0 && !tipConfirmed) {
    route = "none";
  }
  if (!confirmed && route !== "none" && verifyReason === undefined) {
    verifyReason = "one or more files did not confirm on dev";
  }
  const verification: PushVerification = {
    route,
    confirmed,
    tipConfirmed,
    filesConfirmed,
    filesTotal: entries.length,
    perFile,
    reason: confirmed ? undefined : verifyReason,
  };

  const verdict: PushVerdict = confirmed ? "pushed" : "not-verified";
  if (!confirmed) {
    notes.push("push: the push landed on the checkout and was pushed, but what landed on dev could not be confirmed — reported as not-verified, never as landed");
  }
  return buildPushReport({
    pushId: run.pushId,
    verdict,
    dryRun,
    owner: (input as PushInput).owner,
    launchedBy: input.launchedBy,
    cancelChecked,
    cancelled,
    queueIssue: run.queueIssue,
    manifestPath,
    manifest,
    commit,
    devTip,
    verification,
    authorization: authorization ?? null,
    deliveryPayloads: buildPushDeliveryPayloads({
      pushId: run.pushId,
      queueIssue: run.queueIssue,
      verdict,
      commit,
      verification,
      landingTarget,
    }),
    notes: [...notes, "push: pushed " + toPush.length + " file(s) to origin/" + branch + " as commit " + commit],
  });
}
