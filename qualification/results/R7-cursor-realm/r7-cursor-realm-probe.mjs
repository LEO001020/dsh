/**
 * R7 BEFORE/AFTER probe: DATA-11 — a page cursor is not a bearer token.
 *
 * The oracle, verbatim: "Replay a valid cursor against a different store or a
 * different revision. The cursor is refused and the refusal is recorded. A
 * cursor that yields pages from a store it was not issued for is NOT PASS."
 *
 * WHY THIS PROBE IMPORTS `lib/` AND NOT `src/`.
 *
 * The audit's own discipline: "an installed artifact is not the repository until
 * proven built from it". This project filed two FALSE findings (G-SEAM-29,
 * G-SEAM-36) by measuring a stale built `lib/`. So the probe imports the BUILT
 * artifact and REPORTS the source and lib digests together, and the caller can
 * check that `lib` was built from the `src` the digest names. It never imports
 * `src/` directly, so what is measured is the same artifact the profile loads
 * (`main: lib/host-plugin.js`).
 *
 * THE ARMS, and what each decides:
 *
 *   A  same realm + same revision          -> MUST succeed (the control; a
 *                                             refusal everywhere would be useless)
 *   B  different revision                  -> MUST refuse, and be recorded
 *   C  different store, object present     -> MUST refuse (the defect's own case),
 *      with the same scope string             and be recorded
 *   D  different store, object ABSENT      -> MUST refuse (already held)
 *   E  different store, DIFFERENT BYTES    -> MUST refuse. THE HARM ARM: before
 *      under the same content address          the fix it yielded bytes hashing
 *                                             to something other than the
 *                                             descriptor's digest
 *   F  corrupted object in the OWN store   -> MUST refuse. Isolates the harm from
 *                                             the cross-store question entirely.
 *   G  tampered cursor                     -> MUST refuse
 *   H  missing object                      -> MUST refuse, never an empty success
 *
 * "RECORDED" is measured, not asserted: every refusal is pushed through the
 * host's refusal sink and the probe reports the records it received. A refusal
 * the host cannot observe is not a recorded refusal.
 *
 * Run from packages/dsh-daily-work:
 *   node qualification/results/R7-cursor-realm/r7-cursor-realm-probe.mjs --label before
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = 'D:/DSH/work/wt-r7/packages/dsh-daily-work'
const OUT_DIR = HERE

const labelIndex = process.argv.indexOf('--label')
const label = labelIndex === -1 ? 'after' : process.argv[labelIndex + 1]

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
// THE BUILT ARTIFACT, not the source.
const artifacts = await import(pathToFileURL(`${PKG}/lib/artifacts.js`).href)
const observations = await import(pathToFileURL(`${PKG}/lib/observations.js`).href)

const { LocalArtifactStore, InMemorySessionReferenceLog, captureFile, pages, resolveReference } = artifacts
const { GrantTable } = observations

const tempDirs = []
function tempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `r7-${tag}-`))
  tempDirs.push(dir)
  return dir
}
function mountFs(cwd) {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}
function makePlane(tag, scopeName = 'project:r7') {
  const store = new LocalArtifactStore(join(tempRoot(tag), 'artifacts'))
  const log = new InMemorySessionReferenceLog()
  const grants = new GrantTable()
  const scope = scopeName
  grants.bump(scope)
  return { store, log, grants, scope }
}
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

/**
 * Call `pages` and normalize whatever happens into a recordable verdict.
 *
 * The host's refusal sink is `options.onRefusal` when the implementation
 * exposes one; the probe passes it on every call so "the refusal is recorded"
 * is a measurement rather than a claim.
 */
async function attempt(refusals, store, request, attemptName) {
  const sink = entry => refusals.push({ attempt: attemptName, at: new Date().toISOString(), ...entry })
  try {
    const page = await pages(store, { ...request, onRefusal: sink })
    return { refused: false, bytes: page.bytes.byteLength, sha256: sha256(Buffer.from(page.bytes)), offset: page.offset }
  } catch (error) {
    return {
      refused: true,
      code: error?.code ?? null,
      name: error?.name ?? null,
      message: error?.message ?? null,
      realmRefused: typeof error?.realmRefused === 'boolean' ? error.realmRefused : null,
    }
  }
}

const sourceDigest = file => {
  try {
    return sha256(readFileSync(file))
  } catch {
    return null
  }
}

const out = {
  label,
  measuredAt: new Date().toISOString(),
  node: process.version,
  identity: {
    builtLib: {
      artifactsJs: sourceDigest(`${PKG}/lib/artifacts.js`),
      observationsJs: sourceDigest(`${PKG}/lib/observations.js`),
      artifactsJsBytes: statSync(`${PKG}/lib/artifacts.js`).size,
    },
    source: {
      artifactsTs: sourceDigest(`${PKG}/src/artifacts.ts`),
      observationsTs: sourceDigest(`${PKG}/src/observations.ts`),
    },
  },
  arms: {},
  refusals: [],
}

// ---------------------------------------------------------------------------
// The stimulus. One payload, one file, several stores.
// ---------------------------------------------------------------------------
const root = tempRoot('stim')
const payload = Buffer.from('CURSOR-BEARER-TOKEN-PROBE-' + 'q'.repeat(300), 'utf8')
writeFileSync(join(root, 'p.bin'), payload)
const fs = mountFs(root)

const refusals = []

const planeA = makePlane('store-a')
const captureA = await captureFile({
  fs, path: 'p.bin', store: planeA.store, log: planeA.log, grants: planeA.grants,
  ownerScope: planeA.scope, executionWorld: 'local',
  observationId: 'obs-r7-cursor', mediaType: 'application/octet-stream',
})
const firstA = await pages(planeA.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
})
const issuedCursor = firstA.nextCursor ?? null
out.arms.cursorIssued = { issued: issuedCursor !== null, cursorLength: issuedCursor?.length ?? 0 }

// A: the control. Same realm, same revision -> success.
out.arms.A_sameRealmSameRevision = await attempt(refusals, planeA.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
  cursor: issuedCursor,
}, 'A_sameRealmSameRevision')

// B: a different REVISION on its own realm.
planeA.grants.bump(planeA.scope)
out.arms.B_differentRevision = await attempt(refusals, planeA.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
  cursor: issuedCursor,
}, 'B_differentRevision')
planeA.grants.bump(planeA.scope)

// C: a DIFFERENT STORE holding the same bytes under the same content address,
//    under the SAME scope string. The oracle's first arm; the defect.
const planeB = makePlane('store-b')
const captureB = await captureFile({
  fs, path: 'p.bin', store: planeB.store, log: planeB.log, grants: planeB.grants,
  ownerScope: planeB.scope, executionWorld: 'local',
  observationId: 'obs-r7-cursor-b', mediaType: 'application/octet-stream',
})
out.arms.sameSha256AcrossStores = captureA.descriptor.captured.sha256 === captureB.descriptor.captured.sha256
out.arms.C_differentStoreSameBytes = await attempt(refusals, planeB.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
  cursor: issuedCursor,
}, 'C_differentStoreSameBytes')

// D: a different store that does NOT hold the object at all.
const planeD = makePlane('store-d')
out.arms.D_differentStoreObjectAbsent = await attempt(refusals, planeD.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeD.grants, callerScope: planeA.scope,
  cursor: issuedCursor,
}, 'D_differentStoreObjectAbsent')

// E: THE HARM ARM. A different store holding DIFFERENT bytes under the SAME
//    content address (a corrupted or hostile realm).
const planeE = makePlane('store-e')
const captureE = await captureFile({
  fs, path: 'p.bin', store: planeE.store, log: planeE.log, grants: planeE.grants,
  ownerScope: planeE.scope, executionWorld: 'local',
  observationId: 'obs-r7-cursor-e', mediaType: 'application/octet-stream',
})
const eDigest = captureE.descriptor.captured.sha256
const ePath = join(planeE.store.root, 'objects', eDigest.slice(0, 2), eDigest)
chmodSync(ePath, 0o600)
writeFileSync(ePath, Buffer.alloc(payload.length, 0x5a))
const armE = await attempt(refusals, planeE.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeE.grants, callerScope: planeA.scope,
  cursor: issuedCursor,
}, 'E_differentStoreDifferentBytes')
out.arms.E_differentStoreDifferentBytes = {
  ...armE,
  descriptorSha256: captureA.descriptor.captured.sha256,
  yieldedIsTheNamedArtifact: armE.refused ? null : armE.sha256 === captureA.descriptor.captured.sha256,
}

// F: the mechanism, isolated from the cross-store question.
const planeF = makePlane('store-f')
const captureF = await captureFile({
  fs, path: 'p.bin', store: planeF.store, log: planeF.log, grants: planeF.grants,
  ownerScope: planeF.scope, executionWorld: 'local',
  observationId: 'obs-r7-cursor-f', mediaType: 'application/octet-stream',
})
const fDigest = captureF.descriptor.captured.sha256
const fPath = join(planeF.store.root, 'objects', fDigest.slice(0, 2), fDigest)
chmodSync(fPath, 0o600)
writeFileSync(fPath, Buffer.alloc(payload.length, 0x5a))
const armF = await attempt(refusals, planeF.store, {
  descriptor: captureF.descriptor, maxBytes: 64, grants: planeF.grants, callerScope: planeF.scope,
}, 'F_ownStoreCorrupt')
let resolveF
try {
  await resolveReference(planeF.store, planeF.log, 'obs-r7-cursor-f')
  resolveF = { refused: false }
} catch (error) {
  resolveF = { refused: true, code: error?.code ?? null }
}
out.arms.F_ownStoreCorrupt = {
  ...armF,
  yieldedIsTheNamedArtifact: armF.refused ? null : armF.sha256 === captureF.descriptor.captured.sha256,
  resolveReference: resolveF,
  pagingAndResolveDisagree: armF.refused !== resolveF.refused,
}

// G: a TAMPERED cursor. Flip one character of the payload, keep the signature.
const tampered = (() => {
  const text = String(issuedCursor)
  const index = Math.floor(text.length / 2)
  const flip = text[index] === 'A' ? 'B' : 'A'
  return `${text.slice(0, index)}${flip}${text.slice(index + 1)}`
})()
out.arms.G_tamperedCursor = await attempt(refusals, planeA.store, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
  cursor: tampered,
}, 'G_tamperedCursor')

// H: the object is MISSING from the realm the cursor was issued for.
const planeH = makePlane('store-h')
const captureH = await captureFile({
  fs, path: 'p.bin', store: planeH.store, log: planeH.log, grants: planeH.grants,
  ownerScope: planeH.scope, executionWorld: 'local',
  observationId: 'obs-r7-cursor-h', mediaType: 'application/octet-stream',
})
const hFirst = await pages(planeH.store, {
  descriptor: captureH.descriptor, maxBytes: 64, grants: planeH.grants, callerScope: planeH.scope,
})
const hDigest = captureH.descriptor.captured.sha256
const hPath = join(planeH.store.root, 'objects', hDigest.slice(0, 2), hDigest)
chmodSync(hPath, 0o600)
rmSync(hPath)
out.arms.H_missingObject = await attempt(refusals, planeH.store, {
  descriptor: captureH.descriptor, maxBytes: 64, grants: planeH.grants, callerScope: planeH.scope,
  cursor: hFirst.nextCursor ?? undefined,
}, 'H_missingObject')

// ---------------------------------------------------------------------------
// The realm identity, if the implementation exposes one.
//
// `realmId` is resolved LAZILY, so a freshly constructed store has not read the
// file yet. `ensureRealm()` is called first, because the accessor's refusal for an
// unresolved store is a deliberate guard (it stops `pages()` from binding a realm
// it has not established) and not the property under test here.
// ---------------------------------------------------------------------------
const realmOf = store => (typeof store.realmId === 'string' ? store.realmId : null)
const resolvedRealmOf = async store => {
  if (typeof store.ensureRealm !== 'function') return null
  try {
    return await store.ensureRealm()
  } catch {
    return null
  }
}
const realmA = await resolvedRealmOf(planeA.store)
const realmB = await resolvedRealmOf(planeB.store)
out.realm = {
  storeExposesRealm: realmA,
  realmDiffersAcrossStores: realmA === null ? null : realmA !== realmB,
  // A SECOND store object over the SAME root: same realm, or a new one? This is
  // the in-process half of the restart-stability question; the cross-process half
  // is measured by running this probe twice against one root.
  realmAfterReopen: null,
  realmStableAcrossSecondStoreInstance: null,
  persistedRealmFile: null,
}
const sameRoot = planeA.store.root
try {
  const reopened = new LocalArtifactStore(sameRoot)
  out.realm.realmAfterReopen = await resolvedRealmOf(reopened)
  out.realm.realmStableAcrossSecondStoreInstance = realmA === null
    ? null
    : realmA === out.realm.realmAfterReopen
} catch (error) {
  out.realm.realmAfterReopen = `ERROR: ${error.message}`
}
try {
  const realmFile = join(sameRoot, 'store-realm.json')
  out.realm.persistedRealmFile = { path: realmFile, contents: JSON.parse(readFileSync(realmFile, 'utf8')) }
} catch {
  out.realm.persistedRealmFile = null
}

out.refusals = refusals
out.verdicts = {
  control_sameRealmSucceeds: out.arms.A_sameRealmSameRevision.refused === false,
  differentRevisionRefused: out.arms.B_differentRevision.refused === true,
  differentStoreRefused: out.arms.C_differentStoreSameBytes.refused === true,
  crossStoreYieldedUnverifiedBytes: out.arms.E_differentStoreDifferentBytes.refused === false
    && out.arms.E_differentStoreDifferentBytes.yieldedIsTheNamedArtifact === false,
  ownStoreCorruptRefused: out.arms.F_ownStoreCorrupt.refused === true,
  tamperedCursorRefused: out.arms.G_tamperedCursor.refused === true,
  missingObjectRefused: out.arms.H_missingObject.refused === true,
  refusalsRecorded: refusals.length > 0,
  DATA_11_ORACLE_SATISFIED: out.arms.A_sameRealmSameRevision.refused === false
    && out.arms.B_differentRevision.refused === true
    && out.arms.C_differentStoreSameBytes.refused === true
    && out.arms.E_differentStoreDifferentBytes.refused === true
    && out.arms.F_ownStoreCorrupt.refused === true
    && out.arms.G_tamperedCursor.refused === true
    && out.arms.H_missingObject.refused === true
    && refusals.length > 0,
}

writeFileSync(join(OUT_DIR, `${label}.json`), `${JSON.stringify(out, null, 2)}\n`)
console.log(JSON.stringify(out.verdicts, null, 2))
console.log(JSON.stringify({ realm: out.realm, refusalCount: refusals.length }, null, 2))

for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch {
    // A temp dir left behind is not a measurement failure.
  }
}
