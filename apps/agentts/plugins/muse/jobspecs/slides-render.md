# Job spec: slides-render

Render a finished deck to files: the deck as JSON and as Markdown.

## Input

```json
{ "deck": { "deckId": "deck-9f2c41a0b7e1", "title": "Quarterly review",
            "slides": [{ "title": "What shipped", "bullets": ["3 teams shipped in Q3"] }],
            "text": "Quarterly review\nSlide 1: What shipped\n- 3 teams shipped in Q3", "revisions": 1 },
  "outDir": ".agentts-scratch/presentations-out" }
```

- `outDir` defaults to `.agentts-scratch/presentations-out` when
  empty or missing.

## How to render

- Create `outDir` if it does not exist (recursive).
- Write `deck.json`: `JSON.stringify(deck, null, 2)`.
- Write `deck.md`:
  ```
  # <title>

  ## Slide 1: <slide title>

  - <bullet>
  - <bullet>

  ## Slide 2: <slide title>

  - <bullet>

  Deck: <deckId> · <n> slides
  ```
  (one blank line after the title, one blank line after each
  slide's heading, one blank line after each slide's bullets, and
  the `Deck:` footer line last, followed by a trailing newline.)
- `bytes` is the byte length of the JSON plus the byte length of
  the Markdown, UTF-8.

## Output

```json
{ "ok": true, "error": "",
  "deckId": "deck-9f2c41a0b7e1",
  "deckPath": ".agentts-scratch/presentations-out/deck.json",
  "markdownPath": ".agentts-scratch/presentations-out/deck.md",
  "slides": 1, "bytes": 512 }
```

On a write failure, return `ok: false` with `error` naming the
problem (and `bytes: 0`) instead of throwing — the workflow
decides how to fail.

## Notes (learnings from workers — append, don't rewrite)

<!-- specialist learnings accumulate here via POST /note -->
