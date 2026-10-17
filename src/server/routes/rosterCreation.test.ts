import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

import { createDictatedPlayers } from '../../app/scoring/createDictatedPlayers'
import { createDevelopmentSession } from '../../app/scoring/developmentSession'
import { gameFixture } from '../../app/scoring/isUnscoredGame.test'
import {
  asGameLineupsResponse,
  asRosterEntry,
  type GameLineupsResponse,
  type RosterEntry,
  type SaveLineupsBody
} from '../../common/api'
import {
  type RosterCommand,
  rosterSituation
} from '../../common/scoring/rosterCommands'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { seedSettingsCleanup3 } from '../../test/settingsCleanup3Fixture'
import { startingContext } from './lineups'

describe('created roster players saved into coach lineups', function () {
  this.timeout(60000)
  let f: GroupFixture | undefined
  afterEach(async () => {
    await f?.h.close()
  })
  it('reuses persisted identities when a later dictated creation fails and the sentence is retried', async () => {
    f = await groupFixture()
    const draft = createDevelopmentSession(
      { ...gameFixture, homeTeamId: f.teamA },
      [],
      []
    )
    const commands: RosterCommand[] = [
      { type: 'addPlayer', side: 'home', name: 'Shohei Ohtani', jersey: '17' },
      { type: 'addPlayer', side: 'home', name: 'Aaron Judge', jersey: '99' }
    ]
    const completed = new Map<string, RosterEntry>()
    const created: number[] = []
    let refuseSecond = true
    const create: Parameters<typeof createDictatedPlayers>[3] = async (
      teamId,
      player
    ) => {
      if (player.firstName === 'Aaron' && refuseSecond) {
        refuseSecond = false
        throw new Error('Temporary failure')
      }
      const response = await f!.h.request(
        'POST',
        `/teams/${teamId}/roster-players`,
        player,
        101
      )
      expect(response.status).equals(201)
      const entry = asRosterEntry(await response.json())
      created.push(entry.userId)
      return entry
    }
    let failed = false
    try {
      await createDictatedPlayers(
        draft,
        commands,
        rosterSituation(draft),
        create,
        () => true,
        completed
      )
    } catch (error) {
      failed = true
      expect((error as Error).message).equals('Temporary failure')
    }
    expect(failed).equals(true)
    expect(created).length(1)
    const firstId = created[0]
    const result = await createDictatedPlayers(
      draft,
      commands,
      rosterSituation(draft),
      create,
      () => true,
      completed
    )
    if ('problem' in result) throw new Error(result.problem)
    expect(created).length(2)
    const players = Object.values(result.draft.gameData.players).filter(
      player => created.includes(player.userId!)
    )
    expect(players).length(2)
    expect(
      players.some(
        player => player.userId === firstId && player.firstName === 'Shohei'
      )
    ).equals(true)
    const roster = await f.h.db
      .selectFrom('memberships')
      .select('user_id')
      .where('team_id', '=', f.teamA)
      .where('user_id', 'in', created)
      .execute()
    expect(roster.map(row => row.user_id)).have.members(created)
    // Repeating the acknowledged sentence does not create or stage duplicates.
    const repeated = await createDictatedPlayers(
      result.draft,
      commands,
      rosterSituation(result.draft),
      create,
      () => true,
      completed
    )
    if ('problem' in repeated) throw new Error(repeated.problem)
    expect(created).length(2)
    expect(repeated.draft.liveData.boxscore.teams.home.players).deep.equals(
      result.draft.liveData.boxscore.teams.home.players
    )
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
