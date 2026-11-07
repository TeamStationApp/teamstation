import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, type Selectable, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import type { RecapDocument } from '../../common/gameRecap'
import { asPostEventsBody, type PostEventsBody } from '../../common/gumboPlay'
import { migration111GameRecaps } from '../../migrate/migrations/111gameRecaps'
import {
  addGame,
  addPerson,
  addTeam,
  type Person,
  scratchDatabase
} from '../../test/scoreboardKit'
import { listenScreenScopes } from '../../test/screenScopeNotices'
import type { Database, GameRecapsTable } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { recapWriter } from '../recap/model'
import { requestRecap } from '../recap/queue'
import { runRecap, startRecaps } from '../recap/worker'
import { eventRoutes } from './events'
import { recapRoutes } from './recap'

const document: RecapDocument = {
  headline: 'Owls beat Herons 4–2',
  dateLine: 'January 1, 2026',
  paragraphs: [[{ text: 'The game ended.', kind: 'play', plays: [0] }]]
}
const body = (score = 4, final = true): PostEventsBody =>
  asPostEventsBody({
    mode: 'live',
    source: { system: 'teamstation' },
    plays: [
      {
        about: { atBatIndex: 0, endTime: '2026-01-01T18:00:20Z' },
        result: {
          eventType: final ? 'final_score' : 'single',
          homeScore: score,
          awayScore: 2
        }
      }
    ]
  })
const signal = new AbortController().signal

describe('game recap persistence and member HTTP resource', function () {
  this.timeout(60000)
  let db: Kysely<Database>,
    drop: () => Promise<void>,
    server: Server,
    base: string,
    home: string,
    away: string,
    member: Person,
    stranger: Person
  const game = async (): Promise<string> =>
    await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date('2026-01-01T18:00:00Z')
    })
  const row = async (id: string): Promise<Selectable<GameRecapsTable>> =>
    await db
      .selectFrom('game_recaps')
      .selectAll()
      .where('game_id', '=', id)
      .executeTakeFirstOrThrow()
  const tick = async (now = new Date()): Promise<boolean> =>
    await runRecap(db, async () => document, signal, now)
  before(async () => {
    ;({ db, drop } = await scratchDatabase('recap'))
    home = await addTeam(db, 'Owls')
    away = await addTeam(db, 'Herons')
    member = await addPerson(db, 'owner', { owns: home })
    stranger = await addPerson(db, 'visitor')
    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use('/api/v1', eventRoutes(db))
    app.use('/api/v1', recapRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })
  after(async () => {
    server?.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
    await drop?.()
  })
  it('queues only final games, stores one recap, replaces corrections and removes reopened recaps', async () => {
    const id = await game()
    await postGamePlays(db, id, body(0, false))
    expect(
      await db
        .selectFrom('game_recaps')
        .selectAll()
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([])
    await postGamePlays(db, id, body())
    expect((await row(id)).status).equals('pending')
    await tick()
    expect((await row(id)).status).equals('ready')
    const old = (await row(id)).request_id
    await postGamePlays(db, id, body())
    expect((await row(id)).request_id).equals(old)
    await postGamePlays(db, id, body(5))
    expect((await row(id)).request_id).not.equals(old)
    expect((await row(id)).document).equals(null)
    await tick()
    expect((await row(id)).status).equals('ready')
    await postGamePlays(db, id, body(0, false))
    expect(
      await db
        .selectFrom('game_recaps')
        .selectAll()
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([])
    await db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', id)
      .execute()
    await postGamePlays(db, id, body())
    expect(
      await db
        .selectFrom('game_recaps')
        .selectAll()
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([])
  })
  it('isolates missing-key failure, retries three times and resets only on a later post', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    const now = Date.now() + 1000
    for (let n = 0; n < 3; n++)
      await runRecap(db, recapWriter(), signal, new Date(now + n * 6000))
    expect((await row(id)).status).equals('failed')
    expect((await row(id)).attempts).equals(3)
    expect(await tick(new Date(now + 30000))).equals(false)
    await postGamePlays(db, id, body())
    expect((await row(id)).attempts).equals(0)
    await tick()
    expect((await row(id)).status).equals('ready')
  })
  it('does not hold the game lock while the model runs and suppresses obsolete responses', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    let release!: (v: RecapDocument) => void, started!: () => void
    const began = new Promise<void>(resolve => {
      started = resolve
    })
    const work = runRecap(
      db,
      async () => {
        started()
        return await new Promise(resolve => {
          release = resolve
        })
      },
      signal
    )
    await began
    expect(await tick()).equals(false)
    const response = await fetch(`${base}/games/${id}/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${member.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body(6))
    })
    expect(response.status).equals(200)
    release(document)
    await work
    expect((await row(id)).status).equals('pending')
    await tick()
    expect((await row(id)).status).equals('ready')
  })
  it('recovers expired leases, counts a final expired attempt and honors cancellation', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    await db
      .updateTable('game_recaps')
      .set({ attempts: 2, lease_id: 'expired', available_at: new Date(0) })
      .where('game_id', '=', id)
      .execute()
    await tick()
    expect((await row(id)).attempts).equals(3)
    expect((await row(id)).status).equals('ready')
    await requestRecap(db, id, true, 'changed')
    await db
      .updateTable('game_recaps')
      .set({ attempts: 3, available_at: new Date(0) })
      .where('game_id', '=', id)
      .execute()
    await tick()
    expect((await row(id)).status).equals('failed')
    await requestRecap(db, id, true, 'changed')
    await db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', id)
      .execute()
    expect(await tick()).equals(false)
  })
  it('serves content only to members and only for final games', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    const client = new TeamStationClient({ baseUrl: base, token: member.token })
    expect((await client.gameRecap(id)).status).equals('pending')
    await tick()
    expect((await client.gameRecap(id)).document).deep.equals(document)
    for (const token of [undefined, stranger.token]) {
      const response = await fetch(`${base}/games/${id}/recap`, {
        headers: token == null ? {} : { authorization: `Bearer ${token}` }
      })
      expect(response.status).equals(token == null ? 401 : 403)
      expect(await response.text()).not.includes(document.headline)
    }
    expect(
      (
        await fetch(`${base}/games/gam_missing/recap`, {
          headers: { authorization: `Bearer ${member.token}` }
        })
      ).status
    ).equals(404)
    await db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', id)
      .execute()
    expect((await client.gameRecap(id)).status).equals('absent')
    const empty = await game()
    await db
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', empty)
      .execute()
    expect((await client.gameRecap(empty)).status).equals('pending')
    await requestRecap(db, empty, true, 'failed')
    await db
      .updateTable('game_recaps')
      .set({ status: 'failed' })
      .where('game_id', '=', empty)
      .execute()
    expect((await client.gameRecap(empty)).status).equals('failed')
  })
  it('queues one missing recap on concurrent member visits and announces its completion', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    await db.deleteFrom('game_recaps').where('game_id', '=', id).execute()
    for (const token of [undefined, stranger.token]) {
      const response = await fetch(`${base}/games/${id}/recap`, {
        headers: token == null ? {} : { authorization: `Bearer ${token}` }
      })
      expect(response.status).equals(token == null ? 401 : 403)
    }
    expect(
      await db
        .selectFrom('game_recaps')
        .selectAll()
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([])
    const client = new TeamStationClient({ baseUrl: base, token: member.token })
    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => await client.gameRecap(id))
    )
    expect(answers.map(answer => answer.status)).deep.equals(
      Array(5).fill('pending')
    )
    const queued = await row(id)
    await client.gameRecap(id)
    expect((await row(id)).request_id).equals(queued.request_id)
    const notices = await listenScreenScopes(db)
    try {
      const mark = notices.mark()
      await tick()
      expect(await notices.named(mark, { gameId: id })).deep.equals({
        gameId: id
      })
      expect((await client.gameRecap(id)).document).deep.equals(document)
      expect((await row(id)).attempts).equals(1)
      expect((await row(id)).request_id).equals(queued.request_id)
    } finally {
      await notices.close()
    }
  })
  it('announces exhausted generation and expired leases to waiting viewers', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    const notices = await listenScreenScopes(db)
    try {
      let mark = notices.mark()
      await db
        .updateTable('game_recaps')
        .set({ attempts: 2 })
        .where('game_id', '=', id)
        .execute()
      await runRecap(
        db,
        async () => {
          throw new Error('unavailable')
        },
        signal
      )
      expect(await notices.named(mark, { gameId: id })).deep.equals({
        gameId: id
      })
      expect((await row(id)).status).equals('failed')
      await db
        .updateTable('game_recaps')
        .set({ status: 'pending', available_at: new Date(0) })
        .where('game_id', '=', id)
        .execute()
      mark = notices.mark()
      await tick()
      expect(await notices.named(mark, { gameId: id })).deep.equals({
        gameId: id
      })
      expect((await row(id)).status).equals('failed')
    } finally {
      await notices.close()
    }
  })
  it('withholds stale names, regenerates on privacy changes and rejects obsolete in-flight prose', async () => {
    const id = await game()
    await db
      .updateTable('users')
      .set({ first_name: 'Alex', last_name: 'Lee', display_name: 'Alex Lee' })
      .where('id', '=', member.userId)
      .execute()
    await db
      .updateTable('memberships')
      .set({ is_player: true })
      .where('user_id', '=', member.userId)
      .where('team_id', '=', home)
      .execute()
    const posted = asPostEventsBody({
      ...body(),
      plays: [
        { ...body().plays[0], matchup: { batter: { id: member.gumboId } } }
      ]
    })
    const namedDocument = (name: string): RecapDocument => ({
      ...document,
      paragraphs: [[{ text: `${name} played.`, kind: 'play', plays: [0] }]]
    })
    const generate = async (): Promise<boolean> =>
      await runRecap(
        db,
        async input =>
          namedDocument(String(input.plays[0].matchup!.batter!.fullName)),
        signal
      )
    const client = new TeamStationClient({ baseUrl: base, token: member.token })
    await postGamePlays(db, id, posted)
    await generate()
    expect((await client.gameRecap(id)).document).deep.equals(
      namedDocument('Alex L')
    )
    await db
      .updateTable('teams')
      .set({ player_name_privacy: 'initials' })
      .where('id', '=', home)
      .execute()
    expect(await client.gameRecap(id)).deep.equals({
      status: 'pending',
      document: null,
      clips: {}
    })
    expect((await row(id)).document).equals(null)
    await generate()
    expect((await client.gameRecap(id)).document).deep.equals(
      namedDocument('A L')
    )
    const previous = await row(id)
    await db
      .updateTable('teams')
      .set({ player_name_privacy: 'firstLastInitial' })
      .where('id', '=', home)
      .execute()
    await postGamePlays(db, id, posted)
    expect((await row(id)).digest).equals(previous.digest)
    expect((await row(id)).request_id).not.equals(previous.request_id)
    let release!: (value: RecapDocument) => void
    let started!: () => void
    const began = new Promise<void>(resolve => {
      started = resolve
    })
    const work = runRecap(
      db,
      async () => {
        started()
        return await new Promise(resolve => {
          release = resolve
        })
      },
      signal
    )
    await began
    await db
      .updateTable('teams')
      .set({ player_name_privacy: 'initials' })
      .where('id', '=', home)
      .execute()
    release(namedDocument('Alex L'))
    await work
    expect((await row(id)).status).equals('pending')
    expect((await row(id)).document).equals(null)
    expect((await row(id)).attempts).equals(0)
    await generate()
    expect((await client.gameRecap(id)).document).deep.equals(
      namedDocument('A L')
    )
    await db
      .updateTable('teams')
      .set({ player_name_privacy: null })
      .where('id', '=', home)
      .execute()
  })
  it('invalidates renamed teams and corrected game dates on reads, posts and in-flight completion', async () => {
    const id = await game()
    const client = new TeamStationClient({ baseUrl: base, token: member.token })
    const generate = async (): Promise<boolean> =>
      await runRecap(
        db,
        async input => ({
          ...document,
          headline: `${input.homeTeam} beat ${input.awayTeam}`,
          dateLine: input.date
        }),
        signal
      )
    await postGamePlays(db, id, body())
    await generate()
    await db
      .updateTable('teams')
      .set({ name: 'Demo Eagles' })
      .where('id', '=', home)
      .execute()
    expect((await client.gameRecap(id)).status).equals('pending')
    await generate()
    expect((await client.gameRecap(id)).document!.headline).equals(
      'Demo Eagles beat Herons'
    )
    const prior = await row(id)
    await db
      .updateTable('games')
      .set({
        start_at: new Date('2026-01-03T01:00:00Z'),
        timezone: 'America/Los_Angeles'
      })
      .where('id', '=', id)
      .execute()
    await postGamePlays(db, id, body())
    expect((await row(id)).digest).equals(prior.digest)
    expect((await row(id)).request_id).not.equals(prior.request_id)
    await generate()
    expect((await client.gameRecap(id)).document!.dateLine).equals(
      'January 2, 2026'
    )
    await requestRecap(db, id, true, 'metadata-flight')
    await runRecap(
      db,
      async () => {
        await db
          .updateTable('games')
          .set({ timezone: 'UTC' })
          .where('id', '=', id)
          .execute()
        return document
      },
      signal
    )
    expect((await row(id)).status).equals('pending')
    expect((await row(id)).document).equals(null)
    await generate()
    expect((await client.gameRecap(id)).document!.dateLine).equals(
      'January 3, 2026'
    )
    await db
      .updateTable('teams')
      .set({ name: 'Owls' })
      .where('id', '=', home)
      .execute()
  })
  it('invalidates saved and in-flight prose after supplemental pitch PATCH requests', async () => {
    const id = await game()
    const admin = await addPerson(db, 'pitch-editor', { isAdmin: true })
    await postGamePlays(
      db,
      id,
      asPostEventsBody({ plays: body().plays, source: { system: 'outside' } })
    )
    const client = new TeamStationClient({ baseUrl: base, token: member.token })
    const generate = async (): Promise<boolean> =>
      await runRecap(
        db,
        async input => ({
          ...document,
          paragraphs: [
            [
              {
                text: `Pitch count: ${Array.isArray(input.plays[0].playEvents) ? input.plays[0].playEvents.length : 0}.`,
                kind: 'play',
                plays: [0]
              }
            ]
          ]
        }),
        signal
      )
    const patch = async (count: number): Promise<void> => {
      const response = await fetch(`${base}/games/${id}/events`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${admin.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          plays: [
            {
              atBatIndex: 0,
              playEvents: Array.from({ length: count }, (_, index) => ({
                type: 'pitch',
                isPitch: true,
                startTime: new Date(
                  Date.parse('2026-01-01T18:00:00Z') + index * 1000
                ).toISOString(),
                details: {
                  call: { code: 'B', description: 'Ball' },
                  code: 'B',
                  description: 'Ball',
                  isInPlay: false,
                  isStrike: false,
                  isBall: true,
                  isOut: false,
                  hasReview: false
                },
                count: { balls: index + 1, strikes: 0, outs: 0 }
              }))
            }
          ]
        })
      })
      expect(response.status).equals(200)
    }
    await generate()
    const prior = await row(id)
    await patch(1)
    expect((await row(id)).request_id).equals(prior.request_id)
    expect((await client.gameRecap(id)).status).equals('pending')
    await generate()
    expect((await client.gameRecap(id)).document!.paragraphs[0][0].text).equals(
      'Pitch count: 1.'
    )
    await requestRecap(db, id, true, 'pitch-flight')
    await runRecap(
      db,
      async () => {
        await patch(2)
        return document
      },
      signal
    )
    expect((await row(id)).status).equals('pending')
    expect((await row(id)).document).equals(null)
    await generate()
    expect((await client.gameRecap(id)).document!.paragraphs[0][0].text).equals(
      'Pitch count: 2.'
    )
  })
  it('stops a worker and aborts its request without publishing cancelled output', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    let started!: () => void
    const began = new Promise<void>(resolve => {
      started = resolve
    })
    const worker = startRecaps(
      db,
      async (_input, s) => {
        started()
        return await new Promise((_resolve, reject) => {
          s.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'))
            },
            {
              once: true
            }
          )
        })
      },
      10
    )
    await began
    await worker.stop()
    expect((await row(id)).status).equals('pending')
    const aborted = new AbortController()
    aborted.abort()
    expect(await runRecap(db, async () => document, aborted.signal)).equals(
      false
    )
  })
  it('maps only visible ready videos and removes recap rows with the game', async () => {
    const id = await game()
    await postGamePlays(db, id, body())
    await tick()
    await db
      .insertInto('videos')
      .values([
        {
          id: 'vid_recap_ready',
          game_id: id,
          kind: 'program',
          title: 'Fixture video',
          storage: 'local',
          status: 'ready',
          start_at: new Date('2026-01-01T18:00:00Z'),
          duration_sec: 60
        },
        {
          id: 'vid_recap_hidden',
          game_id: id,
          kind: 'program',
          title: 'Hidden fixture',
          storage: 'local',
          status: 'ready',
          start_at: new Date('2026-01-01T17:59:59Z'),
          duration_sec: 60,
          hidden: true
        }
      ])
      .execute()
    const client = new TeamStationClient({ baseUrl: base, token: member.token })
    expect((await client.gameRecap(id)).clips['0'].videoId).equals(
      'vid_recap_ready'
    )
    await db.deleteFrom('videos').where('game_id', '=', id).execute()
    await db.deleteFrom('games').where('id', '=', id).execute()
    expect(
      await db
        .selectFrom('game_recaps')
        .selectAll()
        .where('game_id', '=', id)
        .execute()
    ).deep.equals([])
    await sql.raw(migration111GameRecaps.down).execute(db)
    await sql.raw(migration111GameRecaps.up).execute(db)
    expect(
      await db.selectFrom('game_recaps').selectAll().execute()
    ).deep.equals([])
  })
})
