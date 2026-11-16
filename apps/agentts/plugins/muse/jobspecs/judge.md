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

## Output

```json
{ "score": 0.67, "label": "weak", "notes": "vivid: missing; concrete: addressed; concise: addressed" }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
