# Job spec: rubric-update

Revise a rubric from the judges' verdicts. The rubric names what
good looks like; when judges keep missing the same thing the rubric
does not name yet, the rubric — not the item — is what needs to
change.

## Input

```json
{ "rubric": { "criteria": ["vivid", "concrete", "concise"], "threshold": 0.8 },
  "verdicts": [{ "score": 0.5, "label": "weak", "notes": "vivid: missing; ..." }] }
```

## How to update

1. From every verdict's notes, collect the criteria marked "missing".
2. If any criterion was missed AND the rubric does not already name
   "concrete example", add "concrete example" to the criteria (once
   — never duplicate it). That is the one criterion this update is
   allowed to add: a repeated miss the rubric does not name yet
   becomes a criterion.
3. Keep every existing criterion, in order. Keep the threshold
   unchanged.

Text rubrics: when the rubric carries `text` (a markdown blob, e.g.
the meta-rubric), return it unchanged — v0 never rewrites versioned
human-owned prose. The loop records the update round and needs two
more loops before convergence.

## Output

```json
{ "criteria": ["vivid", "concrete", "concise", "concrete example"], "threshold": 0.8 }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
