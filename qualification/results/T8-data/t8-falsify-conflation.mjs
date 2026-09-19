/**
 * T8-data: FALSIFY the four byte classes -- would a CONFLATED implementation be
 * CAUGHT?
 *
 * A measurement that only reports four numbers does not prove they are four
 * distinct quantities; an implementation that computed one number and printed it
 * four times would look identical. So this probe constructs the specific
 * conflation and checks the product DETECTS it:
 *
 *   A projection that echoed `artifactBytes` into `bytesConsumed` would report
 *   1,048,576 for a walk that actually served 131,072 bytes. The product reports
 *   both fields with DIFFERENT values, so that conflation is visible in the
 *   record rather than silent.
 *
 * It also checks the second pair that could collapse: `acquisition.completeness`
 * (a fact about the ACQUISITION) against `walk.exhausted` (a fact about THIS
 * walk). They are different facts about the same object and the product reports
 * them separately -- a complete artifact walked for two pages is
 * `complete-within-request` AND not exhausted, at the same time.
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-falsify-conflation.mjs
 */
/**
 * FALSIFICATION: if the four classes were conflated, which assertions would fail?
 * Run the product's own projection and check that a conflated implementation
 * would be DETECTED, not silently accepted.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const r = s => pathToFileURL(createRequire(`${PKG}/package.json`).resolve(s)).href
const { Context } = await import(r('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(r('@deepseek-ai/dsh-fs-local'))
const artifacts = await import(pathToFileURL(`${PKG}/src/artifacts.ts`).href)
const observations = await import(pathToFileURL(`${PKG}/src/observations.ts`).href)

const root = mkdtempSync(join(tmpdir(), 't8-falsify-'))
const out = {}
try {
  const pageBytes = 64 * 1024
  const totalBytes = 16 * pageBytes
  writeFileSync(join(root, 'f.bin'), Buffer.alloc(totalBytes, 0x41))
  const ctx = new Context()
  const fs = new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const store = new artifacts.LocalArtifactStore(join(root, 'artifacts'))
  const log = new artifacts.InMemorySessionReferenceLog()
  const grants = new observations.GrantTable()
  const scope = 'project:t8f'
  grants.bump(scope)
  const capture = await artifacts.captureFile({
    fs, path: 'f.bin', store, log, grants, ownerScope: scope,
    executionWorld: 'local', observationId: 'obs-f', mediaType: 'application/octet-stream',
  })
  const persisted = (await store.stat(capture.descriptor.captured.artifact)).bytes
  let consumed = 0
  const walk = await artifacts.walkPages(new artifacts.ArtifactStorePageProvider(store),
    { descriptor: capture.descriptor, maxBytes: pageBytes, grants, callerScope: scope },
    { maxPages: 2, onPage: p => { consumed += p.bytes.byteLength } })
  const projection = artifacts.projectForModel({
    descriptor: capture.descriptor, pagesConsumed: walk.pages, bytesConsumed: consumed,
    exhausted: walk.exhausted, consumerNote: 'two pages only',
  })
  const modelVisible = Buffer.byteLength(JSON.stringify(projection), 'utf8')

  out.numbers = { acquired: capture.io.sourceBytesRead, persisted, consumed, modelVisible }
  // A CONFLATED projection would report the artifact's size as `bytesConsumed`.
  // The product reports the walk's count instead, so the two fields differ.
  out.falsification = {
    projectionArtifactBytes: projection.artifactBytes,
    projectionBytesConsumed: projection.bytesConsumed,
    wouldAConflatedProjectionBeCaught: projection.artifactBytes !== projection.bytesConsumed,
    claim: 'a projection that echoed artifactBytes into bytesConsumed would report 1048576 for a 131072-byte walk',
  }
  // And the record must NOT claim completeness for a partial walk.
  out.completenessIsNotConflatedWithExhaustion = {
    descriptorCompleteness: capture.descriptor.acquisition.completeness,
    walkExhausted: walk.exhausted,
    isDeliverableAsComplete: observations.isDeliverableAsComplete(capture.descriptor),
    note: 'descriptor completeness is about the ACQUISITION; walk.exhausted is about THIS walk. They are different facts and both are reported.',
  }
  // The acquired-vs-source-size case: the guard must fire WITHOUT a range.
  const root2 = mkdtempSync(join(tmpdir(), 't8-falsify2-'))
  writeFileSync(join(root2, 's.bin'), Buffer.alloc(5000, 0x42))
  const ctx2 = new Context()
  const fs2 = new LocalFileSystem(ctx2, { cwd: root2, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const store2 = new artifacts.LocalArtifactStore(join(root2, 'artifacts'))
  const log2 = new artifacts.InMemorySessionReferenceLog()
  const grants2 = new observations.GrantTable()
  grants2.bump(scope)
  const shortCapture = await artifacts.captureFile({
    fs: fs2, path: 's.bin', store: store2, log: log2, grants: grants2, ownerScope: scope,
    executionWorld: 'local', observationId: 'obs-s', mediaType: 'application/octet-stream',
    readChunks: async function* () { yield Buffer.alloc(2000, 0x42) },
  })
  out.acquiredVsSourceSize = {
    sourceFileBytes: 5000, acquiredBytes: shortCapture.io.sourceBytesRead,
    completeness: shortCapture.descriptor.acquisition.completeness,
    gapStages: shortCapture.gaps.map(g => g.stage),
    guardFired: shortCapture.gaps.length > 0 && shortCapture.descriptor.acquisition.completeness === 'partial',
  }
  rmSync(root2, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
out.command = 'cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm '
  + 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-falsify-conflation.mjs'
out.measuredAt = new Date().toISOString()
out.probeScriptSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex')
writeFileSync('D:/DSH/work/dsh-native-daily/qualification/results/T8-data/falsify-conflation.json',
  `${JSON.stringify(out, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
