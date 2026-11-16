# DurableTS plugin protocol (Layer 1 ↔ Layer 2 boundary)

This is the exact interface between the DurableTS core (Layer 1,
`packages/durablets`) and the host plugin (Layer 2, `apps/agentts`).
The core dispatches; the plugin interprets, executes (via the Layer 3
environment adapter), journals, schedules, and stores blobs. Nothing
in this protocol mentions Muse, Claude Code, or any environment: the
adapter sits below the plugin (see `plugin/adapter.ts`) and is the
only layer that knows about one.

## The boundary in one paragraph

The TS host spawns the C host once per run-slice (v0, the proven
experiment shape; a long-lived daemon over IPC is a later
optimization). The C host evals one self-contained script (the TS host
bundles workflow + agentts module with `Bun.build`; the C host never
resolves imports), runs until the run suspends or completes, and exits.
On suspension it writes exactly one file — the blob, at the path the
plugin passed on the command line — and emits `[durablets] {json}`
event lines on stderr. The plugin records those events (its journal),
maintains the run registry from the lifecycle events, stores the blob,
executes the trap (or queues it), and later spawns the C host again to
resume the blob with the result (or throw it). Exit codes: 0 = done,
1 = error, 2 = suspended at a trap, 3 = suspended at a combinator.
Workflow output goes to stdout; host diagnostics + events go to stderr.

## Dispatch: core → plugin

### The trap call

A run calls the core builtin:

```ts
const result = trap(type, arg);
```

- `type: string` — the trap type. The core routes by this string and
  nothing else. Known types (the plugin interprets them; the core does
  not know what any of them means): `job`, `exec`, `gate`, `sleep`,
  `cron`, `decide`.
- `arg: unknown` — JSON-like. The core stringifies it into the trap
  event; non-JSON-like args are the plugin's problem, not the core's.
  In practice the boundary is strict (BRA-46): everything crossing it
  must be clean JSON — see "Trap-boundary JSON rule" below. The core
  enforces arg-in at `trap()` entry in C for direct callers (BRA-43
  follow-up); the agentts module enforces it for wrapper callers.
- Returns a JSON-like result, or throws. Sync-looking, full stop:
  `await trap(...)` does NOT work (an async frame cannot be suspended)
  and there is no async alternative, by decision.
- A run may call `trap` directly or via a wrapper (e.g. the agentts
  module's `job()`); either way it pauses/resumes. A run that never
  calls `trap` just executes and completes.

### Run-side wrapper arg shapes (agentts module, BRA-46)

The module's wrappers pass their spec verbatim as the trap arg — no
added fields, no wrapping — so the journal's trap event arg IS the spec:

| wrapper | trap arg |
| --- | --- |
| `job<Input, Output>({ spec, input })` | `{ spec: "<jobspec>", input: <Input> }` |
| `exec({ cmd, args?, cwd? })` | the spec as written |
| `gate({ question, options? })` | the spec as written |
| `sleep({ ms })` | the spec as written |
| `cron({ at })` | the spec as written |
| `decide<Output>({ question, options? })` | the spec as written |

### Trap-boundary JSON rule (BRA-46)

Everything crossing a trap boundary — arg in, result out — must be
clean JSON data. The module's `toJsonValue()` (in `src/agentts.ts`,
documented in `agentts.md`) is the single implementation: check first,
then serialize. ACCEPT: null, boolean, string, finite number, array,
plain object (Object.prototype or null prototype, string keys). `Date`
is the ONE sanctioned conversion, to its ISO string. REJECT with a
precise error (path, what it was, what to do): `undefined` anywhere (a
trap must return a value or throw — use `null`, not `undefined`),
function, symbol, BigInt, NaN/Infinity, Map/Set, typed arrays /
ArrayBuffer, class instances, circular references, non-string keys,
array holes / extra keys. Plain `JSON.stringify` is NOT the mechanism —
it fails silently (drops functions/`undefined`/symbols, Map/Set to `{}`,
NaN/Infinity to `null`, class instances to method-less objects).
Enforcement split: module checks every wrapper arg before `trap()`;
core checks arg-in at `trap()` entry in C (direct callers); plugin
checks result-out before resume plus every journal write, reusing
`toJsonValue()`. Order at the boundary: JSON-clean check first, then
schema validation against the type extracted from the call site.

### The trap event (what the plugin receives)

On suspension at a trap the core emits on stderr:

```json
[durablets] {"event":"trap","runId":"run-judges","trapId":"run-judges/trap-0","ordinal":0,"type":"job","arg":{"op":"score","value":7}}
```

- `trapId` is the trap's identity: `runId + "/trap-N"`, N the
  per-run trap ordinal (Q9: runId + ordinal as one id). The same
  trapId appears in the trap-result / trap-error event, so a resumed
  run and its history agree on which trap is which.
- `stateBlob`: the blob is NOT in the event — the blob is the snapshot
  file the plugin named on the command line. The plugin already has
  it; the event carries the identity, not the bytes.

The plugin answers a trap by spawning the C host again (see Callbacks
below). It may answer with a value or by throwing. It must record the
dispatch in its journal before executing, so recovery can check the
journal before re-dispatching (a crash between trap completion and
resume must not duplicate the trap).

### Combinator forks

`all(thunks[, failFast])`, `any(thunks)`, `race(thunks)` stash the
thunks under a fresh Symbol key on the global object, emit a fork
event, and suspend (exit 3). Empty lists follow `Promise`:

- `all([])` → `[]` immediately, no fork, no suspension.
- `any([])` → throws an `AggregateError` with no errors immediately,
  no fork, no suspension.
- `race([])` → suspends on a 0-branch fork and never settles.

```json
[durablets] {"event":"fork","runId":"run-judges","forkId":"run-judges/fork-0","kind":"all","branches":3,"failFast":false,"childRuns":["run-judges/fork-0/branch-0","run-judges/fork-0/branch-1","run-judges/fork-0/branch-2"]}
```

- `forkId` is `(runId, fork ordinal)`; child run ids derive from it.
- `failFast` is an `all`-only field.
- The stash is removed on every resume path (the branch child deletes
  the symbol-keyed entry after taking the thunks; every join/cancel
  deletes it before resuming the parent), so a nested fork's stash
  cannot be confused with the outer one.

A branch child is a fresh run: the plugin spawns the C host in
`branch` mode on a COPY of the parent blob, with
`AGENTTS_RUN_ID=<child>` and `AGENTTS_PARENT_FORK=<forkId>`. The child
abandons the parent's suspended call (`JS_AbandonSuspended`) and evals
the driver `__stash[<index>]()`. Branch results are outcome objects:

```json
{ "ok": true, "value": <return value> }
{ "ok": false, "error": { "name": "Error", "message": "..." } }
```

A thrown non-Error crosses as-is (the raw value in `error`). The
child prints its outcome on stdout as `branch <i> outcome: <json>` and
emits `branch-start` / `branch-done` events; the parent snapshot is
untouched by children (the plugin verifies this by hash before the
join). Global-state rule: branches read fork-time state; a branch's
writes are discarded by construction (each child runs on its own heap
copy; the parent blob is never written by a child).

## Callbacks: plugin → core

The plugin resumes a suspended blob by spawning the C host with one of
these modes. `<blob>` is the path the plugin stored the blob at.

### `resume <blob> <result-json>` — complete a pending trap with a value

```json
[durablets] {"event":"trap-result","runId":"run-judges","trapId":"run-judges/trap-0","ordinal":0,"result":{"score":0.92,"label":"approved"}}
```

### `resume <blob> throw:<json>` — complete a pending trap by throwing

The core rehydrates `{name, message}` records into real `Error`s
(BRA-41) before throwing at the trap call site, so the run's
`catch (e)` sees `e instanceof Error`. A thrown non-object crosses
as-is. The emitted event carries the record shape (the plugin's
journal keeps the record; the run sees the `Error`):

```json
[durablets] {"event":"trap-error","runId":"run-judges","trapId":"run-judges/trap-0","ordinal":0,"error":{"name":"Error","message":"boom"}}
```

### `join <blob> <outcome.json>...` — join a collect-all `all()`

Resumes the parent with the joined outcome array (branch order, one
outcome file per branch, written by the plugin). For fail-fast
success, the plugin unwraps the outcomes to bare values first, so the
parent receives `["approved/verified", ...]`, not outcome objects.
Join event (emitted by the core, recorded by the plugin):

```json
[durablets] {"event":"join","runId":"run-judges","forkId":"run-judges/fork-0","outcome":[{"ok":true,"value":"approved/verified"},{"ok":true,"value":"weak/retried"},{"ok":false,"error":{"name":"Error","message":"judge crashed"}}]}
```

### `join-value <blob> <record.json>` — join `any()` / `race()` on a win

Record: `{"value": <winner's bare value>, "winner": i,
"cancelled": [...], "completed": [...]}`. Resumes the parent with the
winner's bare value.

### `join-throw <blob> <record.json>` — join on a thrown branch error

Record: `{"failedBranch": i, "error": {name,message},
"cancelled": [...], "completed": [...]}`. Used by fail-fast `all()`
(first branch error) and by `race()` (first settler failed). The core
rehydrates the error record into a real `Error` and throws it at the
combinator call site; the run catches it with ordinary try/catch, its
finally blocks run, and the run itself is NOT cancelled.

### `join-aggregate <blob> <record.json>` — join `any()` when all fail

Record: `{"errors": [{name,message},...], "completed": [...],
"cancelled": [...]}`. The core rehydrates each branch error and throws
a real `AggregateError` holding all branch errors in branch order.

### `cancel <blob> <cancel.json>` — deliver a cancellation

Record: `{"reason": "...", "trigger": "...", "what": "trap"|"fork",
"ordinal": N?, "forkId": "..."?, "cancelled": [...]?,
"parentForkId": "..."?, "branch": i?}`. `reason` is the why (it
propagates unchanged down a cancelled tree); `trigger` is local to the
event (`"user abort"`, `"parent cancelled"`, ...). The core sets the
run's sticky cancellation token (`__cancelled`, carried by the
snapshot), emits the cancel event (with `when`, epoch seconds), and
resumes the suspended wait throwing a real `CancellationError`
(name `"CancellationError"`, message = reason).

```json
[durablets] {"event":"cancel","runId":"run-cancel-step","what":"trap","ordinal":0,"trigger":"user abort","reason":"user abort","when":1763260000}
```

Sticky cancellation: once the token is set, any further `trap()` or
`all()`/`any()`/`race()` call throws a `CancellationError`
immediately — no event, no suspension, no dispatch — reusing the
stored reason. Cancel-vs-complete race: whichever the plugin records
in its journal first wins (a result recorded before the cancel keeps
the result; a cancel recorded first means the result never arrives).
Nested propagation: the plugin cancels deepest-first (children, then
parent); each run's journal records exactly one cancel event.

Sibling cancellation (fail-fast / `any` / `race` losers): the plugin
refuses to (re)spawn the remaining siblings and records a cancel event
in each one's journal — in this reference driver the siblings are
sequential, so at decision time no sibling process is live; in the
real host the same decision kills live child processes (Q14):

```json
{"event":"cancel","runId":"run-failfast/fork-2/branch-2","parentForkId":"run-failfast/fork-2","branch":2,"trigger":"sibling failed with fail-fast on","failedBranch":1,"error":{"name":"Error","message":"judge crashed"}}
```

## Lifecycle events: core → plugin (the run registry)

The core emits one lifecycle event per run phase; the plugin maintains
the run registry from these events ONLY (the core is invoked per-slice
and exits, so it cannot hold the registry across slices):

```json
[durablets] {"event":"lifecycle","lifecycle":"started","runId":"run-judges"}
[durablets] {"event":"lifecycle","lifecycle":"suspended","runId":"run-judges","kind":2}
[durablets] {"event":"lifecycle","lifecycle":"resumed","runId":"run-judges"}
[durablets] {"event":"lifecycle","lifecycle":"completed","runId":"run-judges"}
[durablets] {"event":"lifecycle","lifecycle":"failed","runId":"run-judges"}
```

- `kind` (on `suspended` only): 2 = suspended at a trap, 3 =
  suspended at a combinator.
- A run enters the registry on `started`/`resumed` and leaves on
  `completed`/`failed`. Branch runs emit the same events (their
  completion is signaled by both `branch-done` and `completed`).
- A run suspended at `race([])` stays in-flight indefinitely — the
  registry holds it; only an explicit teardown (or a later cancel)
  closes it.

## The journal (plugin-side)

One append-only journal per run (the reference plugin writes one
`.journal` file per run id; the real host may use one shared journal —
the event shapes are the same either way). The core writes no journal
file; the plugin records every `[durablets]` event it ingests, plus
its own scheduler decisions (sibling cancellations above). Event
catalog:

| event | fields |
| --- | --- |
| `lifecycle` | `lifecycle`, `runId`, `kind?` |
| `trap` | `runId`, `trapId`, `ordinal`, `type`, `arg` |
| `trap-result` / `trap-error` | `runId`, `trapId`, `ordinal`, `result` / `error` |
| `fork` | `runId`, `forkId`, `kind`, `branches`, `failFast?`, `childRuns` |
| `join` | `runId`, `forkId`, plus one of: `outcome` / (`outcome`, `winner`, `cancelled`, `completed`) / (`failedBranch`, `error`, `cancelled`, `completed`) / (`aggregate`, `errors`, `completed`, `cancelled`) |
| `cancel` | `runId`, `what`, `ordinal?`, `forkId?`, `trigger`, `reason`, `when`, `cancelled?`, `parentForkId?`, `branch?` |
| `branch-start` / `branch-done` | `runId`, `parentForkId`, `branch`, `outcome?` (done only) |

## The C host CLI (thin; Layer 1's executable surface)

```
durablets run <workflow.ts> <blob>
durablets resume <blob> <result-json>
durablets resume <blob> throw:<json>
durablets cancel <blob> <cancel.json>
durablets branch <blob> <index>
durablets join <blob> <outcome.json>...
durablets join-value <blob> <record.json>
durablets join-throw <blob> <record.json>
durablets join-aggregate <blob> <record.json>
```

Run context crosses in the environment (`AGENTTS_RUN_ID`,
`AGENTTS_PARENT_FORK` for branches) and is carried by the snapshot
afterwards (`__run_id`, `__fork_count`, `__trap_count`,
`__cancelled`, `__cancel_reason`, `__branch_index`, `__parent_fork`).
The C host never resolves imports: the TS host bundles the workflow +
the agentts module into one self-contained script first.

## Below the plugin: the environment adapter

The plugin does not execute traps itself — it calls the adapter
(`plugin/adapter.ts`, types only, NOT built here): `spawnJob` /
`collectJob` / `cancelJob` / `runExec` / `deliverGate`. The adapter is
the only layer that knows about an environment (Muse, Claude Code, a
plain shell). The plugin observes timings/costs itself; the adapter
does not report stats. Swapping the adapter must not touch core,
plugin, scheduler, or workflows — the mock plugin (BRA-45) is the
first proof of that boundary.
