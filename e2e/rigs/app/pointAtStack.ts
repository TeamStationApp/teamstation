/**
 * Points the develop app at a stack for its next fresh launch, by the
 * develop build's own server link. The runner has already done this before a
 * scenario starts (open the link, clear the app's state, open it again); a
 * scenario that clears the app's state itself calls `pointAtStack` after.
 * Every step is a maestro-d command on the device the scenario was handed.
 */

/** What the app needs from the attached maestro-d device. */
export interface StackDevice {
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  stopApp: (options: { appId: string }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (options: Record<string, unknown>) => Promise<unknown>
  assertVisible: (options: Record<string, unknown>) => Promise<unknown>
}

/** The develop build's scheme; a stable build claims none, so these reach only a develop build. */
export const PHONE_SCHEME = 'teamstation-develop'

/** The link that keeps `origin` for the next launch, or `clear` with none. */
export function serverLink(origin: string | null): string {
  return origin == null
    ? `${PHONE_SCHEME}://server?clear=1`
    : `${PHONE_SCHEME}://server?origin=${encodeURIComponent(origin)}`
}

/** A develop build's own link to a page of the app: `groups/league/x/scheduler`. */
export function appLink(path: string): string {
  return `${PHONE_SCHEME}://${path.replace(/^\/+/, '')}`
}

/** `text` as a pattern that matches it literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * iOS may ask once whether to open a link in the app. Taps its Open when it
 * is on screen; a screen without it is the ordinary case.
 */
async function acceptOpenPrompt(m: StackDevice): Promise<void> {
  let asked = true
  try {
    await m.assertVisible({ text: '^Open$', timeout: 2500 })
  } catch {
    asked = false
  }
  if (asked) await m.tapOn({ text: '^Open$' })
}

/**
 * Opens `link` in the app from a stopped app, so the launch reads it: the
 * app routes only the link it was launched with.
 */
export async function openInApp(
  m: StackDevice,
  appId: string,
  link: string
): Promise<void> {
  await m.stopApp({ appId })
  await m.openLink({ link })
  await acceptOpenPrompt(m)
}

/**
 * Points the app at `origin` and launches it fresh, so the launch a test
 * exercises is the ordinary one, talking to that stack.
 */
export async function pointAtStack(
  m: StackDevice,
  origin: string,
  appId: string
): Promise<void> {
  await openInApp(m, appId, serverLink(origin))
  const host = escapeRegExp(new URL(origin).host)
  await m.assertVisible({ text: `.*${host}.*Restart TeamStation.*` })
  await m.launchApp({ appId, stopApp: true })
}
