// corruption — shared corrupt-state helpers (BRA-77 queue/journal,
// BRA-76 worker store, BRA-84 run registry).
//
// One way of doing a thing: the Host (queue.json, journals, run
// entries) and the WorkerServer (worker-jobs/store.json) both persist
// JSON state that must survive a crash mid-write and a corrupt file
// on disk, so they share the atomic write, the corruption record
// shape, and the durable corruption log instead of each growing a
// parallel mechanism. The log is stateDir/corruption.log (append-only
// JSONL, deduped by kind+file+lineNo+excerpt) — one file for the
// whole state dir, whatever subsystem found the corruption.
import * as fs from "node:fs";

/** One quarantined corrupt-state record. Journal lines: a line that
 * fails to parse, or parses to a value that is not a journal event
 * (not a plain object, or an object without a string `event`), is
 * skipped on load and recorded here — the Host starts with the good
 * lines intact. Queue / worker store / run entry: a corrupt file
 * recovered from its backup is recorded here too, and a corrupt run
 * entry with no usable backup is recorded here (the run is dropped
 * from the registry but the Host still starts — see host.ts,
 * loadRunEntriesFromDisk). `excerpt` is the first 120 chars
 * of the bad line (journal) or the parse failure (queue/store/run
 * entry). */
export interface CorruptionRecord {
  kind: "journal-line" | "queue-recovered" | "worker-store-recovered" | "run-entry-recovered" | "run-entry-corrupt";
  /** Basename of the file the corruption is in. */
  file: string;
  /** 1-based journal line number; 0 for queue/store records. */
  lineNo: number;
  runId?: string;
  reason: string;
  excerpt: string;
  at: string;
}

/** Dedupe key for a corruption record (kind+file+lineNo+excerpt). */
export function corruptionKey(rec: CorruptionRecord): string {
  return `${rec.kind}|${rec.file}|${rec.lineNo}|${rec.excerpt}`;
}

/** Atomic file write: tmp file in the same directory + rename, the
 * same pattern as the driver-lock heartbeat. A crash mid-write
 * leaves the target either old or new, never torn; a stray tmp file
 * is never read. The tmp name is pid-suffixed so two processes
 * writing the same target cannot clobber each other's tmp file. */
export function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

/** Append-only durable corruption log (stateDir/corruption.log).
 * `append` writes one JSONL record (with its dedupe key) unless a
 * record with the same key is already in the file — a quarantined
 * line stays in its journal file, so every new process re-finds it,
 * and the log must not grow on every load. Best-effort: a failure
 * to read or write the log never throws (the in-memory report is
 * the fallback). Returns true when a line was appended. */
export class CorruptionLog {
  constructor(private logPath: string) {}

  append(rec: CorruptionRecord): boolean {
    const key = corruptionKey(rec);
    try {
      const p = this.logPath;
      if (fs.existsSync(p)) {
        // Compare parsed `key` fields, not a substring match: the
        // stored key is JSON-escaped, so a raw substring check would
        // miss keys whose excerpt holds a quote or backslash and
        // re-log the same corruption on every load.
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            if ((JSON.parse(line) as { key?: unknown }).key === key) return false;
          } catch {
            /* a corrupt log line is ignored — the log is best-effort */
          }
        }
      }
      fs.appendFileSync(p, JSON.stringify({ ...rec, key }) + "\n");
      return true;
    } catch {
      /* the durable log is best-effort; the in-memory report stands */
      return false;
    }
  }
}
