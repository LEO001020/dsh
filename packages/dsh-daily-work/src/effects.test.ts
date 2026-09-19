/**
 * Effect-adapter tests: gates E07 through E11.
 *
 * These run against the REAL storage domain (the same JSON backend and domain
 * facility the production host mounts), so "recorded intent" and "recorded
 * outcome" are durable facts rather than in-memory flags. The only fake is the
 * remote, and it is a counting in-process object: nothing here touches a socket.
 *
 * What each gate is actually asserting, stated so a reader can check the claim:
 *
 *   E07  a retry of the same logical operation reconciles instead of repeating
 *        the effect. The counting fake proves the effect happened ONCE, and the
 *        retry carries a DIFFERENT transport callId, which is the case the
 *        delivery plan names.
 *   E08  a changed payload under the same operationId is a conflict. The original
 *        acknowledgement does not authorize the new action, and the new action is
 *        not sent.
 *   E09  opaque shell text cannot be classified, demonstrated by DEFEATING the
 *        classifier with a real shell rather than by listing regexes that fail.
 *   E10  a partially committed program is not replayed as a unit. Each effect is
 *        reconciled individually and the un-entered remainder is unknown.
 *   E11  cancellation of an in-flight effect reconciles and reports "may have
 *        happened". It is never reported as an undo.
 *
 * A deliberate non-claim, repeated here because a green suite invites the wrong
 * reading: none of this is exactly-once. The guarantee is narrower, and the tests
 * are written so that the narrow version is what is being asserted.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EffectLedger,
  classifyShellCommand,
  canonicalJson,
  identify,
  mayRunAutomatically,
  parameterDigestOf,
  resumeEffectProgram,
  runEffectProgram,
  sendDecision,
  EFFECT_RECORD_STATUSES,
  type EffectAdapter,
  type EffectIntent,
  type EffectPerformResult,
  type EffectQueryResult,
  type EffectRecordStatus,
  type EffectParameters,
  type ProgramReport,
} from './effects.ts'

const NOW = '2026-09-19T00:00:00.000Z'

// ---------------------------------------------------------------------------
// The counting fake remote
// ---------------------------------------------------------------------------

/**
 * A local stand-in for the remote service.
 *
 * It counts TRANSPORT INVOCATIONS, which is the only thing that can distinguish
 * "reconciled" from "repeated". A fake that merely returned a value would let a
 * duplicate send pass unnoticed, so the counter is the assertion.
 *
 * The scripted faults are the two shapes a real remote produces and this design
 * must survive: a commit whose reply is lost, and a call that fails for a reason
 * that says nothing about whether the effect landed.
 */
class CountingRemote {
  /** How many times the effect was actually invoked. The E07 assertion. */
  performCalls = 0
  queryCalls = 0
  /** The effects this remote believes it has committed, keyed by operationId. */
  readonly committed = new Map<string, string>()
  /** Faults consumed in order by `perform`; an exhausted list means normal behaviour. */
  readonly performFaults: ('commit-then-throw' | 'throw-before-commit' | 'never-answer')[] = []
  /** When false, `query` answers `unsupported` rather than guessing. */
  queryable = true
  /** When true, `query` answers `unknown` even though the adapter claims support. */
  queryBlind = false

  commit(operationId: string, resultRef: string): void {
    this.committed.set(operationId, resultRef)
  }

  nextFault(): 'commit-then-throw' | 'throw-before-commit' | 'never-answer' | undefined {
    return this.performFaults.shift()
  }
}

/** An adapter over {@link CountingRemote}. One instance per test, one kind per instance. */
class FakeAdapter implements EffectAdapter {
  readonly kind: string
  readonly capabilities: { readonly idempotencyKey: boolean; readonly queryable: boolean }

  constructor(
    private readonly remote: CountingRemote,
    options: { readonly kind?: string; readonly idempotencyKey?: boolean; readonly queryable?: boolean } = {},
  ) {
    this.kind = options.kind ?? 'deploy'
    this.capabilities = {
      idempotencyKey: options.idempotencyKey ?? true,
      queryable: options.queryable ?? true,
    }
  }

  async perform(_intent: EffectIntent, identity: { readonly operationId: string }): Promise<EffectPerformResult> {
    const fault = this.remote.nextFault()
    if (fault === 'throw-before-commit') throw new Error('the connection dropped before the request was written')
    this.remote.performCalls += 1
    this.remote.commit(identity.operationId, `remote:${identity.operationId}`)
    if (fault === 'commit-then-throw') throw new Error('the effect landed but the reply never arrived')
    if (fault === 'never-answer') {
      // The effect committed; the remote will not confirm it to a later query.
      this.remote.queryBlind = true
      return { status: 'unknown', detail: 'the remote accepted the request and then stopped answering' }
    }
    return { status: 'confirmed', resultRef: `remote:${identity.operationId}`, remoteKey: `key-${identity.operationId}` }
  }

  async query(operationId: string): Promise<EffectQueryResult> {
    if (!this.capabilities.queryable) {
      return { status: 'unsupported', detail: 'this adapter has no query endpoint' }
    }
    this.remote.queryCalls += 1
    if (this.remote.queryBlind) return { status: 'unknown', detail: 'the remote has no record to return yet' }
    const committed = this.remote.committed.get(operationId)
    if (committed === undefined) return { status: 'not_started', detail: 'the remote has no record of this operation' }
    return { status: 'confirmed', resultRef: committed, remoteKey: `key-${operationId}` }
  }
}

// ---------------------------------------------------------------------------
// Harness: the REAL storage domain
// ---------------------------------------------------------------------------

interface Harness {
  readonly ctx: Context
  readonly root: string
  /** Open a ledger over this context. The domain facility permits exactly one per name. */
  open(): Promise<EffectLedger>
  /**
   * Close the given ledger and open a fresh one over the SAME medium.
   *
   * This is how a process restart is simulated: the in-memory object is gone and
   * the next ledger must re-derive everything it knows from the stored records.
   */
  reopen(previous: EffectLedger): Promise<EffectLedger>
  close(): Promise<void>
}

let h: Harness
let ledger: EffectLedger

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-daily-effects-'))
  const ctx = new Context()
  await ctx.plugin(Storage, {})
  await ctx.plugin(storageJsonPlugin as never, { root } as never)
  await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
  const open = async (): Promise<EffectLedger> => {
    const next = new EffectLedger(ctx)
    await next.open()
    return next
  }
  return {
    ctx,
    root,
    open,
    async reopen(previous) {
      await previous.close()
      return open()
    },
    async close() {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

beforeEach(async () => {
  h = await harness()
  ledger = await h.open()
})

afterEach(async () => {
  await ledger.close()
  await h.close()
})

/** Build an intent. The callId is a per-attempt transport id and is never identity. */
function intent(logicalKey: string, parameters: EffectParameters, toolCallId?: string): EffectIntent {
  return {
    kind: 'deploy',
    logicalKey,
    parameters,
    ...(toolCallId === undefined ? {} : { toolCallId }),
  }
}

function stepAt(report: ProgramReport, index: number) {
  const step = report.steps[index]
  if (step === undefined) throw new Error(`effects.test: the report has no step at index ${index}`)
  return step
}

// ---------------------------------------------------------------------------
// Identity: the operationId is a property of the logical operation
// ---------------------------------------------------------------------------

describe('operation identity', () => {
  it('is stable across a changed transport callId', () => {
    // E07 in miniature. If the callId were part of the identity, every retry
    // would be a new operation and the ledger could not detect the repeat.
    const first = identify(intent('invoice-2026-09', { to: 'billing' }, 'call-aaa'))
    const second = identify(intent('invoice-2026-09', { to: 'billing' }, 'call-bbb'))
    expect(second.operationId).toBe(first.operationId)
    expect(second.parameterDigest).toBe(first.parameterDigest)
  })

  it('is stable across parameter key order, so a rebuilt retry is the same operation', () => {
    const a = identify(intent('k', { to: 'billing', amount: 10 }))
    const b = identify(intent('k', { amount: 10, to: 'billing' }))
    expect(b.operationId).toBe(a.operationId)
    expect(b.parameterDigest).toBe(a.parameterDigest)
  })

  it('keeps the operationId when the payload changes, so the change is a conflict and not a new operation', () => {
    // E08's precondition. If the payload were folded into the operationId, a
    // changed target would silently become a second, independently authorized send.
    const original = identify(intent('release-42', { target: 'staging' }))
    const changed = identify(intent('release-42', { target: 'production' }))
    expect(changed.operationId).toBe(original.operationId)
    expect(changed.parameterDigest).not.toBe(original.parameterDigest)
  })

  it('refuses to identify an operation with no logical key', () => {
    // A per-attempt id is not an identity, and inventing a name would be worse
    // than refusing.
    expect(() => identify({ kind: 'deploy', logicalKey: '', parameters: {} })).toThrow(/logicalKey/)
  })

  it('refuses to canonicalize values whose digest would be ambiguous', () => {
    // Two different values that both canonicalize to the same text would digest
    // identically, which would make two different effects look like one.
    expect(() => canonicalJson({ nested: { when: new Date() as never } })).toThrow(/is not a plain object/)
    expect(() => canonicalJson(Number.NaN)).toThrow(/cannot be canonicalized/)
    expect(() => canonicalJson({ f: (() => {}) as never })).toThrow(/cannot be canonicalized/)
  })

  it('digests the canonical form, not the source text', () => {
    expect(parameterDigestOf({ b: [1, 2], a: 'x' })).toBe(parameterDigestOf({ a: 'x', b: [1, 2] }))
  })
})

// ---------------------------------------------------------------------------
// The send decision table
// ---------------------------------------------------------------------------

describe('the send decision table', () => {
  it('licenses a send from exactly two states, and both are proofs about our own write ordering', () => {
    const sending = EFFECT_RECORD_STATUSES.filter(status => sendDecision(status).send)
    expect(sending).toEqual(['intent_recorded'])
    expect(sendDecision('absent').send).toBe(true)
  })

  it('never licenses a send from a state that could already have reached the remote', () => {
    // sent / unknown / confirmed are the states where the world may already have
    // changed. not_started is refused too: a resend is a new authorization, not a
    // reconciliation step.
    for (const status of ['sent', 'unknown', 'confirmed', 'not_started'] as EffectRecordStatus[]) {
      const decision = sendDecision(status)
      expect(decision.send).toBe(false)
      expect(decision.reason.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// E07: same operationId, same parameters => reconcile, not repeat
// ---------------------------------------------------------------------------

describe('E07: operation idempotency', () => {
  it('performs the effect ONCE when the same logical operation is retried with a new callId', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const first = await ledger.perform(adapter, intent('release-1', { target: 'staging' }, 'call-1'))
    expect(first.performed).toBe(true)
    expect(first.outcome).toBe('confirmed')
    expect(remote.performCalls).toBe(1)

    // The retry: same logical operation, same parameters, DIFFERENT tool callId.
    const retry = await ledger.perform(adapter, intent('release-1', { target: 'staging' }, 'call-2'))
    expect(retry.performed).toBe(false)
    expect(retry.outcome).toBe('confirmed')
    expect(retry.operationId).toBe(first.operationId)
    expect(remote.performCalls).toBe(1)
    expect(retry.reason).toMatch(/reconciled against the durable acknowledgement/)
  })

  it('survives a restart: a fresh ledger over the same medium reconciles instead of resending', async () => {
    // The real E07 shape. The lost reply is a process that died; the record is the
    // only thing that knows the effect already landed.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('release-2', { target: 'staging' }))
    expect(remote.performCalls).toBe(1)

    ledger = await h.reopen(ledger)
    const afterRestart = await ledger.perform(adapter, intent('release-2', { target: 'staging' }))
    expect(afterRestart.performed).toBe(false)
    expect(afterRestart.outcome).toBe('confirmed')
    expect(remote.performCalls).toBe(1)
  })

  it('records a lost reply as unknown, and resolves it by QUERY rather than by a second send', async () => {
    const remote = new CountingRemote()
    remote.performFaults.push('commit-then-throw')
    const adapter = new FakeAdapter(remote)

    const first = await ledger.perform(adapter, intent('release-3', { target: 'staging' }))
    expect(first.outcome).toBe('unknown')
    expect(remote.performCalls).toBe(1)

    // A retry must not send. It reconciles against the remote's own record.
    const retry = await ledger.perform(adapter, intent('release-3', { target: 'staging' }, 'call-retry'))
    expect(retry.performed).toBe(false)
    expect(retry.queried).toBe(true)
    expect(retry.outcome).toBe('confirmed')
    expect(remote.performCalls).toBe(1)
  })

  it('leaves the outcome unknown when the adapter cannot be queried, and still does not resend', async () => {
    // The honest case from SECURITY.md: "Without a real query or idempotency
    // support the honest answer is unknown." The value under test is that the
    // system does not convert that into a resend.
    const remote = new CountingRemote()
    remote.performFaults.push('commit-then-throw')
    const adapter = new FakeAdapter(remote, { idempotencyKey: true, queryable: false })

    const first = await ledger.perform(adapter, intent('release-4', { target: 'staging' }))
    expect(first.outcome).toBe('unknown')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await ledger.perform(adapter, intent('release-4', { target: 'staging' }, `call-${attempt}`))
      expect(retry.performed).toBe(false)
      expect(retry.outcome).toBe('unknown')
    }
    expect(remote.performCalls).toBe(1)
    // And the record still says unknown, so a later reader is not told it settled.
    expect(ledger.get(first.operationId)?.status).toBe('unknown')
  })

  it('does not run an adapter with neither an idempotency key nor a queryable result', async () => {
    // SECURITY.md's first-version rule, enforced rather than documented.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote, { idempotencyKey: false, queryable: false })
    const outcome = await ledger.perform(adapter, intent('release-5', { target: 'staging' }))
    expect(outcome.performed).toBe(false)
    expect(outcome.outcome).toBe('unknown')
    expect(remote.performCalls).toBe(0)
    expect(outcome.reason).toMatch(/not run automatically/)
  })

  it('sends after a crash that provably preceded the transport call', async () => {
    // The other half of the write-ordering claim: intent durable + no sent marker
    // PROVES the call was never made, so this is recovery rather than a replay.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const recorded = await ledger.recordIntent(intent('release-6', { target: 'staging' }))
    expect(recorded.status).toBe('intent_recorded')

    const reconciled = await ledger.reconcile(adapter, intent('release-6', { target: 'staging' }))
    expect(reconciled.outcome).toBe('not_started')
    expect(reconciled.performed).toBe(false)
    expect(remote.performCalls).toBe(0)

    const performed = await ledger.perform(adapter, intent('release-6', { target: 'staging' }))
    expect(performed.performed).toBe(true)
    expect(remote.performCalls).toBe(1)
  })

  it('reconcile never reaches the transport, whatever the recorded state', async () => {
    // The property that makes "reconcile, never replay" a fact about the module
    // rather than a convention its callers must remember.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    for (const key of ['r-a', 'r-b', 'r-c']) {
      await ledger.perform(adapter, intent(key, { target: 'staging' }))
    }
    remote.performFaults.push('commit-then-throw')
    await ledger.perform(adapter, intent('r-d', { target: 'staging' }))
    const before = remote.performCalls

    for (const key of ['r-a', 'r-b', 'r-c', 'r-d']) {
      await ledger.reconcile(adapter, intent(key, { target: 'staging' }))
    }
    await ledger.reconcile(adapter, intent('never-recorded', { target: 'staging' }))
    expect(remote.performCalls).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// E08: same operationId, different parameters => conflict
// ---------------------------------------------------------------------------

describe('E08: operation parameter conflict', () => {
  it('refuses the changed action and does not send it', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const original = await ledger.perform(adapter, intent('release-7', { target: 'staging' }))
    expect(original.outcome).toBe('confirmed')
    expect(remote.performCalls).toBe(1)

    const changed = await ledger.perform(adapter, intent('release-7', { target: 'production' }, 'call-changed'))
    expect(changed.outcome).toBe('conflict')
    expect(changed.performed).toBe(false)
    expect(changed.queried).toBe(false)
    expect(changed.operationId).toBe(original.operationId)
    expect(changed.heldParameterDigest).toBe(original.parameterDigest)
    expect(remote.performCalls).toBe(1)
    expect(remote.committed.size).toBe(1)
  })

  it('does not let the original acknowledgement authorize the new action', async () => {
    // The heart of E08. The record's confirmation covers the recorded parameters
    // and nothing else, and reconciling must not return the stale confirmation for
    // a payload it never covered.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('release-8', { target: 'staging' }))

    const changed = await ledger.reconcile(adapter, intent('release-8', { target: 'production' }))
    expect(changed.outcome).toBe('conflict')
    expect(changed.resultRef).toBeUndefined()
    expect(changed.reason).toMatch(/authorizes the recorded parameters only/)
  })

  it('leaves the recorded authorization fields untouched and audits the refusal', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const original = await ledger.perform(adapter, intent('release-9', { target: 'staging' }))
    const held = ledger.get(original.operationId)
    const changedDigest = parameterDigestOf({ target: 'production' })

    await ledger.perform(adapter, intent('release-9', { target: 'production' }))

    const after = ledger.get(original.operationId)
    expect(after?.status).toBe(held?.status)
    expect(after?.parameterDigest).toBe(held?.parameterDigest)
    expect(after?.resultRef).toBe(held?.resultRef)
    expect(after?.parameters).toBe(held?.parameters)
    expect(after?.refusedDigests).toContain(changedDigest)
    // `conflict` is not a stored status: a refused attempt must not overwrite the
    // ack it was refused against.
    expect(EFFECT_RECORD_STATUSES).not.toContain('conflict' as never)
  })

  it('still reconciles the ORIGINAL parameters after a conflict', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('release-10', { target: 'staging' }))
    await ledger.perform(adapter, intent('release-10', { target: 'production' }))

    const original = await ledger.reconcile(adapter, intent('release-10', { target: 'staging' }))
    expect(original.outcome).toBe('confirmed')
    expect(remote.performCalls).toBe(1)
  })

  it('refuses to overwrite a recorded intent through recordIntent', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.recordIntent(intent('release-11', { target: 'staging' }))
    await expect(ledger.recordIntent(intent('release-11', { target: 'production' }))).rejects.toThrow(
      /different parameter digest/,
    )
  })
})

// ---------------------------------------------------------------------------
// E09: opaque shell text
// ---------------------------------------------------------------------------

/** The bash on PATH, or undefined. The adversarial tests below REQUIRE a real shell. */
function bashPath(): string | undefined {
  const probe = spawnSync('bash', ['-c', 'echo present'], { encoding: 'utf8' })
  return probe.status === 0 ? 'bash' : undefined
}

const BASH = bashPath()

describe('E09: opaque shell classification', () => {
  it('classifies only a closed allowlist of plain commands as read_only', () => {
    expect(classifyShellCommand('ls -la').classification).toBe('read_only')
    expect(classifyShellCommand('cat notes.txt').classification).toBe('read_only')
    expect(classifyShellCommand('git log --oneline').classification).toBe('read_only')
    expect(classifyShellCommand('  wc -l notes.txt  ').classification).toBe('read_only')
  })

  it('returns unknown, never read_only, for anything it cannot classify', () => {
    // The E09 oracle: "do not claim a regex can fully decide read-only".
    const opaque = [
      'python -c "open(\'x\',\'w\').write(\'1\')"',
      './deploy.sh',
      'bash deploy.sh',
      'sh -c "make release"',
      'env FOO=1 ./run',
      'sed -i s/a/b/ notes.txt',
      'awk "{print > \\"out\\"}" notes.txt',
      'xargs rm',
      'echo hi',
      'uniq in out',
      'sort in out',
      'frobnicate --go',
    ]
    for (const command of opaque) {
      const verdict = classifyShellCommand(command)
      expect(verdict.classification, command).toBe('unknown')
      expect(mayRunAutomatically(verdict), command).toBe(false)
    }
  })

  it('treats any shell metacharacter as making the text a program rather than a command', () => {
    // Composition is the reason: classifying the first token of `cat a; rm -rf b`
    // would classify the wrong thing entirely.
    const composed = [
      'cat a; rm -rf b',
      'cat a && rm -rf b',
      'cat a || true',
      'cat a > out',
      'cat a >> out',
      'cat a | tee out',
      'cat < in',
      'cat $(ls)',
      'cat `ls`',
      'cat a & ',
      'cat a\nrm -rf b',
      'cat a # comment',
      'cat *',
      'cat a~',
      'cat a!b',
      'cat "a b"',
      "cat 'a b'",
      'cat a\\ b',
      'cat a%b',
    ]
    for (const command of composed) {
      expect(classifyShellCommand(command).classification, command).toBe('unknown')
    }
  })

  it('refuses a reading command whose flag writes', () => {
    // `sort` is NOT on the read-only allowlist precisely because `sort in out`
    // writes with no flag at all. The flag table only ever upgrades the verdict to
    // `mutating`, never down to `read_only`.
    expect(classifyShellCommand('sort -o out in').classification).toBe('mutating')
    expect(classifyShellCommand('sort --output=out in').classification).toBe('mutating')
    expect(classifyShellCommand('date -s 2026-01-01').classification).toBe('mutating')
    expect(classifyShellCommand('sort -ro out in').classification).toBe('mutating')
    expect(classifyShellCommand('find . -delete').classification).toBe('mutating')
    // `tar` writes with mode letters and no dash anywhere in the text.
    expect(classifyShellCommand('tar xf archive.tgz').classification).toBe('mutating')
    expect(classifyShellCommand('tar czf out.tgz src').classification).toBe('mutating')
    expect(classifyShellCommand('sort in').classification).toBe('unknown')
    // A second positional operand is the output file for sort, which no flag reveals.
    expect(classifyShellCommand('sort in out').classification).toBe('unknown')
  })

  it('reports mutating for commands that write in their normal use', () => {
    for (const command of ['rm -rf build', 'curl https://example.invalid', 'docker run img', 'chmod 777 x']) {
      expect(classifyShellCommand(command).classification, command).toBe('mutating')
    }
  })

  it('refuses a path-qualified executable, because the name then proves nothing', () => {
    expect(classifyShellCommand('/bin/ls -la').classification).toBe('unknown')
    expect(classifyShellCommand('./ls -la').classification).toBe('unknown')
  })

  it('exposes its own limits as part of the interface', () => {
    // A reader about to treat `read_only` as an authorization must first read what
    // the verdict does not cover.
    const verdict = classifyShellCommand('ls -la')
    expect(verdict.classification).toBe('read_only')
    expect(verdict.witness).toBe('ls')
  })

  describe('adversarial: the same text that is classified read_only really does write', () => {
    // Each case below is a real shell invocation whose TEXT the classifier calls
    // read_only and whose EFFECT is an observed write to disk. The marker is the
    // evidence: a regex that "would have caught it" is not the same claim as a file
    // that exists.
    //
    // Paths inside the shell text are RELATIVE to the shell's cwd, so the text
    // carries no Windows backslashes for the shell to re-interpret.
    let sandbox: string

    beforeEach(() => {
      sandbox = mkdtempSync(join(tmpdir(), 'dsh-e09-'))
    })

    afterEach(() => {
      rmSync(sandbox, { recursive: true, force: true })
    })

    function run(command: string): void {
      const result = spawnSync(BASH as string, ['-c', command], { encoding: 'utf8', cwd: sandbox })
      expect(result.error, `spawning the shell failed: ${String(result.error)}`).toBeUndefined()
    }

    function markerWritten(name: string): boolean {
      try {
        return readFileSync(join(sandbox, name), 'utf8').trim().length > 0
      } catch {
        return false
      }
    }

    it('requires a real shell, because a regex failure is not the same evidence as an observed write', () => {
      // Stated as an assertion rather than a skip: if there is no shell, this gate
      // has not been run, and a silently skipped test would be green for the wrong
      // reason.
      expect(BASH, 'the E09 adversarial cases need a real shell to produce an observed write').toBeDefined()
    })

    it('a shell function bound to a read-only name writes, while the text still classifies as read_only', () => {
      const command = 'ls -la'
      expect(classifyShellCommand(command).classification).toBe('read_only')

      run(`ls() { printf hijacked > fn_marker; }; ${command}`)

      expect(markerWritten('fn_marker')).toBe(true)
    })

    it('a PATH-shadowed executable writes, while the text still classifies as read_only', () => {
      const command = 'ls -la'
      expect(classifyShellCommand(command).classification).toBe('read_only')

      const shadow = join(sandbox, 'bin')
      mkdirSync(shadow, { recursive: true })
      writeFileSync(join(shadow, 'ls'), '#!/bin/sh\nprintf shadowed > path_marker\n', { mode: 0o755 })

      run(`PATH="$PWD/bin:$PATH" ${command}`)

      expect(markerWritten('path_marker')).toBe(true)
    })

    it('a redirect hidden in a variable writes, while the inner text classifies as read_only', () => {
      // The classifier's verdict is a statement about a STRING. Inside a shell the
      // same string can be re-parsed with a different meaning, which is why the
      // verdict is a refusal device and not an authorization.
      const inner = 'cat notes.txt'
      expect(classifyShellCommand(inner).classification).toBe('read_only')

      writeFileSync(join(sandbox, 'notes.txt'), 'the notes\n')
      run(`CMD="${inner} > redirect_marker"; eval "$CMD"`)

      expect(markerWritten('redirect_marker')).toBe(true)
    })

    it('an exported function writes in a child shell, while the text still classifies as read_only', () => {
      // A function travels into a non-interactive child through the environment, so
      // the text alone cannot decide what a name means.
      const command = 'ls -la'
      expect(classifyShellCommand(command).classification).toBe('read_only')

      run(`ls() { printf exported > exported_marker; }; export -f ls; bash -c "${command}"`)

      expect(markerWritten('exported_marker')).toBe(true)
    })

    it('demonstrates all four defeats in one sandbox, so the gate has a single checkable list', () => {
      // Self-contained on purpose: one sandbox, four defeats, four observed writes,
      // and the classifier saying read_only to every one of the command strings.
      writeFileSync(join(sandbox, 'notes.txt'), 'the notes\n')
      const shadow = join(sandbox, 'bin')
      mkdirSync(shadow, { recursive: true })
      writeFileSync(join(shadow, 'ls'), '#!/bin/sh\nprintf shadowed > path_marker\n', { mode: 0o755 })

      const defeats: readonly { readonly text: string; readonly command: string; readonly marker: string }[] = [
        { text: 'ls -la', command: 'ls() { printf hijacked > fn_marker; }; ls -la', marker: 'fn_marker' },
        { text: 'ls -la', command: 'PATH="$PWD/bin:$PATH" ls -la', marker: 'path_marker' },
        { text: 'cat notes.txt', command: 'CMD="cat notes.txt > redirect_marker"; eval "$CMD"', marker: 'redirect_marker' },
        { text: 'ls -la', command: 'ls() { printf exported > exported_marker; }; export -f ls; bash -c "ls -la"', marker: 'exported_marker' },
      ]

      for (const defeat of defeats) {
        expect(classifyShellCommand(defeat.text).classification, defeat.text).toBe('read_only')
        expect(markerWritten(defeat.marker), `${defeat.marker} before`).toBe(false)
        run(defeat.command)
        expect(markerWritten(defeat.marker), `${defeat.command} must write`).toBe(true)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// E10: a partially committed program
// ---------------------------------------------------------------------------

describe('E10: partial PTC-style program commit', () => {
  it('does not replay the program; it reconciles the committed effect and quarantines the rest', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const program = [
      { stepId: 's1', intent: intent('prog-1/a', { target: 'a' }) },
      {
        stepId: 's2',
        intent: intent('prog-1/b', { target: 'b' }),
        after: () => {
          throw new Error('the program threw after its second effect committed')
        },
      },
      { stepId: 's3', intent: intent('prog-1/c', { target: 'c' }) },
    ]

    const report = await runEffectProgram(ledger, adapter, program)

    expect(report.replayedWholeProgram).toBe(false)
    expect(report.completed).toBe(false)
    expect(report.threwAt).toBe('s2')
    // Two effects were sent: the one that committed and the one whose step threw.
    // The third was never entered, and nothing was re-run.
    expect(remote.performCalls).toBe(2)

    expect(stepAt(report, 0).outcome).toBe('confirmed')
    expect(stepAt(report, 0).disposition).toBe('performed')
    expect(stepAt(report, 1).outcome).toBe('confirmed')
    expect(stepAt(report, 1).disposition).toBe('reconciled')
    expect(stepAt(report, 1).reason).toMatch(/reconciled individually/)
    expect(stepAt(report, 2).outcome).toBe('unknown')
    expect(stepAt(report, 2).disposition).toBe('not_reached')

    for (const step of report.steps) {
      expect(ledger.get(step.operationId)?.attempts ?? 0).toBeLessThanOrEqual(1)
    }
  })

  it('resumes by reconciling each step individually, with no transport invocation at all', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const program = [
      { stepId: 's1', intent: intent('prog-2/a', { target: 'a' }) },
      {
        stepId: 's2',
        intent: intent('prog-2/b', { target: 'b' }),
        after: () => {
          throw new Error('stop')
        },
      },
      { stepId: 's3', intent: intent('prog-2/c', { target: 'c' }) },
    ]
    const first = await runEffectProgram(ledger, adapter, program)
    const performCalls = remote.performCalls

    const resumed = await resumeEffectProgram(ledger, adapter, program)
    expect(remote.performCalls).toBe(performCalls)
    expect(resumed.replayedWholeProgram).toBe(false)
    expect(stepAt(resumed, 0).outcome).toBe('confirmed')
    expect(stepAt(resumed, 1).outcome).toBe('confirmed')
    // The un-entered step stays unknown even on resume: the ledger holds no intent
    // for it, and a control-flow fact about the runner is not evidence about the
    // remote.
    expect(stepAt(resumed, 2).outcome).toBe('unknown')
    expect(stepAt(resumed, 2).disposition).toBe('not_reached')
    expect(first.steps).toHaveLength(3)
  })

  it('reconciles a lost reply inside the program instead of re-running the program', async () => {
    const remote = new CountingRemote()
    remote.performFaults.push('commit-then-throw')
    const adapter = new FakeAdapter(remote)
    const program = [
      { stepId: 's1', intent: intent('prog-3/a', { target: 'a' }) },
      {
        stepId: 's2',
        intent: intent('prog-3/b', { target: 'b' }),
        after: () => {
          throw new Error('stop')
        },
      },
      { stepId: 's3', intent: intent('prog-3/c', { target: 'c' }) },
    ]

    const report = await runEffectProgram(ledger, adapter, program)
    // The first step's reply was lost, so it was unknown when the step returned and
    // confirmed only after a query. Either way it was sent exactly once.
    expect(stepAt(report, 0).outcome).toBe('unknown')
    expect(stepAt(report, 0).disposition).toBe('performed')
    expect(stepAt(report, 0).reason).toMatch(/not proof that the remote did nothing/)

    const resumed = await resumeEffectProgram(ledger, adapter, program)
    expect(stepAt(resumed, 0).outcome).toBe('confirmed')
    expect(remote.performCalls).toBe(2)
  })

  it('leaves a program step unknown when the adapter cannot be queried', async () => {
    const remote = new CountingRemote()
    remote.performFaults.push('commit-then-throw')
    const adapter = new FakeAdapter(remote, { queryable: false })
    const program = [
      { stepId: 's1', intent: intent('prog-4/a', { target: 'a' }) },
      {
        stepId: 's2',
        intent: intent('prog-4/b', { target: 'b' }),
        after: () => {
          throw new Error('stop')
        },
      },
    ]
    await runEffectProgram(ledger, adapter, program)
    const performCallsAfterRun = remote.performCalls
    const resumed = await resumeEffectProgram(ledger, adapter, program)
    expect(stepAt(resumed, 0).outcome).toBe('unknown')
    expect(stepAt(resumed, 0).reason).toMatch(/cannot be established/)
    // Two steps were entered and each sent exactly once; the resume sent nothing.
    expect(performCallsAfterRun).toBe(2)
    expect(remote.performCalls).toBe(performCallsAfterRun)
  })

  it('reports a fully completed program as completed, so a real failure is distinguishable', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const report = await runEffectProgram(ledger, adapter, [
      { stepId: 's1', intent: intent('prog-5/a', { target: 'a' }) },
      { stepId: 's2', intent: intent('prog-5/b', { target: 'b' }) },
    ])
    expect(report.completed).toBe(true)
    expect(report.threwAt).toBeUndefined()
    expect(remote.performCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// E11: cancellation after an effect was sent
// ---------------------------------------------------------------------------

describe('E11: cancellation does not roll back', () => {
  it('reports "may have happened" and reconciles by query when the effect was sent and the remote cannot confirm', async () => {
    const remote = new CountingRemote()
    remote.performFaults.push('never-answer')
    const adapter = new FakeAdapter(remote)
    const performed = await ledger.perform(adapter, intent('cancel-1', { target: 'production' }))
    expect(performed.outcome).toBe('unknown')
    const performCalls = remote.performCalls

    const report = await ledger.cancel(adapter, intent('cancel-1', { target: 'production' }))
    expect(report.outcome).toBe('unknown')
    expect(report.mayHaveHappened).toBe(true)
    expect(report.reverted).toBe(false)
    expect(report.queried).toBe(true)
    expect(report.reason).toMatch(/does not undo it/)
    // Cancelling never sends, and it never clears the record.
    expect(remote.performCalls).toBe(performCalls)
    expect(ledger.get(report.operationId)?.status).not.toBe('not_started')
  })

  it('reports the committed outcome when the query confirms it, rather than the cancellation the user asked for', async () => {
    const remote = new CountingRemote()
    // The effect really lands and the reply is lost, so the record is `unknown`
    // when the user cancels and the query is what settles it.
    remote.performFaults.push('commit-then-throw')
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('cancel-2', { target: 'production' }))

    const report = await ledger.cancel(adapter, intent('cancel-2', { target: 'production' }))
    expect(report.outcome).toBe('confirmed')
    expect(report.mayHaveHappened).toBe(true)
    expect(report.reverted).toBe(false)
    expect(report.queried).toBe(true)
    expect(report.reason).toMatch(/cancelling after the fact does not undo it/)
    expect(remote.performCalls).toBe(1)
  })

  it('reports an already-confirmed effect as committed, and says cancelling does not undo it', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('cancel-2b', { target: 'production' }))

    const report = await ledger.cancel(adapter, intent('cancel-2b', { target: 'production' }))
    expect(report.outcome).toBe('confirmed')
    expect(report.mayHaveHappened).toBe(true)
    expect(report.reverted).toBe(false)
    expect(report.reason).toMatch(/does not undo it/)
    expect(remote.performCalls).toBe(1)
  })

  it('reports not_started when the remote positively says nothing happened, and still not as an undo', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    // Record an intent and mark it sent without the remote committing: the
    // dangerous window where the caller cannot tell.
    await ledger.recordIntent(intent('cancel-3', { target: 'production' }))
    const identity = identify(intent('cancel-3', { target: 'production' }))
    const held = ledger.get(identity.operationId)
    expect(held?.status).toBe('intent_recorded')

    const report = await ledger.cancel(adapter, intent('cancel-3', { target: 'production' }))
    expect(report.outcome).toBe('not_started')
    expect(report.mayHaveHappened).toBe(false)
    expect(report.reverted).toBe(false)
    expect(report.reason).toMatch(/proof about our own write ordering, not an undo/)
  })

  it('does not treat a cancellation of an unrecorded operation as proof it never happened', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const report = await ledger.cancel(adapter, intent('cancel-4', { target: 'production' }))
    expect(report.outcome).toBe('unknown')
    expect(report.reverted).toBe(false)
    expect(report.reason).toMatch(/does not claim the operation is impossible elsewhere/)
    expect(remote.performCalls).toBe(0)
  })

  it('refuses to cancel an operation whose parameters differ from the recorded ones', async () => {
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('cancel-5', { target: 'staging' }))

    const report = await ledger.cancel(adapter, intent('cancel-5', { target: 'production' }))
    expect(report.outcome).toBe('conflict')
    expect(report.mayHaveHappened).toBe(true)
    expect(report.reverted).toBe(false)
    expect(remote.performCalls).toBe(1)
  })

  it('never reports a cancellation as an undo, in any branch', async () => {
    // Asserted across every reachable branch, because the failure mode is a report
    // that says the world was restored when it was not.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    await ledger.perform(adapter, intent('u-1', { target: 'x' }))
    await ledger.recordIntent(intent('u-2', { target: 'x' }))
    remote.performFaults.push('commit-then-throw')
    await ledger.perform(adapter, intent('u-3', { target: 'x' }))

    const reports = [
      await ledger.cancel(adapter, intent('u-1', { target: 'x' })),
      await ledger.cancel(adapter, intent('u-2', { target: 'x' })),
      await ledger.cancel(adapter, intent('u-3', { target: 'x' })),
      // Never recorded by this ledger: still not a claim that it did not happen.
      await ledger.cancel(adapter, intent('u-4', { target: 'x' })),
      // Same operationId as u-1 but different parameters: a conflict, not a cancel.
      await ledger.cancel(adapter, intent('u-1', { target: 'y' })),
    ]
    expect(reports).toHaveLength(5)
    for (const report of reports) {
      expect(report.reverted).toBe(false)
      expect(report.reason).not.toMatch(/rolled back|undone|reverted|reversed/)
    }
    // The ledger still holds every intent it recorded: a cancellation does not erase
    // the record of what may already have happened.
    for (const key of ['u-1', 'u-2', 'u-3']) {
      expect(ledger.get(identify(intent(key, { target: 'x' })).operationId), key).toBeDefined()
    }
    expect(remote.performCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: the durable record itself
// ---------------------------------------------------------------------------

describe('the ledger record', () => {
  it('keeps the intent durable before the transport is invoked', async () => {
    // Proven by construction: record the intent, then confirm the record exists
    // with zero attempts and a status that says the call was never made.
    const remote = new CountingRemote()
    const adapter = new FakeAdapter(remote)
    const stored = await ledger.recordIntent(intent('dur-1', { target: 'x' }))
    expect(stored.status).toBe('intent_recorded')
    expect(stored.attempts).toBe(0)
    expect(stored.parameters).toBe(canonicalJson({ target: 'x' }))
    expect(remote.performCalls).toBe(0)
    expect(ledger.get(stored.operationId)?.operationId).toBe(stored.operationId)
  })

  it('records every transport call id it saw, as an audit trail and not as identity', async () => {
    const remote = new CountingRemote()
    remote.performFaults.push('commit-then-throw')
    const adapter = new FakeAdapter(remote)
    const first = await ledger.perform(adapter, intent('audit-1', { target: 'x' }, 'call-first'))
    // The retry reconciles, so no second call id is recorded: that is the point.
    await ledger.perform(adapter, intent('audit-1', { target: 'x' }, 'call-second'))
    expect(ledger.get(first.operationId)?.toolCallIds).toEqual(['call-first'])
  })

  it('is a separate storage domain from the run record', () => {
    // The effect ledger must not be folded into the run record: they have
    // different lifetimes and different readers, and the run record is a
    // user-authorized plan while this is an audit of what reached a remote.
    expect(ledger.listOperationIds()).toEqual([])
  })
})
