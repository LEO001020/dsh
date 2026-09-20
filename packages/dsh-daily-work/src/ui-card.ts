/**
 * The `daily-work` browser card's ACTION layer: four controls, one authority edge.
 *
 * WHY THIS FILE IS NOT A `.tsx`. V5 section 13 asks for "a minimal daily-work
 * browser UI plugin/card" with an N input, Start Work, Apply Target, Stop Work
 * and Status. The rendering is React; the part that can be WRONG in a way a
 * render cannot show is the part below — which command line each control emits,
 * which session it is addressed to, and what the returned text means. That part
 * is plain TypeScript so it can be tested against the real command contract
 * without a browser, and it is the part this module owns.
 *
 * THE AUTHORITY EDGE, and V5 section 13 is emphatic about it:
 *
 *   "UI actions must use the same human authority plane as slash commands:
 *    prefer `ctx.remote.commands.execute(...)` for `/work start N`,
 *    `/work target N`, `/work stop`, `/work status`. No separate authorization
 *    RPC."
 *
 * So every action here builds a LINE and calls the ONE `execute` face. This
 * module contains:
 *   - no authorization decision,
 *   - no run-record write,
 *   - no capacity arithmetic,
 *   - no second RPC.
 *
 * It cannot: it holds no service reference and no host handle. The only thing it
 * can reach is `execute`, whose host half is `CommandRuntime` — the same
 * registry a typed `/work target 9` reaches, which is what makes "the UI and the
 * slash command share exactly one authority edge" a structural property rather
 * than a claim. Writer R4 built that edge (`src/command-work.ts`, evidence
 * `qualification/results/R4-authorization/`); this module EXTENDS it and adds no
 * second one.
 *
 * WHY THE CALLER INJECTS `execute` RATHER THAN THIS MODULE REACHING `ctx.remote`.
 * The browser half of DSH is `ctx.remote.commands.execute(sessionId, line,
 * attachments)` returning `RemoteResult<CommandExecution | undefined>`
 * (`packages/interaction/commands/lib/typert.remote-client.d.ts:15`, called at
 * `packages/api/session-controller/src/client/sessions/session.ts:373`). Taking
 * that operation as a parameter means the browser bundle and the test drive the
 * SAME function type, so a green test is evidence about the shipped call shape
 * and not about a stand-in. It also keeps this module free of any client-package
 * import, which matters because those packages do not resolve in this package's
 * tree (measured; see the P7 report) — importing one would make this module
 * unbuildable for reasons that have nothing to do with the card.
 *
 * WHAT THIS MODULE DOES NOT DO, stated because the gap is the interesting part:
 * it does not render, and it does not reach the host. A card wired to the command
 * runtime is NOT proof that a user can complete the flow; see the report's
 * "CLAIMS I AM NOT MAKING".
 *
 * @module ui-card
 */

/**
 * The result shape the host returns for one command execution.
 *
 * A structural restatement of DSH's own `RemoteResult<CommandExecution |
 * undefined>` rather than an import, for the resolution reason in the header.
 * The three arms are the host's: an execution with a result, an execution that
 * resolved to no command (`value: undefined`), and a transport/refusal failure.
 */
export type CommandExecuteOutcome =
  | { readonly ok: true; readonly value: { readonly result: { readonly kind: string; readonly text?: string } } }
  | { readonly ok: true; readonly value: undefined }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * The one operation a card action may use.
 *
 * Deliberately the WHOLE remote surface this module is allowed to see. A caller
 * that wanted this module to write a setting directly would have to widen this
 * type, and that widening is the review point where a second authority edge
 * would be caught.
 */
export type ExecuteCommand = (
  sessionId: string,
  line: string,
) => Promise<CommandExecuteOutcome>

/** What one action did, in terms a card can render without re-parsing text. */
export interface CardActionOutcome {
  /** The exact line sent, so the card can show what it ran. */
  readonly line: string
  readonly ok: boolean
  /** The host's text, or the transport error's message. `''` when a command did not resolve. */
  readonly text: string
  /**
   * True when the host executed the line but it matched NO registered command.
   *
   * This is a distinct arm rather than an error: `/work` not being registered is
   * a composition fact (the command plugin is not mounted), and a card that
   * reported it as "the command failed" would send a reader looking at the work
   * service instead of at the profile.
   */
  readonly unmatched: boolean
}

/** The four controls V5 section 13 names, as a closed union. */
export type CardAction =
  | { readonly kind: 'start'; readonly target?: number }
  | { readonly kind: 'applyTarget'; readonly target: number }
  | { readonly kind: 'stop' }
  | { readonly kind: 'status' }

/**
 * The bounds the N input enforces, restated here rather than imported.
 *
 * WHY A SECOND COPY, when `target-setting.ts` already exports these. The browser
 * bundle cannot import the host module: it would pull the settings service and
 * the storage domain into the client graph. A restated constant that can drift is
 * a real risk, so the drift is TESTED rather than trusted — `ui-card.test.ts`
 * asserts these equal `MIN_TARGET_ACTIVE_CHILDREN` and
 * `MAX_TARGET_ACTIVE_CHILDREN`, so a change on either side fails a test instead
 * of silently making the card refuse a value the host accepts.
 */
export const CARD_MIN_TARGET = 1
export const CARD_MAX_TARGET = 30

/**
 * Parse the N input exactly as the host's `/work` grammar does.
 *
 * REFUSAL, NEVER CLAMP, and this mirrors `command-work.ts:parseTarget` on
 * purpose: a clamp would record a number the human did not ask for, so a user who
 * typed 50 would get a run claiming 30 with no indication their instruction was
 * altered. The card refuses client-side so the user sees it before a round trip,
 * and the host refuses again so a hostile payload gets the same answer.
 *
 * @returns the value, or the reason it is not a target.
 */
export function parseCardTarget(text: string): { readonly target: number } | { readonly reason: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { reason: 'a target is required' }
  if (!/^\d+$/u.test(trimmed)) {
    return { reason: `target ${JSON.stringify(trimmed)} is not a whole number` }
  }
  const target = Number(trimmed)
  if (!Number.isSafeInteger(target) || target < CARD_MIN_TARGET || target > CARD_MAX_TARGET) {
    return {
      reason: `target ${trimmed} is outside ${CARD_MIN_TARGET}..${CARD_MAX_TARGET}; `
        + `${CARD_MAX_TARGET} is the deployment's hard child capacity`,
    }
  }
  return { target }
}

/**
 * The command line for one action.
 *
 * A PURE FUNCTION, so the mapping from control to line is testable without a
 * registry and cannot depend on card state. Every line begins with the slash,
 * because that is what the host's parser expects — `CommandRuntime` matches on
 * the leading-slash form.
 */
export function commandLineFor(action: CardAction): string {
  switch (action.kind) {
    case 'start':
      return action.target === undefined ? '/work start' : `/work start ${String(action.target)}`
    case 'applyTarget':
      return `/work target ${String(action.target)}`
    case 'stop':
      return '/work stop'
    case 'status':
      return '/work status'
  }
}

/**
 * The card's action face, bound to one session.
 *
 * SCOPED TO ONE SESSION on purpose, and it is the V5 requirement rather than a
 * convenience: "If multiple roots exist, card is scoped to selected/current
 * Session." The session id is captured at construction, so no action can address
 * a different session than the one the card is showing — a card that took the
 * session per action could show session A's counts and apply a target to
 * session B.
 *
 * This mirrors the domain: a run is resolved by `findRunForSession`, and
 * `/work target N` refuses when the addressed session has no run. So the card
 * cannot reach another session's run even by accident.
 */
export interface WorkCardActions {
  readonly sessionId: string
  /** Start Work. With no N, the host uses the default for new runs. */
  start(target?: number): Promise<CardActionOutcome>
  /** Apply Target. Changes the SELECTED run's durable target, not the default. */
  applyTarget(target: number): Promise<CardActionOutcome>
  /** Stop Work. Refuses new admissions; running children keep their slots. */
  stop(): Promise<CardActionOutcome>
  /** Status. A pure read on the host. */
  status(): Promise<CardActionOutcome>
}

/**
 * Bind the four controls to one session's command plane.
 *
 * @param sessionId - the selected/current session. Captured, not per-call.
 * @param execute - the host's command operation. In the browser this is
 *   `ctx.remote.commands.execute`; in a test it is a recording fake.
 * @returns the action face. It holds no other capability.
 */
export function createWorkCardActions(
  sessionId: string,
  execute: ExecuteCommand,
): WorkCardActions {
  const run = async (line: string): Promise<CardActionOutcome> => {
    const outcome = await execute(sessionId, line)
    if (!outcome.ok) {
      return { line, ok: false, text: `${outcome.error.code}: ${outcome.error.message}`, unmatched: false }
    }
    if (outcome.value === undefined) {
      // The line was admitted but matched nothing. Reported as its own arm: see
      // `CardActionOutcome.unmatched`.
      return { line, ok: false, text: '', unmatched: true }
    }
    const { result } = outcome.value
    return { line, ok: result.kind === 'success', text: result.text ?? '', unmatched: false }
  }

  return {
    sessionId,
    start: async (target?: number) => await run(commandLineFor(
      target === undefined ? { kind: 'start' } : { kind: 'start', target },
    )),
    applyTarget: async (target: number) => await run(commandLineFor({ kind: 'applyTarget', target })),
    stop: async () => await run(commandLineFor({ kind: 'stop' })),
    status: async () => await run(commandLineFor({ kind: 'status' })),
  }
}

/**
 * One count line, as the display needs it.
 *
 * `value` is `undefined` when the command plane does not report the field. That
 * is a THIRD state, not a zero: "the host did not say" and "the host said zero"
 * are different facts, and a card that rendered an absent field as 0 would report
 * an idle deployment where it actually has no information. This is the same
 * distinction `counting.ts` makes between `capacityDeficit` (clamps) and
 * `heldReservations` (does not).
 */
export interface StatusField {
  readonly label: string
  readonly value: number | undefined
}

/** The display a card renders, parsed from the `/work status` text. */
export interface WorkStatusView {
  /** True when the session has no run. The remaining fields are then absent. */
  readonly noRun: boolean
  readonly runId: string | undefined
  readonly phase: string | undefined
  /** The run's durable target, as the command plane reports it. */
  readonly target: number | undefined
  /** Every count line the command plane reports, in the order it reports them. */
  readonly fields: readonly StatusField[]
  /**
   * Counts V5 section 13 asks the card to display that `/work status` does NOT
   * report. Named rather than silently omitted, so the card can show the gap
   * instead of a blank that reads as zero.
   *
   * MEASURED against `command-work.ts` `renderStatus` (`:180-193`), which emits
   * exactly: Run, Phase, Target, Durably admitted, Launching, Active assignments,
   * Stopping, Quarantined (unknown), Confirmed, Capacity deficit (reason) and
   * optionally Authorized by. Everything below is a field `Counts` carries
   * (`counting.ts`) that no line renders:
   *
   *   - `readyTasks` (:39) -- V5 names "ready"; the durable READY queue is writer
   *     P5's concurrent work this round, and P5 may name the concept differently,
   *     so this module does NOT invent a field name.
   *   - `waitingOwnedTool` (:47) and `providerWaiting` (:49) -- the two "waiting"
   *     counts, which `counting.ts`'s own header keeps separate on purpose.
   *   - `heldReservations` (:68) -- the AUTHORITATIVE occupancy, and the one this
   *     list most wants. It is the field that makes an over-admission visible,
   *     because `capacityDeficit` clamps at zero and reads identically for a full
   *     wave and an overshoot. V5 asks for "admitted/reserved"; `Durably admitted`
   *     IS rendered, but this stricter number is not.
   *   - `targetOvershoot` (:83) -- the other half of the same CAP-10 story.
   *   - the global hard cap -- V5 asks for "global hard-cap occupancy". It lives on
   *     `CapacitySnapshot` (`capacity.ts:159`), a different service call, and no
   *     command surfaces it.
   *
   * Extending `renderStatus` is a small change in P5's file, not mine, so it is
   * REPORTED rather than made.
   */
  readonly unreported: readonly string[]
  /** The raw host text, so a card can show exactly what the host said. */
  readonly raw: string
}

/**
 * The display fields V5 section 13 names that the command plane does not report.
 *
 * Declared as data so the test asserts the SET rather than a hand-typed list in
 * two places, and so a future `renderStatus` extension that adds one makes this
 * list shrink rather than leaving a stale claim in a comment.
 */
export const STATUS_FIELDS_NOT_REPORTED: readonly string[] = [
  'ready',
  'waiting (owned tool)',
  'waiting (provider)',
  'held reservations (authoritative occupancy)',
  'target overshoot',
  'global hard-cap occupancy',
]

/** The label prefix of each count line `renderStatus` emits, in its order. */
const COUNT_LABELS: readonly string[] = [
  'Durably admitted',
  'Launching',
  'Active assignments',
  'Stopping',
  'Quarantined (unknown)',
  'Confirmed',
]

/**
 * Parse the host's `/work status` text into the card's display.
 *
 * PARSING THE RENDERED TEXT RATHER THAN READING THE RECORD is a deliberate
 * choice with a real cost and a real benefit. The cost: a wording change in
 * `renderStatus` breaks this parser. The benefit: the card displays EXACTLY what
 * the command plane reports, so the card and the slash command cannot disagree —
 * a card that read the record directly would be a second opinion, and the two
 * would drift the first time admission changed. `renderStatus`'s own header says
 * the counts are listed individually and never collapsed, which is the property
 * this parser preserves.
 *
 * @param text - the host's `CommandResult.text`.
 * @returns the display. Every field is `undefined` rather than `0` when absent.
 */
export function parseStatusText(text: string): WorkStatusView {
  const lines = text.split('\n').map(line => line.trim())
  const value = (label: string): string | undefined => {
    const prefix = `${label}: `
    const found = lines.find(line => line.startsWith(prefix))
    return found === undefined ? undefined : found.slice(prefix.length)
  }
  const numeric = (label: string): number | undefined => {
    const raw = value(label)
    if (raw === undefined) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  // "No active run for this session." is the host's no-run arm. It is a SUCCESS
  // with an explanatory text, not an error, so a card must recognise it rather
  // than treating any success as a run.
  const noRun = text.includes('No active run for this session')

  return {
    noRun,
    runId: value('Run'),
    phase: value('Phase'),
    target: numeric('Target'),
    fields: COUNT_LABELS.map(label => ({ label, value: numeric(label) })),
    // Only claimed absent when a run EXISTS: with no run the host reports no
    // counts at all, and listing them as "unreported" would blame the wrong
    // thing.
    unreported: noRun ? [] : STATUS_FIELDS_NOT_REPORTED,
    raw: text,
  }
}

/**
 * The capacity-deficit line, kept separate because its REASON is load-bearing.
 *
 * V5 section 13 asks for "deficit + reason" and the reason is the part that
 * matters: `counting.ts` documents that `capacityDeficit` clamps at zero, so an
 * overshoot and a healthy full wave read identically. `deficitReason` is what
 * distinguishes them (`'target_exceeded'` vs `'none'`), and a card that showed
 * only the number would hide the one condition it exists to surface.
 */
export function parseDeficit(text: string): { readonly deficit: number | undefined; readonly reason: string | undefined } {
  const line = text.split('\n').map(candidate => candidate.trim())
    .find(candidate => candidate.startsWith('Capacity deficit: '))
  if (line === undefined) return { deficit: undefined, reason: undefined }
  const body = line.slice('Capacity deficit: '.length)
  const open = body.indexOf('(')
  const close = body.lastIndexOf(')')
  const deficit = Number(body.slice(0, open === -1 ? undefined : open).trim())
  return {
    deficit: Number.isFinite(deficit) ? deficit : undefined,
    reason: open === -1 || close <= open ? undefined : body.slice(open + 1, close),
  }
}
