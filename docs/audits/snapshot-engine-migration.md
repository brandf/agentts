# Snapshot engine migration: making snapshots less engine-dependent

Status: investigation write-up (Nov 17, 2026). No code changed. This doc records
what the snapshot format actually contains, why a snapshot written by one
engine build refuses to load on another, and the migration paths available —
with the arguments for and against each.
A Linear issue tracks the follow-up investigation (see §8).

## 1. The problem

A durable run can park at a `gate` trap for days or weeks while a human
decides. Meanwhile the engine moves: the dquickts pin bumps, or `durablets.c`
changes. When the run resumes, the new engine refuses the old snapshot —
loudly, by design. Today the only options are:

- **Drain**: keep the old (host, engine) pair alive until the run finishes,
  and run new runs on the new engine. Works today, zero code. Fails for a
  run parked indefinitely — it never drains. Fails outright if the old engine
  can't run safely (a security flaw in it) — see §4.1.
- **Start fresh**: abandon the run and its accumulated state. Loses work.

This is a real-world post-MVP problem: any production run that outlives an
engine upgrade hits it. The question is what a migration path looks like
that preserves the snapshot approach's guarantees instead of abandoning them.

## 2. What a snapshot is (from source)

Format version 11 (`SNAP_FORMAT_VERSION 11`, `quickjs-snapshot.c:60`).
`JS_WriteSnapshot()` serializes the complete state of a runtime;
`JS_ReadSnapshot()` rebuilds it in a fresh runtime **of the same engine
build**, at arbitrary addresses and in any process.

Layout, in order (format comment, `quickjs-snapshot.c:1-58`):

| Section | Contents |
|---|---|
| header | magic `QJSSNAP\n`, format version, kind (full/delta), base id, build signature, class table |
| cells | one header per cell: what is needed to allocate it |
| changed | (delta only) indexes of the base cells whose body changed |
| atoms | atoms that are not predefined, with their kind |
| strings | string values, deduplicated by identity |
| roots | contexts, jobs, host roots, suspended execution; plus `Math.random()` state and the `performance.now()` time origin |
| bodies | one length-prefixed body per cell (full) or per changed/new cell (delta); a changed base cell can be a patch (prefix/suffix kept from base body, then the bytes between) |

Cells (objects, contexts, closure variables, heap frames, modules, function
bytecode, shared promise resolution records) are encoded as **indexes**. The
reader allocates every cell from its header before reading any body, so
bodies may reference cells in any order and cycles need no special handling.
A body only contains values, cell indexes and table indexes (atoms, strings,
natives): it never defines another entity, so it can be skipped or compared
byte for byte. That last property is what makes a converter tractable (§5).

**Not in the snapshot**: the journal (JSONL trap answers), the run queue,
the blob store / checkpoint manifests, and the frozen workflow closure.
Those live in the state dir in stable formats. A snapshot is the heap only.
Baseline size is ~36 KB for a trivial run, roughly 1:1 with the live heap
uncompressed (BRA-93).

## 3. Why a snapshot refuses a new engine — two layers, both loud

**Layer 1 — host version check.** `assertEngineVersion` (`apps/agentts/src/host.ts:998-1011`)
compares the recorded engine version against the running one. The version
string is source-derived: `dquickts-<pin>+durablets-<sha256[0:16] of durablets.c>`.
The hash covers the whole C file — even a comment change bumps it. On
mismatch the host journals `engine-version-mismatch` and throws: "refusing to
resume… snapshots are same-engine-only; restore the recorded engine build to
resume this run, or start a fresh run". The escape hatch
`AGENTTS_ENGINE_VERSION_OVERRIDE` bypasses only this layer.

**Layer 2 — engine reader checks.** `JS_ReadSnapshot` itself refuses on a
format-version mismatch ("unsupported snapshot version %u",
`quickjs-snapshot.c:3149-3150`) and on a build-signature mismatch
("snapshot was written by another engine build or with other host natives").
The signature is a hash of the native registry — code pointers stored in the
heap (C functions, job functions, lazily instantiated function list entries)
are encoded as indexes into a registry built from the engine function lists
plus the host natives, so a snapshot is only accepted by a compatible engine
and host. The format is also host byte order.

What each layer protects: layer 1 protects against host-side drift (the
trap/journal contract around the snapshot); layer 2 protects against the
reader misinterpreting bytes whose meaning changed. A migration must satisfy
both — a converted snapshot has to be a snapshot the new engine would have
written itself, including a matching signature, which the converter computes
under the new engine.

## 4. Approaches evaluated

### 4.1 Drain / dual-engine — works today, zero code, when the old engine can still run

Keep the old (host, engine) pair for in-flight runs; new runs start on the
new engine. The version check already isolates them. Caveats: the run's state
dir was written by its host version, so the (host, engine) pair must be
preserved together, not just the engine. A run parked indefinitely never
drains. And drain has a precondition the rest of this doc takes for granted:
the old engine must remain safe to run. If the reason for the upgrade is a
security problem in the old engine — a sandbox escape, a JIT bug, anything
that makes executing old code unsafe — drain is not an option at all. The run
is then stuck: it can't run on the old engine (unsafe) and can't resume on
the new one (refused). The only ways out are the converter (§5), which never
executes the old engine, or losing the run. A middle stopgap exists: backport
the security fix to the old pin and drain on the patched old build — but that
is maintaining a forked old engine under pressure, not a migration. This is
the interim answer, not the migration — and it isn't always available.

### 4.2 Journal replay

Replaying the journal from the start on the new engine: re-execute the
workflow, answering each trap from its recorded journal entry, until the run
reaches its parked position, then continue on the new engine.

Arguments for: it needs no knowledge of the snapshot format at all — no
converter, no per-pair work, no bytecode handling. It is the standard
approach in durable execution systems built on event logs. It works across
any engine change, including ones that change the bytecode format, the heap
layout, or the snapshot format itself, as long as the workflow's execution is
deterministic given the journaled answers. The journal already exists and
already answers dispatched traps (BRA-75), so part of the machinery is in
place.

Arguments against: it only works if the workflow's execution is deterministic
given the journal. Anything not captured in the journal can send the replay
down a different branch than the original run, producing a different state
that then continues as if it were the original. Random values are one case:
their state lives in the snapshot roots, which replay discards. Wall-clock
reads, floating-point behavior differences across machines or architectures,
iteration order of unordered structures, and host nondeterminism are others.
That risk grows with run length and with the number of traps. Replay also
pushes the determinism burden onto the workflow author: every workflow must
be written so that replay reproduces it exactly, and a workflow that isn't
deterministic fails at migration time, not at authoring time. And replay
re-executes work, so its cost is proportional to how far into the run the park
point is. The snapshot approach was chosen in the first place to avoid
carrying that determinism obligation — replay reintroduces it at migration
time.

Net: replay trades the converter's per-pair format work for a global
determinism requirement on all workflows. As a fallback, the condition is
concrete: replay works if workflows are limited to deterministic JavaScript
only — no unjournaled nondeterminism and no floating-point behavior that
differs across machines. That restriction would need enforcing (a gate check
on workflow code, or a runtime that journals the nondeterministic sources),
not just documenting, since a violation fails at migration time, not
authoring time.

### 4.3 Snapshot converter (translate) — bounded, mechanical, per version pair

A converter parses the old snapshot into its entities, remaps the tables,
and writes the new format. The format helps: indexed cells, length-prefixed
bodies, and bodies that pass through untouched when their layout didn't
change. Atoms and strings remap by table. Object and shape cells translate
field-by-field if their layout changed. The native registry remaps by name
and the new signature is computed under the new engine. The converter only
ever handles one specific version pair — the two versions actually in hand —
not arbitrary future versions.

The one part with real substance is bytecode: a bytecode cell's body is the
standard `JS_WriteFunctionTag` writer output (compiled code, constant pool,
debug info). If the bytecode format didn't change between the two versions,
the body passes through byte for byte and there is nothing to do. If it did
change, the converter needs either a bytecode-to-bytecode translation (a mini
compiler backend — needs both opcode tables, jump-target rebuilding) or the
strip-and-recompile design in §5. One property of the converter matters
beyond convenience: it reads the snapshot as data and never executes the old
engine. That is what makes it viable in exactly the case where drain fails
(§4.1) — an unsafe old engine.

Cost: real engineering, days to a couple of weeks for one pair, not a research
project. The test burden is the larger half: convert, resume, drive to
completion, and compare the outcome against the same run completed on the old
engine — plus a fault matrix proving bad conversions fail loudly at load
(the new engine's own reader validates version, signature, cell headers, and
constant-pool counts, so a malformed conversion fails at load, not silently).

### 4.4 Format stability as an upstream commitment

Versioned readers (the format already carries a version number) plus CI that
writes a snapshot under engine N and resumes it under N+1 — the SQLite
approach. Owned by dquickts upstream. It compounds: each format-stability
improvement makes every future converter cheaper or unnecessary, where a
converter alone is per-pair work that repeats at every upgrade.

## 5. Strip-and-recompile: the converter design

Instead of translating bytecode, strip it: drop every bytecode cell body,
recompile the source with the new engine, and re-link. The old bytecode
bytes are never interpreted — the converter only needs the old format's
container, not its bytecode encoding. Compared with translating bytecode,
strip-and-recompile trades the need to understand the old bytecode encoding
for a dependence on recompilation and on matching each bytecode cell to its
source.

### 5.1 The heap does not refer all over into bytecode

Only three things reference a bytecode cell, and all reference the cell as a
whole unit, by index (`quickjs-snapshot.c`):

| Referrer | Site | What it holds |
|---|---|---|
| Function objects | `:1192` | bytecode cell, home object, one var-ref per closure variable |
| Constant pools | `:894` (via `snap_put_value`) | nested function bytecodes |
| Suspended frames | `:1081` | bytecode cell, pc offset into its bytes, operand stack values |

The **only** thing pointing into the bytecode bytes is the frame's pc offset,
stored as `cur_pc - byte_code_buf` (`:1087`, read back at `:2508`). Everything
else references the cell. Stripping the bodies therefore breaks exactly one
thing per suspended frame (the pc), plus cell-to-source identity — and both
are recoverable.

### 5.2 The source is recoverable from the snapshot itself

Each bytecode cell carries `debug.filename`, `debug.source`, and
`debug.source_len` (`JSFunctionBytecode`, `quickjs.c:863+`). The bytecode
writer emits them into the serialized body unless stripping is enabled
(`quickjs.c:51376`: `if (b->debug.source && !s->strip_source)`), and the
reader reads them back (`:52626`). Nothing on the snapshot path sets the
strip flags — no `STRIP_SOURCE`/`STRIP_DEBUG` in `durablets.c` or `host.ts`
— so the source is in the snapshot. Verified on real files: all 9/9 and
11/11 bytecode cells in the measured snapshots carry debug info (§6). And
even if it weren't, the frozen workflow closure holds the workflow source.

### 5.3 The design

1. Parse the old snapshot (cells, atoms, strings, roots, bodies). A parser
   for this already exists as a measurement tool: `~/workspace/snap-measure.py`,
   derived from the reader and validated by exact-EOF consumption (§6).
2. For each bytecode cell, record its identity: filename, source, function
   name, definition line (from the pc2line table: the line of pc 0), and
   closure-variable names (`JSClosureVar.var_name`, `quickjs.c:797+`).
3. Recompile each distinct source file with the new engine.
4. Build the new snapshot with new bytecode cells, re-linked by index —
   every other cell keeps its index, so the graph structure is preserved
   for free.
5. Remap frame pcs via pc2line: old pc → source line → new pc. Only the live
   suspended stack needs mapping: a handful of frames, and their pcs sit at
   trap call sites, enumerable from the source. Frame operand stacks are
   data and carry over unchanged.
6. Deltas simplify: a keyframe-plus-delta pair converts into a single full
   snapshot in the new format. There is no need to preserve the chain
   structure — the new engine loads a full snapshot happily. (BRA-90
   deltas reference a base by id; conversion drops the chain.)
7. Realm mapping is mechanical: bytecode cells carry a realm reference;
   map old realm → new realm (typically one realm).

### 5.4 What needs care — all bounded

- **Identity key must be (file, name, definition line), not (file, name).**
  Duplicate anonymous functions in one file collide on name alone. The
  definition line comes from pc2line. Residual ambiguity (two anonymous
  functions defined on the same line) is resolved by compilation order,
  which is deterministic — and if it still can't be resolved, refuse loudly.
- **Closure layout must be verified by var name.** If the new compiler
  orders closure vars differently, the var-refs (by index) would attach to
  the wrong variables. Each closure var carries its name, so the converter
  checks the new bytecode's closure-var list against the old one by name
  and refuses loudly on mismatch.
- **`eval` / `new Function` is the one real edge case.** The source is a
  runtime string with a captured scope; recompiling it in isolation may
  produce a different closure layout. Refuse loudly if a cell can't be
  matched to a file.
- **Built-in JS functions**: QuickJS built-ins are C natives, not bytecode,
  so there should be no engine-provided bytecode to match — but refuse
  loudly if one shows up. The agentts host's JS (agentts module, plugins)
  is compiled from files in the frozen closure, so it is covered by the
  same mechanism.
- **Constant pools regenerate from recompilation.** Every cpool entry is
  derivable from source (constants, strings, nested functions). Nested
  functions become new bytecode cells, handled by the same re-linking.
- **pc remap granularity is lines.** If two suspension points share a line,
  the mapping is ambiguous — refuse that snapshot loudly and let it drain
  on the old engine. A converter doesn't have to handle every case; it has
  to handle the common ones and loudly refuse the rest.
- **Floating point adds no desync risk.** Heap values are bytes carried over
  as data; nothing is recomputed. Future computations on the new engine
  carry the same risk as any engine upgrade does for new runs — the
  converter adds none of its own. This is the fundamental difference from
  replay (§4.2).

## 6. Size bonus (measured): stripping bytecode shrinks snapshots

Stripping the bytecode bodies is also a size win, measured on real snapshot
files with `~/workspace/snap-measure.py` (a read-only parser derived from
`quickjs-snapshot.c`, validated by consuming exactly to EOF — the same check
the C reader's trailing-data error performs).

| File | Size | Cells | Bytecode cells | Bytecode body bytes | Compiled code only |
|---|---|---|---|---|---|
| `agentts-state/slices/smoke-test.snap` | 32,703 B | 302 | 9 | 14,070 B (**43.0%**) | 1,953 B (6.0%) |
| `agentts-state/slices/smoke-test-2.snap` | 32,708 B | 302 | 9 | 14,070 B (**43.0%**) | 1,953 B (6.0%) |
| `agentts-state/slices/smoke-test-3.snap` | 35,522 B | 320 | 11 | 15,915 B (**44.8%**) | 2,409 B (6.8%) |

Compiled code is only ~6–7% of the file. The bulk of a bytecode body is the
debug info — the embedded source text — plus constant pools and var tables.
Stripping removes the whole 43–45% on these small snapshots. (The atoms
section is the other large share at ~22%; object bodies ~25%. Those are
separate opportunities, out of scope here.)

**One nuance, stated plainly because it changes where the win lands:**
bytecode bodies are immutable during a run, so BRA-90 deltas already exclude
them — a delta only carries bodies that changed. Stripping therefore saves
**stored** bytes (the base/keyframe, which holds one copy of every bytecode
body) and base-write bytes, not per-suspension delta bytes. On a long run
the stored set is base + latest delta, so the saving is roughly the
bytecode share of the base — ~43% on the snapshots measured, smaller in
proportion on runs whose heap data dominates (trap results run 1–4 KB each
on realistic workloads), but the absolute saving is every bytecode body,
every keyframe rotation.

Stripping as a storage format needs the converter as the reader: a stripped
snapshot cannot resume on any engine without recompilation. That makes
stripping a storage-format change that depends on the converter existing
first.

## 7. Recommendation

1. Of the migration paths, the converter has the strongest case: it carries
   captured state as data (no determinism requirement on workflows), it never
   executes the old engine (so it works when drain can't), and its hard part
   — bytecode — has the strip-and-recompile design (§5) that avoids
   interpreting old bytecode entirely. Its costs are per-pair work and the
   test burden (§4.3).
2. Drain is the zero-code interim (§4.1), available when the old engine can
   still run safely. It isn't always available, and it avoids migration
   rather than performing it.
3. Format stability upstream (§4.4) is the path whose value compounds across
   upgrades; it is worth raising with dquickts alongside the existing patch
   conversation.
4. Replay (§4.2) trades the converter's per-pair format work for a global
   determinism requirement on all workflows. It is the standard approach in
   log-based durable systems. As a fallback it is viable if workflows are
   limited to deterministic JavaScript only — a restriction that would need
   enforcing, not just documenting.

## 8. Investigation task

Linear: [BRA-115](https://linear.app/brandf/issue/BRA-115/snapshot-engine-migration-investigate-converter-support-strip-and) (filed Nov 17, 2026, Medium, post-MVP investigation). Scope:

1. Measure the bytecode share across real workloads, not just smoke tests
   (bigger runs, real workflows, keyframed chains) — extend
   `~/workspace/snap-measure.py` or fold it into the repo as a tool.
2. Verify source presence in snapshots across workflows (all bytecode cells
   carry debug info? any `eval`/`new Function` cells in practice?).
3. Build the strip-and-recompile prototype: parse → strip → recompile →
   re-link → remap pcs. Needs two engine versions to test against — a newer
   dquickts pin, or an artificial bytecode change between two local builds.
4. Test: convert, resume, drive to completion, compare outcomes against the
   same run completed on the old engine. Fault matrix: ambiguous identity,
   eval'd function, closure-layout mismatch, unidentifiable bytecode — every
   one must refuse loudly, never guess.
5. Decide where the converter lives (host tool, e.g. `agentts snapshot
   convert`, vs dquickts-side support) and file the upstream format-stability
   issue.

## Sources

- `~/workspace/dquickts-build/quickjs-snapshot.c` — format comment (:1-58),
  cell types (:62-80), `snap_write_bytecode` (:829-840), frame body (:1075-1100,
  pc at :1087, read back :2508), function-object body (:1192),
  `snap_read_header` (version/signature checks), `snap_read_cell_headers`
  (bytecode header incl. `byte_code_len`), `JS_ReadSnapshot` flow.
- `~/workspace/dquickts-build/quickjs.c` — `JSFunctionBytecode` (:863+,
  debug section with filename/source/pc2line), `JSClosureVar` (:797+,
  `var_name`), bytecode writer emitting debug source (:51376),
  bytecode reader allocating debug source (:52626), `debug.source` set at
  compilation (:49452).
- `~/workspace/agentts-repo/apps/agentts/src/host.ts` — `engineVersion()`
  (:742), `assertEngineVersion` (:998-1011).
- `~/workspace/agentts-repo/docs/audits/bra90-incremental-snapshots.md` §11 —
  write-amplification measurements (76,211 B vs 1,025,460 B on a real
  30-suspension run); delta/bodies structure.
- Measurement tool: `~/workspace/snap-measure.py` (this write-up's §6).
