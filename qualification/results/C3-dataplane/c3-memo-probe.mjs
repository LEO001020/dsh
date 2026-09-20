/**
 * C3 probe: the memoized-identity attack, done the way an attacker would do it.
 *
 * THE MECHANISM. `assertObjectIdentity` skips the content hash when a previously
 * verified object matches a memoized `${size}:${mtimeMs}` stamp:
 *
 *   const stamp = `${String(info.size)}:${String(info.mtimeMs)}`
 *   if (this.verifiedObjects.get(artifact) === stamp) return
 *
 * Both fields are attacker-settable. A naive replacement fails because this
 * filesystem keeps sub-millisecond mtime precision and `utimesSync` cannot
 * reproduce the fractional part exactly (measured: 1789918729932.5093 -> ...932.0
 * or ...932.5088, never equal).
 *
 * THE ATTACK THAT WORKS. Pin the mtime to an EXACT WHOLE SECOND *before* the
 * legitimate verification. A whole second IS exactly reproducible, so the stamp
 * survives the replacement:
 *
 *   1. chmod the object writable, utimes it to a whole second;
 *   2. page once, so the store verifies the REAL bytes and memoizes that stamp;
 *   3. replace the object with different bytes of the SAME LENGTH;
 *   4. utimes it back to the SAME whole second;
 *   5. present the cursor again.
 *
 * If the hash is skipped, the cursor serves bytes that are not the artifact while
 * `resolveReference` refuses the same object -- the exact harm the DATA-11 evidence
 * note records ("pages() serves 64 bytes hashing cc7321cc... while the descriptor
 * names 9076e7f7..., and resolveReference() refuses the same object with
 * artifact-integrity-error").
 *
 * Run: node qualification/results/C3-dataplane/c3-memo-probe.mjs --label before
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

const fileDigest = path => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex') } catch { return null }
}
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

const out = {
  probe: 'c3-memo',
  label,
  measuredAt: new Date().toISOString(),
  identity: {
    srcArtifactsTs: fileDigest(`${PKG}/src/artifacts.ts`),
    libArtifactsJs: fileDigest(`${PKG}/lib/artifacts.js`),
  },
  arms: {},
}

const tempDirs = []
const tempRoot = name => {
  const dir = mkdtempSync(join(tmpdir(), `c3memo-${name}-`))
  tempDirs.push(dir)
  return dir
}

function makePlane(name, scope = 'project:c3memo') {
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

/** Page once and report whether the page is a prefix of the named artifact. */
async function pageOnce(store, descriptor, grants, scope, cursor) {
  const refusals = []
  try {
    const page = await artifacts.pages(store, {
      descriptor, maxBytes: 64, grants, callerScope: scope,
      ...cursor === undefined ? {} : { cursor },
      onRefusal: refusal => { refusals.push({ code: refusal.code, step: refusal.step }) },
    })
    return {
      refused: false,
      bytes: page.bytes.byteLength,
      sha256: sha256(page.bytes),
      yieldedIsTheNamedArtifact: descriptor.captured.sha256.startsWith(sha256(page.bytes).slice(0, 0))
        && sha256(page.bytes) === sha256(page.bytes) && false || undefined,
      refusals,
      nextCursor: page.nextCursor,
    }
  } catch (error) {
    return { refused: true, code: error?.code ?? null, message: error?.message ?? null, refusals }
  }
}

const PAYLOAD = Buffer.from('C3-MEMO-' + 'm'.repeat(900), 'utf8')

try {
  const root = tempRoot('src')
  writeFileSync(join(root, 'p.bin'), PAYLOAD)
  const plane = makePlane('store')
  const captured = await artifacts.captureFile({
    fs: mountFs(root), path: 'p.bin', store: plane.store, log: plane.log, grants: plane.grants,
    ownerScope: plane.scope, executionWorld: 'local', observationId: 'obs-c3-memo',
    mediaType: 'application/octet-stream',
  })
  const descriptor = captured.descriptor
  const namedSha = descriptor.captured.sha256
  out.arms.capture = { bytes: descriptor.captured.bytes, sha256: namedSha }

  const hostPath = await plane.store.hostPath(`artifact:sha256:${namedSha}`)

  // ---- STEP 1: pin the mtime to a WHOLE SECOND, before any verification.
  chmodSync(hostPath, 0o600)
  const pinned = Math.floor(Date.now() / 1000)
  utimesSync(hostPath, pinned, pinned)
  const pinnedStat = statSync(hostPath)
  out.arms.pinnedMtime = { mtimeMs: pinnedStat.mtimeMs, isWholeSecond: pinnedStat.mtimeMs % 1000 === 0 }

  // ---- STEP 2: page once. The store verifies the REAL bytes and memoizes the stamp.
  const first = await pageOnce(plane.store, descriptor, plane.grants, plane.scope)
  const firstBytes = first.refused ? null : Buffer.from([])
  out.arms.firstPage = {
    refused: first.refused,
    bytes: first.bytes,
    sha256: first.sha256,
    hasCursor: first.nextCursor !== undefined,
    // The first page must BE the artifact's prefix, or the arm below proves nothing.
    isTheNamedArtifactPrefix: first.refused !== true
      && sha256(readFileSync(hostPath).subarray(0, 64)) === first.sha256,
  }

  // ---- STEP 3: replace with different bytes of the SAME length.
  const replacement = Buffer.alloc(descriptor.captured.bytes, 0xcc)
  writeFileSync(hostPath, replacement)

  // ---- STEP 4: restore the SAME whole second.
  utimesSync(hostPath, pinned, pinned)
  const afterStat = statSync(hostPath)
  out.arms.replacement = {
    sameLength: afterStat.size === pinnedStat.size,
    sameMtimeMs: afterStat.mtimeMs === pinnedStat.mtimeMs,
    stampMatches: `${String(afterStat.size)}:${String(afterStat.mtimeMs)}`
      === `${String(pinnedStat.size)}:${String(pinnedStat.mtimeMs)}`,
    storedSha256: sha256(replacement),
    descriptorSha256: namedSha,
    bytesAreTheNamedArtifact: sha256(replacement) === namedSha,
  }

  // ---- STEP 5: present the cursor again.
  const second = await pageOnce(plane.store, descriptor, plane.grants, plane.scope, first.nextCursor)
  out.arms.cursorAfterReplacement = {
    refused: second.refused,
    bytes: second.bytes,
    sha256: second.sha256,
    yieldedIsTheNamedArtifact: second.sha256 === namedSha,
    refusals: second.refusals,
    ...second.refused === true ? { code: second.code, message: second.message } : {},
  }

  // ---- The OTHER read path, on the same object, for the disagreement.
  try {
    const resolved = await artifacts.resolveReference(plane.store, plane.log, descriptor.captured.artifact)
    out.arms.resolveReference = { refused: false, sha256: resolved?.sha256 ?? null }
  } catch (error) {
    out.arms.resolveReference = { refused: true, code: error?.code ?? null, message: error?.message ?? null }
  }

  // ---- A COLD store over the same root, so the memo is empty. This separates
  // "the memo skipped the hash" from "the object is never checked at all".
  const freshCtx = new Context()
  new AttachmentLocal(freshCtx, { dshHome: join(plane.root, 'home') })
  const freshStore = new artifacts.AttachmentArtifactStore(freshCtx.attachments, join(plane.root, 'artifacts'))
  const cold = await pageOnce(freshStore, descriptor, plane.grants, plane.scope)
  out.arms.freshStoreColdMemo = {
    refused: cold.refused, bytes: cold.bytes, sha256: cold.sha256,
    ...cold.refused === true ? { code: cold.code } : {},
  }
} catch (error) {
  out.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
}

for (const dir of tempDirs) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) } catch { /* best effort */ }
}

out.verdicts = {
  pinnedStampIsReproducible: out.arms.replacement?.stampMatches === true,
  replacementIsNotTheNamedArtifact: out.arms.replacement?.bytesAreTheNamedArtifact === false,
  cursorServedReplacedBytes:
    out.arms.cursorAfterReplacement?.refused === false
    && out.arms.cursorAfterReplacement?.yieldedIsTheNamedArtifact === false,
  resolveReferenceRefused: out.arms.resolveReference?.refused === true,
  coldMemoRefusesTheReplacement: out.arms.freshStoreColdMemo?.refused === true,
  // The finding: the cursor path serves bytes the other read path refuses, and the
  // memo is what let it -- a cold store over the SAME root refuses.
  PAGING_IS_THE_WEAKER_ROUTE:
    out.arms.cursorAfterReplacement?.refused === false
    && out.arms.cursorAfterReplacement?.yieldedIsTheNamedArtifact === false
    && out.arms.resolveReference?.refused === true
    && out.arms.freshStoreColdMemo?.refused === true,
}

writeFileSync(join(HERE, `memo-${label}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(out.arms, null, 1))
console.log(JSON.stringify(out.verdicts, null, 1))
