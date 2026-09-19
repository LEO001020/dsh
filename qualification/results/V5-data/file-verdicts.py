"""File the V5-data verdicts onto DATA-01..DATA-12, in place.

WHY A SCRIPT AND NOT A JSON ROUND-TRIP. The spec file uses COMPACT arrays
(`"verdict_vocabulary": ["NOT_RUN", ...]` on one line). `json.dumps(indent=2)`
expands those and rewrites the whole 80 KB file, so the diff would be the entire
document rather than the twelve cases. This edits only the exact
`"status" ... "evidence": [...]` text of each DATA case, matched literally, so
nothing outside the DATA family can move and every non-DATA byte is preserved.

The script is idempotent: it refuses to run twice without saying so, and it
verifies the parse afterwards.
"""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path('D:/DSH/work/dsh-native-daily')
SPEC = ROOT / 'qualification/specs/acceptance-spec.trusted-local-v1.json'
IDENTITY = '0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461'
EV = 'qualification/results/V5-data/'


def sha(rel: str) -> str:
    return hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()


# Every evidence path is hashed from disk HERE, so a recorded digest cannot be a
# hand-typed constant that drifts from the file.
E = {
    'gates': ('GATES.md', 'The DATA-family gate table: per-case assertion, exact command, measured result and verdict.'),
    'tests': ('tests-data-plane.txt', 'data-plane.test.ts at this HEAD: exit 0, 1 file, 68 tests passed, with the measured console lines.'),
    'probe': ('v5-data-probe.json', 'The V5 probe output: gap-stage attribution, reference states, refetch, cursor replay, recorded digests.'),
    'probe_src': ('v5-data-probe.mjs', 'The probe itself, so the measurement can be re-run and checked.'),
    'digests': ('source-digests.txt', 'Build identity, lib/ and src/ digests, and pinned-checkout digests for every claim.'),
}

for key, (rel, _) in E.items():
    path = ROOT / EV / rel
    if not path.is_file():
        sys.exit(f'ABORT: evidence file missing: {path}')

H = {key: sha(EV + rel) for key, (rel, _) in E.items()}


def entry(key: str, note: str) -> dict:
    rel, what = E[key]
    return {
        'path': EV + rel,
        'sha256': H[key],
        'identity': IDENTITY,
        'note': note if note else what,
    }


CASES = {
    'DATA-01': ('PASS', [
        entry('gates', 'Gate row DATA-01, with the command, the measured 102400 bytes and the recorded digest.'),
        entry('tests', 'DAT-01 [real] long line: 4 tests. The real buildWindow clips the line; the byte-range path recovers it.'),
        entry('probe', 'g5_recordedDigests.DATA-01_longLineRecoveredByteForByte: source and recovered sha256 are equal '
                        '(8f73f6f3193b1c3f71ef6395278559fb9c01a8eac0731dfdc6e37667e7a310b2), 2 pages, TAILMARKER present, '
                        'and the read-tool clip at READ_MAX_LINE_LENGTH=2000 is recorded for contrast.'),
        entry('digests', ''),
    ]),
    'DATA-02': ('PASS', [
        entry('gates', 'Gate row DATA-02: 32 MiB / 512 pages, projection 399 B in-process, 429 B real CPython, 437 B real ipykernel.'),
        entry('tests', 'DAT-02 [real capture / real consumers]: 3 tests, each naming its own consumer tier; projection asserted <= 8 KiB.'),
        entry('digests', ''),
    ]),
    'DATA-03': ('PASS', [
        entry('gates', 'Gate row DATA-03, including the measured boundary that an individual fixed-byte page need not be standalone-valid UTF-8.'),
        entry('tests', 'DAT-03 [real]: 5 tests, page sizes 1..96 and 10 record-boundary sizes over CRLF+JSONL.'),
        entry('probe', 'DATA-03_pageBoundarySweep: 5532 bytes, 120 records, 10 page sizes, every reassembly digest equals the source '
                        'digest f1e356753b62073fffd9728c428416ad4a199f838a21a5bf1dc2952c56efa0c4, no U+FFFD.'),
        entry('digests', ''),
    ]),
    'DATA-04': ('PASS', [
        entry('gates', 'Gate row DATA-04: repeated cursor stalls after 3 calls, backwards after 2, real store still completes.'),
        entry('tests', 'DAT-04 [mock provider]: 5 tests. The mock is the only mock in the file, labelled as such, because a correct '
                       'provider cannot return a repeated or backwards cursor.'),
        entry('digests', ''),
    ]),
    'DATA-05': ('PASS', [
        entry('gates', 'Gate row DATA-05, with the captured hash and the post-rewrite source hash recorded.'),
        entry('tests', 'DAT-05 [real]: 3 tests, including a cursor bound to a different artifact and a cursor after a grant bump.'),
        entry('probe', 'DATA-05_snapshotHashAfterSourceRewrite: captured b778c9b54fd1178b186ed04d4e93ddfc6b655b1309458f9b902bf1a9222ed392 '
                        'vs rewritten source 42bb697d7220ece5a3829e41bc60ec3d7c661452653c41c444268cddccdc14da; page 2 still reports the captured hash.'),
        entry('digests', ''),
    ]),
    'DATA-06': ('PASS', [
        entry('gates', 'Gate row DATA-06: 8 pages cost 524288 bytes; the index is one linear 4194304-byte scan; 5 repeated reads scanned 944445 bytes against 20480.'),
        entry('tests', 'DAT-06 [real]: 2 tests. The repeated-read control is the audit inference measured rather than assumed.'),
        entry('digests', ''),
    ]),
    'DATA-07': ('PASS', [
        entry('gates', 'Gate row DATA-07, which records the mechanism deviation: at the raw cap the product THROWS '
                       'SEARCH_RAW_OUTPUT_OVERFLOW rather than returning a partial-marked descriptor. Both substantive '
                       'requirements hold; a reader requiring the literal partial marking should read this as a deviation.'),
        entry('tests', 'DAT-07 [real ripgrep]: 2 tests. Canonical 900 matches read back by a real CPython process; renderer keeps 250 of 900 '
                       'and says it omitted the rest; the cap is driven through runRipgrep and the refusal is measured.'),
        entry('digests', ''),
    ]),
    'DATA-08': ('PASS', [
        entry('gates', 'Gate row DATA-08: quota, orphan, missing, corruption and checkpoint arms, each with its stage and store state.'),
        entry('tests', 'DAT-08 [real]: 5 tests, plus the DATA-08 corruption block (replaced in place, truncated, and an intact control).'),
        entry('digests', ''),
    ]),
    'DATA-09': ('FAIL', [
        entry('gates', 'Gate row DATA-09 and section 3a: 4 of the 6 stages have a real producer and were driven; transport and '
                       'model-projection have 0 assignments in production source, so two of the six stimuli this case names cannot '
                       'produce a gap at all. The spec rule "a loss that is not recorded as a gap is NOT PASS" is therefore not met.'),
        entry('probe', 'g1_gapAttribution: per-stage producer, measured gap, stage and recovery for all six; '
                        'stagesWithNoProducer is ["transport","model-projection"].'),
        entry('probe_src', ''),
        entry('digests', ''),
    ]),
    'DATA-10': ('PASS', [
        entry('gates', 'Gate row DATA-10: two observations with distinct ids; the earlier hash, time and byte count all survive.'),
        entry('tests', 'DATA-06 [real] a refetch is a NEW observation (the artifact-plane half), in tests-data-plane.txt.'),
        entry('probe', 'g3_refetchIsANewObservation: 2 observations, distinct ids, relation first->changed, earlier sha256/acquiredAt/bytes intact, '
                        'no API returning the current body for a url.'),
        entry('digests', ''),
    ]),
    'DATA-11': ('FAIL', [
        entry('gates', 'Gate row DATA-11 and section 3b: the different-REVISION arm holds, but the different-STORE arm the oracle names '
                       'FIRST is NOT refused and yields 64 bytes. The harm is isolated: with the object corrupted in the store the '
                       'descriptor was minted from, pages() serves 64 bytes hashing cc7321cc... while the descriptor names 9076e7f7..., '
                       'and resolveReference() refuses the same object with artifact-integrity-error.'),
        entry('probe', 'g4_cursorIsNotABearerToken: the four arms and the isolated mechanism arm, with the control proving the cursor '
                        'still works against its own store.'),
        entry('probe_src', ''),
        entry('digests', ''),
    ]),
    'DATA-12': ('PASS', [
        entry('gates', 'Gate row DATA-12: durable, orphaned and missing all resolve to their true state from the store own verdict in one run.'),
        entry('tests', 'The DAT-08 orphan/missing/corrupt arms and the crash-consistency block, in tests-data-plane.txt.'),
        entry('probe', 'g2_referenceStates: all three states distinct; missing never returns an empty success; the orphan is reconcilable and '
                        'grace-GC eligible and is never reported as delivered; committed-then-deleted stays a separate integrity error.'),
        entry('digests', ''),
    ]),
}


def block(status: str, evidence: list) -> str:
    body = json.dumps(evidence, indent=6, ensure_ascii=False)
    # json.dumps indents the list from column 0; re-indent to sit under "evidence".
    body = '\n'.join(('      ' + line) if i else line for i, line in enumerate(body.split('\n')))
    return f'"status": "{status}",\n      "evidence": {body}'


raw = (ROOT / 'qualification/specs/acceptance-spec.trusted-local-v1.json').read_text(encoding='utf-8')
original = raw

# Locate each DATA case's own status/evidence block by walking the JSON text, so a
# case id that merely appears in prose cannot be matched by accident.
for cid, (status, evidence) in CASES.items():
    anchor = f'"id": "{cid}"'
    start = raw.find(anchor)
    if start < 0:
        sys.exit(f'ABORT: case {cid} not found')
    if raw.find(anchor, start + 1) >= 0:
        sys.exit(f'ABORT: case id {cid} appears more than once')
    s = raw.find('"status"', start)
    e = raw.find('"evidence": [', s)
    if s < 0 or e < 0:
        sys.exit(f'ABORT: {cid} has no status/evidence block')
    e_end = raw.find(']', e + len('"evidence": ['))
    if e_end < 0:
        sys.exit(f'ABORT: {cid} evidence list is not closed')
    old = raw[s:e_end + 1]
    if '"status": "NOT_RUN",\n      "evidence": []' not in old:
        sys.exit(f'ABORT: {cid} does not hold the pristine NOT_RUN/empty-evidence block; refusing to overwrite: {old!r}')
    raw = raw[:s] + block(status, evidence) + raw[e_end + 1:]

if raw == original:
    sys.exit('ABORT: nothing changed')

(ROOT / 'qualification/specs/acceptance-spec.trusted-local-v1.json').write_text(raw, encoding='utf-8', newline='')

# Verify the write: it must parse, and only the DATA family may have moved.
spec = json.loads((ROOT / 'qualification/specs/acceptance-spec.trusted-local-v1.json').read_text(encoding='utf-8'))
by_id = {c['id']: c for c in spec['cases']}
touched = []
for c in spec['cases']:
    if c['status'] != 'NOT_RUN' or c['evidence']:
        touched.append(c['id'])
        if not c['id'].startswith('DATA-'):
            sys.exit(f'ABORT: non-DATA case {c["id"]} was modified')
for cid, (status, evidence) in CASES.items():
    case = by_id[cid]
    if case['status'] != status:
        sys.exit(f'ABORT: {cid} status is {case["status"]}, expected {status}')
    if len(case['evidence']) != len(evidence):
        sys.exit(f'ABORT: {cid} evidence count is {len(case["evidence"])}')
print(f'parsed OK, {len(spec["cases"])} cases')
print('cases carrying a verdict:', touched)
for cid in CASES:
    for e in by_id[cid]['evidence']:
        p = ROOT / e['path']
        if not p.is_file():
            sys.exit(f'ABORT: {cid} names a missing file {e["path"]}')
        if hashlib.sha256(p.read_bytes()).hexdigest() != e['sha256']:
            sys.exit(f'ABORT: {cid} digest mismatch for {e["path"]}')
print('every recorded path exists and hashes to its recorded sha256')
