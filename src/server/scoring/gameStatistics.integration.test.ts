import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { asGameStatistics } from '../../common/api'
import { makeId } from '../../common/ids'
import type { ScoringAction } from '../../common/scoring/actions'
import { userIdOfGumbo } from '../../common/userId'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import {
  addGame,
  addScorableTeams,
  scoreDirectly,
  scratchDatabase
} from '../../test/scoreboardKit'
import type { Database } from '../db/database'
import { gameStatistics } from './gameStatistics'

describe("a game's playback statistics, named for their reader", function () {
  this.timeout(60000)
  let db: Kysely<Database>
  let drop: () => Promise<void>
  let gameId: string
  let pitcher: number
  const coach = mintUserId(() => false)
  const stranger = mintUserId(id => id === coach.userId)

  before(async function () {
    ;({ db, drop } = await scratchDatabase('game_statistics_reader'))
    const context = await addScorableTeams(db, {
      home: 'Owls',
      away: 'Herons'
    })
    // The home pitcher, a player of the team the coach coaches.
    pitcher = context.setup.sides.home.defense.P!
    await db
      .updateTable('users')
      .set({
        display_name: 'Mookie Betts',
        first_name: 'Mookie',
        last_name: 'Betts'
      })
      .where('id', '=', userIdOfGumbo(pitcher))
      .execute()
    const now = new Date()
    await insertFixtureUsers(db, [
      {
        id: userIdOfGumbo(coach.userId),
        legacyId: coach.legacyId,
        display_name: 'Dave Roberts',
        created_at: now,
        updated_at: now
      },
      {
        id: userIdOfGumbo(stranger.userId),
        legacyId: stranger.legacyId,
        display_name: 'Babe Ruth',
        created_at: now,
        updated_at: now
      }
    ])
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(pitcher),
        team_id: context.teams.home.id,
        role: 'member',
        is_player: true
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(coach.userId),
        scope_type: 'team',
        scope_id: context.teams.home.id,
        role: 'coach'
      })
      .execute()
    gameId = await addGame(db, {
      homeTeamId: context.teams.home.id,
      awayTeamId: context.teams.away.id,
      startAt: now
    })
    const strike: ScoringAction = { type: 'pitch', call: 'C' }
    await scoreDirectly(db, gameId, context, [strike, strike, strike])
  })

  after(async function () {
    await drop?.()
  })

  it('names the boxes in full for the coach, the source apart, and the board for everybody', async function () {
    const read = async (userId: number): ReturnType<typeof gameStatistics> =>
      await gameStatistics(
        db,
        gameId,
        {},
        { reader: { userId: userIdOfGumbo(userId), isAdmin: false } }
      )
    const forCoach = await read(coach.userId)
    const forStranger = await read(stranger.userId)
    // The source is the public's, and whom the coach reads in full comes
    // beside it, as the events read answers it.
    expect(JSON.stringify(forCoach.source)).not.include('Betts')
    expect(forCoach.readerNames).deep.equals({ [pitcher]: 'Mookie Betts' })
    expect(forStranger).not.have.property('readerNames')
    expect(JSON.stringify(forCoach.boxes)).include('Mookie Betts')
    // The client names him in full with the public label beside, which the
    // replay diamond draws.
    const cleaned = asGameStatistics(JSON.parse(JSON.stringify(forCoach)))
    expect(cleaned).not.have.property('readerNames')
    const setup = (
      (cleaned.source.plays[0] ?? cleaned.source.currentPlay) as unknown as {
        teamStation: { setupBefore: { players: Record<string, object> } }
      }
    ).teamStation.setupBefore
    expect(
      Object.values(setup.players).find(
        player => (player as { id?: number }).id === pitcher
      )
    ).include({
      fullName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'Mookie B'
    })
    expect(JSON.stringify(forStranger.source)).not.include('Betts')
    expect(JSON.stringify(forStranger.source)).include('"fullName":"Mookie B"')
    expect(JSON.stringify(forStranger.boxes)).not.include('Betts')
    // The timelines every reader shares stay the public's.
    expect(forCoach.board).deep.equals(forStranger.board)
    expect(forCoach.line).deep.equals(forStranger.line)
    expect(JSON.stringify(forCoach.board)).not.include('Betts')
    expect(forCoach.version).equals(forStranger.version)
    expect(await gameStatistics(db, gameId)).deep.equals(forStranger)
  })
})
