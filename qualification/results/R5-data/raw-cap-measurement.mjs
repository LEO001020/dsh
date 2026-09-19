/**
 * R5-data probe: what does the REAL grep raw-cap path do when the cap is hit?
 *
 * DAT-07's second test builds a `partial` descriptor BY HAND and asserts that
 * `projectForModel` echoes `partial` back. That is a tautology unless the real
 * product also produces `partial`. This probe drives the real `runRipgrep` with
 * a cap small enough to be exceeded, so the question is answered by measurement
 * rather than by reading `completeStdout` alone.
 *
 * Run from packages/dsh-daily-work:
 *   node --import tsx/esm D:/.../R5-data/raw-cap-measurement.mjs
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolve modules from the PACKAGE directory, not from this file's directory.
 *
 * This probe lives outside the package tree, so a bare `@deepseek-ai/...`
 * specifier would resolve from here and find nothing. Anchoring a `require` at
 * the package root makes every specifier resolve exactly as the package's own
 * code resolves it -- the same module instances the product loads.
 */
const PKG = 'D:/DSH/work/dsh-native-daily/packages/dsh-daily-work'
const requireFromPkg = createRequire(`${PKG}/package.json`)
const resolveFromPkg = spec => pathToFileURL(requireFromPkg.resolve(spec)).href

const { Context } = await import(resolveFromPkg('@deepseek-ai/cordis'))
const { default: Subprocess } = await import(resolveFromPkg('@deepseek-ai/dsh-subprocess-local'))
const searchCore = await import(resolveFromPkg('@deepseek-ai/dsh-tool-fs-search/src/search-core.ts'))
const grep = await import(resolveFromPkg('@deepseek-ai/dsh-tool-fs-search/src/grep.ts'))

const root = mkdtempSync(join(tmpdir(), 'r5-rawcap-'))
const out = { root }

try {
  // 900 matching lines, the same stimulus DAT-07 uses.
  const lines = Array.from({ length: 900 }, (_, index) => `needle-${index}-${'x'.repeat(20)}`)
  const file = join(root, 'many.txt')
  writeFileSync(file, `${lines.join('\n')}\n`)

  const rg = await searchCore.resolveRgPath()
  out.rgPath = rg
  out.rawCapConstant = searchCore.RAW_OUTPUT_MAX_BYTES

  const ctx = new Context()
  await ctx.plugin(Subprocess)

  // A minimal ToolExecution: `runRipgrep` reads `signal`, and `agent?.session.header.cwd`.
  const exec = { signal: new AbortController().signal, agent: undefined }

  // --- the generous cap: the same call DAT-07 makes, through the REAL runner ---
  const generous = await searchCore.runRipgrep(
    ctx, exec, 'grep', ['--json', '--no-config', 'needle', file],
    searchCore.RAW_OUTPUT_MAX_BYTES, 5000, 64 * 1024,
  )
  out.generousCap = {
    rawBytes: Buffer.byteLength(generous.stdout, 'utf8'),
    noMatches: generous.noMatches,
    parsedMatches: grep.parseGrepMatches(generous.stdout).length,
  }

  // --- the tiny cap: the real raw-cap overflow ---
  const tinyCap = 4096
  try {
    const overflow = await searchCore.runRipgrep(
      ctx, exec, 'grep', ['--json', '--no-config', 'needle', file],
      tinyCap, 5000, 64 * 1024,
    )
    out.tinyCap = {
      threw: false,
      rawBytes: Buffer.byteLength(overflow.stdout, 'utf8'),
      parsedMatches: grep.parseGrepMatches(overflow.stdout).length,
      note: 'no error: the real path returned a short result',
    }
  } catch (error) {
    out.tinyCap = {
      threw: true,
      name: error?.name ?? null,
      code: error?.code ?? null,
      message: String(error?.message ?? error).slice(0, 300),
    }
  }

  // --- what the real renderer does at 900 matches (the DAT-07 layering claim) ---
  const canonical = grep.parseGrepMatches(generous.stdout)
  const retained = searchCore.retainGrepMatches(canonical, grep.GREP_MAX_MATCHES, grep.GREP_MAX_LINE_BYTES)
  out.renderer = {
    maxMatches: grep.GREP_MAX_MATCHES,
    seen: retained.seen,
    kept: retained.kept,
    truncated: retained.truncated,
    canonicalCount: canonical.length,
    renderedLines: grep.formatGrepOutput(retained, undefined).split('\n')
      .filter(line => line.includes('needle-')).length,
  }

  await ctx.fiber.dispose()
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
