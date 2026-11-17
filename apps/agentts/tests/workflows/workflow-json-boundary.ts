// Trap-boundary JSON rule (Linear BRA-46): a dirty trap arg throws
// synchronously at the call site with a precise error, and the trap
// never dispatches. A clean arg — including a Date, which crosses as
// its ISO string — goes through and returns its canned result.
//
// The dirty values below are smuggled past the static types with casts:
// that models the real source of dirty args (untyped data — a parsed
// payload, a library return — arriving where a clean type was declared).
// Types are erased at runtime, so the runtime check is the backstop.

import { job } from "../../src/agentts";

declare function print(...args: unknown[]): void;

interface ScoreInput {
  value: number;
  when?: Date;
}

interface ScoreResult {
  score: number;
  label: string;
}

export interface RunResult {
  done: boolean;
}

export default function run(): RunResult {
  class Point {
    x: number;
    constructor(x: number) {
      this.x = x;
    }
  }

  function tryDirty(name: string, input: unknown): void {
    try {
      job<ScoreInput, ScoreResult>({ spec: "score", input: input as ScoreInput });
      print(`dirty ${name}: NO THROW`);
    } catch (e) {
      print(`dirty ${name}:`, e instanceof Error ? e.message : String(e));
    }
  }

  // Clean: a Date crosses as its ISO string (the one sanctioned conversion).
  const j = job<ScoreInput, ScoreResult>({
    spec: "score",
    input: { value: 7, when: new Date("2027-04-09T00:00:00Z") },
  });
  print("job:", JSON.stringify(j));

  // Dirty: one case per rejected category.
  tryDirty("undefined", { value: 7, missing: undefined });
  tryDirty("function", { value: 7, fn: () => 1 });
  tryDirty("symbol", { value: 7, sym: Symbol("s") });
  tryDirty("bigint", { value: 7, big: 10n });
  tryDirty("nan", { value: 7, nan: NaN });
  tryDirty("infinity", { value: 7, inf: Infinity });
  tryDirty("map", { value: 7, map: new Map([["a", 1]]) });
  tryDirty("set", { value: 7, set: new Set([1]) });
  tryDirty("typed-array", { value: 7, buf: new Uint8Array([1, 2]) });
  tryDirty("class-instance", { value: 7, obj: new Point(1) });

  const circ: Record<string, unknown> = { value: 7 };
  circ.self = circ;
  tryDirty("circular", circ);

  tryDirty("symbol-key", { value: 7, [Symbol("k")]: 1 });
  tryDirty("invalid-date", { value: 7, when: new Date(NaN) });
  tryDirty("array-hole", { value: 7, items: [1, , 3] });

  const arrExtra: unknown[] = [1, 2];
  (arrExtra as unknown as Record<string, unknown>).extra = "x";
  tryDirty("array-extra-key", { value: 7, items: arrExtra });

  tryDirty("nested-undefined", { value: 7, deep: { leaf: undefined } });
  print("done");
  return { done: true };
}
