import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { pageOf } from '../../test/pageOf'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { cacheFileName, openCacheStore } from './cacheStore'
import { CachingClient } from './cachingClient'

const team = (id: string, name: string): Record<string, unknown> => ({
  id,
  name,
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null,
  kind: 'full',
  seasonCategory: 'inSeason'
})

describe('CachingClient.heldNames', function () {
  let dir: string
  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-held-names-'))
  })
  afterEach(function () {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A client whose server answers `bodies` until `offline` is set. */
  function clientOf(bodies: Record<string, unknown>): {
    client: CachingClient
    calls: string[]
    net: { offline: boolean }
  } {
    const calls: string[] = []
    const net = { offline: false }
    const fetch = (async (input: string) => {
      const url = new URL(input)
      const path = url.pathname.replace('/api/v1', '')
      calls.push(path)
      if (net.offline) throw new TypeError('Network request failed')
      const body = bodies[path + url.search] ?? bodies[path]
      return new Response(
        JSON.stringify(body ?? { error: 'notFound', message: 'Not found' }),
        { status: body == null ? 404 : 200 }
      )
    }) as unknown as typeof globalThis.fetch
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch,
      openCache: async (userId, apiBaseUrl) =>
        await openCacheStore(
          nodeSqliteExecutor(
            join(
              dir,
              cacheFileName(
                userId,
                new URL(apiBaseUrl, 'https://app.example.test').href
              )
            )
          )
        )
    })
    client.openFor('usr_1')
    return { client, calls, net }
  }

  it("names a game by its stored matchup and a team by the person's stored list, with no request", async function () {
    const { client, calls, net } = clientOf({
      '/teams': [team('t1', 'Hawks 12U')],
      '/games/g1': gameFixture
    })
    await client.teams()
    await client.game('g1')
    net.offline = true
    calls.length = 0
    const names = await client.heldNames([
      { kind: 'game', id: 'g1' },
      { kind: 'team', id: 't1' }
    ])
    expect(names).deep.equals({
      'game:g1': `${gameFixture.awayTeamName} @ ${gameFixture.homeTeamName}`,
      'team:t1': 'Hawks 12U'
    })
    expect(calls).deep.equals([])
  })

  it('names an opponent off the list by a held game it plays in, and leaves out what the phone cannot name', async function () {
    const { client } = clientOf({
      '/teams': [team('t1', 'Hawks 12U')],
      '/games/g1': gameFixture
    })
    await client.teams()
    await client.game('g1')
    const names = await client.heldNames([
      { kind: 'game', id: 'g1' },
      { kind: 'game', id: 'g2' },
      { kind: 'team', id: gameFixture.awayTeamId },
      { kind: 'team', id: 'nobody' }
    ])
    expect(names).deep.equals({
      'game:g1': `${gameFixture.awayTeamName} @ ${gameFixture.homeTeamName}`,
      [`team:${gameFixture.awayTeamId}`]: gameFixture.awayTeamName
    })
  })

  it('names an opponent no held game names by a game a stored schedule holds, and only by its own side', async function () {
    const listed = {
      id: 'g7',
      homeTeamId: 't1',
      awayTeamId: 'tem_rivals',
      homeTeamName: 'Hawks 12U',
      awayTeamName: 'Rivals',
      homeTeamExternal: false,
      awayTeamExternal: false,
      seasonId: null,
      startAt: '2026-11-22T18:00:00Z',
      venue: null,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      ingestStatus: 'none',
      videoCount: 0
    }
    const { client, calls, net } = clientOf({
      '/teams': [team('t1', 'Hawks 12U')],
      '/events?paged=1&when=upcoming': pageOf([listed], {}, { counts: null })
    })
    await client.teams()
    await client.gamesPage({ when: 'upcoming' })
    net.offline = true
    calls.length = 0
    expect(
      await client.heldNames([
        { kind: 'team', id: 'tem_rivals' },
        { kind: 'team', id: 'tem_unknown' }
      ])
    ).deep.equals({ 'team:tem_rivals': 'Rivals' })
    expect(calls).deep.equals([])
  })

  it('reads no team list when only games are held, and names nothing with nothing stored', async function () {
    const { client } = clientOf({})
    expect(await client.heldNames([{ kind: 'game', id: 'g1' }])).deep.equals({})
    expect(await client.heldNames([{ kind: 'team', id: 't1' }])).deep.equals({})
  })
})
