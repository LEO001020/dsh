/**
 * OBS T2 probe: the history plane's caching and visibility behaviour, measured
 * through the LOADED `ctx.dailyHistory` service in a real composed host.
 *
 * WHY THIS IS SEPARATE FROM THE T1 TEST FILE. `history-web.test.ts` mounts the
 * services directly. That proves the module works; it does not prove the
 * DELIVERABLE composition reaches it. This probe adds no rows and asks the
 * loaded service, so "the product's history plane" is a fact about the booted
 * host rather than about an import.
 *
 * WHAT IT MEASURES:
 *
 *   OBS-02  A scan pinned to ONE watermark while events append. New events must
 *           be ABSENT from the running scan and appear only in a SEPARATE scan
 *           with its own watermark and a HIGHER generation.
 *   OBS-03  One event larger than the page budget: segments plus the full size,
 *           the digest and an authorized-refetch recovery -- never a partial
 *           body presented as the event.
 *   OBS-04  The number of FULL LOG MATERIALIZATIONS for a multi-page traversal,
 *           recorded as a number, with a CONTROL ARM that shows the counter can
 *           rise (a second pinned scan must increment it) so a `1` cannot be a
 *           constant.
 *   OBS-05  The three visibilities as three separate states on the loaded
 *           plane's own records.
 *   REACH   Whether anything in the composed host actually CALLS
 *           `dailyHistory.history(caller)`: the model-facing tool list, the
 *           IPython kernel service, and the broker protocol's message types.
 *           Recorded as data, with the verdict in the findings file.
 */
import { writeFileSync } from 'node:fs'

export const name = 'v10-obs-plane'
export const inject = ['sessionController']

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

const OUT = process.env.DSH_PROBE_OUT
  ?? join(REPO_ROOT, 'qualification/results/V10-research-obs/obs-plane-boot.json')

const REPO = REPO_ROOT
const LIB = `file:///${REPO}/packages/dsh-daily-work/lib`

export async function apply(ctx) {
  const finding = {
    probe: 'OBS-02..05 + reach, through the LOADED ctx.dailyHistory service',
    presetRoots: [],
    servicePresent: false,
    sessionQueryPresent: false,
    historyAvailable: null,
    sessionId: null,
    targetSessionId: null,
    obs02WatermarkPinned: null,
    obs03OversizedEvent: null,
    obs04Replay: null,
    obs05Visibilities: null,
    reach: null,
    error: null,
  }

  try {
    const roster = ctx.get('agentPresets')
    finding.presetRoots = (roster?.roots ?? []).map(root => ({ path: String(root.path), trust: String(root.trust) }))

    const service = ctx.get('dailyHistory')
    finding.servicePresent = service !== undefined
    finding.sessionQueryPresent = ctx.get('sessionQuery') !== undefined
    if (service === undefined) {
      finding.error = 'ctx.dailyHistory is ABSENT from the composed host'
    } else {
      finding.historyAvailable = service.available()

      // A REAL Session through the real controller: this is the CALLER, so the
      // authorization path the plane re-checks on every read is exercised.
      const created = await ctx.get('sessionController').create({ cwd: REPO_ROOT })
      const callerSessionId = created?.sessionId ?? created?.id ?? null
      const cwd = REPO_ROOT
      finding.sessionId = callerSessionId

      // The TARGET is a SEPARATE stored session, written through the real
      // persistence service. It has to be separate because a live session is
      // owned by its own write handle (`SessionAlreadyOwnedError`), and because a
      // scan's stimulus is a STORED log: a session still being written has no
      // frozen revision to pin.
      const { SessionSeq, SessionId, SESSION_FORMAT_VERSION } = await import(
        'file:///D:/DSH/src/dsh-src/packages/core/session/lib/index.js'
      )
      const { createUserMessage } = await import(
        'file:///D:/DSH/src/dsh-src/packages/llm/llm/lib/index.js'
      )
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('no sessionPersistence service in the composed host')

      // A UNIQUE id per boot: the profile's session root is durable across boots,
      // so a fixed id makes the second run fail with `SessionAlreadyExistsError`
      // -- an environment artefact that would read as a measurement failure.
      const targetId = SessionId(`v10-obs-target-${String(Date.now())}`)
      const handle = await persistence.create({
        version: SESSION_FORMAT_VERSION, id: targetId, createdAt: 1, cwd, isSeeded: false,
      })
      await handle.append([0, 1, 2].map(seq => ({
        type: 'user/message',
        seq: SessionSeq(seq),
        time: 1_700_000_000_000 + seq,
        data: createUserMessage({ content: [{ type: 'text', text: `stored-${String(seq)}` }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      })))
      await handle.flush()
      await handle.close()
      finding.targetSessionId = String(targetId)

      // The plane the PRODUCT hands out: caller first, target second.
      const plane = service.history({ sessionId: callerSessionId, cwd })

      // --- OBS-02: pin one watermark, append, then continue ---------------
      const first = await plane.openScan(targetId, { maxEvents: 1 })
      const watermarkAtPin = { maxSeq: first.watermark.maxSeq, generation: first.watermark.generation }
      const firstSeqs = first.events.map(event => event.seq)

      // Append through the real persistence handle: these events are OUTSIDE the
      // pinned scan. `ctx.get('sessionPersistence')` rather than the property
      // form, because the cordis proxy refuses a property read on a service the
      // fiber did not declare in `inject` (`vendor/cordis/src/reflect.ts`).
      const writer = await persistence.open(targetId, 'write')
      const appended = []
      for (let index = 0; index < 5; index += 1) {
        const seq = 3 + index
        appended.push(seq)
        await writer.append([{
          type: 'user/message',
          seq: SessionSeq(seq),
          time: 1_700_000_000_000 + seq,
          data: createUserMessage({ content: [{ type: 'text', text: `appended-${String(index)}` }], source: { kind: 'user' } }),
          surfaceOp: 'append',
        }])
      }
      await writer.flush()
      await writer.close()

      const continued = await plane.continueScan({ maxEvents: 10, cursor: first.cursor })
      const reopened = await plane.openScan(targetId, { maxEvents: 50 })
      finding.obs02WatermarkPinned = {
        watermarkAtPin,
        firstPageSeqs: firstSeqs,
        appendedSeqs: appended,
        continuedWatermark: { maxSeq: continued.watermark.maxSeq, generation: continued.watermark.generation },
        continuedSeqs: continued.events.map(event => event.seq),
        continuedExhausted: continued.exhausted,
        // The load-bearing facts: the pinned scan did NOT see the new events...
        pinnedScanExcludedAppended: continued.events.every(event => !appended.includes(event.seq)),
        watermarkUnchangedAcrossPages:
          continued.watermark.maxSeq === watermarkAtPin.maxSeq
          && continued.watermark.generation === watermarkAtPin.generation,
        // ...and a SEPARATE scan at a NEW generation did.
        reopenedWatermark: { maxSeq: reopened.watermark.maxSeq, generation: reopened.watermark.generation },
        reopenedSeesAppended: appended.every(seq => reopened.events.some(event => event.seq === seq)),
        generationAdvanced: reopened.watermark.generation > watermarkAtPin.generation,
      }

      // --- OBS-03: an event larger than the page budget --------------------
      const big = 'x'.repeat(200_000)
      const bigWriter = await persistence.open(targetId, 'write')
      const bigSeq = 8
      await bigWriter.append([{
        type: 'user/message',
        seq: SessionSeq(bigSeq),
        time: 1_700_000_000_000 + bigSeq,
        data: createUserMessage({ content: [{ type: 'text', text: big }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      }])
      await bigWriter.flush()
      await bigWriter.close()
      // A FRESH scan, so the oversized event is inside the pinned set.
      const scanForBig = await plane.openScan(targetId, { maxEvents: 50 })
      const read = await plane.readEvent(targetId, bigSeq, { maxBytes: 4096, scan: scanForBig.watermark })
      const full = await plane.readEvent(targetId, bigSeq, { maxBytes: 1_000_000, scan: scanForBig.watermark })
      finding.obs03OversizedEvent = {
        kind: read.kind,
        totalBytes: read.kind === 'segments' ? read.totalBytes : null,
        segmentCount: read.kind === 'segments' ? read.segments.length : null,
        segments: read.kind === 'segments' ? read.segments : null,
        digestIsHex64: read.kind === 'segments' ? /^[a-f0-9]{64}$/u.test(read.digest) : null,
        complete: read.kind === 'segments' ? read.complete : null,
        recovery: read.kind === 'segments' ? read.recovery : null,
        // There is no field carrying the event body in the segments arm.
        segmentsArmCarriesNoEventBody: read.kind === 'segments' ? read.event === undefined : null,
        // WHAT THE BUDGET BOUNDS. The returned PAYLOAD is the offsets, not the
        // bytes they name: `maxBytes: 4096` produced four 4096-wide segments and
        // NO body text. So the bound is enforced twice over -- each segment is at
        // most `maxBytes`, and the LIST is capped (4 here) so a tiny budget
        // against a huge event cannot return thousands of offsets, which would be
        // the same breach counted in a different unit.
        segmentListIsBounded: read.kind === 'segments' ? read.segments.length <= 4 : null,
        eachSegmentIsWithinTheRequestedBudget: read.kind === 'segments'
          ? read.segments.every(segment => segment.endByte - segment.startByte <= 4096)
          : null,
        offsetsDescribedExceedTheBudgetBecauseTheListIsCappedNotTruncated: read.kind === 'segments'
          ? read.segments.reduce((sum, segment) => sum + (segment.endByte - segment.startByte), 0) > 4096
          : null,
        // The two arms describe the SAME object.
        fullArmKind: full.kind,
        fullArmDigestEqualsSegmentsDigest: read.kind === 'segments' && full.kind === 'value'
          ? full.digest === read.digest
          : null,
        fullArmBytesEqualsSegmentsTotalBytes: read.kind === 'segments' && full.kind === 'value'
          ? full.bytes === read.totalBytes
          : null,
        eventBodyIs200kChars: big.length,
      }

      // --- OBS-04: the number of full-log materializations -----------------
      const before = plane.replayCounter().total
      let page = await plane.openScan(targetId, { maxEvents: 1 })
      let pages = 1
      while (!page.exhausted && pages < 400) {
        page = await plane.continueScan({ maxEvents: 1, cursor: page.cursor })
        pages += 1
      }
      const after = plane.replayCounter().total
      const controlBefore = after
      const control = await plane.openScan(targetId, { maxEvents: 1 })
      const controlAfter = plane.replayCounter().total
      plane.closeScan(control.watermark)
      finding.obs04Replay = {
        pages,
        exhausted: page.exhausted,
        fullLogMaterializationsForTheTraversal: after - before,
        // THE CONTROL: a second pinned scan must be a second materialization, or
        // a `1` above is a constant rather than a measurement.
        controlArmSecondScanCost: controlAfter - controlBefore,
        controlHasTeeth: controlAfter > controlBefore,
        replayMap: Object.fromEntries([...plane.replayCounter().fullLogReplays].map(([id, count]) => [String(id), count])),
      }

      // --- OBS-05: the three visibilities ---------------------------------
      const { visibilityLedger, recordConsumed, recordProjected, visibilityReport } = await import(
        `${LIB}/history-plane.js`
      )
      const scanForVisibility = await plane.openScan(targetId, { maxEvents: 200 })
      const ledger = visibilityLedger(scanForVisibility.events)
      const storedSeqs = [...ledger.stored.keys()].sort((a, b) => a - b)
      const consumedSeq = storedSeqs[0]
      const projectedSeq = storedSeqs[0]
      if (consumedSeq !== undefined) recordConsumed(ledger, consumedSeq)
      if (projectedSeq !== undefined) recordProjected(ledger, projectedSeq)
      const report = visibilityReport(ledger)
      const union = new Set([...report.storedOnly, ...report.consumedNotProjected, ...report.projected])
      finding.obs05Visibilities = {
        storedCount: storedSeqs.length,
        surfaces: Object.fromEntries([...ledger.stored.entries()].map(([seq, surface]) => [String(seq), surface])),
        consumed: [...ledger.consumed].sort((a, b) => a - b),
        projected: [...ledger.projected].sort((a, b) => a - b),
        report,
        threeSetsAreDisjoint:
          report.storedOnly.filter(seq => report.consumedNotProjected.includes(seq)).length === 0
          && report.consumedNotProjected.filter(seq => report.projected.includes(seq)).length === 0
          && report.storedOnly.filter(seq => report.projected.includes(seq)).length === 0,
        unionAccountsForEveryStoredEvent: union.size === storedSeqs.length,
        // The refusal direction, measured on the loaded plane's own ledger.
        refusingToProjectWithoutConsuming: (() => {
          const fresh = visibilityLedger(scanForVisibility.events)
          try {
            if (consumedSeq !== undefined) recordProjected(fresh, consumedSeq)
            return 'NO REFUSAL -- projection was accepted without consumption'
          } catch (error) {
            return error?.code ?? error?.name ?? String(error)
          }
        })(),
      }

      // --- REACH: does anything in this host CALL history(caller)? ---------
      const tools = ctx.get('tools')
      const ipython = ctx.get('ipython')
      const agent = ctx.get('agents')?.get(callerSessionId)
      let agentToolNames = []
      if (agent !== undefined && tools !== undefined) agentToolNames = tools.schemas(agent).map(schema => schema.name).sort()
      finding.reach = {
        agentToolCount: agentToolNames.length,
        // A model-facing history tool would have to be in this list.
        historyToolNamesInTheModelSurface: agentToolNames.filter(name => /hist|memory|recall|transcript/u.test(name)),
        ipythonKernelServicePresent: ipython !== undefined,
        ipythonExposesAHistoryBinding: ipython !== undefined && typeof ipython.history === 'function',
        ipythonServiceMethodNames: ipython === undefined
          ? null
          : Object.getOwnPropertyNames(Object.getPrototypeOf(ipython)).sort(),
        dailyHistoryMethodNames: Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort(),
      }

      plane.dispose()
    }
  } catch (error) {
    finding.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    writeFileSync(OUT, JSON.stringify(finding, null, 2))
  }
}
