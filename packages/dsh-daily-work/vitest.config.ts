// T0 + T1 tests. The T1 file boots a real DSH storage domain, so this config
// must not stub DSH services.
export default {
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    reporters: ['verbose'],
    testTimeout: 30_000,
  },
}
