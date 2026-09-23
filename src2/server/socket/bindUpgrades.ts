import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Decides one upgrade. True means this claim has taken the socket: it will
 * accept it or answer it. False means the socket is unchanged.
 */
export type UpgradeClaim = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => boolean

/**
 * The server's one `upgrade` listener.
 *
 * Node hands an upgrade to every listener, and every listener gets the same
 * socket. A listener that answers for a path it does not own writes that
 * answer onto a handshake another listener is about to accept. Claims run in
 * order. The first to take the socket ends the search, and a socket nobody
 * takes is destroyed.
 */
export function bindUpgrades(
  server: Server,
  claims: readonly UpgradeClaim[]
): () => void {
  const onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    for (const claim of claims) {
      if (claim(req, socket, head)) return
    }
    socket.destroy()
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
  }
}
