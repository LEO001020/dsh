/**
 * Deployment-boundary home lock: a KERNEL-held exclusive lock over one store.
 *
 * WHY THIS FILE REPLACES THE PREVIOUS PROTOCOL. The old implementation was
 * read -> confirm-holder-dead -> rename-aside -> link-new. That sequence has a
 * legal interleaving in which two contenders BOTH win:
 *
 *     A and B both read the lock and both observe the same dead holder.
 *     A: rename(stale aside) -> link(A) -> returns success.
 *     B: rename(...) -> this moves A's LIVE lock aside -> link(B) -> success.
 *
 * `rename` binds to the NAME, never to the identity B observed earlier, so B
 * cannot tell that the file it moved was published after its read. This was
 * reproduced independently on this machine (`qualification/results/
 * M10.0-audit-repro/stale_lock_windows.py`): both contenders returned success and
 * the final owner was the second one. Two hosts over one store then silently lose
 * the loser's writes, because DSH storage has no cross-process write locking.
 *
 * The fix is not a retry, a delay, or a TTL. It is to stop making a REPLACEABLE
 * FILE the mutual-exclusion object:
 *
 *   - Windows: a named kernel semaphore (`CreateSemaphoreW` + zero-timeout wait).
 *     The object is keyed by a hash of the RESOLVED PATH, so there is no inode and
 *     no directory entry to swap — the interleaving above has no equivalent.
 *   - POSIX: `flock` on a descriptor, then verify the locked inode is still the
 *     file at the lock path and retry otherwise. This mirrors the discipline
 *     `@deepseek-ai/dsh-session-persistence-jsonl` already uses in `lease.ts`,
 *     including its refusal to remove the lock file on release (keeping the inode
 *     stable is what later lockers verify against).
 *
 * The kernel releases the lock when the holder's handle closes, INCLUDING on any
 * process death. A crashed holder therefore never blocks a successor, which is
 * why no PID/TTL heuristic is needed — and why the old `holderProvenGone` pid
 * probe is no longer part of the exclusion decision.
 *
 * The identity file is ADVISORY. It exists so a refusal can name the current
 * holder for a human. It is deliberately NOT the exclusion mechanism: if it were,
 * a stale or unreadable file would again be able to hand the store to a second
 * host. Nothing in the acquire path trusts it.
 *
 * SCOPE, stated so it is not overread: this excludes a second host on the SAME
 * MACHINE. The Windows semaphore lives in the local session namespace, and a
 * store shared across machines (a network path) is not covered by either path.
 * That limit is real and is reported rather than implied.
 *
 * @module dsh-daily-work/homelock
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { hostname } from 'node:os'

/** Who holds the lock, written only so a refusal can name them. */
export interface HomeLockIdentity {
  readonly pid: number
  readonly hostname: string
  readonly startedAt: string
  readonly token: string
}

/** A held lock. `release` is idempotent and is the only way to give it up. */
export interface HeldHomeLock {
  /** The advisory identity this holder published, when it could be written. */
  readonly identity: HomeLockIdentity
  /** Whether the advisory note was written; a failure here never grants access. */
  readonly advisoryWritten: boolean
  release(): Promise<void>
}

/** Raised when another live host holds the store. */
export class HomeLockHeldError extends Error {
  readonly heldBy: HomeLockIdentity | 'unknown'

  constructor(message: string, heldBy: HomeLockIdentity | 'unknown') {
    super(message)
    this.name = 'HomeLockHeldError'
    this.heldBy = heldBy
  }
}

/**
 * Raised when the platform primitive this guard depends on is unavailable.
 *
 * This is a REFUSAL, not a fallback. Silently degrading to the old
 * read/rename protocol would reintroduce exactly the interleaving this module
 * exists to remove, and it would do so precisely on the machines least likely to
 * be tested.
 */
export class HomeLockUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HomeLockUnsupportedError'
  }
}

/** Windows `WaitForSingleObject` results this module distinguishes. */
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x00000102

/** Minimal Win32 surface, loaded lazily so non-Windows never touches koffi. */
interface Win32LockApi {
  createSemaphore(name: string): number
  wait(handle: number): number
  release(handle: number): void
  close(handle: number): void
  lastError(): number
}

let win32Api: Win32LockApi | undefined

/**
 * Load the Win32 semaphore API.
 *
 * `koffi` is a real dependency of the pinned checkout (it backs the session
 * backend's own Windows lock), so it is resolved from the checkout rather than
 * vendored. An unresolvable koffi is reported as unsupported instead of being
 * treated as "no lock needed".
 */
async function loadWin32(): Promise<Win32LockApi> {
  if (win32Api !== undefined) return win32Api
  let koffi: { load(name: string): { func(...args: unknown[]): unknown } }
  try {
    // Specifier held in a variable so TypeScript does not try to resolve a
    // module that is only present in the pinned checkout at runtime.
    const specifier = 'koffi'
    const mod = await import(specifier) as { default: typeof koffi }
    koffi = mod.default
  } catch (error) {
    throw new HomeLockUnsupportedError(
      'the home lock requires the "koffi" FFI module on Windows, which could not be imported '
      + `(${error instanceof Error ? error.message : String(error)}). Without it there is no kernel-held `
      + 'exclusion, and falling back to a file protocol would let two hosts both claim the store.',
    )
  }
  const kernel32 = koffi.load('kernel32.dll')
  const create = kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']) as
    (security: null, initial: number, maximum: number, name: string) => number
  const waitFor = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as
    (handle: number, ms: number) => number
  const releaseSem = kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']) as
    (handle: number, count: number, previous: null) => number
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as (handle: number) => number
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as () => number

  win32Api = {
    createSemaphore: name => create(null, 1, 1, name),
    wait: handle => waitFor(handle, 0),
    release: (handle) => { releaseSem(handle, 1, null) },
    close: (handle) => { closeHandle(handle) },
    lastError: getLastError,
  }
  return win32Api
}

/**
 * The kernel object name for a store path.
 *
 * Keyed by the RESOLVED path so two spellings of one directory collide (which is
 * the desired exclusion) and two different stores never do. `Local\` scopes it to
 * the logon session, which matches the documented same-machine scope.
 */
function semaphoreName(path: string): string {
  const digest = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex')
  return `Local\\dsh-daily-work-home-${digest}`
}

/** Whether an flock failure means another descriptor holds the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * Take an exclusive lock on the store.
 *
 * @param path - the store's lock path; its directory is created if absent.
 * @param now - timestamp source, injected so tests can be deterministic.
 * @returns the held lock, which must be released.
 * @throws {HomeLockHeldError} while another live host holds the store.
 * @throws {HomeLockUnsupportedError} when no kernel primitive is available.
 */
export async function acquireHomeLock(path: string, now: () => string = () => new Date().toISOString()): Promise<HeldHomeLock> {
  const identity: HomeLockIdentity = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: now(),
    token: createHash('sha256').update(`${process.pid}:${path}:${now()}:${Math.random()}`).digest('hex').slice(0, 32),
  }

  // The note is written only AFTER the kernel lock is held. Writing it first
  // would let a REFUSED acquirer overwrite the live holder's note, so the next
  // refusal would name the wrong process -- and a note written by a loser would
  // become the only record of an owner that is actually still running. The
  // kernel object decides exclusion; this note is only the error message.
  await mkdir(dirname(path), { recursive: true })
  const publishNote = async (): Promise<boolean> => {
    try {
      await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      // A note that cannot be written never grants access; it only makes a later
      // refusal less specific.
      return false
    }
  }

  if (process.platform === 'win32') {
    const api = await loadWin32()
    const handle = api.createSemaphore(semaphoreName(path))
    if (handle === 0) {
      throw new HomeLockUnsupportedError(
        `CreateSemaphoreW failed (Win32 ${api.lastError()}) for ${path}; refusing to open the store without `
        + 'kernel-held exclusion.',
      )
    }
    const wait = api.wait(handle)
    if (wait === WAIT_OBJECT_0) {
      return {
        identity,
        advisoryWritten: await publishNote(),
        release: async () => { api.release(handle); api.close(handle) },
      }
    }
    api.close(handle)
    if (wait === WAIT_TIMEOUT) throw new HomeLockHeldError(heldMessage(path, await readAdvisory(path)), await readAdvisory(path))
    throw new HomeLockUnsupportedError(`WaitForSingleObject failed (Win32 ${api.lastError()}) for ${path}.`)
  }

  // POSIX: lock a descriptor and verify the locked inode is still the file at the
  // path. A lock on an orphaned inode proves nothing, which is the ABA case.
  let flock: (fd: number) => Promise<void>
  try {
    const specifier = '@deepseek-ai/node-addon-system/flock'
    const mod = await import(specifier) as { tryLockExclusive(fd: number): Promise<void> }
    flock = fd => mod.tryLockExclusive(fd)
  } catch (error) {
    throw new HomeLockUnsupportedError(
      'the home lock requires @deepseek-ai/node-addon-system/flock on POSIX, which could not be imported '
      + `(${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle: FileHandle = await open(path, 'w')
    try {
      try {
        await flock(handle.fd)
      } catch (error) {
        if (isLockContention(error)) throw new HomeLockHeldError(heldMessage(path, await readAdvisory(path)), await readAdvisory(path))
        throw error
      }
      const held = await handle.stat({ bigint: true })
      const current = await stat(path, { bigint: true }).catch(() => undefined)
      if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
        return {
          identity,
          advisoryWritten: await publishNote(),
          release: async () => { await handle.close() },
        }
      }
    } catch (error) {
      await handle.close()
      throw error
    }
    // The locked inode is no longer the file at the path: retry against whatever
    // now stands there rather than trusting a lock on an orphan.
    await handle.close()
  }
  throw new HomeLockHeldError(heldMessage(path, await readAdvisory(path)), await readAdvisory(path))
}

/** Read the advisory identity, or `'unknown'` when it cannot be trusted. */
async function readAdvisory(path: string): Promise<HomeLockIdentity | 'unknown'> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<HomeLockIdentity>
    if (typeof parsed.pid === 'number' && typeof parsed.hostname === 'string' && typeof parsed.startedAt === 'string') {
      return { pid: parsed.pid, hostname: parsed.hostname, startedAt: parsed.startedAt, token: String(parsed.token ?? '') }
    }
  } catch {
    // A note we cannot read is not evidence about the holder, so it degrades to
    // "unknown" instead of being guessed at.
  }
  return 'unknown'
}

/** The refusal text, naming the holder when the advisory note allows it. */
function heldMessage(path: string, holder: HomeLockIdentity | 'unknown'): string {
  const who = holder === 'unknown'
    ? 'another process (its advisory note is missing or unreadable)'
    : `pid ${holder.pid} on ${holder.hostname} (since ${holder.startedAt})`
  return `dailyWork: refusing to open the work domain — the store is already owned by ${who}, recorded in ${path}. `
    + 'DSH storage has no cross-process write locking, so two hosts over one store silently lose the loser\'s '
    + 'writes. Stop the other host and retry; the lock is held by the kernel and is released automatically when '
    + 'that process exits, so there is no stale lock to delete by hand.'
}
