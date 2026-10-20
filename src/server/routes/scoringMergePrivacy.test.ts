import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { recordOf } from '../../common/scoring/gumbo'
import { ScoringSession } from '../../common/scoring/session'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
import type { AccountHarness } from '../../test/accountHarness'
import { creationHarness } from '../../test/creationHarness'
import {
  dropPrefix,
  requireRedis,
  testPrefix,
  testStore
} from '../../test/scoreboardKit'
import { closeInto } from '../admin/people'
import { createSession } from '../auth/sessions'
import { createLineupFixture } from '../dev/lineupFixture'
import { writeGameScoreboard } from '../scoreboard/gameSource'
import { scoreboardRoutes } from './scoreboard'

describe('merged scoring names on public reads', function () {
  this.timeout(60000)
  let h: AccountHarness
  let redis: Awaited<ReturnType<typeof testStore>>
  const prefix = testPrefix()
  before(async () => {
    await requireRedis()
    redis = await testStore(prefix)
    h = await creationHarness(
      undefined,
      undefined,
      '127.0.0.1',
      (app, { db }) => {
        app.use('/api/v1', scoreboardRoutes(db, redis.store))
      }
    )
  })
  after(async () => {
    await h?.close()
    if (redis?.client.isOpen) await redis.client.close()
    await dropPrefix(prefix)
  })
  it('abbreviates merged batter and pitcher names in anonymous scoreboards and member events', async () => {
    const f = await h.db
      .transaction()
      .execute(async trx => await createLineupFixture(trx, 'fixture-password'))
    const api = async (userId: string): Promise<TeamStationClient> =>
      new TeamStationClient({
        baseUrl: h.origin + '/api/v1',
        token: (await createSession(h.db, userId, 'fixture')).token
      })
    const scorer = await api(f.users.scorekeeper.userId)
    const member = await api(f.users.member.userId)
    const game = await scorer.game(f.gameId)
    const [away, home] = await Promise.all([
      scorer.roster(f.teams.away),
      scorer.roster(f.teams.home)
    ])
    const setup = startingSetup(game, away, home, {}, false)
    const session = await ScoringSession.open(
      {
        load: async id => await scorer.gameEvents(id),
        save: async (id, change) => await scorer.saveGameEvents(id, change)
      },
      f.gameId,
      { gamePk: f.gameId, teams: teamsOf(game), setup },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    expect(session.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
    const rawBefore = await h.db
      .selectFrom('games')
      .select('currentPlay')
      .where('id', '=', f.gameId)
      .executeTakeFirstOrThrow()
    const batter = f.players.away[9]
    const pitcher = f.players.home[9]
    const oldBatter = away.find(
      row => row.gumboId === session.state.liveData.linescore.offense.batter!.id
    )!
    const oldPitcher = home.find(
      row => row.gumboId === session.state.liveData.linescore.defense.P!.id
    )!
    await closeInto(h.db, oldBatter.userId, batter.userId)
    await closeInto(h.db, oldPitcher.userId, pitcher.userId)
    await h.db
      .updateTable('users')
      .set({
        display_name: 'Hank Aaron',
        first_name: 'Hank',
        last_name: 'Aaron'
      })
      .where('id', '=', batter.userId)
      .execute()
    await h.db
      .updateTable('users')
      .set({
        display_name: 'Hank Allen',
        first_name: null,
        last_name: null
      })
      .where('id', '=', pitcher.userId)
      .execute()
    const written = await writeGameScoreboard(
      {
        db: h.db,
        store: redis.store,
        log: message => {
          throw new Error(message)
        }
      },
      f.gameId
    )
    expect(written).not.equals(undefined)
    const response = await h.request(
      'GET',
      '/scoreboard/' + f.gameId,
      undefined,
      null
    )
    expect(response.status).equals(200)
    const board = await response.json()
    expect(board.state.batterName).equals('Hank Aa')
    expect(board.state.pitcherName).equals('Hank Al')
    const stored = await member.gameEvents(f.gameId)
    const players = recordOf(stored.currentPlay)!.setupBefore.players
    for (const [id, label] of [
      [batter.gumboId, 'Hank Aa'],
      [pitcher.gumboId, 'Hank Al']
    ] as const) {
      expect(players[id].fullName).equals(label)
      expect(players[id].firstName).equals(undefined)
      expect(players[id].lastName).equals(undefined)
    }
    expect(JSON.stringify(stored))
      .not.includes('Hank Aaron')
      .and.not.includes('Hank Allen')
    expect(
      await h.db
        .selectFrom('games')
        .select('currentPlay')
        .where('id', '=', f.gameId)
        .executeTakeFirstOrThrow()
    ).deep.equals(rawBefore)
  })
})
