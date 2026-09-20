"""Classify a graph.jsonl from the ID-01 recorder. Reused by S12's runs."""
import json
import re
import sys

path = sys.argv[1]
rows = []
with open(path, encoding='utf-8') as fh:
    for line in fh:
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass

seen = {}
for r in rows:
    spec = r.get('specifier', '')
    url = r.get('url', '')
    if not spec.startswith('@deepseek-ai/'):
        continue
    seen.setdefault(spec, url)

pkg_lib = re.compile(r'\\packages\\[^\\]+(\\[^\\]+)?\\lib\\', re.I)
vendor_lib = re.compile(r'\\vendor\\[^\\]+\\lib\\', re.I)
node_mods = re.compile(r'\\node_modules\\', re.I)


def norm(u):
    return u.replace('file:///', '').replace('/', '\\')


groups = {'packages_lib': [], 'vendor_lib': [], 'node_modules': [], 'OTHER': []}
for spec, url in sorted(seen.items()):
    p = norm(url)
    if pkg_lib.search(p):
        groups['packages_lib'].append((spec, p))
    elif vendor_lib.search(p):
        groups['vendor_lib'].append((spec, p))
    elif node_mods.search(p):
        groups['node_modules'].append((spec, p))
    else:
        groups['OTHER'].append((spec, p))

print('resolution lines: %d' % len(rows))
print('distinct @deepseek-ai specifiers: %d' % len(seen))
for k, v in groups.items():
    print('  %-14s %d' % (k, len(v)))
print()
print('NOT under packages/*/lib or vendor/*/lib or node_modules:')
for spec, p in groups['OTHER']:
    print('   %s' % spec)
    print('     -> %s' % p)
