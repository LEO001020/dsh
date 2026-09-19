import json, collections, sys, os

tot = 0
files = 0
for path in sys.argv[1:]:
    if not os.path.exists(path):
        print("MISSING", path)
        continue
    d = json.load(open(path))
    res = d.get('testResults', d) if isinstance(d, dict) else d
    n_tot = 0
    n_files = 0
    for f in res:
        n = len(f.get('assertionResults', []) or [])
        n_tot += n
        n_files += 1
    print("FILE", path, "files=", n_files, "tests=", n_tot)
    tot += n_tot
    files += n_files
print("TOTAL files=", files, "tests=", tot)
