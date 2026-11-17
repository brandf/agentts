# Mock host plugin (Linear BRA-45)

The layer-2 mock host plugin — the first proof of the adapter-swap
boundary. It implements the DurableTS core's plugin protocol
(dispatch `{trapId, runId, type, arg, stateBlob}` → resume/throw)
as a REAL plugin the AgentTS host loads, not a copy of the core's
reference test harness (`packages/durablets/plugin/driver.ts`).
The core (BRA-43) is the engine side; this plugin is the host side.
The host executable (BRA-44) later loads plugins from
`apps/agentts/plugins/`.

## Layout

```
src/
  mock-plugin.ts   MockPlugin: dispatch, virtual clock, canned answers,
                   journal, registry, fork/join, repair loop, bundling
  mock-adapter.ts  THE mock adapter implementation (MockAdapter:
                   canned answers + JFL judges/fix/aggregate,
                   bug-fix simulation) — the host and CLI construct
                   this class directly for their defaults.
  adapter.ts       the mock ADAPTER (BRA-53): the loadable plugin module
                   for Host.loadAdapter("mock") — returns the
                   MockAdapter from mock-adapter.ts (same file as
                   above, not a second copy; see plugins/README.md
                   for why the mock adapter appears twice). The
                   engine above is a different thing: a full
                   in-memory host with its own smaller canned set.
  agentts.ts       the agentts module (BRA-46, landed) — copied verbatim
                   from packages/durablets/src/agentts.ts; the plugin
                   reuses its toJsonValue as the single "clean JSON"
                   implementation (see below)
  extract.ts       first-run type extractor (TS compiler API +
                   ts-json-schema-generator), cache, loud failures
  gate.ts          first-run type-check gate (TS compiler API in-process),
                   GateError with structured diagnostics
  validate.ts      AJV wrapper (compiled-validator cache)
tests/
  workflows/       ported core-suite workflows + mock-only workflows
                   (clock, gate-hold, typed valid/bad/repair, JSON-clean,
                   loud-failure fixtures, gate-type-error fixture)
  run-mock-suite.ts
  swap-test.ts     byte-identical comparison, reference vs mock
run.sh             build the C host (scratch) → reference suite → mock
                   suite → swap test; scratch deleted on success
package.json       typescript 5.9.3 (exact pin), ts-json-schema-generator
                   2.9.0, ajv 8.20.0
```

## Run it

```
./run.sh
```

`run.sh` builds the core C host into a scratch `OUT_DIR` and points
both suites at it via `$DURABLETS_HOST` (the Makefile puts build
outputs in `OUT_DIR`; the driver resolves the host from
`$DURABLETS_HOST`, else the legacy in-tree `./durablets` binary —
which the Makefile's `clean` target removes and which must not be
recreated). It then runs the reference suite into a scratch dir, the
mock suite into a scratch dir, then the swap test. All run outputs
live in a mkdtemp scratch dir, never in the staged tree; the scratch
dir is deleted on success and kept (path printed) on failure.

Result (2026-11-15):

```
PASS durablets (reference suite green)
PASS mock-plugin (mock suite green — see below)
PASS swap test: 30 runs byte-identical under the mock plugin and the reference plugin
PASS mock-plugin end to end
```

## The swap test — the point of this plugin

The same workflows, run under the mock plugin, produce
byte-identical results to the same workflows under the core's
reference plugin. 30 runs compared, 30 byte-identical: the 17
ported core-suite runs (judges/global/nested/failfast/any/race,
their direct references, race-empty, the five cancellation runs,
trap-types, error-rehydration + direct), `run-agentts`, the six
agentts-module combinator runs, and `run-json-boundary`. Swapping
the environment changes nothing above the plugin boundary.

## Virtual clock

The clock is VIRTUAL and PER RUN. Each run starts at the configured
start (default `2027-01-01T00:00:00.000Z`, `initialTime` in the
plugin config) and gets its own clock — runs in one plugin are
hermetic, so a run's output never depends on what another run
advanced the clock to first.

- `sleep`: the run's clock jumps by the duration instantly. No real
  waiting, ever — 2h of sleeps + months of cron jumps complete in
  ~0.5s wall time.
- `cron`: the run's clock jumps to the target absolute datetime. A
  target already past fires immediately and the clock does not move
  back (crons fire in datetime order, not call order).
- `clock` (a mock-plugin extension, not one of the six core trap
  types): read-only view of the run's clock (`{now, nowMs}`).

Every advance is journaled as a `clock-advance` event (reason
`sleep`/`cron`, from/to).

## Canned answers

Configurable per test, per trap type:

- `queueAnswer(type, answer)` — the next trap of that type returns
  the queued value (or throws, if `{throw}`).
- `setCanned(type, fn)` — a per-type function computing the answer
  from the trap arg.
- `gates: "auto" | "hold"` — `"auto"` answers a gate at once
  (`{answer: "yes"}`); `"hold"` keeps the gate open until the test
  calls `deliverGate({answer})` — the week-long gate in miniature.
  A held gate stops `drive()` (rc 2), journals a `gate-held` event,
  and the run stays suspended in the registry with no output.
- Repair: `setRepairHandler(type, fn)` / `maxRepairAttempts`
  (default 3) — after a validation or JSON-clean failure the handler
  is consulted with the precise error + previous answer attached;
  the retried trap carries the same `trapId`.

The built-in `MOCK` table answers the core suite's job traps
(`score`/`verify` by input value).

## Blobs, journal, registry, fork/join

- Blobs live in MEMORY (a `Map`), never in files. The live `.snap`
  file is a transient slice; every resume restores it from the Map.
  Deleting the live blob and resuming from the stored copy alone is
  a test, not an accident.
- The plugin-side journal writer emits JSONL in the same event
  shapes as the core protocol, plus plugin-originated events
  (`clock-advance`, `gate-held`, `validation-error`).
- The run registry is built from lifecycle events only.
- Fork/join orchestration for `all`/`any`/`race`: collect-all,
  fail-fast bool, first-success / first-settler wins, `AggregateError`,
  empty lists, sibling cancels, parent-snapshot hash check — the same
  rules as the core suite, verified by the ported tests (including
  cancellation x5: pending trap, whole combinator, sticky, the
  cancel-vs-complete race both ways, nested tree propagation).

## The first-run pipeline (CHECK → EXTRACT → CACHE → ERASE + EXECUTE → VALIDATE)

The engine raises no type errors — it erases types and runs the JS —
so the host closes that hole with a first-run gate that is IN the run
path, not beside it: `prepareRun` (the only way to start a run) runs
it automatically on first run of a workflow version. It must not be
a separate manual step an agent has to remember, or it will be
skipped — the original failure mode this whole project exists to
kill.

1. **CHECK** — on first run of a workflow version, type-check the
   workflow source. Failure = structured diagnostics back to the
   authoring agent, run does not start.
2. **EXTRACT** — extract JSON Schemas for each trap call's
   input/output types. Unextractable type = loud failure at the gate.
3. **CACHE** — gate result + schemas cached keyed by the workflow
   content hash (same frozen-copy store; pinned with the run, so a
   resumed run never re-extracts and the contract can't drift
   mid-run). Later runs of the same version skip to step 4 from
   cache. A source-hash change re-gates (and re-extracts).
4. **ERASE + EXECUTE** — bundle workflow + agentts module (Bun.build;
   the C host never resolves imports), hand to the C host, which
   erases types as it parses and runs the JS.
5. **VALIDATE AT TRAPS** — at each trap, validate the result against
   the cached schema before resuming; throw at the call site on
   mismatch.

Tests cover each step: a workflow with a type error is refused at
the gate (run never starts, diagnostics surfaced); a source-hash
change re-gates; a clean workflow's second run uses the cached gate
result + schemas without re-running the check (`gateRuns` stays 0);
a resumed run never re-extracts (no new cache entry during drive).

### The gate is a feedback channel, not just a wall

Types are guardrails for agents writing workflows, not just humans.
When an agent whips up workflow code, the gate returns a precise
error before anything runs — and the error must reach the author in
a form it can act on (write, check, fix, run). So a gate failure is
a structured return value, not raw log text and not a bare stop:

```ts
interface GateDiagnostic {
  file: string;    // the submitted workflow file
  line: number;    // 1-based
  column: number;  // 1-based
  code: number;    // TS diagnostic code, e.g. 2322
  message: string; // the compiler's message
  expected: string | null; // parsed from assignment-mismatch messages
  actual: string | null;   // e.g. expected "number", actual "string"
}
class GateError extends Error { diagnostics: GateDiagnostic[] }
```

The principle: don't trust the agent's output, verify it — the
static check at the gate + runtime validation at the trap boundary
bracket the agent's work from both sides. The mock suite tests the
full loop: an agent submits a workflow with a type error, gets
structured diagnostics, fixes it, resubmits, passes the gate, runs.

### Checker choice: the TypeScript compiler API, in-process

The gate uses `ts.createProgram` + `getSemanticDiagnostics` /
`getSyntacticDiagnostics` with the BRA-46 flags (`strict: true`,
target ES2022, module ESNext, moduleResolution Bundler,
`skipLibCheck: true`, `noEmit: true`) — i.e. exactly `tsc --noEmit`,
whose CLI is a thin wrapper over this API. Chosen over spawning
`tsc --noEmit` or `bun check` because:

- structured diagnostics natively — no CLI-text parsing, which the
  feedback channel needs;
- no subprocess / PATH fragility;
- no tsconfig needed (options explicit in code; the default ES2022
  lib includes DOM, so ambient globals like `console` don't
  false-positive — the bare-`bun check` TS2584 caveat doesn't apply).

Equivalence was proven live: the API produced the identical
diagnostic as `bun x tsc --noEmit` with the same flags (TS2322,
same file/line/column/message) on the fixture, and positives pass
both. The gate and the extraction share ONE program per first run.

### The dependency: `typescript` 5.9.3, pinned, confined to layer 2

YES, the host takes a dependency on the TypeScript compiler — both
gate steps need it: the check (the `tsc --noEmit` equivalent) and
the extraction (TS compiler API — full type resolution across files
is required; no lightweight substitute resolves types correctly).
`typescript` is listed in `package.json` at the exact version
`5.9.3` (no caret), pinned in `bun.lock`, and the installed version
is 5.9.3. The gate refuses loudly on a version mismatch (synthetic
diagnostic, code 0, naming expected vs actual); cached results are
version-bound (cache hits require `gate.compilerVersion === ts.version`).

Confinement: the dependency lives in exactly one place — layer 2,
the host's first-run gate. The engine (layer 1) stays tsc-free;
workflows don't depend on it (they just import from `'agentts'`).
Load-bearing: if the compiler is unavailable, the host REFUSES to
start the workflow rather than silently skipping the check (a static
import — the plugin fails to load loudly). The gate runs once per
workflow version (cached by hash), so the cost is negligible.

### Why the host must do this — the engine finding

dquickts does NOT run the TypeScript compiler. Its C parser
(`ts_skip_type*` in quickjs.c, 82 occurrences) erases types as it
parses; no type information survives and there is no API to retrieve
types from the engine. By the time a workflow runs, its types are
gone. So the type extraction for validation MUST be a separate pass
by the host (this layer-2 plugin) over the same source file, using
the TypeScript compiler API. The `.ts` file is read by two
consumers: the engine strips types to run, the host extracts types
to validate. Extraction runs once per workflow version, cached by
content hash. The engine stays tsc-free; the host carries the
typescript package as a dependency.

Bun is the same: Bun 1.4.4 strips types and does NOT type-check
(`bun run` on `const x: number = "hello"` prints "ran anyway:
hello", exit 0; `bun check` flags TS2322). So the first-run gate
stands unchanged — the checking lives in the host because neither
runtime does it. Verified live: generic `job<Input, Output>` calls,
interfaces, type aliases, union types, `as` casts, and enums all
parse and run cleanly in the minimal qjs binary — the syntax the
module needs works in the engine today.

## Extraction design (v2 — no transform)

The extractor (`src/extract.ts`) runs a type extractor over the
workflow source (TS compiler API + ts-json-schema-generator) and
produces JSON Schema for each trap call's output type (and input
type), cached keyed by the workflow content hash and pinned with
the frozen copy. Do not hand-write schemas as the mechanism.

- **No transform, no boxing.** The workflow runs as-is; the trap
  arg is exactly the spec object the author passed, verbatim — no
  added fields, no wrapping — so the journal's trap event arg is the
  spec and the call-site mapping stays trivial. (The v1 extractor
  rewrote the workflow with a boxed arg; that was replaced during
  the BRA-46 reconciliation, because the landed module guarantees
  the verbatim arg.)
- **Site keys come from the runtime (type, arg).** `job:<spec>` for
  module job calls (the jobspec name IS the contract identity),
  `job:<op>` for direct job calls with a literal arg, else the bare
  trap type. Same-key sites must agree on (input, output) types —
  a conflict is a loud `ExtractionError`. Runtime dispatch looks the
  site up by the same key.
- **Per-wrapper arity.** `job` = 2 type args; `decide` = 1 (input is
  the module's `DecideSpec`, output from the type arg); `exec` /
  `gate` / `sleep` / `cron` = 0 (fixed Spec/Result interfaces from
  the module). Direct `trap()`: 2 type args, or a named `as` cast /
  variable annotation for the output (an anonymous `as {…}` fails
  loudly); input from an identifier arg's declared named type, else
  null (recorded, not a failure — input schemas are extracted and
  cached but NOT enforced by the plugin; see below).
- **Concrete, named types only.** Trap type arguments must be
  concrete, named types; only JSON-like data types are extractable
  (objects, arrays, strings, numbers, booleans, unions, enums,
  optionals, `JsonValue`); `Date` maps to `{type: "string",
  format: "date-time"}`. Recursive types extract via `$defs`;
  generic interfaces are keyed by name + type arguments.
- **A checker-based pre-check** (adapted from the BRA-46 probe)
  runs before schema generation: it resolves each contract type via
  the checker and walks it, rejecting `any`/`unknown`, unresolved
  type parameters, `undefined`-only, `void`, functions, `Map`/`Set`/
  `WeakMap`/`WeakSet`/`Promise`/`RegExp`, with `Date` allowed.
  This closes a real gap: ts-json-schema-generator silently drops
  what it cannot represent (`Map` becomes `{type: "object",
  properties: {size}}`, a class loses its methods). All six probe
  negatives now fail loudly with precise messages.
- **If a trap carries no extractable type, the host FAILS LOUDLY at
  first run** rather than silently skipping validation — the loud
  failures are tested (`workflow-no-type.ts`,
  `workflow-unknown-type.ts`, `workflow-fn-type.ts`: each throws
  `ExtractionError` before any spawn).
- **Input side:** input schemas are extracted + cached but NOT
  enforced by the plugin (reassigned to module/core per the 19:39
  enforcement split — the module checks args before calling
  `trap()`; the core enforces arg-in at `trap()` entry for direct
  callers). A null input schema (direct call, literal arg, no
  declared type) is recorded, not a failure.

## The trap-boundary JSON rule

Everything crossing a trap boundary must be clean JSON; plain
`JSON.stringify` cannot be the mechanism (it fails silently).
The plugin reuses the agentts module's `toJsonValue` — ONE
implementation defines "clean JSON" everywhere (the module doc's
explicit instruction), so the plugin's local helper was deleted.
It is used in exactly two places: (1) on every trap RESULT before
resuming the workflow, (2) on everything the journal writer writes
(JSONL has the same requirement). Arg-in is enforced elsewhere (see
above); the plugin receives args as JSON by construction and does
not re-check them.

- ACCEPT: null, boolean, string, finite number, array, plain object
  (string keys); `Date` is the ONE sanctioned conversion (to ISO
  string).
- REJECT with a precise error (path, what it was, what to do):
  undefined anywhere, function, symbol, BigInt, NaN/Infinity,
  Map/Set/typed arrays/ArrayBuffer, class instances, circular refs,
  non-string keys — plus the module's extra categories: array holes,
  extra properties on arrays, invalid Dates, `toJSON`-carrying
  objects, unreadable properties, nesting past 1000 levels.
  `JsonBoundaryError` carries `{path, kind, message}` and throws on
  the FIRST bad value (fail-fast — one issue per repair attempt,
  replacing the v1 helper's collect-all behavior).
- Order: JSON-clean check FIRST, then schema validation against the
  extracted type. The error is journaled (a `validation-error`
  event, phase `json-clean` or `output`) and thrown at the call
  site; for agent outputs it goes back to the worker as retry
  feedback (the repair loop).

## Deviations and decisions (recorded)

- **Extractor v2: no transform.** Replaced the v1 boxing transform
  during the BRA-46 reconciliation — the landed module's verbatim
  trap arg is the contract; runtime site mapping uses the
  (type, spec/op) key instead.
- **`toJsonValue` reuse + first-failure semantics.** The plugin's
  local strict check-then-serialize helper was deleted; the module's
  helper is the single implementation. Repair feedback now carries
  one issue per attempt instead of all issues at once.
- **Per-run virtual clocks.** The v1 clock was shared per plugin;
  the second run of a clock workflow in one plugin printed different
  times (caught by the gate re-gate test). Each run now gets its own
  clock starting at the configured start.
- **`run.sh` builds the C host into scratch + `$DURABLETS_HOST`.**
  The legacy in-tree `./durablets` binary no longer exists (the
  Makefile's `clean` removes it); `run.sh` builds with a scratch
  `OUT_DIR` and exports `$DURABLETS_HOST` for both suites.
- **Input schemas extracted but not enforced by the plugin.**
  Per the enforcement split: the module checks args, the core
  enforces arg-in at `trap()` entry; the plugin enforces result-out
  + every journal write.
- **Checker choice: TS compiler API in-process** (see above) instead
  of spawning `tsc --noEmit` or `bun check`.

## Known limitations

- An empty interface (`interface Empty {}`) is accepted by both the
  probe's walk and the generator (validates as an unconstrained
  object) — a degenerate contract. Fixing the exact contract rules
  belongs to the M2 checker; it is not filed as a bug.
- The core's `tests/type-negatives/` (11 tsc fixtures) are
  M2-checker territory, out of scope for the runtime plugin; the
  extractor's own loud-failure fixtures cover the same categories at
  the extraction layer.
- The gate type-checks with `tsc --noEmit` semantics for now; the
  M2 checker replaces it later.
