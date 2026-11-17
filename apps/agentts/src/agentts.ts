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
//     The ONE exception is the call-site transport field (BRA-73):
//     each wrapper attaches `__agenttsSite` ({file, line, column} of
//     the call site in the bundle, captured from Error.stack) to the
//     arg it passes to trap() — the only channel from inside the
//     engine to the host, since the C core emits the trap event from
//     the arg alone and the core is not touched. The host strips that
//     key before dispatch (no adapter, repair handler, or schema
//     lookup ever sees it) and journals it as the trap event's
//     top-level `site`, so the journaled arg stays exactly the spec
//     the author passed. Authors must not use `__agenttsSite` as a
//     spec key — the host strips it from any arg that carries it.
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
// decisionCascade and the Decision shape live here — BRA-47 (see the
// "decision cascade" section at the end of this file).
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

// ------------------------------------------- call-site capture (BRA-73)
/**
 * Reserved trap-arg key carrying a wrapper-captured call site (see
 * the extractor-contract note above). Exported so the host can strip
 * it — it is transport, not part of any spec.
 */
export const TRAP_SITE_KEY = "__agenttsSite";

/** A call site: bundle coordinates (see below). */
export interface TrapSite {
  file: string;
  line: number;
  column: number;
}

/**
 * The six wrapper names, plus this helper and the boundary check:
 * frames for these are the trap machinery, not the call site.
 * A workflow function that happens to share one of these names and
 * calls a wrapper is skipped one frame too far — the site reported
 * is then its caller, still a real call site in the workflow.
 * decisionCascade is here too: its internal wrapper calls report
 * the workflow's decisionCascade() call site, not the module
 * interior — the four tiers share that one call site, and the
 * journal tells them apart by trapId/type.
 */
const TRAP_FRAME_NAMES = new Set([
  "job",
  "exec",
  "gate",
  "sleep",
  "cron",
  "decide",
  "decisionCascade",
  "captureTrapSite",
  "toJsonValue",
]);

/**
 * Capture the caller's call site from Error.stack, skipping wrapper
 * frames. The coordinates refer to the BUNDLE (the workflow is
 * bundled before the C host evals it — verified live on the engine:
 * `at f (/tmp/.../bundle-<run>.js:134:19)`), so they are only
 * interpretable against the bundle + source map the host pins with
 * the run (BRA-73: `bundlePath`/`bundleMapPath` on the
 * lifecycle-started event). Never throws: an unparseable stack (a
 * future engine format, a missing stack) yields null and the
 * wrapper sends the arg without a site — the trap still dispatches.
 */
export function captureTrapSite(): TrapSite | null {
  try {
    const stack = new Error().stack;
    if (typeof stack !== "string") return null;
    for (const raw of stack.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("at ")) continue;
      // QuickJS (the engine) and V8/Bun agree on the two shapes:
      //   at name (file:line:column)   /   at file:line:column
      const m = line.match(/^at (?:(.+?) \((.+):(\d+):(\d+)\)|(.+):(\d+):(\d+))$/);
      if (!m) continue;
      const name = m[1] ?? "";
      const file = m[2] ?? m[5] ?? "";
      const lineNo = Number(m[3] ?? m[6]);
      const colNo = Number(m[4] ?? m[7]);
      if (!file || !Number.isFinite(lineNo) || !Number.isFinite(colNo)) continue;
      if (TRAP_FRAME_NAMES.has(name)) continue;
      return { file, line: lineNo, column: colNo };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attach a captured site to a JSON-clean arg copy for the trap call.
 * The site rides inside the arg (the C core serializes the arg into
 * the trap event — the only channel out of the engine); the host
 * strips it before dispatch and journals it as the event's `site`.
 */
function withTrapSite(cleanArg: unknown, site: TrapSite | null): unknown {
  if (!site) return cleanArg;
  if (cleanArg !== null && typeof cleanArg === "object" && !Array.isArray(cleanArg)) {
    return { ...(cleanArg as Record<string, unknown>), [TRAP_SITE_KEY]: site };
  }
  return cleanArg;
}

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
  return trap("job", withTrapSite(toJsonValue(spec, "job arg"), captureTrapSite())) as Output;
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
  return trap("exec", withTrapSite(toJsonValue(spec, "exec arg"), captureTrapSite())) as ExecResult;
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
  return trap("gate", withTrapSite(toJsonValue(spec, "gate arg"), captureTrapSite())) as GateResult;
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
  return trap("sleep", withTrapSite(toJsonValue(spec, "sleep arg"), captureTrapSite())) as SleepResult;
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
  return trap("cron", withTrapSite(toJsonValue(spec, "cron arg"), captureTrapSite())) as CronResult;
}

// ------------------------------------------------------------------ decide
/**
 * A decision model instead of a full agent.
 *
 * The result type is generic: not every decide call is a cascade
 * tier — call sites supply a concrete, named type, e.g.
 * `decide<DecideResult>({ question: "pick one", options: ["a", "b"] })`.
 * There is deliberately no default result type here. The cascade's
 * decide tier uses DecideTierResult (the canonical Decision shape,
 * BRA-47, below); other decide calls name their own result type.
 */
export interface DecideSpec {
  question: string;
  options?: string[];
}

export function decide<Output>(spec: DecideSpec): Output {
  return trap("decide", withTrapSite(toJsonValue(spec, "decide arg"), captureTrapSite())) as Output;
}

// ------------------------------------------------------- decision cascade (BRA-47)
/**
 * The canonical Decision shape + decisionCascade() (BRA-47).
 *
 * A Decision is the shared result shape for exec, decide, job, and
 * gate WHEN THEY ARE USED AS DECISIONS. Not all gates/jobs/execs
 * are decisions — the shape is a convention for decision-use, not a
 * constraint on the trap type. A gate used as a decision tier returns
 * confidence 1.0: a human answer is authoritative and terminal.
 *
 * decisionCascade(spec) runs one decision spec — question, options,
 * optional context, optional exec command — through the tiers cheap
 * to expensive (exec -> decide -> job -> gate), with the SAME inputs
 * at every tier, stopping at the first tier at or above its
 * threshold. It escalates on low confidence, abstention, or error,
 * and ultimately to a human. It is ordinary workflow-side code
 * built on the trap wrappers — NOT a core builtin or trap — so it
 * is testable with the mock plugin, and the plugin journals every
 * attempt, so the escalation path is visible audit evidence.
 *
 * Thresholds live in the spec, possibly per-tier
 * (spec.thresholds.exec/decide/job, falling back to spec.threshold).
 * Confidence is NOT comparable across tiers — a decision model's
 * 0.8 is calibrated, an agent's self-reported 0.8 is less so — so
 * there is NO default threshold anywhere in this module: a tier
 * with no threshold in the spec fails loudly (before any trap
 * fires) instead of silently inheriting a number nobody chose.
 * The gate needs no threshold: its confidence is 1.0, which meets
 * any threshold <= 1, so it always settles the cascade.
 *
 * Tier contracts (what each tier must return to count as a decision):
 *   - exec: the spec's exec command must print EXACTLY one JSON
 *     object on stdout: { choice, confidence }. Free text is not a
 *     decision — unparseable stdout is an ABSTENTION, not a choice.
 *     A non-zero exit is an ERROR. The choice must be one of
 *     spec.options and confidence a finite number in [0, 1];
 *     anything else is an abstention.
 *   - decide: the decide trap (the local model in decision-model.ts)
 *     returns { choice, confidence }; the same choice/confidence
 *     checks apply. The local model never abstains — a question with
 *     no parseable signal falls back to the first option at
 *     confidence 0.5, which the cascade treats as a below-threshold
 *     answer (it escalates by the threshold, not by abstention).
 *   - job: the job tier always uses the "decision" jobspec (a string
 *     LITERAL in the call below — the extractor requires a literal
 *     spec to map the trap to its contract, so the cascade cannot
 *     take a caller-supplied jobspec name). The agent's answer must
 *     carry its SELF-REPORTED confidence as a structured output
 *     field ({ choice, confidence, reason? } — see
 *     plugins/muse/jobspecs/decision.md), not vibes: the cascade
 *     reads the confidence field, it does not infer one. The same
 *     choice/confidence checks apply.
 *   - gate: the human's answer maps to { choice: answer,
 *     confidence: 1.0, tier: "gate" }, accepted VERBATIM even when
 *     it is not one of the options — a human may reject the framing,
 *     and that is a decision. If the gate trap itself throws there
 *     is no tier left to escalate to, so the cascade throws (the
 *     run fails loudly, with the attempt history in the message).
 *
 * The returned Decision carries the deciding tier AND the full
 * attempt history: one entry per tier the cascade evaluated, in
 * order, up to and including the deciding tier — a tier with no
 * exec command is recorded "skipped", not silently omitted — each
 * with its result (choice + confidence) or its escalation reason.
 * A cascade result naming only the winning tier would hide the
 * escalation path; the audit value is the path.
 *
 * Context: spec.context reaches ONLY the job tier (as a structured
 * input field). DecideSpec and GateSpec have no context channel, so
 * the exec/decide/gate tiers receive the question and options
 * exactly as written — fold any context those tiers need into the
 * question text, and the inputs stay literally identical at every
 * tier.
 *
 * Extraction note: the extractor walks the workflow file and its
 * relative imports but EXCLUDES this module, so the trap calls
 * inside decisionCascade never extract on their own. A
 * decisionCascade(...) call in the workflow SYNTHESIZES the four
 * tier sites (see extract.ts) with the contracts from this file —
 * that is the only host support the helper needs, and the only
 * reason a workflow using decisionCascade must import it from
 * this module (not copy it). Consequence of the shared keys: a
 * workflow that calls decisionCascade AND a direct decide<Other>
 * (or a direct job<"decision"> with different types) hits the
 * usual one-key-one-contract extraction conflict — keep direct
 * decide/job calls in a cascade workflow on the cascade's types
 * (DecideTierResult / DecisionJobInput / DecisionJobResult).
 */

/** The tiers, cheap to expensive. */
export type DecisionTier = "exec" | "decide" | "job" | "gate";

/**
 * One tier's outcome in the attempt history. "decided" is the
 * winning tier; "below-threshold" / "abstained" / "error" are the
 * escalation reasons; "skipped" is a tier the cascade did not
 * attempt (the exec tier with no exec command in the spec).
 */
export type DecisionAttemptStatus = "decided" | "below-threshold" | "abstained" | "error" | "skipped";

export interface DecisionAttempt {
  tier: DecisionTier;
  status: DecisionAttemptStatus;
  choice?: string;
  confidence?: number;
  /** What happened: the outcome note, or the escalation reason. */
  reason: string;
}

/**
 * The canonical Decision shape (BRA-47): the choice, its
 * confidence (0–1), the tier that decided, the question + options
 * it decided between, and the full attempt history (every tier
 * evaluated, in order, with its result or its escalation reason).
 * All plain JSON types, so the first-run gate can extract its
 * schema from this interface.
 */
export interface Decision {
  choice: string;
  confidence: number;
  tier: DecisionTier;
  question: string;
  options: string[];
  attempts: DecisionAttempt[];
}

/**
 * What the decide tier returns. Structurally the local model's
 * { choice, confidence } (decision-model.ts DecisionResult) — a
 * separate name here because this is the cascade tier's contract
 * (the module's type, extractable from this file), not the model's
 * return type. Keep the two shapes aligned.
 */
export interface DecideTierResult {
  choice: string;
  confidence: number;
}

/** Input to the "decision" jobspec: the question, the options, and the structured context. */
export interface DecisionJobInput {
  question: string;
  options: string[];
  context?: string;
}

/**
 * What the "decision" jobspec returns: the agent's choice, its
 * SELF-REPORTED confidence (a structured output field — the
 * jobspec requires it; the cascade never infers a confidence),
 * and a brief reason.
 */
export interface DecisionJobResult {
  choice: string;
  confidence: number;
  reason?: string;
}

/** Per-tier stop thresholds (the gate needs none — see above). */
export interface DecisionThresholds {
  exec?: number;
  decide?: number;
  job?: number;
}

/**
 * One decision spec, run through the tiers. question + options are
 * the same inputs at every tier. exec is the cheap tier's command
 * (absent: the exec tier is skipped). threshold is the fallback
 * for any tier without its own entry in thresholds; a tier with
 * neither fails loudly before any trap fires.
 */
export interface DecisionSpec {
  question: string;
  options: string[];
  context?: string;
  exec?: ExecSpec;
  threshold?: number;
  thresholds?: DecisionThresholds;
}

/** One tier's outcome before the threshold is applied. */
type TierOutcome =
  | { kind: "answer"; choice: string; confidence: number }
  | { kind: "abstain"; reason: string }
  | { kind: "error"; reason: string };

function truncateReason(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Shared choice/confidence validation for the exec, decide, and job
 * tiers: the answer must be an object with a string choice that is
 * one of the options and a finite confidence in [0, 1]. Anything
 * else is an ABSTENTION — the tier produced no usable decision —
 * with the precise reason, never a low-confidence choice.
 */
function checkTierChoice(value: unknown, options: string[], tier: string): TierOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "abstain", reason: `${tier} returned a non-object decision (${truncateReason(JSON.stringify(value) ?? String(value), 120)})` };
  }
  const choice = (value as { choice?: unknown }).choice;
  const confidence = (value as { confidence?: unknown }).confidence;
  if (typeof choice !== "string" || !choice) {
    return { kind: "abstain", reason: `${tier} returned no usable choice (${truncateReason(JSON.stringify(value) ?? String(value), 120)})` };
  }
  if (!options.includes(choice)) {
    return { kind: "abstain", reason: `${tier} returned choice ${JSON.stringify(choice)} which is not one of the options ${JSON.stringify(options)}` };
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { kind: "abstain", reason: `${tier} returned choice ${JSON.stringify(choice)} with confidence ${String(confidence)} outside [0, 1]` };
  }
  return { kind: "answer", choice, confidence };
}

function tierError(tier: string, e: unknown): TierOutcome {
  // A throw crossing the resume boundary may arrive rehydrated as a
  // plain { name, message } record, not an Error instance — read the
  // message off either shape.
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string"
        ? (e as { message: string }).message
        : String(e);
  return { kind: "error", reason: `${tier} trap threw: ${msg}` };
}

/** exec tier: stdout must be exactly one JSON { choice, confidence }. */
function execTier(cmd: ExecSpec, options: string[]): TierOutcome {
  let r: ExecResult;
  try {
    r = exec(cmd);
  } catch (e) {
    return tierError("exec", e);
  }
  if (r.exitCode !== 0) {
    return { kind: "error", reason: `exec exited ${r.exitCode}${r.stderr ? `: ${truncateReason(r.stderr.trim(), 200)}` : ""}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    return { kind: "abstain", reason: `exec stdout did not parse as JSON {choice, confidence} (stdout: ${truncateReason(r.stdout.trim(), 120) || "(empty)"})` };
  }
  return checkTierChoice(parsed, options, "exec");
}

/** decide tier: the decide trap (the local model), same checks. */
function decideTier(question: string, options: string[]): TierOutcome {
  let r: DecideTierResult;
  try {
    r = decide<DecideTierResult>({ question, options });
  } catch (e) {
    return tierError("decide", e);
  }
  return checkTierChoice(r, options, "decide");
}

/**
 * job tier: the "decision" jobspec — the spec name is a string
 * LITERAL (the extractor requires a literal to map the trap to its
 * contract; a caller-supplied jobspec name cannot extract).
 */
function jobTier(question: string, options: string[], context: string | undefined): TierOutcome {
  let r: DecisionJobResult;
  try {
    r = job<DecisionJobInput, DecisionJobResult>({
      spec: "decision",
      input: { question, options, ...(context !== undefined ? { context } : {}) },
    });
  } catch (e) {
    return tierError("job", e);
  }
  return checkTierChoice(r, options, "job");
}

/**
 * gate tier: the human's answer, confidence 1.0, accepted verbatim
 * even when it is not one of the options.
 */
function gateTier(question: string, options: string[]): TierOutcome {
  let r: GateResult;
  try {
    r = gate({ question, options });
  } catch (e) {
    return tierError("gate", e);
  }
  return { kind: "answer", choice: r.answer, confidence: 1.0 };
}

/**
 * The stop threshold for one tier: its own entry in
 * spec.thresholds, else the spec-wide threshold. Missing or out of
 * [0, 1] is a spec error, loud, before any trap fires (the caller
 * in decisionCascade validates every enabled tier up front).
 */
function decisionThreshold(spec: DecisionSpec, tier: "exec" | "decide" | "job"): number {
  const t = spec.thresholds?.[tier] ?? spec.threshold;
  if (t === undefined) {
    throw new Error(
      `decisionCascade: no threshold for the ${tier} tier — set thresholds.${tier} or threshold in the decision spec (thresholds are per-tier: confidence is not comparable across tiers, so there is no default)`,
    );
  }
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
    throw new Error(`decisionCascade: threshold for the ${tier} tier must be a number in [0, 1] (got ${String(t)})`);
  }
  return t;
}

/** Spec validation, up front: loud before any trap fires. */
function validateDecisionSpec(spec: DecisionSpec): void {
  if (typeof spec.question !== "string" || !spec.question) {
    throw new Error("decisionCascade: spec.question must be a non-empty string");
  }
  if (!Array.isArray(spec.options) || spec.options.length === 0) {
    throw new Error("decisionCascade: spec.options must be a non-empty array of option strings");
  }
  if (spec.options.some((o) => typeof o !== "string" || !o)) {
    throw new Error("decisionCascade: every spec.options entry must be a non-empty string");
  }
  decisionThreshold(spec, "decide");
  decisionThreshold(spec, "job");
  if (spec.exec) decisionThreshold(spec, "exec");
}

/**
 * Run one decision spec through the tiers cheap to expensive
 * (exec -> decide -> job -> gate), same inputs at every tier,
 * stopping at the first tier at or above its threshold. Escalates
 * on low confidence, abstention, or error; the gate is terminal
 * (confidence 1.0). The returned Decision carries the deciding
 * tier and the full attempt history.
 */
export function decisionCascade(spec: DecisionSpec): Decision {
  validateDecisionSpec(spec);
  const attempts: DecisionAttempt[] = [];
  const finish = (choice: string, confidence: number, tier: DecisionTier): Decision => ({
    choice,
    confidence,
    tier,
    question: spec.question,
    options: spec.options,
    attempts,
  });
  // One tier's outcome against its threshold: returns the deciding
  // choice, or null (recorded, escalate to the next tier).
  const settle = (tier: DecisionTier, out: TierOutcome, threshold: number): { choice: string; confidence: number } | null => {
    if (out.kind === "answer") {
      if (out.confidence >= threshold) {
        attempts.push({ tier, status: "decided", choice: out.choice, confidence: out.confidence, reason: `confidence ${out.confidence} at or above ${tier} threshold ${threshold}` });
        return { choice: out.choice, confidence: out.confidence };
      }
      attempts.push({ tier, status: "below-threshold", choice: out.choice, confidence: out.confidence, reason: `confidence ${out.confidence} below ${tier} threshold ${threshold}` });
      return null;
    }
    if (out.kind === "abstain") {
      attempts.push({ tier, status: "abstained", reason: out.reason });
      return null;
    }
    attempts.push({ tier, status: "error", reason: out.reason });
    return null;
  };

  if (!spec.exec) {
    attempts.push({ tier: "exec", status: "skipped", reason: "no exec command in spec — the exec tier is skipped, not attempted" });
  } else {
    const won = settle("exec", execTier(spec.exec, spec.options), decisionThreshold(spec, "exec"));
    if (won) return finish(won.choice, won.confidence, "exec");
  }
  const decided = settle("decide", decideTier(spec.question, spec.options), decisionThreshold(spec, "decide"));
  if (decided) return finish(decided.choice, decided.confidence, "decide");
  const jobbed = settle("job", jobTier(spec.question, spec.options, spec.context), decisionThreshold(spec, "job"));
  if (jobbed) return finish(jobbed.choice, jobbed.confidence, "job");
  // The gate is terminal: confidence 1.0 meets any threshold <= 1.
  const gated = settle("gate", gateTier(spec.question, spec.options), 1.0);
  if (gated) return finish(gated.choice, gated.confidence, "gate");
  // No tier left: the gate trap itself threw.
  throw new Error(
    `decisionCascade: the gate tier failed (${attempts[attempts.length - 1]?.reason ?? "unknown"}) — no decision; attempts: ${JSON.stringify(attempts)}`,
  );
}
