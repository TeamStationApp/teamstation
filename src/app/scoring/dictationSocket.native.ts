import type { WebSocketConstructor } from '../../common/gameSocket'
import { dictationHeaders } from './dictationHeaders'
import type { DictationSocket } from './dictationTypes'

/**
 * The phone's dictation socket. React Native's `WebSocket` takes headers as a
 * third argument, which is how the session token rides along: a phone has no
 * cookie for the server to read.
 */
export function openDictationSocket(
  url: string,
  token?: string
): DictationSocket {
  const Impl = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
  if (Impl == null) throw new Error('This phone has no WebSocket')
  const headers = dictationHeaders(token)
  const socket =
    headers == null ? new Impl(url) : new Impl(url, undefined, { headers })
  return socket as unknown as DictationSocket
}
