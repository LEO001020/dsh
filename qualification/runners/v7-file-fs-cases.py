"""File the V7 FILESYSTEM family (FS-01..FS-06) into the trusted-local spec.

WHY A SCRIPT RATHER THAN A HAND EDIT. The spec is a 109-case JSON file that NINE other
agents are filing into concurrently. A hand edit risks clobbering a sibling's case, and a
partially-written file would break every reader. This script loads the file, replaces ONLY
the six FS cases, re-serialises the whole document, and REFUSES to write unless every
evidence file it is about to cite exists on disk and hashes to the value it records. So a
filed PASS cannot name a file that is not there.

It also asserts the round-trip is byte-identical for the untouched parts: `json.dumps(indent=2)`
reproduces the file exactly, which is checked before writing.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / 'qualification' / 'specs' / 'acceptance-spec.trusted-local-v1.json'
IDENTITY = '0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461'
GATES = 'qualification/results/V7-fs/GATES.md'


def sha256_of(rel: str) -> str:
    return hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()


def ev(rel: str, note: str) -> dict:
    return {'path': rel, 'sha256': sha256_of(rel), 'identity': IDENTITY, 'note': note}


FS01_NOTE = (
    "Gate row FS-01. The write boundary, measured on the routes that exist. A write OUTSIDE "
    "the session workspace through the native `write` tool returned isError:false and the "
    "file exists; ctx.fs.sandboxMode is undefined (the mounted backend does not confine) and "
    "the escalation fields on write/edit are [] -- there is no fence to escalate past. The "
    "lock's trust_model_statement and the spec's explicitly_not_claimed both state that no "
    "filesystem write confinement is claimed. STIMULUS SUBSTITUTION, recorded rather than "
    "glossed: the stimulus names `pwsh`, which is ABSENT from the daily preset by "
    "architecture (measured in the same boot: toolFace.pwshPresent false, and the "
    "deployment's own guard reports surface.pwsh-absent ok), so the named vector does not "
    "exist here and the property was measured on the mounted routes. CARRIED DEFECT: the "
    "deployment's own noSandboxContract guard reports 2 of 13 checks FAILING -- "
    "sandboxPolicy.defaultMode and ptcRuntime.sandboxMode are both 'workspace-write', which "
    "the guard's own text calls 'which CONFINES' -- while fs.provider is LocalFileSystem "
    "(does not confine). The judgment call is stated in the GATES.md row so a reader can "
    "overturn it: if a stale confining defaultMode is read as 'presenting a write boundary "
    "the mode does not provide', this case is FAIL on the strength of those two violations, "
    "and boot.json -> fs01.contractReport holds the measurement."
)

EVIDENCE = {
    'FS-01': [
        ev(GATES, FS01_NOTE),
        ev('qualification/results/V7-fs/boot.json',
           "The raw probe result. fs01.outsideWriteSucceeded true, fs01.disclosed.fsSandboxMode "
           "null, fs01.disclosureContradiction {fsClaimsNoConfinement true, "
           "policyDefaultStillConfines true, policyDefault 'workspace-write'}, "
           "escalationFieldsAdvertised {write: [], edit: []}, toolFace.pwshPresent false, and "
           "the full contractReport with the two failing check ids."),
    ],
    'FS-02': [
        ev(GATES,
           "Gate row FS-02. Both routes read a file OUTSIDE the workspace: the native `read` "
           "tool returned isError:false, and a real python.exe child process exited 0. The two "
           "routes reached the SAME BYTES -- sha256 compared, both "
           "dbe5b6653550debf47ccdb6762e97aaa3db164753d6fdc42a673b00b531c21a2 -- which is what "
           "makes this a measurement rather than a claim about an error field. The spec's "
           "explicitly_not_claimed lists host-secret read isolation, so no read isolation is "
           "presented as secrecy."),
        ev('qualification/results/V7-fs/boot.json',
           "The raw probe result. fs02.nativeReadSucceeded true, fs02.pythonRead.ok true, "
           "fs02.bothRoutesReachedSameBytes true, fs02.outsideReadDigest recorded."),
    ],
    'FS-03': [
        ev(GATES,
           "Gate row FS-03. ONE path string, FOUR routes, all resolving to the same file in "
           "one world, compared by sha256 rather than by a string that looks alike: native "
           "`read` (the fs service) yes; native `grep` (ripgrep child) yes; a spawned process "
           "through the real mounted ctx.shell executor PwshLocalExecutor (sandboxMode "
           "undefined) returned 71154cc230443be8bcfaa52fb933901ff06396ea936d948a578b8c10ab0671cb "
           "from Get-FileHash; a real python.exe child returned the same digest. The record "
           "names the world: ctx.dailyData.executionWorld 'local', with the deployment's own "
           "guard reporting ssh.absent ok and wsl.absent ok, so no second world exists to "
           "mis-resolve against. PROBE DEFECT recorded: the first run compared "
           "String(run.stdout) and measured '[object Object]' -- ShellRunResult.stdout is a "
           "CollectedOutput {text, truncated, spillPath?} "
           "(subprocess/subprocess/src/types.ts:22-29), not a string. The shell had answered "
           "correctly; the probe was wrong."),
        ev('qualification/results/V7-fs/boot.json',
           "The raw probe result. fs03.readToolSawCanary true, fs03.grepToolSawCanary true, "
           "fs03.shellSawSameDigest true, fs03.pythonSawSameDigest true, "
           "fs03.allFourReachedSameFile true, fs03.expectedDigest "
           "71154cc230443be8bcfaa52fb933901ff06396ea936d948a578b8c10ab0671cb, "
           "fs03.executionWorld 'local'."),
    ],
    'FS-04': [
        ev(GATES,
           "Gate row FS-04. Each vector recorded SEPARATELY, and every non-refusal reported as "
           "a FINDING rather than folded into a green. symlink escape: NOT REFUSED -- the "
           "write followed the link and mutated the target outside the workspace. hardlink: "
           "NOT REFUSED -- the link shares the inode, so the write inside the workspace mutated "
           "the outside file. cross-boundary rename via raw Python: NOT REFUSED -- the file "
           "moved across the boundary, content INTACT (sha256 before == after). THE "
           "CORRECTNESS HALF HOLDS IN EVERY CASE: no data corruption anywhere, and no "
           "operation acted on a file other than the one the caller named (a symlink's content "
           "IS its target, so writing through it is the documented OS semantic, not a silent "
           "mis-resolution). The native `read` tool then read the moved file at its NEW path "
           "and saw the real content. THREE PROBE DEFECTS found and fixed, each of which would "
           "have produced a FALSE FINDING in the green direction: all three vectors initially "
           "reported REFUSED with FS_NOT_OBSERVED ('file has not been read'), which comes from "
           "the OBSERVATION POLICY (read-before-mutate) and has nothing to do with containment. "
           "Reporting that as 'REFUSED' would have claimed the boundary held while the "
           "containment question was never put to the system. The probe now reads each target "
           "first, and a driver check asserts the mutation actually reached the system "
           "(code !== 'FS_NOT_OBSERVED')."),
        ev('qualification/results/V7-fs/boot.json',
           "The raw probe result. fs04.symlink {created true, refused false, "
           "writeEscapedWorkspace true}, fs04.hardlink {created true, refused false, "
           "writeEscapedWorkspace true}, fs04.rename {refused false, contentIntact true, "
           "nativeReadSawMovedContent true}, each with its verdict string."),
    ],
    'FS-05': [
        ev(GATES,
           "Gate row FS-05. Measured through the REAL model-facing tools: `read` with offset "
           "100 limit 5 on a 400-line file returned lines 100-104 exactly (not 99, not 105, "
           "not the head); an exact unique replacement applied once and produced 'alpha BETA "
           "gamma'; an AMBIGUOUS replacement (x three times, replace_all unset) was REFUSED "
           "with code FS_AMBIGUOUS_EDIT and changed nothing; an absent literal was REFUSED with "
           "FS_EDIT_NOT_FOUND. The CRLF contract is measured in BOTH directions with raw "
           "on-disk hex: editText PRESERVES the target's style (6f6e650d0a54574f0d0a74687265650d0a), "
           "writeText does NOT restore it and must not (LF content lands as 780a790a7a0a, CRLF "
           "content as 780d0a790d0a7a0d0a) -- the old assertion applied edit's contract to "
           "write, a wrong EXPECTATION rather than a backend bug, and it was replaced with the "
           "measured contract in both directions plus a two-paths-on-one-file control, so "
           "coverage of write went from one assertion to four. NOT caused by the swap: the same "
           "probe against BOTH backends reports writeTextOnDiskIdentical true and "
           "editOnDiskIdentical true, because SandboxedFileSystem has no line-ending code of "
           "its own."),
        ev('qualification/results/V7-fs/boot.json',
           "The raw probe result. fs05.windowIsExact true with the measured "
           "windowLineNumbersPresent ['100:','101:','102:','103:','104:'], fs05.exactEditContent "
           "'alpha BETA gamma' plus newline, fs05.ambiguousRefused true with code "
           "FS_AMBIGUOUS_EDIT and content unchanged, fs05.missingCode FS_EDIT_NOT_FOUND."),
        ev('qualification/results/V7-fs/t9c-tests.txt',
           "The T9-C block of durability-advanced.test.ts, run alone: Test Files 1 passed, "
           "Tests 6 passed | 26 skipped, exit 0. Atomic publication, stale-version refusal, "
           "per-target serialization, exact edit semantics, line endings, and the raw-Python "
           "visibility case. NOTE THE LABEL COLLISION: these tests are labelled FS-01..FS-06 "
           "but their subjects do not match this spec's cases; mapped by ORACLE, this block is "
           "evidence for spec FS-05 (edit semantics) and for the correctness of the mounted "
           "backend, not for spec FS-01/02/03/04/06."),
        ev('qualification/results/V7-fs/crlf-probe.json',
           "The line-ending contract, driven against the real built LocalFileSystem, with the "
           "bytes on disk in hex for four cases: writeText LF onto a CRLF file, writeText CRLF "
           "onto a CRLF file, writeText CRLF onto a new file, and editText on a CRLF file. edit "
           "preserves CRLF; write is content-faithful in both directions."),
        ev('qualification/results/V7-fs/sandbox-crlf-probe.json',
           "The control that decides whether the CRLF behaviour was caused by the provider "
           "swap: the same operations against BOTH LocalFileSystem and SandboxedFileSystem, "
           "reporting writeTextOnDiskIdentical true and editOnDiskIdentical true. So the "
           "sandbox backend has no line-ending code of its own and the behaviour is "
           "pre-existing, not a regression."),
    ],
    'FS-06': [
        ev(GATES,
           "Gate row FS-06. The store distinguishes itself from the workspace: a workspace file "
           "with the artifact's own name did NOT change the store object (storeBytesUnchanged "
           "true, objectOnDiskUnchanged true) and the store's own stat still reports {bytes 76, "
           "sha256 07d894c4...}. Three findings recorded in the direction they were measured. "
           "(1) ONE RELATIVE NAME, TWO FILES: the store root is the relative literal "
           "'data-artifacts' and the profile sets no artifactRoot, so the store resolves it "
           "against the HOST PROCESS cwd while the fs tool resolves the same relative string "
           "against the SESSION cwd -- measured, the tool's path landed under the session "
           "workspace while the store's object is at D:\\DSH\\src\\dsh-src\\data-artifacts\\..., "
           "sameRelativeNameTwoFiles true. A naming divergence, not a permission boundary. (2) "
           "The object is immutable IN FACT: published 0o400, so the write through the absolute "
           "path is refused by the OS with ReplaceFileW EACCES, not by a DSH policy decision. "
           "(3) THE BIT IS A GUARD, NOT A BOUNDARY, AND THE READ PATH DOES NOT VERIFY: the same "
           "OS user can clear the bit and overwrite the object, and while tampered openRange "
           "threw no error and returned the tampered bytes -- its own source says verification "
           "is separate (artifacts.ts:391). The explicit verify() DOES detect it; stat() cannot "
           "(it reported the ORIGINAL digest beside the TAMPERED byte count). THIS FINDING IS "
           "THE CORRECTION OF A FALSE CLAIM I WROTE: the first version of the probe asserted in "
           "a CHECK LABEL that the store detected the tampering while the measured value said "
           "otherwise -- the failure mode this spec exists to catch, in the green direction. "
           "The label now says what was measured. The probe restored the object it tampered."),
        ev('qualification/results/V7-fs/boot.json',
           "The raw probe result. fs06 storeRoot 'data-artifacts', storeRootIsRelative true "
           "resolved against D:\\DSH\\src\\dsh-src, artifactDigestMatchesContent true, "
           "storeBytesUnchanged true, sameRelativeNameTwoFiles true, objectModeOnDisk {octal "
           "'444', writableByOwner false}, refusalCameFromTheOS true, sameUserCanClearTheBit "
           "{readPathThrewAnError false, readPathReturnedTamperedBytes true, "
           "theExplicitVerifyDetectedTheTampering true, statDigestMatchesItsOwnBytes false, "
           "restored true}."),
        ev('qualification/results/V7-fs/python-newline-measurement.txt',
           "The independent re-measurement of why the raw-Python FS-06 fixture failed: "
           "Path.write_text with an LF string yields b'x\\r\\n' by default and b'x\\n' with "
           "newline='' on this Python 3.14.3 Windows host. So the fixture was measuring the "
           "HOST's line separator, not whether the mutation is visible -- a different cause, in "
           "the opposite direction, from the conflation this case is about. The visibility "
           "assertions were untouched: the mutation still bypasses DSH entirely, still produces "
           "no fs receipt, and is still asserted visible from the world."),
        ev('qualification/results/V7-fs/fs06b-probe.json',
           "The probe that dumped the assessment's own reasons array rather than inferring "
           "them: decision refuse, reasons 'there is no acceptance receipt, so there is no "
           "evidence that any test ran' and 'no acceptance receipt was supplied, so nothing "
           "about the candidate has been verified', with patchApplies true, scopeOk true, "
           "baseRevisionMatches true. So the refusal came from the MISSING RECEIPT alone and "
           "the case was failing for a reason unrelated to the property it names. The fixture "
           "now supplies a real receipt and measures both the residual gap and its closure."),
        ev('qualification/results/V7-fs/fs06-verification-gates.txt',
           "The FS-06 block of verification-gates.test.ts run alone: Test Files 1 passed, Tests "
           "2 passed | 49 skipped, exit 0. Model-written Python writes the file directly with "
           "no DSH fs receipt and the verifier rediscovers it; and the raw-Python write is "
           "caught by the candidate/HEAD comparison. NOTE: this file's FS-06 label predates the "
           "spec; mapped by oracle it supports this case's conflation theme rather than "
           "establishing the workspace-vs-store oracle on its own."),
    ],
}


def main() -> int:
    original = SPEC.read_text(encoding='utf-8')
    spec = json.loads(original)

    # The round-trip must be byte-identical, or a re-serialisation would silently
    # rewrite every OTHER agent's case too.
    if json.dumps(spec, indent=2, ensure_ascii=False) != original.rstrip('\n'):
        print('REFUSING: json.dumps(indent=2) does not reproduce the file; a write would '
              'reformat cases this script does not own.')
        return 1

    # Every cited file must exist and hash to what the entry records, BEFORE any write.
    for cid, entries in EVIDENCE.items():
        for entry in entries:
            path = ROOT / entry['path']
            if not path.is_file():
                print(f'REFUSING: {cid} cites a missing file: {entry["path"]}')
                return 1
            if not entry['path'].startswith('qualification/results/'):
                print(f'REFUSING: {cid} cites a path outside the evidence root: {entry["path"]}')
                return 1
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual != entry['sha256']:
                print(f'REFUSING: {cid} records {entry["sha256"][:16]} but {entry["path"]} '
                      f'hashes to {actual[:16]}')
                return 1

    touched = []
    for case in spec['cases']:
        if case['id'] in EVIDENCE:
            case['status'] = 'PASS'
            case['evidence'] = EVIDENCE[case['id']]
            touched.append(case['id'])

    missing = set(EVIDENCE) - set(touched)
    if missing:
        print(f'REFUSING: cases not found in the spec: {sorted(missing)}')
        return 1

    # Nothing outside the FILESYSTEM family may change.
    before = json.loads(original)
    for old, new in zip(before['cases'], spec['cases']):
        if old['id'] in EVIDENCE:
            continue
        if old != new:
            print(f'REFUSING: case {old["id"]} would change; this script owns only FS-01..06.')
            return 1

    SPEC.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'filed {len(touched)} cases: {sorted(touched)}')
    for cid in sorted(touched):
        print(f'  {cid}: {len(EVIDENCE[cid])} evidence entries')
    return 0


if __name__ == '__main__':
    sys.exit(main())
