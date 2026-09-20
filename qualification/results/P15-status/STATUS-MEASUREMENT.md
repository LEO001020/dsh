# P15 status measurement — raw output at 2e1b2c2

All commands run in D:\DSH\work\wt-p15 at HEAD 2e1b2c2d3657407ce7ac621b07b3307d3edd8df4.
Working tree clean except the writer's own untracked .writer-provision.json.

## 1. verify-spec.py (full validation)
```
$ python qualification/runners/verify-spec.py
spec      acceptance-spec.trusted-local-v1.json
identity  533c8cb08b2ccd7f...
cases     109
  BLOCKED_EXTERNAL=1, FAIL=13, PASS=95

verify-spec: 317 problem(s).
  - ID-01: evidence was filed under identity 0a0996f3944b5528... but the lock's identity is 533c8cb08b2ccd7f...
  - ID-01: evidence was filed under identity 0a0996f3944b5528... but the lock's identity is 533c8cb08b2ccd7f...
...
  ... and 237 more
exit 1
```

## 2. verify-spec.py --summary
```
$ python qualification/runners/verify-spec.py --summary
identity 533c8cb08b2ccd7f...  total 109
  CACHE/OBSERVABILITY    PASS=6
  COMPOSITION            FAIL=2, PASS=12
  CONCURRENCY            FAIL=1, PASS=12
  DATA                   FAIL=2, PASS=10
  FILESYSTEM             PASS=6
  IDENTITY               FAIL=3, PASS=3
  IPYTHON                BLOCKED_EXTERNAL=1, FAIL=2, PASS=12
  NATIVE BRIDGE          FAIL=1, PASS=11
  RECOVERY               FAIL=2, PASS=8
  RESEARCH               PASS=6
  VERIFICATION           PASS=9
  BLOCKED_EXTERNAL=1, FAIL=13, PASS=95
exit 0
```

## 3. verify-identity.py
```
$ python qualification/results/T1-spec/verify-identity.py

all 30 checks passed. The identity recomputes from the file.
This verifies arithmetic over files. It does not certify the deployment.
exit 0
```

## 4. doctor.py
```
$ python helpers/doctor.py
[ok  ] launcher_realpath                          exists and matches artifact_sha256
[ok  ] live ledger case ids match the frozen spec   109 ids, 109 filed

[info] promotion decision                        NOT_READY
[info] spec                                      qualification/specs/acceptance-spec.trusted-local-v1.json

doctor: 1 problem(s). The tree moved and the identity did not:
  - host_profile_digest is STALE: pinned 0e8e370e06375ad4... but profiles/daily-candidate/cordis.patch.yml hashes to 4e3aa20cbc23b8ce...

Re-derive the identity only after deciding the change is intended, and record
the superseded values in deployment.identity_history. Every PASS recorded
against the old identity is invalidated by the new one; that is intended.
exit 1
```
