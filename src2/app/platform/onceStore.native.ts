/**
 * Whether this launch has already spent a sign-in link.
 *
 * Memory, not storage, and that is the same rule the web file keeps rather
 * than a weaker one: `sessionStorage` lasts as long as the tab, and an app
 * process lasts as long as the app is open. A relaunch is a new visit, and a
 * new visit is allowed to try the link it was given.
 */
let asked: string | undefined

export function markAsked(requestId: string): void {
  asked = requestId
}

export function alreadyAsked(requestId: string): boolean {
  return asked === requestId
}
