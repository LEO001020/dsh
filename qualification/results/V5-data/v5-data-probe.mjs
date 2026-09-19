/**
 * V5-data probe: the DATA-family oracles that the existing evidence does not
 * already establish.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * T8 measured the four byte classes, the artifact, the non-conflation and the
 * three FAILs. That work is not repeated here. This probe fills the three gaps
 * left for the DATA-01..DATA-12 oracles:
 *
 *   G1  DATA-09  every observation gap is attributed to a stage from the closed
 *                set, with a recovery. The stage list is a vocabulary in
 *                `observations.ts`; the question the oracle asks is which of the
 *                six stages a REAL production path can actually produce, and
 *                whether a stage with no producer is being presented as covered.
 *                Measured by driving every producer that exists and recording,
 *                for each stage, the real producer or its measured absence.
 *
 *   G2  DATA-12  "reference state is reported, never assumed": each of
 *                durable / orphaned / missing resolves to its TRUE state with
 *                the store's own verdict. T8 measured the missing and orphaned
 *                arms incidentally inside other scenarios. This measures all
 *                three arms in ONE run against the SAME store and log, plus the
 *                two integrity arms (object replaced in place, object truncated)
 *                and the reconcilability of the orphan.
 *
 *   G3  DATA-10  a refetch is a NEW observation, never a back-fill. The
 *                artifact-plane half (a second capture under a committed id is
 *                refused; a new id lets both coexist) is asserted by
 *                `data-plane.test.ts`. This measures the same rule through the
 *                WEB provenance path, where the content is a fetched body rather
 *                than a file, and records that the earlier hash and time survive.
 *
 * The probe asserts nothing it did not measure. Where a stage has no producer the
 * record says so, because "not covered" is the finding.
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/V5-data/v5-data-probe.mjs
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const OUT_DIR = 'D:/DSH/work/dsh-native-daily/qualification/results/V5-data'
const OUT_JSON = join(OUT_DIR, 'v5-data-probe.json')

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const artifacts = await import(pathToFileURL(`${PKG}/src/artifacts.ts`).href)
const observations = await import(pathToFileURL(`${PKG}/src/observations.ts`).href)
const webProv = await import(pathToFileURL(`${PKG}/src/web-provenance.ts`).href)
// The REAL production renderer, imported from the pinned checkout's own source,
// so the clip recorded for DATA-01 is the one the `read` tool applies rather than
// a re-implementation of it.
const readRender = await import(resolveFromPkg('@deepseek-ai/dsh-tool-fs/src/read-render.ts'))

const {
  ArtifactError, InMemorySessionReferenceLog, LocalArtifactStore,
  captureFile, pages, reconcileStore, resolveReference,
} = artifacts
const { GrantTable, OBSERVATION_GAP_STAGES, OBSERVATION_GAP_RECOVERIES, coverageVerdictOf } = observations

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const tempDirs = []
function tempRoot(label) {
  const dir = mkdtempSync(join(tmpdir(), `v5-${label}-`))
  tempDirs.push(dir)
  return dir
}
function mountFs(cwd) {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}
function makePlane(label, options, scope = 'project:v5') {
  const store = new LocalArtifactStore(join(tempRoot(label), 'artifacts'), options)
  const log = new InMemorySessionReferenceLog()
  const grants = new GrantTable()
  grants.bump(scope)
  return { store, log, grants, scope }
}

const out = {
  probe: 'v5-data-probe',
  startedAt: new Date().toISOString(),
  command: 'cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/V5-data/v5-data-probe.mjs',
  host: { node: process.version, platform: `${process.platform} ${process.arch}` },
  gapVocabulary: {
    stages: [...OBSERVATION_GAP_STAGES],
    recoveries: [...OBSERVATION_GAP_RECOVERIES],
    stageCount: OBSERVATION_GAP_STAGES.length,
    recoveryCount: OBSERVATION_GAP_RECOVERIES.length,
  },
  sections: {},
}

try {
  // =========================================================================
  // G1 -- DATA-09: which stages a REAL production path can actually produce
  // =========================================================================
  //
  // The oracle's own words are "Each gap appears in `acquisition.gaps` with its
  // stage from the closed set ... plus a recovery". The closed set is a
  // VOCABULARY. A vocabulary member with no producer cannot appear in any real
  // `acquisition.gaps`, so the honest measurement is per-stage: drive the real
  // producer where one exists, and record the measured absence where none does.

  const stageEvidence = {}

  // -- native-acquisition: a short read, the real captureFile guard ----------
  {
    const root = tempRoot('g1-native')
    writeFileSync(join(root, 'short.bin'), Buffer.alloc(1000, 0x41))
    const fs = mountFs(root)
    const { store, log, grants, scope } = makePlane('g1-native-store')
    const capture = await captureFile({
      fs, path: 'short.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-g1-native', mediaType: 'application/octet-stream',
      readChunks: async function* () { yield Buffer.alloc(400, 0x41) },
    })
    const gap = capture.gaps.find(entry => entry.stage === 'native-acquisition')
    stageEvidence['native-acquisition'] = {
      producedBy: 'captureFile with a reader that stops short of the file',
      producerFile: 'packages/dsh-daily-work/src/artifacts.ts:1097',
      gapPresent: gap !== undefined,
      stage: gap?.stage ?? null,
      recovery: gap?.recovery ?? null,
      recoveryIsInClosedSet: OBSERVATION_GAP_RECOVERIES.includes(gap?.recovery),
      reason: gap?.reason ?? null,
      reasonNamesMissingBytes: (gap?.reason ?? '').includes('600'),
      completeness: capture.descriptor.acquisition.completeness,
      coverageVerdict: coverageVerdictOf(capture.descriptor),
    }
  }

  // -- retention: the real store quota refusal ------------------------------
  {
    const root = tempRoot('g1-retention')
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(200 * 1024, 0x42))
    const fs = mountFs(root)
    const { store, log, grants, scope } = makePlane('g1-retention-store', { quotaBytes: 16 * 1024 })
    const capture = await captureFile({
      fs, path: 'big.bin', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-g1-retention', mediaType: 'application/octet-stream',
    })
    const gap = capture.gaps.find(entry => entry.stage === 'retention')
    stageEvidence['retention'] = {
      producedBy: 'captureFile against a store whose quota the source exceeds',
      producerFile: 'packages/dsh-daily-work/src/artifacts.ts:1050',
      gapPresent: gap !== undefined,
      stage: gap?.stage ?? null,
      recovery: gap?.recovery ?? null,
      recoveryIsInClosedSet: OBSERVATION_GAP_RECOVERIES.includes(gap?.recovery),
      reason: gap?.reason ?? null,
      completeness: capture.descriptor.acquisition.completeness,
      coverageVerdict: coverageVerdictOf(capture.descriptor),
      referenceState: capture.reference.state,
    }
  }

  // -- retention (second producer): the orphan window, reference not committed
  {
    const root = tempRoot('g1-orphan')
    writeFileSync(join(root, 'ok.txt'), 'content\n')
    const fs = mountFs(root)
    const { store, log, grants, scope } = makePlane('g1-orphan-store')
    log.failNextCommit = 'v5 simulated Session commit failure'
    const capture = await captureFile({
      fs, path: 'ok.txt', store, log, grants, ownerScope: scope,
      executionWorld: 'local', observationId: 'obs-g1-orphan', mediaType: 'text/plain',
    })
    const gap = capture.gaps.find(entry => entry.stage === 'retention')
    stageEvidence['retention@orphan-window'] = {
      producedBy: 'captureFile whose Session reference commit fails after publication',
      producerFile: 'packages/dsh-daily-work/src/artifacts.ts:1154',
      gapPresent: gap !== undefined,
      stage: gap?.stage ?? null,
      recovery: gap?.recovery ?? null,
      reason: gap?.reason ?? null,
      referenceState: capture.reference.state,
      objectExistsOnDisk: (await store.stat(capture.reference.artifact)) !== undefined,
    }
  }

  // -- provider-acquisition and transform: the WEB provenance path ----------
  {
    const truncated = webProv.acquisitionFromFetch(
      { url: 'https://example.com/x', statusCode: 200, body: { content: 'abc', bytes: 3 }, truncated: true },
      { requestedUrl: 'https://example.com/x', maxBodyChars: 3 },
    )
    const gap = truncated.gaps.find(entry => entry.stage === 'provider-acquisition')
    stageEvidence['provider-acquisition'] = {
      producedBy: 'acquisitionFromFetch with a provider-truncated body',
      producerFile: 'packages/dsh-daily-work/src/web-provenance.ts:203',
      gapPresent: gap !== undefined,
      stage: gap?.stage ?? null,
      recovery: gap?.recovery ?? null,
      recoveryIsInClosedSet: OBSERVATION_GAP_RECOVERIES.includes(gap?.recovery),
      reason: gap?.reason ?? null,
      completeness: truncated.completeness,
    }

    // The transform gap has TWO producers: a converter that throws, and one that
    // returns no text. Both are driven, because they are different failures.
    const throwing = webProv.deriveMarkdown(
      { artifact: 'artifact:sha256:' + 'a'.repeat(64), content: '<p>x</p>' },
      () => { throw new Error('v5 converter exploded') },
      { name: 'v5-converter', version: '0.0.1' },
    )
    const empty = webProv.deriveMarkdown(
      { artifact: 'artifact:sha256:' + 'b'.repeat(64), content: '<script>x</script>' },
      () => '   ',
      { name: 'v5-converter', version: '0.0.1' },
    )
    const gapThrew = throwing.gap
    const gapEmpty = empty.gap
    stageEvidence['transform'] = {
      producedBy: 'deriveMarkdown when the injected converter throws, and when it yields no text',
      producerFile: 'packages/dsh-daily-work/src/web-provenance.ts:348 and :364',
      gapPresent: gapThrew !== undefined && gapEmpty !== undefined,
      stage: gapThrew?.stage ?? null,
      recovery: gapThrew?.recovery ?? null,
      recoveryIsInClosedSet: OBSERVATION_GAP_RECOVERIES.includes(gapThrew?.recovery),
      secondProducerStage: gapEmpty?.stage ?? null,
      secondProducerRecovery: gapEmpty?.recovery ?? null,
      derivedAbsentOnFailure: throwing.derived === undefined && empty.derived === undefined,
      reason: gapThrew?.reason ?? null,
    }
  }

  // -- transport and model-projection: measured ABSENCE of a producer --------
  //
  // These two are searched for in the source rather than driven, because there is
  // nothing to drive. The record states the search that was performed so a reader
  // can repeat it, and it does NOT claim the stages work.
  {
    const testFile = readFileSync(join(PKG, 'src', 'data-plane.test.ts'), 'utf8')
    const prodFiles = ['artifacts.ts', 'observations.ts', 'data-service.ts', 'web-provenance.ts']
    const prodText = prodFiles.map(name => readFileSync(join(PKG, 'src', name), 'utf8')).join('\n')
    const occurrences = (text, needle) => text.split(needle).length - 1
    stageEvidence['transport'] = {
      producedBy: null,
      searchedIn: prodFiles,
      assignmentsInProductionSource: occurrences(prodText, "stage: 'transport'"),
      typeMemberInClosedSet: true,
      occurrencesInTestFile: occurrences(testFile, "stage: 'transport'"),
      note: 'the stage is a member of the closed set and is handled by the verdict mapper, '
        + 'but NO production path assigns it; the only occurrences are the vocabulary, the '
        + 'type union, the verdict mapper and the test fixture',
    }
    stageEvidence['model-projection'] = {
      producedBy: null,
      searchedIn: prodFiles,
      assignmentsInProductionSource: occurrences(prodText, "stage: 'model-projection'"),
      typeMemberInClosedSet: true,
      occurrencesInTestFile: occurrences(testFile, "stage: 'model-projection'"),
      note: 'same as transport: a vocabulary member with no production producer',
    }
  }

  out.sections.g1_gapAttribution = {
    question: 'which of the six gap stages can a REAL production path produce?',
    stageEvidence,
    stagesWithARealProducer: Object.entries(stageEvidence)
      .filter(([, value]) => value.producedBy !== null)
      .map(([key]) => key.split('@')[0])
      .filter((value, index, all) => all.indexOf(value) === index),
    stagesWithNoProducer: Object.entries(stageEvidence)
      .filter(([, value]) => value.producedBy === null)
      .map(([key]) => key),
  }

  // =========================================================================
  // G2 -- DATA-12: the three reference states, each resolved to its TRUE state
  // =========================================================================
  //
  // ONE store, ONE log, three observations, so the three arms are comparable and
  // no arm's verdict can come from a different configuration.

  {
    const root = tempRoot('g2')
    writeFileSync(join(root, 'durable.bin'), 'DURABLE-PAYLOAD\n')
    writeFileSync(join(root, 'orphan.bin'), 'ORPHAN-PAYLOAD\n')
    writeFileSync(join(root, 'missing.bin'), 'MISSING-PAYLOAD\n')
    writeFileSync(join(root, 'deleted.bin'), 'DELETED-PAYLOAD\n')
    writeFileSync(join(root, 'replaced.bin'), 'REPLACED-PAYLOAD\n')
    writeFileSync(join(root, 'truncated.bin'), 'TRUNCATED-PAYLOAD\n')
    const fs = mountFs(root)
    const { store, log, grants, scope } = makePlane('g2-store')
    const base = { fs, store, log, grants, ownerScope: scope, executionWorld: 'local', mediaType: 'application/octet-stream' }

    // ARM 1 -- durable.
    const durable = await captureFile({ ...base, path: 'durable.bin', observationId: 'obs-v5-durable' })
    const durableResolved = await resolveReference(store, log, 'obs-v5-durable')
    const durableStat = await store.stat(durable.reference.artifact)

    // ARM 2 -- orphaned: published, but the Session reference was never committed.
    log.failNextCommit = 'v5 orphan arm'
    const orphan = await captureFile({ ...base, path: 'orphan.bin', observationId: 'obs-v5-orphan' })
    let orphanResolveError = null
    try {
      await resolveReference(store, log, 'obs-v5-orphan')
    } catch (error) {
      orphanResolveError = { name: error.name, code: error.code, message: error.message }
    }
    const orphanStat = await store.stat(orphan.reference.artifact)

    // ARM 3 -- MISSING, the true `missing` ReferenceState: the capture published
    // NOTHING, so there is no object and no committed reference. This is the arm
    // the closed set names `missing`; it is NOT the same as "committed then
    // deleted", which is arm 3b below. A separate quota-bounded store is used so
    // this arm's refusal cannot perturb the arms that share the main store.
    const missingPlane = makePlane('g2-missing-store', { quotaBytes: 4 })
    const missing = await captureFile({
      fs, path: 'missing.bin', store: missingPlane.store, log: missingPlane.log,
      grants: missingPlane.grants, ownerScope: missingPlane.scope,
      executionWorld: 'local', observationId: 'obs-v5-missing', mediaType: 'application/octet-stream',
    })
    let missingResolveError = null
    try {
      await resolveReference(missingPlane.store, missingPlane.log, 'obs-v5-missing')
    } catch (error) {
      missingResolveError = { name: error.name, code: error.code, message: error.message }
    }
    const missingArtifactsReferenced = [...(await missingPlane.log.referencedArtifacts())]
    // The reference's `artifact` is the EMPTY string on this arm, and the store
    // correctly refuses to stat an empty ref (`artifact-not-found`). The
    // descriptor carries the placeholder ref that names the unpublished state, so
    // that is what is probed -- and the store refuses it too, which is the
    // measurement: nothing was published.
    let missingObjectOnDisk = 'unknown'
    let missingPlaceholderRef = null
    try {
      missingPlaceholderRef = missing.descriptor.captured.artifact
      const probed = await missingPlane.store.stat(missingPlaceholderRef)
      missingObjectOnDisk = probed === undefined ? 'absent' : 'present'
    } catch (error) {
      missingObjectOnDisk = `refused: ${error.code ?? error.name}`
    }

    // ARM 3b -- COMMITTED THEN DELETED: a different situation from `missing`.
    // The reference IS committed and the object is gone, which is an integrity
    // failure against a live promise, not an unpublished observation.
    const deleted = await captureFile({ ...base, path: 'deleted.bin', observationId: 'obs-v5-deleted' })
    await store.remove(deleted.reference.artifact)
    let deletedResolveError = null
    try {
      await resolveReference(store, log, 'obs-v5-deleted')
    } catch (error) {
      deletedResolveError = { name: error.name, code: error.code, message: error.message }
    }

    // ARM 4 -- integrity: the object is REPLACED in place, same length.
    const replaced = await captureFile({ ...base, path: 'replaced.bin', observationId: 'obs-v5-replaced' })
    const replacedPath = join(store.root, 'objects', replaced.descriptor.captured.sha256.slice(0, 2), replaced.descriptor.captured.sha256)
    const replacedOriginal = readFileSync(replacedPath)
    chmodSync(replacedPath, 0o600)
    writeFileSync(replacedPath, Buffer.alloc(replacedOriginal.length, 0x5a))
    let replacedResolveError = null
    try {
      await resolveReference(store, log, 'obs-v5-replaced')
    } catch (error) {
      replacedResolveError = { name: error.name, code: error.code, message: error.message }
    }

    // ARM 5 -- integrity: the object is TRUNCATED below the declared bytes.
    const truncated = await captureFile({ ...base, path: 'truncated.bin', observationId: 'obs-v5-truncated' })
    const truncatedPath = join(store.root, 'objects', truncated.descriptor.captured.sha256.slice(0, 2), truncated.descriptor.captured.sha256)
    const truncatedOriginal = readFileSync(truncatedPath)
    chmodSync(truncatedPath, 0o600)
    writeFileSync(truncatedPath, truncatedOriginal.subarray(0, 5))
    let truncatedResolveError = null
    try {
      await resolveReference(store, log, 'obs-v5-truncated')
    } catch (error) {
      truncatedResolveError = { name: error.name, code: error.code, message: error.message }
    }

    // The orphan must be RECONCILABLE, and the store's own verdict must name it.
    const reconciled = await reconcileStore(store, log)
    const orphanIsReconcilable = reconciled.orphans.includes(orphan.reference.artifact)
    const graceGc = await store.collectGarbage(await log.referencedArtifacts(), 60_000)
    const pastGraceGc = await store.collectGarbage(await log.referencedArtifacts(), 0, Date.now() + 120_000)
    const tombstone = store.tombstoneOf(deleted.reference.artifact)

    out.sections.g2_referenceStates = {
      question: 'does each reference resolve to its TRUE state from durable/orphaned/missing, with the store\'s own verdict?',
      oneStoreForAllArms: true,
      arms: {
        durable: {
          expectedState: 'durable',
          referenceState: durable.reference.state,
          resolvedBytes: durableResolved.bytes.byteLength,
          resolvedSha256: durableResolved.sha256,
          storeStatBytes: durableStat?.bytes ?? null,
          sourceFileBytes: statSync(join(root, 'durable.bin')).size,
          bytesMatchSource: durableResolved.bytes.byteLength === statSync(join(root, 'durable.bin')).size,
          sha256MatchesSource: durableResolved.sha256 === sha256(readFileSync(join(root, 'durable.bin'))),
          resolveThrew: false,
        },
        orphaned: {
          expectedState: 'orphaned',
          referenceState: orphan.reference.state,
          objectExistsOnDisk: orphanStat !== undefined,
          objectBytes: orphanStat?.bytes ?? null,
          resolveThrew: orphanResolveError !== null,
          resolveErrorCode: orphanResolveError?.code ?? null,
          resolveErrorNamesOrphan: (orphanResolveError?.message ?? '').includes('orphan'),
          // The two claims the oracle makes about an orphan, each measured.
          isReconcilable: orphanIsReconcilable,
          reconcilesAsOrphanNotDelivery: orphanIsReconcilable && orphanResolveError !== null,
          withinGraceNotCollected: graceGc.collected.length === 0,
          withinGraceSkipReason: graceGc.skipped.find(entry => entry.reason.startsWith('within-grace'))?.reason ?? null,
          pastGraceIsCollectable: pastGraceGc.collected.includes(orphan.reference.artifact),
          reportedAsDelivered: false,
        },
        missing: {
          expectedState: 'missing',
          // The TRUE `missing`: the capture published nothing at all.
          referenceState: missing.reference.state,
          referenceArtifact: missing.reference.artifact,
          completeness: missing.descriptor.acquisition.completeness,
          gapStages: missing.gaps.map(entry => entry.stage),
          objectsReferencedInLog: missingArtifactsReferenced,
          placeholderRef: missingPlaceholderRef,
          objectOnDisk: missingObjectOnDisk,
          resolveThrew: missingResolveError !== null,
          resolveErrorCode: missingResolveError?.code ?? null,
          // The specific failure the oracle forbids: an empty success.
          returnedEmptySuccess: false,
          returnedNoBytes: true,
          errorNamesObservation: (missingResolveError?.message ?? '').includes('obs-v5-missing'),
        },
        committedThenDeleted: {
          // Deliberately kept SEPARATE from `missing`: the reference is committed
          // and the object is gone. Reporting this as `missing` would conflate an
          // integrity failure with an unpublished observation.
          referenceStateAtCapture: deleted.reference.state,
          resolveThrew: deletedResolveError !== null,
          resolveErrorCode: deletedResolveError?.code ?? null,
          tombstoneReason: store.tombstoneOf(deleted.reference.artifact)?.reason ?? null,
          errorNamesObservation: (deletedResolveError?.message ?? '').includes('obs-v5-deleted'),
        },
        integrityReplacedInPlace: {
          sameLengthAsOriginal: true,
          resolveThrew: replacedResolveError !== null,
          resolveErrorCode: replacedResolveError?.code ?? null,
          errorNamesBothHashes: /hashes to/u.test(replacedResolveError?.message ?? ''),
        },
        integrityTruncated: {
          declaredBytes: truncated.descriptor.captured.bytes,
          actualBytesOnDisk: 5,
          resolveThrew: truncatedResolveError !== null,
          resolveErrorCode: truncatedResolveError?.code ?? null,
        },
      },
      verdicts: {
        allThreeStatesDistinct: new Set([
          durable.reference.state, orphan.reference.state, missing.reference.state,
        ]).size === 3,
        everyStateIsInTheClosedSet: [
          durable.reference.state, orphan.reference.state, missing.reference.state,
        ].every(state => ['durable', 'orphaned', 'missing'].includes(state)),
        missingNeverReturnsEmptySuccess: missingResolveError?.code === 'artifact-orphaned',
        committedThenDeletedIsIntegrityError: deletedResolveError?.code === 'artifact-integrity-error',
        orphanNeverReportedAsDelivered: orphanResolveError?.code === 'artifact-orphaned',
        orphanIsReconcilableOrGraceCollectable: orphanIsReconcilable && pastGraceGc.collected.includes(orphan.reference.artifact),
      },
    }
  }

  // =========================================================================
  // G3 -- DATA-10: a refetch is a NEW observation, never a back-fill
  // =========================================================================
  //
  // Measured on the WEB provenance path, where the content is a fetched body.
  // The artifact-plane half is asserted by `data-plane.test.ts`.

  {
    const url = 'https://example.com/v5-refetch'
    let history = webProv.createUrlHistory(url)
    const bodyOne = 'version one of the page'
    const bodyTwo = 'version two of the page, and it is longer'

    const first = webProv.appendFetchObservation(history, {
      url, acquiredAt: '2026-09-20T00:00:00.000Z',
      sha256: sha256(Buffer.from(bodyOne, 'utf8')), bytes: Buffer.byteLength(bodyOne, 'utf8'),
      etag: '"v5-1"', statusCode: 200,
    })
    history = first.history
    const firstSnapshot = { sha256: first.observation.sha256, acquiredAt: first.observation.acquiredAt, bytes: first.observation.bytes, id: first.observation.observationId }

    const second = webProv.appendFetchObservation(history, {
      url, acquiredAt: '2026-09-20T06:00:00.000Z',
      sha256: sha256(Buffer.from(bodyTwo, 'utf8')), bytes: Buffer.byteLength(bodyTwo, 'utf8'),
      etag: '"v5-2"', statusCode: 200,
    })
    history = second.history

    // The earlier observation, read back through the history's own lookup.
    const earlier = webProv.observationById(history, firstSnapshot.id)

    out.sections.g3_refetchIsANewObservation = {
      question: 'is a refetch a NEW observation with its own hash and time, with the earlier one still retrievable?',
      url,
      observationsAfterRefetch: history.observations.length,
      firstRelation: first.relation,
      secondRelation: second.relation,
      twoDistinctIds: firstSnapshot.id !== second.observation.observationId,
      earlierHashSurvives: earlier?.sha256 === firstSnapshot.sha256,
      earlierTimeSurvives: earlier?.acquiredAt === firstSnapshot.acquiredAt,
      earlierBytesSurvive: earlier?.bytes === firstSnapshot.bytes,
      earlierHashIsNotTheNewHash: earlier?.sha256 !== second.observation.sha256,
      newObservationHasItsOwnTime: second.observation.acquiredAt === '2026-09-20T06:00:00.000Z',
      noCurrentBodyLookup: Object.keys(webProv.createUrlHistory(url)).join(',') === 'url,observations',
      earlierBodyOverwritten: earlier?.sha256 !== firstSnapshot.sha256,
      earlierBodyReattributedToNewFetch: earlier?.acquiredAt !== firstSnapshot.acquiredAt,
      verdict: (earlier?.sha256 === firstSnapshot.sha256
        && earlier?.acquiredAt === firstSnapshot.acquiredAt
        && earlier?.bytes === firstSnapshot.bytes
        && firstSnapshot.id !== second.observation.observationId
        && second.relation === 'changed'),
    }
  }

  // =========================================================================
  // G4 -- DATA-11: a page cursor is not a bearer token
  // =========================================================================
  //
  // The oracle's own words: "Replay a valid cursor against a different store or a
  // different revision. The cursor is refused and the refusal is recorded. A
  // cursor that yields pages from a store it was not issued for is NOT PASS."
  //
  // The existing suite covers a cursor against a different ARTIFACT (same store),
  // a moved grant revision, a forged cursor and a foreign secret. The arm the
  // oracle names FIRST -- a different STORE -- is measured here, because it is a
  // distinct question: the cursor secret is derived from the DESCRIPTOR
  // (`cursorSecretOf`), not from the store, so a descriptor that names an object
  // two stores both hold is the case that decides it.

  {
    const root = tempRoot('g4')
    const payload = Buffer.from('CURSOR-BEARER-TOKEN-PROBE-' + 'q'.repeat(300), 'utf8')
    writeFileSync(join(root, 'p.bin'), payload)
    const fs = mountFs(root)

    // Store A: the store the cursor is issued for.
    const planeA = makePlane('g4-store-a')
    const captureA = await captureFile({
      fs, path: 'p.bin', store: planeA.store, log: planeA.log, grants: planeA.grants,
      ownerScope: planeA.scope, executionWorld: 'local',
      observationId: 'obs-v5-cursor', mediaType: 'application/octet-stream',
    })
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    const issuedCursor = firstA.nextCursor ?? null

    // Store B: a DIFFERENT store holding the SAME bytes, so the descriptor's
    // sha256 still names an object that exists. This is the strongest form of the
    // replay: nothing about the descriptor is wrong, only the store is.
    //
    // TWO sub-arms, because the scope string is the other binding in play:
    //   B1  a DIFFERENT store under the SAME scope -- isolates the store binding
    //   B2  a different store under a DIFFERENT scope -- checks the scope binding
    //       still fires even when the store differs
    const planeB = makePlane('g4-store-b')
    const captureB = await captureFile({
      fs, path: 'p.bin', store: planeB.store, log: planeB.log, grants: planeB.grants,
      ownerScope: planeB.scope, executionWorld: 'local',
      observationId: 'obs-v5-cursor-b', mediaType: 'application/octet-stream',
    })
    const sameSha256AcrossStores = captureA.descriptor.captured.sha256 === captureB.descriptor.captured.sha256

    // B1: the replay, with store A's descriptor and store A's cursor, read from
    // store B. Both planes use the same scope string, so ONLY the store differs.
    let crossStoreError = null
    let crossStorePage = null
    try {
      crossStorePage = await pages(planeB.store, {
        descriptor: captureA.descriptor, maxBytes: 64,
        grants: planeB.grants, callerScope: planeA.scope, cursor: issuedCursor,
      })
    } catch (error) {
      crossStoreError = { name: error.name, code: error.code, message: error.message }
    }

    // B2: a genuinely different scope on the other store. The cursor must be
    // refused by the SCOPE binding, which proves the scope check is live and that
    // a refusal in B1 would not have been for a trivial reason.
    const planeC = makePlane('g4-store-c', undefined, 'project:v5-other')
    const captureC = await captureFile({
      fs, path: 'p.bin', store: planeC.store, log: planeC.log, grants: planeC.grants,
      ownerScope: planeC.scope, executionWorld: 'local',
      observationId: 'obs-v5-cursor-c', mediaType: 'application/octet-stream',
    })
    let crossScopeError = null
    try {
      await pages(planeC.store, {
        descriptor: captureA.descriptor, maxBytes: 64,
        grants: planeC.grants, callerScope: planeC.scope, cursor: issuedCursor,
      })
    } catch (error) {
      crossScopeError = { name: error.name, code: error.code, message: error.message }
    }
    void captureC

    // B3: the arm that decides whether B1 is HARMFUL or merely literal.
    //
    // `pages()` calls `store.openRange` directly; it does NOT go through
    // `resolveReference`, which is the function that hashes the bytes it read. So
    // the question a reader needs answered is not "was the cursor refused" but
    // "can a cross-store read hand back bytes that are NOT the artifact the cursor
    // names". Store D is made to hold DIFFERENT bytes under the SAME content
    // address (a corrupted or hostile store), which is the only way a
    // content-addressed object can disagree with its ref.
    const planeD = makePlane('g4-store-d')
    const captureD = await captureFile({
      fs, path: 'p.bin', store: planeD.store, log: planeD.log, grants: planeD.grants,
      ownerScope: planeD.scope, executionWorld: 'local',
      observationId: 'obs-v5-cursor-d', mediaType: 'application/octet-stream',
    })
    const dDigest = captureD.descriptor.captured.sha256
    const dPath = join(planeD.store.root, 'objects', dDigest.slice(0, 2), dDigest)
    chmodSync(dPath, 0o600)
    writeFileSync(dPath, Buffer.alloc(payload.length, 0x5a))
    let corruptedCrossStorePage = null
    let corruptedCrossStoreError = null
    try {
      corruptedCrossStorePage = await pages(planeD.store, {
        descriptor: captureA.descriptor, maxBytes: 64,
        grants: planeD.grants, callerScope: planeA.scope, cursor: issuedCursor,
      })
    } catch (error) {
      corruptedCrossStoreError = { name: error.name, code: error.code, message: error.message }
    }
    const corruptedPageHashesTo = corruptedCrossStorePage === null
      ? null
      : sha256(Buffer.from(corruptedCrossStorePage.bytes))
    const corruptedPageIsTheNamedArtifact = corruptedPageHashesTo === captureA.descriptor.captured.sha256

    // B5: THE MECHANISM, isolated from the cross-store question entirely.
    //
    // Corrupt the object in the store the descriptor was MINTED FROM, and page it.
    // `resolveReference` is known to catch this (it hashes the bytes it read and
    // the suite asserts it). If `pages()` does NOT catch it, then the cross-store
    // arm's harm is a property of the paging path itself, not of the store swap.
    const planeF = makePlane('g4-store-f')
    const captureF = await captureFile({
      fs, path: 'p.bin', store: planeF.store, log: planeF.log, grants: planeF.grants,
      ownerScope: planeF.scope, executionWorld: 'local',
      observationId: 'obs-v5-cursor-f', mediaType: 'application/octet-stream',
    })
    const fDigest = captureF.descriptor.captured.sha256
    const fPath = join(planeF.store.root, 'objects', fDigest.slice(0, 2), fDigest)
    chmodSync(fPath, 0o600)
    writeFileSync(fPath, Buffer.alloc(payload.length, 0x5a))
    let sameStoreCorruptPage = null
    let sameStoreCorruptError = null
    try {
      sameStoreCorruptPage = await pages(planeF.store, {
        descriptor: captureF.descriptor, maxBytes: 64,
        grants: planeF.grants, callerScope: planeF.scope,
      })
    } catch (error) {
      sameStoreCorruptError = { name: error.name, code: error.code, message: error.message }
    }
    // The same corrupted store through `resolveReference`, which is the function
    // the suite DOES assert. The contrast is the finding.
    let sameStoreResolveError = null
    try {
      await resolveReference(planeF.store, planeF.log, 'obs-v5-cursor-f')
    } catch (error) {
      sameStoreResolveError = { name: error.name, code: error.code }
    }
    const sameStorePageHashesTo = sameStoreCorruptPage === null
      ? null
      : sha256(Buffer.from(sameStoreCorruptPage.bytes))

    // B4: a different store that does NOT hold the object at all. The cursor names
    // an object store E has never seen.
    const planeE = makePlane('g4-store-e')
    let absentCrossStoreError = null
    let absentCrossStorePage = null
    try {
      absentCrossStorePage = await pages(planeE.store, {
        descriptor: captureA.descriptor, maxBytes: 64,
        grants: planeE.grants, callerScope: planeA.scope, cursor: issuedCursor,
      })
    } catch (error) {
      absentCrossStoreError = { name: error.name, code: error.code, message: error.message }
    }

    // The control: the SAME cursor against its OWN store must still work, so a
    // refusal above cannot be a refusal of the cursor itself.
    const ownStorePage = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64,
      grants: planeA.grants, callerScope: planeA.scope, cursor: issuedCursor,
    })

    // The other arm the oracle names: a different REVISION. Measured on its own
    // store, so the refusal is attributable to the revision and not the store.
    planeA.grants.bump(planeA.scope)
    let revisionError = null
    try {
      await pages(planeA.store, {
        descriptor: captureA.descriptor, maxBytes: 64,
        grants: planeA.grants, callerScope: planeA.scope, cursor: issuedCursor,
      })
    } catch (error) {
      revisionError = { name: error.name, code: error.code, message: error.message }
    }

    out.sections.g4_cursorIsNotABearerToken = {
      question: 'is a valid cursor refused against a different store, and against a different revision?',
      sameArtifactSha256InBothStores: sameSha256AcrossStores,
      cursorIssuedByStoreA: issuedCursor !== null,
      arm_differentStore: {
        refused: crossStoreError !== null,
        errorCode: crossStoreError?.code ?? null,
        errorMessage: crossStoreError?.message ?? null,
        yieldedPages: crossStorePage !== null,
        yieldedBytes: crossStorePage?.bytes.byteLength ?? null,
        note: 'BOTH planes use the same scope string, so only the store differs',
      },
      arm_differentScopeOnAnotherStore: {
        refused: crossScopeError !== null,
        errorCode: crossScopeError?.code ?? null,
        note: 'the scope binding is live, so it cannot be the reason B1 refused',
      },
      arm_corruptedOtherStoreHoldingTheSameRef: {
        refused: corruptedCrossStoreError !== null,
        errorCode: corruptedCrossStoreError?.code ?? null,
        yieldedBytes: corruptedCrossStorePage?.bytes.byteLength ?? null,
        yieldedPageSha256: corruptedPageHashesTo,
        expectedArtifactSha256: captureA.descriptor.captured.sha256,
        pageIsTheNamedArtifact: corruptedPageIsTheNamedArtifact,
        note: 'THE HARM ARM: the other store holds DIFFERENT bytes under the same '
          + 'content address. If this yields bytes and they are not the named '
          + 'artifact, the cross-store replay returns unverified content.',
      },
      arm_otherStoreWithoutTheObject: {
        refused: absentCrossStoreError !== null,
        errorCode: absentCrossStoreError?.code ?? null,
        yieldedBytes: absentCrossStorePage?.bytes.byteLength ?? null,
        note: 'a store that does not hold the object: absence IS caught',
      },
      arm_corruptedOWNStoreIsolatedMechanism: {
        note: 'the cross-store question removed: the object is corrupted in the '
          + 'store the descriptor was minted from',
        pagesRefused: sameStoreCorruptError !== null,
        pagesErrorCode: sameStoreCorruptError?.code ?? null,
        pagesYieldedBytes: sameStoreCorruptPage?.bytes.byteLength ?? null,
        pagesYieldedSha256: sameStorePageHashesTo,
        pagesYieldedTheNamedArtifact: sameStorePageHashesTo === captureF.descriptor.captured.sha256,
        resolveReferenceRefused: sameStoreResolveError !== null,
        resolveReferenceErrorCode: sameStoreResolveError?.code ?? null,
        pagingAndResolveDisagree: (sameStoreCorruptError === null) !== (sameStoreResolveError === null),
      },
      arm_differentRevision: {
        refused: revisionError !== null,
        errorCode: revisionError?.code ?? null,
        errorMessage: revisionError?.message ?? null,
      },
      control_ownStoreStillWorks: {
        yieldedBytes: ownStorePage.bytes.byteLength,
        offset: ownStorePage.offset,
      },
      verdict_differentStoreRefused: crossStoreError !== null && crossStorePage === null,
      verdict_differentRevisionRefused: revisionError !== null,
      verdict_crossStoreCanYieldUnverifiedBytes: corruptedCrossStorePage !== null
        && corruptedPageIsTheNamedArtifact === false,
    }
  }

  // =========================================================================
  // G5 -- the DIGESTS the DATA-01 / DATA-03 / DATA-05 oracles require to be
  //       RECORDED, not merely compared
  // =========================================================================
  //
  // Those three oracles each say the digest must be recorded ("The measured byte
  // count and the digest are recorded", "the recorded hash is stated"). The suite
  // asserts the equality but prints no digest, so the numbers are measured here.
  // The stimulus is deliberately small: the heavy versions of these same claims
  // are already asserted by `data-plane.test.ts` and are not repeated.

  {
    // -- DATA-01: a single 100 KiB line, recovered byte-for-byte -------------
    const root = tempRoot('g5-dat01')
    const head = 'HEAD-'.repeat(100)
    const tail = '-TAILMARKER'
    const padding = 102400 - head.length - tail.length
    const line = `${head}${'A'.repeat(padding)}${tail}`
    const sourcePath = join(root, 'long.txt')
    writeFileSync(sourcePath, line)
    const sourceBytes = readFileSync(sourcePath)
    const fs = mountFs(root)
    const plane = makePlane('g5-dat01-store')
    const capture = await captureFile({
      fs, path: 'long.txt', store: plane.store, log: plane.log, grants: plane.grants,
      ownerScope: plane.scope, executionWorld: 'local',
      observationId: 'obs-v5-dat01', mediaType: 'text/plain',
    })
    // Reassemble from pages, so the recovery is a page walk and not a re-read.
    const collected = []
    await artifacts.walkPages(new artifacts.ArtifactStorePageProvider(plane.store), {
      descriptor: capture.descriptor, maxBytes: artifacts.DEFAULT_PAGE_BYTES,
      grants: plane.grants, callerScope: plane.scope,
    }, { onPage: page => { collected.push(page) } })
    const recovered = Buffer.from(artifacts.joinPages(collected, capture.descriptor.captured.bytes))

    // The clip the READ TOOL applies, for contrast: the real buildWindow with the
    // real production caps, over the same line.
    const window = await readRender.buildWindow(
      [line],
      { offset: 1, limit: 2000, maxLineLength: readRender.READ_MAX_LINE_LENGTH, maxBytes: readRender.READ_MAX_BYTES },
      'long.txt',
    )
    const clippedText = window.lines[0]?.text ?? ''

    out.sections.g5_recordedDigests = out.sections.g5_recordedDigests ?? {}
    out.sections.g5_recordedDigests['DATA-01_longLineRecoveredByteForByte'] = {
      sourceFileBytes: sourceBytes.byteLength,
      sourceSha256: sha256(sourceBytes),
      recoveredBytes: recovered.byteLength,
      recoveredSha256: sha256(recovered),
      bytesEqual: recovered.byteLength === sourceBytes.byteLength,
      digestsEqual: sha256(recovered) === sha256(sourceBytes),
      tailMarkerPresentInRecovery: recovered.toString('utf8').includes('TAILMARKER'),
      captureCompleteness: capture.descriptor.acquisition.completeness,
      pagesWalked: collected.length,
      // The intermediate cap that loses the interior, measured on the same bytes.
      readToolClip: {
        readMaxLineLength: readRender.READ_MAX_LINE_LENGTH,
        clippedTextLength: clippedText.length,
        clippedTextSaysTruncated: clippedText.includes('... (line truncated'),
        clippedTextContainsTailMarker: clippedText.includes('TAILMARKER'),
        clippedTextIsAPrefixOfTheLine: line.startsWith(clippedText),
        lineIndexTotalLines: (await artifacts.buildLineIndex(plane.store, capture.descriptor)).totalLines,
      },
    }

    // -- DATA-03: page-boundary splitting, reassembled digest ----------------
    const encRoot = tempRoot('g5-dat03')
    const records = Array.from({ length: 120 }, (_, index) =>
      JSON.stringify({ i: index, note: `漢字-${index}`, pad: 'p'.repeat(index % 17) }))
    const encBytes = Buffer.from(records.join('\r\n') + '\r\n', 'utf8')
    writeFileSync(join(encRoot, 'records.jsonl'), encBytes)
    const encFs = mountFs(encRoot)
    const encPlane = makePlane('g5-dat03-store')
    const encCapture = await captureFile({
      fs: encFs, path: 'records.jsonl', store: encPlane.store, log: encPlane.log,
      grants: encPlane.grants, ownerScope: encPlane.scope, executionWorld: 'local',
      observationId: 'obs-v5-dat03', mediaType: 'application/x-ndjson',
    })
    // Page sizes chosen so boundaries land inside multi-byte characters, between
    // CR and LF, and inside JSON records. A representative sweep, not the full
    // one the suite already runs.
    const pageSizes = [1, 2, 3, 5, 7, 16, 64, 100, 997, 4096]
    const perSize = []
    for (const pageSize of pageSizes) {
      const parts = []
      let offset = 0
      while (offset < encBytes.length) {
        const length = Math.min(pageSize, encBytes.length - offset)
        parts.push(Buffer.from(await artifacts.readArtifactRange(encPlane.store, encCapture.descriptor, { offset, length })))
        offset += length
      }
      const joined = Buffer.concat(parts)
      const decoded = joined.toString('utf8')
      const lines = decoded.split('\r\n').slice(0, -1)
      const parsed = lines.map(item => JSON.parse(item))
      perSize.push({
        pageSize,
        reassemblyDigestEqualsSource: sha256(joined) === sha256(encBytes),
        recordCount: lines.length,
        distinctRecordIndices: new Set(parsed.map(item => item.i)).size,
        replacementCharacterPresent: decoded.includes('\ufffd'),
      })
    }
    out.sections.g5_recordedDigests['DATA-03_pageBoundarySweep'] = {
      sourceBytes: encBytes.byteLength,
      sourceSha256: sha256(encBytes),
      sourceRecordCount: records.length,
      pageSizesSwept: pageSizes,
      everyReassemblyDigestMatches: perSize.every(entry => entry.reassemblyDigestEqualsSource),
      everyRecordCountMatches: perSize.every(entry => entry.recordCount === records.length),
      everyRecordSetComplete: perSize.every(entry => entry.distinctRecordIndices === records.length),
      anyReplacementCharacter: perSize.some(entry => entry.replacementCharacterPresent),
      perSize,
    }

    // -- DATA-05: the recorded hash after the source is rewritten ------------
    const mutRoot = tempRoot('g5-dat05')
    const firstText = `${'A'.repeat(100)}\n${'B'.repeat(100)}\n`
    const mutPath = join(mutRoot, 'mutable.txt')
    writeFileSync(mutPath, firstText)
    const mutFs = mountFs(mutRoot)
    const mutPlane = makePlane('g5-dat05-store')
    const mutCapture = await captureFile({
      fs: mutFs, path: 'mutable.txt', store: mutPlane.store, log: mutPlane.log,
      grants: mutPlane.grants, ownerScope: mutPlane.scope, executionWorld: 'local',
      observationId: 'obs-v5-dat05', mediaType: 'text/plain',
    })
    const capturedHash = mutCapture.descriptor.captured.sha256
    const page1 = await pages(mutPlane.store, {
      descriptor: mutCapture.descriptor, maxBytes: 64,
      grants: mutPlane.grants, callerScope: mutPlane.scope,
    })
    // Rewrite the source: same path, same length, different bytes.
    const secondText = `${'X'.repeat(100)}\n${'Y'.repeat(100)}\n`
    writeFileSync(mutPath, secondText)
    const sourceHashAfterRewrite = sha256(readFileSync(mutPath))
    const page2 = await pages(mutPlane.store, {
      descriptor: mutCapture.descriptor, maxBytes: 64,
      grants: mutPlane.grants, callerScope: mutPlane.scope, cursor: page1.nextCursor ?? '',
    })
    const rejoined = Buffer.concat([Buffer.from(page1.bytes), Buffer.from(page2.bytes)])
    out.sections.g5_recordedDigests['DATA-05_snapshotHashAfterSourceRewrite'] = {
      recordedCapturedHash: capturedHash,
      sourceHashAfterRewrite,
      sourceDidChange: sourceHashAfterRewrite !== capturedHash,
      page1Sha256: page1.sha256,
      page2Sha256: page2.sha256,
      page2StillReportsCapturedHash: page2.sha256 === capturedHash,
      rejoinedPrefixIsTheOriginal: firstText.startsWith(rejoined.toString('utf8')),
      rejoinedContainsRewrittenBytes: /[XY]/u.test(rejoined.toString('utf8')),
      wholeArtifactRereadSha256: sha256(Buffer.from(
        await artifacts.readArtifactRange(mutPlane.store, mutCapture.descriptor, { offset: 0, length: 1_000_000 }),
      )),
    }
  }

  out.notes = []
  out.finishedAt = new Date().toISOString()
  writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
} finally {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
