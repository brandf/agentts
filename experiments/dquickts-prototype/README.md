# dquickts prototype — is the suspendable engine viable for AgentTS?

Minimal, dquickts-only. No scheduler, no clock, no trace, no replay, no
cursor. The whole prototype is: engine + builtin step + a workflow
that calls it + suspend + snapshot to disk + exit + fresh process
resumes with the result + workflow completes.

## What it proves

A workflow calls `step(input)` — a builtin global the engine itself
provides, not a method on any ctx object and not a JS-side wrapper — and
the engine suspends the run until the result arrives. The workflow is
plain TypeScript: `const a = step({op, value})`. The engine suspends
mid-call via the durable host-call API (`JS_SuspendCall`); the host
snapshots the runtime, exits, and a fresh process completes the call
with `JS_ResumeWith(result)` — or throws the value into the call with
`JS_ResumeWith(result, throw_flag=1)`, so a step can deliver an
exception the workflow's try/catch sees.

Two workflows:

- **Sync** (`workflow-sync.ts`): 2 steps, straight-line.
- **Complex** (`workflow-complex.ts`): 8 steps — nested for loops with
  a step call inside the inner loop; branch-dependent steps (if/else,
  each branch calls a different step: `verify` on the pass side,
  `retry` on the weak side); try/catch/finally around step calls in a
  helper; and a step that throws (value 9), caught by the helper.

## Result (tested 2026-11-15 on this VM)

Both workflows pass end to end (`./run.sh`), output byte-identical to
running straight through — cross-checked by running the same workflow
files under `qjs` against a straight-through mock `step`.

| | sync | complex |
| --- | --- | --- |
| steps | 2 | 8 |
| processes | 3 | 9 |
| final snapshot | 14,707 bytes | 17,077 bytes |
| wall, whole loop | ~32 ms | ~85 ms |

Raw engine speed on this VM: 100M simple loop iterations in ~3.7 s
(`qjs`, ~27M iterations/s on a 1.5-CPU share). The suspend/resume loop
is dominated by process startup, not by the engine.

The engine's own snapshot suite also passes here
(`make test-snapshot` in the dquickts tree): cross-process hibernation
of sync loops, async functions, generators, iterators, proxies,
`using`, and the upstream QuickJS test files — up to 365 slices in
separate processes, output identical to a straight run.

## Verdict: viable, sync-looking only

- The suspension mechanism works exactly as documented, including
  across processes and across exception delivery: a step can throw
  into a suspended call stack, and the workflow's try/catch/finally
  runs normally on resume. A full snapshot of the complex workflow is
  ~17 KB (an empty runtime is ~13 KB); deltas would be smaller
  (upstream reports 128 bytes after one call in the Rust example — not
  tested here).
- **Sync-looking is the only style** (decision 2026-11-15): the async
  variant (`stepAsync`) was dropped — no coherent argument for it when
  sync-looking works. The boundary stays documented: `await step()`
  throws `TypeError: this call cannot be suspended` (an async frame is
  not suspendable; see `quickjs.h`).
- The headline constraint: **one suspended execution per runtime, and
  a suspending call cannot be awaited.** The engine never suspends code
  running on behalf of native code (getters, `forEach` callbacks,
  promise reactions) — a request there stays pending until a later
  safepoint.

## What would need to be true for production use

1. **Accept the fork-maintenance bet.** dquickts is a small project
   (last commit 2026-11-11, four days before this test; tracks
   upstream QuickJS 2026-06-04; PRs landing that week). It is active
   now, but a fork this size can stall. Mitigations: vendor the tree,
   pin a commit, and keep the engine behind the `step` API so a swap
   stays possible.
2. **Same build everywhere.** A snapshot only loads into the same
   engine build (same version, same native registry in the same order,
   same word size). Fine if we ship one binary; a footgun if the
   registry ever drifts between writer and reader.
3. **Build cost.** `make` in the dquickts tree takes ~6 min wall on
   this VM (mostly `quickjs.c` at `-O2` plus the Python CAPI modules)
   and the build tree is ~330 MB with `-g` objects — too big for a
   512 MB `/tmp` (the default `make` fails there with "No space left
   on device" while linking the examples; `libquickjs.a`, `qjs` and
   `qjsc` build fine). Build on real disk.

Not tested here: incremental (delta) snapshots, or snapshot
determinism across machines.

## Reproduce

```sh
git clone https://github.com/stencil-hq/dquickts
cd dquickts && make            # needs >512 MB free; ~6 min on a small VM
cd ../agentts                  # or wherever this prototype lives
cd experiments/dquickts-prototype
make DQUICKTS=/path/to/dquickts
./run.sh
```

`run.sh` builds the host, drives each workflow through
run → suspend → snapshot → resume → complete, diffs stdout against
the expected output, and prints snapshot sizes and wall times.
Expected: `PASS sync` and `PASS complex`.

## Files

- `host.c` — the engine side: `print` and `step` builtins,
  `run`/`resume` driver, snapshot to disk. `resume` takes a plain
  result or `throw:<json>` to deliver an exception. ~260 lines.
- `workflow-sync.ts` — sync-looking workflow (2 steps).
- `workflow-complex.ts` — nested loops, branch-dependent steps,
  try/catch/finally, a throwing step (8 steps).
- `Makefile` — builds `proto` against a dquickts checkout.
- `run.sh` — end-to-end driver + checks. The mock maps a step's
  input to its result per workflow, keyed on op:value.
