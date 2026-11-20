// run-ledger — one record per terminal run in the state dir (BRA-165).
//
// The cost model records per-call-site wall-time actuals and the
// scheduler reads them; tier timings are recorded per run.sh
// section. Neither aggregates per-RUN totals, and nothing records
// tokens anywhere. The ledger is the single source for per-run
// efficiency numbers: wall clock, trap/job counts, and tokens as
// reported by workers — the foundation the dynamic scheduler
// (BRA-160) and the audit (BRA-166) build on.
//
// Format: one JSON line per terminal run, appended to
// <stateDir>/ledger/run-ledger.jsonl (append-only JSONL, the same
// shape as cost-actuals.jsonl and the journal). The journal is the
// source of truth: an entry is built from the run's journal tree
// (profileTree for counts/wall time, a scan of trap-result events
// for tokens), never from parallel in-memory counters — so a run
// driven across several processes still gets exactly one entry
// with the whole run's numbers.
//
// Tokens are explicit unknown, never invented: the complete-job
// payload carries no token counts (verified in worker-server.ts
// completeJob + plugins/muse/worker-loop.ts: neither reads nor
// sends `tokens`), and no adapter reports TrapAnswer.tokens today
// (adapter.ts: "no adapter reports tokens today"). A run whose
// traps report no tokens gets tokens.total === null. When an
// adapter starts reporting them, the journal already carries them
// on trap-result events (host.ts ingestLog attaches meta.tokens)
// and the ledger picks them up with no code change.
//
// The write is best-effort by design: recordRunLedger never throws
// — a ledger failure must not fail the run it measures. A corrupt
// ledger line is skipped on load, never fatal (same rule as
// loadActualsFile).
//
// Ranking: rankQueueByLedgerCost orders queue entries by the mean
// ledger wall time of their workflow (unknown-cost workflows sort
// last, in their original order; ties break by mean tokens, unknown
// last). It is a pure query surface — runQueue's ordering is
// unchanged by BRA-165; the dynamic scheduler (BRA-160) decides
// when to apply it.

import * as fs from "node:fs";
import * as path from "node:path";

import { loadJournalTree, profileTree, parseWallTs, type JournalTree } from "./profiler";

/** Ledger format version (bump only on a breaking record change). */
export const LEDGER_VERSION = 1;

/** Where the ledger lives under a state dir. */
export function ledgerFile(stateDir: string): string {
  return path.join(stateDir, "ledger", "run-ledger.jsonl");
}

export interface LedgerTrapCounts {
  /** Trap-result + trap-error events (answered traps). */
  total: number;
  /** Per trap type: answered results and errors. */
  byType: Record<string, { results: number; errors: number }>;
  /** Job traps that completed (byType.job.results − errors: the
   * profiler counts every answered trap as a result, errored ones
   * included, so completed = answered − errored). */
  jobsCompleted: number;
  /** Job traps that errored (byType.job.errors). */
  jobsFailed: number;
}

export interface LedgerTokens {
  /** Sum of tokens reported on trap-result events, or null when no
   * trap in the run reported any (explicit unknown). */
  total: number | null;
  /** How many trap results reported a token count. */
  reportedTraps: number;
  /** Total trap results in the run (the denominator). */
  totalTraps: number;
}

export interface LedgerEntry {
  version: typeof LEDGER_VERSION;
  runId: string;
  /** Workflow as submitted (the queue entry's workflowPath). */
  workflow: string;
  status: "done" | "failed";
  adapter: string;
  /** First / last wallTs in the root journal (ISO), or null when
   * the journal carries no wallTs (v1 journals). */
  startedAt: string | null;
  finishedAt: string | null;
  /** Total run wall time (ms): last.wallTs − first.wallTs over the
   * root journal; null when either is missing. Includes gate-hold
   * time when the run waited at a gate — see gateHoldMs. */
  wallMs: number | null;
  /** Sum of gate hold durations (ms) when computable, else null.
   * Active time is wallMs − gateHoldMs when both are known. */
  gateHoldMs: number | null;
  traps: LedgerTrapCounts;
  tokens: LedgerTokens;
  /** Failure reason for failed runs, else null. */
  error: string | null;
}

/** Build one ledger entry from a run's journal tree. Returns null
 * when there is nothing to record (no journals in the tree). Pure:
 * no I/O. The caller supplies the run's identity (workflow as
 * submitted, terminal status, adapter); everything measurable comes
 * from the journal tree. */
export function buildLedgerEntry(
  tree: JournalTree,
  opts: { runId: string; workflow: string; status: "done" | "failed"; adapter: string; error?: string },
): LedgerEntry | null {
  if (!tree || !Array.isArray(tree.journals) || tree.journals.length === 0) return null;
  const profile = profileTree(tree);

  const byType: Record<string, { results: number; errors: number }> = {};
  for (const [type, c] of Object.entries(profile.byType)) {
    byType[type] = { results: c.results, errors: c.errors };
  }
  const job = byType["job"];

  let gateHoldMs: number | null = null;
  for (const g of profile.gates) {
    if (typeof g.holdMs === "number") gateHoldMs = (gateHoldMs ?? 0) + g.holdMs;
  }

  let tokenTotal = 0;
  let reportedTraps = 0;
  let totalTraps = 0;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  const root = tree.journals[0];
  if (root) {
    for (const ev of root.events) {
      if (typeof ev?.wallTs === "string" && parseWallTs(ev.wallTs) !== null) {
        if (startedAt === null) startedAt = ev.wallTs;
        finishedAt = ev.wallTs;
      }
    }
  }
  for (const jf of tree.journals) {
    for (const ev of jf.events) {
      if (ev?.event !== "trap-result" && ev?.event !== "trap-error") continue;
      totalTraps += 1;
      if (typeof ev.tokens === "number" && Number.isFinite(ev.tokens) && ev.tokens >= 0) {
        tokenTotal += ev.tokens;
        reportedTraps += 1;
      }
    }
  }

  return {
    version: LEDGER_VERSION,
    runId: opts.runId,
    workflow: opts.workflow,
    status: opts.status,
    adapter: opts.adapter,
    startedAt,
    finishedAt,
    wallMs: profile.totalWallMs,
    gateHoldMs,
    traps: {
      total: profile.totalTraps,
      byType,
      jobsCompleted: (job?.results ?? 0) - (job?.errors ?? 0),
      jobsFailed: job?.errors ?? 0,
    },
    tokens: {
      total: reportedTraps > 0 ? tokenTotal : null,
      reportedTraps,
      totalTraps,
    },
    error: opts.error ?? null,
  };
}

/** Append one entry to the ledger file. Best-effort: a failure to
 * write the ledger must never fail the run it measures. */
export function appendLedgerEntry(file: string, entry: LedgerEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    /* ledger logging is best-effort */
  }
}

/** Record the ledger entry for a terminal run: load its journal
 * tree, build the entry, append it. Never throws — returns the
 * entry written, or null when there was nothing to record or the
 * record failed. */
export function recordRunLedger(
  stateDir: string,
  opts: { runId: string; workflow: string; status: "done" | "failed"; adapter: string; error?: string },
): LedgerEntry | null {
  try {
    const tree = loadJournalTree(path.join(stateDir, "journals"), opts.runId);
    const entry = buildLedgerEntry(tree, opts);
    if (!entry) return null;
    appendLedgerEntry(ledgerFile(stateDir), entry);
    return entry;
  } catch {
    return null;
  }
}

/** Read the ledger file (tolerant: corrupt lines are skipped, never
 * fatal — a cost log must not break a run). Returns the entries plus
 * the skipped-line count. */
export function loadLedger(file: string): { entries: LedgerEntry[]; skipped: number } {
  const entries: LedgerEntry[] = [];
  let skipped = 0;
  if (!fs.existsSync(file)) return { entries, skipped };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.runId !== "string" || typeof e?.workflow !== "string") throw new Error("not a ledger entry");
      entries.push(e as LedgerEntry);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/** Mean wall time (ms) of a workflow's recorded runs, or null when
 * the workflow has no recorded runs with a known wall time. */
export function meanWallMsForWorkflow(entries: LedgerEntry[], workflow: string): number | null {
  let sum = 0;
  let n = 0;
  for (const e of entries) {
    if (e.workflow !== workflow) continue;
    if (typeof e.wallMs !== "number") continue;
    sum += e.wallMs;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/** Mean tokens of a workflow's recorded runs, or null when no
 * recorded run reported tokens. */
export function meanTokensForWorkflow(entries: LedgerEntry[], workflow: string): number | null {
  let sum = 0;
  let n = 0;
  for (const e of entries) {
    if (e.workflow !== workflow) continue;
    if (typeof e.tokens?.total !== "number") continue;
    sum += e.tokens.total;
    n += 1;
  }
  return n > 0 ? sum / n : null;
}

/** Rank queued work by ledger cost (the read/query surface the
 * scheduler needs, BRA-165 acceptance 2). Orders entries by the
 * mean ledger wall time of their workflow, cheapest first; a
 * workflow with no recorded wall time sorts last, in its original
 * relative order (unknown is never treated as zero — the same rule
 * the scheduler applies to unknown cost-model estimates). Ties
 * break by mean tokens, unknown last. Pure: returns a new array,
 * never mutates its input. */
export function rankQueueByLedgerCost<T extends { workflow: string }>(queued: T[], entries: LedgerEntry[]): T[] {
  const indexed = queued.map((q, i) => ({ q, i }));
  const wallCache = new Map<string, number | null>();
  const tokenCache = new Map<string, number | null>();
  const wallOf = (workflow: string): number | null => {
    if (!wallCache.has(workflow)) wallCache.set(workflow, meanWallMsForWorkflow(entries, workflow));
    return wallCache.get(workflow) ?? null;
  };
  const tokensOf = (workflow: string): number | null => {
    if (!tokenCache.has(workflow)) tokenCache.set(workflow, meanTokensForWorkflow(entries, workflow));
    return tokenCache.get(workflow) ?? null;
  };
  indexed.sort((a, b) => {
    const wa = wallOf(a.q.workflow);
    const wb = wallOf(b.q.workflow);
    if (wa !== null && wb !== null && wa !== wb) return wa - wb;
    if (wa === null && wb !== null) return 1;
    if (wa !== null && wb === null) return -1;
    const ta = tokensOf(a.q.workflow);
    const tb = tokensOf(b.q.workflow);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if (ta === null && tb !== null) return 1;
    if (ta !== null && tb === null) return -1;
    return a.i - b.i;
  });
  return indexed.map((x) => x.q);
}
