/**
 * Enumerate every resumable Session on this machine and classify its sandbox
 * override. V3 F2 ("Session overrides") requires this as a MEASUREMENT rather
 * than an assumption:
 *
 *   For every copied/canary Session:
 *     - no override                -> allowed;
 *     - `danger-full-access`       -> allowed;
 *     - `read-only`/`workspace-write` -> explicit migration OR refuse resume.
 *   Do not silently ignore event-sourced state.
 *
 * WHY THE DEFAULT IS NOT ENOUGH, stated as source rather than as caution.
 * `SandboxPolicyService.resolve` is
 * (`packages/sandbox/sandbox-policy/src/index.ts:164-171`):
 *
 *     mode: request.mode ?? overrideOf(session) ?? this.defaultMode
 *
 * so changing the DEPLOYMENT DEFAULT does not migrate a Session that already
 * logged a `sandbox/mode` event. That session still resolves to the confined
 * mode -- while the deployment claims to be trusted-local. The override is
 * durable session history, and the two honest dispositions are "migrate it with
 * a record" or "refuse to resume", never "ignore it".
 *
 * THE STORAGE FORMAT TRAP THIS SCANNER EXISTS TO AVOID. A session log is
 * `session.v3.jsonl.zstd` and it is NOT one zstd frame: the writer appends one
 * frame per flush, so `zstdDecompressSync` over the whole file stops after the
 * FIRST frame and silently returns a 176-byte header. A scanner that does that
 * reports "0 sessions carry an override" for a store that contains them --
 * a false negative in the reassuring direction, which is the worst kind. This
 * scanner splits on the zstd magic and decodes every frame, and it CROSS-CHECKS
 * its answer against the projection cache (`storages/session_projcache`), which
 * is an independent reader of the same fold. Two instruments, one verdict.
 *
 * WHAT IT DOES NOT DO. It writes nothing into any session. It does not edit,
 * move or delete a log, and it does not append a migration event. Migration is a
 * decision with an owner; this script produces the inventory that decision needs.
 *
 * USAGE
 *   node .probe/inventory-session-overrides.mjs [root] [out.json]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, dirname } from 'node:path'

const ROOT = process.argv[2] ?? 'D:/DSH/home'
const OUT = process.argv[3] ?? 'D:/DSH/work/wt-r1/qualification/results/R1-trusted-local/session-override-inventory.json'

/** The one mode that does not confine. Spelled once so the classifier cannot drift. */
const TRUSTED_LOCAL_MODE = 'danger-full-access'

/**
 * Decode a session log that may contain MANY concatenated zstd frames.
 *
 * Splitting on the magic is deliberately conservative: a frame boundary inside
 * compressed data would be astronomically unlikely (the 4-byte magic is
 * 0x28B52FFD) and every frame is decoded independently, so a false boundary
 * would fail to decode rather than silently produce wrong text.
 *
 * @param path - the log file.
 * @returns the concatenated decoded text.
 */
function decodeLog(path) {
  const bytes = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x28 && bytes[i + 1] === 0xB5 && bytes[i + 2] === 0x2F && bytes[i + 3] === 0xFD) offsets.push(i)
  }
  if (offsets.length === 0) return { text: bytes.toString('utf8'), frames: 0 }
  let text = ''
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : bytes.length
    try {
      text += zstdDecompressSync(bytes.subarray(offsets[k], end)).toString('utf8')
    } catch {
      // A partial trailing frame is normal for a log that was being written when
      // the process died. Dropping it is correct; the events it held were never
      // durably committed.
    }
  }
  return { text, frames: offsets.length }
}

/** The home a log belongs to, for grouping. */
function homeOf(path) {
  const norm = path.replaceAll('\\', '/')
  const marker = '/DSH/home/'
  const at = norm.indexOf(marker)
  return at < 0 ? '?' : norm.slice(at + marker.length).split('/')[0]
}

const sessions = []
const parseFailures = []

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    if (!/^session.*\.jsonl(\.zstd)?$/.test(entry.name)) continue
    let decoded
    try {
      decoded = decodeLog(path)
    } catch (error) {
      parseFailures.push({ path: path.replaceAll('\\', '/'), error: String(error?.message ?? error) })
      continue
    }
    let header = null
    const modes = []
    let events = 0
    for (const line of decoded.text.split('\n')) {
      if (line.trim() === '') continue
      events++
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'session') header = event
      if (event.type === 'sandbox/mode') {
        modes.push({ mode: event.data?.mode ?? null, source: event.data?.source ?? null, seq: event.seq ?? null })
      }
    }
    sessions.push({
      home: homeOf(path),
      path: path.replaceAll('\\', '/'),
      sessionId: header?.id ?? null,
      cwd: header?.cwd ?? null,
      agentPreset: header?.agentPreset ?? null,
      frames: decoded.frames,
      eventCount: events,
      modeEvents: modes,
      lastOverride: modes.length > 0 ? modes[modes.length - 1].mode : null,
    })
  }
}

walk(ROOT)

// ── the independent cross-check: the projection cache's own folded value ────
const projections = []
function walkCache(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkCache(path)
      continue
    }
    if (!path.replaceAll('\\', '/').includes('projcache')) continue
    if (!entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const cell = parsed?.record?.rows?.sandboxMode
      projections.push({
        home: homeOf(path),
        path: path.replaceAll('\\', '/'),
        sessionId: parsed?.record?.identity?.id ?? null,
        seq: cell?.seq ?? null,
        val: cell?.val ?? null,
      })
    } catch (error) {
      projections.push({ path: path.replaceAll('\\', '/'), error: String(error?.message ?? error) })
    }
  }
}
walkCache(ROOT)

/** Classification per V3 F2. */
function classify(lastOverride) {
  if (lastOverride === null) return 'allowed: no override'
  if (lastOverride === TRUSTED_LOCAL_MODE) return 'allowed: already danger-full-access'
  return `MIGRATE OR REFUSE: override '${lastOverride}' resolves confined under a trusted-local default`
}

const withOverride = sessions.filter(s => s.lastOverride !== null)
const byLast = {}
for (const s of withOverride) byLast[s.lastOverride] = (byLast[s.lastOverride] ?? 0) + 1
const byHome = {}
for (const s of withOverride) byHome[s.home] = (byHome[s.home] ?? 0) + 1
const projectionNonEmpty = projections.filter(p => p.val !== null && p.val !== undefined)

const report = {
  scannedAt: new Date().toISOString(),
  root: ROOT,
  totalSessionLogs: sessions.length,
  logsWithSandboxModeEvent: withOverride.length,
  byLastOverride: byLast,
  byHome,
  classifications: withOverride.map(s => ({
    home: s.home,
    sessionId: s.sessionId,
    cwd: s.cwd,
    agentPreset: s.agentPreset,
    lastOverride: s.lastOverride,
    modeEvents: s.modeEvents,
    disposition: classify(s.lastOverride),
  })),
  // The independent instrument. It is NOT a verdict: it is the same fold read
  // through the cache, so agreement is evidence and disagreement is a finding.
  crossCheck: {
    projectionFiles: projections.length,
    projectionNonEmptyValues: projectionNonEmpty.length,
    projectionValueHistogram: projectionNonEmpty.reduce((acc, p) => {
      acc[p.val] = (acc[p.val] ?? 0) + 1
      return acc
    }, {}),
  },
  parseFailures,
  sessions,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 1))

console.log(`root                     ${ROOT}`)
console.log(`session logs             ${sessions.length}`)
console.log(`with a sandbox/mode event ${withOverride.length}`)
console.log(`by last override         ${JSON.stringify(byLast)}`)
console.log(`by home                  ${JSON.stringify(byHome)}`)
console.log(`projection files         ${projections.length} (non-null values: ${projectionNonEmpty.length})`)
console.log(`projection histogram     ${JSON.stringify(report.crossCheck.projectionValueHistogram)}`)
console.log(`parse failures           ${parseFailures.length}`)
console.log(`-> ${OUT}`)
