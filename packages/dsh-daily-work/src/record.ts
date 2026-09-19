/**
 * The durable run record.
 *
 * This is deliberately NOT a copy of a DSH Session. DSH already persists
 * Sessions, inboxes and artifacts. What DSH does not have is this project's
 * notion of a user-authorized run with a target N, a credit reservation, and a
 * per-task reconciliation relation.
 *
 * So the record holds only what nothing else holds:
 *   - the assignment (taskId -> reserved childId -> attempt)
 *   - the permission ceiling and policy digest
 *   - the credit reservation and spend
 *   - the outbox of notifications not yet delivered
 *   - the last reconciled refs, and tombstones for closed tasks
 *
 * Large payloads live in ordinary immutable artifacts and Sessions. The record
 * stores refs. Every field must be justified by a failure window it closes;
 * fields with no such justification get deleted.
 *
 * Record schemas are zod. Plugin Config stays schemastery. These are different
 * validators on purpose and must not be mixed.
 */
import { z } from 'zod'
import { ADMISSION_STATES } from './states.ts'

/**
 * A reference to evidence held elsewhere.
 *
 * `digest` is optional because not every source is content-addressable (a
 * Session event has a seq, not a hash). When it is present it is authoritative
 * and must be re-checked on read; when absent the ref is a pointer only and
 * must not be treated as proof of content.
 */
export const evidenceRefSchema = z.object({
  /** Where the evidence lives: 'session' | 'artifact' | 'file' | 'url'. */
  kind: z.string().min(1),
  /** Identifier within that kind (session id, artifact locator, path, URL). */
  id: z.string().min(1),
  /** Optional content digest. Absent means "pointer only, unverified". */
  digest: z.string().min(1).optional(),
  /** Free-form label for the model and for humans. */
  label: z.string().optional(),
})
export type EvidenceRef = z.infer<typeof evidenceRefSchema>

/**
 * One task's assignment.
 *
 * `childId` is reserved BEFORE launch and persisted, so a crash between the
 * reservation and the launch is recoverable without inventing a new identity.
 * That is what makes DUPLICATE_CHILD a reconciliation trigger rather than a
 * reason to retry with a fresh UUID.
 */
export const taskRecordSchema = z.object({
  taskId: z.string().min(1),
  /** Digest of the assignment as submitted. A changed digest is a new task. */
  assignmentDigest: z.string().min(1),
  /** Reserved before launch; never re-minted for the same taskId. */
  childId: z.string().min(1).optional(),
  /** 1-based. Increments only on an explicit, reconciled retry. */
  attempt: z.number().int().min(1),
  state: z.enum(ADMISSION_STATES),
  /** Capability classes this task may use: permission, not a cognitive role. */
  allowedCapabilities: z.array(z.string()),
  inputRefs: z.array(evidenceRefSchema),
  outputRefs: z.array(evidenceRefSchema),
  /** Cost reserved at admission, in the run's currency unit. */
  reservedCost: z.number().min(0),
  /** Cost actually attributed, when known. `undefined` means unknown, not zero. */
  spentCost: z.number().min(0).optional(),
  /** Why the state is `unknown`, when it is. */
  uncertainty: z.string().optional(),
  /** ISO-8601 timestamps for the timeline. */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type TaskRecord = z.infer<typeof taskRecordSchema>

/** One pending notification. `stage` moves pending -> sent -> acked. */
export const outboxEntrySchema = z.object({
  id: z.string().min(1),
  destination: z.string().min(1),
  payloadDigest: z.string().min(1),
  stage: z.enum(['pending', 'sent', 'acked']),
  createdAt: z.string(),
})
export type OutboxEntry = z.infer<typeof outboxEntrySchema>

/**
 * Budget accounting.
 *
 * `unknownReserved` is a separate field from `reserved` on purpose: a request
 * whose usage we never learned keeps a conservative reservation, and collapsing
 * it into `reserved` or into `spent` would hide a real gap.
 */
export const budgetSchema = z.object({
  currency: z.string().min(1),
  priceVersion: z.string().min(1),
  spent: z.number().min(0),
  reserved: z.number().min(0),
  unknownReserved: z.number().min(0),
  /** Hard ceiling authorized by the user. Top-up stops here, it does not degrade. */
  ceiling: z.number().min(0),
})
export type Budget = z.infer<typeof budgetSchema>

/**
 * The run phase.
 *
 * `paused` is resumable and is what a recovery without an explicit
 * restart-resume authorization produces. `closing` is the terminal wind-down.
 * There is no `drained` phase: drain is a DSH operation on the parent, not a
 * state this record invents.
 */
export const RUN_PHASES = [
  'open',
  'paused',
  'closing',
  'closed',
] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/**
 * The whole run. One bounded record per run.
 *
 * Written with a single `KvTable.update` pure transform so that task state,
 * budget and outbox move together. Writing task state and budget under
 * different keys and calling that atomic would be a lie: the domain gives
 * atomicity per record, not across keys.
 */
export const runRecordSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  /**
   * Monotonic run epoch. Bumped when a run is re-adopted by a new host
   * generation. A callback carrying a stale epoch must be rejected rather than
   * allowed to write authoritative state.
   */
  epoch: z.number().int().min(1),
  rootSessionId: z.string().min(1),
  /** Opaque reference to the user's authorization for this run. */
  authorizationRef: z.string().min(1),
  phase: z.enum(RUN_PHASES),
  /** The target N. Root is NOT part of this number. */
  requestedTarget: z.number().int().min(0),
  /** Max delegation depth granted to children. 1 forbids grandchildren. */
  maxDepth: z.number().int().min(0),
  /** ISO-8601, or absent for no deadline. */
  deadline: z.string().optional(),
  policyDigest: z.string().min(1),
  /**
   * Whether this run may continue after a host restart. Absent or false means
   * recovery comes back paused: reopening a Session does not re-authorize
   * unbounded background execution.
   */
  restartResumeAuthorized: z.boolean(),
  budget: budgetSchema,
  tasks: z.record(z.string(), taskRecordSchema),
  outbox: z.record(z.string(), outboxEntrySchema),
  lastReconciledRefs: z.array(evidenceRefSchema),
  /** Closed task ids kept so a late result cannot resurrect them. */
  terminalTombstones: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RunRecord = z.infer<typeof runRecordSchema>

/** A fresh record for a newly authorized run. */
export function initialRunRecord(input: {
  runId: string
  rootSessionId: string
  authorizationRef: string
  requestedTarget: number
  maxDepth: number
  policyDigest: string
  budget: Budget
  restartResumeAuthorized: boolean
  now: string
}): RunRecord {
  return {
    version: 1,
    runId: input.runId,
    epoch: 1,
    rootSessionId: input.rootSessionId,
    authorizationRef: input.authorizationRef,
    phase: 'open',
    requestedTarget: input.requestedTarget,
    maxDepth: input.maxDepth,
    policyDigest: input.policyDigest,
    restartResumeAuthorized: input.restartResumeAuthorized,
    budget: input.budget,
    tasks: {},
    outbox: {},
    lastReconciledRefs: [],
    terminalTombstones: [],
    createdAt: input.now,
    updatedAt: input.now,
  }
}
