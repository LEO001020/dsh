# The canonical truncation, verified in source

The audit's M4 design rests on a specific claim: that `read`'s long-line clipping
has ALREADY happened before any consumer sees the value, so a Python program
cannot recover the missing bytes by reading more. That claim is load-bearing — if
it were false, the whole capture/byte-range layer would be unnecessary — so it was
verified in source before the data plane was built on it.

## The claim is correct

Three facts, each from the pinned checkout:

**1. The cap is a real constant.** `packages/fs/tool-fs/src/read-render.ts:11`

```ts
export const READ_MAX_LINE_LENGTH = 2000
```

**2. The clipping keeps the HEAD and discards the TAIL.** `read-render.ts:69-70`

```ts
function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line
}
```

`substring(0, maxLineLength)` retains the first 2000 characters. The remainder is
dropped and replaced by a marker. Nothing preserves it.

**3. It happens on the CANONICAL path, not only at render time.**
`packages/fs/tool-fs/src/read.ts:148-158`:

```ts
const window = await buildWindow(
  chunks,
  { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
  target.displayPath,
)
const outcome = {
  path: target.displayPath,
  offset: input.offset,
  lines: window.lines,        // <- the clipped lines ARE the returned value
  totalLines: window.totalLines,
}
return outcome
```

`window.lines` is assigned straight into the value the tool returns. The
truncation is therefore part of the tool's canonical output, not a presentation
choice made afterwards.

## Why a larger offset cannot recover it

`FileTextLine` is addressed by **line number** (`read-render.ts:29-34`):

```ts
export interface FileTextLine {
  /** 1-based line number in the file. */
  number: number
  /** Line text without its trailing newline. */
  text: string
}
```

So `offset` selects a different LINE. For a file whose first line is 100 KiB, line
1 is clipped at 2000 characters and line 2 does not exist. Requesting a larger
offset moves past the only line there is; the discarded interior of line 1 is
never addressable through this interface at any offset or limit.

**This is the precise difference between "the output was truncated for display"
and "the data was never obtained".** Only the first is recoverable by asking
again. The audit's rule — that the layer of loss must be recorded, and that
"omitted from the model context" is usually recoverable while "never acquired" is
not — applies exactly here, and this is the concrete case that makes it real
rather than theoretical.

## Consequence for M4

A `read`-based consumer cannot be repaired by raising `maxBytes` or looping over
offsets, because neither addresses the interior of a single long line. The fix has
to be a path that never clips: a streaming capture that writes the bytes to an
artifact while computing its hash, with paging against the IMMUTABLE captured
object afterwards. That is what M4 builds, and this note is why.

The original `read` keeps its contract and its documented limit — the audit is
explicit that this is not "rewrite every native tool". `grep` and `web_fetch` are
different cases (their canonical values retain the raw-cap matches and the
provider body respectively, with the renderer narrowing afterwards), so they are
not subject to this defect and must not be rewritten as if they were.

## Status

Verified from source and its tests (`tests/read-render.spec.ts` asserts the
clipping). Not yet verified by execution on this machine; M4's `DAT-01` is the
gate that must demonstrate byte-for-byte recovery of a single 100 KiB line
through the new capture path.
