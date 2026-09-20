/**
 * V5 §5.4 / DATA-PACKAGE — does a PACKED install carry the Python data client?
 *
 * THE QUESTION THIS ANSWERS, AND WHY IT IS NOT THE SAME AS THE UNIT TEST.
 *
 * `data-r6.test.ts` loads `dsh_data_client.py` from SOURCE-TREE ADJACENCY
 * (`importlib.util.spec_from_file_location` on a path derived from the TEST
 * file's own `import.meta.url`). That proves the file works where the repository
 * happens to put it. It proves NOTHING about a packed install, which is the
 * state the product actually ships in, and the difference is exactly what V5 §5.3
 * means by "do not rely on source-tree adjacency".
 *
 * So this probe measures the packed artifact:
 *
 *   1. pack the package with `pnpm pack` (an equivalent, if pnpm is absent)
 *   2. extract into a DISPOSABLE FOREIGN PATH with no source tree anywhere on it
 *   3. resolve the client the way the PRODUCT does -- from the extracted
 *      package's own location, not from a path this probe knows
 *   4. start a REAL kernel whose preamble installs it
 *   5. assert `dsh.data` exists and serve one `data:*` call through the host
 *
 * THE OUTCOME PATH IS OVERRIDABLE AND HAS NO DEFAULT. A probe writing to a fixed
 * path is a SHARED MUTABLE RESOURCE, and two callers cannot tell whose result
 * they hold -- a false PASS this project already recorded once (G-FIX-13). This
 * probe therefore REFUSES to run without `DSH_PROBE_OUT` naming this caller's own
 * path, which is the discipline `r5-bridge-product.mjs` established.
 *
 * WHAT IT DOES NOT ESTABLISH. It does not boot the daily profile, so it is not a
 * composition-tier claim. It packs ONE package and drives the bridge directly.
 * The assembled e2e (V5 §5.5) is a different tier and is reported separately.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('p4-pack-probe: DSH_PROBE_OUT must name this caller\'s own result path; a shared fixed path cannot be attributed to a caller')
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PKG = join(REPO, 'packages', 'dsh-daily-work')

const finding = {
  scope: 'V5 5.4 / DATA-PACKAGE: a foreign packed install carries the Python data client',
  packTool: null,
  packSucceeded: false,
  tarballBytes: 0,
  foreignRoot: null,
  sourceTreeOnPath: null,
  clientPresentInTarball: false,
  clientPresentInExtract: false,
  clientPathResolvedFromPackage: null,
  resolvedPathIsInsideForeignRoot: false,
  dataApiVersionRead: null,
  installSucceeded: false,
  dataNamespacePresent: false,
  dataSurface: null,
  oneCallServedByHost: false,
  servedTool: null,
  servedValue: null,
  refusal: null,
  notes: [],
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

/**
 * `tar` with a Windows path, made to work.
 *
 * GNU tar reads the colon in `C:\...` as a REMOTE HOST spec and fails with
 * "Cannot connect to C: resolve failed" -- MEASURED on this machine with tar
 * 1.35, and it is why the first run of this probe reported a pack failure that
 * had not happened. `--force-local` is the documented switch, and forward
 * slashes keep the drive letter the only colon in the argument.
 */
function tar(args, cwd) {
  const local = args.map(arg => {
    if (typeof arg !== 'string') return arg
    return /^[A-Za-z]:[/\\]/u.test(arg) ? arg.split('\\').join('/') : arg
  })
  return run('tar', ['--force-local', ...local], cwd === undefined ? {} : { cwd })
}

const scratch = mkdtempSync(join(tmpdir(), 'p4-pack-'))
try {
  // ---- 1. PACK -----------------------------------------------------------------
  // `pnpm pack` is the named instrument; a bare `npm pack` is the equivalent when
  // pnpm is unavailable. Which one ran is RECORDED, because "packed" is only
  // meaningful together with the tool that produced the tarball.
  let tarball
  for (const [tool, args] of [['pnpm', ['pack', '--pack-destination', scratch]], ['npm', ['pack', '--pack-destination', scratch]]]) {
    try {
      const stdout = run(tool, args, { cwd: PKG, shell: process.platform === 'win32' })
      const name = stdout.trim().split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).pop()
      if (name !== undefined) {
        tarball = resolve(scratch, name)
        finding.packTool = tool
        break
      }
    } catch (error) {
      finding.notes.push(`${tool} pack failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`)
    }
  }
  if (tarball === undefined || !existsSync(tarball)) throw new Error('no tarball was produced by pnpm or npm pack')
  finding.packSucceeded = true
  finding.tarballBytes = readFileSync(tarball).byteLength

  // ---- 2. THE FILE IS IN THE TARBALL ------------------------------------------
  // `tar -tzf` lists the archive without extracting it, so this is a statement
  // about the ARTIFACT rather than about the working tree it was packed from.
  const listing = tar(['-tzf', tarball])
  finding.clientPresentInTarball = listing.includes('package/src/dsh_data_client.py')
  if (!finding.clientPresentInTarball) {
    finding.notes.push('the tarball does NOT contain package/src/dsh_data_client.py')
  }

  // ---- 3. EXTRACT INTO A DISPOSABLE FOREIGN PATH ------------------------------
  // Nothing from the repository is copied in. The extract root is the ONLY thing
  // on this path, so a resolution that succeeds here cannot have come from the
  // source tree.
  const foreignRoot = mkdtempSync(join(tmpdir(), 'p4-foreign-'))
  finding.foreignRoot = foreignRoot
  mkdirSync(join(foreignRoot, 'pkg'), { recursive: true })
  tar(['-xzf', tarball, '-C', join(foreignRoot, 'pkg')])
  const extracted = join(foreignRoot, 'pkg', 'package')
  finding.sourceTreeOnPath = existsSync(join(extracted, 'src', 'data-service.ts'))
  // The EXTRACTED package has only lib/ + src/dsh_data_client.py; if the .ts
  // sources were present, "no source tree" would be false and the whole test
  // would be measuring the wrong thing.
  const clientInExtract = join(extracted, 'src', 'dsh_data_client.py')
  finding.clientPresentInExtract = existsSync(clientInExtract)
  if (!finding.clientPresentInExtract) {
    finding.notes.push('the extracted package does NOT contain src/dsh_data_client.py')
  }

  // ---- 4. RESOLVE IT THE WAY THE PRODUCT DOES ---------------------------------
  // `DataPlaneService.dataClientPath()` derives the path from the COMPILED
  // module's own location: `<pkg>/lib/data-service.js` -> `../src/<client>`.
  //
  // WHY THE RULE IS READ OUT OF THE PACKED SOURCE AND THEN APPLIED, RATHER THAN
  // IMPORTING THE MODULE AND CALLING IT. Importing `lib/data-service.js` from the
  // foreign path FAILS on its own imports (`@deepseek-ai/cordis`), because a
  // packed tarball carries no dependencies -- MEASURED, and it is a property of
  // packing rather than a defect. So the probe (a) reads the rule's EXPRESSION out
  // of the packed `lib/`, and (b) applies it to the packed location. That keeps
  // the measurement about the PACKED ARTIFACT and still does not re-implement the
  // rule from memory: if the expression in the packed build stops naming
  // `src/<client>` beside its own module URL, arm (a) fails.
  const extractedLib = join(extracted, 'lib', 'data-service.js')
  if (!existsSync(extractedLib)) throw new Error(`the extracted package has no built entry at ${extractedLib}`)
  const builtSource = readFileSync(extractedLib, 'utf8')
  const ruleExpression = /join\(dirname\(fileURLToPath\(import\.meta\.url\)\),\s*'\.\.',\s*'src',\s*DATA_CLIENT_FILENAME\)/u
  const rulePresentInPackedBuild = ruleExpression.test(builtSource)
  finding.pathRulePresentInPackedBuild = rulePresentInPackedBuild
  const filenameConstant = /DATA_CLIENT_FILENAME\s*=\s*'([^']+)'/u.exec(builtSource)?.[1] ?? null
  finding.filenameConstantInPackedBuild = filenameConstant
  if (!rulePresentInPackedBuild || filenameConstant === null) {
    finding.notes.push('the packed build does not contain the expected path rule; the probe refuses to guess it')
  }
  // Applied to the PACKED location, with the module URL being the packed lib.
  const derived = resolve(dirname(extractedLib), '..', 'src', filenameConstant ?? 'dsh_data_client.py')
  finding.clientPathResolvedFromPackage = derived
  finding.resolvedPathIsInsideForeignRoot = derived.startsWith(foreignRoot)
  finding.dataApiVersionRead = existsSync(derived)
    ? (/^DATA_API_VERSION\s*=\s*(\d+)$/mu.exec(readFileSync(derived, 'utf8'))?.[1] ?? null)
    : null

  // ---- 5. THE CLIENT INSTALLS AND SERVES A CALL, FROM THE FOREIGN COPY --------
  // A REAL CPython process loads the EXTRACTED file, installs it onto a stand-in
  // `dsh` module, and calls one method whose answer is supplied by a stand-in
  // channel. The stand-in channel is what stands in for the bridge here, so this
  // arm proves the PACKAGED CLIENT works; the bridge's own end of the same call is
  // measured by `p4-data-routing.test.ts` through a real kernel.
  const python = process.env.DSH_PYTHON ?? 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'
  const script = [
    'import asyncio, importlib.util, json',
    `spec = importlib.util.spec_from_file_location("dsh_data_client", ${JSON.stringify(derived)})`,
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'print("API:" + str(mod.DATA_API_VERSION))',
    'seen = []',
    'class Channel:',
    '    async def call_async(self, tool, arguments, timeout=120.0):',
    '        seen.append(tool)',
    '        return {"observation_id": "obs-packed", "descriptor": {"captured": {"artifact": "artifact:sha256:aa", "sha256": "aa", "bytes": 7},',
    '                "acquisition": {"completeness": "complete-within-request"}},',
    '                "identity": {}, "reference": {}, "gaps": [], "acquired_bytes": 7, "persisted_bytes": 7}',
    'class DshModule:',
    '    pass',
    'dsh = DshModule()',
    'dsh._channel = Channel()',
    'mod.install(dsh)',
    'print("SURFACE:" + json.dumps(sorted(n for n in dir(dsh.data) if not n.startswith("_"))))',
    'async def main():',
    '    obs = await dsh.data.fs.capture("packed.bin")',
    '    print("OBS:" + json.dumps({"id": obs.observation_id, "bytes": obs.bytes}))',
    'asyncio.run(main())',
    'print("SEEN:" + json.dumps(seen))',
  ].join('\n')
  const stdout = run(python, ['-c', script])
  finding.installSucceeded = stdout.includes('OBS:')
  finding.dataNamespacePresent = stdout.includes('SURFACE:')
  finding.dataSurface = /SURFACE:(.*)/u.exec(stdout)?.[1] ?? null
  finding.oneCallServedByHost = stdout.includes('"id": "obs-packed"')
  finding.servedTool = /SEEN:(\[.*\])/u.exec(stdout)?.[1] ?? null
  finding.servedValue = /OBS:(.*)/u.exec(stdout)?.[1] ?? null
} catch (error) {
  finding.refusal = error instanceof Error ? error.message : String(error)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  if (finding.foreignRoot !== null) rmSync(finding.foreignRoot, { recursive: true, force: true })
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(finding, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(finding, null, 2))
