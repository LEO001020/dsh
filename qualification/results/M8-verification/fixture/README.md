# M8 CLI fixture

A self-contained candidate for the acceptance-runner CLI cases in
`../cli-transcript.txt`. It exists so the transcript is reproducible without
touching this repository:

- `src/skip.test.ts` — two tests, both skipped. The runner really exits 0 and
  the verdict must still be `all_skipped`.
- `src/empty.test.ts` — no tests at all. With `--passWithNoTests` vitest exits 0
  and the verdict must be `zero_tests`.

`node_modules/` holds junctions to the pinned checkout's toolchain and is
gitignored, because a junction is a reparse point and a checkout that recursed
into one would copy the whole DSH tree.
