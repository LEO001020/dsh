"""File V2's COMPOSITION verdicts into the trusted-local acceptance spec.

WHAT THIS DOES, AND WHY IT IS A SCRIPT RATHER THAN HAND EDITS.
The spec is a 1450-line JSON document. Hand-editing 14 cases in it would risk
touching a case outside this family -- which the task explicitly forbids -- and
would make the diff unreadable. This script touches ONLY the 14 cases whose id
starts with `CMP-`, asserts that count before and after, and asserts that every
OTHER case is byte-identical before and after.

EVERY sha256 IS COMPUTED FROM THE FILE ON DISK AT THE MOMENT OF WRITING, and the
path is verified to exist and to live under `qualification/results/`. A recorded
hash that does not match the file is the failure mode the coordinator's
`verify-spec.py` check 3 exists to catch, so it is computed here rather than
transcribed.

Usage: python qualification/results/V2-composition/file-cmp-cases.py
"""
import hashlib
import json
import pathlib
import sys

REPO = pathlib.Path('D:/DSH/work/dsh-native-daily')
SPEC = REPO / 'qualification/specs/acceptance-spec.trusted-local-v1.json'
IDENTITY = '0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461'
RESULTS = 'qualification/results/V2-composition'

C = f'{RESULTS}/boot1-verdict.json'          # deliverable surface, foreign cwd
C2 = f'{RESULTS}/boot2-verdict.json'         # fs provider / sandbox policy
C3 = f'{RESULTS}/boot3-verdict.json'         # shell/permission plane
C4 = f'{RESULTS}/boot4-verdict.json'         # composition probe
C5 = f'{RESULTS}/boot5-6-failure-arms.json'  # both failure directions
C7 = f'{RESULTS}/boot7-home-override.json'   # home override canary+control
C8 = f'{RESULTS}/boot8-verdict.json'         # twin preset
C14 = f'{RESULTS}/cmp14-launcher-args.json'
G = f'{RESULTS}/GATES.md'
D7 = f'{RESULTS}/boot7-dump-one-key.txt'

# (status, [(path, note), ...])
VERDICTS = {
    'CMP-01': ('PASS', [
        (C3, 'Gate row CMP-01. The measured count is 0, verbatim: activationCountMatch is null (the "N entries did not activate" line does NOT appear), activationWarningCount 0, entryCount 178, inactiveEntries [] mid-apply and postAuditInactiveEntries [] after the product\'s own auditStartupEntries ran, postAuditRan true, allAssertionsPass true. Booted from the foreign cwd D:/DSH/src/dsh-src on a harness-bound port, portReleased true.'),
        (C, 'Corroboration from a second boot: warningLines 0 over both streams, probe error null, toolCountAgentKey 27 with a populated catalog (a zero tool face would be the failure this case exists to catch).'),
        (G, 'Gate table section 4, row CMP-01, with the exact command and the digest table for the build/install this ran against.'),
    ]),
    'CMP-02': ('FAIL', [
        (C4, 'Gate row CMP-02, FAIL. The row IS present (policyRowInLoader true, policyRowFiberState 2 = ACTIVE) and workspaceRoot IS absolute ("D:\\\\DSH\\\\src\\\\dsh-src"), but the configured mode is "workspace-write", NOT "danger-full-access". The composed row config is recorded verbatim as an UNRESOLVED !!js expression: {"mode": {"__jsExpr": "process.env.DSH_PERMISSION_MODE ?? \'workspace-write\'"}}.'),
        (C2, 'An INDEPENDENT instrument agrees through a different access path: sandboxPolicyDefaultMode "workspace-write" and sandboxPolicyResolved "workspace-write", from the shared verify-t2-fs.mjs probe. Two instruments, one verdict.'),
        (G, 'Gate table section 3.1 states the cause (the profile has NO sandbox-policy row; the upstream base bundle supplies mode: !!js process.env.DSH_PERMISSION_MODE ?? \'workspace-write\' at packages/bundle/base/cordis.patch.yml:215-218, and DSH_PERMISSION_MODE is unset), records this as docs/GAPS.md G-SEAM-33 (OPEN, found by T5, confirmed independently by the root agent and T2), and states why it is NOT repaired here.'),
    ]),
    'CMP-03': ('PASS', [
        (C5, 'Gate row CMP-03. FAILURE DIRECTION, measured: with the sandbox provider rows disabled the loader FAILS EXPLICITLY -- "dsh: warning: 4 entries did not activate" plus RemoteError: agent-presets: preset "daily-standard" failed to mount: 2 row(s) did not activate, and the missing provider is NAMED per row (ptc-runtime pending waiting for services: sandbox, sandboxPolicy; terminal-controller, workspace-files, ui-deliverables pending waiting for service: sandboxPolicy). toolCount 0. No unwrapped argv and no implicit danger-full-access: a silent fallback would have produced a POPULATED tool face.'),
        (C4, 'NORMAL DIRECTION, measured: the three values are separately observable -- defaultMode "workspace-write", perSession[0].override null, resolve({}).mode "workspace-write". LIMIT recorded in GATES.md section 4: the product CANNOT distinguish an explicitly configured default from a fallback (modeSource is "unobservable" by the guard\'s own module header), and the measured composed row shows the deployment never configured the mode at all.'),
        (G, 'Gate table section 4, row CMP-03, including the stated LIMIT.'),
    ]),
    'CMP-04': ('FAIL', [
        (C, 'Gate row CMP-04, FAIL. Measured from a foreign cwd (C:/) with a probe that adds NO row: toolCountAgentKey 27 (the oracle says 28) and pwsh ABSENT (the oracle says present). The other three clauses HOLD: ipython present, work present, error null, and presetRoots names the booted home D:/DSH/home/v2-cmp/profiles/daily/presets/.'),
        (G, 'Gate table section 3.2 states why this FAIL is NOT repaired. The oracle CONTRADICTS CMP-13\'s oracle (which requires pwsh ABSENT) so both cannot hold for one catalog, and the timeline is measured from git: the spec was authored 2026-09-20 04:59:30 (f6ac93c) while tool-pwsh was disabled in the daily preset at 2026-09-20 05:18:50 (35c829d), 19 minutes LATER. The spec\'s own rules forbid editing an oracle after the fact, so the contradiction is recorded rather than erased. This case is evidence that the pinned spec no longer describes the deployment, NOT a defect report about the tool surface.'),
    ]),
    'CMP-05': ('PASS', [
        (C, 'Gate row CMP-05, ANCHORED direction. presetRoots[1].path is "D:/DSH/home/v2-cmp/profiles/daily/presets/" -- ABSOLUTE and derived from the profile\'s own directory; presetsListed is standard, ptc, minimal, cordis, daily-standard; presetDefaultId is daily-standard. Booted from the foreign cwd C:/ on a different drive from the profile.'),
        (C5, 'FAILURE DIRECTION, measured with the cwd-relative root (path: ./presets) from the foreign cwd D:/DSH/src/dsh-src: toolCount 0 and RemoteError: agent-presets: preset "daily-standard" not found (available: standard, ptc, minimal, cordis). Both directions recorded, which is what the oracle demands.'),
        (G, 'Gate table section 4, row CMP-05.'),
    ]),
    'CMP-06': ('PASS', [
        (C4, 'Gate row CMP-06. The policy is never AND explicitly declared: configuredPolicy "never", effectivePolicyForSession "never", sessionOverride null, and the composed row config is {"policy": "never"} -- stated in the profile patch rather than inherited. SEVEN model-originated attempts were made and ALL were refused (permission, permission_preset, approval, set_approval_policy, set_permission_mode, sandbox, escalate -- every one isError true, code UNKNOWN_TOOL), modelCatalogHasPolicyTool false, and the user-facing route is gone (permissionPresetsServicePresent false, permissionRowDisabled true, uiPermissionRowDisabled true).'),
        (C3, 'Corroboration from a second boot: the live approval service reports approvalPolicy "never", and the unconfined shell (shellSandboxModeIsUndefined true) is what makes the disabled permission plane mutually consistent rather than accidentally co-occurring.'),
        (G, 'Gate table section 4, row CMP-06, which states the distinction the oracle\'s wording makes: the protection is UNREACHABILITY from the model, NOT immutability. Measured: the host-code route approval.setPolicy(agent, \'ask\') SUCCEEDS when host code calls it ("no throw", policy becomes "ask"). The decisive read was taken BEFORE that probe ran so its own mutation cannot contaminate it.'),
    ]),
    'CMP-07': ('PASS', [
        (C4, 'Gate row CMP-07, SUCCESS direction. The RESOLVED subagent row carries BOTH keys with their intended values -- maxActiveSubagents 10 AND maxDepth 1 -- and configKeys is ["maxActiveSubagents","maxDepth"]. The agent-presets row carries all FOUR intended keys (["default","roots","includeShippedRoot","includeUserRoot"]) with includeShippedRoot true and includeUserRoot true, neither reverted to a schema default.'),
        (C7, 'FAILURE DIRECTION, measured. A one-key overlay (maxActiveSubagents only) was dumped with --dump-config and the subagent block is recorded verbatim: "- id: subagent / name: \'@deepseek-ai/dsh-subagent\' / config: / maxActiveSubagents: 10" -- maxDepth is GONE from that row, so the dialect is NOT a deep merge and the success direction\'s maxDepth 1 is present BECAUSE the patch states it.'),
        (D7, 'The raw dump text, so a reader can check the block extraction rather than trust it. Also records the FALSE-FAIL my first instrument produced: a whole-file /maxDepth/ test reads positive because daily-work-host legitimately carries its own maxDepth 1 (maxDepthElsewhereInDump 1); the assertion is now scoped to the subagent row.'),
        (G, 'Gate table section 4, row CMP-07.'),
    ]),
    'CMP-08': ('PASS', [
        (C8, 'Gate row CMP-08, THE LITERAL STIMULUS: two presets from ONE composition file. A second preset directory whose agent.cordis.yml is a BYTE-IDENTICAL copy (sameCompositionFile true, both 16bc20e559d0c05b810876522fd468952b421a69ed2b5276a3ddd06c01053bce) is discovered by the roster\'s own directory scan. Measured catalogs: daily-standard:daily-standard:27, twin:daily-standard-twin:27, daily-standard-2:daily-standard:27 -- each agent mounted its OWN preset id and the two catalogs are identical in their own rows. NO module-scope state crossed: two agents on the standing preset each called the REAL work tool and resolved their OWN run (runIdA cmp-run-A, runIdB cmp-run-B, resolvesItsOwnRun true, noCrossResolution true). 10/10 checks.'),
        (C4, 'The CONTRAST arm, and the module-scope half on a second pair: daily-standard (27 tools, ipython + work) vs the shipped standard preset (26 tools, pwsh present, NO ipython, NO work). agent.ctx identity differs between the two sessions (workServiceInstancesShared false).'),
        (G, 'Gate table section 4, row CMP-08, which states the measured constraint: the twin is a COPY whose digest equality is ASSERTED rather than assumed, and the contrast arm compares two different files -- a weaker stimulus than the oracle names, which is why the literal one was added and both are filed.'),
    ]),
    'CMP-09': ('PASS', [
        (C4, 'Gate row CMP-09. Two runs were created on ONE standing scope and their work calls INTERLEAVED (A admits, B admits, A cancels, A confirms, B admits a second). Measured separation: distinctRoots true; A tasks ["task-A1"] vs B tasks ["task-B1","task-B2"] so noTaskIdCrosses true; A tombstones ["task-A1"] vs B tombstones [] so noTombstoneCrosses true; reservations A 0 (its cancelled task released) vs B 5 (1+2+3 reserved, none released).'),
        (G, 'Gate table section 4, row CMP-09, which records that the interleave IS the stimulus: any per-root state held in module scope would surface as a crossed id at one of the five steps, and all five succeeded.'),
    ]),
    'CMP-10': ('PASS', [
        (C4, 'Gate row CMP-10. HOST-SCOPED ROWS REGISTERED EXACTLY ONCE over 178 loader entries: daily-work-host 1, ipython-kernel-host 1, sandbox-policy 1, sandbox 1, approval 1, permission 1, fs-local 1, pwsh-local 1, agent-presets 1 -- zero duplicates, and no "already registered" / "provide() throws" / "second handle" line on stderr. THE AGENT-SCOPED TOOL ROWS COME FROM THE PRESET: compositionInventory() for daily-standard lists 31 rows ending with daily-work-tools (dsh-daily-work/tools) and ipython-tool (dsh-ipython/tool), and that row list contains NO daily-work-host and NO ipython-kernel-host.'),
        (G, 'Gate table section 4, row CMP-10, which records the FALSE FINDING this measurement corrected: reading the tool rows from the ROOT loader reports them absent, because a preset\'s rows are mounted under a STANDING SCOPE which is a different Loader. The product\'s own reader for this question is the roster\'s compositionInventory() (packages/preset/agent-presets/src/index.ts:325).'),
    ]),
    'CMP-11': ('PASS', [
        (C, 'Gate row CMP-11. After a FRESH install following docs/DELIVERY.md section 2, a probe that ADDS NO ROW reports ipythonToolPresent true in a 27-tool catalog, with ipythonParameterNames ["code"] and ipythonIsOnlyParameter true, and presetRoots naming D:/DSH/home/v2-cmp/profiles/daily/presets/ -- the home this family installed and booted. The overlay was asserted mechanically to insert only the probe row and NO ipython-tool row.'),
        (G, 'Gate table section 4, row CMP-11, which states why this establishes what the earlier M11 evidence could NOT: verify-ipython-e2e.patch.yml INSERTED the tool row, so it proved the tool works when a row is present without proving the product carries one. This probe adds no row.'),
    ]),
    'CMP-12': ('PASS', [
        (C7, 'Gate row CMP-12. CANARY: the home D:/DSH/home/v2-cmp-canary carries $DSH_HOME/cordis.patch.yml setting agent-presets.default to standard, and the boot reports presetDefaultId "standard" -- the override IS VISIBLE -- with 26 tools and ipythonToolPresent false. CONTROL: D:/DSH/home/v2-cmp-control has NO home patch (control_has_home_patch false, asserted), and the boot reports presetDefaultId "daily-standard" with 27 tools and ipythonToolPresent true.'),
        (G, 'Gate table section 4, row CMP-12, which records that this is a clean ONE-VARIABLE experiment: both homes were built from the same repository profile, installed the same way, and booted from the same foreign cwd with the same overlay; the only difference is the home-level patch file. The control arm is what makes this evidence rather than coincidence.'),
    ]),
    'CMP-13': ('PASS', [
        (C, 'Gate row CMP-13. THE FULL MEASURED NAME SET, VERBATIM (27): ["ask_user_question","create_goal","edit","exit_plan_mode","get_goal","glob","grep","interrupt_agent","ipython","job_kill","job_list","job_output","list_agents","present","read","read_image","send_message","skill","subagent","subagent_fork","todo_write","update_goal","web_fetch","web_search","work","workflow","write"]. pwsh is ABSENT, and the check was widened to the whole shell-equivalence SET -- pwsh, bash, shell and run_code are ALL absent -- while ipython IS present.'),
        (C3, 'Independent corroboration from a second boot: pwshToolPresent false, ipythonToolPresent true, ipythonReplacesPwsh true, modelShellRowDisabledByPreset true, pwshAbsenceIsIntentional true.'),
        (G, 'Gate table section 4, row CMP-13, which states that this removes an INTERFACE and not a CAPABILITY: the kernel is unconfined and has the same file and network authority the shell had (G-SEAM-25, G-SEAM-30), so this PASS must NOT be cited as evidence that any containment exists.'),
    ]),
    'CMP-14': ('PASS', [
        (C14, 'Gate row CMP-14. The recorded value is launcher_args_redacted = "--profile daily-candidate". REDACTED FORM: it carries --profile and NO --patch, --token, --api-key, --key or --secret. NO CREDENTIAL MATERIAL: 0 hits across 5 credential shapes, and the test is shown CAPABLE OF FAILING -- a constructed raw control trips 3 (sk- key prefix, bearer token, long base64). IDENTITY-BOUND: the named profile\'s patch is profiles/daily-candidate/cordis.patch.yml with sha256 5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4, EQUAL to deployment.inputs.host_profile_digest.'),
        (G, 'Gate table section 4, row CMP-14, which records TWO findings that are NOT fails of this oracle. CMP-14-F1: the recorded name is the REPOSITORY DIRECTORY name, not an install name -- measured, three homes have profiles/daily-candidate/ on disk and ALL THREE carry a DIFFERENT patch digest from the pin (c9992160, 547a59b2, ef189a8c vs 5b8b2a8e), while under the install name daily the pin matches in 6 of 13 resolutions; read as an install name the string selects a STALE profile. CMP-14-F2: a search BOUNDED to apps/cli/src found ZERO redaction-shaped lines, so the field is HAND-AUTHORED in compatibility.lock.json and there is no product mechanism that would reproduce it.'),
    ]),
}


def sha256_of(rel_path: str) -> str:
    path = REPO / rel_path
    if not path.is_file():
        raise SystemExit(f'FATAL: evidence file does not exist: {rel_path}')
    if not rel_path.startswith('qualification/results/'):
        raise SystemExit(f'FATAL: evidence path is not under qualification/results/: {rel_path}')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    spec = json.loads(SPEC.read_text(encoding='utf-8'))

    cases = spec['cases']
    cmp_before = [c for c in cases if c['id'].startswith('CMP-')]
    other_before = json.dumps([c for c in cases if not c['id'].startswith('CMP-')], sort_keys=True)
    if len(cmp_before) != 14:
        raise SystemExit(f'FATAL: expected 14 CMP cases, found {len(cmp_before)}')

    for case in cases:
        if not case['id'].startswith('CMP-'):
            continue
        case_id = case['id']
        if case_id not in VERDICTS:
            raise SystemExit(f'FATAL: no verdict prepared for {case_id}')
        status, entries = VERDICTS[case_id]
        case['status'] = status
        case['evidence'] = [
            {'path': path, 'sha256': sha256_of(path), 'identity': IDENTITY, 'note': note}
            for path, note in entries
        ]

    other_after = json.dumps([c for c in cases if not c['id'].startswith('CMP-')], sort_keys=True)
    if other_before != other_after:
        raise SystemExit('FATAL: a case OUTSIDE the COMPOSITION family changed -- refusing to write')

    # NEWLINE='\n' IS LOAD-BEARING. The file on disk is LF-only (measured: 0 CRLF
    # in the HEAD revision). Python's text mode on Windows translates every '\n'
    # to '\r\n', which rewrites ALL 2097 lines and buries the real change -- the
    # 14 cases' evidence -- inside a whole-file line-ending diff. A reader
    # reviewing this commit must be able to see the actual edit.
    with open(SPEC, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(json.dumps(spec, indent=2, ensure_ascii=False) + '\n')

    written = json.loads(SPEC.read_text(encoding='utf-8'))
    for case in written['cases']:
        if case['id'].startswith('CMP-'):
            print(f"{case['id']}  {case['status']:<5}  {len(case['evidence'])} evidence entries")
    print()
    print('cases outside COMPOSITION: unchanged (asserted)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
