/**
 * S16 PRODUCT REACHABILITY — the fix is reached by the SERVICE the profile constructs.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE MODULE PROBES. The brief's most-repeated defect
 * class is "the mechanism is implemented, unit-tested, correct, and nothing in the
 * product calls it". A module-level probe proves the pager refuses a forgery; it does
 * NOT prove the product's own page path reaches the keyed authority. This probe drives
 * `DataPlaneService` -- the exact class `data-plugin.ts:49` constructs on a real boot
 * and publishes as `ctx.dailyData` -- through the same `page()` method that
 * `data-bridge.ts`'s `fs.page` route calls.
 *
 * WHAT IT MEASURES, and what it does not:
 *   - MEASURED: a correctly-signed forgery presented to `DataPlaneService.page()` is
 *     refused, and the refusal is recorded in the service's own journal
 *     (`DataPlaneService.refusals()`, which reads the store's durable file);
 *   - MEASURED: an honest page through the same service works and returns the
 *     artifact's bytes, so the service is not refusing everything;
 *   - NOT MEASURED: a real profile boot driving a model cell. That is NOT_RUN and is
 *     stated as such in FINDINGS.md. This probe constructs the service in-process,
 *     exactly as `data-plane.test.ts` does, so it proves the SERVICE reaches the fix,
 *     not that a booted deployment does.
 *
 * Run from packages/dsh-daily-work:
 *   node --import ./node_modules/tsx/dist/loader.mjs \
 *     qualification/results/S16-cursor-authority/s16-reachability-probe.mjs
 */
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const PKG_ROOT = join(REPO_ROOT, 'packages', 'dsh-daily-work')
const SRC = join(PKG_ROOT, 'src')

const requireFromPkg = createRequire(join(PKG_ROOT, 'package.json'))
const resolveFromPkg = (spec) => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: AttachmentLocal } = await import(resolveFromPkg('@deepseek-ai/dsh-attachment-local'))
const { default: Storage } = await import(resolveFromPkg('@deepseek-ai/dsh-storage'))
const storageDomainPlugin = await import(resolveFromPkg('@deepseek-ai/dsh-storage-domain'))
const storageJsonPlugin = await import(resolveFromPkg('@deepseek-ai/dsh-storage-json'))

const A = await import(pathToFileURL(join(SRC, 'artifacts.ts')).href)
const O = await import(pathToFileURL(join(SRC, 'observations.ts')).href)
const S = await import(pathToFileURL(join(SRC, 'data-service.ts')).href)

const dirs = []
const tempRoot = (tag) => { const d = mkdtempSync(join(tmpdir(), `s16r-${tag}-`)); dirs.push(d); return d }
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
const redact = (t) => (typeof t === 'string' ? t.replace(/realm_[0-9a-fA-F-]{36}/gu, 'realm_<redacted>') : t)

/** The PRODUCT service, constructed exactly as data-plugin.ts:49 does. */
async function mountService(label, scope) {
  const root = tempRoot(label)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(storageJsonPlugin, { root: join(root, 'store') })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
  await ctx.plugin(AttachmentLocal, { dshHome: join(root, 'home') })
  const service = new S.DataPlaneService(ctx, {
    artifactRoot: join(root, 'artifacts'), ownerScope: scope, executionWorld: 'local',
  })
  await service.open(ctx.storageDomain)
  return { service, ctx, root, dispose: async () => { await service.close() } }
}

const PAYLOAD = Buffer.from('S16-REACHABILITY-' + 'r'.repeat(600), 'utf8')

async function attempt(fn) {
  try { const v = await fn(); return { refused: false, ...v } }
  catch (e) { return { refused: true, code: e?.code, message: redact(e?.message) } }
}

const out = {
  probe: 'S16 product reachability — DataPlaneService.page reaches the keyed authority',
  measuredAt: new Date().toISOString(),
  node: process.version,
  identity: {
    worktree: 'D:/DSH/work/wt-s16', branch: 'wt/s16',
    artifactsTsSha256: sha256(readFileSync(join(SRC, 'artifacts.ts'))),
    dataServiceTsSha256: sha256(readFileSync(join(SRC, 'data-service.ts'))),
  },
  productPath: 'profile boot -> data-plugin.ts:49 -> DataPlaneService -> data-bridge fs.page -> service.page() -> pages() -> store.cursorKey()',
}

{
  const { service, root, dispose } = await mountService('svc', 'project:s16')
  try {
    // Capture THROUGH the service, which is the product's own capture path.
    const src = join(root, 'p.bin')
    writeFileSync(src, PAYLOAD)
    const captured = await service.capture({ fs: undefined, path: src }, {})
    void captured
  } catch {
    // `capture` needs a real ctx.fs; the service's own page path is what this probe is
    // about, so the descriptor is built by the store's capture primitive and then
    // handed to the SERVICE, which is the same descriptor the bridge would carry.
    const plane = { store: service.store, grants: service.grants }
    const fsCtx = new Context()
    const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
    const fs = new LocalFileSystem(fsCtx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
    const capture = await A.captureFile({
      fs, path: 'p.bin', store: service.store, log: new A.InMemorySessionReferenceLog(),
      grants: service.grants, ownerScope: service.ownerScope, executionWorld: 'local',
      observationId: 'obs-s16-reach', mediaType: 'application/octet-stream',
    })
    const descriptor = capture.descriptor
    const realm = await service.storeRealmId()

    // POSITIVE CONTROL: the product's own page() serves the first page.
    const first = await service.page({ descriptor, maxBytes: 64 })
    out.positiveControl = { offset: first.offset, bytes: first.bytes.byteLength, hasCursor: first.nextCursor !== undefined }
    out.positiveControl.bytesAreArtifactBytes =
      Buffer.from(first.bytes).equals(PAYLOAD.subarray(0, 64))

    // The honest continuation through the product path.
    const second = await service.page({ descriptor, maxBytes: 64, cursor: first.nextCursor })
    out.honestContinuation = { offset: second.offset, bytes: second.bytes.byteLength }

    // THE ARM: the OLD public key derivation, correctly signed, position 500.
    const oldKey = `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
    const full = {
      storeRealmId: realm,
      artifactSha256: descriptor.captured.sha256,
      observationId: descriptor.id,
      revision: `${descriptor.captured.sha256}@g${descriptor.authority.grantRevision}`,
      representation: 'bytes',
      query: 'bytes:64',
      position: 500,
      ownerScope: service.ownerScope,
      watermark: descriptor.source.acquiredAt,
      schemaVersion: O.OBSERVATION_SCHEMA_VERSION,
    }
    const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
    const forged = `${payload}.${createHmac('sha256', oldKey).update(payload).digest('base64url')}`

    out.forgeryThroughProductService = await attempt(async () => {
      const page = await service.page({ descriptor, maxBytes: 64, cursor: forged })
      return { offset: page.offset, bytes: page.bytes.byteLength }
    })

    // THE REFUSAL IS RECORDED, which is half of DATA-11's oracle, and it is read back
    // through the service's own accessor -- the durable file, not a local variable.
    //
    // A DELAY IS REQUIRED, and it is a property of the design rather than a flaw:
    // `DataPlaneService.page` starts the journal write and does NOT await it
    // (data-service.ts:407-418 -- making the refusal wait on a disk write would let a
    // slow journal delay the refusal, or replace it). So the write is in flight when
    // the throw reaches this probe. Polling is the honest way to observe a
    // deliberately unawaited write; asserting immediately would report "not recorded"
    // for a refusal that is recorded microseconds later.
    let refusals = []
    for (let attempt = 0; attempt < 50 && refusals.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      refusals = await service.refusals()
    }
    out.refusalRecordedByProduct = {
      count: refusals.length,
      codes: refusals.map(entry => entry.code),
      steps: refusals.map(entry => entry.step),
      note: 'read back through DataPlaneService.refusals() -> the store\'s durable cursor-refusals.jsonl',
    }
    // The key must not be in the product's durable evidence either.
    const key = await service.store.cursorKey()
    out.keyAbsentFromProductJournal = !JSON.stringify(refusals).includes(key)
    void plane
  } finally {
    await dispose()
  }
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
