/**
 * R5-data probe: can the `python_exec` substitution now be the REAL thing?
 *
 * M4's DAT-02 admits `dataToolPresent: false` and substitutes a bare
 * `python -c` process for a `python_exec` cell, on the stated grounds that M3's
 * package did not exist. `packages/dsh-ipython` NOW EXISTS and boots a real
 * ipykernel (proven in M11/M12). So the question is re-opened and answered here
 * by measurement rather than by argument:
 *
 *   Q1  Does the product's own `ipython` tool drive a real kernel from THIS
 *       package's test environment?
 *   Q2  Can a cell reach the data plane (a native `data.pages` call)?
 *   Q3  Can a cell receive 512 pages over a channel the HOST serves, so the
 *       page walk stays on the artifact?
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/.../R5-data/ipython-substitution-probe.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const IPY = 'D:/DSH/work/dsh-native-daily/packages/dsh-ipython'
const PYTHON = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: Subprocess } = await import(resolveFromPkg('@deepseek-ai/dsh-subprocess-local'))
const { default: ToolRuntime } = await import(resolveFromPkg('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(resolveFromPkg('@deepseek-ai/dsh-system-prompt'))
const { default: LocalFileSystem } = await import(resolveFromPkg('@deepseek-ai/dsh-fs-local'))
const { KernelService } = await import(pathToFileURL(`${IPY}/src/kernel-plugin.ts`).href)
const ipyTool = await import(pathToFileURL(`${IPY}/src/ipython-tool.ts`).href)
const artifacts = await import(pathToFileURL(`${PKG}/src/artifacts.ts`).href)
const observations = await import(pathToFileURL(`${PKG}/src/observations.ts`).href)

const out = {}
const root = mkdtempSync(join(tmpdir(), 'r5-sub-'))
const kernelRoot = join(root, 'kernels')

let ctx
let service
try {
  // --- capture a real 32 MiB artifact through the real store ---------------
  const pageBytes = artifacts.DEFAULT_PAGE_BYTES
  const totalBytes = 512 * pageBytes
  const record = `${'r'.repeat(1022)}\n`
  const buffer = Buffer.alloc(totalBytes)
  for (let offset = 0; offset < totalBytes; offset += record.length) buffer.write(record, offset, 'utf8')
  writeFileSync(join(root, 'big32.txt'), buffer)

  ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 10 })
  await ctx.plugin(Subprocess)
  const fs = new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
  const store = new artifacts.LocalArtifactStore(join(root, 'artifacts'))
  const log = new artifacts.InMemorySessionReferenceLog()
  const grants = new observations.GrantTable()
  const scope = 'project:r5'
  grants.bump(scope)
  const capture = await artifacts.captureFile({
    fs, path: 'big32.txt', store, log, grants, ownerScope: scope,
    executionWorld: 'local', observationId: 'obs-r5', mediaType: 'text/plain',
  })
  out.artifactBytes = capture.descriptor.captured.bytes
  out.artifactSha256 = capture.descriptor.captured.sha256

  // --- Q1: the product's own `ipython` tool, driving a real kernel ---------
  service = new KernelService(ctx, {
    pythonExecutable: PYTHON,
    brokerScript: `${IPY}/src/broker.py`,
    root: kernelRoot,
  })
  ipyTool.apply(ctx)
  const agent = { session: { header: { id: 'r5-sub-session', cwd: root } } }
  const hello = await ctx.tools.execute({
    callId: 'q1', name: 'ipython',
    arguments: { code: 'import sys, ipykernel\nprint("REAL_KERNEL", sys.version_info[:2], type(get_ipython()).__module__)' },
    agent, signal: new AbortController().signal,
  })
  out.q1_ipythonTool = {
    isError: hello.isError,
    outcome: hello.isError ? null : hello.value.outcome,
    sawRealKernel: hello.isError ? false : hello.value.text.includes('REAL_KERNEL'),
    text: hello.isError ? String(hello.error.info?.code ?? '') : hello.value.text.slice(0, 200),
  }

  // --- Q2: can a cell reach the data plane? --------------------------------
  // A cell that tries every plausible name for a native data tool. If the
  // channel existed, one of these would resolve.
  const reach = await ctx.tools.execute({
    callId: 'q2', name: 'ipython',
    arguments: { code: [
      'import json',
      'found = []',
      'for name in ("data", "tools", "dsh", "dailyData", "data_pages", "data_capture_file"):',
      '    if name in globals():',
      '        found.append(name)',
      'try:',
      '    import data  # noqa',
      '    found.append("import data")',
      'except Exception as exc:',
      '    found.append("import data FAILED: " + type(exc).__name__)',
      'print(json.dumps({"reachable": found}))',
    ].join('\n') },
    agent, signal: new AbortController().signal,
  })
  out.q2_cellReach = reach.isError
    ? { isError: true, code: String(reach.error.info?.code ?? '') }
    : { isError: false, text: reach.value.text.slice(0, 300) }

  // --- Q3: can a cell consume pages the HOST serves? -----------------------
  // The host serves the page protocol on a loopback socket. This keeps the page
  // walk ON the artifact (counters prove it) while the CONSUMER is the real
  // kernel. It does NOT use a product channel, because M3 exposes none.
  const io = { artifactBytesRead: 0, sourceBytesRead: 0, indexBytesRead: 0, artifactReads: 0 }
  const server = createServer(socket => {
    let carry = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      carry += chunk
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        const line = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        newline = carry.indexOf('\n')
        let request
        try { request = JSON.parse(line) } catch { continue }
        if (typeof request.want !== 'number' || typeof request.length !== 'number') continue
        void artifacts.readArtifactRange(store, capture.descriptor, { offset: request.want, length: request.length }, io).then(bytes => {
          socket.write(`${Buffer.from(bytes).toString('base64')}\n`)
        })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const cell = [
    'import json, socket, base64, hashlib',
    `s = socket.create_connection(("127.0.0.1", ${port}))`,
    'h = hashlib.sha256()',
    'pages = 0',
    'total = 0',
    'offset = 0',
    'while offset < 33554432:',
    '    s.sendall((json.dumps({"want": offset, "length": 65536}) + "\\n").encode())',
    '    buf = b""',
    '    while not buf.endswith(b"\\n"):',
    '        piece = s.recv(1 << 20)',
    '        if not piece:',
    '            break',
    '        buf += piece',
    '    data = base64.b64decode(buf.strip())',
    '    if not data:',
    '        break',
    '    h.update(data)',
    '    pages += 1',
    '    total += len(data)',
    '    offset += len(data)',
    's.close()',
    'print(json.dumps({"pages": pages, "bytes": total, "sha256": h.hexdigest()}))',
  ].join('\n')

  const t0 = Date.now()
  const walk = await ctx.tools.execute({
    callId: 'q3', name: 'ipython', arguments: { code: cell },
    agent, signal: new AbortController().signal,
  })
  server.close()
  out.q3_realKernelWalk = {
    elapsedMs: Date.now() - t0,
    isError: walk.isError,
    text: walk.isError ? String(walk.error.info?.code ?? '') : walk.value.text.slice(0, 400),
    artifactBytesRead: io.artifactBytesRead,
    artifactReads: io.artifactReads,
    digestMatchesSource: !walk.isError && walk.value.text.includes(capture.descriptor.captured.sha256),
  }

  // The projection for that consumption, from the real function.
  out.projectionBytes = Buffer.byteLength(JSON.stringify(artifacts.projectForModel({
    descriptor: capture.descriptor, pagesConsumed: 512, bytesConsumed: totalBytes,
    exhausted: true, consumerNote: 'real ipython kernel hashed every page',
  })), 'utf8')
} catch (error) {
  out.error = `${error?.constructor?.name}: ${String(error?.message).slice(0, 400)}`
} finally {
  await service?.close().catch(() => undefined)
  await ctx?.fiber.dispose().catch(() => undefined)
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
