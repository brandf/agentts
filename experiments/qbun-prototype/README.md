# qbun prototype — can qbun host a durable workflow?

**Verdict: NO for the workflow host. YES for the step-execution side.**

qbun runs its modules fine, and a durable `step()` builtin can be
registered in it — but `step()` can never suspend from module code, and
a qbun runtime cannot be snapshotted. Those are two independent,
root-caused blockers (details below). The durable workflow host stays
the minimal engine in `experiments/dquickts-prototype/` (plain scripts
evaluated by the host, where suspension works). qbun is the right host
for *executing steps*: a step is an ordinary qbun program with full
`node:` / `Bun` module access, and its result is handed back to the
workflow host across the step boundary.

Date: 2026-11-15. qbun 1.4.4, built from stencil-hq/dquickts
(last commit 2026-11-11 at the time; tracks upstream QuickJS 2026-06-04).

## What was proven

### 1. qbun builds and its modules work — PASS

`test-modules.ts` under the patched qbun, exit 0, output ends
`MODULES OK`:

```
fs read: "hello fs\n"
bun read: "hello bun\n"
child_process: "child-process-works"
fetch: 200 "<!doctype html><html lang=en><head><meta charset=utf-8>..."
MODULES OK
```

Each check has a real observable effect: `node:fs` writes/reads a
real file, `Bun.write`/`Bun.file` writes/reads a real file,
`node:child_process` `execSync` runs a real subprocess, `fetch`
hits `https://example.com` and returns a real 200 + HTML body.

### 2. A workflow under qbun cannot suspend — FAIL (blocker A)

Both workflows throw the same error at the `step()` call, exit 1,
no snapshot file:

```
fs read back: "item 7\n"
child said: "7"
[qbun-step] step({"op":"score","value":7}) - suspending
TypeError: this call cannot be suspended
    at step (native)
    at <anonymous> (.../workflow-qbun-sync.ts:19:15)
```

The sync workflow (`workflow-qbun-sync.ts`) uses only synchronous
module APIs and no top-level await — the fs/child lines above it run
fine, then `step()` throws. The async workflow
(`workflow-qbun-async.ts`, awaits `Bun.file(...).text()` first)
throws identically at its `step()` call. Two isolation runs rule out
imports and top-level await as the cause:

- a module with **no imports at all** calling `step()` at top level —
  same `TypeError`;
- `qbun -e 'const a = step(...)'` — same `TypeError`.

So it is not the imports and not `await`: **module evaluation itself
does not present a suspendable frame.**

#### Root cause (read in the engine source, not guessed)

`JS_SuspendCall` (quickjs.c) throws unless
`js_can_suspend_from(rt, rt->native_caller_frame)` returns true. That
check walks the whole frame chain and requires **every** frame to be a
normal bytecode function (`func_kind == JS_FUNC_NORMAL`), entered
either directly by the previous frame (`JS_FRAME_ENTRY_DIRECT`) or,
at the bottom, by the host (`JS_FRAME_ENTRY_HOST`, which must be the
outermost frame). It returns true only via the HOST branch.

Module code fails this by construction: `js_execute_sync_module`
(quickjs.c) invokes the module's eval function via
`js_async_function_call` — the module function is entered as an
**async** function, so the very first frame on the walk fails the
`func_kind` test. The module frame is never a HOST frame (module
evaluation goes through `JS_LoadModule` → `JS_EvalFunction` →
`js_evaluate_module` → `js_inner_module_evaluation` →
`js_execute_sync_module`, an internal call path, not a host entry
point). A sync helper function called from module top level would
fail too: the walk reaches the async module frame and returns false.

Consequence: under qbun, where every entry point is a module
(`qb_run_main` uses `JS_LoadModule`; `qb_run_eval` compiles as a
module; the CJS path goes through the bootstrap's `runMain` hook,
also JS code, so its outermost frame is not a HOST frame either),
**no `step()` call can ever suspend**. The only suspendable entry
points are plain scripts evaluated with `JS_Eval` (proven in the
bare-engine probe, mode 2: the suspend itself worked) or plain sync
functions called directly by the host — which is exactly what the
minimal prototype host in `experiments/dquickts-prototype/` does.

### 3. A qbun runtime cannot be snapshotted — FAIL (blocker B)

Independent of blocker A: even if suspension worked, `JS_WriteSnapshot`
fails on a qbun runtime. Proven with `snap-probe.c` (a minimal C host
linking the same `libquickjs.a`, registering only `step` + `print`):

| probe mode | result |
|---|---|
| 0 — plain runtime, no intrinsics | snapshot OK, **13,185 bytes** |
| 1 — only `JS_AddIntrinsicTemporal` + `JS_AddIntrinsicIntl` added | snapshot FAILED: `TypeError: snapshot: unregistered native code pointer 0x...` |
| 2 — intrinsics + suspend via `step()` | the SUSPEND worked (`JS_IsSuspended` true), snapshot FAILED with the same error |
| 3/4 — `Intl.DateTimeFormat` / `Temporal.PlainDate` instance | snapshot FAILED, same error |

Why: `snap_builtin_lists` in quickjs-snapshot.c contains no
Temporal/Intl function lists, and the Temporal/Intl C functions and
tables are `static` inside temporal.c / intl/*.c, so a host outside
the engine cannot list them in `JSSnapshotHost`. The quickjs.h docs
list "contexts with the Intl or Temporal intrinsics" as unsupported
for snapshots. qbun **always** adds both intrinsics in
`qb_runtime_new` (node/core.c), so every qbun runtime is
unsnapshottable as shipped.

A second, untested half of blocker B: even without the intrinsics, a
snapshot host would have to list **all** node binding natives
(function lists in node/*.c — `JS_SetPropertyFunctionList` call sites
in core.c, crypto.c, fs.c, http.c, net.c, process.c, sqlite.c, tls.c,
worker.c, zlib.c, plus class methods, C module inits and
`JS_NewCFunction` calls; hundreds of functions total, tables static
per file). The `qjs --drepl` works only because its heap contains
almost no host natives. Whether that listing is practical was not
tested — it is moot while blocker A stands.

### 4. The no-intl build — settles half of blocker B, changes nothing else

A separate copy (`CONFIG_TEMPORAL_INTL=` empty, Makefile gates the
flag and the intl/temporal objects cleanly) builds and boots:

- `./qbun --version` → 1.4.4; binary 45.3 MB vs 48.5 MB with intrinsics.
- `typeof Temporal, typeof Intl` → `undefined undefined` (vs
  `object object` in the intl build) — the intrinsics are genuinely gone.
- `test-modules.ts` passes fully (fs, Bun.file, child_process, fetch).
- `node/lib` does not need the intrinsics at runtime for these
  modules (`Intl.` appears in 3 files, `Temporal.` in 0 — grep
  counts; none of the exercised paths touched them).

With the step patch applied to the no-intl tree, the sync workflow
fails with the **identical** `TypeError: this call cannot be
suspended` at the same line. So the suspend failure is
intrinsics-independent, as the root cause predicts. The no-intl build
removes the Temporal/Intl half of blocker B in principle; the
node-natives listing half and blocker A remain. No snapshot of a
no-intl qbun heap was attempted: suspension never occurs in module
code, so the snapshot path is never reached.

### 5. Does the event loop interfere with suspension?

No — it never gets the chance. The failure happens during module
evaluation, before `qb_run_loop` runs. The loop is irrelevant to the
suspend failure. (Separately, event-loop state is native and would
not survive a snapshot anyway — a further reason the workflow host
and the qbun step executor stay separate.)

## The step hosting patch

`--preload` cannot register a suspending builtin (preload code is
itself module code — see blocker A), so the patch is in the qbun
startup code itself, in the local tree only (see
`dquickts-local-patches.diff`):

- **`qbun.c`** — `qb_step` C function (logs the call, returns
  `JS_SuspendCall`), `qb_try_snapshot` (`JS_WriteSnapshot` with a
  host listing only `qb_step`; writes to `$QBUN_STEP_SNAP` or
  `qbun-step.snap`; prints success/failure to stderr), and
  registration of the `step` global on the main context after
  `qb_bootstrap` and before `qb_run_main`. If `qb_run_main` /
  `qb_run_eval` returns 2, `main()` attempts the snapshot and exits
  2 on success, 1 on failure. The CJS entry path via the `runMain`
  hook is NOT patched — it would swallow a suspension; the
  experiments use ESM `.ts` workflows.
- **`node/core.c`** — `qb_watch_main` now returns 2 (instead of
  reporting the suspension marker as an uncaught exception) when the
  entry evaluation returns an exception and `JS_IsSuspended(qr->rt)`
  is true. Covers both `qb_run_main` (`JS_LoadModule`) and
  `qb_run_eval`.

The patch is small and correct as far as it goes: `typeof step` is
`function` in the patched builds, and the `[qbun-step] ... suspending`
log line appears before the engine throws. The throw comes from the
engine's suspendability check, not from the patch.

## Building qbun (what it took on this VM)

Linux VM, CPU-only. The tree is a local copy of stencil-hq/dquickts;
do not build in anyone else's tree.

Dev headers the VM lacked (runtime libs were present, `-dev` was
missing) — installed via `sudo apt-get`:

```
libuv1-dev libcurl4-gnutls-dev libsqlite3-dev libjpeg-turbo8-dev libwebp-dev libgif-dev
```

Already newest: `zlib1g-dev libffi-dev libbrotli-dev libpng-dev`.
`libzstd-dev` could **not** be installed via apt (depends on
`libzstd1 = 1.5.5+dfsg2-2build1.1` but `1.5.5+dfsg2-2build1.1+hatch1`
is installed — held broken packages). Workaround: extract the
`libzstd-dev.deb` (1.5.5+dfsg2-2build1.1) into
`<tree>/.deps/usr/` with `dpkg-deb -x`, fix its `.pc` (prefix/libdir
rewritten to the `.deps` path), build with

```
PKG_CONFIG_PATH=<tree>/.deps/usr/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH make qbun
```

The upstream code assumes newer libraries than the VM has (system:
OpenSSL 3.0.13, libcurl 8.5.0, libuv 1.48.0, zstd 1.5.5). Local
compat patches, all in `dquickts-local-patches.diff` (8 files,
111 insertions, 3 deletions):

- `node/crypto.c` (+11): Argon2 KDF params and the signature context
  string (OpenSSL 3.2+) guarded with
  `#if OPENSSL_VERSION_NUMBER >= 0x30200000L`, else fail loudly.
- `node/zlib.c` (+4): `ZSTD_c_targetCBlockSize` and
  `ZSTD_error_cannotProduce_uncompressedBlock` (zstd 1.5.6+) guarded
  with `#if ZSTD_VERSION_NUMBER >= 10506`.
- `node/http.c` (+2): `CURLWS_NOAUTOPONG` (curl 8.14+) guarded with
  `#if LIBCURL_VERSION_NUM >= 0x080e00` (skipped on 8.5; libcurl then
  auto-replies to pings as well as the code's own pong handler).
- `node/napi.c` (+1): added `#include "../cutils.h"` — `TRUE`/`FALSE`
  come from an enum in cutils.h; napi.c used them without it.
- `node/tls.c` (+15, −3): `SSL_get0_group_name` (OpenSSL 3.5+)
  replaced with a `QB_SSL_GET0_GROUP_NAME` macro returning NULL
  below 3.5 (callers fall back to the key type name or skip the
  hybrid-group branch).
- `node/worker.c` (+8): `uv_thread_detach` (libuv 1.50+) guarded;
  below 1.50 falls back to `uv_thread_join` (waits for the stopped
  thread; both sites are after `qb_worker_stop_locked`, both guarded
  by `thread_started`).
- `node/core.c` (+5) and `qbun.c` (+68): the step hosting patch above.

Full build `make qbun` takes ~4–6 min on a small VM. The no-intl
variant: `make qbun CONFIG_TEMPORAL_INTL=` (empty value disables
the flag; the Makefile gates it cleanly).

## Reproduce

```sh
git clone https://github.com/stencil-hq/dquickts
cd dquickts
# install the dev packages above; apply the zstd shim if apt refuses libzstd-dev
# apply dquickts-local-patches.diff (paths are repo-relative)
git apply dquickts-local-patches.diff
PKG_CONFIG_PATH=$PWD/.deps/usr/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH make qbun
./qbun --version   # 1.4.4

# 1. modules work
./qbun test-modules.ts            # ends "MODULES OK", exit 0

# 2. workflow + step fails at step() — both variants
QBUN_STEP_SNAP=/tmp/qbun-step.snap ./qbun workflow-qbun-sync.ts    # exit 1, TypeError
./qbun workflow-qbun-async.ts                                     # exit 1, TypeError

# 3. snapshot blocker probe (links against the tree's libquickjs.a)
cc snap-probe.c -I. -L. -lquickjs -lm -o /tmp/snap-probe
/tmp/snap-probe 0   # snapshot OK: 13185 bytes
/tmp/snap-probe 1   # snapshot FAILED: unregistered native code pointer
/tmp/snap-probe 2   # suspend works, snapshot FAILED (same error)
```

## Files in this experiment

- `README.md` — this file.
- `test-modules.ts` — module smoke test (PASS).
- `workflow-qbun-sync.ts` — sync workflow + `step()` (FAIL: TypeError).
- `workflow-qbun-async.ts` — async workflow + `step()` (FAIL: TypeError).
- `snap-probe.c` — minimal C host proving the snapshot blocker
  (bare runtime OK; +Temporal/Intl fails). Known wart: the mode-2
  resume check passes a JSON string with length 15 for a 14-char
  string, so the resume half of mode 2 was not properly exercised —
  the snapshot failure in mode 2 is the finding that matters and is
  unaffected.
- `dquickts-local-patches.diff` — the full local diff against the
  dquickts tree: VM compat patches + the step hosting patch
  (qbun.c, node/core.c). Apply with `git apply` in a dquickts tree.
  The engine tree itself is NOT committed here (hundreds of MB).

## What is rough / broken / untested

- The patches are local to this VM's library versions (see "Building
  qbun"); on a machine with OpenSSL ≥ 3.2 / libcurl ≥ 8.14 /
  libuv ≥ 1.50 / zstd ≥ 1.5.6 most of the compat guards are no-ops.
- The zstd `.deb` shim is a local workaround, not a fix.
- The CJS entry path is unpatched (the `runMain` hook would swallow
  a suspension); only the ESM path was exercised.
- No snapshot of a no-intl qbun heap was attempted (unreachable:
  suspension never occurs in module code). The node-natives host
  listing for a snapshot was not attempted either.
- A plain script suspending under the qbun runtime specifically was
  not tested (no CLI for it); the bare-engine probe proves scripts
  suspend, but workflows are modules, so the configuration is not
  one anyone would use.
- `snap-probe.c` mode-2 resume check has the off-by-one noted above.

## What this means for AgentTS

Keep the split the prototype already has: the **workflow host is the
minimal engine** (`experiments/dquickts-prototype/` — host evaluates
plain scripts / calls plain sync functions, `step` is the only
builtin, snapshot + journal are the resume story). **qbun is the
step executor**: when a step needs the OS — files, subprocesses,
network, SQLite, `Bun` APIs — run it as a qbun program (or as a
child qbun process) behind the step boundary, and hand its result
back to the workflow host. Nothing in this experiment changes the
resume mechanism decision (dquickts, confirmed) — it only rules out
collapsing the workflow host into qbun.
