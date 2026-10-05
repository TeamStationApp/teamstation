import { expect } from 'chai'
import express from 'express'
import { after, before, describe, it } from 'mocha'

import { asBattingRow, asBoxScore, asPitchingRow } from '../../common/api'
import { emptyStatExtras } from '../../common/statExtras'
import { asUserId } from '../../common/userIdNumber'
import { statsDatabase } from '../../test/statsDatabase'
import type { MediaContext } from '../media/mediaContext'
import { errorHandler } from '../middleware/withErrors'
import { teamsOf } from './players'
import { teamRoutes } from './teams'

const media: MediaContext = {
  ffmpegPath: 'ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'synthetic',
  publicUrl: 'http://example.com',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}

describe('expanded statistics routes', function () {
  this.timeout(60000)
  const fixture = statsDatabase('routes')
  let server: ReturnType<express.Express['listen']>
  let base: string
  const ask = async (path: string, actor = 'admin'): Promise<Response> =>
    await fetch(`${base}${path}`, { headers: { 'x-test-actor': actor } })
  before(async function () {
    const { db, ids } = fixture
    const app = express()
    app.use((req, _res, next) => {
      const actor = req.header('x-test-actor')
      if (actor !== 'none')
        req.actor = {
          userId: asUserId(String(ids[2])),
          isAdmin: actor === 'admin',
          scopes: []
        }
      next()
    })
    app.use(teamRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0)
    const address = server.address()
    if (address == null || typeof address === 'string')
      throw new Error('Expected port')
    base = `http://127.0.0.1:${address.port}`
    await db
      .insertInto('game_player_stats')
      .values([
        {
          id: 'gps_pitcher',
          game_id: 'gam_demo',
          team_id: 'tem_home',
          user_id: ids[0],
          extra: JSON.stringify({
            ...emptyStatExtras(),
            appeared: true,
            gs: 1,
            pitches: 3,
            pitchAb: 2,
            pitchSb: 1,
            pitchCs: 1
          }),
          pitch_h: 1
        },
        {
          id: 'gps_batter',
          game_id: 'gam_demo',
          team_id: 'tem_home',
          user_id: ids[1],
          pa: 2,
          ab: 2,
          h: 1,
          extra: JSON.stringify({ ...emptyStatExtras(), roe: 1, firstPa: 4 })
        }
      ])
      .execute()
  })
  after(() => server?.close())
  it('keeps the batting array and exposes only actual pitching appearances', async function () {
    const batting = (
      (await (await ask('/teams/tem_home/stats')).json()) as unknown[]
    ).map(asBattingRow)
    expect(batting.map(row => row.userId)).deep.equals([fixture.ids[1]])
    expect(batting[0].roe).equals(1)
    const pitching = (
      (await (
        await ask('/teams/tem_home/stats?kind=pitching&seasonId=sea_demo')
      ).json()) as unknown[]
    ).map(asPitchingRow)
    expect(pitching).has.length(1)
    expect(pitching[0]).includes({
      userId: fixture.ids[0],
      ip: '0.0',
      g: 1,
      pitches: 3,
      gs: 1
    })
    expect(pitching[0].rates).includes({ baa: 0.5, sbPct: 0.5 })
    expect(
      await (
        await ask('/teams/tem_home/stats?kind=pitching&seasonId=sea_missing')
      ).json()
    ).deep.equals([])
    expect(
      (await ask('/teams/tem_home/stats?kind=pitching', 'stranger')).status
    ).equals(404)
    expect(
      (await ask('/teams/tem_home/stats?kind=pitching', 'none')).status
    ).equals(401)
    expect(
      (await teamsOf(fixture.db, [fixture.ids[0]])).map(team => [
        team.teamId,
        team.seasonId
      ])
    ).deep.equals([['tem_home', 'sea_demo']])
  })
  it('orders stored appearances and legacy event fallback through merged identities', async function () {
    const { db, ids } = fixture
    await db
      .updateTable('game_player_stats')
      .set({
        pa: 1,
        ab: 1,
        extra: JSON.stringify({
          ...emptyStatExtras(),
          appeared: true,
          firstPa: 9
        })
      })
      .where('id', '=', 'gps_pitcher')
      .execute()
    let box = asBoxScore(await (await ask('/games/gam_demo/box-score')).json())
    expect(box.batting.map(row => row.userId)).deep.equals([ids[1], ids[0]])
    await db.updateTable('game_player_stats').set({ extra: null }).execute()
    await db
      .updateTable('users')
      .set({ merged_into: ids[0] })
      .where('id', '=', ids[2])
      .execute()
    await db
      .insertInto('events')
      .values([
        {
          id: 'evt_first',
          gameId: 'gam_demo',
          gumbo: JSON.stringify({
            about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
            result: { eventType: 'single' },
            matchup: { batter: { id: ids[2] } }
          })
        },
        {
          id: 'evt_second',
          gameId: 'gam_demo',
          gumbo: JSON.stringify({
            about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
            result: { eventType: 'single' },
            matchup: { batter: { id: ids[1] } }
          })
        },
        {
          id: 'evt_unnamed',
          gameId: 'gam_demo',
          gumbo: JSON.stringify({
            about: { atBatIndex: 2, inning: 1, halfInning: 'bottom' },
            result: { eventType: 'single' },
            matchup: { batter: {} }
          })
        }
      ])
      .execute()
    box = asBoxScore(await (await ask('/games/gam_demo/box-score')).json())
    expect(box.batting.map(row => row.userId)).deep.equals([ids[0], ids[1]])
  })
})
