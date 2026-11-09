import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { SeasonGame } from '../../common/api'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { listProps } from '../../test/PagedListStandIn'
import { pageOf } from '../../test/pageOf'
import { cacheFileName, openCacheStore } from '../sync/cacheStore'
import { CachingClient } from '../sync/cachingClient'
import { ThemeProvider } from '../theme/ThemeContext'
import { GamesFeedScreen } from './GamesFeedScreen'
import type { When } from './whenFilter'

const game = (
  id: string,
  startAt: string,
  patch: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  homeTeamId: 'tem_sox',
  awayTeamId: 'tem_badgers',
  homeTeamName: 'Sox',
  awayTeamName: 'Badgers',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: 'sea_spring',
  startAt,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'none',
  videoCount: 0,
  ...patch
})

const UPCOMING = Array.from({ length: 10 }, (_, n) =>
  game(`u${n}`, `2026-11-${String(n + 10)}T18:00:00Z`)
)
const PAST = [
  game('p1', '2026-10-01T18:00:00Z', {
    status: 'final',
    homeScore: 2,
    awayScore: 1
  })
]

/**
 * The server: each pill's page, with every answer held until `release` while
 * `gate` is set, and none at all while `offline`.
 */
function schedule(): {
  fetch: typeof fetch
  calls: string[]
  offline: boolean
  gate: Promise<void> | undefined
  routes: Record<string, unknown>
} {
  const routes: Record<string, unknown> = {
    '/events?paged=1&when=upcoming': pageOf(UPCOMING),
    '/events?paged=1&when=past': pageOf(PAST)
  }
  const state = {
    calls: [] as string[],
    offline: false,
    gate: undefined as Promise<void> | undefined,
    routes,
    fetch: (async (url: unknown) => {
      const path = String(url).replace('http://x/api/v1', '')
      state.calls.push(path)
      if (state.gate != null) await state.gate
      if (state.offline) throw new TypeError('Load failed')
      const body = state.routes[path]
      return new Response(
        JSON.stringify(body ?? { code: 'notFound', message: 'Not found' }),
        { status: body == null ? 404 : 200 }
      )
    }) as unknown as typeof fetch
  }
  return state
}

const rows = (): SeasonGame[] => listProps().data as unknown as SeasonGame[]

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

describe('Schedule’s pills with games the phone stored', function () {
  let dir: string
  let executors: Array<ReturnType<typeof nodeSqliteExecutor>>
  let root: Root | undefined
  let host: HTMLElement | undefined

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-tabs-'))
    executors = []
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    host = undefined
    for (const executor of executors) await executor.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function phone(net: ReturnType<typeof schedule>): CachingClient {
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      fetch: net.fetch,
      openCache: async userId => {
        const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
        executors.push(executor)
        return await openCacheStore(executor)
      }
    })
    client.openFor('usr_1')
    return client
  }

  async function draw(client: CachingClient, when: When): Promise<void> {
    host ??= document.body.appendChild(document.createElement('div'))
    root ??= createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GamesFeedScreen
            client={client}
            mode="schedule"
            initialWhen={when}
            onOpenGame={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await settle()
  }

  const errorShown = (): boolean =>
    [...(host?.querySelectorAll('div') ?? [])].some(
      node =>
        node.childElementCount === 0 &&
        /Cannot|connection|offline/i.test(node.textContent ?? '')
    )

  it('paints Upcoming’s ten stored games, then the answer, with the score that changed since', async function () {
    const net = schedule()
    const client = phone(net)
    await client.gamesPage({ when: 'upcoming' })
    net.calls.length = 0
    // The game was played since: the server says so, held for now.
    net.routes['/events?paged=1&when=upcoming'] = pageOf([
      { ...UPCOMING[0], status: 'final', homeScore: 5, awayScore: 3 },
      ...UPCOMING.slice(1)
    ])
    let release!: () => void
    net.gate = new Promise(resolve => {
      release = resolve
    })
    await draw(client, 'upcoming')
    expect(rows().map(row => row.id)).deep.equals(UPCOMING.map(row => row.id))
    expect(rows()[0]?.homeScore).equals(null)
    // The screen's own read still goes out, and only it.
    expect(net.calls).deep.equals(['/events?paged=1&when=upcoming'])
    await act(async () => {
      net.gate = undefined
      release()
    })
    await settle()
    expect(rows()[0]).deep.include({ status: 'final', homeScore: 5 })
    expect(rows()).length(10)
  })

  it('paints Past from its stored games and then its own answer, and neither pill shows the page error offline', async function () {
    const net = schedule()
    const client = phone(net)
    await client.gamesPage({ when: 'upcoming' })
    await client.gamesPage({ when: 'past' })
    net.routes['/events?paged=1&when=past'] = pageOf([
      ...PAST,
      game('p0', '2026-09-01T18:00:00Z', { status: 'final' })
    ])
    net.calls.length = 0
    await draw(client, 'past')
    expect(net.calls).deep.equals(['/events?paged=1&when=past'])
    expect(rows().map(row => row.id)).deep.equals(['p1', 'p0'])

    // No signal: each pill keeps what it stored, and says nothing failed.
    net.offline = true
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await draw(client, 'past')
    expect(rows().map(row => row.id)).deep.equals(['p1', 'p0'])
    expect(errorShown()).equals(false)
    await draw(client, 'upcoming')
    expect(rows()).length(10)
    expect(errorShown()).equals(false)
    // All was never read: what Upcoming and Past stored, with no error.
    await draw(client, 'all')
    expect(rows()).length(12)
    expect(errorShown()).equals(false)
  })
})
