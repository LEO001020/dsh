/**
 * S16 — D-1: THE CURSOR MAC KEY IS A MINTED STORE SECRET, NOT A DERIVED VALUE.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `data11-cursor-realm.test.ts`.
 *
 * That file owns DATA-11's oracle: a cursor replayed against another store or another
 * revision is refused and the refusal is recorded. Its arms ask whether a CURSOR is
 * accepted. This file asks a different question about the mechanism underneath:
 * where does the MAC KEY come from, and what can be said about it?
 *
 * The distinction matters because the defect was invisible from the cursor side.
 * Every arm in the DATA-11 file was green while the key was
 * `cursorSecretOf(descriptor)` -- four descriptor fields, all of them handed to the
 * caller -- because a cursor-side arm can only observe what the key DOES. An arm that
 * asks "is the key derivable from what the caller holds?" fails immediately and
 * unambiguously, and it is the arm that would have caught this.
 *
 * THE PROPERTIES PINNED HERE, each with the failure it rules out:
 *
 *   1. the key is NOT the old public derivation, and contains no descriptor field
 *      -> rules out the defect returning in a renamed form;
 *   2. the key is NOT any digest of the descriptor -> rules out "hash the public
 *      thing", which is public too;
 *   3. two stores over different roots have DIFFERENT keys -> rules out a compiled-in
 *      constant, which one reader of the source could forge for every deployment;
 *   4. the key is DURABLE: two real OS processes over one root read the SAME key
 *      -> rules out a per-boot key, which would break a walk that spans a restart
 *      while looking like a security property;
 *   5. the key is MEMOIZED: repeated calls return the same value without re-reading
 *      -> the paging hot path performs no file read per page;
 *   6. the key is NOT in a cursor, NOT in a refusal record, NOT in the journal
 *      -> rules out the secret leaking through the very channel it protects;
 *   7. a TRUNCATED or malformed key file is REFUSED, never regenerated and never
 *      accepted -> rules out a silently weakened MAC that leaves every arm green;
 *   8. a store that cannot resolve its key refuses the PAGE with a recorded refusal
 *      rather than throwing raw or, worse, serving
 *      -> rules out "the mechanism is absent so the read proceeds";
 *   9. the realm file and the key file are SEPARATE and each lacks the other's value
 *      -> the disclosed value and the secret cannot be confused by a later reader.
 *
 * TRACK LABEL: `[real]`. Every arm drives the production `AttachmentArtifactStore`
 * over real files on this machine's disk, and the durability arm spawns REAL OS
 * processes. No mock: the question is what a caller can obtain, so a stand-in store
 * would answer a different question.
 *
 * SECRETS ARE NEVER PRINTED. The key is reported only as a length or a digest, and no
 * assertion message includes it. `expect(key).not.toBe(...)` failure output is the one
 * place vitest could print it, so the negative arms compare DIGESTS instead wherever
 * the value could be a key.
 */
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIN_CURSOR_KEY_CHARS,
  STORE_CURSOR_KEY_FILE_NAME,
  STORE_REALM_FILE_NAME,
  ArtifactError,
  ArtifactStorePageProvider,
  AttachmentArtifactStore,
  InMemorySessionReferenceLog,
  RecordingPageProvider,
  captureFile,
  mountRefusalRecording,
  pages,
  walkPages,
  type IoCounters,
} from './artifacts.ts'
import { GrantTable, type ObservationDescriptor } from './observations.ts'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(HERE)

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `s16-key-${label}-`))
  tempDirs.push(dir)
  return dir
}

function mountFs(cwd: string): LocalFileSystem {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}

function makePlane(label: string, scope = 'project:s16') {
  const root = tempRoot(label)
  const home = join(root, 'home')
  const indexRoot = join(root, 'artifacts')
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: home })
  const store = new AttachmentArtifactStore(ctx.attachments, indexRoot)
  const log = new InMemorySessionReferenceLog()
  const grants = new GrantTable()
  grants.bump(scope)
  return { store, log, grants, scope, ctx, home, indexRoot, root }
}

const sha256 = (buffer: Uint8Array | string): string =>
  createHash('sha256').update(buffer).digest('hex')

/** A digest of the key, which is what a failure message is allowed to contain. */
const keyDigest = (key: string): string => `sha256:${sha256(key)}`

/** The stimulus. Long enough to span several 64-byte pages. */
const PAYLOAD = Buffer.from('S16-CURSOR-KEY-' + 'k'.repeat(400), 'utf8')

async function captureInto(
  root: string,
  plane: ReturnType<typeof makePlane>,
  observationId: string,
): Promise<Awaited<ReturnType<typeof captureFile>>> {
  return captureFile({
    fs: mountFs(root), path: 'p.bin', store: plane.store, log: plane.log, grants: plane.grants,
    ownerScope: plane.scope, executionWorld: 'local', observationId, mediaType: 'application/octet-stream',
  })
}

/**
 * The key derivation as it was before D-1, copied from the source at that revision.
 *
 * It is written out in full rather than described, because it is the ATTACKER's
 * function: every input is a field of the descriptor the caller holds.
 */
function oldPublicDerivation(descriptor: ObservationDescriptor): string {
  return `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
}

// ---------------------------------------------------------------------------
// 1-2. The key is not derivable from anything the caller holds.
// ---------------------------------------------------------------------------
describe('S16 D-1 [real] the cursor key is not derivable from data the caller holds', () => {
  it('is not the descriptor-derived value, nor a digest of it, nor a digest of the object', async () => {
    // THE ARM THAT WOULD HAVE CAUGHT D-1. It asks the question directly instead of
    // inferring it from whether some cursor was refused.
    const root = tempRoot('not-derived')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('not-derived-store')
    const capture = await captureInto(root, plane, 'obs-not-derived')
    const descriptor = capture.descriptor
    const key = await plane.store.cursorKey()

    // The exact value the old code used. Compared as DIGESTS so a failure cannot print
    // key material, and so the assertion is about identity rather than about a string
    // that a reader could copy out of the test output.
    expect(keyDigest(key)).not.toBe(keyDigest(oldPublicDerivation(descriptor)))
    // "Hash the public thing" is public too, so both plausible derivations are ruled
    // out, not only the literal one.
    expect(keyDigest(key)).not.toBe(keyDigest(sha256(Buffer.from(oldPublicDerivation(descriptor), 'utf8'))))
    expect(keyDigest(key)).not.toBe(keyDigest(sha256(Buffer.from(descriptor.captured.sha256, 'utf8'))))

    // The fields themselves must not appear inside it. Only fields long enough for a
    // substring test to MEAN something: a one-character field occurs by chance in any
    // base64url string, so including it would make the arm fail for an unrelated
    // reason -- the same class of mistake as a sorted-key token being refused as a
    // malformed token and read as evidence about the key.
    for (const part of [descriptor.id, descriptor.captured.sha256, descriptor.authority.ownerScope]) {
      expect(part.length).toBeGreaterThan(3)
      expect(key).not.toContain(part)
    }
  })

  it('is minted with enough entropy to be a key rather than a label', async () => {
    // The length bound is not decoration: it is what `readStoreCursorKeyRecord`
    // enforces on READ, so a hand-edited short key cannot be accepted. Asserted here
    // against the constant so the two cannot drift.
    const plane = makePlane('entropy')
    const key = await plane.store.cursorKey()
    expect(key.length).toBeGreaterThanOrEqual(MIN_CURSOR_KEY_CHARS)
    // 32 bytes base64url-encoded is exactly 43 characters with no padding. Asserted as
    // a range rather than a literal so a deliberate strengthening does not fail the
    // arm for being stronger.
    expect(key.length).toBeGreaterThanOrEqual(43)
    // A random 256-bit value does not repeat across stores, which is the next arm.
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u)
  })
})

// ---------------------------------------------------------------------------
// 3. Per store, not a constant.
// ---------------------------------------------------------------------------
describe('S16 D-1 [real] the cursor key is per store, not a compiled-in constant', () => {
  it('gives two stores at different roots DIFFERENT keys', async () => {
    // A constant in the source is in the repository: every deployment would share one
    // key and any reader of the source could forge for all of them. This is the arm
    // that rules that design out.
    const planeA = makePlane('per-store-a')
    const planeB = makePlane('per-store-b')
    const keyA = await planeA.store.cursorKey()
    const keyB = await planeB.store.cursorKey()
    expect(keyDigest(keyA)).not.toBe(keyDigest(keyB))
  })

  it('gives two stores over ONE root the SAME key, so the key is a property of the store', async () => {
    // The other half: the key belongs to the store root, not to the object instance.
    // Without this, a reopen would mint a second key and invalidate every cursor.
    const plane = makePlane('one-root')
    const first = await plane.store.cursorKey()
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: plane.home })
    const reopened = new AttachmentArtifactStore(ctx.attachments, plane.indexRoot)
    expect(keyDigest(await reopened.cursorKey())).toBe(keyDigest(first))
  })

  it('memoizes the key, so the paging hot path does not re-read the file per page', async () => {
    // The key is read once per store instance. Measured by deleting the file after the
    // first read: a per-call read would now fail, a memoized one is unaffected.
    const plane = makePlane('memo')
    const key = await plane.store.cursorKey()
    rmSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME))
    expect(keyDigest(await plane.store.cursorKey())).toBe(keyDigest(key))
  })
})

// ---------------------------------------------------------------------------
// 4. Durable across a REAL process restart.
// ---------------------------------------------------------------------------
describe('S16 D-1 [real] the cursor key survives a real process restart', () => {
  it('reads the SAME key in two independent OS processes', async () => {
    // A per-boot key would read as a security property ("every restart invalidates
    // every old cursor") and be a restart bug: a legitimate walk spanning a restart
    // would fail. This is the same argument the realm's design records, and it is
    // measured the same way -- two `node` processes, not two module instances.
    const root = tempRoot('restart')
    const storeRoot = join(root, 'artifacts')
    const home = join(root, 'home')
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: home })
    const primed = new AttachmentArtifactStore(ctx.attachments, storeRoot)
    const created = await primed.cursorKey()

    const script = `
      const { pathToFileURL } = await import('node:url')
      const mod = await import(pathToFileURL(${JSON.stringify(join(PKG_ROOT, 'lib', 'artifacts.js'))}).href)
      const attachment = await import('@deepseek-ai/dsh-attachment-local')
      const { Context } = await import('@deepseek-ai/cordis')
      const ctx = new Context()
      new attachment.default(ctx, { dshHome: ${JSON.stringify(home)} })
      const store = new mod.AttachmentArtifactStore(ctx.attachments, ${JSON.stringify(storeRoot)})
      const key = await store.cursorKey()
      // Only a digest and a length leave the child: the key itself must not reach this
      // process's stdout, which a test log would then hold.
      const { createHash } = await import('node:crypto')
      process.stdout.write(JSON.stringify({
        pid: process.pid,
        length: key.length,
        digest: createHash('sha256').update(key).digest('hex'),
      }))
    `
    const runOnce = async (): Promise<{ pid: number; length: number; digest: string }> => {
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: PKG_ROOT,
        timeout: 60_000,
      })
      return JSON.parse(stdout) as { pid: number; length: number; digest: string }
    }
    const first = await runOnce()
    const second = await runOnce()
    expect(first.pid).not.toBe(second.pid)
    expect(first.digest).toBe(sha256(created))
    expect(second.digest).toBe(first.digest)
    expect(second.length).toBe(created.length)
  })

  it('lets a cursor minted before a restart resume after it', async () => {
    // The POSITIVE consequence, and the reason a per-boot key is not an option: the
    // key is stable, so a walk that spans a restart keeps working. A key that broke
    // this would satisfy every forgery arm above and be a product regression.
    const root = tempRoot('restart-resume')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('restart-resume-store')
    const capture = await captureInto(root, plane, 'obs-restart-resume')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    expect(first.nextCursor).toBeDefined()

    // A NEW store object over the same root with a freshly mounted provider: the
    // in-process stand-in for the restarted process.
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: plane.home })
    const restarted = new AttachmentArtifactStore(ctx.attachments, plane.indexRoot)
    const resumed = await pages(restarted, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })
    expect(resumed.offset).toBe(64)
    expect(Buffer.from(resumed.bytes)).toEqual(PAYLOAD.subarray(64, 128))
  })
})

// ---------------------------------------------------------------------------
// 6. The secret does not leak through the channel it protects.
// ---------------------------------------------------------------------------
describe('S16 D-1 [real] the cursor key does not leak through a cursor, a refusal or the journal', () => {
  it('is absent from the cursor the host mints, in both raw and decoded form', async () => {
    const root = tempRoot('no-leak-cursor')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('no-leak-cursor-store')
    const capture = await captureInto(root, plane, 'obs-no-leak')
    const key = await plane.store.cursorKey()
    const page = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    const token = page.nextCursor ?? ''
    expect(token.length).toBeGreaterThan(0)
    expect(token).not.toContain(key)
    const decoded = Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8')
    expect(decoded).not.toContain(key)
    // Nor a PREFIX long enough to be useful: a 16-character prefix of a key is a
    // meaningful head start if the rest were ever brute-forced.
    expect(decoded).not.toContain(key.slice(0, 16))
  })

  it('is absent from every refusal record and from the journal ON DISK', async () => {
    // The refusal path is the one that runs when a token is bad, and it is the path
    // that already disclosed the realm. It must not disclose the key.
    const root = tempRoot('no-leak-refusal')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('no-leak-refusal-a')
    const planeB = makePlane('no-leak-refusal-b')
    const captureA = await captureInto(root, planeA, 'obs-no-leak-a')
    await captureInto(root, planeB, 'obs-no-leak-b')
    const keyB = await planeB.store.cursorKey()
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })

    const provider = new RecordingPageProvider(
      new ArtifactStorePageProvider(planeB.store),
      mountRefusalRecording(planeB.store),
    )
    const refusals: string[] = []
    try {
      await provider.next({
        descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
        cursor: firstA.nextCursor ?? '',
      })
    } catch (error) {
      refusals.push((error as ArtifactError).message)
    }
    expect(refusals).toHaveLength(1)
    for (const message of refusals) expect(message).not.toContain(keyB)

    // The durable record is the one that outlives the process, so it is checked on
    // disk as well as through the reader.
    const onDisk = readFileSync(join(planeB.store.root, 'cursor-refusals.jsonl'), 'utf8')
    expect(onDisk).not.toContain(keyB)
    expect(JSON.stringify(await planeB.store.readRefusals())).not.toContain(keyB)
  })

  it('keeps the key out of the realm record and the realm out of the key record', async () => {
    // The realm is DISCLOSED by design (it is in the cursor and named in refusals) and
    // the key must never be. Keeping them in one file would put the secret in the file
    // whose value is deliberately public, so they are two files and neither carries
    // the other's value.
    const plane = makePlane('two-files')
    const realm = await plane.store.ensureRealm()
    const key = await plane.store.cursorKey()
    const realmRecord = JSON.parse(readFileSync(join(plane.store.root, STORE_REALM_FILE_NAME), 'utf8')) as
      Record<string, unknown>
    const keyRecord = JSON.parse(readFileSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME), 'utf8')) as
      Record<string, unknown>
    expect(realmRecord['storeRealmId']).toBe(realm)
    expect(realmRecord['cursorKey']).toBeUndefined()
    expect(keyRecord['cursorKey']).toBe(key)
    expect(keyRecord['storeRealmId']).toBeUndefined()
    // The non-secret label exists so a diagnosis can NAME the key without printing it.
    expect(typeof keyRecord['keyId']).toBe('string')
    expect(String(keyRecord['keyId'])).not.toBe(key)
    expect(statSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME)).isFile()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. A damaged key file is refused, never silently regenerated or accepted.
// ---------------------------------------------------------------------------
describe('S16 D-1 [real] a damaged cursor key file is refused, never silently regenerated', () => {
  it('refuses a key file that is not valid JSON rather than minting a new key', async () => {
    // Regenerating would invalidate every cursor the store ever issued WHILE LOOKING
    // LIKE the fix working, which is why the refusal names the file.
    const plane = makePlane('bad-json')
    await plane.store.cursorKey()
    writeFileSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME), '{ not json')
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: plane.home })
    const reopened = new AttachmentArtifactStore(ctx.attachments, plane.indexRoot)
    await expect(reopened.cursorKey()).rejects.toMatchObject({ code: 'artifact-integrity-error' })
    // The refusal names the FILE and not the value, so a broken key file does not put
    // key material into a log line.
    await expect(reopened.cursorKey()).rejects.toThrow(/store cursor key file/u)
  })

  it('refuses a key file that carries no key', async () => {
    const plane = makePlane('no-key')
    await plane.store.cursorKey()
    writeFileSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME), JSON.stringify({ createdAt: 'x' }))
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: plane.home })
    await expect(new AttachmentArtifactStore(ctx.attachments, plane.indexRoot).cursorKey())
      .rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('refuses a TRUNCATED key instead of accepting a weakened MAC', async () => {
    // THE ARM THAT MAKES THE LENGTH BOUND REAL. Without it, replacing a 32-byte key
    // with one character would leave every forgery arm green -- the MAC would still be
    // computed, and the key would be guessable in one try.
    const plane = makePlane('truncated')
    const key = await plane.store.cursorKey()
    const record = JSON.parse(readFileSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME), 'utf8')) as
      Record<string, unknown>
    record['cursorKey'] = 'a'
    writeFileSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME), JSON.stringify(record))
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: plane.home })
    const reopened = new AttachmentArtifactStore(ctx.attachments, plane.indexRoot)
    await expect(reopened.cursorKey()).rejects.toMatchObject({ code: 'artifact-integrity-error' })
    await expect(reopened.cursorKey()).rejects.toThrow(/below the 43-character minimum/u)
    // And the real key really was longer, so the arm is about truncation and not about
    // a store that never had a usable key.
    expect(key.length).toBeGreaterThanOrEqual(MIN_CURSOR_KEY_CHARS)
  })

  it('refuses the PAGE, with a recorded refusal, when the key cannot be resolved', async () => {
    // A store that cannot state its key must not serve. The failure has to be a
    // REFUSAL on the request path -- recorded like every other refusal -- rather than
    // a raw throw that a caller could not classify, and never a silent serve.
    const root = tempRoot('unresolvable')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('unresolvable-store')
    const capture = await captureInto(root, plane, 'obs-unresolvable')
    // Damage the key file and open a FRESH store, so no memo hides it.
    writeFileSync(join(plane.store.root, STORE_CURSOR_KEY_FILE_NAME), '{ not json')
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: plane.home })
    const damaged = new AttachmentArtifactStore(ctx.attachments, plane.indexRoot)

    // The descriptor is still valid, the object is still intact: the ONLY thing wrong
    // is the key, so a serve here would be the defect.
    const seen: string[] = []
    await expect(pages(damaged, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      onRefusal: refusal => { seen.push(refusal.code) },
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
    // The refusal reached the sink, which is what makes it observable rather than a
    // bare exception: `refusalStepOf` classifies an integrity error as step 4.
    expect(seen).toEqual(['artifact-integrity-error'])
    await expect(pages(damaged, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toThrow(/store cursor key file/u)
  })
})

// ---------------------------------------------------------------------------
// The key does not become a per-page cost, and the walk still works end to end.
// ---------------------------------------------------------------------------
describe('S16 D-1 [real] the key costs nothing per page and the walk is unchanged', () => {
  it('walks a multi-page artifact to exhaustion with a keyed cursor, byte-for-byte', async () => {
    // THE POSITIVE CONTROL FOR THE WHOLE FILE. Every arm above asserts a refusal or an
    // absence; a store that refused everything would satisfy them. This one requires
    // the mechanism to WORK: the reassembled bytes must equal the artifact.
    const root = tempRoot('walk')
    const pageBytes = 64
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('walk-store')
    const capture = await captureInto(root, plane, 'obs-walk')
    const counters: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    const collected: Buffer[] = []
    const walk = await walkPages(new ArtifactStorePageProvider(plane.store), {
      descriptor: capture.descriptor, maxBytes: pageBytes, grants: plane.grants, callerScope: plane.scope,
    }, {
      counters,
      onPage: page => { collected.push(Buffer.from(page.bytes)) },
    })
    expect(walk.exhausted).toBe(true)
    expect(Buffer.concat(collected)).toEqual(PAYLOAD)
    // The page count is the artifact's, so the key introduced no extra read.
    expect(walk.pages).toBe(Math.ceil(PAYLOAD.length / pageBytes))
    expect(counters.artifactBytesRead).toBe(PAYLOAD.length)
  })
})
