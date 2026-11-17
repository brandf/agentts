# DurableTS — the durable execution core library (Linear BRA-43)

Snapshot-based durable execution. A run is any globally scoped
TypeScript code: if it calls `trap()` (directly or via a wrapper) it
pauses and resumes; otherwise it just executes and completes. There is
no named entry point and no workflow concept in the core.

## The three layers (do not blur them)

- **Layer 1 — DurableTS core (this package, YOUR layer).** Trap /
  `all` / `any` / `race` builtins, suspend a run into a blob, resume a
  blob with a value/throw, run registry, trapId identity. Dispatches
  traps to the host plugin. Knows nothing about jobs, gates, journals,
  scheduling, workers, agents, Muse, or Claude Code — it doesn't even
  know what a trap *means*, it just hands it to the plugin and waits
  for an answer. C + thin host CLI.
- **Layer 2 — AgentTS host (environment-independent, later step,
  BRA-44).** Host plugin, agentts module, trap interpretation,
  scheduler, workflow library; the mock plugin lives here. TypeScript;
  loads the adapter by config.
- **Layer 3 — agentic environment adapter (later step).**
  `spawnJob` / `collect` / `cancelJob` / `runExec` / gate
  notifications; the ONLY layer that knows about Muse or Claude Code.

Dependency rule: each layer talks only to its neighbors through a
small interface; nothing skips a layer (layer 1 never talks to layer
3; layer 3 never reaches into layer 1). Swap tests: swapping layer 3
changes nothing in layers 1–2; swapping layer 2's scheduler changes
nothing in layers 1 and 3; replacing layer 1's engine changes nothing
in layers 2–3 as long as the trap/blob interface holds.

Repo mapping: `packages/durablets` (layer 1, this package),
`apps/agentts` (layer 2), `apps/agentts/plugins/` (layer 3).

### Purity boundary

`packages/durablets` contains **no Muse knowledge anywhere** — no
subagent APIs, no chat APIs, no Muse-specific imports. The environment
adapter is the only layer that knows about Muse; it sits BELOW the
plugin (the plugin calls the adapter, not the core). The adapter
interface is defined types-only in `plugin/adapter.ts`; the adapter
itself is NOT built here (it comes with the host, BRA-44/48). The
reference plugin in `plugin/driver.ts` stands in for the adapter with
canned handlers, exactly as the mock plugin (BRA-45) will.

## What the core does and does not do

The core knows ONLY:

- the `trap(type, arg)` builtin — the single dispatch point. It
  suspends the run, hands the trap to the host plugin, and resumes
  with the plugin's result.
- the `all` / `any` / `race` core builtins — fork/join with the Q13
  semantics: collect-all default, fail-fast bool on `all`,
  first-success / first-settler wins, `AggregateError`, empty-list
  behavior per `Promise`.
- suspend-a-run-into-a-blob / resume-a-blob-with-a-value-or-throw.
- the run registry (in-memory, per-slice — the plugin maintains the
  durable registry from the lifecycle events below).
- trapId identity: a trap's identity is its trapId, `runId + "/trap-N"`
  (runId + ordinal as one id — this answers Q9 for the core).

The core does NOT journal — the journal is a plugin concern and the
core writes no journal file itself (proven by the `core-only` test:
invoked with no plugin, the core writes exactly one file, the blob it
was told to write, and emits its events on stderr for the plugin to
record). The core does NOT know what a step, job, gate, judge, or
workflow is. The core does NOT store blobs: it produces/consumes blob
bytes at a path the plugin passes on the command line; it never
chooses, lists, or stores blob paths. The core does NOT schedule,
interpret trap types, or decide anything — it routes by type string
and waits.

Trap types are dispatched by type string; the plugin interprets them:
`job` (worker agent session), `exec` (shell command), `gate` (human
answer), `sleep` (a duration from now), `cron` (a single datetime —
one-shot, the name does not imply recurrence), `decide` (a decision
model instead of a full agent). Run-side wrappers live in the agentts
module (`src/agentts.ts`, docs in `agentts.md`): generic-typed
`job<Input, Output>({ spec, input })`, fixed-result `exec` / `gate` /
`sleep` / `cron`, generic `decide<Output>`, plus the re-exported
combinators; `trap` stays the low-level core global. Every wrapper runs
its arg through the trap-boundary JSON check (`toJsonValue`) before
calling `trap()` — a dirty arg throws synchronously at the call site
with a precise path and never dispatches; a Date crosses as its ISO
string. The core enforces the same rule at `trap()` entry in C for
direct `trap()` callers (BRA-43 follow-up): same rejected categories,
same `JsonBoundaryError` shape, no trap event and no ordinal consumed.
TypeScript types are the only source of truth: the host extracts
JSON Schema per trap call from the call-site type arguments (see
`agentts.md`).

Cancellation (Q14): cancel a pending trap, cancel a whole combinator,
sticky cancellation (further trap/combinator calls throw immediately),
cancel-vs-complete race (journal order wins — the plugin records it),
nested propagation down the tree. The core delivers cancellation by
resuming the suspended wait throwing a real `CancellationError`.

Error rehydration (BRA-41, fixed here): every resume-with-throw path
rehydrates `{name, message}` error records into real `Error`s — trap
results included, not just joins. The old prototype delivered throwing
steps as raw strings / plain objects; a throwing trap now arrives as a
real `Error` (`instanceof Error` true), and a thrown non-Error crosses
as-is.

## Layout

```
src/
  durablets.c / durablets.h   the C core + thin host CLI (builtins,
                              suspend/resume, abandon+eval fork
                              machinery, trapId, lifecycle events)
  agentts.ts                  the run-side TS module (generic-typed trap
                              wrappers + re-exported combinators + the
                              trap-boundary JSON check; portable)
agentts.md                    the agentts module's API docs (generic
                              wrappers, extractor contract, JSON rule,
                              decisions)
plugin/
  PROTOCOL.md                 the plugin protocol (exact dispatch +
                              callback shapes, event catalog, journal
                              shapes, registry rules)
  adapter.ts                  the environment-adapter interface,
                              types only (NOT built here)
  driver.ts                   the reference plugin (TS): canned trap
                              handlers, fork/join orchestration, the
                              plugin-side journal writer, the run
                              registry, the blob store — and the test
                              driver that proves all of it
tests/
  workflow-*.ts               test workflows + straight-through
                              references (ported from the BRA-24/25/26
                              and BRA-27 experiments, step -> trap)
  workflow-*-module.ts        module variants of the combinator
                              workflows (combinators + job via the
                              agentts import; byte-identical output)
  workflow-json-boundary.ts   trap-boundary JSON rule: clean Date job
                              + one dirty arg per rejected category
  workflow-trap-arg-boundary.ts
                              same rule, direct trap() callers: the C
                              core's arg-in check (dirty args throw
                              synchronously, never dispatch, consume no
                              ordinal; clean Date / DAG / own __proto__
                              pass through)
  test-agentts-module.ts      standalone module test (no C host/driver):
                              wrappers, combinator identity, JSON
                              matrix, tsc positive/negatives, bundle size
  type-negatives/             one mistyped call per file — each must
                              FAIL tsc (run by test-agentts-module.ts)
Makefile                      builds the thin host against the patched
                              minimal dquickts tree
run.sh                        build + full test run (exit non-zero on
                              any mismatch)
```

## How to build

```sh
# First, vendor the patched engine tree (once per checkout):
./re-vendor.sh 96a9a79   # installs packages/durablets/vendor/dquickts
make durablets        # builds against the vendored tree by default
                      # (libquickjs.a with JS_AbandonSuspended, BRA-42)
./run.sh              # build + full test suite (bun)
```

The full clean-checkout build — prerequisites, the vendoring step,
and troubleshooting — is in `BUILDING.md` at the repo root. To build
against a tree you already have instead of the vendored one, pass
`make DQUICKTS=/path/to/dquickts`; if the tree is missing or
unbuilt, `make` fails fast with instructions rather than a cryptic
linker error.

Build + test outputs (the `durablets` binary, logs, snapshots,
journals, blobs) go to a scratch dir, never into the package tree:
`./run.sh` uses a fresh mktemp dir (`OUT_DIR`, overridable), and plain
`make` uses `./out/` (`make OUT_DIR=...` to choose). The staged tree
stays sources-only.

The engine tree is NOT modified. The C host is a few hundred lines of
CLI over the core: `run` / `resume` / `cancel` / `branch` / `join` /
`join-value` / `join-throw` / `join-aggregate`. Exit codes: 0 = done,
1 = error, 2 = suspended at a trap, 3 = suspended at a combinator.
Workflow output goes to stdout; host diagnostics and the
`[durablets] {json}` event lines go to stderr.

The C↔TS boundary is the blob + JSON over process spawn (v0, the
proven experiment shape: the TS host spawns the C host per run-slice,
exactly as the experiment drivers did). A long-lived C host daemon
over IPC is a LATER optimization — not built here.

Modules: the TS host owns module resolution — it bundles the workflow
+ the agentts module into one self-contained script (`Bun.build`) and
hands that to the C host to eval. The C host never resolves imports
(proven by the `agentts-bundle` test: bundled output byte-identical
to the direct `trap()` version).

Toolchain used: **Bun 1.4.4** (TS execution + `Bun.build` bundler),
Node 24.22.1 also present on the VM but not used. No system-wide
tooling was installed.

## Result

**PASS** — `./run.sh` exits 0:

```
PASS durablets (trap x6 types + all/any/race + fail-fast + nested +
global-state + cancellation x5 + blob round-trip + registry + error
rehydration + no core journal + agentts bundle + agentts combinators x6
+ trap-boundary JSON rule + direct-trap arg-in JSON rule)
```

What it proves, each with a test that fails if the behavior is absent:

| test | what it proves |
| --- | --- |
| judges | 3 simulated judges via `all()`, one throws; parent still gets every outcome, failed branch as `{ ok: false, error }`; aggregate 2 approved / 1 failed; parent output byte-identical to the straight-through reference |
| global state | branches read fork-time state; a branch write is discarded (parent `sharedCount` still 0); `all([])` returns `[]` with no fork |
| nested `all()` | a branch fans out again; same machinery recursively |
| fail-fast bool | `all([...], true)` returns bare values on success, throws the first branch error at the call site (rehydrated `Error`), finally runs, parent keeps working; firstness is journal order; `all([...], false)` is collect-all |
| any | first success wins (bare value); all-fail throws a real `AggregateError` with all branch errors in branch order; `any([])` throws an `AggregateError` with no errors, no fork |
| race | first settler wins — bare value or thrown `Error`; losers cancelled; `race([])` never settles (bounded drive: still suspended, no join, no output, no crash) |
| cancel a pending trap | `CancellationError` at the call site, real `Error`, finally runs; journal records what/when/why/trigger; no trap-result appears |
| cancel a whole `all()` | children cancelled deepest-first, parent throws at the `all()` call site, no join event |
| sticky cancellation | after cancel, a further `trap()` and `all()` both throw at once — neither dispatches, no trap/fork event |
| cancel-vs-complete race | result-first keeps the result (trap-result recorded before the cancel event); cancel-first means no result ever lands and the next trap throws at once (sticky) |
| nested propagation | the whole tree cancels deepest-first; every journal records exactly one cancel event; uncaught branches fail with `CancellationError` outcomes |
| trap dispatch x6 | `trap("job"|"exec"|"gate"|"sleep"|"cron"|"decide", …)` each answered with its canned result; journal carries one trap event per type with trapIds `runId/trap-0…5` |
| blob round-trip | plugin store holds the blob (hash-checked); live blob deleted; run resumes from the stored copy alone — and every slice in every test goes through store/load with hash checks |
| run registry | maintained from lifecycle events only; parent + children in-flight while suspended; empty after every test completes (including the still-suspended `race([])` run, which stays in-flight) |
| error rehydration (BRA-41) | throwing trap arrives as a real `Error`; thrown plain string crosses as-is; driven output byte-identical to the direct reference |
| no journal by core | core invoked with no plugin writes no journal file (only the blob it was told to write); trap events go to stderr; no journal-path identifiers in `src/durablets.c` |
| agentts bundle | `Bun.build` bundles workflow + agentts module into one script; bundled output byte-identical to the direct `trap()` version; journal trap args asserted verbatim per wrapper (`job` as `{ spec, input }`) |
| agentts combinators x6 | every core-suite combinator workflow re-run through the module imports (`all`/`any`/`race` + `job`); output byte-identical to the direct references; job traps carry `{ spec, input }` |
| trap-boundary JSON rule | a dirty arg in each of 16 rejected categories throws synchronously at the call site with a precise path and never dispatches; a Date crosses as its ISO string in the journal trap arg; standalone module test (`bun tests/test-agentts-module.ts`, no C host/driver) also passes: wrappers, combinator identity, JSON matrix, tsc positive/negatives, bundle under 16 KiB |

Parent snapshots: ~14.9–15.3 KB at the fork. The parent snapshot is
untouched by the children (sha256 checked before forking vs before
the join; children work on copies).

## What did not survive the generalization

Nothing behavioral was lost. Three things changed shape, deliberately:

- `step(op, value)` became `trap(type, arg)` — the old builtin is
  gone; the ported workflows call `trap` through a thin `step()`
  wrapper (`trap("job", input)`) so their bodies are unchanged, and
  the new trap-types / agentts tests call `trap()` directly.
- Journaling moved out of the core: the experiments' host wrote
  journal files itself; the core now emits `[durablets]` event lines
  on stderr and the plugin (reference driver) writes the journals.
  Event shapes are preserved (only `"type"` → `"event"` and
  `step`/`step-result`/`step-error` → `trap`/`trap-result`/`trap-error`).
- Branch outcomes no longer cross via an outcome file the core writes:
  the core prints `branch <i> outcome: <json>` on stdout and the
  plugin parses it. The join modes still take outcome/record files as
  arguments — those files are written by the plugin, not the core.

One real bug was found and fixed during the build (it blocked the
milestone, so it was fixed immediately rather than filed): the BRA-41
rehydration in the resume-throw path leaked the parsed value —
`rehydrate_error` returns a new value without consuming its input —
which tripped QuickJS's `JS_FreeRuntime` `list_empty` assertion on the
second throw-resume. The fix frees the parsed value after rehydration.
No non-blocking bugs were filed during this build.
