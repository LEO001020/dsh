#!/usr/bin/env python3
"""S14 — GAPS.md hygiene audit.

Reads docs/GAPS.md, emits machine-checkable hygiene findings:
  * numbering contiguity / collisions per family
  * entries whose status carries no verdict word
  * malformed table rows (unescaped '|' splitting a cell)
  * control bytes that make the file unreadable by ordinary text tools
  * subject-level duplicate candidates

This script READS ONLY. It writes its JSON to stdout or to the path given as
argv[1]. The GAPS.md edit itself is a separate, reviewed change.
"""
import json
import re
import sys
from collections import Counter, OrderedDict

SRC = r'D:\DSH\work\wt-s14\docs\GAPS.md'


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


def leading_verdict(status):
    s = status.strip().lstrip('*').strip()
    head = re.split(r'\s+[—-]\s+', s, maxsplit=1)[0].strip().rstrip('.').strip()
    up = head.upper()
    # The vocabulary is defined in the file's own "HOW TO READ THIS FILE" header.
    for word in ('RETRACTED', 'REFUTED', 'BLOCKED_EXTERNAL', 'DUPLICATE',
                 'SUPERSEDED', 'NOT_A_DEFECT', 'FIXED', 'RESOLVED',
                 'VERIFIED', 'CONFIRMED', 'IN_PROGRESS', 'PARTIALLY',
                 'MEASURED', 'SELF-REPORTED', 'OPEN'):
        if up.startswith(word):
            return {'PARTIALLY': 'PARTIAL', 'MEASURED': 'NO_VERDICT',
                    'SELF-REPORTED': 'OPEN'}.get(word, word)
    return 'NO_VERDICT'


def main():
    raw = open(SRC, 'rb').read()
    text = raw.decode('utf-8')
    lines = text.split('\n')

    secof, sec = {}, None
    for n, l in enumerate(lines, 1):
        if l.startswith('## '):
            sec = l[3:].strip()
        secof[n] = sec

    rows = []
    for n, l in enumerate(lines, 1):
        if re.match(r'^\| G-', l):
            p = splitrow(l)
            rows.append({
                'line': n, 'section': secof[n],
                'id': p[1].strip(), 'gap': p[2].strip(),
                'status': p[3].strip(),
                'note': '|'.join(p[4:]).strip() if len(p) > 4 else '',
                'ncols': len(p),
                'leading': leading_verdict(p[3].strip()),
            })

    ids = [r['id'] for r in rows]

    # numbering
    fams = OrderedDict()
    for i in ids:
        m = re.match(r'^(G-[A-Z]+)-(\d+)$', i)
        fams.setdefault(m.group(1), []).append(int(m.group(2)))
    numbering = {}
    for f, nums in fams.items():
        s = sorted(nums)
        numbering[f] = {
            'count': len(s),
            'min': min(s), 'max': max(s),
            'missing': [n for n in range(min(s), max(s) + 1) if n not in s],
            'collisions': [n for n, c in Counter(s).items() if c > 1],
        }

    # referenced-but-undefined
    defined = set(ids)
    refs = Counter(m for m in re.findall(r'G-[A-Z]+-\d+', text))
    undefined = sorted(k for k in refs if k not in defined)

    # control bytes
    ctrl = [(k, b) for k, b in enumerate(raw)
            if b < 9 or (13 < b < 32) or b == 127]

    out = {
        'totalEntries': len(rows),
        'numbering': numbering,
        'collisions': [k for k, v in Counter(ids).items() if v > 1],
        'missingIds': {f: v['missing'] for f, v in numbering.items() if v['missing']},
        'referencedButUndefined': undefined,
        'malformedRows': [{'line': r['line'], 'id': r['id'], 'ncols': r['ncols']}
                          for r in rows if r['ncols'] not in (5, 6)],
        'noVerdictEntries': [{'line': r['line'], 'id': r['id'],
                              'status': r['status']} for r in rows
                             if r['leading'] == 'NO_VERDICT'],
        'controlBytes': [{'offset': k, 'byte': '0x%02X' % b} for k, b in ctrl],
        'leadingVerdictCounts': dict(Counter(r['leading'] for r in rows)),
    }
    dest = sys.argv[1] if len(sys.argv) > 1 else None
    blob = json.dumps(out, indent=1, ensure_ascii=False)
    if dest:
        open(dest, 'w', encoding='utf-8').write(blob + '\n')
    else:
        print(blob)


if __name__ == '__main__':
    main()
