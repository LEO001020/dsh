"""S2 scratch: total sweep for surviving claims of the deleted recovery guarantee.

Searches the WHOLE repo except node_modules, the pinned checkout, and the R9
evidence directory (which legitimately documents the deletion), for the claim
vocabulary. Prints file:line and a short excerpt so I can classify each hit.
"""
import pathlib
import re

ROOT = pathlib.Path('D:/DSH/work/wt-s2')
SKIP_DIRS = {'node_modules', '.git', 'lib', 'dist', 'coverage'}

# The vocabulary of the deleted guarantee. `epoch` alone is too broad (KERNEL
# epoch, G-SEAM-43), so each pattern is recorded with why it is in the list.
PATTERNS = {
    'applyWorkerSettlement': r'applyWorkerSettlement',
    'WorkerSettlement': r'WorkerSettlement',
    'RefusalLedger': r'RefusalLedger',
    'refusals-domain': r'dsh_daily_work_refusals',
    'run-epoch': r'run\s*`?epoch|run-epoch|run epoch',
    'stale-epoch': r'stale[- ]epoch|stale generation|superseded generation|被取代世代',
    'settlement': r'settlement',
    'INV-L3': r'INV-L3',
}

hits = {k: [] for k in PATTERNS}
for path in ROOT.rglob('*'):
    if not path.is_file():
        continue
    parts = set(path.parts)
    if parts & SKIP_DIRS:
        continue
    rel = path.relative_to(ROOT).as_posix()
    if rel.startswith('qualification/results/R9-recovery-topology/'):
        continue
    if rel.startswith('.s2-'):
        continue
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        continue
    for name, pat in PATTERNS.items():
        for m in re.finditer(pat, text, re.IGNORECASE):
            line = text[:m.start()].count('\n') + 1
            start = text.rfind('\n', 0, m.start()) + 1
            end = text.find('\n', m.end())
            if end == -1:
                end = len(text)
            hits[name].append((rel, line, text[start:end].strip()[:150]))

for name in PATTERNS:
    print(f'===== {name}: {len(hits[name])} hits =====')
    for rel, line, excerpt in hits[name]:
        print(f'  {rel}:{line}')
        print(f'      {excerpt}')
    print()
