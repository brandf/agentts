// direct-adapter — the direct/coordinator adapter (BRA-44, v0).
// Implementation — the loadable seam is ./adapter.ts.
//
// The v0 "real" adapter: the coordinator executes traps directly,
// i.e. the host's own agent session does the work — there is no
// worker pool yet (BRA-48/49). Concretely:
//  - job: spawn a real worker PROCESS (Bun) running the registered
//    worker script for the jobspec, synchronously (spawnSync, with a
//    timeout). The worker is a separate process doing genuine work
//    over the actual input — not a canned answer. Registry: spec ->
//    worker script path; default workers live in
//    apps/agentts/workflows/library/worker.ts (judge/fix/aggregate/
//    rubric-update for JudgeFixLoop). An unregistered spec is a loud
//    error, never a canned default.
//  - exec: run the command for real (spawnSync, in the given cwd or
//    the host cwd). No sandboxing beyond the process boundary in v0 —
//    the command runs as the host user; workflows are authored by
//    trusted agents. (A sandbox is BRA-48 scope.)
//  - gate: ALWAYS hold. A gate is a human decision; the direct
//    adapter never auto-answers it. The run suspends until the human
//    delivers an answer (CLI deliver-gate / this chat).
//  - decide: the local decision model (decision-model.ts) —
//    cheap/fast/narrow, computed from the question content.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOLD, type Adapter, type TrapAnswer, type TrapContext } from "../../../src/adapter";
import { decideLocal } from "../../../src/decision-model";

export interface DirectAdapterConfig {
  /** spec -> worker script path. Defaults to the bundled
   * workflows/library/worker.ts for the JudgeFixLoop specs. */
  workers?: Record<string, string>;
  /** Worker timeout in ms (default 120_000). */
  workerTimeoutMs?: number;
  /** Working directory for exec traps without an explicit cwd. */
  cwd?: string;
}

const DEFAULT_WORKER = path.resolve(import.meta.dir, "..", "..", "..", "workflows", "library", "worker.ts");
const DEFAULT_BUGFIX_WORKER = path.resolve(import.meta.dir, "..", "..", "..", "workflows", "dogfood", "bugfix-worker.ts");

/** BRA-179: a job payload is passed to the worker script as argv[2]
 * of the spawn, and Linux caps any single argv string at 128KB
 * (MAX_ARG_STRLEN = 131072 bytes). Payloads at or above this many
 * bytes go through a scratch file instead (marker
 * `agentts-file:<path>`, read by the worker script) — 64KB is half
 * the cap, leaving margin for argv overhead, and far above any
 * payload a normal job carries. Measured in bytes, not characters:
 * multi-byte UTF-8 counts against the cap. (Same threshold + marker
 * as RESULT_ARG_INLINE_MAX_BYTES / RESULT_ARG_FILE_PREFIX in
 * src/host.ts — BRA-171, the output side of this same argv
 * boundary; keep the two in sync, per the BRA-88 verbatim-copy
 * rule.) */
const JOB_ARG_INLINE_MAX_BYTES = 64 * 1024;
/** Marker prefix for a file-backed job payload (BRA-179). It starts
 * with `a`, which no JSON document starts with — the marker can
 * never collide with an inline payload. */
const JOB_ARG_FILE_PREFIX = "agentts-file:";

export class DirectAdapter implements Adapter {
  readonly name = "direct";
  private workers: Record<string, string>;
  private workerTimeoutMs: number;
  private cwd: string;

  constructor(config: DirectAdapterConfig = {}) {
    this.workers = {
      judge: DEFAULT_WORKER,
      fix: DEFAULT_WORKER,
      aggregate: DEFAULT_WORKER,
      "rubric-update": DEFAULT_WORKER,
      // Bug-fix workflow (Phase 2, BRA-54): the bugfix worker runs
      // reproduce/diagnose/fix/test/verify as real processes with
      // fs + exec access. Registered by default so the CLI direct
      // path can run the bug-fix workflow without extra config.
      "bugfix-reproduce": DEFAULT_BUGFIX_WORKER,
      "bugfix-diagnose": DEFAULT_BUGFIX_WORKER,
      "bugfix-fix": DEFAULT_BUGFIX_WORKER,
      "bugfix-test": DEFAULT_BUGFIX_WORKER,
      "bugfix-verify": DEFAULT_BUGFIX_WORKER,
      // Improve-loop workflow (standard library): the same worker
      // script serves the improve-* specs (genuine computation over
      // the actual item + rubric — see workflows/library/worker.ts).
      "improve-judge": DEFAULT_WORKER,
      "improve-aggregate": DEFAULT_WORKER,
      "improve-decide": DEFAULT_WORKER,
      "improve-fix": DEFAULT_WORKER,
      "improve-write": DEFAULT_WORKER,
      // Presentations workflow (BRA-109): the same worker script
      // serves the slides-* specs (deck build + render).
      "slides-create": DEFAULT_WORKER,
      "slides-render": DEFAULT_WORKER,
      // Plan-driven-work template (BRA-117): the same worker script
      // serves the plan-* specs (plan draft + phase execution).
      "plan-draft": DEFAULT_WORKER,
      "plan-phase": DEFAULT_WORKER,
      ...(config.workers ?? {}),
    };
    // Suite-running workers need longer than the old 120s default:
    // staged run.sh takes ~70s on its own (reference + mock + host
    // suites + swap test). 600s leaves headroom without delaying
    // anything (a timeout is a ceiling, not a wait).
    this.workerTimeoutMs = config.workerTimeoutMs ?? 600_000;
    this.cwd = config.cwd ?? process.cwd();
  }

  /** Register (or override) the worker script for a jobspec. */
  registerWorker(spec: string, scriptPath: string): void {
    this.workers[spec] = scriptPath;
  }

  /** The worker script this adapter would spawn for a jobspec, or
   * null when none is registered. The host reads it (BRA-89) to
   * pin the run's trap code at submit: a mid-run edit of a worker
   * script must not silently change an in-flight run's answers. */
  workerPathFor(spec: string): string | null {
    return this.workers[spec] ?? null;
  }

  /**
   * BRA-179: argv-safe form of a job payload JSON string for the
   * worker-script spawn. Small payloads go inline, exactly as
   * before. A payload at or above JOB_ARG_INLINE_MAX_BYTES is
   * written to a scratch file under os.tmpdir() (one file per spawn,
   * random suffix — spawns for one run are sequential, but a crash
   * mid-spawn must never collide with the retry's file) and argv[2]
   * becomes `agentts-file:<path>`, which the worker script reads.
   * The caller MUST invoke the returned cleanup after the spawn —
   * it unlinks the file when one was written (a no-op for the
   * inline form), so a dispatched job never litters the temp dir.
   * (The pool worker-loop has the same helper for its own spawn
   * site — plugins/muse/worker-loop.ts — keep the two in sync, per
   * the BRA-88 verbatim-copy rule.)
   */
  private jobPayloadArg(payload: string): { arg: string; cleanup: () => void } {
    if (Buffer.byteLength(payload, "utf8") < JOB_ARG_INLINE_MAX_BYTES) {
      return { arg: payload, cleanup: () => {} };
    }
    const filePath = path.join(os.tmpdir(), `.agentts-job-payload-${crypto.randomUUID()}.json`);
    fs.writeFileSync(filePath, payload, "utf8");
    return {
      arg: `${JOB_ARG_FILE_PREFIX}${filePath}`,
      cleanup: () => {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* already gone — the worker consumed it or the spawn failed before reading */
        }
      },
    };
  }

  private runJob(spec: string, input: unknown, ctx: TrapContext): TrapAnswer {
    const script = this.workers[spec];
    if (!script) {
      throw new Error(
        `direct adapter: no worker registered for jobspec "${spec}" (trap ${ctx.trapId}) — register one with registerWorker or add it to the default workers; an unregistered job never gets a canned answer`,
      );
    }
    if (!fs.existsSync(script)) {
      throw new Error(`direct adapter: worker script not found for jobspec "${spec}": ${script}`);
    }
    const { arg, cleanup } = this.jobPayloadArg(JSON.stringify({ spec, input }));
    let r: SpawnSyncReturns<string>;
    try {
      r = spawnSync(
        "/opt/hatch-image/bin/bun",
        [script, arg],
        { encoding: "utf8", timeout: this.workerTimeoutMs, cwd: this.cwd },
      );
    } finally {
      cleanup();
    }
    if (r.error) {
      throw new Error(`direct adapter: worker for "${spec}" failed to spawn: ${String(r.error)}`);
    }
    if (r.status !== 0) {
      const err = (r.stderr ?? "").trim() || `worker exited ${r.status}`;
      throw new Error(`direct adapter: worker for "${spec}" exited ${r.status}: ${err.slice(0, 500)}`);
    }
    const out = (r.stdout ?? "").trim();
    if (!out) throw new Error(`direct adapter: worker for "${spec}" printed nothing`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.split("\n").pop()!);
    } catch {
      throw new Error(`direct adapter: worker for "${spec}" did not print JSON: ${out.slice(0, 200)}`);
    }
    return { value: parsed };
  }

  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD {
    switch (type) {
      case "job": {
        const spec = arg?.spec;
        if (typeof spec !== "string") {
          throw new Error(
            `direct adapter: job trap ${ctx.trapId} has no string spec — the direct adapter routes jobs by spec`,
          );
        }
        return this.runJob(spec, arg?.input ?? null, ctx);
      }
      case "exec": {
        const cmd: string = arg?.cmd;
        if (typeof cmd !== "string" || !cmd) {
          throw new Error(`direct adapter: exec trap ${ctx.trapId} has no cmd`);
        }
        const args: string[] = Array.isArray(arg?.args) ? arg.args : [];
        const cwd = typeof arg?.cwd === "string" ? arg.cwd : this.cwd;
        const r = spawnSync(cmd, args, { encoding: "utf8", cwd, shell: false });
        if (r.error) {
          return { value: { stdout: "", stderr: String(r.error), exitCode: 1 } };
        }
        return {
          value: {
            stdout: r.stdout ?? "",
            stderr: r.stderr ?? "",
            exitCode: r.status ?? 1,
          },
        };
      }
      case "gate":
        return HOLD;
      case "decide": {
        const question = typeof arg?.question === "string" ? arg.question : "";
        const options = Array.isArray(arg?.options) ? arg.options : undefined;
        return { value: decideLocal(question, options) };
      }
      default:
        throw new Error(`direct adapter: unknown trap type "${type}" (trap ${ctx.trapId})`);
    }
  }
}
