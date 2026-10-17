import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('remaining scoring on game detail and schedules', function () {
  this.timeout(60000)
  let f: GroupFixture
  const id = 'gam_live_policy_demo'
  before(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(),
        status: 'inProgress'
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })

  async function check(expected: boolean): Promise<void> {
    for (const user of [101, null]) {
      for (const path of [
        `/games/${id}`,
        ...(user == null ? [] : [`/teams/${f.teamA}/games`]),
        `/teams/${f.teamA}`
      ]) {
        const response = await f.h.request('GET', path, undefined, user)
        expect(response.status, path).equals(200)
        const body = await response.json()
        const game =
          path === `/games/${id}`
            ? body
            : (Array.isArray(body) ? body : body.games).find(
                (g: { id: string }) => g.id === id
              )
        expect(game.hasScoringEvents, path).equals(expected)
      }
    }
  }

  it('does not count initialized at-bats, and follows pitches, plays and their removal', async () => {
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: { about: { inning: 1 }, teamStation: { actions: [] } }
      })
      .where('id', '=', id)
      .execute()
    await check(false)
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: {
          teamStation: { actions: [{ type: 'pitch', kind: 'ball' }] }
        }
      })
      .where('id', '=', id)
      .execute()
    await check(true)
    await f.h.db
      .updateTable('games')
      .set({ currentPlay: null })
      .where('id', '=', id)
      .execute()
    await check(false)
    await f.h.db
      .insertInto('events')
      .values({
        id: 'evt_live_policy_demo',
        gameId: id,
        gumbo: { about: { atBatIndex: 0 }, result: { eventType: 'walk' } }
      })
      .execute()
    await check(true)
    await f.h.db.deleteFrom('events').where('gameId', '=', id).execute()
    await check(false)
  })
})
