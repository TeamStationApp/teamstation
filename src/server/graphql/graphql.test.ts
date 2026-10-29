import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asApiKey } from '../../common/apiKeys'
import { userIdOfGumbo } from '../../common/userId'
import { type ApiFixture, apiFixture } from '../../test/apiFixture'
import { apiKeyRoutes } from '../routes/apiKeys'
import { graphqlRoutes, MAX_QUERY_LENGTH } from '../routes/graphql'
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
      app.use('/api/v1', graphqlRoutes({ origin: () => origin }))
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
      ).deep.equals(['Player.stats'])
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
