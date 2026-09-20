#!/usr/bin/env python3
"""S14 — apply GAPS.md hygiene edits.

Every replacement is asserted to occur EXACTLY ONCE. Nothing is deleted: the
history of each entry is preserved, verdicts are PREPENDED to the Status cell,
and duplicates are cross-referenced rather than removed.

Run:  python apply-gaps-hygiene.py            (writes docs/GAPS.md in place)
      python apply-gaps-hygiene.py --check    (report what would change)
"""
import re
import sys

SRC = r'D:\DSH\work\wt-s14\docs\GAPS.md'
CHECK = '--check' in sys.argv

raw = open(SRC, 'rb').read()
text = raw.decode('utf-8')
orig = text

# ---------------------------------------------------------------- header ----
OLD_HEAD = (
    '# GAPS \u2014 what is missing, unverified, or externally blocked\n'
    '\n'
    'Status values: `OPEN` / `IN_PROGRESS` / `RESOLVED` / `BLOCKED_EXTERNAL` / `NOT_APPLICABLE`.\n'
    'An entry only moves to `RESOLVED` with a link to evidence under `qualification/results/`.\n'
)

NEW_HEAD = '''# GAPS — what is missing, unverified, or externally blocked

## HOW TO READ THIS FILE

This file is the project's defect ledger and its audit record. **Entries are
never deleted.** A wrong entry is corrected in place, a superseded one keeps its
text and gains a successor, and a retracted one keeps the retraction next to the
claim so a reader who saw the original can see it withdrawn.

### Status vocabulary

**Every entry's Status cell must BEGIN with one of these words.** A Status that
only describes provenance ("MEASURED by writer R1\u2026") is not a verdict — it does
not tell a reader whether the defect is still live, so it is a filing error.

| word | meaning |
|---|---|
| `OPEN` | A real defect or gap, not closed. The Note must name what would close it, or say plainly that it is unfixable here. |
| `RESOLVED` | Closed by a change **in this tree**. The Note must name the code site or an evidence path under `qualification/results/`. |
| `FIXED` | Same as `RESOLVED`, used by the `G-FIX-*` family, and normally naming the commit. |
| `SUPERSEDED` | A later entry or decision replaced this one. The successor is named in the Status. |
| `DUPLICATE` | The same defect is filed under another id. The canonical entry is named; this one is kept for cross-reference only. |
| `RETRACTED` | This project filed it and then withdrew it. Kept because the row was cited elsewhere. |
| `REFUTED` | Someone else's claim, re-measured here, that did not reproduce. |
| `BLOCKED_EXTERNAL` | Cannot be closed from inside this repository (credential, budget, a different OS). |
| `NOT_A_DEFECT` | Recorded for context; there is nothing to fix. |
| `VERIFIED` | A measured, positive result kept as evidence. Not a defect and not an open question. |
| `IN_PROGRESS` | Investigation open, no verdict yet. **Only the `G-TODO-*` family may use this.** |

An entry that says "this is a problem" without saying whether it was fixed,
deferred, or found not to be a problem is not actionable, and is a filing defect
in its own right.

### Identity and provenance

- **`G-*` ids are the file's primary key and they are not contiguous across
  families.** `G-SEAM-55..74` are round-1 filings and appear out of numeric order
  inside the "Fixed during implementation" section, because the table is in
  arrival order. Search by id, not by position.
- **A label is not an identifier.** Pre-spec test labels (`IPY-15`, `FS-06`,
  `VER-09`) are NOT the spec's case ids; map by ORACLE. See `G-SEAM-38`.
- **Aliases from other documents.** `G-WEB-01` and `G-WEB-03` are defined in
  `qualification/results/R6-research/FINDINGS.md`; their filings here are
  `G-SEAM-52` and `G-SEAM-53`. `G-R5-04` is defined in
  `qualification/results/R5-data/FINDINGS.md`; its filing here is `G-SEAM-64`.
- **An installed artifact is not the repository until proven built from it.**
  This project has filed and retracted false findings twice by measuring a stale
  build (`G-SEAM-29`, `G-SEAM-36`); every claim carries the identity it was
  measured under.
- **This file is UTF-8 with LF line endings and must stay machine-readable.** It
  is parsed as a markdown table by tooling and by readers; a literal control byte
  or an unescaped `|` inside a cell breaks the row for every downstream consumer.
  Use `\\|` for a pipe inside a cell and `\\x00` / `\\u0000` for a NUL, never the
  byte itself. (Three control bytes and six over-split rows were repaired by
  writer S14; see `qualification/results/S14-gaps/`.)
'''

# ---------------------------------------------------- status-cell edits ----
# (id, old_status_cell, new_status_cell). Prepend a vocabulary word; never
# rewrite the reasoning that was already there.
STATUS_EDITS = [
    # --- falsified by round-1 work: the claim "X is not implemented" is now false
    ('G-SEAM-20',
     'OPEN \u2014 BLOCKS the product; the mechanism is proven but unwired',
     'RESOLVED \u2014 was: `OPEN`, blocked the product. **Closed by round 1**: the launch port IS '
     'installed on the production path and the run IS created by a user action. '
     '`WorkService.createRun` calls `installDefaultLaunchPort(input.root)` '
     '(`packages/dsh-daily-work/src/host.ts:700`), and `createRun` is reached from the product by '
     'the human `/work start` command (`src/command-work.ts`, mounted at '
     '`profiles/daily-candidate/presets/daily-standard/agent.cordis.yml:384-385`; measured on a real '
     'boot, 33/33 checks, `qualification/results/R4-authorization/report-after.json`). '
     'The text below is the original filing, kept as history. '
     'SUPERSEDED-IN-PART by `G-SEAM-63` (the RECOVERY path still installs no port).'),

    ('G-SEAM-31',
     'OPEN \u2014 measured by import graph; the mandatory N=10 requirement is unreachable from the composed profile',
     'RESOLVED \u2014 was: `OPEN`, "nothing in the product creates a run". **The missing entry point '
     'now exists**: `src/command-work.ts` registers `/work start [N] \\| target N \\| stop \\| status` '
     'through DSH\'s HUMAN command registry, mounted in the deliverable preset '
     '(`agent.cordis.yml:384-385`), and a real composed-profile boot measured a durable run created '
     'by `/work start 10` with `authorizationRef` naming the human command '
     '(`qualification/results/R4-authorization/report-after.json`, 33/33). '
     'The `work` tool still refuses when no run exists, deliberately \u2014 that is the authorization '
     'edge, not the defect. The text below is the original filing, kept as history.'),

    ('G-SEAM-34',
     'OPEN \u2014 measured by two independent instruments; instance 10 of the defect class',
     'RESOLVED \u2014 was: `OPEN`, "nothing in the product ever constructs a `BridgeServer`". '
     '**Round 1 wired it**: `new BridgeServer(...)` is constructed at '
     '`packages/dsh-ipython/src/kernel-plugin.ts:493`, before the kernel process, and a real `daily` '
     'profile boot reached a live bridge on port 4191 with a durable ledger row '
     '(`qualification/results/R5-bridge/composition-tier.json`; see `G-SEAM-72`). '
     'The text below is the original filing, kept as history.'),

    ('G-SEAM-33',
     'OPEN \u2014 measured twice independently, plus verified in upstream source',
     'RESOLVED \u2014 was: `OPEN`, "the composed profile\'s `sandboxPolicy.defaultMode` is '
     '`workspace-write`". **Round 1 gave the deployment its own `sandbox-policy` row** with '
     '`mode: danger-full-access` (`profiles/daily-candidate/cordis.patch.yml:539`), and a real boot '
     'records `danger-full-access` (`qualification/results/R1-trusted-local/composition-after.json`; '
     'the `before` file is the archived reproduction). Both live consequences named below are '
     'therefore closed: the system-prompt line now states the true mode, and the PTC confine branch '
     'no longer fences. The text below is the original filing, kept as history.'),

    ('G-SEAM-41',
     'OPEN \u2014 measured by the DATA family (V5), `DATA-11` FAIL',
     'RESOLVED \u2014 was: `OPEN`, `DATA-11` FAIL. **A cursor now carries a store realm and the read '
     'path checks it**: `PageCursor.storeRealmId` with `CursorAuthority.assertRealm` '
     '(`packages/dsh-daily-work/src/artifacts.ts:1390,1513`), called from the paging path before the '
     'reference is resolved (`:1755`). Evidence: `src/data11-cursor-realm.test.ts`. '
     'The text below is the original filing, kept as history.'),

    ('G-SEAM-45',
     'OPEN \u2014 measured by the CONCURRENCY family (V8), `CAP-10` FAIL, with ZERO real children',
     'RESOLVED \u2014 was: `OPEN`, `CAP-10` FAIL. **The coalescer that synchronized the callers is '
     'gone**, replaced by a per-run leader with a generation/dirty loop so no second `runDrain` '
     'starts for the same run (`packages/dsh-daily-work/src/host.ts:1955-2032`), and the invariant no '
     'longer depends on it: admission is decided inside ONE storage-domain update '
     '(`tryReserveAdmission`). `f5-admission.test.ts` carries the arm that drives the reservation '
     'path with the coalescer deliberately defeated. The text below is the original filing, kept as '
     'history.'),

    ('G-SEAM-54',
     'OPEN \u2014 measured by the NATIVE BRIDGE family (V4), `BR-07` FAIL',
     'RESOLVED \u2014 was: `OPEN`, `BR-07` FAIL, "the bridge route has NO disposition vocabulary". '
     '**The vocabulary now exists on the bridge route**: `BridgeDisposition` with all four members '
     '(`packages/dsh-ipython/src/bridge.ts:58-59, 263, 648-649, 712, 823`), and a real boot recorded '
     'a durable ledger row with disposition `settled` (`qualification/results/R5-bridge/'
     'composition-tier.json`). The text below is the original filing, kept as history.'),

    ('G-SEAM-40',
     'OPEN \u2014 measured by the DATA family (V5), `DATA-09` FAIL',
     'RESOLVED (by redefinition) \u2014 was: `OPEN`, `DATA-09` FAIL, "two of the six observation-gap '
     'stages have ZERO production producers". **The fix was to remove the vocabulary, not to invent '
     'producers**: v2 of the descriptor carries FOUR stages, `model-projection` became a '
     '`ProjectionManifest` (a different type, not a gap) and `transport` became an error path, with '
     'the reasoning written at `packages/dsh-daily-work/src/observations.ts:75-137` and the schema '
     'version raised 1->2. Evidence: `qualification/results/R8-taxonomy-split/`. '
     'The text below is the original filing, kept as history.'),

    ('G-SEAM-47',
     'OPEN \u2014 measured by the IDENTITY family (V1), `ID-01` FAIL',
     'SUPERSEDED by `G-SEAM-74` \u2014 was: `OPEN`, `ID-01` FAIL on one source resolution out of 223. '
     'The clause is CLOSED: `artifacts.ts` now imports the public `@deepseek-ai/dsh-attachment` '
     'instead of the private `./src/store.ts` subpath, a real built-launcher boot resolves 221/221 '
     'under `lib/` with `sourceRows: []`, and `no-src-imports.test.ts` is the regression gate. '
     'Evidence: `G-SEAM-74`. The text below is the original filing, kept as history.'),

    ('G-SEAM-48',
     'OPEN \u2014 measured by the IDENTITY family (V1), `ID-05` FAIL, with a control arm',
     'RESOLVED \u2014 was: `OPEN`, `ID-05` FAIL, "the project\'s own gate depends on the stricter '
     'checker". **The gate is now ONE named command that cannot silently degrade**: `pnpm typecheck` '
     '-> `helpers/typecheck.mjs` (`package.json:29`), which derives the package set rather than '
     'listing it and REFUSES to report success if the resolved check config contains no '
     '`*.test.ts`. The two configs still mean different things, deliberately; a reader no longer has '
     'to guess which one the gate uses. The text below is the original filing, kept as history.'),

    ('G-SEAM-64',
     'OPEN \u2014 **ALREADY RECORDED as `G-R5-04`** (`qualification/results/R5-data/FINDINGS.md:359`, re-confirmed in `qualification/results/T8-data/GATES.md:222`); re-found independently by writer R2-F11F10 and re-verified by root',
     'DUPLICATE of `G-R5-04` (canonical), and now FIXED \u2014 `G-R5-04` '
     '(`qualification/results/R5-data/FINDINGS.md:359`) is the authoritative record; this row is '
     'kept for the one causal link it adds (`G-SEAM-62`) and must not be read as a second defect. '
     '**FIXED by writer R6**: `artifactRoot` is now derived from the host\'s own `dshHomePath` '
     'helper (`packages/dsh-daily-work/cordis.patch.yml:281`, the same convention the sibling stores '
     'use), an explicitly configured root must be ABSOLUTE or it is refused by name, and the '
     'remaining relative fallback is RECORDED (`service.artifactRootFallback`) rather than silent.'),

    ('G-SEAM-65',
     'MEASURED by writer R1 (`qualification/results/R1-trusted-local/session-override-inventory.json`); **the migration decision is OPEN**',
     'OPEN \u2014 measured by writer R1 '
     '(`qualification/results/R1-trusted-local/session-override-inventory.json`); **the migration '
     'decision is open**, and it is a policy choice about sessions that predate the change, not a '
     'code defect. What would close it: either an explicit migration of the stored events, or a '
     'refusal to resume such a session under the new default.'),

    ('G-VER-03',
     'CONFIRMED \u2014 BLOCKED_EXTERNAL for the boundary; gate is FAIL, not unknown',
     'BLOCKED_EXTERNAL (CONFIRMED) \u2014 the boundary cannot be expressed through the public sandbox '
     'seam; the gate stays an honest FAIL, not unknown'),

    # --- "CONFIRMED BY MEASUREMENT" is a fact, not a verdict: say which kind
    ('G-SEAM-07',
     '**CONFIRMED BY MEASUREMENT**',
     'OPEN (upstream fact, confirmed by measurement) \u2014 the default is DSH\'s, not this '
     'deployment\'s; what closes it here is the explicit override, which the composed profile '
     'carries'),

    ('G-SEAM-12',
     '**CONFIRMED BY MEASUREMENT**',
     'OPEN (upstream limitation, confirmed by measurement) \u2014 the seam has no read or egress lever '
     'in its type, so this cannot be closed inside the runner'),

    # --- "VERIFIED" entries: not defects, and they must say so
    ('G-SEAM-60',
     '**VERIFIED** (not a defect; recorded because it is the precondition that makes every other round-1 claim trustworthy)',
     'VERIFIED (NOT_A_DEFECT) \u2014 recorded because it is the precondition that makes every other '
     'round-1 claim trustworthy'),

    ('G-SEAM-71',
     '**VERIFIED** \u2014 writer R6\'s slice, with root confirming the two source-level defect claims',
     'VERIFIED \u2014 writer R6\'s slice, with root confirming the two source-level defect claims. '
     'The three defects found while measuring are FIXED in-slice (`G-SEAM-70` is the one left to '
     'its owner)'),

    ('G-SEAM-72',
     '**VERIFIED** \u2014 writer R5\'s composition-tier measurement; root confirmed the fix in source',
     'VERIFIED \u2014 writer R5\'s composition-tier measurement; root confirmed the fix in source. '
     'The boot defect it found is FIXED (`host-plugin.ts:58`, `kernel-plugin.ts:364`)'),

    # --- explicit duplicate / supersede markers for the cross-referenced pairs
    ('G-SEAM-11',
     'OPEN \u2014 M6 risk',
     'DUPLICATE of `G-SEAM-17` (canonical, and more complete) \u2014 same fact, filed twice. '
     '`G-SEAM-17` names the six tools and the model\'s actual route to a PTY; read that one. '
     'Status of the fact itself: OPEN (upstream composition fact, not this project\'s to change)'),

    ('G-SEAM-17',
     'OPEN',
     'OPEN \u2014 canonical entry for the fact `G-SEAM-11` also filed (that row is the duplicate)'),

    ('G-SEAM-49',
     'OPEN \u2014 measured by the IDENTITY family (V1), `ID-06` FAIL',
     'SUPERSEDED by `G-SEAM-62` \u2014 the same checkout-cleanliness fact, re-measured after the '
     'untracked directories were relocated: three dirty entries became ONE, and the remaining one is '
     'a line-ending artifact with an identical blob id. `ID-06` remains FAIL for an ENVIRONMENT '
     'precondition. Read `G-SEAM-62` for the current measurement; the text below is the original '
     'filing, kept as history.'),
]

# ------------------------------------------------------- structural edits ----
# Each is (old_exact_substring, new_exact_substring, why).
STRUCT_EDITS = [
    # 1. G-SEAM-39: a fenced code block escaped the table cell and split the row.
    ('(`qualification/results/V3-ipython/experiment-restart-single-variable.txt`):\n'
     '```\n'
     'with-status     ok:true  elapsedMs:1823   pidBefore:31804  epochAfter:2\n'
     'without-status  ok:true  elapsedMs:11852  pidBefore:29972  epochAfter:2\n'
     '```\n'
     'BOTH arms pass.',
     '(`qualification/results/V3-ipython/experiment-restart-single-variable.txt`). '
     'Both arms PASS, and the two trials differ by 6x in wall time '
     '(`with-status ok:true elapsedMs:1823 pidBefore:31804 epochAfter:2` / '
     '`without-status ok:true elapsedMs:11852 pidBefore:29972 epochAfter:2`), '
     'which is why the timing variance is still recorded as `UNKNOWN_CAUSE` rather than explained. '
     'BOTH arms pass.',
     'the fenced block was outside the table cell, splitting G-SEAM-39 into two rows'),

    # 2. G-SEAM-62: the row was cut mid-sentence and the continuation became orphan prose.
    # The corruption: `\relocated` had its `\r` escape-processed into a real
    # newline, and `\2026` its `\2` into U+0082 -- so the row was cut in half and
    # the continuation became orphan prose below the table.
    ('were **moved, not deleted**, to `D:\\DSH\n'
     'elocated\x826-09-20-checkout-state\\` with a per-file sha256 manifest',
     'were **moved, not deleted**, to `D:\\DSH\\relocated\\2026-09-20-checkout-state\\` '
     'with a per-file sha256 manifest',
     'row split by a Python-escape corruption of `\\r` and `\\2` (see G-FIX-11 for the same defect '
     'class in compatibility.lock.json)'),

    # 3+4. backspace where `\b` of `\broker.py` was escape-processed.
    ('D:\\DSH\\work\\wt-<name>\\packages\\dsh-ipython\\src\x08roker.py',
     'D:\\DSH\\work\\wt-<name>\\packages\\dsh-ipython\\src\\broker.py',
     '0x08 backspace from an unescaped `\\b`'),

    ('D:\\DSH\\work\\wt-r0-probe\\packages\\dsh-ipython\\src\x08roker.py',
     'D:\\DSH\\work\\wt-r0-probe\\packages\\dsh-ipython\\src\\broker.py',
     '0x08 backspace from an unescaped `\\b`'),

    # 5. literal NUL in a description of a NUL-separated digest.
    ("sha256(url + '\x00' + acquiredAt).slice(0,16)",
     "sha256(url + '\\u0000' + acquiredAt).slice(0,16)",
     'literal 0x00 byte; the code writes `\\u0000`, and the file must stay text'),
]

# 6. unescaped pipes inside cells -> escaped, so the row keeps its 4 cells.
PIPE_FIXES = [
    ('`status | submit | finish`', '`status \\| submit \\| finish`'),
    ('`NT AUTHORITY\\Authenticated Users | Modify`', '`NT AUTHORITY\\Authenticated Users \\| Modify`'),
    ('`BUILTIN\\Users | ReadAndExecute`', '`BUILTIN\\Users \\| ReadAndExecute`'),
    ('`CodexSandboxUsers | Modify`', '`CodexSandboxUsers \\| Modify`'),
    ('outside its own tree. | **CONFIRMED IN PRACTICE',
     'outside its own tree. \\| **CONFIRMED IN PRACTICE'),
    ("as { root?: string } | undefined)?.root`", "as { root?: string } \\| undefined)?.root`"),
    ('presenting the finding as new. | **FIX CHOSEN BY WRITER R6',
     'presenting the finding as new. \\| **FIX CHOSEN BY WRITER R6'),
    ("'(?:settling|confirmed|cancelled|executing|cancel_requested)'",
     "'(?:settling\\|confirmed\\|cancelled\\|executing\\|cancel_requested)'"),
    ("rather than the product. | **ROOT THEN APPLIED THIS TEST",
     "rather than the product. \\| **ROOT THEN APPLIED THIS TEST"),
    ('tension explained rather than hidden. | **R2-F4\'s REPORT ADDS',
     'tension explained rather than hidden. \\| **R2-F4\'s REPORT ADDS'),
]

# 7. the missing G-FIX-10 entry: referenced twice, defined nowhere.
G_FIX_10_ANCHOR = '| G-FIX-11 |'
G_FIX_10_ROW = (
    '| G-FIX-10 | **The `tsconfig.check.json` `paths` map is a workaround for an upstream '
    'resolution trap, and the entry that explains it was LOST from this file.** | '
    'RESOLVED \u2014 and this row is a RECONSTRUCTION, not a filing | '
    '`G-SEAM-22` cites `G-FIX-10` twice and no such entry existed in this file, so a reader '
    'following the reference found nothing. Reconstructed from `G-SEAM-22` and from the config '
    'itself: `packages/dsh-daily-work/tsconfig.check.json` carries a ONE-ENTRY `paths` map for '
    '`@deepseek-ai/dsh-util-values`, copied from the pinned commit\'s `tsconfig.base.json` rather '
    'than hand-written. WHY IT IS NEEDED: a few tests deliberately import a production module '
    'through the checkout\'s exported `./src/*` deep path, so TypeScript resolves that file\'s own '
    'imports from the CHECKOUT\'s directory, which declares only 13 of ~100 `@deepseek-ai` links '
    'because it relies on the same `paths` mechanism this project does not extend. Without the map '
    'the check reports an upstream package as unresolvable, which is a property of the checkout\'s '
    'layout and not a defect in the test. **Whether the original entry said anything more is '
    'UNKNOWN** \u2014 it is not in the git history of this file, so this row records what can be '
    'established and names the gap. |\n'
)

# ---------------------------------------------------------------- apply ----
changes = 0
for old, new in [(OLD_HEAD, NEW_HEAD)]:
    n = text.count(old)
    assert n == 1, 'header matched %d times' % n
    text = text.replace(old, new)
    changes += 1

for eid, old, new in STATUS_EDITS:
    # anchor on the row so a phrase cannot match in the wrong entry
    needle = '| %s |' % eid
    assert text.count(needle) == 1, '%s row anchor matched %d times' % (eid, text.count(needle))
    i = text.index(needle)
    j = text.index('\n', i)
    row = text[i:j]
    cnt = row.count('| %s |' % old)
    assert cnt == 1, '%s status cell %r matched %d times' % (eid, old[:60], cnt)
    newrow = row.replace('| %s |' % old, '| %s |' % new)
    text = text[:i] + newrow + text[j:]
    changes += 1

for old, new, why in STRUCT_EDITS:
    n = text.count(old)
    assert n == 1, 'structural edit (%s) matched %d times: %r' % (why, n, old[:70])
    text = text.replace(old, new)
    changes += 1

for old, new in PIPE_FIXES:
    n = text.count(old)
    assert n == 1, 'pipe fix %r matched %d times' % (old[:60], n)
    text = text.replace(old, new)
    changes += 1

assert text.count(G_FIX_10_ANCHOR) == 1
text = text.replace(G_FIX_10_ANCHOR, G_FIX_10_ROW + G_FIX_10_ANCHOR)
changes += 1

# --- invariants that must hold after the edit -------------------------------
assert '\x08' not in text, 'backspace survived'
assert '\x00' not in text, 'NUL survived'
bad_ctrl = [c for c in text if ord(c) < 9 or (13 < ord(c) < 32) or ord(c) == 127]
assert not bad_ctrl, 'control chars remain: %r' % bad_ctrl


def splitrow(l):
    parts, cur, i = [], [], 0
    while i < len(l):
        c = l[i]
        if c == '\\' and i + 1 < len(l):
            cur.append(l[i:i + 2]); i += 2; continue
        if c == '|':
            parts.append(''.join(cur)); cur = []; i += 1; continue
        cur.append(c); i += 1
    parts.append(''.join(cur))
    return parts


lines = text.split('\n')
badrows = []
for n, l in enumerate(lines, 1):
    if re.match(r'^\| G-', l):
        nc = len(splitrow(l))
        if nc not in (5, 6):
            badrows.append((n, l[:40], nc))
assert not badrows, 'malformed rows remain: %r' % badrows

nrows = sum(1 for l in lines if re.match(r'^\| G-', l))
assert nrows == 109, 'expected 109 rows (108 + the reconstructed G-FIX-10), got %d' % nrows

print('%d edits applied; %d entries; no control bytes; all rows well-formed' % (changes, nrows))

if CHECK:
    print('--check: not writing')
else:
    open(SRC, 'wb').write(text.encode('utf-8'))
    print('written:', SRC)
