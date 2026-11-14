import { mkdir, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server as TcpServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import express from 'express'

import type { GroupFixture } from '../../src/test/groupFixtures'
import { groupFixture } from '../../src/test/groupFixtures'
import { seedPrivacyGame } from '../../src/test/playerNamePrivacyFixture'
import {
  quiet,
  requireRedis,
  testPrefix,
  testStore
} from '../../src/test/scoreboardKit'

/**
 * The pop-up wheel fixture for `src/app/nativeWheel.e2e.ts`: the privacy
 * fixture's people, team and game, and the web build from `dist`, on an
 * address a simulator, an emulator and a browser all reach. The app build
 * names it (`TS_API_BASE_URL`); Safari and Chromium open its origin.
 *
 *   TS_WHEEL_HOST=<this Mac> TS_WHEEL_PORT=19480 \
 *     TS_WHEEL_MANIFEST=<private file> \
 *     node -r sucrase/register e2e/fixtures/nativeWheelFixture.ts
 *
 * Postgres and Redis must be running. Sign-in codes come from the control
 * endpoint, which listens on this Mac only, and are never printed. Interrupt
 * it to stop.
 */
export interface NativeWheelManifest {
  origin: string
  control: string
  email: string
  teamId: string
}

async function main(): Promise<void> {
  const host = process.env.TS_WHEEL_HOST
  const port = Number(process.env.TS_WHEEL_PORT ?? '19480')
  const manifestFile = process.env.TS_WHEEL_MANIFEST
  if (host == null || manifestFile == null)
    throw new Error('Supply TS_WHEEL_HOST and TS_WHEEL_MANIFEST')
  await requireRedis()
  const { store } = await testStore(testPrefix())
  const f: GroupFixture = await groupFixture(
    resolve('dist'),
    host,
    undefined,
    undefined,
    {},
    {},
    { store, log: quiet }
  )
  await seedPrivacyGame(f)
  // The phone and the browsers reach one fixed port; the harness listens on
  // its own.
  const inner = new URL(f.h.origin)
  const front: TcpServer = createServer(socket => {
    const upstream = connect(Number(inner.port), inner.hostname)
    socket.pipe(upstream).pipe(socket)
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  })
  front.listen(port, host)
  const control = express()
  control.get('/code', (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email : ''
    res.json({ code: f.h.mail.get(email) ?? null })
  })
  const listening = control.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => listening.once('listening', resolve))
  const address = listening.address()
  if (address == null || typeof address === 'string')
    throw new Error('Missing control port')
  const manifest: NativeWheelManifest = {
    origin: `http://${host}:${port}`,
    control: `http://127.0.0.1:${address.port}`,
    email: 'alex@example.com',
    teamId: f.teamA
  }
  const file = resolve(manifestFile)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  console.log('Native wheel fixture ready.')
  const stop = (): void => {
    process.stdin.emit('end')
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  for await (const line of createInterface({ input: process.stdin }))
    if (line === 'quit') break
  await rm(file, { force: true })
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
