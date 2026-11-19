# Morning Report Rubric (v0.2)

**Status:** v0.2, reviewed Nov 18, 2026 through `rubricReview`
(round-1 0.49, converged 1.0). The loop's appended sentences were
NOT adopted — they assert compliance rather than guiding the drafter.
The genuine improvements from the review are in the change log below.

**How it is used:** the drafter and the judges read the same text.
Threshold is a separate numeric input to the workflow (default 0.8),
not something parsed from this file.

**Scale:** 0–10 per graded question. Each question defines what 0, 5, and
10 mean. **Interpolate:** a 7 means between the 5- and 10-anchors, closer
to 10; say in one line which side of each anchor it falls on and why. Do
not round to 0, 5, or 10 unless the edition genuinely matches an anchor.
Score each question independently.

## Scope

**In scope:** one daily edition of the AI research briefing — at least five
papers from the arXiv window (default 2 days), all verified on their own
arXiv abstract pages, deduped against the seen list, across Brandon's
interest areas: LLM architecture, transformers and attention techniques,
context compression, vision / multimodal models, diffusion models,
speculative decoding — with depth-axis looped / recurrent transformers
(weight-tied depth recurrence, Huginn-style) as a standing high-interest
topic, explicitly NOT time-axis latent CoT.

**Out of scope:** papers already covered in a prior edition; papers
outside the interest areas unless they bear directly on them; anything
that is not a research paper (announcements, blog posts, tweets).

**What "good" means, in one line:** every paper's key claims carry real
numbers with baselines, the mechanism is explained well enough to
reproduce the idea, relations name specific prior papers Brandon has
read with the actual connection, insights go beyond the abstract, and
limitations are honest and specific. Reference standard: the Nov 18,
2026 cron edition — ~1,400 words per paper, ~5 number-bearing bullets
per paper.

**Calibration:** the Nov 18 cron edition (~1,440 words/paper, ~5.2
number-bullets/paper) passes this rubric; the Nov 18 trial edition
(~360 words/paper, ~1.5 number-bullets/paper) fails it — the 0.8
threshold sits between them.

**Generality:** this rubric generalizes across days' editions of the
same report; it does not claim to judge other kinds of morning report.

## Selection perspective

### Graded questions

**S1. Must-read is the most consequential paper of the day.**
- **0:** Must-read is arbitrary, or the top-ranked paper by topic fit
  with no significance argument. No justification, or a justification
  that could apply to any paper.
- **5:** Must-read is a strong paper and the scope note argues for it,
  but a stronger candidate was cut or ranked below it without reason.
- **10:** Must-read is the single most consequential paper — it changes
  what Brandon should believe or do (reverses published claims,
  reframes a program, opens a direction) — and the scope note says why
  in one or two sentences.

**S2. Selection covers the day's consequential papers, not just the
topical ones.**
- **0:** Selection is keyword-topic fit only. A consequential paper in
  the window was never a candidate (not discovered, or ranked below the
  read cutoff on topic score alone).
- **5:** Most consequential papers selected, but one was missed or a
  marginal topical paper took a slot a consequential one should have
  had.
- **10:** Every consequential paper in the window is selected or named
  in the scope note's cut list with a one-line reason. Nothing
  consequential is silently absent.

**S3. At least five papers, deduped, verified.**
- **0:** Fewer than five papers, or a paper already covered in a prior
  edition, or a paper whose claims were not verified on its own arXiv
  page.
- **5:** Five or more papers, deduped and verified, but the window or
  the dedupe is not stated in the scope note.
- **10:** Five or more papers, all verified on their own arXiv pages,
  deduped against the seen list, with the window and the dedupe stated
  in the scope note (including named exclusions with reasons).

### Open-ended questions

- Which consequential paper in the window did this edition miss, and
  why would it have mattered?
- If you had to cut one selected paper and promote one cut paper, which
  and why?

## Depth perspective

### Graded questions

**D1. Key findings carry real numbers with baselines and comparators.**
- **0:** No numbers, or bare digits with no baseline ("improves
  accuracy by 5%").
- **5:** Numbers present but mostly without comparators, or the numbers
  are from the abstract only and never from the full text.
- **10:** Every key claim carries numbers with baselines/comparators
  ("FlashAttention 2,830 MB / 144.9 ms vs. DiJiang 4,085 MB / 157 ms";
  "softmax 79.8, Hedgehog 77.7 (−2.1)"), drawn from the full text
  where available, with seed/variance noted where the paper gives it.

**D2. Mechanism is explained well enough to reproduce the idea.**
- **0:** One-line summary of what the paper claims ("a new attention
  mechanism"), or the abstract restated.
- **5:** The mechanism is described, but a key step is missing or
  hand-waved — a reader could not reconstruct the idea.
- **10:** The mechanism is explained with its moving parts (equations,
  algorithm steps, design choices and why each was made) so a reader
  could reproduce the idea. Reference: the Nov 18 "How it works"
  sections.

**D3. Depth is analysis, not extraction.**
- **0:** Sections are extracted sentences from the fetched text —
  abstract sentences repeated as findings, insights, or limitations.
- **5:** Some analysis, but findings read as a summary of the paper
  rather than an evaluation of it.
- **10:** ~1,400 words per paper, ~5 number-bearing bullets, with
  evaluation throughout: what is surprising, what is load-bearing,
  what would change the conclusion.

### Open-ended questions

- What number in this edition most needs a baseline the paper did not
  give, and what would you compare it against?
- Which paper's mechanism is still unclear after reading its section,
  and what is missing?

## Relations perspective

### Graded questions

**R1. Relations name specific prior papers Brandon has read, with the
actual connection.**
- **0:** Relations are keyword overlap ("related to attention") or name
  no prior paper at all.
- **5:** Some relations name real papers, but the connection is generic
  ("builds on prior work") or the named paper is not one Brandon has
  read.
- **10:** Every relation names a specific paper (with arXiv ID where
  it is one Brandon has read — e.g. "Yesterday's Latent Lattice
  (2611.21608)") and states the actual connection: what it shares,
  what it changes, what it implies for the earlier paper.

**R2. The edition is threaded, not a list.**
- **0:** Papers are unrelated entries; no scope-note synthesis, no
  cross-paper connections.
- **5:** The scope note names a theme, but the papers do not connect to
  each other in their relations sections.
- **10:** The scope note states the day's spines (thematic threads)
  and the papers connect across them — a paper's relations section
  references another paper in the same edition where the connection
  is real.

### Open-ended questions

- Which prior paper that Brandon has read should have been related to
  one in this edition but was not?
- Is there a thread across today's papers the scope note missed?

## Insights perspective

### Graded questions

**I1. Insights go beyond the abstract.**
- **0:** "Insights" restate the abstract or repeat a finding bullet in
  different words.
- **5:** One genuine insight per edition, the rest restatements.
- **10:** Every paper has at least one insight that is not in the paper:
  an implication, a suspicion, a next experiment, a reframe — stated
  as the author's own judgment, not the paper's claims.

**I2. Insights are specific and falsifiable, not generic.**
- **0:** Generic praise or generic caution ("promising direction",
  "more work is needed").
- **5:** Specific claims, but hedged to meaninglessness.
- **10:** Specific, checkable claims ("any future linear-attention
  proposal needs a DRAM-traffic budget in its abstract, not just a
  FLOP count"; "if the gap-closing is about the self-supervised
  objective, LARA++-style methods may be viable for pretraining but
  not for supervised fine-tuning").

### Open-ended questions

- What is the most interesting implication of today's must-read that
  the edition did not draw out?
- What claim in this edition do you most suspect, and what would
  settle it?

## Honesty perspective

### Graded questions

**H1. Limitations are honest and specific.**
- **0:** No limitations, or boilerplate ("limited evaluation").
- **5:** Limitations named, but vague or copied from the paper's own
  limitations section without evaluation.
- **10:** Limitations are specific and quantified: what was not tested,
  where the numbers stop (context lengths, model scales, tasks),
  uneven tuning, single-config results presented as general ("the
  '99%' is one config: 82.1/82.9 on DeiT-B/384").

**H2. Uncertainty is stated, not smoothed over.**
- **0:** Headline numbers presented without the caveats that qualify
  them; irreconcilable figures left unflagged.
- **5:** Some caveats present, but a headline number is overstated
  somewhere.
- **10:** Every headline number carries its qualifier; figures that
  cannot be reconciled from the text are flagged as such ("treat the
  latency claims as indicative, not verified").

### Open-ended questions

- Where is this edition most likely overstating a paper's claims?
- What did the paper's authors claim that the edition should have
  challenged but did not?

## Presentation perspective

### Graded questions

**P1. All five subsections present in every paper, in order.**
- **0:** A paper is missing a subsection, or subsections are out of
  order or mislabeled.
- **5:** All five present, but one is a stub (a sentence where the
  section needs a paragraph).
- **10:** All five subsections present in every paper — Key findings,
  How it works, How it relates to other work, Insights beyond the
  paper, Honest limitations — each substantive.

**P2. Scope note orients the day.**
- **0:** No scope note, or a scope note that only states the window.
- **5:** Scope note states window and verification, but no synthesis
  and no cut list.
- **10:** Scope note states the window, verification, dedupe (with
  named exclusions), the day's spines, the must-read with its
  justification, and the cut list with one-line reasons.

### Open-ended questions

- What would make this edition easier to skim on a walk — what is
  buried that should be surfaced?

## Anti-patterns (judges: look for these actively)

- Abstract restated as insights, findings, or limitations.
- Keyword-overlap relations (no named paper, no actual connection).
- Numbers without baselines; headline percentages that appear only in
  the abstract.
- Must-read chosen by topic fit rather than consequence.
- A consequential paper silently absent (not selected, not in the cut
  list).
- Scope note that states the window but synthesizes nothing.

## Version

v0.2 (Nov 18, 2026). Change log: v0.1 created from the Nov 18, 2026
cron edition as reference standard; trial edition (Nov 18) as the
mediocre reference. v0.2 reviewed through `rubricReview` (round-1
0.49, converged 1.0; record:
`~/workspace/rubric-validation/VALIDATION.md` and the briefing-review
run in `~/workspace/rubric-validation/state/briefing-review/`):
- "How it is used" trimmed to contract facts — the step sequencing
  ("draft and read steps read it first... judges score afterward") was
  process in the prose (meta-rubric criterion 12); the workflow owns
  sequencing, the rubric carries data only.
- Calibration stated explicitly (criterion 7): cron passes, trial
  fails, threshold sits between them.
- Generality claim stated explicitly (criterion 14): across days'
  editions of this report, not other kinds.
- The loop's appended sentences were NOT adopted: they assert the
  rubric satisfies the meta-criteria rather than improving it, and
  would make the rubric worse as a working document. Criteria the
  draft already satisfies in substance (coverage, discrimination,
  actionability, drafter-shared) were left as written — the v0
  stem-matching judge cannot see them, which is a known v0
  limitation, not a rubric defect.
