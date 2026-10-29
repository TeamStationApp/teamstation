import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

import { attachGameSocket } from '../server/socket/gameSocket'
import { quietStreamFixture } from './quietStreamFixture'
import { databaseUrlOf } from './screenScopeNotices'

async function main(): Promise<void> {
  const publicOrigin = process.env.QUIET_STREAM_ORIGIN
  const manifest = process.env.QUIET_STREAM_MANIFEST
  if (publicOrigin == null || manifest == null)
    throw new Error('Supply fixture origin and manifest')
  const f = await quietStreamFixture('127.0.0.1', publicOrigin)
  let stream = await f.addStream({ quietMs: 0 })
  await f.tick()
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const path = req.url ?? '/'
      if (path === '/__quiet/bootstrap') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ token: f.h.tokens.get(101) }))
      } else if (path === '/__quiet/reset' && req.method === 'POST') {
        await f.db
          .updateTable('live_streams')
          .set({ closes_at: new Date() })
          .where('state', 'in', ['idle', 'publishing'])
          .execute()
        await f.tick()
        res.end('reset')
      } else if (path === '/__quiet/expire' && req.method === 'POST') {
        await f.db
          .updateTable('live_streams')
          .set({ last_published_at: new Date(Date.now() - 660_000) })
          .where('id', '=', stream.id)
          .execute()
        await f.tick()
        res.end('ended')
      } else if (
        ['/__quiet/automatic', '/__quiet/manual'].includes(path) &&
        req.method === 'POST'
      ) {
        stream = await f.addStream({
          quietMs: 0,
          endAgoMs: path === '/__quiet/manual' ? -3_600_000 : 660_000
        })
        await f.tick()
        res.end('ready')
      } else if (path === '/__quiet/tick' && req.method === 'POST') {
        await f.tick()
        res.end('synced')
      } else if (path === '/__quiet/state') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify(
            await f.db
              .selectFrom('live_streams')
              .select(['state', 'closes_at'])
              .where('id', '=', stream.id)
              .executeTakeFirstOrThrow()
          )
        )
      } else {
        const body: Buffer[] = []
        for await (const chunk of req) body.push(Buffer.from(chunk))
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(req.headers)) {
          if (
            value == null ||
            [
              'host',
              'connection',
              'content-length',
              'accept-encoding'
            ].includes(key)
          )
            continue
          headers[key] = Array.isArray(value) ? value.join(', ') : value
        }
        const response = await fetch(f.h.origin + path, {
          method: req.method,
          headers,
          ...(body.length === 0 ? {} : { body: Buffer.concat(body) })
        })
        res.writeHead(
          response.status,
          Object.fromEntries(
            [...response.headers].filter(
              ([key]) =>
                ![
                  'content-encoding',
                  'transfer-encoding',
                  'content-length'
                ].includes(key)
            )
          )
        )
        res.end(Buffer.from(await response.arrayBuffer()))
      }
    }
    handle().catch((error: unknown) => {
      console.error(error)
      res.writeHead(500).end(String(error))
    })
  })
  const socket = attachGameSocket(server, f.db, await databaseUrlOf(f.db), {
    stopSignals: null
  })
  await new Promise<void>(resolve =>
    server.listen(Number(new URL(publicOrigin).port), '0.0.0.0', resolve)
  )
  await writeFile(
    manifest,
    JSON.stringify({
      origin: publicOrigin,
      gameId: stream.gameId,
      videoId: stream.videoId
    })
  )
  console.log('Owned quiet-stream native fixture ready')
  try {
    for await (const line of createInterface({ input: process.stdin }))
      if (line === 'quit') break
  } finally {
    await socket.close()
    server.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
    await f.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
