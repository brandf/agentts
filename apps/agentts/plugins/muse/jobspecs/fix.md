# Job spec: fix

Revise a work item from the judges' verdicts. The revision must
address what the judges found missing — that is what makes later
loops score higher. Do not merely rephrase.

## Input

```json
{ "item": { "text": "...", "goal": "..." },
  "rubric": { "criteria": ["vivid", "concrete", "concise"], "threshold": 0.8 },
  "verdicts": [{ "score": 0.5, "label": "weak", "notes": "vivid: missing; ..." }] }
```

## How to revise

1. Count the revision markers already in the text (`(revised N)`);
   the new text carries marker number n+1, as `(revised n).` appended
   to the existing text (the old text is kept, not replaced).
2. From every verdict's notes, collect the criteria marked "missing".
3. For each missed criterion, add one sentence that genuinely
   addresses it:
   - **vivid**: a sentence with a vivid image (e.g. "The fox's russet
     coat flashed golden in the morning light.").
   - **concrete**: a sentence with a concrete detail — a number, a
     name, a place (e.g. "It was the third morning the fox had
     crossed the stone road.").
   - **concise**: add nothing — concision comes from tightening, not
     adding. (The revision marker alone is the tightening signal.)
   - **any other criterion**: a sentence containing the criterion's
     first word, used meaningfully.
4. Keep the goal unchanged.

## Rubric-review shape

When the item is a rubric (`item.kind === "rubric"`), revise the
rubric text from the judges' verdicts — including their open-ended
feedback, which the verdicts carry alongside the scores:
1. From every verdict's `notes`, collect the criteria marked
   "missing". From every verdict's guided answers, question 1 (the
   missed dimension) names the same set — collect any criterion it
   names that the notes missed.
2. For each missed criterion, append one sentence that genuinely
   addresses it (one per criterion, in the rubric's own voice —
   e.g. "Coverage: this rubric scores every quality dimension that
   distinguishes good work from bad work, including the subtle
   ones."). The sentence must name the criterion: naming it is what
   the next round's judge checks.
3. Never append a guided answer verbatim: a Q2 answer quotes the
   criticism ("ignores coverage, discrimination"), and quoting it
   would make the next round score the criterion as addressed for
   merely being mentioned.
4. Append a revision marker `(revised n).` as in the generic shape.
   Keep `scope`, `artifactKind`, and `references` unchanged — the fix
   never rewrites the rubric's scope or its reference examples.

## Output

```json
{ "text": "<old text> (revised 1). The fox's russet coat flashed golden in the morning light.", "goal": "A vivid one-sentence story opening." }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
