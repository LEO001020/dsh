# P15 STEP 3 — the Windows clone caveat, re-measured and completed

The README documents a Windows clone failure and two remedies. V5 section 15
requires the documented remedy to be complete and accurate, and to not be
achieved by renaming historical evidence paths. This re-measures the claim
rather than trusting the README wording, and tests the remedy itself.

Measured in D:\DSH\work\wt-p15 at 2e1b2c2, cloning the local main tree
(D:\DSH\work\dsh-native-daily at d35d251) with --no-hardlinks.

## The repository-side fact (re-derived, not copied)

```
$ git ls-files | awk '{print length($0)}' | sort -rn | head -1
222
$ git ls-files | awk 'length($0) > 259' | wc -l     # Windows MAX_PATH
0
$ git ls-files | awk 'length($0) >= 200' | wc -l
13
```

So the longest RELATIVE path is 222 characters and ZERO tracked paths exceed
259 on their own. The repository is inside MAX_PATH by itself, which is why the
failure is a property of PREFIX + 222 and not of the tree.

## The three arms, all run

```
ARM 1  short destination  D:\v\lp-short   (prefix 5)
  $ git clone <local> /d/v/lp-short
  clone exit=0    git ls-files=1127    longest cloned path=222   OK

ARM 2  deep destination   %TEMP%/lp-deep  (prefix 12)
  $ git clone <local> "$TEMP/lp-deep"
  clone exit=128  git ls-files=0
  stderr: warning: unable to access '.../session-21b737a1.../.gitattributes': Filename too long
          error: unable to create file '.../session-21b737a1.../session.v3.jsonl': Filename too long
  FAILS, and leaves an EMPTY-LOOKING checkout -- the index is never written.

ARM 3  deep destination with the documented remedy
  $ git -c core.longpaths=true clone <local> "$TEMP/lp-long"
  clone exit=0    git ls-files=1127    REMEDY VERIFIED
```

The claim in the README is therefore accurate in all three arms, and the
per-invocation remedy it shows works. Two things were missing and are now fixed
in README.md:

1. V5 section 15 names a SECOND form -- 'git config --global core.longpaths true'
   -- which the README did not mention at all. It is the form a developer wants
   when they will clone or check out more than once, and its absence meant the
   documented remedy was incomplete.
2. The README gave the remedy but not the DIAGNOSIS. The failure is silent in the
   sense that matters: git exits 128 and prints Filename-too-long lines that are
   easy to scroll past, and the checkout that remains looks merely empty. A reader
   who hits it needs 'git ls-files returns 0' as the tell, because that
   distinguishes this from a network or auth failure.

## Not done here, deliberately

V5 section 15 offers an Option 2 for a future release package: do not ship the
raw historical qualification tree in the daily install artifact, and publish the
source/runtime package separately from the audit evidence archive. That is a
packaging decision for the release, not a README edit, and it is recorded as an
open item in README.md rather than applied.

Renaming the evidence paths was NOT done and must not be done: the paths encode
the workspace the Session store scoped them to, and the recorded digests
reference them. V5 section 15 says this directly.
