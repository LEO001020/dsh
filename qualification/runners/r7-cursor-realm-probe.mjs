/**
 * R7 product-reachability probe: is the cursor's store-realm binding reachable
 * through the ASSEMBLED daily profile, and does the PRODUCT record the refusal?
 *
 * WHY THIS EXISTS AND WHY A TEST IS NOT ENOUGH
 *
 * This project has recorded the same defect more than twelve times: "the mechanism
 * is implemented, unit-tested, and correct -- while nothing in the product calls
 * it." `docs/GAPS.md` G-FIX-04 states the rule an oracle must satisfy: a gate whose
 * oracle is weaker than its scenario passes while the product is broken. So the
 * `data11-cursor-realm.test.ts` suite proves the MODULE refuses a cross-realm
 * cursor; it does NOT prove the product does.
 *
 * This probe runs INSIDE a real composed profile boot, reached the same way
 * `verify-data-plane.mjs` reaches it: `ctx.get('dailyData')`, which exists only if
 * `cordis.patch.yml` resolved, `data-plugin` activated, and `DataPlaneService`
 * completed its `open`. It then:
 *
 *   1. captures a real file through the profile's own `ctx.fs`;
 *   2. mints a real cursor through `service.page(...)`;
 *   3. presents that cursor to a DIFFERENT store through the SAME service surface,
 *      using the same scope string -- the defect's own arm;
 *   4. reads the refusal back from the service's own journal, so "the refusal is
 *      recorded" is measured at the product surface and not inferred from a throw.
 *
 * It also reports the realm the profile's store resolved, which is the value the
 * restart-stability measurement compares across processes.
 *
 * WHAT THIS DOES NOT PROVE, stated so a green result is not over-read:
 *   - It does not prove a MODEL can reach `data.pages` as a native tool. No `data.*`
 *     tool row exists in this tree (measured, and reported by this probe as
 *     `dataToolNames`), so the model-facing call is still absent. What is proven is
 *     that the SERVICE the intended caller binds to refuses correctly.
 *   - The second store is a second `LocalArtifactStore` over a second root inside
 *     the probe process, not a second deployment. It is a genuinely different realm
 *     (asserted), which is the property the refusal depends on.
 */
import { mkdirSync, writeFileSync } from 'node:fs'

export const name = 'r7-cursor-realm-probe'
// `inject` is a READINESS GATE: the probe activates only once the data plane is
// genuinely live. Gating on the service under test is the CORRECT use, and the
// negative case stays visible (the boot prints the row under "Plugins waiting for
// services" if it never resolves).
export const inject = ['dailyData']

/** The caller's own output path, so this result cannot be another agent's. */
const OUT = process.env['R7_PROBE_OUT'] ?? 'D:/DSH/work/wt-r7/qualification/results/R7-cursor-realm/product-boot.json'

export async function apply(ctx) {
  const finding = {
    home: process.env['DSH_HOME'] ?? null,
    servicePresent: false,
    serviceKind: null,
    artifactRoot: null,
    storeRealmId: null,
    realmIsPersisted: false,
    realmFileContents: null,
    toolCountAgentKey: 0,
    dataToolNames: [],
    error: null,
    arms: {},
    recordedRefusals: [],
  }
  try {
    const service = ctx.get('dailyData')
    if (service === undefined) {
      finding.error = 'ctx.dailyData is ABSENT: the data-plane row did not resolve through the profile'
      throw new Error(finding.error)
    }
    finding.servicePresent = true
    finding.serviceKind = service.constructor?.name ?? null
    finding.artifactRoot = service.store?.root ?? null

    // The realm the PROFILE's store resolved. This is the value a restart must
    // reproduce, so it is reported rather than kept internal.
    finding.storeRealmId = await service.storeRealmId()

    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('ctx.fs is absent; the profile mounted no filesystem')

    const probeDir = 'D:/DSH/work/wt-r7/qualification/results/R7-cursor-realm'
    mkdirSync(probeDir, { recursive: true })
    const payloadPath = `${probeDir}/probe-payload.bin`
    const payload = Buffer.from('R7-REALM-PROBE-' + 'z'.repeat(400), 'utf8')
    writeFileSync(payloadPath, payload)

    // ---- ARM 1: capture and page through the PRODUCT service.
    const outcome = await service.capture({
      fs,
      path: payloadPath,
      mediaType: 'application/octet-stream',
      observationId: `obs-r7-probe-${Date.now()}`,
    })
    finding.arms.capture = {
      state: outcome.reference.state,
      bytes: outcome.descriptor.captured.bytes,
      sha256: outcome.descriptor.captured.sha256,
    }
    const descriptor = service.parseObservation(outcome.descriptor)
    const first = await service.page({ descriptor, maxBytes: 64 })
    finding.arms.firstPage = { bytes: first.bytes.byteLength, offset: first.offset, hasCursor: first.nextCursor !== undefined }
    const issuedCursor = first.nextCursor
    if (issuedCursor === undefined) throw new Error('the first page produced no continuation cursor; the arm cannot run')

    // ---- ARM 2: the cursor replayed against a DIFFERENT store.
    //
    // The second store is constructed from the SAME module the product loaded (the
    // class the service itself is holding), rooted at a different directory, so its
    // realm is genuinely different. `pages()` is driven directly because the service
    // owns exactly one store; the point of this arm is the store binding, not the
    // service's plumbing.
    const artifactsModule = await import('../../packages/dsh-daily-work/lib/artifacts.js')
    const otherRoot = `${probeDir}/other-store`
    const otherStore = new artifactsModule.LocalArtifactStore(otherRoot)
    const otherRealm = await otherStore.ensureRealm()
    finding.arms.otherStoreRealm = otherRealm
    finding.arms.realmsDiffer = otherRealm !== finding.storeRealmId

    const refusals = []
    try {
      const page = await artifactsModule.pages(otherStore, {
        descriptor,
        maxBytes: 64,
        grants: service.grants,
        callerScope: service.ownerScope,
        cursor: issuedCursor,
        onRefusal: refusal => { refusals.push({ code: refusal.code, step: refusal.step, storeRealmId: refusal.storeRealmId }) },
      })
      finding.arms.crossStore = { refused: false, yieldedBytes: page.bytes.byteLength }
    } catch (error) {
      finding.arms.crossStore = {
        refused: true,
        code: error?.code ?? null,
        realmRefused: typeof error?.realmRefused === 'boolean' ? error.realmRefused : null,
        message: error?.message ?? null,
      }
    }
    finding.arms.refusalSinkFired = refusals

    // ---- ARM 3: the PRODUCT records the refusal.
    //
    // `DataPlaneService.page` mounts the sink and the store journals it. This arm
    // presents a cursor minted by the OTHER store to the SERVICE's own store through
    // the recording provider the service itself mounts, so the recorded refusal is a
    // REALM refusal on the product's store rather than a parse refusal.
    //
    // THE CURSOR IS MINTED OVER THE PRODUCT'S OWN DESCRIPTOR, so its MAC secret and
    // every signed field are exactly what the product's store expects. Only the
    // `storeRealmId` field differs -- which is the strongest possible form of the
    // replay, and the only shape in which the realm check is the thing that fires.
    // (A cursor minted over a DIFFERENT observation is refused earlier, by the MAC:
    // that ordering is correct and is measured by `data11-cursor-realm.test.ts`.)
    const recordingProvider = new artifactsModule.RecordingPageProvider(
      new artifactsModule.ArtifactStorePageProvider(service.store),
      artifactsModule.mountRefusalRecording(service.store),
    )
    const otherLog = new artifactsModule.InMemorySessionReferenceLog()
    const { GrantTable: OtherGrantTable } = await import('../../packages/dsh-daily-work/lib/observations.js')
    const otherGrants = new OtherGrantTable()
    otherGrants.bump(service.ownerScope)
    // The same bytes into the other store, so the other realm genuinely holds the
    // content address the descriptor names.
    const otherCapture = await artifactsModule.captureFile({
      fs,
      path: payloadPath,
      store: otherStore,
      log: otherLog,
      grants: otherGrants,
      ownerScope: service.ownerScope,
      executionWorld: 'local',
      observationId: `obs-r7-other-${Date.now()}`,
      mediaType: 'application/octet-stream',
    })
    finding.arms.otherStoreHoldsSameDigest =
      otherCapture.descriptor.captured.sha256 === outcome.descriptor.captured.sha256

    // Mint the foreign cursor over the PRODUCT's descriptor, paging the other store.
    // Its `storeRealmId` is the other realm; every other signed field is the
    // product's.
    const otherFirst = await artifactsModule.pages(otherStore, {
      descriptor,
      maxBytes: 64,
      grants: service.grants,
      callerScope: service.ownerScope,
    })
    finding.arms.otherStoreIssuedCursor = otherFirst.nextCursor !== undefined

    try {
      await recordingProvider.next({
        descriptor,
        maxBytes: 64,
        grants: service.grants,
        callerScope: service.ownerScope,
        cursor: otherFirst.nextCursor,
      })
      finding.arms.realmRefusalOnProductStore = { refused: false }
    } catch (error) {
      finding.arms.realmRefusalOnProductStore = {
        refused: true,
        code: error?.code ?? null,
        realmRefused: typeof error?.realmRefused === 'boolean' ? error.realmRefused : null,
      }
    }
    finding.recordedRefusals = (await service.refusals()).map(entry => ({
      code: entry.code, step: entry.step, storeRealmId: entry.storeRealmId, observationId: entry.observationId,
    }))

    // The realm is persisted, so a restart reads the same value.
    const { readFileSync, statSync } = await import('node:fs')
    const realmFile = `${service.store.root}/store-realm.json`
    finding.realmIsPersisted = statSync(realmFile).isFile()
    finding.realmFileContents = JSON.parse(readFileSync(realmFile, 'utf8'))

    // The tool surface, reported so "the model cannot reach data.*" stays checkable.
    const sc = ctx.get('sessionController')
    if (sc !== undefined) {
      const created = await sc.create({ cwd: process.cwd() })
      const sessionId = created?.sessionId ?? created?.id ?? null
      const agents = ctx.get('agents')
      const agent = sessionId === null ? undefined : agents?.get(sessionId)
      if (agent !== undefined) {
        const names = ctx.get('tools').schemas(agent).map(schema => schema.name).sort()
        finding.toolCountAgentKey = names.length
        finding.dataToolNames = names.filter(entry => entry.startsWith('data'))
      }
    }

    finding.verdicts = {
      serviceReachable: finding.servicePresent,
      realmPersistedNotPerBoot: finding.realmIsPersisted && finding.storeRealmId !== null,
      crossStoreRefused: finding.arms.crossStore?.refused === true,
      crossStoreRefusalIsTheRealm: finding.arms.crossStore?.code === 'pagination-realm-denied',
      refusalSinkFired: refusals.length > 0,
      // The product's OWN store refused a cursor minted by another store over the
      // SAME payload, and journalled the refusal.
      productStoreRefusedForeignRealm: finding.arms.realmRefusalOnProductStore?.code === 'pagination-realm-denied',
      refusalRecordedByProduct: finding.recordedRefusals.some(entry => entry.code === 'pagination-realm-denied'),
      DATA_11_PRODUCT_REACHABLE: finding.servicePresent
        && finding.realmIsPersisted
        && finding.arms.crossStore?.refused === true
        && finding.arms.crossStore?.code === 'pagination-realm-denied'
        && finding.arms.realmRefusalOnProductStore?.code === 'pagination-realm-denied'
        && finding.recordedRefusals.some(entry => entry.code === 'pagination-realm-denied'),
    }
  } catch (error) {
    finding.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
    finding.verdicts = { DATA_11_PRODUCT_REACHABLE: false }
  }
  writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
}
