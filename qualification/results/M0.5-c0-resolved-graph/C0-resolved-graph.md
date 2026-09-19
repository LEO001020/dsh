=== G-SEAM-07 CONFIRMED: the C0 capability gap ===

Command: node apps/cli/lib/bin.js --profile <P> --dump-default-config
DSH_HOME=D:\DSH\home\canary

Row 'id: subagent' in ALL THREE shipped profiles:
  - id: subagent
    name: '@deepseek-ai/dsh-subagent'
  (no config block at all)

=> maxActiveSubagents falls back to the Schemastery default 8.
=> maxDepth falls back to the default 1.
=> N=10 is NOT satisfiable by the stock profiles. An explicit override is required.

Providers actually mounted (all three profiles):
  - id: subagent-spawn-in-process   providerName: spawn
  - id: subagent-fork-in-process    providerName: fork

Storage actually mounted (all three profiles):
  - storage-json    root: dshHomePath('storages')
  - storage-domain  backend: json

session-query-sqlite in all three profiles:
    path: ':memory:'
    openAt: never
  => full-text session search is DISABLED by the shipped bundle (confirms the seam read;
     the package default is openAt:'startup', the bundle value is 'never').

PTC: ptc-runtime -> @deepseek-ai/dsh-ptc-runtime-node (TypeScript backend), all profiles.
Web profile only: agent-presets with default: standard.

dump sha256 (proof the graph is reproducible):
f89b4e817a05d44c903cfecf3398db8c0516ee4e5a241bf643115717d301617b *dump-default-headless.yml
d8929cea43835722cbea0e1df281016456212161ea92435361ef537c1d158153 *dump-default-sdk.yml
b64151b308f3cbb0f5efe57b04c35bfddda641e249300ee28148391f07e1af01 *dump-default-web.yml
