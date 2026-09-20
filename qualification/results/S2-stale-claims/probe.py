"""S2 probe: does the tree still deliver what the deleted guarantee claimed?

Reproducible, read-only. Answers three questions against the CURRENT tree, so a
later reader can re-run it instead of trusting this directory's prose:

  1. Is any production module writing a terminal task state?  (a settlement
     producer would have to.)
  2. Is any production module reading or writing a run `epoch`?
  3. What are the run record's actual keys, read from the schema the product
     uses?

Exit code 0 means the facts hold; 1 means the tree has moved and this directory's
conclusions are stale.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path('D:/DSH/work/wt-s2')
SRC = ROOT / 'packages' / 'dsh-daily-work' / 'src'
TERMINAL = ('settling', 'confirmed', 'cancelled', 'cancel_requested')

def strip_comments(text: str) -> str:
    return '\n'.join(
        line for line in text.split('\n')
        if not re.match(r'^\s*(?://|\*|/\*)', line)
    )

production = sorted(
    p for p in SRC.glob('*.ts')
    if not p.name.endswith('.test.ts')
)

print('measured tree:', SRC.as_posix())
print('production modules:', len(production))
print()

# --- 1. terminal-state writers -------------------------------------------------
# R9's hardened call-site pattern: a call site ENDS with `,` or `}`. The loose
# form also matches a type annotation, which is how R9's first instrument both
# omitted a state and invented one (see R9's TEST-LEDGER.md 0.1).
CALL_SITE = re.compile(r"to:\s*'([a-z_]+)'\s*[,}]")
ANNOTATION = re.compile(r"to:\s*'([a-z_]+)'")

terminal_writers = {}
annotations = {}
for path in production:
    code = strip_comments(path.read_text(encoding='utf-8'))
    for m in CALL_SITE.finditer(code):
        if m.group(1) in TERMINAL:
            terminal_writers.setdefault(path.name, []).append(m.group(1))
    for m in ANNOTATION.finditer(code):
        if m.group(1) in TERMINAL and not CALL_SITE.match(code, m.start()):
            annotations.setdefault(path.name, []).append(m.group(1))

print('=== 1. PRODUCTION call sites targeting a TERMINAL state ===')
print('   terminal states:', ' | '.join(TERMINAL))
print('   writers found :', terminal_writers if terminal_writers else 'NONE')
print()

print('=== 1b. type annotations that mention a terminal state (must NOT count) ===')
print('   ', annotations if annotations else 'none')
print()

# --- 2. run-epoch references ---------------------------------------------------
# `kernel-lifecycle.ts` carries the KERNEL epoch, a different field sharing the
# word (G-SEAM-43), excluded by name -- the same exclusion R9 used.
epoch_files = {}
for path in production:
    if path.name == 'kernel-lifecycle.ts':
        continue
    code = strip_comments(path.read_text(encoding='utf-8'))
    if re.search(r'\bepoch\b', code):
        epoch_files[path.name] = [
            line.strip()[:110] for line in code.split('\n') if re.search(r'\bepoch\b', line)
        ]

print('=== 2. production modules referencing a RUN epoch (kernel excluded) ===')
print('   ', epoch_files if epoch_files else 'NONE')
print()

deleted_symbols = {}
for path in production:
    code = strip_comments(path.read_text(encoding='utf-8'))
    hits = [s for s in ('applyWorkerSettlement', 'RefusalLedger', 'WorkerSettlement') if s in code]
    if hits:
        deleted_symbols[path.name] = hits
print('=== 2b. deleted settlement symbols surviving in CODE (comments allowed) ===')
print('   ', deleted_symbols if deleted_symbols else 'NONE')
print()

# --- 3. the record schema ------------------------------------------------------
record = (SRC / 'record.ts').read_text(encoding='utf-8')
declares_epoch = bool(re.search(r'^\s*epoch:\s*z\.', record, re.M))
print('=== 3. runRecordSchema declares an epoch? ===')
print('   ', declares_epoch)
print('   documented removal present?', 'THERE IS NO `epoch` FIELD HERE' in record)
print()

# --- 4. positive controls ------------------------------------------------------
# Without these, every NONE above could be an empty negative of a broken scan.
print('=== 4. POSITIVE CONTROLS (the scan is not silently broken) ===')
host_code = strip_comments((SRC / 'host.ts').read_text(encoding='utf-8'))
nonterminal = sorted({m.group(1) for m in CALL_SITE.finditer(host_code)})
print('   call sites found in host.ts (non-terminal):', nonterminal)
kernel_code = strip_comments((SRC / 'kernel-lifecycle.ts').read_text(encoding='utf-8'))
print('   kernel-lifecycle.ts still mentions epoch :', bool(re.search(r'\bepoch\b', kernel_code)))
print()

ok = (
    not terminal_writers
    and not epoch_files
    and not deleted_symbols
    and not declares_epoch
    and 'unknown' in nonterminal
    and bool(re.search(r'\bepoch\b', kernel_code))
)
print('VERDICT:', 'FACTS HOLD' if ok else 'TREE HAS MOVED -- conclusions in this directory are STALE')
sys.exit(0 if ok else 1)
