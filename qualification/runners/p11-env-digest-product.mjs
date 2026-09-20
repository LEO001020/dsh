/**
 * P11 composition-tier probe: does a REAL BOOT derive its environment identity
 * from a probed manifest (V5 §11.2), and does the identity move when a hashed
 * local file changes?
 *
 * WHY THIS EXISTS AND WHY THE TEST IS NOT ENOUGH. `p11-env-digest.test.ts`
 * measures the SERVICE with a context the TEST owns. That is strictly stronger
 * than a unit test of the digest function and it is still not the product: the
 * profile, the subprocess provider, the storage domain and the interpreter all
 * come from the test's own composition. This probe boots the real `daily`
 * profile through the shared port-safe harness and asks the boot's OWN
 * `ctx.ipython` service what environment it would build a kernel against.
 *
 * THE QUESTION IT ANSWERS, which no test in this package can answer: is the
 * environment identity that the PRODUCT uses a manifest-derived value, and does
 * the product's own service see a change to a file the manifest hashes.
 *
 * WHAT IS REAL HERE. The profile's own bundle rows (the `dsh-ipython` host row),
 * the profile's own subprocess provider, the profile's own configured
 * `pythonExecutable`, and the service instance the boot itself constructed.
 *
 * WHAT THIS PROBE DOES NOT ESTABLISH, stated because it bounds the claim.
 *   1. It does NOT start a kernel. `environmentStatus()` deliberately does not,
 *      so this probe cannot show that a kernel is refused -- that is measured
 *      against a real kernel in `p11-env-digest.test.ts`, and against the
 *      assembled tool path in `r5-product-bridge.test.ts`.
 *   2. It does NOT drive a model turn; there is no LLM in this boot.
 *   3. It mutates `broker.py` on disk and restores it, verifying the restore by
 *      digest. If the restore check fails the probe THROWS rather than reporting
 *      a result, so a failed run cannot leave the tree modified and looking fine.
 *
 * THE OUTPUT PATH IS OVERRIDABLE and required, for the reason recorded in
 * `r5-bridge-product.mjs`: a probe writing to a fixed path is a shared mutable
 * resource, and 22 runners here hardcode a path into the MAIN checkout.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'p11-env-digest-product'
// A readiness gate. Without the ipython service composed this probe reports
// NOTHING rather than a false absence -- the G-FIX-04 shape.
export const inject = ['ipython']

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('p11-env-digest-product: DSH_PROBE_OUT must name this caller\'s own result path; a shared fixed path cannot be attributed to a caller')
}

const HERE = dirname(fileURLToPath(import.meta.url))
/** The worktree this probe was loaded FROM, not a hardcoded main checkout. */
const REPO_ROOT = join(HERE, '..', '..')
const BROKER = join(REPO_ROOT, 'packages', 'dsh-ipython', 'src', 'broker.py')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function apply(ctx) {
  const finding = {
    scope: 'P11 composition tier: the environment identity in a real daily boot is manifest-derived',
    profileBooted: true,
    kernelServicePresent: false,
    // THE HOME-ATTRIBUTION FIELD. The harness's `readResult` refuses to return a
    // result whose roots do not name the home this caller booted, because a probe
    // writing to a shared path can be overwritten by another agent's boot. This
    // probe reports the preset roots it actually sees so that check can run; a
    // result that cannot name its own home is not attributable to a caller.
    presetRoots: [],
    // The manifest, as the BOOT's own service derives it.
    digestIsFullSha256: false,
    digestChars: null,
    configuredByHost: false,
    manifest: null,
    // The local-file half, measured through the boot's service.
    brokerSha256Before: null,
    brokerSha256Mutated: null,
    brokerFileHashMoved: false,
    digestBeforeMutation: null,
    digestAfterMutation: null,
    digestMovedWithFileContent: false,
    brokerRestoredByteIdentical: false,
    // The probed half.
    probedFieldsPresent: [],
    ipythonVersionDiffersFromPythonVersion: null,
    error: null,
  }

  const original = readFileSync(BROKER)
  const originalSha = sha256(original)
  let mutatedOnDisk = false

  try {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined) {
      finding.presetRoots = (roster.roots ?? []).map(root => String(root.path))
    }

    const service = ctx.get('ipython')
    finding.kernelServicePresent = service !== undefined
    if (service === undefined) throw new Error('the ipython service is not mounted in this profile')
    if (typeof service.environmentStatus !== 'function') {
      throw new Error('the boot\'s ipython service has no environmentStatus(); the manifest surface is not mounted')
    }

    // ---- the boot's own environment identity ---------------------------------
    const before = await service.environmentStatus()
    finding.configuredByHost = before.configuredByHost
    finding.digestBeforeMutation = before.digest
    finding.digestChars = before.digest.length
    finding.digestIsFullSha256 = /^[0-9a-f]{64}$/u.test(before.digest)
    finding.manifest = before.manifest ?? null
    finding.brokerSha256Before = before.manifest?.broker_sha256 ?? null

    const manifest = before.manifest
    if (manifest !== null && manifest !== undefined) {
      finding.probedFieldsPresent = ['sys_executable_realpath', 'python_implementation', 'python_version',
        'ipython', 'ipykernel', 'jupyter_client', 'pyzmq', 'broker_sha256',
        'bridge_python_client_sha256', 'data_client_sha256']
        .filter(key => manifest[key] !== null && manifest[key] !== undefined)
      // The naming fix, as a fact about the values rather than about the names.
      finding.ipythonVersionDiffersFromPythonVersion = manifest.ipython !== null
        && manifest.python_version !== null
        && manifest.ipython !== manifest.python_version
    }

    // ---- a REAL content change to a hashed file, through the boot's service ---
    // `reconfigure` is the host's way to say "re-read the environment"; the probe
    // passes back the SAME configuration the service already holds, so the only
    // thing that changed between the two reads is the file's bytes.
    const config = typeof service.configuration === 'function' ? service.configuration() : undefined
    writeFileSync(BROKER, Buffer.concat([
      original,
      Buffer.from(`\n# P11 composition-tier mutation ${String(Date.now())}\n`, 'utf8'),
    ]))
    mutatedOnDisk = true
    finding.brokerSha256Mutated = sha256(readFileSync(BROKER))
    finding.brokerFileHashMoved = finding.brokerSha256Mutated !== originalSha

    if (typeof service.reconfigure === 'function' && config !== undefined) {
      service.reconfigure(config)
      const after = await service.environmentStatus()
      finding.digestAfterMutation = after.digest
      finding.digestMovedWithFileContent = after.digest !== before.digest
    } else {
      finding.error = 'the boot\'s service does not expose reconfigure()/configuration(); '
        + 'the mutation arm could not be driven through the product service'
    }
  } catch (error) {
    finding.error = String(error?.stack ?? error)
  } finally {
    if (mutatedOnDisk) {
      writeFileSync(BROKER, original)
      const restored = sha256(readFileSync(BROKER))
      finding.brokerRestoredByteIdentical = restored === originalSha
      if (!finding.brokerRestoredByteIdentical) {
        throw new Error(
          `P11 probe FAILED TO RESTORE ${BROKER} (${originalSha} -> ${restored}); the tree is modified. `
          + 'Refusing to report a result.',
        )
      }
    }
  }

  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
}
