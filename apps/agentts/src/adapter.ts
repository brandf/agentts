// adapter — the Layer 3 environment-adapter seam (BRA-44).
//
// The host (Layer 2) owns trap interpretation: JSON-clean check,
// schema validation, repair loop, fork/join, journal, registry. It
// does NOT execute traps itself — it asks the adapter. The adapter is
// the ONLY layer that knows about an environment (mock canned answers,
// the coordinator's direct execution, Muse later, Claude Code later).
// Swapping the adapter must not touch core, host, scheduler, or
// workflows — the swap test proves that boundary for the mock adapter.
//
// The adapter answers four trap types. sleep / cron / clock are NOT
// adapter calls: the clock is host-owned (virtual in tests, real wall
// time in production), so the host answers those itself and journals
// the clock-advance. A gate answer of HOLD means "held open until a
// human answers" — the host suspends the run and waits for
// deliverGate; the adapter never blocks on a human.
//
// Adapters are loaded from apps/agentts/plugins/<name>/src/adapter.ts
// (see host.loadAdapter) or from the host's built-ins in
// src/adapters/ (mock, direct). "mock" loads from the plugin dir
// (plugins/mock/src/adapter.ts, BRA-53); the Host constructor's
// default adapter is the same MockAdapter class, kept as the
// fallback when no adapter is configured at all.

export const HOLD = Symbol("adapter-hold");

/** What an adapter returns for one trap: resume with a value, or
 * throw at the call site. The optional provenance is host-side
 * only — only `value`/`throw` cross into the engine (BRA-57):
 * `worker` names the worker (id/process) that produced the answer
 * when the adapter can name one (the pool's worker id for muse
 * jobs; absent for canned/local answers, where the adapter name
 * is the identity), `tokens` the tokens consumed when known
 * (no adapter reports tokens today — the field exists so the
 * journal can carry them when one does). The host journals both
 * on the trap-result/trap-error event. */
export type TrapAnswer =
  | { value: unknown; worker?: string; tokens?: number }
  | { throw: unknown; worker?: string; tokens?: number };

/** What the host passes to the adapter for one trap. */
export interface TrapContext {
  runId: string;
  trapId: string;
  /** The trap's ordinal within the run (0-based). */
  ordinal: number;
}

export interface Adapter {
  /** Stable name, e.g. "mock", "direct". Journaled on first use. */
  readonly name: string;
  /**
   * Answer one trap. Return { value } to resume with a value,
   * { throw } to throw at the call site, HOLD (gate only) to hold
   * the run open until a human answers. Must be synchronous in v0:
   * the host drives runs in a synchronous loop (the C host is
   * spawned per slice with spawnSync); a worker that needs real
   * time uses a blocking spawn (see direct adapter). Async adapters
   * are a later step (BRA-48/49 worker pool).
   */
  answer(type: string, arg: any, ctx: TrapContext): TrapAnswer | typeof HOLD;
}

/** Optional capability: queue a canned answer for the next trap of
 * a type (test adapters). The host's queueAnswer/setCanned
 * pass-throughs delegate here when the loaded adapter implements it. */
export interface CannedAdapter extends Adapter {
  queueAnswer(type: string, answer: TrapAnswer | unknown): void;
  setCanned(
    type: string,
    fn: (type: string, arg: any, ctx: TrapContext) => TrapAnswer | undefined,
  ): void;
  queueGateAnswer(answer: unknown): void;
}

export function isCannedAdapter(a: Adapter): a is CannedAdapter {
  return typeof (a as CannedAdapter).queueAnswer === "function";
}
