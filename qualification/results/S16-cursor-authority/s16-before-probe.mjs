/**
 * S16 BEFORE PROBE — D-1 and D-2 reproduced from scratch, on this worktree.
 *
 * WHAT THIS MEASURES. The claim under test is that a page cursor is unforgeable by
 * a caller who holds the descriptor. `cursorSecretOf` (artifacts.ts:1905) is
 * `id:sha256:ownerScope:grantRevision` -- four DESCRIPTOR fields -- and the
 * descriptor is returned to the caller by `data:fs.capture`, so the "host secret"
 * is a deterministic function of data the caller already has.
 *
 * The three attacks below are all CORRECTLY SIGNED. That is the whole point: the
 * existing DATA-11 arms tamper with the token and therefore trip the MAC, which
 * proves the MAC is computed and not that it protects anything. A forgery with a
 * valid MAC is the only stimulus that can distinguish those two.
 *
 * THE CANONICAL FORM IS THE TRAP. `CursorAuthority.mint` signs
 * `JSON.stringify(full)` where `full = { ...cursor, schemaVersion }` -- i.e. the
 * INTERFACE FIELD ORDER with `schemaVersion` appended last, NOT a sorted key/value
 * list. A sorted form is refused (`pagination-cursor-invalid`) and a refusal from a
 * malformed token proves nothing about the key. The field order used below is
 * copied from the `PageCursor` interface (artifacts.ts:1388-1409) plus the
 * `schemaVersion` append in `mint`.
 *
 * NOTHING HERE PRINTS A STORE IDENTITY OR A SECRET. Realm ids are redacted to a
 * digest prefix plus a length (the realm is disclosed by the refusal path by
 * design, but a probe has no reason to echo it, and any key material introduced by
 * the fix must never reach this output). The probe reports only booleans, codes,
 * offsets, and digests of the tokens it mints.
 *
 * Run from packages/dsh-daily-work:
 *   node --import ./node_modules/tsx/dist/loader.mjs \
 *     qualification/results/S16-cursor-authority/s16-before-probe.mjs
 */
import { createHash, createHmac } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))

const A = await import(pathToFileURL(join(SRC, 'artifacts.ts')).href)
const O = await import(pathToFileURL(join(SRC, 'observations.ts')).href)

const dirs = []
const tempRoot = (tag) => { const d = mkdtempSync(join(tmpdir(), `s16-${tag}-`)); dirs.push(d); return d }
const mountFs = (cwd) => { const ctx = new Context(); return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 }) }

function plane(tag, scope = 'project:s16') {
  const root = tempRoot(tag); const home = join(root, 'home'); const indexRoot = join(root, 'artifacts')
  const ctx = new Context(); new AttachmentLocal(ctx, { dshHome: home })
  const store = new A.AttachmentArtifactStore(ctx.attachments, indexRoot)
  const log = new A.InMemorySessionReferenceLog(); const grants = new O.GrantTable(); grants.bump(scope)
  return { store, log, grants, scope, ctx, home, indexRoot, root }
}

const PAYLOAD = Buffer.from('S16-CURSOR-AUTHORITY-' + 'w'.repeat(600), 'utf8')
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/**
 * Redact a store identity for the record.
 *
 * The realm is DISCLOSED by the refusal path by design (that is D-2's amplifier),
 * but a probe that echoes it puts a store identity into a committed artifact for
 * no reason. A digest prefix plus a length is enough to tell two realms apart in
 * the evidence, which is all a reader needs.
 */
const redactRealm = (value) => (typeof value === 'string' && value.length > 0
  ? `sha256:${sha256(value).slice(0, 12)}…(len ${value.length})`
  : value)

/** Redact every `realm_…` token that a message or error may carry. */
const redactText = (text) => (typeof text === 'string'
  ? text.replace(/realm_[0-9a-fA-F-]{36}/gu, match => redactRealm(match))
  : text)

/**
 * The MAC key, re-derived by an ATTACKER from the descriptor alone.
 *
 * This is `cursorSecretOf` (artifacts.ts:1905) copied from the source. It reads
 * four fields of an object the caller already holds.
 */
const attackerSecret = (d) =>
  `${d.id}:${d.captured.sha256}:${d.authority.ownerScope}:${d.authority.grantRevision}`

/**
 * Mint a cursor with the REAL algorithm and the REAL canonical serialization.
 *
 * `schemaVersion` is appended LAST, exactly as `mint` does with
 * `{ ...cursor, schemaVersion }`. Key order is the interface's, not sorted.
 */
function mintForged(cursor, descriptor, schemaVersion) {
  const full = { ...cursor, schemaVersion }
  const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${payload}.${createHmac('sha256', attackerSecret(descriptor)).update(payload).digest('base64url')}`
}

/** The exact field order the host signs, so a probe can prove it matched. */
const HOST_FIELD_ORDER = [
  'storeRealmId', 'artifactSha256', 'observationId', 'revision', 'representation',
  'query', 'position', 'ownerScope', 'watermark', 'schemaVersion',
]

/** A sorted-key forgery, kept as the control that a malformed token proves nothing. */
function mintForgedSorted(cursor, descriptor, schemaVersion) {
  const full = { ...cursor, schemaVersion }
  const sorted = {}
  for (const key of Object.keys(full).sort()) sorted[key] = full[key]
  const payload = Buffer.from(JSON.stringify(sorted), 'utf8').toString('base64url')
  return `${payload}.${createHmac('sha256', attackerSecret(descriptor)).update(payload).digest('base64url')}`
}

async function attempt(fn) {
  try { const v = await fn(); return { refused: false, ...v } }
  catch (e) {
    return {
      refused: true,
      code: e?.code,
      name: e?.name,
      message: redactText(e?.message),
      // Whether the refusal named BOTH realms. D-2's amplifier: a caller that does
      // not know the target realm can read it out of the refusal. Asserted as a
      // BOOLEAN so the values themselves never reach this output.
      messageNamesBothRealms: typeof e?.message === 'string' && /store realm/u.test(e.message),
    }
  }
}

async function captureInto(root, p, observationId) {
  return await A.captureFile({
    fs: mountFs(root), path: 'p.bin', store: p.store, log: p.log, grants: p.grants,
    ownerScope: p.scope, executionWorld: 'local', observationId, mediaType: 'application/octet-stream',
  })
}

const out = {
  probe: 'S16 D-1/D-2 BEFORE — correctly-signed cursor forgeries against the accepted DATA-11 fix',
  measuredAt: new Date().toISOString(),
  node: process.version,
  identity: {
    worktree: 'D:/DSH/work/wt-s16', branch: 'wt/s16',
    artifactsTsSha256: sha256(readFileSync(join(SRC, 'artifacts.ts'))),
    observationsTsSha256: sha256(readFileSync(join(SRC, 'observations.ts'))),
  },
  attacks: {},
}

// ---------------------------------------------------------------------------
// The shape of what the host mints: field order, and the legitimate walk.
// ---------------------------------------------------------------------------
{
  const r = tempRoot('shape'); writeFileSync(join(r, 'p.bin'), PAYLOAD)
  const p = plane('shape-store')
  const c = await captureInto(r, p, 'obs-shape')
  const first = await A.pages(p.store, { descriptor: c.descriptor, maxBytes: 64, grants: p.grants, callerScope: p.scope })
  const token = first.nextCursor
  const payload = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8'))
  out.hostCursor = {
    fieldOrder: Object.keys(payload),
    matchesInterfaceOrderWithSchemaVersionLast:
      JSON.stringify(Object.keys(payload)) === JSON.stringify(HOST_FIELD_ORDER),
    positionMinted: payload.position,
    schemaVersion: payload.schemaVersion,
    tokenSha256: sha256(Buffer.from(token, 'utf8')),
  }
  // POSITIVE CONTROL: the honest walk continues. Without this, a pager that refused
  // everything would satisfy every refusal assertion below.
  const second = await A.pages(p.store, {
    descriptor: c.descriptor, maxBytes: 64, grants: p.grants, callerScope: p.scope, cursor: token,
  })
  out.hostCursor.honestContinuation = { offset: second.offset, bytes: second.bytes.byteLength }
}

// ---------------------------------------------------------------------------
// ATTACK 1 — a correctly signed cursor naming a position the host never minted.
// ---------------------------------------------------------------------------
{
  const r = tempRoot('a1'); writeFileSync(join(r, 'p.bin'), PAYLOAD)
  const p = plane('a1-store')
  const c = await captureInto(r, p, 'obs-a1')
  const D = c.descriptor
  const first = await A.pages(p.store, { descriptor: D, maxBytes: 64, grants: p.grants, callerScope: p.scope })
  const base = {
    storeRealmId: await p.store.ensureRealm(),
    artifactSha256: D.captured.sha256,
    observationId: D.id,
    revision: `${D.captured.sha256}@g${D.authority.grantRevision}`,
    representation: 'bytes',
    query: 'bytes:64',
    position: 500,
    ownerScope: p.scope,
    watermark: D.source.acquiredAt,
  }
  // THE CONTROL that costs a wasted attempt if skipped: a sorted-key token with the
  // SAME key material is refused, and that refusal proves NOTHING about the key.
  out.attacks.sortedKeyControl = await attempt(async () => {
    const page = await A.pages(p.store, {
      descriptor: D, maxBytes: 64, grants: p.grants, callerScope: p.scope,
      cursor: mintForgedSorted(base, D, O.OBSERVATION_SCHEMA_VERSION),
    })
    return { offset: page.offset }
  })
  out.attacks.positionForgery = await attempt(async () => {
    const page = await A.pages(p.store, {
      descriptor: D, maxBytes: 64, grants: p.grants, callerScope: p.scope,
      cursor: mintForged(base, D, O.OBSERVATION_SCHEMA_VERSION),
    })
    return {
      offset: page.offset,
      bytes: page.bytes.byteLength,
      bytesMatchChosenOffset:
        Buffer.from(page.bytes).equals(PAYLOAD.subarray(500, 500 + page.bytes.byteLength)),
    }
  })
  out.attacks.positionForgery.hostMintedPosition = first.offset === 0 ? 64 : first.offset + 64
  out.attacks.positionForgery.callerChosePosition = 500
}

// ---------------------------------------------------------------------------
// ATTACK 2 — a correctly signed cursor naming ANOTHER store's realm.
// ---------------------------------------------------------------------------
{
  const r = tempRoot('a2'); writeFileSync(join(r, 'p.bin'), PAYLOAD)
  const pA = plane('a2-a'); const pB = plane('a2-b')
  const cA = await captureInto(r, pA, 'obs-a2-a')
  await captureInto(r, pB, 'obs-a2-b')
  const D = cA.descriptor
  const firstA = await A.pages(pA.store, { descriptor: D, maxBytes: 64, grants: pA.grants, callerScope: pA.scope })

  // POSITIVE CONTROL: R7's own arm 3 HOLDS -- A's cursor is refused by B.
  out.attacks.crossStoreHonestCursor = await attempt(async () => {
    const page = await A.pages(pB.store, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope, cursor: firstA.nextCursor,
    })
    return { offset: page.offset }
  })

  // The forgery names B's OWN realm, correctly signed by the caller.
  const forged = mintForged({
    storeRealmId: await pB.store.ensureRealm(),
    artifactSha256: D.captured.sha256,
    observationId: D.id,
    revision: `${D.captured.sha256}@g${D.authority.grantRevision}`,
    representation: 'bytes',
    query: 'bytes:64',
    position: 64,
    ownerScope: pA.scope,
    watermark: D.source.acquiredAt,
  }, D, O.OBSERVATION_SCHEMA_VERSION)
  out.attacks.crossStoreForgery = await attempt(async () => {
    const page = await A.pages(pB.store, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope, cursor: forged,
    })
    return {
      offset: page.offset,
      bytes: page.bytes.byteLength,
      // The forgery named B's OWN realm and B served it. The realm is reported
      // redacted: the fact that matters is that B accepted a token it never minted.
      servedByRealm: redactRealm(await pB.store.ensureRealm()),
      storeNeverMintedThisCursor: forged !== firstA.nextCursor,
    }
  })
}

// ---------------------------------------------------------------------------
// ATTACK 3 — D-2: ONE copyFileSync of store-realm.json.
// ---------------------------------------------------------------------------
{
  const r = tempRoot('a3'); writeFileSync(join(r, 'p.bin'), PAYLOAD)
  const pA = plane('a3-a'); const pB = plane('a3-b')
  const cA = await captureInto(r, pA, 'obs-a3-a')
  await captureInto(r, pB, 'obs-a3-b')
  const D = cA.descriptor
  const firstA = await A.pages(pA.store, { descriptor: D, maxBytes: 64, grants: pA.grants, callerScope: pA.scope })

  // POSITIVE CONTROL: before the copy, B refuses.
  out.attacks.realmCopyBefore = await attempt(async () => {
    const page = await A.pages(pB.store, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope, cursor: firstA.nextCursor,
    })
    return { offset: page.offset }
  })

  copyFileSync(
    join(pA.store.root, A.STORE_REALM_FILE_NAME),
    join(pB.store.root, A.STORE_REALM_FILE_NAME),
  )
  // A FRESH store over B's root, so no in-process memo can hide the change.
  const ctx = new Context(); new AttachmentLocal(ctx, { dshHome: pB.home })
  const pBAfter = new A.AttachmentArtifactStore(ctx.attachments, pB.indexRoot)
  out.attacks.realmCopyAfter = await attempt(async () => {
    const realm = await pBAfter.ensureRealm()
    const page = await A.pages(pBAfter, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope, cursor: firstA.nextCursor,
    })
    return {
      offset: page.offset,
      bytes: page.bytes.byteLength,
      // B's realm became A's realm, by file copy alone, with no crypto involved.
      adoptedRealm: realm === await pA.store.ensureRealm(),
      adoptedRealmRedacted: redactRealm(realm),
      bytesMatchA: Buffer.from(page.bytes).equals(PAYLOAD.subarray(64, 64 + page.bytes.byteLength)),
    }
  })
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
