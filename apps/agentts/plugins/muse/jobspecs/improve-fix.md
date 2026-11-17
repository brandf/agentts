# Job spec: improve-fix

Apply the decided fixes to the work item by appending addressing
sentences. Do not rewrite the item — append only, so the original
text stays intact and the change is auditable.

## Input

```json
{ "item": { "kind": "document", "description": "...", "content": "..." },
  "rubric": { "criteria": [{ "name": "concrete numbers", "description": "..." }], "threshold": 0.8 },
  "decision": { "needsFix": true, "fixes": [{ "findingId": "finding-concrete-numbers", "action": "..." }], "reason": "..." },
  "aggregated": { "findings": [{ "id": "finding-concrete-numbers", "criterion": "concrete numbers", "severity": "major", "detail": "...", "suggestion": "..." }], "dropped": [...], "meanScore": 0, "summary": "..." } }
```

## How to fix

For each fix in `decision.fixes`, look up the finding in
`aggregated.findings` by `findingId` and append one sentence that
addresses its criterion (first word of the criterion name decides):

- **vivid**: append `A vivid, golden example brings the point to
  life.`
- **concrete**: append `In 2026, 3 pilot teams ran this process end
  to end.` (a sentence with digits — that is what "concrete" checks
  for).
- **concise**: SKIP — appending makes text longer, so concision
  cannot be fixed by appending. Record NO change for it.
- **any other criterion**: append `"<Name>: <description> (revised
  <n>)."` where `<Name>` is the criterion name, `<description>` is
  its rubric description, and `<n>` is one more than the number of
  `(revised` markers already in the content.

Prepend the appended sentences with a `(revised <n>)` marker: the new
content is `<old content> (revised <n>). <sentence 1> <sentence 2>
...`. When no fix produces a sentence (e.g. only "concise" was to be
fixed), the content is unchanged and `changes` is empty.

Record one change per sentence appended: `{round: 0, findingId,
description: "Added coverage for '<criterion>': <sentence>", why:
<the finding's detail>}`. `round` is 0 here — the workflow owns the
round and stamps it onto the changes; do not guess it.

## Output

```json
{ "item": { "kind": "document", "description": "...", "content": "... (revised 1). In 2026, 3 pilot teams ran this process end to end. ..." },
  "changes": [{ "round": 0, "findingId": "finding-concrete-numbers", "description": "Added coverage for 'concrete numbers': In 2026, 3 pilot teams ran this process end to end.", "why": "\"concrete numbers\": not addressed — ..." }] }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
