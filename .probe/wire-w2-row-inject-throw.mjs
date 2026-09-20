/**
 * W2: the ROW declares `inject: ['sandboxPolicy']`, so the ENTRY's own fiber is
 * ordered after the dependency, and `apply` calls the check DIRECTLY — a plain
 * synchronous throw, which is the shape already measured to put the entry in
 * FAILED.
 */
export const name = 'wire-w2-row-inject-throw'
export function apply() {
  throw new Error('W2-ROW-INJECT-THROW-MARKER')
}
