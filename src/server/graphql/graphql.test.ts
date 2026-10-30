import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asApiKey } from '../../common/apiKeys'
import { userIdOfGumbo } from '../../common/userId'
import { type ApiFixture, apiFixture } from '../../test/apiFixture'
import { withdrawnKey } from '../games/withdrawn'
import { apiKeyRoutes } from '../routes/apiKeys'
import { graphqlRoutes, MAX_QUERY_LENGTH } from '../routes/graphql'
import type { BattingLine, PitchingLine } from '../stats'
import { boxScoreOrder, pitchingOrder } from '../stats/boxScoreOrder'
import { MAX_READS } from './restReader'
import { MAX_DEPTH } from './schema'

/**
 * The GraphQL API on the real REST routes, as `apiFixture`'s people.
 *
 * Alfonso Soriano (201) plays for Demo Hawks; Tim Raines (106) is his
 * guardian; Ichiro (104) coaches the Hawks; Juan Pierre (211) is their
 * songkeeper; Grant Hartwig (207) follows them and belongs to nothing; José
 * Alvarez (105) is a site administrator. Alfonso's line in the Comets' game
 * is for his side alone.
 */
interface Answer {
  status: number
  body: {
    data?: any
    errors?: Array<{
      message: string
      path?: string[]
      extensions?: { status?: number }
    }>
  }
  text: string
}

describe('the GraphQL API', function () {
  this.timeout(120000)

  let f: ApiFixture
  let origin = ''
  const alfonso = userIdOfGumbo(201)

  before(async function () {
    f = await apiFixture(undefined, undefined, (app, { db }) => {
      app.use('/api/v1', apiKeyRoutes(db, { sessionSecret: 'graphql-test' }))
      app.use('/api/v1', graphqlRoutes({ db, origin: () => origin }))
    })
    origin = f.h.origin
    await f.h.db
      .updateTable('games')
      .set({
        notes: 'Bring the blue jerseys',
        arrival_time_delta: 45,
        linescore: JSON.stringify({
          away: {
            runs: [0, 1, 2],
            r: 3,
            h: 7,
            e: 1,
            bb: 3,
            k: 5,
            hr: 1,
            hbp: 2
          },
          home: {
            runs: [2, 0, 4],
            r: 6,
            h: 8,
            e: 0,
            bb: 2,
            k: 4,
            hr: 1,
            hbp: 0
          }
        })
      })
      .where('id', '=', f.games[0].id)
      .execute()
  })

  after(async function () {
    await f?.h.close()
  })

  const ask = async (
    who: number | string | null,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<Answer> => {
    const response = await f.h.request(
      'POST',
      '/graphql',
      { query, ...(variables == null ? {} : { variables }) },
      who
    )
    const text = await response.text()
    return { status: response.status, body: JSON.parse(text), text }
  }

  const ROSTER = `query ($team: ID!) {
    team(id: $team) { roster { section player { id name fullName } } }
  }`

  describe('names', function () {
    const alfonsoOf = (
      answer: Answer
    ): { name: string; fullName: string | null } =>
      answer.body.data.team.roster.find(
        (entry: { player: { id: string } }) => entry.player.id === alfonso
      ).player

    for (const [who, person] of [
      ['a follower', 207],
      ['a songkeeper', 211]
    ] as const)
      it(`gives ${who} the short name, and the stored full name nowhere`, async function () {
        const answer = await ask(person, ROSTER, { team: f.teamA })
        expect(answer.status).equals(200)
        expect(alfonsoOf(answer)).deep.equals({
          id: alfonso,
          name: 'Alfonso S',
          fullName: null
        })
        expect(answer.text).not.includes('Soriano')
      })

    for (const [who, person] of [
      ['a coach of his team', 104],
      ['his guardian', 106],
      ['a site administrator', 105]
    ] as const)
      it(`gives ${who} the full name`, async function () {
        const answer = await ask(person, ROSTER, { team: f.teamA })
        expect(alfonsoOf(answer)).deep.include({
          name: 'Alfonso S',
          fullName: 'Alfonso Soriano'
        })
      })

    it('reads one player as the player route gives them, and not where it refuses', async function () {
      const query = `{ player(id: "${alfonso}") { id name fullName teams { team { id name } jersey } } }`
      const songkeeper = await ask(211, query)
      expect(songkeeper.body.data.player).deep.include({
        id: alfonso,
        name: 'Alfonso S',
        fullName: null
      })
      expect(songkeeper.body.data.player.teams[0]).deep.equals({
        team: { id: f.teamA, name: 'Demo Hawks' },
        jersey: '7'
      })
      expect(songkeeper.text).not.includes('Soriano')
      // The player route keeps a player's page from somebody outside his
      // teams, so the query does too.
      const follower = await ask(207, query)
      expect(follower.body.data.player).equals(null)
      expect(follower.body.errors?.[0].extensions?.status).equals(404)
    })
  })

  describe('teams', function () {
    it('gives the team fields the team routes give, and keeps a member’s figures from a non-member', async function () {
      const query = `query ($team: ID!) {
        team(id: $team) { id name timezone canViewPrivate nonMemberView batting { player { name } h } }
      }`
      const outside = await ask(207, query, { team: f.teamA })
      expect(outside.body.data.team).deep.include({
        id: f.teamA,
        name: 'Demo Hawks',
        canViewPrivate: false,
        nonMemberView: true,
        batting: null
      })
      expect(
        outside.body.errors?.map(({ message, path, extensions }) => ({
          message,
          path,
          extensions
        }))
      ).deep.equals([
        {
          message: 'You need to be a member of one of the teams to see this.',
          path: ['team', 'batting'],
          extensions: { status: 403 }
        }
      ])
      const inside = await ask(104, query, { team: f.teamA })
      expect(inside.body.errors).equals(undefined)
      expect(inside.body.data.team).deep.include({
        canViewPrivate: true,
        nonMemberView: false
      })
      expect(
        inside.body.data.team.batting
          .map((line: { h: number }) => line.h)
          .sort()
      ).deep.equals([2, 4])
    })

    it('gives a short name and a year only where a listing carried them, and says so', async function () {
      const answer = await ask(
        101,
        `{ team(id: "${f.teamA}") { shortName } seasons { id year } season(id: "${f.seasonA}") { year }
           shortName: __type(name: "Team") { fields { name description } }
           year: __type(name: "Season") { fields { name description } } }`
      )
      expect(answer.body.data.team.shortName).equals(null)
      expect(answer.body.data.season.year).equals(null)
      const listed = answer.body.data.seasons.find(
        (season: { id: string }) => season.id === f.seasonA
      )
      expect(listed.year).to.be.a('number')
      const described = (type: string, field: string): string =>
        answer.body.data[type].fields.find(
          (each: { name: string }) => each.name === field
        ).description
      expect(described('shortName', 'shortName')).includes('listing')
      expect(described('year', 'year')).includes('listing')
    })

    it('lists the caller’s teams as GET /teams does', async function () {
      const answer = await ask(
        104,
        '{ teams { id name record { wins losses } } }'
      )
      expect(
        answer.body.data.teams.map((team: { id: string }) => team.id)
      ).includes(f.teamA)
      const listed = (await (
        await f.h.request('GET', '/teams', undefined, 104)
      ).json()) as Array<{ id: string }>
      expect(
        answer.body.data.teams.map((team: { id: string }) => team.id)
      ).deep.equals(listed.map(team => team.id))
    })
  })

  describe('games', function () {
    const GAME = `query ($game: ID!) {
      game(id: $game) {
        id nonMemberView notes arrivalTimeDelta ingestMessage scoringOwner
        homeScore awayScore homeTeam { name } awayTeam { name }
        lineScore { home { runs r h e } away { runs r h } }
        boxScore { batting { player { name } ab h avg } pitching { player { name } ip era } }
      }
    }`

    it('gives a non-member the non-member view: runs, and none of the private fields or player lines', async function () {
      const answer = await ask(207, GAME, { game: f.games[0].id })
      const game = answer.body.data.game
      expect(game).deep.include({
        nonMemberView: true,
        notes: null,
        arrivalTimeDelta: null,
        ingestMessage: null,
        scoringOwner: null,
        homeScore: 6,
        awayScore: 3,
        boxScore: null
      })
      expect(game.lineScore.home).deep.equals({
        runs: [2, 0, 4],
        r: 6,
        h: null,
        e: null
      })
      expect(answer.body.errors?.map(error => error.path)).deep.equals([
        ['game', 'boxScore']
      ])
      expect(answer.body.errors?.[0].extensions?.status).equals(403)
      expect(answer.text).not.includes('Bring the blue jerseys')
    })

    it('gives a member of a side the full detail, with the box score’s player lines', async function () {
      const answer = await ask(104, GAME, { game: f.games[0].id })
      expect(answer.body.errors).equals(undefined)
      const game = answer.body.data.game
      expect(game).deep.include({
        nonMemberView: false,
        notes: 'Bring the blue jerseys',
        arrivalTimeDelta: 45
      })
      expect(game.lineScore.home.h).equals(8)
      expect(game.boxScore.batting).deep.include({
        player: { name: 'Alfonso S' },
        ab: 4,
        h: 3,
        avg: 0.75
      })
      expect(game.boxScore.pitching).deep.equals([
        { player: { name: 'Ben C' }, ip: '6.0', era: 2 }
      ])
    })

    it('reads a team’s games, each as the game route gives it', async function () {
      const answer = await ask(
        207,
        `query ($team: ID!) { team(id: $team) { games { id nonMemberView notes } } }`,
        { team: f.teamA }
      )
      expect(answer.body.data.team.games).to.have.length(2)
      for (const game of answer.body.data.team.games)
        expect(game).deep.include({ nonMemberView: true, notes: null })
    })
  })

  describe('stat lines', function () {
    const LINES = `query ($game: ID!) {
      game(id: $game) { statLines { player { id } batting { h hr } pitching { k } } }
    }`

    it('returns no line for a game the caller cannot open, and every line to a site administrator', async function () {
      const coach = await ask(104, LINES, { game: f.cometsGame })
      expect(coach.body.data.game.statLines).equals(null)
      expect(coach.body.errors?.[0].extensions?.status).equals(403)
      expect(coach.text).not.includes(alfonso)
      const admin = await ask(105, LINES, { game: f.cometsGame })
      expect(admin.body.errors).equals(undefined)
      expect(admin.body.data.game.statLines).deep.equals([
        { player: { id: alfonso }, batting: { h: 2, hr: 1 }, pitching: null }
      ])
    })

    it('puts batting and pitching on one line a player', async function () {
      const answer = await ask(104, LINES, { game: f.games[0].id })
      const ben = answer.body.data.game.statLines.find(
        (line: { player: { id: string } }) =>
          line.player.id === userIdOfGumbo(202)
      )
      expect(ben).deep.equals({
        player: { id: userIdOfGumbo(202) },
        batting: { h: 0, hr: 0 },
        pitching: { k: 7 }
      })
    })

    it('gives a withdrawn line its placeholder and no player', async function () {
      const { db } = f.h
      const game = f.games[0].id
      const row = await db
        .selectFrom('games')
        .select(['home_team_id', 'away_team_id'])
        .where('id', '=', game)
        .executeTakeFirstOrThrow()
      await db
        .insertInto('group_requests')
        .values({
          id: 'grq_graphql_withdrawn',
          kind: 'playerAdd',
          sender_id: userIdOfGumbo(202),
          sender_scope_type: 'team',
          sender_scope_id: row.home_team_id,
          terms: '{}',
          status: 'declined',
          sent_at: new Date(0),
          expires_at: new Date(1)
        })
        .execute()
      const lines = `query ($game: ID!) {
        game(id: $game) {
          statLines { player { id } batting { name h } pitching { name k } }
        }
      }`
      await db
        .insertInto('game_withdrawn_players')
        .values({
          game_id: game,
          user_id: userIdOfGumbo(202),
          side: 'home',
          request_id: 'grq_graphql_withdrawn',
          label: 'HWKS A'
        })
        .execute()
      try {
        const answer = await ask(104, lines, { game })
        expect(answer.body.errors).equals(undefined)
        const gone = answer.body.data.game.statLines.filter(
          (line: { player: unknown }) => line.player == null
        )
        expect(gone).has.length(1)
        expect(gone[0].pitching).deep.equals({ name: 'HWKS A', k: 7 })
        // Their own figures leave the game out.
        const own = `{ stats(perspective: PITCHING, filter: { playerId: "${userIdOfGumbo(202)}" }) { pa k } }`
        const figures = (await ask(104, own)).body.data.stats
        expect(figures.map((row: { k: number }) => row.k)).not.includes(7)
      } finally {
        await db
          .deleteFrom('group_requests')
          .where('id', '=', 'grq_graphql_withdrawn')
          .execute()
      }
    })

    it('counts a player’s games over the lines the caller may see', async function () {
      const query = `{ player(id: "${alfonso}") { stats { games batting { h hr avg } } } }`
      expect((await ask(104, query)).body.data.player.stats).deep.include({
        games: 2
      })
      expect((await ask(105, query)).body.data.player.stats).deep.equals({
        games: 3,
        batting: { h: 6, hr: 2, avg: 0.545 }
      })
    })
  })

  describe('stats from the database', function () {
    const STATS = `query ($filter: StatsFilter, $groupBy: [StatsGroup!], $perspective: StatsPerspective!, $orderBy: StatsOrder, $limit: Int) {
      stats(filter: $filter, groupBy: $groupBy, perspective: $perspective, orderBy: $orderBy, limit: $limit) {
        player { id name } team { id name } opponent { id name } season { id name }
        side outs runners firstPitch games pa ab h hr k rbi avg slg ops kRate
        firstPitchKnown firstPitchStrikeRate firstPitchBallRate whip ip outsMade
        pitches pitchedPa pitchesPerPa
      }
    }`
    const stats = async (
      who: number | string,
      variables: Record<string, unknown>
    ): Promise<Answer> =>
      await ask(who, STATS, { perspective: 'BATTING', ...variables })

    it('counts only the games the caller may open, and every game for a site administrator', async function () {
      const filter = { playerId: alfonso }
      const coach = await stats(104, { filter })
      expect(coach.body.errors).equals(undefined)
      expect(coach.body.data.stats).to.have.length(1)
      expect(coach.body.data.stats[0]).deep.include({
        games: 1,
        pa: 4,
        ab: 4,
        h: 3,
        hr: 1,
        avg: 0.75
      })
      const admin = await stats(105, { filter })
      expect(admin.body.data.stats[0]).deep.include({
        games: 2,
        pa: 7,
        h: 5,
        hr: 2
      })
      // His guardian sees every game of his, as on his stats page.
      const guardian = await stats(106, { filter })
      expect(guardian.body.data.stats[0]).deep.include({ games: 2, pa: 7 })
      // Nobody outside his teams sees a line of his.
      expect((await stats(207, { filter })).body.data.stats).deep.equals([])
    })

    it('splits by outs, by runners and by the first pitch', async function () {
      const filter = { playerId: alfonso }
      const byOuts = await stats(105, { filter, groupBy: ['OUTS'] })
      const outs = Object.fromEntries(
        (
          byOuts.body.data.stats as Array<{
            outs: number
            pa: number
            h: number
          }>
        ).map(line => [line.outs, [line.pa, line.h]])
      )
      expect(outs).deep.equals({ 0: [3, 2], 1: [2, 1], 2: [2, 2] })
      const risp = await stats(105, {
        filter: { ...filter, runners: 'SCORING_POSITION' }
      })
      expect(risp.body.data.stats[0]).deep.include({ pa: 2, h: 2, avg: 1 })
      const byRunners = await stats(105, { filter, groupBy: ['RUNNERS'] })
      expect(
        (byRunners.body.data.stats as Array<{ runners: string; pa: number }>)
          .map(line => `${line.runners}:${line.pa}`)
          .sort()
      ).deep.equals(['empty:4', 'first:1', 'scoringPosition:2'])
      const twoOuts = await stats(105, { filter: { ...filter, outs: [2] } })
      expect(twoOuts.body.data.stats[0]).deep.include({ pa: 2, h: 2, hr: 1 })
      const firstBall = await stats(105, {
        filter: { ...filter, firstPitch: 'BALL' }
      })
      expect(firstBall.body.data.stats[0]).deep.include({ pa: 3, h: 2, k: 1 })
    })

    it('splits by home and away, by opponent, by season and by dates', async function () {
      const filter = { playerId: alfonso }
      const byOpponent = await stats(105, {
        filter,
        groupBy: ['OPPONENT'],
        orderBy: 'PA'
      })
      expect(
        (
          byOpponent.body.data.stats as Array<{
            opponent: { id: string; name: string }
            pa: number
          }>
        ).map(line => [line.opponent.name, line.pa])
      ).deep.equals([
        ['Demo Eagles', 4],
        ['Demo Rookies', 3]
      ])
      const home = await stats(105, { filter: { ...filter, side: 'HOME' } })
      expect(home.body.data.stats[0]).deep.include({ pa: 7 })
      expect(
        (await stats(105, { filter: { ...filter, side: 'AWAY' } })).body.data
          .stats
      ).deep.equals([])
      const since = await stats(105, {
        filter: { ...filter, from: '2026-09-10T00:00:00Z' }
      })
      expect(since.body.data.stats[0]).deep.include({ pa: 4, games: 1 })
      const bySeason = await stats(105, { filter, groupBy: ['SEASON'] })
      expect(
        (bySeason.body.data.stats as Array<{ season: { id: string } }>)
          .map(line => line.season.id)
          .sort()
      ).deep.equals([f.playoffs, f.seasonA].sort())
      const team = await stats(105, {
        filter: { teamId: f.teamA },
        groupBy: ['PLAYER', 'TEAM']
      })
      expect(
        (
          team.body.data.stats as Array<{
            player: { id: string; name: string }
            team: { id: string; name: string }
            pa: number
            rbi: number
          }>
        ).map(line => [line.player.name, line.team.name, line.pa, line.rbi])
      ).deep.equals([
        ['Alfonso S', 'Demo Hawks', 4, 2],
        // Drew Ellis's only line is a run batted in pinch-hitting.
        ['Drew E', 'Demo Hawks', 0, 1]
      ])
      // A date alone would be UTC midnight, not the caller's: a time with
      // its offset is required.
      for (const from of ['yesterday', '2026-09-10', '2026-09-10T00:00:00']) {
        const bad = await stats(105, { filter: { from } })
        expect(bad.body.errors?.[0], from).deep.include({
          message:
            'from must be an ISO 8601 time with its offset, as 2026-05-01T00:00:00-07:00'
        })
      }
      const local = await stats(105, {
        filter: { ...filter, from: '2026-09-09T17:00:00-07:00' }
      })
      expect(local.body.data.stats[0]).deep.include({ pa: 4, games: 1 })
      const outs = await stats(105, { filter: { outs: [100000] } })
      expect(outs.body.errors?.[0]).deep.include({
        message: 'outs must be 0, 1 or 2'
      })
    })

    it('gives a pitcher how often he starts a batter with a strike, or a ball', async function () {
      const ben = await stats(104, {
        perspective: 'PITCHING',
        filter: { playerId: userIdOfGumbo(202) },
        groupBy: ['PLAYER']
      })
      expect(ben.body.errors).equals(undefined)
      expect(ben.body.data.stats[0]).deep.include({
        player: { id: userIdOfGumbo(202), name: 'Ben C' },
        pa: 3,
        k: 2,
        outsMade: 3,
        ip: '1.0',
        // He threw the first pitch of two of them, and 8 pitches to his 3
        // batters.
        firstPitchKnown: 2,
        firstPitchStrikeRate: 0.5,
        firstPitchBallRate: 0.5,
        kRate: 0.667,
        pitches: 8,
        pitchedPa: 3,
        pitchesPerPa: 2.667
      })
      // A reliever who only picked a runner off still has his line: his out.
      const relief = await stats(104, {
        perspective: 'PITCHING',
        filter: { teamId: f.teamA },
        groupBy: ['PLAYER']
      })
      expect(
        (
          relief.body.data.stats as Array<{
            player: { name: string }
            pa: number
            outsMade: number
            ip: string
          }>
        ).map(line => [line.player.name, line.pa, line.outsMade, line.ip])
      ).deep.equals([
        ['Ben C', 3, 3, '1.0'],
        ['Cody D', 0, 1, '0.1']
      ])
    })

    it('orders, limits, and keeps to its bounds', async function () {
      const leaders = await stats(105, {
        groupBy: ['PLAYER'],
        orderBy: 'HR',
        limit: 1
      })
      expect(leaders.body.data.stats).to.have.length(1)
      expect(leaders.body.data.stats[0].player.id).equals(alfonso)
      // Without an order, the most plate appearances first, the same way
      // every time.
      const byGame = await stats(105, { groupBy: ['GAME', 'PLAYER'] })
      const again = await stats(105, { groupBy: ['GAME', 'PLAYER'] })
      expect(byGame.body.data.stats).deep.equals(again.body.data.stats)
      const pas = (byGame.body.data.stats as Array<{ pa: number }>).map(
        line => line.pa
      )
      expect(pas).deep.equals([...pas].sort((a, b) => b - a))
      expect((await ask(105, '{ stats(limit: null) { pa } }')).status).equals(
        400
      )
      // Not split by player, a count is ordered and cut in SQL.
      const top = await stats(105, {
        groupBy: ['GAME', 'OUTS'],
        orderBy: 'PA',
        limit: 2
      })
      expect(
        (top.body.data.stats as Array<{ pa: number }>).map(line => line.pa)
      ).deep.equals([3, 2])
      expect(
        (await stats(105, { filter: { firstPitch: 'OTHER' } })).body.data.stats
      ).deep.equals([])
      const aliased = await ask(
        105,
        `{ ${['a', 'b', 'c', 'd'].map(alias => `${alias}: stats { pa }`).join(' ')} }`
      )
      expect(aliased.status).equals(400)
      expect(aliased.body.errors?.[0].message).equals(
        'A query may ask for stats at most 3 times'
      )
      // A pinch hitter's run batted in on another's strikeout is his.
      const drew = await stats(104, {
        filter: { playerId: userIdOfGumbo(204) }
      })
      expect(drew.body.data.stats[0]).deep.include({ pa: 0, rbi: 1 })
      const tooMany = await stats(105, { limit: 5000 })
      expect(tooMany.body.errors?.[0].message).equals('limit is 1 to 1000')
    })

    it('needs game events read on an API key', async function () {
      const made = async (permissions: string[]): Promise<string> => {
        await f.h.resetLimits()
        const response = await f.h.request(
          'POST',
          '/me/api-keys',
          { name: 'Stats', permissions },
          105
        )
        return asApiKey(await response.json()).secret ?? ''
      }
      const refused = await stats(await made(['team:read']), {
        filter: { playerId: alfonso }
      })
      expect(refused.body.errors?.[0]).deep.include({
        message: 'This API key cannot do that',
        extensions: { status: 403 }
      })
      const allowed = await stats(await made(['gameEvents:read']), {
        filter: { playerId: alfonso }
      })
      expect(allowed.body.data.stats[0]).deep.include({ pa: 7 })
    })
  })

  describe('what it cannot do', function () {
    it('has no mutation, and refuses one', async function () {
      const schema = await ask(
        207,
        '{ __schema { mutationType { name } subscriptionType { name } } }'
      )
      expect(schema.body.data.__schema).deep.equals({
        mutationType: null,
        subscriptionType: null
      })
      const write = await ask(207, 'mutation { teams { id } }')
      expect(write.status).equals(400)
    })

    it('has no account, session, token, settings or stats builder type or field', async function () {
      const answer = await ask(
        207,
        '{ __schema { types { name fields { name } } } }'
      )
      const names = (
        answer.body.data.__schema.types as Array<{
          name: string
          fields: Array<{ name: string }> | null
        }>
      )
        .filter(type => !type.name.startsWith('__'))
        .flatMap(type => [
          type.name,
          ...(type.fields ?? []).map(field => `${type.name}.${field.name}`)
        ])
      expect(
        names.filter(name =>
          /account|session|token|setting|builder|email|password|\.stats?$/i.test(
            name
          )
        )
      ).deep.equals(['Query.stats', 'Player.stats'])
      const asked = await ask(207, '{ account { id } }')
      expect(asked.status).equals(400)
    })

    it('writes no audit row', async function () {
      await ask(104, '{ teams { id } }')
      await new Promise(resolve => setTimeout(resolve, 100))
      const rows = await f.h.db
        .selectFrom('audit_log')
        .select('id')
        .where('path', '=', '/api/v1/graphql')
        .execute()
      expect(rows).deep.equals([])
    })

    it('refuses a query that is too long, too deep or reads too much, and one that does not parse', async function () {
      const long = await ask(
        207,
        `{ teams { id } }${' '.repeat(MAX_QUERY_LENGTH)}`
      )
      expect(long.status).equals(400)
      const tooDeep = await ask(
        207,
        `{ season(id: "${f.seasonA}") { teams { games { homeTeam { games { awayTeam { games { homeTeam { games { awayTeam { games { id } } } } } } } } } } } }`
      )
      expect(tooDeep.status).equals(400)
      expect(tooDeep.body.errors?.[0].message).includes(`${MAX_DEPTH} levels`)
      // Fragments count where they are spread, and a fragment spread inside
      // itself is counted once.
      const throughFragments = await ask(
        207,
        `fragment Side on Team { games { homeTeam { games { awayTeam { games { homeTeam { games { awayTeam { id } } } } } } } } }
        { season(id: "${f.seasonA}") { teams { ...Side ... on Team { id } } } }`
      )
      expect(throughFragments.status).equals(400)
      expect(throughFragments.body.errors?.[0].message).includes('levels')
      // A chain of fragments, each spreading the next twice, is measured in
      // the time of its length, not of two to its length.
      const chain = Array.from(
        { length: 25 },
        (_, i) =>
          `fragment F${i} on Query { seasons { id } ${i < 24 ? `...F${i + 1} ...F${i + 1}` : ''} }`
      ).join(' ')
      const started = Date.now()
      const doubled = await ask(207, `query { ...F0 } ${chain}`)
      expect(doubled.status).equals(400)
      expect(doubled.body.errors?.[0].message).includes('fields. Ask for less')
      expect(Date.now() - started).lessThan(2000)
      const wide = await ask(
        207,
        `{ ${Array.from(
          { length: MAX_READS + 1 },
          (_, i) => `p${i}: player(id: "${userIdOfGumbo(1000 + i)}") { id }`
        ).join(' ')} }`
      )
      expect(
        wide.body.errors?.some(error => error.message.includes('Ask for less'))
      ).equals(true)
      expect((await ask(207, '{ teams { id ')).status).equals(400)
      // A dot is no id: a URL would read another route with it.
      for (const dots of ['.', '..']) {
        const odd = await ask(207, `{ team(id: "${dots}") { name } }`)
        expect(odd.body.data.team).equals(null)
        expect(odd.body.errors?.[0]).deep.include({
          message: `${dots} is not an id`
        })
      }
      expect((await ask(null, '{ teams { id } }')).status).equals(401)
    })
  })

  describe('with an API key', function () {
    it('reads a player’s name and full name with game events read', async function () {
      const made = await f.h.request(
        'POST',
        '/me/api-keys',
        { name: 'Roster reader', permissions: ['gameEvents:read'] },
        104
      )
      const key = asApiKey(await made.json()).secret ?? ''
      const answer = await ask(
        key,
        `{ player(id: "${alfonso}") { name fullName } }`
      )
      expect(answer.body.errors).equals(undefined)
      expect(answer.body.data.player).deep.equals({
        name: 'Alfonso S',
        fullName: 'Alfonso Soriano'
      })
    })

    it('reads each field only with that field’s family', async function () {
      const made = await f.h.request(
        'POST',
        '/me/api-keys',
        { name: 'Team reader', permissions: ['team:read'] },
        104
      )
      const key = asApiKey(await made.json()).secret ?? ''
      const answer = await ask(
        key,
        `query ($team: ID!) { team(id: $team) { name games { id } } }`,
        { team: f.teamA }
      )
      expect(answer.body.data.team.name).equals('Demo Hawks')
      expect(answer.body.data.team.games).equals(null)
      expect(answer.body.errors?.[0]).deep.include({
        message: 'This API key cannot do that',
        path: ['team', 'games'],
        extensions: { status: 403 }
      })
    })
  })
})
