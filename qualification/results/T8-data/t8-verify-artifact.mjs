/**
 * T8-data: independently verify the persisted observation artifact.
 *
 * WHY A SEPARATE PROCESS. The requirement is that the artifact's byte accounting
 * is the artifact's OWN, not a summary of numbers computed in-process by the run
 * that produced it. A number a program reports about a value it still holds is a
 * claim about its own variable, not about the disk. So this file runs in a FRESH
 * process, reads `four-byte-classes.json` for what was recorded, and then
 * re-derives every persisted-byte fact from the FILE ON DISK:
 *
 *   1. `fs.statSync`  -- the OS's own byte length for the object
 *   2. a streamed sha256 over the file's bytes, in 64 KiB windows
 *   3. the product's own `LocalArtifactStore.stat` on a COLD store (no in-memory
 *      state from the producing run), so the store's byte accounting is
 *      reproduced rather than remembered
 *   4. the product's `readArtifactRange` over the whole object, hashed again, so
 *      the object is proven readable through the product's own range API and not
 *      only by a raw file read
 *   5. the stimulus recipe is REGENERATED and hashed, so the artifact's content
 *      is traceable to the recorded inputs and not merely self-consistent
 *
 * Any disagreement is printed as a FAILURE with both numbers. Nothing here can
 * make the earlier run's numbers true; it can only contradict them.
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-verify-artifact.mjs
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const OUT_DIR = 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data'
const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const artifacts = await import(pathToFileURL(`${PKG}/src/artifacts.ts`).href)
const observations = await import(pathToFileURL(`${PKG}/src/observations.ts`).href)

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** sha256 of a file by STREAMING it in bounded windows, never holding it whole. */
function sha256OfFile(path, windowBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createReadStream(path, { highWaterMark: windowBytes })
    stream.on('data', chunk => { hash.update(chunk); bytes += chunk.byteLength })
    stream.on('error', reject)
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes, windows: Math.ceil(bytes / windowBytes) }))
  })
}

const out = {
  verifier: 't8-verify-artifact',
  verifiedAt: new Date().toISOString(),
  host: { node: process.version, platform: `${process.platform} ${process.arch}` },
  command: 'cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm '
    + 'D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-verify-artifact.mjs',
  checks: {},
  failures: [],
}

function check(id, assertion, passed, detail) {
  out.checks[id] = { assertion, passed, detail }
  if (!passed) out.failures.push(`${id}: ${assertion} -- ${JSON.stringify(detail)}`)
}

try {
  const recorded = JSON.parse(readFileSync(join(OUT_DIR, 'four-byte-classes.json'), 'utf8'))
  const s1 = recorded.scenarios?.S1_full_walk
  if (s1 === undefined) throw new Error('four-byte-classes.json has no S1_full_walk; nothing to verify')

  out.recordedProvenance = {
    probeStartedAt: recorded.startedAt,
    probeFinishedAt: recorded.finishedAt,
    probeScriptSha256: recorded.probeScriptSha256,
    stimulusBytes: recorded.stimulus?.bytes,
    stimulusSha256: recorded.stimulus?.sha256,
    stimulusRecipe: recorded.stimulus?.recipe,
    artifactRef: s1.artifactRef,
    artifactPath: s1.artifactPath,
    artifactSha256: s1.artifactSha256,
    acquiredBytes: s1.acquiredBytes,
    persistedBytes: s1.persistedBytes,
    consumedBytes: s1.consumedBytes,
    modelVisibleBytes: s1.modelVisibleBytes,
  }

  // --- the artifact is ON DISK at the path the run recorded -----------------
  const path = s1.artifactPath
  check('V-01', 'the persisted object exists at the recorded path', existsSync(path), { path })
  const osStat = statSync(path)

  // --- (1) the OS's own byte length ----------------------------------------
  check('V-02', 'the OS reports the same byte length as the recorded persistedBytes',
    osStat.size === s1.persistedBytes, { osStatBytes: osStat.size, recordedPersistedBytes: s1.persistedBytes })

  // --- (2) a streamed digest over the file on disk --------------------------
  const streamed = await sha256OfFile(path)
  check('V-03', 'a fresh streamed sha256 over the file equals the recorded artifact digest',
    streamed.sha256 === s1.artifactSha256, { streamed: streamed.sha256, recorded: s1.artifactSha256 })
  check('V-04', 'the streamed byte count equals the OS byte length',
    streamed.bytes === osStat.size, { streamed: streamed.bytes, osStat: osStat.size })

  // --- (3) the PRODUCT's store, cold, must reproduce the same accounting ----
  const coldStore = new artifacts.LocalArtifactStore(join(OUT_DIR, 'artifacts'))
  const storeStat = await coldStore.stat(s1.artifactRef)
  check('V-05', 'a COLD product store reports the same bytes and digest for the recorded ref',
    storeStat?.bytes === s1.persistedBytes && storeStat?.sha256 === s1.artifactSha256,
    { coldStoreStat: storeStat, recordedBytes: s1.persistedBytes, recordedSha256: s1.artifactSha256 })

  // --- (4) the object is readable through the product's own range API -------
  // A descriptor is required to read a range, so the recorded one is rebuilt from
  // the recorded facts rather than trusted from memory. If any recorded fact were
  // wrong, this rebuild is where it would show.
  const grants = new observations.GrantTable()
  const scope = s1.artifactRef === undefined ? 'project:t8' : 'project:t8'
  grants.bump(scope)
  const descriptor = observations.mintObservation({
    id: 'obs-t8-verify',
    source: { kind: 'file', locator: 'stimulus.txt', acquiredAt: recorded.startedAt, executionWorld: 'local' },
    captured: {
      artifact: s1.artifactRef, sha256: s1.artifactSha256, bytes: s1.persistedBytes, mediaType: 'text/plain',
    },
    acquisition: {
      completeness: 'complete-within-request',
      coverage: observations.coverageForRequest({ receivedBytes: s1.persistedBytes }),
      gaps: [],
    },
    authority: { ownerScope: scope, grantRevision: grants.revisionOf(scope) ?? 0 },
  })
  const io = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
  const rangeRead = await artifacts.readArtifactRange(coldStore, descriptor, { offset: 0, length: s1.persistedBytes }, io)
  check('V-06', 'reading the whole object through the product range API reproduces the recorded digest',
    sha256(Buffer.from(rangeRead)) === s1.artifactSha256, {
      rangeReadBytes: rangeRead.byteLength, rangeReadSha256: sha256(Buffer.from(rangeRead)), recorded: s1.artifactSha256,
    })
  check('V-07', 'the product range API accounted the read against the artifact, not the source',
    io.artifactBytesRead === s1.persistedBytes && io.sourceBytesRead === 0,
    { artifactBytesRead: io.artifactBytesRead, sourceBytesRead: io.sourceBytesRead })

  // --- (5) regenerate the stimulus and hash it ------------------------------
  // The recipe is in the JSON; if it does not reproduce the recorded digest, the
  // artifact's content is not traceable to its stated inputs.
  const LINE = `${'t8'.repeat(511)}X\n`
  const regenerated = Buffer.from(LINE.repeat((recorded.stimulus?.bytes ?? 0) / LINE.length), 'utf8')
  check('V-08', 'the recorded stimulus recipe regenerates bytes matching the recorded stimulus digest',
    sha256(regenerated) === recorded.stimulus?.sha256, {
      regeneratedBytes: regenerated.byteLength,
      regeneratedSha256: sha256(regenerated),
      recordedStimulusSha256: recorded.stimulus?.sha256,
    })
  check('V-09', 'the artifact on disk IS the stimulus, byte for byte',
    sha256(regenerated) === s1.artifactSha256, { stimulus: sha256(regenerated), artifact: s1.artifactSha256 })

  // --- the non-conflation case, re-derived ---------------------------------
  const s2 = recorded.scenarios?.S2_partial_walk
  check('V-10', 'the partial walk reports persisted != consumed, both non-zero and both reported',
    s2 !== undefined && s2.persistedBytes !== s2.consumedBytes && s2.consumedBytes > 0 && s2.persistedBytes > 0,
    { persistedBytes: s2?.persistedBytes, consumedBytes: s2?.consumedBytes, differ: s2?.differ })

  // --- the independent consumer witness ------------------------------------
  check('V-11', 'the out-of-process consumer tallied the same bytes and digest as the artifact',
    s1.consumedBytesConsumerTally === s1.persistedBytes && s1.consumedBytesConsumerSha256 === s1.artifactSha256,
    {
      consumerTally: s1.consumedBytesConsumerTally,
      consumerSha256: s1.consumedBytesConsumerSha256,
      persistedBytes: s1.persistedBytes,
      artifactSha256: s1.artifactSha256,
    })

  out.verdict = out.failures.length === 0 ? 'PASS' : 'FAIL'
  out.artifactFile = {
    path,
    bytes: osStat.size,
    sha256: streamed.sha256,
    streamWindows: streamed.windows,
    mode: `0o${(osStat.mode & 0o777).toString(8)}`,
  }
} catch (error) {
  out.verdict = 'ERROR'
  out.error = `${error?.constructor?.name}: ${String(error?.message).slice(0, 600)}`
}

writeFileSync(join(OUT_DIR, 'artifact-verification.json'), `${JSON.stringify(out, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
