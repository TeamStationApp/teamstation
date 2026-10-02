import { createServer as createHttpServer } from 'node:http'
import { type AddressInfo, connect, createServer, type Server } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { WebSocket } from 'ws'

import type { ScoringAction } from '../../common/scoring/actions'
import {
  addGame,
  addPerson,
  addScorableTeams,
  dropPrefix,
  type Person,
  requireRedis,
  scoreDirectly,
  scratchDatabase,
  testPrefix,
  testRedisUrl,
  until
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { scoreboardRoutes } from '../routes/scoreboard'
import { teamRoutes } from '../routes/teams'
import { attachScoreboard } from './attachScoreboard'
import { startScoreboard } from './scoreboardService'

/**
 * A worker's scoreboard started against a Redis that is not there yet, the
 * way `runWorker` starts it: the API is up, the scoreboard answers 503 and
 * its sockets 1011, and when Redis arrives everything recovers on its own.
 *
 * "Arrives" is a TCP relay to the test Redis, started on the port the
 * clients were pointed at.
 */

const media: MediaContext = {
  ffmpegPath: '/usr/bin/ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await new Promise(resolve => probe.once('listening', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise(resolve => probe.close(resolve))
  return port
}

/** Relays a port to the test Redis, which is what Redis coming back is. */
async function relay(port: number): Promise<Server> {
  const target = new URL(testRedisUrl)
  const server = createServer(inbound => {
    const outbound = connect(
      target.port === '' ? 6379 : Number(target.port),
      target.hostname
    )
    inbound.pipe(outbound).pipe(inbound)
    inbound.on('error', () => outbound.destroy())
    outbound.on('error', () => inbound.destroy())
  })
  server.listen(port, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  return server
}

describe('a worker’s scoreboard while Redis is away', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let runner: Person
  let gameId = ''
  const prefix = testPrefix()
  const logged: string[] = []

  before(async function () {
    await requireRedis()
    ;({ db, drop } = await scratchDatabase('scoreboard_service'))
    const context = await addScorableTeams(db, {
      home: 'Pioneers',
      away: 'Visitors'
    })
    runner = await addPerson(db, 'runner', { owns: context.teams.home.id })
    gameId = await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: new Date()
    })
    const ball: ScoringAction = { type: 'pitch', call: 'B' }
    await scoreDirectly(db, gameId, context, [ball, ball])
  })

  after(async function () {
    await dropPrefix('ts-test')
    await drop?.()
  })

  it('stays up, answers 503 and 1011, and recovers when Redis comes', async function () {
    const port = await freePort()
    const url = new URL(testRedisUrl)
    const scoreboard = startScoreboard({
      db,
      redis: { url: `redis://127.0.0.1:${port}${url.pathname}`, prefix },
      databaseUrl: 'postgres://localhost/unused',
      log: line => logged.push(line)
    })
    expect(scoreboard.store.prefix).equals(prefix)
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', scoreboardRoutes(db, scoreboard.store))
    app.use('/api/v1', teamRoutes(db, media, scoreboard.store))
    app.use(errorHandler)
    const server = createHttpServer(app)
    const closeScoreboard = attachScoreboard(server, scoreboard.hub)
    server.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const base = `127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    const get = async (path: string): Promise<Response> =>
      await fetch(`http://${base}${path}`, {
        headers: { authorization: `Bearer ${runner.token}` }
      })
    const fieldsOf = async (res: Response): Promise<Record<string, unknown>> =>
      (await res.json()) as Record<string, unknown>
    const view = async (): Promise<{ code?: number; state?: any }> =>
      await new Promise(resolve => {
        const socket = new WebSocket(`ws://${base}/scoreboard/${gameId}/socket`)
        socket.on('message', data => {
          resolve({ state: JSON.parse((data as Buffer).toString('utf8')) })
          socket.close()
        })
        socket.on('close', code => {
          resolve({ code })
        })
        socket.on('error', () => undefined)
      })
    let proxy: Server | undefined
    try {
      // Away.
      expect((await get(`/scoreboard/${gameId}`)).status).equals(503)
      expect(await view()).deep.equals({ code: 1011 })
      const detail = await get(`/games/${gameId}`)
      expect(detail.status).equals(200)
      expect((await fieldsOf(detail)).scoreboard).equals(null)
      scoreboard.onGameWritten(gameId)
      await until('the hook to log', () =>
        logged.some(line => line.includes('not written'))
      )
      expect(logged).to.include(
        `scoreboard: game ${gameId} not written: The scoreboard is unavailable`
      )

      // Back, with nobody restarting anything.
      proxy = await relay(port)
      await until('Redis to be ready', () => scoreboard.store.isReady(), 20000)
      scoreboard.onGameWritten(gameId)
      await until(
        'the hook to write',
        async () => (await scoreboard.store.readScoreboard(gameId)) != null
      )
      const answer = await get(`/scoreboard/${gameId}`)
      expect(answer.status).equals(200)
      expect((await fieldsOf(answer)).state).includes({
        balls: 2,
        inGame: true
      })
      expect((await view()).state).includes({ balls: 2 })
      expect(
        (await fieldsOf(await get(`/games/${gameId}`))).scoreboard
      ).deep.equals({ open: true, mayOverride: true })
    } finally {
      await closeScoreboard()
      server.close()
      proxy?.close()
    }
  })
})
