import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import type { GameIntent } from '../../common/gameApprovals'
import { makeId } from '../../common/ids'
import { OPEN_SIDE_NAME } from '../../common/openSides'
import { userIdOfGumbo } from '../../common/userId'
import {
  actor,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'
import { completionNotice } from '../notifications/completionNotice'
import { titleAndDescription } from '../notifications/requestInformation'
import { requireImmediateGameConsent, SIDE_CLEARED } from './gameApprovals'
import { pendingSchedule } from './pendingProjection'

/**
 * A proposal may leave a side open (`null`), and a later edit may give it a
 * team. In the fixture, 103 administers Demo Visitors (no season) and 102
 * Demo Eagles; 106 is made an administrator of Demo Regular with no team
 * role, and the two teams are its active members where a case says so.
 */
describe('scheduling a game with an open side', function () {
  this.timeout(120000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
    // As every open-sides suite: the season's roles reach its teams through
    // `season_team_parents`.
    await f.h.db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(106),
        scope_type: 'season',
        scope_id: f.seasonA,
        role: 'admin'
      })
      .execute()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  let keys = 0
  const intent = (
    homeTeamId: string | null,
    awayTeamId: string | null,
    seasonId: string | null = null
  ): GameIntent => ({
    homeTeamId,
    awayTeamId,
    seasonId,
    startAt: '2027-04-10T19:00:00.000Z',
    status: 'scheduled',
    venue: null,
    outsideTournament: null
  })
  const propose = async (
    user: number,
    sender: { kind: 'team' | 'season'; id: string },
    game: GameIntent,
    edit: { gameId: string; expected: string } | undefined = undefined
  ): Promise<Response> =>
    await f.h.request(
      'POST',
      '/game-requests',
      { sender, game, idempotencyKey: `open-sides-${++keys}`, ...edit },
      user
    )
  const sent = async (
    response: Response
  ): Promise<{ id: string; status: string; gameId: string | null }> => {
    const text = await response.text()
    expect(response.status, text).equals(201)
    return JSON.parse(text)
  }
  const refusal = async (
    response: Response,
    status: number
  ): Promise<string> => {
    const text = await response.text()
    expect(response.status, text).equals(status)
    return (
      (JSON.parse(text) as { message?: string; error?: string }).message ?? text
    )
  }
  const gameRow = async (id: string): Promise<any> =>
    await f.h.db
      .selectFrom('games')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  const teamCount = async (): Promise<number> =>
    (await f.h.db.selectFrom('teams').select('id').execute()).length
  const scheduling = async (gameId: string, user: number): Promise<any> => {
    const response = await f.h.request(
      'GET',
      `/games/${gameId}/scheduling`,
      undefined,
      user
    )
    expect(response.status).equals(200)
    return await response.json()
  }
  const members = async (...teamIds: string[]): Promise<void> => {
    await f.h.db
      .insertInto('season_teams')
      .values(
        teamIds.map(teamId => ({
          team_id: teamId,
          season_id: f.seasonA,
          active: true
        }))
      )
      .execute()
  }
  const sidesOf = async (requestId: string): Promise<any[]> =>
    await f.h.db
      .selectFrom('group_request_sides')
      .select(['scope_type', 'scope_id', 'approved_by'])
      .where('request_id', '=', requestId)
      .execute()
  const insertGame = async (
    home: string | null,
    away: string | null,
    seasonId: string | null = null
  ): Promise<string> => {
    const id = makeId('game')
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: seasonId,
        start_at: new Date('2027-04-12T19:00:00.000Z'),
        timezone: 'UTC'
      })
      .execute()
    return id
  }
  /** The team page's game: Demo Visitors at home, the opponent open. */
  const teamPageGame = async (): Promise<string> => {
    const answer = await sent(
      await propose(
        103,
        { kind: 'team', id: f.standaloneTeam },
        intent(f.standaloneTeam, null)
      )
    )
    expect(answer.status).equals('accepted')
    return answer.gameId!
  }

  it('accepts a team page’s game with the opponent open at once, and creates no team', async () => {
    const before = await teamCount()
    const gameId = await teamPageGame()
    const row = await gameRow(gameId)
    expect([row.home_team_id, row.away_team_id]).deep.equals([
      f.standaloneTeam,
      null
    ])
    expect(await teamCount()).equals(before)
    // Its scheduling answer names the open side as every answer does.
    const state = await scheduling(gameId, 103)
    expect(state.game).deep.include({
      homeTeamId: f.standaloneTeam,
      awayTeamId: ''
    })
    expect(state).deep.include({ canPropose: true })
  })

  it('refuses a team page’s game whose own side is open, and one with both open', async () => {
    await refusal(
      await propose(
        103,
        { kind: 'team', id: f.standaloneTeam },
        intent(null, f.teamB)
      ),
      403
    )
    expect(
      await refusal(
        await propose(
          103,
          { kind: 'team', id: f.standaloneTeam },
          intent(null, null)
        ),
        400
      )
    ).includes('Choose at least one team, or send the game from its season')
    expect(await f.h.db.selectFrom('games').select('id').execute()).lengthOf(0)
  })

  it('asks only the named team of a season page’s game with one side open', async () => {
    const answer = await sent(
      await propose(
        106,
        { kind: 'season', id: f.seasonA },
        intent(f.teamB, null, f.seasonA)
      )
    )
    expect(answer.status).equals('pending')
    expect((await sidesOf(answer.id)).map(side => side.scope_id)).deep.equals([
      f.teamB
    ])
    // Pending, it is shown on the season's and the team's lists with TBD.
    const listed = await f.h.request(
      'GET',
      `/game-requests?scopeKind=season&scopeId=${f.seasonA}`,
      undefined,
      106
    )
    const rows = (await listed.json()) as any[]
    expect(rows[0].game).deep.include({ homeTeamId: f.teamB, awayTeamId: '' })
    const pending = await pendingSchedule(f.h.db, actor(102), new Date(), {
      teamId: f.teamB
    })
    expect(pending[0]).deep.include({
      homeTeamId: f.teamB,
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME,
      awayTeamExternal: true,
      awayLogoPath: null,
      affectedTeamIds: [f.teamB]
    })
    // The request's words name the open side TBD.
    const request = await f.h.db
      .selectFrom('group_requests')
      .selectAll()
      .where('id', '=', answer.id)
      .executeTakeFirstOrThrow()
    const words = await titleAndDescription(f.h.db, request)
    expect(words.title).includes(`${OPEN_SIDE_NAME} invited to game`)
    expect(await completionNotice(f.h.db, request.terms as never)).includes(
      `vs ${OPEN_SIDE_NAME}`
    )
    // The named team approves, and the game is published.
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${answer.id}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    const published = (await accepted.json()) as {
      status: string
      gameId: string
    }
    expect(published.status).equals('accepted')
    expect((await gameRow(published.gameId)).away_team_id).equals(null)
  })

  it('lets the season approve for an active member of a game with one side open', async () => {
    await members(f.standaloneTeam)
    const answer = await sent(
      await propose(
        106,
        { kind: 'season', id: f.seasonA },
        intent(null, f.standaloneTeam, f.seasonA)
      )
    )
    expect(answer.status).equals('accepted')
    const row = await gameRow(answer.gameId!)
    expect([row.home_team_id, row.away_team_id]).deep.equals([
      null,
      f.standaloneTeam
    ])
  })

  it('accepts a season’s game with both sides open on its own authority, and lets the season assign it', async () => {
    const before = await teamCount()
    const answer = await sent(
      await propose(
        106,
        { kind: 'season', id: f.seasonA },
        intent(null, null, f.seasonA)
      )
    )
    expect(answer.status).equals('accepted')
    expect(await sidesOf(answer.id)).deep.equals([])
    const gameId = answer.gameId!
    expect(await teamCount()).equals(before)
    // 106 administers neither side's team, and may still change it.
    const state = await scheduling(gameId, 106)
    expect(state.game).deep.include({ homeTeamId: '', awayTeamId: '' })
    expect(state).deep.include({
      canPropose: true,
      withdrawTeamIds: [],
      administeredTeamIds: []
    })
    await members(f.standaloneTeam)
    const assigned = await sent(
      await propose(
        106,
        { kind: 'season', id: f.seasonA },
        intent(f.standaloneTeam, null, f.seasonA),
        { gameId, expected: state.version }
      )
    )
    expect(assigned).deep.include({ status: 'accepted', gameId })
    const row = await gameRow(gameId)
    expect([row.home_team_id, row.away_team_id]).deep.equals([
      f.standaloneTeam,
      null
    ])
    expect((await scheduling(gameId, 106)).version).not.equals(state.version)
  })

  it('refuses a season administrator the scheduling of a named game of teams he does not administer', async () => {
    const gameId = await insertGame(f.teamB, f.standaloneTeam, f.seasonA)
    const response = await f.h.request(
      'GET',
      `/games/${gameId}/scheduling`,
      undefined,
      106
    )
    expect(response.status).equals(403)
  })

  it('assigns a team to the open side by an edit: same game, that team’s consent, published on approval', async () => {
    const gameId = await teamPageGame()
    const state = await scheduling(gameId, 103)
    const answer = await sent(
      await propose(
        103,
        { kind: 'team', id: f.standaloneTeam },
        intent(f.standaloneTeam, f.teamB),
        { gameId, expected: state.version }
      )
    )
    expect(answer).deep.include({ status: 'pending', gameId })
    const sides = await sidesOf(answer.id)
    const approved = new Map(
      sides.map(side => [side.scope_id, side.approved_by != null])
    )
    expect(Object.fromEntries(approved)).deep.equals({
      [f.standaloneTeam]: true,
      [f.teamB]: false
    })
    // Until Demo Eagles approves, the side stays open.
    expect((await gameRow(gameId)).away_team_id).equals(null)
    const accepted = await f.h.request(
      'POST',
      `/game-requests/${answer.id}/accept`,
      {},
      102
    )
    expect(accepted.status).equals(200)
    expect(await accepted.json()).deep.include({ status: 'accepted', gameId })
    const row = await gameRow(gameId)
    expect([row.home_team_id, row.away_team_id]).deep.equals([
      f.standaloneTeam,
      f.teamB
    ])
    const after = await scheduling(gameId, 103)
    expect(after.version).not.equals(state.version)
    expect(after.game.awayTeamId).equals(f.teamB)
  })

  it('refuses an edit that clears a named side', async () => {
    const gameId = await insertGame(f.standaloneTeam, f.teamB)
    const state = await scheduling(gameId, 103)
    expect(
      await refusal(
        await propose(
          103,
          { kind: 'team', id: f.standaloneTeam },
          intent(f.standaloneTeam, null),
          { gameId, expected: state.version }
        ),
        409
      )
    ).includes(SIDE_CLEARED)
  })

  it('refuses to assign the open side once the game is under way', async () => {
    const gameId = await teamPageGame()
    const state = await scheduling(gameId, 103)
    await f.h.db
      .updateTable('games')
      .set({ status: 'inProgress' })
      .where('id', '=', gameId)
      .execute()
    expect(
      await refusal(
        await propose(
          103,
          { kind: 'team', id: f.standaloneTeam },
          intent(f.standaloneTeam, f.teamB),
          { gameId, expected: state.version }
        ),
        409
      )
    ).includes('Keep played games on their original teams')
  })

  it('swaps a game with an open side: the named team and the open side exchange', async () => {
    const gameId = await teamPageGame()
    const state = await scheduling(gameId, 103)
    const answer = await sent(
      await propose(
        103,
        { kind: 'team', id: f.standaloneTeam },
        intent(null, f.standaloneTeam),
        { gameId, expected: state.version }
      )
    )
    expect(answer).deep.include({ status: 'accepted', gameId })
    const row = await gameRow(gameId)
    expect([row.home_team_id, row.away_team_id]).deep.equals([
      null,
      f.standaloneTeam
    ])
  })

  it('asks the batch route only for the named sides it cannot speak for', async () => {
    await requireImmediateGameConsent(f.h.db, actor(103), [
      intent(f.standaloneTeam, null)
    ])
    let refused: unknown
    try {
      await requireImmediateGameConsent(f.h.db, actor(103), [
        intent(null, f.teamB)
      ])
    } catch (error) {
      refused = error
    }
    expect(String((refused as Error)?.message)).includes(
      'Additional approval is required'
    )
  })
})
