import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'

import { groupFixture } from '../../test/groupFixtures'
import { seedStack } from '../../test/stackTransitionsSeed'

/**
 * The server the phone scenarios talk to: the stack transitions world, on
 * this Mac's LAN address, until SIGINT.
 *
 * The phone's build names one fixed address, so the fixture's own port (a new
 * one each run) sits behind a proxy on `TS_STACK_PORT` (9471 by default).
 * `GET /__stack/code?email=` answers the last sign-in code mailed to that
 * address, which is how the phone script signs in. The manifest it writes,
 * `$TS_STACK_ARTIFACTS/support/native-manifest.json`, holds the origin and
 * the seeded ids.
 *
 *   TS_STACK_ARTIFACTS=… node -r sucrase/register \
 *     src/app/navigation/stackTransitionsFixture.e2e.ts
 */
async function main(): Promise<void> {
  const artifacts = process.env.TS_STACK_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_STACK_ARTIFACTS')
  const port = Number(process.env.TS_STACK_PORT ?? '9471')
  const lan = Object.values(networkInterfaces())
    .flat()
    .find(entry => entry?.family === 'IPv4' && !entry.internal)?.address
  if (lan == null) throw new Error('No LAN address')
  // Filled once the fixture exists; the route only runs after that.
  const mailbox: { mail?: Map<string, string> } = {}
  const f = await groupFixture(resolve('dist'), '127.0.0.1', app => {
    app.get('/__stack/code', (req, res) => {
      const email = typeof req.query.email === 'string' ? req.query.email : ''
      const code = mailbox.mail?.get(email)
      if (code == null) res.status(404).end()
      else res.json({ code })
    })
  })
  mailbox.mail = f.h.mail
  const seeded = await seedStack(f)
  const target = new URL(f.h.origin)
  const proxy = createServer((incoming, outgoing) => {
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
  await mkdir(join(artifacts, 'support'), { recursive: true })
  await writeFile(
    join(artifacts, 'support', 'native-manifest.json'),
    JSON.stringify(
      {
        origin,
        apiBaseUrl: `${origin}/api/v1`,
        email: 'alex@example.com',
        team: seeded.teamId,
        player: seeded.playerId,
        game: seeded.gameId
      },
      null,
      2
    )
  )
  console.log(`Stack fixture ready on ${origin}; manifest saved.`)
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

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
