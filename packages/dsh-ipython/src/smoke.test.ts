/**
 * A first, deliberately small end-to-end test.
 *
 * Its only job is to prove the broker actually starts a real kernel through DSH's
 * own subprocess seam and answers one cell. Everything the gate requires is
 * asserted in `requirements.test.ts`; this file exists so a failure in the
 * transport or the framing is separated from a failure in a requirement.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelHost } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'

let ctx: Context
let root: string
let host: KernelHost | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-smoke-'))
})

afterEach(async () => {
  if (host !== undefined) {
    await host.shutdown().catch(() => undefined)
    host = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function makeHost(): KernelHost {
  host = new KernelHost({
    subprocess: ctx.subprocess,
    identity: { sessionId: 'smoke', executionWorld: 'local', environmentDigest: 'test' },
    brokerScript: BROKER,
    pythonExecutable: PYTHON,
    workingDirectory: root,
  })
  return host
}

describe('broker transport', () => {
  it('starts a kernel with curve keys and no plaintext warning', async () => {
    const h = makeHost()
    const status = await h.start()
    expect(status.alive).toBe(true)
    // The achieved transport is read back from the connection file, so this is
    // an observation of what the kernel got, not a restatement of the request.
    expect(status.curveKeysPresent).toBe(true)
    expect(status.plaintextWarningSeen).toBe(false)
    expect(status.transport).toBe('tcp')
  }, 120_000)

  it('runs one cell and reports ok', async () => {
    const h = makeHost()
    const result = await h.execute('print("hello from a real kernel")')
    expect(result.outcome).toBe('ok')
    expect(result.stdout.text).toContain('hello from a real kernel')
  }, 120_000)
})
