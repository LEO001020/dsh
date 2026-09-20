/**
 * S15 GATE — no NEW cross-tree checkout path may enter the source plane.
 *
 * WHAT THIS GATE EXISTS FOR
 *
 * This project has repeatedly been damaged by one defect, recorded five times: a
 * writer MEASURES THE MAIN TREE (or a sibling's) while believing it measures its
 * own worktree, and reports a verdict about a tree it does not own.
 *
 *   G-SEAM-29, G-SEAM-36   stale artifacts: a measurement about a tree the writer
 *                          did not own. BOTH findings were RETRACTED.
 *   G-SEAM-61              WRITE side: `u03-sustained-load.test.ts` deposited its
 *                          nondeterministic load measurement into the MAIN tree.
 *   G-SEAM-66              `dep-gates.test.ts` used a worktree-RELATIVE path that
 *                          rewrote a sibling slice's evidence INSIDE its own tree.
 *   G-SEAM-57              a provisioning check that grepped for a path and FAILED
 *                          on a correct tree.
 *
 * The root cause is always the same: a literal that names ONE checkout, in a
 * repository that is checked out in MANY places at once -- fifteen writer worktrees
 * plus the main tree, concurrently. No single literal can be correct for all of
 * them, so the correct form is to DERIVE the path from the running file:
 *
 *     resolve(import.meta.dirname, '..', '..', '..')        // from a test file
 *     fileURLToPath(new URL('../../..', import.meta.url))   // same, URL form
 *
 * WHY THIS IS NOT A BLANKET "NO ABSOLUTE PATH" GATE, AND WHY THAT MATTERS
 *
 * A blanket rule cannot be honest here. Four classes of absolute path are
 * legitimate, and each is excluded for a stated reason rather than by allowlisting
 * hits one at a time:
 *
 *   1. THE PINNED CHECKOUT `D:/DSH/src/dsh-src`. The read-only upstream this
 *      deployment is qualified against; its location is a machine-layout fact
 *      recorded in `compatibility.lock.json`. Naming it is required.
 *   2. RECORDED HISTORY `qualification/results/**`. An artifact that records which
 *      tree it was measured in is doing its job. Rewriting it to remove the path
 *      would destroy the provenance the artifact exists to carry.
 *   3. A FOREIGN WORKING DIRECTORY. `C:/Windows/Temp` is deliberately NOT the repo
 *      (several gates prove the preset root does not follow the process cwd), and
 *      an interpreter path like `.../Python314/python.exe` is a tool location.
 *      Neither can belong to another checkout.
 *   4. PROVISION-TIME VALUES, covered by their own arm below.
 *
 * So the gate refuses exactly ONE shape: a drive-letter path whose first two
 * segments are `DSH/work` -- that is, a path that names a DIRECTORY UNDER
 * `DSH/work`, which is the precise set of paths that can belong to another
 * checkout. Everything else is out of scope by construction, not by exemption.
 *
 * WHAT IT IS NOT. A static scan cannot prove a path is never reached at runtime.
 * What it CAN prove is that a NEW literal of a named shape has not entered a file
 * that runs, and that a named coupling has not silently drifted.
 *
 * THE MUTATION TEST IS THE POINT. A gate that never fires and a gate that is absent
 * produce identical evidence, so the last arm injects the exact defect shape and
 * requires the scan to go RED. It is applied IN MEMORY: a control arm that mutated
 * the tree would itself be the defect class this gate is about.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The repo root, resolved from THIS file rather than from cwd (the whole point). */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/**
 * The pinned read-only upstream checkout. LEGITIMATE to name: it is the artifact
 * this deployment is qualified against. `DSH_SRC_ROOT` overrides it.
 */
const PINNED_CHECKOUT = 'D:/DSH/src/dsh-src'

/**
 * A checkout literal: a drive-letter path whose first two segments are `DSH/work`.
 *
 * Deliberately narrower than "any absolute path", and the narrowing is the whole
 * design: it matches only paths that can belong to ANOTHER CHECKOUT, so the four
 * legitimate classes above are never matched rather than allowlisted away.
 */
const CHECKOUT_LITERAL = /[A-Za-z]:[\\/]{1,2}DSH[\\/]{1,2}work[\\/]{1,2}([A-Za-z0-9_.-]+)/gu

/**
 * The two shapes, distinguished because they are NOT equally bad and conflating
 * them would hide the worse one.
 *
 *   SIBLING_CHECKOUT  `D:/DSH/work/wt-<other>` names ANOTHER WRITER'S worktree.
 *                     Strictly worse than a main-tree reference: not even a stable
 *                     default, but one writer's ephemeral branch. In a patch row's
 *                     `name:` it is cross-tree CODE EXECUTION (see below).
 *   MAIN_CHECKOUT     `D:/DSH/work/dsh-native-daily` names the MAIN tree. A latent
 *                     hazard in a read, a LIVE bug in a write: a writer running from
 *                     a worktree overwrites the main tree's evidence, which is
 *                     G-SEAM-61 and G-SEAM-66.
 */
type OffenceKind = 'SIBLING_CHECKOUT' | 'MAIN_CHECKOUT'

interface Offence {
  readonly file: string
  readonly line: number
  readonly kind: OffenceKind
  readonly path: string
  readonly text: string
}

/**
 * Directories that are NOT the source plane, each for a stated reason.
 *
 *   node_modules, lib, .git   build/vendor state, not authored.
 *   results                   RECORDED HISTORY (see class 2 above).
 *   .probe                    a scratch plane of one-off measurement scripts. It is
 *                             not a deliverable and is not loaded by the product,
 *                             and several of its files are themselves records of a
 *                             past investigation.
 *   docs                      prose. `docs/GAPS.md` must be able to QUOTE a defect's
 *                             literal path in order to describe it, and the
 *                             exec-plans must be able to name the tree a round was
 *                             integrated in.
 */
const SKIPPED_DIRS = new Set(['node_modules', 'lib', '.git', '.vite-temp', '__pycache__', 'results', '.probe', 'docs'])

/** Extensions that can RUN or be LOADED. Prose and history are out of scope. */
const SCANNED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs', '.py', '.ps1', '.yml', '.yaml', '.json'])

/** Files that are themselves records of this investigation, not scanned subjects. */
const SELF_AND_FIXTURES = new Set([
  // This file. Its own negative-control arm carries the defect literal as a
  // FIXTURE, which is the only way the control can exist. Excluded by name so the
  // gate does not have to allowlist its own test data.
  'packages/dsh-daily-work/src/cross-tree-paths.test.ts',
])

/** Is this a DOCUMENTATION comment rather than executable text? */
function isCommentaryLine(line: string): boolean {
  const s = line.trimStart()
  return s.startsWith('*') || s.startsWith('//') || s.startsWith('#') || s.startsWith('/*')
}

/** Every file this gate scans, repo-relative and sorted. */
function scannedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        walk(full)
      } else if (entry.isFile()) {
        const rel = relative(REPO_ROOT, full).split(sep).join('/')
        if (SELF_AND_FIXTURES.has(rel)) continue
        const dot = entry.name.lastIndexOf('.')
        if (dot < 0) continue
        if (!SCANNED_EXTENSIONS.has(entry.name.slice(dot))) continue
        out.push(rel)
      }
    }
  }
  walk(REPO_ROOT)
  return out.sort()
}

/**
 * Find every checkout literal in `text`, separating LIVE code from commentary.
 *
 * The separation is not cosmetic. Several files carry a long comment that NAMES the
 * literal they were fixed from -- that is how a reader learns the defect was real
 * and what it was. Refusing those would delete the explanation, and a gate that
 * forces the explanation to be deleted is a gate that makes the codebase worse.
 */
function findOffences(rel: string, text: string): { offences: Offence[]; commentary: Offence[] } {
  const offences: Offence[] = []
  const commentary: Offence[] = []
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(CHECKOUT_LITERAL)) {
      const full = match[0]!
      const name = match[1]!
      // The pinned checkout is not under DSH/work, but guard anyway so a future
      // relocation into that tree does not silently become an offence.
      if (full.toLowerCase().startsWith(PINNED_CHECKOUT.toLowerCase())) continue
      const kind: OffenceKind = name.toLowerCase().startsWith('wt-') ? 'SIBLING_CHECKOUT' : 'MAIN_CHECKOUT'
      const record: Offence = { file: rel, line: index + 1, kind, path: full, text: line.trim().slice(0, 200) }
      if (isCommentaryLine(line)) commentary.push(record)
      else offences.push(record)
    }
  }
  return { offences, commentary }
}

/** Scan the whole source plane. Returns live offences and commentary separately. */
function scanSourcePlane(): { offences: Offence[]; commentary: Offence[] } {
  const offences: Offence[] = []
  const commentary: Offence[] = []
  for (const rel of scannedFiles()) {
    let text: string
    try {
      text = readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8')
    } catch {
      continue
    }
    const found = findOffences(rel, text)
    offences.push(...found.offences)
    commentary.push(...found.commentary)
  }
  return { offences, commentary }
}

/**
 * Files permitted to carry a live checkout literal, each with a reason.
 *
 * THE LIST IS SHORT ON PURPOSE, and it is short because the SCOPE is narrow rather
 * than because 900 hits were laundered into it. It holds only paths that genuinely
 * cannot derive their value, and every one is justified by WHY it cannot.
 */
const JUSTIFIED_LIVE_LITERALS: Readonly<Record<string, string>> = {
  // The PROVISIONER. `-Repo` defaults to the main tree because that is the tree a
  // new writer is provisioned FROM. The literal is the point of the file, and there
  // is no `import.meta` in PowerShell. The coupling that makes it safe is asserted
  // by its own arm below.
  'helpers/new-writer.ps1':
    'the provisioner itself: names the main tree as the default source for a new writer worktree',

  // The profile's `link:` targets name the MAIN tree as a DEFAULT that
  // `helpers/new-writer.ps1` rewrites into the writer's worktree at provision time.
  // It cannot be derived from `import.meta.url`: the file is CONSUMED BY PNPM, not
  // executed, so there is no `import.meta` to derive from. The drift risk is real
  // and is gated by the `PROVISIONER/PROFILE COUPLING` arm below.
  'profiles/daily-candidate/package.json':
    'pnpm-consumed link: default, rewritten at provision time by helpers/new-writer.ps1',

  // A synthetic fixture whose oracle is that an ABSOLUTE workspace root is accepted
  // in either spelling. The VALUE is arbitrary by construction -- nothing is read or
  // written through it -- and the case's own name says so.
  'packages/dsh-daily-work/src/no-sandbox-contract.test.ts':
    'synthetic absolute workspaceRoot fixture; the oracle is absoluteness, and the value is never dereferenced',

  // Generated by provisioning, not authored, and never committed. Listed so a stray
  // local copy does not fail the gate for a writer who ran the provisioner.
  '.writer-provision.json':
    'provisioning receipt written by helpers/new-writer.ps1; records the writer\'s own paths',
}

/**
 * Patch overlays that still name the MAIN tree in a `name:` row, each with the
 * reason it is NOT yet fixed. This is a RATCHET: the set may only SHRINK.
 *
 * WHY THEY ARE NOT FIXED HERE. Each of these is referenced by a driver in
 * `qualification/results/**`, which is the EVIDENCE PLANE: rewriting a caller there
 * would be editing recorded history, and the S15 slice explicitly must not do that.
 * Fixing them means changing those callers to materialise the overlay (the
 * `qualification/runners/overlay.mjs` pattern), which is a change to artifacts this
 * slice does not own.
 *
 * WHY THEY ARE STILL LISTED RATHER THAN IGNORED. A silent exemption would let the
 * set GROW. Recording it makes growth a test failure and shrinkage a required edit.
 */
const PATCH_OVERLAYS_AWAITING_OWNER: Readonly<Record<string, string>> = {
  'qualification/runners/verify-cmp-composition.patch.yml': 'referenced by qualification/results/V2-composition/run-boot4-composition.mjs and run-boot8-twin-preset.mjs (evidence plane)',
  'qualification/runners/verify-deliverable-surface.patch.yml': 'referenced by .probe/run-docform.mjs and qualification/results/V2-composition/* (scratch + evidence plane)',
  'qualification/runners/verify-ipython-e2e.patch.yml': 'referenced by qualification/results/R9-delivery/r9-surface-probe.mjs (evidence plane)',
  'qualification/runners/verify-t10-capacity.patch.yml': 'referenced by qualification/results/T10-capacity/run-prod-capacity.mjs and V8-capacity/run-v8-capacity-boot.mjs (evidence plane)',
  'qualification/runners/verify-t2-fs.patch.yml': 'referenced by qualification/results/V2-composition/run-boot2-fs.mjs (evidence plane)',
  'qualification/runners/verify-t3-shell.patch.yml': 'referenced by qualification/results/V2-composition/run-boot3-shell.mjs (evidence plane)',
  'qualification/runners/verify-t4-preset.patch.yml': 'referenced by qualification/results/T4-preset/run-verify.mjs (evidence plane)',
  'qualification/runners/verify-r4-authorization.patch.yml': 'names a SIBLING worktree; referenced by qualification/results/R4-authorization/run-r4-authorization.mjs (evidence plane)',
}

describe('S15: no NEW cross-tree checkout literal in the source plane', () => {
  it('the source plane carries no UNJUSTIFIED checkout literal', () => {
    const { offences } = scanSourcePlane()
    // Two recorded exemptions, each with its own arm above:
    //   JUSTIFIED_LIVE_LITERALS         a value that CANNOT be derived (the allowlist
    //                                   is short because the SCOPE is narrow).
    //   PATCH_OVERLAYS_AWAITING_OWNER   an overlay whose only caller is in the
    //                                   evidence plane, which this slice must not edit.
    // Everything else is an offence.
    const unjustified = offences.filter(o =>
      JUSTIFIED_LIVE_LITERALS[o.file] === undefined && PATCH_OVERLAYS_AWAITING_OWNER[o.file] === undefined)
    const rendered = unjustified
      .map(o => `  ${o.file}:${o.line}  [${o.kind}]  ${o.path}\n      ${o.text}`)
      .join('\n')
    expect(
      unjustified.length,
      `a checkout literal names ONE tree, and this repository is checked out in many.\n`
      + `Derive the path from the running file instead:\n`
      + `  resolve(import.meta.dirname, '..', '..', '..')        // from a test file\n`
      + `  fileURLToPath(new URL('../../..', import.meta.url))   // same, URL form\n`
      + `If the value genuinely cannot be derived, add the file to JUSTIFIED_LIVE_LITERALS with a reason.\n`
      + `If its only caller is in the evidence plane, add it to PATCH_OVERLAYS_AWAITING_OWNER instead.\n`
      + rendered,
    ).toBe(0)
  })

  it('every justified entry still exists and still carries its literal, so the allowlist cannot rot', () => {
    // An entry for a file that no longer contains the literal is dead weight that
    // would silently permit the literal to RETURN later. This arm makes each entry
    // falsifiable: it must currently be earning its place.
    for (const [rel, reason] of Object.entries(JUSTIFIED_LIVE_LITERALS)) {
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(20)
      const abs = join(REPO_ROOT, ...rel.split('/'))
      expect(existsSync(abs), `${rel} is allowlisted but does not exist`).toBe(true)
      const { offences } = findOffences(rel, readFileSync(abs, 'utf8'))
      expect(
        offences.length,
        `${rel} is allowlisted but carries no live checkout literal any more; remove the entry`,
      ).toBeGreaterThan(0)
    }
  })

  it('the two known-fixed files still DERIVE their root, and a third now does too', () => {
    // Round 1 fixed exactly two hardcoded literals. They are re-asserted by
    // MECHANISM rather than by absence, because "the literal is gone" is also
    // satisfied by deleting the feature: each file must still DERIVE a root AND
    // still use it.
    const cases: ReadonlyArray<readonly [string, RegExp, string]> = [
      // G-SEAM-61, write side: the artifact must land in the RUNNING tree.
      ['packages/dsh-daily-work/src/u03-sustained-load.test.ts', /new URL\('\.\.\/\.\.\/\.\.', import\.meta\.url\)/u, 'u03 artifact path'],
      // The read-side twin: the hashed profiles must be the RUNNING tree's.
      ['packages/dsh-daily-work/src/eco.test.ts', /new URL\('\.\.\/\.\.\/\.\.', import\.meta\.url\)/u, 'ECO-07 profile hash root'],
      // G-SEAM-66's real cause: this file computes a path relative to ITSELF and
      // then WRITES. It now derives the repo root, so its writes land in its own tree.
      ['packages/dsh-daily-work/src/dep-gates.test.ts', /resolve\(import\.meta\.dirname, '\.\.', '\.\.', '\.\.'\)/u, 'DEP evidence writes'],
    ]
    for (const [rel, derivation, what] of cases) {
      const text = readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8')
      expect(text, `${rel} must DERIVE its repo root (${what})`).toMatch(derivation)
      const { offences } = findOffences(rel, text)
      expect(offences, `${rel} must not name a checkout in live code (${what})`).toEqual([])
    }
  })

  it('no patch overlay names a SIBLING worktree in a live name: row', () => {
    // The `name:` of a cordis entry is a MODULE SPECIFIER. The loader converts an
    // absolute one into a `file://` URL and imports exactly that file
    // (`packages/boot/app-boot/src/index.ts:521`,
    // `vendor/loader/src/config/tree.ts:122-126`). So an overlay naming a sibling
    // makes a boot EXECUTE that sibling's module while measuring its own tree --
    // strictly worse than reading another tree, because the code RUNS.
    //
    // Sibling references are refused outright: unlike a main-tree default, a
    // sibling is not even a stable value, and there is no reading under which it is
    // the right target. The main-tree cases are the ratchet above.
    const offenders: Offence[] = []
    for (const rel of scannedFiles()) {
      if (!rel.startsWith('qualification/runners/') || !rel.endsWith('.yml')) continue
      if (PATCH_OVERLAYS_AWAITING_OWNER[rel] !== undefined) continue
      const { offences } = findOffences(rel, readFileSync(join(REPO_ROOT, ...rel.split('/')), 'utf8'))
      offenders.push(...offences.filter(o => o.kind === 'SIBLING_CHECKOUT'))
    }
    expect(
      offenders.length,
      `a patch row must not name a SIBLING worktree: the boot would EXECUTE that tree's module.\n`
      + `Use a package specifier, or materialise the overlay with the running tree's own path\n`
      + `(see qualification/runners/overlay.mjs).\n`
      + offenders.map(o => `  ${o.file}:${o.line}  ${o.path}`).join('\n'),
    ).toBe(0)
  })

  it('RATCHET: the overlays awaiting an owner may only SHRINK', () => {
    // This is what stops the recorded set from becoming a silent dumping ground.
    // A file listed here must (a) still exist, (b) still actually contain a live
    // checkout literal -- so a FIXED file must be removed from the map -- and
    // (c) carry its reason. A new offender cannot join without an explicit edit.
    for (const [rel, reason] of Object.entries(PATCH_OVERLAYS_AWAITING_OWNER)) {
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(20)
      const abs = join(REPO_ROOT, ...rel.split('/'))
      expect(existsSync(abs), `${rel} is recorded as awaiting an owner but does not exist`).toBe(true)
      const { offences } = findOffences(rel, readFileSync(abs, 'utf8'))
      expect(
        offences.length,
        `${rel} no longer carries a live checkout literal; remove it from PATCH_OVERLAYS_AWAITING_OWNER`,
      ).toBeGreaterThan(0)
    }
  })

  it('PROVISIONER/PROFILE COUPLING: the rewrite target and the committed literal agree', () => {
    // THE FRAGILITY THIS ARM EXISTS FOR. `helpers/new-writer.ps1` redirects the
    // installed profile away from the main tree with a LITERAL string replace:
    //
    //     $text = $text -replace [regex]::Escape('D:/DSH/work/dsh-native-daily'), $wt
    //
    // If the committed value in `profiles/daily-candidate/package.json` ever changes
    // -- a drive letter, a slash direction, a different default tree -- the replace
    // matches NOTHING and provisioning SILENTLY STOPS REDIRECTING. Every writer then
    // boots the main checkout while believing it booted its own worktree, which is
    // this entire defect class reproduced by a one-character edit, with no error.
    //
    // The coupling is checked here rather than repaired because the repair belongs to
    // the provisioner's own slice. What this arm guarantees is that the two literals
    // cannot drift apart unnoticed.
    const provisioner = readFileSync(join(REPO_ROOT, 'helpers', 'new-writer.ps1'), 'utf8')
    const replace = /-replace \[regex\]::Escape\('([^']+)'\)/u.exec(provisioner)
    expect(replace, 'helpers/new-writer.ps1 must contain the profile rewrite').not.toBeNull()
    const target = replace![1]!

    const profile = readFileSync(join(REPO_ROOT, 'profiles', 'daily-candidate', 'package.json'), 'utf8')
    expect(
      profile.includes(target),
      `the provisioner rewrites the literal ${JSON.stringify(target)} but `
      + `profiles/daily-candidate/package.json does not contain it.\n`
      + `That makes the rewrite a SILENT NO-OP: every writer would boot the MAIN tree while `
      + `believing it booted its own worktree. Fix whichever side moved.`,
    ).toBe(true)
  })

  it('NEGATIVE CONTROL: the gate goes RED when a checkout literal is injected', () => {
    // MUTATION TEST. The injected text is the exact shape the gate exists to catch,
    // and it is applied IN MEMORY: a control arm that mutated the tree on disk would
    // itself be the defect class this gate is about.
    const derived = `const REPO = fileURLToPath(new URL('../../..', import.meta.url))\n`
    const sibling = `const REPO = 'D:/DSH/work/wt-s99/qualification/results'\n`
    const main = `const OUT = 'D:/DSH/work/dsh-native-daily/qualification/results/x.json'\n`
    const backslash = `const OUT = 'D:\\\\DSH\\\\work\\\\dsh-native-daily\\\\x.json'\n`

    // The control: a DERIVED path must produce NO offence, or the gate would be
    // firing on the fix itself and would be impossible to satisfy.
    expect(findOffences('control.ts', derived).offences).toEqual([])

    const sib = findOffences('control.ts', sibling).offences
    expect(sib, 'an injected sibling literal must be caught').toHaveLength(1)
    expect(sib[0]!.kind).toBe('SIBLING_CHECKOUT')

    const mn = findOffences('control.ts', main).offences
    expect(mn, 'an injected main-tree literal must be caught').toHaveLength(1)
    expect(mn[0]!.kind).toBe('MAIN_CHECKOUT')

    // The BACKSLASH spelling must be caught too: a gate that only saw forward
    // slashes would be trivially evaded by the other Windows spelling.
    expect(findOffences('control.ts', backslash).offences, 'the backslash spelling must be caught').toHaveLength(1)

    // A COMMENT that names the literal is commentary, not an offence: the
    // explanation of a fixed defect must remain writable.
    const asComment = findOffences('control.ts', `// it used to be ${main.trim()}\n`)
    expect(asComment.offences).toEqual([])
    expect(asComment.commentary).toHaveLength(1)

    // The four legitimate classes must NOT be offences, or the gate would be
    // unsatisfiable by a correct tree. This is the arm that proves the scope is
    // honest rather than merely narrow.
    for (const [label, line] of [
      ['pinned checkout', `const L = '${PINNED_CHECKOUT}/apps/cli/lib/bin.js'\n`],
      ['foreign cwd', `cwd: 'C:/Windows/Temp',\n`],
      ['interpreter', `const P = 'C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe'\n`],
      ['drive root', `const R = 'C:/'\n`],
      ['dsh home', `const H = 'D:/DSH/home/t3-shell'\n`],
    ] as ReadonlyArray<readonly [string, string]>) {
      expect(findOffences('control.ts', line).offences, `${label} must NOT be an offence`).toEqual([])
    }
  })
})
