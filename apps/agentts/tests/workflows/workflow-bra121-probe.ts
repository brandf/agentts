import { all, any, race, sleep } from "../../src/agentts";

/**
 * BRA-121 probe workflow: a throw that surfaces through an `all()` join.
 *
 * Modes:
 * - "plain": throw with no combinator (baseline — fails cleanly today).
 * - "after-join": collect-all, inspect outcomes, throw after the join.
 * - "fail-fast": all(..., true) with a failing branch, uncaught.
 * - "after-join-sleep": same as after-join, but a sleep({ms: 0}) before
 *   the throw (the plan-driven-work template's workaround — fails
 *   cleanly today because the throw lands in a fresh slice).
 * - "any-winner": any() delivers the winner, then the workflow throws
 *   (exercises the join-value handler).
 * - "any-all-fail": any() with all branches failing throws the
 *   AggregateError at the call site, uncaught (join-aggregate).
 * - "race-fail": race() whose first branch fails throws at the call
 *   site, uncaught (join-throw via race).
 * - "race-win": race() delivers the winner, then the workflow throws
 *   (join-value via race).
 * - "caught-after-join": collect-all with a failing branch, caught and
 *   returned normally (happy path still works after the fix).
 */
export interface ProbeInput {
  mode: string;
}

export interface ProbeOutput {
  ok: boolean;
}

export default function run(input: ProbeInput): ProbeOutput {
  if (input.mode === "plain") throw new Error("plain throw, no combinator");
  if (input.mode === "fail-fast") {
    // all() throws at the call site when the first branch fails;
    // the return is unreachable.
    all(
      [
        () => {
          throw new Error("branch boom");
        },
        () => "sibling",
      ],
      true,
    );
    return { ok: true };
  }
  if (input.mode === "after-join" || input.mode === "after-join-sleep") {
    const outcomes = all([
      () => {
        throw new Error("branch boom");
      },
      () => "sibling",
    ]);
    for (const o of outcomes) {
      if (!o.ok) {
        const msg = `after-join throw: ${JSON.stringify(o.error)}`;
        if (input.mode === "after-join-sleep") {
          sleep({ ms: 0 });
          throw new Error(`${msg} (post-sleep)`);
        }
        throw new Error(msg);
      }
    }
    return { ok: true };
  }
  if (input.mode === "any-winner") {
    const v = any([() => "winner", () => { throw new Error("loser boom"); }]);
    throw new Error(`after-any throw: ${v}`);
  }
  if (input.mode === "any-all-fail") {
    // AggregateError thrown at the any() call site, uncaught.
    any([
      () => {
        throw new Error("first boom");
      },
      () => {
        throw new Error("second boom");
      },
    ]);
    return { ok: true };
  }
  if (input.mode === "race-fail") {
    // First branch fails; race throws at the call site, uncaught.
    race([
      () => {
        throw new Error("racer boom");
      },
      () => "sibling",
    ]);
    return { ok: true };
  }
  if (input.mode === "race-win") {
    const v = race([() => "winner", () => { throw new Error("loser boom"); }]);
    throw new Error(`after-race throw: ${v}`);
  }
  if (input.mode === "caught-after-join") {
    const outcomes = all([
      () => {
        throw new Error("branch boom");
      },
      () => "sibling",
    ]);
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length !== 1) throw new Error(`expected 1 failure, got ${failed.length}`);
    return { ok: true };
  }
  throw new Error(`unknown mode: ${input.mode}`);
}
