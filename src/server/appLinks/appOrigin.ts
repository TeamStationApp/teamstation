import { badRequest } from '../../common/errors'

/**
 * The app a sign-in request names by its link host, once it is known to be
 * one this server signs in.
 *
 * Absent is a sign-in from the web, whose link stays on the server's own
 * address. Anything not configured is refused before the request is counted
 * or the address looked up, so the answer says nothing about the account; and
 * a link is never mailed to a host whose operating-system verification nobody
 * here controls.
 */
export function allowedAppOrigin(
  appOrigin: string | undefined,
  appOrigins: readonly string[]
): string | null {
  if (appOrigin == null) return null
  if (!appOrigins.includes(appOrigin))
    throw badRequest('appOrigin is not an app this server signs in to')
  return appOrigin
}
