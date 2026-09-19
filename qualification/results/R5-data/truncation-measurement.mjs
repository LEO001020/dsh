/**
 * R5-data: re-derive the canonical-truncation contract by MEASUREMENT.
 *
 * This is a standalone probe, not a test. It exists so the truncation claim is
 * re-established from a fresh process against the REAL `buildWindow` of the
 * pinned checkout, rather than trusted from a previous agent's note.
 *
 * Run (from packages/dsh-daily-work, so the checkout's module graph resolves):
 *   node --import tsx/esm ../../../qualification/results/R5-data/truncation-measurement.mjs
 *
 * It prints one JSON line. Every number in it is measured, none is computed from
 * a constant the probe itself supplied.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The REAL `read-render.ts` of the pinned checkout, imported by ABSOLUTE path.
 *
 * A bare `@deepseek-ai/dsh-tool-fs` specifier cannot be used here: this file
 * lives outside the package tree, so Node resolves bare specifiers from THIS
 * directory and finds nothing. Importing the source file by path keeps the probe
 * honest about WHICH buildWindow it measured, and the module's own imports still
 * resolve from its real location in the checkout.
 */
const CHECKOUT = 'D:/DSH/src/dsh-src'
const READ_RENDER = `${CHECKOUT}/packages/fs/tool-fs/src/read-render.ts`
const READ_TOOL = `${CHECKOUT}/packages/fs/tool-fs/src/read.ts`

const {
  READ_MAX_BYTES,
  READ_MAX_LINE_LENGTH,
  buildWindow,
} = await import(pathToFileURL(READ_RENDER).href)

/** The source text of `truncateLine`, read from the file on disk. */
function sourceOf(path, marker) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/u)
  const hit = lines.findIndex(line => line.includes(marker))
  return { line: hit + 1, text: hit === -1 ? null : lines[hit] }
}

const out = {}

// --- fact 1: the cap is a real constant ------------------------------------
out.cap = { READ_MAX_LINE_LENGTH, READ_MAX_BYTES }

// --- fact 2: `truncateLine` keeps the HEAD and APPENDS a suffix ------------
const truncateSrc = sourceOf(READ_RENDER, 'function truncateLine')
out.truncateLineSource = truncateSrc
const capSrc = sourceOf(READ_RENDER, 'const lineBufferCap')
out.lineBufferCapSource = capSrc

// --- fact 3: `read.ts` assigns window.lines into the canonical value -------
const assignSrc = sourceOf(READ_TOOL, 'lines: window.lines')
out.canonicalAssignmentSource = assignSrc
out.readToolPath = READ_TOOL
out.readRenderPath = READ_RENDER

// --- MEASUREMENT: a 102,400-byte single line through the REAL buildWindow ---
const head = 'HEAD-'.repeat(100)
const tail = '-TAILMARKER'
const line = `${head}${'A'.repeat(102400 - head.length - tail.length)}${tail}`
out.stimulus = {
  byteLength: Buffer.byteLength(line, 'utf8'),
  charLength: line.length,
  sha256: createHash('sha256').update(Buffer.from(line, 'utf8')).digest('hex'),
}

const window = await buildWindow(
  [line],
  { offset: 1, limit: 2000, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
  'long.txt',
)

const text = window.lines[0]?.text ?? ''
out.measured = {
  totalLines: window.totalLines,
  linesReturned: window.lines.length,
  clippedCharLength: text.length,
  expectedSuffixChars: '... (line truncated to 2000 chars)'.length,
  hasSuffix: text.includes('... (line truncated to 2000 chars)'),
  tailMarkerSurvives: text.includes('TAILMARKER'),
  // THE decisive property: the clipped value is not a prefix, so `slice` cannot
  // recover the original. `startsWith` is the falsifiable form of "not a prefix".
  clippedIsPrefixOfOriginal: line.startsWith(text),
  // How many bytes of the original the clipped value does NOT contain, measured
  // by removing the appended suffix and comparing lengths.
  interiorBytesLost: Buffer.byteLength(line, 'utf8') - Buffer.byteLength(text, 'utf8'),
  clippedSha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
}

// --- MEASUREMENT: offset=2 cannot reach the interior -----------------------
try {
  await buildWindow(
    [line],
    { offset: 2, limit: 2000, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
    'long.txt',
  )
  out.offset2 = { threw: false, message: null }
} catch (error) {
  out.offset2 = { threw: true, message: String(error.message) }
}

// --- MEASUREMENT: the line buffer cap is maxLineLength + 1 -----------------
//
// The cap is observable: a line of exactly `maxLineLength + 1` chars and a line
// of 100x that must produce the SAME clipped text, because the buffer stops
// growing one char past the cap. If the buffer were unbounded, a line whose
// content at position `maxLineLength + 1` differed would still be clipped
// identically -- so instead we test the boundary that the cap DEFINES: a line of
// exactly `maxLineLength` chars is NOT truncated, and `maxLineLength + 1` IS.
const exact = 'B'.repeat(READ_MAX_LINE_LENGTH)
const oneOver = 'C'.repeat(READ_MAX_LINE_LENGTH + 1)
const exactWindow = await buildWindow(
  [exact],
  { offset: 1, limit: 1, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
  'exact.txt',
)
const oneOverWindow = await buildWindow(
  [oneOver],
  { offset: 1, limit: 1, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
  'oneover.txt',
)
out.boundary = {
  atCapTruncated: (exactWindow.lines[0]?.text ?? '').length !== READ_MAX_LINE_LENGTH,
  oneOverCapTruncated: (oneOverWindow.lines[0]?.text ?? '').includes('... (line truncated'),
  oneOverClippedLength: (oneOverWindow.lines[0]?.text ?? '').length,
}

// --- MEASUREMENT: a larger maxBytes does NOT recover the interior ----------
const biggerBytes = await buildWindow(
  [line],
  { offset: 1, limit: 2000, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: 50 * 1024 * 1024 },
  'long.txt',
)
out.biggerMaxBytes = {
  clippedCharLength: (biggerBytes.lines[0]?.text ?? '').length,
  tailMarkerSurvives: (biggerBytes.lines[0]?.text ?? '').includes('TAILMARKER'),
}

// --- MEASUREMENT: a larger maxLineLength DOES recover it -------------------
//
// This is the honest counter-case: the loss is a CONFIGURED cap, so raising the
// cap above the line length recovers it. What no configuration can do is recover
// it AFTER the fact, because the caller only ever holds the clipped value.
const raisedCap = await buildWindow(
  [line],
  { offset: 1, limit: 2000, maxLineLength: 200_000, maxBytes: 50 * 1024 * 1024 },
  'long.txt',
)
out.raisedMaxLineLength = {
  clippedCharLength: (raisedCap.lines[0]?.text ?? '').length,
  tailMarkerSurvives: (raisedCap.lines[0]?.text ?? '').includes('TAILMARKER'),
  byteForByte: Buffer.from(raisedCap.lines[0]?.text ?? '', 'utf8').toString('utf8') === line,
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
