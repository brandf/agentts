# Job spec: improve-judge

Critique one work item against a rubric and return a scorecard. One
judge of two: you are independent — score what YOU see, do not
coordinate with the other judge, do not copy another scorecard.

## Input

```json
{ "item": { "kind": "document", "description": "...", "content": "..." },
  "rubric": { "criteria": [{ "name": "concrete numbers", "description": "..." }], "threshold": 0.8 },
  "judge": 0 }
```

`judge` is your index (0 or 1). Judges differ: each weights one
criterion double — judge 0 weights axis 0, judge 1 weights axis 1
(axis i is the i-th criterion, 0-based). Every other axis weighs 1.
That is the whole difference between judges.

## How to score

One axis per criterion (score 1 if addressed, else 0), using the
criterion's NAME (not its description) for the check:

- **vivid** (name starts with "vivid"): the content contains a vivid
  word (vivid, bright, russet, flashed, striking, golden, crimson,
  blazing, shimmering, scarlet, gleaming).
- **concrete** (name starts with "concrete"): the content contains a
  concrete detail — a number, or a concrete noun (fox, coat, light,
  morning, dog, river, stone, road, cat, house, tree, rain, snow).
- **concise** (name starts with "concise"): the content is at most 25
  words.
- **any other criterion**: the content contains the criterion name's
  first word (case-insensitive).

A missed axis is a "major" finding; an addressed axis is a "nit"
finding (the aggregate drops nits when a major exists). v0 emits
only major + nit — never "blocking".

- Finding `id` is `finding-<slug>` where slug is the criterion name
  lowercased with non-alphanumerics as hyphens (e.g. "concrete
  numbers" -> `finding-concrete-numbers`).
- Missed: `detail` is `"<name>": not addressed — <description>`,
  `suggestion` is `Address the "<name>" criterion: <description>`.
- Addressed: `detail` is `"<name>": addressed, but could be
  strengthened`, `suggestion` is `Tighten the wording for "<name>".`.
- `axisScores` is one entry per criterion: `{criterion: <name>,
  score: 1 or 0, note: "addressed" or "not addressed"}`.
- The weighted mean is the weighted fraction addressed (judge j
  doubles axis j), rounded to two decimals.
- `summary` is `judge <judge>: <addressed> of <total> axes addressed
  (weighted mean <mean>)`.

## Output

```json
{ "judge": 0,
  "axisScores": [{ "criterion": "concrete numbers", "score": 0, "note": "not addressed" }],
  "findings": [{ "id": "finding-concrete-numbers", "criterion": "concrete numbers", "severity": "major", "detail": "\"concrete numbers\": not addressed — ...", "suggestion": "Address the \"concrete numbers\" criterion: ..." }],
  "summary": "judge 0: 0 of 3 axes addressed (weighted mean 0)" }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
