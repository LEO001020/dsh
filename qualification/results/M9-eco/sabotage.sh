#!/bin/bash
# Falsification harness for M9-eco.
#
# WHY IT RUNS ON A COPY. The first version of this harness mutated the live
# `src/perf-metrics.ts` in place and restored it afterwards. The shared
# `tsconfig.check.json` typecheck is a resource other gates read, and the
# coordinator sampled the tree INSIDE a mutation window and saw the errors a
# removed narrowing produces. The mutation was real, the errors were real, and
# the report was about a state that existed for a few seconds. That is a false
# alarm caused by this harness, so the harness now works on a COPY of the package
# and the live tree is never in a mutated state at all.
#
# WHERE THE COPY LIVES, AND WHY. It is created as a SIBLING of the real package
# inside `packages/`, not under `/tmp`. Two measured reasons: the package's
# `node_modules` is a tree of Windows JUNCTIONS into the pinned checkout, and
# `cp -r` of a junction to another volume fails with "Operation not permitted";
# and a copy under `packages/` can reach the real `node_modules` through a single
# junction, so every `@deepseek-ai/*` import resolves exactly as it does in the
# real suite. The copy is removed in a trap, including on failure.
#
# Usage: bash sabotage.sh <output-file>
set -u

OUT="${1:-sabotage.txt}"
SRC=/d/DSH/work/dsh-native-daily/packages/dsh-daily-work
PKG=/d/DSH/work/dsh-native-daily/packages/.eco-sabotage-copy

cleanup() { rm -rf "$PKG"; }
trap cleanup EXIT

echo "building the copy at $PKG (the live tree is not modified)" >&2
cleanup
mkdir -p "$PKG"
cp -r "$SRC/src" "$PKG/src"
cp "$SRC/package.json" "$SRC/tsconfig.json" "$SRC/tsconfig.check.json" "$SRC/vitest.config.ts" "$PKG/"
# ONE junction for the whole dependency tree, so every import resolves as it does
# in the real package. Created through POWERSHELL, not `cmd /c mklink /J`: MSYS
# rewrites the `/J` switch into a path before cmd sees it, and `cmd //c` opens an
# interactive shell instead of running the command -- both measured, both of which
# produced a copy whose suite reported "no tests" because the import failed.
# `New-Item -ItemType Junction` needs no elevation, unlike a symlink.
powershell -NoProfile -Command \
  "New-Item -ItemType Junction -Path '$(cygpath -w "$PKG/node_modules")' -Target '$(cygpath -w "$SRC/node_modules")' | Out-Null"

export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"

run_suite() {
  ( cd "$PKG" && npx vitest run src/eco.test.ts --maxWorkers=1 --no-file-parallelism 2>&1 ) \
    | sed 's/\x1b\[[0-9;]*m//g' > /tmp/eco-sab-run.txt
  grep -aE "^ +Tests " /tmp/eco-sab-run.txt | tail -1
  # The NAMES of the tests that broke, so each mutation's claim is checkable
  # rather than taken on the count alone.
  grep -aE "^ × " /tmp/eco-sab-run.txt | sed 's/^ × /    BROKE: /' | cut -c1-160
  # And a guard against the failure mode this harness itself hit: a mutation that
  # never applied reports a clean run, which reads identically to a test that
  # cannot fail. The "APPLIED" line above is what distinguishes them, and this
  # makes its absence fatal rather than a note.
}

# Restore the copy's source from the LIVE tree, which is read-only for this
# script. Reading the live file is the restore, so the copy can never drift.
restore() { cp "$SRC/src/perf-metrics.ts" "$PKG/src/perf-metrics.ts"; cp "$SRC/src/record.ts" "$PKG/src/record.ts"; }

{
  echo "# Falsification: do the ECO tests actually fail when the property is broken?"
  echo "#"
  echo "# A test that cannot fail proves nothing. Each mutation below was applied to a"
  echo "# COPY of the package (see this script's header for why), the suite was run"
  echo "# there, and the live tree was never in a mutated state."
  echo "#"
  echo "# The control run at the end is the unmutated copy."
  echo

  echo "COMMAND (identical for every row, run inside the copy):"
  echo "  cd <copy> && npx vitest run src/eco.test.ts --maxWorkers=1 --no-file-parallelism"
  echo "Each row below reports the tests that FAILED, by name, under that command."
  echo

  echo "=== CONTROL: the unmutated copy ==="
  run_suite
  echo

  echo "=== S1: the unknown-usage guard is removed ==="
  echo "#     priceAttempt stops returning early for an absent usage, so an unknown"
  echo "#     attempt reaches the priced path and is charged as if it were measured."
  echo "#     Expected to break ECO-02."
  ECO_SAB_FILE="$PKG/src/perf-metrics.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace('  if (usage === undefined) {', '  if (false) {', 1)
assert s != s2, 'S1 did not apply'
print('S1 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== S2: the cross-provider guard is removed, and a foreign cache-write field is accepted ==="
  echo "#     One vendor's price table is applied to another's tokens, and a"
  echo "#     cache-write count from a protocol that has no such field is priced"
  echo "#     instead of refused. Expected to break ECO-03."
  ECO_SAB_FILE="$PKG/src/perf-metrics.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace('  if (input.provider !== pricing.provider) {', '  if (false) {', 1)
s2 = s2.replace('    if (usage.cacheWriteTokens > 0) {', '    if (false) {', 1)
assert s != s2, 'S2 did not apply'
print('S2 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== S3: the token delta is read from the MONEY lines again, and the shadow spends ==="
  echo "#     The exact bug this case found in its own module: reportCostDelta"
  echo "#     computes the token delta from byLine (currency) instead of byTokens."
  echo "#     Plus a shadow that increments its own request counter. Expected to break"
  echo "#     ECO-05 and ECO-06."
  ECO_SAB_FILE="$PKG/src/perf-metrics.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace(
    '  const tokensBefore = before.byTokens.promptTotal\n  const tokensAfter = after.byTokens.promptTotal',
    '  const tokensBefore = before.byLine.freshInput + before.byLine.cachedInput\n'
    '  const tokensAfter = after.byLine.freshInput + after.byLine.cachedInput', 1)
s2 = s2.replace(
    '  observe(label: string, live: string): ShadowObservation {\n    const shadow = this.#project(live)',
    '  observe(label: string, live: string): ShadowObservation {\n    this.llmRequests += 1\n'
    '    const shadow = this.#project(live)', 1)
assert s != s2, 'S3 did not apply'
print('S3 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== S4: the cache-storage line is dropped from the total, and an unknown is marked known ==="
  echo "#     Two omissions ECO-03 and ECO-02 name: a charge line that exists but is"
  echo "#     never added, and a gap that reports itself as measured. Expected to break"
  echo "#     both."
  ECO_SAB_FILE="$PKG/src/perf-metrics.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace('    byLine.cacheStorage += entry.charges.cacheStorage ?? 0',
               '    byLine.cacheStorage += 0', 1)
s2 = s2.replace('    known: false,', '    known: true,', 1)
assert s != s2, 'S4 did not apply'
print('S4 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== S5: completeness ignores unknown attempts, and the price book falls back ==="
  echo "#     A total that calls itself complete with a gap in it, and an unregistered"
  echo "#     provider priced with whichever table happens to be first. Expected to"
  echo "#     break ECO-02 and ECO-03."
  ECO_SAB_FILE="$PKG/src/perf-metrics.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace('    complete: unknownAttempts === 0 && unpricedLines.size === 0 && currencies.size <= 1,',
               '    complete: unpricedLines.size === 0 && currencies.size <= 1,', 1)
s2 = s2.replace('    const found = this.tables.get(provider)\n    if (found === undefined) {',
                '    const found = this.tables.get(provider) ?? [...this.tables.values()][0]\n'
                '    if (found === undefined) {', 1)
assert s != s2, 'S5 did not apply'
print('S5 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== S6: percentiles interpolate instead of reporting an observed sample ==="
  echo "#     The p95 becomes a value between two observations and the p95IsMax flag is"
  echo "#     hardcoded false, so a five-sample p95 is reported as a real tail."
  echo "#     Expected to break the perf instrumentation case."
  ECO_SAB_FILE="$PKG/src/perf-metrics.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace(
    '  const rank = Math.ceil((percentileValue / 100) * sorted.length)\n'
    '  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))\n'
    '  const value = sorted[index]',
    '  const position = (percentileValue / 100) * (sorted.length - 1)\n'
    '  const lower = sorted[Math.floor(position)] ?? 0\n'
    '  const upper = sorted[Math.ceil(position)] ?? 0\n'
    '  const value = lower + (upper - lower) * (position - Math.floor(position))', 1)
s2 = s2.replace('      p95IsMax: percentileOf(sorted, 95) === last,', '      p95IsMax: false,', 1)
assert s != s2, 'S6 did not apply'
print('S6 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== S7: the conservative reservation is released instead of held ==="
  echo "#     holdUnknown stops holding and retainAsUnknown releases rather than moving"
  echo "#     the amount, so an unreported charge looks free and the commitment total"
  echo "#     falls. Expected to break ECO-02's admission-refusal case."
  ECO_SAB_FILE="$PKG/src/record.ts" python - <<'PY'
import os
p = os.environ['ECO_SAB_FILE']
s = open(p, encoding='utf-8').read()
s2 = s.replace('  return { ...budget, unknownReserved: budget.unknownReserved + held }',
               '  return { ...budget, unknownReserved: budget.unknownReserved }', 1)
s2 = s2.replace('    reserved: budget.reserved - moved,\n    unknownReserved: budget.unknownReserved + moved,',
                '    reserved: budget.reserved - moved,\n    unknownReserved: budget.unknownReserved,', 1)
assert s != s2, 'S7 did not apply'
print('S7 APPLIED to', p)
open(p, 'w', encoding='utf-8').write(s2)
PY
  run_suite
  restore
  echo

  echo "=== CONTROL (restored copy) ==="
  run_suite
} > "$OUT" 2>&1

echo "wrote $OUT" >&2

