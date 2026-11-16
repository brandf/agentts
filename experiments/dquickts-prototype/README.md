# dquickts prototype — is the suspendable engine viable for AgentTS?

Minimal, dquickts-only. No scheduler, no clock, no trace, no replay, no
cursor. The whole prototype is: engine + builtin step(s) + a workflow
that calls them + suspend + snapshot to disk + exit + fresh process
resumes with the result + workflow completes.

## What it proves

A workflow calls `step(input)` — a builtin global the engine itself
provides, not a method on any ctx object and not a JS-side wrapper — and
the engine suspends the run until the result arrives. Two variants:

- **Sync-looking** (`workflow-sync.ts`): `const a = step({op, value})`.
  The engine suspends mid-call via the durable host-call API
  (`JS_SuspendCall`); the host snapshots the runtime, exits, and a fresh
  process completes the call with `JS_ResumeWith(result)`.
- **Async-await** (`workflow-async.ts`): `const a = await stepAsync(...)`.
  The sync-suspending call **cannot** be awaited — `await step()` throws
  `TypeError: this call cannot be suspended` (an async frame is not
  suspendable; see `quickjs.h`). So the async variant uses a second,
  promise-based builtin: `stepAsync()` returns a promise and stashes its
  resolve on the heap; the workflow parks on the await between jobs, the
  host snapshots, and a later process resolves the promise.

## Result (tested 2026-11-15 on this VM)

Both variants pass end to end (`./run.sh`): 2 steps, 3 processes each,
output byte-identical to running straight through.

| | sync-looking | async-await |
| --- | --- | --- |
| steps | `step()` (suspending call) | `stepAsync()` (promise) |
| snapshots | 14,571 / 14,761 bytes | 14,883 / 15,074 bytes |
| wall, whole loop | ~12 ms (3 process spawns) | ~13 ms |

Raw engine speed on this VM: 100M simple loop iterations in ~3.5 s
(`qjs`, ~28M iterations/s on a 1.5-CPU share). The suspend/resume loop
is dominated by process startup, not by the engine.

The engine's own snapshot suite also passes here
(`make test-snapshot` in the dquickts tree): cross-process hibernation
of sync loops, async functions, generators, iterators, proxies,
`using`, and the upstream QuickJS test files — up to 365 slices in
separate processes, output identical to a straight run.

## Verdict: viable, with the sync-looking style primary

- The suspension mechanism works exactly as documented, including
  across processes. A full snapshot of this trivial workflow is ~15 KB
  (an empty runtime is ~13 KB); deltas would be smaller (upstream
  reports 128 bytes after one call in the Rust example — not tested
  here).
- **Sync-looking is easier on both sides.** The workflow is plain
  TypeScript — no `async`, no `.then`, no determinism rule, no await
  discipline. The host is one builtin and a snapshot; the async variant
  needs the deferred + stash + resolve dance in the host and an async
  workflow. If a workflow needs awaits for its own reasons, `stepAsync`
  covers it, but it is a second builtin, not the same call.
- The headline constraint: **one suspended execution per runtime, and
  a suspending call cannot be awaited.** Async frames park between jobs
  instead. The engine never suspends code running on behalf of native
  code (getters, `forEach` callbacks, promise reactions) — a request
  there stays pending until a later safepoint.

## What would need to be true for production use

1. **Accept the fork-maintenance bet.** dquickts is a small project
   (last commit 2026-11-11, four days before this test; tracks
   upstream QuickJS 2026-06-04; PRs landing that week). It is active
   now, but a fork this size can stall. Mitigations: vendor the tree,
   pin a commit, and keep the engine behind the `step` API so a swap
   stays possible.
2. **Settle the async story.** Either standardize on sync-looking
   steps (recommended — simplest), or carry both builtins.
3. **Same build everywhere.** A snapshot only loads into the same
   engine build (same version, same native registry in the same order,
   same word size). Fine if we ship one binary; a footgun if the
   registry ever drifts between writer and reader.
4. **Build cost.** `make` in the dquickts tree takes ~6 min wall on
   this VM (mostly `quickjs.c` at `-O2` plus the Python CAPI modules)
   and the build tree is ~330 MB with `-g` objects — too big for a
   512 MB `/tmp` (the default `make` fails there with "No space left
   on device" while linking the examples; `libquickjs.a`, `qjs` and
   `qjsc` build fine). Build on real disk.

Not tested here: throwing from a step, incremental (delta) snapshots,
or snapshot determinism across machines.

## Reproduce

```sh
git clone https://github.com/stencil-hq/dquickts
cd dquickts && make            # needs >512 MB free; ~6 min on a small VM
cd ../agentts                  # or wherever this prototype lives
cd experiments/dquickts-prototype
make DQUICKTS=/path/to/dquickts
./run.sh
```

`run.sh` builds the host, drives both variants through
run → suspend → snapshot → resume → complete, diffs stdout against
the expected output, and prints snapshot sizes and wall times.
Expected: `PASS sync-looking` and `PASS async-await`.

## Files

- `host.c` — the engine side: `print`, `step`, `stepAsync` builtins,
  `run`/`resume` driver, snapshot to disk. ~300 lines.
- `workflow-sync.ts` — sync-looking workflow (2 steps).
- `workflow-async.ts` — async-await workflow (2 steps, `stepAsync`).
- `Makefile` — builds `proto` against a dquickts checkout.
- `run.sh` — end-to-end driver + checks.
