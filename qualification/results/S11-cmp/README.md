# S11 — CMP-02 and CMP-04, measured on a live boot

**Slice:** the two composition facts, measured on a real boot with a probe that
adds NO row.

**Measured on:** worktree `D:\DSH\work\wt-s11`, branch `wt/s11`, HEAD `fef7612`,
DSH_HOME `D:\DSH\home\s11`, pinned checkout `D:\DSH\src\dsh-src` (read-only,
untouched). Every digest is in `MEASUREMENT.json.identity`.

**One boot at a time.** Four boots total, each a separate process invocation:
`healthy-probe`, `confined-probe`, `healthy-noprobe`, `confined-noprobe`. No
arm was ever run concurrently with another.

---

## The result

| case | verdict | the measurement |
|---|---|---|
| **CMP-02** | **PASS** | the row is present and its mode is a LITERAL `danger-full-access`; the service resolves it; a real Session resolves it with no override; the model is told `danger-full-access` and NOT `workspace-write`; the guard recorded the startup boundary as satisfied |
| **CMP-04** | **PASS** | 27 tools for one real Session, `ipython` present, `work` present, `pwsh` absent, no error, `presetRoots` names `D:/DSH/home/s11/profiles/daily/presets/`, through a probe that inserts no tool row |
| **CMP-13** (CMP-04's dependency) | **PASS** | `pwsh` absent AND no shell-equivalent (`bash`/`shell`/`run_code`) present, `ipython` present, full name set recorded |

### CMP-04's catalog, VERBATIM — 27 names

```
ask_user_question  create_goal  edit  exit_plan_mode  get_goal  glob  grep
interrupt_agent  ipython  job_kill  job_list  job_output  list_agents  present
read  read_image  send_message  skill  subagent  subagent_fork  todo_write
update_goal  web_fetch  web_search  work  workflow  write
```

`ipython` parameters: `["code"]` — exactly one, as the contract requires.

Read in registry order, the same 27 are:

```
work  read  write  edit  glob  grep  job_output  job_list  job_kill  skill
ask_user_question  web_search  web_fetch  present  ipython  read_image
send_message  interrupt_agent  list_agents  todo_write  workflow  get_goal
create_goal  update_goal  exit_plan_mode  subagent_fork  subagent
```

Both orderings are in `healthy-probe.json` and in `MEASUREMENT.json.catalogVerbatim`.

**The count is recorded, NOT pinned.** The v2 oracle explicitly refuses a pinned
integer, so nothing in this evidence compares the count to 27 or 28.

---

## Files

| file | what it is |
|---|---|
| `healthy-probe.json` | the measurement: CMP-02, CMP-04, CMP-13, and the instrument's own falsification arm |
| `confined-probe.json` | the mode-sensitivity control — a COPY of the profile with `mode: workspace-write` |
| `healthy-noprobe.boot.json` | the loudness CONTROL — real profile, NO probe in the tree |
| `confined-noprobe.boot.json` | the loudness ARM — confined copy, NO probe in the tree |
| `dumpconfig-baseline.txt` | the composed profile tree WITHOUT the overlay, from the launcher's own `--dump-config` |
| `dumpconfig-with-probe.txt` | the same tree WITH the overlay — the two differ by exactly one row |
| `MEASUREMENT.json` | every check and its verdict, COMPUTED from the artifacts above |
| `mutation/` | the gate's own mutation test — see below |

Runners: `qualification/runners/s11-cmp-probe.mjs` (the probe),
`s11-cmp-probe.patch.yml` (its one-row overlay),
`s11-cmp-driver.mjs` (one boot per invocation), `s11-cmp-verdict.mjs` (computes
the verdicts; types nothing).

---

## "The probe adds no row" — how it is established

This is load-bearing: if the probe mounted a tool row, the catalog would be the
probe's, not the product's. **Three independent instruments** establish it, and
none of them is an assertion:

1. **The composed tree diff.** `--dump-config` without the overlay vs with it.
   The entire diff is three lines:
   ```
   645a646,648
   > # == D:\DSH\work\wt-s11\qualification\runners\s11-cmp-probe.patch.yml
   > - id: s11-cmp-probe
   >   name: file:///D:/DSH/work/wt-s11/qualification/runners/s11-cmp-probe.mjs
   ```
   One row, and it is the probe. No `tool-*`, no `sandbox-policy`, no
   `webserver` row.

2. **The live loader table.** `healthy-probe.json.loader.probeRowIds` is exactly
   `["s11-cmp-probe"]`, and
   `probeAddsNoRow.overlayToolRows` is `[]` — a row whose `name` resolved to a
   tool package would appear there.

3. **The sensitivity arm — the part that makes the other two mean something.**
   The probe reads the real catalog, then REGISTERS a sentinel tool through the
   live registry, then re-reads, then disposes and reads a third time:

   | reading | count | sentinel present |
   |---|---|---|
   | before | 27 | no |
   | after `tools.register(sentinel)` | **28** | **yes** |
   | after `dispose()` | 27 | no |

   If the measurement channel could not see a probe-added row, every catalog
   number above would be worthless. It can, and it does. The real catalog is read
   **before** the sentinel exists, so the sentinel cannot contaminate it.

---

## The negative arm

`D:/DSH/home/s11/profiles/daily-s11-confined` is a **COPY** of the installed
profile with the one line `mode: danger-full-access` changed to
`mode: workspace-write`. **The real profile was not edited** — its patch digest
is `0e8e370e…`, byte-identical to `profiles/daily-candidate/cordis.patch.yml` in
the repo, both before and after this work. The confined copy is `65b6ade7…`.

What the confined copy produced:

- **The narration flips**, which is what makes the positive measurement
  meaningful: the same channel that said *"Current DSH file policy:
  danger-full-access. The DSH file sandbox does not restrict file modifications
  by available operations."* now says *"Current DSH file policy:
  workspace-write. Any available operation enforced by the DSH file sandbox may
  modify files under the session workspace: "C:\\Windows\\Temp"…"*. The sentence
  is a LIVE render — it interpolates the session cwd.
- **The PTC confine decision flips** to `WOULD CONFINDE`.
- **The guard's own entry FAILED** (`state: 3`), and `ctx.noSandboxContract` is
  not published — the refusal throws from `apply`'s own body, so the entry dies.
- **The deployment is REFUSED loudly, with no probe in the tree**
  (`confined-noprobe.boot.json`): stderr carries
  `warning: 1 entry did not activate`, names
  `daily-no-sandbox-contract (dsh-daily-work/no-sandbox-contract)`, carries the
  refusal text `trusted-local contract violated at the startup boundary`, names
  the failing check id `startup.sandboxPolicy.mode`, and reports the observed
  mode `'workspace-write'`.

The healthy probe-free control is served, has **empty stderr**, and carries no
activation warning. The two arms are distinguishable on stderr, which is the
property R1's silent-startup fix was for.

---

## The settle re-read — a real race, resolved by measurement

The probe's first loader read reported `ui-deliverables` and `hmr` in state 1
(LOADING). That reading is taken while `apply` is still running, so it is a
timing fact about the probe's own instant, not a statement about the
composition. Rather than assert either way, the probe **waits for the tree to
settle and reads again**, and the artifact carries both readings:

| arm | non-ACTIVE at `apply` time | non-ACTIVE after settle |
|---|---|---|
| healthy | `hmr`, `ui-deliverables`, the probe itself (all LOADING) | **none** |
| confined | `hmr`, `ui-deliverables`, `daily-no-sandbox-contract` (FAILED), the probe | **`daily-no-sandbox-contract`, FAILED** |

The post-settle read is the one that can report a REAL failure, and it does — on
the confined arm only. The product's own activation audit, which runs after
`loader.await()` (`packages/boot/app-boot/src/index.ts:955-957`), agrees with the
post-settle reading.

---

## The gate's own mutation test

Nine mutations, each written over the artifact its group reads, verdict
recomputed, real artifact restored. **Every group is reachable** — no group
passes unconditionally. Control (`RESTORED-UNMUTATED`): all groups PASS.

| mutation | group that went red |
|---|---|
| A: declared mode → `workspace-write` | `cmp02` |
| B: append `pwsh` to the recorded catalog | `cmp04` **and** `cmp13` |
| C: sensitivity arm reports it cannot see a probe row | `cmp04` |
| D: probe error recorded | `artifacts` |
| E: healthy control's stderr made non-empty | `control` |
| F: confined arm's stderr made silent | `negativeArm` (and `control`, correctly) |
| G: confined copy made not-confined | `negativeArm` |
| H: healthy arm left with a FAILED entry after settle | `settle` |
| I: artifact made to name ANOTHER home | `provenance` (and `artifacts`) |

**Mutation B found a real defect in the first version of the verdict script,**
and it is recorded rather than smoothed over: CMP-13 originally read the PROBE's
own derived booleans (`cmp13.pwshAbsent`, …), so appending `pwsh` to the catalog
flipped CMP-04 red while CMP-13 stayed green. CMP-13 was restating CMP-04's
conclusion instead of reading the catalog. Both cases now RECOMPUTE from the
name set, and the probe's derived flags are kept only as an agreement
cross-check. Details in `s11-cmp-verdict.mjs` above the CMP-13 block.

Three couplings are **correct rather than defects** and are recorded as such:
F also flips `control` (the control asserts the two arms are distinguishable);
B flips both catalog cases (one catalog answers both, which is why CMP-04
depends on CMP-13); I flips `provenance` and `artifacts` (a foreign home breaks
both ownership checks).

Full record: `mutation/GATE-MUTATION.json`.

---

## CMP-04's dependency on CMP-13 — satisfied

CMP-04's v2 entry lists `dependencies: ["CMP-13"]`, whose oracle is that `pwsh`
(and any equivalent shell tool) is ABSENT while `ipython` is present. Measured
from the same session catalog: `pwsh` absent, and the WIDENED shell-equivalence
set (`pwsh`, `bash`, `shell`, `run_code`) is entirely absent, while `ipython` is
present. So the dependency is satisfied and CMP-04's verdict is available.

---

## Boundary statement

**Nothing was removed.** The pinned checkout `D:\DSH\src\dsh-src` is untouched
and read-only for this wave; no upstream code was deleted or edited. What is
measured is the *exposure* of this worktree's composed daily profile. A reader
must not mistake the measured surface for a claim about upstream code.

The negative arm's profile is a COPY under the DSH_HOME, outside the repository.
`profiles/**` in the repo was not edited (`git status --porcelain profiles/` is
empty).
