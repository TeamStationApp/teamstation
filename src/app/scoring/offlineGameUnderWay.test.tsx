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
import { listProps } from '../../test/PagedListStandIn'
import { scoringSession } from '../../test/scoringSession'
import { lstrings } from '../locales/strings'
import { ScoreGameScreen } from '../scoreboard/ScoreGameScreen'
import { CoachGameScreen } from '../screens/CoachGameScreen'
import { GameScreen } from '../screens/GameScreen'
import { GamesFeedScreen } from '../screens/GamesFeedScreen'
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
  async function readAhead(
    underWay = true,
    external = false,
    prefetch = true
  ): Promise<{
    client: CachingClient
    net: ReturnType<typeof fieldServer>
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
    net.underWay = underWay
    net.external = external
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      token: 'token-1',
      fetch: net.fetch,
      openCache: async userId => {
        const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
        executors.push(executor)
        return await openCacheStore(executor)
      },
      outbox: { setTimer: () => 0, clearTimer: () => undefined },
      refreshRetryMs: 100
    })
    client.openFor('usr_scorer')
    if (prefetch) await client.prefetch()
    // Nothing read, nothing opened: nothing stored.
    const stored = (
      (executors.at(-1)?.db.prepare('SELECT key FROM documents').all() ??
        []) as Array<{ key: string }>
    ).map(row => row.key)
    net.offline = true
    return { client, net, stored }
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

  it('lists the game in Past, to tap', async function () {
    const { client } = await readAhead()
    const opened: string[] = []
    await render(
      <GamesFeedScreen
        client={client}
        mode="schedule"
        initialWhen="past"
        onOpenGame={gameId => opened.push(gameId)}
      />
    )
    const rows = listProps().data as unknown as Array<{ id: string }>
    expect(rows.map(row => row.id)).deep.equals(['g1'])
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
    expect(text).not.includes(lstrings.common_not_found)
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

  it('stores no box score for a game not begun, and Coach Game still opens', async function () {
    const { client, stored } = await readAhead(false)
    expect(stored).includes.members(['game.g1', '/events/g1/info'])
    expect(stored).not.includes('/games/g1/box-score')
    const text = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(text).includes('Box Score')
    expect(text).not.includes(UNREACHABLE)
  })

  it('opens Score Game and Coach Game at once on a link that answers nothing, once no signal is known', async function () {
    const { client, net } = await readAhead()
    await client.serverTime().catch(() => undefined)
    expect(client.offline).equals(true)
    // A dropped link: requests leave and nothing comes back.
    net.offline = false
    net.hold = new Promise<void>(() => undefined)
    const options = await render(
      <ScoreGameScreen
        client={client}
        gameId="g1"
        onFullScoring={() => undefined}
        onScoreboard={() => undefined}
      />
    )
    expect(options).includes('Full game scoring')
    await act(async () => {
      root?.unmount()
    })
    document.body.replaceChildren()
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score').and.not.includes('Loading game')
  })

  it('opens Coach Game at once on a link that answers nothing, against a placeholder opponent', async function () {
    const { client, net, stored } = await readAhead(true, true)
    expect(stored).not.includes('roster.away')
    await client.serverTime().catch(() => undefined)
    expect(client.offline).equals(true)
    net.offline = false
    net.hold = new Promise<void>(() => undefined)
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score').and.not.includes('Loading game')
  })

  it('opens Score Game and Coach Game on a game never stored from the server, when the phone wrongly thinks it has no signal', async function () {
    const { client, net, stored } = await readAhead(true, false, false)
    expect(stored).not.includes('game.g1')
    // The link works: only the phone's flag, left by a missed deadline,
    // says otherwise.
    net.offline = false
    client.offline = true
    const options = await render(
      <ScoreGameScreen
        client={client}
        gameId="g1"
        onFullScoring={() => undefined}
        onScoreboard={() => undefined}
      />
    )
    expect(options).includes('Full game scoring')
    await act(async () => {
      root?.unmount()
    })
    document.body.replaceChildren()
    // Answered, the flag is down again; set it, as a missed deadline would.
    client.offline = true
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score')
  })

  it('reads Coach Game again from the server once it answers, after opening on the phone’s copies', async function () {
    const { client, net } = await readAhead()
    await client.serverTime().catch(() => undefined)
    expect(client.offline).equals(true)
    net.offline = false
    let release = (): void => undefined
    net.hold = new Promise<void>(resolve => {
      release = resolve
    })
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        boxScoreEveryMs={50}
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score')
    // Each copy the screen opened on is read from the server behind it,
    // held while the link answers nothing; the signal comes back, and no
    // notice follows it.
    for (const path of [
      '/games/g1/plans',
      '/games/g1/lineups',
      '/games/g1/box-score'
    ])
      expect(net.requested, `${path} read behind`).includes(path)
    net.hold = undefined
    release()
    await settle(300)
    expect(client.offline).equals(false)
  })

  it('reads Coach Game again once the server answers, when no signal was learned while it opened, and again after a read again that failed', async function () {
    const { client, net } = await readAhead()
    // The phone has not yet learned the link is gone: the first read that
    // fails tells it, and the reads after it answer the phone's copies.
    expect(client.offline).equals(false)
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        boxScoreEveryMs={50}
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score')
    expect(client.offline).equals(true)
    // The phone takes the signal for back, and it is not: the reads again
    // find none.
    await act(async () => {
      client.offline = false
    })
    await settle(200)
    expect(client.offline).equals(true)
    // Back for good: read again. Another device saved a plan meanwhile, so
    // the screen, told, reads its plan too.
    net.planNote = 'newer'
    net.requested.length = 0
    net.offline = false
    await act(async () => {
      await client.serverTime().catch(() => undefined)
    })
    await settle(300)
    for (const path of ['/games/g1/plans', '/games/g1/lineups'])
      expect(net.requested, `${path} read again`).includes(path)
    expect(
      net.requested.filter(path => path === '/games/g1/plans').length,
      'the client’s read, and the screen’s'
    ).greaterThan(1)
  })

  it('reads Coach Game again shortly when the server refuses its first read again, with the signal back (9.harness-review.6)', async function () {
    const { client, net } = await readAhead()
    await client.serverTime().catch(() => undefined)
    expect(client.offline).equals(true)
    net.offline = false
    let release = (): void => undefined
    net.hold = new Promise<void>(resolve => {
      release = resolve
    })
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score')
    // The signal is back, and the server, being deployed, refuses the plan.
    net.refused.set('/games/g1/plans', 503)
    net.hold = undefined
    release()
    await settle(60)
    expect(client.offline).equals(false)
    net.refused.clear()
    net.requested.length = 0
    await settle(300)
    expect(net.requested, 'the plan read again').includes('/games/g1/plans')
  })

  async function coachOffline(): Promise<{
    client: CachingClient
    net: ReturnType<typeof fieldServer>
    release: () => void
  }> {
    const { client, net } = await readAhead()
    await client.serverTime().catch(() => undefined)
    net.offline = false
    let release = (): void => undefined
    net.hold = new Promise<void>(resolve => {
      release = resolve
    })
    const coach = await render(
      <CoachGameScreen
        client={client}
        gameId="g1"
        teamId="home"
        userId="usr_scorer"
        onExit={() => undefined}
      />
    )
    expect(coach).includes('Box Score')
    return { client, net, release }
  }

  it('reads a refused copy again until the server answers it, then no more (10.harness-review.1, the client’s own)', async function () {
    const { net, release } = await coachOffline()
    net.refused.set('/games/g1/plans', 503)
    net.hold = undefined
    release()
    await settle(150)
    // Refused for now: read again after the wait, once answered.
    net.refused.clear()
    await settle(250)
    expect(
      net.requested.filter(path => path === '/games/g1/plans').length
    ).greaterThan(1)
    net.requested.length = 0
    await settle(300)
    expect(net.requested, 'answered: no more').not.includes('/games/g1/plans')
  })

  it('reads a refused copy again no more once no screen listens for it (3.harness-review.1)', async function () {
    const { net, release } = await coachOffline()
    net.refused.set('/games/g1/plans', 503)
    net.hold = undefined
    release()
    await settle(60)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    net.requested.length = 0
    await settle(400)
    expect(net.requested, 'nobody to tell').not.includes('/games/g1/plans')
  })

  it('gives a copy the server keeps refusing up after a few tries, each wait longer (3.harness-review.1, 4.harness-review.1)', async function () {
    const { net, release } = await coachOffline()
    net.refused.set('/games/g1/plans', 503)
    net.hold = undefined
    release()
    // When each read of the plan sets out, watched over the waits of 100,
    // 200 and 400 ms the client takes.
    const times: number[] = []
    const started = Date.now()
    let seen = 0
    while (Date.now() - started < 1500) {
      const count = net.requested.filter(
        path => path === '/games/g1/plans'
      ).length
      for (; seen < count; seen++) times.push(Date.now())
      await settle(5)
    }
    const gaps = times.slice(1).map((at, index) => at - times[index])
    expect(gaps.length, 'tried again, then given up').within(2, 4)
    // Each wait longer than the one before.
    for (let at = 1; at < gaps.length; at++)
      expect(gaps[at]).greaterThan(gaps[at - 1] * 1.5)
    net.requested.length = 0
    await settle(900)
    expect(net.requested, 'given up').not.includes('/games/g1/plans')
  })

  it('reads Coach Game’s plan again when the server’s, read behind the phone’s copy, differs (2.harness-review.3)', async function () {
    const { net, release } = await coachOffline()
    // Another device saved a plan while the phone had no signal.
    net.planNote = 'newer'
    net.requested.length = 0
    net.hold = undefined
    release()
    await settle(300)
    // The client's read, held from before, differed: the screen reads its
    // plan again.
    expect(net.requested, 'the screen’s read again').includes('/games/g1/plans')
  })

  it('takes a 403 on a read again as the server’s last word, and does not try it again (10.harness-review.1)', async function () {
    const { client, net, release } = await coachOffline()
    net.refused.set('/games/g1/plans', 403)
    net.hold = undefined
    release()
    await settle(60)
    expect(client.offline).equals(false)
    net.requested.length = 0
    await settle(300)
    expect(net.requested).not.includes('/games/g1/plans')
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
