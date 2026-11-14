import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ScoringSession } from '../../common/scoring/session'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { fieldServer, memoryStorage } from '../../test/offlineFieldServer'
import { scoringSession } from '../../test/scoringSession'
import { ScoreGameScreen } from '../scoreboard/ScoreGameScreen'
import { CoachGameScreen } from '../screens/CoachGameScreen'
import { GameScreen } from '../screens/GameScreen'
import { cacheFileName, openCacheStore } from '../sync/cacheStore'
import { CachingClient } from '../sync/cachingClient'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { ScoringScreen } from './ScoringScreen'
import { memoryStore, ServerScoringSource } from './scoringSource'
import { ServerClock } from './serverClock'

// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext

const UNREACHABLE = 'Cannot reach TeamStation'

async function settle(ms = 50): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

/**
 * A game under way that the phone only read ahead, never opened: tapped with
 * no signal, its page, Score Game, scoring and Coach Game all open from what
 * the read-ahead stored. Upcoming is a game whose start is still ahead, so
 * the game being scored at the field is read ahead as one that started.
 */
describe('a game under way, read ahead and opened with no signal', function () {
  let dir: string
  let executors: Array<ReturnType<typeof nodeSqliteExecutor>>
  let root: Root | undefined

  beforeEach(function () {
    dir = mkdtempSync(join(tmpdir(), 'teamstation-underway-'))
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

  /** Online, only the read-ahead Home starts; then every request fails. */
  async function readAhead(): Promise<{
    client: CachingClient
    stored: string[]
  }> {
    const started = memoryStore()
    const first = ScoringSession.start(
      started,
      'g1',
      scoringSession(gameFixture)
    )
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    const net = fieldServer(started.games.get('g1')!)
    net.underWay = true
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
    await client.prefetch()
    const stored = (
      executors.at(-1)!.db.prepare('SELECT key FROM documents').all() as Array<{
        key: string
      }>
    ).map(row => row.key)
    net.offline = true
    return { client, stored }
  }

  async function render(element: React.ReactElement): Promise<string> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<ThemeProvider>{element}</ThemeProvider>)
    })
    await settle(200)
    return document.body.textContent ?? ''
  }

  it('stores the game and what its page, scoring and Coach Game read', async function () {
    const { stored } = await readAhead()
    expect(stored).includes.members([
      'game.g1',
      'lineups.g1',
      'events.g1',
      '/events/g1/info',
      '/games/g1/box-score',
      '/games/g1/plans'
    ])
  })

  it('opens the game page on its event information, with Score offered', async function () {
    const { client } = await readAhead()
    const text = await render(
      <GameScreen
        client={client}
        gameId="g1"
        signedIn
        onScoreGame={() => undefined}
        onCoachGame={() => undefined}
      />
    )
    expect(text).not.includes(UNREACHABLE)
    expect(document.querySelector('[aria-label="Score"]')).not.equals(null)
    expect(
      document.querySelector('[aria-label="Retry event information"]')
    ).equals(null)
  })

  it('opens Score Game on its choices', async function () {
    const { client } = await readAhead()
    const text = await render(
      <ScoreGameScreen
        client={client}
        gameId="g1"
        onFullScoring={() => undefined}
        onScoreboard={() => undefined}
      />
    )
    expect(text).includes('Full game scoring')
    expect(text).not.includes('not found')
  })

  it('opens scoring on the plays already scored', async function () {
    const { client } = await readAhead()
    const source = new ServerScoringSource(
      client,
      new ServerClock(async () => await client.serverTime(), memoryStorage())
    )
    const text = await render(
      <ScoringScreen
        client={client}
        gameId="g1"
        userId="usr_scorer"
        source={source}
        onExit={() => undefined}
      />
    )
    expect(text).includes('1 balls')
  })

  it('opens Coach Game on its box score', async function () {
    const { client } = await readAhead()
    const text = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(text).includes('Box Score').and.includes('Batting — Hawks')
    expect(text).not.includes(UNREACHABLE)
  })
})
