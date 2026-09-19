# acceptance-skip-fixture

The self-contained "all tests skipped" fixture the acceptance runner is measured
against. It exists to prove the sharpest result of M9.1: a suite with a **real
exit code of 0** and `skipped: 1, passed: 0` is still classified non-PASS.

## Why `node_modules/` is NOT committed

This fixture originally carried a 6 MB installed `node_modules/` (214 files)
because it was created by a real `pnpm install` in place. That directory is
deliberately removed from the repository:

- It is a **reproducible artifact**, not evidence. It contains no result, no
  measurement and no fixture data — only a copy of the vitest toolchain.
- The fixture's own sources import nothing from it. `vitest.config.ts` and
  `package.json` are the whole fixture.
- An installed dependency tree inside an evidence directory is the same
  machine-layout artifact the project already refuses to commit for the package
  itself (`packages/dsh-daily-work/node_modules/`). Evidence should record what
  was OBSERVED, not a copy of the toolchain that observed it.

## Regenerating it

The recorded output is `../receipt-all-skipped.json` and `../cli-transcript.txt`.
To re-run the fixture, install its toolchain first:

```sh
cd qualification/results/M9.1-acceptance-runner/fixture-all-skipped
pnpm install --ignore-workspace   # or: npm install
node ../../../runners/acceptance.mjs --definition <definition.json>
```

`node_modules/` is gitignored via `qualification/results/**/node_modules/`, so a
regenerated tree will not be committed again.
