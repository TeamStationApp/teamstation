import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  type GameDetail,
  TeamStationClient
} from '../../common/api'
import { asEventInfo } from '../../common/eventInfo'
import { press, settle, text } from '../../test/gameFormDom'
import {
  HELD_GAME_CONSEQUENCE,
  USE_SERVER_COPY
} from '../scoring/HeldGameNotice'
import { CachingClient } from '../sync/cachingClient'
import type { OutboxListener, OutboxSummary } from '../sync/outbox'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})
function fixture(): { client: TeamStationClient; game: GameDetail } {
  const game = asGameDetail({
    id: 'g1',
    nonMemberView: false,
    homeTeamId: 'home',
    awayTeamId: 'away',
    homeTeamName: 'Owls',
    awayTeamName: 'Eagles',
    seasonId: null,
    startAt: '2027-04-10T18:00:00Z',
    endAt: '2027-04-10T20:00:00Z',
    venue: null,
    status: 'scheduled',
    homeScore: null,
    awayScore: null,
    ingestStatus: 'none',
    ingestMessage: null,
    videos: [],
    canScore: true,
    assignedRoles: {
      away: [],
      home: ['coach', 'scorekeeper', 'songkeeper', 'videographer']
    },
    hasScoringEvents: false
  })
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({ ...game })
  client.teams = async () => []
  client.boxScore = async () => ({
    batting: [],
    pitching: [],
    stats: undefined
  })
  client.gameScheduling = async () => ({
    game: {
      homeTeamId: 'home',
      awayTeamId: 'away',
      seasonId: null,
      startAt: game.startAt!,
      venue: null,
      outsideTournament: null,
      status: 'scheduled',
      exhibition: false,
      timezone: 'UTC'
    },
    version: 'a'.repeat(64),
    canPropose: false,
    withdrawTeamIds: [],
    administeredTeamIds: [],
    canSwap: false,
    plays: undefined
  })
  client.eventInfo = async () =>
    asEventInfo({
      id: 'g1',
      eventKind: game.eventKind ?? 'game',
      title: game.title ?? null,
      teamId: 'home',
      teamName: 'Owls',
      startAt: game.startAt,
      endAt: game.endAt ?? null,
      timezone: 'UTC',
      venue: null,
      address: null,
      latitude: null,
      longitude: null,
      status: game.status,
      canManage: false,
      attendees: [],
      replyUserIds: []
    })
  return { client, game }
}
async function render(
  props: Omit<React.ComponentProps<typeof GameScreen>, 'signedIn'>
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen signedIn {...props} />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
}

const summary = (games: OutboxSummary['games']): OutboxSummary => ({
  count: Object.keys(games).length,
  chains: {},
  games,
  teams: {}
})

/**
 * The event page's fixture on a phone's client holding `held`: each read of
 * the game is counted, and discarding the game lets the hold go.
 */
function phone(held: OutboxSummary): {
  client: TeamStationClient
  game: GameDetail
  calls: string[]
  set: (next: OutboxSummary) => void
} {
  const { client, game } = fixture()
  const calls: string[] = []
  const listeners = new Set<OutboxListener>()
  let current = held
  const set = (next: OutboxSummary): void => {
    current = next
    for (const listener of listeners) listener(next)
  }
  const read = async (): Promise<GameDetail> => ({ ...game })
  Object.setPrototypeOf(client, CachingClient.prototype)
  Object.assign(client, {
    game: async () => {
      calls.push('game')
      return await read()
    },
    subscribeOutbox: (listener: OutboxListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    outboxSummary: async () => current,
    subscribeOutboxNotices: () => () => undefined,
    subscribeOffline: () => () => undefined,
    onStoredChanged: () => () => undefined,
    cached: async () => undefined,
    discardGame: async (id: string) => {
      calls.push(`discard ${id}`)
      set(summary({}))
      return true
    },
    retryGame: async (id: string) => {
      calls.push(`retry ${id}`)
    }
  })
  return { client, game, calls, set }
}

const notice = (): HTMLElement | null =>
  document.querySelector('[data-testid="heldGameNotice"]')
const reads = (calls: string[]): number =>
  calls.filter(call => call === 'game').length

describe("a held game's page", () => {
  it('says what the server stopped above the hero, and takes the server’s copy from the notice', async () => {
    const { client, calls } = phone(
      summary({ g1: { state: 'dead', message: 'That inning is closed.' } })
    )
    await render({ client, gameId: 'g1' })
    await settle(50)
    expect(notice()?.textContent).equals('Not sent: That inning is closed.')
    // Above the hero: the notice comes first in the page.
    const hero = document.querySelector('[data-testid="event-hero"]')!
    expect(
      notice()!.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    const before = reads(calls)
    await press('Unsent changes')
    expect(text()).includes(HELD_GAME_CONSEQUENCE)
    await press(USE_SERVER_COPY)
    await settle(50)
    expect(calls).includes('discard g1')
    expect(notice()).equals(null)
    expect(reads(calls)).greaterThan(before)
  })

  it('reads the game again when its hold is cleared elsewhere, and says nothing of another game', async () => {
    const { client, calls, set } = phone(
      summary({ g1: { state: 'parked', message: 'stale' } })
    )
    await render({ client, gameId: 'g1' })
    await settle(50)
    expect(notice()).not.equals(null)
    const before = reads(calls)
    await act(async () => {
      set(summary({ g2: { state: 'dead', message: null } }))
    })
    await settle(50)
    expect(notice()).equals(null)
    expect(reads(calls)).greaterThan(before)
  })

  it('shows no notice with nothing held', async () => {
    const { client } = phone(summary({}))
    await render({ client, gameId: 'g1' })
    await settle(50)
    expect(notice()).equals(null)
    expect(document.querySelector('[data-testid="event-hero"]')).not.equals(
      null
    )
  })
})
