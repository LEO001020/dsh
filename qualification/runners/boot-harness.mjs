/**
 * A shared, port-safe boot harness for the trusted-local verification agents.
 *
 * WHY THIS EXISTS. Several agents need to boot a real DSH host and inspect the
 * resolved graph. If each one picks "the default port" they collide: port 3080
 * was held by a stray probe twice today, and a collision produces
 * `EADDRINUSE` -> `2 required plugins did not activate` -> a boot that LOOKS
 * like a composition failure but is only a port conflict. That has already
 * caused one wasted investigation.
 *
 * WHAT IT DOES.
 *   1. Picks a free port by BINDING it, then releasing it. Not by guessing.
 *   2. Builds the boot argv with that port, `--no-open`, and the caller's
 *      patches in order.
 *   3. Runs the host as a CHILD process, waits for the probe to write its
 *      result, then kills the host and VERIFIES the port is released.
 *
 * WHAT IT DOES NOT DO. It does not interpret the result. Every caller must
 * read its own output and decide. A shared helper that also judged would be a
 * second oracle, which is the defect class this project keeps recording.
 *
 * THE FIXED-OUTPUT-PATH TRAP. A probe that writes to a fixed path is a SHARED
 * MUTABLE RESOURCE: two agents running it cannot tell whose result they hold.
 * That produced a false PASS earlier in this project. So every caller MUST
 * pass its own `outPath` and then call `readResult()` which asserts the result
 * names the home the caller booted.
 */
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export const DSH_SRC = 'D:/DSH/src/dsh-src'
export const LAUNCHER = `${DSH_SRC}/apps/cli/lib/bin.js`

/** Bind port 0 to get a genuinely free port, then release it. */
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** A patch that sets the webserver port WITHOUT dropping the row's other keys.
 *
 * TRAP: a `cordis.patch.yml` entry REPLACES the target row's whole `config`
 * object; it is not a deep merge. The shipped `webserver` row carries
 * `host`, `port`, `compression` and `compressionLevel`. Overriding only `port`
 * drops `host` and the loader fails with `$.host missing required value`.
 * So every key is restated here.
 */
export function portPatch(port, path) {
  const body = [
    '- id: webserver',
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    `    port: ${String(port)}`,
    '    compression: gzip',
    '    compressionLevel: 1',
    '',
  ].join('\n')
  writeFileSync(path, body, 'utf8')
  return path
}

/**
 * Boot a real DSH host and wait for the probe to write `outPath`.
 *
 * @returns {{ port:number, exitCode:number|null, stdout:string, stderr:string, timedOut:boolean }}
 */
export async function bootAndWait(options) {
  const {
    home, profile, patches = [], outPath, cwd = process.cwd(),
    timeoutMs = 90_000, settleMs = 900, port,
  } = options

  const chosen = port ?? await freePort()
  const portFile = `${outPath}.port.yml`
  portPatch(chosen, portFile)

  if (existsSync(outPath)) rmSync(outPath)

  const argv = [
    LAUNCHER, '--profile', profile,
    ...patches.flatMap(p => ['--patch', p]),
    '--patch', portFile,
    '--no-open',
  ]

  const child = spawn(process.execPath, argv, {
    cwd,
    // DSH_PROBE_OUT lets a probe that supports it write to THIS caller's file
    // rather than a fixed shared path. Probes that ignore it still work; the
    // caller just has to point outPath at wherever that probe writes.
    env: { ...process.env, DSH_HOME: home, DSH_PROBE_OUT: outPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout += String(d) })
  child.stderr.on('data', d => { stderr += String(d) })

  const deadline = Date.now() + timeoutMs
  let timedOut = false
  while (!existsSync(outPath)) {
    if (Date.now() > deadline) { timedOut = true; break }
    if (child.exitCode !== null) {
      // The host exited before the probe wrote. Give the filesystem a moment,
      // then stop: the exit code plus stderr is the finding.
      await sleep(settleMs)
      break
    }
    await sleep(200)
  }
  // A probe writes its JSON in one call, but a partial read is possible if we
  // sample mid-write. Let the write settle before killing.
  if (!timedOut && existsSync(outPath)) await sleep(settleMs)

  child.kill('SIGKILL')
  await sleep(500)

  const released = await isPortFree(chosen)
  return { port: chosen, exitCode: child.exitCode, stdout, stderr, timedOut, portReleased: released }
}

export async function isPortFree(port) {
  return await new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/**
 * Read a probe result and ASSERT it describes the home that was booted.
 *
 * This is the guard against the fixed-output-path trap: without it, a caller
 * can read another agent's result and report it as its own.
 */
export function readResult(outPath, expectedHome, label = 'presetRoots') {
  const raw = readFileSync(outPath, 'utf8')
  const json = JSON.parse(raw)
  const roots = (json.presetRoots ?? []).map(r => String(r.path ?? r))
  const joined = roots.join('|')
  // Normalise separators and case: Windows paths arrive both ways.
  const norm = s => s.replace(/\\/g, '/').toLowerCase()
  if (!norm(joined).includes(norm(expectedHome))) {
    throw new Error(
      `${outPath} does not describe the home this caller booted.\n`
      + `  expected home: ${expectedHome}\n`
      + `  roots observed: ${joined}\n`
      + 'A probe writing to a fixed path is a SHARED MUTABLE RESOURCE. Another agent '
      + 'may have overwritten it. Do not report this result as yours.',
    )
  }
  return { json, roots }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
