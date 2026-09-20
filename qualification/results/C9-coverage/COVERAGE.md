# The 112-case acceptance authority, measured against this repository

**This is a census, not a verdict.** It records what can be established mechanically and
names precisely what cannot. It deliberately does NOT classify cases as
COVERED / PARTIAL / UNCOVERED, because that classification would be a guess dressed as a
finding — see "why a mapping is not possible" below.

---

## 1. The two specs, and why they cannot be joined on `id`

| | cases | statuses | families |
|---|---|---|---|
| `qualification/specs/acceptance-spec.json` (the authority) | **112** | `NOT_RUN` only | BRG, CAP, DAT, DEP, ECO, HIS, IPY, REC, RES, SEC, UI, UPG, VER, WEB |
| `qualification/specs/acceptance-spec.trusted-local-v1.json` | **109** | `PASS`, `FAIL`, `BLOCKED_EXTERNAL` | BR, CAP, CMP, DATA, FS, ID, IPY, OBS, REC, RES, VER |

The authority's copy in the user's audit package
(`delivery/acceptance-spec.json`) is byte-for-byte the same 112 cases: identical ids, the
same `schema_version: 2`, the same `target`, `hard_child_capacity: 30` and
`target_range: [1, 30]`. Its `AUDIT_STATUS.json` records `new_acceptance_status:
"ALL_NOT_RUN"` and `production_qualification: "NOT_READY"`.

**The family prefixes are DISJOINT except for five.** Only `CAP`, `IPY`, `REC`, `RES` and
`VER` appear in both, and even there the numbering does not correspond — the authority's
`CAP-01..08` and the trusted spec's `CAP-01..13` were authored independently. A join on
`id` is impossible; a join on family would be a guess. So the honest deliverable is the
authority's own census plus the evidence inventory, side by side, and a reader draws the
map.

## 2. The authority's tier census (all 112 mandatory)

| tier | cases | mandatory |
|---|---|---|
| `integration` | 72 | 72 |
| `fault_injection` | 16 | 16 |
| `security` | 16 | 16 |
| `evaluation` | 8 | 8 |

## 3. What cannot be established here, established mechanically

**`CAP-08` is the only case whose text names 30** ("30->1->30 持续调整并并发完成"). Every
other case's oracle can be satisfied at a smaller N. This matters because the project's
own capacity file warns that a reader must not read "30 real children were refused" out of
a run whose largest real N was 10 on a scripted adapter.

**`UPG-07` is the only case whose text requires an authorization this project does not
hold** ("真实30provider"; its oracle states that mock results do not substitute for this
gate). It is therefore `BLOCKED_EXTERNAL` under the standing constraint that no live API
budget is authorized — and note that holding a key would not change that, because holding
a key is not the same as authorization to spend.

Everything else in the `evaluation` tier (`ECO-01..08`) is about accounting and
measurement correctness and is runnable; what is not runnable is a *paid* comparison.

## 4. The evidence the repository actually holds

150 directories under `qualification/results/`, of which the largest are V9-verification
(49 files), C8-post-integration (63), V2-composition, V3-ipython, V4-bridge, V6-recovery,
V7-fs, V8-capacity and the M-series. The full inventory with per-directory file counts is
in `coverage.json` under `result_directories`, so a reader can see the shape without
trusting this prose.

## 5. What this document does NOT claim

It does not claim any of the 112 cases is covered. The trusted-local spec's 99 PASS
verdicts are statements about a DIFFERENT case set with different oracles, and inheriting
them across the disjoint prefixes would be exactly the weaker-oracle substitution this
project's rules forbid. Mapping them requires reading each authority requirement beside
the trusted spec's requirements and judging correspondence — a task that needs a reader
who can see both, and one that a script must not fake.

**The honest status of the 112 is the authority's own: `ALL_NOT_RUN`.** That is not a
measurement shortfall in this repository; it is the authority's baseline, and nothing in
this round changed it.
