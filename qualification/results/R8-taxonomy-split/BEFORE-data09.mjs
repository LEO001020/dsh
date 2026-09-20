/**
 * R8 BEFORE reproduction: the DATA-09 conflation, measured against the
 * pre-change tree, so the before/after pair is on disk.
 *
 * WHAT THIS MEASURES, and it is the v1 FAIL exactly as filed:
 *
 *   (1) The closed set has SIX stages. Four have a real production producer
 *       (`stage: '...'` assigned in non-test production source). Two --
 *       `transport` and `model-projection` -- have ZERO assignments, so they
 *       are vocabulary members no production path can ever emit.
 *
 *   (2) `model-projection` is not merely producer-less: it is CONFLATED. The
 *       same enum that records "the provider never sent these bytes" (an
 *       acquisition fact about the world) also holds "the model was shown 2 KB
 *       of a complete 30 MB artifact" (a projection choice about OUR output).
 *       The second is recorded as a LOSS, which is the thing D2 splits.
 *
 *   (3) The projection that IS produced (`projectForModel`) carries no
 *       `ProjectionManifest`: it reports `pagesConsumed`/`bytesConsumed` but
 *       does not name the source ref, the selection code, the omitted counts
 *       or the emitted-content digest. So "we deliberately showed the model
 *       less" is not a first-class recorded fact -- it is a pair of counters
 *       with no manifest, which is why naming it a "gap" was the only
 *       vocabulary available.
 *
 * Run from packages/dsh-daily-work:
 *   node --import file:///D:/DSH/src/dsh-src/node_modules/tsx/dist/loader.mjs \
 *     D:/DSH/work/wt-r8/qualification/results/R8-taxonomy-split/BEFORE-data09.mjs
 *
 * Writes BEFORE-data09.json next to this file. Asserts nothing it did not read.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
const PKG_SRC = 'D:/DSH/work/wt-r8/packages/dsh-daily-work/src'

const observations = await import(`file:///${PKG_SRC}/observations.ts`.replace(/\/\//gu, '/'))

const { OBSERVATION_GAP_STAGES, OBSERVATION_COVERAGE_VOCABULARY, OBSERVATION_SCHEMA_VERSION } = observations

// ---------------------------------------------------------------------------
// (1) producer inventory: which stages does PRODUCTION source actually assign?
// ---------------------------------------------------------------------------
//
// The search is deliberately literal: `stage: '<name>'` in a non-test `.ts`
// file under `src/`. A type union member, a closed-set entry, a switch case and
// a zod enum do NOT count as a producer -- they are all declarations. That
// distinction is the whole measurement: v1's FAIL was that two names appear
// ONLY in declarations.
const PRODUCTION_FILES = ['observations.ts', 'artifacts.ts', 'data-service.ts', 'web-provenance.ts', 'history-plugin.ts']

const producerEvidence = {}
for (const stage of OBSERVATION_GAP_STAGES) {
  producerEvidence[stage] = []
}
for (const file of PRODUCTION_FILES) {
  const text = readFileSync(join(PKG_SRC, file), 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    for (const stage of OBSERVATION_GAP_STAGES) {
      // An ASSIGNMENT to the stage field, not a declaration of the name.
      if (new RegExp(`stage:\\s*'${stage}'`, 'u').test(line)) {
        producerEvidence[stage].push({ file, line: index + 1, text: line.trim().slice(0, 120) })
      }
    }
  })
}

const producerCounts = {}
const stagesWithNoProducer = []
for (const stage of OBSERVATION_GAP_STAGES) {
  producerCounts[stage] = producerEvidence[stage].length
  if (producerEvidence[stage].length === 0) stagesWithNoProducer.push(stage)
}

// ---------------------------------------------------------------------------
// (2) the conflation, read directly out of the vocabulary's own comments
// ---------------------------------------------------------------------------
//
// `model-projection` is declared in the SAME array as the four acquisition
// stages, so `acquisition.gaps[].stage` can hold it. That is the conflation:
// the field that means "the world gave us less than we asked for" also accepts
// "we chose to show the model less than we hold".
const observationsSource = readFileSync(join(PKG_SRC, 'observations.ts'), 'utf8')
const projectionIsAnAcquisitionStage = OBSERVATION_GAP_STAGES.includes('model-projection')
const transportIsAnAcquisitionStage = OBSERVATION_GAP_STAGES.includes('transport')
const coverageVocab = [...OBSERVATION_COVERAGE_VOCABULARY]

// ---------------------------------------------------------------------------
// (3) the projection record that exists today
// ---------------------------------------------------------------------------
//
// `projectForModel` returns a fixed field set. Measured from its own declared
// return type by CALLING it with a minimal input and listing the keys that come
// back -- so this is the shape the product emits, not a reading of its source.
const artifacts = await import(`file:///${PKG_SRC}/artifacts.ts`.replace(/\/\//gu, '/'))
const descriptor = {
  id: 'obs-before',
  schemaVersion: OBSERVATION_SCHEMA_VERSION,
  source: { kind: 'file', locator: 'x', acquiredAt: '2026-09-20T00:00:00.000Z', executionWorld: 'local' },
  captured: { artifact: `artifact:sha256:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 30 * 1024 * 1024, mediaType: 'text/plain' },
  acquisition: { completeness: 'complete-within-request', coverage: null, gaps: [] },
  authority: { ownerScope: 'project:r8', grantRevision: 1 },
}
const projection = artifacts.projectForModel({
  descriptor,
  pagesConsumed: 1,
  bytesConsumed: 2048,
  exhausted: false,
})
const projectionKeys = Object.keys(projection).sort()
const manifestFieldsExpected = [
  'sourceRef', 'selectedBytes', 'omittedBytes', 'recoverableRef', 'projectionReason', 'emittedSha256',
]
const manifestFieldsPresent = manifestFieldsExpected.filter(field => projectionKeys.includes(field))

const record = {
  probe: 'R8 BEFORE — the DATA-09 conflation, measured on the pre-change tree',
  identity: {
    worktree: 'D:/DSH/work/wt-r8',
    branch: 'wt/r8',
    measuredFrom: 'packages/dsh-daily-work/src (TS source, imported through tsx)',
  },
  observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
  closedSet: [...OBSERVATION_GAP_STAGES],
  closedSetSize: OBSERVATION_GAP_STAGES.length,
  coverageVocabulary: coverageVocab,
  producerCounts,
  producerEvidence,
  stagesWithNoProducer,
  stagesWithProducer: OBSERVATION_GAP_STAGES.filter(stage => producerCounts[stage] > 0),
  producerCount: OBSERVATION_GAP_STAGES.length - stagesWithNoProducer.length,
  conflation: {
    projectionIsAnAcquisitionStage,
    transportIsAnAcquisitionStage,
    // The two facts that cannot be one enum: one is about the world, one is about
    // our own deliberate selection.
    whyItMatters: 'a provider that sent less than we asked for, and a complete artifact we chose to summarize, '
      + 'are recorded in the same field with the same `recovery` vocabulary',
  },
  existingProjectionRecord: {
    functionName: 'projectForModel',
    keys: projectionKeys,
    keyCount: projectionKeys.length,
    manifestFieldsExpected,
    manifestFieldsPresent,
    manifestFieldsAbsent: manifestFieldsExpected.filter(field => !projectionKeys.includes(field)),
    artifactBytes: projection.artifactBytes,
    bytesConsumed: projection.bytesConsumed,
    note: 'a 30 MiB artifact projected to 2 KiB is reported as two counters, not as a manifest',
  },
  verdict: stagesWithNoProducer.length > 0
    ? `FAIL: ${String(stagesWithNoProducer.length)} of ${String(OBSERVATION_GAP_STAGES.length)} stages have no production producer`
    : 'all stages have a producer',
}

writeFileSync(join(HERE, 'BEFORE-data09.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  stagesWithNoProducer,
  producerCount: record.producerCount,
  closedSetSize: record.closedSetSize,
  manifestFieldsAbsent: record.existingProjectionRecord.manifestFieldsAbsent,
  projectionKeys,
}, null, 2))
