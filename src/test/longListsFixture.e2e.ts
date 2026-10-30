import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'

import { drainDirty } from '../server/chat/reconciler'
import { chatRoutes } from '../server/routes/chat'
import { chatEpochRoutes } from '../server/routes/chatEpochs'
import { chatKeyRoutes } from '../server/routes/chatKeys'
import { chatMessageRoutes } from '../server/routes/chatMessages'
import { mediaRoutes } from '../server/routes/media'
import { umpireRoutes } from '../server/routes/umpires'
import { type GroupFixture, groupFixture } from './groupFixtures'
import {
  type LongListsSeed,
  longListsSupport,
  seedLongLists
} from './longListsSeed'

/** Answers the last sign-in code and link mailed to `?email=`. */
export const SIGN_IN_LINK_ROUTE = '/__longLists/code'
/**
 * On the fixture's own origin, which the phone never sees: `?offline=1` or `0`
 * cuts the phone off or lets it back, and it answers the paths it has seen.
 */
export const PHONE_NETWORK_ROUTE = '/__longLists/phone'

/** The way to the fixture from a phone, which a simulator cannot turn off. */
interface PhoneNetwork {
  offline: boolean
  seen: string[]
}

export interface LongListsServer {
  f: GroupFixture
  seeded: LongListsSeed
}

/**
 * The long lists world on the server the app talks to, with what its screens
 * read beyond the harness: stills, umpires and chat.
 */
export async function startLongLists(
  bindHost = '127.0.0.1',
  phone: PhoneNetwork = { offline: false, seen: [] }
): Promise<LongListsServer> {
  // Filled once the fixture exists; the route only runs after that.
  const mailbox: { mail?: Map<string, string>; links?: Map<string, string> } =
    {}
  const f = await groupFixture(
    resolve('dist'),
    bindHost,
    (app, { db, media }) => {
      app.use('/api/v1', mediaRoutes(db, media))
      app.use('/api/v1', umpireRoutes(db, media))
      app.use('/api/v1', chatRoutes(db, media))
      app.use('/api/v1', chatKeyRoutes(db))
      app.use('/api/v1', chatEpochRoutes(db))
      app.use('/api/v1', chatMessageRoutes(db, media))
      app.get(PHONE_NETWORK_ROUTE, (req, res) => {
        if (req.query.offline != null) phone.offline = req.query.offline === '1'
        res.json(phone)
      })
      app.get(SIGN_IN_LINK_ROUTE, (req, res) => {
        const email = typeof req.query.email === 'string' ? req.query.email : ''
        const code = mailbox.mail?.get(email)
        if (code == null) res.status(404).end()
        else res.json({ code, link: mailbox.links?.get(email) })
      })
    }
  )
  mailbox.mail = f.h.mail
  mailbox.links = f.h.links
  return { f, seeded: await seedLongLists(f) }
}

/**
 * The server the phone scenarios talk to: the long lists world, on this Mac's
 * LAN address, until SIGINT.
 *
 * The phone's build names one fixed address, so the fixture's own port (a new
 * one each run) sits behind a proxy on `TS_LONG_LISTS_PORT` (9472 by default).
 * The manifest, `native-manifest.json` in `longListsSupport()`, holds the
 * origin, `apiBaseUrl`, the sign-in link route and the seeded ids.
 *
 *   TS_LONG_LISTS_ARTIFACTS=… node -r sucrase/register \
 *     src/test/longListsFixture.e2e.ts
 */
async function main(): Promise<void> {
  if (process.env.TS_LONG_LISTS_ARTIFACTS == null)
    throw new Error('Supply TS_LONG_LISTS_ARTIFACTS')
  const port = Number(process.env.TS_LONG_LISTS_PORT ?? '9472')
  const lan = Object.values(networkInterfaces())
    .flat()
    .find(entry => entry?.family === 'IPv4' && !entry.internal)?.address
  if (lan == null) throw new Error('No LAN address')
  const phone: PhoneNetwork = { offline: false, seen: [] }
  const { f, seeded } = await startLongLists('127.0.0.1', phone)
  // The team, season and league chats the server's reconciler would make.
  setInterval(() => {
    drainDirty(f.h.db, new Date()).catch(() => undefined)
  }, 2000)
  const target = new URL(f.h.origin)
  const proxy = createServer((incoming, outgoing) => {
    if (phone.offline) {
      // A request that never got out: to the app, no signal.
      incoming.socket.destroy()
      return
    }
    phone.seen.push(incoming.url ?? '')
    const forward = request(
      {
        host: target.hostname,
        port: target.port,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: target.host }
      },
      answer => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(outgoing)
      }
    )
    forward.on('error', () => {
      outgoing.writeHead(502).end()
    })
    incoming.pipe(forward)
  })
  await new Promise<void>(resolve => {
    proxy.listen(port, '0.0.0.0', resolve)
  })
  const origin = `http://${lan}:${port}`
  const support = longListsSupport()
  await mkdir(support, { recursive: true })
  await writeFile(
    join(support, 'native-manifest.json'),
    JSON.stringify(
      {
        origin,
        apiBaseUrl: `${origin}/api/v1`,
        controlOrigin: f.h.origin,
        email: 'alex@example.com',
        signInLinkRoute: SIGN_IN_LINK_ROUTE,
        phoneNetworkRoute: PHONE_NETWORK_ROUTE,
        ...seeded
      },
      null,
      2
    )
  )
  console.log(`Long lists fixture ready on ${origin}; manifest saved.`)
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await new Promise<void>(resolve => {
    proxy.close(() => {
      resolve()
    })
  })
  await f.h.close()
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
