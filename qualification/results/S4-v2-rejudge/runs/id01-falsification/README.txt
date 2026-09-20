=== ID-01 FALSIFICATION ARM (the negative control the PASS rests on) ===

The PASS in ../id01/verdict.json is only worth something if the SAME instrument
goes red when the defect it names is present. This directory holds that run.

WHAT WAS INJECTED. The v1 defect, verbatim, appended to the SOURCE so the
driver's own rebuild would emit it into the BUILT artifact:

  packages/dsh-daily-work/src/artifacts.ts  (+2 lines, appended)
    import { publishImmutableObjectStream as __S4_PROBE } from '@deepseek-ai/dsh-attachment-local/src/store.ts'
    export const __s4Probe = __S4_PROBE

OBSERVED (transcript.txt / verdict.json in this directory):

  FAIL no @deepseek-ai specifier resolved to a source (.ts) file
       observed: {"fromBuilt":221,"fromSource":1,"fromOther":1,
                  "offenders":[["@deepseek-ai/dsh-attachment-local/src/store.ts",
                                "D:\DSH\src\dsh-src\packages\attachment\attachment-local\src\store.ts"]]}
  checks_passed: 22/23
  verdict: FAIL

THE OFFENDER IS BYTE-FOR-BYTE THE ONE V1 RECORDED, including the resolved path.
That is what makes this a reproduction of v1's FAIL rather than a new defect.

A SEPARATE, WEAKER CONTROL WAS RUN FIRST AND IS WORTH RECORDING because it
initially looked like a failed falsification: injecting the import into the
BUILT `lib/artifacts.js` alone left the graph clause GREEN, because the driver
REBUILDS both packages before booting and the rebuild overwrote the injected
`lib/`. That is the driver working as designed (trap 1, stale build), and it is
recorded rather than discarded: the graph clause is a property of the built tree
the boot actually loads, and the driver proves freshness before measuring.

RESTORED. `git diff --stat` on the source file is empty; `git hash-object`
equals `git rev-parse HEAD:<path>` = 6d639744625b7871b7a0abdd23a5670bc0bb471f;
`lib/` rebuilt from the restored source and contains no `src/store.ts` import.
