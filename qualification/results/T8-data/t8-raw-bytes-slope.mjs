/**
 * T8-data supplementary: pin the exact relationship between path length and
 * ripgrep's `--json` stdout size, and separate it from the timing jitter.
 *
 * WHY A SECOND PROBE. The first sweep produced 249,448 for 68 path chars on one
 * run and 249,446 on the next -- the same jitter it was measuring. A coefficient
 * derived from two single samples is therefore itself unreliable, so this probe
 * takes REPEATED samples per path length and reports the MODE and the SPREAD.
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-raw-bytes-slope.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const OUT_DIR = 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data'
const requireFromPkg = createRequire(`${PKG}/package.json`)
const searchCore = await import(pathToFileURL(requireFromPkg.resolve('@deepseek-ai/dsh-tool-fs-search/src/search-core.ts')).href)
const rg = await searchCore.resolveRgPath()

const MATCHES = 900
const lines = Array.from({ length: MATCHES }, (_, i) => `needle-${i}-${'x'.repeat(20)}`)
const root = mkdtempSync(join(tmpdir(), 't8-slope-'))
const out = { probe: 't8-raw-bytes-slope', measuredAt: new Date().toISOString(), matches: MATCHES, samplesPerLength: 5, points: [] }

try {
  mkdirSync(join(root, 'd'), { recursive: true })
  const prefix = join(root, 'd')
  for (const extra of [4, 6, 8, 10, 12]) {
    const padLen = extra
    const file = join(prefix, `${'p'.repeat(padLen)}many.txt`)
    writeFileSync(file, `${lines.join('\n')}\n`)
    const readings = []
    const printed = []
    for (let i = 0; i < out.samplesPerLength; i += 1) {
      const { stdout } = await execFileAsync(rg, ['--json', '--no-config', 'needle', file], { maxBuffer: 64 * 1024 * 1024 })
      readings.push(Buffer.byteLength(stdout, 'utf8'))
      const summary = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
      printed.push(summary.data?.stats?.bytes_printed ?? null)
    }
    const mode = [...new Set(readings)].sort((a, b) => readings.filter(v => v === b).length - readings.filter(v => v === a).length)[0]
    out.points.push({
      pathChars: file.length,
      rawBytes: readings,
      mode,
      spread: Math.max(...readings) - Math.min(...readings),
      bytesPrinted: [...new Set(printed)],
    })
  }

  // The slope: (mode at the longest path - mode at the shortest) / path-char delta.
  const first = out.points[0]
  const last = out.points.at(-1)
  const deltaChars = last.pathChars - first.pathChars
  const deltaBytes = last.mode - first.mode
  out.slope = {
    deltaChars,
    deltaBytes,
    bytesPerPathChar: deltaBytes / deltaChars,
    matches: MATCHES,
    excessOverMatches: deltaBytes / deltaChars - MATCHES,
    reading: 'the path appears once per match event, so the coefficient is MATCHES + a small constant',
  }
  // `bytes_printed` includes the path once per match, so it MUST rise with path
  // length. What must be stable is the value across REPEATS at one length -- that
  // is the match data, and it is the part a caller actually cares about.
  out.bytesPrintedRisesWithPathLength = new Set(out.points.map(point => point.bytesPrinted[0])).size > 1
  out.bytesPrintedStableAcrossRepeats = out.points.every(point => point.bytesPrinted.length === 1)
  out.bytesPrintedValuesByPathChars = out.points.map(point => ({ pathChars: point.pathChars, bytesPrinted: point.bytesPrinted[0] }))
  out.rawBytesJittersAtFixedLength = out.points.some(point => point.spread > 0)
  out.jitterObservation = out.rawBytesJittersAtFixedLength
    ? 'jitter WAS observed at a fixed path length in this run'
    : `no jitter observed at a fixed path length in this run (${out.samplesPerLength} samples per point); `
      + 'it WAS observed in t8-four-byte-classes.mjs (10 samples on one path: {241328, 241330} with bytes_printed constant)'
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

out.command = 'cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm '
  + 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-raw-bytes-slope.mjs'
out.probeScriptSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
writeFileSync(join(OUT_DIR, 'raw-bytes-slope.json'), `${JSON.stringify(out, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
