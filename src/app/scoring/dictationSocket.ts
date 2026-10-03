import type { DictationSocket } from './dictationTypes'

/**
 * The browser's dictation socket. The session cookie goes with it; a bearer
 * token is not added, because a browser's `WebSocket` has nowhere to put one.
 */
export function openDictationSocket(
  url: string,
  _token?: string
): DictationSocket {
  return new WebSocket(url) as unknown as DictationSocket
}
