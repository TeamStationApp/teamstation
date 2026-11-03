import { createServer, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ValkeyCache } from '../server/cache/valkeyCache'

/**
 * A stand-in for Valkey that answers until it is told to go silent, and then
 * keeps every connection open and answers nothing: what a client sees of a
 * partition that drops packets. While it answers, a `GET` is a miss and every
 * other command `OK`, which is all a client's handshake asks.
 */
export interface SilentValkey {
  url: string
  /** The name of every command heard, answered or not, in order. */
  commands: string[]
  /** From now on nothing is answered. */
  silence: () => void
  close: () => Promise<void>
}

export async function silentValkey(): Promise<SilentValkey> {
  const commands: string[] = []
  const sockets = new Set<Socket>()
  let answering = true
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffered = ''
    socket.on('data', chunk => {
      buffered += chunk.toString('latin1')
      for (;;) {
        const read = oneCommand(buffered)
        if (read == null) return
        buffered = buffered.slice(read.length)
        const name = (read.args[0] ?? '').toUpperCase()
        commands.push(name)
        if (answering) socket.write(name === 'GET' ? '$-1\r\n' : '+OK\r\n')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string')
    throw new Error('The silent Valkey has no port')
  return {
    url: `redis://127.0.0.1:${address.port}`,
    commands,
    silence: () => {
      answering = false
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
    }
  }
}

/**
 * Waits until `cache` has asked `valkey` a `GET`, so its client is ready and
 * its next commands reach the server.
 */
export async function untilAsked(
  cache: ValkeyCache,
  valkey: SilentValkey
): Promise<void> {
  const deadline = Date.now() + 5000
  while (!valkey.commands.includes('GET')) {
    if (Date.now() > deadline)
      throw new Error('The cache never reached the silent Valkey')
    await cache.get('ready')
    await sleep(20)
  }
}

/** One RESP array of bulk strings at the head of `text`, once all of it is in. */
function oneCommand(text: string): { args: string[]; length: number } | null {
  if (!text.startsWith('*')) {
    // An inline command, one line.
    const end = text.indexOf('\r\n')
    return end < 0
      ? null
      : { args: text.slice(0, end).split(' '), length: end + 2 }
  }
  let at = text.indexOf('\r\n')
  if (at < 0) return null
  const count = Number(text.slice(1, at))
  at += 2
  const args: string[] = []
  for (let i = 0; i < count; i += 1) {
    const end = text.indexOf('\r\n', at)
    if (end < 0) return null
    const size = Number(text.slice(at + 1, end))
    const start = end + 2
    if (text.length < start + size + 2) return null
    args.push(text.slice(start, start + size))
    at = start + size + 2
  }
  return { args, length: at }
}
