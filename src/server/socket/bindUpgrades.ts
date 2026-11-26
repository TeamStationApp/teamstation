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
  claims: readonly UpgradeClaim[],
  admit?: (req: IncomingMessage) => Promise<number>
): () => void {
  const dispatch = (
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
  const onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    if (admit == null) {
      dispatch(req, socket, head)
      return
    }
    claimUpgrade(socket)
    socket.on('error', () => socket.destroy())
    admit(req)
      .then(
        wait => {
          if (socket.destroyed) return
          if (wait === 0) {
            dispatch(req, socket, head)
            return
          }
          socket.once('finish', () => socket.destroy())
          socket.end(
            `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${wait}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
          )
        },
        () => {
          // A credential lookup can fail before the protocol handler gets the socket.
          socket.once('finish', () => socket.destroy())
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
          )
        }
      )
      .catch(() => socket.destroy())
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
  }
}
