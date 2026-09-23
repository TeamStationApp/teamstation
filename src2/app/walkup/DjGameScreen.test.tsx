import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asDjGame,
  type DjGame,
  type DjSide,
  type GameStationClient
} from '../../common/api'
import type { GameSocketEvent } from '../../common/gameSocket'
import type { WalkUpSong } from '../../common/walkUpSong'
import { ThemeProvider } from '../theme/ThemeContext'
import { AT_BAT_FADE_MS } from './atBatColors'
import {
  DjGameScreen,
  type DjGameScreenProps,
  type DjSocket
} from './DjGameScreen'
import type { PlaybackState, WalkUpMusic } from './walkUpMusicTypes'

/**
 * U29: DJ Game — the roster editor's team pill, the list and its notes, and
 * how the socket, the poll and a finger on the glass keep it current.
 */
let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const text = (): string => document.body.textContent ?? ''
function labelled(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`)
}
async function press(label: string): Promise<void> {
  const found = buttonNamed(label)
  if (found == null) throw new Error(`No "${label}" in ${text()}`)
  await act(async () => {
    found.click()
    await delay(20)
  })
}
function names(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="DJ row"]')).map(
    row => (row.textContent ?? '').replace('music_note', '')
  )
}
function buttonNamed(label: string): HTMLElement | null {
  return (
    labelled(label) ??
    (Array.from(document.querySelectorAll('[role="button"]')).find(
      node => node.textContent === label
    ) as HTMLElement | undefined) ??
    null
  )
}

/**
 * Takes over the intervals of one period, so a test fires the poll itself
 * rather than racing real timers. Every other interval runs as usual.
 */
function pollClock(period: number): {
  running: () => number
  tick: () => Promise<void>
  restore: () => void
} {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const polls = new Map<unknown, () => void>()
  let nextId = 0
  globalThis.setInterval = ((
    callback: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms !== period) return realSet(callback, ms, ...rest)
    const id = { poll: ++nextId }
    polls.set(id, callback)
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (id: unknown) => {
    if (polls.delete(id)) return
    realClear(id as Parameters<typeof clearInterval>[0])
  }
  return {
    running: () => polls.size,
    tick: async () => {
      await act(async () => {
        for (const callback of Array.from(polls.values())) callback()
        await delay(5)
      })
    },
    restore: () => {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  }
}
let clock: ReturnType<typeof pollClock> | undefined

/** A touch event from the page's own window, which jsdom insists on. */
function touch(type: string): Event {
  const view = document.defaultView as unknown as { Event: typeof Event }
  return new view.Event(type, { bubbles: true })
}

const walk: WalkUpSong = {
  provider: 'localFile',
  providerId: 'lf:0123456789abcdef',
  isrc: null,
  title: 'Walk',
  artist: 'Band',
  album: null,
  artworkUrl: null,
  durationMs: 90000,
  startMs: 5000,
  endMs: 20000
}

function side(
  teamId: string,
  teamName: string,
  batters: string[],
  extra: Partial<DjSide> = {}
): DjSide {
  return {
    teamId,
    teamName,
    source: 'lineup',
    canEditWalkUp: false,
    batters: batters.map((name, index) => ({
      userId: index + 1,
      name,
      walkUpSong: null
    })),
    ...extra
  }
}

function game(away: Partial<DjSide> = {}, home: Partial<DjSide> = {}): DjGame {
  return asDjGame({
    away: side('tem_o', 'Owls', ['Otto', 'Olga'], away),
    home: side('tem_t', 'Titan', ['Tom A', 'Bea B', 'Cal C'], home)
  })
}

/** A client that answers DJ Game with whatever `answers` holds next. */
function djClient(answers: Array<DjGame | Error>): GameStationClient & {
  reads: number
} {
  const client = {
    reads: 0,
    djGame: async () => {
      const answer = answers[Math.min(client.reads, answers.length - 1)]
      client.reads++
      if (answer instanceof Error) throw answer
      return answer
    },
    game: async () => ({ startAt: '2026-09-27T17:00:00.000Z' })
  }
  return client as unknown as GameStationClient & { reads: number }
}

/** The app's socket, as a test drives it. */
class FakeSocket implements DjSocket {
  connected = true
  readonly listeners = new Map<string, Set<(event: GameSocketEvent) => void>>()
  readonly statuses = new Set<(connected: boolean) => void>()
  onStatus(listener: (connected: boolean) => void): () => void {
    this.statuses.add(listener)
    return () => {
      this.statuses.delete(listener)
    }
  }

  subscribe(
    gameId: string,
    listener: (event: GameSocketEvent) => void
  ): () => void {
    const set = this.listeners.get(gameId) ?? new Set()
    set.add(listener)
    this.listeners.set(gameId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(gameId)
    }
  }

  async emit(gameId: string, event: GameSocketEvent): Promise<void> {
    await act(async () => {
      for (const listener of this.listeners.get(gameId) ?? []) listener(event)
      await delay(20)
    })
  }

  async status(connected: boolean): Promise<void> {
    await act(async () => {
      this.connected = connected
      for (const listener of this.statuses) listener(connected)
      await delay(5)
    })
  }
}

function fakeMusic(): WalkUpMusic & { played: string[]; stops: number[] } {
  const listeners = new Set<(state: PlaybackState) => void>()
  const played: string[] = []
  const stops: number[] = []
  return {
    available: true,
    providerName: 'Files',
    access: async () => 'authorized',
    search: async () => [],
    pickFile: async () => null,
    play: async handle => {
      played.push(handle)
    },
    stop: async fadeMs => {
      stops.push(fadeMs)
    },
    onState: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    played,
    stops
  }
}

async function render(
  props: Partial<DjGameScreenProps> & { client: GameStationClient }
): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <DjGameScreen gameId="g1" music={fakeMusic()} {...props} />
      </ThemeProvider>
    )
    await delay(30)
  })
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  clock?.restore()
  clock = undefined
  document.body.innerHTML = ''
})

describe('DJ Game’s team pill (U29)', function () {
  it('is the roster editor’s: team names in the halves, Away and Home above', async function () {
    await render({ client: djClient([game()]) })
    const away = labelled('Away Team')
    const home = labelled('Home Team')
    expect(away?.textContent).equals('Owls')
    expect(home?.textContent).equals('Titan')
    const captions = document.querySelector(
      '[data-testid="Roster selector captions"]'
    )
    expect(captions?.textContent).equals('AwayHome')
    // The name is not said again under the pill.
    expect(text().split('Titan').length - 1).equals(2) // matchup + pill
    expect(text()).includes('Owls @ Titan')
  })

  it('opens on Home for both or neither, and on the side you keep songs for', async function () {
    await render({ client: djClient([game()]) })
    expect(labelled('Home Team')?.getAttribute('aria-selected')).equals('true')
    expect(names()[0]).includes('Tom A')
    await act(async () => {
      root?.unmount()
    })
    await render({ client: djClient([game({ canEditWalkUp: true })]) })
    expect(labelled('Away Team')?.getAttribute('aria-selected')).equals('true')
    expect(names()[0]).includes('Otto')
    await act(async () => {
      root?.unmount()
    })
    await render({
      client: djClient([game({ canEditWalkUp: true }, { canEditWalkUp: true })])
    })
    expect(labelled('Home Team')?.getAttribute('aria-selected')).equals('true')
  })

  it('switches lists, and tells the shell which side is showing', async function () {
    const sides: string[] = []
    await render({
      client: djClient([game()]),
      onSide: next => sides.push(next)
    })
    await press('Away Team')
    expect(names().map(row => row.split('No walk')[0])).deep.equals([
      'Otto',
      'Olga'
    ])
    expect(sides).deep.equals(['away'])
  })

  it('comes back on the side it was left on', async function () {
    await render({ client: djClient([game()]), side: 'away' })
    expect(labelled('Away Team')?.getAttribute('aria-selected')).equals('true')
  })

  it('opens on the team at bat, with that batter outlined', async function () {
    await render({
      client: djClient([{ ...game(), atBat: { side: 'away', userId: 1 } }])
    })
    expect(labelled('Away Team')?.getAttribute('aria-selected')).equals('true')
    const marks = document.querySelectorAll('[data-testid="DJ at bat"]')
    expect(marks.length).equals(1)
    expect(marks[0].parentElement?.textContent).includes('Otto')
  })

  it('fades to the next batter, and moves the pill when the half changes', async function () {
    const socket = new FakeSocket()
    const sides: string[] = []
    const client = djClient([
      { ...game(), atBat: { side: 'away', userId: 1 } },
      { ...game(), atBat: { side: 'away', userId: 2 } },
      { ...game(), atBat: { side: 'home', userId: 2 } }
    ])
    await render({
      client,
      socket,
      onSide: next => sides.push(next)
    })
    expect(
      document.querySelector('[data-testid="DJ at bat"]')?.parentElement
        ?.textContent
    ).includes('Otto')
    const change = {
      type: 'change',
      gameId: 'g1',
      kind: 'plays',
      at: '',
      data: {}
    } as unknown as GameSocketEvent
    await socket.emit('g1', change)
    await act(async () => {
      await delay(AT_BAT_FADE_MS * 2 + 40)
    })
    expect(labelled('Away Team')?.getAttribute('aria-selected')).equals('true')
    expect(sides).deep.equals([])
    expect(
      document.querySelector('[data-testid="DJ at bat"]')?.parentElement
        ?.textContent
    ).includes('Olga')
    await socket.emit('g1', change)
    await act(async () => {
      await delay(AT_BAT_FADE_MS * 2 + 40)
    })
    expect(labelled('Home Team')?.getAttribute('aria-selected')).equals('true')
    expect(sides).deep.equals(['home'])
    expect(
      document.querySelector('[data-testid="DJ at bat"]')?.parentElement
        ?.textContent
    ).includes('Bea B')
  })
})

describe('DJ Game’s list (U29)', function () {
  it('is the batting order, with no note for the game’s own lineup', async function () {
    await render({ client: djClient([game()]) })
    expect(names().map(row => row.split('No walk')[0])).deep.equals([
      'Tom A',
      'Bea B',
      'Cal C'
    ])
    expect(document.querySelector('[data-testid="DJ source note"]')).equals(
      null
    )
  })

  it('says when it shows the default or the roster', async function () {
    await render({
      client: djClient([game({ source: 'roster' }, { source: 'default' })])
    })
    expect(text()).includes(
      'Lineup not set for this game — showing the team’s default'
    )
    await press('Away Team')
    expect(text()).includes('No lineup yet — showing the roster')
  })

  it('offers Retry when it cannot load, and loads again', async function () {
    const client = djClient([new Error('offline'), game()])
    await render({ client })
    expect(text()).includes('Cannot load this game’s lineups.')
    expect(names()).deep.equals([])
    await press('Retry')
    expect(names().length).equals(3)
  })
})

describe('DJ Game on the socket (U29)', function () {
  it('subscribes while shown and unsubscribes when it goes', async function () {
    const socket = new FakeSocket()
    await render({ client: djClient([game()]), socket })
    expect(socket.listeners.get('g1')?.size).equals(1)
    expect(socket.statuses.size).equals(1)
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(socket.listeners.has('g1')).equals(false)
    expect(socket.statuses.size).equals(0)
  })

  it('reads again on lineups, plays and resync', async function () {
    const socket = new FakeSocket()
    const client = djClient([
      game(),
      game({}, side('tem_t', 'Titan', ['Tom A', 'Pinch', 'Cal C'])),
      game(),
      game({}, side('tem_t', 'Titan', ['Zed']))
    ])
    await render({ client, socket })
    expect(client.reads).equals(1)
    const change = (kind: 'lineups' | 'plays'): GameSocketEvent =>
      ({
        type: 'change',
        gameId: 'g1',
        kind,
        at: '',
        data: {}
      }) as unknown as GameSocketEvent
    await socket.emit('g1', change('lineups'))
    expect(client.reads).equals(2)
    expect(names()[1]).includes('Pinch')
    await socket.emit('g1', change('plays'))
    expect(client.reads).equals(3)
    await socket.emit('g1', { type: 'resync', gameId: 'g1' })
    expect(client.reads).equals(4)
    expect(names().length).equals(1)
    // A game status change is not about the list.
    await socket.emit('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'game',
      at: '',
      data: { status: 'final', awayScore: 1, homeScore: 2 }
    })
    expect(client.reads).equals(4)
  })

  it('patches one row for a song change, without reading again', async function () {
    const socket = new FakeSocket()
    const client = djClient([game()])
    await render({ client, socket })
    await socket.emit('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'walkUpSong',
      at: '',
      data: { teamId: 'tem_t', userId: 2, song: walk }
    })
    expect(client.reads).equals(1)
    expect(names()[1]).includes('Walk · Band')
    expect(names()[0]).includes('No walk-up song')
    // Another team's song for the same user id changes nothing here.
    await socket.emit('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'walkUpSong',
      at: '',
      data: { teamId: 'tem_x', userId: 1, song: walk }
    })
    expect(names()[0]).includes('No walk-up song')
    await socket.emit('g1', {
      type: 'change',
      gameId: 'g1',
      kind: 'walkUpSong',
      at: '',
      data: { teamId: 'tem_t', userId: 2, song: null }
    })
    expect(names()[1]).includes('No walk-up song')
  })

  it('polls only while the socket is down', async function () {
    clock = pollClock(40)
    const socket = new FakeSocket()
    const client = djClient([game()])
    await render({ client, socket, pollMs: 40 })
    expect(clock.running()).equals(0)
    for (let i = 0; i < 3; i++) await clock.tick()
    expect(client.reads).equals(1)
    await socket.status(false)
    expect(clock.running()).equals(1)
    for (let i = 0; i < 3; i++) await clock.tick()
    expect(client.reads).equals(4)
    await socket.status(true)
    expect(clock.running()).equals(0)
    for (let i = 0; i < 3; i++) await clock.tick()
    expect(client.reads).equals(4)
  })

  it('polls while the server has refused the game (internal), until it is subscribed again', async function () {
    clock = pollClock(40)
    const socket = new FakeSocket()
    const client = djClient([game()])
    await render({ client, socket, pollMs: 40 })
    expect(clock.running()).equals(0)
    // Other refusals are not the server failing: still no poll.
    await socket.emit('g1', {
      type: 'error',
      gameId: 'g1',
      code: 'tooMany',
      message: 'Too many'
    })
    expect(clock.running()).equals(0)
    await socket.emit('g1', {
      type: 'error',
      gameId: 'g1',
      code: 'internal',
      message: 'The server could not subscribe; try again'
    })
    expect(socket.connected).equals(true)
    expect(clock.running()).equals(1)
    for (let i = 0; i < 3; i++) await clock.tick()
    expect(client.reads).equals(4)
    await socket.emit('g1', { type: 'subscribed', gameId: 'g1' })
    expect(clock.running()).equals(0)
    // The answer that ends the refusal reads the list once, in case a change
    // came after the last poll.
    expect(client.reads).equals(5)
    // The list's own batched update after that read settles inside act.
    await act(async () => {
      await delay(100)
    })
    for (let i = 0; i < 3; i++) await clock.tick()
    expect(client.reads).equals(5)
    // A later subscribed (a reconnect's) reads nothing more by itself.
    await socket.emit('g1', { type: 'subscribed', gameId: 'g1' })
    expect(client.reads).equals(5)
  })

  it('recovers from "Cannot load" when the refusal ends, with no Retry', async function () {
    clock = pollClock(40)
    const socket = new FakeSocket()
    const down = new Error('down')
    const client = djClient([down, down, down, game()])
    await render({ client, socket, pollMs: 40 })
    await socket.emit('g1', {
      type: 'error',
      gameId: 'g1',
      code: 'internal',
      message: 'The server could not subscribe; try again'
    })
    for (let i = 0; i < 2; i++) await clock.tick()
    expect(client.reads).equals(3)
    expect(text()).includes('Cannot load')
    await socket.emit('g1', { type: 'subscribed', gameId: 'g1' })
    expect(text()).not.includes('Cannot load')
    expect(names()[0]).includes('Tom A')
  })

  it('polls with no socket at all', async function () {
    clock = pollClock(40)
    const client = djClient([game()])
    await render({ client, pollMs: 40 })
    expect(clock.running()).equals(1)
    for (let i = 0; i < 3; i++) await clock.tick()
    expect(client.reads).equals(4)
  })

  it('holds an update while a finger is down, and shows it on release', async function () {
    const socket = new FakeSocket()
    const client = djClient([
      game(),
      game({}, side('tem_t', 'Titan', ['Pinch', 'Bea B', 'Cal C']))
    ])
    await render({ client, socket })
    const list = document.querySelector('[data-testid="DJ list"]')
    await act(async () => {
      list?.dispatchEvent(touch('touchstart'))
    })
    await socket.emit('g1', { type: 'resync', gameId: 'g1' })
    expect(client.reads).equals(2)
    expect(names()[0]).includes('Tom A')
    await act(async () => {
      list?.dispatchEvent(touch('touchend'))
      // A browser follows a tap with emulated mouse events, and React Native
      // Web ignores the mouse until the emulated mouseup arrives. Without it
      // the next test's mouse drag would be ignored.
      document.dispatchEvent(touch('mouseup'))
    })
    expect(names()[0]).includes('Pinch')
  })
})

describe('DJ Game’s rows on the screen (U29)', function () {
  it('opens the picker for an editable player, never a placeholder', async function () {
    const opened: string[] = []
    const withGuest = game(
      {},
      {
        canEditWalkUp: true,
        batters: [
          { userId: 1, name: 'Tom A', walkUpSong: walk },
          { userId: null, name: 'Guest', walkUpSong: null }
        ]
      }
    )
    await render({
      client: djClient([withGuest]),
      onEditSong: (teamId, batter, song) => {
        opened.push(`${teamId}:${batter.userId}:${song?.title ?? '-'}`)
      }
    })
    await press('Set Tom A’s walk-up song')
    expect(opened).deep.equals(['tem_t:1:Walk'])
    expect(labelled('Set Guest’s walk-up song')).equals(null)
  })

  it('plays a found song, keeps it playing across the pill, and stops it on leaving', async function () {
    const music = fakeMusic()
    const playing = game(
      {
        batters: [{ userId: 9, name: 'Otto', walkUpSong: walk }]
      },
      {
        batters: [{ userId: 1, name: 'Tom A', walkUpSong: walk }]
      }
    )
    await render({
      client: djClient([playing]),
      music,
      resolve: async (_song, owner) => `file:${owner.teamId}:${owner.userId}`
    })
    await press('Play Tom A’s walk-up song')
    expect(music.played).deep.equals(['file:tem_t:1'])
    await press('Away Team')
    expect(music.stops).deep.equals([])
    await press('Play Otto’s walk-up song')
    expect(music.played).deep.equals(['file:tem_t:1', 'file:tem_o:9'])
    await press('Stop Otto’s walk-up song')
    expect(music.stops).deep.equals([1500])
    await press('Play Otto’s walk-up song')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    expect(music.stops).deep.equals([1500, 0])
  })

  it('dims a song that is not on this phone, and says so on a tap', async function () {
    const music = fakeMusic()
    await render({
      client: djClient([
        game({}, { batters: [{ userId: 1, name: 'Tom A', walkUpSong: walk }] })
      ]),
      music,
      resolve: async () => null
    })
    await press('Play Tom A’s walk-up song')
    expect(music.played).deep.equals([])
    expect(text()).includes('Walk isn’t on this phone')
  })
})
