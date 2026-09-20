# S14 — verification record

Every claim S14 makes about the tree, with the exact command and what it
returned. Measured at `fef7612`, worktree `D:\DSH\work\wt-s14`, no test suite
run (the slice needed none; the round-2 brief forbids stressing the machine).

Nothing in this file is a runtime measurement by S14. Where a claim needs a
runtime fact, the round-1 artifact that measured it is cited and marked
`[ROUND-1]`.

---

## A. The nine now-false claims

### G-SEAM-20 — "the shipped profile installs NO launch port"

```
$ grep -rn "setLaunchPort\|installDefaultLaunchPort" packages/ --include=*.ts | grep -v "\.test\.ts"
packages/dsh-daily-work/src/host.ts:533:  setLaunchPort(port: LaunchPort): void {
packages/dsh-daily-work/src/host.ts:563:  private installDefaultLaunchPort(root: Agent): void {
packages/dsh-daily-work/src/host.ts:700:    this.installDefaultLaunchPort(input.root)
```
`host.ts:700` is inside `createRun` (declared `:685`). The port IS installed on
the production create path. `[ROUND-1] R4-authorization/report-after.json`.

### G-SEAM-31 — "nothing in the product creates a run"

```
$ grep -rn "authorizeRun" packages/*/src/ --include=*.ts | grep -v "\.test\.ts"
packages/dsh-daily-work/src/command-work.ts:252:    const settled = await service.authorizeRun({
packages/dsh-daily-work/src/host.ts:942:  async authorizeRun(input: {
$ grep -n "daily-work-command" profiles/daily-candidate/presets/daily-standard/agent.cordis.yml
384:- id: daily-work-command
385:  name: dsh-daily-work/command
```
The command plugin is mounted in the deliverable preset. `[ROUND-1]`
`R4-authorization/report-after.json` records `runsForThisSession=1` after a real
`/work start 10`, with `authorizationRef` naming the human command.

### G-SEAM-34 — "nothing in the product ever constructs a `BridgeServer`"

```
$ grep -rn "new BridgeServer" packages/dsh-ipython/src/ --include=*.ts | grep -v test
packages/dsh-ipython/src/kernel-plugin.ts:493:    const bridge = new BridgeServer({
```
`[ROUND-1] R5-bridge/composition-tier.json` — `bridgePresentAfterBoot: true`,
`bridgeEndpointPort: 4191`.

### G-SEAM-33 — "`defaultMode` is `workspace-write`"

```
$ grep -n "danger-full-access" profiles/daily-candidate/cordis.patch.yml
539:    mode: danger-full-access
$ python -c "import json; d=json.load(open('qualification/results/R1-trusted-local/composition-after.json'))"
  -> 'danger-full-access' present, 'workspace-write' absent
```
The `before` file (`composition-before.json`) contains BOTH strings — it is the
archived reproduction.

### G-SEAM-41 — "not refused across a different STORE"

```
$ grep -n "assertRealm" packages/dsh-daily-work/src/artifacts.ts
1513:  assertRealm(cursor: PageCursor, storeRealmId: string): void {
1755:      authority.assertRealm(cursor, storeRealmId)
```
`:1755` is on the paging path, before the reference is resolved. Test file:
`packages/dsh-daily-work/src/data11-cursor-realm.test.ts`.

### G-SEAM-45 — "all K admit"

```
$ sed -n '1955,2032p' packages/dsh-daily-work/src/host.ts
  ... "The previous implementation coalesced like this (`host.ts`, before this
       change): const inFlight = this.pendingDrain.get(runId) ..."
  ... "The fix here is a generation/dirty loop: one leader per run runs passes
       while requestedGeneration > handledGeneration"
$ grep -n "COALESCER" packages/dsh-daily-work/src/f5-admission.test.ts
1121:  it('WITH THE COALESCER DEFEATED: concurrent reservations still never exceed the target', ...
```

### G-SEAM-54 — "the bridge route has NO disposition vocabulary"

```
$ grep -c "disposition" packages/dsh-ipython/src/bridge.ts packages/dsh-ipython/src/native-call.ts
packages/dsh-ipython/src/bridge.ts:39
packages/dsh-ipython/src/native-call.ts:0
```
All four members appear: `settled`, `cancelled`, `handed-to-jobs` (`:649`),
`abandoned-unstarted` (`:648`). `[ROUND-1] R5-bridge/composition-tier.json`
records a durable ledger row with disposition `settled`.

### G-SEAM-40 — "two of six stages have zero producers"

```
$ python -c "print(open('packages/dsh-daily-work/src/observations.ts').read()[i:i+700])"
export const OBSERVATION_GAP_STAGES = [
  'provider-acquisition', 'native-acquisition', 'transform', 'retention',
] as const
```
Four members. `OBSERVATION_SCHEMA_VERSION = 2`. The reasoning for removing the
other two is written at `observations.ts:75-137`. `[ROUND-1] R8-taxonomy-split/`.

### G-SEAM-48 — "the project's own gate depends on the stricter checker"

```
$ grep -n "typecheck" package.json
29:    "typecheck": "node helpers/typecheck.mjs",
$ ls helpers/typecheck.mjs
helpers/typecheck.mjs
```
The script's own header states it derives the package set from
`packages/*/tsconfig.check.json` and refuses to report success if the resolved
config contains no `*.test.ts`.

---

## B. Entries left OPEN, confirmed still open

| id | command | result |
|---|---|---|
| `G-SEAM-63` | `grep -n installDefaultLaunchPort packages/dsh-daily-work/src/host.ts` | `:563` definition, `:700` sole caller (inside `createRun`). `resume()` (`:1178`) installs none. **Still open.** |
| `G-SEAM-44` | `grep -rn kernel-lifecycle packages/dsh-daily-work/src/*.ts \| grep -v test` | no non-test importer; `package.json` `exports` does not list it. **Still open.** |
| `G-SEAM-53` | `grep -rn provenanceFromFetch packages/dsh-daily-work/src/*.ts \| grep -v test` | field exists, optional; no search caller populates it. **Still open.** |
| `G-SEAM-52` | `grep -n searchProvider` in `D:/DSH/src/dsh-src/packages/bundle/base/cordis.patch.yml` | `:461 searchProvider: deepseek-official`; ported row carries `id: daily-search`. **Still open.** |
| `G-SEAM-61` | `grep -rl "D:/DSH/work/dsh-native-daily/qualification/results" qualification/runners/*.mjs \| wc -l` | 22; denominator now 46 (entry says 38). **Still open.** |
| trailing row 4 | `grep -rn "\.history(" packages/dsh-daily-work/src/*.ts \| grep -v test` | none. **Still open.** |
| trailing row 5 | `grep -n "this.disposed\|signal.aborted" packages/dsh-daily-work/src/host.ts` | `:2116` only. The cited `:490-492` / `:1265-1266` have moved. **Still open; line numbers stale.** |
| `G-SEAM-49`/`62` | `cd /d/DSH/src/dsh-src && git status --porcelain && git rev-parse HEAD` | ` M packages/deliverables/workspace-changes/src/index.ts`; HEAD `ddefc45f…`. One dirty entry, matching `G-SEAM-62`. |

## C. G-TODO questions answered in the tree

```
$ grep -n "ctx.terminals" docs/DSH_SEAMS.md          -> :370  §6.1
$ grep -n "terminalController" docs/DSH_SEAMS.md     -> :406  §6.2
$ grep -n "storageDomain" docs/DSH_SEAMS.md          -> :151  §4
$ grep -n "disarm" docs/DSH_SEAMS.md                 -> :294, :319, :328-340
$ grep -n "waterfall\|serial" docs/DSH_SEAMS.md      -> :557-560, :590, :596
$ grep -n "Windows" docs/DSH_SEAMS.md                -> :423  §6.3
```
`G-TODO-01, 02, 04, 05, 07` have answers in `docs/DSH_SEAMS.md`. **Left as
`IN_PROGRESS`**: the TODO rows are the file's own "not yet investigated"
register, and closing them is a claim about the SEAMS document's completeness
that is not S14's to make. The observation is recorded here so the owner can.

## D. The hygiene measurements

```
$ python qualification/results/S14-gaps/audit-gaps-hygiene.py hygiene-before.json
$ python qualification/results/S14-gaps/audit-gaps-hygiene.py hygiene-after.json
```

| | before | after |
|---|---|---|
| entries | 108 | 109 |
| malformed rows | 6 | 0 |
| control bytes | 3 | 0 |
| no-verdict statuses | 1 | 0 |
| id collisions | 0 | 0 |
| missing ids | `G-FIX: [10]` | none |
| referenced-but-undefined | `G-FIX-10`, `G-WEB-01`, `G-WEB-03` | `G-WEB-01`, `G-WEB-03` (aliases, now documented) |

```
$ file docs/GAPS.md
before: (the Read tool refused it: "Unsupported or binary text encoding")
after:  Unicode text, UTF-8 text, with very long lines (6955)
```

The three control bytes and their intended text:

| offset | byte | intended | cause |
|---|---|---|---|
| 93831 | `0x08` | `\broker.py` | `\b` escape-processed |
| 117369 | `0x00` | `\u0000` | NUL written literally |
| 133056 | `0x08` | `\broker.py` | `\b` escape-processed |

Plus, in `G-SEAM-62`: `\relocated` had its `\r` become a newline (cutting the row
in half) and `\2026` its `\2` become U+0082. Same defect class as `G-FIX-11`.

## E. The edit is auditable

```
$ python qualification/results/S14-gaps/apply-gaps-hygiene.py --check
38 edits applied; 109 entries; no control bytes; all rows well-formed
--check: not writing
```

The script asserts every replacement matches **exactly once**, and refuses to
write unless: no control bytes remain, every `| G-… |` row has 5 or 6 cells, and
the row count is exactly 109. **Re-running it against the edited file aborts on
its first assertion** (`AssertionError: header matched 0 times`) rather than
applying anything twice — that is the control that proves the script is not
silently re-editing a file it has already edited.

```
$ python -c "compare GAPS.before.md with docs/GAPS.md"
G-SEAM-21 identical before/after: True   (1102 chars both)
rows before: 108   rows after: 109
```
