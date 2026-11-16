// agentts — the run-side TypeScript module for DurableTS (BRA-46).
//
// A run imports this module; the module wraps the core's trap(type, arg)
// builtin. This module is PORTABLE: it knows nothing about Muse, about
// any host, or about how a trap is executed. Execution lives below the
// plugin, behind the environment adapter (see plugin/adapter.ts) —
// swapping the adapter never touches this module, the core, the plugin,
// the scheduler, or any workflow.
//
//   import { job, exec, gate, sleep, cron, decide } from "agentts";
//   interface ScoreInput { value: number; }
//   interface ScoreResult { score: number; label: string; }
//   const r = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
//
// TypeScript types are the ONLY source of truth (Brandon, 19:36 PST —
// this supersedes the earlier schema-first direction). There are no
// schemas anywhere in author code: no schema parameters, no schema
// builders, no validation in this module. The wrappers are generic-typed
// so the host can EXTRACT the contract from the types: on first run (or
// when the workflow source hash changes) the host (layer 2) runs a type
// extractor over the workflow source and produces JSON Schema per trap
// call, cached keyed by the workflow content hash and pinned with the
// frozen copy. The plugin then validates each trap result against the
// cached schema before resuming, throwing at the call site on failure.
//
// Extractor contract — what this module guarantees the host can rely on:
//   - Every wrapper is a generic function whose type parameters appear
//     directly on the exported function and resolve at the call site:
//     job<Input, Output>, decide<Output>. Call sites MUST supply
//     concrete, named types for both of job's type arguments (and for
//     decide's); a call with no type arguments, or with an unresolved
//     generic type parameter, has nothing to extract, and the host
//     FAILS LOUDLY at first run rather than silently skipping
//     validation. The M2 checker enforces concreteness.
//   - The trap arg is exactly the spec object the author passed, verbatim
//     — no added fields, no wrapping — so the journal's trap event arg
//     is the spec and the extractor's call-site mapping stays trivial.
//   - Only JSON-like data types are extractable (objects, arrays,
//     strings, numbers, booleans, unions, enums, optionals). A type
//     outside that subset (Date, Map, functions, recursive types the
//     extractor cannot express) fails loudly at first run.
//   - The fixed-result wrappers (exec, gate, sleep, cron) carry no type
//     arguments: their result type is fixed by the trap type itself, so
//     the host uses the exported result interface (ExecResult, ...).
//
// The combinators (all / any / race) are core builtins, re-exported
// here for convenience. trap itself stays the low-level core global.
// decisionCascade and the Decision shape are NOT here — BRA-47.
//
// Trap-boundary JSON rule (Brandon, 19:39 PST). Everything crossing a
// trap boundary must be clean JSON data. Every wrapper below runs the
// arg through toJsonValue() before calling trap(): the check runs FIRST
// (can this even cross?), then the schema validation the host does
// against the extracted type. toJsonValue() throws synchronously at the
// call site — the trap never dispatches — with a precise error (path,
// what the value was, what to do). The core separately enforces arg-in
// at trap() entry in C for direct trap() callers (BRA-43 follow-up);
// the plugin enforces result-out before resume plus every journal
// write (BRA-45). This generalizes the all-combinator lesson (a thunk
// returning undefined lost its value key through the JSON round-trip):
// the same class of bug, now a boundary rule instead of a footgun.
// Plain JSON.stringify is NOT the mechanism — it fails silently (drops
// functions/undefined/symbols from objects, turns Map/Set into {},
// NaN/Infinity into null, class instances into plain objects with
// methods dropped).

declare function trap(type: string, arg: unknown): unknown;

/**
 * The core combinator builtins, re-exported. These are the globals
 * themselves — read off globalThis at import time, so the exported value
 * IS the builtin (same function object, no wrapper frame: calling one
 * suspends exactly as calling the global does). A bare `export { all }`
 * over an ambient declaration cannot work: the declaration is type-only
 * and the bundler has no runtime binding to export, so the first
 * workflow that imported a combinator failed the build. `trap` needs no
 * such alias: it is only ever called, never exported, so the bare
 * identifier resolves to the global at call time.
 */
export interface AllFn {
  <T>(thunks: (() => T)[], failFast: true): T[];
  <T>(thunks: (() => T)[], failFast?: false): Outcome<T>[];
  <T>(thunks: (() => T)[], failFast: boolean): Outcome<T>[] | T[];
}
export interface AnyFn {
  <T>(thunks: (() => T)[]): T;
}
export interface RaceFn {
  <T>(thunks: (() => T)[]): T;
}

export const all: AllFn = (globalThis as unknown as { all: AllFn }).all;
export const any: AnyFn = (globalThis as unknown as { any: AnyFn }).any;
export const race: RaceFn = (globalThis as unknown as { race: RaceFn }).race;

/** The six trap types, by the string the core routes on. */
export type TrapType = "job" | "exec" | "gate" | "sleep" | "cron" | "decide";

/**
 * Any clean JSON value — the type of "arbitrary data that may cross a
 * trap boundary". Recursive by design: an object maps string keys to
 * JsonValues, an array holds JsonValues. The runtime boundary check
 * (toJsonValue) is what enforces this shape; the type is the static
 * statement of it, and the host's extractor can express it as a
 * recursive JSON Schema (JsonValue / JsonObject in $defs).
 */
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/**
 * One branch outcome from collect-all `all()`: a value, or the error.
 * The error is a JsonValue, not `unknown`: whatever was thrown crossed
 * the branch boundary as clean JSON (an Error arrives as its
 * { name, message } record; a thrown non-Error crosses as-is), so the
 * honest type is "any JSON value" — and unlike `unknown`, that type is
 * extractable by the host into a real schema.
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: JsonValue };

// ------------------------------------------------------- JSON boundary rule
/**
 * Thrown by toJsonValue() when a value cannot cross a trap boundary.
 * `path` is the JSON path to the offending value (`$` is the root,
 * `$.input.deadline`, `$.items[2]`); `kind` is a machine-readable token
 * for retry feedback (undefined, function, symbol, bigint,
 * non-finite-number, invalid-date, map, set, typed-array, array-buffer,
 * class-instance, circular, non-string-key, array-hole, array-extra-key,
 * max-depth, unreadable). The message carries the path, what the value
 * was, and what to do.
 */
export class JsonBoundaryError extends Error {
  readonly path: string;
  readonly kind: string;
  constructor(what: string, path: string, kind: string, detail: string, fix: string) {
    super(`JSON boundary (${what}): ${path} ${detail}; ${fix}`);
    this.name = "JsonBoundaryError";
    this.path = path;
    this.kind = kind;
  }
}

/** Nesting cap: a precise error beats a stack-overflow crash. */
const MAX_JSON_DEPTH = 1000;

/**
 * Strict check-then-serialize for the trap boundary (Brandon, 19:39 PST).
 *
 * Walks `value` once, validating AND building a fresh clean copy:
 * the author's object is never mutated, and the copy is what crosses.
 *
 * ACCEPT: null, boolean, string, finite number, array, plain object
 * (Object.prototype or null prototype, string keys). Date is the ONE
 * sanctioned conversion, to its ISO string (the standard JSON
 * convention — Date.prototype.toJSON). The host's type extractor maps
 * Date to { type: "string", format: "date-time" } for the same reason.
 *
 * REJECT (each with path + what-it-was + what-to-do): undefined anywhere
 * (a trap must return a value or throw — use null, not undefined, for
 * no value), function, symbol, BigInt, NaN/Infinity, Map/Set, typed
 * arrays/DataView/ArrayBuffer, class instances (non-plain prototype),
 * circular references, non-string (symbol) keys, array holes, extra
 * keys on arrays, nesting past MAX_JSON_DEPTH, and unreadable properties.
 *
 * Notes: a value referenced twice without a cycle (a DAG) is fine — it
 * is copied at each occurrence, exactly as JSON.stringify duplicates it.
 * Only true cycles are rejected (ancestors, not all seen objects, are
 * tracked). A plain object carrying a `toJSON` function is rejected as
 * a function-valued property — no silent user-code invocation during
 * serialization. Proxies are not detected; the walk validates the values
 * it observes through them.
 *
 * Every wrapper below calls this on its arg before trap(). The plugin
 * reuses this same helper for result-out and journal writes (BRA-45),
 * so one implementation defines "clean JSON" everywhere.
 */
export function toJsonValue(value: unknown, what = "value"): unknown {
  const ancestors = new Map<object, string>();
  const fail = (path: string, kind: string, detail: string, fix: string): never => {
    throw new JsonBoundaryError(what, path, kind, detail, fix);
  };
  const read = (obj: object, key: string | number, path: string): unknown => {
    try {
      return (obj as Record<string | number, unknown>)[key];
    } catch (e) {
      return fail(
        path,
        "unreadable",
        `could not be read (${e instanceof Error ? e.message : String(e)})`,
        "make the property readable or drop it",
      );
    }
  };
  const clean = (v: unknown, path: string, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH) {
      return fail(path, "max-depth", `is nested past ${MAX_JSON_DEPTH} levels`, "flatten the value");
    }
    if (v === null) return null;
    switch (typeof v) {
      case "boolean":
      case "string":
        return v;
      case "number":
        if (!Number.isFinite(v)) {
          return fail(
            path,
            "non-finite-number",
            `is ${String(v)}`,
            "use a finite number or null — JSON has no NaN or Infinity",
          );
        }
        return v;
      case "undefined":
        return fail(
          path,
          "undefined",
          "is undefined",
          "a trap must return a value or throw — use null, not undefined, for no value",
        );
      case "function":
        return fail(path, "function", "is a function", "functions cannot cross a trap boundary — pass plain JSON data instead");
      case "symbol":
        return fail(path, "symbol", `is a symbol (${String(v)})`, "symbols cannot cross a trap boundary — pass plain JSON data instead");
      case "bigint":
        return fail(path, "bigint", `is a BigInt (${String(v)})`, "BigInts cannot cross a trap boundary — pass a string or number instead");
      case "object":
        break;
      default:
        return fail(path, "unknown", `has unhandled typeof ${typeof v}`, "pass plain JSON data instead");
    }
    // object from here on
    if (ancestors.has(v)) {
      return fail(
        path,
        "circular",
        `is a circular reference (already seen at ${ancestors.get(v)})`,
        "break the cycle — JSON cannot represent circular structures",
      );
    }
    if (v instanceof Date) {
      if (!Number.isFinite(v.getTime())) {
        return fail(path, "invalid-date", "is an invalid Date", "pass a valid Date or an ISO string");
      }
      return v.toISOString();
    }
    if (v instanceof Map) {
      return fail(path, "map", `is a Map with ${v.size} entries`, "convert it to a plain object or array first — JSON.stringify would silently turn it into {}");
    }
    if (v instanceof Set) {
      return fail(path, "set", `is a Set with ${v.size} entries`, "convert it to an array first — JSON.stringify would silently turn it into {}");
    }
    if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) {
      return fail(path, "array-buffer", "is an ArrayBuffer", "binary data cannot cross a trap boundary — encode it (e.g. base64) first");
    }
    if (ArrayBuffer.isView(v)) {
      const name = Object.prototype.toString.call(v).slice(8, -1);
      return fail(path, "typed-array", `is a ${name}`, "typed arrays cannot cross a trap boundary — convert to a plain array first");
    }
    if (Array.isArray(v)) {
      ancestors.set(v, path);
      try {
        const out: unknown[] = [];
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) {
            return fail(
              `${path}[${i}]`,
              "array-hole",
              "is a hole in an array",
              "fill the hole or use null — JSON.stringify would silently turn it into null",
            );
          }
          out.push(clean(read(v, i, `${path}[${i}]`), `${path}[${i}]`, depth + 1));
        }
        for (const k of Object.keys(v)) {
          if (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= v.length) {
            return fail(
              `${path}.${k}`,
              "array-extra-key",
              `is an extra property ${JSON.stringify(k)} on an array`,
              "move it to a plain object — JSON.stringify would silently drop it",
            );
          }
        }
        for (const s of Object.getOwnPropertySymbols(v)) {
          if (Object.propertyIsEnumerable.call(v, s)) {
            return fail(path, "non-string-key", `has a symbol key (${String(s)})`, "JSON keys must be strings — drop the symbol key");
          }
        }
        return out;
      } finally {
        ancestors.delete(v);
      }
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
      return fail(
        path,
        "class-instance",
        `is an instance of ${ctor}`,
        "only plain objects cross a trap boundary — convert it to a plain object first (JSON.stringify would silently drop its methods)",
      );
    }
    for (const s of Object.getOwnPropertySymbols(v)) {
      if (Object.propertyIsEnumerable.call(v, s)) {
        return fail(path, "non-string-key", `has a symbol key (${String(s)})`, "JSON keys must be strings — drop the symbol key");
      }
    }
    ancestors.set(v, path);
    try {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        out[k] = clean(read(v, k, `${path}.${k}`), `${path}.${k}`, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  return clean(value, "$", 0);
}

// --------------------------------------------------------------------- job
/**
 * Run a worker agent session.
 *
 * `spec` is the jobspec name — the host resolves it to a jobspec (the
 * jobspec file is part of the frozen copy, so the contract cannot drift
 * mid-run). `input` is the session's input, typed as `Input`.
 *
 * Supply BOTH type arguments explicitly, as concrete named types:
 * `job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } })`.
 * The output type cannot be inferred from the call — there is no
 * inference site for it — so omitting it leaves `Output = unknown` and
 * the host has no output contract to extract. A single type argument
 * fills `Input`, not `Output`. Extra per-job parameters belong inside
 * `input`, not as extra fields here: the spec shape is exactly
 * `{ spec, input }`, which is also exactly the trap arg.
 *
 * The arg is checked by toJsonValue() before trap() is called: a dirty
 * arg (undefined, function, Map, class instance, circular, ...) throws
 * synchronously here with a precise path, and the trap never dispatches.
 * A Date anywhere in the input crosses as its ISO string.
 */
export interface JobSpec<Input> {
  spec: string;
  input: Input;
}

export function job<Input, Output>(spec: JobSpec<Input>): Output {
  return trap("job", toJsonValue(spec, "job arg")) as Output;
}

// -------------------------------------------------------------------- exec
/** Run a shell command. The result type is fixed by the trap type. */
export interface ExecSpec {
  cmd: string;
  args?: string[];
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

export function exec(spec: ExecSpec): ExecResult {
  return trap("exec", toJsonValue(spec, "exec arg")) as ExecResult;
}

// -------------------------------------------------------------------- gate
/** Wait for a human answer. The result type is fixed by the trap type. */
export interface GateSpec {
  question: string;
  options?: string[];
}

export interface GateResult {
  answer: string;
}

export function gate(spec: GateSpec): GateResult {
  return trap("gate", toJsonValue(spec, "gate arg")) as GateResult;
}

// ------------------------------------------------------------------- sleep
/** Wait a duration from now. The result type is fixed by the trap type. */
export interface SleepSpec {
  ms: number;
}

export interface SleepResult {
  sleptMs: number;
}

export function sleep(spec: SleepSpec): SleepResult {
  return trap("sleep", toJsonValue(spec, "sleep arg")) as SleepResult;
}

// -------------------------------------------------------------------- cron
/**
 * Wait until a single datetime (one-shot — the name does NOT imply
 * recurrence). The result type is fixed by the trap type.
 */
export interface CronSpec {
  at: string; // one-shot datetime (ISO 8601)
}

export interface CronResult {
  scheduled: string;
}

export function cron(spec: CronSpec): CronResult {
  return trap("cron", toJsonValue(spec, "cron arg")) as CronResult;
}

// ------------------------------------------------------------------ decide
/**
 * A decision model instead of a full agent.
 *
 * The result type is generic because the Decision shape belongs to
 * BRA-47, not this module: call sites supply a concrete, named type,
 * e.g. `decide<DecideResult>({ question: "pick one", options: ["a", "b"] })`.
 * There is deliberately no default result type here — a default would
 * bake in a Decision shape BRA-47 owns. Until BRA-47 lands, workflows
 * name their own result type at the call site.
 */
export interface DecideSpec {
  question: string;
  options?: string[];
}

export function decide<Output>(spec: DecideSpec): Output {
  return trap("decide", toJsonValue(spec, "decide arg")) as Output;
}
