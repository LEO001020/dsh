/**
 * R7 driver: boot the REAL daily profile and measure whether DATA-11's refusal is
 * reachable through the assembled product.
 *
 * WHY A DRIVER AND NOT ONLY THE TEST SUITE. The suite proves the module refuses a
 * cross-realm cursor. It does not prove the product does. This driver boots the
 * composed profile through the shared harness (free port, child host, port
 * release verified), lets the probe run inside that boot, and reports the probe's
 * own JSON. It interprets nothing: the probe decides, this driver transports.
 *
 * THE HOME IS FRESH-PROFILED FROM THE REPOSITORY, not reused. The installed
 * profile under `$DSH_HOME/profiles/daily/` is a COPY, and a stale copy would make
 * the probe report a false absence -- a measurement error about the probe rather
 * than a finding about the product. The `link:` dependencies are rewritten at this
 * worktree so the boot resolves THIS tree's build.
 *
 * Run:
 *   node qualification/runners/r7-cursor-realm-driver.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootAndWait, LAUNCHER } from './boot-harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(dirname(HERE))
const HOME = 'D:/DSH/home/r7'
const PROFILE_SRC = join(REPO, 'profiles', 'daily-candidate')
const PROFILE_DIR = join(HOME, 'profiles', 'daily')
const OUT = join(REPO, 'qualification', 'results', 'R7-cursor-realm', 'product-boot.json')
const PATCH_SRC = join(HERE, 'r7-cursor-realm.patch.yml')
/**
 * The overlay is MATERIALISED INTO THIS TREE at run time, with the probe row
 * rewritten to name THIS tree's probe file.
 *
 * WHY IT IS NOT THE COMMITTED FILE ANY MORE. The committed overlay carries the
 * literal `D:/DSH/work/wt-r7/qualification/runners/r7-cursor-realm-probe.mjs`,
 * and a cordis row's `name:` is a MODULE SPECIFIER: the loader turns an absolute
 * one into a `file://` URL and imports exactly that file
 * (`packages/boot/app-boot/src/index.ts:521`, `vendor/loader/src/config/tree.ts:122-126`).
 * So a boot from any tree other than `wt-r7` executed ANOTHER writer's probe
 * while believing it measured its own composition -- cross-tree CODE EXECUTION,
 * not merely a cross-tree read. A relative `name:` is not a substitute: the
 * loader resolves it against the PROFILE directory, not against this file.
 *
 * Materialising the overlay beside this driver's own result keeps the row a
 * specifier the loader understands while making the file it names this tree's.
 */
const PATCH = join(REPO, 'qualification', 'results', 'R7-cursor-realm', 'r7-cursor-realm.patch.yml')
function materialiseOverlay() {
  const text = readFileSync(PATCH_SRC, 'utf8')
  const own = join(HERE, 'r7-cursor-realm-probe.mjs').replace(/\\/g, '/')
  const rewritten = text.replace(/^(\s*name:\s*)'[^']*r7-cursor-realm-probe\.mjs'/mu, `$1'${own}'`)
  if (rewritten === text) {
    throw new Error(`r7-cursor-realm-driver: the overlay names no r7-cursor-realm-probe.mjs row to rewrite: ${PATCH_SRC}`)
  }
  mkdirSync(dirname(PATCH), { recursive: true })
  writeFileSync(PATCH, rewritten, 'utf8')
  return PATCH
}

/** Install the profile FRESH from this repository. */
function installProfile() {
  rmSync(PROFILE_DIR, { recursive: true, force: true })
  mkdirSync(dirname(PROFILE_DIR), { recursive: true })
  cpSync(PROFILE_SRC, PROFILE_DIR, { recursive: true })
  const pkgPath = join(PROFILE_DIR, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = pkg.dependencies ?? {}
  for (const name of Object.keys(deps)) {
    if (String(deps[name]).startsWith('link:')) {
      deps[name] = `link:${join(REPO, 'packages', name.replace(/^dsh-/, ''))}`
    }
  }
  // Point every link at THIS worktree's package, so the boot resolves the build
  // this driver is measuring rather than a sibling writer's tree.
  deps['dsh-daily-work'] = `link:${join(REPO, 'packages', 'dsh-daily-work')}`
  deps['dsh-ipython'] = `link:${join(REPO, 'packages', 'dsh-ipython')}`
  pkg.dependencies = deps
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  // The bundle must be INSTALLED, not merely declared: without this the boot fails
  // with `cannot resolve profile bundle "dsh-daily-work"`, which looks like a
  // composition failure and is only a missing link. `helpers/new-writer.ps1` runs
  // the same command for the same reason.
  execFileSync(process.execPath, [LAUNCHER, 'plugin', '--profile', 'daily', 'install'], {
    cwd: PROFILE_DIR,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: 'pipe',
  })
}

installProfile()
if (existsSync(OUT)) rmSync(OUT)
materialiseOverlay()

const boot = await bootAndWait({
  home: HOME,
  profile: 'daily',
  patches: [PATCH],
  outPath: OUT,
  cwd: REPO,
  timeoutMs: 120_000,
  env: { R7_PROBE_OUT: OUT },
})

const result = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
const report = {
  boot: {
    port: boot.port,
    exitCode: boot.exitCode,
    timedOut: boot.timedOut,
    portReleased: boot.portReleased,
    stderrTail: boot.stderr.split('\n').slice(-12).join('\n'),
  },
  probe: result,
}
writeFileSync(join(dirname(OUT), 'product-boot-driver.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
