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

/** Every upgrade socket a listener has taken, whichever listener it was. */
const claimed = new WeakSet<Duplex>()

/**
 * Records that a listener has taken this upgrade, so the other listeners on
 * the same server neither answer it nor destroy it.
 */
export function claimUpgrade(socket: Duplex): void {
  claimed.add(socket)
}

/**
 * For a listener that does not own this upgrade's path and may share the
 * server with others. A socket another listener has taken is left alone.
 * When this is the server's only listener, `orphan` answers it at once.
 * Otherwise the others are heard first, and `orphan` answers it a tick later
 * if none took it and nothing has answered it.
 */
export function leaveUpgrade(
  server: Server,
  socket: Duplex,
  orphan: () => void
): void {
  if (claimed.has(socket)) return
  if (server.listenerCount('upgrade') <= 1) {
    orphan()
    return
  }
  setImmediate(() => {
    if (claimed.has(socket) || socket.destroyed || !socket.writable) return
    orphan()
  })
}

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
      if (claim(req, socket, head)) {
        claimUpgrade(socket)
        return
      }
    }
    socket.destroy()
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
  }
}
