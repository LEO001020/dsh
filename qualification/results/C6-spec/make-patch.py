"""
Build the CMP-04 note-correction payload as DATA, without applying it.

This script READS the spec and WRITES only under qualification/results/C6-spec/.
It never writes to qualification/specs/ -- the coordinator owns that file.

It also proves the replacement is an exact, unique match in the raw bytes, so
the coordinator can apply it without guessing at whitespace.
"""
import hashlib
import json

SPEC = 'qualification/specs/acceptance-spec.trusted-local-v1.json'
OUT = 'qualification/results/C6-spec/PATCH-cmp04-note.json'

raw = open(SPEC, encoding='utf-8').read()
d = json.loads(raw)


def case(cid):
    return next(c for c in d['cases'] if c['id'] == cid)


c04, c13 = case('CMP-04'), case('CMP-13')

NEW_C04_NOTE = (
    "SPEC DEFECT, recorded rather than edited, and the FAIL is CORRECT UNDER THIS ORACLE. "
    "This oracle and CMP-13's cannot both hold for one catalog. The cause is an ordering accident, "
    "measured from git: this case was authored at 2026-09-20 04:59:30 (f6ac93c) requiring "
    "`toolCountAgentKey is 28` and `pwsh is present`, and commit 35c829d at 05:18:50 then disabled "
    "`tool-pwsh` unconditionally in the daily preset so that IPython became the model's only execution "
    "surface. The spec's own rules forbid editing an oracle after the fact, so the contradiction is "
    "recorded rather than erased, and the status stays FAIL: under THIS oracle the catalog genuinely "
    "does not match, and the mismatch belongs to the ORACLE, not to the product. This case's other "
    "three clauses all hold (measured: ipythonToolPresent true, workToolPresent true, error null), and "
    "the catalog is intact. It is NOT repaired by editing 28->24 and present->absent, which the spec "
    "forbids twice ('no PASS by editing an oracle after the fact'; 'a case may only be marked PASS "
    "when that file establishes THIS oracle') and which would silently erase the record that the spec "
    "and the deployment diverged.\n"
    "\n"
    "RE-VERIFIED ON THE CURRENT TREE, AND THE NUMBER HAS MOVED AGAIN SINCE THIS FAIL WAS FILED. "
    "Measured from a foreign cwd with a probe that inserts NO tool row: toolCountAgentKey is 24 (not "
    "the 27 recorded on this case), `pwsh` is ABSENT, `ipython` and `work` are PRESENT, `error` is "
    "null, and presetRoots names the home actually booted. The gap is fully reconciled by TWO "
    "committed composition changes, with no unexplained row: "
    "24 + {subagent, subagent_fork, workflow} (d8b95cb, 20:50:47) = 27, the count recorded here; "
    "27 + {pwsh} (35c829d, 05:18:50) = 28, the count this oracle pins. All eight recorded 28-valued "
    "measurements that carry a name set include `pwsh` in that same set, and NO recorded measurement "
    "reaches 28 with `pwsh` absent. The 28 pin therefore encoded a COMPOSITION FACT, not a different "
    "way of counting.\n"
    "\n"
    "THE ALTERNATIVE EXPLANATION WAS TESTED AND IS FALSE: this is not an artifact of HOW the count is "
    "taken. Three other scope keys were measured on the same boot (the agent-context key and the "
    "unscoped global view: both 0), and two session cwds (a foreign directory and the repository root: "
    "both 24). A control that re-enabled `tool-pwsh` and changed nothing else moved the count 27 -> 28 "
    "and added exactly `pwsh` "
    "(qualification/results/S4-v2-rejudge/runs/cmp-pwsh-control/verdict.json). No choice of key, cwd or "
    "preset reproduces this oracle on the current catalog, so the two oracles are in genuine conflict "
    "about the CATALOG itself.\n"
    "\n"
    "RESOLUTION: ALREADY DECIDED AND ALREADY BUILT, which is why this note is updated and the oracle is "
    "not. The delivery decision is D1 (docs/decisions/V3-v2-oracle-resolutions.md): v2 states the "
    "CURRENT architecture -- `ipython` present, `work` present, `pwsh` ABSENT, `error` null, and the "
    "tool count MEASURED INTO THE EVIDENCE rather than pinned -- while CMP-13 is unchanged. That "
    "decision is implemented in qualification/specs/acceptance-spec.trusted-local-v2.definition.json, "
    "the acceptance definition this deployment now declares (compatibility.expected.json -> "
    "acceptance_definition.contract_id \"trusted-local-v2\"), and the rewrite is recorded as treatment "
    "\"rewritten\" with dropped_assertions [\"toolCountAgentKey is 28\", \"pwsh is present\"] in "
    "acceptance-spec.trusted-local-v2.provenance.json. v1 stays frozen with BOTH oracles and BOTH "
    "verdicts intact, which is exactly what D1 requires and is the reason this case is not edited into "
    "a PASS.\n"
    "\n"
    "THE COST OF SUPERSEDING IS ALREADY PAID, so it is no longer a reason to leave this open. The "
    "alternative this note originally posed -- 'supersede this spec with a corrected revision under a "
    "NEW identity (which invalidates every verdict filed under 0a0996f3)' -- has ALREADY HAPPENED. The "
    "deployment identity has moved to 533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb "
    "(compatibility.lock.json), which records that every verdict bound to 0a0996f3 -- including all 109 "
    "filed cases of this spec -- is STALE as evidence for the current identity and must be re-measured. "
    "Note the mechanism, because it bounds what a later editor may safely do: the pinned identity input "
    "is the digest of the FROZEN as-authored snapshot "
    "(qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json, pinned as "
    "trusted_local_acceptance_spec_sha256), NOT of this live ledger, and helpers/doctor.py checks this "
    "ledger only for case-id shape. So editing THIS note does not move the identity; what is forbidden "
    "is editing the ORACLE, which would erase the record of the divergence. The 19-minute ordering "
    "accident is preserved as history in the frozen snapshot, and the corrected case is v2's.\n"
    "\n"
    "Recorded by the root agent after the COMPOSITION family declined to choose unilaterally, which was "
    "correct; independently re-verified and re-measured by C6 "
    "(qualification/results/C6-spec/REPORT.md), which reached the same resolution and found no basis "
    "for the measurement-artifact alternative."
)

NEW_C13_NOTE = (
    "MATCHING CLARIFICATION, and CMP-13 is UNCHANGED as an oracle and still PASS -- its invariant "
    "survives the composition change that broke CMP-04. The 27-name set recorded in the evidence above "
    "is a HISTORICAL measurement and the count has since moved to 24: commit d8b95cb (20:50:47) "
    "disabled the four model-facing child-creation rows, so `subagent`, `subagent_fork` and `workflow` "
    "left the catalog. Re-measured on the current tree, `pwsh` is STILL ABSENT (as are `bash`, `shell` "
    "and `run_code`) and `ipython` is STILL PRESENT, so this case's oracle continues to hold and its "
    "PASS does not rest on the count. That asymmetry is the point worth recording: CMP-13 states an "
    "ARCHITECTURAL INVARIANT (the model-facing shell leaves the daily preset) which stays true across "
    "composition changes, while CMP-04's v1 oracle pinned a point-in-time composition fact. A pinned "
    "integer in an oracle is what turned a legitimate composition change into a product FAIL, which is "
    "why v2 measures the count into the evidence instead. See CMP-04's note and "
    "docs/decisions/V3-v2-oracle-resolutions.md D1."
)

# Prove the replacement target is an EXACT, UNIQUE literal in the raw bytes.
old_literal = json.dumps(c04['note'], ensure_ascii=False)[1:-1]
occurrences = raw.count(old_literal)
if occurrences != 1:
    raise SystemExit(f'REFUSING: the CMP-04 note literal matches {occurrences} times, expected exactly 1')
if json.loads('"' + old_literal + '"') != c04['note']:
    raise SystemExit('REFUSING: the extracted literal does not round-trip to the note value')

payload = {
    "patch_kind": "ACCEPTANCE_SPEC_NOTE_CORRECTION_NOT_AN_ORACLE_EDIT",
    "prepared_by": "C6 (writer, worktree D:/DSH/work/wt-c6, branch wt/c6)",
    "prepared_for": "the coordinator, who owns qualification/specs/acceptance-spec.trusted-local-v1.json",
    "target_spec_path": SPEC,
    "target_spec_sha256_at_preparation": hashlib.sha256(raw.encode('utf-8')).hexdigest(),
    "why_not_applied_here": "C6 is forbidden from editing qualification/specs/ and the coordinator owns this file. Applying it here would collide.",
    "what_this_does_NOT_do": [
        "It does NOT change any oracle.",
        "It does NOT change any status. CMP-04 stays FAIL and CMP-13 stays PASS.",
        "It does NOT touch the frozen as-authored snapshot, which is the pinned identity input.",
        "It does NOT move the deployment identity (verified: the pinned input is the frozen snapshot digest, not this live ledger).",
    ],
    "edits": [
        {
            "case_id": "CMP-04",
            "operation": "replace_note_only",
            "status_before": c04['status'],
            "status_after": c04['status'],
            "status_change": False,
            "old_note": c04['note'],
            "old_note_sha256": hashlib.sha256(c04['note'].encode('utf-8')).hexdigest(),
            "old_note_literal_occurrences_in_raw_spec": occurrences,
            "new_note": NEW_C04_NOTE,
            "new_note_sha256": hashlib.sha256(NEW_C04_NOTE.encode('utf-8')).hexdigest(),
        },
        {
            "case_id": "CMP-13",
            "operation": "add_note_key",
            "status_before": c13['status'],
            "status_after": c13['status'],
            "status_change": False,
            "old_note": None,
            "new_note": NEW_C13_NOTE,
            "new_note_sha256": hashlib.sha256(NEW_C13_NOTE.encode('utf-8')).hexdigest(),
            "optional": True,
            "why_optional": "CMP-13 needs no correction to be correct. This only cross-references the resolution and records that its cited count is historical.",
        },
    ],
    "measured_basis": {
        "current_toolCountAgentKey": 24,
        "current_pwsh_present": False,
        "current_ipython_present": True,
        "current_work_present": True,
        "current_error": None,
        "measurement": "qualification/results/C6-spec/c6-verdict.json",
        "arithmetic": "24 + {subagent,subagent_fork,workflow}(d8b95cb) = 27 ; 27 + {pwsh}(35c829d) = 28",
    },
}

with open(OUT, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2, ensure_ascii=False)
    fh.write('\n')

print('CMP-04 old note literal occurrences (must be 1):', occurrences)
print('spec digest at preparation:', payload['target_spec_sha256_at_preparation'])
print('statuses unchanged:', c04['status'], c13['status'])
print('payload written:', OUT)
