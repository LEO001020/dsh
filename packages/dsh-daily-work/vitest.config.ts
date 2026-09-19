// T0 tests only: pure functions, no DSH host, no I/O.
// Deliberately does NOT import from 'vitest/config' so the config loads without
// this package having its own node_modules. The runner is invoked from the
// pinned DSH checkout, whose vitest owns the real dependency closure.
export default {
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    reporters: ['verbose'],
  },
}
