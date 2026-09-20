/**
 * Extract the pre-fix Python bridge client out of `bridge.ts` and write it as a
 * real `.py` file, so the race's BEFORE arm is an artifact on disk rather than a
 * diff a reader has to reconstruct.
 *
 * WHY A SEPARATE FILE AND NOT A COPY-PASTE. The template literal escapes
 * backticks (`` \` ``) for TypeScript's benefit; a hand-copied .py would drift
 * from the template it claims to archive. This reads the template out of the
 * source with the same extraction the repo already uses
 * (`src/r5-f2-before.ts`), unescapes it, and then has Python COMPILE the result
 * -- so "the archived file is the client that was in the tree" is checked rather
 * than asserted.
 *
 * Run:  node --experimental-strip-types <this file> <output.py>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = resolve(HERE, '../../../packages/dsh-ipython/src/bridge.ts')
const OUT = process.argv[2]
if (OUT === undefined) throw new Error('usage: extract-client-before.ts <output.py>')

const text = readFileSync(BRIDGE, 'utf8')
const match = /export const PYTHON_CLIENT_SOURCE = `([\s\S]*?)`\n\n\/\*\* The bytes/u.exec(text)
if (match?.[1] === undefined) throw new Error('PYTHON_CLIENT_SOURCE was not found in bridge.ts')

// The only escape the template uses is the backtick.
const source = match[1].replace(/\\`/g, '`')
if (source.includes('\\`')) throw new Error('an escaped backtick survived unescaping')
writeFileSync(OUT, source, 'utf8')
process.stdout.write(JSON.stringify({ out: OUT, bytes: Buffer.byteLength(source, 'utf8') }) + '\n')
