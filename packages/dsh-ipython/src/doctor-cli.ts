/**
 * The `doctor` command an operator runs when a kernel cannot start.
 *
 * WHY THIS IS A SEPARATE MODULE WITH A `main`. V5 §11.3 requires that a
 * deployment which cannot bootstrap "fails loud with an exact doctor
 * instruction". An instruction that names a command is only honest if the
 * command exists and does what the instruction says, so the string in
 * `pythonConfigurationInstruction` (`dsh-ipython doctor --bootstrap`) has to have
 * a real target. This is it.
 *
 * WHY IT IS NOT A PLUGIN ROW. It runs BEFORE the deployment can boot -- the whole
 * point is that the operator's kernel does not start -- so it cannot depend on a
 * cordis context, a loader, or a profile. It reads the environment, the
 * filesystem and one subprocess, and prints.
 *
 * THE THREE MODES:
 *   (default)     report only. Never writes anything. Safe on any machine.
 *   --bootstrap   discover a system CPython, create `$DSH_HOME/runtime/python`,
 *                 and report the install command. Does NOT use the network.
 *   --check       report and exit non-zero when NOT READY, for a gate to call.
 *
 * It NEVER runs a network install on its own. That is deliberate: this round has
 * no authorized budget for one, and a doctor that silently reached the network
 * would be doing the thing the constraint forbids. The install command is printed
 * for the operator to run.
 *
 * Usage:
 *   node --import tsx packages/dsh-ipython/src/doctor-cli.ts [--bootstrap|--check]
 *   (or, once built: node packages/dsh-ipython/lib/doctor-cli.js [--bootstrap])
 */
import {
  bootstrapManagedVenv,
  discoverSystemPython,
  renderDoctorReport,
  resolveKernelInterpreter,
} from './python-doctor.ts'
import { managedVenvPython, resolveRuntimeDshHome } from './runtime-root.ts'

/** Exit codes, named so a gate can assert on them rather than on prose. */
export const EXIT_READY = 0
export const EXIT_NOT_READY = 1
export const EXIT_BOOTSTRAP_REFUSED = 2

/**
 * Run the doctor and return the process exit code.
 *
 * Exported so a test can drive it in-process and assert on the code and the
 * output without spawning a second Node, which the CPU discipline for this
 * machine forbids doing casually.
 */
export function runDoctor(argv: readonly string[]): { code: number, output: string } {
  const bootstrap = argv.includes('--bootstrap')
  const checkOnly = argv.includes('--check')
  const lines: string[] = []

  const home = resolveRuntimeDshHome()
  lines.push(`DSH home            : ${home}`)
  lines.push(`managed venv root   : ${managedVenvPython()}`)

  if (bootstrap) {
    const discovery = discoverSystemPython()
    lines.push('')
    lines.push(`candidates considered: ${discovery.length}`)
    for (const candidate of discovery) {
      lines.push(`  ${candidate.accepted ? 'ACCEPT' : 'reject'} ${candidate.path}  [${candidate.source}] ${candidate.reason}`)
    }
    const chosen = discovery.find(candidate => candidate.accepted)
    if (chosen === undefined) {
      lines.push('')
      lines.push('STATUS: NOT READY -- no compatible system CPython was found')
      lines.push('Install CPython ' + '3.10+ from python.org, or set DSH_PYTHON to an interpreter')
      lines.push('that already has IPython + ipykernel + jupyter_client + pyzmq.')
      return { code: EXIT_BOOTSTRAP_REFUSED, output: lines.join('\n') }
    }
    const result = bootstrapManagedVenv({ interpreter: chosen.path })
    lines.push('')
    lines.push(`bootstrap action    : ${result.action}`)
    lines.push(`venv root           : ${result.venvRoot}`)
    lines.push(`venv interpreter    : ${result.venvPython}`)
    for (const note of result.notes) lines.push(`note: ${note}`)
    for (const blocker of result.blockers) lines.push(`BLOCKER: ${blocker}`)
    lines.push('')
    lines.push(result.blockers.length === 0 ? 'STATUS: READY' : 'STATUS: NOT READY')
    const code = result.blockers.length === 0 ? EXIT_READY : EXIT_BOOTSTRAP_REFUSED
    return { code, output: lines.join('\n') }
  }

  const resolution = resolveKernelInterpreter({})
  lines.push('')
  lines.push(renderDoctorReport(resolution))
  const ready = resolution.interpreter !== undefined
  if (checkOnly && !ready) return { code: EXIT_NOT_READY, output: lines.join('\n') }
  return { code: ready ? EXIT_READY : EXIT_NOT_READY, output: lines.join('\n') }
}

/**
 * Whether this module was the process entry point.
 *
 * `process.argv[1]` is compared by resolved path rather than by string suffix,
 * because a suffix match would also fire for a file whose name merely ENDS with
 * this one's -- and a doctor that ran on import would make every consumer of
 * `runDoctor` also print a report.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === new URL(`file://${entry.replace(/\\/g, '/')}`).href
      || import.meta.url.endsWith(entry.replace(/\\/g, '/').replace(/^.*?(\/src\/|\/lib\/)/, '$1'))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const outcome = runDoctor(process.argv.slice(2))
  process.stdout.write(outcome.output + '\n')
  process.exitCode = outcome.code
}
