import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { connect, createServer, type Server as TcpServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import express from 'express'

import { type TessFixture, tessFixture } from './tessFixture'

/**
 * Tess's fixture for a phone, a tablet simulator or an emulator: the same
 * fixture as the browser's, bound to an address the device reaches, on a
 * fixed port the app build names (`TS_API_BASE_URL`), so one build serves
 * every run.
 *
 *   TS_TESS_NATIVE_HOST=<this Mac's address> TS_TESS_NATIVE_PORT=19480 \
 *     node -r sucrase/register src/test/tessNativeFixture.e2e.ts
 *
 * The fixed port passes bytes straight through to the fixture's own, so the
 * API and the dictation socket both work through it. It writes the
 * manifest `tessNative.e2e.ts` reads (`TS_TESS_NATIVE_MANIFEST`, by default
 * `$TS_ARTIFACTS_DIR/support/native-manifest.json`), mode 0600, and deletes
 * it when it stops, since it holds the address. Sign-in codes are never in
 * it: the script asks the control endpoint, which listens on this Mac only.
 * Type `quit`, or interrupt it, to stop.
 */

export interface TessNativeManifest {
  /** Where the app reaches the API: `http://<address>:<port>`. */
  origin: string
  /** This Mac's own control endpoint, for sign-in codes and counters. */
  control: string
  email: string
  team: string
  games: TessFixture['games']
  links: TessFixture['links']
}

async function main(): Promise<void> {
  const host = process.env.TS_TESS_NATIVE_HOST
  const port = Number(process.env.TS_TESS_NATIVE_PORT ?? '19480')
  if (host == null || host === '' || !Number.isInteger(port))
    throw new Error('Supply TS_TESS_NATIVE_HOST and TS_TESS_NATIVE_PORT')
  const manifestPath = resolve(
    process.env.TS_TESS_NATIVE_MANIFEST ??
      join(
        process.env.TS_ARTIFACTS_DIR ?? 'artifacts/202610231030-tessAiHelper',
        'support',
        'native-manifest.json'
      )
  )
  const origin = `http://${host}:${port}`
  let t: TessFixture | undefined
  let front: TcpServer | undefined
  let control: Server | undefined
  const open = new Set<{ destroy: () => void }>()
  try {
    t = await tessFixture({ bindHost: host, publicOrigin: origin })
    const fixture = t
    const inner = new URL(fixture.f.h.origin)
    // The fixed port, passing every byte to the fixture: HTTP and the
    // dictation socket's upgrade alike.
    front = createServer(socket => {
      const upstream = connect(Number(inner.port), inner.hostname)
      socket.pipe(upstream).pipe(socket)
      open.add(socket)
      open.add(upstream)
      const end = (): void => {
        socket.destroy()
        upstream.destroy()
        open.delete(socket)
        open.delete(upstream)
      }
      socket.on('close', end)
      upstream.on('close', end)
      socket.on('error', end)
      upstream.on('error', end)
    })
    front.listen(port, host)
    await new Promise<void>((resolve, reject) => {
      front!.once('listening', resolve)
      front!.once('error', reject)
    })
    const app = express()
    app.get('/code', (req, res) => {
      const email = typeof req.query.email === 'string' ? req.query.email : ''
      res.json({ code: fixture.f.h.mail.get(email) ?? null })
    })
    app.delete('/code', (req, res) => {
      if (typeof req.query.email === 'string')
        fixture.f.h.mail.delete(req.query.email)
      res.sendStatus(204)
    })
    app.get('/beacon-count', (_req, res) => {
      res.json({ count: fixture.beaconHits() })
    })
    app.get('/dictation', (_req, res) => {
      res.json(fixture.dictation)
    })
    app.get('/games/:teamId', (req, res, next) => {
      fixture.f.h.db
        .selectFrom('games')
        .select(['id', 'start_at', 'status'])
        .where(eb =>
          eb.or([
            eb('home_team_id', '=', req.params.teamId),
            eb('away_team_id', '=', req.params.teamId)
          ])
        )
        .execute()
        .then(games => res.json({ games }))
        .catch(next)
    })
    control = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => control!.once('listening', resolve))
    const address = control.address()
    if (address == null || typeof address === 'string')
      throw new Error('Missing control port')
    const manifest: TessNativeManifest = {
      origin,
      control: `http://127.0.0.1:${address.port}`,
      email: 'alex@example.com',
      team: fixture.f.teamA,
      games: fixture.games,
      links: fixture.links
    }
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), {
      mode: 0o600
    })
    console.log('Tess native fixture ready; the manifest is saved privately.')
    const stop = (): void => {
      process.stdin.emit('end')
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      for await (const line of createInterface({
        input: process.stdin,
        terminal: false
      }))
        if (line === 'quit') break
    } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  } finally {
    await rm(manifestPath, { force: true })
    for (const socket of open) socket.destroy()
    control?.closeAllConnections()
    for (const server of [control, front])
      if (server != null)
        await new Promise<void>(resolve => {
          server.close(() => {
            resolve()
          })
        })
    await t?.close()
    process.stdin.destroy()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
