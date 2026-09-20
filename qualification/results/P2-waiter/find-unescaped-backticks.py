import io
import re
import sys

p = sys.argv[1]
lines = io.open(p, encoding='utf-8', newline='').read().split('\n')
start = next(i for i, l in enumerate(lines) if l.startswith('export const PYTHON_CLIENT_SOURCE = `'))
end = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip() == '`')
print('template lines', start + 1, '..', end + 1)
bad = []
for i in range(start + 1, end + 1):
    line = lines[i]
    for m in re.finditer('`', line):
        pos = m.start()
        nbs = 0
        j = pos - 1
        while j >= 0 and line[j] == chr(92):
            nbs += 1
            j -= 1
        if nbs % 2 == 0:
            bad.append((i + 1, line[:90]))
print('UNESCAPED backticks:', len(bad))
for n, text in bad:
    print(' ', n, repr(text))
