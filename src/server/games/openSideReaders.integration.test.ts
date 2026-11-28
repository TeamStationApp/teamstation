import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client } from 'pg'

import { makeId } from '../../common/ids'
import { OPEN_SIDE_NAME } from '../../common/openSides'
import { userIdOfGumbo } from '../../common/userId'
import { testDatabaseUrlOf } from '../../migrate/testDatabase'
import { actor, type GroupFixture } from '../../test/groupFixtures'
import { umpireFixture } from '../../test/umpireFixture'
import { adminScopes, canSeeGame, visibleScopes } from '../access'
import { mergeTeams } from '../admin/mergeTeams'
import { mayRunGame, runGamesQuery } from '../director/runGames'
import { publicGames } from '../groups/publicSummary'
import { followRoutes } from '../routes/follows'
import { graphqlRoutes } from '../routes/graphql'
import { schedule as umpireSchedule } from '../umpires/schedule'

/**
 * A game's side may be open (a null team): every reader of a game's teams
 * answers it, names the open side TBD with the id `''`, and lists only the
 * named teams. No route makes such a game yet, so the games are inserted.
 */
describe('readers of a game with an open side', function () {
  this.timeout(120000)
  let f: GroupFixture
  let origin = ''
  /** Demo Hawks at home, the away side open. */
  let openAway: string
  /** A Demo Regular game with both sides open. */
  let bothOpen: string

  before(async function () {
    f = await umpireFixture({}, (app, { db, media }) => {
      app.use('/api/v1', followRoutes(db, media))
      app.use('/api/v1', graphqlRoutes({ db, origin: () => origin }))
    })
    origin = f.h.origin
    // As every open-sides suite: the season's roles reach its teams through
    // `season_team_parents`.
    await f.h.db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
      .execute()
    openAway = makeId('game')
    bothOpen = makeId('game')
    await f.h.db
      .insertInto('games')
      .values([
        {
          id: openAway,
          home_team_id: f.teamA,
          away_team_id: null,
          season_id: f.seasonA,
          start_at: new Date('2027-04-10T18:00:00Z'),
          end_at: new Date('2027-04-10T20:00:00Z'),
          timezone: 'America/Los_Angeles',
          venue: 'Demo Field'
        },
        {
          id: bothOpen,
          home_team_id: null,
          away_team_id: null,
          season_id: f.seasonA,
          start_at: new Date('2027-04-11T18:00:00Z'),
          end_at: new Date('2027-04-11T20:00:00Z'),
          timezone: 'America/Los_Angeles',
          venue: 'Demo Field'
        }
      ])
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })

  const get = async (path: string, user = 101): Promise<any> => {
    const response = await f.h.request('GET', path, undefined, user)
    expect(response.status, path).equals(200)
    return await response.json()
  }
  const rowOf = (rows: any[], id: string): any =>
    rows.find((row: any) => row.id === id)

  it("lists the game on its named team's schedule, the open side TBD with the id ''", async () => {
    const rows = await get(`/teams/${f.teamA}/games`)
    expect(rowOf(rows, openAway)).deep.include({
      homeTeamId: f.teamA,
      homeTeamName: 'Demo Hawks',
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME,
      awayTeamExternal: true,
      awayLogoUrl: null
    })
    // An open side is no team: the both-open game is on no team's list.
    expect(rowOf(rows, bothOpen)).equals(undefined)
    const page = await get(`/teams/${f.teamA}/games?paged=1`)
    expect(rowOf(page.items, openAway)).deep.include({
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME
    })
  })

  it('lists both on the event list and the season schedule', async () => {
    const events = await get(`/events?season=${f.seasonA}`)
    expect(rowOf(events, openAway)).deep.include({
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME
    })
    expect(rowOf(events, bothOpen)).deep.include({
      homeTeamId: '',
      homeTeamName: OPEN_SIDE_NAME,
      homeTeamExternal: true,
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME
    })
    const season = await publicGames(
      f.h.db,
      { kind: 'season', id: f.seasonA },
      actor(101)
    )
    expect(rowOf(season, bothOpen)).deep.include({
      homeTeam: { id: '', name: OPEN_SIDE_NAME },
      awayTeam: { id: '', name: OPEN_SIDE_NAME },
      homeTeamExternal: true,
      awayTeamExternal: true
    })
    expect(rowOf(season, openAway)).deep.include({
      homeTeam: { id: f.teamA, name: 'Demo Hawks' },
      awayTeam: { id: '', name: OPEN_SIDE_NAME }
    })
  })

  it("answers the game's page and event page with TBD and no team", async () => {
    const game = await get(`/games/${openAway}`)
    expect(game).deep.include({
      homeTeamId: f.teamA,
      homeTeamName: 'Demo Hawks',
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME,
      awayRecord: null,
      awayLogoUrl: null,
      nonMemberView: false,
      canScore: true
    })
    expect(game.assignedRoles.away).deep.equals([])
    expect(game.coachSides).deep.equals(['home'])
    const both = await get(`/games/${bothOpen}`)
    expect(both).deep.include({
      homeTeamId: '',
      awayTeamId: '',
      homeTeamName: OPEN_SIDE_NAME,
      awayTeamName: OPEN_SIDE_NAME,
      canScore: false,
      canDj: false
    })
    expect(both.coachSides).deep.equals([])
    expect(both.assignedRoles).deep.equals({ away: [], home: [] })

    const info = await get(`/events/${openAway}/info`)
    expect(info).deep.include({
      teamId: f.teamA,
      teamName: 'Demo Hawks',
      canManage: true
    })
    expect(info.attendanceTeams.map((team: any) => team.id)).deep.equals([
      f.teamA
    ])
    const bothInfo = await get(`/events/${bothOpen}/info`)
    expect(bothInfo).deep.include({
      teamId: '',
      teamName: OPEN_SIDE_NAME,
      // Its season's administrator schedules it.
      canManage: true,
      attendanceTeams: []
    })
  })

  it("names the open side on follows, GraphQL, the umpire schedule and the director's games", async () => {
    const follows = await get(`/teams/${f.teamA}/schedule`)
    expect(follows.find((row: any) => row.gameId === openAway)).deep.include({
      homeTeam: { id: f.teamA, name: 'Demo Hawks' },
      awayTeam: { id: '', name: OPEN_SIDE_NAME }
    })

    const graph = await f.h.request(
      'POST',
      '/graphql',
      {
        query: `query ($game: ID!, $both: ID!) {
          game(id: $game) { id homeTeam { id name } awayTeam { id name } }
          both: game(id: $both) { id homeTeam { id } awayTeam { id } }
        }`,
        variables: { game: openAway, both: bothOpen }
      },
      101
    )
    const answer = await graph.json()
    expect(answer.errors).equals(undefined)
    expect(answer.data.game).deep.equals({
      id: openAway,
      homeTeam: { id: f.teamA, name: 'Demo Hawks' },
      awayTeam: null
    })
    expect(answer.data.both).deep.equals({
      id: bothOpen,
      homeTeam: null,
      awayTeam: null
    })

    const umpires = await umpireSchedule(
      f.h.db,
      actor(101),
      f.leagueA,
      'league',
      {}
    )
    const umpired = umpires.games.find(game => game.id === openAway)
    expect(umpired).deep.include({
      home: 'Demo Hawks',
      away: OPEN_SIDE_NAME,
      homeTeamId: f.teamA,
      awayTeamId: ''
    })
    expect(umpires.games.find(game => game.id === bothOpen)).deep.include({
      home: OPEN_SIDE_NAME,
      away: OPEN_SIDE_NAME,
      homeTeamId: '',
      awayTeamId: ''
    })

    const film = await get('/events?scope=film')
    expect(rowOf(film, openAway)).deep.include({
      awayTeamId: '',
      awayTeamName: OPEN_SIDE_NAME
    })
    const scopes = await adminScopes(f.h.db, userIdOfGumbo(105), true)
    const run = await runGamesQuery(f.h.db, scopes)!
      .where('games.id', 'in', [openAway, bothOpen])
      .orderBy('games.start_at')
      .execute()
    expect(
      run.map(row => [row.homeTeamName, row.awayTeamName, row.awayTeamId])
    ).deep.equals([
      ['Demo Hawks', OPEN_SIDE_NAME, ''],
      [OPEN_SIDE_NAME, OPEN_SIDE_NAME, '']
    ])
    const hawks = await adminScopes(f.h.db, userIdOfGumbo(101), false)
    expect(mayRunGame(hawks, { homeTeamId: f.teamA, awayTeamId: null })).equals(
      true
    )
    expect(mayRunGame(hawks, { homeTeamId: null, awayTeamId: null })).equals(
      false
    )
  })

  it("lets the named team's people and the season's see it, and nobody else", async () => {
    const sees = async (user: number, game: string): Promise<boolean> => {
      const row = await f.h.db
        .selectFrom('games')
        .select([
          'home_team_id as homeTeamId',
          'away_team_id as awayTeamId',
          'season_id as seasonId'
        ])
        .where('id', '=', game)
        .executeTakeFirstOrThrow()
      return canSeeGame(
        await visibleScopes(f.h.db, userIdOfGumbo(user), false),
        row
      )
    }
    // 101 administers the Hawks and their season; 104 plays for the Hawks;
    // 102 and 103 have nothing to do with either.
    expect(await sees(101, openAway)).equals(true)
    expect(await sees(104, openAway)).equals(true)
    expect(await sees(102, openAway)).equals(false)
    expect(await sees(103, openAway)).equals(false)
    expect(await sees(101, bothOpen)).equals(true)
    expect(await sees(102, bothOpen)).equals(false)
    expect(await sees(103, bothOpen)).equals(false)
    expect((await get(`/games/${openAway}`, 102)).nonMemberView).equals(true)
  })

  it('tells the offline set of the named teams only', async () => {
    const [{ name }] = (
      await sql<{ name: string }>`select current_database() as name`.execute(
        f.h.db
      )
    ).rows
    const client = new Client({ connectionString: testDatabaseUrlOf(name) })
    await client.connect()
    try {
      const heard: unknown[] = []
      client.on('notification', message => {
        const payload = JSON.parse(message.payload ?? '{}')
        if (payload.t === 'offlineSet') heard.push(payload.g)
      })
      await client.query('listen user_notices')
      const id = makeId('game')
      await f.h.db
        .insertInto('games')
        .values({
          id,
          home_team_id: null,
          away_team_id: f.teamA,
          season_id: f.seasonA,
          start_at: new Date('2027-04-12T18:00:00Z')
        })
        .execute()
      await f.h.db
        .updateTable('games')
        .set({ away_team_id: null })
        .where('id', '=', id)
        .execute()
      await f.h.db.deleteFrom('games').where('id', '=', id).execute()
      const deadline = Date.now() + 5000
      while (heard.length < 3 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20))
      expect(heard).deep.equals([[f.teamA], [f.teamA], []])
    } finally {
      await client.end()
    }
  })

  it('keeps a held open side open when the schedule importer matches the game', async () => {
    await f.h.db
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'game',
        entity_id: openAway,
        system: 'otherLeague',
        kind: 'game',
        external_id: 'open-away-1'
      })
      .execute()
    const response = await f.h.request(
      'POST',
      `/teams/${f.teamA}/games`,
      {
        games: [
          {
            opponent: { name: 'Demo Dunlins' },
            side: 'away',
            seasonId: f.seasonA,
            startAt: '2027-04-10T19:00:00Z',
            externalId: {
              system: 'otherLeague',
              kind: 'game',
              id: 'open-away-1'
            }
          }
        ]
      },
      101
    )
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).equals(200)
    expect(body.results[0]).deep.include({ gameId: openAway })
    const game = await f.h.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'start_at'])
      .where('id', '=', openAway)
      .executeTakeFirstOrThrow()
    // The time is the row's; the sides are as they were.
    expect(game).deep.equals({
      home_team_id: f.teamA,
      away_team_id: null,
      start_at: new Date('2027-04-10T19:00:00Z')
    })
    expect(
      await f.h.db
        .selectFrom('teams')
        .select('id')
        .where('name', '=', 'Demo Dunlins')
        .execute()
    ).deep.equals([])
  })

  it('moves the named team in a merge and leaves the open side open', async () => {
    const from = makeId('team')
    const into = makeId('team')
    await f.h.db
      .insertInto('teams')
      .values([
        { id: from, name: 'Demo Merged Away' },
        { id: into, name: 'Demo Kept' }
      ])
      .execute()
    const games = [makeId('game'), makeId('game')]
    // Two games at one minute against an open side are two fixtures.
    await f.h.db
      .insertInto('games')
      .values(
        games.map(id => ({
          id,
          home_team_id: from,
          away_team_id: null,
          start_at: new Date('2027-04-13T18:00:00Z')
        }))
      )
      .execute()
    // The kept team has an administrator, as a merge requires.
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(101),
        scope_type: 'team',
        scope_id: into,
        role: 'admin',
        granted_by: userIdOfGumbo(101)
      })
      .execute()
    const report = await mergeTeams(f.h.db, {
      fromTeamId: from,
      intoTeamId: into,
      apply: true
    })
    expect(report.fixtures).deep.equals([])
    const rows = await f.h.db
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id'])
      .where('id', 'in', games)
      .execute()
    expect(rows).deep.equals([
      { home_team_id: into, away_team_id: null },
      { home_team_id: into, away_team_id: null }
    ])
  })
})
