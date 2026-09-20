/**
 * The durable bridge ledger: what became of every exact native call a cell made.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A SESSION EVENT.
 *
 * `BR-07`'s oracle requires that every in-flight call carry one disposition from
 * `settled` / `cancelled` / `handed-to-jobs` / `abandoned-unstarted`, that a call
 * handed to Jobs name its job id, and that "nothing continues silently in the
 * background with no record". The bridge route had the DRAIN and not the RECORD:
 * a `revoke` waited 1499 ms for an in-flight call and then reported nothing about
 * what became of it, so a reader could not tell settled from cancelled from
 * abandoned. That is `G-SEAM-54` and it is why `BR-07` was the one BR case that
 * failed while the other eleven passed.
 *
 * The vocabulary is NOT invented here. `packages/dsh-daily-work/src/
 * programmatic-scope.ts` already implements these exact four dispositions with a
 * `jobId` on the handoff arm, and this module mirrors its semantics deliberately
 * so the repository has ONE vocabulary rather than two. The names, the
 * `jobId`-exactly-when-handed rule, and the "every submitted call reports exactly
 * one" accounting property are copied from there.
 *
 * WHY A STORAGE DOMAIN AND NOT `Session.append`. V3 §J6 and the shared brief's
 * §5.14 state the release limitation exactly: at this pinned release public
 * `Session.append(...)` does NOT expose the `ignorable` option, so a downstream
 * non-surface plugin MUST NOT append custom durable event types
 * (`ipython/native-call-*`) — a reader that cannot skip an unknown event is a
 * reader that breaks on reload. `tool/ptc-dispatch-*` and `feedback/record` are
 * forbidden substitutes for the same reason. The project's own answer, already
 * used by `dsh-daily-work` for its run record, its effects and its data plane, is
 * the DSH storage-domain bridge over the same JSON backend the profile mounts.
 * This module adds a domain; it does NOT add a second SQLite database.
 *
 * WHAT THIS LEDGER IS, IN THE ARCHITECTURE'S OWN WORDS. Session remains
 * conversation/turn occurrence truth. This is a CORRELATED AUXILIARY OCCURRENCE
 * LEDGER keyed by Session id, outer call id and subcall id — the three keys the
 * brief names — so a reader holding a Session can find what the program did
 * without the Session having to learn a new event type.
 *
 * THE CRASH-CONSISTENCY ORDER, WHICH IS THE POINT OF THE `STARTED` ROW.
 *
 *     STARTED  -> durably recorded BEFORE any mutating dispatch
 *     SETTLED  -> durably recorded AFTER the final ToolRuntime result
 *
 * A crash between the two leaves `STARTED` with no `SETTLED`, and that is a
 * resting state rather than an error to retry: the ledger reports
 * `OUTCOME_UNKNOWN` and the same mutating logical operation is never
 * automatically dispatched again. Reconciliation stays tool/effect-specific,
 * exactly as `dsh-daily-work`'s own effect ledger already does it. This module
 * does NOT claim exactly-once external effects — no mechanism here could.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createHash } from 'node:crypto'
import { z } from 'zod'

/** The domain name. Doubles as the backend unit name, so it must match `UNIT_NAME_RE`. */
export const BRIDGE_LEDGER_DOMAIN_NAME = 'dsh_ipython_bridge_ledger'

/**
 * The ledger schema version.
 *
 * A change here requires an offline conversion or a new namespace with an
 * explicit cutover. The storage domain does not migrate for us, and reading an
 * older shape as if it were current is what the version exists to prevent.
 */
export const BRIDGE_LEDGER_SCHEMA_VERSION = 1

/**
 * One call's disposition. The four arms are the oracle's own words, and the
 * meaning of each is copied from `programmatic-scope.ts` rather than re-decided:
 *
 * - `settled`            the call finished before the close began.
 * - `cancelled`          it was in flight when the lease closed and settled under the abort.
 * - `handed-to-jobs`     it had not started and a host handoff took ownership of it.
 * - `abandoned-unstarted` it had not started and no handoff existed, so it was refused.
 */
export const BRIDGE_DISPOSITIONS = ['settled', 'cancelled', 'handed-to-jobs', 'abandoned-unstarted'] as const
export type BridgeDisposition = typeof BRIDGE_DISPOSITIONS[number]

/** Why a lease closed; recorded on every disposition, as the scope route records its close reason. */
export const BRIDGE_CLOSE_REASONS = ['completed', 'aborted', 'error'] as const
export type BridgeCloseReason = typeof BRIDGE_CLOSE_REASONS[number]

/**
 * One exact call's durable intent-and-settlement row.
 *
 * `STARTED` and `SETTLED` are the SAME row updated in place, keyed by subcall id,
 * rather than two rows: the pair is one logical occurrence, and two keys would
 * give a reader two things to disagree about. What makes the crash window
 * visible is precisely that `settledAt` is absent on a `STARTED` row.
 */
export const bridgeCallRecordSchema = z.object({
  /** Host-minted, e.g. `<outerCallId>:ipython:<n>`. The ledger's primary key. */
  subCallId: z.string().min(1),
  sessionId: z.string().min(1),
  kernelEpoch: z.number().int().min(0),
  cellId: z.string().min(1),
  /** The outer model `ipython` execution this call was made on behalf of. */
  outerCallId: z.string().min(1),
  rootCallId: z.string().min(1),
  /** The protocol-level request id Python chose. NOT the subcall id, deliberately. */
  requestId: z.string().min(1),
  /** Digest of the losslessly normalized arguments, so a replay can be detected. */
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  name: z.string().min(1),
  /** Host clock, ISO-8601. Written BEFORE any mutating dispatch. */
  startedAt: z.string().min(1),
  /** Host clock, ISO-8601. ABSENT means the crash window: the outcome is unknown. */
  settledAt: z.string().optional(),
  isError: z.boolean().optional(),
  /** Digest of the delivered canonical value or the error identity. Never the value. */
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** Byte count of the canonical JSON, so an oversized result is visible without its content. */
  resultBytes: z.number().int().min(0).optional(),
  /**
   * Where an oversized result was retained. An Artifact ref, never the bytes
   * themselves: the brief forbids logging unbounded content into this ledger.
   */
  artifactRef: z.string().optional(),
  /** The single disposition this call carries. Present once the lease has closed the call. */
  disposition: z.enum(BRIDGE_DISPOSITIONS).optional(),
  /** Present exactly when `disposition` is `handed-to-jobs`. */
  jobId: z.string().optional(),
  /** The lease close classification, when this call's disposition came from a close. */
  closeReason: z.enum(BRIDGE_CLOSE_REASONS).optional(),
})

export type BridgeCallRecord = z.infer<typeof bridgeCallRecordSchema>

/** The domain: one table, keyed by subcall id. */
export const bridgeLedgerDomainSpec = defineDomain({
  name: BRIDGE_LEDGER_DOMAIN_NAME,
  version: BRIDGE_LEDGER_SCHEMA_VERSION,
  global: {
    schema: z.object({ initialized: z.boolean() }),
    initial: { initialized: false },
  },
  tables: {
    calls: domainTable<string, BridgeCallRecord>(bridgeCallRecordSchema),
  },
})

/**
 * Losslessly normalize a value to its canonical JSON text.
 *
 * THE ORDERING RULE IS THE REASON THIS IS NOT `JSON.stringify`. The ledger's
 * `argsDigest` must identify the ARGUMENTS, not the order a caller happened to
 * write their keys in, or the same logical call submitted twice would look like
 * two different calls. Object keys are therefore sorted; array order is
 * preserved, because an array's order IS part of its meaning.
 *
 * A value that does not survive a JSON round trip is refused rather than
 * stringified into something that only looks canonical: `undefined`, a function
 * and a `BigInt` would each silently become `null` or throw inside
 * `JSON.stringify`, and a digest over a fabricated representation is worse than
 * no digest at all.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const walk = (node: unknown, path: string): string => {
    if (node === null) return 'null'
    const type = typeof node
    if (type === 'string') return JSON.stringify(node)
    if (type === 'boolean') return String(node)
    if (type === 'number') {
      if (!Number.isFinite(node as number)) {
        throw new Error(`bridge ledger: ${path} is ${String(node)}, which has no JSON representation`)
      }
      return String(node)
    }
    if (type === 'bigint' || type === 'function' || type === 'symbol' || type === 'undefined') {
      throw new Error(`bridge ledger: ${path} is a ${type}, which does not survive a JSON round trip`)
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) throw new Error(`bridge ledger: ${path} is a cycle`)
      seen.add(node)
      const out = `[${node.map((item, index) => walk(item, `${path}[${String(index)}]`)).join(',')}]`
      seen.delete(node)
      return out
    }
    if (type === 'object') {
      const record = node as Record<string, unknown>
      if (seen.has(record)) throw new Error(`bridge ledger: ${path} is a cycle`)
      seen.add(record)
      const keys = Object.keys(record).sort()
      const out = `{${keys.map(key => `${JSON.stringify(key)}:${walk(record[key], `${path}.${key}`)}`).join(',')}}`
      seen.delete(record)
      return out
    }
    throw new Error(`bridge ledger: ${path} has an unsupported type`)
  }
  return walk(value, '$')
}

/** The digest the ledger stores for one normalized value. */
export function digestOf(value: unknown): { digest: string, bytes: number, text: string } {
  const text = canonicalJson(value)
  return {
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    text,
  }
}

/**
 * The durable ledger handle.
 *
 * Every write here is awaited by the caller on the production critical path, so
 * `STARTED` really is durable before a mutating dispatch rather than merely
 * scheduled. A ledger that buffered would make the crash window unobservable,
 * which is the one thing the `STARTED` row exists to make observable.
 */
export interface BridgeLedger {
  /** Record the intent, BEFORE any mutating dispatch. */
  started(record: Omit<BridgeCallRecord, 'startedAt' | 'settledAt' | 'isError' | 'resultDigest' | 'resultBytes' | 'artifactRef' | 'disposition' | 'jobId' | 'closeReason'>): Promise<void>
  /** Record the settlement, AFTER the final ToolRuntime result is known. */
  settled(subCallId: string, settlement: {
    isError: boolean
    resultDigest: string
    resultBytes: number
    artifactRef?: string
  }): Promise<void>
  /** Record the disposition. Exactly one per submitted call, by construction of the caller. */
  disposed(subCallId: string, disposition: BridgeDisposition, extra?: { jobId?: string, closeReason?: BridgeCloseReason }): Promise<void>
  /** One row, for a reader that holds a subcall id. */
  get(subCallId: string): BridgeCallRecord | undefined
  /** Every row for one outer call, in submission order. */
  forOuterCall(outerCallId: string): BridgeCallRecord[]
  /** Every row for one session, newest epoch first. */
  forSession(sessionId: string): BridgeCallRecord[]
  /**
   * Rows that were STARTED and never SETTLED: the crash window, reported as
   * `OUTCOME_UNKNOWN` rather than as a failure. Never auto-replayed by this
   * module or any caller of it.
   */
  unknownOutcomes(): BridgeCallRecord[]
  /** Every row, for audit. */
  all(): BridgeCallRecord[]
}

/** The in-process ledger. Used by tests and by a host that has no domain open. */
export class MemoryBridgeLedger implements BridgeLedger {
  private readonly rows = new Map<string, BridgeCallRecord>()

  started(record: Parameters<BridgeLedger['started']>[0]): Promise<void> {
    this.rows.set(record.subCallId, { ...record, startedAt: new Date().toISOString() })
    return Promise.resolve()
  }

  settled(subCallId: string, settlement: Parameters<BridgeLedger['settled']>[1]): Promise<void> {
    const current = this.rows.get(subCallId)
    if (current === undefined) {
      return Promise.reject(new Error(`bridge ledger: no STARTED row for ${subCallId}; a settlement without an intent is not a settlement`))
    }
    this.rows.set(subCallId, {
      ...current,
      settledAt: new Date().toISOString(),
      isError: settlement.isError,
      resultDigest: settlement.resultDigest,
      resultBytes: settlement.resultBytes,
      ...settlement.artifactRef === undefined ? {} : { artifactRef: settlement.artifactRef },
    })
    return Promise.resolve()
  }

  disposed(subCallId: string, disposition: BridgeDisposition, extra: Parameters<BridgeLedger['disposed']>[2] = {}): Promise<void> {
    const current = this.rows.get(subCallId)
    if (current === undefined) {
      return Promise.reject(new Error(`bridge ledger: no row for ${subCallId}; a disposition for an unknown call is a fabrication`))
    }
    if (current.disposition !== undefined) {
      return Promise.reject(new Error(`bridge ledger: ${subCallId} already carries disposition ${current.disposition}; a call reports exactly one`))
    }
    if (disposition === 'handed-to-jobs' && extra.jobId === undefined) {
      return Promise.reject(new Error(`bridge ledger: ${subCallId} is handed-to-jobs with no job id; the oracle requires the job to be named`))
    }
    if (disposition !== 'handed-to-jobs' && extra.jobId !== undefined) {
      return Promise.reject(new Error(`bridge ledger: ${subCallId} carries a job id with disposition ${disposition}; only handed-to-jobs names a job`))
    }
    this.rows.set(subCallId, {
      ...current,
      disposition,
      ...extra.jobId === undefined ? {} : { jobId: extra.jobId },
      ...extra.closeReason === undefined ? {} : { closeReason: extra.closeReason },
    })
    return Promise.resolve()
  }

  get(subCallId: string): BridgeCallRecord | undefined {
    return this.rows.get(subCallId)
  }

  forOuterCall(outerCallId: string): BridgeCallRecord[] {
    return [...this.rows.values()].filter(row => row.outerCallId === outerCallId)
  }

  forSession(sessionId: string): BridgeCallRecord[] {
    return [...this.rows.values()].filter(row => row.sessionId === sessionId)
  }

  unknownOutcomes(): BridgeCallRecord[] {
    return [...this.rows.values()].filter(row => row.settledAt === undefined)
  }

  all(): BridgeCallRecord[] {
    return [...this.rows.values()]
  }
}

/**
 * The ledger backed by the DSH storage domain.
 *
 * The domain is the durable medium an extension can actually reach, and it is
 * the SAME facility the profile already mounts for the run record and the data
 * plane. `put` resolves only after the backend's write chain accepted the row,
 * which is what makes `STARTED`-before-dispatch an ordering claim rather than a
 * scheduling hope.
 */
export class StorageBridgeLedger implements BridgeLedger {
  private readonly domain: Domain<typeof bridgeLedgerDomainSpec>

  constructor(domain: Domain<typeof bridgeLedgerDomainSpec>) {
    this.domain = domain
  }

  private get table(): { get(key: string): BridgeCallRecord | undefined, put(key: string, value: BridgeCallRecord): Promise<void>, entries(): IterableIterator<[string, BridgeCallRecord]> } {
    return this.domain.table('calls')
  }

  async started(record: Parameters<BridgeLedger['started']>[0]): Promise<void> {
    await this.table.put(record.subCallId, { ...record, startedAt: new Date().toISOString() })
  }

  async settled(subCallId: string, settlement: Parameters<BridgeLedger['settled']>[1]): Promise<void> {
    const current = this.table.get(subCallId)
    if (current === undefined) {
      throw new Error(`bridge ledger: no STARTED row for ${subCallId}; a settlement without an intent is not a settlement`)
    }
    await this.table.put(subCallId, {
      ...current,
      settledAt: new Date().toISOString(),
      isError: settlement.isError,
      resultDigest: settlement.resultDigest,
      resultBytes: settlement.resultBytes,
      ...settlement.artifactRef === undefined ? {} : { artifactRef: settlement.artifactRef },
    })
  }

  async disposed(subCallId: string, disposition: BridgeDisposition, extra: Parameters<BridgeLedger['disposed']>[2] = {}): Promise<void> {
    const current = this.table.get(subCallId)
    if (current === undefined) {
      throw new Error(`bridge ledger: no row for ${subCallId}; a disposition for an unknown call is a fabrication`)
    }
    if (current.disposition !== undefined) {
      throw new Error(`bridge ledger: ${subCallId} already carries disposition ${current.disposition}; a call reports exactly one`)
    }
    if (disposition === 'handed-to-jobs' && extra.jobId === undefined) {
      throw new Error(`bridge ledger: ${subCallId} is handed-to-jobs with no job id; the oracle requires the job to be named`)
    }
    if (disposition !== 'handed-to-jobs' && extra.jobId !== undefined) {
      throw new Error(`bridge ledger: ${subCallId} carries a job id with disposition ${disposition}; only handed-to-jobs names a job`)
    }
    await this.table.put(subCallId, {
      ...current,
      disposition,
      ...extra.jobId === undefined ? {} : { jobId: extra.jobId },
      ...extra.closeReason === undefined ? {} : { closeReason: extra.closeReason },
    })
  }

  get(subCallId: string): BridgeCallRecord | undefined {
    return this.table.get(subCallId)
  }

  forOuterCall(outerCallId: string): BridgeCallRecord[] {
    return [...this.table.entries()].map(([, row]) => row).filter(row => row.outerCallId === outerCallId)
  }

  forSession(sessionId: string): BridgeCallRecord[] {
    return [...this.table.entries()].map(([, row]) => row).filter(row => row.sessionId === sessionId)
  }

  unknownOutcomes(): BridgeCallRecord[] {
    return [...this.table.entries()].map(([, row]) => row).filter(row => row.settledAt === undefined)
  }

  all(): BridgeCallRecord[] {
    return [...this.table.entries()].map(([, row]) => row)
  }
}

/**
 * Open the ledger over the storage facility the profile already mounts.
 *
 * A caller that has no facility open gets `undefined` rather than a thrown
 * error: the bridge must still work in a composition that mounts no storage
 * (a test host, a minimal profile), and refusing to bridge because a ledger is
 * unavailable would turn a provenance gap into a capability outage. The caller
 * decides, and `KernelService` records which it got.
 */
export async function openBridgeLedger(facility: DomainFacility | undefined): Promise<{ ledger: BridgeLedger, durable: boolean } | undefined> {
  if (facility === undefined) return undefined
  const domain = await facility.open(bridgeLedgerDomainSpec)
  return { ledger: new StorageBridgeLedger(domain), durable: true }
}

/** The storage facility a host context carries, when one is mounted. */
export function storageFacilityOf(ctx: Context): DomainFacility | undefined {
  return ctx.get('storageDomain') as DomainFacility | undefined
}
