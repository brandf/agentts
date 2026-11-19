# Meta-Rubric (v1.0)

**Status:** v1.0, written Nov 18, 2026. The rubric that judges rubrics:
would this rubric, applied honestly, separate good work from bad work,
and would it tell the fixer what to change? It judges the rubric, not
the artifact.

**How it is used:** `workflows/library/rubric-review.ts` reads this file
(the default judging rubric) and scores a rubric under review against
it. Threshold is a separate numeric input to the workflow (default
0.8), not something parsed from this file.

**Scale:** 0–10 per criterion. Every criterion defines what **0**, **5**,
and **10** mean. **Interpolate:** a score is not one of the three
anchors — a 7 means the rubric sits between the 5-anchor and the
10-anchor, closer to 10; say in one line which side of each anchor it
falls on and why. Do not round to 0, 5, or 10 unless the rubric
genuinely matches an anchor exactly. Score each criterion
independently; a rubric can be comprehensive and still fail
discrimination.

## Scope

**In scope:** any rubric — a set of graded questions with anchors plus
open-ended questions — written to judge one class of items (a daily
research briefing edition, a code review, a plan, a deck, ...). The
review judges the rubric against the scope the rubric claims: what is
in scope, what is explicitly out, where the boundaries lie. A narrow
rubric is judged on generalizing across its narrow class (the morning
report rubric across different days' editions), not across kinds it
never claimed.

**Out of scope:** the artifact the rubric judges (scored by the rubric
itself, in its own loop); the workflow that runs the judging (process
lives in code, never in this prose).

## Discrimination perspective

### Graded questions

**1. Coverage.** Does the rubric score every quality dimension that
distinguishes good work from bad work for this artifact type? Is any
important dimension unscored?
- **0:** A dimension that decides good-vs-bad is never scored.
  (Example: a briefing rubric with no criterion on selection
  significance — a bad selection can pass with full marks.)
- **5:** Covers the obvious dimensions (structure, presence of
  required parts) but misses a subtle one (depth, correctness of
  relations, honesty of limitations).
- **10:** Every dimension that separates good from bad is scored,
  including the subtle ones and the edge cases. Nothing that matters
  is left to the judges' unguided discretion.

**2. Discrimination.** Does the rubric separate bad from good from
great? Or does everything pass?
- **0:** Ceiling or floor effect — nearly all real work scores at the
  top (or the bottom). A mediocre artifact and an excellent one get
  the same score.
- **5:** Separates bad from good, but not good from great. The top of
  the scale is crowded; excellence is unscored.
- **10:** Real work lands across the scale. Mediocre work scores
  mid-range, good work scores high, great work scores at the top —
  and the criteria say what the difference is.

**7. Calibration.** Is the pass threshold stated, and does passing mean
the artifact is actually good?
- **0:** No threshold, or an arbitrary one. Passing guarantees nothing.
- **5:** Threshold stated, but uncalibrated — no reference examples
  show what passing and failing work look like.
- **10:** Threshold calibrated against reference examples: a
  known-good artifact passes, a known-mediocre one fails, and the
  rubric says why each lands where it does.

### Open-ended questions

- What quality dimension does this rubric miss entirely — something a
  bad artifact could hide behind?

## Clarity perspective

### Graded questions

**3. Anchored scores.** Is every criterion defined at 0, 5, and 10,
concretely enough that two independent judges would give the same
score?
- **0:** No anchors, or anchors in vague language ("poor / average /
  excellent"). Scores are vibes; two judges routinely differ by 4+.
- **5:** Some criteria anchored, others vague; or anchors exist but use
  terms the judges interpret differently ("thorough", "insightful").
- **10:** Every criterion has concrete 0/5/10 meanings written in
  observable terms (what is present, what is missing, what it looks
  like), plus the interpolation rule. Two careful judges land within
  1 point.

**5. Checkability.** Can each criterion be checked against the artifact
alone, without guessing the author's intent or reading their mind?
- **0:** Criteria are subjective impressions ("feels rigorous",
  "seems insightful") that cannot be checked from the artifact.
- **5:** Mostly checkable, with some criteria that depend on the judge
  inferring intent or background the artifact does not state.
- **10:** Every criterion is verifiable from the artifact itself — by
  direct inspection or by a mechanical check — with no intent-guessing.

**6. Independence.** Do the criteria measure different things, or does
one flaw hit three scores?
- **0:** Heavy overlap — the same flaw (or virtue) moves three or more
  criteria. The total is inflated/deflated by double-counting.
- **5:** Mostly distinct, with some overlap (two criteria that partly
  measure the same thing).
- **10:** Orthogonal criteria. One flaw costs one score. No criterion
  can be derived from another.

### Open-ended questions

- Where would two careful judges disagree on a score, and what wording
  causes the disagreement?

## Usefulness perspective

### Graded questions

**4. Actionability.** Does a failing score tell the fixer exactly what
to change?
- **0:** Scores give no guidance. A 3 on "quality" leaves the fixer
  guessing what to fix.
- **5:** Some criteria point at fixes; others name a problem without
  naming the change ("improve the analysis").
- **10:** Every failing score names the concrete change: what to add,
  remove, or rewrite, and what the fixed version looks like.

**8. Open-ended feedback.** Do the judges give open-ended feedback that
covers what the scores miss, and does it reach the fix step?
- **0:** Numbers only. No free text, or free text that is never read by
  the fix step.
- **5:** Free text allowed but not required, or required but not routed
  to the fix step — it is recorded and ignored.
- **10:** Open-ended feedback is required on every round, guided by
  questions (see below) plus free-form, and it is handed to the fix
  step alongside the scores. The run result records it so a human can
  read it.

**9. Drafter-shared.** Is the rubric written to be read by the drafter
before drafting, in language the drafter can act on — and does the
workflow actually hand it to the drafter?
- **0:** The rubric reaches only the judges. The drafter works blind.
- **5:** The drafter gets it, but it is written in judge-language
  (scoring terms, not writing terms) or the handoff is not enforced
  by the workflow.
- **10:** Plain actionable language, no jargon the drafter cannot use,
  and the workflow passes it to the draft step (and any step that
  writes content) before drafting begins.

### Open-ended questions

- What does this rubric reward that it should not, or punish that it
  should not?

## Robustness perspective

### Graded questions

**10. Anti-patterns.** Does the rubric name the known failure modes for
this artifact type, with what each looks like, so judges actively look
for them?
- **0:** No failure modes named. A classic bad artifact (abstract
  restated as insights, digits with no baselines) passes unnoticed.
- **5:** Some failure modes named, or named without what they look
  like.
- **10:** The known failure modes are all named, each with its tell —
  what the judge will see when the failure is present.

**11. Versioning.** Is the rubric a versioned artifact, so a judgment
can be traced to the exact rubric that produced it?
- **0:** Inline literal in a workflow file. Changes are silent; no
  record of which version judged what.
- **5:** Versioned file, but no change log — the version exists, the
  reasoning for changes does not.
- **10:** Versioned file with a change log, and every judging record
  names the rubric version used.

**12. No process in prose.** Does the rubric contain data only — no
steps, no sequencing, no instructions about how to judge? The process
lives in the workflow code, never in the prose.
- **0:** The rubric is full of procedural instructions ("first read X,
  then score Y, if the score is low do Z") — the process is in the
  prose, where it rots.
- **5:** Mostly data, with some procedural language mixed in (ordering
  instructions, conditional actions).
- **10:** Pure data — perspectives, graded questions with anchors,
  open-ended questions. Nothing about how the judging happens; the
  workflow owns all of that.

**13. Multiple perspectives.** Is the rubric organized into multiple
perspectives, each with graded questions and open-ended questions?
The specific perspectives are not what matters — what matters is that
there are several, so the judge role-plays each viewpoint and
considers factors a single viewpoint would miss. Agents are good at
role-playing; the structure exploits that.
- **0:** A single perspective, or a flat list of questions with no
  perspective structure. The judge scores from one viewpoint; factors
  outside it go unconsidered.
- **5:** Multiple perspectives named, but thin — perspectives that
  overlap heavily (the same viewpoint restated), or some perspectives
  with graded questions only and no open-ended ones (or vice versa).
- **10:** Multiple distinct perspectives, each with anchored graded
  questions AND open-ended questions. The perspectives are genuinely
  different lenses on the artifact, not rewordings of one another. A
  judge role-playing each perspective would notice different things.

**14. Signs of generality.** The judges cannot validate the rubric —
they cannot run a generalization suite from inside a judging round.
What they can do is check for indications that the rubric is (or is
not) a general rubric for the class of items it claims to judge:
criteria written in class terms versus instance terms, dimensions
that only make sense for the design examples, scope claims broader
than the criteria cover, and whether any validation evidence is
cited alongside the rubric. Generality is relative to the scope the
rubric claims. A narrow rubric is not penalized for being narrow —
the morning report rubric is for one specific kind of report
(machine-learning papers, daily), and it needs to generalize across
different days' editions, not across all possible kinds of morning
report. What is judged is whether it generalizes across the class it
claims, and whether its claimed scope matches its criteria. The full
validation — held-out cases, pre-specified expectations, cross-kind
cases where the scope claims them — is a separate step run by Meroki,
operating the review; this criterion scores what the judges can see.
The judges also apply the rubric mentally to the supplied reference
examples and report whether it separates the good from the mediocre
as expected — a check for indications, not validation.
- **0:** Clear signs of overfitting — criteria reference specific
  instances ("LoopZip's compression ratio"), or dimensions that only
  make sense for the design examples, or the rubric claims scope
  (e.g. cross-kind) that nothing in its criteria covers. No
  validation evidence cited anywhere.
- **5:** Criteria mostly in class terms, but some instance-tied
  language, or the scope is unexamined — no evidence either way, and
  the rubric alone does not let the judges tell whether it
  generalizes.
- **10:** Criteria purely in class terms; nothing references a
  specific instance; the claimed scope matches what the criteria
  cover — a narrow rubric is judged on generalizing across its
  narrow class (the morning report rubric across different days'
  editions), not across kinds it never claimed; and a validation
  record is cited (held-out cases, pre-specified expectations,
  results) supporting the generality claim. Applied mentally to the
  supplied reference examples, the rubric separates the good from the
  mediocre as expected.

Related to criterion 7 (calibration), but distinct: 7 asks whether
the threshold means something on the reference examples; 14 asks
whether there is any indication the rubric generalizes beyond them.
A rubric can have a calibrated threshold on its design cases and
still show every sign of being overfit to them.

### Open-ended questions

- Construct a bad artifact that would PASS this rubric. What does it
  look like?
- Free-form: anything else the scores did not capture.

## Guided open-ended questions (asked of every judge, every round)

1. What quality dimension does this rubric miss entirely — something a
   bad artifact could hide behind?
2. Construct a bad artifact that would PASS this rubric. What does it
   look like?
3. Where would two careful judges disagree on a score, and what wording
   causes the disagreement?
4. What does this rubric reward that it should not, or punish that it
   should not?
5. Free-form: anything else the scores did not capture.

Question 2 is the adversarial probe and the strongest discriminator:
if a judge can construct a passing-but-bad artifact, the rubric fails
criterion 2 (discrimination) no matter what its scores say.

## Version

v1.0 (Nov 18, 2026). Change log: created from
`~/workspace/rubric-rubric-design.md` — the 14 criteria with 0/5/10
anchors, reorganized under four perspective headings
(discrimination: 1, 2, 7; clarity: 3, 5, 6; usefulness: 4, 8, 9;
robustness: 10, 11, 12, 13, 14) so the meta-rubric passes its own
criterion 13. Validation: run Nov 18, 2026 — record at
`~/workspace/rubric-validation/VALIDATION.md`. Self-test converged
(finalMean 1.0); negative control round-1 < 0.3 (PASS); positive
exceeds negative by ≥ 0.4 (PASS); code-review round-1 ≥ 0.5 missed
by 0.01 (0.49) and plan ordering missed (0) — both instrument
limitations of the v0 stem-matching judge, not meta-rubric defects.
Round-1 scores are the measure; final convergence to 1.0 is not
evidence of quality.
