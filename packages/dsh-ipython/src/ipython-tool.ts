/**
 * The model-facing `ipython` tool: ONE tool, ONE parameter.
 *
 * WHY THERE IS NO `ipython_open` / `_send` / `_read` / `_status` / `_close`. A
 * session-per-call protocol makes the model responsible for lifecycle, which
 * means it can also get lifecycle wrong: a forgotten kernel leaks memory, a
 * second `open` splits the namespace, and a `close` racing a running cell
 * destroys work. The architecture document puts kernel lifecycle in the host for
 * exactly this reason ("kernel lifecycle belongs to the host"). The model gets
 * `code` and nothing else.
 *
 * WHAT THE MODEL CANNOT DO THROUGH THIS TOOL. It cannot start, restart, shut
 * down, or evict a kernel; it cannot raise its own output cap or cell timeout;
 * it cannot read the connection file; it cannot reach the broker. Those are all
 * host-side decisions taken from trusted configuration. A tool that let the
 * model widen its own resource ceiling would not be a resource ceiling.
 *
 * ===========================================================================
 * THIS TOOL IS THE PRODUCT PATH THAT REACHES THE NATIVE-TOOL BRIDGE (F2)
 * ===========================================================================
 *
 * `bridge.ts` and `native-call.ts` were, until this change, outside the
 * transitive closure of every package entry point: `new BridgeServer` had zero
 * production call sites (G-SEAM-34). The mechanism was implemented, unit-tested
 * and correct, and a Python cell could reach NO DSH tool, which made `ipython`
 * a dead end for everything except pure computation.
 *
 * The path is now: a model turn calls `ipython` -> the registry dispatches this
 * tool's `execute` with a live `ToolRunContext` -> this function builds a
 * {@link CellAuthority} from that context -> `KernelService.runCell` mints a
 * CellLease on the Session's kernel bridge and prepends the bridge preamble to
 * the cell -> Python's `dsh.call(...)` travels the loopback channel back to that
 * lease -> the lease's handler runs `ctx.tools.execute` -> the value returns to
 * the cell. Every link is a production call.
 *
 * WHY THE AUTHORITY IS BUILT HERE AND NOT PASSED IN. `exec` is the registry's own
 * live execution object. Its `token` is a value only the registry can mint, so
 * building the authority from it is what makes "Python cannot choose the Agent,
 * the Session, the root call id, or the token" true by construction rather than
 * by a check. Nothing in this file reads a value the model supplied.
 *
 * WHY `deferContext` IS FORWARDED RATHER THAN REPLACED. A nested exact call that
 * attached policy context or asked to conclude the turn must reach the SAME outer
 * execution this tool is running under (V3 §J4). `exec.deferContext` and
 * `exec.concludeTurn` ARE that outer execution's own capabilities, so forwarding
 * them is the whole mechanism -- there is no second ferry to keep in sync.
 *
 * The schema is declared ONCE, so the native call path and any programmatic path
 * are generated from the same definition and cannot drift.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KernelBindError, KernelBusyError, KernelOutcomeUnknownError, KernelTransportError } from './kernel.ts'
import type { CellResult } from './protocol.ts'
import type { LateNotice, LateNoticeAccount } from './late-notice.ts'
import type { CellAuthority, KernelService } from './kernel-plugin.ts'

export const name = 'dsh-ipython-tool'
export const inject = ['tools']

/** The single model-facing entry point. */
export const IPYTHON_TOOL_NAME = 'ipython'

/**
 * Render a cell result as the bounded, structured projection the model reads.
 *
 * The projection is deliberately lossy and says so. Every field that could hide
 * a loss -- `truncated`, `droppedFrames`, `spillPath`, `outcome`, `generation` --
 * is present in the text, because a model that cannot see that its output was
 * cut will reason about a prefix as if it were the whole.
 */
function renderCell(result: CellResult, epoch: number): string {
  const lines: string[] = []
  lines.push(`outcome: ${result.outcome}`)
  lines.push(`kernel epoch: ${epoch}`)

  if (result.generation !== undefined) {
    // Stated before the output, not after: a reader that stops at the first
    // line must still learn that the namespace it remembers is gone.
    lines.push(
      `KERNEL GENERATION CHANGED: epoch ${result.generation.previousEpoch} -> ${result.generation.epoch}. ` +
      `Reason: ${result.generation.reason}. ` +
      'All volatile state (variables, imports, open files) from the previous epoch is LOST. ' +
      'Nothing was replayed.',
    )
  }

  if (result.stdout.text !== '') {
    lines.push('--- stdout ---')
    lines.push(result.stdout.text)
  }
  if (result.stdout.truncated) {
    lines.push(
      `[stdout TRUNCATED: ${result.stdout.totalBytes} bytes were produced, only the first ` +
      `${result.stdout.text.length} characters are shown` +
      `${result.stdout.spillPath === undefined ? '' : `; the complete stream is in ${result.stdout.spillPath}`}. ` +
      'This output is NOT complete.]',
    )
  }
  if (result.stdout.droppedFrames > 0) {
    lines.push(
      `[${result.stdout.droppedFrames} stdout frame(s) were refused by the transport for exceeding the ` +
      'maximum message size. Those bytes are LOST, not empty.]',
    )
  }
  if (result.stderr.text !== '') {
    lines.push('--- stderr ---')
    lines.push(result.stderr.text)
  }
  if (result.stderr.truncated) {
    lines.push(`[stderr TRUNCATED: ${result.stderr.totalBytes} bytes were produced; this is a prefix.]`)
  }
  for (const display of result.display) {
    lines.push(`--- display (${display.mime}${display.truncated ? ', TRUNCATED' : ''}) ---`)
    lines.push(display.text)
  }
  if (result.error !== undefined) {
    lines.push(`--- error: ${result.error.ename}: ${result.error.evalue} ---`)
    // The traceback is where the line number and the failing frame live; without
    // it the model knows only that something raised.
    lines.push(result.error.traceback.join('\n'))
  }
  if (result.outcome === 'interrupted') {
    lines.push(
      'The cell was interrupted. This is NOT a rollback: assignments made before the interrupt ' +
      'are still in the namespace, and assignments made during it may be partial.',
    )
  }
  if (result.outcome === 'aborted') {
    lines.push('The kernel refused to run the cell (aborted before execution). Nothing in it ran.')
  }
  if (result.foreignFrames > 0) {
    lines.push(
      `[${result.foreignFrames} shell frame(s) for other requests were ignored while waiting for this ` +
      'cell. They did not complete it.]',
    )
  }
  return lines.join('\n')
}

/**
 * Render the Session's pending late-output notices as ONE bounded message.
 *
 * ===========================================================================
 * G-SEAM-78: WHY THIS IS A SEPARATE MESSAGE AND NOT PART OF THE CELL RESULT
 * ===========================================================================
 *
 * The tool's own description promises the model that background output "is
 * reported separately as unattributed output". This function is the delivery of
 * that promise, and the word "separately" is the load-bearing one:
 *
 *   - it is returned through `deferContext`, so it reaches the model as its own
 *     message at the next step boundary, NOT as text inside a cell's stdout;
 *   - nothing here is ever concatenated into {@link renderCell}'s output, so a
 *     background write cannot be read as output of code that never ran;
 *   - it does NOT wake the model. A deferred context is appended to the step that
 *     is already happening; a thread printing at 3am starts no turn.
 *
 * THE PRESENTATION IS CAUSAL TRUTH, NOT AESTHETICS. A reader must be able to see
 * that this text came from a DIFFERENT cell -- and, for the `undecidable` class,
 * that no cell could be named at all. So the origin is stated per record, and an
 * unknown origin is never rendered as if it were a cell id.
 */
function renderLateNotices(notices: readonly LateNotice[], account: LateNoticeAccount | undefined): string {
  const lines: string[] = []
  lines.push('Runtime notice: background output from earlier cell(s)')
  lines.push('')
  lines.push(
    'This text was NOT produced by the cell you just ran. It was written by a background thread',
    'after its own cell had already settled, and it is reported here rather than inside a cell',
    'result so it cannot be mistaken for output of code that did not produce it.',
  )

  const bytes = notices.reduce((sum, notice) => sum + Buffer.byteLength(notice.text ?? '', 'utf8'), 0)
  lines.push('')
  lines.push(`records: ${String(notices.length)}, kept bytes: ${String(bytes)}`)

  for (const notice of notices) {
    lines.push('')
    lines.push(`--- ${notice.causalClass === 'known-late' ? 'late output' : 'output of UNDECIDABLE origin'} ---`)
    lines.push(`kernel epoch: ${String(notice.kernelEpoch)}`)
    lines.push(`stream: ${notice.stream}`)
    if (notice.causalClass === 'known-late') {
      lines.push(`origin cell: ${notice.cellId}`)
    } else {
      // The sentinel or an empty id is reported VERBATIM and named as what it is.
      // Rendering it as a cell id, or omitting the line, would each be a guess:
      // the first attaches the write to a cell, the second hides that the origin
      // was ever unknown.
      lines.push(
        `origin cell: UNDECIDABLE (recorded origin ${notice.cellId === '' ? '<none>' : notice.cellId}); ` +
        'this write carried no cell identity that could be preserved, so no cell is named. ' +
        'Do not assume any particular cell produced it.',
      )
    }
    if (notice.text !== undefined) {
      lines.push(notice.text.trimEnd())
      if (notice.truncated === true) {
        lines.push(
          `[TRUNCATED: ${String(notice.bytes)} bytes were written for this record; the text above is a prefix.` +
          `${notice.artifactRef === undefined ? '' : ` The complete bytes are in ${notice.artifactRef}`}]`,
        )
      }
    } else {
      // A record that was not kept is REPORTED, not dropped silently: the model
      // must learn that output existed and where it went.
      lines.push(
        `[this record's text was not kept in memory${notice.artifactRef === undefined ? '' : `; it is in ${notice.artifactRef}`}. ` +
        `${String(notice.bytes)} bytes were written.]`,
      )
    }
  }

  if (account !== undefined && (account.spilled > 0 || account.dropped > 0)) {
    lines.push('')
    lines.push(
      `[${String(account.spilled)} further record(s) were spilled${account.spillPath === undefined ? '' : ` to ${account.spillPath}`}` +
      `${account.dropped === 0 ? '' : `, and ${String(account.dropped)} record(s) exceeded every bound and were counted and DROPPED`}. ` +
      'This notice is bounded; it is not the complete set of what the kernel wrote.]',
    )
  }
  return lines.join('\n')
}

/**
 * Drain this Session's pending late-output notices and ferry them to the model.
 *
 * ===========================================================================
 * WHY `deferContext` AND NOT A RETURNED STRING (G-SEAM-78)
 * ===========================================================================
 *
 * This is the whole delivery decision of the slice, so it is stated once here.
 *
 * `exec.deferContext` is the EXISTING DSH context-injection seam. The chain, each
 * link read in the pinned checkout, is:
 *
 *   `ToolRunContext.deferContext`            packages/core/tools/src/index.ts:408
 *   -> a per-execution array                 packages/core/tools/src/index.ts:1398
 *   -> folded into the result as
 *      `additionalContexts`                  packages/core/tools/src/index.ts:1590-1598
 *   -> committed by the agent loop           packages/core/agent-loop/src/tool-calls.ts:157
 *   -> spliced into the next-step inbox      packages/core/agent-loop/src/agent.ts:491
 *   -> consumed at the next step boundary    packages/core/agent-loop/src/agent.ts:316-321
 *
 * Three properties follow from that chain rather than from a check written here:
 *
 *   1. IT DOES NOT WAKE THE MODEL. A message lands in the inbox of a step that is
 *      already running; a background thread printing starts no turn. That is
 *      V5 section 10's first rule, and it holds because the seam cannot do
 *      anything else.
 *   2. IT IS SEPARATE FROM THE CELL'S STDOUT BY CONSTRUCTION. `additionalContexts`
 *      is a different field from the tool's rendered `text`, so "never merge late
 *      output into the next cell's stdout" is not a rendering discipline that
 *      could be forgotten -- there is no code path that puts these bytes there.
 *   3. IT IS SESSION-SCOPED AND DURABLE WITHOUT A NEW STORE. The inbox is a
 *      Session projection, so the notice inherits the Session's own scoping and
 *      persistence. No new Session database is created, which V5 section 10
 *      forbids.
 *
 * WHY THE ACCOUNT IS READ FIRST. An empty drain means one of two very different
 * things: nothing was written, or everything written was dropped by a bound. The
 * account is read before the drain so the notice can report the second case; a
 * reader that saw only an empty list would read a flood as silence.
 */
function deliverLateNotices(
  exec: Pick<ToolRunContext, 'deferContext'>,
  service: KernelService,
  agent: Parameters<KernelService['drainLateNotices']>[0],
): void {
  const account = service.lateNoticeAccount(agent)
  const notices = service.drainLateNotices(agent)
  // A dropped record with nothing held is still news, so the notice is emitted
  // when EITHER list is non-empty.
  if (notices.length === 0 && (account === undefined || (account.spilled === 0 && account.dropped === 0))) return
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text: renderLateNotices(notices, account) }],
    source: { kind: 'plugin', plugin: 'dsh-ipython-late-output' },
  }))
}

/** One-line explanation of why a cell could not be delivered a result. */
function explainFailure(error: unknown): string {
  if (error instanceof KernelOutcomeUnknownError) {
    return [
      `outcome: unknown`,
      `The cell's result could not be established: ${error.message}`,
      'The kernel was reset, so the namespace is GONE and nothing was replayed.',
      'Do not assume the cell ran, and do not assume it did not: any external effect it may have ' +
      'taken is unresolved.',
      ...error.result.stdout.text === '' ? [] : ['--- stdout received before the outcome became unobservable ---', error.result.stdout.text],
    ].join('\n')
  }
  if (error instanceof KernelBusyError) {
    return `outcome: refused\nA cell is already running in this kernel. Wait for it to finish; the host does not queue cells.`
  }
  if (error instanceof KernelBindError) {
    // THE CELL WAS NEVER SENT. Saying so is the whole point of this arm: a reader
    // who saw only "the cell failed" would have to guess whether the user's code
    // ran, and the honest answer is that it did not.
    return [
      'outcome: refused',
      'The host could not bind this cell\'s capability in the kernel, so the cell was NOT run.',
      'Nothing in your code took effect.',
      `The bind failed with: ${error.bind.error?.ename ?? error.bind.outcome}: ${error.bind.error?.evalue ?? 'no detail'}`,
    ].join('\n')
  }
  if (error instanceof KernelTransportError) {
    return `outcome: transport_failure\n${error.message}`
  }
  return `outcome: failed\n${error instanceof Error ? error.message : String(error)}`
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: IPYTHON_TOOL_NAME,
      description: [
        'Run Python in this session\'s persistent IPython kernel.',
        '',
        'The kernel is a real IPython shell. It keeps its namespace between calls, so a variable,',
        'function, import or DataFrame defined in one call is still there in the next. Top-level',
        '`await` works with no async-function wrapper, and IPython magics (`%time`, `%who`, ...)',
        'work as written.',
        '',
        'There is exactly one call shape: `code`. The kernel is started, reused, reset and stopped',
        'by the host; there is no open/close/status call, and a cell cannot restart its own kernel.',
        '',
        'What to expect:',
        '- An exception does NOT roll back the namespace. Assignments made before it survive; the',
        '  error is reported with its traceback.',
        '- `input()` and `getpass()` fail immediately (stdin is disabled); they never wait.',
        '- Output is bounded. If a cell prints more than the cap, the result says TRUNCATED and',
        '  names a spill file; the text you get is a prefix, not the whole.',
        '- Output written by a background thread after the cell returns is NOT part of the result.',
        '  It is reported separately, in its own runtime-notice message, before your next step.',
        '  That notice names the cell each write came from, or says the origin is UNDECIDABLE when',
        '  no cell identity could be preserved -- in which case no cell is guessed. The notice is',
        '  bounded: if a background thread floods, the overflow goes to a spill file and the notice',
        '  says so. Background output never starts a turn of its own.',
        '- If the kernel dies or a cell cannot be given a definite outcome, the result says so and',
        '  reports a NEW kernel epoch. Variables from the old epoch are gone; nothing is replayed.',
      ].join('\n'),
      parameters: {
        code: {
          type: 'string',
          required: true,
          description: 'Python source to run as one IPython cell.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outcome: { type: 'string', required: true },
            text: { type: 'string', required: true },
            epoch: { type: 'integer' },
            isError: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const service = ctx.get('ipython') as KernelService | undefined
        if (service === undefined) {
          throw new Error('the ipython service is not mounted in this host profile')
        }
        if (exec.agent === undefined) {
          // Without an Agent there is no Session, and without a Session there is
          // no kernel identity to bind. Guessing one would give an unowned cell a
          // namespace that outlives its caller.
          throw new Error('the ipython tool requires an Agent-backed session')
        }

        // THE AUTHORITY, READ FROM THE LIVE EXECUTION. Every field here is the
        // registry's own value for THIS call: the Agent it resolved, the root call
        // id it propagated, the token only it can mint, and its own call id. The
        // model supplied none of them and has no parameter through which it could.
        const authority: CellAuthority = {
          callId: String(exec.callId),
          rootCallId: String(exec.rootCallId),
          token: exec.token,
          agent: exec.agent,
          cellId: String(exec.callId),
          // The composite ferry, forwarded rather than reimplemented: these ARE
          // the outer execution's capabilities, so a nested call's policy context
          // and turn conclusion reach the same place a native sibling's would.
          onContext: context => { exec.deferContext(context as Parameters<typeof exec.deferContext>[0]) },
          onConcludeTurn: () => { exec.concludeTurn() },
        }

        try {
          const result = await service.runCell(exec.agent, args.code, exec.signal, authority)
          const epoch = service.currentEpoch(exec.agent)
          // G-SEAM-78: THE DELIVERY. Drained AFTER the cell settled, so the notice
          // describes output that arrived up to the moment this cell returned --
          // including output produced by an earlier cell that is only now being
          // reported. It rides `deferContext` as its OWN message, so it can never
          // appear inside the cell's rendered text, and it does not conclude or
          // extend the turn.
          deliverLateNotices(exec, service, exec.agent)
          return {
            outcome: result.outcome,
            epoch,
            isError: result.outcome !== 'ok',
            text: renderCell(result, epoch),
          }
        } catch (error) {
          const epoch = service.currentEpoch(exec.agent)
          // The failure arm delivers too: a cell that could not be given a
          // definite outcome is exactly when a reader most needs to know that
          // background output exists, and withholding it because the cell failed
          // would make the notice depend on an unrelated outcome.
          deliverLateNotices(exec, service, exec.agent)
          return {
            outcome: error instanceof KernelOutcomeUnknownError ? 'unknown' : 'failed',
            epoch,
            isError: true,
            text: explainFailure(error),
          }
        }
      },
      presentCall: () => ({ card: 'generic', title: 'ipython', kind: 'other' }),
    }),
  )
}
