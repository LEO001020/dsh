/**
 * A10 keyless scripted adapter.
 *
 * It is deliberately a real `LlmAdapter` registered on the real `ctx.llm`, so
 * the production AgentLoop, the production tool registry and the production
 * Session log are all in the path. The only thing removed is the network.
 *
 * Three scripts, selected by `M914_SCRIPT`:
 *
 *   tool-then-answer  one real shell tool call, then a final answer. The
 *                     baseline that proves the boundary test is measuring the
 *                     runner and not a broken composition.
 *   huge-output       the same, but the shell command emits ~1 MiB. The model
 *                     then answers with a SHORT string: the oversized text
 *                     exists only in the tool result, which is exactly the
 *                     payload `boundJsonLine` has to bound.
 *   business-failure  the shell command EXITS NON-ZERO and the model then
 *                     reports the failure in prose and finishes normally.
 *                     Nothing in this script throws, so the turn ends
 *                     `completed` and the process exits 0 even though the
 *                     business outcome is a failure. That is the whole point:
 *                     `exit 0` is a statement about the turn, not the work.
 *
 * @module m914-mock-llm
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

const SCRIPT = process.env['M914_SCRIPT'] ?? 'tool-then-answer'

/** ~1 MiB of shell output, in one line so the JSON line cap is what bounds it. */
const HUGE_BYTES = 1024 * 1024
const HUGE_COMMAND = process.platform === 'win32'
  ? `Write-Output ('X' * ${String(HUGE_BYTES)})`
  : `head -c ${String(HUGE_BYTES)} /dev/zero | tr '\0' 'X'`

const FAILING_COMMAND = process.platform === 'win32'
  ? "Write-Output 'M914_BUSINESS_FAILURE'; exit 3"
  : "echo M914_BUSINESS_FAILURE; exit 3"

function command(): { command: string; description: string } {
  if (SCRIPT === 'huge-output') {
    return { command: HUGE_COMMAND, description: 'Emit about one mebibyte of output.' }
  }
  if (SCRIPT === 'business-failure') {
    return { command: FAILING_COMMAND, description: 'Run a command that reports a business failure.' }
  }
  return {
    command: process.platform === 'win32' ? "Write-Output 'M914_OK'" : 'echo M914_OK',
    description: 'Prove the one-shot runner drives a real tool call.',
  }
}

/** The final assistant text per script. The model reports; it does not decide. */
function finalText(): string {
  if (SCRIPT === 'business-failure') return 'M914_REPORT: the command failed and I am reporting it in prose.'
  if (SCRIPT === 'huge-output') return 'M914_REPORT: done.'
  return 'M914_REPORT: done.'
}

class M914MockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const alreadyCalled = options.messages
      .at(-1)?.content.some(block => block.type === 'tool-result') === true
    if (alreadyCalled) {
      const text = finalText()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const { command: cmd, description } = command()
    const args = JSON.stringify({ command: cmd, description })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: ToolCallId('m914-call'), name: SHELL_TOOL, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('m914-call'), name: SHELL_TOOL, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'm914-mock-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new M914MockAdapter())
}
