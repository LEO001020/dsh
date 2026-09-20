/**
 * V3's IPY-09 boot driver: ONE boot, through the shared port-safe harness.
 *
 * WHY A DRIVER AND NOT A DIRECT BOOT. `boot-harness.mjs` picks a genuinely free
 * port by BINDING it, kills the host afterwards, and VERIFIES the port was
 * released. A second agent booting on a guessed port produces EADDRINUSE ->
 * "2 required plugins did not activate" -> a boot that LOOKS like a composition
 * failure but is only a port conflict. That has already cost this project an
 * investigation, so every boot goes through the harness.
 *
 * `readResult` is called because a probe that writes to a fixed path is a SHARED
 * MUTABLE RESOURCE: without the assertion that the result names THIS home, a
 * caller can read another agent's file and report it as its own. That produced a
 * false PASS earlier in this project (G-FIX-13).
 */
import { bootAndWait, readResult, sleep } from './boot-harness.mjs'
import { materialiseOverlay } from './overlay.mjs'

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** The repository root of the tree THIS FILE was loaded from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

const HOME = 'D:/DSH/home/v3-ipython'
const OUT = join(REPO_ROOT, 'qualification/results/V3-ipython/IPY-09-tool-surface.json')
const PROFILE = 'daily'
// The overlay is MATERIALISED here with this tree's own probe path. The committed
// file is a TEMPLATE: a cordis `name:` is a MODULE SPECIFIER, and an absolute one is
// imported as-is, so a committed literal would make any other checkout's boot execute
// THIS probe while measuring its own composition. See `overlay.mjs`.
const PATCH = materialiseOverlay(
  join(REPO_ROOT, 'qualification/runners/v3-ipython-surface.patch.yml'),
  join(REPO_ROOT, 'qualification/results/V3-ipython/v3-ipython-surface.materialised.patch.yml'),
  join(REPO_ROOT, 'qualification/runners/v3-ipython-surface.mjs'),
)

const boot = await bootAndWait({
  home: HOME,
  profile: PROFILE,
  patches: [PATCH],
  outPath: OUT,
  cwd: REPO_ROOT,
  timeoutMs: 180_000,
})

// A partial write is possible if the harness sampled mid-write; give it a moment.
await sleep(500)

let result
let resultError = null
try {
  const read = readResult(OUT, HOME, 'presetRoots')
  result = read.json
} catch (error) {
  resultError = error instanceof Error ? error.message : String(error)
}

const summary = {
  scope: 'V3 IPY-09 boot driver',
  home: HOME,
  profile: PROFILE,
  patch: PATCH,
  outPath: OUT,
  port: boot.port,
  portReleased: boot.portReleased,
  hostExitCode: boot.exitCode,
  timedOut: boot.timedOut,
  resultRead: result !== undefined,
  resultError,
  result,
  // Kept because a boot that fails to compose reports it here, and that is a
  // different finding from a probe that ran and reported a surface.
  stderrTail: boot.stderr.slice(-4000),
  stdoutTail: boot.stdout.slice(-2000),
}

process.stdout.write('V3-IPY-BOOT: ' + JSON.stringify({
  port: summary.port,
  portReleased: summary.portReleased,
  hostExitCode: summary.hostExitCode,
  timedOut: summary.timedOut,
  resultRead: summary.resultRead,
  resultError: summary.resultError,
  ipythonToolPresent: result?.ipythonToolPresent ?? null,
  ipythonParameterNames: result?.ipythonParameterNames ?? null,
  toolCountAgentKey: result?.toolCountAgentKey ?? null,
  forbiddenLifecycleTools: result?.forbiddenLifecycleTools ?? null,
  pythonExecAliasPresent: result?.pythonExecAliasPresent ?? null,
}) + '\n')

if (result === undefined) {
  process.stderr.write('the probe produced no readable result; stderr tail follows\n')
  process.stderr.write(summary.stderrTail + '\n')
  process.exitCode = 1
}
