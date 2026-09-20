/**
 * The durable authorization evidence for a work run.
 *
 * WHY THIS EXISTS. `WorkService.createRun` takes an `authorizationRef: string`
 * and stores it verbatim. Until now nothing in the product ever called it
 * (G-SEAM-31), so the string's content was never a product question — a test
 * passed `'auth'`. Once a human command creates the run, the string becomes the
 * only durable record of WHAT AUTHORIZED IT, and `docs/GAPS.md` G-SEAM-31 is
 * explicit that a run must not be creatable by anything that is not a human
 * action. So the ref is given a canonical, parseable shape that names the KIND
 * of authority and the exact identity of the action, and a reader can CHECK the
 * claim instead of trusting it.
 *
 * WHY A STRUCTURED STRING RATHER THAN A NEW RECORD FIELD. The run record's
 * schema (`record.ts`) is shared with the admission/drain machinery another
 * writer owns at this pin. Encoding the evidence in the field that already
 * exists — and whose doc comment already says "Opaque reference to the user's
 * authorization for this run" — keeps this change ADDITIVE: no schema version
 * bump, no migration, and every existing record still validates. The encoding is
 * versioned so a future shape can be told apart rather than guessed at.
 *
 * WHAT THIS IS NOT. It is not an authentication token. It is evidence a reader
 * can audit: the commandId it names is paired with a `command/run` event that
 * `CommandRuntime` appended with `source.kind === 'user'` BEFORE the handler
 * ran, and a matching `command/done`. A forged ref would have to name a
 * commandId that no such event pair carries.
 *
 * @module authorization
 */

/** Version tag of the encoding. A reader that does not know it must not guess. */
export const AUTHORIZATION_REF_PREFIX = 'dsh-work-auth/1'

/**
 * Which human control seam authorized the run.
 *
 * The three members are the three seams V3 section I allows, and there is
 * deliberately no fourth. In particular there is NO `model-tool` member: a model
 * call is not a human action, and `exec.agent` existing does not equal user
 * authorization. A kind that could be spelled by a model parameter would make
 * the whole distinction decorative.
 */
export type WorkAuthorizationKind =
  /** A human-typed slash command reached `CommandRuntime`. */
  | 'human-command'
  /** A UI action reached the SAME handler the slash command reaches. */
  | 'ui-action'
  /**
   * A model tool call whose turn carried host-attested human input
   * (`user/message` with `source.kind === 'user'`) on the root agent.
   *
   * RESERVED, and currently UNREACHABLE: no model-side create exists at this
   * pin. It is declared so that a future addition cannot invent a fourth
   * spelling, and so that a reader seeing it in a record knows exactly which
   * authority structure it claims.
   */
  | 'direct-human-tool-turn'

/** The exact authority one run was created under. */
export interface WorkAuthorizationEvidence {
  readonly kind: WorkAuthorizationKind
  /** The verb that authorized it, e.g. `start`. */
  readonly action: string
  /** `CommandId` of the invoking command, when one exists. */
  readonly commandId?: string
  /** The registered command name, e.g. `work`. */
  readonly commandName?: string
  /** The command's raw input, as the human typed it. */
  readonly commandArgs?: string
  /** A Session event seq identifying the authorizing turn, for the tool seam. */
  readonly turnRef?: string
}

/** The reserved characters in the encoding, escaped so a value cannot forge a field. */
function escapeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|')
}

/** Inverse of {@link escapeValue}. */
function unescapeValue(value: string): string {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\\' && index + 1 < value.length) {
      index += 1
      out += value[index]
      continue
    }
    out += char
  }
  return out
}

/**
 * Split an encoded ref on UNESCAPED separators only.
 *
 * A plain `String.split('|')` would be wrong, and the reason is worth stating
 * because the bug is silent: `commandArgs` carries the human's verbatim input,
 * so a user who typed `a|kind=model-tool` would have their text cut into two
 * fields, and the second one would be read as the authority kind. The escape
 * exists to make that impossible, and the splitter is what has to honour it.
 */
function splitFields(ref: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let index = 0; index < ref.length; index += 1) {
    const char = ref[index]
    if (char === '\\' && index + 1 < ref.length) {
      current += char + ref[index + 1]
      index += 1
      continue
    }
    if (char === '|') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/**
 * Encode authorization evidence into the run record's `authorizationRef`.
 *
 * The field order is fixed so two encodings of the same evidence are byte-equal,
 * which is what lets a test compare them and what makes the ref greppable in a
 * report. Absent optional fields are omitted rather than written empty: an empty
 * `commandId=` would read as "a command with no id", which is a different fact
 * from "no command".
 */
export function formatAuthorizationRef(evidence: WorkAuthorizationEvidence): string {
  const fields: string[] = [`kind=${escapeValue(evidence.kind)}`, `action=${escapeValue(evidence.action)}`]
  if (evidence.commandId !== undefined) fields.push(`commandId=${escapeValue(evidence.commandId)}`)
  if (evidence.commandName !== undefined) fields.push(`commandName=${escapeValue(evidence.commandName)}`)
  if (evidence.commandArgs !== undefined) fields.push(`commandArgs=${escapeValue(evidence.commandArgs)}`)
  if (evidence.turnRef !== undefined) fields.push(`turnRef=${escapeValue(evidence.turnRef)}`)
  return [AUTHORIZATION_REF_PREFIX, ...fields].join('|')
}

const AUTHORIZATION_KINDS: readonly string[] = ['human-command', 'ui-action', 'direct-human-tool-turn']

/**
 * Parse a ref this module wrote.
 *
 * Returns `undefined` for anything else — including the bare `'auth'` a test
 * fixture passes to `createRun` directly. That is deliberate: a reader must be
 * able to tell "this run carries structured authorization evidence" from "this
 * run carries a string", and a parser that coerced an unknown shape into a known
 * kind would destroy exactly that distinction.
 *
 * An unknown `kind` is also `undefined` rather than a cast: a version bump that
 * adds a kind must be accompanied by a reader that knows it.
 */
export function parseAuthorizationRef(ref: string): WorkAuthorizationEvidence | undefined {
  const segments = splitFields(ref)
  if (segments[0] !== AUTHORIZATION_REF_PREFIX) return undefined
  const fields = new Map<string, string>()
  for (const segment of segments.slice(1)) {
    const separator = segment.indexOf('=')
    if (separator <= 0) return undefined
    const key = segment.slice(0, separator)
    const value = unescapeValue(segment.slice(separator + 1))
    if (fields.has(key)) return undefined
    fields.set(key, value)
  }
  const kind = fields.get('kind')
  const action = fields.get('action')
  if (kind === undefined || action === undefined || action === '') return undefined
  if (!AUTHORIZATION_KINDS.includes(kind)) return undefined
  const commandId = fields.get('commandId')
  const commandName = fields.get('commandName')
  const commandArgs = fields.get('commandArgs')
  const turnRef = fields.get('turnRef')
  return {
    kind: kind as WorkAuthorizationKind,
    action,
    ...commandId === undefined ? {} : { commandId },
    ...commandName === undefined ? {} : { commandName },
    ...commandArgs === undefined ? {} : { commandArgs },
    ...turnRef === undefined ? {} : { turnRef },
  }
}

/**
 * Whether a run's ref names the exact command that is authorizing a retry.
 *
 * This is the crash-retry check V3 section I2 requires: a host that died after
 * the run was written but before `command/done` is retried by the human, and the
 * retry must OBSERVE the existing run rather than duplicate it. Comparing the
 * commandId proves the retry is the SAME action, not a different one that
 * happens to find the same run.
 */
export function authorizationRefMatchesCommand(ref: string, commandId: string): boolean {
  const parsed = parseAuthorizationRef(ref)
  return parsed?.commandId === commandId
}
