/**
 * C3 arm probe: measure DATA-11's three arms against THIS worktree's build.
 *
 * WHY THIS EXISTS. `qualification/results/R7-cursor-realm/{before,after}.json` are
 * the archived R7 measurements, and they were taken against `D:/DSH/work/wt-r7`
 * (their `identity` block hashes that tree's files, and their PKG constant names
 * it). They cannot be re-run here without editing a frozen archive. This probe
 * measures the SAME arms against THIS tree's `lib/`, so the before/after in
 * `REPORT.md` is an observation about this worktree and not a quotation.
 *
 * It is the R7 arm set, not a substitute for it: A..H below are the same
 * stimulus shapes the R7 probe uses, so a difference between the two is a
 * difference in the TREE and not in the measurement.
 *
 * Run:
 *   node qualification/results/C3-dataplane/c3-arm-probe.mjs --label before|after
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(dirname(dirname(HERE))).replace(/\\/g, '/')
const PKG = `${REPO}/packages/dsh-daily-work`

const labelIndex = process.argv.indexOf('--label')
const label = labelIndex === -1 ? 'after' : process.argv[labelIndex + 1]

const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const { default: AttachmentLocal } = await import(resolveFromPkg('@deepseek-ai/dsh-attachment-local'))
// THE BUILT ARTIFACT, not the source: the same thing a boot resolves.
const artifacts = await import(pathToFileURL(`${PKG}/lib/artifacts.js`).href)
const observations = await import(pathToFileURL(`${PKG}/lib/observations.js`).href)

const { AttachmentArtifactStore, InMemorySessionReferenceLog, captureFile, pages, resolveReference } = artifacts
const { GrantTable } = observations

const tempDirs = []
function tempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `c3-${tag}-`))
  tempDirs.push(dir)
  return dir
}
function mountFs(cwd) {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}
function makePlane(tag, scopeName = 'project:c3') {
  const root = tempRoot(tag)
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: join(root, 'home') })
  const store = new AttachmentArtifactStore(ctx.attachments, join(root, 'artifacts'))
  const log = new InMemorySessionReferenceLog()
  const grants = new GrantTable()
  const scope = scopeName
  grants.bump(scope)
  return { store, log, grants, scope }
}
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

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

/** The object file inside a store root, addressed by digest. */
async function objectPath(store, digest) {
  // The store keeps its bytes in the mounted provider, so the path is asked for
  // rather than reconstructed: reconstructing a layout is how a probe measures its
  // own assumption.
  const entry = await store.stat(`artifact:sha256:${digest}`)
  if (entry === undefined) throw new Error(`no index entry for ${digest}`)
  const ref = { attachmentId: `sha256:${digest}`, name: 'artifact', bytes: entry.bytes }
  const host = store.provider.fileHostPath(ref)
  if (host === undefined) throw new Error('the provider is not host-file-backed')
  return host
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
  tree: REPO,
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

const root = tempRoot('stim')
const payload = Buffer.from('CURSOR-BEARER-TOKEN-PROBE-' + 'q'.repeat(300), 'utf8')
writeFileSync(join(root, 'p.bin'), payload)
const fs = mountFs(root)

const refusals = []

const planeA = makePlane('store-a')
const captureA = await captureFile({
  fs, path: 'p.bin', store: planeA.store, log: planeA.log, grants: planeA.grants,
  ownerScope: planeA.scope, executionWorld: 'local',
  observationId: 'obs-c3-cursor', mediaType: 'application/octet-stream',
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

// C: a DIFFERENT STORE holding the same bytes under the same content address,
//    under the SAME scope string. The oracle's first arm; the defect.
const planeB = makePlane('store-b')
const captureB = await captureFile({
  fs, path: 'p.bin', store: planeB.store, log: planeB.log, grants: planeB.grants,
  ownerScope: planeB.scope, executionWorld: 'local',
  observationId: 'obs-c3-cursor-b', mediaType: 'application/octet-stream',
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
  observationId: 'obs-c3-cursor-e', mediaType: 'application/octet-stream',
})
const ePath = await objectPath(planeE.store, captureE.descriptor.captured.sha256)
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
  observationId: 'obs-c3-cursor-f', mediaType: 'application/octet-stream',
})
const fPath = await objectPath(planeF.store, captureF.descriptor.captured.sha256)
chmodSync(fPath, 0o600)
writeFileSync(fPath, Buffer.alloc(payload.length, 0x5a))
const armF = await attempt(refusals, planeF.store, {
  descriptor: captureF.descriptor, maxBytes: 64, grants: planeF.grants, callerScope: planeF.scope,
}, 'F_ownStoreCorrupt')
let resolveF
try {
  await resolveReference(planeF.store, planeF.log, 'obs-c3-cursor-f')
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
  observationId: 'obs-c3-cursor-h', mediaType: 'application/octet-stream',
})
const hFirst = await pages(planeH.store, {
  descriptor: captureH.descriptor, maxBytes: 64, grants: planeH.grants, callerScope: planeH.scope,
})
const hPath = await objectPath(planeH.store, captureH.descriptor.captured.sha256)
chmodSync(hPath, 0o600)
rmSync(hPath)
out.arms.H_missingObject = await attempt(refusals, planeH.store, {
  descriptor: captureH.descriptor, maxBytes: 64, grants: planeH.grants, callerScope: planeH.scope,
  cursor: hFirst.nextCursor ?? undefined,
}, 'H_missingObject')

// I: the SAME-KEY cross-store arm. Two stores that share a cursor key but not a
//    realm: a whole-root clone of the key file. This is the arm the realm check
//    exists for once the MAC key is per-store.
const planeI = makePlane('store-i')
const iCapture = await captureFile({
  fs, path: 'p.bin', store: planeI.store, log: planeI.log, grants: planeI.grants,
  ownerScope: planeI.scope, executionWorld: 'local',
  observationId: 'obs-c3-cursor-i', mediaType: 'application/octet-stream',
})
// Copy planeA's KEY into planeI's root, so planeI's MACs verify planeA's cursors.
{
  const { copyFileSync } = await import('node:fs')
  copyFileSync(
    join(planeA.store.root, artifacts.STORE_CURSOR_KEY_FILE_NAME),
    join(planeI.store.root, artifacts.STORE_CURSOR_KEY_FILE_NAME),
  )
  // A NEW store object, so the copied key is what it resolves rather than the memo.
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: join(tempRoot('store-i-home'), 'home') })
}
out.arms.I_sharedKeyDifferentRealm = await attempt(refusals, planeI.store, {
  descriptor: iCapture.descriptor, maxBytes: 64, grants: planeI.grants, callerScope: planeI.scope,
  cursor: (await pages(planeI.store, {
    descriptor: iCapture.descriptor, maxBytes: 64, grants: planeI.grants, callerScope: planeI.scope,
  })).nextCursor,
}, 'I_sharedKeyDifferentRealm')

const resolvedRealmOf = async store => {
  try {
    return await store.ensureRealm()
  } catch {
    return null
  }
}
out.realm = {
  storeA: await resolvedRealmOf(planeA.store),
  storeB: await resolvedRealmOf(planeB.store),
  storeI: await resolvedRealmOf(planeI.store),
}
out.realm.realmDiffersAcrossStores = out.realm.storeA !== out.realm.storeB

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

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
writeFileSync(join(HERE, `${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ label, verdicts: out.verdicts, arms: {
  C: out.arms.C_differentStoreSameBytes, E: out.arms.E_differentStoreDifferentBytes,
  A: out.arms.A_sameRealmSameRevision, B: out.arms.B_differentRevision, F: out.arms.F_ownStoreCorrupt,
} }, null, 2))
