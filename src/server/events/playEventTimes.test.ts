import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { asPostEventsBody, type GumboPlay } from '../../common/gumboPlay'
import {
  addGame,
  addPerson,
  addTeam,
  type Person,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { eventRoutes } from '../routes/events'
import { expandedGameStatLines } from '../stats/expandedStats'
import { postGamePlays } from './postPlays'

/**
 * `PATCH /games/:gameId/events`: a node administrator puts each play's
 * events, with their times, on a game an outside scorer's import stored
 * without them, and nothing else about the game changes.
 */

const START = Date.parse('2026-10-04T19:07:00.000Z')
const at = (seconds: number): string =>
  new Date(START + seconds * 1000).toISOString()

function play(index: number, away: number, home: number): unknown {
  return {
    about: {
      atBatIndex: index,
      inning: 1,
      halfInning: index === 0 ? 'top' : 'bottom',
      isScoringPlay: false,
      startTime: at(index * 60)
    },
    count: { outs: 1 },
    result: {
      eventType: 'single',
      awayScore: away,
      homeScore: home,
      description: 'A single'
    }
  }
}

function pitch(seconds: number, code = 'B'): Record<string, unknown> {
  return {
    type: 'pitch',
    isPitch: true,
    startTime: at(seconds),
    description: 'Ball',
    details: {
      call: { code, description: 'Ball' },
      code,
      description: 'Ball',
      isInPlay: false,
      isStrike: false,
      isBall: true,
      isOut: false,
      hasReview: false
    },
    count: { balls: 1, strikes: 0, outs: 0 }
  }
}

describe('adding events to stored plays', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let admin: Person
  let scorer: Person
  let home = ''
  let away = ''

  before(async function () {
    ;({ db, drop } = await scratchDatabase('play_event_times'))
    home = await addTeam(db, 'Pioneers')
    away = await addTeam(db, 'Visitors')
    admin = await addPerson(db, 'admin', { isAdmin: true })
    scorer = await addPerson(db, 'scorer', { owns: home })
    // Node administration asks for an account that may sign in.
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', 'in', [admin.userId, scorer.userId])
      .execute()
    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(
      '/api/v1',
      eventRoutes(db, {
        onGameWritten: gameId => {
          announced.push(gameId)
        }
      })
    )
    app.use(errorHandler)
    server = app.listen(0)
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    await new Promise<void>(resolve => {
      if (server == null) resolve()
      else
        server.close(() => {
          resolve()
        })
    })
    await drop()
  })

  /** The games whose board timeline the route announced, in order. */
  const announced: string[] = []

  /** A final game an outside scorer's import stored, with two plays. */
  async function importedGame(): Promise<string> {
    const gameId = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date(START)
    })
    await postGamePlays(
      db,
      gameId,
      asPostEventsBody({
        plays: [play(0, 0, 0), play(1, 0, 1)],
        source: { system: 'outside' }
      })
    )
    return gameId
  }

  async function put(
    gameId: string,
    body: unknown,
    who: Person = admin
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/games/${gameId}/events`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${who.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>
    }
  }

  async function stored(gameId: string): Promise<unknown> {
    return {
      plays: await db
        .selectFrom('events')
        .select([
          'atBatIndex',
          'eventType',
          'startTime',
          'endTime',
          'awayScore',
          'homeScore',
          'source',
          'hidden',
          'gumbo'
        ])
        .where('gameId', '=', gameId)
        .orderBy('atBatIndex')
        .execute(),
      game: await db
        .selectFrom('games')
        .select(['status', 'scoringOwner', 'away_score', 'home_score'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow(),
      stats: await db
        .selectFrom('game_player_stats')
        .selectAll()
        .where('game_id', '=', gameId)
        .execute()
    }
  }

  it("puts each play's timed events on a final game, and changes nothing else", async function () {
    const gameId = await importedGame()
    const before = (await stored(gameId)) as {
      plays: Array<{ gumbo: Record<string, unknown> }>
      game: { status: string }
    }
    expect(before.game.status).equals('final')
    const { updated_at: was } = await db
      .selectFrom('games')
      .select('updated_at')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()

    const answer = await put(gameId, {
      plays: [{ atBatIndex: 1, playEvents: [pitch(61), pitch(65)] }]
    })
    expect(answer).deep.equals({ status: 200, body: { plays: 1, events: 2 } })

    const after = (await stored(gameId)) as typeof before
    const events = after.plays[1].gumbo.playEvents as Array<
      Record<string, unknown>
    >
    expect(events.map(event => event.startTime)).deep.equals([at(61), at(65)])
    // Without the other service's words, as any outside scorer's play.
    expect(events.every(event => !('description' in event))).equals(true)
    // Everything else as it was: the other play, this one's own fields, the
    // game and its statistics.
    const { playEvents, ...rest } = after.plays[1].gumbo
    expect(playEvents).not.equals(undefined)
    expect(rest).deep.equals(before.plays[1].gumbo)
    expect({ ...after, plays: [after.plays[0]] }).deep.equals({
      ...before,
      plays: [before.plays[0]]
    })
    const plays = after.plays as Array<Record<string, unknown>>
    const was1 = before.plays as Array<Record<string, unknown>>
    expect({ ...plays[1], gumbo: null }).deep.equals({
      ...was1[1],
      gumbo: null
    })
    // The board's timeline is cached under the game's updated_at.
    const { updated_at: now } = await db
      .selectFrom('games')
      .select('updated_at')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(new Date(now).getTime()).greaterThan(new Date(was).getTime())
  })

  it('refuses the whole body, and writes nothing, for anything it cannot keep', async function () {
    const gameId = await importedGame()
    const before = await stored(gameId)
    const good = { atBatIndex: 0, playEvents: [pitch(1)] }
    const cases: Array<[string, unknown, number, Person?]> = [
      [
        'somebody who is not a node administrator',
        { plays: [good] },
        403,
        scorer
      ],
      [
        'a play the game does not have',
        { plays: [good, { atBatIndex: 7, playEvents: [] }] },
        400
      ],
      ['a play named twice', { plays: [good, good] }, 400],
      [
        'an event with no time',
        {
          plays: [
            {
              atBatIndex: 0,
              playEvents: [{ ...pitch(1), startTime: undefined }]
            }
          ]
        },
        400
      ],
      [
        'an event with a time that is no time',
        {
          plays: [
            { atBatIndex: 0, playEvents: [{ ...pitch(1), startTime: 'soon' }] }
          ]
        },
        400
      ],
      [
        'an event that is not a play event',
        {
          plays: [
            { atBatIndex: 0, playEvents: [{ type: 'swing', startTime: at(1) }] }
          ]
        },
        400
      ],
      [
        'a pitch with no pitch code',
        { plays: [{ atBatIndex: 0, playEvents: [pitch(1, 'nonsense')] }] },
        400
      ],
      ['a body that is not plays', { plays: 'all of them' }, 400],
      [
        'a time that is a number',
        {
          plays: [
            { atBatIndex: 0, playEvents: [{ ...pitch(1), startTime: 5 }] }
          ]
        },
        400
      ],
      [
        'a time that is a bare digit',
        {
          plays: [
            { atBatIndex: 0, playEvents: [{ ...pitch(1), startTime: '0' }] }
          ]
        },
        400
      ],
      [
        'a time with no zone',
        {
          plays: [
            {
              atBatIndex: 0,
              playEvents: [{ ...pitch(1), startTime: '2026-10-04T19:07:00' }]
            }
          ]
        },
        400
      ],
      [
        'an event naming a person by a string',
        {
          plays: [
            {
              atBatIndex: 0,
              playEvents: [
                { ...pitch(1), player: { id: String(scorer.userId) } }
              ]
            }
          ]
        },
        400
      ],
      [
        'an event naming a person by a fraction',
        {
          plays: [
            {
              atBatIndex: 0,
              playEvents: [{ ...pitch(1), pitcher: { id: 1.5 } }]
            }
          ]
        },
        400
      ],
      [
        'an event naming a person who is not a user',
        {
          plays: [
            {
              atBatIndex: 0,
              playEvents: [
                { ...pitch(1), player: { id: 424242 } },
                { ...pitch(2), offense: { first: { id: 434343 } } }
              ]
            }
          ]
        },
        400
      ]
    ]
    for (const [what, body, status, who] of cases) {
      const answer = await put(gameId, body, who)
      expect(answer.status, what).equals(status)
      expect(await stored(gameId), what).deep.equals(before)
    }
    expect((await put('gam_nonexistent', { plays: [good] })).status).equals(404)
    const unknown = await put(gameId, {
      plays: [
        { atBatIndex: 0, playEvents: [{ ...pitch(1), player: { id: 424242 } }] }
      ]
    })
    expect(unknown.body.message).equals(
      'Play 0: event 0 names person 424242, who is not a user'
    )
    const fraction = await put(gameId, {
      plays: [
        { atBatIndex: 0, playEvents: [{ ...pitch(1), pitcher: { id: 1.5 } }] }
      ]
    })
    expect(fraction.body.message).equals(
      'Play 0: event 0 names person 1.5, which is not a user id'
    )
    // A user, or nobody named (null), is fine.
    const named = await put(gameId, {
      plays: [
        {
          atBatIndex: 0,
          playEvents: [
            { ...pitch(1), player: { id: scorer.userId } },
            { ...pitch(2), pitcher: { id: null } },
            // An umpire is nobody the game's statistics name.
            { ...pitch(3), umpire: { id: 515151 } }
          ]
        }
      ]
    })
    expect(named.status).equals(200)
  })

  it('asks for no statistics rebuild; the next one counts the events', async function () {
    const gameId = await importedGame()
    const queued = async (): Promise<unknown[]> =>
      await db
        .selectFrom('game_stats_state')
        .selectAll()
        .where('game_id', '=', gameId)
        .execute()
    const before = await queued()
    const answer = await put(gameId, {
      plays: [{ atBatIndex: 0, playEvents: [pitch(1), pitch(2)] }]
    })
    expect(answer.status).equals(200)
    expect(await queued()).deep.equals(before)

    // What a rebuild reads from a play: without its events a pitcher's
    // pitches are unknown; with them, they are counted.
    const thrown = (playEvents?: unknown[]): unknown => {
      const one: GumboPlay = {
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
        result: { eventType: 'single' },
        count: { outs: 0 },
        matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
        ...(playEvents == null ? {} : { playEvents }),
        runners: [
          {
            movement: { start: null, end: '1B', isOut: false },
            details: { runner: { id: 1 }, eventType: 'single' }
          }
        ]
      }
      const result = expandedGameStatLines(
        [one],
        { homeTeamId: home, awayTeamId: away },
        new Set([1, 11])
      )
      if (result.kind !== 'lines') throw new Error(result.detail)
      return result.lines.find(line => line.gumboId === 11)?.extra.pitches
    }
    expect(thrown()).equals(null)
    expect(
      thrown([
        { index: 0, isPitch: true, details: { call: { code: 'B' } } },
        { index: 1, isPitch: true, details: { call: { code: 'D' } } }
      ])
    ).equals(2)
  })

  it('tells a viewer watching the board’s timeline once the events are stored, and not after a refusal', async function () {
    const gameId = await importedGame()
    announced.length = 0
    const refused = await put(gameId, {
      plays: [{ atBatIndex: 9, playEvents: [pitch(1)] }]
    })
    expect(refused.status).equals(400)
    expect(announced).deep.equals([])
    const answer = await put(gameId, {
      plays: [{ atBatIndex: 0, playEvents: [pitch(1)] }]
    })
    expect(answer.status).equals(200)
    expect(announced).deep.equals([gameId])
  })

  it('takes a long game’s events, past the small body limit', async function () {
    const gameId = await importedGame()
    // About 1.5 MB of pitches on one play.
    const many = Array.from({ length: 6000 }, (unused, index) =>
      pitch(1 + index / 100)
    )
    expect(JSON.stringify(many).length).greaterThan(1_100_000)
    const answer = await put(gameId, {
      plays: [{ atBatIndex: 0, playEvents: many }]
    })
    expect(answer).deep.equals({
      status: 200,
      body: { plays: 1, events: 6000 }
    })
  })

  it('refuses a game TeamStation scores', async function () {
    const gameId = await importedGame()
    await db
      .updateTable('games')
      .set({ scoringOwner: 'teamstation' })
      .where('id', '=', gameId)
      .execute()
    const before = await stored(gameId)
    const answer = await put(gameId, {
      plays: [{ atBatIndex: 0, playEvents: [pitch(1)] }]
    })
    expect(answer.status).equals(409)
    expect(await stored(gameId)).deep.equals(before)
  })
})
