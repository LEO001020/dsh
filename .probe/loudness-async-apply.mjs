/**
 * A probe row whose `apply` REJECTS ASYNCHRONOUSLY.
 *
 * The subject is DSH's own loudness channel, not this plugin: does an async
 * `apply` rejection put the ENTRY into FAILED, so `auditStartupEntries` lists it
 * in "N entries did not activate" on stderr?
 */
export const name = 'loudness-async-apply'
export const inject = []
export async function apply() {
  throw new Error('ASYNC-APPLY-REJECTION-MARKER')
}
