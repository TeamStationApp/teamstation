import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { makeDatabase } from '../db/database'
import { attachGameSocket } from './gameSocket'

/**
 * Another worker, in its own process, for the chat socket tests: the socket
 * alone on an HTTP server of its own, with its own `LISTEN chat_changes`, on
 * the database named on its command line. It tells its parent its port once
 * it listens, and closes when the parent says `close`. Run with
 * `node -r sucrase/register`.
 */
async function main(databaseUrl: string): Promise<void> {
  const db = makeDatabase(databaseUrl)
  const server = createServer()
  const socket = attachGameSocket(server, db, databaseUrl, {
    stopSignals: null
  })
  await socket.chat.listening
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  process.on('message', message => {
    if (message !== 'close') return
    socket
      .close()
      .then(async () => {
        server.close()
        await db.destroy()
      })
      .then(
        () => process.exit(0),
        () => process.exit(1)
      )
  })
  process.send?.({ port: (server.address() as AddressInfo).port })
}

main(process.argv[2]).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
