C4 independent instruments (writer c4, slice: ID-01 graph clause).

recorder-all.mjs  -- loader hook that records EVERY module resolution the booted host
                     performs. The archived V1 recorder filters INSIDE the hook
                     (`specifier.startsWith('@deepseek-ai/')`), so its artifact can
                     never show a specifier the filter did not match. This one writes
                     everything and filters in the READER, which makes the filter's own
                     coverage reportable ("how many resolutions landed in a .ts file
                     under ANY specifier spelling").
measure-all.mjs   -- the driver: real built launcher, real `daily` profile, link:
                     targets rewritten to this worktree and ASSERTED, T17 probe and
                     keyless mock adapter (no provider budget), shared port-safe
                     harness, same classifier as the archived driver.
classify.py       -- reads a graph.jsonl back and classifies it, so a result can be
                     inspected without re-running a boot.
runs/             -- this instrument's own artifacts, kept separate from the
                     committed qualification/results/C4-graph/ evidence.
