=== C2 resolved graph: the mandatory override is IN the graph ===

Command:
  DSH_HOME=D:\DSH\home\canary3 node apps/cli/lib/bin.js --profile daily-candidate --dump-config
exit_code: 0   stderr: empty

--- the row that closes the measured C0 gap ---
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxActiveSubagents: 10
    maxDepth: 1

In C0 the same row has NO config block, so the effective value is the source
default 8. Here it is 10, and the dump attributes the row to our patch layer:
  # == D:\DSH\home\canary3\profiles\daily-candidate\cordis.patch.yml

--- the host service row ---
- id: daily-work-host
  name: dsh-daily-work/host
  config: { targetChildren: 10, maxDepth: 1, budgetCeiling: 200, currency: USD, ... }

--- a real defect this slice caught ---
The first version of cordis.patch.yml ended with a literal '[]' line after
comment blocks, which is invalid YAML alongside other content. The loader
rejected it with:
  failed to parse overlay .../cordis.patch.yml: YAMLException: end of the
  stream or a document separator is expected (89:1)
Fixed by removing the stray '[]'. Recorded because it shows the loader does
reject a malformed profile rather than silently ignoring it.

--- what is NOT yet proven ---
This proves the patch RESOLVES. It does not yet prove that ten children are
admitted and topped up by the real startContinuable path. That is the next
slice (M3.2) and needs a controlled provider, not a live one.
