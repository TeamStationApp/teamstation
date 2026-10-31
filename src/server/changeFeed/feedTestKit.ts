import { connect, createServer, type Server, type Socket } from 'node:net'

import { testRedisUrl } from '../../test/scoreboardKit'
import type { FeedHandlers } from './feed'

export const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function until(
  check: () => boolean | Promise<boolean>,
  what: string
): Promise<void> {
  const deadline = Date.now() + 8000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Never saw ${what}`)
    await wait(5)
  }
}

/** A handler that writes down what it hears. */
export function hearer(): Required<FeedHandlers> & {
  payloads: Array<string | undefined>
  listenings: boolean[]
} {
  const payloads: Array<string | undefined> = []
  const listenings: boolean[] = []
  return {
    payloads,
    listenings,
    onPayload: payload => {
      payloads.push(payload)
    },
    onListening: first => {
      listenings.push(first)
    }
  }
}

/**
 * Redis behind a door, so a test can take it away from one client without
 * disturbing anything else using the same Redis.
 */
export interface RedisDoor {
  url: string
  open: () => Promise<void>
  shut: () => Promise<void>
}

export async function redisDoor(startOpen = true): Promise<RedisDoor> {
  const target = new URL(testRedisUrl)
  const sockets = new Set<Socket>()
  let server: Server | undefined
  let port = 0
  const open = async (): Promise<void> => {
    if (server != null) return
    const next = createServer(inbound => {
      const outbound = connect(Number(target.port), target.hostname)
      for (const socket of [inbound, outbound]) {
        sockets.add(socket)
        socket.on('error', () => undefined)
        socket.on('close', () => {
          sockets.delete(socket)
          inbound.destroy()
          outbound.destroy()
        })
      }
      inbound.pipe(outbound)
      outbound.pipe(inbound)
    })
    await new Promise<void>(resolve => {
      next.listen(port, '127.0.0.1', resolve)
    })
    const address = next.address()
    if (address != null && typeof address !== 'string') port = address.port
    server = next
  }
  const shut = async (): Promise<void> => {
    const closing = server
    server = undefined
    for (const socket of sockets) socket.destroy()
    if (closing != null)
      await new Promise(resolve => {
        closing.close(resolve)
      })
  }
  await open()
  const url = `redis://127.0.0.1:${port}${target.pathname}`
  if (!startOpen) await shut()
  return { url, open, shut }
}
