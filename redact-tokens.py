"""Redact loopback session tokens from qualification artifacts before publishing.

WHY THIS IS A SCRIPT AND NOT A ONE-LINE sed. The redaction must be verifiable: the same
run has to report how many files and occurrences it changed, and the JSON artifacts have
to stay parseable afterwards. A silent in-place edit of 56 evidence files is exactly the
kind of change a reader cannot audit later.

THE PATTERN IS THE PROJECT'S OWN, quoted from qualification/results/M9.14-profile-config/
run-a12.mjs:106:

    const redact = (text) => text.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')

Reusing it rather than writing a second redactor is the point: a second redactor is a
second thing that can disagree about what a token looks like.

WHAT THESE TOKENS ARE. Per-boot nonces for the local `dsh web` host, bound to 127.0.0.1,
on ports that are long dead. The push-gate audit (.push-gate/P1-secrets.md) judged them
inert and also judged that they CONTRADICT the project's own stated redaction policy,
which is a credibility problem for an audit package rather than a security incident.
"""

import json
import pathlib
import re
import sys

PATTERN = re.compile(rb'token=[A-Za-z0-9_-]+')
REPLACEMENT = b'token=<redacted>'


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'qualification/results')
    changed_files = 0
    changed_occurrences = 0
    unparseable = []

    for path in sorted(root.rglob('*')):
        if not path.is_file():
            continue
        try:
            before = path.read_bytes()
        except OSError:
            continue
        occurrences = len(PATTERN.findall(before))
        if occurrences == 0:
            continue
        after = PATTERN.sub(REPLACEMENT, before)
        path.write_bytes(after)
        changed_files += 1
        changed_occurrences += occurrences
        if path.suffix == '.json':
            try:
                json.loads(after.decode('utf-8'))
            except Exception as exc:  # noqa: BLE001 -- reported, not raised
                unparseable.append(f'{path.as_posix()}: {exc}')
        print(f'{occurrences:3d}  {path.as_posix()}')

    print()
    print(f'files changed       : {changed_files}')
    print(f'occurrences changed : {changed_occurrences}')
    if unparseable:
        print()
        print('JSON FILES THAT NO LONGER PARSE -- the redaction must be repaired:')
        for row in unparseable:
            print('  ', row)
        return 1
    print('all JSON artifacts still parse')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
