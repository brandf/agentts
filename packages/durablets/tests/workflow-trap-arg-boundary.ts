// Trap arg-in JSON rule, direct trap() callers (BRA-43 follow-up):
// the C core enforces the same boundary the agentts module (BRA-46)
// enforces for its wrappers. A dirty arg passed straight to trap()
// throws synchronously at the call site with a precise error, and the
// trap never dispatches. A clean arg — including a Date, which crosses
// as its ISO string, a DAG (the same object twice, copied at each
// occurrence), and an own "__proto__" data property (JSON.parse shape)
// — goes through unchanged.
//
// No imports: this workflow calls the core global directly, exactly
// the hole the module-side check cannot close.

declare function trap(type: string, arg: unknown): unknown;
declare function print(...args: unknown[]): void;

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

  function tryDirty(name: string, arg: unknown): void {
    try {
      trap("job", arg);
      print(`dirty ${name}: NO THROW`);
    } catch (e) {
      print(`dirty ${name}:`, e instanceof Error ? e.message : String(e));
    }
  }

  // Clean: a Date crosses as its ISO string (the one sanctioned conversion).
  const j = trap("job", {
    op: "score",
    value: 7,
    when: new Date("2027-04-09T00:00:00Z"),
  }) as { score: number; label: string };
  print("job:", JSON.stringify(j));

  // Dirty: one case per rejected category, direct trap() calls.
  tryDirty("undefined", { value: 7, missing: undefined });
  tryDirty("root-undefined", undefined);
  tryDirty("function", { value: 7, fn: () => 1 });
  tryDirty("symbol", { value: 7, sym: Symbol("s") });
  tryDirty("bigint", { value: 7, big: 10n });
  tryDirty("nan", { value: 7, nan: NaN });
  tryDirty("infinity", { value: 7, inf: Infinity });
  tryDirty("map", { value: 7, map: new Map([["a", 1]]) });
  tryDirty("set", { value: 7, set: new Set([1]) });
  tryDirty("typed-array", { value: 7, buf: new Uint8Array([1, 2]) });
  tryDirty("array-buffer", { value: 7, ab: new ArrayBuffer(4) });
  tryDirty("dataview", { value: 7, dv: new DataView(new ArrayBuffer(4)) });
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
  // An object literal's "__proto__" key sets the prototype: the root
  // object's prototype is not Object.prototype, so it is rejected as a
  // class instance at $ — same as the module check.
  tryDirty("proto-setter", { "__proto__": { polluted: true }, value: 7 });

  // Clean again after all the dirty calls: a DAG plus a JSON.parse
  // "__proto__" own data property. If any dirty call had consumed a
  // trap ordinal, this trap would not be ordinal 1.
  const shared = { x: 1 };
  const ownProto = JSON.parse('{"__proto__":{"polluted":true},"value":7}');
  const d = trap("job", {
    op: "score",
    value: 3,
    dag: { a: shared, b: shared },
    ownProto,
  }) as { score: number; label: string };
  print("dag job:", JSON.stringify(d));
  print("done");
  return { done: true };
}
