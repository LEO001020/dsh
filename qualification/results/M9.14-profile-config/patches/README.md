# Standalone copies of the gate stimuli

These are the SAME stimuli the tests stage, kept as files so a reader can run one
by hand without reading the test source.

- `a04-one-field.yml` — the one-field replacement. Pass with
  `--patch <this file>` to `--dump-config` (see `dumps/a04-one-field.yml`).
- `a10-headless-keyless.yml` — the keyless headless overlay. It inserts the
  scripted adapter from
  `packages/dsh-daily-work/m914-mock-llm.ts`, which is where that adapter lives
  so this file needs no helper directory beside it.

## Why the adapter is not a sibling file

The adapter is TypeScript importing `@deepseek-ai/dsh-llm`, and Node resolves
those bare specifiers by walking up from the FILE's directory. This directory has
no such ancestor, so a sibling copy fails with `Cannot find package
'@deepseek-ai/dsh-llm'` — reproduced, and the reason a junction farm once had to
live here. Pointing at the package removes that need entirely: the package
already resolves the pinned DSH packages, and the shipped keyless fixture
(`apps/cli/tests/profiles/headless/tests/fixtures/cli.patch.yml`) lives inside
the checkout for the same reason.

## Regenerating

The authoritative copies are inlined in `profile-config.test.ts` and
`make-a10-runs.mjs`. If you change a stimulus there, update the copy here and
regenerate `dumps/` with `make-dumps.mjs`.
