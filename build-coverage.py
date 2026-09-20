"""Map the 112-case acceptance authority onto the evidence that exists in this repo.

WHY A MAPPING AND NOT A COUNT. The two specs use DISJOINT family prefixes -- the
authority's 112 cases are DEP/IPY/BRG/DAT/WEB/HIS/REC/SEC/CAP/UI/VER/ECO/RES/UPG and the
trusted-local 109 are BR/CAP/CMP/DATA/FS/ID/IPY/OBS/REC/RES/VER -- so a case-by-case join
on id is impossible and a family-level join would be a guess. This script therefore
records, for each authority case, the REQUIREMENT TEXT and the TIER, and leaves the
classification to a reader who can see both. It deliberately does NOT invent a verdict.

WHAT IT DOES ESTABLISH MECHANICALLY, and these are the facts a reader would otherwise
have to trust:
  - the authority's tier census,
  - which authority cases name a hard capacity (30) and therefore cannot be satisfied by
    a smaller N,
  - which authority cases need a live provider or paid evaluation and are therefore
    BLOCKED_EXTERNAL under the standing authorization,
  - and the complete list of evidence directories that exist, so a reader can see what
    the repo actually holds.
"""

import collections
import json
import pathlib
import re

AUTHORITY = 'qualification/specs/acceptance-spec.json'
TRUSTED = 'qualification/specs/acceptance-spec.trusted-local-v1.json'
RESULTS = pathlib.Path('qualification/results')

# Phrases that identify a case which cannot be run without authorization this project
# does not hold. Matched against the case's own requirement+stimulus+oracle text.
EXTERNAL_MARKERS = [
    '真实30provider', '30个非空child', '授权frontier', 'paid', 'live provider',
    '授权live', 'vendor benchmark', 'isolated executor VM', '隔离executor',
]
CAPACITY_MARKER = re.compile(r'\b30\b')


def text_of(case: dict) -> str:
    return ' '.join(str(case.get(k, '')) for k in ('requirement', 'stimulus', 'oracle'))


def main() -> int:
    authority = json.load(open(AUTHORITY, encoding='utf-8'))
    trusted = json.load(open(TRUSTED, encoding='utf-8'))

    print('=== the two specs, and why they cannot be joined on id ===')
    print(f'authority {AUTHORITY}: {len(authority["cases"])} cases, '
          f'statuses {sorted({c["status"] for c in authority["cases"]})}')
    print(f'trusted   {TRUSTED}: {len(trusted["cases"])} cases, '
          f'statuses {sorted({c["status"] for c in trusted["cases"]})}')
    af = collections.Counter(c['id'].split('-')[0] for c in authority['cases'])
    vf = collections.Counter(c['id'].split('-')[0] for c in trusted['cases'])
    print(f'authority families: {dict(sorted(af.items()))}')
    print(f'trusted   families: {dict(sorted(vf.items()))}')
    shared = set(af) & set(vf)
    print(f'families in BOTH: {sorted(shared)}  (so a family join is possible only for these)')
    print()

    print('=== the authority tier census ===')
    tiers = collections.Counter(c['tier'] for c in authority['cases'])
    for t, n in sorted(tiers.items()):
        mand = sum(1 for c in authority['cases'] if c['tier'] == t and c['mandatory'])
        print(f'  {t:16s} {n:3d}  ({mand} mandatory)')
    print()

    capacity = [c['id'] for c in authority['cases'] if CAPACITY_MARKER.search(text_of(c))]
    print(f'=== cases whose text names 30 (a smaller N does NOT satisfy them): {len(capacity)} ===')
    print('  ' + ' '.join(capacity))
    print()

    external = [c['id'] for c in authority['cases']
                if any(m.lower() in text_of(c).lower() for m in EXTERNAL_MARKERS)]
    print(f'=== cases whose text requires an authorization this project does NOT hold: {len(external)} ===')
    print('  ' + ' '.join(external))
    print()

    print('=== evidence the repo actually holds (top-level result directories) ===')
    dirs = sorted(p.name for p in RESULTS.iterdir() if p.is_dir())
    print(f'  {len(dirs)} directories')
    for d in dirs:
        n = sum(1 for _ in (RESULTS / d).rglob('*') if _.is_file())
        print(f'    {d:44s} {n:5d} files')
    print()

    out = {
        'authority_spec': AUTHORITY,
        'authority_case_count': len(authority['cases']),
        'authority_statuses': sorted({c['status'] for c in authority['cases']}),
        'authority_tiers': dict(tiers),
        'authority_families': dict(sorted(af.items())),
        'trusted_spec': TRUSTED,
        'trusted_case_count': len(trusted['cases']),
        'trusted_statuses': sorted({c['status'] for c in trusted['cases']}),
        'trusted_families': dict(sorted(vf.items())),
        'families_in_both': sorted(shared),
        'cases_naming_30': capacity,
        'cases_requiring_unauthorized_external': external,
        'result_directories': {d: sum(1 for _ in (RESULTS / d).rglob('*') if _.is_file())
                               for d in dirs},
        '_what_this_is': (
            'A MECHANICAL census, not a verdict. It records the tier counts, the cases '
            'whose text names 30, the cases whose text requires an authorization this '
            'project does not hold, and the evidence directories that exist. It does NOT '
            'classify any case as COVERED/PARTIAL/UNCOVERED: the two specs use disjoint '
            'family prefixes, so that classification needs a human or model reading both '
            'requirements side by side, and inventing it here would be the overclaim this '
            'project keeps recording.'
        ),
    }
    out_path = RESULTS / 'C9-coverage' / 'coverage.json'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding='utf-8')
    print(f'wrote {out_path.as_posix()}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
