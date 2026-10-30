import { mkdir, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server as TcpServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import express from 'express'

import type { Turn } from '../server/dictation/interpreter'
import { attachDictation } from '../server/dictation/route'
import { dictationScopes } from '../server/dictation/scopes'
import { dictatingHealth } from './dictationFakes'
import type { GroupFixture } from './groupFixtures'
import { groupFixture } from './groupFixtures'
import { seedPrivacyGame } from './playerNamePrivacyFixture'
import { quiet, requireRedis, testPrefix, testStore } from './scoreboardKit'

/**
 * The privacy fixture for a phone: the browser pass's people and game, bound
 * to an address the phone reaches, on a fixed port the app build names
 * (`TS_API_BASE_URL`). Dictation is real up to the model: the socket, its
 * authorisation and everything the app sends, with a recogniser that hears
 * nothing useful and a conversation that records what it was given.
 *
 *   TS_PRIVACY_NATIVE_HOST=<this Mac> TS_PRIVACY_NATIVE_PORT=19470 \
 *     TS_PRIVACY_NATIVE_MANIFEST=<private file> \
 *     node -r sucrase/register src/test/playerNamePrivacyNativeFixture.e2e.ts
 *
 * Sign-in codes come from the control endpoint, which listens on this Mac
 * only, and are never printed. Interrupt it to stop.
 */
export interface PrivacyNativeManifest {
  origin: string
  control: string
  email: string
  gameId: string
  teamId: string
  leagueId: string
  alex: string
}

async function main(): Promise<void> {
  const host = process.env.TS_PRIVACY_NATIVE_HOST
  const port = Number(process.env.TS_PRIVACY_NATIVE_PORT ?? '19470')
  const manifestFile = process.env.TS_PRIVACY_NATIVE_MANIFEST
  if (host == null || manifestFile == null)
    throw new Error('Supply TS_PRIVACY_NATIVE_HOST and _MANIFEST')
  await requireRedis()
  const { store } = await testStore(testPrefix())
  const heard = {
    keyterms: [] as string[][],
    contexts: [] as string[]
  }
  const f: GroupFixture = await groupFixture(
    undefined,
    host,
    app => {
      app.get('/api/v1/health', (_req, res, next) => {
        dictatingHealth()
          .then(health => res.json(health))
          .catch(next)
      })
    },
    undefined,
    {},
    {},
    { store, log: quiet }
  )
  const { gameId, ALEX } = await seedPrivacyGame(f)
  attachDictation(f.h.server, {
    db: f.h.db,
    config: {
      apiKey: 'test-key-placeholder',
      baseUrl: 'http://model.example.test/v1',
      anthropic: {
        apiKey: 'test-key-placeholder',
        baseUrl: 'http://model.example.test/v1'
      },
      sttUrl: 'wss://stt.example.test',
      sttModel: 'stt-fake',
      model: 'claude-haiku-5-5'
    },
    scopes: dictationScopes({ tess: false }),
    openRecogniser: handlers => {
      let bytes = 0
      return {
        retarget: keyterms => {
          heard.keyterms.push([...keyterms])
        },
        begin: () => {
          bytes = 0
        },
        write: pcm => {
          bytes += pcm.length
        },
        end: () => {
          setTimeout(() => {
            handlers.onFinal(bytes > 0 ? 'ball one' : '')
          }, 50)
        },
        close: () => undefined
      }
    },
    converse: (_config, context) => {
      heard.contexts.push(context)
      const done: Turn = { kind: 'actions', actions: [], dropped: [] }
      return {
        start: async () => await Promise.resolve(done),
        answer: async () => await Promise.resolve(done)
      }
    }
  })
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
  control.get('/dictation', (_req, res) => {
    res.json(heard)
  })
  const listening = control.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => listening.once('listening', resolve))
  const address = listening.address()
  if (address == null || typeof address === 'string')
    throw new Error('Missing control port')
  const manifest: PrivacyNativeManifest = {
    origin: `http://${host}:${port}`,
    control: `http://127.0.0.1:${address.port}`,
    email: 'alex@example.com',
    gameId,
    teamId: f.teamA,
    leagueId: f.leagueA,
    alex: String(ALEX)
  }
  const file = resolve(manifestFile)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  console.log('Privacy native fixture ready.')
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
