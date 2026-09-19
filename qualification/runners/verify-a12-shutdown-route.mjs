/**
 * A12 shutdown instrument: a qualification-only Web route that asks the
 * launcher for its OWN bounded shutdown.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT A PRODUCT CHANGE
 *
 * `apps/cli/src/profile-boot.ts` installs SIGTERM (exit 0) and SIGINT (exit 130)
 * handlers. On win32 Node's `child.kill()` maps both to TerminateProcess, so
 * neither handler runs and no exit code is observable — which is exactly why the
 * recorded A12 result carries no clean-shutdown claim. A throwaway-child matrix
 * run on this machine (see `signal-probe.txt`) established that the only
 * catchable console event this platform can deliver to a child is
 * CTRL_BREAK_EVENT, which Node surfaces as SIGBREAK; the launcher registers no
 * SIGBREAK handler, and the Web profile has no in-product exit command either
 * (`exitOnStdinEnd` is mounted by the acp/sdk apps only, and a piped stdin that
 * is never resumed does not even emit `end`).
 *
 * So the host has no reachable graceful-stop route on this platform. This row
 * supplies one for the measurement, calling the SAME `ctx.appExit` callback the
 * product's own `exitOnStdinEnd` calls — so what is measured is the production
 * shutdown path (bounded dispose, then exit) rather than a process kill.
 *
 * AUTHORIZATION. The route reuses the product's real browser-trust fence through
 * `ctx.connection.requestRejection`, so an unauthenticated caller gets the same
 * 401 as every other /api route. It does NOT invent auth, does not widen
 * permissions, and does not bypass the fence. The route is mounted only by this
 * gate's own `--patch` overlay and is never part of the delivered profile.
 *
 * @module verify-a12-shutdown-route
 */

/** Services required before the route can register. */
export const inject = ['webServer', 'connection', 'appExit']

export const name = 'a12-shutdown-route'

/** The one path this instrument owns. */
export const SHUTDOWN_PATH = '/a12/shutdown'

/**
 * Register the qualification-only shutdown route.
 * @param ctx - the host context carrying webServer, connection, and appExit.
 */
export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('a12-shutdown-route: the launcher did not provide ctx.appExit before the tree mounted')
  }
  const route = {
    kind: 'prefix',
    path: SHUTDOWN_PATH,
    handler: (req, res) => {
      // The product's own fence decides, exactly as the /api route does.
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      // The code is fixed at 0 so the measurement reads the launcher's own
      // exit path rather than this route's opinion about success.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('shutdown requested\n')
      // After the response is flushed: appExit disposes the whole tree, which
      // includes this route's own server.
      setImmediate(() => { exit(0) })
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'a12-shutdown-route: instrument route')
}
