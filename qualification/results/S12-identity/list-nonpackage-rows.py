"""List the vendor and node_modules rows of a graph, to read the strict clause."""
import json
import re
import sys

path = sys.argv[1]
seen = {}
with open(path, encoding='utf-8') as fh:
    for line in fh:
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        spec = r.get('specifier', '')
        if spec.startswith('@deepseek-ai/'):
            seen.setdefault(spec, r.get('url', ''))

BS = chr(92)  # backslash


def norm(u):
    return u.replace('file:///', '').replace('/', BS)


B = re.escape(BS)
vendor = re.compile(B + 'vendor' + B + '[^' + B + ']+' + B + 'lib' + B, re.I)
node_mods = re.compile(B + 'node_modules' + B, re.I)

for label, pat in (('VENDOR', vendor), ('NODE_MODULES', node_mods)):
    rows = sorted((s, norm(u)) for s, u in seen.items() if pat.search(norm(u)))
    print('%s (%d):' % (label, len(rows)))
    for s, u in rows:
        print('   %s' % s)
        print('     -> %s' % u)
    print()
