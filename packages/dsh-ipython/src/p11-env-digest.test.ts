/**
 * V5 §18 `ENV-DIGEST`, on the live plane: "changing Python/IPython/ipykernel/
 * bridge code changes environment digest and forces new epoch."
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `service.test.ts`. That file tests the
 * REGISTRY's identity rule with a hand-supplied digest string, which proves the
 * COMPARISON works and says nothing about whether the digest is a real
 * environment identity. This file tests the PRODUCER: that the value the service
 * derives from an actual environment moves when the environment moves. A test of
 * the comparison cannot fail when the producer is a hash of a path string, which
 * is exactly what the old implementation was.
 *
 * THE ARMS, and what each one is worth:
 *
 *   1. LOCAL FILE, the strong arm. Mutate `broker.py` on disk -- the file the
 *      configured interpreter actually EXECUTES -- and show the digest moves and
 *      a live kernel is refused. This needs no second Python install and no second
 *      IPython version, and it is the property the old digest could not have:
 *      `sha256(pythonExecutable + platform + arch)` cannot see a file's bytes, so
 *      this arm FAILS against the old implementation by construction. It is the
 *      arm V5 §11.2's `broker_sha256` field exists for. Before-pair archived at
 *      `qualification/results/P11-env/before-weak-digest.json`.
 *
 *   2. EVERY MANIFEST FIELD IS AN INPUT. The digest is independently recomputed
 *      from the manifest the service returned, so a field that was reported but
 *      not hashed is caught. This is what stops "the manifest looks complete" from
 *      standing in for "the identity covers the manifest".
 *
 *   3. THE PROBE REPORTS REAL VERSIONS. The manifest is cross-checked against the
 *      same interpreter through an INDEPENDENT `python -c`, so a manifest full of
 *      plausible constants cannot pass.
 *
 *   4. CONTROL ARMS. The same environment twice must give the same digest (or the
 *      identity would refuse healthy kernels), and a bad interpreter must FAIL
 *      LOUD rather than digest a partial manifest.
 *
 *   5. THE EPOCH HALF. V5 §18 asks for a new epoch, not only a new digest. This
 *      file measures the refusal for a real ENVIRONMENT change: a live kernel, a
 *      mutated hashed file, and the next cell refused with the kernel NOT quietly
 *      replaced.
 *
 * ONE SERVICE PER TEST. Cordis refuses a second registration on one context
 * (pinned by `service.test.ts`), so each re-resolution is driven through
 * `reconfigure`, which is also the production path a host uses to declare that the
 * environment moved -- and which is the ONLY thing that clears the memoized
 * manifest. Driving the arms through it means the test exercises the same
 * cache-clearing the host depends on.
 *
 * WHAT THIS FILE DOES NOT DO, stated so the evidence is not over-read: it does not
 * install a second IPython, does not upgrade a distribution, and does not prove the
 * PRODUCT evicts a kernel. See the report's "CLAIMS I AM NOT MAKING".
 *
 * CPU: one kernel, closed in `afterEach`. One test file at a time.
 */
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelService, type EnvironmentManifest } from './kernel-plugin.ts'
import { bridgeClientDigest } from './bridge.ts'
import { KernelTransportError } from './kernel.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BROKER = resolve(HERE, 'broker.py')
const PYTHON = process.env['DSH_PYTHON'] ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
/** A path that is a REAL file but NOT a Python interpreter: `broker.py` itself. */
const NOT_AN_INTERPRETER = BROKER

let ctx: Context
let root: string
let service: KernelService | undefined

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(Subprocess)
  root = await mkdtemp(join(tmpdir(), 'dsh-ipython-envdigest-'))
})

afterEach(async () => {
  if (service !== undefined) {
    await service.close().catch(() => undefined)
    service = undefined
  }
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function agentFor(sessionId: string): Agent {
  return { session: { header: { id: sessionId } } } as unknown as Agent
}

function makeService(): KernelService {
  // A GENUINE DEVELOPMENT HOST: this file's subject is the environment digest,
  // and it mounts no storage domain. Since V5 11.1 made the durable ledger
  // REQUIRED, an unset durableLedger would refuse every kernel here and the
  // digest arms would measure nothing. The durable path has its own gate.
  service = new KernelService(ctx, { pythonExecutable: PYTHON, brokerScript: BROKER, root, durableLedger: false })
  return service
}

/** `reconfigure` with the same values: the host's way to say "re-read the environment". */
function refresh(s: KernelService): void {
  s.reconfigure({ pythonExecutable: PYTHON, brokerScript: BROKER, root, durableLedger: false })
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Run `body` with `path` carrying different bytes, then restore.
 *
 * THE RESTORE IS VERIFIED BY DIGEST, not assumed, and the verification THROWS. A
 * test that corrupted a tracked source file and reported success would be far
 * worse than a failing test: it would leave the tree broken while looking green,
 * and `afterEach` cannot undo it because the damage is to a source file rather
 * than to the temp root.
 */
async function withMutatedFile<T>(path: string, body: () => Promise<T>): Promise<T> {
  const original = await readFile(path)
  const before = sha256(original)
  try {
    await writeFile(path, Buffer.concat([
      original,
      Buffer.from(`\n# P11 ENV-DIGEST mutation ${String(Date.now())}\n`, 'utf8'),
    ]))
    return await body()
  } finally {
    await writeFile(path, original)
    const restored = sha256(await readFile(path))
    if (restored !== before) {
      throw new Error(`the mutated file was NOT restored byte-identical: ${path} (${before} -> ${restored})`)
    }
  }
}

/**
 * Recompute the digest from the manifest INDEPENDENTLY of the production code.
 *
 * A second implementation on purpose: if this reused the service's own
 * canonicalizer, a field silently dropped from the digest would be dropped from
 * both and the check would agree with itself. This one is written from V5 §11.2's
 * definition ("canonical JSON hash") and sorts its own keys.
 */
function digestOf(manifest: EnvironmentManifest): string {
  const keys = Object.keys(manifest).sort()
  const canonical = `{${keys.map(key => `${JSON.stringify(key)}:${JSON.stringify(manifest[key as keyof EnvironmentManifest])}`).join(',')}}`
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

describe('V5 §18 ENV-DIGEST: the environment digest follows a real environment change', () => {
  it('a changed broker.py moves the digest AND makes a live kernel be refused', async () => {
    const s = makeService()
    const agent = agentFor('env-digest-broker')

    const baseline = await s.environmentStatus()
    expect(baseline.configuredByHost).toBe(false)
    expect(baseline.manifest).toBeDefined()

    // A kernel is established FIRST, under the unmutated environment, so the
    // refusal measured below is about a change under a LIVE kernel rather than
    // about a service that had nothing to refuse.
    await s.runCell(agent, 'carried_over = "built under the old environment"')
    expect(s.hasKernel(agent)).toBe(true)
    const epochBefore = s.currentEpoch(agent)

    // ONE MUTATION, EVERYTHING INSIDE IT. The mutation appends a timestamped
    // marker, so two separate `withMutatedFile` calls produce DIFFERENT bytes and
    // therefore different digests -- comparing a digest captured in one call
    // against a message produced in another compares two unrelated mutations.
    // Measured: that mistake made this test fail with two digests that were both
    // real and neither of them the one under test.
    await withMutatedFile(BROKER, async () => {
      // `reconfigure` clears the memoized manifest, so this re-probes and derives
      // the digest the CURRENT environment has -- which is what a host does when it
      // learns the environment moved.
      refresh(s)
      const mutated = await s.environmentStatus()

      expect(mutated.manifest?.broker_sha256).not.toBe(baseline.manifest?.broker_sha256)
      expect(mutated.digest).not.toBe(baseline.digest)
      // The mutation moved exactly ONE manifest input, so the digest change is
      // attributable to it rather than to a probe that returns noise.
      const differing = (Object.keys(baseline.manifest ?? {}) as Array<keyof EnvironmentManifest>)
        .filter(key => baseline.manifest?.[key] !== mutated.manifest?.[key])
      expect(differing).toEqual(['broker_sha256'])

      // ---- the EPOCH half: the live kernel is refused, not quietly replaced ---
      const error = await s.runCell(agent, 'carried_over').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(KernelTransportError)
      // The message names BOTH digests, so an operator can see what moved.
      expect((error as Error).message).toContain('the kernel must be evicted')
      expect((error as Error).message).toContain(mutated.digest)
      expect((error as Error).message).toContain(baseline.digest)
    })

    // The refusal did NOT silently replace the kernel: the old one is still there
    // and its epoch did not advance. A silent evict-and-restart would satisfy "a
    // new epoch" while destroying the evidence that the environment changed under
    // a live namespace -- the distinction `service.test.ts` records for the
    // execution world, applied here to the environment.
    expect(s.hasKernel(agent)).toBe(true)
    expect(s.currentEpoch(agent)).toBe(epochBefore)

    // ---- and once restored, the SAME service and session work again -----------
    // This is what makes the refusal attributable to the mutation rather than to a
    // service that broke and stayed broken.
    refresh(s)
    const recovered = await s.runCell(agent, 'print("still alive:", carried_over)')
    expect(recovered.outcome).toBe('ok')
    expect(recovered.stdout.text).toContain('still alive: built under the old environment')
  }, 300_000)

  it('every manifest field is an input to the digest, and the client hash is the real one', async () => {
    const s = makeService()
    const status = await s.environmentStatus()
    const manifest = status.manifest
    expect(manifest).toBeDefined()
    if (manifest === undefined) throw new Error('unreachable: asserted above')

    // (a) The digest IS the canonical JSON hash of the manifest, recomputed here by
    //     an independent implementation. A field that was reported but not hashed
    //     would make these two disagree.
    expect(status.digest).toBe(digestOf(manifest))

    // (b) The bridge client field carries the client's REAL digest, from the
    //     existing accessor rather than a second implementation of it.
    expect(manifest.bridge_python_client_sha256).toBe(bridgeClientDigest())

    // (c) The broker field carries the REAL sha256 of the file on disk, checked
    //     against a hash computed here.
    expect(manifest.broker_sha256).toBe(sha256(await readFile(BROKER)))

    // (d) `data_client_sha256` is null because NO HOST SUPPLIED ONE. This is the
    //     honest value and it is asserted rather than left implicit: the dsh.data
    //     client lives in a package this one must not import in order to identify
    //     itself, so the path is host-supplied. `null` here means "asked, and no
    //     host answered", which is a different fact from a digest.
    expect(manifest.data_client_sha256).toBeNull()

    // (e) A host-supplied data client must move the digest, which is how the third
    //     local-file field is shown to be WIRED rather than merely declared. A
    //     scratch file stands in for `dsh_data_client.py`: what is under test is
    //     that the field is read from the configured path and hashed, not the
    //     contents of any particular client.
    const clientPath = join(root, 'stand-in-data-client.py')
    await writeFile(clientPath, 'def fetch(): return 1\n', 'utf8')
    const expectedFirst = sha256(await readFile(clientPath))

    s.reconfigure({ pythonExecutable: PYTHON, brokerScript: BROKER, root, dataClientScript: clientPath })
    const withDataClient = await s.environmentStatus()
    expect(withDataClient.manifest?.data_client_sha256).toBe(expectedFirst)
    expect(withDataClient.digest).not.toBe(status.digest)

    // Changing ONLY that file's bytes moves the digest again, so the field is an
    // input rather than a value that happens to be present.
    await writeFile(clientPath, 'def fetch(): return 2\n', 'utf8')
    s.reconfigure({ pythonExecutable: PYTHON, brokerScript: BROKER, root, dataClientScript: clientPath })
    const changed = await s.environmentStatus()
    expect(changed.manifest?.data_client_sha256).toBe(sha256(await readFile(clientPath)))
    expect(changed.digest).not.toBe(withDataClient.digest)
  }, 300_000)

  it('the probe reports the interpreter\'s REAL versions, cross-checked independently', async () => {
    const s = makeService()
    const manifest = (await s.environmentStatus()).manifest
    expect(manifest).toBeDefined()
    if (manifest === undefined) throw new Error('unreachable: asserted above')

    expect(manifest.sys_executable_realpath).not.toBeNull()
    expect(manifest.python_implementation).toBe('CPython')
    expect(manifest.python_version).toMatch(/^\d+\.\d+\.\d+/u)

    // The SAME questions asked of the SAME interpreter through a second,
    // independent `python -c`. A manifest of plausible constants would disagree.
    const direct = await probeDirectly()
    expect(manifest.python_version).toBe(direct['python_version'])
    expect(manifest.ipython).toBe(direct['ipython'])
    expect(manifest.ipykernel).toBe(direct['ipykernel'])
    expect(manifest.jupyter_client).toBe(direct['jupyter_client'])
    expect(manifest.pyzmq).toBe(direct['pyzmq'])

    // The IPython and Python versions are DIFFERENT values, which is what makes the
    // naming fix load-bearing rather than cosmetic: if they were equal, the field
    // formerly called `ipythonVersion` would have been accidentally correct.
    expect(manifest.ipython).not.toBe(manifest.python_version)

    // The digest is a FULL sha256, not the 16 hex chars the old one was.
    expect((await s.environmentStatus()).digest).toMatch(/^[0-9a-f]{64}$/u)
  }, 300_000)

  it('the same environment gives the same digest twice, so a healthy kernel is not refused', async () => {
    // A digest that moved on every call would pass the mutation arm and be useless:
    // it would refuse every healthy kernel. This arm keeps the others honest.
    const s = makeService()
    const first = await s.environmentStatus()
    refresh(s)
    const second = await s.environmentStatus()
    expect(second.digest).toBe(first.digest)
    expect(second.manifest).toEqual(first.manifest)
  }, 300_000)

  it('an interpreter that cannot be probed FAILS LOUD rather than digesting a partial manifest', async () => {
    // The bound and the failure arm, which V5 §11.2's "bounded probe" requirement
    // is about. `broker.py` is a real file that is not a Python interpreter, so the
    // probe exits non-zero -- the same arm a missing `ipykernel` would take.
    const s = makeService()
    s.reconfigure({ pythonExecutable: NOT_AN_INTERPRETER, brokerScript: BROKER, root })
    const error = await s.environmentStatus().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(KernelTransportError)
    // And the refusal is a THROW, not a manifest full of nulls: digesting nulls
    // would produce a stable, plausible, wrong identity -- which is the defect
    // being fixed, not a mitigation of it.
    expect((error as Error).message).toMatch(/environment probe/u)

    // A non-existent interpreter takes the same loud arm rather than a fallback.
    refresh(s)
    s.reconfigure({ pythonExecutable: resolve(root, 'no-such-interpreter.exe'), brokerScript: BROKER, root })
    await expect(s.environmentStatus()).rejects.toBeInstanceOf(KernelTransportError)
  }, 300_000)
})

/**
 * Ask the interpreter the same questions through an INDEPENDENT path.
 *
 * Deliberately NOT the service's own probe source: a cross-check that reused the
 * production probe would agree with itself no matter what either computed.
 */
async function probeDirectly(): Promise<Record<string, string | null>> {
  const source = [
    'import json, platform',
    'from importlib.metadata import version',
    'print(json.dumps({',
    '  "python_version": platform.python_version(),',
    '  "ipython": version("ipython"),',
    '  "ipykernel": version("ipykernel"),',
    '  "jupyter_client": version("jupyter_client"),',
    '  "pyzmq": version("pyzmq"),',
    '}))',
  ].join('\n')
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(PYTHON, ['-c', source], { timeout: 30_000 }, (error, out) => {
      if (error !== null) rejectPromise(error)
      else resolvePromise(out)
    })
  })
  return JSON.parse(stdout) as Record<string, string | null>
}
