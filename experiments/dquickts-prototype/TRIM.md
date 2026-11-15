# Trimming dquickts for AgentTS

dquickts ships a lot AgentTS doesn't need: Python 3.15, the Python C API,
Rust bindings, qbun, examples, tests, Intl/Temporal. The engine only needs
JS + TypeScript + durable execution (suspend/snapshot). Pinned upstream
commit: `96a9a79` (2026-11-11); dquickts tracks upstream QuickJS 2026-06-04.

## What the Makefile already makes optional

- **Python / C API**: `CONFIG_PYTHON=y` and `CONFIG_PYTHON_CAPI=y` are on by
  default, but the engine is `#ifdef CONFIG_PYTHON`-guarded throughout
  (quickjs.c, qjs.c, quickjs-snapshot.c). Command-line empty values turn them
  off — command-line assignments win over the Makefile's, and empty counts as
  unset for `ifdef`:
  `make CONFIG_PYTHON= CONFIG_PYTHON_CAPI= ...`
- **Intl / Temporal**: `CONFIG_TEMPORAL_INTL=y` by default;
  `make CONFIG_TEMPORAL_INTL=` drops it. No workflow uses Intl or Temporal.
  The Intl/Temporal code lives in its own translation units (`intl/`,
  `temporal/`) — nothing in the core includes them.
- **qbun** is never in the default `PROGS`; `make` doesn't build it unless
  asked. **rquickjs/** is a cargo project, not in the Makefile at all.
- Build only what we need: `make qjs libquickjs.a` instead of bare `make`
  (which also builds run-test262 and the examples). qjsc still gets built as
  a prerequisite — it generates repl.c from repl.js.

## The minimal tree

`~/workspace/dquickts-build-minimal` — a copy of the checkout with the fat
deleted:

```sh
git clone https://github.com/stencil-hq/dquickts dquickts-minimal
cd dquickts-minimal
git checkout 96a9a79   # pinned commit
rm -rf capi pylib rquickjs node examples tests fuzz tools doc intl temporal \
  run-test262 run-test262.c test262.conf test262o.conf \
  test262_errors.txt test262o_errors.txt \
  unicode_gen.c unicode_gen_def.h unicode_download.sh \
  gen-locale-data.js gen_tzdata.py hello.c test_fib.c \
  qpy.c qpy-base.c qbun.c readme-cosmo.txt release.sh TODO Changelog
find python -type f ! -name opcode.h -delete
find python -type d -empty -delete
```

Then build:

```sh
make CONFIG_PYTHON= CONFIG_PYTHON_CAPI= CONFIG_TEMPORAL_INTL= qjs libquickjs.a
# ~1m25s on this VM (1.5-CPU share); quickjs.c at -O2 dominates
```

## What must stay, and why

- `python/opcode.h` — the only unguarded Python include. quickjs.c includes
  it outside `#ifdef CONFIG_PYTHON`; it's an X-macro file (it includes
  itself) defining the Python subop table. Nothing else from `python/` is
  needed.
- `compat/` — the Makefile probes `compat/test-closefrom.c` at parse time.
- `repl.js` — qjsc generates repl.c from it; qjs needs repl.o.
- `LICENSE`, `README.md`, `VERSION`, `Makefile` — kept.

## What was cut

- `python/` (all but opcode.h), `pylib/`, `capi/` (the whole C API tree —
  with `CONFIG_PYTHON_CAPI` off, the Makefile's CAPI block never runs;
  verified: the minimal tree builds with `capi/` fully deleted),
  `rquickjs/`, `node/` + `qbun.c`, `examples/`, `tests/`, `fuzz/`,
  `tools/`, `doc/`, `intl/`, `temporal/`, the test262 harness, codegen
  helpers, `qpy.c`, `qpy-base.c`.
- Consequence: `make test-snapshot` (the engine's own snapshot suite) cannot
  run in the minimal tree — it lives in `tests/`. Run it from a full
  checkout. The prototype's `./run.sh` is the verification that matters
  here, and it passes.

## Measured sizes (2026-11-15, this VM)

| | full `make` (Python on) | minimal build |
|---|---|---|
| source tree | 58 MB git-tracked (514 MB as-is with .obj + binaries) | 4.0 MB |
| libquickjs.a (-g) | 85.6 MB | 14.4 MB |
| libquickjs.a (stripped) | 12.2 MB | 1.59 MB |
| qjs (-g) | 46.6 MB | 7.3 MB |
| qjs (stripped) | 12.1 MB | 1.49 MB |

libquickjs.a holds just 6 objects: quickjs.o (the engine incl. snapshot +
TS), dtoa.o, libregexp.o, libunicode.o, cutils.o, quickjs-libc.o. Python
alone was ~65 MB of the -g archive (85.6 → 20.4); Intl/Temporal was another
~6 MB of objects (20.4 → 14.4).

## Verification

Prototype rebuilt against the minimal tree
(`make DQUICKTS=.../dquickts-build-minimal`) and `./run.sh` passes both
workflows, output byte-identical to straight-through runs under the minimal
qjs (checked independently by running both workflows straight through with
a mock `step`):

```
=== sync (workflow-sync.ts) ===       exit=0 rounds=3  snapshot=14548 bytes  PASS sync
=== complex (workflow-complex.ts) ===  exit=0 rounds=9  snapshot=16916 bytes  PASS complex
```

## Re-enabling

- Python: drop the `CONFIG_PYTHON=` / `CONFIG_PYTHON_CAPI=` overrides (and
  restore `python/`, `capi/`, `pylib/` from a full checkout).
- Intl/Temporal: drop `CONFIG_TEMPORAL_INTL=` (and restore `intl/`,
  `temporal/`).
- qbun: `make qbun` (needs `node/` + `qbun.c` restored, plus curl/openssl/
  sqlite etc. via pkg-config).
