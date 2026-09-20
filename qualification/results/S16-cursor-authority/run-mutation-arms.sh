# S16 MUTATION ARMS — does each new arm actually go red when the fix is broken?
#
# A green arm proves nothing until you have watched it fail. Each mutation below
# breaks the D-1 fix in a specific way, the two test files are run, and the failure
# count is recorded. Then `artifacts.ts` is restored and its sha256 re-checked against
# the pristine value, so a mutation can never be left behind.
#
# Usage, from packages/dsh-daily-work:
#   bash ../../qualification/results/S16-cursor-authority/run-mutation-arms.sh
#
# ONE test file at a time, per the round-2 brief §4: the two files are run in
# sequence, never concurrently.
set -u

PKG="$(cd "$(dirname "$0")/../../../packages/dsh-daily-work" && pwd)"
ART="$PKG/src/artifacts.ts"
OUT="$(cd "$(dirname "$0")" && pwd)/MUTATION-ARMS.txt"

PRISTINE_SHA=$(sha256sum "$ART" | cut -d' ' -f1)
echo "pristine artifacts.ts sha256: $PRISTINE_SHA"
echo "pristine artifacts.ts sha256: $PRISTINE_SHA" > "$OUT"

restore() {
  cp "$ART.s16-mutation-backup" "$ART"
  local now
  now=$(sha256sum "$ART" | cut -d' ' -f1)
  if [ "$now" != "$PRISTINE_SHA" ]; then
    echo "RESTORE FAILED: $now != $PRISTINE_SHA" | tee -a "$OUT"
    exit 1
  fi
}

cp "$ART" "$ART.s16-mutation-backup"

# Run both files and report passed/failed counts. The counts are what the arm is
# judged on: a mutation that changes nothing is a mutation that proves nothing.
# The ANSI escapes are stripped first, because vitest colourises the summary line and
# a pattern anchored on it silently matches nothing -- which is how a mutation run
# reports "no change" for a mutation that in fact reddened everything.
run_arms() {
  local label="$1"
  {
    echo ""
    echo "=== $label ==="
  } >> "$OUT"
  for file in data11-cursor-realm.test.ts data16-cursor-key-authority.test.ts; do
    local line
    line=$(node node_modules/vitest/vitest.mjs run "src/$file" 2>&1 \
      | sed -e 's/\x1b\[[0-9;]*m//g' \
      | grep -E "^ *(Tests|Test Files) " | tr '\n' ' ')
    echo "  $file -> ${line:-NO SUMMARY LINE}" >> "$OUT"
  done
  tail -2 "$OUT"
}

mutate() {
  local label="$1" from="$2" to="$3"
  python - "$ART" "$from" "$to" <<'PY'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
if text.count(frm) != 1:
    raise SystemExit(f'mutation anchor matched {text.count(frm)} times, expected 1: {frm!r}')
open(path, 'w', encoding='utf-8', newline='').write(text.replace(frm, to))
PY
  if [ $? -ne 0 ]; then echo "MUTATION ANCHOR FAILED: $label" | tee -a "$OUT"; restore; return 1; fi
  echo "  applied: $label"
}

# ---------------------------------------------------------------------------
# M1 — REVERT THE FIX: key the MAC from the descriptor again, exactly as D-1 was.
# This is the historical regression. It must redden the position and realm forgery
# arms AND the key-provenance arms; if it reddens nothing, the new arms are decorative.
# ---------------------------------------------------------------------------
mutate "M1 key from the descriptor again (the D-1 regression)" \
  "    authority = new CursorAuthority(await store.cursorKey(), descriptor.schemaVersion)" \
  "    authority = new CursorAuthority(\`\${descriptor.id}:\${descriptor.captured.sha256}:\${descriptor.authority.ownerScope}:\${descriptor.authority.grantRevision}\`, descriptor.schemaVersion)"
run_arms "M1 key derived from the descriptor (the D-1 regression)"
restore

# ---------------------------------------------------------------------------
# M2 — A KEY DERIVED FROM THE REALM. This is the specific wrong design the brief
# asked to be argued against: the realm is DISCLOSED (in the cursor, and named in
# refusals), so a key derived from it is public. If the arms do not catch this, they
# only catch the exact historical string rather than the CLASS.
# ---------------------------------------------------------------------------
mutate "M2 key derived from the disclosed realm id" \
  "    authority = new CursorAuthority(await store.cursorKey(), descriptor.schemaVersion)" \
  "    authority = new CursorAuthority(\`k:\${storeRealmId}\`, descriptor.schemaVersion)"
run_arms "M2 key derived from the realm (a disclosed value)"
restore

# ---------------------------------------------------------------------------
# M3 — DROP position FROM THE MAC. The MAC covers the whole tuple; if position were
# not covered, a caller could edit it and re-sign nothing. This mutation is the
# reason the position arm is worth having: it isolates the FIELD from the KEY.
# ---------------------------------------------------------------------------
mutate "M3 position excluded from the signed payload" \
  "    const payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
    return \`\${payload}\${CURSOR_SEPARATOR}\${this.sign(payload)}\`" \
  "    const { position: _dropped, ...withoutPosition } = full
    const payload = Buffer.from(JSON.stringify(withoutPosition), 'utf8').toString('base64url')
    return \`\${payload}\${CURSOR_SEPARATOR}\${this.sign(payload)}\`"
run_arms "M3 position not covered by the MAC"
restore

# ---------------------------------------------------------------------------
# M4 — ACCEPT A TRUNCATED KEY. Remove the length bound. The truncated-key arm must
# redden; without this mutation, that arm could be passing for an unrelated reason.
# ---------------------------------------------------------------------------
mutate "M4 the minimum key length is not enforced" \
  "  if (record.cursorKey.length < MIN_CURSOR_KEY_CHARS) {" \
  "  if (false) {"
run_arms "M4 truncated key accepted"
restore

# ---------------------------------------------------------------------------
# M5 — REGENERATE A MALFORMED KEY INSTEAD OF REFUSING. This is the "looks like a
# security property, is actually data loss" failure the realm design names.
# ---------------------------------------------------------------------------
mutate "M5 malformed key silently regenerated" \
  "  const record = parsed as Partial<StoreCursorKeyRecord>
  if (typeof record.cursorKey !== 'string' || record.cursorKey.length === 0) {" \
  "  const record = parsed as Partial<StoreCursorKeyRecord>
  if (true) {
    return { cursorKey: randomBytes(32).toString('base64url'), keyId: 'regenerated', createdAt: '', storeVersion: '' }
  }
  if (typeof record.cursorKey !== 'string' || record.cursorKey.length === 0) {"
run_arms "M5 malformed key regenerated instead of refused"
restore

# ---------------------------------------------------------------------------
# M6 — LEAK THE KEY INTO A REFUSAL. The disclosure arm must redden: a refusal that
# names the key hands it to the caller it is protecting against.
# ---------------------------------------------------------------------------
mutate "M6 the key is disclosed in a refusal message" \
  "        refuse(new ArtifactError(
          'pagination cursor names a different store realm than the one serving this request, and its MAC does '
          + 'not verify under this store\\'s cursor key; a cursor is not a bearer token and cannot be replayed '
          + 'against another store'," \
  "        refuse(new ArtifactError(
          'pagination cursor names a different store realm than the one serving this request, and its MAC does '
          + 'not verify under this store\\'s cursor key (' + await store.cursorKey() + '); a cursor is not a bearer '
          + 'token and cannot be replayed against another store',"
run_arms "M6 key leaked into a refusal message"
restore

# ---------------------------------------------------------------------------
# M7 — PER-CALL KEY RESOLUTION. Remove the memo. The paging path then re-reads the
# key file per page, which the hot-path arm and the no-re-read control must catch.
# ---------------------------------------------------------------------------
mutate "M7 the key is not memoized" \
  "  async cursorKey(): Promise<string> {
    if (this.cursorKeyValue !== undefined) return this.cursorKeyValue" \
  "  async cursorKey(): Promise<string> {
    if (false) return this.cursorKeyValue as string"
run_arms "M7 key not memoized (per-call file read)"
restore

# ---------------------------------------------------------------------------
# M8 — A PER-BOOT KEY. Mint a fresh key every process instead of reading the file.
# This is the design that looks like a security property and is a restart bug, so the
# durability arms must redden.
#
# NOTE ON A FIRST VERSION OF THIS MUTATION THAT PROVED NOTHING: it was written as
# `if (existing !== undefined && process.env['S16_PER_BOOT'] !== '1')`, so the
# per-boot branch was only taken when an environment variable was set -- and the test
# run never set it. Every arm stayed green and the run looked like a gap in the arms
# when it was a gap in the MUTATION. A mutation that cannot fire is a mutation that
# proves nothing, which is the same failure mode the arms themselves exist to catch.
# It is unconditional now, and the fact that it reddens is what makes the durability
# arms evidence.
# ---------------------------------------------------------------------------
mutate "M8 the key is per-boot rather than durable" \
  "  const existing = await readStoreCursorKeyRecord(path)
  if (existing !== undefined) return existing.cursorKey" \
  "  const existing = await readStoreCursorKeyRecord(path)
  if (existing !== undefined) return randomBytes(32).toString('base64url')"
run_arms "M8 per-boot key (a restart bug wearing a security property)"
restore

# ---------------------------------------------------------------------------
# M9 — THE REALM COMPARISON DISABLED. The shared-key block was added because the
# realm check would otherwise be unreachable after the fix; this mutation is what
# proves the block is not decorative. It must redden the shared-key arm and the
# different-store arms.
# ---------------------------------------------------------------------------
mutate "M9 the realm comparison is a no-op" \
  "  assertRealm(cursor: PageCursor, storeRealmId: string): void {
    if (cursor.storeRealmId !== storeRealmId) {" \
  "  assertRealm(cursor: PageCursor, storeRealmId: string): void {
    if (false && cursor.storeRealmId !== storeRealmId) {"
run_arms "M9 realm comparison disabled"
restore

# ---------------------------------------------------------------------------
# M10 — THE REALM FIELD MINTED AS A CONSTANT. Distinct from M9: here the realm is
# carried and compared, but it is not the STORE's realm, so two stores mint tokens
# that name the same value. The cross-store arms must redden.
# ---------------------------------------------------------------------------
mutate "M10 the minted realm is a constant" \
  "      nextCursor: authority.mint({
        storeRealmId," \
  "      nextCursor: authority.mint({
        storeRealmId: 'realm_fixed_for_every_store',"
run_arms "M10 realm field minted as a constant"
restore

# ---------------------------------------------------------------------------
# M0 — THE HARNESS'S OWN CONTROL: a mutation that changes nothing observable.
# A rename of a local with the same value must leave both files GREEN. Without this
# arm, a harness that reported "red" for every input would look like a success.
# ---------------------------------------------------------------------------
mutate "M0 control: a no-op restatement (must stay GREEN)" \
  "  const revision = revisionOf(descriptor)" \
  "  const revision = revisionOf(descriptor) // s16 no-op control"
run_arms "M0 no-op control (both files must stay GREEN)"
restore

echo ""
echo "=== RESTORED ==="
final=$(sha256sum "$ART" | cut -d' ' -f1)
echo "artifacts.ts sha256 after all mutations: $final"
if [ "$final" != "$PRISTINE_SHA" ]; then echo "MISMATCH -- mutation left behind"; exit 1; fi
{
  echo ""
  echo "=== RESTORED ==="
  echo "artifacts.ts sha256 after all mutations: $final"
  echo "matches pristine: yes"
} >> "$OUT"
rm -f "$ART.s16-mutation-backup"
echo "OK: every mutation restored, artifacts.ts is byte-identical to pristine."
