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
import type { GameSocketEvent } from '../../common/gameSocket'
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
    administeredTeamIds: []
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
  props: React.ComponentProps<typeof GameScreen>
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen {...props} />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
}
const selected = (): string | null =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ??
  null
async function choose(label: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
      .click()
  })
}
describe('the event page’s automatic and explicit sections', () => {
  it('opens an unscored game on Info and follows the first play through the shared socket', async () => {
    const { client, game } = fixture()
    let listener: ((event: GameSocketEvent) => void) | undefined
    let detached = false
    await render({
      client,
      gameId: 'g1',
      socket: {
        subscribe: (_id, receive) => {
          listener = receive
          return () => {
            detached = true
          }
        }
      }
    })
    expect(selected()).equals('Info')
    await act(async () => {
      game.hasScoringEvents = true
      listener!({ type: 'resync', gameId: 'g1' })
    })
    expect(selected()).equals('Box score')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(detached).equals(true)
  })
  it('preserves a chosen Info section while later scoring arrives and responds to explicit address changes', async () => {
    const { client, game } = fixture()
    let listener: ((event: GameSocketEvent) => void) | undefined
    const socket = {
      subscribe: (
        _id: string,
        receive: (event: GameSocketEvent) => void
      ): (() => void) => {
        listener = receive
        return () => undefined
      }
    }
    await render({ client, gameId: 'g1', socket })
    await choose('Info')
    await act(async () => {
      game.hasScoringEvents = true
      listener!({ type: 'resync', gameId: 'g1' })
    })
    expect(selected()).equals('Info')
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GestureHandlerRootView>
            <GameScreen
              client={client}
              gameId="g1"
              initialTab="boxScore"
              socket={socket}
            />
          </GestureHandlerRootView>
        </ThemeProvider>
      )
    })
    expect(selected()).equals('Box score')
  })
  it('changes the default and moves Info last at the scheduled end while remaining mounted', async () => {
    const { client, game } = fixture()
    game.startAt = new Date(Date.now() - 60000).toISOString()
    game.endAt = new Date(Date.now() + 200).toISOString()
    await render({ client, gameId: 'g1' })
    expect(selected()).equals('Info')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 260))
    })
    expect(selected()).equals('Box score')
    const pills = [...document.querySelectorAll('[role="tab"]')].map(
      node => node.textContent
    )
    expect(pills.at(-1)).equals('Info')
  })
  it('shows title-only non-game events on Info even after their end and suppresses the game socket', async () => {
    const { client, game } = fixture()
    game.eventKind = 'event'
    game.title = 'Team dinner'
    game.awayTeamId = ''
    game.awayTeamName = ''
    game.canScore = false
    game.endAt = new Date(Date.now() - 60000).toISOString()
    let subscriptions = 0
    await render({
      client,
      gameId: 'g1',
      initialTab: 'boxScore',
      socket: {
        subscribe: () => {
          subscriptions++
          return () => undefined
        }
      }
    })
    expect(selected()).equals('Info')
    expect(document.body.textContent).includes('Team dinner')
    expect(document.querySelectorAll('[role="tab"]')).length(1)
    expect(subscriptions).at.most(1)
  })
  it('keeps REST foreground refresh working when a socket transport is unavailable', async () => {
    const { client, game } = fixture()
    await render({
      client,
      gameId: 'g1',
      socket: {
        subscribe: () => {
          throw new Error('No socket transport')
        }
      }
    })
    expect(selected()).equals('Info')
    await act(async () => {
      game.hasScoringEvents = true
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(selected()).equals('Box score')
  })
  it('discards an older game answer after a newer scoring update', async () => {
    const { client, game } = fixture()
    let listener: ((event: GameSocketEvent) => void) | undefined
    await render({
      client,
      gameId: 'g1',
      socket: {
        subscribe: (_id, receive) => {
          listener = receive
          return () => undefined
        }
      }
    })
    let finish: ((game: GameDetail) => void) | undefined
    const old = { ...game }
    client.game = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    await act(async () => {
      listener!({ type: 'resync', gameId: 'g1' })
    })
    const finishOld = finish!
    client.game = async () => ({ ...game, hasScoringEvents: true })
    await act(async () => {
      listener!({ type: 'resync', gameId: 'g1' })
    })
    expect(selected()).equals('Box score')
    await act(async () => {
      finishOld(old)
    })
    expect(selected()).equals('Box score')
  })
  it('clears a previous game’s cached box score when its address changes', async () => {
    const { client, game } = fixture()
    const boxes: string[] = []
    client.game = async id => ({ ...game, id, hasScoringEvents: true })
    client.boxScore = async id => {
      boxes.push(id)
      return { batting: [], pitching: [], stats: undefined }
    }
    await render({ client, gameId: 'g1', initialTab: 'boxScore' })
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GestureHandlerRootView>
            <GameScreen client={client} gameId="g2" initialTab="boxScore" />
          </GestureHandlerRootView>
        </ThemeProvider>
      )
    })
    expect(boxes).includes('g1').and.includes('g2')
    expect(selected()).equals('Box score')
  })
  it('applies a newly past scheduled end even when its clock was seeded before that end', async () => {
    const { client, game } = fixture()
    await render({ client, gameId: 'g1' })
    game.startAt = new Date(Date.now() - 60000).toISOString()
    game.endAt = new Date(Date.now() - 1).toISOString()
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(selected()).equals('Box score')
    expect(
      [...document.querySelectorAll('[role="tab"]')].at(-1)?.textContent
    ).equals('Info')
  })
})
