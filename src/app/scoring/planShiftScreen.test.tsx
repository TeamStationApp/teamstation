import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  type GameLineupsResponse,
  type GamePlansResponse,
  TeamStationClient
} from '../../common/api'
import type { PlanCell } from '../../common/gamePlan'
import type { GameSocketEvent } from '../../common/gameSocket'
import { DEFAULT_PLAYING_TIME_RULES } from '../../common/playingTimeRules'
import { ScoringSession as GameSession } from '../../common/scoring/session'
import { nodeSqliteExecutor } from '../../test/nodeSqliteExecutor'
import { fieldServer, memoryStorage } from '../../test/offlineFieldServer'
import {
  PLAN_SWAPPED,
  scoringPlans,
  scoringSidePlan
} from '../../test/scoringPlans'
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

  /** A coach saved a plan. */
  async plans(): Promise<void> {
    await act(async () => {
      for (const listener of [...this.listeners])
        listener({
          type: 'change',
          gameId: 'g1',
          kind: 'plans',
          at: '2026-10-12T12:00:00Z',
          data: { teamId: 'home' }
        })
    })
    await settle()
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

const notice = (): string | null | undefined =>
  document.querySelector('[data-testid="scoringPlanNotice"]')?.textContent

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

/**
 * A scoring screen on a saved game whose plans read answers what `plans`
 * does: a fetch of its own, so a failed read is the client's as it is live.
 */
async function scoring(
  plans: () => Promise<Response> | Response
): Promise<{ changes: FakeChanges; roster: () => Promise<number> }> {
  const store = memoryStore()
  const open = async (): Promise<GameSession> =>
    await GameSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: teamsOf(gameFixture),
      setup: startingSetup(gameFixture, scoringRoster(1), scoringRoster(10))
    })
  const client = new TeamStationClient({
    baseUrl: 'http://x/api/v1',
    fetch: async (url: unknown) =>
      String(url) === 'http://x/api/v1/games/g1/plans'
        ? await plans()
        : new Response(
            JSON.stringify({ code: 'notFound', message: 'Not found' }),
            { status: 404 }
          )
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
    // Roster saves in the game as stored.
    roster: async () =>
      (await open()).actions.filter(
        action => action.type === 'lineup' && action.kind === 'roster'
      ).length
  }
}

const answer = (body: GamePlansResponse): Response =>
  new Response(JSON.stringify(body), { status: 200 })

describe('plan shift on the scoring screen', function () {
  const failures: Array<[string, () => Response]> = [
    [
      'a network error',
      () => {
        throw new TypeError('Load failed')
      }
    ],
    [
      'a 500',
      () =>
        new Response(JSON.stringify({ code: 'internal', message: 'Down' }), {
          status: 500
        })
    ],
    ['a body the cleaner refuses', () => new Response('[]', { status: 200 })]
  ]
  for (const [failure, fails] of failures)
    it(`scores on after ${failure} reading the plans, and reads them on the next plans change`, async function () {
      let read: () => Response = fails
      const { changes, roster } = await scoring(() => read())
      await click('Ball')
      expect(document.body.textContent).includes('1 balls 0 strikes')
      await endHalf()
      await endHalf()
      expect(document.body.textContent).includes('Top 2nd')
      expect(notice()).equals(undefined)
      expect(await roster()).equals(0)
      read = () =>
        answer(scoringPlans({ home: scoringSidePlan(10, { 3: PLAN_SWAPPED }) }))
      await changes.plans()
      await endHalf()
      await endHalf()
      expect(notice()).equals('Inning 3 plan applied')
      expect(await roster()).equals(1)
    })

  it('scores offline, where the plans cannot be read, queuing plays and shifting nothing', async function () {
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
    net.offline = true
    const posts = net.posts.length
    await render(
      client,
      new ServerScoringSource(
        client,
        new ServerClock(async () => await client.serverTime(), memoryStorage())
      )
    )
    expect(asked).includes('/games/g1/plans')
    expect(document.body.textContent).includes('1 balls')
    await endHalf()
    await endHalf()
    await click('Ball')
    expect(document.body.textContent).includes('Top 2nd')
    expect(document.body.textContent).includes('1 balls')
    expect(notice()).equals(undefined)
    expect(net.posts.length, 'nothing left the phone').equals(posts)
    expect((await client.outboxSummary()).chains['game:g1']).greaterThan(0)
  })

  it('tells the scorer what the shift did, until the next play', async function () {
    // Max Sits is one; Player 9 sits innings 1, 2 and 3.
    const sitting: PlanCell[] = [
      'P',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      '-'
    ]
    const plans = scoringPlans({
      home: scoringSidePlan(
        10,
        { 1: sitting, 2: sitting, 3: sitting },
        {
          rules: {
            ...DEFAULT_PLAYING_TIME_RULES,
            enforceSittingLimits: true,
            noConsecutiveSits: false,
            equalSittingOrder: 'off'
          }
        }
      )
    })
    await scoring(() => answer(plans))
    await endHalf()
    expect(notice()).equals(undefined)
    await endHalf()
    expect(notice()).equals('Inning 2 plan applied — 1 playing-time warning')
    await click('Ball')
    expect(notice()).equals(undefined)
  })

  it('tells the scorer a column it could not apply, and why', async function () {
    const benched: PlanCell[] = [
      '-',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      'RF'
    ]
    const { roster } = await scoring(() =>
      answer(scoringPlans({ home: scoringSidePlan(10, { 2: benched }) }))
    )
    await endHalf()
    await endHalf()
    expect(document.body.textContent).includes('Top 2nd')
    expect(notice()).equals('Hawks inning 2 plan not applied: needs a pitcher')
    expect(await roster()).equals(0)
  })

  it('names each team when one side applies and the other is refused', async function () {
    // Max Sits is one; the Owls' Player 9 sits innings 1, 2 and 3.
    const sitting: PlanCell[] = [
      'P',
      'C',
      '1B',
      '2B',
      'SS',
      '3B',
      'LF',
      'CF',
      '-'
    ]
    const benched: PlanCell[] = ['-', ...sitting.slice(1, 8), 'RF']
    const plans = scoringPlans({
      away: scoringSidePlan(
        1,
        { 1: sitting, 2: sitting, 3: sitting },
        {
          rules: {
            ...DEFAULT_PLAYING_TIME_RULES,
            enforceSittingLimits: true,
            noConsecutiveSits: false,
            equalSittingOrder: 'off'
          }
        }
      ),
      home: scoringSidePlan(10, { 2: benched })
    })
    const { roster } = await scoring(() => answer(plans))
    await endHalf()
    await endHalf()
    expect(notice()).equals(
      'Owls inning 2 plan applied — 1 playing-time warning\nHawks inning 2 plan not applied: needs a pitcher'
    )
    expect(await roster()).equals(1)
  })
})
