#!/usr/bin/env python3
"""S14 — emit the classification table for every entry in docs/GAPS.md.

Reads the CURRENT file and prints a markdown table: id, line, one-line subject,
verdict, and (where S14 verified the claim against code) the verification.

Run:  python classify-gaps.py > CLASSIFICATION.md
"""
import re
import sys

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
    for word in ('RETRACTED', 'REFUTED', 'BLOCKED_EXTERNAL', 'DUPLICATE',
                 'SUPERSEDED', 'NOT_A_DEFECT', 'FIXED', 'RESOLVED',
                 'VERIFIED', 'CONFIRMED', 'IN_PROGRESS', 'PARTIALLY',
                 'MEASURED', 'SELF-REPORTED', 'OPEN'):
        if up.startswith(word):
            return {'PARTIALLY': 'PARTIAL', 'MEASURED': 'NO_VERDICT',
                    'SELF-REPORTED': 'OPEN'}.get(word, word)
    return 'NO_VERDICT'


def subject(gap):
    s = gap.strip().lstrip('*').strip()
    s = s.rstrip('*').strip()
    s = re.sub(r'\s+', ' ', s)
    if len(s) > 130:
        s = s[:127].rstrip() + '...'
    return s.replace('|', '\\|')


def main():
    lines = open(SRC, encoding='utf-8').read().split('\n')
    print('| id | line | subject | verdict |')
    print('|---|---|---|---|')
    n = 0
    for i, l in enumerate(lines, 1):
        if re.match(r'^\| G-', l):
            p = splitrow(l)
            n += 1
            print('| `%s` | %d | %s | **%s** |' % (
                p[1].strip(), i, subject(p[2]), leading_verdict(p[3])))
    sys.stderr.write('%d entries\n' % n)


if __name__ == '__main__':
    main()
