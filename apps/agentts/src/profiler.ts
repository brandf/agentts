/**
 * Profiler (BRA-30, M3): render a run's journal tree as a timeline
 * with counters. READ-ONLY — it never schedules, dispatches, or
 * mutates a run; it only reads journal files.
 *
 * Time model (decided hands-dirty, see README + BRA-30, updated
 * BRA-57):
 *
 * Journal format v2 (BRA-57) stamps every event with `wallTs`
 * (ISO wall-clock time, ms precision) at the writer, and every
 * trap-result/trap-error carries `adapter` (the adapter that
 * answered), `worker` (the worker id when the adapter names one —
 * pool jobs only; canned/local answers carry none), `wallMs` (the
 * host-measured dispatch wall time, ms), and `tokens` when known.
 * So per-trap wall durations, total run wall time, and gate hold
 * durations are REAL when the events carry them:
 *   - a trap's wallMs is the result event's `wallMs` field when
 *     present (the precise dispatch measure, including repairs);
 *     else the wallTs difference trap → result (dispatch + the two
 *     C-host spawns around it); else null.
 *   - a gate's holdMs is result.wallTs − gate-held.wallTs (the hold
 *     is the wall time between the hold event and the delivered
 *     answer — a gate trap's own wallMs is only its final dispatch,
 *     ~0ms, and must never be read as the hold).
 *   - total run wall time is last.wallTs − first.wallTs over the
 *     root journal.
 * Older (v1) journals carry none of these fields, and the profiler
 * still reports them as unknown instead of inventing them — the
 * timeline axis stays EVENT ORDER (sequence index within each
 * journal), not time.
 *
 * Virtual time is separate and IS in the journal: `clock-advance`
 * events carry from/to ISO timestamps on the run's virtual clock.
 * A sleep/cron trap's virtual delta is the sum of the clock-advances
 * between its `trap` and its `trap-result` event (the advance is
 * journaled while the trap is suspended). For every other trap the
 * virtual clock does not move, so its virtual delta is 0 — a 2h
 * sleep advances the virtual clock 2h with ~0ms of wall time and is
 * shown on the virtual track only, never as a 2h stall.
 *
 * What the journal still lacks: per-trap tokens (no adapter reports
 * them today — the field exists on the event for when one does).
 * The reference driver's journals carry wallTs but no
 * adapter/worker/wallMs (its answers are canned test-harness
 * answers, not dispatched through an adapter) — those fields stay
 * unknown there, by the same missing-field rule.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type JournalEvent = Record<string, any>;

export interface JournalFile {
  runId: string;
  file: string;
  events: JournalEvent[];
}

/** A trap call site: bundle coordinates (BRA-73). `file` is the
 * bundle path; the run's pinned bundle + source map (see
 * Profile.runStart) translate it back to the workflow source. */
export interface TrapSite {
  file: string;
  line: number;
  column: number;
}

export interface JournalTree {
  rootRunId: string;
  journals: JournalFile[]; // root first, then branches in fork order
}

export interface TrapSpan {
  journalRunId: string;
  trapId: string;
  ordinal: number | null;
  type: string;
  argSummary: string;
  resultKind: "result" | "error" | "pending";
  resultSummary: string;
  errorText: string | null;
  /** Event index of the `trap` event inside its journal. */
  startSeq: number;
  /** Event index of the matching `trap-result`/`trap-error`, or null. */
  endSeq: number | null;
  /** Virtual-clock advance between trap and result (ms). 0 for
   *  non-sleep/cron traps; the virtual clock only moves on
   *  clock-advance events. */
  virtualDeltaMs: number;
  /** Wall duration (ms). The result event's `wallMs` field when
   * present (host-measured dispatch time); else the wallTs
   * difference trap → result when both events carry one; else null
   * (v1 journals, or a result that never arrived). Never invented. */
  wallMs: number | null;
  /** Adapter that answered the trap (trap-result's `adapter`), or
   * null when the journal does not say (v1 journals). */
  adapter: string | null;
  /** Worker that produced the answer (trap-result's `worker`), or
   * null — pool jobs only; canned/local answers carry none. */
  worker: string | null;
  /** Call site of this trap occurrence (the trap event's `site`,
   * BRA-73), or null when the journal does not carry one (direct
   * trap() callers, or journals written before BRA-73). Bundle
   * coordinates — translate with the run's pinned bundle + map. */
  site: TrapSite | null;
  /** Queue-wait (ms): trap-dispatch.wallTs − trap.wallTs (BRA-73 —
   * the dispatch event exists since BRA-75). Null when either
   * event lacks a wallTs, or when no dispatch event is in the
   * journal (a run written before BRA-75). */
  queueWaitMs: number | null;
  /** Execution (ms): trap-result.wallTs − trap-dispatch.wallTs,
   * using the LAST dispatch when the trap was re-dispatched (the
   * dispatch that produced the result). Null when either event
   * lacks a wallTs, or when there is no dispatch / no result. The
   * result event's `wallMs` (host-measured dispatch time) is the
   * cross-check for this number — the two measure the same span
   * from different clocks, so they agree within spawn/ingest
   * overhead, never exactly. */
  executionMs: number | null;
}

export interface ClockAdvance {
  journalRunId: string;
  seq: number;
  reason: string;
  from: string;
  to: string;
  deltaMs: number;
}

export interface ForkInfo {
  forkId: string;
  journalRunId: string;
  seq: number;
  kind: string;
  branches: number;
  childRuns: string[];
  joined: boolean;
  joinSeq: number | null;
}

export interface GateInfo {
  trapId: string;
  journalRunId: string;
  question: string | null;
  heldSeq: number | null;
  resultSeq: number | null;
  /** Hold duration (ms): result.wallTs − gate-held.wallTs when both
   * events carry one; else null (v1 journals, or a gate still held). */
  holdMs: number | null;
}

export interface TypeCounter {
  traps: number;
  results: number;
  errors: number;
}

export interface Profile {
  rootRunId: string;
  status: string;
  gatePending: boolean;
  totalEvents: number;
  journalCount: number;
  journals: { runId: string; events: number; parentForkId: string | null; branch: number | null }[];
  traps: TrapSpan[];
  totalTraps: number;
  trapResults: number;
  errorCount: number;
  unmatchedTraps: string[];
  byType: Record<string, TypeCounter>;
  forks: ForkInfo[];
  forkCount: number;
  joinCount: number;
  branchCount: number;
  gates: GateInfo[];
  clock: {
    advances: ClockAdvance[];
    totalVirtualMs: number;
    byReason: Record<string, { count: number; totalMs: number }>;
    virtualStart: string | null;
    virtualEnd: string | null;
  };
  lifecycle: string[];
  /** Total run wall time (ms): last.wallTs − first.wallTs over the
   * root journal when both carry one; else null (v1 journals). */
  totalWallMs: number | null;
  /** Run-start record (BRA-73): the fields the lifecycle-started
   * event carries, or null when the root journal has no
   * lifecycle-started event (v1 journals, or a journal written
   * before BRA-73). workflowHash is the extraction sourceHash —
   * the pointer into the extraction cache for the exact source
   * that ran. submitToStartMs is started.wallTs − submittedAt
   * when both are known, else null. */
  runStart: {
    workflowHash: string | null;
    workflowPath: string | null;
    submittedAt: string | null;
    bundlePath: string | null;
    bundleMapPath: string | null;
    submitToStartMs: number | null;
  } | null;
  /** The time-model caveat, rendered with every profile. */
  timeNote: string;
}

export const TIME_NOTE =
  "Time model (journal v2, BRA-57): every event carries wallTs, so wall durations " +
  "(per-trap time, total run wall time, gate hold time) are real where the events carry them — " +
  "a trap's wallMs is its result event's wallMs field, else the wallTs difference trap → result. " +
  "Older (v1) journals carry no wallTs and report wall durations as unknown, never invented — " +
  "the timeline axis is event order. Virtual time comes only from clock-advance events (from/to); " +
  "a sleep that advances the virtual clock 2h takes ~0ms of wall time and is shown on the virtual track only. " +
  "Since BRA-75 every dispatch carries a trap-dispatch event, so queue-wait is dispatch.wallTs − trap.wallTs " +
  "and execution is result.wallTs − dispatch.wallTs. Since BRA-73 a trap event may carry site " +
  "(bundle file:line:column — translate with the run's pinned bundle + source map) and the " +
  "lifecycle-started event may carry workflowHash (the extraction sourceHash), workflowPath, " +
  "submittedAt, and the bundle paths; missing fields report as unknown, never invented.";

/** Parse one JSONL journal file. Throws on a corrupt line. */
export function parseJournalText(text: string, sourceName: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e !== "object" || e === null || typeof e.event !== "string") {
        throw new Error(`line ${i + 1} in ${sourceName} is not a journal event`);
      }
      events.push(e);
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error(`corrupt journal line ${i + 1} in ${sourceName}: ${line.slice(0, 120)}`);
      throw err;
    }
  }
  return events;
}

function readJournalFile(file: string, runId: string): JournalFile {
  return { runId, file, events: parseJournalText(fs.readFileSync(file, "utf8"), file) };
}

/**
 * Load a run's journal tree from a state dir's journals/ directory.
 * Branch journals are siblings named `<root>_fork-<n>_branch-<m>.journal`
 * (the host writes run ids with "/" mapped to "_"). The `_fork-`
 * separator keeps `run-jfl-mock` from matching `run-jfl-mock-2`.
 */
export function loadJournalTree(journalsDir: string, rootRunId: string): JournalTree {
  const prefix = rootRunId.replace(/\//g, "_");
  const mainFile = path.join(journalsDir, `${prefix}.journal`);
  if (!fs.existsSync(mainFile)) {
    throw new Error(`no journal for ${rootRunId} in ${journalsDir} (looked for ${path.basename(mainFile)})`);
  }
  const journals: JournalFile[] = [readJournalFile(mainFile, rootRunId)];
  if (fs.existsSync(journalsDir)) {
    for (const f of fs.readdirSync(journalsDir).sort()) {
      if (!f.startsWith(`${prefix}_fork-`) || !f.endsWith(".journal")) continue;
      const runId = f.slice(0, -".journal".length).replace(/_/g, "/");
      journals.push(readJournalFile(path.join(journalsDir, f), runId));
    }
  }
  return orderTree({ rootRunId, journals });
}

/** Load from a single journal file path; siblings in the same dir are picked up. */
export function loadJournalTreeFromFile(file: string): JournalTree {
  const base = path.basename(file, ".journal");
  const rootRunId = base.replace(/_/g, "/");
  return loadJournalTree(path.dirname(file), rootRunId);
}

/** Order branch journals after the root, in fork/branch order. */
function orderTree(tree: JournalTree): JournalTree {
  const [root, ...rest] = tree.journals;
  rest.sort((a, b) => {
    const key = (r: string) => {
      const m = r.match(/\/fork-(\d+)\/branch-(\d+)$/);
      return m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, 0];
    };
    const [af, ab] = key(a.runId);
    const [bf, bb] = key(b.runId);
    return af - bf || ab - bb;
  });
  return { rootRunId: tree.rootRunId, journals: [root, ...rest] };
}

function shortId(id: string, rootRunId: string): string {
  return id.startsWith(rootRunId + "/") ? id.slice(rootRunId.length + 1) : id;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function oneLine(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** Human summary of a trap's arg: spec/cmd/question, not the whole blob. */
export function summarizeArg(type: string, arg: any): string {
  if (!arg || typeof arg !== "object") return oneLine(arg);
  if (typeof arg.spec === "string") return `spec=${arg.spec}`;
  if (typeof arg.cmd === "string") return `cmd=${arg.cmd} ${Array.isArray(arg.args) ? arg.args.join(" ") : ""}`.trim();
  if (typeof arg.question === "string") return `q=${trunc(arg.question, 120)}`;
  if (typeof arg.ms === "number") return `ms=${arg.ms}`;
  if (typeof arg.at === "string") return `at=${arg.at}`;
  return trunc(oneLine(arg), 120);
}

/** Human summary of a trap's result: the scalars that explain it. */
export function summarizeResult(type: string, result: any): string {
  if (result === null || result === undefined) return "";
  if (typeof result !== "object") return oneLine(result);
  const parts: string[] = [];
  if (type === "decide" && typeof result.choice === "string") {
    parts.push(`choice=${result.choice}`);
    if (typeof result.confidence === "number") parts.push(`conf=${result.confidence}`);
    return parts.join(" ");
  }
  if (typeof result.meanScore === "number") parts.push(`mean=${result.meanScore}`);
  else if (typeof result.mean === "number") parts.push(`mean=${result.mean}`);
  if (typeof result.approved === "number") parts.push(`approved=${result.approved}`);
  if (typeof result.failed === "number") parts.push(`failed=${result.failed}`);
  if (typeof result.score === "number") parts.push(`score=${result.score}`);
  if (typeof result.label === "string") parts.push(`label=${result.label}`);
  if (typeof result.loops === "number") parts.push(`loops=${result.loops}`);
  if (typeof result.converged === "boolean") parts.push(`converged=${result.converged}`);
  if (typeof result.reproduced === "boolean") parts.push(`reproduced=${result.reproduced}`);
  for (const k of ["found", "applied", "passed"]) {
    if (typeof result[k] === "boolean") parts.push(`${k}=${result[k]}`);
  }
  if (typeof result.ok === "boolean") parts.push(`ok=${result.ok}`);
  if (typeof result.exitCode === "number") parts.push(`exit=${result.exitCode}`);
  if (typeof result.sleptMs === "number") parts.push(`sleptMs=${result.sleptMs}`);
  if (typeof result.now === "string") parts.push(`now=${result.now}`);
  if (parts.length) return parts.join(" ");
  // Fall back to the most informative short scalar fields.
  if (typeof result.summary === "string") parts.push(trunc(result.summary, 100));
  for (const k of ["spec", "id", "file", "markdownPath", "scheduled"]) {
    if (typeof result[k] === "string") parts.push(`${k}=${trunc(result[k], 60)}`);
  }
  if (parts.length) return parts.join(" ");
  return trunc(oneLine(result), 120);
}

/** A trap-result counts as an error when it carries a non-empty error string or ok:false. */
export function resultErrorText(result: any): string | null {
  if (!result || typeof result !== "object") return null;
  if (typeof result.error === "string" && result.error.trim()) return result.error;
  if (result.ok === false) return "ok=false";
  return null;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Parse a journal event's wallTs (ISO string) to epoch ms, or null
 * when the event carries none / it does not parse (v1 journals). */
export function parseWallTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export function profileTree(tree: JournalTree): Profile {
  const rootRunId = tree.rootRunId;
  const byType: Record<string, TypeCounter> = {};
  const traps: TrapSpan[] = [];
  const forks: ForkInfo[] = [];
  const gates: GateInfo[] = [];
  const advances: ClockAdvance[] = [];
  const lifecycle: string[] = [];
  const unmatched: string[] = [];
  const journalMeta: Profile["journals"] = [];
  let totalEvents = 0;
  let trapResults = 0;
  let errorCount = 0;
  let joinCount = 0;
  let branchCount = 0;
  let gatePending = false;
  let status = "unknown";

  const bump = (type: string) => (byType[type] ??= { traps: 0, results: 0, errors: 0 });

  // BRA-73: the root journal's lifecycle-started event, when the
  // journal carries one (v2 since BRA-73). Branch journals carry
  // no started event of their own — the root's record is the run's.
  let runStart: Profile["runStart"] = null;

  for (const jf of tree.journals) {
    totalEvents += jf.events.length;
    let parentForkId: string | null = null;
    let branch: number | null = null;
    // Pre-scan (order-independent): results by trapId, clock-advances,
    // and gate-held events. A trap's clock-advance and its gate-held
    // event both come AFTER the trap event in the journal, so a
    // single in-order pass would miss them when the trap is processed.
    // BRA-73: trap-dispatch events likewise — first dispatch per
    // trapId (queue-wait starts there) and last dispatch (execution
    // ends at the result from the dispatch that produced it).
    const results = new Map<string, { seq: number; ev: JournalEvent }>();
    const dispatches = new Map<string, { firstWall: number | null; lastWall: number | null }>();
    const journalAdvances: { seq: number; deltaMs: number }[] = [];
    const journalGates = new Map<string, GateInfo>();
    for (const [seq, ev] of jf.events.entries()) {
      if ((ev.event === "trap-result" || ev.event === "trap-error") && typeof ev.trapId === "string" && !results.has(ev.trapId)) {
        results.set(ev.trapId, { seq, ev });
      }
      if (ev.event === "trap-dispatch" && typeof ev.trapId === "string") {
        const wall = parseWallTs(ev.wallTs);
        const d = dispatches.get(ev.trapId);
        if (!d) dispatches.set(ev.trapId, { firstWall: wall, lastWall: wall });
        else d.lastWall = wall;
      }
      if (ev.event === "lifecycle" && ev.lifecycle === "started" && jf.runId === rootRunId && runStart === null) {
        const startedWall = parseWallTs(ev.wallTs);
        const submittedWall = parseWallTs(ev.submittedAt);
        runStart = {
          workflowHash: typeof ev.workflowHash === "string" ? ev.workflowHash : null,
          workflowPath: typeof ev.workflowPath === "string" ? ev.workflowPath : null,
          submittedAt: typeof ev.submittedAt === "string" ? ev.submittedAt : null,
          bundlePath: typeof ev.bundlePath === "string" ? ev.bundlePath : null,
          bundleMapPath: typeof ev.bundleMapPath === "string" ? ev.bundleMapPath : null,
          submitToStartMs:
            startedWall !== null && submittedWall !== null ? Math.max(0, startedWall - submittedWall) : null,
        };
      }
      if (ev.event === "clock-advance" && typeof ev.from === "string" && typeof ev.to === "string") {
        const deltaMs = Date.parse(ev.to) - Date.parse(ev.from);
        const adv: ClockAdvance = {
          journalRunId: jf.runId,
          seq,
          reason: typeof ev.reason === "string" ? ev.reason : "?",
          from: ev.from,
          to: ev.to,
          deltaMs: Number.isFinite(deltaMs) ? deltaMs : 0,
        };
        advances.push(adv);
        journalAdvances.push(adv);
      }
      if (ev.event === "gate-held" && typeof ev.trapId === "string" && !journalGates.has(ev.trapId)) {
        const g: GateInfo = {
          trapId: ev.trapId,
          journalRunId: jf.runId,
          question: typeof ev.question === "string" ? ev.question : null,
          heldSeq: seq,
          resultSeq: null,
          holdMs: null,
        };
        journalGates.set(ev.trapId, g);
        gates.push(g);
      }
    }
    for (const [seq, ev] of jf.events.entries()) {
      if (ev.event === "branch-start") {
        parentForkId = typeof ev.parentForkId === "string" ? ev.parentForkId : null;
        branch = typeof ev.branch === "number" ? ev.branch : null;
        branchCount++;
      }
      if (ev.event === "lifecycle" && typeof ev.lifecycle === "string") {
        if (jf.runId === rootRunId) {
          lifecycle.push(ev.lifecycle);
          if (ev.lifecycle === "completed" || ev.lifecycle === "failed") status = ev.lifecycle;
          else if (status === "unknown" && ev.lifecycle === "started") status = "started";
        }
      }
      if (ev.event === "fork" && typeof ev.forkId === "string") {
        forks.push({
          forkId: ev.forkId,
          journalRunId: jf.runId,
          seq,
          kind: typeof ev.kind === "string" ? ev.kind : "?",
          branches: typeof ev.branches === "number" ? ev.branches : 0,
          childRuns: Array.isArray(ev.childRuns) ? ev.childRuns.map(String) : [],
          joined: false,
          joinSeq: null,
        });
      }
      if (ev.event === "join" && typeof ev.forkId === "string") {
        joinCount++;
        const f = forks.find((x) => x.forkId === ev.forkId);
        if (f) {
          f.joined = true;
          f.joinSeq = seq;
        }
      }
      if (ev.event === "trap" && typeof ev.trapId === "string") {
        const type = typeof ev.type === "string" ? ev.type : "?";
        bump(type).traps++;
        const res = results.get(ev.trapId);
        let resultKind: TrapSpan["resultKind"] = "pending";
        let resultSummary = "— no result in journal —";
        let errorText: string | null = null;
        let endSeq: number | null = null;
        let wallMs: number | null = null;
        let worker: string | null = null;
        let adapter: string | null = null;
        if (res) {
          endSeq = res.seq;
          // BRA-57: wallMs prefers the result event's measured
          // `wallMs` field (host-measured dispatch time); the wallTs
          // difference is the fallback; missing both stays null.
          if (typeof res.ev.wallMs === "number" && Number.isFinite(res.ev.wallMs) && res.ev.wallMs >= 0) {
            wallMs = res.ev.wallMs;
          } else {
            const trapWall = parseWallTs(ev.wallTs);
            const resWall = parseWallTs(res.ev.wallTs);
            if (trapWall !== null && resWall !== null) wallMs = Math.max(0, resWall - trapWall);
          }
          if (typeof res.ev.worker === "string" && res.ev.worker) worker = res.ev.worker;
          if (typeof res.ev.adapter === "string" && res.ev.adapter) adapter = res.ev.adapter;
          trapResults++;
          bump(type).results++;
          if (res.ev.event === "trap-error") {
            resultKind = "error";
            errorText = oneLine(res.ev.error ?? res.ev.result ?? "trap-error");
            resultSummary = `ERROR: ${trunc(errorText, 160)}`;
            errorCount++;
            bump(type).errors++;
          } else {
            errorText = resultErrorText(res.ev.result);
            if (errorText) {
              resultKind = "error";
              resultSummary = `ERROR: ${trunc(errorText, 160)}`;
              errorCount++;
              bump(type).errors++;
            } else {
              resultKind = "result";
              resultSummary = summarizeResult(type, res.ev.result);
            }
          }
          const gate = gates.find((g) => g.trapId === ev.trapId);
          if (gate) {
            gate.resultSeq = endSeq;
            // BRA-57: holdMs is result.wallTs − gate-held.wallTs —
            // the wall time the gate sat held, not the trap's
            // dispatch wallMs (which is only its final ~0ms dispatch).
            if (gate.heldSeq !== null) {
              const heldWall = parseWallTs(jf.events[gate.heldSeq]?.wallTs);
              const resWall = parseWallTs(res.ev.wallTs);
              if (heldWall !== null && resWall !== null) gate.holdMs = Math.max(0, resWall - heldWall);
            }
          }
        } else {
          unmatched.push(ev.trapId);
        }
        // Virtual delta: clock-advances strictly between trap and result.
        let virtualDeltaMs = 0;
        if (endSeq !== null) {
          for (const a of journalAdvances) {
            if (a.seq > seq && a.seq < endSeq) virtualDeltaMs += a.deltaMs;
          }
        }
        // BRA-73: the trap event's own site (bundle coordinates),
        // and the queue-wait / execution split from the dispatch
        // event(s). A malformed site value is treated as absent —
        // the profiler never invents a call site.
        let site: TrapSite | null = null;
        const rawSite = (ev as JournalEvent).site;
        if (
          rawSite !== null &&
          typeof rawSite === "object" &&
          typeof rawSite.file === "string" &&
          typeof rawSite.line === "number" &&
          Number.isFinite(rawSite.line) &&
          typeof rawSite.column === "number" &&
          Number.isFinite(rawSite.column)
        ) {
          site = { file: rawSite.file, line: rawSite.line, column: rawSite.column };
        }
        let queueWaitMs: number | null = null;
        let executionMs: number | null = null;
        const disp = dispatches.get(ev.trapId);
        if (disp) {
          const trapWall = parseWallTs(ev.wallTs);
          if (trapWall !== null && disp.firstWall !== null) {
            queueWaitMs = Math.max(0, disp.firstWall - trapWall);
          }
          if (res) {
            const resWall = parseWallTs(res.ev.wallTs);
            if (resWall !== null && disp.lastWall !== null) {
              executionMs = Math.max(0, resWall - disp.lastWall);
            }
          }
        }
        traps.push({
          journalRunId: jf.runId,
          trapId: ev.trapId,
          ordinal: typeof ev.ordinal === "number" ? ev.ordinal : null,
          type,
          argSummary: summarizeArg(type, ev.arg),
          resultKind,
          resultSummary,
          errorText,
          startSeq: seq,
          endSeq,
          virtualDeltaMs,
          wallMs,
          adapter,
          worker,
          site,
          queueWaitMs,
          executionMs,
        });
      }
    }
    journalMeta.push({ runId: jf.runId, events: jf.events.length, parentForkId, branch });
  }

  // A gate is pending when its trap has a gate-held event but no result yet.
  gatePending = gates.some((g) => g.resultSeq === null);
  if (gatePending && status !== "completed" && status !== "failed") status = "suspended-at-gate";

  const byReason: Record<string, { count: number; totalMs: number }> = {};
  let totalVirtualMs = 0;
  for (const a of advances) {
    totalVirtualMs += a.deltaMs;
    const r = (byReason[a.reason] ??= { count: 0, totalMs: 0 });
    r.count++;
    r.totalMs += a.deltaMs;
  }

  // BRA-57: total run wall time is last.wallTs − first.wallTs over
  // the ROOT journal when both carry one; else null (v1 journals).
  let totalWallMs: number | null = null;
  {
    const rootEvents = tree.journals[0]?.events ?? [];
    const firstWall = rootEvents.length ? parseWallTs(rootEvents[0].wallTs) : null;
    const lastWall = rootEvents.length ? parseWallTs(rootEvents[rootEvents.length - 1].wallTs) : null;
    if (firstWall !== null && lastWall !== null) totalWallMs = Math.max(0, lastWall - firstWall);
  }

  return {
    rootRunId,
    status,
    gatePending,
    totalEvents,
    journalCount: tree.journals.length,
    journals: journalMeta,
    traps,
    totalTraps: traps.length,
    trapResults,
    errorCount,
    unmatchedTraps: unmatched,
    byType,
    forks,
    forkCount: forks.length,
    joinCount,
    branchCount,
    gates,
    clock: {
      advances,
      totalVirtualMs,
      byReason,
      virtualStart: advances.length ? advances[0].from : null,
      virtualEnd: advances.length ? advances[advances.length - 1].to : null,
    },
    lifecycle,
    totalWallMs,
    runStart,
    timeNote: TIME_NOTE,
  };
}

/** Collapse "suspended → resumed" pairs in a lifecycle sequence so a
 *  50-event run reads as `started → (suspend/resume ×24) → completed`. */
export function compressLifecycle(lifecycle: string[]): string {
  if (!lifecycle.length) return "—";
  const tokens: string[] = [];
  let i = 0;
  while (i < lifecycle.length) {
    if (lifecycle[i] === "suspended" && lifecycle[i + 1] === "resumed") {
      let n = 0;
      while (lifecycle[i] === "suspended" && lifecycle[i + 1] === "resumed") {
        n++;
        i += 2;
      }
      tokens.push(n === 1 ? "suspended → resumed" : `(suspend/resume ×${n})`);
    } else {
      tokens.push(lifecycle[i]);
      i++;
    }
  }
  return tokens.join(" → ");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One text line per trap, for the counters section. */
function trapLine(p: Profile, t: TrapSpan): string {
  const span = t.endSeq !== null ? `#${t.startSeq}→#${t.endSeq}` : `#${t.startSeq}→?`;
  const v = t.virtualDeltaMs ? ` virtual +${formatMs(t.virtualDeltaMs)}` : "";
  const w = t.wallMs !== null ? ` (wall: ${formatMs(t.wallMs)})` : " (wall: unknown)";
  const who = [t.adapter ? `adapter=${t.adapter}` : "", t.worker ? `worker=${t.worker}` : ""].filter(Boolean).join(" ");
  const site = t.site ? ` site=${t.site.file}:${t.site.line}:${t.site.column}` : "";
  const split =
    t.queueWaitMs !== null || t.executionMs !== null
      ? ` [queue: ${t.queueWaitMs !== null ? formatMs(t.queueWaitMs) : "?"} exec: ${t.executionMs !== null ? formatMs(t.executionMs) : "?"}]`
      : "";
  const mark = t.resultKind === "error" ? "ERROR " : t.resultKind === "pending" ? "PENDING " : "";
  return `  [${span}] ${t.type} ${shortId(t.trapId, p.rootRunId)} ${mark}${t.argSummary} => ${t.resultSummary}${v}${w}${who ? ` [${who}]` : ""}${site}${split}`;
}

export function renderText(p: Profile): string {
  const L: string[] = [];
  L.push(`profile: ${p.rootRunId}`);
  L.push(`status: ${p.status}${p.gatePending ? " (gate pending)" : ""}`);
  L.push(`events: ${p.totalEvents} across ${p.journalCount} journal(s)`);
  L.push(`lifecycle: ${compressLifecycle(p.lifecycle)}`);
  if (p.runStart) {
    const r = p.runStart;
    L.push(
      `run: workflowHash=${r.workflowHash ?? "unknown"} workflow=${r.workflowPath ?? "unknown"} submittedAt=${r.submittedAt ?? "unknown"}${r.submitToStartMs !== null ? ` submit→start ${formatMs(r.submitToStartMs)}` : ""}`,
    );
    if (r.bundlePath) L.push(`bundle: ${r.bundlePath}${r.bundleMapPath ? ` (map: ${r.bundleMapPath})` : " (no source map)"}`);
  }
  L.push("");
  L.push("counters:");
  L.push(`  traps: ${p.totalTraps}  results: ${p.trapResults}  errors: ${p.errorCount}  unmatched (no result): ${p.unmatchedTraps.length}`);
  for (const [type, c] of Object.entries(p.byType).sort()) {
    L.push(`  ${type}: ${c.traps} trap(s), ${c.results} result(s), ${c.errors} error(s)`);
  }
  L.push(`  forks: ${p.forkCount}  joins: ${p.joinCount}  branches: ${p.branchCount}`);
  const knownHolds = p.gates.filter((g) => g.holdMs !== null);
  L.push(
    knownHolds.length === p.gates.length && p.gates.length > 0
      ? `  gates: ${p.gates.length} held event(s); hold ${knownHolds.map((g) => formatMs(g.holdMs!)).join(", ")}`
      : `  gates: ${p.gates.length} held event(s); hold duration unknown (no timestamps)`,
  );
  L.push(`  clock-advances: ${p.clock.advances.length} (virtual +${formatMs(p.clock.totalVirtualMs)} total)`);
  for (const [reason, r] of Object.entries(p.clock.byReason).sort()) {
    L.push(`    ${reason}: ${r.count} advance(s), +${formatMs(r.totalMs)} virtual`);
  }
  L.push(
    p.totalWallMs !== null
      ? `  wall time: ${formatMs(p.totalWallMs)} total (first→last event)`
      : `  wall time: UNKNOWN — per-trap wall time, total run wall time, and gate hold time are not in the journal`,
  );
  L.push("");
  L.push(p.timeNote);
  L.push("");
  L.push(
    p.totalWallMs !== null || p.traps.some((t) => t.wallMs !== null)
      ? "timeline (event order — sequence # within each journal; wall durations in ms where known):"
      : "timeline (event order — sequence # within each journal; wall durations unknown):",
  );
  return L.join("\n");
}

/** Hold text for a gate-held timeline row: the measured hold when
 * the profiler knows it, else the old unknown wording. */
function gateHeldHold(p: Profile, trapId: string): string {
  const g = p.gates.find((x) => x.trapId === trapId);
  return g?.holdMs !== null && g?.holdMs !== undefined ? `held ${formatMs(g.holdMs)}` : "hold duration unknown";
}

/** Full text timeline — needs the tree, not just the profile. */
export function renderTreeText(tree: JournalTree, p: Profile): string {
  const L: string[] = [renderText(p)];
  const trapById = new Map(p.traps.map((t) => [t.trapId, t]));
  const forkById = new Map(p.forks.map((f) => [f.forkId, f]));
  const branchByRun = new Map(tree.journals.map((j) => [j.runId, j]));
  // Virtual clock carried through the root journal only (branches
  // journal no advances; their virtual time is their fork's).
  const renderedBranches = new Set<string>();

  const renderJournalRows = (jf: JournalFile, depth: number, virtualAtFork: string | null): void => {
    const pad = "  ".repeat(depth);
    let vNow = virtualAtFork;
    for (const [seq, ev] of jf.events.entries()) {
      const v = vNow ? ` [v:${vNow}]` : "";
      switch (ev.event) {
        case "lifecycle":
          L.push(`${pad}#${seq} lifecycle: ${ev.lifecycle}${v}`);
          break;
        case "trap": {
          const t = trapById.get(ev.trapId);
          L.push(`${pad}${t ? trapLine(p, t) : `#${seq} trap ${ev.type ?? "?"} ${shortId(ev.trapId ?? "?", p.rootRunId)}`}${v}`);
          break;
        }
        case "trap-result":
        case "trap-error":
          // Already folded into the trap line; skip to keep the
          // timeline scannable (counts still cover them).
          break;
        case "fork": {
          const f = forkById.get(ev.forkId);
          L.push(`${pad}#${seq} FORK ${shortId(ev.forkId, p.rootRunId)} kind=${f?.kind ?? ev.kind} branches=${f?.branches ?? ev.branches} children=${(f?.childRuns ?? []).map((c) => shortId(c, p.rootRunId)).join(", ")}${v}`);
          for (const child of f?.childRuns ?? []) {
            const bj = branchByRun.get(child);
            if (!bj || renderedBranches.has(child)) continue;
            renderedBranches.add(child);
            L.push(`${pad}  branch ${shortId(child, p.rootRunId)}:`);
            renderJournalRows(bj, depth + 2, vNow);
          }
          break;
        }
        case "join":
          L.push(`${pad}#${seq} JOIN ${shortId(ev.forkId, p.rootRunId)}${v}`);
          break;
        case "branch-start":
          L.push(`${pad}#${seq} branch-start parent=${shortId(ev.parentForkId ?? "?", p.rootRunId)} branch=${ev.branch}${v}`);
          break;
        case "branch-done":
          L.push(`${pad}#${seq} branch-done branch=${ev.branch}${v}`);
          break;
        case "clock-advance": {
          const to = typeof ev.to === "string" ? ev.to : "?";
          const from = typeof ev.from === "string" ? ev.from : "?";
          const d = Date.parse(to) - Date.parse(from);
          L.push(`${pad}#${seq} CLOCK-ADVANCE ${ev.reason ?? "?"}: ${from} → ${to} (+${Number.isFinite(d) ? formatMs(d) : "?"}) virtual — 0ms wall`);
          vNow = to;
          break;
        }
        case "gate-held":
          L.push(`${pad}#${seq} GATE-HELD ${shortId(ev.trapId ?? "?", p.rootRunId)} q=${trunc(oneLine(ev.question ?? ""), 100)} (${gateHeldHold(p, ev.trapId ?? "")})${v}`);
          break;
        case "validation-error":
          L.push(`${pad}#${seq} VALIDATION-ERROR ${trunc(oneLine(ev), 160)}${v}`);
          break;
        case "cancel":
          L.push(`${pad}#${seq} CANCEL ${trunc(oneLine(ev), 160)}${v}`);
          break;
        default:
          L.push(`${pad}#${seq} ${ev.event} ${trunc(oneLine(ev), 140)}${v}`);
      }
    }
  };

  renderJournalRows(tree.journals[0], 0, null);
  // Any branch journal not reached from a fork (orphan) still renders.
  for (const jf of tree.journals.slice(1)) {
    if (renderedBranches.has(jf.runId)) continue;
    L.push(`orphan branch journal ${jf.runId} (no fork event references it):`);
    renderJournalRows(jf, 1, null);
  }
  return L.join("\n") + "\n";
}

export function renderTreeHtml(tree: JournalTree, p: Profile): string {
  const text = renderTreeText(tree, p);
  const rows = text.split("\n").map((line) => {
    let cls = "row";
    if (/ERROR/.test(line)) cls += " err";
    if (/FORK/.test(line)) cls += " fork";
    if (/JOIN/.test(line)) cls += " join";
    if (/CLOCK-ADVANCE/.test(line)) cls += " clock";
    if (/GATE-HELD/.test(line)) cls += " gate";
    if (/^counters:/.test(line) || /^timeline/.test(line) || /^time model:/.test(line)) cls += " head";
    return `<div class="${cls}">${esc(line) || "&nbsp;"}</div>`;
  });
  const counterRows = Object.entries(p.byType)
    .sort()
    .map(([t, c]) => `<tr><td>${esc(t)}</td><td>${c.traps}</td><td>${c.results}</td><td>${c.errors}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>profile: ${esc(p.rootRunId)}</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;margin:24px;max-width:1100px;color:#1a1a1a}
h1{font-size:18px}h2{font-size:15px;margin-top:24px}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px;text-align:left}
.row{white-space:pre-wrap}.head{font-weight:700;margin-top:8px}
.err{color:#a00}.fork{color:#0645ad}.join{color:#0645ad}.clock{color:#5a3d00}.gate{color:#7a007a}
.note{background:#fff8e1;border:1px solid #e6c200;padding:8px 12px}
</style></head><body>
<h1>profile: ${esc(p.rootRunId)}</h1>
<p>status: <b>${esc(p.status)}</b> &nbsp; events: ${p.totalEvents} across ${p.journalCount} journal(s) &nbsp; traps: ${p.totalTraps} &nbsp; results: ${p.trapResults} &nbsp; errors: ${p.errorCount}</p>
<p>forks: ${p.forkCount} &nbsp; joins: ${p.joinCount} &nbsp; branches: ${p.branchCount} &nbsp; gates held: ${p.gates.length} &nbsp; clock-advances: ${p.clock.advances.length} (virtual +${esc(formatMs(p.clock.totalVirtualMs))})</p>
<p class="note">${esc(p.timeNote)}</p>
<h2>counters by trap type</h2>
<table><tr><th>type</th><th>traps</th><th>results</th><th>errors</th></tr>
${counterRows}</table>
<h2>timeline (event order${p.totalWallMs !== null || p.traps.some((t) => t.wallMs !== null) ? "; wall durations in ms where known" : "; wall durations unknown"})</h2>
${rows.join("\n")}
</body></html>
`;
}
