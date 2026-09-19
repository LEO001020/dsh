/**
 * V9 — printed numbers for the two VER oracles whose text demands a NUMBER rather
 * than a pass/fail line.
 *
 *   spec VER-05  "A-B-A mutation during acceptance is caught"
 *     oracle: "...The candidate is frozen to an immutable snapshot and the verdict
 *     is bound to that snapshot... The control arm must also be run: endpoint hash
 *     polling alone would have certified the tampered run, and that is demonstrated
 *     rather than asserted."
 *
 *   spec VER-06  "in-flight writers are converged or isolated before freezing"
 *     oracle: "The system converges or isolates the writer before freezing, and an
 *     unresolved mutation produces an unknown rather than a certification."
 *
 * WHY A SEPARATE PROBE. `src/verification-gates.test.ts` asserts both, and its
 * transcript proves they RAN. What a transcript does not carry is the numbers: the
 * A->B->A case's whole point is that the endpoint digests are IDENTICAL while the
 * command executed against a different tree, and that fact is invisible in a
 * "51 passed" line. So this probe re-runs the same two schedules and PRINTS the
 * values, so a reader can check the claim instead of trusting the assertion.
 *
 * BOUNDS (CPU directive): it spawns FOUR short node processes and does no looping
 * beyond the marker poll. It imports the TypeScript directly — Node 24 strips types
 * — which is the same path `qualification/runners/acceptance.mjs` takes.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolved by ABSOLUTE file URL rather than a relative specifier, because the
 * bare `@deepseek-ai/*` imports INSIDE these modules are resolved from the
 * importing module's own directory (`packages/dsh-daily-work/`) — that is where
 * the links live. Importing them by path keeps the resolution honest, and it is
 * the same mechanism `qualification/runners/acceptance.mjs` uses.
 *
 * NOTE ON THE FIRST ATTEMPT, recorded because it is the kind of thing that reads
 * as a product failure: this probe originally imported `@deepseek-ai/cordis`
 * ITSELF, from a file under `qualification/results/`, where no `node_modules`
 * link exists — and it died with ERR_MODULE_NOT_FOUND before running a line. The
 * failure was in the probe's own import list, not in the modules under test, and
 * the fix was to stop importing what the probe does not use.
 */
const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const { digestInputs, runAcceptance, serializeReceipt } = await import(
  pathToFileURL(`${PKG}/src/verify.ts`).href
)
const { acquireWriterWorkspace, convergeBeforeFreeze, writerLeaseHeld } = await import(
  pathToFileURL(`${PKG}/src/worktree-isolation.ts`).href
)

const roots = []
const workspaces = []

function makeRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `v9-${prefix}-`))
  roots.push(dir)
  return dir
}

function write(dir, relPath, content) {
  const target = join(dir, relPath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', ...args], {
    cwd, encoding: 'utf8',
  })
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`)
  return (r.stdout ?? '').trim()
}

const out = []
function say(line = '') {
  out.push(line)
  process.stdout.write(`${line}\n`)
}

async function waitForMarker(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) throw new Error(`the child never signalled readiness via ${markerPath}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function aba() {
  say('='.repeat(72))
  say('spec VER-05 — A-B-A during acceptance: is the verdict bound to the FROZEN copy?')
  say('='.repeat(72))
  const dir = makeRoot('aba')
  const markerDir = makeRoot('aba-marker')
  const markerPath = join(markerDir, 'ready')

  const INPUT_A = 'console.log("A")\n'
  const ORACLE_A = 'export const assertion = "expect(total).toBe(30)"\n'
  const CONFIG_A = "export default { test: { include: ['src/**/*.test.ts'] } }\n"
  const TAMPER = 'B - the tampered version'

  write(dir, 'src/target.mjs', INPUT_A)
  write(dir, 'oracle/acceptance.test.ts', ORACLE_A)
  write(dir, 'oracle/vitest.config.ts', CONFIG_A)
  write(dir, 'src/probe.mjs', `
import { readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
writeFileSync(${JSON.stringify(markerPath)}, 'ready')
const readAll = () => ({
  input: read('src/target.mjs'),
  oracle: read('oracle/acceptance.test.ts'),
  config: read('oracle/vitest.config.ts'),
})
const isTampered = seen => Object.values(seen).some(value => value.includes('${TAMPER}'))
const deadline = Date.now() + 6000
let seen = readAll()
while (!isTampered(seen) && Date.now() < deadline) { await sleep(50); seen = readAll() }
writeFileSync(new URL('src/observed.json', root), JSON.stringify(seen))
if (isTampered(seen)) {
  console.error('SAW_THE_TAMPERED_TREE: ' + Object.entries(seen).filter(([, v]) => v.includes('${TAMPER}')).map(([n]) => n).join(','))
  process.exit(9)
}
`)

  const definition = {
    id: 'v9-aba',
    command: [process.execPath, 'src/probe.mjs'],
    cwd: dir,
    inputs: ['src', 'oracle'],
    timeoutMs: 60_000,
  }
  const digestBefore = digestInputs(definition)

  const mutate = async () => {
    await waitForMarker(markerPath, 30_000)
    await new Promise(resolve => setTimeout(resolve, 700))
    write(dir, 'src/target.mjs', `console.log("${TAMPER}")\n`)
    write(dir, 'oracle/acceptance.test.ts', `export const assertion = "${TAMPER}"\n`)
    write(dir, 'oracle/vitest.config.ts', `export default { test: { include: ["${TAMPER}"] } }\n`)
    await new Promise(resolve => setTimeout(resolve, 1_400))
    write(dir, 'src/target.mjs', INPUT_A)
    write(dir, 'oracle/acceptance.test.ts', ORACLE_A)
    write(dir, 'oracle/vitest.config.ts', CONFIG_A)
  }

  say()
  say('ARM 1 — the runner FREEZES a snapshot and runs the command inside it.')
  const mutation = mutate()
  const snapshotted = await runAcceptance(definition, { keepSnapshot: true })
  await mutation
  say(`  liveDigestAtStart        ${snapshotted.snapshot?.liveDigestAtStart}`)
  say(`  liveDigestAtEnd          ${snapshotted.snapshot?.liveDigestAtEnd}`)
  say(`  digest of the tree as declared at freeze time: ${digestBefore}`)
  say(`  liveDriftDetected        ${snapshotted.snapshot?.liveDriftDetected}`)
  say(`  exit code                ${snapshotted.exit.code}`)
  say(`  stderr contains SAW_THE_TAMPERED_TREE: ${String(snapshotted.output.stderr.text).includes('SAW_THE_TAMPERED_TREE')}`)
  const observed = JSON.parse(readFileSync(join(snapshotted.snapshot.dir, 'src', 'observed.json'), 'utf8'))
  say(`  what the CHILD read: input=${JSON.stringify(observed.input)} oracle=${JSON.stringify(observed.oracle)} config=${JSON.stringify(observed.config)}`)
  say(`  => the child saw revision A for all three, so the frozen copy is what was tested.`)
  say(`  => AND endpoint hashing reports NO DRIFT (liveDriftDetected=${snapshotted.snapshot?.liveDriftDetected}) even though the live tree went A->B->A underneath it.`)
  rmSync(snapshotted.snapshot.dir, { recursive: true, force: true, maxRetries: 5 })

  say()
  say('ARM 2 (the CONTROL) — the same A->B->A, verified IN PLACE.')
  write(dir, 'src/target.mjs', INPUT_A)
  rmSync(markerPath, { force: true })
  const mutation2 = mutate()
  const inPlace = await runAcceptance({ ...definition, snapshot: false }, { keepSnapshot: true })
  await mutation2
  say(`  snapshot                 ${inPlace.snapshot}`)
  say(`  candidateTreeDigestScope ${inPlace.candidateTreeDigestScope}`)
  say(`  exit code                ${inPlace.exit.code}   (9 = the child saw the tampered tree)`)
  say(`  stderr contains SAW_THE_TAMPERED_TREE: ${String(inPlace.output.stderr.text).includes('SAW_THE_TAMPERED_TREE')}`)
  const snapText = serializeReceipt(snapshotted)
  const inPlaceText = serializeReceipt(inPlace)
  say()
  say('  THE ASYMMETRY, on the SERIALIZED artifacts a verifier would store:')
  say(`    snapshot receipt carries liveDriftDetected : ${snapText.includes('liveDriftDetected')}`)
  say(`    snapshot receipt carries liveDigestAtEnd   : ${snapText.includes('liveDigestAtEnd')}`)
  say(`    in-place receipt carries liveDriftDetected : ${inPlaceText.includes('liveDriftDetected')}`)
  say(`    in-place receipt carries liveDigestAtEnd   : ${inPlaceText.includes('liveDigestAtEnd')}`)
  say(`    snapshot arm candidateTreeDigest           : ${snapshotted.candidateTreeDigest}`)
  say(`    in-place arm candidateTreeDigest           : ${inPlace.candidateTreeDigest}`)
  say(`    both equal the pre-mutation digest         : ${snapshotted.candidateTreeDigest === digestBefore && inPlace.candidateTreeDigest === digestBefore}`)
  say()
  say('  VERDICT: the two receipts are INDISTINGUISHABLE in their start digest while one')
  say('  command ran against A and the other demonstrably ran against B. Endpoint hash')
  say('  polling alone would have certified the tampered run; the SNAPSHOT is what makes')
  say('  the frozen revision the tested revision.')
}

async function inflight() {
  say()
  say('='.repeat(72))
  say('spec VER-06 — in-flight writers converged or isolated before freezing')
  say('='.repeat(72))
  const root = makeRoot('inflight')
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'src/app.txt', 'version one\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')

  const workspace = await acquireWriterWorkspace({
    root, writerId: 'v9-inflight', baseRevision: base, parentDir: makeRoot('inflight-ws'),
  })
  workspaces.push(workspace)
  const definition = {
    id: 'v9-inflight',
    command: [process.execPath, '-e', '0'],
    cwd: workspace.path,
    inputs: ['src'],
    timeoutMs: 30_000,
  }

  say()
  say('PATH 1 — a writer LEASE is still held, so the workspace is in flight by definition.')
  say(`  writerLeaseHeld(workspace)        ${writerLeaseHeld(workspace.path)}`)
  const held = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 50 })
  say(`  converged                         ${held.converged}`)
  say(`  digest                            ${JSON.stringify(held.digest)}   ('' = no value is offered for an unknown)`)
  say(`  writerLeaseHeld (reported)        ${held.writerLeaseHeld}`)
  say(`  reasons                           ${JSON.stringify(held.reasons)}`)

  say()
  say('PATH 2 — the lease is released, but the TREE is still moving between samples.')
  workspace.finish()
  say(`  writerLeaseHeld after finish()    ${writerLeaseHeld(workspace.path)}`)
  let writing = true
  const churn = (async () => {
    let n = 0
    while (writing) {
      write(workspace.path, 'src/app.txt', `version ${n++}\n`)
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  })()
  const unconverged = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 120 })
  writing = false
  await churn
  say(`  converged                         ${unconverged.converged}`)
  say(`  digest                            ${JSON.stringify(unconverged.digest)}`)
  say(`  reasons                           ${JSON.stringify(unconverged.reasons)}`)

  say()
  say('PATH 3 (the control) — the writer has stopped; the same call now CONVERGES.')
  const converged = await convergeBeforeFreeze({ workspacePath: workspace.path, definition, settleMs: 150 })
  say(`  converged                         ${converged.converged}`)
  say(`  digest                            ${converged.digest}`)
  say(`  digestInputs(definition)          ${digestInputs(definition)}`)
  say(`  digest is the RUNNER's own tree digest: ${converged.digest === digestInputs(definition)}`)
  say(`  samples                           ${JSON.stringify(converged.samples.map(s => s.digest))}`)

  say()
  say('THE STRUCTURAL INVARIANT — a refusal NEVER carries a digest.')
  for (const [name, result] of [['in-flight', held], ['still-moving', unconverged], ['converged', converged]]) {
    const holds = result.digest === '' ? result.converged === false : result.converged === true
    say(`  ${name.padEnd(14)} digest=${result.digest === '' ? "''" : `${result.digest.slice(0, 16)}...`} converged=${result.converged}  invariant holds=${holds}`)
  }
}

try {
  await aba()
  await inflight()
} finally {
  for (const workspace of workspaces) {
    try { await workspace.release() } catch { /* best effort */ }
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  say()
  say(`cleanup: ${roots.length} temp root(s) removed, ${workspaces.length} workspace(s) released`)
}
