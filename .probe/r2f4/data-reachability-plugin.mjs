/**
 * R2-F4 product-reachability probe: is `ctx.dailyData` LIVE in a real composed
 * profile, and is its store bound to the mounted `ctx.attachments` capability?
 *
 * WHY A PLUGIN ROW AND NOT A DIRECT MOUNT. A test that calls
 * `ctx.plugin(DataPlaneService)` proves the module runs and says nothing about
 * whether the product loads it. This project has retracted that over-claim three
 * times, so the probe is inserted as a ROW in the composition under test and gates
 * on `inject`, which means it activates only once the data plane is genuinely live.
 *
 * WHAT IT PROVES, and the one thing that is specific to this slice:
 *   1. `ctx.dailyData` exists in the booted product, so the `daily-data-plane` row
 *      resolved and `apply()` completed;
 *   2. the service's store is an `AttachmentArtifactStore`, i.e. the store that
 *      takes its bytes from the capability rather than from a private import;
 *   3. `store.provider === ctx.attachments`, so the store is bound to the SAME
 *      provider instance the composition mounted -- which is the whole point of the
 *      F4 fix: ONE physical provider instance, reached through the capability.
 *   4. a real capture through the profile's own `ctx.fs` reaches `durable: true`
 *      and reads back byte-for-byte, so the service is usable and not merely present.
 *
 * WHAT IT DOES NOT PROVE. It does not prove the model can reach a `data.*` tool:
 * no such tool row exists anywhere in this tree, and that gap is recorded in
 * `qualification/runners/verify-data-plane.mjs` rather than papered over here.
 */
import { writeFileSync } from 'node:fs'

export const name = 'r2f4-data-reachability'
export const inject = ['dailyData', 'attachments', 'fs']

/**
 * A cordis `apply` must not return a value: the loader reads a returned value as an
 * EFFECT and rejects a non-effect one (`TypeError: Invalid effect`). The first
 * version of this probe returned its finding and the row therefore "did not
 * activate", which would have read as a composition failure rather than as a probe
 * defect. The finding is written to the output file and returned through it.
 */
export async function apply(ctx) {
  const out = process.env.R2F4_OUT
  const finding = {
    dailyDataPresent: false,
    storeConstructor: null,
    storeIsAttachmentBacked: false,
    providerIsTheMountedCapability: false,
    providerUnwrapWorked: false,
    providerConstructor: null,
    artifactRoot: null,
    artifactRootIsAbsolute: false,
    observationId: null,
    captureState: null,
    capturedBytes: null,
    readBackMatches: false,
    error: null,
  }
  try {
    const service = ctx.dailyData
    finding.dailyDataPresent = service !== undefined && service !== null
    const store = service.store
    finding.storeConstructor = store?.constructor?.name ?? null
    finding.storeIsAttachmentBacked = finding.storeConstructor === 'AttachmentArtifactStore'
    // The identity test: the store must hold the SAME capability object the host
    // mounted, not a second one it constructed for itself.
    //
    // A cordis service accessor returns a TRACE PROXY, so `===` against a second read
    // is not the test and the first version of this probe reported a FALSE NEGATIVE
    // because of it. Cordis exposes the unwrapped value under
    // `Symbol.for('cordis.original')` (`vendor/cordis/lib/index.js:38` and the `get`
    // trap at `:129`), so the comparison unwraps through that symbol.
    const ORIGINAL = Symbol.for('cordis.original')
    const unwrap = (value) => (value !== null && typeof value === 'object' && value[ORIGINAL] !== undefined
      ? value[ORIGINAL]
      : value)
    const storeProvider = unwrap(store?.provider)
    const mounted = unwrap(ctx.attachments)
    finding.providerIsTheMountedCapability = storeProvider === mounted
    finding.providerUnwrapWorked = storeProvider !== store?.provider || mounted !== ctx.attachments
    finding.providerConstructor = mounted?.constructor?.name ?? null
    finding.artifactRoot = store?.root ?? null
    finding.artifactRootIsAbsolute = typeof store?.root === 'string' && /^[A-Za-z]:[\\/]|^\//u.test(store.root)

    // A REAL capture through the profile's own fs, so the service is USABLE.
    //
    // THE PAYLOAD GOES TO AN ABSOLUTE PATH. The store's root is the RELATIVE
    // `data-artifacts` (recorded as G-R5-04: the mounted `storageDomain` is a
    // facility with no `root`, so the derivation falls back and lands against the
    // process cwd). A probe that wrote a relative path would depend on the boot cwd
    // and its failure would say nothing about the data plane, so the payload is
    // written under the probe's own output directory instead.
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const scratch = mkdtempSync(join(tmpdir(), 'r2f4-reach-'))
    const probePath = join(scratch, 'r2f4-probe-payload.txt')
    writeFileSync(probePath, 'R2F4-DATA-REACHABILITY\n')
    // A UNIQUE id per run. The store root is the relative `data-artifacts` and the
    // boot cwd is reused, so a fixed id would be refused on the SECOND run by
    // DATA-06's own guard -- which is the guard working, not a defect, and it must not
    // be mistaken for a data-plane failure.
    const observationId = `obs-r2f4-${Date.now().toString(36)}`
    const outcome = await service.capture({
      fs: ctx.fs,
      path: probePath,
      mediaType: 'text/plain',
      observationId,
    })
    finding.observationId = observationId
    finding.captureState = outcome.reference.state
    finding.capturedBytes = outcome.reference.bytes
    const resolved = await service.resolve(observationId)
    finding.readBackMatches = Buffer.from(resolved.bytes).toString('utf8') === 'R2F4-DATA-REACHABILITY\n'
  } catch (error) {
    finding.error = `${error.name}: ${error.message}`
  }
  if (out !== undefined && out !== '') writeFileSync(out, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
}
