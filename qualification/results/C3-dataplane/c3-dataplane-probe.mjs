/**
 * C3 probe: measure DATA-09 and DATA-11 on THIS tree's built lib.
 *
 * WHY IT IMPORTS `lib/` AND NOT `src/`. The audit filed two FALSE findings
 * (G-SEAM-29, G-SEAM-36) by measuring a stale built `lib/`. So this probe imports
 * the BUILT artifact -- the same one the profile loads (`main: lib/host-plugin.js`)
 * -- and reports the src and lib digests together so a reader can check that the
 * lib was built from the src it names.
 *
 * WHAT IT MEASURES
 *
 *   DATA-09  the closed set of gap stages, and, per stage, whether a real
 *            production source ASSIGNS it (comments excluded, since a comment is
 *            not a producer). Plus the recovery vocabulary.
 *
 *   DATA-11  the arms the oracle names: different STORE, different REVISION, and
 *            the CONTROL (own store still serves). Each refusal is checked to be
 *            RECORDED, not merely raised.
 *
 * Run:  node qualification/results/C3-dataplane/c3-dataplane-probe.mjs --label before
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..').replace(/\\/g, '/')
const PKG = `${REPO}/packages/dsh-daily-work`
const SRC = `${PKG}/src`

const labelIndex = process.argv.indexOf('--label')
const label = labelIndex === -1 ? 'after' : process.argv[labelIndex + 1]

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const { default: AttachmentLocal } = await import(resolveFromPkg('@deepseek-ai/dsh-attachment-local'))
const artifacts = await import(pathToFileURL(`${PKG}/lib/artifacts.js`).href)
const observations = await import(pathToFileURL(`${PKG}/lib/observations.js`).href)

const digest = text => createHash('sha256').update(text).digest('hex')

/** SHA-256 of a file's bytes, or null when absent. */
function fileDigest(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}

const out = {
  probe: 'c3-dataplane',
  label,
  measuredAt: new Date().toISOString(),
  identity: {
    repo: REPO,
    srcArtifactsTs: fileDigest(`${SRC}/artifacts.ts`),
    srcObservationsTs: fileDigest(`${SRC}/observations.ts`),
    libArtifactsJs: fileDigest(`${PKG}/lib/artifacts.js`),
    libObservationsJs: fileDigest(`${PKG}/lib/observations.js`),
  },
  sections: {},
}

// ---------------------------------------------------------------------------
// DATA-09: the closed set, and per-stage producers in PRODUCTION source.
// ---------------------------------------------------------------------------

/**
 * Strip comments, keeping line numbers.
 *
 * A comment that NAMES a stage is not a producer. The module's own doc comments
 * say "v1 filed `{stage: 'model-projection'}` as a loss", so a naive grep reports
 * a producer for a stage no code path can emit.
 */
function stripComments(text) {
  const lines = text.split('\n')
  let inBlock = false
  return lines.map(line => {
    let outText = ''
    let index = 0
    while (index < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', index)
        if (close === -1) return outText
        inBlock = false
        index = close + 2
        continue
      }
      const open = line.indexOf('/*', index)
      const lineComment = line.indexOf('//', index)
      if (lineComment !== -1 && (open === -1 || lineComment < open)) return outText + line.slice(index, lineComment)
      if (open === -1) return outText + line.slice(index)
      outText += line.slice(index, open)
      inBlock = true
      index = open + 2
    }
    return outText
  }).join('\n')
}

/** Every `stage: '<name>'` assignment in a file, with line numbers, comments excluded. */
function stageAssignments(text, stage) {
  return stripComments(text).split('\n')
    .map((line, number) => ({ line, number: number + 1 }))
    .filter(({ line }) => new RegExp(`stage:\\s*'${stage}'`, 'u').test(line))
    .map(({ number }) => number)
}

const closedSet = [...observations.OBSERVATION_GAP_STAGES]
const coverageSet = [...observations.ACQUISITION_COVERAGE_STAGES]
const recoveries = [...observations.OBSERVATION_GAP_RECOVERIES]
const v1Stages = ['provider-acquisition', 'native-acquisition', 'transform', 'retention', 'transport', 'model-projection']

const sources = readdirSync(SRC)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map(name => ({ file: name, text: readFileSync(join(SRC, name), 'utf8') }))

const producers = {}
for (const stage of v1Stages) {
  producers[stage] = sources.flatMap(({ file, text }) =>
    stageAssignments(text, stage).map(line => `${file}:${line}`))
}

out.sections.data09 = {
  observationSchemaVersion: observations.OBSERVATION_SCHEMA_VERSION,
  closedSet,
  closedSetSize: closedSet.length,
  coverageVocabulary: coverageSet,
  coverageMatchesGapStages: JSON.stringify(coverageSet) === JSON.stringify(closedSet),
  recoveries,
  v1OracleStages: v1Stages,
  producers,
  stagesInClosedSetWithNoProducer: closedSet.filter(stage => producers[stage].length === 0),
  v1StagesAbsentFromClosedSet: v1Stages.filter(stage => !closedSet.includes(stage)),
  v1StagesPresentInClosedSet: v1Stages.filter(stage => closedSet.includes(stage)),
  allClosedSetStagesProduced: closedSet.every(stage => producers[stage].length > 0),
  // The oracle's clause: a gap must carry a stage from the closed set AND a
  // recovery from the recovery set. Checked against the schema, not asserted.
  gapSchemaAcceptsOnlyClosedSet: (() => {
    const good = { stage: closedSet[0], reason: 'r', recovery: recoveries[0] }
    const results = { closedSetStageAccepted: null, transportRejected: null, modelProjectionRejected: null, badRecoveryRejected: null }
    try { observations.observationGapSchema.parse(good); results.closedSetStageAccepted = true } catch { results.closedSetStageAccepted = false }
    for (const [stage, key] of [['transport', 'transportRejected'], ['model-projection', 'modelProjectionRejected']]) {
      try { observations.observationGapSchema.parse({ stage, reason: 'r', recovery: 'none' }); results[key] = false } catch { results[key] = true }
    }
    try { observations.observationGapSchema.parse({ stage: closedSet[0], reason: 'r', recovery: 'not-a-recovery' }); results.badRecoveryRejected = false } catch { results.badRecoveryRejected = true }
    return results
  })(),
}

// ---------------------------------------------------------------------------
// DATA-11: the cursor arms, driven against real stores on disk.
// ---------------------------------------------------------------------------

const tempDirs = []
function tempRoot(name) {
  const dir = mkdtempSync(join(tmpdir(), `c3-${name}-`))
  tempDirs.push(dir)
  return dir
}

const PAYLOAD = Buffer.from('C3-CURSOR-REALM-' + 'w'.repeat(300), 'utf8')
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

/** A real store + log + grants triple over real directories. */
function makePlane(name, scope = 'project:c3') {
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

async function captureInto(root, plane, observationId) {
  return artifacts.captureFile({
    fs: mountFs(root), path: 'p.bin', store: plane.store, log: plane.log, grants: plane.grants,
    ownerScope: plane.scope, executionWorld: 'local', observationId, mediaType: 'application/octet-stream',
  })
}

/** Replace an object's bytes in place, so a store holds DIFFERENT bytes at the same address. */
async function corruptObject(store, digestValue, fill) {
  const path = await store.hostPath(`artifact:sha256:${digestValue}`)
  if (path === undefined) throw new Error('the mounted provider must be host-backed')
  const { chmodSync, writeFileSync: write } = await import('node:fs')
  chmodSync(path, 0o600)
  write(path, Buffer.alloc(PAYLOAD.length, fill))
}

/**
 * Present a cursor to a store and report whether it was REFUSED and whether the
 * refusal reached the host's sink. Both halves are the oracle: a refusal the host
 * cannot observe is not a recorded refusal.
 */
async function present(store, request) {
  const refusals = []
  try {
    const page = await artifacts.pages(store, {
      ...request,
      onRefusal: refusal => { refusals.push({ code: refusal.code, step: refusal.step }) },
    })
    return {
      refused: false,
      yieldedBytes: page.bytes.byteLength,
      sha256: sha256(page.bytes),
      offset: page.offset,
      refusals,
    }
  } catch (error) {
    return {
      refused: true,
      code: error?.code ?? null,
      name: error?.name ?? null,
      message: error?.message ?? null,
      realmRefused: typeof error?.realmRefused === 'boolean' ? error.realmRefused : null,
      refusals,
    }
  }
}

const data11 = { arms: {}, verdicts: {} }
try {
  const rootA = tempRoot('a')
  writeFileSync(join(rootA, 'p.bin'), PAYLOAD)
  const planeA = makePlane('store-a')
  const planeB = makePlane('store-b')
  const captureA = await captureInto(rootA, planeA, 'obs-c3-a')
  // The SAME bytes into store B, so B genuinely holds the content address the
  // descriptor names and the store identity is the ONLY thing separating them.
  const captureB = await captureInto(rootA, planeB, 'obs-c3-b')

  const realmA = await planeA.store.ensureRealm()
  const realmB = await planeB.store.ensureRealm()
  data11.realmA = realmA
  data11.realmB = realmB
  data11.realmsDiffer = realmA !== realmB
  data11.sameSha256InBothStores = captureA.descriptor.captured.sha256 === captureB.descriptor.captured.sha256
  data11.descriptorSha256 = captureA.descriptor.captured.sha256

  const descriptor = captureA.descriptor
  const base = { descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope }

  // CONTROL: the cursor against its OWN store. Must still serve, or the whole
  // binding would be a refusal everywhere and prove nothing.
  const first = await artifacts.pages(planeA.store, base)
  data11.arms.control_ownStore = {
    offset: first.offset, bytes: first.bytes.byteLength, hasCursor: first.nextCursor !== undefined,
  }
  const cursor = first.nextCursor

  if (cursor !== undefined) {
    // CONTROL ARM 2: the ISSUED cursor replayed against its OWN store. This is the
    // arm that must stay GREEN -- a cursor is not a bearer token, but it is still a
    // working cursor on the store that minted it.
    data11.arms.control_cursorReplayOnOwnStore = await present(planeA.store, { ...base, cursor })

    // ARM 1 (the oracle names it FIRST): a different STORE holding the SAME bytes.
    data11.arms.differentStore = await present(planeB.store, { ...base, cursor })

    // ARM 2: a different REVISION, on the cursor's OWN store. A SEPARATE plane, so
    // bumping the grant here cannot contaminate the control above.
    const rootE = tempRoot('e')
    writeFileSync(join(rootE, 'p.bin'), PAYLOAD)
    const planeE = makePlane('store-e')
    const captureE = await captureInto(rootE, planeE, 'obs-c3-e')
    const eBase = { descriptor: captureE.descriptor, maxBytes: 64, grants: planeE.grants, callerScope: planeE.scope }
    const firstE = await artifacts.pages(planeE.store, eBase)
    planeE.grants.bump(planeE.scope)
    if (firstE.nextCursor !== undefined) {
      data11.arms.differentRevision = await present(planeE.store, { ...eBase, cursor: firstE.nextCursor })
    }

    // THE HARM ARM: a store holding DIFFERENT bytes under the same content
    // address. The corrupted store cannot even mint a cursor over the object it
    // damaged -- its own identity check refuses -- which is recorded rather than
    // assumed, because "the foreign store refused" and "the foreign store minted a
    // cursor" lead to different conclusions about the boundary.
    const planeC = makePlane('store-c')
    await captureInto(rootA, planeC, 'obs-c3-c')
    await corruptObject(planeC.store, captureA.descriptor.captured.sha256, 0xcc)
    const planeF = makePlane('store-f')
    await captureInto(rootA, planeF, 'obs-c3-f')
    let foreignCursor
    try {
      const foreignPage = await artifacts.pages(planeC.store, {
        descriptor, maxBytes: 64, grants: planeC.grants, callerScope: planeC.scope,
      })
      foreignCursor = foreignPage.nextCursor
      data11.arms.corruptStoreMintingItsOwnCursor = {
        refused: false, yieldedBytes: foreignPage.bytes.byteLength, hasCursor: foreignCursor !== undefined,
      }
    } catch (error) {
      data11.arms.corruptStoreMintingItsOwnCursor = {
        refused: true, code: error?.code ?? null, message: error?.message ?? null,
      }
    }
    if (foreignCursor !== undefined) {
      data11.arms.foreignCursorPresentedToThirdStore = await present(planeF.store, {
        descriptor, maxBytes: 64, grants: planeF.grants, callerScope: planeF.scope,
        cursor: foreignCursor,
      })
    }

    // THE INTEGRITY ARM: the object corrupted in the store the descriptor was
    // minted from. `resolveReference` refuses this; the paging path must agree.
    const planeD = makePlane('store-d')
    const captureD = await captureInto(rootA, planeD, 'obs-c3-d')
    await corruptObject(planeD.store, captureD.descriptor.captured.sha256, 0xdd)
    data11.arms.corruptOwnStore = await present(planeD.store, {
      descriptor: captureD.descriptor, maxBytes: 64, grants: planeD.grants, callerScope: planeD.scope,
    })
    try {
      await artifacts.resolveReference(planeD.store, planeD.log, captureD.descriptor.captured.artifact)
      data11.arms.corruptOwnStore_resolveReference = { refused: false }
    } catch (error) {
      data11.arms.corruptOwnStore_resolveReference = { refused: true, code: error?.code ?? null }
    }
  }

  data11.verdicts = {
    control_ownStoreServes: data11.arms.control_ownStore?.bytes === 64,
    control_cursorReplayServes: data11.arms.control_cursorReplayOnOwnStore?.refused === false,
    differentStoreRefused: data11.arms.differentStore?.refused === true,
    differentStoreRefusalIsRealm: data11.arms.differentStore?.code === 'pagination-realm-denied',
    differentStoreRefusalRecorded: (data11.arms.differentStore?.refusals ?? []).length > 0,
    differentStoreYieldedBytes: data11.arms.differentStore?.yieldedBytes ?? null,
    differentRevisionRefused: data11.arms.differentRevision?.refused === true,
    differentRevisionRefusalRecorded: (data11.arms.differentRevision?.refusals ?? []).length > 0,
    corruptOwnStoreRefused: data11.arms.corruptOwnStore?.refused === true,
    // The oracle: "The cursor is refused and the refusal is recorded. A cursor
    // that yields pages from a store it was not issued for is NOT PASS."
    DATA_11_ORACLE_SATISFIED:
      data11.arms.control_ownStore?.bytes === 64
      && data11.arms.differentStore?.refused === true
      && (data11.arms.differentStore?.refusals ?? []).length > 0
      && data11.arms.differentStore?.yieldedBytes === undefined
      && data11.arms.differentRevision?.refused === true
      && (data11.arms.differentRevision?.refusals ?? []).length > 0,
  }
} catch (error) {
  data11.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
  data11.verdicts = { DATA_11_ORACLE_SATISFIED: false }
}
out.sections.data11 = data11

for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) } catch { /* best effort */ }
}

writeFileSync(join(HERE, `${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(out.sections.data09, null, 1))
console.log(JSON.stringify(out.sections.data11.verdicts, null, 1))
