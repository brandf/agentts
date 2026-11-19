# BRA-90 incremental snapshots — measurement + design

- **Date:** 2026-11-17
- **Linear:** BRA-90 (project AgentTS) — "Investigate incremental snapshots
  (JS_SNAPSHOT_BASE/DELTA) for large-heap runs". Status: Backlog, MVP blocker.
  **Investigation only — no adoption decision here.** Brandon decides adoption;
  this doc is the numbers + design the decision rests on.
- **Sequencing:** BRA-90 is sequenced after BRA-83 (save_snapshot atomicity).
  Nothing here changes the default path.
- **Design direction (already decided, Nov 16, 2026 — Brandon, delegated to
  Meroki):** snapshot chain linked by content hash, like git commits; a fork
  branches by referencing the fork-point checkpoint by hash and extends its
  own chain rather than copying; always-on with no heap-size threshold (KISS,
  one mode). Adoption still gated on measurements — if deltas turn out near
  full-size on realistic workloads, the chain is not adopted. This doc tests
  that gate and fills in the design under that direction.
- **Method:** prototype C host + measurement harness, both in
  `experiments/bra90/`. The stock `packages/durablets/src/durablets.c` is
  NOT modified (zero `BRA-90` references in it). The prototype is a copy,
  `experiments/bra90/durablets-delta.c`, with opt-in delta mode behind
  `DURABLETS_DELTA=1` (off by default; verified: the prototype binary
  without the env var writes plain full snapshots and no `.base`/`.meta`
  files). `run.sh` is untouched. All runs used a scratch state dir under
  `/tmp` (latest full run: `/tmp/bra90-measure-pMWq0T`); the production
  state dir and tick agent were never touched. Engine: vendored dquickts
  pinned commit `96a9a79` (2026-11-11) + BRA-42 patch. Harness drives the
  C host directly (`run` / `resume` / `branch`), with canned deterministic
  trap answers, so full-mode and delta-mode runs hold byte-identical heaps
  and must produce identical stdout + `<snap>.result.json` — they did, on
  every workload (assertion-checked by the harness).
- **Reproduce:** `bun experiments/bra90/measure.ts` (builds both binaries
  into a fresh scratch dir, runs all workloads + checks, writes
  `experiments/bra90/results-<date>.json`). Latest results:
  `experiments/bra90/results-2026-11-17.json`. Full run: all checks passed.
- **Follow-up 2026-11-17 (same day): keyframe hybrid + heap shape.**
  Brandon's comment on BRA-90 asked for the video-codec hybrid
  (periodic full keyframes + deltas between them, §8) and for heap-shape
  measurements (equal bytes at different allocation shapes, §9), plus
  the attached-base memory/pinning analysis (§10). Prototype extended
  in place (keyframes behind `DURABLETS_KEYFRAME_INTERVAL`, off by
  default); second harness `experiments/bra90/measure-keyframes.ts`,
  results `experiments/bra90/results-keyframes-2026-11-17.json`
  (all checks passed). The original harness was re-run after the
  prototype change and reproduces every §2 number exactly (same totals
  to the byte) — no regression. §3 (rebase policy) and §5
  (recommendation) are revised below in light of §8–§10; the rest of
  §1–§7 stands as the original investigation.

## 1. What was measured

Workloads (in `experiments/bra90/workflows/`):

| Workload | Shape | Suspensions |
|---|---|---|
| control-1k | Issue reproduction: one live string, 1,024 B, held across 3 sleep traps | 3 |
| control-500k | Same, 512,000 B live string | 3 |
| control-2m | Same, 2,097,152 B live string (large-heap scaling) | 3 |
| briefing | Briefing-style: 6 papers fetched (trap result carries a ~3 KB body, stored), 6 refine traps (~1 KB notes each); drafts + running brief held live, nothing dropped | 12 |
| judgefix | JudgeFixLoop-style: 2 rounds × 3 judges (~2.5 KB verdict notes each, held live) + a ~4 KB revised draft per round that REPLACES the previous draft (churn) + aggregate | 9 |
| churn | Worst case: a ~20 KB document REPLACED in full by each rewrite trap result | 6 |

Realism note: the briefing/judgefix text is synthetic but realistic-shaped
(real sentences, realistic sizes — 1–4 KB per trap result, the size class
real LLM outputs arrive in). What is measured is snapshot bytes as a
function of live-heap bytes and heap churn between traps, which is exactly
the quantity the decision turns on; the text content itself is irrelevant
to the engine. The control workloads reproduce the issue's setup and its
~1:1 law (baseline ~15 KB for my workflow vs the issue's ~35 KB for theirs
— baseline differs by workflow, the law does not: 512,000 B live →
526,283 B full snapshot).

## 2. Measured results

### 2.1 Totals (bytes written across the whole run; stored = what the blob store holds at the end)

| Workload | Susp. | Full total written | Delta total written | Delta/full | Stored full (last snap) | Stored delta (base + last delta) |
|---|---|---|---|---|---|---|
| control-1k | 3 | 45,885 | 15,494 | 0.338 | 15,295 | 15,383 |
| control-500k | 3 | 1,578,849 | 526,482 | 0.333 | 526,283 | 526,371 |
| control-2m | 3 | 6,334,290 | 2,111,629 | 0.333 | 2,111,430 | 2,111,518 |
| briefing | 12 | 342,829 | 180,601 | 0.527 | 42,178 | 42,331 |
| judgefix | 9 | 232,192 | 113,847 | 0.490 | 34,485 | 34,634 |
| churn | 6 | 188,596 | 117,378 | 0.622 | 34,844 | 34,958 |

### 2.2 Per-suspension detail (full size → delta size)

**control-1k** (base 15,272): susp 0: 15,295 → base 15,272; susp 1: 15,295 → **111**;
susp 2: 15,295 → **111**.

**control-500k** (base 526,260): susp 0: 526,283 → base 526,260; susp 1: 526,283 → **111**;
susp 2: 526,283 → **111**.

**control-2m** (base 2,111,407): susp 0: 2,111,430 → base 2,111,407; susp 1: 2,111,430 → **111**;
susp 2: 2,111,430 → **111**.

**briefing** (base 14,893):

| Susp. | Trap | Full | Delta | Delta/full |
|---|---|---|---|---|
| 0 | job:fetch | 14,916 | 14,893 (base) | 1.000 |
| 1 | job:refine | 18,513 | 3,763 | 0.203 |
| 2 | job:fetch | 19,702 | 4,951 | 0.251 |
| 3 | job:refine | 23,246 | 8,506 | 0.366 |
| 4 | job:fetch | 24,435 | 9,684 | 0.396 |
| 5 | job:refine | 27,979 | 13,239 | 0.473 |
| 6 | job:fetch | 29,168 | 14,417 | 0.494 |
| 7 | job:refine | 32,712 | 17,972 | 0.549 |
| 8 | job:fetch | 33,901 | 19,150 | 0.565 |
| 9 | job:refine | 37,445 | 22,705 | 0.606 |
| 10 | job:fetch | 38,634 | 23,883 | 0.618 |
| 11 | job:refine | 42,178 | 27,438 | 0.650 |

**judgefix** (base 14,927):

| Susp. | Trap | Full | Delta | Delta/full |
|---|---|---|---|---|
| 0 | job:judge | 14,950 | 14,927 (base) | 1.000 |
| 1 | job:judge | 17,539 | 2,735 | 0.156 |
| 2 | job:judge | 20,103 | 5,299 | 0.264 |
| 3 | job:fix | 22,693 | 7,901 | 0.348 |
| 4 | job:judge | 26,753 | 11,965 | 0.447 |
| 5 | job:judge | 29,317 | 14,529 | 0.496 |
| 6 | job:judge | 31,881 | 17,093 | 0.536 |
| 7 | job:fix | 34,471 | 19,691 | 0.571 |
| 8 | job:aggregate | 34,485 | 19,707 | 0.571 |

**churn** (base 14,353): susp 0: 14,376 → base 14,353; susp 1–5: 34,844 → **20,605**
(0.591) each — flat, because every suspension replaces the same ~20 KB.

### 2.3 The law (holds at every measured point)

```
delta ≈ full − base + ~100–150 bytes
```

Check: briefing susp 11: 42,178 − 14,893 = 27,285; measured delta 27,438
(+153). Judgefix susp 8: 34,485 − 14,927 = 19,558; measured 19,707 (+149).
Churn: 34,844 − 14,353 = 20,491; measured 20,605 (+114). Control: delta
111 B against an unchanged heap (framing + trap counter + roots only).

In words: a delta saves exactly the base's bytes, every suspension. The
saving is bounded by how much of the heap is stable since the base, and
the delta grows monotonically with heap growth since the base — it is
NOT a fixed small size. Consequences:

- **Write amplification is where the win lives.** Total bytes written
  fall 2–3× on realistic runs (0.49–0.53) and 3× on stable-heap runs
  (0.33 at only 3 suspensions; the ratio tends toward ~0 as suspension
  count grows against a fixed base). At the drive cap of 50 suspensions
  the realistic-run ratio would be far below 0.5.
- **Stored bytes do NOT shrink.** Base + last delta = last full + ~150 B,
  on every workload (e.g. briefing 42,331 vs 42,178). The base duplicates
  the early state. Delta mode is a write optimization, not a storage
  optimization — do not sell it as one.
- **Even the worst case is nowhere near full-size.** Whole-heap churn
  (churn workload: every byte of live state replaced between traps) still
  yields deltas at 59% of full, because the delta omits the unchanged
  bytecode/module cells (~14 KB base). The issue's "delta approaches full
  size" failure mode does not occur at any churn level reachable by these
  workloads: the floor is set by (new content) vs (new content + base),
  and the base is mostly code, which never churns.

### 2.4 Fork check (branch from a delta-mode snapshot)

Workflow `tests/workflow-judges.ts` (`all()` with 3 branches), delta mode:
parent suspends at `all()` (rc 3) with snap = base = 15,629 B. Branch 0,
started from a copy of the pair (snap + `.base` + `.meta`), suspends at
its first trap with a **853 B delta** against the shared 15,629 B base;
after one resume, 889 B. Full mode for comparison: branch snap 15,788 B
after the same step. So with a shared base, a branch copy costs ~0.85 KB
instead of ~15.8 KB — an 18× reduction per branch, and it grows with
parent heap size (at a 500 KB parent heap the branch copy would be ~500 KB
full vs ~1 KB delta). Forks are where the saving is largest in both
relative and absolute terms, and this is the mechanism the decided
hash-chain direction exploits (branch references the fork-point checkpoint
by hash; it does not copy the base).

### 2.5 Base reproducibility (rebuild instead of store)

Two fresh processes, same bundle path + same run id, run to suspension 1
in delta mode: base files byte-identical (sha256 `c0d83d06…`, 15,265 B).
The header's reproducibility claim holds — **provided the inputs are
identical**. The run id is a snapshotted heap global and the bundle path
is the eval filename, so both are part of the bytes; a rebuild must use
the same bundle (frozenHash/frozenPath, BRA-71) and the same run id.
(First version of this check used different run ids and failed — harness
bug, not an engine finding; fixed in `measure.ts` with a comment.)

## 3. Pairing / lifecycle design (under the decided hash-chain direction)

The prototype pairs by sibling filename (`<snap>.base` + `<snap>.meta`
with `{"kind":"base"|"delta"}`), gated on file existence. That is
**prototype-only and must not ship**: a filename is not an identity, and
the prototype's three writes (base, snap, meta) are not atomic as a
triple. The production design follows the decided direction:

- **Checkpoint = (base-hash, delta-bytes), content-addressed.** Each
  checkpoint names its base by sha256 of the base bytes, like a git
  commit naming its parent. The blob store keys the base by that hash;
  a delta is meaningless without the base it names, and the name makes a
  wrong pairing unrepresentable in the store's own terms (the engine
  additionally rejects a mismatched pair at read time — measured §4).
- **Base creation:** first suspension of a run writes the base (full
  snapshot, `JS_SNAPSHOT_BASE`) once; it is immutable thereafter.
  Subsequent suspensions write deltas against it. The base may be
  **stored** (simplest, one extra file per run) or **rebuilt** (re-run
  `run` to the first trap with the same bundle + run id — verified
  byte-identical in §2.5, and needs no trap results since suspension 1
  precedes any result). Decision: **store the base**; rebuilding is a
  documented fallback for a lost/corrupt base, not the primary path,
  because rebuilding re-executes workflow code up to the first trap and
  couples recovery to the frozen bundle being re-runnable.
- **Forks:** a branch references the fork-point checkpoint by hash and
  extends its own chain; the base file is shared, never copied per
  branch (§2.4: 853 B vs 15,788 B per branch). The store must refcount
  (or mark-and-sweep at repair time) bases referenced by live branches:
  a base is collectable only when no live checkpoint — run or branch —
  names it. Queue repair (BRA-72) treats a referenced base as live.
- **Rebase policy — REVISED (§8): the rebase IS the keyframe.** A rebase
  writes a periodic full snapshot with `JS_SNAPSHOT_BASE` — a keyframe
  — which replaces the attached base, so later deltas are relative to
  it. The rule, as prototyped and measured (§8.2): write a keyframe
  when the latest delta exceeds 75% of the estimated full snapshot
  (`delta/(base+delta) > 0.75`, from the §2.3 law `full ~= base + delta`)
  OR every 25 suspensions, whichever comes first; **interval 25 is now
  the measured recommendation, not just a cap** (two independent fits
  to the §8.4 totals put the write optimum at ~23–24 suspensions, §8.5).
  Measured behaviour of the two triggers (§8.6): the 75% rule fires
  once, early (accumulate run, ordinal 20, when the base is still
  small) and then never again — once the base is large, the firing
  interval for the ratio rule grows with heap size (it needs
  `delta > 3 × base`, i.e. more than `3 × base/growth-per-suspension`
  suspensions), so the interval rule always wins. The ratio rule is an
  early-run backstop for fast growth on a small base, not a
  steady-state mechanism. A rebase writes a new base file under its
  new hash and a checkpoint naming it; the old base stays until
  unreferenced. No delta is ever rewritten. One measured limit: a
  keyframe does NOT reset the delta to "growth since keyframe" for
  workloads that rebuild a large aggregate each suspension — the
  rebuilt aggregate is a new cell and is written whole in every delta
  (§8.6, controlled rebuild-vs-append experiment).
- **Base pinning (GC):** while a base is attached, the runtime pins its
  cells/strings/atoms (no GC) until `JS_DropSnapshotBase()` or
  `JS_FreeRuntime()`. Each slice is a fresh process, so pinning lasts one
  slice at most, and its size is bounded by the base — the live state at
  suspension 1, which is mostly still live anyway. The churn workload
  bounds the dead-but-pinned cost at base size (~14 KB here). On rebase,
  the host drops the old base (its deltas are already stored as
  checkpoints and do not need the runtime's attachment). Not a blocker.
- **Resume path:** resume-from-blob (BRA-74) loads base-by-hash +
  delta, verifies the base hash before calling `JS_ReadSnapshot`, and
  lets the engine's own mismatch detection act as backstop (§4).
  A run restored from base (+delta) has that base attached, so its next
  deltas are relative to the same base — deltas are never chained.
- **Math.random / performance.now:** full snapshots and deltas save them;
  a base read without a delta gets fresh ones (header). No action: the
  first suspension is always a base+delta pair in practice (the snap file
  at susp 1 IS the base), and a bare-base resume only occurs if the store
  deliberately reconstructs suspension 1, which re-seeds randomness —
  acceptable and documented; workflows must not depend on random state
  surviving suspension 1, which they cannot anyway since trap results
  are the only cross-suspension inputs.

## 4. Durability-impact assessment

The single-file blob is the simplest durable artifact (one file = the
whole state, hash-checkable). Pairing adds a two-file invariant to the
blob store, queue repair (BRA-72), resume-from-blob (BRA-74), corruption
handling (BRA-77) and save_snapshot atomicity (BRA-83). Assessment,
with measurements where the prototype could provide them:

- **Engine backstop — measured, strong.** The engine itself detects a
  wrong pair: truncated delta → `read after the end of the buffer`,
  rc 1; mismatched base+delta (briefing base + judgefix delta) →
  `the delta was not written from this base`, rc 1. A wrong pair is a
  loud failure, not a silently wrong resume — the issue's worst fear
  does not materialise at the engine layer. The host must still bind by
  hash (a loud failure mid-run is better than a silent one, but a
  prevented one is better than both).
- **Host layer — prototype gaps, all closable by the design in §3.**
  The prototype fails loudly on missing `.meta` (refuses to guess) and
  missing `.base` (rc 1), but its triple-write is not atomic: a crash
  between the base/snap/meta writes leaves a mixed generation. The
  production write order must be: (1) write base once, fsync, rename
  (immutable, hash-named); (2) write delta to tmp, fsync, rename;
  (3) write the checkpoint manifest (base-hash + delta-hash) last — the
  manifest is the commit point; a crash before it leaves the previous
  checkpoint intact. This is the same tmp+fsync+rename discipline BRA-83
  establishes for the single file, applied to two files + a manifest.
  The manifest (or the blob store's own record) must carry both hashes;
  hash-checking both files on load is what makes a torn pair detectable
  before the engine ever sees it.
- **Interaction with BRA-72 (queue repair):** repair must understand
  the chain: a checkpoint without its base is unresumable and must be
  reported as such (not silently repaired by dropping the delta); a base
  without any checkpoint is garbage-collectable. Repair's "stranded
  running" handling is unchanged; the blob-existence check becomes a
  pair-existence check.
- **Interaction with BRA-74 (resume-from-blob):** resume loads two files
  instead of one; the failure mode "base present, delta missing" must
  fail loudly with a named error (measured: rc 1), never fall back to
  resuming the base alone (that would silently rewind the run to
  suspension 1 — a wrong resume by another name).
- **Interaction with BRA-77 (corruption handling):** corrupt base or
  corrupt delta are both detectable by hash before read; corrupt manifest
  means the checkpoint does not exist (previous checkpoint stands).
  The rebuild fallback (§3) gives a recovery path for a lost base that
  the single-file design does not have — a small durability *gain*,
  not a loss, provided the frozen bundle is intact.
- **Interaction with BRA-83 (atomicity):** sequencing matters — BRA-90
  adoption must land after BRA-83, reusing its atomic-write primitive
  for both files and the manifest. No new atomicity primitive is needed.
- **Residual risk:** the pairing invariant is real complexity in four
  subsystems, and a bug in the manifest/commit ordering could strand a
  run that the single-file design would have resumed. Mitigation is the
  hash binding + manifest-last ordering + the engine backstop, plus the
  fact that the chain is one mode (no dual paths to keep consistent).
  The risk is bounded and testable: the harness's corruption probes
  (truncated delta, mismatched pair, missing meta, missing base — all
  rc 1, all loud) should become permanent tests in the adoption work.

## 5. Recommendation

**ADOPT — conditionally. Adopt the hash-linked snapshot chain (the
already-decided direction: always-on, one mode, no heap-size threshold),
sequenced after BRA-83, with the §3 design (content-hash binding,
manifest-last commit, shared base across forks) plus the §8 keyframe
design: keyframes every 25 suspensions or when the latest delta exceeds
75% of the estimated full snapshot, whichever comes first; interval 25
is the measured optimum for growing workloads (§8.5), and the 75% rule
is the early-run backstop (§8.6).** The keyframe measurements (§8) and
heap-shape measurements (§9) strengthen the case and bound it: the
write saving on long growing runs is 4.7–10× with keyframes (vs ~1×
without them at 500 suspensions, §8.4), and the pinned-base memory
cost that keyframes bound is measured at ~4.7 MB RSS on the shrink
workload (§10). The limits the adoption work must respect are in the
conditions below.

Reasons, with numbers:

1. **The measurement gate passes.** Deltas are materially smaller than
   full snapshots on every realistic workload measured: total bytes
   written fall to 0.49 (judgefix, 9 susp.) and 0.53 (briefing, 12 susp.)
   of full, and the advantage grows with suspension count (control runs
   at 3 suspensions already reach 0.33). The per-suspension delta never
   exceeds 65% of full even at the last suspension of a monotonically
   accumulating run, and the worst case measured — whole-heap replacement
   every trap — still yields 59–62%. The "delta approaches full size"
   failure mode does not occur.
2. **Forks are the biggest win.** Branch copies shrink ~18× (853 B vs
   15,788 B measured) with a shared base, and the saving scales with
   parent heap size — the JudgeFixLoop shape is exactly where the current
   full-copy fork is most expensive.
3. **Durability is not weakened if the §3 design is followed.**
   The engine rejects wrong pairs loudly (measured), bases are
   byte-reproducible (measured), and the hash binding + manifest-last
   ordering close the host-level gaps. The one genuine cost is complexity
   across BRA-72/74/77/83 — real, but bounded, testable, and already
   sequenced after BRA-83.

Conditions and honest limits:

- **This is a write-amplification optimization, not a storage one.**
  Stored bytes at the end are ~150 B *larger* than a full snapshot (§2.1).
  If the goal were smaller stored blobs, do not adopt — that goal is not
  served. The payoff is cumulative write bytes (and fork-copy bytes),
  which only matters at scale: at today's realistic run sizes the saving
  is ~100–160 KB per run — small in absolute terms. The case for adopting
  now is that the mechanism scales linearly (2 MB control: 6.33 MB → 2.11 MB
  written) and the runs that motivated the issue (MBs of drafts across
  many traps, JudgeFixLoop forks) are exactly where it pays.
- **Validate on a real run before calling it done.** My realistic
  workloads use synthetic realistic-shaped text, not real LLM outputs.
  The adoption work should re-measure on one real briefing run and one
  real JudgeFixLoop run; if per-suspension deltas there exceed 80% of
  full at the suspension counts that matter, the adoption should be
  revisited. The harness (`measure.ts`) is built to take real workflows.
  The same validation applies to the keyframe interval: re-measure the
  10/25/50 totals on a real long run before treating 25 as final — the
  fitted optimum (~23–24, §8.5) rests on two synthetic growing
  workloads, and the rebuild floor (§8.6) means a real run's optimum
  depends on how much of its heap it rebuilds per suspension.
- **Keyframes are a write optimization, not a resume-time one.** At the
  heap sizes measured (≤1.2 MB), keyframing does not measurably improve
  resume/load time (§8.3: load time is set by total heap size,
  base + delta ≈ full, in every mode). Do not sell the interval as a
  resume-time control at this scale; its measured levers are bytes
  written and pinned-base memory (§8.4, §10). If a future run's heap
  is 10× larger, re-measure the load-time table — the shape data (§9)
  shows read cost reaching 26 ms (min) at 2 MB / 45k objects, where
  the interval could start to matter.
- **Heap shape changes the write-time payoff (§9).** Delta-write time
  is O(heap cells), not O(changed bytes): at equal bytes, 12,000 small
  objects cost 6× the delta-write time of one 500 KB string (27× at
  2 MB). The byte saving (up to 4,700×) does not carry over to time
  (4–24×). Object-heavy runs still benefit, but less than the byte
  ratios suggest; validate the time saving on a real object-heavy run.
- **Do not ship the prototype's pairing.** Sibling-filename pairing with
  a file-existence gate is not production-grade; the hash chain in §3 is
  the shippable form. The prototype exists to produce numbers, not to
  be merged. The prototype's keyframe bookkeeping (`.meta` record,
  §8.2) is likewise prototype-only: the production manifest carries
  the keyframe hash, base hash and previous-checkpoint hash (§8.7),
  and the pruning rule (§8.7) governs what may be dropped.

## 6. Prototype inventory (what was built, what was not changed)

- `experiments/bra90/durablets-delta.c` — copy of
  `packages/durablets/src/durablets.c` + opt-in delta support
  (`DURABLETS_DELTA=1`; `JS_SNAPSHOT_BASE` at first suspension,
  `JS_SNAPSHOT_DELTA` after; pair-aware load in all 7 `JS_ReadSnapshot`
  sites: resume, branch, join, join-value, join-throw, join-aggregate,
  cancel). Exact diff:
  `diff packages/durablets/src/durablets.c experiments/bra90/durablets-delta.c`.
  `experiments/bra90/durablets.h` is an unmodified copy (build include).
- `experiments/bra90/measure.ts` — builds both binaries, drives all
  workloads in both modes, asserts identical outputs, runs the
  reproducibility + fork checks, writes `results-<date>.json`.
- `experiments/bra90/workflows/` — `control.ts`, `briefing.ts`,
  `judgefix.ts`, `churn.ts`.
- `experiments/bra90/results-2026-11-17.json` — machine-readable numbers
  behind every table above.
- **Keyframe + heap-shape follow-up (2026-11-17, §8–§10):**
  `experiments/bra90/durablets-delta.c` gained keyframes
  (`DURABLETS_KEYFRAME_INTERVAL`, interval/ratio triggers, full
  `.meta` record), a `load` probe verb, `[bra90-time]` engine timing
  lines, and `DURABLETS_LOAD_SLEEP_MS` for RSS sampling.
  `experiments/bra90/measure-keyframes.ts` is the second harness
  (long chains to 500 suspensions, load probes at chain lengths
  10/50/100/250/500, heap shapes, shrink/pinning, pruning tests, fork
  check with keyframes); results
  `experiments/bra90/results-keyframes-2026-11-17.json`. New
  workflows: `accumulate.ts`, `slowgrow.ts`, `stable.ts`,
  `churn-long.ts`, `shape-string.ts`, `shape-objects.ts`,
  `shape-mixed.ts`, `shape-shrink.ts`, `shape-rebuild.ts`,
  `shape-append.ts`.
- **Not changed:** `packages/durablets/src/durablets.c` (0 `BRA-90`
  references), `run.sh`, `~/workspace/agentts-state`, the production
  tick agent, the dquickts trees. No Linear update, no issue close, no
  comment posted.

## 7. Caveats / follow-ups (out of scope, noted not done)

- ~~Rebase value (§3) is derived from the measured delta law, not
  separately measured — the prototype has no rebase trigger.~~ **Closed
  2026-11-17 (§8):** the rebase (keyframe) trigger is prototyped and
  measured on 500-suspension runs; the interval optimum is fitted
  from those totals (§8.5).
- Timing numbers are engine times (`[bra90-time]` lines inside the C
  host), not wall clock, and are reported as **minima over the samples**
  with medians alongside (§8.3, §9.2): the VM's shared CPU produces
  one-sided preemption spikes (single samples up to ~200 ms on a ~25 ms
  operation), so medians of small samples are contaminated and minima
  are the better estimator of the true serialization cost. A focused
  recheck of the noisiest cell (objects-2m keyframe write) gave
  medians of 88/34/26 ms across three repetitions with a stable
  minimum of ~25 ms — the minimum is the number to trust.
- The harness drives the C host directly, not through `host.ts` /
  queue / tick driver, so blob-store, queue-repair and corruption
  interactions in §4 are assessed from the design + engine behaviour,
  not end-to-end tested. The adoption work needs those integration tests
  (the §4 corruption probes should become permanent tests).
- A delta file is indistinguishable from a full snapshot by extension or
  content sniffing — the store must record kind/hash in its manifest.
  The prototype's `.meta` sidecar demonstrates the need; the production
  manifest in §3 is the answer.
- The stock binary refuses to resume a delta file (rc 1, measured) —
  good, but it means a delta-mode blob store is unreadable by an old
  host. Mixed-version rollout needs the manifest to record the chain
  format version; a one-mode rollout avoids supporting both.

## 8. Keyframes (follow-up, 2026-11-17)

Brandon's comment on BRA-90: a pure delta chain has a resume-time trap
of its own — if resuming means replaying through 100,000 incremental
snapshots, that gets very slow — and the ideal is a video-codec hybrid:
periodic full snapshots (I-frames / keyframes) with deltas (P-frames)
between them, so resume cost is bounded by the keyframe interval, not
the chain length. This section measures that design. Its first finding
corrects the premise (§8.1); the rest measures what keyframes actually
bound.

### 8.1 The engine correction: there is no replay chain

The premise assumes a chained-delta model (each delta relative to the
previous checkpoint, resume replaying the chain). This engine does not
work that way — verified from the dquickts source and header
(`quickjs.h`, `quickjs-snapshot.c`):

- "A runtime restored from a base (with or without a delta) has that
  base attached, so its next deltas are relative to the same base.
  **Deltas are not chained: each one only needs the base.**"
- A full snapshot written with `JS_SNAPSHOT_BASE` "becomes the base of
  the runtime (**replacing the previous base**)". The writer calls
  `JS_DropSnapshotBase(rt)` and attaches the new base
  (`snap_attach_written_base`); the new base gets a fresh id that is a
  content hash of its bytes (`snap_hash64(snapshot bytes) | 1`).
- A delta records the base id it was written against, and the reader
  verifies it (`quickjs-snapshot.c`: "the delta was not written from
  this base") — the engine's own base identity is already a content
  hash, which is what the §3 hash-chain design binds to.

Consequences for the design:

- **A resume loads ONE keyframe + ONE delta, never a replay.** The
  "nearest keyframe" is the base the checkpoint's delta was written
  against; resume applies exactly one delta on top of it. There is no
  chain-length replay cost to bound.
- **What a keyframe actually bounds is the DELTA SIZE (stale base)**
  — hence bytes written (§8.4) — **and the pinned base's age/size**
  (§10). Resume/load time is bounded only insofar as the delta is part
  of the total bytes loaded, and §8.3 shows that effect is small at
  the heap sizes measured, because base + delta ≈ the full heap in
  every mode.
- The keyframe is therefore the rebase mechanism of §3, not a
  replay-shortening mechanism. The interval recommendation (§8.5)
  rests on bytes written, not on resume time.

### 8.2 Prototype mechanics (decisions)

- **Trigger:** env `DURABLETS_KEYFRAME_INTERVAL=N` (0/unset = off:
  pure-delta, exactly as before). At a suspension, write a keyframe
  when suspensions-since-keyframe >= N (interval backstop) OR when the
  previous delta exceeded 75% of the estimated full snapshot
  (`delta/(base+delta) > 0.75`, integer test `4*delta > 3*(base+delta)`,
  from the §2.3 law `full ~= base + delta`), whichever fires first;
  the interval check is evaluated first, so when both fire the trigger
  recorded is "interval". The decision is made from the previous
  `.meta` record alone, so a fresh process needs no other state.
- **Storage/marking:** a keyframe is a `JS_SNAPSHOT_BASE` write; its
  bytes go to `<snap>.base` AND `<snap>` (same as the first suspension,
  so `<snap>` stays a valid full snapshot at the keyframe) and the
  meta records `{"kind":"keyframe",...}`. The next suspension's delta
  is relative to it — verified: after a keyframe the delta shrinks to
  new-content size (briefing, interval 5: delta 9,656 → keyframe
  27,881 → delta 3,019).
- **Meta record (the manifest, prototype-grade):**
  `{"kind":"base"|"keyframe"|"delta","ordinal":N,"sinceKeyframe":K,
  "baseSize":B,"lastDelta":D|null,"ratio":R|null,"trigger":"initial"|
  "interval"|"ratio"|"meta-lost"|null}`. `lastDelta` resets to null
  at a keyframe, so the ratio rule cannot fire on a stale pre-keyframe
  delta. If the base exists but the meta is missing/unreadable, the
  host self-heals with a keyframe (`trigger:"meta-lost"`) rather than
  guessing a pairing. The load path treats "keyframe" like "base" (a
  full read of `<snap>`).
- **Measurement scaffolding (prototype only):** a `load` verb
  (`durablets load <snap>`) reads a snapshot without executing
  anything, so load cost is timed separately from run-forward +
  next-write cost; `[bra90-time]` lines in the C host report the
  engine's read/write milliseconds per snapshot; `DURABLETS_LOAD_SLEEP_MS`
  holds a loaded process open so the harness can sample its peak RSS
  from `/proc` (§10).

### 8.3 Resume/load time vs chain length

Load time = engine `JS_ReadSnapshot` time for one keyframe + one delta
(`load` verb, 5 repetitions per point; **minima** reported — see the
§7 timing note; medians are in the results JSON). Chain length =
suspensions driven; delta = the checkpoint's delta size at that length.

| Workload | Mode | 10 | 50 | 100 | 250 | 500 | Delta @500 |
|---|---|---|---|---|---|---|---|
| accumulate | pure | 0.44 | 0.53 | 0.69 | 1.24 | 1.54 | 1,183,180 |
| accumulate | k10 | 0.44 | 0.56 | 0.69 | 1.11 | 1.89 | 178,591 |
| accumulate | k25 | 0.43 | 0.53 | 0.76 | 1.22 | 2.27 | 167,307 |
| accumulate | k50 | 0.44 | 0.57 | 0.73 | 1.12 | 1.84 | 219,591 |
| slowgrow | pure | 0.41 | 0.42 | 0.46 | 0.55 | 0.66 | 258,139 |
| slowgrow | k25 | 0.41 | 0.45 | 0.48 | 0.61 | 0.79 | 13,938 |
| stable | pure | 0.95 | 0.97 | 0.97 | 0.95 | 0.96 | 110 |
| stable | k25 | 0.95 | 0.97 | 0.96 | 0.98 | 0.95 | 109 |
| churn-long | pure | 0.42 | 0.43 | 0.47 | 0.43 | 0.43 | 20,608 |
| churn-long | k25 | 0.45 | 0.45 | 0.45 | 0.45 | 0.46 | 20,607 |

Readings:

- **Load time is set by total heap size, not by keyframing.** Pure
  accumulate grows 0.44 → 1.54 ms as its delta grows 22 KB → 1.18 MB;
  keyframed accumulate ends at 1.84–2.27 ms — *slightly slower* than
  pure, because it loads a 1.19 MB base + a 167 KB delta (1.35 MB
  total) against pure's 15 KB base + 1.18 MB delta (1.20 MB total).
  The base + delta total is ≈ the full heap in every mode, so
  keyframing cannot reduce load time below the full-heap rebuild cost.
- **Stable and churn load times are flat vs chain length in every
  mode** (~0.95 ms for the 526 KB stable heap, ~0.45 ms for churn):
  when the delta does not grow, chain length does nothing to load
  time. The interval barely matters for resume time below any chain
  length measured — the whole table spans 0.4–2.3 ms, and the
  mode-to-mode differences at a fixed chain length are ≤ ~0.7 ms,
  within the noise band (max samples reach 63 ms on a single probe;
  minima are the stable estimator).
- The load-time story therefore does not choose the interval. What
  does is bytes written (§8.4) and pinned memory (§10).

### 8.4 Disk cost: bytes written vs resume time

Total bytes written over 500 suspensions (deterministic — identical
across repeated runs):

| Workload | Full (no delta) | Pure delta | k10 | k25 | k50 | Best vs pure |
|---|---|---|---|---|---|---|
| accumulate | 303,219,231 | 295,844,630 | 70,497,505 | **62,781,135** | 69,114,903 | 4.71× (k25) |
| slowgrow | — | 64,587,546 | 8,596,703 | **6,240,077** | 8,025,497 | 10.35× (k25) |
| stable | — | **580,945** | 26,361,164 | 10,577,203 | 5,315,939 | pure (0.05×) |
| churn-long | — | **10,297,555** | 10,996,732 | 10,568,511 | 10,425,827 | pure (0.97×) |

(Full-mode 500 was run only for accumulate, as the equivalence check;
slowgrow/stable/churn full totals are not needed — the pure-vs-keyframe
comparison is the point. Stored bytes at the end are ~the last full
snapshot in every mode, as in §2.1: keyframes do not change stored
size except on shrink workloads, §10.)

Readings:

- **Growing workloads: keyframing restores the saving that pure
  deltas lose.** At 500 suspensions the pure delta on accumulate has
  grown to 98.8% of full (§8.6), so pure writes 295.8 MB vs full's
  303.2 MB — a 2.4% saving, i.e. the pure-delta advantage has
  essentially vanished. Keyframed k25 writes 62.8 MB (4.71× less
  than pure, 4.83× less than full). Slowgrow is starker: pure 64.6 MB
  → k25 6.24 MB (10.35×).
- **The optimum is interior and shallow: k25 beats k10 and k50 on
  both growing workloads** (accumulate 62.8 vs 70.5/69.1 MB; slowgrow
  6.24 vs 8.60/8.03 MB). k10 pays too much in keyframes (49 full
  writes: 29.7 MB of keyframe bytes on accumulate); k50 pays too much
  in deltas (63.2 MB of delta bytes). See the fit in §8.5.
- **Stable heaps: keyframes are pure cost.** Pure writes 580,945 B
  (111 B deltas); k10 writes 26.4 MB — 45× more — for zero benefit,
  because every keyframe is a pointless 526 KB full write of an
  unchanged heap. k50 still writes 5.3 MB (9× pure). The absolute
  cost is small (k25: ~21 KB per suspension on a 526 KB heap), but
  the multiple is large — see §8.8 for the decision on whether to
  gate the interval on growth.
- **Churn: keyframes change nothing.** Deltas are flat ~20.6 KB in
  every mode (each suspension replaces the whole document), so totals
  sit within 7% of each other (10.3–11.0 MB). Keyframes neither help
  nor much hurt here — but note they *increase* stored bytes
  (55,490 vs 35,023: the keyframe's base holds a full document where
  pure's base holds the small seed).

### 8.5 Interval recommendation, from the numbers

Fit `total(I) = A/I + B·I + C` (keyframe cost ~ 1/I, delta cost ~ I)
to the three measured intervals per growing workload:

- Accumulate: A ≈ 239 MB·susp, B ≈ 0.443 MB/susp → optimum
  I = √(A/B) ≈ **23 suspensions**.
- Slowgrow: A ≈ 71.7 MB·susp, B ≈ 0.129 MB/susp → optimum
  I = √(A/B) ≈ **24 suspensions**.

Two independent workloads converge on ~23–24. **Recommendation:
interval 25** — the already-decided 25-suspension cap, now measured
rather than guessed. The fit is an interpolation through three
points per workload, not a law: re-measure on a real long run before
treating 25 as final (§5). The differences between 10/25/50 are
modest (≤30% on totals); the large win is keyframing at all vs pure
on growing runs (4.7–10×). On stable/churn runs any interval is
overhead (§8.4, §8.8).

### 8.6 Stale-base bound (measured)

Per-suspension delta size vs suspensions-since-keyframe, accumulate
run (500 suspensions):

- **Pure:** final delta 1,183,180 B, ratio `delta/(base+delta)` =
  **0.988** — the delta has grown to the full snapshot minus the
  15 KB base. The §2.3 law holds to the end: the stale-base failure
  mode the issue feared is real on long accumulating runs, and pure
  deltas do not bound it.
- **Keyframed:** final ratios k10 0.132, k25 0.123, k50 0.163 — the
  ratio is bounded, and the sawtooth is visible in the rows (each
  keyframe resets the delta; the harness asserts the first delta
  after a keyframe is smaller than the one before it, on the growing
  workloads).
- **The floor: a keyframe does NOT reset the delta to "growth since
  keyframe".** The keyframed final deltas (167–220 KB) are far above
  the ~7–50 KB of growth since the last keyframe. The reason is the
  workflow's rebuild pattern: the briefing `brief` string is rebuilt
  with `+=` every suspension, so each suspension creates a NEW cell
  holding the whole accumulated brief (~150 KB at the end), and a new
  cell is written whole in every delta (`snap_write_body`: new cells
  are written whole, §9.1). Controlled verification (workflows
  `shape-rebuild.ts` vs `shape-append.ts`, same ~165 KB heap, same
  600 B/suspension growth, only the update pattern differs; 20
  suspensions, interval 10):

  | Pattern | Post-keyframe delta (median, susp 11–19) |
  |---|---|
  | Rebuild (`agg += chunk`) | **159,713 B** |
  | Append (`parts.push(chunk)`) | **3,168 B** |

  A 50× difference from the pattern alone. The accumulate delta
  floor (~150 KB ≈ the brief) matches the rebuild number
  quantitatively. So the keyframe bounds the *accumulated new
  content* part of the delta, not the *rebuilt aggregate* part — and
  the interval optimum in §8.5 already reflects that floor (it is
  why k10 does not beat k25: shorter intervals cannot remove the
  floor, they only pay more keyframes). A run that appends rather
  than rebuilds gets the full benefit (slowgrow: final ratio 0.051
  at k25, delta 13,938 B).
- **Trigger behaviour (measured):** the 75% ratio rule fired exactly
  once per keyframed accumulate run, at ordinal 20, and never in any
  other workload/mode. After the base grows, the ratio rule's firing
  interval grows with heap size (it needs `delta > 3 × base`), so the
  interval rule always wins. The ratio rule is an early-run backstop
  for fast growth on a small base. Slowgrow/churn/stable never fire
  it (final pure ratios 0.947 / 0.588 / 0.000 — slowgrow's 0.947 is
  reached only after 500 suspensions, long past the interval
  keyframes that reset it).

### 8.7 Keyframes as a first-class concept in the chain

- **Placement:** keyframes sit in the checkpoint chain at the
  suspensions where the trigger fires. Between two keyframes, every
  checkpoint's delta is relative to the *earlier* keyframe (base-
  relative, §8.1) — checkpoints are independent given their keyframe,
  not chained to each other. The chain is therefore: keyframe K0,
  checkpoints 1..n (deltas vs K0), keyframe K1, checkpoints (deltas
  vs K1), …
- **References (production manifest):** each checkpoint records
  `keyframeHash` (sha256 of the keyframe bytes its delta was written
  against — the engine's own base id is the same content hash, §8.1),
  `deltaHash`, and `prevCheckpointHash` (the previous checkpoint in
  the run's chain, for the fork rule). Each keyframe records its own
  hash and the previous keyframe's hash, so the keyframe list is
  itself a hash chain. Resume loads `keyframeHash` + the checkpoint's
  delta — one keyframe, one delta, no search: the manifest names the
  keyframe directly. (The prototype's `.meta` record is the same
  information in filename-paired form: kind, ordinal, baseSize,
  trigger; the production form replaces the filename with the hash.)
- **Pruning:** once a newer keyframe K1 exists, the older keyframe K0
  and every checkpoint whose delta names K0 are droppable **iff no
  live checkpoint names K0**. Fork-from-head needs only the latest
  keyframe + the checkpoints since it. Arbitrary-point resume or
  branching from an older point needs that point's keyframe kept.
  Pruning is by reference count (or mark-and-sweep at repair time):
  a keyframe is collectable only when zero live checkpoints name it.
  Measured in the harness (accumulate k25 run): the final checkpoint
  alone in a fresh directory resumes to completion (rc 0) — older
  keyframes are not needed for the live head; and an ordinal-50
  checkpoint kept with its own keyframe still resumes (rc 2).
- **Fork interaction:** a fork references the fork-point checkpoint
  by hash (§3) and extends its own chain from there. The fork-point's
  keyframe is shared, never copied: the branch's first suspension
  writes a delta against the shared keyframe (measured: branch snap
  849 B vs 15,790 B full, with interval 10). A fork does not pin the
  *latest* keyframe; it pins the fork-point's keyframe — the pruning
  rule must count fork references too. If the fork-point predates the
  latest keyframe, its keyframe stays live until the fork dies.
- **Queue repair / corruption interaction:** the rule that prevents
  a pruned keyframe from stranding a live checkpoint is the reference
  count itself — repair (BRA-72) may only collect a keyframe with
  zero referencing checkpoints (live runs, live branches, and the
  repairer's own "stranded running" set all count as references). A
  checkpoint whose keyframe is missing is unresumable and must be
  reported as such, never silently repaired by dropping the delta
  (§4). Measured failure mode: an old checkpoint whose keyframe was
  replaced by a newer keyframe fails loudly at load — rc 1, the
  engine's own "the delta was not written from this base" (base-id
  mismatch, §8.1) — not a silent wrong resume. So a pruning bug
  strands loudly rather than corrupting silently, but it still
  strands: the refcount is the prevention, the engine error is the
  backstop.

### 8.8 What keyframes don't do

- They do not speed up resume at the heap sizes measured (§8.3).
- They do not help stable heaps (pure cost, §8.4) or churn heaps
  (no change, §8.4) — and on churn they increase stored bytes.
- They do not remove the rebuilt-aggregate floor (§8.6).
- **Decision (no growth gate):** the interval trigger stays
  unconditional (every N suspensions), as prototyped and measured.
  A growth-gated interval (keyframe only when the last delta exceeds
  some floor) would recover the stable-heap overhead (pure 0.58 MB
  vs k25 10.6 MB over 500 suspensions), but it adds a second
  condition to the trigger for a saving that is small in absolute
  terms (~21 KB/suspension on a 526 KB heap) and contradicts the
  decided KISS direction (one mode, no threshold). Noted as a
  refinement for the adoption work if write volume becomes a
  concern; not adopted here.

## 9. Heap shape (follow-up, 2026-11-17)

Brandon's comment on BRA-90: does 500 KB as one allocation differ from
500 KB as tens of thousands of little allocations, and does the
incremental case have to diff the two? The answer, verified from
`quickjs-snapshot.c` (`snap_write_body`, `snap_put_changed_body`) and
now measured: yes, it diffs, and there is no dirty tracking — so
allocation count, not just total bytes, drives the cost.

### 9.1 Mechanism (verified from source)

A delta is computed by re-serializing **every cell** into a scratch
buffer and byte-comparing (memcmp) it against the stored base body
(`snap_put_changed_body` / the write loop in `JS_WriteSnapshot`):
unchanged → nothing written; changed → a prefix/suffix patch (only
the middle bytes); new cells written whole. There is no dirty
tracking, and every base cell is queued and compared even if it is no
longer reachable. So delta-write work is **O(entire heap) in cells**,
not O(changed bytes). 12,000 small objects = 12,000 serializations +
12,000 memcmps per delta write; one 500 KB string = one serialization
+ one memcmp. The same serialization pass runs on a full write, so
full-write time is also cell-count dominated (it just also writes all
the bytes).

### 9.2 Measurements

Equal total bytes, different shapes — 20 suspensions each; full size
is the full snapshot at suspension 1 (the "equal bytes" ground truth);
the k1 run is interval 1 = a full `JS_SNAPSHOT_BASE` write at every
suspension *with* engine timing, which the stock binary cannot provide
(it has no `[bra90-time]` lines), so it is the full-write/full-read
baseline in the same instrumented binary. Engine ms, **minima** (see
the §7 timing note); medians are in the results JSON.

| Shape | Heap | Full@1 | Delta write min | Delta read min | Full write min (k1) | Full read min (k1) | Med delta size | Med post-kf delta |
|---|---|---|---|---|---|---|---|---|
| string-500k | 1×500 KB string | 514,393 | **0.25** | 0.92 | 1.92 | 0.90 | 122 | 127 |
| objects-500k-few | 12,000 objects, ~50 B each, few change | 522,524 | **1.52** | 6.94 | 6.14 | 6.76 | 416 | 266 |
| objects-500k-many | 12,000 objects, many change | 522,539 | **2.81** | 7.02 | 6.30 | 6.78 | 367,849 | 367,849 |
| mixed-500k | 6,000 objects + 250 KB string | 516,578 | **0.84** | 3.85 | 3.86 | 3.78 | 409 | 259 |
| string-2m | 1×2 MB string | 2,014,389 | **0.25** | 2.29 | 6.14 | 2.30 | 122 | 127 |
| objects-2m-few | 45,000 objects, few change | 1,999,132 | **6.73** | 25.82 | 24.55 | 25.92 | 429 | 274 |

(All six shapes are within ~1% of each other by full snapshot size
at 500 KB, and within ~0.8% at 2 MB — the byte counts are genuinely
equal; only the shape differs.)

Readings:

- **Delta-write time scales with cell count, not bytes.** At equal
  bytes: 500 KB as one string writes its delta in 0.25 ms; as 12,000
  objects, 1.52 ms — **6.1×**. At 2 MB: 0.25 ms vs 6.73 ms —
  **26.9×**. The string write is flat vs size (one memcmp: 0.25 ms
  for 500 KB and for 2 MB); the object write is linear in cells
  (1.52 ms / 12,000 ≈ 6.73 ms / 45,000 ≈ 0.13–0.15 µs per cell).
  The mixed heap sits between (0.84 ms) in proportion to its cell
  count.
- **Delta-write vs full-write, same shape: 3.6–24.6× cheaper in time,
  vs ~1,000–4,700× in bytes.** String-500k: 0.25 vs 1.92 ms (7.7×);
  string-2m: 0.25 vs 6.14 ms (24.6×); objects-500k-few: 1.52 vs 6.14
  ms (4.0×); objects-2m-few: 6.73 vs 24.55 ms (3.6×). The byte ratio
  is enormous (a 122 B delta vs a 514 KB full = 4,200×) because the
  bytes written are tiny — but the *time* saving is bounded by the
  re-serialization pass, which the delta still pays in full. So the
  write-time saving is far smaller than the byte saving, and the
  gap is largest on object-heavy heaps.
- **Delta read ≈ full read, in every shape.** 0.92 vs 0.90 ms;
  6.94 vs 6.76; 25.82 vs 25.92. A delta does not speed up resume;
  resume cost is the heap-rebuild cost, and it is shape-dependent
  (2 MB / 45k objects reads in ~26 ms, 2 MB / 1 string in ~2.3 ms).
  This is the same conclusion as §8.3, now with the shape dimension:
  a large object-heavy heap is the expensive resume case, and
  keyframing does not change it.
- **Many-change vs few-change (objects-500k):** write 2.81 vs 1.52
  ms — the extra 1.3 ms is the cost of writing 368 KB of changed
  bytes (vs 416 B); read is unchanged (7.02 vs 6.94 ms) — read cost
  does not depend on delta size, only on the heap it rebuilds.
  Post-keyframe deltas confirm the distinction: few-change stays at
  266 B after a keyframe; many-change stays at 367,849 B — keyframes
  bound the *stale* part of the delta, not the *changed* part.
- **Stability across runs:** the minima are stable (run-to-run: 0.25/
  0.26, 1.61/1.52, 6.72/6.73 ms for string-500k, objects-500k-few,
  objects-2m-few delta writes). The medians are not (objects-2m full
  write: 85.7 ms in one run, 34.9 in the next, minimum ~25 ms in
  both) — see §7.

Implication for adoption: the §2 byte ratios overstate the
write-time saving, especially on object-heavy heaps. The saving is
still real (3.6× at worst measured, 24× at best) and the byte
saving is what it is, but any latency claim for the adoption should
use the time numbers in this table, not the byte ratios.

## 10. Attached-base memory and pinning (follow-up, 2026-11-17)

### 10.1 Mechanism (verified from source)

The base is held in memory while it is attached. `JSSnapshotBase`
holds the concatenated base bodies (plus cells, atoms and strings),
and `quickjs.h` states: "While a base is attached, the runtime
references every cell, string and atom of the base so that they keep
their identity: they are not garbage collected." `JS_DropSnapshotBase()`
(or `JS_FreeRuntime()`) frees them. Consequences:

- **The heap cannot shrink under a base.** Cells that die after the
  base was written are still pinned by it, and the base bodies stay
  in memory in full. A long chain pins the run's first snapshot
  forever (pure-delta mode) — the pinned set never shrinks.
- **Keyframes bound the pinned set.** Writing a keyframe drops the
  old base and attaches the new one, so the pinned cells are the new
  base's cells only. The worst-case pinned dead set is then bounded
  by ~one interval of growth (plus the rebuild floor, §8.6), not by
  the whole run.
- The load-side cost is measured in §10.2. The write-side cost is
  the same mechanism (the writer also holds the attached base while
  it runs) — argued from code, not separately measured.

### 10.2 Shrink measurement

Workflow `shape-shrink.ts`: 10,000 objects (~436 KB heap), dropped to
`[]` at suspension 1, then 30 more suspensions. The load is the
final checkpoint (30 suspensions after the drop).

| Mode | Full pre-drop | Post-drop delta | Stored at end | Load RSS (median, n=5) | Load read ms (median) |
|---|---|---|---|---|---|
| full | 436,257 | 14,530 (full) | 14,530 | — | — |
| pure | 436,233 | 137 | **436,370** | **7,864 KiB** | **6.695** |
| k25 | 436,230 | 137 | **14,611** | **3,116 KiB** | **0.497** |

- **Pure-delta stores 30× the live heap** (436,370 B vs the 14,530 B
  live full): the old 436 KB base is still there, plus a 137 B delta
  that says "all dead". The stored bytes are the same as the pinned
  RAM: the base never goes away.
- **Load RSS: pure 7,864 KiB vs k25 3,116 KiB** — a gap of ~4,748 KiB
  (~4.6 MB) for a 436 KB dead snapshot, i.e. **~10× the snapshot size
  in live RAM**: the dead 10,000 objects are restored as live JS
  objects (each with its own allocation, shape and property storage),
  plus the attached base bodies themselves. Load read time is 13×
  slower too (6.695 vs 0.497 ms) — restoring 10,000 dead objects
  costs real time, cross-validated by §9.2 (objects-500k-few delta
  read ~7 ms).
- **Keyframes fix it, at a small write cost.** k25's stored bytes
  are 14,611 (a post-drop keyframe of 14,530 B + a 137 B delta) and
  its load RSS/read are the small-heap numbers. Total bytes written
  over the 31 suspensions: pure 440,343 B vs k25 454,561 B — the
  keyframe costs ~14 KB more write to save ~4.7 MB of load RSS.
  (Full mode writes the most bytes here — 872,157 B total, one full
  snapshot per suspension; pure is the byte-cheapest on a shrink run,
  k25 the RAM-cheapest.)
- **Connection to the interval choice:** the pinning cost grows with
  the pinned base's age and size, so it is a second force toward
  shorter intervals, alongside bytes written (§8.4) — but the same
  interval-25 recommendation covers both, and the measured pinning
  cost at interval 25 is the small-heap number, not the pure-delta
  number. On a pure-delta chain there is no bound at all: the base
  is the run's first snapshot forever, and any later shrink is dead
  weight in RAM on every resume until the run ends. If a run's heap
  is expected to shrink by a large factor mid-run (e.g. a big
  context is dropped), the interval is what caps that exposure.

## 11. Implementation (2026-11-17, BRA-90)

Landed as designed (§3 + §8.7), with two deviations recorded
plainly below. Framing, corrected by Brandon and repeated here so
it is not re-broken: the savings are **bytes WRITTEN over a run,
not bytes stored**. The live set is a keyframe + the latest delta,
marginally MORE stored than one full snapshot; load is slightly
slower (one keyframe + one delta to read). The wins are write
amplification over long runs and fork storage.

### What changed

- `packages/durablets/src/durablets.c` — `save_snapshot` obeys
  `DURABLETS_SAVE_MODE=base|delta` (default `base`; a base write
  is now `JS_SNAPSHOT_BASE`, which is itself a complete,
  restorable snapshot and also becomes the runtime's base). All 7
  `JS_ReadSnapshot` sites (resume, branch, join, join-value,
  join-throw, join-aggregate, cancel) now go through one
  `read_snapshot()` helper: when `DURABLETS_BASE_PATH` names a
  keyframe, the snapshot file is read as a delta against it;
  otherwise a plain full read (the legacy path). The engine
  version is source-derived from this file, so the format change
  bumps it (`dquickts-96a9a79+durablets-47f512ac166dbcc1`, was
  `...1a31de6141d8d`) and old snapshots fail loudly on version
  mismatch via `assertEngineVersion` instead of loading wrongly.
- `apps/agentts/src/host.ts` — the chain. Layout (forced by the
  BRA-76 C1 test: `blobs/<run>.snap` must stay > 1000 bytes after
  a 50-sleep run, and a counter-only delta is ~150–300 B):
  `blobs/<run>.snap` = verbatim copy of the latest KEYFRAME;
  `blobs/<run>.delta` = latest delta bytes; `blobs/keyframes/
  <sha256>.snap` = immutable content-addressed keyframes, shared
  across forks; `blobs/<run>.checkpoint.json` = the manifest
  (`bra90-chain-v1`: keyframeHash, deltaHash,
  prevCheckpointHash, ordinal, sinceKeyframe, baseSize,
  lastDelta, trigger), written LAST via tmp+fsync+rename — the
  commit point. `decideSave(prev)` is pure + recomputable: the
  slice env (`chainEnvFor`, before the slice) and `storeBlob`
  (after it) call it with the same manifest, so they always
  agree. Keyframes at ordinals 0, 25, 50, … (at most 24
  consecutive deltas at interval 25) or when the previous delta
  exceeds 75% of the estimated full snapshot (interval first).
  `DURABLETS_KEYFRAME_INTERVAL`, default 25, 0 = full-only.
  Branches extend the parent's chain at the fork point
  (`storeBlob(child, snap, parentManifest)`); the child's first
  save is a delta against the shared keyframe. Pruning is
  mark-and-sweep over all manifests, after the new manifest
  commits; a completed run's manifest is discarded (unpinning
  its keyframe). A run that fails with a throw keeps its
  checkpoint (the DriveCapError message promises the blob
  intact).
- `apps/agentts/tests/test-bra90.ts` (+ 3 workflows) — the
  fault-injection proof + chain checks, wired into `run.sh`
  after the bra112 suite. See the test's header for the case
  list. The suite passes standalone (2026-11-17): exit 0, 147
  checks green. Headline results are in "Measured numbers"
  below.

### Measured numbers (real runs, standalone suite)

- Write amplification, 30-sleep run: keyframe 34,196 B; 2
  keyframes 68,399 B + 28 deltas 8,036 B = **76,435 B written
  vs 1,025,880 B for full snapshots every suspension — ratio
  0.075 (13.4× less written)**. The 4.71×/10.35× prototype
  totals were 500-suspension harness numbers; this is the
  same effect measured on a real 30-suspension run, and it is
  larger here because the counter-only deltas are ~287 B
  against a 34 KB keyframe. Re-measured inside the full
  `run.sh` verification (staged AND copy-path, identical):
  keyframe 34,182 B, written-total 76,211 B vs 1,025,460 B,
  **ratio 0.074**.
- Ratio rule, accumulate run (1 KB first chunk, then 100 KB per
  suspension): saves [35,443, 101,296, 201,296, 335,452,
  401,291] bytes, base at ordinals 0 and 3 — the ratio rebase
  fired at ordinal 3, not 2: at ordinal 2 the test is
  4×101,296 = 405,184 vs 3×(35,443+101,296) = 410,217, just
  under 0.75 (the real base is 35 KB, not the ~16 KB the
  prototype's small-heap estimate assumed). At ordinal 3 it
  fires decisively (805,184 vs 710,217). The rule works as
  specified; the firing ordinal depends on the real base size,
  which the test asserts as "ordinal 2 or 3".
- Fork: both branch slices wrote deltas only, each 1,805 B vs
  the 34,401 B keyframe (19× smaller), against the one shared
  keyframe; the join completed with both branch names.
- Fault injection, all loud, none silent: truncated delta and
  truncated keyframe both end "C host crashed resuming … 3
  times … (last blob intact at blobs/<run>.snap)" with no
  result; wrong-hash pairing is rejected by the engine ("the
  delta was not written from this base", in the slice log);
  missing delta / missing keyframe / corrupt manifest all fail
  with the named BRA-90 error and no result (never a bare-base
  resume).
- Legacy migration: a keyframe-suspension blob with manifest +
  delta deleted resumes directly (29 trap events, no replay),
  the first post-resume suspension writes a base + fresh
  manifest, result correct.

### Deviations from the report (recorded, not silent)

1. **No host-side hash check on load.** The report (§8.7)
   recommends hash-checking both files on load. That would
   change the crash-recovery error path BRA-76 A2 / BRA-83 B1
   pin (a truncated `.snap` must surface as "C host crashed
   resuming", naming the blob path). The engine is the
   load-time verifier instead: it rejects truncated and
   mismatched pairs loudly (measured in §4, re-proven by
   test-bra90 D1–D3). Manifest hashes are still recorded and
   verified at store time. The safety property — loud failure,
   never a silently wrong resume — is preserved; only where
   the failure is detected moved.
2. **A manifest-less delta checkpoint rewinds, it does not
   fail.** Deleting a manifest + delta from a chain blob leaves
   `.snap` = the ordinal-0 keyframe, not the latest checkpoint
   (that is what `.snap` holds by design). The run resumes
   from the keyframe and replays the recorded trap answers
   from the journal (BRA-75) — the result stays correct, but
   it is a replay, not a direct resume. This is the safe
   fallback, not a silent rewind: no trap is re-dispatched
   (the journal's recorded answers are delivered), and the
   test documents it rather than proving the false claim that
   the manifest-less case is a legacy resume. A TRUE legacy
   blob (`.snap` = the latest full snapshot) resumes directly;
   scenario G strands at a keyframe suspension to construct
   exactly that.
