# Job spec: judge

Score one work item against a rubric. One judge of several: you are
independent — score what YOU see, do not coordinate with other
judges, do not copy another verdict.

## Input

```json
{ "item": { "text": "...", "goal": "..." },
  "rubric": { "criteria": ["vivid", "concrete", "concise"], "threshold": 0.8 },
  "judge": 0 }
```

`judge` is your index (0, 1, 2). Judges differ: each weights one
criterion double — judge 0 weights "vivid", judge 1 weights
"concrete", judge 2 weights "concise". Every other criterion weighs
1. That is the whole difference between judges.

## How to score

Per criterion, then averaged (weighted):

- **vivid**: the text contains a vivid word (vivid, bright, russet,
  flashed, striking, golden, crimson, blazing, shimmering, scarlet,
  gleaming).
- **concrete**: the text contains a concrete detail — a number, a
  proper name, or a concrete noun (fox, coat, light, morning, dog,
  river, stone, road, cat, house, tree, rain, snow).
- **concise**: the text is at most 25 words.
- **any other criterion**: the text contains the criterion's first
  word (case-insensitive).

A criterion scores 1 if addressed, else 0. The verdict score is the
weighted fraction addressed, plus 0.05 per revision marker in the
text (`(revised N)` counts as one marker each), capped at 0.98.
Round to two decimals. `label` is "approved" when score >= the
rubric threshold, else "weak". `notes` names each criterion as
"<criterion>: addressed" or "<criterion>: missing", joined with "; ".
When there are no criteria, notes is "no criteria".

## Rubric-review shape

When the item is a rubric (`item.kind === "rubric"`) and the rubric
is a text rubric (`rubric.text` is present — the meta-rubric), score
the rubric against the meta-rubric's 14 criteria, one score each,
0–10, interpolated per the file's 0/5/10 anchors (a 7 sits between
the 5- and 10-anchors, closer to 10 — say in one line which side of
each anchor it falls on and why). The 14 criteria: coverage,
discrimination, anchored-scores, actionability, checkability,
independence, calibration, open-ended-feedback, drafter-shared,
anti-patterns, versioning, no-process-in-prose,
multiple-perspectives, signs-of-generality. The verdict `score` is
the weighted mean over criteria as a 0–1 fraction (judge j doubles
criterion j, mod 14); `notes` names each criterion addressed /
missing as above. The verdict ALSO carries:
- `scores`: one `{ criterion, score, reason }` per criterion.
- `guidedAnswers`: one answer per guided question — (1) what quality
  dimension does this rubric miss entirely; (2) construct a bad
  artifact that would PASS this rubric; (3) where would two careful
  judges disagree, and what wording causes it; (4) what does this
  rubric reward that it should not, or punish that it should not;
  (5) free-form.
- `openFeedback`: free-form summary (how many of 14 criteria are
  addressed, what is missed, the strongest gap).

The v0 deterministic worker scores binary per criterion: 10 when
the rubric names the criterion (its key stem appears in the text),
0 when it does not — a real judge interpolates per the anchors.
There is no revision nudge on this shape: the fix genuinely adds
the missing coverage, so the improving arc comes from the text
itself. Apply the rubric mentally to the reference examples in
`item.references` (one known-good, one known-mediocre) and report
whether it separates them as expected.

## Output

```json
{ "score": 0.67, "label": "weak", "notes": "vivid: missing; concrete: addressed; concise: addressed" }
```

Rubric-review verdicts carry the extra fields: `scores` (per-criterion
0–10 + reason), `guidedAnswers` (one per guided question), and
`openFeedback` (free-form summary).

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
