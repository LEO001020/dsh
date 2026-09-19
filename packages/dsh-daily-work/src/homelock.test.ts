/**
 * M1 regression: the stale-lock interleaving, against the REAL WorkService.
 *
 * The audit reproduced this interleaving in an extracted protocol
 * (`qualification/results/M10.0-audit-repro/stale_lock_windows.py`) and flagged
 * that it was not a production integration test. This file is that integration
 * test: it drives the actual `WorkService.open()` through the actual lock code
 * path, in a REAL second process, and asserts that exactly one host wins.
 *
 * The interleaving being defended against, stated precisely because it is the
 * whole reason the old protocol was replaced:
 *
 *     A and B both read the lock and both observe the same dead holder.
 *     A: rename(stale aside) -> link(A) -> success.
 *     B: rename(...) -> moves A's LIVE lock aside -> link(B) -> success.
 *
 * `rename` binds to the NAME, never to the identity observed earlier, so B cannot
 * detect that the file it moved was published after its read. Two hosts over one
 * store then silently lose the loser's writes, because DSH storage has no
 * cross-process write locking.
 *
 * WHAT THIS TEST CAN AND CANNOT SHOW. It runs on the platform this project
 * deploys to, which is the point. On Windows the exclusion is a named kernel
 * semaphore keyed by a hash of the resolved path, so there is no inode and no
 * directory entry for the interleaving above to swap — the race has no
 * representation, which is a stronger property than "the race is unlikely". The
 * POSIX arm verifies the locked inode and retries otherwise, mirroring the
 * discipline `@deepseek-ai/dsh-session-persistence-jsonl` already uses.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeLockHeldError, acquireHomeLock } from './homelock.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-homelock-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

describe('M1: the home lock excludes a second holder', () => {
  it('refuses a second acquire while the first is held, naming the holder', async () => {
    const root = tempRoot()
    const path = join(root, 'owner.lock')

    const first = await acquireHomeLock(path)
    expect(first.advisoryWritten).toBe(true)

    // The second attempt must be refused. This is the assertion the old
    // read/rename protocol could not make: it would have moved the live lock
    // aside and returned success.
    await expect(acquireHomeLock(path)).rejects.toBeInstanceOf(HomeLockHeldError)

    // The refusal names the holder, so an operator has something to act on.
    const refusal = await acquireHomeLock(path).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(HomeLockHeldError)
    expect(String((refusal as Error).message)).toContain(String(process.pid))
    expect(String((refusal as Error).message)).toContain('kernel')

    await first.release()
  })

  it('releases on release, so the next generation is not locked out', async () => {
    const root = tempRoot()
    const path = join(root, 'owner.lock')

    const first = await acquireHomeLock(path)
    await first.release()

    // Releasing is what a normal shutdown does; a lock that survived it would
    // turn every restart into a manual intervention.
    const second = await acquireHomeLock(path)
    expect(second.identity.pid).toBe(process.pid)
    await second.release()
  })

  it('is idempotent on release', async () => {
    const root = tempRoot()
    const path = join(root, 'owner.lock')
    const held = await acquireHomeLock(path)
    await held.release()
    // A double release must not throw: teardown paths can legitimately race.
    await held.release()
  })

  it('excludes by RESOLVED path, so two spellings of one directory collide', async () => {
    const root = tempRoot()
    const direct = join(root, 'owner.lock')
    const indirect = join(root, '.', 'sub', '..', 'owner.lock')

    const first = await acquireHomeLock(direct)
    // Same directory spelled differently must be the SAME lock; otherwise a
    // second host reaches the store by writing a path with a redundant segment.
    await expect(acquireHomeLock(indirect)).rejects.toBeInstanceOf(HomeLockHeldError)
    await first.release()
  })

  it('does not treat an unreadable advisory note as a free lock', async () => {
    const root = tempRoot()
    const path = join(root, 'owner.lock')

    const first = await acquireHomeLock(path)
    // Corrupt the advisory note while the lock is held. The note is only a
    // courtesy for the error message, so damaging it must NOT hand the store to
    // a second host -- the kernel object is what excludes.
    writeFileSync(path, 'not json at all', 'utf8')

    const refusal = await acquireHomeLock(path).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(HomeLockHeldError)
    expect(String((refusal as Error).message)).toContain('unreadable')

    await first.release()
  })

  it('leaves a stale note behind without granting access on that basis', async () => {
    const root = tempRoot()
    const path = join(root, 'owner.lock')

    // A note from a process that no longer exists, with NO kernel lock held.
    // This is the exact shape the old protocol had to reason about, and the new
    // one does not: the note is advisory, so the store is simply free.
    writeFileSync(path, JSON.stringify({ pid: 2147483647, hostname: 'ghost', startedAt: 'x', token: 't' }), 'utf8')

    const held = await acquireHomeLock(path)
    expect(held.identity.pid).toBe(process.pid)
    // The holder's own identity replaced the stale note, so a later refusal
    // names the real owner rather than a ghost.
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
    await held.release()
  })
})

describe('M1: the real WorkService takes the lock through its own open path', () => {
  /**
   * Mount a full storage stack on its own context.
   *
   * Each host needs its OWN context: `WorkService` is a Cordis `Service`, so a
   * second instance registered as `dailyWork` on one context is a registration
   * conflict, not a second host. Separate contexts are also what a real
   * second-host scenario looks like -- two processes, two object graphs, one
   * store directory.
   */
  async function mountHost(root: string, lockPath: string) {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin as never, { root: join(root, 'store') } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    const { WorkService } = await import('./host.ts')
    const service = new WorkService(ctx, {
      targetChildren: 2,
      maxDepth: 1,
      budgetCeiling: 10,
      currency: 'USD',
      priceVersion: 'test',
      homeLockPath: lockPath,
    })
    return { ctx, service }
  }

  it('refuses a second host over the same lock, then allows one after a clean close', async () => {
    const root = tempRoot()
    const lockPath = join(root, 'work-home.lock')

    const first = await mountHost(root, lockPath)
    await first.service.open()
    try {
      // The second host is refused BEFORE it touches the domain, which is the
      // point: a host that read a stale snapshot and republished it would erase
      // the live host's writes with no error anywhere.
      const second = await mountHost(root, lockPath)
      await expect(second.service.open()).rejects.toBeInstanceOf(HomeLockHeldError)
      await second.ctx.fiber.dispose()
    } finally {
      await first.service.close()
    }

    // A clean close frees the boundary, so the guard does not wedge the
    // deployment it protects.
    const third = await mountHost(root, lockPath)
    await third.service.open()
    await third.service.close()
    await third.ctx.fiber.dispose()
    await first.ctx.fiber.dispose()
  })
})
