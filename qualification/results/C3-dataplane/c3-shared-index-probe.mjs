/**
 * C3 probe 3: is there a store the cursor was NOT issued for that the realm
 * check cannot tell apart from the one it WAS issued for?
 *
 * THE SHAPE. The store's durable identity -- `store-realm.json` -- lives in the
 * store's INDEX root, and so does `store-cursor-key.json`. A store's BYTES live in
 * the mounted attachment provider, addressed by its own home. So two
 * `AttachmentArtifactStore` objects can share an index root (and therefore share a
 * realm AND a cursor key) while resolving their bytes from DIFFERENT homes.
 *
 * For that pair, every check on the paging path passes by construction:
 *   - the MAC verifies, because both resolve the same key file;
 *   - `assertRealm` passes, because both resolve the same realm file;
 *   - the index entry is found, because the index is shared;
 *   - `assertObjectIdentity` resolves the provider ref against the SECOND home,
 *     which is where the check becomes a check of the wrong store's bytes.
 *
 * So the question is exactly the oracle's: does a cursor minted against store A
 * yield pages from store B? And if it does, are the bytes the ones the descriptor
 * names?
 *
 * WHAT MAKES THIS THE HONEST VERSION OF THE ARM. Nothing is corrupted and nothing
 * is hand-edited: two ordinary stores, constructed the ordinary way, with the
 * ordinary `wx` protocol. The only unusual thing is that a deployment pointed two
 * byte homes at one index root -- which is what a `reopenStoreAt`-style restart,
 * a home moved between boots, or a second provider over a shared index produces.
 *
 * Run: node qualification/results/C3-dataplane/c3-shared-index-probe.mjs --label before
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

const { AttachmentArtifactStore, InMemorySessionReferenceLog, captureFile, pages } = artifacts
const { GrantTable } = observations

const tempDirs = []
function tempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `c3s-${tag}-`))
  tempDirs.push(dir)
  return dir
}
function mountFs(cwd) {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}
/** A store whose INDEX root and byte HOME are both chosen by the caller. */
function storeAt(indexRoot, home) {
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: home })
  return new AttachmentArtifactStore(ctx.attachments, indexRoot)
}
const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const fileDigest = path => {
  try { return sha256(readFileSync(path)) } catch { return null }
}

async function attempt(store, request) {
  try {
    const page = await pages(store, request)
    return { refused: false, bytes: page.bytes.byteLength, sha256: sha256(Buffer.from(page.bytes)), offset: page.offset }
  } catch (error) {
    return { refused: true, code: error?.code ?? null, name: error?.name ?? null, message: error?.message ?? null }
  }
}

const out = {
  probe: 'c3-shared-index',
  label,
  measuredAt: new Date().toISOString(),
  identity: {
    srcArtifactsTs: fileDigest(`${PKG}/src/artifacts.ts`),
    libArtifactsJs: fileDigest(`${PKG}/lib/artifacts.js`),
  },
  arms: {},
}

const root = tempRoot('stim')
const payloadA = Buffer.from('SHARED-INDEX-ARM-A-' + 'a'.repeat(400), 'utf8')
writeFileSync(join(root, 'a.bin'), payloadA)
const fs = mountFs(root)

const base = tempRoot('base')
const indexRoot = join(base, 'artifacts')
const homeA = join(base, 'home-a')
const homeB = join(base, 'home-b')

const storeA = storeAt(indexRoot, homeA)
const logA = new InMemorySessionReferenceLog()
const grantsA = new GrantTable()
const scopeA = 'project:c3-shared'
grantsA.bump(scopeA)

const captureA = await captureFile({
  fs, path: 'a.bin', store: storeA, log: logA, grants: grantsA,
  ownerScope: scopeA, executionWorld: 'local',
  observationId: 'obs-c3-shared-a', mediaType: 'application/octet-stream',
})
out.arms.capture = {
  sha256: captureA.descriptor.captured.sha256,
  bytes: captureA.descriptor.captured.bytes,
  realmOfA: await storeA.ensureRealm(),
}

const first = await pages(storeA, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: grantsA, callerScope: scopeA,
})
out.arms.firstPageFromA = {
  bytes: first.bytes.byteLength,
  offset: first.offset,
  sha256: sha256(Buffer.from(first.bytes)),
  isTheArtifact: Buffer.from(first.bytes).equals(payloadA.subarray(0, 64)),
  hasCursor: first.nextCursor !== undefined,
}

// THE SECOND STORE: same index root, DIFFERENT byte home. Its own provider home
// holds no object at all, so if it serves anything it served it from a place the
// cursor was not issued for -- or it served nothing, which is the refusal.
const storeB = storeAt(indexRoot, homeB)
out.arms.storeB = {
  realmOfB: await storeB.ensureRealm(),
  sameRealmAsA: (await storeB.ensureRealm()) === (await storeA.ensureRealm()),
  sameKeyAsA: (await storeB.cursorKey()) === (await storeA.cursorKey()),
  sameIndexRoot: storeB.root === storeA.root,
}

// THE ARM: A's cursor presented to B, same descriptor, same scope.
const armB = await attempt(storeB, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: grantsA, callerScope: scopeA,
  cursor: first.nextCursor,
})
out.arms.cursorFromAOnB = {
  ...armB,
  yieldedIsTheNamedArtifact: armB.refused ? null : armB.sha256 === captureA.descriptor.captured.sha256,
}

// THE CONTROL: the same cursor on its OWN store must still serve.
out.arms.controlOwnStore = await attempt(storeA, {
  descriptor: captureA.descriptor, maxBytes: 64, grants: grantsA, callerScope: scopeA,
  cursor: first.nextCursor,
})

// A SECOND STIMULUS: make home B hold DIFFERENT bytes under the same attachment
// id, so a served page can be checked against the descriptor rather than merely
// counted. The provider addresses by `sha256:<digest>`, so this is the only way to
// put a wrong object at the right address.
{
  const { mkdirSync, writeFileSync: wf } = await import('node:fs')
  const bHomeObjects = join(homeB, 'attachments')
  mkdirSync(bHomeObjects, { recursive: true })
  // Enumerate what the provider wrote for A, so B is given the SAME leaf name.
  const { readdirSync, statSync } = await import('node:fs')
  const aHome = join(homeA, 'attachments')
  const walk = dir => {
    const found = []
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) found.push(...walk(path))
      else found.push(path)
    }
    return found
  }
  let aFiles = []
  try { aFiles = walk(aHome) } catch { aFiles = [] }
  out.arms.byteHomes = { aFiles: aFiles.map(p => p.slice(homeA.length).replace(/\\/g, '/')) }
  for (const aFile of aFiles) {
    const relative = aFile.slice(aHome.length)
    const bFile = join(bHomeObjects, relative)
    mkdirSync(dirname(bFile), { recursive: true })
    wf(bFile, Buffer.alloc(payloadA.length, 0x5a))
  }
  out.arms.storeBHoldDifferentBytesUnderSameAddress = true
  const armB2 = await attempt(storeB, {
    descriptor: captureA.descriptor, maxBytes: 64, grants: grantsA, callerScope: scopeA,
    cursor: first.nextCursor,
  })
  out.arms.cursorFromAOnBWrongBytes = {
    ...armB2,
    yieldedIsTheNamedArtifact: armB2.refused ? null : armB2.sha256 === captureA.descriptor.captured.sha256,
  }
}

out.verdicts = {
  controlOwnStoreServes: out.arms.controlOwnStore.refused === false,
  sharedRealmAcrossHomes: out.arms.storeB.sameRealmAsA === true,
  sharedKeyAcrossHomes: out.arms.storeB.sameKeyAsA === true,
  cursorServedByStoreItWasNotIssuedFor: out.arms.cursorFromAOnB.refused === false,
  crossHomeYieldedWrongBytes: out.arms.cursorFromAOnBWrongBytes?.refused === false
    && out.arms.cursorFromAOnBWrongBytes?.yieldedIsTheNamedArtifact === false,
  ORACLE_HOLDS: out.arms.cursorFromAOnB.refused === true
    && out.arms.controlOwnStore.refused === false,
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
writeFileSync(join(HERE, `shared-index-${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(out, null, 2))
