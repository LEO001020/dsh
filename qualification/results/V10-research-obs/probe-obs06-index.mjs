/**
 * OBS-06 probe: the derived full-text index is rebuildable from canonical data.
 *
 * THE STIMULUS IS A DELETION. The derived index is removed, and the SAME queries
 * must be answered afterwards from the canonical Session/artifact data with no
 * second history source. This probe uses the REAL SQLite FTS5 backend
 * (`@deepseek-ai/dsh-session-query-sqlite`) over the REAL JSONL session
 * persistence, deletes the index FILE AND ITS DIRECTORY, boots a fresh engine over
 * the surviving session root, and re-asks the query.
 *
 * WHAT IT RECORDS, because "rebuilt" is not a single fact:
 *   - the query result BEFORE the deletion (the baseline the rebuild must match);
 *   - the files the index directory held before the deletion, and that the
 *     directory is GONE afterwards;
 *   - the result AFTER the rebuild, and whether it matches the baseline;
 *   - WHAT THE REBUILD READ: the session root that survived, enumerated, so
 *     "from canonical data" is a file list rather than an assertion.
 *
 * Run: node qualification/results/V10-research-obs/probe-obs06-index.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'D:/DSH/work/dsh-native-daily'
const require = createRequire(`${REPO}/packages/dsh-daily-work/package.json`)
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href)

const { Context } = await load('@deepseek-ai/cordis')
const { SessionStore, SessionId, SessionSeq, SESSION_FORMAT_VERSION } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const JsonlSessionPersistence = (await load('@deepseek-ai/dsh-session-persistence-jsonl')).default
const SqliteSessionQueryEngine = (await load('@deepseek-ai/dsh-session-query-sqlite')).default

const sessionRoot = mkdtempSync(join(tmpdir(), 'v10-obs06-sessions-'))
const indexRoot = mkdtempSync(join(tmpdir(), 'v10-obs06-index-'))
const indexPath = join(indexRoot, 'search.db')

const out = []
const say = line => { out.push(line); console.log(line) }
const removeTree = path => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
/** A bounded, non-recursive listing: enough to name what is there without a walk. */
const listFlat = path => existsSync(path) ? readdirSync(path).sort() : []

say('=== OBS-06: a derived index rebuilds from canonical data ===')
say(`session root: ${sessionRoot}`)
say(`index root:   ${indexRoot}`)

const CWD = 'C:/v10-obs06-project'
const MARKER = 'CANONICALMARKERONLY'

let ctx
try {
  // --- the canonical session, written to real JSONL storage ---------------
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(SqliteSessionQueryEngine, { path: indexPath, openAt: 'startup' })

  const sessionId = SessionId('v10-obs06-session')
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: CWD, isSeeded: false,
  })
  await handle.append([
    { type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: `${MARKER} the only copy of this fact` }], source: { kind: 'user' } }) },
    { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'an unrelated second event' }], source: { kind: 'user' } }) },
  ])
  await handle.flush()
  await handle.close()

  // --- the baseline query --------------------------------------------------
  const query = { query: MARKER, sessionFilters: [{ kind: 'cwd', values: [CWD] }] }
  const before = await ctx.sessionQuery.searchSessions(query)
  const baseline = {
    itemCount: before.items.length,
    sessionIds: before.items.map(item => String(item.header?.id ?? '?')),
    live: before.items.map(item => item.live === true),
    persisted: before.items.map(item => item.persisted === true),
    bestMatchSeq: before.items.map(item => item.bestMatch?.seq ?? null),
    snippetContainsMarker: (before.items[0]?.bestMatch?.snippet ?? '').includes(MARKER),
  }
  say('')
  say(`baseline query result: ${JSON.stringify(baseline)}`)
  say(`index dir before deletion: ${JSON.stringify(listFlat(indexRoot))}`)

  // --- tear down, DELETE the derived index AND its directory --------------
  await ctx.fiber.dispose()
  ctx = undefined
  removeTree(indexRoot)
  say(`index dir after deletion:  ${JSON.stringify(listFlat(indexRoot))} (exists=${String(existsSync(indexRoot))})`)
  say(`canonical session root survived: ${String(existsSync(sessionRoot))} -> ${JSON.stringify(listFlat(sessionRoot))}`)

  // WHAT THE REBUILD MAY READ: only the canonical session root.
  const canonicalFiles = []
  for (const entry of listFlat(sessionRoot)) {
    const path = join(sessionRoot, entry)
    if (statSync(path).isDirectory()) {
      canonicalFiles.push({ entry, kind: 'dir', contents: listFlat(path) })
    } else {
      canonicalFiles.push({ entry, kind: 'file', bytes: statSync(path).size })
    }
  }
  say(`canonical files the rebuild has to work from: ${JSON.stringify(canonicalFiles)}`)

  // --- boot a fresh engine over the surviving session root ----------------
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot })
  await ctx.plugin(SqliteSessionQueryEngine, { path: indexPath, openAt: 'startup' })

  const after = await ctx.sessionQuery.searchSessions(query)
  const rebuilt = {
    itemCount: after.items.length,
    sessionIds: after.items.map(item => String(item.header?.id ?? '?')),
    live: after.items.map(item => item.live === true),
    persisted: after.items.map(item => item.persisted === true),
    bestMatchSeq: after.items.map(item => item.bestMatch?.seq ?? null),
    snippetContainsMarker: (after.items[0]?.bestMatch?.snippet ?? '').includes(MARKER),
  }
  say('')
  say(`rebuilt query result: ${JSON.stringify(rebuilt)}`)
  say(`index dir after the rebuild: ${JSON.stringify(listFlat(indexRoot))}`)
  say('')
  say(`SAME ANSWER AS BEFORE: ${String(JSON.stringify(baseline) === JSON.stringify(rebuilt))}`)
  say(`a SECOND history source was needed: false (the index directory did not exist when the rebuild started)`)
} finally {
  try { await ctx?.fiber.dispose() } catch { /* the measurement is already recorded */ }
  removeTree(sessionRoot)
  removeTree(indexRoot)
}

say('')
say(`temp dirs removed: ${String(!existsSync(sessionRoot))} / ${String(!existsSync(indexRoot))}`)
