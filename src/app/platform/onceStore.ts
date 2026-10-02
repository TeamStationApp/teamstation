/**
 * Whether this browser has already spent a sign-in link.
 *
 * `sessionStorage`, so a reload does not spend it a second time but a new tab
 * or a new visit starts clean. The token is one-use on the server; asking
 * twice is how a working link turns into an error message in front of
 * somebody who did nothing wrong.
 */
const KEY = 'gs.signIn.asked'

export function markAsked(requestId: string): void {
  try {
    window.sessionStorage.setItem(KEY, requestId)
  } catch {
    // Private browsing, or a storage quota. Asking twice is the cost.
  }
}

export function alreadyAsked(requestId: string): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === requestId
  } catch {
    return false
  }
}
