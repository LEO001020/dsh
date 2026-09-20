/**
 * P10 negative-arm instrument: occupy the bridge-ledger domain name BEFORE the
 * kernel service tries to open it.
 *
 * WHY THIS INSTRUMENT AND NOT A DISABLED STORAGE ROW. The first version of the
 * negative arm disabled the `storage-domain` row, and it was MEASURED to be the
 * wrong tool: that leaves EIGHT rows unactivated ("pending (waiting for service:
 * storageDomain)"), including the probe itself, because `sessionController` ->
 * `workspace` -> `storageDomain`. The probe then never ran, so the arm could not
 * tell "the ledger gate refused a kernel" from "the whole composition collapsed".
 *
 * Routing only the ledger's domain at a missing backend was the second attempt,
 * and it was measured to fail the same way: the `storage-domain` row did not
 * activate at all, so the same eight rows went pending. (Cause not established;
 * recorded as an UNRESOLVED UNKNOWN rather than explained away. A patch that
 * names a row by `id` and supplies only `config` did not leave that row activatable
 * in this composition, and the exact reason was not chased further because a
 * better instrument was available.)
 *
 * WHAT THIS DOES INSTEAD. It leaves the whole composition INTACT -- storage
 * mounted, every consumer activating, the probe running, a real cell driven --
 * and fails exactly one thing: the bridge ledger's open. `DomainFacility.open`
 * refuses a domain name that is already open, so opening it here first makes the
 * kernel service's own open reject.
 *
 * AND THAT IS NOT A CONTRIVED STIMULUS. It is the ACTUAL defect this slice fixes:
 * before the fix, the second `openBridgeLedger` in any process threw
 * `already-open`, the error was swallowed, and the Session silently got an
 * in-memory ledger. Measured directly in
 * `packages/dsh-ipython/src/p10-ledger-durable.test.ts`. This instrument puts
 * that same condition in front of a REAL BOOT, so the negative arm tests the
 * routine failure rather than a hypothetical one.
 */
export const name = 'p10-ledger-occupier'
// The facility must exist before this can occupy a domain on it.
export const inject = ['storageDomain']

export async function apply(ctx) {
  const facility = ctx.get('storageDomain')
  // Imported from THIS tree's package, so the occupier and the service contend
  // for the SAME domain name and spec.
  //
  // THE PATH MUST BE A `file://` URL, NOT A WINDOWS PATH. Measured, and it cost
  // one run: a raw `D:/...` specifier makes Node refuse with
  // `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'd:'`, the occupier
  // never occupies anything, and the negative arm then reports a SUCCESSFUL cell
  // -- i.e. it would have reported "no refusal" for a reason that has nothing to
  // do with the gate. The driver passes an absolute path because that is the
  // portable thing to pass through an environment variable; the conversion to a
  // URL belongs here, at the import.
  const specifier = process.env.P10_LEDGER_MODULE
  if (specifier === undefined || specifier === '') {
    throw new Error('p10-ledger-occupier: P10_LEDGER_MODULE must name this tree\'s bridge-ledger.ts')
  }
  const { pathToFileURL } = await import('node:url')
  const { bridgeLedgerDomainSpec } = await import(pathToFileURL(specifier).href)
  await facility.open(bridgeLedgerDomainSpec)
  // Deliberately NOT closed: the whole point is that the name stays occupied
  // while the probe drives a cell.
}
