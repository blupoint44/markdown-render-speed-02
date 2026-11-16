# markdown-render-speed-02 entry

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/blupoint44/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/blupoint44/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)


A dependency-free Markdown renderer (`parse.js`, ES module exporting
`parse(markdown)`) that renders byte-identical HTML to marked 18.1.3 with
default options, plus the `main.ts` driver that renders `/input/cases.json`
to `/output/html.json`.

## Current status

Byte-identical to marked on 4,316 of 4,320 generated cases across six
independently seeded sets (720 cases each): the kit practice set and five
fresh-seed sets all score 720/720 except gen4 (717/720) and gen5 (719/720).
The remaining differences are block-level list-capture edge cases (a tab
continuation indent, a paragraph trailing newline and a dropped blank line
inside list items) and one nested-link case where an escaped `\]` inside an
inner link label makes the reference renderer prefer the outer link.

## How it works

`parse.js` is a single-pass block lexer feeding a single-pass inline
parser, with no dependencies and no build step:

- Blocks: ATX/setext headings, fenced and indented code, blockquotes,
  lists (with marked's item-capture rules, including lazy continuations
  and fence feeding), tables, HTML blocks, link reference definitions.
- Inline: a delimiter-stack emphasis matcher driven by a global code
  mask — backtick runs are paired up front (a run closes at the next run
  of equal length) and a masked run is inert as a closer but can still
  open. When a reference link forms, mask ranges that started inside its
  label are dropped and the remaining runs are re-paired from that point,
  because the dropped range's closing run becomes an opener and shifts
  every later pairing. Matched emphasis spans are then re-parsed against
  their own content mask (two-phase mask recursion), so pairs killed by
  a boundary-spanning mask in the outer pass can still form inside a
  span that was actually matched.
- Links/images use a bracket stack with marked's fallbacks: failed
  full-reference attempts whose reference resolves drop the mask ranges
  overlapping the attempt, and labels containing bare URLs are rescanned
  as ordinary text when the bracket fails.

`main.ts` resolves the input/output directories (`--input`/`--output`
flags, then `MAKEFUN_INPUT_DIR`/`MAKEFUN_OUTPUT_DIR`, then `/input` and
`/output`), validates the cases file shape, renders each case
independently with `parse()`, and writes the HTML strings in input order
as a JSON array.

MIT licensed.
