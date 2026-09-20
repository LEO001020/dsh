/**
 * V4 scope probe: the BR-10 and BR-11 arms the scope suite does not cover.
 *
 * WHY THIS FILE EXISTS. `programmatic-scope.test.ts` covers BR-04/05/06/07/11
 * partially and BR-10 partially:
 *
 *   - BR-10 names THREE close reasons (`completed`/`aborted`/`error`) and
 *     requires each to be recorded on every disposition. The suite exercises
 *     `completed` (34x) and `aborted` (4x) and NEVER `error`. So the third arm
 *     of the oracle is unmeasured, and this probe measures it.
 *   - BR-11 requires the DELIVERED BYTE COUNT per mode and the mode to be
 *     visible in the record. The suite asserts the two modes' BEHAVIOUR
 *     (deferred vs retained, `scope.content()[0].blockTypes`) but records no
 *     byte counts, so "the delivered byte counts differ as the modes require"
 *     is not established by it.
 *
 * WHAT IS REAL. The real `ToolRuntime` mounted through `ctx.plugin`, so
 * `tools/pre-execute`, the guard slot, the output-schema gate, `tools/post-execute`
 * and `tools/result` are the shipped behaviours. The scope is the real
 * `createProgrammaticCallScope`. No kernel is started: this is the scope route,
 * which is the route the spec's BR-10/BR-11 stimuli name ("Close a programmatic
 * scope...", "Run one image-returning tool with `contentProjection`...").
 *
 * WHAT THIS DOES NOT ESTABLISH. It does not establish that the PRODUCT opens a
 * scope on the model's Python path. The scope service IS wired
 * (`cordis.patch.yml` row `daily-programmatic-scope`), but the IPython bridge
 * does NOT route through it -- the bridge calls `ctx.tools.execute` directly
 * via `native-call.ts`, and nothing constructs a `BridgeServer` at all
 * (docs/GAPS.md G-SEAM-34). So these arms measure the scope MECHANISM, and the
 * case records say which route.
 *
 * Run:  node --experimental-strip-types src/v4-scope-probe.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import {
  createProgrammaticCallScope,
  type ProgrammaticCallScopeHandle,
  type ScopeCallDisposition,
  type ScopeCloseReason,
  type ScopeJobHandoff,
} from './programmatic-scope.ts'

const IMAGE_BYTES = 4096

const observed: Record<string, unknown> = {}

/** A real registry, the same composition the scope suite mounts. */
async function rig(): Promise<{ ctx: Context; tools: ToolRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  return { ctx, tools: ctx.tools }
}

/** Register an image-returning tool whose canonical value is a small summary. */
function registerImageTool(ctx: Context, name: string): { calls: number } {
  const state = { calls: 0 }
  ctx.tools.register(defineTool({
    name,
    description: 'Returns a bulk image alongside its summary.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        { type: 'text', text: value },
        {
          type: 'image',
          attachment: {
            attachmentId: 'cafebabe' as never,
            mediaType: 'image/png',
            bytes: IMAGE_BYTES,
            width: 64,
            height: 64,
          },
        },
      ],
    },
    execute: () => { state.calls += 1; return Promise.resolve('v4: image captured') },
  }))
  return state
}

/** Register a tool that never settles until its signal aborts (a real in-flight call). */
function registerSlowTool(ctx: Context, name: string): { started: number; finished: number } {
  const state = { started: 0, finished: 0 }
  ctx.tools.register(defineTool({
    name,
    description: 'Runs until its signal aborts.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      state.started += 1
      return new Promise<string>(resolve => {
        exec.signal.addEventListener('abort', () => {
          state.finished += 1
          resolve(`aborted:${(args as { id: string }).id}`)
        }, { once: true })
      })
    },
  }))
  return state
}

/** Open a scope the way the host service does, with the sinks recorded. */
function openScope(
  tools: ToolRuntime,
  options: {
    contentProjection?: 'reference' | 'defer-images'
    maxParallel?: number
    handoffToJobs?: ScopeJobHandoff
  } = {},
): {
  scope: ProgrammaticCallScopeHandle
  deferred: UserMessage[]
  dispositions: ScopeCallDisposition[]
  conclusions: number
} {
  const deferred: UserMessage[] = []
  const dispositions: ScopeCallDisposition[] = []
  const state = { conclusions: 0 }
  const scope = createProgrammaticCallScope({
    registry: tools,
    parent: Symbol('v4.parent') as unknown as ToolExecutionToken,
    signal: new AbortController().signal,
    callIdPrefix: 'v4-scope',
    control: {
      deferContext: (context) => { deferred.push(context) },
      concludeTurn: () => { state.conclusions += 1 },
    },
    maxParallel: options.maxParallel ?? 10,
    ...options.contentProjection === undefined ? {} : { contentProjection: options.contentProjection },
    onDisposition: (disposition) => { dispositions.push(disposition) },
    ...options.handoffToJobs === undefined ? {} : { handoffToJobs: options.handoffToJobs },
  })
  return { scope, deferred, dispositions, get conclusions() { return state.conclusions } }
}

/** Count the bytes a deferred user message would deliver to the model. */
function deliveredBytes(messages: readonly UserMessage[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content as readonly ContentBlock[]) {
      if (block.type === 'text') total += Buffer.byteLength(block.text, 'utf8')
      else if (block.type === 'image') total += block.attachment.bytes
      else total += Buffer.byteLength(JSON.stringify(block), 'utf8')
    }
  }
  return total
}

async function main(): Promise<void> {
  // =======================================================================
  // BR-10: close a scope with a nested call UNSETTLED, for EACH close reason.
  // =======================================================================
  const br10: Record<string, unknown> = {}
  for (const reason of ['completed', 'aborted', 'error'] as const satisfies readonly ScopeCloseReason[]) {
    const { ctx, tools } = await rig()
    const slow = registerSlowTool(ctx, 'v4_slow')
    // maxParallel 2 with five submitted calls: two start and are IN FLIGHT at
    // close, three have not started. Both classes must carry a disposition.
    const opened = openScope(tools, { maxParallel: 2 })
    const calls = ['1', '2', '3', '4', '5'].map(id =>
      opened.scope.invoke('v4_slow', { id }, 'value')
        .then(() => 'settled', (error: unknown) => `refused:${(error as Error).message.slice(0, 60)}`))
    // Wait until at least one call has genuinely started, so "in flight at close"
    // is a measured state and not a race.
    const deadline = Date.now() + 10_000
    while (slow.started < 1 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const startedAtClose = slow.started
    await opened.scope.close(reason)
    const outcomes = await Promise.all(calls)

    const byKind: Record<string, number> = {}
    for (const disposition of opened.dispositions) {
      byKind[disposition.disposition] = (byKind[disposition.disposition] ?? 0) + 1
    }
    br10[reason] = {
      startedAtClose,
      finishedByClose: slow.finished,
      submittedCalls: 5,
      dispositions: opened.dispositions.map(d => ({
        subCallId: d.subCallId,
        disposition: d.disposition,
        closeReason: d.closeReason ?? null,
        nested: d.nested,
      })),
      dispositionCounts: byKind,
      totalDispositions: opened.dispositions.length,
      everyCallReachedATerminalState: outcomes.every(outcome => outcome.length > 0),
      outcomes,
      // The oracle: every sub-call carries a disposition, the close reason is
      // recorded from the declared vocabulary, and no call survives the close
      // unsettled.
      everyDispositionCarriesTheCloseReason:
        opened.dispositions.every(d => d.closeReason === reason),
      uniqueSubCallIds: new Set(opened.dispositions.map(d => d.subCallId)).size,
    }
    await ctx.fiber.dispose()
  }
  observed['br10_scope_close_per_reason'] = br10

  // =======================================================================
  // BR-11: the DECLARED mode is honoured, with the delivered BYTE COUNT.
  // =======================================================================
  const br11: Record<string, unknown> = {}
  for (const mode of ['reference', 'defer-images'] as const) {
    const { ctx, tools } = await rig()
    const image = registerImageTool(ctx, 'v4_image')
    const opened = openScope(tools, { contentProjection: mode })
    const value = await opened.scope.invoke('v4_image', {}, 'value')
    await opened.scope.close('completed')

    const retained = opened.scope.content()
    br11[mode] = {
      declaredMode: mode,
      // The program's own copy is the canonical value, identical in both modes.
      canonicalValue: value,
      toolExecutions: image.calls,
      // What entered MODEL CONTEXT on this route.
      deferredMessages: opened.deferred.length,
      bytesDeliveredToModelContext: deliveredBytes(opened.deferred),
      imageBytesInDeferredMessages: opened.deferred.reduce((sum, message) =>
        sum + (message.content as readonly ContentBlock[])
          .filter(block => block.type === 'image')
          .reduce((inner, block) => inner + (block.type === 'image' ? block.attachment.bytes : 0), 0), 0),
      // What was RETAINED as an auditable reference instead.
      retainedPayloads: retained.length,
      retainedBytes: retained.reduce((sum, record) => sum + record.bytes, 0),
      retainedBlockTypes: retained.map(record => record.blockTypes),
      retainedLossless: retained.map(record => record.lossless),
      retainedSha256: retained.map(record => record.reference.sha256),
      declaredImageBytes: IMAGE_BYTES,
      // The mode is VISIBLE in the record, not only in the constructor argument.
      modeVisibleInTheRecord: {
        contentRecords: retained.length,
        noticeRecords: opened.scope.notices().length,
        // The retained record's presence or absence IS the mode's observable.
        observable: retained.length > 0 ? 'reference (retained, kept out of context)' : 'defer-images (deferred into context)',
      },
    }
    await ctx.fiber.dispose()
  }
  // The comparison the oracle asks for, stated as the difference.
  const reference = br11['reference'] as { bytesDeliveredToModelContext: number; retainedBytes: number }
  const deferred = br11['defer-images'] as { bytesDeliveredToModelContext: number; retainedBytes: number }
  observed['br11_content_projection'] = {
    ...br11,
    theDifference: {
      bytesToModelContext: { reference: reference.bytesDeliveredToModelContext, deferImages: deferred.bytesDeliveredToModelContext },
      bytesRetained: { reference: reference.retainedBytes, deferImages: deferred.retainedBytes },
      modesDifferAsRequired:
        reference.bytesDeliveredToModelContext === 0
        && deferred.bytesDeliveredToModelContext > 0
        && reference.retainedBytes > 0
        && deferred.retainedBytes === 0,
    },
  }

  const text = JSON.stringify(observed, null, 2)
  const out = process.env['DSH_PROBE_OUT']
  if (out !== undefined && out !== '') writeFileSync(out, text + '\n', 'utf8')
  process.stdout.write(text + '\n')
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + '\n')
  process.exitCode = 1
})
