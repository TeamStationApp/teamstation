import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  asVideoSummary,
  type GameDetail,
  TeamStationClient
} from '../../common/api'
import { asEventInfo } from '../../common/eventInfo'
import { eventArrivalTime, eventHeroLines } from '../../common/eventTime'
import type { GameSocketEvent } from '../../common/gameSocket'
import { HeaderSlotProvider } from '../components/headerSlot'
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
  it('updates the game LIVE pill for scoring, undo and finalization through the socket', async () => {
    const { client, game } = fixture()
    game.startAt = new Date(Date.now() - 60000).toISOString()
    game.endAt = new Date(Date.now() + 60000).toISOString()
    game.status = 'inProgress'
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
    const visible = (): boolean =>
      document.querySelector('[aria-label="Live now"]') != null
    expect(visible()).equals(false)
    for (const hasScoringEvents of [true, false, true]) {
      await act(async () => {
        game.hasScoringEvents = hasScoringEvents
        listener!({ type: 'resync', gameId: 'g1' })
      })
      expect(visible()).equals(hasScoringEvents)
    }
    await act(async () => {
      game.status = 'final'
      listener!({ type: 'resync', gameId: 'g1' })
    })
    expect(visible()).equals(false)
  })

  it('shows and expires the game LIVE pill at its time boundaries while mounted', async () => {
    const { client, game } = fixture()
    const hour = 60 * 60 * 1000
    const now = Date.now()
    game.startAt = new Date(now + hour + 200).toISOString()
    game.endAt = new Date(now + 2 * hour).toISOString()
    game.hasScoringEvents = true
    await render({ client, gameId: 'g1' })
    const visible = (): boolean =>
      document.querySelector('[aria-label="Live now"]') != null
    expect(visible()).equals(false)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 260))
    })
    expect(visible()).equals(true)
    game.startAt = new Date(Date.now() - 2 * hour).toISOString()
    game.endAt = new Date(Date.now() - hour + 200).toISOString()
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(visible()).equals(true)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 260))
    })
    expect(visible()).equals(false)
  })

  it('catches a start crossed during the game request while its end is still future', async () => {
    const { client, game } = fixture()
    const originalNow = Date.now
    let now = Date.parse('2027-04-10T17:59:59Z')
    Date.now = () => now
    game.videos = [
      asVideoSummary({
        id: 'v1',
        kind: 'program',
        title: 'Live',
        status: 'live',
        storage: 'local',
        startAt: null,
        durationSec: null,
        width: null,
        height: null,
        codecs: null
      })
    ]
    client.game = async () => {
      now = Date.parse('2027-04-10T18:00:01Z')
      return { ...game }
    }
    client.highlights = async () => ({
      highlights: [],
      withheld: null,
      droppedCount: 0
    })
    client.playback = async () => {
      throw new Error('No recording')
    }
    try {
      await render({ client, gameId: 'g1' })
      expect(selected()).equals('Videos')
      expect(document.querySelector('[role="tab"]')?.textContent).equals(
        'Videos'
      )
    } finally {
      Date.now = originalNow
    }
  })
  it('reapplies the default when Back clears an explicit section without another game refresh', async () => {
    const { client, game } = fixture()
    game.status = 'final'
    const show = async (initialTab?: 'watch' | 'boxScore'): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <GestureHandlerRootView>
              <GameScreen client={client} gameId="g1" initialTab={initialTab} />
            </GestureHandlerRootView>
          </ThemeProvider>
        )
      })
    }
    await render({ client, gameId: 'g1' })
    expect(selected()).equals('Box score')
    await show('watch')
    expect(selected()).equals('Videos')
    await show()
    expect(selected()).equals('Box score')
    game.eventKind = 'event'
    game.title = 'Team dinner'
    game.venue = 'Demo Park'
    game.status = 'cancelled'
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    await show('boxScore')
    expect(selected()).equals('Info')
    expect(document.body.textContent).not.includes('Demo Park')
    expect(document.body.textContent).includes('Canceled')
    expect(document.body.textContent).includes(
      eventHeroLines(game.startAt!, game.endAt).join('')
    )
  })
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
  it('keeps the Settings action stable during refresh and removes it when rights are revoked', async () => {
    const { client } = fixture()
    const state = await client.gameScheduling('g1')
    client.gameScheduling = async () => ({
      ...state,
      withdrawTeamIds: ['home']
    })
    await render({ client, gameId: 'g1', onSettings: () => undefined })
    const action = document.querySelector(
      '[aria-label="Event settings"][role="button"]'
    )!
    expect(action).not.equals(null)
    let finish: (value: typeof state) => void = () => undefined
    const pending = new Promise<typeof state>(resolve => {
      finish = resolve
    })
    client.gameScheduling = async () => await pending
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'))
    })
    expect(action.isConnected).equals(true)
    await act(async () => {
      finish({ ...state, withdrawTeamIds: [] })
      await pending
    })
    expect(
      document.querySelector('[aria-label="Event settings"][role="button"]')
    ).equals(null)
  })
  it('refreshes the viewer-local hero zone on foreground even while offline', async () => {
    const { client, game } = fixture()
    await render({ client, gameId: 'g1' })
    const original = Object.getOwnPropertyDescriptor(
      Intl.DateTimeFormat.prototype,
      'resolvedOptions'
    )!.value as Intl.DateTimeFormat['resolvedOptions']
    const nextZone =
      original.call(new Intl.DateTimeFormat()).timeZone === 'Asia/Tokyo'
        ? 'America/Los_Angeles'
        : 'Asia/Tokyo'
    Intl.DateTimeFormat.prototype.resolvedOptions = function (
      this: Intl.DateTimeFormat
    ): Intl.ResolvedDateTimeFormatOptions {
      return { ...original.call(this), timeZone: nextZone }
    }
    client.game = async () => {
      throw new Error('Offline')
    }
    try {
      await act(async () => {
        window.dispatchEvent(new window.Event('focus'))
      })
      expect(
        document.querySelector('[data-testid="event-hero"]')?.textContent
      ).includes(
        eventHeroLines(game.startAt!, game.endAt, undefined, nextZone).join('')
      )
    } finally {
      Intl.DateTimeFormat.prototype.resolvedOptions = original
    }
  })
  it('calls a titled practice Practice in its hero and in the header', async () => {
    const { client, game } = fixture()
    game.eventKind = 'event'
    game.eventType = 'practice'
    game.title = 'Pitching clinic'
    const handed: React.ReactNode[] = []
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <HeaderSlotProvider
            headerHeight={56}
            onHandoff={node => {
              handed.push(node)
            }}
          >
            <GestureHandlerRootView>
              <GameScreen client={client} gameId="g1" initialTab="info" />
            </GestureHandlerRootView>
          </HeaderSlotProvider>
        </ThemeProvider>
      )
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    const hero = document.querySelector('[data-testid="event-hero"]')!
    expect(hero.textContent).includes('Practice')
    expect(hero.textContent).not.includes('Pitching clinic')
    const header = document.createElement('div')
    document.body.append(header)
    const headerRoot = createRoot(header)
    await act(async () => {
      headerRoot.render(
        <ThemeProvider>{handed.filter(Boolean).at(-1)}</ThemeProvider>
      )
    })
    expect(header.textContent).equals('Practice')
    await act(async () => {
      headerRoot.unmount()
    })
  })
  for (const kind of ['game', 'event'] as const)
    for (const delta of [null, 0, 45])
      it(`shows actual local arrival only when provided (${kind}, ${String(delta)})`, async () => {
        const { client, game } = fixture()
        game.eventKind = kind
        game.title = kind === 'event' ? 'Demo practice' : null
        game.arrivalTimeDelta = delta
        game.startAt = '2032-03-01T00:15:00Z'
        await render({ client, gameId: 'g1', initialTab: 'info' })
        const hero = document
          .querySelector('[data-testid="event-hero"]')!
          .textContent!.toUpperCase()
        const details = document.querySelectorAll<HTMLElement>(
          '[data-testid="event-hero-date"], [data-testid="event-hero-time"]'
        )
        expect(details).length(2)
        expect(getComputedStyle(details[0]).color).equals('rgb(0, 0, 0)')
        if (delta == null) expect(hero).not.includes('ARRIVAL')
        else
          expect(hero).includes(
            `ARRIVAL ${eventArrivalTime(game.startAt, delta)!.toUpperCase()}`
          )
      })
})
