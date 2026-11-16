import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type GameLineupsResponse, TeamStationClient } from '../../common/api'
import type { PlanCell } from '../../common/gamePlan'
import type { GameSocketEvent } from '../../common/gameSocket'
import { ScoringSession as GameSession } from '../../common/scoring/session'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { fieldServer, memoryStorage } from '../../test/offlineFieldServer'
import { PLAN_START, PLAN_SWAPPED } from '../../test/scoringPlans'
import { scoringRoster, scoringSession } from '../../test/scoringSession'
import { cacheFileName, openCacheStore } from '../sync/cacheStore'
import { CachingClient } from '../sync/cachingClient'
import { ThemeProvider } from '../theme/ThemeContext'
import { startingSetup, teamsOf } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import type { GameChanges } from './rosterLive'
import { ScoringScreen } from './ScoringScreen'
import {
  memoryStore,
  type ScoringSource,
  ServerScoringSource
} from './scoringSource'
import { ServerClock } from './serverClock'

/** The game socket, as the screen hears it: the test says what arrives. */
class FakeChanges implements GameChanges {
  readonly listeners = new Set<(event: GameSocketEvent) => void>()

  subscribe(
    _gameId: string,
    listener: (event: GameSocketEvent) => void
  ): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A coach saved a change to `inning` of `teamId`'s plan, or a resync. */
  async emit(event: GameSocketEvent): Promise<void> {
    await act(async () => {
      for (const listener of [...this.listeners]) listener(event)
    })
    await settle()
  }

  async plans(teamId: string, inning: number): Promise<void> {
    await this.emit({
      type: 'change',
      gameId: 'g1',
      kind: 'plans',
      at: '2026-10-12T12:00:00Z',
      data: { teamId, inning }
    })
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
let root: Root | undefined
let cleanup: Array<() => Promise<void> | void> = []

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
  HTMLCanvasElement.prototype.getContext = getContext
  for (const step of cleanup) await step()
  cleanup = []
})

async function click(label: string): Promise<void> {
  const nodes = document.querySelectorAll<HTMLElement>(
    `[aria-label="${label}"]`
  )
  const node = nodes.item(nodes.length - 1)
  expect(node, label).not.equals(null)
  await act(async () => {
    node.click()
  })
  await settle()
}

async function endHalf(): Promise<void> {
  await click('Open scoring menu')
  await click('End Half Inning')
  await click('Confirm End Half Inning')
}

const planNotice = (): Element | null =>
  document.querySelector('[data-testid="scoringPlanNotice"]')
const syncNotice = (): string | null | undefined =>
  document.querySelector('[data-testid="planSyncNotice"]')?.textContent

async function render(
  client: TeamStationClient,
  source: ScoringSource,
  changes?: FakeChanges
): Promise<void> {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          userId="scorer"
          onExit={() => undefined}
          source={source}
          socket={changes}
        />
      </ThemeProvider>
    )
  })
  await settle()
}

/** The column of a side whose first player is `first`, as the route answers. */
const column = (first: number, cells: readonly PlanCell[]): unknown[] =>
  cells.map((cell, at) => ({
    player: {
      gumboId: first + at,
      fullName: `Player ${at + 1}`,
      jersey: String(at + 1)
    },
    cell
  }))

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

/** An inning column, as the route answers a scorer. */
const inningAnswer = (
  teamId: string,
  inning: number,
  cells: readonly PlanCell[] | null
): Response =>
  json(200, {
    teamId,
    inning,
    column: cells == null ? [] : column(teamId === 'away' ? 1 : 10, cells)
  })

type Answer = (teamId: string, inning: number) => Promise<Response> | Response

/**
 * A scoring screen on a saved game whose inning route answers what
 * `innings` does: a fetch of its own, so a failure is the client's as it is
 * live. Every path it asks for is kept.
 */
async function scoring(innings: Answer): Promise<{
  changes: FakeChanges
  asked: string[]
  roster: () => Promise<number>
  home: () => Promise<Record<string, number | null>>
}> {
  const store = memoryStore()
  const open = async (): Promise<GameSession> =>
    await GameSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: teamsOf(gameFixture),
      setup: startingSetup(gameFixture, scoringRoster(1), scoringRoster(10))
    })
  const asked: string[] = []
  const client = new TeamStationClient({
    baseUrl: 'http://x/api/v1',
    fetch: async (url: unknown) => {
      const path = String(url).replace('http://x/api/v1', '')
      asked.push(path)
      const inning = /^\/games\/g1\/plans\/([^/]+)\/innings\/(\d+)$/.exec(path)
      return inning == null
        ? json(404, { code: 'notFound', message: 'Not found' })
        : await innings(inning[1], Number(inning[2]))
    }
  })
  client.game = async () => gameFixture
  client.roster = async teamId =>
    scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10)
  client.gameLineups = async () =>
    ({ digest: 'd1' }) as unknown as GameLineupsResponse
  const changes = new FakeChanges()
  await render(client, { persistent: true, open }, changes)
  return {
    changes,
    asked,
    // Roster saves in the game as stored.
    roster: async () =>
      (await open()).actions.filter(
        action => action.type === 'lineup' && action.kind === 'roster'
      ).length,
    home: async () => {
      const game = await open()
      return { ...game.state.liveData.boxscore.teams.home.defense }
    }
  }
}

const inningsAsked = (asked: readonly string[]): string[] =>
  asked.filter(path => path.includes('/innings/'))

/** The home side fielding `cells` as players 10 to 18 in batting order. */
const fielded = (cells: readonly PlanCell[]): Record<string, number | null> => {
  const defense: Record<string, number | null> = Object.fromEntries(
    PLAN_START.map(position => [position, null])
  )
  cells.forEach((cell, at) => {
    if (cell in defense) defense[cell] = 10 + at
  })
  return defense
}

describe('plan innings on the scoring screen', function () {
  it('downloads both sides’ column for the inning an inning’s end starts, applies it, and never reads the whole plan', async function () {
    const { asked, roster, home } = await scoring((teamId, inning) =>
      inningAnswer(teamId, inning, teamId === 'home' ? PLAN_SWAPPED : null)
    )
    await click('Ball')
    await endHalf()
    expect(inningsAsked(asked)).deep.equals([])
    await endHalf()
    expect(document.body.textContent).includes('Top 2nd')
    expect(inningsAsked(asked)).deep.equals([
      '/games/g1/plans/away/innings/2',
      '/games/g1/plans/home/innings/2'
    ])
    expect(asked).not.includes('/games/g1/plans')
    expect(await roster()).equals(1)
    expect(await home()).deep.equals(fielded(PLAN_SWAPPED))
    expect(planNotice()).equals(null)
    expect(syncNotice()).equals(undefined)
  })

  const failures: Array<[string, () => Response]> = [
    [
      'a network error',
      () => {
        throw new TypeError('Load failed')
      }
    ],
    ['a 500', () => json(500, { code: 'internal', message: 'Down' })],
    [
      'an inning not in play',
      () =>
        json(409, {
          code: 'conflict',
          message: 'Not in play',
          details: { reason: 'planInningNotCurrent', inning: 1 }
        })
    ],
    ['a body the cleaner refuses', () => new Response('[]', { status: 200 })]
  ]
  for (const [failure, fails] of failures)
    it(`drops the sync card after ${failure}, keeps the lineup on Accept, and applies the column on Try again`, async function () {
      let answer: Answer = (teamId, inning) =>
        teamId === 'home' ? fails() : inningAnswer(teamId, inning, null)
      const { asked, roster, home } = await scoring(
        async (teamId, inning) => await answer(teamId, inning)
      )
      await endHalf()
      await endHalf()
      expect(syncNotice()).equals(
        'Unable to sync new inning defensive lineup for HawksAcceptTry again'
      )
      expect(await roster()).equals(0)
      // Scoring goes on under the card.
      await click('Ball')
      expect(document.body.textContent).includes('1 balls')
      await click('Accept')
      expect(syncNotice()).equals(undefined)
      expect(await roster()).equals(0)
      // The next inning fails again; Try again asks once more and applies.
      await endHalf()
      await endHalf()
      expect(syncNotice()).includes('Hawks')
      answer = (teamId, inning) =>
        inningAnswer(teamId, inning, teamId === 'home' ? PLAN_SWAPPED : null)
      const before = inningsAsked(asked).length
      await click('Try again')
      expect(inningsAsked(asked).slice(before)).deep.equals([
        '/games/g1/plans/home/innings/3'
      ])
      expect(syncNotice()).equals(undefined)
      expect(await home()).deep.equals(fielded(PLAN_SWAPPED))
    })

  it('shows nothing before the game’s start time or once it is over', async function () {
    for (const reason of ['planNotStarted', 'planGameOver']) {
      const { asked, roster } = await scoring(() =>
        json(403, { code: 'forbidden', message: 'No', details: { reason } })
      )
      await endHalf()
      await endHalf()
      expect(inningsAsked(asked), reason).has.length(2)
      expect(syncNotice(), reason).equals(undefined)
      expect(await roster()).equals(0)
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      document.body.replaceChildren()
    }
  })

  it('downloads the inning in play again when a coach saves a change to it, replacing the defence, and nothing for another inning or a resync', async function () {
    let cells: readonly PlanCell[] = PLAN_SWAPPED
    const { changes, asked, home } = await scoring((teamId, inning) =>
      inningAnswer(teamId, inning, teamId === 'home' ? cells : null)
    )
    await endHalf()
    await endHalf()
    expect(await home()).deep.equals(fielded(PLAN_SWAPPED))
    const before = inningsAsked(asked).length
    await changes.plans('home', 3)
    await changes.emit({ type: 'resync', gameId: 'g1' })
    expect(inningsAsked(asked)).has.length(before)
    cells = PLAN_START
    await changes.plans('home', 2)
    expect(inningsAsked(asked).slice(before)).deep.equals([
      '/games/g1/plans/home/innings/2'
    ])
    expect(await home()).deep.equals(fielded(PLAN_START))
  })

  it('takes a coach’s change on a screen just opened, before the scorer has scored anything', async function () {
    const { changes, asked, home } = await scoring((teamId, inning) =>
      inningAnswer(teamId, inning, teamId === 'home' ? PLAN_SWAPPED : null)
    )
    await changes.plans('home', 1)
    expect(inningsAsked(asked)).deep.equals(['/games/g1/plans/home/innings/1'])
    expect(await home()).deep.equals(fielded(PLAN_SWAPPED))
  })

  it('scores offline, where nothing can be saved, asking for no inning and showing no card', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'teamstation-plan-'))
    const executors: Array<ReturnType<typeof nodeSqliteExecutor>> = []
    cleanup.push(async () => {
      for (const executor of executors) await executor.close()
      rmSync(dir, { recursive: true, force: true })
    })
    const started = memoryStore()
    const first = GameSession.start(started, 'g1', scoringSession(gameFixture))
    first.apply({ type: 'pitch', call: 'B' })
    await first.flush()
    const net = fieldServer(started.games.get('g1')!)
    const asked: string[] = []
    const client = new CachingClient({
      baseUrl: 'http://x/api/v1',
      token: 'token-1',
      fetch: async (url: unknown, init?: RequestInit) => {
        asked.push(String(url).replace('http://x/api/v1', ''))
        return await net.fetch(url as string, init)
      },
      openCache: async userId => {
        const executor = nodeSqliteExecutor(join(dir, cacheFileName(userId)))
        executors.push(executor)
        return await openCacheStore(executor)
      },
      outbox: { setTimer: () => 0, clearTimer: () => undefined }
    })
    client.openFor('usr_scorer')
    await client.prefetch()
    // What the phone reads ahead is not the scoring screen's.
    const ahead = asked.length
    net.offline = true
    const posts = net.posts.length
    await render(
      client,
      new ServerScoringSource(
        client,
        new ServerClock(async () => await client.serverTime(), memoryStorage())
      )
    )
    expect(document.body.textContent).includes('1 balls')
    await endHalf()
    await endHalf()
    await click('Ball')
    expect(document.body.textContent).includes('Top 2nd')
    expect(document.body.textContent).includes('1 balls')
    expect(inningsAsked(asked)).deep.equals([])
    expect(asked.slice(ahead)).not.includes('/games/g1/plans')
    expect(syncNotice()).equals(undefined)
    expect(net.posts.length, 'nothing left the phone').equals(posts)
    expect((await client.outboxSummary()).chains['game:g1']).greaterThan(0)
  })
})
