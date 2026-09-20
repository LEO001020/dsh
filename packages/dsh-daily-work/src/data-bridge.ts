/**
 * The seam between writer R5's bridge (`packages/dsh-ipython`) and this data plane.
 *
 * WHY A SEPARATE FILE AND NOT A METHOD ON THE BRIDGE.
 *
 * R5 owns `packages/dsh-ipython/`; this slice owns `packages/dsh-daily-work/`. The
 * integration point therefore has to be a NARROW, DOCUMENTED CONTRACT rather than
 * one writer reaching into the other's file. This module is that contract, and it
 * is deliberately the whole of it: one reserved name prefix, one caller
 * constructor, one router.
 *
 * THE ROUTING RULE, AND WHY IT IS A PREFIX RATHER THAN A SECOND PROTOCOL.
 *
 * A `dsh.data` request arrives on the SAME bridge frame R5 already dispatches
 * (`{type:'call', tool, arguments, leaseId, cellId, epoch}`) with a tool name
 * beginning `data:`. That name is NOT a tool and never reaches
 * `ctx.tools.execute`. The reserved prefix is what makes the distinction
 * mechanical:
 *
 *   `dsh.call("read", {...})`      -> exact ToolRuntime semantics, SERIAL.
 *   `dsh.data.fs.capture(...)`     -> this plane, bounded read concurrency.
 *
 * WHY NOT REUSE `dsh.call` AND LET A TOOL DO THE WORK. Because the two have
 * different concurrency semantics and the difference is the whole point of V3 §K.
 * `ctx.tools.execute()` runs one complete ToolRuntime pipeline and Native
 * AgentLoop/PTC coordinate their ordered pre/post stages through a module-local
 * scheduler Symbol that is NOT a public downstream seam. Issuing several
 * `execute()` calls concurrently therefore gets no scheduling parity -- it just
 * runs several pipelines whose ordered stages can interleave. Bulk data reads need
 * capability-level read concurrency, which is a different primitive. A reserved
 * prefix keeps the two apart in ONE place, at the router, rather than relying on
 * every future caller to remember which is which.
 *
 * AUTHORITY IS HOST-OWNED. {@link dataCallerFromEnclosing} is the ONLY constructor
 * of a {@link DataCaller} in production code, and it reads every field from the
 * live enclosing execution. A request payload cannot name a Session, a workspace
 * or a scope: those fields are not read from the arguments, and a payload that
 * tries to assert one is refused by {@link refuseForgedClaims} inside the plane.
 *
 * WHAT R5 MUST DO TO WIRE THIS (stated as a contract, since this file cannot
 * implement it without editing R5's package):
 *
 *   1. In the bridge's per-call handler, before dispatch, test
 *      `isDataRequest(call.tool)`.
 *   2. When true, call {@link routeDataRequest} with the plane, the caller built
 *      from the live enclosing authority, the tool name and the arguments, and
 *      return its outcome as the call's result.
 *   3. When false, dispatch to `ctx.tools.execute` exactly as today.
 *
 * Step 1's test is a single prefix check, so the change on R5's side is one
 * branch. There is no second listener, no second socket and no second protocol.
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  DataPlaneError,
  type DataCaller,
  type DataPlane,
} from './data-plane.ts'

/**
 * The reserved prefix that marks a `dsh.data` request.
 *
 * A colon is used rather than a dot because a dotted name could collide with a
 * real tool (`data.read`), while `data:` cannot be a tool name: DSH tool names
 * are identifiers, and a colon is not valid in one. The prefix is therefore
 * un-collidable by construction rather than by convention.
 */
export const DATA_TOOL_PREFIX = 'data:'

/** Whether a bridge call's tool name is a `dsh.data` request. */
export function isDataRequest(tool: string): boolean {
  return tool.startsWith(DATA_TOOL_PREFIX)
}

/**
 * The authority the host binds to one enclosing cell, as this plane needs it.
 *
 * A structural subset of R5's `EnclosingAuthority` plus the cell's own identity.
 * Structural rather than imported so this package does not depend on
 * `dsh-ipython` at all: the dependency runs one way, from the integration point
 * to the plane, and `dsh-daily-work` stays loadable without a kernel.
 */
export interface EnclosingDataAuthority {
  /** The enclosing call's cancellation. A revoked cell stops its reads. */
  readonly signal?: AbortSignal
  /** The Agent/Session the enclosing `ipython` call runs as. Host-supplied. */
  readonly sessionId: string
  /** The caller's workspace, which is the history authorization key. */
  readonly cwd?: string
  /** A label for attribution in records. Never used for a decision. */
  readonly callLabel?: string
}

/**
 * Build the plane's caller from the live enclosing execution.
 *
 * This is the ONLY place a `DataCaller` is constructed from host facts. Every
 * field comes from the authority the bridge read from the live tool execution, so
 * a Python program cannot widen its own authority by naming it -- the same
 * property R5's bridge enforces for tool calls, applied to the read plane.
 *
 * @param authority - the enclosing cell's host-read identity.
 * @returns the caller to pass to every plane method.
 */
export function dataCallerFromEnclosing(authority: EnclosingDataAuthority): DataCaller {
  return {
    sessionId: authority.sessionId as SessionId,
    ...authority.cwd === undefined ? {} : { cwd: authority.cwd },
    ...authority.signal === undefined ? {} : { signal: authority.signal },
    ...authority.callLabel === undefined ? {} : { callLabel: authority.callLabel },
  }
}

/** What a routed data request returns to the bridge. */
export interface DataRouteOutcome {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** The argument object a request carries. Validated here, not trusted. */
function asArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DataPlaneError(
      'DATA_INVALID_REQUEST',
      `dsh.data: the arguments must be a JSON object, got ${Array.isArray(value) ? 'an array' : typeof value}`,
    )
  }
  return value as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, name: string, tool: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new DataPlaneError(
      'DATA_INVALID_REQUEST',
      `${tool}: "${name}" is required and must be a non-empty string`,
    )
  }
  return value
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalInt(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DataPlaneError('DATA_INVALID_REQUEST', `"${name}" must be an integer when present`)
  }
  return value
}

/**
 * Route one `data:*` request to the plane.
 *
 * A THROWN REFUSAL IS CONVERTED TO A STRUCTURED ERROR, not swallowed: the bridge
 * protocol carries `{code, message}` so a Python caller can branch on the code
 * without parsing prose. An unknown `data:*` name is its OWN refusal naming the
 * unknown method, rather than falling through to the tool registry -- a fall-through
 * would let a typo become a tool call, which is exactly the conflation the
 * reserved prefix exists to prevent.
 *
 * @param plane - the live data plane.
 * @param caller - the host-bound caller.
 * @param tool - the reserved-prefix tool name.
 * @param rawArguments - the request's argument object.
 * @returns the structured outcome; never throws for a plane-level refusal.
 */
export async function routeDataRequest(
  plane: DataPlane,
  caller: DataCaller,
  tool: string,
  rawArguments: unknown,
): Promise<DataRouteOutcome> {
  try {
    if (!isDataRequest(tool)) {
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        `routeDataRequest received "${tool}", which does not begin with "${DATA_TOOL_PREFIX}"`,
      )
    }
    const method = tool.slice(DATA_TOOL_PREFIX.length)
    const args = asArguments(rawArguments)
    const value = await dispatch(plane, caller, method, args)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof DataPlaneError) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    // A plane-level error from `artifacts.ts` / `observations.ts` carries its own
    // stable code and is surfaced under it rather than flattened into a generic
    // failure: "the artifact is corrupt" and "the store is broken" need different
    // next actions, and a caller cannot tell them apart from one code.
    const coded = error as { code?: unknown; message?: unknown }
    if (typeof coded.code === 'string' && coded.code.length > 0) {
      return {
        ok: false,
        error: {
          code: coded.code,
          message: typeof coded.message === 'string' ? coded.message : String(error),
        },
      }
    }
    return {
      ok: false,
      error: { code: 'DATA_INTERNAL', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * The method table.
 *
 * Deliberately a SWITCH over the small documented surface rather than a dynamic
 * dispatch over the plane's methods. A dynamic dispatch would expose every public
 * method of the plane -- including `dispose()` and the accounting helpers -- to a
 * Python caller, and "the model can call whatever the object happens to have" is
 * the opposite of a small, reviewed surface (V3 §K5).
 */
async function dispatch(
  plane: DataPlane,
  caller: DataCaller,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    // -- fs ----------------------------------------------------------------
    case 'fs.capture': {
      const requestedRange = readRange(args['requested_range'])
      const result = await plane.fsCapture(caller, {
        path: requireString(args, 'path', 'data:fs.capture'),
        ...optionalString(args, 'media_type') === undefined ? {} : { mediaType: optionalString(args, 'media_type') as string },
        ...optionalString(args, 'observation_id') === undefined ? {} : { observationId: optionalString(args, 'observation_id') as string },
        ...requestedRange === undefined ? {} : { requestedRange },
        // THE WHOLE ARGUMENT OBJECT IS THE CLAIM, and that is the design rather
        // than a shortcut. `mintObservation` reads exactly three things from a
        // kernel claim -- a suggested `locator`, a suggested `mediaType` and a
        // declared `transform` -- and `refuseForgedClaims` refuses any payload that
        // names a HOST-authored path (`captured`, `authority`, `source.acquiredAt`,
        // ...). Passing the caller's own arguments here is what routes a forged
        // payload into that refusal, so a program that sends `captured: {...}`
        // is told which path it tried to forge instead of having it silently
        // dropped.
        claim: args,
      })
      // The DESCRIPTOR is returned so a caller can page it. The BYTES are not:
      // returning them here is what would put 32 MiB into a frame.
      return {
        observation_id: result.observationId,
        descriptor: result.descriptor,
        identity: result.identity,
        reference: result.reference,
        gaps: result.gaps,
        acquired_bytes: result.accounting.acquiredBytes,
        persisted_bytes: result.accounting.persistedBytes,
      }
    }
    case 'fs.page': {
      // ONE page at a cursor. This is what a Python `async for` uses, so a caller
      // that wants only the first few pages pays for only those: the host reads one
      // byte window of an immutable object per call and re-reads nothing.
      const page = await plane.openPages(caller, {
        descriptor: args['descriptor'],
        ...optionalInt(args, 'max_bytes') === undefined ? {} : { pageBytes: optionalInt(args, 'max_bytes') as number },
      }).next(optionalString(args, 'cursor'))
      return {
        offset: page.offset,
        bytes: Buffer.from(page.bytes).toString('base64'),
        byte_length: page.bytes.byteLength,
        exhausted: page.exhausted,
        ...page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
        sha256: page.sha256,
      }
    }
    case 'fs.pages': {
      const handle = plane.openPages(caller, {
        descriptor: args['descriptor'],
        ...optionalInt(args, 'max_bytes') === undefined ? {} : { pageBytes: optionalInt(args, 'max_bytes') as number },
      })
      const walked = await handle.walk({ ...optionalInt(args, 'max_pages') === undefined ? {} : { maxPages: optionalInt(args, 'max_pages') as number } })
      return {
        observation_id: handle.observationId,
        artifact: handle.artifact,
        sha256: handle.sha256,
        artifact_bytes: handle.artifactBytes,
        pages: walked.pages,
        bytes: walked.bytes,
        exhausted: walked.exhausted,
        io: walked.io,
      }
    }
    case 'fs.read_range': {
      const bytes = await plane.readRange(caller, {
        descriptor: args['descriptor'],
        offset: optionalInt(args, 'offset') ?? 0,
        length: optionalInt(args, 'length') ?? 0,
      })
      // A bounded range IS the requested value, so returning it inline is correct
      // -- the caller named its size. The bound is the caller's, not an accident.
      return {
        offset: optionalInt(args, 'offset') ?? 0,
        bytes: Buffer.from(bytes).toString('base64'),
        byte_length: bytes.byteLength,
      }
    }
    // -- artifacts ---------------------------------------------------------
    case 'artifacts.save': {
      return await plane.saveAttachment(caller, {
        descriptor: args['descriptor'],
        ...optionalString(args, 'name') === undefined ? {} : { name: optionalString(args, 'name') as string },
      })
    }
    case 'artifacts.open': {
      const opened = await plane.readAttachment(caller, {
        attachmentId: requireString(args, 'attachment_id', 'data:artifacts.open'),
        name: requireString(args, 'name', 'data:artifacts.open'),
        bytes: optionalInt(args, 'bytes') ?? 0,
      })
      return { sha256: opened.sha256, byte_length: opened.bytes.byteLength }
    }
    // -- history -----------------------------------------------------------
    case 'history.search': {
      const surfaces = args['surfaces']
      const page = await plane.historySearch(caller, {
        query: requireString(args, 'query', 'data:history.search'),
        ...optionalString(args, 'session_id') === undefined ? {} : { sessionId: optionalString(args, 'session_id') as string },
        ...optionalString(args, 'cursor') === undefined ? {} : { cursor: optionalString(args, 'cursor') as string },
        ...optionalInt(args, 'max_hits') === undefined ? {} : { maxHits: optionalInt(args, 'max_hits') as number },
        ...Array.isArray(surfaces) ? { surfaces: surfaces.map(String) } : {},
      })
      return page
    }
    case 'history.close': {
      plane.closeHistoryScan(requireString(args, 'cursor', 'data:history.close'))
      return { closed: true }
    }
    // -- web ---------------------------------------------------------------
    case 'web.fetch': {
      const outcome = await plane.webFetch(caller, {
        url: requireString(args, 'url', 'data:web.fetch'),
        ...optionalInt(args, 'max_body_chars') === undefined ? {} : { maxBodyChars: optionalInt(args, 'max_body_chars') as number },
        ...optionalString(args, 'etag') === undefined ? {} : { etag: optionalString(args, 'etag') as string },
        ...optionalString(args, 'last_modified') === undefined ? {} : { lastModified: optionalString(args, 'last_modified') as string },
      })
      return {
        provider: outcome.provider,
        record: outcome.record,
        // The body is SUMMARIZED, never returned. A fetched page is bulk data, so
        // the caller gets the acquisition record and the body's identity, and
        // captures the bytes into the artifact store if it wants them.
        body: outcome.body,
        gaps: outcome.gaps,
      }
    }
    case 'web.search': {
      const outcome = await plane.webSearch(caller, {
        query: requireString(args, 'query', 'data:web.search'),
        ...optionalInt(args, 'max_results') === undefined ? {} : { maxResults: optionalInt(args, 'max_results') as number },
      })
      return { provider: outcome.provider, provenance: outcome.provenance }
    }
    // -- projection --------------------------------------------------------
    case 'projection.manifest': {
      const descriptors = args['descriptors']
      if (!Array.isArray(descriptors)) {
        throw new DataPlaneError(
          'DATA_INVALID_REQUEST',
          'data:projection.manifest: "descriptors" must be an array of observation descriptors',
        )
      }
      const emitted = args['emitted']
      if (typeof emitted !== 'string') {
        throw new DataPlaneError(
          'DATA_INVALID_REQUEST',
          'data:projection.manifest: "emitted" must be the exact string that entered the model request',
        )
      }
      return plane.projectionManifest(caller, {
        descriptors,
        mode: readProjectionMode(args['mode']),
        selectorName: requireString(args, 'selector_name', 'data:projection.manifest'),
        selectorVersion: requireString(args, 'selector_version', 'data:projection.manifest'),
        ...optionalString(args, 'selector_digest') === undefined ? {} : { selectorDigest: optionalString(args, 'selector_digest') as string },
        selectedBytes: optionalInt(args, 'selected_bytes') ?? 0,
        ...optionalInt(args, 'selected_items') === undefined ? {} : { selectedItems: optionalInt(args, 'selected_items') as number },
        ...optionalInt(args, 'omitted_bytes') === undefined ? {} : { omittedBytes: optionalInt(args, 'omitted_bytes') as number },
        ...optionalInt(args, 'omitted_items') === undefined ? {} : { omittedItems: optionalInt(args, 'omitted_items') as number },
        emitted,
      })
    }
    default:
      throw new DataPlaneError(
        'DATA_INVALID_REQUEST',
        `"${DATA_TOOL_PREFIX}${method}" is not a dsh.data method. The surface is deliberately small and closed; `
        + 'an unknown name is refused here rather than falling through to the tool registry, because a '
        + 'fall-through would turn a typo into a tool call.',
      )
  }
}

function readRange(value: unknown): { offset: number; length?: number } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DataPlaneError('DATA_INVALID_REQUEST', '"requested_range" must be an object with offset/length')
  }
  const record = value as Record<string, unknown>
  const offset = record['offset']
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new DataPlaneError('DATA_INVALID_REQUEST', '"requested_range.offset" must be a non-negative integer')
  }
  const length = record['length']
  if (length === undefined || length === null) return { offset }
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    throw new DataPlaneError('DATA_INVALID_REQUEST', '"requested_range.length" must be a non-negative integer')
  }
  return { offset, length }
}

function readProjectionMode(value: unknown): 'exhaustive' | 'bounded' | 'sampled' | 'head' {
  const allowed = ['exhaustive', 'bounded', 'sampled', 'head'] as const
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DataPlaneError(
      'DATA_INVALID_REQUEST',
      `"mode" must be one of ${allowed.join(', ')}; an unknown mode cannot be recorded because it would `
      + 'decide whether the omission count is a measurement or a floor',
    )
  }
  return value as 'exhaustive' | 'bounded' | 'sampled' | 'head'
}

/**
 * The Python method names this router accepts, for the client's own documentation
 * and for a test that asserts the two lists cannot drift.
 */
export const DATA_METHODS: readonly string[] = Object.freeze([
  'fs.capture',
  'fs.page',
  'fs.pages',
  'fs.read_range',
  'artifacts.save',
  'artifacts.open',
  'history.search',
  'history.close',
  'web.fetch',
  'web.search',
  'projection.manifest',
])
