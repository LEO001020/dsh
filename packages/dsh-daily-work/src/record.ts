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
 * Why new admissions stopped, and when.
 *
 * This is deliberately NOT a run phase. A budget halt leaves `phase: 'open'`
 * and `requestedTarget` untouched, because neither fact became false: the user
 * still asked for N children and the run is still the user's. What changed is
 * that no further commitment is authorized until a human resolves it. Folding
 * a budget halt into `phase: 'paused'` would make a budget stop
 * indistinguishable from a user stop, and INV-G4 makes the user's stop outrank
 * top-up precisely because the two are not the same thing.
 *
 * A halt is sticky: it is set by the observation that produced it and cleared
 * only by `WorkService.resolveHalt`. A later in-budget spend must not clear it,
 * or a run that overspent once would quietly go green again.
 */
export const admissionHaltSchema = z.object({
  /** Checkable statement of what was observed, with the numbers in it. */
  reason: z.string().min(1),
  /** ISO-8601, when the halt was recorded. */
  at: z.string(),
})
export type AdmissionHalt = z.infer<typeof admissionHaltSchema>

/**
 * What the Goal handover did when a run was created.
 *
 * Stored because "exactly one continuation owner" is a claim a reader should be
 * able to CHECK rather than trust. The handover reports whether the durable
 * objective and its revision survived `disarm`, and whether a goal was present
 * at all; keeping that on the record makes a run's continuation state auditable
 * after the fact instead of only observable at creation time.
 *
 * Every field is required WITHIN this object, but the object itself is optional
 * on the record, so a record written before this field existed still validates
 * on read. Refusing to open such a record would be a migration the domain cannot
 * perform, and the honest answer for an old run is "the handover was not
 * recorded", not "the run is invalid".
 */
export const continuationHandoverSchema = z.object({
  goalPresent: z.boolean(),
  disarmed: z.boolean(),
  objectivePreserved: z.boolean().optional(),
  revisionUnchanged: z.boolean().optional(),
  phaseBefore: z.string().optional(),
  phaseAfter: z.string().optional(),
  activationAfter: z.string().optional(),
  note: z.string(),
})
export type ContinuationHandoverRecord = z.infer<typeof continuationHandoverSchema>

/**
 * Budget accounting.
 *
 * `unknownReserved` is a separate field from `reserved` on purpose: a request
 * whose usage we never learned keeps a conservative reservation, and collapsing
 * it into `reserved` or into `spent` would hide a real gap.
 *
 * INV-C5 (root reserve): `spent + reserved + unknownReserved` is the CHILD
 * commitment, and it may never exceed `ceiling - rootReserve`. The root
 * therefore always retains `rootReserve - rootSpent` of its own credit no
 * matter how many children are admitted, and no number of children can starve
 * it. `rootSpent` is kept separate from `spent` because the two answer
 * different questions: `spent` is what the children cost, `rootSpent` is what
 * the root cost, and summing them into one number would destroy the only
 * evidence that the reserve was respected.
 *
 * `overage` is the part of `spent` that no reservation covered. It is NOT an
 * addition to `spent`: `spent` already includes it, in full. It exists so a
 * reader can see that a reservation was wrong WITHOUT the total being reduced
 * to what was reserved - which is the "delete the bill and stay green" failure
 * the plan names.
 *
 * The four added fields are optional so that a record written before this
 * change still validates on read. That is also why `WORK_SCHEMA_VERSION` does
 * not move: an old record read by this code means "no reserve, no overage,
 * not halted", which is exactly what it meant when it was written.
 */
export const budgetSchema = z.object({
  currency: z.string().min(1),
  priceVersion: z.string().min(1),
  spent: z.number().min(0),
  reserved: z.number().min(0),
  unknownReserved: z.number().min(0),
  /** Hard ceiling authorized by the user. Top-up stops here, it does not degrade. */
  ceiling: z.number().min(0),
  /** Portion of `ceiling` that child admission can never consume. */
  rootReserve: z.number().min(0).optional(),
  /** The root's own spend, drawn only from `rootReserve`. */
  rootSpent: z.number().min(0).optional(),
  /** Cumulative part of `spent` that exceeded its reservation. Included in `spent`. */
  overage: z.number().min(0).optional(),
  /** Present exactly when new admissions are paused for a budget reason. */
  halt: admissionHaltSchema.optional(),
})
export type Budget = z.infer<typeof budgetSchema>

/** The reserve, defaulted. An absent reserve is zero reserve, never a free ceiling. */
export function rootReserveOf(budget: Budget): number {
  return budget.rootReserve ?? 0
}

/** The root's own spend, defaulted to zero. */
export function rootSpentOf(budget: Budget): number {
  return budget.rootSpent ?? 0
}

/**
 * What children may commit in total.
 *
 * This is the ONE place the root reserve is subtracted. Every admission
 * predicate reads this function rather than repeating the subtraction, because
 * two copies of the arithmetic is how a gate and its stated reason drift apart.
 */
export function childCeiling(budget: Budget): number {
  return Math.max(0, budget.ceiling - rootReserveOf(budget))
}

/** What children have committed: spent (including overage), reserved, and held unknowns. */
export function childCommitted(budget: Budget): number {
  return budget.spent + budget.reserved + budget.unknownReserved
}

/** What children may still commit. Negative only if a reservation was already wrong. */
export function childHeadroom(budget: Budget): number {
  return childCeiling(budget) - childCommitted(budget)
}

/** The root's unspent reserve. Never touched by a child admission. */
export function rootAvailable(budget: Budget): number {
  return Math.max(0, rootReserveOf(budget) - rootSpentOf(budget))
}

/** Whether new admissions are paused for a budget reason. */
export function isHalted(budget: Budget): boolean {
  return budget.halt !== undefined
}

/**
 * Apply a completed spend to a budget, recording any overage.
 *
 * The rule, in one sentence: **money already spent is always recorded in full,
 * and money that has not been spent yet is refused when it does not fit.**
 *
 * So this function never truncates `actualCost` to the reservation. The
 * provider charged what it charged; reducing the number to what we expected
 * would be falsifying the bill. What it does instead is record the excess in
 * `overage` and set `halt`, which stops new admissions and leaves the run
 * visibly blocked rather than green.
 *
 * The two reservation arguments are deliberately separate, because "how much
 * was reserved for this work" and "how much reservation is being retired now"
 * are different questions:
 *
 *   - `reservationCovering` is what the spend is MEASURED AGAINST. It is the
 *     reservation that was made for this work, whether or not it is being
 *     released in this same call. Using it for the overage math is what makes
 *     a spend reported for a task still held in `unknown` comparable to its own
 *     estimate rather than to zero.
 *   - `reservationReleased` is what comes OUT of `reserved`. It is clamped at
 *     zero against the outstanding reservation, matching `WorkService.transition`:
 *     a release larger than the outstanding reservation is a caller bug, and
 *     the clamp keeps the record non-negative rather than letting a negative
 *     reservation masquerade as headroom.
 *
 * A spend that is not retiring its reservation therefore records the cost in
 * full WITHOUT releasing the hold, which is the conservative direction: the
 * commitment grows, admission tightens, and nothing is forgotten.
 *
 * @param budget - the budget before the spend.
 * @param input - the reservations, the actual cost, and why it moved.
 * @returns the budget after the spend. Pure; safe inside a `KvTable.update`.
 */
export function applySpend(
  budget: Budget,
  input: {
    readonly reservationReleased: number
    readonly reservationCovering: number
    readonly actualCost: number
    readonly reason: string
    readonly now: string
  },
): Budget {
  const released = Math.min(budget.reserved, Math.max(0, input.reservationReleased))
  const overageAdd = Math.max(0, input.actualCost - Math.max(0, input.reservationCovering))
  const next: Budget = {
    ...budget,
    reserved: budget.reserved - released,
    spent: budget.spent + input.actualCost,
    overage: (budget.overage ?? 0) + overageAdd,
  }
  if (overageAdd === 0) return next
  return {
    ...next,
    halt: {
      reason:
        `${input.reason}: actual spend ${input.actualCost} exceeded the reservation ${input.reservationCovering} `
        + `made for this work by ${overageAdd}; the full amount is recorded in spent and new admissions are `
        + 'paused until a human resolves it',
      at: input.now,
    },
  }
}

/**
 * Move a task's reservation from `reserved` to `unknownReserved`.
 *
 * This is what "we will never learn this usage" does to the record. The amount
 * is NOT zeroed and NOT released: the commitment is unchanged, it is merely
 * held under a name that says why. `committed` therefore does not move, and a
 * reader can still see the exact figure that is in doubt.
 *
 * The clamp is deliberate: a caller asking to move more than is reserved has
 * mis-stated the amount, and the honest response is to move what exists rather
 * than to invent credit. Use {@link holdUnknown} when the amount was never in
 * `reserved` to begin with.
 *
 * @param budget - the budget before the move.
 * @param amount - the reservation to hold as unknown. Clamped to what is reserved.
 * @returns the budget after the move. Pure.
 */
export function retainAsUnknown(budget: Budget, amount: number): Budget {
  const moved = Math.min(budget.reserved, Math.max(0, amount))
  return {
    ...budget,
    reserved: budget.reserved - moved,
    unknownReserved: budget.unknownReserved + moved,
  }
}

/**
 * Hold an amount as unknown that was NEVER in `reserved`.
 *
 * This is the auxiliary-request path: a compaction, summary or search call that
 * the run authorized, whose usage the provider never reported. There is no
 * reservation to move, and the one thing that must not happen is treating the
 * missing report as a zero charge. So the amount is ADDED to `unknownReserved`,
 * which can only tighten admission - the conservative direction - and the
 * commitment total rises by exactly the amount in doubt.
 *
 * Note the asymmetry with {@link retainAsUnknown}, which is intentional:
 * moving an existing reservation keeps the total unchanged (the credit was
 * already committed), while holding a new unknown raises it (the credit was
 * not). Both leave the amount legible; neither zeroes anything.
 *
 * @param budget - the budget before the hold.
 * @param amount - the amount to hold as unknown. Must be non-negative.
 * @returns the budget after the hold. Pure.
 */
export function holdUnknown(budget: Budget, amount: number): Budget {
  const held = Math.max(0, amount)
  return { ...budget, unknownReserved: budget.unknownReserved + held }
}

/** Every quantity a reader needs to check a budget claim, in one object. */
export interface BudgetReport {
  readonly currency: string
  readonly ceiling: number
  readonly rootReserve: number
  readonly rootSpent: number
  /** What the root can still spend. A child admission never reduces this. */
  readonly rootAvailable: number
  readonly childCeiling: number
  readonly childCommitted: number
  readonly childHeadroom: number
  readonly spent: number
  readonly reserved: number
  readonly unknownReserved: number
  /** The part of `spent` no reservation covered. Already inside `spent`. */
  readonly overage: number
  readonly halted: boolean
  readonly haltReason: string | undefined
}

/** Compute the report. Pure, so the record and a test read the same numbers. */
export function budgetReport(budget: Budget): BudgetReport {
  return {
    currency: budget.currency,
    ceiling: budget.ceiling,
    rootReserve: rootReserveOf(budget),
    rootSpent: rootSpentOf(budget),
    rootAvailable: rootAvailable(budget),
    childCeiling: childCeiling(budget),
    childCommitted: childCommitted(budget),
    childHeadroom: childHeadroom(budget),
    spent: budget.spent,
    reserved: budget.reserved,
    unknownReserved: budget.unknownReserved,
    overage: budget.overage ?? 0,
    halted: isHalted(budget),
    haltReason: budget.halt?.reason,
  }
}

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
   * Monotonic run epoch. **Currently NOT enforced in the product.**
   *
   * This field exists to distinguish host generations, so that a callback from a
   * superseded generation can be refused instead of writing authoritative state.
   * The comparison that would do that lives in `recovery.ts`'s
   * `applyWorkerSettlement`, which refuses a settlement whose epoch does not match
   * the record's.
   *
   * That guard is **unreachable from any production path**: `recovery.ts` has no
   * non-test importer, `applyWorkerSettlement` has no caller outside its own
   * module and that test, and outside `recovery.ts` nothing reads or writes this
   * field after `initialRunRecord` sets it to 1. So nothing bumps it and nothing
   * checks it.
   *
   * This comment previously said a stale-epoch callback "must be rejected". That
   * was a requirement stated as if it were enforcement, which is the same defect
   * shape this project found three times (the launch port and the Goal handover
   * had zero production callers; this guard is unreachable). Presence of a guard
   * is not enforcement; reachability is.
   *
   * What IS enforced today, for the case that matters most: a live Agent's
   * identity, by `tool-protocol-guards.ts` comparing the registry entry by object
   * (`ctx.agents.get(id) === owner`), which covers an in-process resume. The
   * cross-PROCESS generation case, which this field promises, is not covered.
   *
   * To close it: call `applyWorkerSettlement` from whatever path receives a
   * worker settlement. That path does not exist yet, so wiring one would mean
   * inventing a caller rather than connecting a real one.
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
  /**
   * What the Goal handover did at run creation, when one ran.
   *
   * Optional so a record written before this field existed still validates on
   * read. See {@link continuationHandoverSchema} for why the result is stored
   * rather than merely logged.
   */
  continuation: continuationHandoverSchema.optional(),
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
  /** The Goal handover result, when one ran. Optional: a run may be created with no Goal mounted. */
  continuation?: ContinuationHandoverRecord
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
    ...input.continuation === undefined ? {} : { continuation: input.continuation },
    budget: input.budget,
    tasks: {},
    outbox: {},
    lastReconciledRefs: [],
    terminalTombstones: [],
    createdAt: input.now,
    updatedAt: input.now,
  }
}

// ---------------------------------------------------------------------------
// Usage accounting (R06)
// ---------------------------------------------------------------------------

/**
 * Where an attempt's usage came from.
 *
 * This list is the plan's sentence made mechanical: "cost covers root +
 * descendants + retries + compaction/summary/search". `compaction` and
 * `summary` are separate entries because a compaction request is a real billed
 * model call that belongs to no task, and folding it into a task's cost would
 * attribute the harness's own overhead to the work.
 */
export const USAGE_SOURCES = ['root', 'child', 'retry', 'compaction', 'summary', 'search'] as const
export type UsageSource = (typeof USAGE_SOURCES)[number]

/**
 * Token buckets, kept DISJOINT exactly as DSH reports them.
 *
 * The field names and the disjointness rule are copied from
 * `@deepseek-ai/dsh-llm`'s `TokenUsage` (packages/llm/llm/src/types.ts:162):
 *
 *   "Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 *    reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 *    sum of the three)."
 *
 * They are NOT collapsed into a single `totalTokens` here. A single number
 * would erase the cache split, and the cache split is most of what explains a
 * cost that came in above its reservation. `reasoningTokens` is carried
 * separately and is NOT added into `outputTokens` by this module: DSH already
 * includes reasoning in `outputTokens` (see the token-meter projection's
 * "reasoning tokens are already included in `outputTokens` and are not
 * accumulated again"), so adding it here would double-count.
 */
export interface UsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Informational: already inside `outputTokens`, never summed into it here. */
  readonly reasoningTokens: number
}

/**
 * One billable attempt.
 *
 * An "attempt" is one request that the provider could have charged for. The
 * identity that matters is `attemptId`, not the task: a retry is a SEPARATE
 * attempt with its own id, and the two are summed, because the provider billed
 * both. Folding a retry into its first attempt is how a system reports one
 * request's cost for two requests' work.
 *
 * `usage` and `cost` are both optional and their absence means UNKNOWN. This
 * type has no zero-valued default and no `?? 0` anywhere near it: an absent
 * usage is the gap the ledger exists to expose, and substituting zero is the
 * exact failure R06 names.
 */
export interface UsageAttempt {
  /**
   * Identity of this attempt. Convention: `${taskId}#${attempt}` for a task,
   * `root#${n}` for a root call, `compaction#${n}` for a compaction. Distinct
   * attempts must have distinct ids; re-reporting the same id is a duplicate.
   */
  readonly attemptId: string
  /** The task this attempt belongs to, when it belongs to one. */
  readonly taskId?: string
  readonly source: UsageSource
  /**
   * Provider or harness request identity, when one exists.
   *
   * Used only for de-duplication. A retry that reuses a request id is the same
   * billable request, so it must not be summed a second time.
   */
  readonly requestId?: string
  /** 1-based attempt number within its task. A retry increments it. */
  readonly attempt: number
  /** Token usage. Absent means UNKNOWN, never zero. */
  readonly usage?: UsageBuckets
  /** Priced cost in the run's currency. Absent means UNKNOWN, never zero. */
  readonly cost?: number
  /** Free-form note: why this attempt exists, or why its usage is missing. */
  readonly note?: string
}

/** What `record` did with an attempt. Every outcome is visible, none is silent. */
export type UsageRecordOutcome =
  /** A new attempt was added to the totals. */
  | 'recorded'
  /** This exact `attemptId` was already recorded; nothing was summed again. */
  | 'duplicate_attempt'
  /** This `requestId` already belongs to another attempt; nothing was summed again. */
  | 'duplicate_request'
  /**
   * A duplicate of a request whose first report carried NO usage, and this
   * report carries some. The unknown was replaced by the known value, so the
   * request still counts once but is no longer a gap.
   */
  | 'upgraded'

/** Per-source roll-up, so a reader can check every category is actually present. */
export interface UsageSourceSummary {
  readonly source: UsageSource
  readonly attempts: number
  /** Attempts from this source with no usage at all. */
  readonly unknown: number
  readonly cost: number
}

/** The whole ledger, as a reader needs it. */
export interface UsageTotal {
  readonly attempts: number
  readonly known: number
  /**
   * Attempts with NEITHER tokens nor cost. Reported as its own count so the
   * gap is visible; it is never folded into a zero-valued token bucket.
   */
  readonly unknownCount: number
  /** Attempts with no token usage. A superset of nothing; cost may still be known. */
  readonly unknownUsageCount: number
  /** Attempts with no cost. */
  readonly unknownCostCount: number
  /** Reports rejected because their `attemptId` was already present. */
  readonly duplicateAttempts: number
  /** Reports rejected because their `requestId` was already billed once. */
  readonly duplicateRequests: number
  /** Unknowns that a later report resolved. */
  readonly upgraded: number
  readonly tokens: UsageBuckets
  readonly knownCost: number
  /**
   * True when no attempt is missing usage. This is a statement about
   * COMPLETENESS only - it does not mean the numbers are correct, and it is
   * false the moment one request's usage is unknown.
   */
  readonly complete: boolean
  readonly bySource: readonly UsageSourceSummary[]
}

const ZERO_BUCKETS: UsageBuckets = Object.freeze({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

function addBuckets(into: UsageBuckets, from: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: into.uncachedInputTokens + from.uncachedInputTokens,
    outputTokens: into.outputTokens + from.outputTokens,
    cacheReadTokens: into.cacheReadTokens + from.cacheReadTokens,
    cacheWriteTokens: into.cacheWriteTokens + from.cacheWriteTokens,
    reasoningTokens: into.reasoningTokens + from.reasoningTokens,
  }
}

/**
 * An append-only ledger of every billable attempt in a run.
 *
 * Why this exists alongside the budget fields: the budget answers "may we
 * commit more credit", and it needs one number per run. It cannot answer
 * "which attempts were billed, and which of them do we know nothing about",
 * because it has already summed them. This ledger keeps the per-attempt rows.
 *
 * Two rules it enforces, both directly from R06:
 *
 *   1. UNKNOWN IS NOT ZERO. An attempt with no usage contributes to
 *      `unknownCount` and to no token bucket. There is no `?? 0` on this path.
 *   2. ONE REQUEST, ONE CHARGE. A repeat `attemptId` is refused. A repeat
 *      `requestId` is refused even when the `attemptId` is new, because a retry
 *      that reuses a request id is the same billable request. Both refusals are
 *      COUNTED and both are visible in the totals - the duplicate is reported,
 *      not silently swallowed, because "we ignored it" is itself a fact a
 *      reader needs.
 *
 * Not persisted. This class is deliberately pure and in-memory; it holds no
 * I/O and no clock. Persisting the rows is a separate decision with its own
 * schema-version consequence, and it is recorded as an open gap rather than
 * implied by this type.
 */
export class UsageLedger {
  private readonly attempts = new Map<string, UsageAttempt>()
  /** requestId -> attemptId of the row that owns the single charge for it. */
  private readonly requestOwners = new Map<string, string>()
  private duplicateAttempts = 0
  private duplicateRequests = 0
  private upgraded = 0

  /**
   * Record one attempt.
   *
   * @param attempt - the attempt to record. Its `attemptId` must be unique
   *   across the ledger; a retry needs its own id.
   * @returns what happened, so a caller can surface a duplicate rather than
   *   assume success.
   */
  record(attempt: UsageAttempt): UsageRecordOutcome {
    if (this.attempts.has(attempt.attemptId)) {
      this.duplicateAttempts += 1
      return 'duplicate_attempt'
    }
    const requestId = attempt.requestId
    if (requestId !== undefined) {
      const owner = this.requestOwners.get(requestId)
      if (owner !== undefined) {
        const existing = this.attempts.get(owner)
        // The one case where a duplicate may still change the totals: the
        // first report for this request had no usage at all and this one does.
        // The request is still counted once - the row is REPLACED, never added
        // - and the gap closes, which is the point of tracking unknown at all.
        if (existing !== undefined && !hasUsage(existing) && hasUsage(attempt)) {
          this.attempts.set(owner, { ...existing, usage: attempt.usage, cost: attempt.cost })
          this.upgraded += 1
          return 'upgraded'
        }
        this.duplicateRequests += 1
        return 'duplicate_request'
      }
      this.requestOwners.set(requestId, attempt.attemptId)
    }
    this.attempts.set(attempt.attemptId, attempt)
    return 'recorded'
  }

  /** Every recorded attempt, in insertion order. Read-only; the rows are immutable. */
  rows(): readonly UsageAttempt[] {
    return [...this.attempts.values()]
  }

  /** One attempt by id, for a reader checking a specific row. */
  get(attemptId: string): UsageAttempt | undefined {
    return this.attempts.get(attemptId)
  }

  /** The totals, with the unknown count kept separate from every known number. */
  total(): UsageTotal {
    let tokens = ZERO_BUCKETS
    let knownCost = 0
    let known = 0
    let unknownCount = 0
    let unknownUsageCount = 0
    let unknownCostCount = 0
    const bySource = new Map<UsageSource, { attempts: number; unknown: number; cost: number }>()
    for (const source of USAGE_SOURCES) bySource.set(source, { attempts: 0, unknown: 0, cost: 0 })

    for (const attempt of this.attempts.values()) {
      const bucket = bySource.get(attempt.source)
      if (bucket !== undefined) bucket.attempts += 1
      const usageKnown = attempt.usage !== undefined
      const costKnown = attempt.cost !== undefined
      if (usageKnown) {
        tokens = addBuckets(tokens, attempt.usage as UsageBuckets)
      } else {
        unknownUsageCount += 1
      }
      if (costKnown) {
        knownCost += attempt.cost as number
        if (bucket !== undefined) bucket.cost += attempt.cost as number
      } else {
        unknownCostCount += 1
      }
      if (usageKnown || costKnown) {
        known += 1
      } else {
        // Neither tokens nor cost: this attempt is a GAP. It contributes to no
        // bucket and to no cost, and it is counted here so the gap is visible.
        unknownCount += 1
        if (bucket !== undefined) bucket.unknown += 1
      }
    }

    return {
      attempts: this.attempts.size,
      known,
      unknownCount,
      unknownUsageCount,
      unknownCostCount,
      duplicateAttempts: this.duplicateAttempts,
      duplicateRequests: this.duplicateRequests,
      upgraded: this.upgraded,
      tokens,
      knownCost,
      complete: unknownCount === 0,
      bySource: USAGE_SOURCES.map(source => {
        const bucket = bySource.get(source) ?? { attempts: 0, unknown: 0, cost: 0 }
        return { source, attempts: bucket.attempts, unknown: bucket.unknown, cost: bucket.cost }
      }),
    }
  }
}

/** Whether an attempt carries any usage at all. Absence is not zero. */
function hasUsage(attempt: UsageAttempt): boolean {
  return attempt.usage !== undefined || attempt.cost !== undefined
}

/**
 * Build a `UsageBuckets` from DSH's `TokenUsage` shape.
 *
 * The mapping is mechanical and total: every optional DSH field that is absent
 * becomes 0 IN THE BUCKET, which is correct here because the bucket is a sum
 * over many calls and an absent cache field genuinely means zero cached tokens.
 * This is deliberately different from `UsageAttempt.usage` being absent, which
 * means "we never learned this call's usage at all". The distinction is the
 * whole point: zero tokens is a measurement, a missing report is not.
 *
 * @param usage - a DSH `TokenUsage` (see `@deepseek-ai/dsh-llm`), already
 *   adjusted by the adapter so that `inputTokens` is uncached input only.
 * @returns the disjoint buckets.
 */
export function bucketsFromTokenUsage(usage: {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}): UsageBuckets {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  }
}
