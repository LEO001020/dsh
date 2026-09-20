/**
 * Materialise a cordis patch overlay into the RUNNING tree.
 *
 * THE PROBLEM THIS SOLVES, stated exactly.
 *
 * A cordis entry's `name:` is a MODULE SPECIFIER, and an ABSOLUTE one is turned
 * into a `file://` URL and imported as-is:
 *
 *   packages/boot/app-boot/src/index.ts:521
 *     const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
 *   vendor/loader/src/config/tree.ts:122-126
 *     this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
 *     ... else new URL(name, this.ctx.baseUrl).href
 *
 * So a committed overlay whose probe row reads
 * `D:/DSH/work/dsh-native-daily/qualification/runners/verify-t3-shell.mjs` makes a
 * boot from ANY other checkout execute the MAIN tree's probe while the caller
 * believes it is measuring its own composition. That is CROSS-TREE CODE EXECUTION
 * -- strictly worse than the cross-tree READ that produced the two retracted
 * findings (G-SEAM-29, G-SEAM-36) and the same class as G-SEAM-61/G-SEAM-66.
 *
 * A RELATIVE `name:` IS NOT A SUBSTITUTE, and this is the part that is easy to get
 * wrong: the loader resolves a relative specifier against `ctx.baseUrl`, which is
 * the PROFILE DIRECTORY (`packages/boot/app-boot/src/index.ts:939`), not the patch
 * file and not the repository. `./verify-t3-shell.mjs` would therefore resolve
 * under `$DSH_HOME/profiles/daily/`, where no such file exists.
 *
 * SO THE OVERLAY MUST BE WRITTEN AT RUN TIME, into the caller's own tree, with the
 * probe row naming the caller's own file. That is what this module does.
 *
 * WHY A SHARED MODULE RATHER THAN A COPY PER DRIVER. Every driver that needs this
 * has the same three inputs (the committed template, an output path in its own
 * tree, the probe file it must name) and the same failure mode if one of them is
 * wrong. A per-driver copy is a per-driver opportunity to get the rewrite subtly
 * wrong, and the failure is SILENT: the boot succeeds and measures the wrong tree.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Rewrite one patch overlay so its probe row names `probePath`, and write the
 * result to `destPath`.
 *
 * @param templatePath - the committed overlay, which carries a placeholder.
 * @param destPath - where to write the materialised overlay; must be in the
 *   caller's own tree (the caller derives it, which is the point).
 * @param probePath - the absolute path of the probe THIS caller must load.
 * @returns destPath, so a caller can inline the call in its `patches:` array.
 * @throws when the template has no row naming `probeBasename`, because a silent
 *   no-op would leave the placeholder in place and boot a non-existent module --
 *   a failure that LOOKS like a composition error rather than a path error.
 */
export function materialiseOverlay(templatePath, destPath, probePath) {
  const probeBasename = probePath.replace(/\\/g, '/').split('/').pop()
  if (probeBasename === undefined || probeBasename === '') {
    throw new Error(`materialiseOverlay: probePath names no file: ${probePath}`)
  }
  const text = readFileSync(templatePath, 'utf8')
  // Match the `name:` of the row that ends in this probe's basename. Quoted form
  // only: an unquoted absolute path is not valid YAML on a Windows drive letter
  // (`C:/x` is fine, but the project's rows are quoted by convention), so requiring
  // the quote keeps this from half-matching a comment.
  const row = new RegExp(`^(\\s*name:\\s*)'[^']*${probeBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'mu')
  const own = resolve(probePath).replace(/\\/g, '/')
  const rewritten = text.replace(row, `$1'${own}'`)
  if (rewritten === text) {
    throw new Error(
      `materialiseOverlay: ${templatePath} has no quoted name: row ending in ${probeBasename}, `
      + 'so the overlay cannot be pointed at this tree\'s probe. Refusing rather than booting a '
      + 'placeholder path, which would surface as a composition failure instead of a path error.',
    )
  }
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, rewritten, 'utf8')
  return destPath
}
