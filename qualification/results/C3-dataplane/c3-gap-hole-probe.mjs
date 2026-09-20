/**
 * C3 probe 2: is there a GENUINE unrecorded loss on the capture path?
 *
 * DATA-09's oracle rule: "A loss at one of those four stages that is not recorded
 * as a gap is NOT PASS." So the question is not "does every stage always emit" --
 * it is "is there a capture that loses bytes and reports no gap".
 *
 * THE CANDIDATE. `captureFile`'s completeness guard is:
 *
 *   const shortBy = sourceBytesAtStart !== undefined && request.requestedRange === undefined
 *     ? sourceBytesAtStart - published.bytes
 *     : 0
 *
 * A RANGE request therefore forces `shortBy = 0`, so completeness is
 * `complete-within-request` and no gap is filed -- regardless of how many of the
 * requested bytes actually arrived. If the range names bytes the source does not
 * have (offset+length past EOF), the caller asked for N bytes and got fewer, and
 * `complete-within-request` is a FALSE claim about the requested range.
 *
 * That is not a fabricated loss: the bytes are absent from a range the caller
 * named. `observations.ts` defines `partial` as exactly "bytes inside the
 * requested range are known to be absent".
 *
 * Run: node qualification/results/C3-dataplane/c3-gap-hole-probe.mjs --label before
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..').replace(/\\/g, '/')
const PKG = `${REPO}/packages/dsh-daily-work`

const labelIndex = process.argv.indexOf('--label')
const label = labelIndex === -1 ? 'after' : process.argv[labelIndex + 1]

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const { default: AttachmentLocal } = await import(resolveFromPkg('@deepseek-ai/dsh-attachment-local'))
const artifacts = await import(pathToFileURL(`${PKG}/lib/artifacts.js`).href)
const observations = await import(pathToFileURL(`${PKG}/lib/observations.js`).href)

const fileDigest = path => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

const out = {
  probe: 'c3-gap-hole',
  label,
  measuredAt: new Date().toISOString(),
  identity: {
    srcArtifactsTs: fileDigest(`${PKG}/src/artifacts.ts`),
    libArtifactsJs: fileDigest(`${PKG}/lib/artifacts.js`),
  },
  arms: {},
}

const tempDirs = []
function tempRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `c3hole-${name}-`))
  tempDirs.push(dir)
  return dir
}

function makePlane(name, scope = 'project:c3hole') {
  const root = tempRoot(name)
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: join(root, 'home') })
  const store = new artifacts.AttachmentArtifactStore(ctx.attachments, join(root, 'artifacts'))
  const log = new artifacts.InMemorySessionReferenceLog()
  const grants = new observations.GrantTable()
  grants.bump(scope)
  return { store, log, grants, scope, ctx, root }
}

function mountFs(cwd) {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}

/** Capture with an explicit requested range, reporting the record's own claims. */
async function captureRange(name, fileBytes, requestedRange) {
  const root = tempRoot(name)
  writeFileSync(join(root, 'p.bin'), Buffer.alloc(fileBytes, 0x41))
  const plane = makePlane(name)
  const outcome = await artifacts.captureFile({
    fs: mountFs(root), path: 'p.bin', store: plane.store, log: plane.log, grants: plane.grants,
    ownerScope: plane.scope, executionWorld: 'local', observationId: `obs-${name}`,
    mediaType: 'application/octet-stream', requestedRange,
  })
  return {
    fileBytes,
    requestedRange,
    requestedBytes: requestedRange.length,
    publishedBytes: outcome.descriptor.captured.bytes,
    completeness: outcome.descriptor.acquisition.completeness,
    coverageVerdict: observations.coverageVerdictOf(outcome.descriptor),
    gaps: outcome.gaps.map(gap => ({ stage: gap.stage, recovery: gap.recovery })),
    // The oracle's question: were bytes inside the REQUESTED RANGE absent, and was
    // that absence recorded?
    bytesMissingFromRequestedRange: Math.max(0, requestedRange.length - outcome.descriptor.captured.bytes),
    deliverableAsComplete: observations.isDeliverableAsComplete(outcome.descriptor),
  }
}

try {
  // ARM A: the range is entirely inside the file. Nothing is lost; completeness
  // `complete-within-request` and NO gap is the CORRECT answer. (Control: without
  // this arm, a change that filed a gap on every range request would look right.)
  out.arms.rangeInsideFile = await captureRange('inside', 4096, { offset: 0, length: 1024 })

  // ARM B: the range names bytes past EOF. The caller asked for 1000 bytes of a
  // 400-byte file, so 600 bytes of the requested range are absent. If this reports
  // `complete-within-request` with no gap, the absence is UNRECORDED.
  out.arms.rangePastEof = await captureRange('past-eof', 400, { offset: 0, length: 1000 })

  // ARM C: an offset past EOF with a length. Every requested byte is absent.
  out.arms.rangeEntirelyPastEof = await captureRange('all-past-eof', 400, { offset: 1000, length: 512 })

  // ARM D: a whole-file capture whose reader stops short -- the KNOWN-GOOD arm,
  // so the probe shows the detector can see a recorded loss at all.
  {
    const root = tempRoot('short-reader')
    writeFileSync(join(root, 'p.bin'), Buffer.alloc(1000, 0x41))
    const plane = makePlane('short-reader')
    const outcome = await artifacts.captureFile({
      fs: mountFs(root), path: 'p.bin', store: plane.store, log: plane.log, grants: plane.grants,
      ownerScope: plane.scope, executionWorld: 'local', observationId: 'obs-short-reader',
      mediaType: 'application/octet-stream',
      readChunks: async function* () { yield Buffer.alloc(400, 0x41) },
    })
    out.arms.wholeFileShortReader = {
      publishedBytes: outcome.descriptor.captured.bytes,
      completeness: outcome.descriptor.acquisition.completeness,
      gaps: outcome.gaps.map(gap => ({ stage: gap.stage, recovery: gap.recovery })),
    }
  }
} catch (error) {
  out.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
}

for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) } catch { /* best effort */ }
}

// The finding, stated as the oracle states it.
out.finding = {
  rangePastEofIsUnrecordedLoss:
    (out.arms.rangePastEof?.bytesMissingFromRequestedRange ?? 0) > 0
    && (out.arms.rangePastEof?.gaps ?? []).length === 0
    && out.arms.rangePastEof?.completeness === 'complete-within-request',
  rangeEntirelyPastEofIsUnrecordedLoss:
    (out.arms.rangeEntirelyPastEof?.bytesMissingFromRequestedRange ?? 0) > 0
    && (out.arms.rangeEntirelyPastEof?.gaps ?? []).length === 0
    && out.arms.rangeEntirelyPastEof?.completeness === 'complete-within-request',
  controlInsideRangeRecordsNoGap: (out.arms.rangeInsideFile?.gaps ?? []).length === 0,
  controlShortReaderRecordsGap: (out.arms.wholeFileShortReader?.gaps ?? []).length > 0,
}

writeFileSync(join(HERE, `gap-hole-${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(out.arms, null, 1))
console.log(JSON.stringify(out.finding, null, 1))
