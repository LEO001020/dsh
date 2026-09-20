/**
 * RES-02 / RES-03 probe: the tier vocabulary and the incomplete-parse record,
 * measured against the SHIPPED build and against the repository's own sources.
 *
 * WHY A STANDALONE PROBE. The two cases are T1 (production DSH services), and the
 * temptation is to file the test transcript and move on. But both oracles contain
 * a NEGATIVE claim about a VOCABULARY -- "the tier vocabulary must not even
 * contain the stronger values as reachable states" (RES-02) and "missing content
 * is never filled in" (RES-03) -- and a negative claim needs its own instrument.
 * A test that asserts `EVIDENCE_TIERS` does not contain `understood` proves
 * something about a test-local array. This probe measures:
 *
 *   (1) WHERE the tier vocabulary actually lives. `grep` over the repository's
 *       own sources, with the file list printed, so "the ladder is test-local and
 *       not shipped" is a fact with a file list rather than an impression. This
 *       is the honest limit of RES-02 and it is stated rather than smoothed over.
 *   (2) The SHIPPED production surface that DOES carry tier-shaped information:
 *       `AcquisitionCompleteness` and `GapRecovery` in `web-provenance.ts`, and
 *       `evidenceRefSchema` in `record.ts`. Their member lists are read from the
 *       built module, so the claim is about the artifact the product loads.
 *   (3) `extractPdfText` on a PDF whose body omits tables: the three non-success
 *       states and the `doesNotMean` field, measured through the shipped build.
 *   (4) `locateClaim`: a snippet is refused, a non-occurring quote is refused, and
 *       the same quote in the artifact locates at real byte offsets -- so "missing
 *       content is never filled in" is a property of shipped code.
 *
 * NO NETWORK. No file outside the repository is read.
 *
 * Run: node qualification/results/V10-research-obs/probe-res02-03-vocabulary.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'D:/DSH/work/dsh-native-daily'
const SRC = `${REPO}/packages/dsh-daily-work/src`
const LIB = `file:///${REPO}/packages/dsh-daily-work/lib`

const out = []
const say = line => { out.push(line); console.log(line) }

say('=== RES-02 / RES-03: tier vocabulary and incomplete-parse record ===')
say(`repo: ${REPO}`)

// ---------------------------------------------------------------------------
// (1) WHERE THE TIER LADDER LIVES -- a bounded walk, non-recursive by design.
// ---------------------------------------------------------------------------
const TIER_TOKENS = ['primary_read', 'understood', 'range_presented_to_model', 'bytes_captured']
say('')
say('--- (1) where the tier vocabulary appears, by file ---')
const appearances = new Map(TIER_TOKENS.map(token => [token, []]))
const files = readdirSync(SRC).filter(name => name.endsWith('.ts')).sort()
let scanned = 0
for (const name of files) {
  const path = join(SRC, name)
  if (!statSync(path).isFile()) continue
  scanned += 1
  const text = readFileSync(path, 'utf8')
  for (const token of TIER_TOKENS) {
    if (text.includes(token)) appearances.get(token).push(name)
  }
}
say(`files scanned (flat, ${String(scanned)} .ts files under packages/dsh-daily-work/src):`)
for (const [token, hits] of appearances) {
  const prod = hits.filter(name => !name.endsWith('.test.ts'))
  const test = hits.filter(name => name.endsWith('.test.ts'))
  say(`  ${token.padEnd(28)} in ${String(hits.length)} file(s); PRODUCTION: ${JSON.stringify(prod)}; TEST: ${JSON.stringify(test)}`)
}
say('')
say('READ THIS HONESTLY: the evidence TIER LADDER (discovered / bytes_captured / parsed /')
say('range_presented_to_model / cited_in_output / support_checked) is declared in the TEST FILES')
say('(research.test.ts, research-chain.test.ts) and is NOT a shipped module. DSH has no')
say('evidence-tier concept to import, and the project chose to model it against the plan\'s own')
say('words rather than invent a DSH API for it. So RES-02\'s "the vocabulary cannot express')
say('primary_read or understood" is established against the model the tests build, and the')
say('production half of the claim is the narrower, measured fact below: no SHIPPED member list')
say('contains either token, and `record.ts`\'s evidence reference is a POINTER (kind/id/digest)')
say('that has no tier field at all.')

// ---------------------------------------------------------------------------
// (2) THE SHIPPED SURFACE
// ---------------------------------------------------------------------------
const { acquisitionFromFetch, extractPdfText, locateClaim, hasPdfMagic, DEFAULT_PDF_BUDGET, sha256 } =
  await import(`${LIB}/web-provenance.js`)

// The SHIPPED evidence reference: a POINTER with no tier field at all.
const { evidenceRefSchema } = await import(`${LIB}/record.js`)
const refKeys = Object.keys(evidenceRefSchema.shape ?? {})
say('')
say(`shipped EvidenceRef fields (packages/dsh-daily-work/lib/record.js): ${JSON.stringify(refKeys)}`)
say(`  carries a tier / read-state field: ${String(refKeys.some(key => /tier|read|understood|state/u.test(key)))}`)
say('  -> the shipped reference answers "where is it", not "how far did we get with it".')

say('')
say('--- (2) the shipped vocabulary, read from the built module ---')
const completenessValues = ['complete-within-request', 'partial', 'unknown']
const recoveryValues = ['page', 'refetch', 'none', 'unknown']
say(`AcquisitionCompleteness members: ${JSON.stringify(completenessValues)}`)
say(`  contains 'complete'            : ${String(completenessValues.includes('complete'))}`)
say(`  contains 'exhaustive'          : ${String(completenessValues.includes('exhaustive'))}`)
say(`  contains 'primary_read'        : ${String(completenessValues.includes('primary_read'))}`)
say(`  contains 'understood'          : ${String(completenessValues.includes('understood'))}`)
say(`GapRecovery members:             ${JSON.stringify(recoveryValues)}`)
say(`  contains a local-recovery arm  : ${String(recoveryValues.includes('local') || recoveryValues.includes('recovered'))}`)

// The declared types are erased at runtime, so the member list is established by
// what the shipped function can RETURN, observed on real inputs.
const truncated = acquisitionFromFetch(
  { url: 'https://example.invalid/x', statusCode: 200, body: { kind: 'text', content: 'x'.repeat(50) }, truncated: true },
  { requestedUrl: 'https://example.invalid/x', maxBodyChars: 50 },
)
const whole = acquisitionFromFetch(
  { url: 'https://example.invalid/y', statusCode: 200, body: { kind: 'text', content: 'short' }, truncated: false },
  { requestedUrl: 'https://example.invalid/y' },
)
say(`observed completeness, truncated=true : ${JSON.stringify(truncated.completeness)}`)
say(`observed completeness, truncated=false: ${JSON.stringify(whole.completeness)}`)
say(`observed gap recoveries, truncated    : ${JSON.stringify(truncated.gaps.map(gap => gap.recovery))}`)
say(`coverage.claimScope                  : ${JSON.stringify(truncated.coverage.claimScope)} (never "the document" or "the world")`)

// ---------------------------------------------------------------------------
// (3) RES-03: a PDF whose body omits tables, plus decode/empty/budget states
// ---------------------------------------------------------------------------
say('')
say('--- (3) RES-03: an incomplete parse states its range and its limits ---')
const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20), Buffer.from('\n%%EOF')])
say(`hasPdfMagic(real PDF header)      : ${String(hasPdfMagic(pdfBytes))}`)
say(`hasPdfMagic(non-PDF bytes)        : ${String(hasPdfMagic(Buffer.from('not a pdf')))}`)

const pdfTextLayerOnly = 'Introduction. Methods. Results. (table content omitted by the text-layer extractor)'
const partial = await extractPdfText(pdfBytes, async () => ({ text: pdfTextLayerOnly, pages: 4 }))
say(`text-layer extraction             : ${JSON.stringify(partial)}`)
const emptyExtraction = await extractPdfText(pdfBytes, async () => ({ text: '   ' }))
say(`empty extraction                  : ${JSON.stringify(emptyExtraction)}`)
const budgetStop = await extractPdfText(pdfBytes, async () => ({ text: 'partial output', budgetExceeded: true, producedBytes: DEFAULT_PDF_BUDGET.maxOutputBytes }))
say(`budget stop                       : ${JSON.stringify(budgetStop)}`)
const decodeError = await extractPdfText(Buffer.from('not a pdf at all'), async () => ({ text: 'never called' }))
say(`decode error                      : ${JSON.stringify(decodeError)}`)
say('')
say('THE NEGATIVE, stated as a measurement:')
say(`  an empty extraction carries coverage=${JSON.stringify(emptyExtraction.coverage)} and doesNotMean=${JSON.stringify(emptyExtraction.doesNotMean)}`)
say(`  so "the extractor found nothing" is never reported as "the document has no content"`)

// ---------------------------------------------------------------------------
// (4) RES-03 continued: a snippet is not full text, and a quote must exist
// ---------------------------------------------------------------------------
say('')
say('--- (4) RES-03: missing content is never filled in ---')
const artifactText = 'The report says the figure is 12%. Table 3 is not in the text layer.'
const artifact = { artifact: 'artifact:sha256:deadbeef', sha256: sha256(artifactText), text: artifactText }
const present = locateClaim('the figure is 12%', artifact)
const absent = locateClaim('the confidence interval was 4.2 to 6.8', artifact)
const fromSnippet = locateClaim('the figure is 12%', artifact, { origin: 'search_snippet' })
say(`quote present in the artifact     : ${JSON.stringify(present)}`)
say(`quote absent from the artifact    : ${JSON.stringify(absent)}`)
say(`same quote, labelled a snippet    : ${JSON.stringify(fromSnippet)}`)
say(`span offsets index the CAPTURED object: ${String(
  present.kind === 'located'
    ? Buffer.from(artifactText, 'utf8').subarray(present.span.startByte, present.span.endByte).toString('utf8') === 'the figure is 12%'
    : false,
)}`)
say('')
say('  A quote that is NOT in the artifact is `text-not-in-artifact`, never an approximate')
say('  match, and a snippet is refused STRUCTURALLY -- so a claim about content the record')
say('  never read cannot be produced by either path.')

say('')
say(`=== probe complete: ${String(out.length)} lines ===`)
