import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, describe, it } from 'mocha'

import type { Database } from '../db/database'
import { MAX_FIELDS, MAX_SELECTIONS } from '../graphql/schema'
import { errorHandler } from '../middleware/withErrors'
import { graphqlRoutes } from './graphql'

/**
 * The GraphQL route on its own, with a fake REST API behind it: what it does
 * when a read never answers, and when a route answers in a shape the schema
 * cannot take.
 */
describe('the GraphQL route', function () {
  const servers: Array<ReturnType<express.Express['listen']>> = []

  after(async function () {
    for (const server of servers)
      await new Promise(resolve => {
        server.close(resolve)
      })
  })

  const serve = async (
    fake: typeof fetch,
    deadlineMs?: number
  ): Promise<string> => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.actor = { userId: 'usr_1', isAdmin: false, scopes: [] }
      next()
    })
    app.use(
      '/api/v1',
      graphqlRoutes({
        // These cases read no stats, so nothing touches the database.
        db: {} as unknown as Kysely<Database>,
        origin: () => 'http://api.invalid',
        fetch: fake,
        deadlineMs
      })
    )
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise(resolve => server.once('listening', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/graphql`
  }

  const post = async (
    url: string,
    query: string
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query })
    })
    return { status: response.status, body: await response.json() }
  }

  it('ends a query at its deadline, and sends none of its later reads', async function () {
    const asked: string[] = []
    const url = await serve(async (input: unknown) => {
      asked.push(new URL(String(input)).pathname)
      await new Promise(resolve => setTimeout(resolve, 10_000))
      return Response.json([])
    }, 100)
    const started = Date.now()
    const answer = await post(
      url,
      `{ ${Array.from({ length: 12 }, (_, i) => `p${i}: player(id: "usr_${i}") { id }`).join(' ')} }`
    )
    expect(Date.now() - started).lessThan(2000)
    expect(answer.status).equals(200)
    expect(answer.body.errors[0].extensions.status).equals(504)
    expect(asked.length).at.most(8)
  })

  it('refuses a cyclic, aliased query long before it builds what it asks for', async function () {
    // A team with thirty games, each of whose home team is that team again.
    const url = await serve(async (input: unknown) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/teams/tem_1')
        return Response.json({ group: { name: 'Demo Hawks' } })
      if (path === '/api/v1/teams/tem_1/games')
        return Response.json(
          Array.from({ length: 30 }, (_, i) => ({ id: `gam_${i}` }))
        )
      return Response.json({ homeTeamId: 'tem_1', homeTeamName: 'Demo Hawks' })
    })
    const level = (next: string): string =>
      ['a', 'b', 'c']
        .map(alias => `${alias}: games { homeTeam { ${next} } }`)
        .join(' ')
    const started = Date.now()
    const answer = await post(
      url,
      `{ team(id: "tem_1") { ${level(level(level('id')))} } }`
    )
    expect(Date.now() - started).lessThan(5000)
    expect(answer.status).equals(400)
    expect(answer.body.errors).deep.equals([
      {
        message: `This query asks for more than ${MAX_FIELDS} fields. Ask for less`
      }
    ])
  })

  it('refuses an aliased introspection at validation, before it builds anything', async function () {
    const url = await serve(async () => Response.json([]))
    const aliases = (body: string): string =>
      Array.from({ length: 30 }, (_, i) => `a${i}: ${body}`).join(' ')
    const started = Date.now()
    const answer = await post(
      url,
      `{ __schema { ${aliases('types { ...N }')} } }
       fragment N on __Type { ${aliases('fields { type { ...M } }')} }
       fragment M on __Type { ${aliases('fields { type { name } }')} }`
    )
    expect(Date.now() - started).lessThan(1000)
    expect(answer.status).equals(400)
    expect(answer.body.errors[0].message).equals(
      `This query selects more than ${MAX_SELECTIONS} fields. Ask for less`
    )
    // One plain introspection is well inside it.
    const plain = await post(
      url,
      '{ __schema { types { name fields { name } } } }'
    )
    expect(plain.status).equals(200)
  })

  it('lists a team’s games from its schedule, leaving out its events and proposals', async function () {
    const asked: string[] = []
    const row = (i: number): Record<string, unknown> => ({
      id: `gam_${i}`,
      eventKind: 'game',
      pendingApproval: false,
      startAt: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T18:00:00.000Z`,
      homeTeamId: 'tem_1',
      homeTeamName: 'Demo Hawks',
      awayTeamId: 'tem_2',
      awayTeamName: 'Demo Eagles',
      homeScore: i,
      awayScore: 1,
      notes: 'Only members may read this'
    })
    const url = await serve(async (input: unknown) => {
      const path = new URL(String(input)).pathname
      asked.push(path)
      if (path === '/api/v1/teams/tem_1/games')
        return Response.json([
          ...Array.from({ length: 150 }, (_, i) => row(i)),
          { ...row(900), id: 'tev_practice', eventKind: 'event' },
          { ...row(901), id: 'pending:req_1', pendingApproval: true }
        ])
      return Response.json({ group: { name: 'Demo Hawks' }, notes: null })
    })
    const answer = await post(
      url,
      '{ team(id: "tem_1") { games { id startAt homeScore awayTeam { name } } } }'
    )
    expect(answer.status).equals(200)
    expect(answer.body.errors).equals(undefined)
    const games = answer.body.data.team.games as Array<{ id: string }>
    expect(games).to.have.length(150)
    expect(games.map(game => game.id)).not.includes('tev_practice')
    expect(games.map(game => game.id)).not.includes('pending:req_1')
    expect(games[3]).deep.equals({
      id: 'gam_3',
      startAt: '2026-04-04T18:00:00.000Z',
      homeScore: 3,
      awayTeam: { name: 'Demo Eagles' }
    })
    // The team and its schedule: no read a game.
    expect(asked).deep.equals([
      '/api/v1/teams/tem_1',
      '/api/v1/teams/tem_1/games'
    ])
    // Notes always come from the game route, never the schedule row.
    const notes = await post(url, '{ team(id: "tem_1") { games { notes } } }')
    expect(notes.body.data.team.games[0].notes).equals(null)
  })

  it('answers 200 with a refused root null and its sibling whole', async function () {
    const url = await serve(async (input: unknown) =>
      new URL(String(input)).pathname === '/api/v1/teams'
        ? Response.json(
            { code: 'forbidden', message: 'This API key cannot do that' },
            { status: 403 }
          )
        : Response.json([{ id: 'sea_1', name: 'Spring' }])
    )
    const answer = await post(url, '{ teams { id } seasons { id name } }')
    expect(answer.status).equals(200)
    expect(answer.body.data).deep.equals({
      teams: null,
      seasons: [{ id: 'sea_1', name: 'Spring' }]
    })
    expect(answer.body.errors[0]).deep.include({
      message: 'This API key cannot do that',
      path: ['teams'],
      extensions: { status: 403 }
    })
  })

  it('logs a route that answers in a shape the schema cannot take, and tells the caller less', async function () {
    const url = await serve(async () =>
      Response.json([{ id: 'sea_1', year: 'soon' }])
    )
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    }
    let answer
    try {
      answer = await post(url, '{ seasons { id year } }')
    } finally {
      console.error = original
    }
    expect(answer.status).equals(200)
    expect(answer.body.errors[0].message).equals('This field could not be read')
    expect(
      logged.some(line => line.startsWith('graphql: seasons.0.year:'))
    ).equals(true)
  })

  it('refuses a query whose variables are wrong, as the request’s fault', async function () {
    const url = await serve(async () => Response.json([]))
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query ($id: ID!) { team(id: $id) { id } }',
        variables: {}
      })
    })
    expect(response.status).equals(400)
  })
})
