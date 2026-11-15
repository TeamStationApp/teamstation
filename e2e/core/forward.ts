import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Forwarding an upstream reply, for the stack's front and the fault proxy.
 * An upstream that dies mid-reply (a scenario restarting or killing the API)
 * must cost that one request, never the server forwarding it: an `'error'`
 * with no listener is an uncaught exception, and headers cannot be written
 * twice.
 */

/** Sends `reply` on to `res`, closing `res` if the reply breaks off. */
export function sendReply(
  reply: IncomingMessage,
  res: ServerResponse,
  status: number
): void {
  reply.on('error', () => {
    res.destroy()
  })
  res.writeHead(status, reply.headers)
  reply.pipe(res)
}

/** Answers an upstream that failed: a 502 when nothing was sent yet, else a closed connection. */
export function upstreamFailed(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(502)
  res.end()
}
