// T0 + T1 + T2 tests.
//
// The concurrency suite boots the PRODUCTION agent loop with real subagents,
// real JSONL session persistence and a real storage domain, so teardown has to
// unwind genuinely owned resources. The default 10s hook budget is too tight for
// that on this machine; a timeout here means "teardown did not finish", which
// must be visible rather than silently tolerated.
export default {
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    reporters: ['verbose'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}
