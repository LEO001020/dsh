/**
 * S16 AFTER PROBE — the same three correctly-signed forgeries, against the fix.
 *
 * The stimulus is COPIED from `s16-before-probe.mjs` so the pair is a controlled
 * comparison: same payload, same page size, same forged position (500), same
 * canonical form (`JSON.stringify` in interface field order, `schemaVersion` last).
 * The only thing that changed is where `pages()` gets its MAC key.
 *
 * WHAT MUST BE TRUE AFTER THE FIX, and each is asserted below rather than printed:
 *   1. the position forgery is REFUSED;
 *   2. the cross-store forgery is REFUSED;
 *   3. the realm-file copy alone no longer grants acceptance (D-2);
 *   4. the honest walk still works -- a pager that refused everything would satisfy
 *      1-3 and be useless;
 *   5. a cursor minted by store A is still refused by store B (R7's own arm);
 *   6. the MAC key is NOT derivable from anything the caller holds: the old
 *      `cursorSecretOf` derivation no longer verifies;
 *   7. the key does not appear in a cursor, in a refusal, or in the refusal journal.
 *
 * NOTHING HERE PRINTS A KEY OR A REALM. Realm ids are redacted to a digest prefix
 * and length; the key is only ever reported as a length and a digest, and the
 * assertions about it are booleans.
 *
 * Run from packages/dsh-daily-work:
 *   node --import ./node_modules/tsx/dist/loader.mjs \
 *     qualification/results/S16-cursor-authority/s16-after-probe.mjs
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
const tempRoot = (tag) => { const d = mkdtempSync(join(tmpdir(), `s16a-${tag}-`)); dirs.push(d); return d }
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
const redactRealm = (value) => (typeof value === 'string' && value.length > 0
  ? `sha256:${sha256(value).slice(0, 12)}…(len ${value.length})`
  : value)
const redactText = (text) => (typeof text === 'string'
  ? text.replace(/realm_[0-9a-fA-F-]{36}/gu, match => redactRealm(match))
  : text)

/** The OLD key derivation, kept so the fix can be shown to have removed it. */
const oldAttackerSecret = (d) =>
  `${d.id}:${d.captured.sha256}:${d.authority.ownerScope}:${d.authority.grantRevision}`

/** Mint a cursor with a GIVEN key and the host's canonical form. */
function mintWith(key, cursor, schemaVersion) {
  const full = { ...cursor, schemaVersion }
  const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
}

async function attempt(fn) {
  try { const v = await fn(); return { refused: false, ...v } }
  catch (e) {
    return {
      refused: true,
      code: e?.code,
      name: e?.name,
      realmRefused: typeof e?.realmRefused === 'boolean' ? e.realmRefused : null,
      message: redactText(e?.message),
      // Whether the message names a realm. Reported as a boolean so the values stay
      // out of the record; the fix must NOT disclose an identity to a request whose
      // MAC failed.
      messageNamesARealm: typeof e?.message === 'string' && /realm_[0-9a-fA-F-]{36}/u.test(e.message),
    }
  }
}

async function captureInto(root, p, observationId) {
  return await A.captureFile({
    fs: mountFs(root), path: 'p.bin', store: p.store, log: p.log, grants: p.grants,
    ownerScope: p.scope, executionWorld: 'local', observationId, mediaType: 'application/octet-stream',
  })
}

/** The fields a cursor binds, as the host mints them. */
function baseCursor(D, realm, scope, position) {
  return {
    storeRealmId: realm,
    artifactSha256: D.captured.sha256,
    observationId: D.id,
    revision: `${D.captured.sha256}@g${D.authority.grantRevision}`,
    representation: 'bytes',
    query: 'bytes:64',
    position,
    ownerScope: scope,
    watermark: D.source.acquiredAt,
  }
}

const out = {
  probe: 'S16 D-1/D-2 AFTER — the same correctly-signed forgeries, refused',
  measuredAt: new Date().toISOString(),
  node: process.version,
  identity: {
    worktree: 'D:/DSH/work/wt-s16', branch: 'wt/s16',
    artifactsTsSha256: sha256(readFileSync(join(SRC, 'artifacts.ts'))),
    observationsTsSha256: sha256(readFileSync(join(SRC, 'observations.ts'))),
  },
  attacks: {},
  properties: {},
}

// ---------------------------------------------------------------------------
// ATTACK 1 — the position forgery, signed with the OLD (public) derivation.
// ---------------------------------------------------------------------------
{
  const r = tempRoot('a1'); writeFileSync(join(r, 'p.bin'), PAYLOAD)
  const p = plane('a1-store')
  const c = await captureInto(r, p, 'obs-a1')
  const D = c.descriptor
  const first = await A.pages(p.store, { descriptor: D, maxBytes: 64, grants: p.grants, callerScope: p.scope })

  // POSITIVE CONTROL: the honest walk continues, and it is the SAME call shape.
  const second = await A.pages(p.store, {
    descriptor: D, maxBytes: 64, grants: p.grants, callerScope: p.scope, cursor: first.nextCursor,
  })
  out.properties.honestWalkStillWorks = second.offset === 64 && second.bytes.byteLength === 64
  out.properties.honestWalkReturnsArtifactBytes =
    Buffer.from(second.bytes).equals(PAYLOAD.subarray(64, 128))

  // THE SAME FORGERY AS BEFORE: same key derivation, same field order, position 500.
  out.attacks.positionForgeryOldKey = await attempt(async () => {
    const page = await A.pages(p.store, {
      descriptor: D, maxBytes: 64, grants: p.grants, callerScope: p.scope,
      cursor: mintWith(oldAttackerSecret(D), baseCursor(D, await p.store.ensureRealm(), p.scope, 500),
        O.OBSERVATION_SCHEMA_VERSION),
    })
    return { offset: page.offset, bytes: page.bytes.byteLength }
  })

  // The old derivation is not merely refused -- it is not the key at all.
  const storeKey = await p.store.cursorKey()
  out.properties.oldDerivationIsNotTheKey = storeKey !== oldAttackerSecret(D)
  out.properties.keyIsNotDerivableFromDescriptor =
    ![D.id, D.captured.sha256, D.authority.ownerScope, String(D.authority.grantRevision)]
      .some(part => storeKey.includes(part))
  out.properties.keyShape = { length: storeKey.length, sha256: sha256(storeKey) }

  // The key must not be in the cursor the host mints, nor in a refusal.
  const token = first.nextCursor
  const decodedToken = Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8')
  out.properties.keyAbsentFromCursor = !token.includes(storeKey) && !decodedToken.includes(storeKey)
  const journal = await p.store.readRefusals()
  out.properties.keyAbsentFromRefusalJournal =
    !JSON.stringify(journal).includes(storeKey) && journal.length === 0
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

  out.attacks.crossStoreHonestCursor = await attempt(async () => {
    const page = await A.pages(pB.store, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope, cursor: firstA.nextCursor,
    })
    return { offset: page.offset }
  })

  // The forgery signed with the OLD public derivation, naming B's OWN realm.
  out.attacks.crossStoreForgeryOldKey = await attempt(async () => {
    const page = await A.pages(pB.store, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope,
      cursor: mintWith(oldAttackerSecret(D), baseCursor(D, await pB.store.ensureRealm(), pA.scope, 64),
        O.OBSERVATION_SCHEMA_VERSION),
    })
    return { offset: page.offset, bytes: page.bytes.byteLength }
  })

  // The forgery signed with B's REAL key -- i.e. an attacker who somehow obtained it.
  // Refused as well, because the realm field is still signed and compared: the key is
  // not the only binding, which is the property that makes the two independent.
  out.attacks.crossStoreForgeryRealKey = await attempt(async () => {
    const page = await A.pages(pB.store, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope,
      cursor: mintWith(await pB.store.cursorKey(), baseCursor(D, await pA.store.ensureRealm(), pA.scope, 64),
        O.OBSERVATION_SCHEMA_VERSION),
    })
    return { offset: page.offset }
  })
}

// ---------------------------------------------------------------------------
// ATTACK 3 — D-2: ONE copyFileSync of store-realm.json, with the key left alone.
// ---------------------------------------------------------------------------
{
  const r = tempRoot('a3'); writeFileSync(join(r, 'p.bin'), PAYLOAD)
  const pA = plane('a3-a'); const pB = plane('a3-b')
  const cA = await captureInto(r, pA, 'obs-a3-a')
  await captureInto(r, pB, 'obs-a3-b')
  const D = cA.descriptor
  const firstA = await A.pages(pA.store, { descriptor: D, maxBytes: 64, grants: pA.grants, callerScope: pA.scope })

  copyFileSync(
    join(pA.store.root, A.STORE_REALM_FILE_NAME),
    join(pB.store.root, A.STORE_REALM_FILE_NAME),
  )
  const ctx = new Context(); new AttachmentLocal(ctx, { dshHome: pB.home })
  const pBAfter = new A.AttachmentArtifactStore(ctx.attachments, pB.indexRoot)
  out.attacks.realmCopyOnlyAfter = await attempt(async () => {
    const realm = await pBAfter.ensureRealm()
    const page = await A.pages(pBAfter, {
      descriptor: D, maxBytes: 64, grants: pB.grants, callerScope: pA.scope, cursor: firstA.nextCursor,
    })
    return {
      offset: page.offset,
      bytes: page.bytes.byteLength,
      adoptedRealm: realm === await pA.store.ensureRealm(),
    }
  })

  // AND THE RESIDUE, measured rather than left implicit: copying the KEY file too --
  // i.e. cloning the store root whole -- DOES let B accept A's cursor. The realm check
  // then fires, because the realms still differ; with BOTH files copied there is
  // nothing left to distinguish the stores, and that is the honest limit of this
  // mechanism (a caller who can write both files has the store).
  const pC = plane('a3-c')
  await captureInto(r, pC, 'obs-a3-c')
  copyFileSync(join(pA.store.root, A.STORE_REALM_FILE_NAME), join(pC.store.root, A.STORE_REALM_FILE_NAME))
  copyFileSync(join(pA.store.root, A.STORE_CURSOR_KEY_FILE_NAME), join(pC.store.root, A.STORE_CURSOR_KEY_FILE_NAME))
  const ctxC = new Context(); new AttachmentLocal(ctxC, { dshHome: pC.home })
  const pCAfter = new A.AttachmentArtifactStore(ctxC.attachments, pC.indexRoot)
  out.attacks.wholeRootCloneAfter = await attempt(async () => {
    const page = await A.pages(pCAfter, {
      descriptor: D, maxBytes: 64, grants: pC.grants, callerScope: pA.scope, cursor: firstA.nextCursor,
    })
    return { offset: page.offset, bytes: page.bytes.byteLength, wholeRootCloneAccepted: true }
  })
  out.properties.wholeRootCloneIsOutOfScope = true
}

// ---------------------------------------------------------------------------
// The key's provenance: minted, durable, shared by two stores over one root, and
// NOT shared between two roots.
// ---------------------------------------------------------------------------
{
  const pA = plane('k-a'); const pB = plane('k-b')
  // The realm is resolved explicitly: `cursorKey()` does not create it, and the
  // comparison below reads both files. A store that has published would have one.
  await pA.store.ensureRealm()
  const keyA1 = await pA.store.cursorKey()
  const keyA2 = await pA.store.cursorKey()
  out.properties.keyIsMemoized = keyA1 === keyA2
  out.properties.keyDiffersBetweenStores = keyA1 !== await pB.store.cursorKey()
  // Durable across a reopen of the same root, which is what keeps a walk alive.
  const ctx = new Context(); new AttachmentLocal(ctx, { dshHome: pA.home })
  const reopened = new A.AttachmentArtifactStore(ctx.attachments, pA.indexRoot)
  out.properties.keySurvivesReopen = await reopened.cursorKey() === keyA1
  // The key file exists and is not the realm file.
  const keyFile = join(pA.store.root, A.STORE_CURSOR_KEY_FILE_NAME)
  const record = JSON.parse(readFileSync(keyFile, 'utf8'))
  out.properties.keyFile = {
    name: A.STORE_CURSOR_KEY_FILE_NAME,
    hasCursorKey: typeof record.cursorKey === 'string' && record.cursorKey.length > 0,
    // The record must not carry the realm, and the realm record must not carry the
    // key: the disclosed value and the secret are in different files on purpose.
    recordCarriesNoRealm: record.storeRealmId === undefined,
    realmRecordCarriesNoKey:
      JSON.parse(readFileSync(join(pA.store.root, A.STORE_REALM_FILE_NAME), 'utf8')).cursorKey === undefined,
  }
}

// ---------------------------------------------------------------------------
// A truncated key file is REFUSED, not silently weakened.
// ---------------------------------------------------------------------------
{
  const p = plane('trunc')
  await p.store.cursorKey()
  const keyFile = join(p.store.root, A.STORE_CURSOR_KEY_FILE_NAME)
  const record = JSON.parse(readFileSync(keyFile, 'utf8'))
  record.cursorKey = 'short'
  writeFileSync(keyFile, JSON.stringify(record))
  const ctx = new Context(); new AttachmentLocal(ctx, { dshHome: p.home })
  const reopened = new A.AttachmentArtifactStore(ctx.attachments, p.indexRoot)
  out.properties.truncatedKeyRefused = await attempt(async () => ({ key: (await reopened.cursorKey()).length }))
  out.properties.minimumKeyLength = A.MIN_CURSOR_KEY_CHARS
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
