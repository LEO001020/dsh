"""S2 scratch: would re-running build-gates.py today FALSIFY the identity binding?

build-gates.py stamps `lock.deployment.identity` onto EVERY PASS row. gates.json
currently carries `ece4037a...`; the lock now carries `0a0996f3...`. If those
differ, a regeneration re-stamps 85 historical measurements with an identity they
were never taken under.

This imports the generator as a module, redirects its two output paths to a temp
directory, and runs it. NOTHING in the repository is written.
"""
import importlib.util
import json
import pathlib
import tempfile

ROOT = pathlib.Path('D:/DSH/work/wt-s2')
GEN = ROOT / 'qualification' / 'runners' / 'build-gates.py'

spec = importlib.util.spec_from_file_location('build_gates_probe', GEN)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

tmp = pathlib.Path(tempfile.mkdtemp(prefix='s2-gates-probe-'))
mod.OUT = tmp / 'gates.json'
mod.SUMMARY = tmp / 'gates-summary.json'
rc = mod.main()

generated = json.loads(mod.OUT.read_text(encoding='utf-8'))
on_disk = json.loads((ROOT / 'qualification' / 'gates.json').read_text(encoding='utf-8'))

lock_identity = json.loads((ROOT / 'compatibility.lock.json').read_text(encoding='utf-8'))['deployment']['identity']

gen_ids = {g['deployment_identity'] for g in generated if 'deployment_identity' in g}
disk_ids = {g['deployment_identity'] for g in on_disk if 'deployment_identity' in g}

print('generator exit code      :', rc)
print('lock identity now        :', lock_identity)
print('identities in GENERATED  :', gen_ids)
print('identities in ON DISK    :', disk_ids)
print()
moved = [g['id'] for g in generated if g.get('deployment_identity') != None]
print('PASS rows that would be re-stamped with the current lock identity:', len(moved))
print()
d10_gen = next(g for g in generated if g['id'] == 'D10')
d10_disk = next(g for g in on_disk if g['id'] == 'D10')
print('D10 generated status/identity:', d10_gen['status'], d10_gen.get('deployment_identity'))
print('D10 on-disk  status/identity:', d10_disk['status'], d10_disk.get('deployment_identity'))
print()
print('temp dir (nothing in the repo was written):', tmp)
