// land-queue — order the merge queue (BRA-261).
//
// The queue is the reorder buffer — the one serial stage, deliberately
// narrow. The Director merges serially from it; this workflow orders
// it, persists it, and returns the ordered ready list for the Director
// (or Landing's loop) to drive the merge workflow per entry. It does not
// merge — the merge workflow (BRA-159) stays the one way a copy lands.
// It does not verify — Quality verifies, and the verification stands on its
// own. It never closes an issue.
//
// The queue lives in one file (the run input's queuePath — for the
// AgentTS project, the goal's hidden_files/land-queue.json). This
// workflow is the file's single writer: callers pass updates (a Quality
// verdict, an Landing authorization, a status change) in the run input,
// the workflow applies them, orders, and persists atomically. Nobody
// hand-edits the file while the workflow owns it.
//
// The queue entry shape, as read from the live file Nov 22 (brief
// ~/workspace/bra261-262-263-impl-brief.md, amendment note — the
// brief's paraphrase was the OLD shape only):
//   - Orders 1-9 (hand-written): {copies[], issue, landed_at, notes,
//     order, parts[], ready_at, status, title}.
//   - Orders 10-13 (queue-managed): {copy (singular string), issue,
//     landed_at, notes, order, ready_at, status, title,
//     authorized_at (flat string)} — NO parts.
//   - Top level: {items, owner, policy, queue, throughput, updated}.
// The workflow accepts both `copies[]` and `copy` (`copies` wins
// when both are present), treats `parts` as optional, preserves
// `authorized_at` as-is, preserves every top-level key, and updates
// `updated` on write. On write, entries gain `verification` and
// `authorization` (null when absent) — the full shape — but the
// workflow does NOT fabricate `parts` and does NOT convert `copy`
// to `copies`.
//
// Design decisions (brief ~/workspace/bra261-262-263-impl-brief.md):
//
// 1. Readiness: an entry is ready only when status is "ready" AND
//    its verification passed AND ready_at is non-null. A "ready"
//    entry with a failed or missing verification transitions to
//    "blocked" with the reason named in its notes — a failed verify
//    is never ordered as ready and never disappears. A blocked
//    entry stays in the file with its failure named, readable by
//    the verdict route (BRA-256, a separate item) — the queue must
//    not hide what the verdict route needs to see. A blocked entry
//    with a passing verification stays blocked until a caller sets
//    status "ready" in an update — the workflow never promotes on
//    its own; readiness is a decision, and the workflow only ever
//    demotes (ready -> blocked) for safety.
// 2. Ordering: ready entries first, by ready_at ascending; then
//    blocked, then paused, then pending_qa (in Quality — verification
//    done, the verdict outstanding; never ordered as ready, never
//    demoted — the queue neither promotes nor demotes a pending_qa
//    entry, it only orders it), then landed (kept as history) —
//    each bucket by previous `order` ascending, then issue. Items
//    are persisted in the computed order with `order` reassigned
//    1..N, so the file on disk IS the ordered queue. "pending_qa"
//    is a real, recurring state in the landing pipeline (Landing
//    ruling, Nov 22 ~03:38 PST): every build passes through a
//    window where verification is done and Quality's verdict is
//    outstanding. It is in the accepted vocabulary, not a
//    skip — the readers (247/248) count it as pending and show it
//    as awaiting Quality.
// 3. Updates arrive in the run input, keyed by issue, and apply
//    before ordering. An update naming an unknown issue refuses
//    the run (fail-closed). When an update marks an entry ready
//    with a passing verification and ready_at is null, ready_at
//    is set to run.now (or the run's clock time).
// 4. Queue-file read bound 48KB (the generic bound) — the live
//    file is 19,577 bytes at build time, past the brief's 16KB
//    figure (corrected in the brief amendment). A file over the
//    bound is refused loudly, the bound named, never truncated
//    into a wrong parse. Rotation (BACKLOG.md heading "Unfiled:
//    land-queue.json needs rotation before it hits the 48KB read
//    bound (Low)", P0): when the file reaches the rotation
//    threshold (36KB — 75% of the bound; the headroom covers one
//    full burst-rate merge cycle, ~10,850 bytes), the run moves
//    all but the 5 most recent landed entries into a dated
//    history file (land-queue-rotated-<now>.json, same directory
//    as the queue file — one file per rotation, never a single
//    appended file, which would itself grow past the trap read
//    cap), records the rotation in the file (`rotations` array +
//    latest `rotation`, the one-time rotation's shape) and the
//    report's notes, and refuses loudly — writing nothing to the
//    live file — if the file changed between the rotation's read
//    and its write (re-read or refuse, never overwrite blind).
//    A file already over the bound still refuses before any
//    rotation; the rotation prevents the recurrence, it does not
//    repair the breach. A dry-run plans the rotation and names
//    it in the notes, and writes nothing.
// 5. Reads/writes via exec traps in the dispatch pattern (base64
//    chunks + temp + rename + read-back), never trap stdout, never
//    Buffer. The write temp file lives under project.workDir.
// 6. Cancel is check-then-act (the triage pattern); a null/absent
//    run is refused, never dereferenced. Dry-run orders and writes
//    nothing. The queue file is byte-identical after a dry-run.
// 7. Recovery: every write is atomic (temp + rename + read-back);
//    a re-run re-reads the persisted file and re-orders from it —
//    idempotent (a second run with no updates produces the same
//    items; only `updated` changes). A resumed run records the
//    recovery in its report's notes when the file it read already
//    carries the updates it was asked to apply.
// 8. The entry's `authorization` is the settled MergeAuthorization
//    from merge.ts (imported type, validated with
//    validateMergeAuthorization when present — a malformed
//    authorization on an entry refuses the run, naming the entry).
// 9. The workflow never closes an issue, merges code, or decides
//    acceptance. Predictor-record scoring is out of this build.
// 10. BRA-260 (push) and BRA-256 (dual-report verification) are
//     out of scope: the queue orders what the push step pushes
//     (the entry's `copies` + `order` are the push step's input),
//     and a blocked entry stays in the file with the failure
//     named for the verdict route.
//
// Known v0 limits, carried verbatim in every report:
//
// - The queue orders; it never merges, verifies, or closes. A
//   blocked entry stays in the file with its failure named. The
//   queue file is read in full (48KB bound) — when it approaches
//   the bound the run rotates landed entries into a dated history
//   file (see decision 4). Concurrent writers are not guarded:
//   Landing drives one queue run at a time.

import { exec } from "../../src/agentts";
import { shellQuote, cancelCheckScript, parseRunStatus } from "./triage";
import { splitHandoffChunks, parseWriteSummary } from "./dispatch";
import { readFileScript, parseReadOutput, chunkWriteScript, finalizeWriteScript } from "./daily-brief";
import {
  validateMergeAuthorization,
  type MergeAuthorization,
} from "./merge";

/** The known-limit string, carried verbatim in every report. */
export const LAND_QUEUE_KNOWN_LIMIT =
  "The queue orders; it never merges, verifies, or closes. A blocked entry stays in the file with its failure named. " +
  "The queue file is read in full (48KB bound) — when it approaches the bound the run rotates landed entries into a dated history file (see decision 4). Concurrent writers are not guarded: Landing drives one queue run at a time.";

/** Queue-file read bound (bytes of decoded text): the live file is
 * 19,577 bytes at build time — past the brief's 16KB figure, so the
 * generic 48KB bound applies, far under the ~60KB trap cap. */
export const LAND_QUEUE_READ_MAX_BYTES = 48 * 1024;

/** Rotation trigger (bytes of decoded text at read time): 36KB,
 * 75% of the 48KB read bound. The headroom (49,152 − 36,864 =
 * 12,288 bytes) covers one full merge cycle at the burst growth
 * rate (~9,300 bytes/hour around merge activity, a tier-1 runs
 * ~70 minutes — ~10,850 bytes a cycle), so a rotation that fires
 * on approach always leaves room for the cycle in flight to
 * land. A file already over the bound refuses before any
 * rotation (the reader refuses first). */
export const LAND_QUEUE_ROTATION_THRESHOLD_BYTES = 36 * 1024;

/** Landed entries kept in the live file by a rotation: the 5 most
 * recent (by landed_at, then previous order). Every older landed
 * entry moves to the history file, preserved in full. */
export const LAND_QUEUE_KEEP_RECENT_LANDED = 5;

export type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** The standard project config (mechanics §3): inlined by the
 * launcher; the workflow never reads agentts.project.json itself. */
export interface LandQueueProjectConfig {
  linearProject: string;
  repo: string;
  stateDir: string;
  roster?: Record<string, string>;
  /** Numeric thresholds the workflow enforces (unused by the queue
   * v0 — carried for the set). */
  thresholds?: Record<string, number>;
  workDir: string;
  resumeDir?: string;
}

/** The verification behind a change: what ran, what passed, where
 * the evidence lives. Supplied by the handoff / Quality verdict — the
 * queue reads it, it never decides it. */
export interface QueueVerification {
  /** True only when the verification passed. */
  passed: boolean;
  /** What ran and what passed, e.g. "tier-1 60/3,910, Quality PASS". */
  summary: string;
  /** Where the evidence lives, e.g. a merge-report path. */
  evidencePath?: string;
  /** The failure, named, when passed is false. */
  failedReason?: string;
}

export type LandQueueStatus = "ready" | "blocked" | "paused" | "pending_qa" | "landed";
const LAND_QUEUE_STATUSES: LandQueueStatus[] = ["ready", "blocked", "paused", "pending_qa", "landed"];

/** One queue entry, as carried in the file. `copies` (old shape)
 * and `copy` (queue-managed shape) are both accepted; `parts` is
 * optional; `authorized_at` is the flat legacy field, preserved
 * as-is. Unknown fields are preserved on write (index signature). */
export interface LandQueueEntry {
  issue: string;
  title: string;
  copies?: string[];
  copy?: string;
  order?: number;
  ready_at?: string | null;
  landed_at?: string | null;
  status: string;
  parts?: string[];
  notes?: string;
  authorized_at?: string;
  verification?: QueueVerification | null;
  authorization?: MergeAuthorization | null;
  [key: string]: unknown;
}

/** One update to apply to an entry, keyed by issue. */
export interface LandQueueEntryUpdate {
  issue: string;
  verification?: QueueVerification;
  authorization?: MergeAuthorization;
  status?: LandQueueStatus;
  /** Appended to the entry's notes as a new sentence. */
  notesAppend?: string;
}

export interface LandQueueRunInput {
  /** e.g. "BRA-261". */
  queueId: string;
  /** Absolute path to the queue file. */
  queuePath: string;
  /** Updates to apply before ordering (by issue). */
  updates?: LandQueueEntryUpdate[];
  dryRun?: boolean;
  /** Present when the run is cancellable (the cancel check reads
   * the live flag from stateDir/queue.json). */
  runId?: string;
  /** Caller-supplied now (ISO), for tests and for `updated` /
   * ready_at. When absent, the workflow reads the clock. */
  now?: string;
  bunPath?: string;
}

export interface LandQueueInput {
  project: LandQueueProjectConfig;
  run: LandQueueRunInput;
  /** The driving session — required, never assumed from the
   * launcher (BRA-211). Informational until Phase 2. */
  owner: string;
  launchedBy?: string;
}

export interface LandQueueReport {
  queueId: string;
  verdict: "ordered" | "dry-run" | "failed";
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  queuePath: string;
  /** Issue keys in merge order (ready first, by ready_at). */
  ready: string[];
  blocked: string[];
  paused: string[];
  /** In Quality — verification done, the verdict outstanding. Never
   * ordered as ready, never demoted (Landing ruling, Nov 22
   * ~03:38 PST). */
  pendingQa: string[];
  landed: string[];
  /** Entries in the file after this run. */
  items: number;
  /** True when the file was written. */
  updated: boolean;
  /** State transitions this run made (ready -> blocked, ready_at
   * set, failure named), each naming the issue. */
  transitions: string[];
  notes: string[];
  knownLimit: string;
}

/** Validate the run input. Pure — returns the error strings (empty
 * when valid), each naming the missing or malformed field. The
 * entry converts these into a refused report; nothing throws for
 * bad input. A null/absent run is an error here too, but the entry
 * guards it first (never dereferenced). */
export function validateLandQueueInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ["land-queue: input is not an object"];
  const project = (input as JsonObject).project;
  const run = (input as JsonObject).run;
  if (!isPlainObject(project)) errors.push("land-queue: input has no project object");
  else {
    const p = project as JsonObject;
    for (const f of ["linearProject", "repo", "stateDir", "workDir"]) {
      if (!isNonEmptyString(p[f])) errors.push("land-queue: project has no " + f + " string");
    }
  }
  if (!isPlainObject(run)) {
    errors.push("land-queue: input has no run object");
    return errors;
  }
  const r = run as JsonObject;
  if (!isNonEmptyString(r.queueId)) errors.push("land-queue: run has no queueId string");
  if (!isNonEmptyString(r.queuePath)) errors.push("land-queue: run has no queuePath string");
  if (r.dryRun !== undefined && typeof r.dryRun !== "boolean") {
    errors.push("land-queue: run.dryRun must be a boolean when present");
  }
  if (r.runId !== undefined && typeof r.runId !== "string") {
    errors.push("land-queue: run.runId must be a string when present");
  }
  if (r.now !== undefined && typeof r.now !== "string") {
    errors.push("land-queue: run.now must be a string when present");
  }
  if (r.updates !== undefined) {
    if (!Array.isArray(r.updates)) {
      errors.push("land-queue: run.updates must be an array when present");
    } else {
      (r.updates as unknown[]).forEach((u, i) => {
        if (!isPlainObject(u)) {
          errors.push("land-queue: run.updates[" + i + "] is not an object");
          return;
        }
        if (!isNonEmptyString(u.issue)) errors.push("land-queue: run.updates[" + i + "] has no issue string");
        if (u.status !== undefined && !LAND_QUEUE_STATUSES.includes(u.status as LandQueueStatus)) {
          errors.push("land-queue: run.updates[" + i + "].status is not a queue status");
        }
        if (u.verification !== undefined) {
          const v = u.verification as JsonObject;
          if (!isPlainObject(v) || typeof v.passed !== "boolean" || !isNonEmptyString(v.summary)) {
            errors.push("land-queue: run.updates[" + i + "].verification needs passed (boolean) and summary (string)");
          }
        }
        if (u.authorization !== undefined && u.authorization !== null) {
          const err = validateMergeAuthorization(u.authorization);
          if (err !== null) errors.push("land-queue: run.updates[" + i + "].authorization is malformed");
        }
        if (u.notesAppend !== undefined && typeof u.notesAppend !== "string") {
          errors.push("land-queue: run.updates[" + i + "].notesAppend must be a string when present");
        }
      });
    }
  }
  if (!isNonEmptyString((input as JsonObject).owner)) {
    errors.push("land-queue: input has no owner string — the owner is the driving session, never assumed from the launcher");
  }
  return errors;
}

/** The copy roots an entry merges from: `copies` wins when both
 * forms are present; a lone `copy` normalizes to one element. */
export function copiesOf(entry: LandQueueEntry): string[] {
  if (Array.isArray(entry.copies)) return [...entry.copies];
  if (typeof entry.copy === "string" && entry.copy !== "") return [entry.copy];
  return [];
}

/** One queue entry skipped by the lenient read: a status nobody
 * recognizes (a typo, or a status added after this code was
 * written). The entry is named, never silently dropped. */
export interface QueueEntrySkip {
  issue: string;
  status: string;
  reason: string;
}

/** Validate one queue entry. Pure — returns the entry (null when
 * the raw value is not an object), its errors, and whether the
 * unknown-status error is its ONLY error (the skip-with-reason
 * shape: an entry with no other defect). `seen` is the set of
 * issue keys already validated — mutated exactly as
 * validateQueueFile always did. */
function validateQueueEntry(
  raw: unknown,
  i: number,
  seen: Set<string>,
): { entry: LandQueueEntry | null; errors: string[]; unknownStatusOnly: boolean } {
  if (!isPlainObject(raw)) {
    return { entry: null, errors: ["land-queue: queue item " + i + " is not an object"], unknownStatusOnly: false };
  }
  const e = raw as LandQueueEntry;
  const errors: string[] = [];
  if (!isNonEmptyString(e.issue)) errors.push("land-queue: queue item " + i + " has no issue string");
  else if (seen.has(e.issue)) errors.push("land-queue: queue has two entries for issue " + e.issue);
  else seen.add(e.issue);
  if (!isNonEmptyString(e.title)) errors.push("land-queue: queue item " + (e.issue ?? i) + " has no title string");
  let unknownStatus = false;
  if (!isNonEmptyString(e.status)) {
    errors.push("land-queue: queue item " + (e.issue ?? i) + " has no status string");
  } else if (!LAND_QUEUE_STATUSES.includes(e.status as LandQueueStatus)) {
    errors.push("land-queue: queue item " + e.issue + " has unknown status " + JSON.stringify(e.status));
    unknownStatus = true;
  }
  if (e.copies !== undefined && (!Array.isArray(e.copies) || e.copies.some((c) => typeof c !== "string"))) {
    errors.push("land-queue: queue item " + (e.issue ?? i) + ".copies is not a string array");
  }
  if (e.copy !== undefined && typeof e.copy !== "string") {
    errors.push("land-queue: queue item " + (e.issue ?? i) + ".copy is not a string");
  }
  if (e.verification !== undefined && e.verification !== null) {
    const v = e.verification as unknown as JsonObject;
    if (!isPlainObject(v) || typeof v.passed !== "boolean" || !isNonEmptyString(v.summary)) {
      errors.push("land-queue: queue item " + (e.issue ?? i) + ".verification needs passed (boolean) and summary (string)");
    }
  }
  if (e.authorization !== undefined && e.authorization !== null) {
    const err = validateMergeAuthorization(e.authorization);
    if (err !== null) errors.push("land-queue: queue item " + (e.issue ?? i) + ".authorization is malformed");
  }
  return { entry: e, errors, unknownStatusOnly: unknownStatus && errors.length === 1 };
}

/** Validate the parsed queue file. Pure — returns the items plus
 * the errors (empty when valid). The top level must be an object
 * with an `items` array; every entry needs a non-empty issue,
 * title, and a known status; issues must be unique; a present
 * verification needs passed + summary; a present authorization
 * must validate. Unknown top-level keys and unknown entry fields
 * are preserved, never an error. The readers (247/248) use the
 * lenient sibling validateQueueFileForRead instead — same
 * validation, except an entry whose only defect is an unknown
 * status is skipped-with-reason rather than a refusal. */
export function validateQueueFile(value: unknown): { items: LandQueueEntry[]; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { items: [], errors: ["land-queue: queue file is not a JSON object"] };
  if (!Array.isArray(value.items)) return { items: [], errors: ["land-queue: queue file has no items array"] };
  const items: LandQueueEntry[] = [];
  const seen = new Set<string>();
  value.items.forEach((raw, i) => {
    const { entry, errors: entryErrors } = validateQueueEntry(raw, i, seen);
    errors.push(...entryErrors);
    if (entry !== null) items.push(entry);
  });
  return { items, errors };
}

/** The lenient read (BRA-247/248 fix round, Nov 22): the same
 * validation as validateQueueFile, except an entry whose ONLY
 * defect is an out-of-vocabulary status is SKIPPED-WITH-REASON —
 * excluded from items, named in `skipped`, and contributes no
 * error — while every structural error (no issue string,
 * duplicate issue, no title, no status string, bad copies/copy,
 * malformed verification/authorization, non-object entry, no
 * items array) still refuses. The land queue itself keeps the
 * strict read: its writer contract stands, and a status the queue
 * actually uses ("pending_qa" included, Landing ruling Nov 22
 * ~03:38 PST) is handled explicitly, never skipped. The readers
 * (247/248) use this read so a typo or a future status never
 * fails the whole run — the skip is named in the report. */
export function validateQueueFileForRead(value: unknown): { items: LandQueueEntry[]; skipped: QueueEntrySkip[]; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { items: [], skipped: [], errors: ["land-queue: queue file is not a JSON object"] };
  if (!Array.isArray(value.items)) return { items: [], skipped: [], errors: ["land-queue: queue file has no items array"] };
  const items: LandQueueEntry[] = [];
  const skipped: QueueEntrySkip[] = [];
  const seen = new Set<string>();
  value.items.forEach((raw, i) => {
    const { entry, errors: entryErrors, unknownStatusOnly } = validateQueueEntry(raw, i, seen);
    if (entry !== null && unknownStatusOnly) {
      skipped.push({ issue: entry.issue, status: entry.status, reason: entryErrors[0] });
      return;
    }
    errors.push(...entryErrors);
    if (entry !== null) items.push(entry);
  });
  return { items, skipped, errors };
}

/** Append a reason to an entry's notes when the notes do not
 * already name it (idempotent — a re-run never grows the notes
 * twice for the same reason). Pure. */
export function ensureFailureNamed(entry: LandQueueEntry, reason: string): boolean {
  const notes = typeof entry.notes === "string" ? entry.notes : "";
  if (notes.includes(reason)) return false;
  entry.notes = notes === "" ? reason : notes + " " + reason;
  return true;
}

/** Apply the run's updates to the items (by issue), before
 * ordering. Pure — returns the errors (empty when all applied).
 * An update naming an unknown issue is an error (fail-closed).
 * Setting verification/authorization/status/notes is recorded
 * in the returned applied list, each naming the issue. */
export function applyQueueUpdates(
  items: LandQueueEntry[],
  updates: LandQueueEntryUpdate[],
): { applied: string[]; errors: string[] } {
  const applied: string[] = [];
  const errors: string[] = [];
  const byIssue = new Map(items.map((e) => [e.issue, e]));
  for (const u of updates) {
    const entry = byIssue.get(u.issue);
    if (entry === undefined) {
      errors.push("land-queue: update names unknown issue " + u.issue);
      continue;
    }
    if (u.verification !== undefined) {
      entry.verification = u.verification;
      applied.push(u.issue + ": verification recorded (passed=" + u.verification.passed + ")");
    }
    if (u.authorization !== undefined) {
      entry.authorization = u.authorization;
      applied.push(u.issue + ": authorization recorded");
    }
    if (u.status !== undefined) {
      entry.status = u.status;
      applied.push(u.issue + ": status set to " + u.status);
    }
    if (u.notesAppend !== undefined) {
      const notes = typeof entry.notes === "string" ? entry.notes : "";
      entry.notes = notes === "" ? u.notesAppend : notes + " " + u.notesAppend;
      applied.push(u.issue + ": note appended");
    }
  }
  return { applied, errors };
}

/** Order the items and apply the readiness transitions. Pure.
 * Ready: status "ready" + verification passed + ready_at set
 * (ready_at is set to `now` when the verification passed and it
 * is null). A "ready" entry with a failed or missing verification
 * transitions to "blocked" with the reason named in notes. A
 * blocked entry keeps its failure named. "pending_qa" (Landing
 * ruling, Nov 22 ~03:38 PST) is its own bucket, after paused and
 * before landed: verification done, Quality's verdict outstanding —
 * the queue never orders it as ready and never demotes it to
 * blocked; it only orders it. Buckets: ready by ready_at
 * ascending; blocked, paused, pending_qa, landed by previous
 * order ascending, then issue. `order` is reassigned 1..N in the
 * final sequence. Returns the ordered items, the bucket issue
 * lists, and the transitions made. */
export function orderQueueEntries(
  items: LandQueueEntry[],
  now: string,
): { ordered: LandQueueEntry[]; ready: string[]; blocked: string[]; paused: string[]; pendingQa: string[]; landed: string[]; transitions: string[] } {
  const transitions: string[] = [];
  const ready: LandQueueEntry[] = [];
  const blocked: LandQueueEntry[] = [];
  const paused: LandQueueEntry[] = [];
  const pendingQa: LandQueueEntry[] = [];
  const landed: LandQueueEntry[] = [];
  const prevOrder = (e: LandQueueEntry): number => (typeof e.order === "number" ? e.order : Number.MAX_SAFE_INTEGER);
  const byPrevOrder = (a: LandQueueEntry, b: LandQueueEntry): number =>
    prevOrder(a) - prevOrder(b) || (a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : 0);
  for (const entry of items) {
    if (entry.status === "landed") {
      landed.push(entry);
      continue;
    }
    if (entry.status === "paused") {
      paused.push(entry);
      continue;
    }
    if (entry.status === "pending_qa") {
      pendingQa.push(entry);
      continue;
    }
    if (entry.status === "blocked") {
      const v = entry.verification;
      if (isPlainObject(v) && v.passed === false && typeof v.failedReason === "string" && v.failedReason !== "") {
        if (ensureFailureNamed(entry, v.failedReason)) {
          transitions.push(entry.issue + ": failure named (" + v.failedReason + ")");
        }
      } else if (!isPlainObject(v)) {
        if (ensureFailureNamed(entry, "blocked — no verification recorded")) {
          transitions.push(entry.issue + ": failure named (blocked — no verification recorded)");
        }
      }
      blocked.push(entry);
      continue;
    }
    // status "ready": ready only when the verification passed and
    // ready_at is set; otherwise the entry transitions to blocked.
    const v = entry.verification;
    if (isPlainObject(v) && v.passed === true) {
      if (!isNonEmptyString(entry.ready_at)) {
        entry.ready_at = now;
        transitions.push(entry.issue + ": ready_at set to " + now);
      }
      ready.push(entry);
    } else if (isPlainObject(v) && v.passed === false) {
      const reason =
        typeof v.failedReason === "string" && v.failedReason !== ""
          ? v.failedReason
          : "verification failed — no reason recorded";
      entry.status = "blocked";
      if (ensureFailureNamed(entry, reason)) {
        transitions.push(entry.issue + ": ready -> blocked (" + reason + ")");
      } else {
        transitions.push(entry.issue + ": ready -> blocked");
      }
      blocked.push(entry);
    } else {
      entry.status = "blocked";
      if (ensureFailureNamed(entry, "no verification recorded — an entry is ready only when its verification passed")) {
        transitions.push(entry.issue + ": ready -> blocked (no verification recorded)");
      } else {
        transitions.push(entry.issue + ": ready -> blocked");
      }
      blocked.push(entry);
    }
  }
  ready.sort((a, b) => String(a.ready_at).localeCompare(String(b.ready_at)) || byPrevOrder(a, b));
  blocked.sort(byPrevOrder);
  paused.sort(byPrevOrder);
  pendingQa.sort(byPrevOrder);
  landed.sort(byPrevOrder);
  const ordered = [...ready, ...blocked, ...paused, ...pendingQa, ...landed];
  ordered.forEach((e, i) => {
    e.order = i + 1;
  });
  return {
    ordered,
    ready: ready.map((e) => e.issue),
    blocked: blocked.map((e) => e.issue),
    paused: paused.map((e) => e.issue),
    pendingQa: pendingQa.map((e) => e.issue),
    landed: landed.map((e) => e.issue),
    transitions,
  };
}

/** One rotation record, the one-time rotation's shape (live file,
 * top-level `rotation`, Nov 22): when it ran, who ran it, where
 * the entries went, how many, which issues, and why. */
export interface QueueRotationRecord {
  rotated_at: string;
  rotated_by: string;
  archived_to: string;
  archived_count: number;
  archived_issues: string[];
  note: string;
}

/** The history file's name for a rotation at `now` (ISO UTC):
 * one dated file per rotation, in the queue file's directory —
 * never a single appended file (that file would itself grow past
 * the trap read cap). Same naming as the one-time rotation's
 * land-queue-rotated-2026-11-22.json, with the run's time added
 * so two rotations the same day never collide. Pure. */
export function rotationHistoryFileName(now: string): string {
  return "land-queue-rotated-" + now.replace(/[-:]/g, "") + ".json";
}

/** The history file's path for a queue file + run time. Pure. */
export function rotationHistoryPath(queuePath: string, now: string): string {
  const slash = queuePath.lastIndexOf("/");
  const dir = slash >= 0 ? queuePath.slice(0, slash) : ".";
  return dir + "/" + rotationHistoryFileName(now);
}

/** Split the landed entries into the ones a rotation moves and
 * the ones it keeps: the `keepMostRecentLanded` most recent
 * (landed_at descending, then previous order descending — an
 * entry with no landed_at sorts as oldest) stay; every older
 * landed entry moves, oldest first in the moved list. Pure. */
export function planRotation(
  items: LandQueueEntry[],
  keepMostRecentLanded: number = LAND_QUEUE_KEEP_RECENT_LANDED,
): { moved: LandQueueEntry[]; kept: LandQueueEntry[] } {
  const landed = items.filter((e) => e.status === "landed");
  const byRecency = (a: LandQueueEntry, b: LandQueueEntry): number => {
    const atA = typeof a.landed_at === "string" ? a.landed_at : "";
    const atB = typeof b.landed_at === "string" ? b.landed_at : "";
    if (atA !== atB) return atA < atB ? 1 : -1;
    const oA = typeof a.order === "number" ? a.order : 0;
    const oB = typeof b.order === "number" ? b.order : 0;
    return oB - oA;
  };
  const sorted = [...landed].sort(byRecency);
  const kept = sorted.slice(0, keepMostRecentLanded);
  const keptSet = new Set(kept);
  const moved = sorted.filter((e) => !keptSet.has(e)).reverse();
  return { moved, kept };
}

/** Build one rotation record. Pure. */
export function buildRotationRecord(args: {
  now: string;
  rotatedBy: string;
  archivedTo: string;
  archivedIssues: string[];
  note: string;
}): QueueRotationRecord {
  return {
    rotated_at: args.now,
    rotated_by: args.rotatedBy,
    archived_to: args.archivedTo,
    archived_count: args.archivedIssues.length,
    archived_issues: [...args.archivedIssues],
    note: args.note,
  };
}

/** Write a rotation record into the file's top level. Pure —
 * returns a new top-level object: the `rotations` array gains
 * the record (seeded from the existing singular `rotation` when
 * the file carries one and no array yet, so the one-time
 * rotation's record is never lost), and `rotation` is the latest
 * record. */
export function applyRotationRecord(
  top: JsonObject,
  record: QueueRotationRecord,
): JsonObject {
  const rotations: QueueRotationRecord[] = Array.isArray(top.rotations)
    ? [...(top.rotations as QueueRotationRecord[])]
    : [];
  if (rotations.length === 0 && isPlainObject(top.rotation)) {
    rotations.push(top.rotation as unknown as QueueRotationRecord);
  }
  rotations.push(record);
  return { ...top, rotations, rotation: record };
}

/** The mid-rotation stability check: true when the live file's
 * bytes changed between the rotation's read and its write. Pure
 * — the entry refuses on true, never overwrites blind. */
export function rotationReReadChanged(firstContent: string, secondContent: string): boolean {
  return firstContent !== secondContent;
}

/** The refusal note when the live file changed mid-rotation.
 * Pure — the wording is unit-tested; the entry refuses with it
 * and writes nothing to the live file. */
export function rotationChangedRefusalNote(historyName: string): string {
  return (
    "land-queue: queue file changed during rotation — refusing, nothing written to the live file " +
    "(history file " +
    historyName +
    " already holds the planned entries in full; re-run to retry — an entry written mid-rotation is never lost and never duplicated)"
  );
}

/** Assemble the report. Pure. The verdict is "ordered" only when
 * the run wrote (or, in dry-run, planned) cleanly; "dry-run" when
 * the plan is clean and nothing was written; "failed" otherwise.
 * Every failure is named in notes. */
export function buildLandQueueReport(args: {
  queueId: string;
  verdict: LandQueueReport["verdict"];
  dryRun: boolean;
  owner: string;
  launchedBy?: string;
  cancelChecked: boolean;
  cancelled: boolean;
  queuePath: string;
  ready: string[];
  blocked: string[];
  paused: string[];
  pendingQa: string[];
  landed: string[];
  items: number;
  updated: boolean;
  transitions: string[];
  extraNotes?: string[];
}): LandQueueReport {
  const notes: string[] = [...(args.extraNotes ?? [])];
  if (args.cancelled) {
    notes.push("run cancelled — land queue refused, nothing was written");
  }
  return {
    queueId: args.queueId,
    verdict: args.verdict,
    dryRun: args.dryRun,
    owner: args.owner,
    launchedBy: args.launchedBy,
    cancelChecked: args.cancelChecked,
    cancelled: args.cancelled,
    queuePath: args.queuePath,
    ready: args.ready,
    blocked: args.blocked,
    paused: args.paused,
    pendingQa: args.pendingQa,
    landed: args.landed,
    items: args.items,
    updated: args.updated,
    transitions: args.transitions,
    notes,
    knownLimit: LAND_QUEUE_KNOWN_LIMIT,
  };
}

// ------------------------------------------------------------------
// Trap I/O helpers (exec traps; not pure).
// ------------------------------------------------------------------

type ReadResult =
  | { kind: "ok"; total: number; printed: number; content: string }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/** Read one file through a bounded exec trap. A missing file is a
 * result, not a throw — the caller records it. A truncated read is
 * reported in the result (the caller refuses, never parses a
 * truncated file). A malformed trap response throws loudly. */
function readFileViaTrap(filePath: string, maxBytes: number): ReadResult {
  const r = exec({ cmd: "/bin/sh", args: ["-c", readFileScript(filePath, maxBytes)] });
  if (r.exitCode === 2) return { kind: "missing" };
  if (r.exitCode === 1) {
    return { kind: "error", reason: (r.stdout ?? "").trim().slice(0, 200) || "read failed (rc 1)" };
  }
  if (r.exitCode !== 0) {
    throw new Error(
      "land-queue: read trap failed unexpectedly for " +
        filePath +
        " (rc " +
        r.exitCode +
        "): " +
        ((r.stderr ?? "") + (r.stdout ?? "")).slice(0, 200),
    );
  }
  const parsed = parseReadOutput(r.stdout ?? "");
  return { kind: "ok", total: parsed.total, printed: parsed.printed, content: parsed.content };
}

/** Write one text file through chunked base64 traps + rename +
 * read-back (the dispatch pattern). Throws loudly on any failure
 * — a half-written queue must not report success. */
function writeTextFile(tmpPath: string, destPath: string, content: string): void {
  const chunks = splitHandoffChunks(content);
  for (let i = 0; i < chunks.length; i++) {
    const r = exec({ cmd: "/bin/sh", args: ["-c", chunkWriteScript(chunks[i], i, tmpPath)] });
    if (r.exitCode !== 0 || (r.stdout ?? "").trim() !== "CHUNK " + i) {
      throw new Error(
        "land-queue: write chunk " + i + " failed for " + destPath + ": " + JSON.stringify((r.stdout ?? "").slice(0, 200)),
      );
    }
  }
  const fin = exec({ cmd: "/bin/sh", args: ["-c", finalizeWriteScript(tmpPath, destPath, "json")] });
  if (fin.exitCode !== 0) {
    throw new Error("land-queue: write finalize failed for " + destPath + " (rc " + fin.exitCode + ")");
  }
  const summary = parseWriteSummary(fin.stdout ?? "");
  if (summary.path !== destPath) {
    throw new Error("land-queue: write summary names the wrong path: " + JSON.stringify(summary.path));
  }
}

/** The clock script: print one `NOW <ISO UTC>` line. Used only
 * when run.now is absent — tests pass run.now for determinism.
 * Pure — the script's shape is unit-tested. */
export function nowScript(): string {
  return "date -u +%Y-%m-%dT%H:%M:%SZ | sed 's/^/NOW /'";
}

/** Parse the clock trap's one-line output. Pure. */
export function parseNowOutput(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const m = /^NOW (\S+)$/.exec(line);
  if (!m) throw new Error("land-queue: clock output is not a NOW line: " + JSON.stringify(line.slice(0, 200)));
  return m[1];
}

export default function landQueue(input: LandQueueInput): LandQueueReport {
  const dryRun = input?.run?.dryRun ?? false;
  let cancelChecked = false;
  let cancelled = false;
  const refusedReport = (
    extraNotes: string[],
    queueId?: string,
  ): LandQueueReport =>
    buildLandQueueReport({
      queueId: queueId ?? (typeof input?.run?.queueId === "string" ? input.run.queueId : ""),
      verdict: "failed",
      dryRun,
      owner: typeof input?.owner === "string" ? input.owner : "",
      launchedBy: input?.launchedBy,
      cancelChecked,
      cancelled,
      queuePath: typeof input?.run?.queuePath === "string" ? input.run.queuePath : "",
      ready: [],
      blocked: [],
      paused: [],
      pendingQa: [],
      landed: [],
      items: 0,
      updated: false,
      transitions: [],
      extraNotes,
    });

  // Validate first, fail-closed. A null/absent run is refused,
  // never dereferenced (this workflow validates first, so it does
  // not have the defect).
  if (!isPlainObject(input)) return refusedReport(["land-queue: input is not an object"]);
  if (!isPlainObject((input as JsonObject).run)) {
    return refusedReport(["land-queue: input has no run object"]);
  }
  const run = (input as LandQueueInput).run;
  const validationErrors = validateLandQueueInput(input);
  if (validationErrors.length > 0) {
    return refusedReport(validationErrors, run.queueId);
  }
  const stateDir = (input as LandQueueInput).project.stateDir;

  // Cancel check first (when runId present): check-then-act before
  // any read or write. Exit 2 (no queue entry) and exit 3 (queue
  // missing/unparsable) mean the check did not complete — the run
  // refuses with cancelChecked false. A cancelled run refuses
  // with cancelChecked true + cancelled true.
  if (typeof run.runId === "string" && run.runId !== "") {
    const check = exec({ cmd: "/bin/sh", args: ["-c", cancelCheckScript(stateDir, run.runId)] });
    if (check.exitCode === 2) {
      return refusedReport(["land-queue: cancel check: no queue entry for run " + run.runId], run.queueId);
    }
    if (check.exitCode === 3) {
      return refusedReport(["land-queue: cancel check: " + (check.stdout ?? "").trim().slice(0, 200)], run.queueId);
    }
    if (check.exitCode !== 0) {
      throw new Error(
        "land-queue: cancel check failed unexpectedly (rc " +
          check.exitCode +
          "): " +
          ((check.stderr ?? "") + (check.stdout ?? "")).slice(0, 200),
      );
    }
    let status: string;
    try {
      status = parseRunStatus(check.stdout ?? "");
    } catch (e) {
      throw new Error("land-queue: cancel status is malformed: " + (e as Error).message);
    }
    cancelChecked = true;
    if (status === "cancelled") {
      cancelled = true;
      return refusedReport(["land-queue: run " + run.runId + " is cancelled — the queue exits cleanly without advancing"], run.queueId);
    }
  }

  // The clock: run.now when the caller supplies it, else the
  // trap's UTC time. `updated` and any ready_at set this run use
  // this one value.
  let now: string;
  if (typeof run.now === "string" && run.now !== "") {
    now = run.now;
  } else {
    const clock = exec({ cmd: "/bin/sh", args: ["-c", nowScript()] });
    if (clock.exitCode !== 0) {
      throw new Error("land-queue: clock trap failed (rc " + clock.exitCode + ")");
    }
    now = parseNowOutput(clock.stdout ?? "");
  }

  // Read the queue file (it must be present — a missing queue
  // file refuses the whole run before any write).
  const queueRead = readFileViaTrap(run.queuePath, LAND_QUEUE_READ_MAX_BYTES);
  if (queueRead.kind === "missing") {
    return refusedReport(["land-queue: queue file not found: " + run.queuePath], run.queueId);
  }
  if (queueRead.kind === "error") {
    return refusedReport(["land-queue: queue file unreadable: " + queueRead.reason], run.queueId);
  }
  if (queueRead.printed < queueRead.total) {
    return refusedReport(
      ["land-queue: queue file exceeds the " + LAND_QUEUE_READ_MAX_BYTES + "-byte read bound (" + queueRead.total + " bytes) — rotation needed, see BACKLOG.md"],
      run.queueId,
    );
  }
  let queueJson: unknown;
  try {
    queueJson = JSON.parse(queueRead.content) as unknown;
  } catch (e) {
    return refusedReport(["land-queue: queue file is unparsable JSON: " + (e as Error).message.slice(0, 200)], run.queueId);
  }
  const { items, errors } = validateQueueFile(queueJson);
  if (errors.length > 0) {
    return refusedReport(errors, run.queueId);
  }

  // Apply the run's updates, then order. An update naming an
  // unknown issue refuses the run before any write.
  const updates = run.updates ?? [];
  const { applied, errors: updateErrors } = applyQueueUpdates(items, updates);
  if (updateErrors.length > 0) {
    return refusedReport(updateErrors, run.queueId);
  }

  // Rotation: when the file approaches the read bound, move all
  // but the most recent landed entries into a dated history file
  // (decision 4). The history write happens before the live
  // write; the live file is re-read immediately before it is
  // written and the run refuses when it changed — an entry
  // written mid-rotation is never lost and never duplicated.
  const rotationNotes: string[] = [];
  let rotationRecord: QueueRotationRecord | null = null;
  if (queueRead.total >= LAND_QUEUE_ROTATION_THRESHOLD_BYTES) {
    const plan = planRotation(items);
    if (plan.moved.length === 0) {
      rotationNotes.push(
        "rotation: file at " +
          queueRead.total +
          " bytes approaches the " +
          LAND_QUEUE_READ_MAX_BYTES +
          "-byte bound but holds no landed entries to rotate — nothing moved",
      );
    } else if (dryRun) {
      rotationNotes.push(
        "rotation would fire: " +
          plan.moved.length +
          " landed entries would move to " +
          rotationHistoryFileName(now) +
          " (kept " +
          plan.kept.length +
          " most recent landed)",
      );
    } else {
      const historyName = rotationHistoryFileName(now);
      const historyPath = rotationHistoryPath(run.queuePath, now);
      rotationRecord = buildRotationRecord({
        now,
        rotatedBy: "land-queue workflow",
        archivedTo: historyName,
        archivedIssues: plan.moved.map((e) => e.issue),
        note:
          "Rotation: " +
          plan.moved.length +
          " landed entries archived in full to " +
          historyName +
          " (nothing deleted); live file keeps " +
          plan.kept.length +
          " most recent landed entries. Queue file at " +
          queueRead.total +
          " bytes approached the " +
          LAND_QUEUE_READ_MAX_BYTES +
          "-byte read bound.",
      });
      const historyContent = JSON.stringify({ items: plan.moved, rotation: rotationRecord }, null, 1) + "\n";
      const workTmp = (input as LandQueueInput).project.workDir + "/tmp";
      const mkHist = exec({ cmd: "mkdir", args: ["-p", workTmp] });
      if (mkHist.exitCode !== 0) {
        throw new Error("land-queue: cannot create workDir tmp " + workTmp + " (rc " + mkHist.exitCode + ")");
      }
      writeTextFile(workTmp + "/land-queue-history.json.tmp", historyPath, historyContent);
      const reRead = readFileViaTrap(run.queuePath, LAND_QUEUE_READ_MAX_BYTES);
      if (reRead.kind === "missing") {
        return refusedReport(
          ["land-queue: queue file disappeared during rotation — refusing, nothing written to the live file"],
          run.queueId,
        );
      }
      if (reRead.kind === "error") {
        return refusedReport(
          ["land-queue: queue file unreadable during rotation: " + reRead.reason + " — refusing, nothing written to the live file"],
          run.queueId,
        );
      }
      if (rotationReReadChanged(queueRead.content, reRead.content)) {
        return refusedReport([rotationChangedRefusalNote(historyName)], run.queueId);
      }
      const movedSet = new Set(plan.moved);
      items.splice(0, items.length, ...items.filter((e) => !movedSet.has(e)));
      rotationNotes.push(
        "rotation: " +
          plan.moved.length +
          " landed entries archived to " +
          historyName +
          " (kept " +
          plan.kept.length +
          " most recent landed: " +
          plan.kept.map((e) => e.issue).join(", ") +
          ")",
      );
    }
  }
  const { ordered, ready, blocked, paused, pendingQa, landed, transitions } = orderQueueEntries(items, now);

  if (dryRun) {
    return buildLandQueueReport({
      queueId: run.queueId,
      verdict: "dry-run",
      dryRun: true,
      owner: (input as LandQueueInput).owner,
      launchedBy: (input as LandQueueInput).launchedBy,
      cancelChecked,
      cancelled,
      queuePath: run.queuePath,
      ready,
      blocked,
      paused,
      pendingQa,
      landed,
      items: ordered.length,
      updated: false,
      transitions,
      extraNotes: [
        "dry-run: " + ready.length + " ready, " + blocked.length + " blocked, " + paused.length + " paused, " + pendingQa.length + " pending_qa, " + landed.length + " landed — nothing written",
        ...(applied.length > 0 ? ["dry-run: updates planned, not applied: " + applied.join("; ")] : []),
        ...rotationNotes,
      ],
    });
  }

  // Persist: the top level is preserved whole, `items` replaced
  // by the ordered entries, `updated` set to now, and a rotation
  // this run recorded (`rotations` array + latest `rotation`).
  // The write is chunked base64 + rename + read-back (the
  // dispatch pattern).
  const top = queueJson as JsonObject;
  const out =
    rotationRecord !== null
      ? applyRotationRecord({ ...top, items: ordered, updated: now }, rotationRecord)
      : { ...top, items: ordered, updated: now };
  const tmpPath = (input as LandQueueInput).project.workDir + "/tmp/land-queue.json.tmp";
  const mk = exec({ cmd: "mkdir", args: ["-p", (input as LandQueueInput).project.workDir + "/tmp"] });
  if (mk.exitCode !== 0) {
    throw new Error("land-queue: cannot create workDir tmp " + (input as LandQueueInput).project.workDir + "/tmp (rc " + mk.exitCode + ")");
  }
  writeTextFile(tmpPath, run.queuePath, JSON.stringify(out, null, 1) + "\n");

  return buildLandQueueReport({
    queueId: run.queueId,
    verdict: "ordered",
    dryRun: false,
    owner: (input as LandQueueInput).owner,
    launchedBy: (input as LandQueueInput).launchedBy,
    cancelChecked,
    cancelled,
    queuePath: run.queuePath,
    ready,
    blocked,
    paused,
    pendingQa,
    landed,
    items: ordered.length,
    updated: true,
    transitions,
    extraNotes: [...(applied.length > 0 ? ["updates applied: " + applied.join("; ")] : []), ...rotationNotes],
  });
}
