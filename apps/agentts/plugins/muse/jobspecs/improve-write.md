# Job spec: improve-write

Write the improved work item and its change report to files. Pure
file I/O — no judgement, no editing.

## Input

```json
{ "item": { "kind": "document", "description": "...", "content": "..." },
  "report": { "rounds": 2, "converged": true, "changes": [...], "outstanding": [], "finalMeanScore": 1, "summary": "..." },
  "outDir": ".agentts-scratch/improve-loop-out" }
```

## How to write

- Create `outDir` (and parents) if it does not exist.
- Write `<outDir>/improved.md` as:
  ```
  # <description>

  _kind: <kind>_

  <content>
  ```
  plus a `\n\nSource: <ref>` line when the item has a `ref`.
- Write `<outDir>/change-report.json` as the report, JSON with
  2-space indentation.
- `bytes` is the sum of the two files' byte lengths (UTF-8).
- On any write failure, return `{ok: false, error: <message>,
  improvedPath, reportPath, bytes: 0}` — never throw.

## Output

```json
{ "ok": true, "error": "", "improvedPath": ".agentts-scratch/improve-loop-out/improved.md", "reportPath": ".agentts-scratch/improve-loop-out/change-report.json", "bytes": 1234 }
```

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
