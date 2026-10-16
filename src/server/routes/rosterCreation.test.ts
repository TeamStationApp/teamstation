import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import {
  asGameLineupsResponse,
  asRosterEntry,
  type GameLineupsResponse,
  type SaveLineupsBody
} from '../../common/api'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { seedSettingsCleanup3 } from '../../test/settingsCleanup3Fixture'
import { startingContext } from './lineups'

describe('created roster players saved into coach lineups', function () {
  this.timeout(60000)
  let f: GroupFixture | undefined
  afterEach(async () => {
    await f?.h.close()
  })
  for (const alreadySaved of [false, true])
    it(`saves a new roster user with existing lineup=${alreadySaved} and refuses outsiders`, async () => {
      f = await groupFixture()
      await seedSettingsCleanup3(f)
      await f.h.db
        .insertInto('memberships')
        .values({
          id: 'mem_review_other',
          user_id: 105,
          team_id: f.teamB,
          is_player: true
        })
        .execute()
      const gameId = 'gam_settings3_scheduled'
      const context = await startingContext(
        f.h.db,
        gameId,
        { home_team_id: f.teamA, away_team_id: f.teamB },
        () => true
      )
      const setup = context.setup
      const side = setup.sides.home
      const index = (id: number): number => side.players.indexOf(id)
      const current = async (): Promise<GameLineupsResponse> =>
        asGameLineupsResponse(
          await (
            await f!.h.request(
              'GET',
              `/games/${gameId}/lineups`,
              undefined,
              101
            )
          ).json()
        )
      let base = (await current()).digest
      const body: SaveLineupsBody = {
        side: 'home',
        base,
        players: side.players.map(id => ({
          userId: setup.players[id].userId,
          fullName: setup.players[id].fullName,
          jersey: setup.players[id].jersey
        })),
        battingOrder: side.battingOrder.map(index),
        defense: Object.fromEntries(
          Object.entries(side.defense)
            .filter(([, id]) => id != null)
            .map(([position, id]) => [position, index(id!)])
        )
      }
      const save = async (value: SaveLineupsBody): Promise<Response> =>
        await f!.h.request('POST', `/games/${gameId}/lineups`, value, 101)
      if (alreadySaved) {
        expect((await save(body)).status).equals(200)
        base = (await current()).digest
      }
      const create = await f.h.request(
        'POST',
        `/teams/${f.teamA}/roster-players`,
        {
          firstName: 'Mookie',
          lastName: 'Betts',
          jersey: '50',
          positions: ['RF'],
          bats: 'right',
          throws: 'right'
        },
        101
      )
      expect(create.status).equals(201)
      const player = asRosterEntry(await create.json())
      const added: SaveLineupsBody = {
        ...body,
        base,
        players: [
          ...body.players,
          { userId: player.userId, fullName: 'Untrusted label', jersey: '99' }
        ],
        battingOrder: [...body.battingOrder, body.players.length]
      }
      const saved = await save(added)
      expect(saved.status, JSON.stringify(await saved.clone().json())).equals(
        200
      )
      const read = await current()
      expect(
        read.home.current?.batters.find(row => row.userId === player.userId)
          ?.name
      ).equals('Mookie B')
      // A role holder and a player of another team cannot be injected as this team's new player.
      for (const userId of [101, 105]) {
        const refused = await save({
          ...added,
          base: read.digest,
          players: [
            ...added.players,
            { userId, fullName: 'Outsider', jersey: '' }
          ]
        })
        expect(refused.status).equals(400)
      }
    })
})
