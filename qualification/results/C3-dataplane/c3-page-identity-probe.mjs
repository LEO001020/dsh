/**
 * C3 probe 2: does the paging path serve bytes that are NOT the named artifact
 * once the identity check has been memoized?
 *
 * THE CANDIDATE HOLE. `pages()` verifies the object through
 * `store.assertObjectIdentity(...)`, which hashes the object on FIRST TOUCH and
 * then remembers a `size:mtime` stamp (`artifacts.ts`, `verifiedObjects`). A later
 * call with the same stamp returns early. `openRange`'s own content check only
 * fires when the window IS the whole object (`offset === 0 && length >= bytes`),
 * which a 64-byte page of a 326-byte object is not.
 *
 * So the question the oracle actually asks -- "can a cursor yield pages that are
 * not the artifact the descriptor names?" -- has a shape nobody has measured: a
 * BENIGN first page (which populates the memo), then an in-place replacement that
 * preserves both the length and the mtime, then the cursor. If that yields bytes,
 * then the identity check on the paging path is memoized away and the page route
 * is the weaker route to the same bytes -- the same defect class DATA-11 filed,
 * one step later in the walk.
 *
 * It also measures the CROSS-STORE arm the oracle names first, on this tree, so
 * the two are reported together and a green cross-store result cannot be read as
 * "the paging path verifies what it serves".
 *
 * Run: node qualification/results/C3-dataplane/c3-page-identity-probe.mjs --label before
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

const { AttachmentArtifactStore, InMemorySessionReferenceLog, captureFile, pages, resolveReference } = artifacts
const { GrantTable } = observations

const tempDirs = []
function tempRoot(tag) {
  const dir = mkdtempSync(join(tmpdir(), `c3p-${tag}-`))
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
const fileDigest = path => {
  try { return sha256(readFileSync(path)) } catch { return null }
}

async function objectPath(store, digest) {
  const entry = await store.stat(`artifact:sha256:${digest}`)
  if (entry === undefined) throw new Error(`no index entry for ${digest}`)
  const host = store.provider.fileHostPath({ attachmentId: `sha256:${digest}`, name: 'artifact', bytes: entry.bytes })
  if (host === undefined) throw new Error('the provider is not host-file-backed')
  return host
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
  probe: 'c3-page-identity',
  label,
  measuredAt: new Date().toISOString(),
  identity: {
    srcArtifactsTs: fileDigest(`${PKG}/src/artifacts.ts`),
    libArtifactsJs: fileDigest(`${PKG}/lib/artifacts.js`),
  },
  arms: {},
}

const root = tempRoot('stim')
// Long enough for several pages, so a cursor exists after page 1.
const payload = Buffer.from('PAGE-IDENTITY-PROBE-' + 'q'.repeat(900), 'utf8')
writeFileSync(join(root, 'p.bin'), payload)
const fs = mountFs(root)

// ---- Arm 1: the benign walk, so the memo is populated by a REAL first page.
const plane = makePlane('memo')
const capture = await captureFile({
  fs, path: 'p.bin', store: plane.store, log: plane.log, grants: plane.grants,
  ownerScope: plane.scope, executionWorld: 'local',
  observationId: 'obs-c3-page-identity', mediaType: 'application/octet-stream',
})
const objectPathOnDisk = await objectPath(plane.store, capture.descriptor.captured.sha256)
const beforeStat = statSync(objectPathOnDisk)

const first = await pages(plane.store, {
  descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
})
out.arms.benignFirstPage = {
  bytes: first.bytes.byteLength,
  offset: first.offset,
  sha256: sha256(Buffer.from(first.bytes)),
  isTheNamedArtifactPrefix: Buffer.from(first.bytes).equals(payload.subarray(0, 64)),
  hasCursor: first.nextCursor !== undefined,
}

// ---- Arm 2: replace the object in place, preserving BOTH length and mtime.
//
// This is the stimulus the memo is vulnerable to. `assertObjectIdentity` memoizes
// on `size:mtimeMs`, and both are attacker-settable, so a replacement that
// restores them is indistinguishable from the verified object by the memo.
const replacement = Buffer.alloc(payload.length, 0x5a)
chmodSync(objectPathOnDisk, 0o600)
writeFileSync(objectPathOnDisk, replacement)
// `utimesSync` takes SECONDS and accepts a float, while `stat().mtimeMs` can carry
// a fractional part. Passing a `Date` truncates to whole milliseconds, which is
// enough to make the stamp differ and the arm measure nothing -- measured: the
// first attempt restored `mtimeMs` to a different value and `assertObjectIdentity`
// re-hashed, so the cursor was refused for the wrong reason.
utimesSync(objectPathOnDisk, beforeStat.atimeMs / 1000, beforeStat.mtimeMs / 1000)
const afterStat = statSync(objectPathOnDisk)
out.arms.replacement = {
  sameLength: afterStat.size === beforeStat.size,
  sameMtimeMs: afterStat.mtimeMs === beforeStat.mtimeMs,
  storedSha256: fileDigest(objectPathOnDisk),
  descriptorSha256: capture.descriptor.captured.sha256,
  bytesAreTheNamedArtifact: fileDigest(objectPathOnDisk) === capture.descriptor.captured.sha256,
}

// ---- Arm 3: the cursor. Does the paging path serve the replaced bytes?
const second = await attempt(plane.store, {
  descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
  cursor: first.nextCursor,
})
out.arms.cursorAfterReplacement = {
  ...second,
  yieldedIsTheNamedArtifact: second.refused ? null : second.sha256 === capture.descriptor.captured.sha256,
}

// ---- Arm 4: the SAME object through `resolveReference`, which hashes what it read.
let resolveArm
try {
  const resolved = await resolveReference(plane.store, plane.log, 'obs-c3-page-identity')
  resolveArm = { refused: false, sha256: sha256(Buffer.from(resolved.bytes)) }
} catch (error) {
  resolveArm = { refused: true, code: error?.code ?? null, message: error?.message ?? null }
}
out.arms.resolveReferenceOnSameObject = resolveArm
out.arms.pagingAndResolveDisagree = (second.refused === false) !== (resolveArm.refused === false)

// ---- Arm 5: a FRESH store object over the same root, so no memo exists.
//     If this refuses while arm 3 served, the memo is the whole difference.
{
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: plane.home ?? join(tempRoot('fresh-home'), 'home') })
  const fresh = new AttachmentArtifactStore(ctx.attachments, join(root, 'artifacts-fresh'))
  void fresh
}
const ctx2 = new Context()
const freshHome = tempRoot('fresh-home')
new AttachmentLocal(ctx2, { dshHome: join(freshHome, 'home') })
const reopened = new AttachmentArtifactStore(ctx2.attachments, plane.store.root)
out.arms.freshStoreSameRootCursor = await attempt(reopened, {
  descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
  cursor: first.nextCursor,
})

out.verdicts = {
  firstPageWasTheArtifact: out.arms.benignFirstPage.isTheNamedArtifactPrefix === true,
  replacementPreservedLengthAndMtime: out.arms.replacement.sameLength === true
    && out.arms.replacement.sameMtimeMs === true,
  replacementIsNotTheNamedArtifact: out.arms.replacement.bytesAreTheNamedArtifact === false,
  cursorServedReplacedBytes: out.arms.cursorAfterReplacement.refused === false
    && out.arms.cursorAfterReplacement.yieldedIsTheNamedArtifact === false,
  resolveReferenceRefused: out.arms.resolveReferenceOnSameObject.refused === true,
  freshStoreRefused: out.arms.freshStoreSameRootCursor.refused === true,
  PAGE_IDENTITY_HOLDS: out.arms.cursorAfterReplacement.refused === true
    || out.arms.cursorAfterReplacement.yieldedIsTheNamedArtifact === true,
}

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
writeFileSync(join(HERE, `page-identity-${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(out, null, 2))
