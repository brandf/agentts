# agentts — the run-side TypeScript module (Linear BRA-46)

The run-side module for DurableTS. A run imports it; it wraps the core's
`trap(type, arg)` builtin. It is PORTABLE: it knows nothing about Muse,
about any host, or about how a trap is executed. Execution lives below
the plugin, behind the environment adapter (`plugin/adapter.ts`).

```ts
import { job, exec, gate, sleep, cron, decide } from "agentts";

interface ScoreInput { value: number; }
interface ScoreResult { score: number; label: string; }

const r = job<ScoreInput, ScoreResult>({ spec: "score", input: { value: 7 } });
```

Home: `packages/durablets/src/agentts.ts`. The module is layer-2 API
surface, but it lives in the core package until the AgentTS host
(`apps/agentts`, BRA-44) exists: there is no host package to move it to
yet, Bun.build bundles it identically from either location, and its only
hard requirement — portability, no host imports — is satisfied here. The
move, when BRA-44 lands, is a pure file move plus an import-path change.
Revisit then; do not move it speculatively now.

## API

### `job<Input, Output>(spec: JobSpec<Input>): Output`

Run a worker agent session. `spec` is the jobspec name — the host
resolves it to a jobspec file, which is part of the frozen copy, so the
contract cannot drift mid-run. `input` is the session's input.

Supply BOTH type arguments explicitly, as concrete named types. The
output type cannot be inferred (there is no inference site for it), so
omitting it leaves `Output = unknown` and the host has no output
contract to extract; a single type argument fills `Input`, not `Output`
(`job<ScoreResult>(...)` is a type error in practice — the input will
not match). Extra per-job parameters belong inside `input`: the spec
shape is exactly `{ spec, input }`, which is also exactly the trap arg
(see below).

```ts
export interface JobSpec<Input> {
  spec: string;
  input: Input;
}
```

### Fixed-result wrappers

For these, the result type is fixed by the trap type itself, so they
carry no type arguments — the host uses the exported result interface.

| wrapper | arg | result |
| --- | --- | --- |
| `exec(spec: ExecSpec)` | `{ cmd, args?, cwd? }` | `ExecResult { stdout, exitCode, stderr? }` |
| `gate(spec: GateSpec)` | `{ question, options? }` | `GateResult { answer }` |
| `sleep(spec: SleepSpec)` | `{ ms }` | `SleepResult { sleptMs }` |
| `cron(spec: CronSpec)` | `{ at }` (ISO 8601, one-shot — the name does NOT imply recurrence) | `CronResult { scheduled }` |

### `decide<Output>(spec: DecideSpec): Output`

A decision model instead of a full agent. The result type is generic:
not every decide call is a cascade tier — call sites supply a
concrete, named type (`decide<DecideResult>({ question, options })`).
There is deliberately no default result type here. The cascade's
decide tier uses `DecideTierResult` (the canonical Decision shape,
BRA-47, in this module); other decide calls name their own result
type.

### Combinators: `all`, `any`, `race`

The core builtins, re-exported. These are the globals themselves — read
off `globalThis` at import time, so the exported value IS the builtin
(same function object, no wrapper frame: calling one suspends exactly as
calling the global does). A bare `export { all }` over an ambient
declaration cannot work: the declaration is type-only and the bundler
has no runtime binding to export — the first workflow that imported a
combinator failed the build, which is how this was found. `trap` needs
no such alias: it is only ever called, never exported.

`all` is overloaded on the fail-fast flag, matching the core's two
return shapes:

```ts
all<T>(thunks, true): T[];                          // fail-fast: bare values
all<T>(thunks, false?): Outcome<T>[];               // collect-all (default)
all<T>(thunks, failFast: boolean): Outcome<T>[] | T[];
any<T>(thunks): T;                                  // first success wins
race<T>(thunks): T;                                 // first settler wins
```

```ts
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: JsonValue };
```

The error is a `JsonValue`, not `unknown`: whatever was thrown crossed
the branch boundary as clean JSON (an Error arrives as its
`{ name, message }` record; a thrown non-Error crosses as-is), so the
honest type is "any JSON value" — and unlike `unknown`, that type is
extractable by the host into a real (recursive) schema.

```ts
export interface JsonObject { [key: string]: JsonValue; }
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
```

`decisionCascade` and the Decision shape live here — BRA-47 (see the
"decision cascade" section at the end of `src/agentts.ts`).

## Types are the only source of truth

(Brandon, 19:36 PST — this supersedes the earlier schema-first
direction, which would have had authors write zod-style schemas and
derive types from them. Zod was evaluated hands-dirty and rejected on
both counts: a trivial zod workflow bundles to 166,842 bytes against
857 for this module, and `JSON.stringify` of a zod schema yields zod's
internal `def` shape, not JSON Schema — the plugin would have needed
zod plus a converter to read its own contract. Typia stays a fallback
evaluation only, not now.)

There are no schemas anywhere in author code: no schema parameters, no
schema builders, no validation in this module. The wrappers are
generic-typed so the host can EXTRACT the contract from the types.

### Extractor contract (host responsibility, layer 2)

On first run — or when the workflow source hash changes — the host runs
a type extractor over the workflow source (ts-json-schema-generator
style) and produces JSON Schema per trap call, cached keyed by the
workflow content hash and pinned with the frozen copy, so the validation
contract cannot drift mid-run. The plugin then validates each trap
result against the cached schema before resuming, throwing at the call
site on failure (and validating the input too). What this module
guarantees the host can rely on:

- Every generic wrapper's type parameters appear directly on the
  exported function and resolve at the call site: `job<Input, Output>`,
  `decide<Output>`. Call sites MUST supply concrete, named types; a
  call with no type arguments, or with an unresolved generic type
  parameter, has nothing to extract, and the host FAILS LOUDLY at first
  run rather than silently skipping validation. The M2 checker enforces
  concreteness.
- The trap arg is exactly the spec object the author passed, verbatim —
  no added fields, no wrapping — so the journal's trap event arg is the
  spec and the extractor's call-site mapping stays trivial.
- Only JSON-like data types are extractable (objects, arrays, strings,
  numbers, booleans, unions, enums, optionals, `JsonValue`). A type
  outside that subset (Date is the one exception — see below — plus
  Map, functions, class instances with methods) fails loudly at first
  run: "type X can not be validated — simplify it".
- `Date` maps to `{ type: "string", format: "date-time" }`, mirroring
  the module's runtime Date → ISO conversion (below). The extractor
  must apply the same mapping, or a `Date`-typed field would be
  unextractable while the runtime happily converts it.
- Recursive types extract via `$defs` (proven for `JsonValue` /
  `JsonObject`); generic interfaces must be keyed by name + type
  arguments, or distinct instantiations (e.g. `Array<Outcome>` vs
  `Array<JsonValue>`) collapse into one definition.

Verified during BRA-46 with a compiler-API probe over every workflow in
`tests/`: 37 call sites extract, including the `Date` field and the
recursive `JsonValue` in `Outcome<string>[]`; six negative fixtures
(unresolved type parameter, missing type arguments, function / Map /
method-carrying-class types) each fail loudly with a precise reason.
The probe is host-side verification tooling, not part of this package.

## Trap-boundary JSON rule

(Brandon, 19:39 PST.) Everything crossing a trap boundary must be clean
JSON data. Every wrapper runs its arg through `toJsonValue()` before
calling `trap()` — the check runs FIRST (can this even cross?), then the
schema validation the host does against the extracted type. The check
and the copy happen in one walk: the author's object is never mutated,
and the clean copy is what crosses.

```ts
export function toJsonValue(value: unknown, what?: string): unknown;
export class JsonBoundaryError extends Error {
  readonly path: string; // e.g. "$.input.deadline", "$.items[2]"
  readonly kind: string; // e.g. "undefined", "circular", "map"
}
```

ACCEPT: `null`, boolean, string, finite number, array, plain object
(`Object.prototype` or null prototype, string keys). `Date` is the ONE
sanctioned conversion, to its ISO string (the standard JSON convention
— `Date.prototype.toJSON`); an invalid Date is rejected. A value
referenced twice without a cycle (a DAG) is fine — it is copied at each
occurrence, exactly as `JSON.stringify` duplicates it.

REJECT, each with path + what-it-was + what-to-do: `undefined` anywhere
(a trap must return a value or throw — use `null`, not `undefined`, for
no value), function, symbol, BigInt, NaN/Infinity, Map/Set, typed
arrays / DataView / ArrayBuffer, class instances (non-plain prototype),
circular references, non-string (symbol) keys, array holes, extra keys
on arrays, nesting past 1000 levels (a precise error beats a
stack-overflow crash), unreadable properties. A plain object carrying a
`toJSON` function is rejected as a function-valued property — no silent
user-code invocation during serialization. Proxies are not detected; the
walk validates the values it observes through them.

Why not `JSON.stringify`: it fails silently — drops
functions/`undefined`/symbols from objects, turns Map/Set into `{}`,
NaN/Infinity into `null`, class instances into plain objects with
methods dropped. The rule generalizes the all-combinator lesson (a
thunk returning `undefined` lost its value key through the JSON
round-trip): the same class of bug, now a boundary rule instead of a
footgun.

A dirty arg throws synchronously at the call site — the trap never
dispatches, so no trap event appears in the journal — and the
workflow's ordinary `try/catch` sees a `JsonBoundaryError`. The error
is journaled by the plugin; for agent outputs it goes back to the
worker as retry feedback.

Enforcement split: the module runs the helper on every wrapper arg
before `trap()` (the author-facing fail-fast); the core enforces arg-in
at `trap()` entry in C for direct `trap()` callers (BRA-43 follow-up,
queued after BRA-46 lands to avoid staging conflicts); the plugin
enforces result-out before resume plus every journal write (BRA-45),
reusing this same helper so one implementation defines "clean JSON"
everywhere. The combinators take thunks (functions by design, stashed
not serialized) and are out of scope for this helper; branch outcomes
cross as JSON on the plugin side.

## Tests

Full suite (builds the C host, runs the reference driver):

```sh
./run.sh   # DURABLETS_WORKDIR=<scratch> to keep outputs out of the tree
```

Standalone module test — no C host, no driver (stubbed globals, tsc
positive/negative fixtures, bundle-size tripwire):

```sh
bun tests/test-agentts-module.ts   # exit 0 on PASS
```

Driver coverage for this module: the six wrappers bundled (output
byte-identical to the direct-`trap()` version, journal trap args
asserted verbatim per wrapper); the six core-suite combinator workflows
re-run through the module imports, byte-identical to their direct
references; the JSON rule end-to-end (16 rejected categories throw at
the call site with precise paths, dirty args never dispatch, a Date
crosses as its ISO string in the journal trap arg).

## Decisions (BRA-46)

- **Generic-typed wrappers, types-only source of truth.** Per Brandon's
  19:36 correction, superseding schema-first. Zero author friction: one
  artifact (the types), the contract derived exactly where the code is.
- **API shape finalized as `job<Input, Output>({ spec, input })`.**
  `spec` (not `jobspec`) per Brandon's example; the jobspec name is
  resolved by the host. The old `{ op, value, verdicts }` shape is gone
  — a clean break, recorded here: it had no jobspec identity and no
  contract, and keeping both shapes would fork the trap-arg contract
  the plugin validates. Direct-`trap()` workflows are unaffected.
- **No default result type on `decide`.** The cascade's decide tier
  uses `DecideTierResult` (BRA-47); other decide calls name their
  own result type.
- **Fixed-result wrappers carry no type arguments** (`exec`, `gate`,
  `sleep`, `cron`): their result type is fixed by the trap type.
- **`all` overloads on fail-fast** match the core's two return shapes
  (bare values vs outcome objects); a computed boolean flag falls
  through to the `boolean` overload.
- **`error: JsonValue` in `Outcome<T>`**, not `unknown`: honest about
  what crosses, and extractable (recursive `$defs`).
- **Combinators re-exported via `globalThis` reads**, not ambient
  re-exports (see above) — found by the first workflow that imported
  one.
- **Home: stays in `packages/durablets/src/`** until BRA-44 builds
  `apps/agentts` (see top).
