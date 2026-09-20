# The FILESYSTEM family was filed by the root agent

## Why this file exists

The FILESYSTEM family (FS-01..FS-06) was assigned to an agent that produced
complete evidence and then stopped writing: `qualification/results/V7-fs/` holds a
`VERDICT.json` reporting **47/47 checks pass** plus the boot, transcript and probe
files, but no `GATES.md` and no filing. The agent had been asked twice, and the
last write was five minutes before the root agent took over. **Six mandatory cases
would have stayed unfiled against evidence that was already complete**, so the
root agent filed them and records the provenance here.

## What was measured, and by whom

**Every check below was measured by the FILESYSTEM agent**, captured in
`qualification/results/V7-fs/`:

| File | What it is |
|---|---|
| `VERDICT.json` | 47/47 checks, with the installed and repository composition digests recorded so the run is bound to a composition |
| `boot.json` | the boot that produced them: port, timedOut, exitCode, portReleased |
| `transcript.txt` | the probe's own output |
| `sandbox-crlf-probe.json`, `crlf-probe.json` | the CRLF measurements against both backends |
| `fs06-verification-gates.txt`, `t9c-tests.txt` | the test transcripts |
| `python-newline-measurement.txt` | the CPython text-mode translation measurement |

**The root agent ran nothing for this family and wrote no probe.** It read the
VERDICT's own check list and mapped each case to the checks that establish its
oracle. That is a filing from existing evidence, and it is worth less than one
produced by a family that also wrote its `GATES.md` — which is why this file
exists rather than a quiet edit to the spec.

## The mapping

| Spec case | Establishing checks (from VERDICT.json) | Verdict |
|---|---|---|
| FS-01 | the write outside the workspace SUCCEEDS; the file exists; `fsSandboxMode` is undefined; the escalation fields are ABSENT from the write/edit schemas; the deployment says in its own words that no write confinement is claimed; the spec itself lists write confinement as NOT claimed | PASS |
| FS-02 | the read outside the workspace succeeds through the NATIVE tool AND through a PYTHON cell; both routes reach the SAME BYTES (digest compared) | PASS |
| FS-03 | four routes — native `read`, native `grep`, a spawned process, a Python cell — all reach the same digest; "all four routes reached the same file in one world" | PASS |
| FS-04 | symlink, hardlink and cross-boundary rename each attempted and recorded separately; the two link vectors shown to have actually reached the mutation; the rename did not corrupt content; the moved file read at its new path | PASS |
| FS-05 | read with offset/limit returns EXACTLY the requested window; an exact unique replacement applies once; an ambiguous replacement is REFUSED and changed nothing; an absent literal is refused with its own code | PASS |
| FS-06 | the store root resolves OUTSIDE the workspace; an object's address IS its content digest; a same-named workspace file does NOT change the store object; immutability is enforced by the OS (EACCES), not by DSH policy | PASS |

## Three findings recorded inside FS-06, not folded into green

The oracle requires that "assuming an artifact is immutable merely because a cell
can write a same-named path is NOT PASS", and the checks go further than that in
three ways worth naming:

1. **The relative store path and the session-relative path are DIFFERENT files** —
   recorded as a finding, so a reader does not assume one route reaches the other.
2. **The read-only bit is NOT a boundary** — the same OS user can clear it. The
   check says so rather than presenting EACCES as a policy.
3. **The READ PATH does not detect tampering**: no error, tampered bytes returned.
   An explicit `verify()` DOES detect it, and `stat()` cannot either — it reports
   the ORIGINAL digest beside the tampered byte count. The probe restored the
   object it tampered, so the store is left as found.

**Point 3 is the strongest thing in this family** and it is a real defect in
disposition: an object store whose ordinary read path cannot tell that its bytes
changed, while a separate verification call can. It is not folded into the FS-06
PASS because the oracle is about workspace/store non-conflation, which holds.

## The label collision applies here too (G-SEAM-38)

`FS-06` in `verification-gates.test.ts` is **"a RAW PYTHON mutation is visible to
the verifier"** — a provenance case. The spec's `FS-06` is **"workspace files and
store-owned artifacts are not conflated"** — a data-plane case. Same label,
unrelated oracles. **The mapping above is by ORACLE.** A reader checking this
family should read the spec's oracle text, not the test names.
