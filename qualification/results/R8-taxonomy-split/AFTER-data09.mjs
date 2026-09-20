/**
 * R8 AFTER reproduction: the DATA-09 split, measured on the changed tree.
 *
 * Paired with BEFORE-data09.json, which measured the same six questions on the
 * pre-change tree. Read them together: the interesting column is the DIFF.
 *
 * WHAT THIS MEASURES
 *
 *   (1) The closed set is FOUR stages, not six. `transport` and
 *       `model-projection` are absent BY NAME, so a re-addition is visible.
 *
 *   (2) All four have a real production producer (`stage: '...'` assigned in
 *       non-test production source, comments stripped). The count is 4 of 4 --
 *       NOT 6 of 6, because no producer was fabricated to reach six.
 *
 *   (3) The two removed names have ZERO gap producers. This is the negative
 *       half: if `model-projection` were still assigned, the split would be
 *       cosmetic and the conflation would survive in emitted records.
 *
 *   (4) A projection is a ProjectionManifest with `sourceRef`, the selected and
 *       omitted counts, a `recoverableRef` and a `projectionReason` -- and it
 *       has NO `stage` and NO `recovery`, so it cannot be filed as a gap.
 *
 *   (5) `OBSERVATION_SCHEMA_VERSION` moved to 2, and a v1 descriptor is refused
 *       with `observation-schema-version-unsupported` rather than re-read.
 *
 * Run from packages/dsh-daily-work:
 *   node --import file:///D:/DSH/src/dsh-src/node_modules/tsx/dist/loader.mjs \
 *     D:/DSH/work/wt-r8/qualification/results/R8-taxonomy-split/AFTER-data09.mjs
 *
 * Writes AFTER-data09.json next to this file. Asserts nothing it did not read.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
const PKG_SRC = 'D:/DSH/work/wt-r8/packages/dsh-daily-work/src'

const observations = await import(`file:///${PKG_SRC}/observations.ts`.replace(/\/\//gu, '/'))
const {
  OBSERVATION_GAP_STAGES,
  ACQUISITION_COVERAGE_STAGES,
  OBSERVATION_SCHEMA_VERSION,
  GrantTable,
  parseObservation,
  recordProjection,
  projectionWithheld,
} = observations

// ---------------------------------------------------------------------------
// The comment stripper. Load-bearing: this file's own prose NAMES the removed
// stages, and a naive scan would report producers that do not exist.
// ---------------------------------------------------------------------------
function stripComments(text) {
  let inBlock = false
  return text.split('\n').map(line => {
    let out = ''
    let index = 0
    while (index < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', index)
        if (close === -1) return out
        inBlock = false
        index = close + 2
        continue
      }
      const open = line.indexOf('/*', index)
      const lineComment = line.indexOf('//', index)
      if (lineComment !== -1 && (open === -1 || lineComment < open)) return out + line.slice(index, lineComment)
      if (open === -1) return out + line.slice(index)
      out += line.slice(index, open)
      inBlock = true
      index = open + 2
    }
    return out
  }).join('\n')
}

const productionFiles = readdirSync(PKG_SRC).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
const sourceText = new Map(productionFiles.map(name => [name, readFileSync(join(PKG_SRC, name), 'utf8')]))

function assignments(stage) {
  const hits = []
  for (const [file, text] of sourceText) {
    stripComments(text).split('\n').forEach((line, index) => {
      if (new RegExp(`stage:\\s*'${stage}'`, 'u').test(line)) hits.push(`${file}:${index + 1}`)
    })
  }
  return hits
}

// ---------------------------------------------------------------------------
// (1)+(2)+(3) the taxonomy and its producers
// ---------------------------------------------------------------------------
const producerEvidence = {}
const producerCounts = {}
for (const stage of [...OBSERVATION_GAP_STAGES, 'transport', 'model-projection']) {
  producerEvidence[stage] = assignments(stage)
  producerCounts[stage] = producerEvidence[stage].length
}
const stagesWithNoProducer = OBSERVATION_GAP_STAGES.filter(stage => producerCounts[stage] === 0)

// ---------------------------------------------------------------------------
// (4) the projection is a manifest, not a gap
// ---------------------------------------------------------------------------
const artifactRef = `artifact:sha256:${'a'.repeat(64)}`
const manifest = recordProjection({
  sourceRef: artifactRef,
  selectedBytes: 2048,
  sourceBytes: 30 * 1024 * 1024,
  projectionReason: 'the model request budget allows a bounded preview of the artifact',
})
const manifestKeys = Object.keys(manifest).sort()

// A projection over an unmeasured stream: the omitted count must stay UNKNOWN
// rather than becoming a fabricated 0 that asserts a complete projection.
const unknownTotal = recordProjection({
  sourceRef: artifactRef,
  selectedBytes: 2048,
  projectionReason: 'the source was streamed and its total size was never established',
})

// ---------------------------------------------------------------------------
// (5) the schema version refuses a v1 descriptor by name
// ---------------------------------------------------------------------------
const grants = new GrantTable()
grants.bump('project:r8')
const v1Descriptor = {
  id: 'obs-v1',
  schemaVersion: 1,
  source: { kind: 'file', locator: 'x', acquiredAt: '2026-09-20T00:00:00.000Z', executionWorld: 'local' },
  captured: { artifact: artifactRef, sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/plain' },
  acquisition: {
    completeness: 'complete-within-request',
    coverage: null,
    gaps: [{ stage: 'model-projection', reason: 'the model saw 10 of 2000 lines', recovery: 'page' }],
  },
  authority: { ownerScope: 'project:r8', grantRevision: 1 },
}
let versionRefusal = null
try {
  parseObservation(v1Descriptor, grants)
} catch (error) {
  versionRefusal = { name: error.name, code: error.code, message: error.message }
}

const record = {
  probe: 'R8 AFTER — the DATA-09 split, measured on the changed tree',
  identity: {
    worktree: 'D:/DSH/work/wt-r8',
    branch: 'wt/r8',
    measuredFrom: 'packages/dsh-daily-work/src (TS source, imported through tsx)',
    pairedWith: 'BEFORE-data09.json in this directory',
  },
  observationSchemaVersion: OBSERVATION_SCHEMA_VERSION,
  closedSet: [...OBSERVATION_GAP_STAGES],
  closedSetSize: OBSERVATION_GAP_STAGES.length,
  coverageVocabulary: [...ACQUISITION_COVERAGE_STAGES],
  coverageMatchesGapStages: JSON.stringify([...ACQUISITION_COVERAGE_STAGES]) === JSON.stringify([...OBSERVATION_GAP_STAGES]),
  producerCounts,
  producerEvidence,
  stagesWithNoProducer,
  stagesWithProducer: OBSERVATION_GAP_STAGES.filter(stage => producerCounts[stage] > 0),
  producerCount: OBSERVATION_GAP_STAGES.length - stagesWithNoProducer.length,
  removedStages: {
    transport: {
      stillAGapStage: OBSERVATION_GAP_STAGES.includes('transport'),
      gapProducers: producerEvidence.transport,
      whereItWent: 'a refusal with a stable FRAME_TOO_LARGE code and a count; a failed transport is a failed OPERATION, '
        + 'and an over-limit frame is rejected before any successful value exists',
    },
    'model-projection': {
      stillAGapStage: OBSERVATION_GAP_STAGES.includes('model-projection'),
      gapProducers: producerEvidence['model-projection'],
      whereItWent: 'a ProjectionManifest — a sibling of `acquisition`, not a member of its gap list',
    },
  },
  projectionManifest: {
    keys: manifestKeys,
    hasStage: Object.hasOwn(manifest, 'stage'),
    hasRecovery: Object.hasOwn(manifest, 'recovery'),
    selectedBytes: manifest.selectedBytes,
    omittedBytes: manifest.omittedBytes,
    recoverableRef: manifest.recoverableRef,
    projectionReason: manifest.projectionReason,
    withheld: projectionWithheld(manifest),
    artifactBytes: 30 * 1024 * 1024,
    note: 'a 30 MiB artifact projected to 2 KiB is recorded as a manifest, and is NOT an acquisition gap',
  },
  unknownTotalProjection: {
    omittedBytes: unknownTotal.omittedBytes ?? null,
    withheld: projectionWithheld(unknownTotal),
    note: 'an unmeasured total leaves the omitted count UNKNOWN rather than fabricating a 0 that would assert completeness',
  },
  schemaVersionRefusal: {
    measured: versionRefusal,
    refusedByCode: versionRefusal?.code ?? null,
    isNotReportedAsMalformed: versionRefusal?.code !== 'observation-malformed',
  },
  verdict: stagesWithNoProducer.length === 0 && OBSERVATION_GAP_STAGES.length === 4
    ? 'PASS: 4 of 4 acquisition stages have a real producer; transport and model-projection are not acquisition gaps'
    : `UNEXPECTED: closedSetSize=${String(OBSERVATION_GAP_STAGES.length)} unproduced=${JSON.stringify(stagesWithNoProducer)}`,
}

writeFileSync(join(HERE, 'AFTER-data09.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  closedSet: record.closedSet,
  closedSetSize: record.closedSetSize,
  producerCounts,
  stagesWithNoProducer,
  projectionKeys: manifestKeys,
  projectionHasStage: record.projectionManifest.hasStage,
  versionRefusalCode: record.schemaVersionRefusal.refusedByCode,
  verdict: record.verdict,
}, null, 2))
