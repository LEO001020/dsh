/**
 * Launch-port tests.
 *
 * The port is the boundary between this project and DSH's continuable child
 * machinery. What is under test here is NOT DSH (its own suite covers that) but
 * the contract this project depends on:
 *
 *   - a resolved launch means the inbox ACCEPTED the prompt, nothing more
 *   - the reserved childId is passed through, so a crash between reservation and
 *     launch stays reconcilable
 *   - a DUPLICATE_CHILD rejection is rethrown unchanged, so nobody can turn it
 *     into a retry with a fresh UUID
 *   - an unknown failure is rethrown, so the service can record `unknown` and
 *     keep holding the reservation
 *
 * The stand-in is typed as the REAL `SubagentsLike` slice of `SubagentRuntime`,
 * so it cannot drift from the interface it replaces.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContinuableStart, ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import { createContinuableLaunchPort, type SubagentsLike } from './launch-port.ts'

/** A minimal stand-in that records the specs it was asked to admit. */
class RecordingSubagents implements SubagentsLike {
  readonly specs: ContinuableStartSpec[] = []
  /** When set, `startContinuable` rejects with this error. */
  failWith: Error | undefined
  /** When set, the stand-in echoes this id instead of the reserved one. */
  echoId: string | undefined

  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    this.specs.push(spec)
    if (this.failWith !== undefined) throw this.failWith
    return { childId: (this.echoId ?? spec.childId) as ContinuableStart['childId'], messageId: 'm1' as never }
  }
}

function parentStub(): Agent {
  return { session: { header: { id: 'session-root' } } } as never
}

function port(subagents: RecordingSubagents, overrides: { maxDepth?: number } = {}) {
  return createContinuableLaunchPort({
    subagents,
    parent: parentStub(),
    provider: 'spawn',
    maxDepth: overrides.maxDepth ?? 1,
  })
}

const REQUEST = { taskId: 'task-1', childId: 'child-1', prompt: 'do the thing', reservedCost: 1 }

describe('continuable launch port', () => {
  it('passes the reserved childId through so recovery stays reconcilable', async () => {
    const subagents = new RecordingSubagents()
    await port(subagents).launch(REQUEST, new AbortController().signal)
    expect(subagents.specs).toHaveLength(1)
    expect(String(subagents.specs[0]?.childId)).toBe('child-1')
  })

  it('sends the prompt as ContentBlock[], not a bare string', async () => {
    // A continuable request takes ContentBlock[]. Passing a string would be a
    // type error, and this pins the runtime shape as well.
    const subagents = new RecordingSubagents()
    await port(subagents).launch(REQUEST, new AbortController().signal)
    expect(subagents.specs[0]?.request.prompt).toEqual([{ type: 'text', text: 'do the thing' }])
  })

  it('carries maxDepth so children cannot open unbilled grandchildren', async () => {
    const subagents = new RecordingSubagents()
    await port(subagents, { maxDepth: 1 }).launch(REQUEST, new AbortController().signal)
    expect(subagents.specs[0]?.request.maxDepth).toBe(1)
  })

  it('uses the task id as the child creation label', async () => {
    const subagents = new RecordingSubagents()
    await port(subagents).launch(REQUEST, new AbortController().signal)
    expect(subagents.specs[0]?.label).toBe('task-1')
  })

  it('forwards the abort signal so a cancelled admission can be aborted', async () => {
    const subagents = new RecordingSubagents()
    const controller = new AbortController()
    await port(subagents).launch(REQUEST, controller.signal)
    expect(subagents.specs[0]?.signal).toBe(controller.signal)
  })

  it('resolves at admission and does not wait for the child to work', async () => {
    // The core contract. The stand-in resolves immediately, mirroring DSH, which
    // resolves "without waiting for the turn to start". If this port ever grew a
    // wait-for-completion, this test would still pass, so it is paired with the
    // host test that asserts the task lands in `accepted` and NOT `executing`.
    const subagents = new RecordingSubagents()
    const result = await port(subagents).launch(REQUEST, new AbortController().signal)
    expect(result.childId).toBe('child-1')
  })

  it('rethrows DUPLICATE_CHILD unchanged so it cannot become a fresh-UUID retry', async () => {
    // INV-D4. A duplicate means "query the existing child", never "launch again".
    const subagents = new RecordingSubagents()
    const duplicate = Object.assign(new Error('subagent "child-1" already exists'), { code: 'DUPLICATE_CHILD' })
    subagents.failWith = duplicate
    await expect(port(subagents).launch(REQUEST, new AbortController().signal)).rejects.toBe(duplicate)
  })

  it('rethrows an unknown failure so the caller can quarantine rather than retry', async () => {
    const subagents = new RecordingSubagents()
    subagents.failWith = new Error('transport reset')
    await expect(port(subagents).launch(REQUEST, new AbortController().signal)).rejects.toThrow('transport reset')
  })

  it('refuses to record a child id the provider allocated instead of the reserved one', async () => {
    // A mismatched identity would break the reconciliation relation the record
    // is keyed on, so it is a hard error rather than a silent acceptance.
    const subagents = new RecordingSubagents()
    subagents.echoId = 'child-somebody-elses'
    await expect(port(subagents).launch(REQUEST, new AbortController().signal)).rejects.toThrow(
      /refusing to record a mismatched identity/,
    )
  })

  it('omits agentOptions entirely when no child route is configured', async () => {
    // Absent must mean "inherit", not "override with undefined".
    const subagents = new RecordingSubagents()
    await port(subagents).launch(REQUEST, new AbortController().signal)
    expect('agentOptions' in (subagents.specs[0]?.request ?? {})).toBe(false)
  })
})
