# V9 fixture-fresh — the one suite that really passes

`src/pass.test.ts` is a single passing test. It exists so the VER-04 arms start from a
receipt that records **PASS**, which is what makes "the receipt goes stale" a statement
about freshness rather than about a run that was already failing.

**The VER-04 arms MUTATE this file** (arm 3 adds a test, then restores it byte-for-byte).
If you re-run them, check `git status` afterwards: the file must be back at its committed
revision, or the recorded `receipt-ver04-fresh-pass.json` will no longer be fresh against it
and the receipt's recorded hash will not match what a reader sees.

`node_modules` is a junction into the M8 fixture's, for the same reason and with the same
rebuild note as `../fixture/README.md`. It is not committed.
