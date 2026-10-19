import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { asLineScoreTimeline, TeamStationClient } from '../../common/api'
import { asPostEventsBody } from '../../common/gumboPlay'
import {
  addGame,
  addPerson,
  addTeam,
  type Person,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { postGamePlays } from '../events/postPlays'
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import type { ScoreboardStore } from '../scoreboard/scoreboardStore'
import { scoreboardRoutes } from './scoreboard'

/**
 * `GET /games/:gameId/line-score` (U3): every step, one instant, a window,
 * the parameters it refuses, and who may ask, on a scratch database through
 * the app's own client.
 */
describe('the line score route (U3)', function () {
  this.timeout(60000)

  let db: Kysely<Database>
  let drop: () => Promise<void>
  let server: Server
  let base = ''
  let owner: Person
  let stranger: Person
  let scored = ''
  let empty = ''
  const t0 = Date.parse('2026-10-19T18:00:00Z')

  const ask = async (
    path: string,
    who: Person | null = owner
  ): Promise<{ status: number; json: unknown }> => {
    const answer = await fetch(`${base}${path}`, {
      headers: who == null ? {} : { authorization: `Bearer ${who.token}` }
    })
    return { status: answer.status, json: await answer.json() }
  }

  // The line score is read from Postgres alone: no route it asks touches
  // the board's store, and one that did would fail the test here.
  const noStore = new Proxy(
    {},
    {
      get: (target, name) => {
        throw new Error(`the line score asked the store for ${String(name)}`)
      }
    }
  ) as ScoreboardStore

  before(async function () {
    ;({ db, drop } = await scratchDatabase('line_score_route'))
    const home = await addTeam(db, 'Owls')
    const away = await addTeam(db, 'Herons')
    owner = await addPerson(db, 'owner', { owns: home })
    stranger = await addPerson(db, 'stranger')
    scored = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date(t0)
    })
    empty = await addGame(db, {
      homeTeamId: home,
      awayTeamId: away,
      startAt: new Date(t0)
    })
    const play = (
      index: number,
      inning: number,
      half: 'top' | 'bottom',
      second: number,
      score: [number, number]
    ): unknown => ({
      about: {
        atBatIndex: index,
        inning,
        halfInning: half,
        startTime: new Date(t0 + (second - 1) * 1000).toISOString(),
        endTime: new Date(t0 + second * 1000).toISOString()
      },
      count: { outs: 3 },
      result: {
        eventType: 'single',
        awayScore: score[0],
        homeScore: score[1]
      }
    })
    await postGamePlays(
      db,
      scored,
      asPostEventsBody({
        plays: [
          play(0, 1, 'top', 10, [1, 0]),
          play(1, 1, 'bottom', 20, [1, 2]),
          play(2, 2, 'top', 30, [3, 2])
        ],
        mode: 'replace',
        source: { system: 'external' }
      })
    )
    const app = express()
    app.use(withActor(db))
    app.use(jsonBody)
    app.use('/api/v1', scoreboardRoutes(db, noStore))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.closeAllConnections()
    server?.close()
    await drop?.()
  })

  it('answers every step with the teams', async function () {
    const all = await ask(`/games/${scored}/line-score`)
    expect(all.status).equals(200)
    const timeline = asLineScoreTimeline(all.json)
    expect(timeline.teams).deep.equals({ away: 'Herons', home: 'Owls' })
    expect(timeline.steps.map(step => step.at)).deep.equals([
      t0 + 10_000,
      t0 + 20_000,
      t0 + 30_000
    ])
    expect(timeline.steps[2].line.away.innings).deep.equals([1, 2])
    expect(timeline.steps[2].line.home.innings).deep.equals([2, null])
  })

  it('answers the step in effect at one instant, and none before the first', async function () {
    const client = new TeamStationClient({ baseUrl: base, token: owner.token })
    const at = await client.lineScore(scored, { at: t0 + 25_000 })
    expect(at.steps).length(1)
    expect(at.steps[0].at).equals(t0 + 20_000)
    expect(at.steps[0].line.home.r).equals(2)
    expect((await client.lineScore(scored, { at: t0 })).steps).deep.equals([])
    const window = await client.lineScore(scored, {
      fromMs: t0 + 15_000,
      toMs: t0 + 25_000
    })
    expect(window.steps.map(step => step.at)).deep.equals([
      t0 + 10_000,
      t0 + 20_000
    ])
  })

  it('has no steps for a game with no events, and no game for none', async function () {
    const none = await ask(`/games/${empty}/line-score`)
    expect(none.status).equals(200)
    expect((none.json as { steps: unknown[] }).steps).deep.equals([])
    expect((await ask('/games/gam_nothere/line-score')).status).equals(404)
  })

  it('refuses what it cannot answer, naming the parameter', async function () {
    const bad = await ask(`/games/${scored}/line-score?at=nonsense`)
    expect(bad.status).equals(400)
    expect(JSON.stringify(bad.json)).includes('at')
    const both = await ask(`/games/${scored}/line-score?at=1&from=1`)
    expect(both.status).equals(400)
    expect(JSON.stringify(both.json)).includes('without from or to')
    const backwards = await ask(`/games/${scored}/line-score?from=5&to=1`)
    expect(backwards.status).equals(400)
  })

  it('is for somebody signed in who can see the game', async function () {
    expect((await ask(`/games/${scored}/line-score`, null)).status).equals(401)
    expect((await ask(`/games/${scored}/line-score`, stranger)).status).equals(
      403
    )
  })
})
