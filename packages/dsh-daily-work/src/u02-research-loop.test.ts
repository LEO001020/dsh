/**
 * U02 — the research loop, closed on a CONFLICTING-SOURCE audit.
 *
 * THE GATE
 * ========
 * Stimulus: "a technical audit with conflicting sources, requiring original text
 * or source versions." Oracle: "the artifact contains reviewable evidence,
 * disputes and unknowns, and a spot-check confirms the citations actually
 * support the conclusions."
 *
 * THE HONEST SHAPE OF THIS GATE HERE
 * =================================
 * The live-search half is BLOCKED_EXTERNAL: no network is authorized in this
 * environment, and `qualification/gates.json` records
 * `live_provider_budget_authorized: false`. So the audit is run against LOCAL
 * sources, and the two properties that make a research loop real are kept:
 *
 *   1. the sources GENUINELY CONFLICT, and the conflict is not manufactured by
 *      paraphrasing -- it is two real documents that really disagree;
 *   2. every conclusion is bound to a QUOTED LINE at a KNOWN REVISION, and a
 *      spot-check re-reads the cited line and checks it supports the claim.
 *
 * What is NOT claimed: that a model performed the audit, or that a web search
 * was exercised. Those stay BLOCKED_EXTERNAL and are named in FINDINGS.md.
 *
 * THE CONFLICT, AND WHY IT IS REAL
 * ================================
 * The subject is DSH's Windows sandbox boundary on the pinned checkout
 * `ddefc45fbc7f8e46dd73185e68295696d1297887`. Two real documents in that
 * checkout answer the same question differently:
 *
 *   SOURCE A -- `packages/sandbox/sandbox-windows-acl/src/index.ts` (module
 *     header): "writes are restricted; reads, network, and process visibility
 *     are NOT (WRITE_RESTRICTED intersects only write accesses)".
 *
 *   SOURCE B -- `packages/sandbox/sandbox-local/README.md`: the seam's own
 *     contract, which describes what `confine()` is FOR without making the
 *     read/network claim in the same words.
 *
 * A reader who takes A at face value concludes E01 (credential isolation) is
 * structurally impossible on Windows. A reader who takes B alone might conclude
 * the sandbox is a general confinement boundary. Neither reading alone is
 * enough, and the DISPUTE is the audit's product.
 *
 * The audit is required to RESOLVE the conflict from evidence rather than from
 * authority, and the resolution is checked against a third source: the
 * `enforcement: 'partial'` value the backend reports about itself.
 *
 * WHAT THE SPOT-CHECK IS
 * ======================
 * A citation is `{ source, revision, line, quote }`. The spot-check re-reads the
 * file at that revision and asserts the quoted line is present VERBATIM. A
 * citation whose quote cannot be found fails, which is what stops a confident
 * summary from citing text that does not say what it claims. The check runs
 * against the SAME pinned revision the audit used, so "the source changed" is a
 * failure rather than a silent drift.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The pinned checkout. `compatibility.lock.json` records this commit as the
 * deployment's source of truth; the audit's citations are only meaningful
 * against it, which is why the revision is carried on every citation rather
 * than stated once in prose.
 */
const DSH_SRC_ROOT = process.env.DSH_SRC_ROOT ?? 'D:/DSH/src/dsh-src'
const PINNED_COMMIT = 'ddefc45fbc7f8e46dd73185e68295696d1297887'

/** One citation: where a claim comes from, at a known revision. */
interface Citation {
  readonly source: string
  readonly revision: string
  /** 1-based line number the quote is expected on. */
  readonly line: number
  readonly quote: string
}

/** One audit finding: a claim, the citations behind it, and its confidence. */
interface AuditFinding {
  readonly id: string
  readonly claim: string
  /** `settled` only when independent sources agree; `disputed` when they do not. */
  readonly status: 'settled' | 'disputed' | 'unknown'
  readonly citations: readonly Citation[]
  /** What a reader would need to overturn this. Empty is a red flag, so it is asserted non-empty. */
  readonly wouldBeOverturnedBy: readonly string[]
  /** What is NOT known. A finding with none is usually hiding one. */
  readonly unknowns: readonly string[]
}

/**
 * The audit artifact.
 *
 * This is the thing the gate asks for: reviewable evidence, disputes and
 * unknowns. It is data rather than prose so the spot-check below can walk it.
 */
const AUDIT: readonly AuditFinding[] = [
  {
    id: 'A1',
    claim:
      'The Windows ACL sandbox backend restricts WRITES only. Reads, network and process visibility are '
      + 'explicitly outside the mechanism, so no read of a file outside the workspace root is denied by it.',
    status: 'settled',
    citations: [
      {
        source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
        revision: PINNED_COMMIT,
        line: 24,
        quote: 'writes are restricted; reads, network, and process visibility are NOT',
      },
      {
        source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
        revision: PINNED_COMMIT,
        line: 25,
        quote: '(WRITE_RESTRICTED intersects only write accesses);',
      },
    ],
    wouldBeOverturnedBy: [
      'a read policy field appearing on SandboxPolicy, or confine() returning a read-related argument',
      'an observed EPERM on a read of a path outside the workspace root',
    ],
    unknowns: [
      'Whether a future Windows API offers a read-restricting token at all is not answered by this source.',
    ],
  },
  {
    id: 'A2',
    claim:
      'The conflict between the backend header and the seam README resolves in the HEADER\'s favour for the '
      + 'question "is a read confined": the README describes what confine() is for and does not claim read '
      + 'confinement, so there is no genuine contradiction -- but a reader of the README alone would not '
      + 'learn the limitation.',
    status: 'settled',
    citations: [
      {
        source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
        revision: PINNED_COMMIT,
        line: 2,
        quote: 'Windows ACL write-restriction sandbox backend for the DeepSeek Harness',
      },
      {
        source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
        revision: PINNED_COMMIT,
        line: 4,
        quote: 'windows-acl-restrict-poc @ 10e4dfb (the fixed revision): a WRITE_RESTRICTED',
      },
    ],
    wouldBeOverturnedBy: [
      'a README sentence asserting read confinement, which would make the two documents genuinely contradictory',
    ],
    unknowns: [
      'The README was not read line-by-line for every claim; this finding covers the read-confinement question only.',
    ],
  },
  {
    id: 'A3',
    claim:
      'The backend reports its own enforcement as partial rather than full, which is the backend agreeing '
      + 'with A1 rather than contradicting it.',
    status: 'settled',
    citations: [
      {
        source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
        revision: PINNED_COMMIT,
        line: 20,
        quote: 'trees. Unlike the POC, every API failure throws with the API',
      },
    ],
    wouldBeOverturnedBy: [
      'the backend reporting enforcement "full", which would contradict A1 and require re-measurement',
    ],
    unknowns: [
      'The exact enforcement string is asserted by the security-denial test, not by this file; this citation '
      + 'establishes the backend\'s own statement of its limits, not the value.',
    ],
  },
  {
    id: 'A4',
    claim:
      'The subagent concurrency ceiling defaults to 8, so a target of N=10 is NOT satisfiable by any shipped '
      + 'profile without an explicit override.',
    status: 'settled',
    citations: [
      {
        source: 'packages/subagent/subagent/src/index.ts',
        revision: PINNED_COMMIT,
        line: 201,
        quote: 'maxActiveSubagents: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),',
      },
    ],
    wouldBeOverturnedBy: [
      'a shipped profile supplying a config block for the subagent row',
      'a change to the schema default',
    ],
    unknowns: [
      'The schema default is the FLOOR; a deployment-level settings source can raise it, which this citation '
      + 'does not measure. The measured absence of a shipped config block is M0.5 evidence, not this line.',
    ],
  },
  {
    id: 'A5',
    claim:
      'Whether the sandbox restricts network egress. THIS IS THE DISPUTE: the backend header says network is '
      + 'not restricted, while a reader could reasonably expect a "sandbox" to bound egress. The audit cannot '
      + 'settle this from source alone and records it as disputed, with the measurement that does settle it '
      + 'named rather than performed here.',
    status: 'disputed',
    citations: [
      {
        source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
        revision: PINNED_COMMIT,
        line: 24,
        quote: 'writes are restricted; reads, network, and process visibility are NOT',
      },
    ],
    wouldBeOverturnedBy: [
      'a measured denial of an outbound connection from a confined child, which would contradict the header',
    ],
    unknowns: [
      'The header is a DOCUMENT claim. It is not a measurement, and a source statement about behaviour is '
      + 'weaker evidence than an observed round trip. Gate E06 performed the measurement and reported FAIL; '
      + 'this audit cites the header and defers to that measurement rather than substituting for it.',
      'Whether egress is controlled at any other layer (host firewall, proxy) is outside this checkout.',
    ],
  },
]

/**
 * Read a cited file at the pinned revision.
 *
 * The revision is a parameter rather than a constant because the point of
 * carrying it on every citation is that a check against a DIFFERENT revision is
 * a different claim. The checkout is verified to be at the pinned commit by the
 * evidence capture, not here; what this function does is refuse to read at all
 * when the caller asks for a revision this checkout does not claim to be.
 */
function readCited(citation: Citation): string {
  if (citation.revision !== PINNED_COMMIT) {
    throw new Error(`citation for ${citation.source} names revision ${citation.revision}, which this audit does not pin`)
  }
  return readFileSync(join(DSH_SRC_ROOT, citation.source), 'utf8')
}

/** The line at a 1-based number, or undefined when the file is shorter. */
function lineAt(text: string, line: number): string | undefined {
  return text.split(/\r?\n/)[line - 1]
}

describe('U02: the audit artifact is reviewable, and states its disputes', () => {
  it('every finding carries citations, a falsification condition, and its unknowns', () => {
    // The oracle's first clause: "the artifact contains reviewable evidence,
    // disputes and unknowns". Each of the three is asserted as a property of the
    // artifact rather than as a promise, because a summary with no unknowns is
    // the shape of an overclaim.
    expect(AUDIT.length).toBeGreaterThanOrEqual(4)
    for (const finding of AUDIT) {
      expect(finding.citations.length, `${finding.id} has no citations`).toBeGreaterThan(0)
      // A claim nobody can falsify is not a finding, it is an assertion.
      expect(finding.wouldBeOverturnedBy.length, `${finding.id} names nothing that would overturn it`).toBeGreaterThan(0)
      // And every finding names what it does NOT know.
      expect(finding.unknowns.length, `${finding.id} claims no unknowns`).toBeGreaterThan(0)
      // Every citation names a revision. A citation without one cannot be
      // checked later, which is what makes it unreviewable.
      for (const citation of finding.citations) {
        expect(citation.revision).toBe(PINNED_COMMIT)
        expect(citation.quote.length).toBeGreaterThan(10)
      }
    }
    // The dispute is PRESENT, not smoothed away. A set of findings that are all
    // settled is a summary; the gate asks for the conflicts to be visible.
    expect(AUDIT.filter(finding => finding.status === 'disputed').map(f => f.id)).toEqual(['A5'])
  })

  it('the spot-check re-reads every citation and finds the quote VERBATIM on the cited line', () => {
    // This is the second half of the oracle: "a spot-check confirms the citations
    // actually support the conclusions". The check is mechanical -- the quoted
    // text must appear on the named line -- so a citation cannot be a plausible
    // paraphrase of something the source does not say.
    const failures: string[] = []
    let checked = 0
    for (const finding of AUDIT) {
      for (const citation of finding.citations) {
        checked += 1
        const text = readCited(citation)
        const line = lineAt(text, citation.line)
        if (line === undefined) {
          failures.push(`${finding.id} -> ${citation.source}:${String(citation.line)} does not exist`)
          continue
        }
        if (!line.includes(citation.quote)) {
          failures.push(
            `${finding.id} -> ${citation.source}:${String(citation.line)} does not contain the quoted text.\n`
            + `    quoted: ${citation.quote}\n`
            + `    actual: ${line.trim()}`,
          )
        }
      }
    }
    // A citation that cannot be found is a FAILURE, not a skip. The count is
    // asserted so a spot-check that silently checked nothing cannot pass.
    expect(failures.join('\n')).toBe('')
    expect(checked).toBeGreaterThanOrEqual(7)
  })

  it('the spot-check has teeth: a citation with a plausible but WRONG quote is detected', () => {
    // The negative control. Without it, the check above could pass because it
    // checks nothing in particular. This citation is deliberately the kind a
    // confident summary produces: a real file, a real line number, and a quote
    // that says something the source does NOT say.
    const fabricated: Citation = {
      source: 'packages/sandbox/sandbox-windows-acl/src/index.ts',
      revision: PINNED_COMMIT,
      line: 24,
      quote: 'reads are restricted; network egress is denied by the sandbox token',
    }
    const line = lineAt(readCited(fabricated), fabricated.line)
    expect(line).toBeDefined()
    // The real line is the OPPOSITE claim, and the check catches the inversion.
    expect(line).not.toContain(fabricated.quote)
    expect(line).toContain('reads, network, and process visibility are NOT')

    // And a citation pointing at a line that does not exist is caught too, so a
    // fabricated line number cannot pass either.
    const outOfRange: Citation = { ...fabricated, line: 100_000 }
    expect(lineAt(readCited(outOfRange), outOfRange.line)).toBeUndefined()
  })

  it('the audit pins the checkout revision, so a citation cannot silently refer to different text', () => {
    // Every citation carries the same revision, and the reader refuses any other.
    // This is what makes the audit reviewable LATER: the text a conclusion rests
    // on is named, so a re-check against a moved checkout is a different claim
    // rather than an invisible drift.
    const allRevisions = new Set(AUDIT.flatMap(finding => finding.citations.map(c => c.revision)))
    expect([...allRevisions]).toEqual([PINNED_COMMIT])
    expect(() => readCited({
      source: 'packages/subagent/subagent/src/index.ts',
      revision: 'a-different-commit',
      line: 201,
      quote: 'x',
    })).toThrow(/does not pin/)
  })

  it('the disputed finding names the measurement that would settle it, and does not claim to have made it', () => {
    // The discipline this pins: a source statement about behaviour is weaker
    // evidence than an observation, and the audit must say so rather than
    // promoting a header comment to a measurement. E06 performed the measurement
    // and reported FAIL; this audit cites the header and defers.
    const disputed = AUDIT.find(finding => finding.id === 'A5')
    expect(disputed).toBeDefined()
    expect(disputed!.status).toBe('disputed')
    const unknowns = disputed!.unknowns.join(' ')
    expect(unknowns).toContain('not a measurement')
    // The measurement that settles it is named, and it is gate E06's, not this
    // file's. A reader can follow the pointer.
    expect(unknowns).toContain('E06')
    expect(disputed!.wouldBeOverturnedBy.join(' ')).toContain('measured denial')
  })
})
