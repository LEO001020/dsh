# Standalone copies of the gate stimuli

These are the SAME stimuli the tests stage, kept as files so a reader can run one
by hand without reading the test source.

- `a04-one-field.yml` — the one-field replacement. Pass with
  `--patch <this file>` to `--dump-config` (see `dumps/a04-one-field.yml`).
- `a10-headless-keyless.yml` + `m914-mock-llm.ts` — the keyless headless overlay
  and the scripted adapter it inserts by RELATIVE path.

The relative `name:` in `a10-headless-keyless.yml` is why `../node_modules/`
exists: the adapter is TypeScript importing `@deepseek-ai/dsh-llm`, and Node
resolves those bare specifiers by walking up from the FILE's directory. Without
that directory the import fails with `Cannot find package '@deepseek-ai/dsh-llm'`
— reproduced before the junctions were added. The test suite does not need this:
it stages its own copy inside `packages/dsh-daily-work/`, which already resolves
those packages.

Both are read-only copies. The authoritative versions are inlined in
`profile-config.test.ts`; if you change a stimulus there, update the copy here and
regenerate `dumps/`.
