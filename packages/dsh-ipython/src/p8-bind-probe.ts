/**
 * P8 PROBE — the source-identity instrument, before and after the fix.
 *
 * WHY THIS FILE EXISTS AS A PROBE AND NOT AS A TEST. It must be runnable BOTH
 * against the pre-fix tree (to archive the reproduction) and against the
 * post-fix tree (to show the change), from one instrument, so the two records
 * are comparable. It is imported by nothing and is in no entry point; the
 * guard in `bridge-seam.test.ts` keeps a named list of such files so this
 * cannot be mistaken for a production caller.
 *
 * WHAT IT MEASURES, AND WHY EACH ONE IS A REAL OBSERVATION.
 *
 *  1. SOURCE IDENTITY. `get_ipython().history_manager.input_hist_raw[-1]` is
 *     IPython's own record of the exact string it was handed for the cell that
 *     just ran. It is written by IPython's `store_inputs(execution_count, cell,
 *     raw_cell)` from the `execute_request`'s `code` field, so reading it back
 *     is reading the kernel's own account of what it received -- not the host's
 *     account of what it sent, and not what the bridge says about itself.
 *
 *  2. THE LINE NUMBERS A USER SEES. A traceback and a SyntaxError both report
 *     the line number of the compiled source. If the source was rewritten, the
 *     number is the rewritten one.
 *
 *  3. CELL MAGICS. `%%capture` must be the first line. Whether it binds `dsh`
 *     at all is a different question from whether it runs.
 *
 *  4. THE STALE CAPABILITY. Whether a `dsh` object from a settled cell is still
 *     reachable in the namespace of a later cell.
 *
 * Run:  node --experimental-strip-types src/p8-bind-probe.ts
 * Out:  JSON on stdout, and to $P8_PROBE_OUT when set.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ipythonTool from './ipython-tool.ts'
import { KernelService } from './kernel-plugin.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

const out: Record<string, unknown> = {}

function agentFor(sessionId: string, cwd: string): Agent {
  return { session: { header: { id: sessionId, cwd } } } as unknown as Agent
}

/** One JSON value a cell printed on a line shaped `KEY=<json>`. */
function jsonLine(text: string, key: string): unknown {
  const match = new RegExp(`^${key}=(.*)$`, 'mu').exec(text)
  if (match?.[1] === undefined) return undefined
  try { return JSON.parse(match[1]) } catch { return match[1] }
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const root = await mkdtemp(join(tmpdir(), 'p8-bind-probe-'))

  ctx.tools.register(defineTool({
    name: 'p8_echo',
    description: 'Returns its argument, so a successful call is distinguishable from a refusal.',
    parameters: { tag: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => ({ tag: (args as { tag: string }).tag }),
  }))

  const service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: BROKER,
    root: join(root, 'kernels'),
    durableLedger: false,
  })
  ipythonTool.apply(ctx)

  const agent = agentFor('p8-probe', root)
  let seq = 0
  /** Drive the REAL model-facing tool through the REAL registry, as the loop does. */
  async function cell(code: string): Promise<{ text: string, outcome: string }> {
    seq += 1
    const result = await ctx.tools.execute({
      callId: `p8-outer-${String(seq)}` as never,
      name: ipythonTool.IPYTHON_TOOL_NAME,
      arguments: { code },
      agent,
      signal: new AbortController().signal,
    })
    if (result.isError) return { text: result.error.message, outcome: 'error' }
    const value = result.value as { text: string, outcome: string }
    return { text: value.text, outcome: value.outcome }
  }

  // ---- 1. SOURCE IDENTITY -------------------------------------------------
  // The cell's own bytes, printed back from IPython's own record of them.
  const modelSource = [
    'import json as _json, IPython as _ipython',
    '_h = _ipython.get_ipython().history_manager',
    'print("RECORDED=" + _json.dumps(_h.input_hist_raw[-1]))',
    'print("PARSED=" + _json.dumps(_h.input_hist_parsed[-1]))',
  ].join('\n')
  const identity = await cell(modelSource)
  out['sourceIdentity'] = {
    submitted: modelSource,
    submittedSha256: await sha256(modelSource),
    recorded: jsonLine(identity.text, 'RECORDED') ?? null,
    recordedSha256: typeof jsonLine(identity.text, 'RECORDED') === 'string'
      ? await sha256(jsonLine(identity.text, 'RECORDED') as string)
      : null,
    outcome: identity.outcome,
    rawText: identity.text,
  }

  // ---- 2. TRACEBACK LINE NUMBER ------------------------------------------
  // Line 3 raises. A user reading the traceback expects `line 3`.
  const tbSource = ['x = 1', 'y = 2', 'raise ValueError("boom")'].join('\n')
  const tb = await cell(tbSource)
  out['tracebackLine'] = { submitted: tbSource, outcome: tb.outcome, reportedLine: reportedLine(tb.text), text: tb.text }

  // ---- 3. SYNTAX ERROR LINE NUMBER ---------------------------------------
  const syntaxSource = ['a = 1', 'b = 2', 'def broken(:'].join('\n')
  const syntax = await cell(syntaxSource)
  out['syntaxErrorLine'] = {
    submitted: syntaxSource,
    outcome: syntax.outcome,
    reportedLine: reportedLine(syntax.text),
    text: syntax.text,
  }

  // ---- 4. CELL MAGIC: does it run, and is `dsh` bound INSIDE it? ---------
  // `%%capture` is a real IPython cell magic present in this environment. The
  // question is asked from INSIDE the magic cell, because that is where a fresh
  // binding would have to be visible. `%%capture` swallows stdout, so the
  // observation is written to a file the NEXT cell reads -- otherwise a
  // captured print would look identical to a cell that never ran.
  const magicReport = join(root, 'magic-report.json')
  const magicSource = [
    '%%capture cap',
    'import json as _json',
    'report = {"dsh_in_dir": "dsh" in dir()}',
    'try:',
    "    import dsh as _dsh",
    "    report['import'] = 'OK'",
    'except Exception as exc:',
    "    report['import'] = type(exc).__name__",
    'if report["dsh_in_dir"]:',
    '    try:',
    "        await dsh.call('p8_echo', {'tag': 'from-the-magic-cell'})",
    "        report['call'] = 'SERVED'",
    '    except Exception as exc:',
    "        report['call'] = getattr(exc, 'code', type(exc).__name__)",
    'else:',
    "    report['call'] = 'NO_DSH'",
    `with open(${JSON.stringify(magicReport.replace(/\\/gu, '/'))}, 'w', encoding='utf-8') as _h:`,
    '    _json.dump(report, _h, sort_keys=True)',
  ].join('\n')
  const magic = await cell(magicSource)
  const magicProbe = await cell([
    'import json as _json, os',
    `p = ${JSON.stringify(magicReport.replace(/\\/gu, '/'))}`,
    'print("MAGIC_CELL=" + (_json.dumps(_json.load(open(p, encoding="utf-8")), sort_keys=True) if os.path.exists(p) else "null"))',
  ].join('\n'))
  out['cellMagic'] = {
    submitted: magicSource,
    outcome: magic.outcome,
    text: magic.text,
    insideMagic: jsonLine(magicProbe.text, 'MAGIC_CELL') ?? null,
    insideMagicRaw: magicProbe.text,
  }

  // ---- 5. STALE CAPABILITY ACROSS A CELL MAGIC ---------------------------
  // Cell A binds `dsh` (an ordinary cell) and makes a call that SUCCEEDS. Cell B
  // is a cell magic. Cell C asks whether the `dsh` object from cell A is still
  // reachable AND whether it can still call. Cell C is ordinary, so it receives
  // its own fresh bind -- which is why the interesting case for the stale
  // capability is the authority-less cell in arm 8, not this one.
  const a = await cell("await dsh.call('p8_echo', {'tag': 'cell-a'})\nprint('A_OK=True')")
  await cell(['%%capture held', 'print("B_RAN=True")'].join('\n'))
  const stale = await cell([
    'import json as _json',
    'report = {"dsh_in_dir": "dsh" in dir()}',
    'if report["dsh_in_dir"]:',
    '    try:',
    "        await dsh.call('p8_echo', {'tag': 'cell-c'})",
    "        report['call'] = 'SERVED'",
    '    except Exception as exc:',
    "        report['call'] = getattr(exc, 'code', type(exc).__name__)",
    'print("STALE=" + _json.dumps(report, sort_keys=True))',
  ].join('\n'))
  out['staleAfterMagic'] = {
    cellA: { outcome: a.outcome, text: a.text },
    text: stale.text,
    parsed: jsonLine(stale.text, 'STALE') ?? null,
    outcome: stale.outcome,
  }

  // ---- 6. `%who` AND TOP-LEVEL AWAIT -------------------------------------
  const who = await cell('%who')
  out['who'] = { outcome: who.outcome, text: who.text }
  const awaited = await cell([
    'import asyncio',
    'value = await asyncio.sleep(0.01, result=7)',
    'print("AWAIT=" + str(value))',
  ].join('\n'))
  out['topLevelAwait'] = { outcome: awaited.outcome, text: awaited.text }

  // ---- 7. THE LEASE ROTATES PER CELL ------------------------------------
  const leaseA = await cell([
    'import json as _json',
    'print("LEASE=" + _json.dumps(dsh._channel._lease))',
  ].join('\n'))
  const leaseB = await cell([
    'import json as _json',
    'print("LEASE=" + _json.dumps(dsh._channel._lease))',
  ].join('\n'))
  out['leasePerCell'] = {
    first: jsonLine(leaseA.text, 'LEASE') ?? null,
    second: jsonLine(leaseB.text, 'LEASE') ?? null,
    differs: jsonLine(leaseA.text, 'LEASE') !== jsonLine(leaseB.text, 'LEASE'),
  }

  // ---- 8. AN AUTHORITY-LESS CELL: is a prior `dsh` reusable? -------------
  // Drive `runCell` directly with NO authority, exactly as an internal probe or
  // a test does. V5 §9 requires the hidden control phase to REVOKE `dsh` rather
  // than merely omit a new bind -- and the claim in the pre-fix comment is that
  // `dsh` is "simply absent". This measures whether it is, and if it is not,
  // what a call through the surviving object does.
  const noAuth = await service.runCell(agent, [
    'import json as _json',
    'report = {"dsh_in_dir": "dsh" in dir()}',
    'try:',
    "    import dsh as _dsh",
    "    report['import'] = 'OK'",
    'except Exception as exc:',
    "    report['import'] = type(exc).__name__",
    'if "dsh" in dir():',
    '    report["bound_lease"] = getattr(getattr(dsh, "_channel", None), "_lease", None)',
    '    try:',
    "        await dsh.call('p8_echo', {'tag': 'from-the-authority-less-cell'})",
    "        report['call'] = 'SERVED'",
    '    except Exception as exc:',
    "        report['call'] = getattr(exc, 'code', type(exc).__name__)",
    'else:',
    "    report['call'] = 'NO_DSH'",
    'print("NOAUTH=" + _json.dumps(report, sort_keys=True))',
  ].join('\n'))
  out['authorityLess'] = {
    text: noAuth.stdout.text,
    parsed: jsonLine(noAuth.stdout.text, 'NOAUTH') ?? null,
    outcome: noAuth.outcome,
    stderr: noAuth.stderr.text,
  }

  out['identity'] = {
    python: PYTHON,
    node: process.version,
    serviceRoot: root,
  }

  console.log(JSON.stringify(out, null, 2))
  const target = process.env['P8_PROBE_OUT']
  if (target !== undefined) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(out, null, 2), 'utf8')
  }

  await service.close().catch(() => undefined)
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

/** The `line N` a traceback or SyntaxError text names, as a number. */
function reportedLine(text: string): number | null {
  const matches = [...text.matchAll(/line (\d+)/gu)].map(match => Number(match[1]))
  return matches.length === 0 ? null : matches[0] as number
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

await main()
