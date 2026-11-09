import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ScoringSession } from '../../common/scoring/session'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { scoringSession } from '../../test/scoringSession'
import { cacheFileName, openCacheStore } from '../sync/cacheStore'
import { CachingClient } from '../sync/cachingClient'
import { fieldServer, memoryStorage } from '../sync/offlineScoring.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { ScoringScreen } from './ScoringScreen'
import { memoryStore, ServerScoringSource } from './scoringSource'
import { ServerClock } from './serverClock'

// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext

async function settle(ms = 50): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

/**
 * Scoring a game the phone never read ahead for: what its screen read once
 * with signal is what it opens with when every request fails to leave.
 */
describe('scoring opened again with no signal', function () {
  let dir: string
  let executors: Array<ReturnType<typeof nodeSqliteExecutor>>
  let root: Root | undefined

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-open-'))
    executors = []
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  })
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.replaceChildren()
    HTMLCanvasElement.prototype.getContext = getContext
    for (const executor of executors) await executor.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function open(client: CachingClient): Promise<void> {
    await act(async () => {
      root?.unmount()
    })
    document.body.replaceChildren()
    const source = new ServerScoringSource(
      client,
      new ServerClock(async () => await client.serverTime(), memoryStorage())
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScoringScreen
            client={client}
            gameId="g1"
            userId="usr_scorer"
            source={source}
            onExit={() => undefined}
          />
        </ThemeProvider>
      )
    })
    await settle()
  }

  it('opens from the stored game, default lineups, plays and rosters when those requests fail offline', async function () {
    const started = memoryStore()
    const first = ScoringSession.start(
      started,
      'g1',
      scoringSession(gameFixture)
    )
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    const net = fieldServer(started.games.get('g1')!)
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      token: 'token-1',
      fetch: net.fetch,
      openCache: async userId => {
        const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
        executors.push(executor)
        return await openCacheStore(executor)
      },
      outbox: { setTimer: () => 0, clearTimer: () => undefined }
    })
    client.openFor('usr_scorer')
    // With signal, and no read ahead: only what the screen asks for.
    await open(client)
    expect(document.body.textContent).includes('1 balls')
    const keys = (
      executors
        .at(-1)!
        .db.prepare('SELECT key FROM documents ORDER BY key')
        .all() as Array<{ key: string }>
    ).map(row => row.key)
    // The plays carry the lineups; the sides' default lineups open them.
    for (const key of [
      'game.g1',
      'events.g1',
      'me.roles',
      'roster.full.away',
      'roster.full.home',
      'defaultLineup.away',
      'defaultLineup.home'
    ])
      expect(keys, `${key} in ${keys.join(',')}`).includes(key)

    net.offline = true
    await open(client)
    expect(client.offline).equals(true)
    expect(document.body.textContent).includes('Owls 0 · Hawks 0')
    expect(document.body.textContent).includes('1 balls')
  })
})
