import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { asDjGame } from '../../common/api'
import { POSITIONS } from '../../common/scoring/state'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('raw guest game DJ fallback privacy', function () {
  this.timeout(60000)
  let f: GroupFixture
  let gameId: string
  beforeEach(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('memberships')
      .values({
        id: 'mem_private_guest_player',
        team_id: f.teamB,
        user_id: 106,
        role: 'member',
        is_player: true,
        jersey: '1'
      })
      .execute()
    const sent = await f.h.request(
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        game: {
          homeTeamId: f.teamA,
          awayTeamId: f.teamB,
          seasonId: f.seasonA,
          startAt: '2027-03-20T19:00:00.000Z',
          venue: null,
          outsideTournament: null,
          status: 'scheduled'
        },
        idempotencyKey: 'guest-dj-privacy'
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
    gameId = ((await accepted.json()) as { gameId: string }).gameId
    // The host's administrator is not a member of the guest team: its roster
    // is theirs only in the non-member view, every name and no face.
    const outside = await f.h.request(
      'GET',
      `/teams/${f.teamB}/roster`,
      undefined,
      101
    )
    expect(outside.status).equals(200)
    expect(
      ((await outside.json()) as Array<{ avatarUrl: string | null }>).every(
        row => row.avatarUrl === null
      )
    ).equals(true)
    expect(
      (await f.h.request('GET', `/teams/${f.teamB}/stats`, undefined, 101))
        .status
    ).equals(403)
  })
  afterEach(async () => {
    await f?.h.close()
  })
  for (const source of ['roster', 'default'] as const) {
    it(`does not expose the guest's unrelated ${source}, while its own administrator can read it`, async () => {
      if (source === 'default')
        await f.h.db
          .updateTable('teams')
          .set({
            default_lineup: {
              fromGameId: 'gam_unrelated_private',
              setAt: new Date().toISOString(),
              lineup: {
                batters: [{ gumboId: 106, name: 'Private Guest', jersey: '1' }],
                defense: Object.fromEntries(
                  POSITIONS.map(position => [position, null])
                )
              }
            }
          })
          .where('id', '=', f.teamB)
          .execute()
      const shared = await f.h.request(
        'GET',
        `/games/${gameId}/dj`,
        undefined,
        101
      )
      expect(shared.status).equals(200)
      expect(asDjGame(await shared.json()).away).includes({
        canEditWalkUp: false
      })
      const body = asDjGame(
        await (
          await f.h.request('GET', `/games/${gameId}/dj`, undefined, 101)
        ).json()
      )
      expect(body.away.batters).deep.equals([])
      const own = asDjGame(
        await (
          await f.h.request('GET', `/games/${gameId}/dj`, undefined, 102)
        ).json()
      )
      expect(own.away.source).equals(source)
      expect(own.away.batters.map(row => row.userId)).includes(106)
    })
  }
})
