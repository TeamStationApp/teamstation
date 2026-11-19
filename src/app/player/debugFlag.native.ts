/**
 * `?debug=1` is a browser's: the phone app has no address to carry it, and
 * none of the browser's storage, so its player never draws the readout.
 */
export function playerDebug(): boolean {
  return false
}
