# Building AgentTS from a clean checkout

This is the whole build: clone, vendor the engine, build the core,
install the host's dependencies, run the checks. Nothing here assumes
the machine this repo was developed on — no paths under anyone's home
directory, no pre-built trees. If a step below fails, the
[Troubleshooting](#troubleshooting) section at the end names the fix.

## Prerequisites

| Tool | Version | Check | Notes |
| --- | --- | --- | --- |
| `git` | any recent | `git --version` | Clones the repo and the engine upstream. |
| `cc` | any C99 compiler (gcc or clang) | `cc --version` | Builds the DurableTS C host. |
| `make` | any recent GNU make | `make --version` | Drives the C build. |
| `bun` | **1.4.4** | `bun --version` | Runs the TypeScript host, its checks, and the test suites. Install from https://bun.sh if missing. |
| network | — | — | `re-vendor.sh` clones `github.com/stencil-hq/dquickts`; `bun install` fetches the host's dependencies from the npm registry. |
| disk | ~500 MB free | — | The vendored engine tree is ~50 MB once built; the re-vendor work dir and the test scratch dirs are transient. |

Node is **not** needed: the host runs on Bun only (Node is present on
the dev VM but unused). No system-wide tooling is installed by any
step below.

## The engine, in one paragraph

The DurableTS C host links `libquickjs.a` from dquickts, a fork of
QuickJS with durable execution (suspend / snapshot / resume).
Upstream is `https://github.com/stencil-hq/dquickts`, pinned to a
single commit — currently **`96a9a79`** (2026-11-11); the pin lives in
[`packages/durablets/UPKEEP.md`](packages/durablets/UPKEEP.md), which
is the source of truth, so use the commit it names, never upstream
HEAD. The tree also carries a local patch, BRA-42
`JS_AbandonSuspended` ([`packages/durablets/dquickts-bra42.patch`](packages/durablets/dquickts-bra42.patch)),
which is not upstream. The engine is **never fetched at build time**:
`re-vendor.sh` (next step) clones upstream once, applies the patch,
trims the tree to the keep-list in
[`experiments/dquickts-prototype/TRIM.md`](experiments/dquickts-prototype/TRIM.md),
builds it, proves it against the full test suite, and installs the
proven tree as `packages/durablets/vendor/dquickts` — the core
Makefile's default. The build then consumes only that vendored tree.

## Steps

```sh
# 0. Clone
git clone https://github.com/brandf/agentts.git
cd agentts

# 1. Install the host's dependencies FIRST — before re-vendor.sh.
#    re-vendor.sh proves the engine by running the full test suite,
#    and the suite copies the host sources to scratch when
#    node_modules is missing. That configuration used to hit a bug
#    (BRA-101: the plugin dir pointed at the repo's plugins while
#    the host ran from scratch, so the adapter's HOLD symbol was not
#    the host's — "answer is not an Object"); run.sh now points the
#    plugin dir at the copied tree, so the order no longer matters
#    for correctness. Installing first is still the recommended
#    order: it keeps the prove run in place (faster, no copy).
#    Seconds once the registry is warm (23 packages each for the
#    host and the mock plugin).
cd apps/agentts
bun install
(cd plugins/mock && bun install)
cd ../..

# 2. Vendor the patched engine tree (once per checkout).
#    This clones upstream at the pinned commit, applies the BRA-42
#    patch, builds the trimmed tree, proves it with the full test
#    suite, and installs it as packages/durablets/vendor/dquickts.
#    Takes ~20 minutes on the dev VM, almost all of it the prove
#    step (clone ~1 min, engine build ~2 min, full suite ~16–22 min).
cd packages/durablets
./re-vendor.sh 96a9a79
cd ../..

# 3. Build the core C host (binary lands in packages/durablets/out/).
#    Plain `make` works now: the default is the vendored tree from
#    step 2. Seconds (~4s measured).
make -C packages/durablets durablets

# 4. Check the host works.
cd apps/agentts
bun src/cli.ts version
# agentts-host v0 (BRA-44), typescript 5.9.3

# 5. Run the hello quickstart (README.md, "Quickstart").
#    A hello workflow ships at apps/agentts/workflows/hello.ts.
#    ~13s for the three commands.
bun src/cli.ts check workflows/hello.ts --state-dir /tmp/agentts-quickstart/state
bun src/cli.ts run workflows/hello.ts --run-id run-hello \
  --input-file /tmp/hello-input.json --wait \
  --state-dir /tmp/agentts-quickstart/state
# Inline JSON works too: --input '{"name":"world"}' instead of
# --input-file; giving both is refused (exit 1).
```

## Full verification

The full test suite — core, host, swap, worker pool, scheduling,
tick driver — is one command from `apps/agentts/`:

```sh
./run.sh
```

It builds the core into a scratch dir, runs every suite into scratch
dirs, and exits non-zero on any mismatch. It writes nothing into the
tree it runs from (if `node_modules` is missing it copies the host
sources to scratch and installs there instead) — **except** the bench
suite, which writes `baselines.json` (updated baselines) and
`ratchet.log` (ratchet history) into `apps/agentts/bench/` when it
ratchets (see `apps/agentts/bench/README.md`). Takes ~16–22 minutes
on the dev VM. A green run is the proof a clean checkout builds and
behaves.

## Variations

- **You already have a patched dquickts tree** (e.g. from another
  checkout): skip step 2 and build with
  `make -C packages/durablets DQUICKTS=/path/to/dquickts durablets`.
  The tree must already be built (`libquickjs.a` present) and carry
  the BRA-42 patch. If the path is wrong, `make` fails fast with
  instructions instead of a cryptic linker error.
- **You want the vendored tree elsewhere**: run
  `./re-vendor.sh 96a9a79 --dest /path/to/dquickts` (or set
  `$DQUICKTS_DEST`), then build with `make DQUICKTS=/path/to/dquickts`.
  The default destination is `packages/durablets/vendor/dquickts`.
- **Re-vendoring to a newer upstream commit** (a maintainer task, not
  part of a clean build): `./re-vendor.sh <commit>` with the new pin,
  then update the pin in `packages/durablets/UPKEEP.md` by hand — see
  that file's "Vendoring procedure" section.

## Troubleshooting

- **`make` fails: "no patched dquickts tree at ... (libquickjs.a
  missing)"** — step 2 has not been run for this checkout (or the
  vendored tree was deleted). Run `./re-vendor.sh 96a9a79` from
  `packages/durablets`, or pass an existing tree with
  `make DQUICKTS=/path/to/dquickts`.
- **`re-vendor.sh`: "PATCH DOES NOT APPLY CLEANLY"** — the BRA-42
  patch no longer applies to the pinned commit. This needs a human:
  rebase the patch by hand, save the new diff to
  `packages/durablets/dquickts-bra42.patch`, and re-run. Do not ship
  a tree with a silently dropped patch.
- **`re-vendor.sh`: "KEEP-LIST FILE MISSING UPSTREAM"** — an upstream
  file on the TRIM.md keep-list was renamed or removed. Update the
  keep-list in `experiments/dquickts-prototype/TRIM.md`; do not skip
  the file silently.
- **`re-vendor.sh` fails cloning** — no network access to
  `github.com`, or the upstream repo moved. The build cannot proceed
  without the engine source; there is no fallback.
- **`bun install` fails** — no network access to the npm registry,
  or the wrong Bun version. Check `bun --version` is 1.4.4.
- **`bun src/cli.ts ...` fails: "C host binary not found"** — step 3
  has not been run, or the binary was built to a different `OUT_DIR`.
  Rebuild with `make -C packages/durablets durablets`, or set
  `$DURABLETS_HOST` to the built binary's path.
- **`re-vendor.sh` prove step fails in the host suite's
  cross-process gate: `answer is not an Object. (evaluating '"throw"
  in answer')`** — this was BRA-101: `run.sh` copied the host
  sources to scratch because `node_modules` was missing, then
  pointed the plugin dir at the repo's plugins, so the host and the
  direct adapter loaded two different copies of `src/adapter.ts`
  and the adapter's `HOLD` symbol was not the host's. Fixed:
  `run.sh` now points the plugin dir at the copied tree when the
  host runs from scratch, so the step order no longer matters. If
  this error appears, the BRA-101 branch in `run.sh` (the first
  `AGENTTS_PLUGINS_DIR` branch) is broken or regressed, or a new
  split-tree cause exists — check that the adapter's
  `src/adapter.ts` resolves to the same file the host imports
  (`tests/test-bra101.ts` asserts exactly that).
- **`./run.sh` fails in the bra71 suite, B3 ENGINE (`durablets-unknown`
  in the recorded engine version)** — this was BRA-103: `run.sh`
  copies the host sources to scratch when `node_modules` is missing,
  and the host locates the DurableTS package relative to its own
  file, so from the scratch copy (which holds `apps/agentts` only,
  not `packages/`) it cannot find `src/durablets.c` and records
  `durablets-unknown`. Fixed: `run.sh` exports
  `$AGENTTS_DURABLETS_DIR` (the package dir the binary was built
  from) and the host takes it as its first package-dir candidate.
  If this error appears, the export in `run.sh` (right after the
  `CORE` location block) is broken or regressed, or the host stopped
  honoring it — `tests/test-bra103.ts` asserts exactly that wiring.
- **`./run.sh` fails only in the bra67 suite, section A timing
  checks (`A TIMING` / `A SPAN` below their bounds)** — this is a
  known pre-existing timing assumption, not an engine or build
  problem. Section A sets a 30s cron target and bounds the re-drive
  wait at 12000–28000ms and the trap-to-completion span at
  15000–28000ms (BRA-102, KEEP — the earlier 15s target left only
  ~107ms of headroom on good days and failed outright on slow-start
  days; the bounds still discriminate the failure modes the test
  exists for: skipped wait ~4–6s vs one wait vs two waits ~36–48s).
  The recovery itself is correct: the run completes with the
  scheduled target and every journal assertion in the section
  passes. Suites after bra67 do not run, because `run.sh` stops at
  the first failing suite.
- **Tests fail in `./run.sh`** — the run keeps its scratch dir and
  prints the path on failure; inspect the logs there. A failure in
  the re-vendor prove step means the candidate engine tree is bad
  and is **not** installed — do not work around it by copying the
  tree by hand.
