/**
 * T2 measurement: WHY does `assessIntegration` refuse the FS-06b candidate?
 *
 * WHY THIS EXISTS. `verification-gates.test.ts > FS-06 > the raw-Python write is
 * caught by the candidate/HEAD comparison` asserted `accept_for_publication` and
 * got `refuse`. The assertion shows only the decision, never the reasons, so the
 * cause had to be measured rather than inferred: a refusal has several possible
 * sources (base mismatch, patch not applying, out-of-scope paths, no receipt,
 * binding mismatch) and the raw-Python edit is only one of them.
 *
 * WHAT IT ESTABLISHES. Reproducing the scenario and printing the assessment's own
 * `reasons` array shows the refusal came from the MISSING RECEIPT, not from the
 * raw-Python edit:
 *
 *   "there is no acceptance receipt, so there is no evidence that any test ran"
 *   "no acceptance receipt was supplied, so nothing about the candidate has been verified"
 *
 * So the case was failing for a reason unrelated to the property it names. The
 * fixture now supplies a real receipt and measures both the residual gap and its
 * closure (see the case's own comments).
 *
 * RUN IT FROM ANYWHERE. Imports are absolute paths into the pinned checkout,
 * because ESM resolves bare specifiers relative to the IMPORTING FILE's location
 * rather than the process cwd. `tsx` is needed for the `.ts` import of the subject.
 *   cd D:/DSH/src/dsh-src && node --import tsx/esm \
 *     D:/DSH/work/dsh-native-daily/qualification/runners/t2-probes/fs06b-probe.mts
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'file:///D:/DSH/src/dsh-src/vendor/cordis/lib/index.js'
import { LocalSubprocessRuntime } from 'file:///D:/DSH/src/dsh-src/packages/subprocess/subprocess-local/lib/index.js'
// The subject under test, reached through its SOURCE so this probe tracks the
// module rather than a stale build.
import { acquireWriterWorkspace, assessIntegration } from 'file:///D:/DSH/work/dsh-native-daily/packages/dsh-daily-work/src/worktree-isolation.ts'

const roots: string[] = []
const makeRoot = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), `t2-${p}-`))
  roots.push(d)
  return d
}
const write = (dir: string, rel: string, content: string): void => {
  const t = join(dir, rel)
  mkdirSync(join(t, '..'), { recursive: true })
  writeFileSync(t, content, 'utf8')
}
const gitTry = (cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', ...args], { cwd, encoding: 'utf8' })
  return { code: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}
const git = (cwd: string, ...args: string[]): string => {
  const r = gitTry(cwd, ...args)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}
const makeRepo = (prefix: string): { root: string; base: string } => {
  const root = makeRoot(prefix)
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'src/app.txt', 'version one\n')
  write(root, 'README.md', 'candidate\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

const { root, base } = makeRepo('fs06b')
const workspace = await acquireWriterWorkspace({
  root,
  writerId: 'rawpy',
  baseRevision: base,
  parentDir: makeRoot('fs06b-ws'),
})

write(workspace.path, 'src/app.txt', 'committed change\n')
git(workspace.path, 'commit', '-q', '-am', 'committed change')
const head = git(workspace.path, 'rev-parse', 'HEAD')

const python = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
const target = join(workspace.path, 'src', 'app.txt').replace(/\\/g, '\\\\')
// `newline=''` so the fixture's bytes are the ones the script states; without it
// CPython's text mode translates \n to \r\n on Windows and this probe would be
// measuring the host's line separator.
const script = [
  'import pathlib',
  `pathlib.Path(r"${target}").write_text("raw python change\\n", encoding="utf-8", newline='')`,
].join('\n')
const wrote = spawnSync(python, ['-c', script], { encoding: 'utf8' })
console.log('python_status:', wrote.status, 'stderr:', (wrote.stderr ?? '').slice(0, 300))

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const assessment = await assessIntegration({
  ctx,
  root,
  candidate: { cwd: workspace.path, baseRevision: base, headRevision: head },
  expectedBase: base,
  allowedPaths: ['src'],
  patchDir: makeRoot('fs06b-patch'),
})

console.log(JSON.stringify({
  decision: assessment.decision,
  reasons: assessment.reasons,
  testsAreReal: assessment.testsAreReal,
  testReason: assessment.testReason,
  patchApplies: assessment.patchApplies,
  scopeOk: assessment.scopeOk,
  baseRevisionMatches: assessment.baseRevisionMatches,
  headDescendsFromBase: assessment.headDescendsFromBase,
  changedPaths: assessment.changedPaths,
  receiptBinding: assessment.receiptBinding,
}, null, 2))

await ctx.fiber.dispose()
for (const r of roots) rmSync(r, { recursive: true, force: true })
