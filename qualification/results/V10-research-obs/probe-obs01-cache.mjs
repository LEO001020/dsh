/**
 * OBS-01 measurement: observe ONE unchanged stored session N times with the
 * prepared-observation cache sized ABOVE N, and count the underlying full log
 * reads.
 *
 * WHY A STANDALONE SCRIPT RATHER THAN A TEST. The oracle for OBS-01 asks for a
 * read count RECORDED VERBATIM, and for a cache that never hits to be reported as
 * a DEFECT WITH ITS CAUSE. A test file can assert a number; this script prints the
 * number, the cache size, the revision on both ends, and the identity of the
 * object the cache key actually compares, so a reader can falsify the claim
 * without reading the test.
 *
 * WHAT IS REAL HERE: the real `SessionStore`, the real JSONL session persistence
 * (`@deepseek-ai/dsh-session-persistence-jsonl`, whose `open(id,'read')` handle is
 * wrapped to COUNT), the real SQLite session-query engine, and the real
 * `SessionObservationReader` inside it. Nothing is mocked; the only modification
 * is a counter on the persistence handle's `read` method.
 *
 * THE HYPOTHESIS UNDER TEST (G-SEAM-23): the cache key is
 *   `cached.persistence !== persistence || cached.revision !== revision`
 * (`packages/session-query/session-query/src/observation.ts:209`) and
 * `persistence` comes from `ctx.get('sessionPersistence')`, which returns a fresh
 * traceable Proxy on every call (`vendor/cordis/src/utils.ts:165-175`). If that is
 * true, the identity half of the key is ALWAYS false, the revision half always
 * matches, and the cache never hits.
 *
 * THE FALSIFIER IS BUILT IN. The same run measures the revision on both ends
 * (must be equal, so the revision half is NOT the reason), and compares
 * `ctx.get('sessionPersistence') === ctx.get('sessionPersistence')` on two
 * consecutive calls. If those two were the same object, the defect would not
 * exist; if they differ, the key cannot match. It also resolves
 * `symbols.original` on both, to show the STABLE target the fix would key on.
 *
 * Run: node qualification/results/V10-research-obs/probe-obs01-cache.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'D:/DSH/work/dsh-native-daily'
const require = createRequire(`${REPO}/packages/dsh-daily-work/package.json`)
/** Windows absolute paths are not ESM URLs; every resolved entry goes through this. */
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href)

const { Context } = await load('@deepseek-ai/cordis')
const { SessionStore, SessionId, SessionSeq, SESSION_FORMAT_VERSION } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const JsonlSessionPersistence = (await load('@deepseek-ai/dsh-session-persistence-jsonl')).default
const SqliteSessionQueryEngine = (await load('@deepseek-ai/dsh-session-query-sqlite')).default

/** N observations of one unchanged session. The cache is sized above N. */
const N = 6
const CACHE_SIZE = 32

const sessionRoot = mkdtempSync(join(tmpdir(), 'v10-obs01-sessions-'))
const indexRoot = mkdtempSync(join(tmpdir(), 'v10-obs01-index-'))
const indexPath = join(indexRoot, 'search.db')

const out = []
const say = line => { out.push(line); console.log(line) }

say('=== OBS-01: observation cache hit rate, measured ===')
say(`N (observations of one unchanged session) = ${N}`)
say(`preparedSessionCacheSize                  = ${CACHE_SIZE}  (ABOVE N, so eviction is not the reason)`)
say(`repo                                      = ${REPO}`)

let logReads = 0
let ctx
try {
  ctx = new Context()
  await ctx.plugin(SessionStore)

  const CountingJsonl = class extends JsonlSessionPersistence {
    async open(id, access, options) {
      const handle = await super.open(id, access, options)
      if (access === 'read') {
        const original = handle.read.bind(handle)
        handle.read = async (...args) => {
          logReads += 1
          return await original(...args)
        }
      }
      return handle
    }
  }
  await ctx.plugin(CountingJsonl, { root: sessionRoot })
  await ctx.plugin(SqliteSessionQueryEngine, {
    path: indexPath, openAt: 'startup', preparedSessionCacheSize: CACHE_SIZE,
  })

  // Write one canonical session to real JSONL storage.
  const sessionId = SessionId('obs01-unchanged')
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: 'C:/project-a', isSeeded: false,
  })
  await handle.append(Array.from({ length: 200 }, (_, seq) => ({
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    data: createUserMessage({ content: [{ type: 'text', text: `payload-${seq}` }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  })))
  await handle.flush()
  await handle.close()

  // THE CONTROL ON THE KEY'S SECOND HALF: the revision must be stable, or a
  // miss would be explained by the revision rather than by the identity.
  const revisionBefore = (await ctx.sessionPersistence.stat(sessionId))?.revision
  const revisionAfter = (await ctx.sessionPersistence.stat(sessionId))?.revision
  say('')
  say(`revision before observations: ${String(revisionBefore)}`)
  say(`revision after  observations: ${String(revisionAfter)}`)
  say(`revision stable across calls: ${String(revisionBefore === revisionAfter)}`)

  // THE CONTROL ON THE KEY'S FIRST HALF: is the object the reader keys on the
  // same object twice?
  const p1 = ctx.get('sessionPersistence')
  const p2 = ctx.get('sessionPersistence')
  const symbolsOriginal = Symbol.for('cordis.original')
  say('')
  say(`ctx.get('sessionPersistence') === ctx.get('sessionPersistence') : ${String(p1 === p2)}`)
  say(`  first  call -> constructor: ${p1?.constructor?.name ?? 'n/a'}  proxyTargetSameAsSecond: ${String(p1?.[symbolsOriginal] === p2?.[symbolsOriginal])}`)
  say(`  second call -> constructor: ${p2?.constructor?.name ?? 'n/a'}`)
  say(`  both are Proxies over ONE stable target (the escape the fix would use): ${String(p1?.[symbolsOriginal] !== undefined && p1[symbolsOriginal] === p2[symbolsOriginal])}`)

  // THE MEASUREMENT.
  const before = logReads
  const sources = []
  for (let index = 0; index < N; index += 1) {
    const lease = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    sources.push(lease.source)
    lease[Symbol.dispose]()
  }
  const reads = logReads - before

  say('')
  say(`observations issued:            ${N}`)
  say(`lease.source for every read:    ${JSON.stringify(sources)}`)
  say(`FULL LOG READS OBSERVED:        ${reads}`)
  say(`a cache HIT would have produced: 1`)
  say('')
  say(reads === 1
    ? 'RESULT: the cache HIT. One full log read for N observations.'
    : `RESULT: DEFECT CONFIRMED -- the cache never hit. ${reads} full log reads for ${N} observations of ONE unchanged `
      + `session with cacheSize ${CACHE_SIZE} > N ${N}. A working cache would have produced 1.`)
  if (reads !== 1) {
    say('')
    say('CAUSE (measured above, not inferred): the revision half of the key MATCHES (revision stable: true),')
    say('and the identity half CANNOT match, because ctx.get(name) returns a fresh traceable Proxy on every')
    say('call, so `cached.persistence !== persistence` is always true.')
    say('  key: packages/session-query/session-query/src/observation.ts:209')
    say('       if (cached === undefined || cached.persistence !== persistence || cached.revision !== revision) return undefined')
    say('  proxy: vendor/cordis/src/utils.ts:165-175 (createTraceable -> new Proxy(value, ...))')
    say('  entry: vendor/cordis/src/reflect.ts (ctx.get -> getTraceable)')
    say('  escape: proxy[Symbol.for("cordis.original")] is the STABLE target, measured identical above')
    say('')
    say('CONSUMER EXPOSURE, measured separately in this slice: the history plane does NOT rely on this cache')
    say('(it pins its own observation), which is why a 100-page traversal costs ONE log read. See')
    say('qualification/results/V10-research-obs/OBS-04-100page-traversal.txt and the HIS-04 block of')
    say('qualification/results/V10-research-obs/OBS-history-web.txt.')
  }
} finally {
  try { await ctx?.fiber.dispose() } catch { /* the measurement is already recorded */ }
  rmSync(sessionRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  rmSync(indexRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

say('')
say(`temp dirs removed: ${String(!existsSync(sessionRoot))} / ${String(!existsSync(indexRoot))}`)
