import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

import express from 'express'

import { groupFixture } from '../../src/test/groupFixtures'

/** Own isolated API/mail/object/Metro services; no production account or route. */
async function main(): Promise<void> {
  const host = process.env.TS_CREATION_NATIVE_HOST
  const artifacts = process.env.TS_CREATION_ARTIFACTS
  if (host == null || artifacts == null)
    throw new Error(
      'Supply the native fixture LAN host and artifacts directory'
    )
  const support = path.join(artifacts, 'support')
  mkdirSync(support, { recursive: true })
  const fixture = await groupFixture(undefined, host)
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (address == null || typeof address === 'string')
    throw new Error('Missing Metro port')
  await new Promise<void>(resolve =>
    probe.close(() => {
      resolve()
    })
  )
  const metroLog = openSync(path.join(support, 'native-metro-private.log'), 'w')
  const metro = spawn(
    path.resolve('node_modules/.bin/react-native'),
    ['start', '--port', String(address.port), '--no-interactive'],
    {
      cwd: process.cwd(),
      env: { ...process.env, TS_API_BASE_URL: fixture.h.origin + '/api/v1' },
      stdio: ['ignore', metroLog, metroLog]
    }
  )
  const app = express()
  app.get('/code', (req, res) => {
    if (typeof req.query.email !== 'string') {
      res.status(400).json({ code: null })
      return
    }
    res.json({ code: fixture.h.mail.get(req.query.email) ?? null })
  })
  app.post('/pending', (_req, res, next) => {
    fixture.h
      .request(
        'POST',
        '/relationship-requests',
        {
          kind: 'participation',
          sender: { kind: 'season', id: fixture.seasonB },
          seasonId: fixture.seasonB,
          teamId: fixture.teamA,
          idempotencyKey: 'native-pending-approval'
        },
        102
      )
      .then(async response => {
        if (response.status !== 201)
          throw new Error('Native pending fixture failed')
        res.json(await response.json())
      })
      .catch(next)
  })
  const control = app.listen(0, '127.0.0.1', () => {
    const bound = control.address()
    if (bound == null || typeof bound === 'string')
      throw new Error('Missing control port')
    writeFileSync(
      path.join(support, 'native-fixture-private.json'),
      JSON.stringify({
        origin: fixture.h.origin,
        port: address.port,
        teamA: fixture.teamA,
        seasonA: fixture.seasonA
      })
    )
    writeFileSync(
      path.join(support, 'native-control-private.json'),
      JSON.stringify({ port: bound.port })
    )
    console.log(
      'Own native fixture and Metro ready; connection details stored privately under support/'
    )
  })
  const shutdown = async (): Promise<void> => {
    control.close()
    metro.kill()
    await fixture.h.close()
    process.exit(0)
  }
  process.once('SIGINT', () => {
    shutdown().catch(() => process.exit(1))
  })
  process.once('SIGTERM', () => {
    shutdown().catch(() => process.exit(1))
  })
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Native fixture failed'
  )
  process.exitCode = 1
})
