import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('game-bounded historical box-score averages', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_demo_game_viewer',
        team_id: f.teamA,
        user_id: 106,
        role: 'member'
      })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })
  for (const mode of ['outside', 'season'] as const) {
    it(`keeps unrelated opponent hits private in an approved ${mode} game, while authorized averages remain complete`, async () => {
      const sent = await f.h.request(
        'POST',
        '/game-requests',
        {
          sender: {
            kind: mode === 'outside' ? 'team' : 'season',
            id: mode === 'outside' ? f.teamA : f.seasonA
          },
          game: {
            homeTeamId: f.teamA,
            awayTeamId: f.teamB,
            seasonId: mode === 'outside' ? null : f.seasonA,
            startAt: '2027-03-20T19:00:00.000Z',
            venue: null,
            outsideTournament: null,
            status: 'scheduled'
          },
          idempotencyKey: 'demo-shared-box-' + mode
        },
        101
      )
      expect(sent.status).equals(201)
      const { id } = (await sent.json()) as { id: string }
      const accepted = await f.h.request(
        'POST',
        `/game-requests/${id}/accept`,
        {},
        102
      )
      expect(accepted.status).equals(200)
      const { gameId } = (await accepted.json()) as { gameId: string }
      await f.h.db
        .insertInto('games')
        .values({
          id: 'gam_demo_private_average',
          home_team_id: f.teamB,
          away_team_id: f.standaloneTeam,
          season_id: mode === 'outside' ? f.seasonB : f.seasonA,
          start_at: new Date('2027-03-19T19:00:00Z'),
          status: 'final'
        })
        .execute()
      await f.h.db
        .insertInto('game_player_stats')
        .values([
          {
            id: 'gps_demo_shared_average',
            game_id: gameId,
            team_id: f.teamB,
            user_id: 104,
            pa: 1,
            ab: 1,
            h: 0
          },
          {
            id: 'gps_demo_private_average',
            game_id: 'gam_demo_private_average',
            team_id: f.teamB,
            user_id: 104,
            pa: 1,
            ab: 1,
            h: 1
          }
        ])
        .execute()
      expect(
        (
          await f.h.request(
            'GET',
            '/games/gam_demo_private_average/box-score',
            undefined,
            106
          )
        ).status
      ).equals(404)
      const average = async (userId: number): Promise<number | null> => {
        const response = await f.h.request(
          'GET',
          `/games/${gameId}/box-score`,
          undefined,
          userId
        )
        expect(response.status).equals(200)
        const body = (await response.json()) as {
          batting: Array<{
            userId: number
            h: number
            seasonAvg: number | null
          }>
        }
        expect(body.batting[0]).includes({ userId: 104, h: 0 })
        return body.batting[0].seasonAvg
      }
      expect(await average(106)).equals(0)
      expect(await average(102)).equals(0.5)
      expect(await average(105)).equals(0.5)
      await f.h.db
        .updateTable('game_player_stats')
        .set({ h: 0 })
        .where('id', '=', 'gps_demo_private_average')
        .execute()
      expect(await average(106)).equals(0)
      expect(await average(102)).equals(0)
      expect(await average(105)).equals(0)
    })
  }
})
