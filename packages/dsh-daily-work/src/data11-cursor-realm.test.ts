/**
 * R7 — DATA-11: a page cursor is not a bearer token.
 *
 * THE ORACLE, VERBATIM (qualification/specs/acceptance-spec.trusted-local-v1.json):
 *
 *   "Replay a valid cursor against a different store or a different revision.
 *    The cursor is refused and the refusal is recorded. A cursor that yields
 *    pages from a store it was not issued for is NOT PASS."
 *
 * THE DEFECT THIS FILE PINS. Measured before this change (archived as
 * `qualification/results/R7-cursor-realm/before.json`): the cursor REJECTED a
 * revision mismatch but ACCEPTED a cross-store replay. `PageCursor` and
 * `cursorSecretOf` carried no store identity, so two stores holding the same
 * content address minted and accepted the same cursors. The harm arm was worse
 * than the literal arm: a second store holding DIFFERENT bytes under the same
 * content address was served as pages hashing to something other than the
 * descriptor's digest, while `resolveReference` refused the same object.
 *
 * THE REQUIRED ARMS, from V3 §L, each named in a test below:
 *   - same realm + same revision -> success
 *   - changed revision -> reject
 *   - different store -> reject            (the defect's own case)
 *   - tampered cursor -> reject
 *   - descriptor/content mismatch -> reject
 *   - missing/corrupt object -> reject
 *
 * ROUND 2 ADDITION — THE ATTACKER THE SUITE WAS MISSING (D-1).
 *
 * Every arm above TAMPERS with the token, so every one of them trips the MAC. That
 * proves the MAC is computed; it does not prove it protects anything. S16's
 * falsification found the reason the whole file was green while the authority model
 * was broken: the MAC key was `cursorSecretOf(descriptor)` -- four fields of an
 * object `data:fs.capture` hands to the caller -- so a CORRECTLY SIGNED forgery was
 * accepted and served (position 64 -> 500). The block at the end of this file,
 * "a CORRECTLY SIGNED forgery is refused", is that missing attacker, and it is the
 * arm whose absence let 32 green cases miss D-1.
 *
 * THE SHARED-KEY BLOCK is the other half. With a per-store key, a cursor from a
 * store with a DIFFERENT key is refused at step 1 and never reaches the realm
 * comparison, so the realm check would look dead. It is not: it is what separates
 * two stores that share a key (a whole-root clone, one key provisioned twice), and
 * the block below constructs that case deliberately so the check has a live arm.
 *
 * TRACK LABEL: `[real]`. Every arm drives the production `AttachmentArtifactStore`
 * over real files on this machine's disk through the production
 * `publishImmutableObjectStream` publication primitive. There is no mock here:
 * the cross-store question is about real store roots, so a mock store would
 * prove nothing about the defect.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE. The `[mock provider]` block in
 * `data-plane.test.ts` owns the stall guard (DAT-04); a correct provider cannot
 * return a backwards cursor, so that guard cannot be reached from here. This file
 * does not re-test it.
 */
import { Context } from '@deepseek-ai/cordis'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createHash, createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactError,
  CURSOR_REFUSAL_LOG_NAME,
  STORE_CURSOR_KEY_FILE_NAME,
  STORE_REALM_FILE_NAME,
  InMemorySessionReferenceLog,
  AttachmentArtifactStore,
  RecordingPageProvider,
  ArtifactStorePageProvider,
  captureFile,
  mountRefusalRecording,
  pages,
  refusalStepOf,
  walkPages,
  type ArtifactPage,
  type CursorRefusal,
  type IoCounters,
  type PageCursor,
} from './artifacts.ts'
import { GrantTable, OBSERVATION_SCHEMA_VERSION, type ObservationDescriptor } from './observations.ts'

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
  const dir = mkdtempSync(join(tmpdir(), `r7-data11-${label}-`))
  tempDirs.push(dir)
  return dir
}

function mountFs(cwd: string): LocalFileSystem {
  const ctx = new Context()
  return new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
}

/**
 * A real store + log + grants triple, with the store rooted in a temp dir.
 *
 * THE PROVIDER IS MOUNTED HERE, and that is the post-merge construction. The
 * store takes its BYTES from the `ctx.attachments` capability (F4's fix: the
 * module used to deep-import the provider's `src/store.ts`, which put a `.ts`
 * file in the production import graph and created a second physical module
 * instance). So the store's first argument is a mounted provider and its second
 * is the INDEX root -- two independent locations, which is exactly what the
 * cross-store arms below need: two planes with different index roots AND
 * different byte homes, so "different store" is a real difference rather than
 * two views of one directory.
 *
 * The provider's home sits under the same temp root as the index, so no two
 * planes share an attachment store and a plane publishing identical bytes cannot
 * silently dedup against another plane's object.
 */
function makePlane(label: string, scope = 'project:r7') {
  const root = tempRoot(label)
  const home = join(root, 'home')
  const indexRoot = join(root, 'artifacts')
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: home })
  const store = new AttachmentArtifactStore(ctx.attachments, indexRoot)
  const log = new InMemorySessionReferenceLog()
  const grants = new GrantTable()
  grants.bump(scope)
  return { store, log, grants, scope, ctx, home, indexRoot }
}

/**
 * A SECOND store over the SAME two directories as `plane`, with a freshly mounted
 * provider -- the in-process stand-in for a restarted process.
 *
 * Both locations are reused, and that is the point: the store's identity is a
 * property of the index root, so a reopen pointed at a different root would prove
 * nothing about durability. The provider is re-mounted rather than shared because
 * a real restart has a new process and therefore a new provider instance; sharing
 * `plane.ctx.attachments` would model a warm cache, not a restart.
 */
function reopenPlane(plane: ReturnType<typeof makePlane>): AttachmentArtifactStore {
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: plane.home })
  return new AttachmentArtifactStore(ctx.attachments, plane.indexRoot)
}

/**
 * A store over a FRESH temp root, for the arms that only exercise the realm file.
 *
 * The realm lives in the INDEX root, so the byte home is placed beside it under
 * the same temp directory and never read. The provider still has to be mounted,
 * because the constructor takes one -- a store with no provider is not a shape
 * the merged code has.
 *
 * @param label - a distinct temp-dir name, so no two arms share a root.
 * @returns the store and its index root.
 */
function standaloneStore(label: string): { store: AttachmentArtifactStore; indexRoot: string } {
  const root = tempRoot(label)
  const indexRoot = join(root, 'artifacts')
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: join(root, 'home') })
  return { store: new AttachmentArtifactStore(ctx.attachments, indexRoot), indexRoot }
}

/** {@link standaloneStore} with the two directories named explicitly. */
function standaloneStoreAt(home: string, indexRoot: string): { store: AttachmentArtifactStore } {
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: home })
  return { store: new AttachmentArtifactStore(ctx.attachments, indexRoot) }
}

/** A second store over an existing index root, with a freshly mounted provider. */
function reopenStoreAt(indexRoot: string, home?: string): AttachmentArtifactStore {
  const ctx = new Context()
  new AttachmentLocal(ctx, { dshHome: home ?? join(indexRoot, '..', 'home') })
  return new AttachmentArtifactStore(ctx.attachments, indexRoot)
}

const sha256 = (buffer: Uint8Array): string => createHash('sha256').update(buffer).digest('hex')

/** The stimulus. One payload, captured into as many stores as an arm needs. */
const PAYLOAD = Buffer.from('CURSOR-BEARER-TOKEN-' + 'q'.repeat(300), 'utf8')

/** Capture the payload into a plane and return the outcome. */
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
 * The object path for a digest, so a test can damage the real file.
 *
 * The bytes live in the mounted attachment provider now, so the path comes from
 * the capability (`hostPath`) rather than from a layout this module assumes.
 * That is the same accessor the production read path uses, which is what makes
 * the damage land on the file the product would actually open -- a hand-built
 * `root/objects/<sha>` path would damage nothing and the tamper arms below would
 * pass vacuously. The same correction is recorded in `data-plane.test.ts`'s
 * DATA-08 block.
 */
async function objectPath(store: AttachmentArtifactStore, digest: string): Promise<string> {
  const path = await store.hostPath(`artifact:sha256:${digest}`)
  if (path === undefined) {
    throw new Error('the mounted provider must be host-backed for this test to damage the real object')
  }
  return path
}

/** Replace an object's bytes in place, clearing the read-only mode first. */
async function corruptObject(
  store: AttachmentArtifactStore,
  digest: string,
  fill: number,
  length = PAYLOAD.length,
): Promise<void> {
  const path = await objectPath(store, digest)
  chmodSync(path, 0o600)
  writeFileSync(path, Buffer.alloc(length, fill))
}

/** A store with its object replaced by DIFFERENT bytes of the SAME length. */
async function corruptedPlane(root: string, label: string, fill: number) {
  const plane = makePlane(label)
  const capture = await captureInto(root, plane, `obs-${label}`)
  corruptObject(plane.store, capture.descriptor.captured.sha256, fill)
  return { plane, capture }
}

// ---------------------------------------------------------------------------
// V3 §L arm 1: same realm + same revision -> success.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] arm 1: same realm and same revision still succeeds', () => {
  it('serves the next page for a cursor replayed against the store that issued it', async () => {
    const root = tempRoot('same-realm')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('same-realm-store')
    const capture = await captureInto(root, plane, 'obs-same')

    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    expect(first.bytes.byteLength).toBe(64)
    expect(first.nextCursor).toBeDefined()

    // The control. Without it, a pager that refused everything would satisfy every
    // other arm in this file and be useless.
    const second = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })
    expect(second.offset).toBe(64)
    expect(second.bytes.byteLength).toBe(64)
    expect(Buffer.from(second.bytes).equals(PAYLOAD.subarray(64, 128))).toBe(true)
  })

  it('walks the whole artifact and reassembles it byte-for-byte, so the realm binding is not lossy', async () => {
    const root = tempRoot('same-realm-walk')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('same-realm-walk-store')
    const capture = await captureInto(root, plane, 'obs-walk')
    const collected: Uint8Array[] = []
    const walk = await walkPages(new ArtifactStorePageProvider(plane.store), {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    }, { onPage: page => { collected.push(page.bytes) } })
    expect(walk.exhausted).toBe(true)
    expect(sha256(Buffer.concat(collected.map(part => Buffer.from(part))))).toBe(sha256(PAYLOAD))
  })
})

// ---------------------------------------------------------------------------
// V3 §L arm 2: changed revision -> reject.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] arm 2: a changed revision is refused', () => {
  it('refuses a cursor after the grant revision moves, even on its own realm', async () => {
    const root = tempRoot('revision')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('revision-store')
    const capture = await captureInto(root, plane, 'obs-revision')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    plane.grants.bump(plane.scope)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-scope-denied' })
  })

  it('refuses a cursor whose descriptor revision differs, even when the object is unchanged', async () => {
    // The revision is bound as a SIGNED FIELD, so a descriptor edited to claim a
    // different revision cannot be paired with the old cursor: the MAC covers the
    // revision string, not just the digest.
    const root = tempRoot('revision-field')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('revision-field-store')
    const capture = await captureInto(root, plane, 'obs-revfield')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    // Bump the grant twice so the LIVE revision returns to a value the descriptor
    // can be edited to name, while the cursor still carries the original.
    plane.grants.bump(plane.scope)
    const liveRevision = plane.grants.bump(plane.scope)
    const forgedDescriptor: ObservationDescriptor = {
      ...capture.descriptor,
      authority: { ...capture.descriptor.authority, grantRevision: liveRevision },
    }
    // The descriptor passes the live-grant check, so the refusal can only be the
    // cursor's own revision binding.
    await expect(pages(plane.store, {
      descriptor: forgedDescriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })
})

// ---------------------------------------------------------------------------
// V3 §L arm 3: DIFFERENT STORE -> reject. THE DEFECT'S OWN CASE.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] arm 3: a cursor replayed against a different store is refused', () => {
  it('refuses store A\u2019s cursor when presented to store B holding the SAME bytes', async () => {
    // This is the oracle's first arm and the measured defect. Both stores hold the
    // SAME content address, both use the SAME scope string, so before the fix every
    // binding a cursor carried was satisfied and 64 bytes came back.
    const root = tempRoot('cross-store')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('cross-store-a')
    const planeB = makePlane('cross-store-b')
    const captureA = await captureInto(root, planeA, 'obs-cross-a')
    const captureB = await captureInto(root, planeB, 'obs-cross-b')

    // The premise: the two stores agree on the content address, so the DIGEST
    // cannot be what distinguishes them.
    expect(captureB.descriptor.captured.sha256).toBe(captureA.descriptor.captured.sha256)
    expect(await planeA.store.realmId).not.toBe(await planeB.store.realmId)

    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    expect(firstA.nextCursor).toBeDefined()

    // A's descriptor, A's cursor, A's scope string -- read from B.
    await expect(pages(planeB.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied', realmRefused: true })

    // The refusal names the realm binding, so it is not confusable with a scope or
    // signature refusal.
    await expect(pages(planeB.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
    })).rejects.toThrow(/store realm/u)
  })

  it('refuses the cross-store replay BEFORE any byte is read, so no unverified content escapes', async () => {
    // The read order is the contract. A refusal that happened after the read would
    // mean the bytes were already in the caller's hands, which is the failing shape
    // ("openRange, then discover it was the wrong artifact").
    const root = tempRoot('cross-store-order')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('cross-order-a')
    const planeB = makePlane('cross-order-b')
    const captureA = await captureInto(root, planeA, 'obs-order-a')
    await captureInto(root, planeB, 'obs-order-b')
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    const counters: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    await expect(pages(planeB.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
    }, counters)).rejects.toMatchObject({ code: 'pagination-realm-denied' })
    // ZERO bytes and ZERO reads: the refusal preceded the read.
    expect(counters.artifactBytesRead).toBe(0)
    expect(counters.artifactReads).toBe(0)
  })

  it('refuses a cursor replayed against a store holding DIFFERENT bytes under the same address', async () => {
    // THE HARM ARM, isolated. Store D holds different bytes under the SAME content
    // address. Before the fix this yielded bytes hashing to something other than the
    // descriptor's digest, while `resolveReference` refused the same object -- the
    // two planes disagreed about one object.
    const root = tempRoot('cross-store-harm')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('cross-harm-a')
    const captureA = await captureInto(root, planeA, 'obs-harm-a')
    const { plane: planeD } = await corruptedPlane(root, 'cross-harm-d', 0x5a)

    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    await expect(pages(planeD.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeD.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })
  })

  it('refuses a cross-store replay even when the OTHER store has no object at all', async () => {
    // A store that never held the object: absence alone already refused this before
    // the fix, so the arm is kept as a control that the realm check did not WEAKEN
    // the existing behaviour.
    const root = tempRoot('cross-store-absent')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('cross-absent-a')
    const planeC = makePlane('cross-absent-c')
    const captureA = await captureInto(root, planeA, 'obs-absent-a')
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    await expect(pages(planeC.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeC.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })
  })
})

// ---------------------------------------------------------------------------
// V3 §L arm 4: tampered cursor -> reject.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] arm 4: a tampered cursor is refused', () => {
  it('refuses a cursor whose payload was edited to skip bytes', async () => {
    const root = tempRoot('tamper')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('tamper-store')
    const capture = await captureInto(root, plane, 'obs-tamper')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    const token = first.nextCursor ?? ''
    const index = Math.floor(token.length / 2)
    const tampered = `${token.slice(0, index)}${token[index] === 'A' ? 'B' : 'A'}${token.slice(index + 1)}`
    expect(tampered).not.toBe(token)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: tampered,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })

  it('refuses a re-signed cursor that claims a position the host never minted', async () => {
    // A caller with the descriptor can produce a well-formed payload but not a valid
    // MAC, because the MAC is keyed by the host secret. This is what makes the
    // position a host fact rather than a caller assertion.
    const root = tempRoot('tamper-resign')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('tamper-resign-store')
    const capture = await captureInto(root, plane, 'obs-resign')
    const forged = `${Buffer.from(JSON.stringify({
      storeRealmId: await plane.store.ensureRealm(),
      artifactSha256: capture.descriptor.captured.sha256,
      observationId: capture.descriptor.id,
      revision: `${capture.descriptor.captured.sha256}@g1`,
      representation: 'bytes',
      query: 'bytes:64',
      position: 999,
      schemaVersion: 1,
      ownerScope: plane.scope,
      watermark: capture.descriptor.source.acquiredAt,
    }), 'utf8').toString('base64url')}.not-a-real-mac`
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: forged,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })

  it('refuses a cursor whose realm field was edited without the host secret', async () => {
    // Editing the realm field is the attack the fix invites: if the realm were not
    // inside the MAC, a caller could rewrite it to name the target store. It IS
    // inside, so the edit breaks the MAC.
    const root = tempRoot('tamper-realm-field')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('tamper-realm-a')
    const planeB = makePlane('tamper-realm-b')
    const captureA = await captureInto(root, planeA, 'obs-tamper-realm')
    const first = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    const token = first.nextCursor ?? ''
    const index = token.lastIndexOf('.')
    const decoded = JSON.parse(Buffer.from(token.slice(0, index), 'base64url').toString('utf8')) as Record<string, unknown>
    decoded['storeRealmId'] = await planeB.store.ensureRealm()
    const rewritten = `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}${token.slice(index)}`
    // The MAC does not verify over the rewritten payload, so this is a parse refusal
    // and NOT a realm refusal -- which is the point: a caller cannot reach the realm
    // comparison at all without a host-minted token.
    await expect(pages(planeB.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
      cursor: rewritten,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })
})

// ---------------------------------------------------------------------------
// V3 §L arm 5: descriptor/content mismatch -> reject.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] arm 5: a descriptor/content mismatch is refused before the read', () => {
  it('refuses to page an object the OWN store holds with different bytes under the same address', async () => {
    // The mechanism, isolated from the cross-store question entirely. This is the
    // arm that proves the harm was a property of the PAGING PATH and not of the
    // store swap: before the fix `pages()` served 64 bytes here while
    // `resolveReference` refused the same object.
    const root = tempRoot('own-store-corrupt')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const { plane, capture } = await corruptedPlane(root, 'own-corrupt', 0x5a)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('refuses an object TRUNCATED below the bytes the descriptor records', async () => {
    const root = tempRoot('own-store-truncated')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('own-truncated')
    const capture = await captureInto(root, plane, 'obs-truncated')
    corruptObject(plane.store, capture.descriptor.captured.sha256, 0x61, 5)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
    // The refusal names the two lengths, so an operator can tell WHICH object is wrong.
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toThrow(/bytes but the descriptor records/u)
  })

  it('refuses a descriptor whose reference and recorded digest disagree', async () => {
    // A malformed descriptor could otherwise be bound to one object while claiming
    // another, which would let a page be attributed to bytes it did not come from.
    const root = tempRoot('descriptor-mismatch')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('descriptor-mismatch-store')
    const capture = await captureInto(root, plane, 'obs-mismatch')
    const other = 'a'.repeat(64)
    const mismatched: ObservationDescriptor = {
      ...capture.descriptor,
      captured: { ...capture.descriptor.captured, artifact: `artifact:sha256:${other}`, sha256: other },
    }
    await expect(pages(plane.store, {
      descriptor: mismatched, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('still serves an INTACT object, so the identity check is not vacuous', async () => {
    // A check that refused everything would satisfy the three tests above and be
    // useless. The control is the same call on undamaged bytes.
    const root = tempRoot('own-store-intact')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('own-intact')
    const capture = await captureInto(root, plane, 'obs-intact')
    const page = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    expect(page.bytes.byteLength).toBe(64)
    expect(sha256(Buffer.from(page.bytes))).toBe(sha256(PAYLOAD.subarray(0, 64)))
  })

  it('refuses a replacement that preserves the length AND the mtime, because the memo moves with ctime', async () => {
    // THE WEAKER-ROUTE ARM, and the reason `ctimeMs` is in the identity stamp.
    //
    // DATA-11's evidence note names the harm as a DISAGREEMENT between two read
    // paths: `pages()` serving bytes that are not the artifact while
    // `resolveReference()` refuses the same object. This arm constructs the one
    // shape that produced that disagreement.
    //
    // THE MECHANISM. `assertObjectIdentity` memoized a verification under
    // `${size}:${mtimeMs}`, and BOTH fields are settable by whoever can write the
    // store root. A naive replacement fails, because this filesystem keeps
    // sub-millisecond mtime precision and `utimesSync` cannot reproduce the
    // fraction. So the arm pins the mtime to a WHOLE SECOND FIRST -- a whole second
    // IS exactly reproducible -- and only then pages once. The store hashes the
    // REAL bytes and memoizes that stamp; the replacement then restores the same
    // whole second and matches it.
    //
    // MEASURED BEFORE THE FIX, all five steps
    // (`qualification/results/C3-dataplane/memo-before.json`): the cursor SERVED
    // THE REPLACED BYTES with an empty refusal list, while a COLD store over the
    // same root refused them with `artifact-integrity-error`. The replacement was
    // therefore detectable and the warm memo was the only reason it was not
    // detected -- the paging path was the weaker route to the same bytes.
    //
    // This test asserts the NEW truth: the stamp now includes `ctimeMs`, which
    // POSIX does not let `utimes` set and which the replacing write updates, so the
    // digest is re-taken and the page is refused.
    const root = tempRoot('memo-stamp')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('memo-stamp-store')
    const capture = await captureInto(root, plane, 'obs-memo-stamp')
    const hostPath = await objectPath(plane.store, capture.descriptor.captured.sha256)

    // STEP 1: pin the mtime to a whole second BEFORE any verification.
    chmodSync(hostPath, 0o600)
    const pinned = Math.floor(Date.now() / 1000)
    utimesSync(hostPath, pinned, pinned)
    const pinnedStat = statSync(hostPath)
    expect(pinnedStat.mtimeMs % 1000).toBe(0)

    // STEP 2: page once, so the REAL bytes are verified and the stamp memoized.
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    expect(first.nextCursor).toBeDefined()

    // STEP 3: replace in place with different bytes of the SAME length.
    const replacement = Buffer.alloc(PAYLOAD.length, 0xcc)
    writeFileSync(hostPath, replacement)

    // STEP 4: restore the SAME whole second. The old stamp matched here, which is
    // the defect; the assertion records that the attack really was constructed,
    // so a green result below cannot be a test that failed to build its stimulus.
    utimesSync(hostPath, pinned, pinned)
    const afterStat = statSync(hostPath)
    expect(afterStat.size).toBe(pinnedStat.size)
    expect(afterStat.mtimeMs).toBe(pinnedStat.mtimeMs)
    expect(`${String(afterStat.size)}:${String(afterStat.mtimeMs)}`)
      .toBe(`${String(pinnedStat.size)}:${String(pinnedStat.mtimeMs)}`)
    // The bytes really are not the artifact.
    expect(sha256(replacement)).not.toBe(capture.descriptor.captured.sha256)
    // AND THE FIELD THAT MAKES THE STAMP MOVE: the replacement updated ctime, and
    // userspace cannot set it back.
    expect(afterStat.ctimeMs).not.toBe(pinnedStat.ctimeMs)

    // STEP 5: the cursor is REFUSED, and the refusal reaches the host's sink.
    // The LIVE callback type, which is narrower than the JOURNAL row: `onRefusal`
    // fires before the journal assigns `at`, so it carries no timestamp. Typing this
    // as `CursorRefusal[]` was the mismatch the compiler caught -- the assertion below
    // reads only `.code`, which both shapes carry.
    const refusals: Array<Omit<CursorRefusal, 'at'>> = []
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
      onRefusal: refusal => { refusals.push(refusal) },
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
    expect(refusals.map(entry => entry.code)).toContain('artifact-integrity-error')
  })
})

// ---------------------------------------------------------------------------
// V3 §L arm 6: missing/corrupt object -> reject.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] arm 6: a missing object is refused, never as an empty success', () => {
  it('refuses a continuation when the object was deleted between pages', async () => {
    // The object existed when the cursor was minted and is gone now. An empty page
    // here would be indistinguishable from a legitimately empty region, so the
    // refusal is an integrity error naming the absence.
    const root = tempRoot('missing-mid-walk')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('missing-mid-walk-store')
    const capture = await captureInto(root, plane, 'obs-missing-mid')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    const path = await objectPath(plane.store, capture.descriptor.captured.sha256)
    chmodSync(path, 0o600)
    rmSync(path)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('refuses the FIRST page of a missing object, so a lost artifact never reads as empty', async () => {
    const root = tempRoot('missing-first')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('missing-first-store')
    const capture = await captureInto(root, plane, 'obs-missing-first')
    const path = await objectPath(plane.store, capture.descriptor.captured.sha256)
    chmodSync(path, 0o600)
    rmSync(path)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('refuses a deleted object as not-found rather than as an integrity error', async () => {
    // "explicitly deleted" and "vanished" are different facts, and the store keeps
    // them apart: the tombstone makes a delete read as a delete.
    const root = tempRoot('deleted')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('deleted-store')
    const capture = await captureInto(root, plane, 'obs-deleted')
    await plane.store.remove(capture.descriptor.captured.artifact)
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })).rejects.toMatchObject({ code: 'artifact-not-found' })
  })
})

// ---------------------------------------------------------------------------
// THE ORACLE'S SECOND CLAUSE: "the refusal is recorded".
// ---------------------------------------------------------------------------
describe('DATA-11 [real] the refusal is RECORDED, not merely raised', () => {
  it('journals a cross-store refusal durably, naming both realms and the step', async () => {
    const root = tempRoot('record-cross')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('record-cross-a')
    const planeB = makePlane('record-cross-b')
    const captureA = await captureInto(root, planeA, 'obs-record-a')
    await captureInto(root, planeB, 'obs-record-b')
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })

    // The PRODUCTION recording path: the same provider decorator `DataPlaneService.walk`
    // mounts, over the same journal the store writes.
    const provider = new RecordingPageProvider(
      new ArtifactStorePageProvider(planeB.store),
      mountRefusalRecording(planeB.store),
    )
    await expect(provider.next({
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })

    const recorded: CursorRefusal[] = await planeB.store.readRefusals()
    expect(recorded).toHaveLength(1)
    const refusal = recorded[0] as CursorRefusal
    expect(refusal.code).toBe('pagination-realm-denied')
    expect(refusal.step).toBe('realm')
    expect(refusal.storeRealmId).toBe(await planeB.store.ensureRealm())
    expect(refusal.observationId).toBe(captureA.descriptor.id)
    expect(refusal.reason).toMatch(/store realm/u)
    // The journal is a FILE inside the store root, so the evidence survives the
    // process that refused it.
    const onDisk = readFileSync(join(planeB.store.root, CURSOR_REFUSAL_LOG_NAME), 'utf8')
    expect(onDisk.trim().split('\n')).toHaveLength(1)
  })

  it('records the refusal through the request sink even when no journal is mounted', async () => {
    // `pages()` is pure paging: it reports the refusal and does no IO. A caller that
    // mounts no journal still observes the refusal, so the sink is not the only
    // route and the pure path stays pure.
    const root = tempRoot('record-sink')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('record-sink-a')
    const planeB = makePlane('record-sink-b')
    const captureA = await captureInto(root, planeA, 'obs-sink-a')
    await captureInto(root, planeB, 'obs-sink-b')
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    const seen: Array<{ code: string; step: string }> = []
    await expect(pages(planeB.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
      cursor: firstA.nextCursor ?? '',
      onRefusal: refusal => { seen.push({ code: refusal.code, step: refusal.step }) },
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })
    expect(seen).toEqual([{ code: 'pagination-realm-denied', step: 'realm' }])
  })

  it('maps every refusal code to the read-order step that produced it', () => {
    // The read order is the contract, so the step a refusal is attributed to is
    // derived from the code in ONE place rather than attached by hand at each throw.
    expect(refusalStepOf(new ArtifactError('x', 'pagination-realm-denied'))).toBe('realm')
    expect(refusalStepOf(new ArtifactError('x', 'pagination-cursor-invalid'))).toBe('parse')
    expect(refusalStepOf(new ArtifactError('x', 'pagination-scope-denied'))).toBe('reference')
    expect(refusalStepOf(new ArtifactError('x', 'artifact-integrity-error'))).toBe('identity')
    expect(refusalStepOf(new ArtifactError('x', 'artifact-not-found'))).toBe('read')
  })

  it('keeps recording refusals across many attempts rather than only the first', async () => {
    const root = tempRoot('record-many')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('record-many-a')
    const planeB = makePlane('record-many-b')
    const captureA = await captureInto(root, planeA, 'obs-many-a')
    await captureInto(root, planeB, 'obs-many-b')
    const firstA = await pages(planeA.store, {
      descriptor: captureA.descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    const provider = new RecordingPageProvider(
      new ArtifactStorePageProvider(planeB.store),
      mountRefusalRecording(planeB.store),
    )
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(provider.next({
        descriptor: captureA.descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope,
        cursor: firstA.nextCursor ?? '',
      })).rejects.toMatchObject({ code: 'pagination-realm-denied' })
    }
    const recorded = await planeB.store.readRefusals()
    expect(recorded).toHaveLength(3)
    expect(recorded.every(entry => entry.code === 'pagination-realm-denied')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// THE STORE IDENTITY ITSELF: durable, stable, and not per-boot.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] the store realm identity is durable and not per-boot', () => {
  it('persists the realm in a file and returns the SAME value for a second store over one root', async () => {
    // The in-process half of restart stability. A per-boot random realm would make
    // every cursor from a previous process invalid, which reads as a security
    // property and is actually a restart bug.
    const root = tempRoot('realm-persist')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('realm-persist-store')
    await captureInto(root, plane, 'obs-realm-persist')
    const first = await plane.store.ensureRealm()
    const reopened = reopenPlane(plane)
    expect(await reopened.ensureRealm()).toBe(first)
    // The file is the durable record, and it names the same realm.
    const record = JSON.parse(readFileSync(join(plane.store.root, STORE_REALM_FILE_NAME), 'utf8')) as
      { storeRealmId: string }
    expect(record.storeRealmId).toBe(first)
    expect(statSync(join(plane.store.root, STORE_REALM_FILE_NAME)).isFile()).toBe(true)
  })

  it('gives two stores at DIFFERENT roots different realms, so the identity distinguishes them', async () => {
    const planeA = makePlane('realm-distinct-a')
    const planeB = makePlane('realm-distinct-b')
    expect(await planeA.store.ensureRealm()).not.toBe(await planeB.store.ensureRealm())
  })

  it('refuses rather than silently minting a new realm when the realm file is malformed', async () => {
    // Regenerating would invalidate every cursor the store ever issued while looking
    // like a security property. The honest answer is a refusal naming the file.
    const { store, indexRoot } = standaloneStore('realm-malformed')
    const realm = await store.ensureRealm()
    expect(realm.length).toBeGreaterThan(0)
    writeFileSync(join(store.root, STORE_REALM_FILE_NAME), '{ not json')
    const reopened = reopenStoreAt(indexRoot)
    await expect(reopened.ensureRealm()).rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('refuses a realm file that carries no storeRealmId', async () => {
    const { store, indexRoot } = standaloneStore('realm-empty')
    await store.ensureRealm()
    writeFileSync(join(store.root, STORE_REALM_FILE_NAME), JSON.stringify({ createdAt: 'x' }))
    await expect(reopenStoreAt(indexRoot).ensureRealm())
      .rejects.toMatchObject({ code: 'artifact-integrity-error' })
  })

  it('survives a REAL process restart: the realm read by one process is the one a second process reads', async () => {
    // THE EXIT CRITERION, measured rather than argued. Two independent `node`
    // processes open ONE store root and print the realm they resolve. If the realm
    // were per-boot these would differ, and every cursor from the first process
    // would be refused by the second -- which is the specific failure mode this
    // design exists to avoid.
    const root = tempRoot('realm-restart')
    const storeRoot = join(root, 'artifacts')
    const home = join(root, 'home')
    // Prime the realm so process 1 reads an EXISTING one, which is the case that
    // matters: a fresh store in each process would prove nothing about durability.
    const { store: primed } = standaloneStoreAt(home, storeRoot)
    const created = await primed.ensureRealm()

    // The child mounts its OWN provider over the same home, which is what a real
    // second process does; a shared instance would model a warm cache instead.
    const script = `
      const { pathToFileURL } = await import('node:url')
      const mod = await import(pathToFileURL(${JSON.stringify(join(PKG_ROOT, 'lib', 'artifacts.js'))}).href)
      const attachment = await import('@deepseek-ai/dsh-attachment-local')
      const { Context } = await import('@deepseek-ai/cordis')
      const ctx = new Context()
      new attachment.default(ctx, { dshHome: ${JSON.stringify(home)} })
      const store = new mod.AttachmentArtifactStore(ctx.attachments, ${JSON.stringify(storeRoot)})
      const realm = await store.ensureRealm()
      process.stdout.write(JSON.stringify({ pid: process.pid, realm }))
    `
    const runOnce = async (): Promise<{ pid: number; realm: string }> => {
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: PKG_ROOT,
        timeout: 60_000,
      })
      return JSON.parse(stdout) as { pid: number; realm: string }
    }
    const first = await runOnce()
    const second = await runOnce()
    // Two genuinely different OS processes, so "restart" is real and not a second
    // module instance inside one runtime.
    expect(first.pid).not.toBe(second.pid)
    expect(first.realm).toBe(created)
    expect(second.realm).toBe(created)
    expect(second.realm).toBe(first.realm)
  })

  it('lets a cursor minted before a restart resume after it, which a per-boot realm could not', async () => {
    // The positive half of the same measurement: the identity is stable, so the
    // guarantee a per-boot realm would falsely appear to provide is actually
    // provided by the content digest, and the realm does not break legitimate walks.
    const root = tempRoot('realm-resume')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('realm-resume-store')
    const capture = await captureInto(root, plane, 'obs-resume')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    // A NEW store object over the same root stands in for the restarted process's
    // store; the cross-process case is measured in the test above.
    const restarted = reopenPlane(plane)
    const resumed = await pages(restarted, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })
    expect(resumed.offset).toBe(64)
    expect(Buffer.from(resumed.bytes).equals(PAYLOAD.subarray(64, 128))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The tuple, stated as a test so the bindings cannot silently shrink.
// ---------------------------------------------------------------------------
describe('DATA-11 [real] the cursor binds the COMPLETE tuple', () => {
  it('carries every bound field, so a partial binding cannot be mistaken for a full one', async () => {
    const root = tempRoot('tuple')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('tuple-store')
    const capture = await captureInto(root, plane, 'obs-tuple')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    const token = first.nextCursor ?? ''
    const index = token.lastIndexOf('.')
    const payload = JSON.parse(Buffer.from(token.slice(0, index), 'base64url').toString('utf8')) as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual([
      'artifactSha256', 'observationId', 'ownerScope', 'position', 'query',
      'representation', 'revision', 'schemaVersion', 'storeRealmId', 'watermark',
    ])
    expect(payload['storeRealmId']).toBe(await plane.store.ensureRealm())
    expect(payload['observationId']).toBe(capture.descriptor.id)
    expect(payload['revision']).toBe(`${capture.descriptor.captured.sha256}@g1`)
    expect(payload['query']).toBe('bytes:64')
    expect(payload['position']).toBe(64)
    // Bound to the CONSTANT rather than to the literal 1 it was when this arm was
    // written. The cursor carries the DESCRIPTOR's schema version
    // (`new CursorAuthority(..., descriptor.schemaVersion)`), and R8's taxonomy
    // split raised `OBSERVATION_SCHEMA_VERSION` from 1 to 2 -- so a literal here
    // asserts a number the product is right not to produce. Reading the constant
    // keeps this arm about the BINDING, which is what the test name claims, rather
    // than about a value that moves for unrelated reasons.
    expect(payload['schemaVersion']).toBe(OBSERVATION_SCHEMA_VERSION)
  })

  it('refuses a cursor minted for a different QUERY over the same artifact', async () => {
    // The query binding: a cursor issued for a 64-byte page walk must not resume a
    // 4096-byte walk, because the two are different requests over one object.
    const root = tempRoot('tuple-query')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('tuple-query-store')
    const capture = await captureInto(root, plane, 'obs-query')
    const first = await pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    await expect(pages(plane.store, {
      descriptor: capture.descriptor, maxBytes: 128, grants: plane.grants, callerScope: plane.scope,
      cursor: first.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })

  it('refuses a cursor minted for a different OBSERVATION over the same artifact', async () => {
    // Two observations can legitimately name the SAME object (a re-capture of
    // identical bytes dedups onto one object), so the digest alone cannot separate
    // their cursors. The observation id is the binding that can.
    const root = tempRoot('tuple-observation')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('tuple-observation-store')
    const first = await captureInto(root, plane, 'obs-one')
    const second = await captureInto(root, plane, 'obs-two')
    expect(second.descriptor.captured.sha256).toBe(first.descriptor.captured.sha256)
    const firstPage = await pages(plane.store, {
      descriptor: first.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    await expect(pages(plane.store, {
      descriptor: second.descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
      cursor: firstPage.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
  })
})

// ---------------------------------------------------------------------------
// The per-page IO cost is unchanged: the identity check must not become a
// full re-read per page (DAT-06's budget).
// ---------------------------------------------------------------------------
describe('DATA-11 [real] the identity check does not become a full re-read per page', () => {
  it('reads O(pages) from the object even with the pre-read verification in place', async () => {
    // The reason `assertObjectIdentity` is a stat-per-call plus a digest memoized on
    // (size, mtime) rather than a hash per call: hashing the whole object per page
    // would be the P-times-full-rescan cost DAT-06 forbids. This asserts the budget
    // survived the fix.
    const root = tempRoot('io-budget')
    const pageBytes = 64 * 1024
    const totalBytes = 16 * pageBytes
    writeFileSync(join(root, 'io.bin'), Buffer.alloc(totalBytes, 0x61))
    const plane = makePlane('io-budget-store')
    const capture = await captureFile({
      fs: mountFs(root), path: 'io.bin', store: plane.store, log: plane.log, grants: plane.grants,
      ownerScope: plane.scope, executionWorld: 'local', observationId: 'obs-io', mediaType: 'application/octet-stream',
    })
    const counters: IoCounters = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
    const walk = await walkPages(new ArtifactStorePageProvider(plane.store), {
      descriptor: capture.descriptor, maxBytes: pageBytes, grants: plane.grants, callerScope: plane.scope,
    }, { maxPages: 4, counters })
    expect(walk.pages).toBe(4)
    // Exactly the pages consumed: no whole-object scan per page.
    expect(counters.artifactBytesRead).toBe(4 * pageBytes)
    expect(counters.artifactReads).toBe(4)
    // The verification's own read of the object is NOT accounted in these counters,
    // because it happens once per (size, mtime) rather than per page. Stated rather
    // than implied: this counter measures the paging path, and the one-time verify
    // pass is a separate cost.
    expect(counters.artifactBytesRead).toBeLessThan(totalBytes)
  })
})

// ---------------------------------------------------------------------------
// S16 D-1: THE ARM THAT WAS MISSING — a CORRECTLY SIGNED forgery.
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS, in one sentence: every other arm in this file tampers with
// the token, so every other arm trips the MAC, and a suite whose arms all fail for
// the same reason cannot tell "the MAC is checked" from "the MAC protects
// something".
//
// THE DEFECT, measured before the fix
// (`qualification/results/S16-cursor-authority/s16-before.json`): the MAC key was
// `cursorSecretOf(descriptor)` --
//
//     `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
//
// -- four fields of an object `data:fs.capture` returns to the caller
// (`data-bridge.ts:255`), which the Python client stores verbatim
// (`dsh_data_client.py:82`) and sends back on every page call. So a caller could
// re-derive the key and mint a cursor the host never issued. One was ACCEPTED and
// served offset 500, a position the host never minted.
//
// WHY `position` AND `storeRealmId` WERE THE TWO FORGEABLE FIELDS. Seven of the nine
// bound fields are ALSO compared against a live value (`assertBindings`, the digest
// and watermark checks, the live grant), so a signed forgery of those is refused for
// a reason that has nothing to do with the MAC. `position` is the caller's chosen
// resume point and has no live counterpart; `storeRealmId` was compared only against
// the store's own value, which a caller can read out of a refusal. Those two are
// therefore where a broken key is observable, and they are the arms below.
//
// THE TRAP THAT COST THE ROOT AGENT AN ATTEMPT, recorded so nobody repeats it: the
// canonical form is `JSON.stringify(full)` in the INTERFACE FIELD ORDER with
// `schemaVersion` appended last (`mint`, artifacts.ts). A SORTED key/value form is
// refused -- and that refusal proves NOTHING about the key, because it is a
// malformed token. A test that stops at the first refusal concludes the opposite of
// the truth. Both forms are exercised below: the sorted one is kept as the control
// that a malformed-token refusal is not evidence.
describe('DATA-11 [real] D-1: a CORRECTLY SIGNED forgery is refused', () => {
  /**
   * The OLD key derivation, copied from the source as it was before this fix.
   *
   * Kept verbatim rather than described, because this is the ATTACKER's function:
   * it reads four fields of an object the caller holds, and the point of the block
   * is that this is no longer the key.
   */
  const oldPublicDerivation = (descriptor: ObservationDescriptor): string =>
    `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`

  /**
   * Mint a cursor with the REAL algorithm: HMAC-SHA256 over `JSON.stringify(full)`
   * in interface field order, `schemaVersion` last.
   *
   * A forgery that merely appends a bogus MAC proves only that the MAC is checked.
   * The question is whether a caller holding the descriptor can produce a cursor the
   * host did not issue, so the forgery has to be CORRECTLY SIGNED to test anything.
   */
  function mintWithKey(
    key: string,
    cursor: Omit<PageCursor, 'schemaVersion'>,
    schemaVersion: number,
  ): string {
    const full = { ...cursor, schemaVersion }
    const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
    return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`
  }

  /** The fields a cursor binds, as the host mints them, so only one has to differ. */
  function boundFields(
    descriptor: ObservationDescriptor,
    storeRealmId: string,
    scope: string,
    position: number,
  ): Omit<PageCursor, 'schemaVersion'> {
    return {
      storeRealmId,
      artifactSha256: descriptor.captured.sha256,
      observationId: descriptor.id,
      revision: `${descriptor.captured.sha256}@g${descriptor.authority.grantRevision}`,
      representation: 'bytes',
      query: 'bytes:64',
      position,
      ownerScope: scope,
      watermark: descriptor.source.acquiredAt,
    }
  }

  it('refuses a CORRECTLY SIGNED cursor claiming a position the host never minted', async () => {
    // THE DEFECT'S OWN CASE. The host minted position 64; the caller asks for 500 and
    // signs it with the key re-derived from the PUBLIC descriptor. Before the fix this
    // was accepted and returned the payload's bytes at 500.
    const root = tempRoot('s16-forge-position')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('s16-forge-position-store')
    const capture = await captureInto(root, plane, 'obs-s16-forge')
    const descriptor = capture.descriptor

    // POSITIVE CONTROLS, hard-asserted OUTSIDE the refusal assertion. A pager that
    // refused everything would satisfy the arm below and be useless, so the honest
    // walk is established first: page 1 works, and its cursor resumes at 64.
    const first = await pages(plane.store, {
      descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope,
    })
    expect(first.offset).toBe(0)
    const honest = await pages(plane.store, {
      descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope, cursor: first.nextCursor ?? '',
    })
    expect(honest.offset).toBe(64)
    // And the bytes really are the artifact's at that offset, so the control is about
    // content and not merely about a call returning.
    expect(Buffer.from(honest.bytes)).toEqual(PAYLOAD.subarray(64, 128))

    // The MAC-failure control: a SORTED-key token with the same key material. It is
    // refused, and that refusal is NOT evidence about the key -- it is a malformed
    // token. Kept so the block cannot be read as "any refusal proves the fix".
    const realmOf = await plane.store.realmId
    const sorted = (() => {
      const full: Record<string, unknown> = {
        ...boundFields(descriptor, realmOf, plane.scope, 500),
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
      }
      const ordered: Record<string, unknown> = {}
      for (const key of Object.keys(full).sort()) ordered[key] = full[key]
      const payload = Buffer.from(JSON.stringify(ordered), 'utf8').toString('base64url')
      return `${payload}.${createHmac('sha256', oldPublicDerivation(descriptor)).update(payload).digest('base64url')}`
    })()
    await expect(pages(plane.store, {
      descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope, cursor: sorted,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })

    // THE ARM. Correctly signed in the host's own canonical form, with the OLD key.
    const forged = mintWithKey(
      oldPublicDerivation(descriptor),
      boundFields(descriptor, await plane.store.realmId, plane.scope, 500),
      OBSERVATION_SCHEMA_VERSION,
    )
    await expect(pages(plane.store, {
      descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope, cursor: forged,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
    // Named so the failure mode is unambiguous: the MAC is what refused it, not a
    // binding that happens to differ.
    await expect(pages(plane.store, {
      descriptor, maxBytes: 64, grants: plane.grants, callerScope: plane.scope, cursor: forged,
    })).rejects.toThrow(/MAC does not verify/u)
  })

  it('refuses a CORRECTLY SIGNED cursor claiming ANOTHER store\u2019s realm, without naming a realm back', async () => {
    // THE SECOND FORGEABLE FIELD. `storeRealmId` was compared only against the
    // store's own value, and that value is readable from a refusal message, so a
    // caller could obtain it and sign a token naming it. Before the fix store B
    // accepted such a token and served its pages.
    const root = tempRoot('s16-forge-realm')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('s16-forge-realm-a')
    const planeB = makePlane('s16-forge-realm-b')
    const captureA = await captureInto(root, planeA, 'obs-s16-realm-a')
    await captureInto(root, planeB, 'obs-s16-realm-b')
    const descriptor = captureA.descriptor

    // POSITIVE CONTROLS, hard-asserted: A's honest cursor is served by A, and the
    // same cursor is refused by B. R7's own arm HOLDS and is not what this arm tests.
    const firstA = await pages(planeA.store, {
      descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    const sameStore = await pages(planeA.store, {
      descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })
    expect(sameStore.offset).toBe(64)
    await expect(pages(planeB.store, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })

    // THE ARM: B's OWN realm, correctly signed by the caller with the public key.
    const forged = mintWithKey(
      oldPublicDerivation(descriptor),
      boundFields(descriptor, await planeB.store.realmId, planeA.scope, 64),
      OBSERVATION_SCHEMA_VERSION,
    )
    await expect(pages(planeB.store, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: forged,
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })

    // THE DISCLOSURE ARM, and the reason the refusal path classifies rather than
    // prints. A request whose MAC FAILED is unauthenticated, so answering it must not
    // name the serving store's realm: doing so would hand B's realm to anyone who can
    // send a garbage token, which is the amplifier that made the old cross-store
    // forgery need no prior knowledge. Asserted as "no realm id in the message".
    await expect(pages(planeB.store, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: forged,
    })).rejects.toThrow(/^(?!.*realm_[0-9a-fA-F-]{36}).*$/su)
  })

  it('keeps the old public derivation from being the key at all, so the fix is not a coincidence', async () => {
    // A refusal could in principle come from a binding rather than from the key. This
    // asserts the stronger, direct property: the store's key is NOT the value the
    // old derivation produces, and it does not CONTAIN any of the four descriptor
    // fields. A key built from those fields is a key a caller can build.
    const root = tempRoot('s16-key-provenance')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const plane = makePlane('s16-key-provenance-store')
    const capture = await captureInto(root, plane, 'obs-s16-provenance')
    const descriptor = capture.descriptor
    const key = await plane.store.cursorKey()

    expect(key).not.toBe(oldPublicDerivation(descriptor))
    // Only the fields long enough for a substring test to MEAN anything. A single
    // character like the grant revision `1` occurs by chance in any base64url string,
    // so asserting "the key does not contain '1'" would be a test that fails for a
    // reason unrelated to the property -- the same trap as a sorted-key token being
    // refused for the wrong reason.
    for (const part of [
      descriptor.id,
      descriptor.captured.sha256,
      descriptor.authority.ownerScope,
    ]) {
      expect(part.length).toBeGreaterThan(3)
      expect(key).not.toContain(part)
    }
    // And it is not a digest of the descriptor either: a hash of public data is
    // public. Compared against the two plausible ways to "derive" it.
    expect(key).not.toBe(sha256(Buffer.from(oldPublicDerivation(descriptor), 'utf8')))
    expect(key).not.toBe(sha256(Buffer.from(descriptor.captured.sha256, 'utf8')))
  })
})

// ---------------------------------------------------------------------------
// S16: THE REALM CHECK'S LIVE ARM — two stores that SHARE a cursor key.
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK IS NECESSARY NOW. Before the fix, a cursor from store A reached
// store B's realm comparison, so R7's arm 3 exercised that check. After the fix the
// keys differ, so a cross-store token is refused at STEP 1 (the MAC) and the realm
// comparison is never reached by that stimulus. The check is still load-bearing --
// it is what separates two stores that share a key -- but a suite that only ever
// presents differently-keyed tokens would leave it unexercised, which is how a guard
// becomes decorative.
//
// THE SHARED-KEY CASE IS NOT HYPOTHETICAL. It is what a whole-root clone produces
// (both `store-realm.json` and `store-cursor-key.json` copied), what a deployment
// that provisions one key into two roots produces, and what the `before` probe's
// `realmCopyAfter` arm measured when the realm alone was copied. This block
// constructs it by copying the KEY file only, so the realms still DIFFER and the
// realm comparison is the only thing left that can refuse.
describe('DATA-11 [real] the realm binding still refuses when two stores SHARE a cursor key', () => {
  it('refuses a shared-key cursor minted for a different realm, so the realm check is not dead code', async () => {
    const root = tempRoot('s16-shared-key')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('s16-shared-key-a')
    const planeB = makePlane('s16-shared-key-b')
    const captureA = await captureInto(root, planeA, 'obs-s16-shared-a')
    await captureInto(root, planeB, 'obs-s16-shared-b')
    const descriptor = captureA.descriptor

    const firstA = await pages(planeA.store, {
      descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    expect(firstA.nextCursor).toBeDefined()

    // POSITIVE CONTROL before the copy: the keys differ, so the refusal is the MAC.
    expect(await planeA.store.cursorKey()).not.toBe(await planeB.store.cursorKey())
    await expect(pages(planeB.store, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })

    // THE STIMULUS: B adopts A's KEY, and only the key. Its realm is its own.
    copyFileSync(
      join(planeA.store.root, STORE_CURSOR_KEY_FILE_NAME),
      join(planeB.store.root, STORE_CURSOR_KEY_FILE_NAME),
    )
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: planeB.home })
    const planeBShared = new AttachmentArtifactStore(ctx.attachments, planeB.indexRoot)

    // The two stores now agree on the key and disagree on the realm, which is exactly
    // the case the realm comparison exists for.
    expect(await planeBShared.cursorKey()).toBe(await planeA.store.cursorKey())
    expect(await planeBShared.ensureRealm()).not.toBe(await planeA.store.ensureRealm())

    // THE ARM. A's cursor now verifies under B's key and MUST still be refused, by
    // the realm, naming both realms so the diagnosis is actionable. Driven through
    // the PRODUCTION recording provider, so the oracle's second clause ("the refusal
    // is recorded") is exercised rather than asserted about a sink nobody mounted.
    const provider = new RecordingPageProvider(
      new ArtifactStorePageProvider(planeBShared),
      mountRefusalRecording(planeBShared),
    )
    await expect(provider.next({
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied', realmRefused: true })
    await expect(pages(planeBShared, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toThrow(/store realm/u)

    // AND THE REFUSAL IS RECORDED, which is the oracle's second clause: a shared key
    // must not make a cross-realm replay silent.
    const recorded = await planeBShared.readRefusals()
    expect(recorded).toHaveLength(1)
    expect(recorded.every(entry => entry.code === 'pagination-realm-denied' && entry.step === 'realm')).toBe(true)
    // The recorded refusal names BOTH realms, because the MAC verified and the caller
    // legitimately holds another store's cursor: the diagnosis is worth the disclosure
    // here, which is the opposite of the unauthenticated path above.
    expect(recorded[0]?.cursorRealmId).toBe(await planeA.store.ensureRealm())
    expect(recorded[0]?.storeRealmId).toBe(await planeBShared.ensureRealm())
  })

  it('does not let a copied REALM alone make a store accept another store\u2019s cursors (D-2)', async () => {
    // D-2, re-measured under the fix. Before it, one `copyFileSync` of a 3-line JSON
    // file made store B accept store A's cursors and serve A's pages, because the
    // realm was the only store identity there was. The fix makes the KEY a second,
    // independent identity, so a copied realm is no longer sufficient.
    //
    // WHAT THIS DOES NOT CLAIM: copying BOTH files still works, and that is measured
    // in `s16-after.json` (`wholeRootCloneAfter`). A caller who can write both files
    // has the store. The honest statement is that the realm file alone is no longer
    // enough, not that the store root is tamper-proof.
    const root = tempRoot('s16-realm-copy')
    writeFileSync(join(root, 'p.bin'), PAYLOAD)
    const planeA = makePlane('s16-realm-copy-a')
    const planeB = makePlane('s16-realm-copy-b')
    const captureA = await captureInto(root, planeA, 'obs-s16-copy-a')
    await captureInto(root, planeB, 'obs-s16-copy-b')
    const descriptor = captureA.descriptor

    const firstA = await pages(planeA.store, {
      descriptor, maxBytes: 64, grants: planeA.grants, callerScope: planeA.scope,
    })
    // POSITIVE CONTROL: before the copy, B refuses.
    await expect(pages(planeB.store, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-realm-denied' })

    // THE ATTACK: one file copy, no crypto.
    copyFileSync(
      join(planeA.store.root, STORE_REALM_FILE_NAME),
      join(planeB.store.root, STORE_REALM_FILE_NAME),
    )
    const ctx = new Context()
    new AttachmentLocal(ctx, { dshHome: planeB.home })
    const planeBAfter = new AttachmentArtifactStore(ctx.attachments, planeB.indexRoot)
    // B really did adopt A's realm, so the arm is about the KEY and not about a copy
    // that silently failed.
    expect(await planeBAfter.ensureRealm()).toBe(await planeA.store.ensureRealm())

    // THE ARM: the realm now matches and the cursor is still refused, because the KEY
    // does not. The refusal is a MAC failure, which is the stronger step.
    await expect(pages(planeBAfter, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toMatchObject({ code: 'pagination-cursor-invalid' })
    await expect(pages(planeBAfter, {
      descriptor, maxBytes: 64, grants: planeB.grants, callerScope: planeA.scope, cursor: firstA.nextCursor ?? '',
    })).rejects.toThrow(/MAC does not verify/u)
  })
})
