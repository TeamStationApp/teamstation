import { expect } from 'chai'
import { afterEach, before, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  type GameDetail,
  TeamStationClient
} from '../../common/api'
import type { GameSocket, GameSocketEvent } from '../../common/gameSocket'
import type { StoredGame } from '../../common/scoring/session'
import { editsBetween, liveGames } from '../../test/playsLive'
import { finalGame, inProgressGame } from '../../test/replayGameFixture'
import { NoticesProvider, ScreenNotices } from '../../test/screenNotices'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

const notices = new ScreenNotices()

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

function fixture(fields: Partial<GameDetail> = {}): {
  client: TeamStationClient
  game: GameDetail
  reads: string[]
} {
  const game = {
    ...asGameDetail({
      id: 'g1',
      nonMemberView: false,
      homeTeamId: 'home',
      awayTeamId: 'away',
      homeTeamName: 'Valley Pines',
      awayTeamName: 'Harbor Hawks',
      seasonId: null,
      startAt: '2027-04-10T18:00:00Z',
      endAt: '2027-04-10T20:00:00Z',
      venue: null,
      status: 'final',
      homeScore: 2,
      awayScore: 3,
      ingestStatus: 'none',
      ingestMessage: null,
      videos: [],
      canScore: false,
      assignedRoles: { away: [], home: [] },
      hasScoringEvents: true
    }),
    ...fields
  }
  const reads: string[] = []
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({ ...game })
  client.teams = async () => []
  client.roster = async () => []
  client.boxScore = async () => ({
    batting: [],
    pitching: [],
    stats: undefined
  })
  client.gameEvents = async gameId => {
    reads.push(gameId)
    return stored
  }
  return { client, game, reads }
}

let stored: StoredGame

async function render(
  props: Omit<React.ComponentProps<typeof GameScreen>, 'signedIn'> & {
    signedIn?: boolean | null
  }
): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <NoticesProvider notices={notices}>
          <GestureHandlerRootView>
            <GameScreen signedIn {...props} />
          </GestureHandlerRootView>
        </NoticesProvider>
      </ThemeProvider>
    )
  })
  await settle()
}

async function settle(milliseconds = 50): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
  })
}

const selected = (): string | null =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ??
  null

const pills = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')].map(
    tab => tab.textContent ?? ''
  )

async function choose(label: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLElement>(`[role="tab"][aria-label="${label}"]`)!
      .click()
  })
  await settle()
}

const shown = (testId: string): boolean =>
  document.querySelector(`[data-testid="${testId}"]`) != null

const MEMBERS_ONLY =
  "You need to be a member of one of these teams to see this game's Plays."

describe('the Plays tab', function () {
  this.timeout(20000)
  before(async () => {
    stored = await finalGame()
  })

  it('shows the stream from its pill, read once', async () => {
    const { client, reads } = fixture()
    const tabs: string[] = []
    await render({
      client,
      gameId: 'g1',
      onTab: tab => {
        tabs.push(tab)
      }
    })
    expect(pills()).deep.equals(['Box score', 'Videos', 'Plays', 'Info'])
    expect(selected()).equals('Box score')
    expect(reads).deep.equals([])
    await choose('Plays')
    expect(selected()).equals('Plays')
    expect(shown('plays-stream')).equals(true)
    expect(document.body.textContent).includes('Top 1st')
    expect(reads).deep.equals(['g1'])
    expect(tabs).deep.equals(['plays'])
    await choose('Info')
    await choose('Plays')
    expect(shown('plays-stream')).equals(true)
  })

  it('opens on Plays from the address', async () => {
    const { client, reads } = fixture()
    const tabs: string[] = []
    await render({
      client,
      gameId: 'g1',
      initialTab: 'plays',
      onTab: tab => {
        tabs.push(tab)
      }
    })
    expect(selected()).equals('Plays')
    expect(shown('plays-stream')).equals(true)
    expect(reads).deep.equals(['g1'])
    expect(tabs).deep.equals([])
  })

  it('shows the at-bat in progress of a game being scored', async () => {
    const live = await inProgressGame()
    const before = stored
    stored = live
    try {
      const { client } = fixture({ status: 'inProgress', homeScore: 0 })
      await render({ client, gameId: 'g1', initialTab: 'plays' })
      expect(
        document.querySelector(
          `[data-testid="plays-line-${live.currentPlay!.about.atBatIndex}"]`
        )
      ).not.equals(null)
      expect(document.body.textContent).includes('batting, ')
    } finally {
      stored = before
    }
  })

  it('asks a non-member to become a member, never reads the plays, and ignores the socket on Plays', async () => {
    const { client, reads } = fixture({ nonMemberView: true })
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
    expect(pills()).includes('Plays')
    await choose('Plays')
    expect(document.body.textContent).includes(MEMBERS_ONLY)
    expect(shown('plays-members-only')).equals(true)
    const before = document.querySelector(
      '[data-testid="eventTabContent"]'
    )!.textContent
    await act(async () => {
      listener?.({
        type: 'change',
        gameId: 'g1',
        kind: 'playEdits',
        at: new Date().toISOString(),
        data: {
          generation: 0,
          fromDigest: 'd0',
          digest: 'd1',
          namesDigest: 'n0',
          edits: [],
          currentPlay: stored.plays[0]
        }
      })
    })
    await settle()
    expect(shown('plays-stream')).equals(false)
    expect(
      document.querySelector('[data-testid="eventTabContent"]')!.textContent
    ).equals(before)
    expect(reads).deep.equals([])
  })

  it('asks a guest to sign in first, and never reads the plays', async () => {
    const { client, reads } = fixture({ nonMemberView: true })
    let signIns = 0
    await render({
      client,
      gameId: 'g1',
      signedIn: false,
      initialTab: 'plays',
      onSignIn: () => {
        signIns++
      }
    })
    expect(selected()).equals('Plays')
    expect(document.body.textContent).includes(MEMBERS_ONLY)
    expect(document.body.textContent).includes(
      'Log in or create an account first to request membership.'
    )
    await act(async () => {
      ;[...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(button => button.textContent === 'Log in / Sign up')!
        .click()
    })
    expect(signIns).equals(1)
    expect(reads).deep.equals([])
  })

  for (const [name, fields, fallback, label] of [
    [
      'a game nobody has pitched in',
      { status: 'scheduled', hasScoringEvents: false, homeScore: null },
      'info',
      'Info'
    ],
    [
      'a final game with no pitch standing',
      { status: 'final', hasScoringEvents: false },
      'boxScore',
      'Box score'
    ]
  ] as const)
    it(`falls back to the default tab for ?tab=plays on ${name}`, async () => {
      const { client, reads } = fixture({
        ...fields,
        startAt: '2099-04-10T18:00:00Z',
        endAt: '2099-04-10T20:00:00Z'
      })
      const tabs: string[] = []
      await render({
        client,
        gameId: 'g1',
        initialTab: 'plays',
        onTab: tab => {
          tabs.push(tab)
        }
      })
      expect(pills()).not.includes('Plays')
      expect(selected()).equals(label)
      expect(shown('plays-stream')).equals(false)
      expect(shown('plays-loading')).equals(false)
      expect(tabs).deep.equals([fallback])
      expect(reads).deep.equals([])
    })
})

/** A game socket the test speaks for: what it sends, every listener hears. */
function fakeSocket(): {
  socket: Pick<GameSocket, 'subscribe'>
  send: (event: GameSocketEvent) => Promise<void>
} {
  const listeners = new Set<(event: GameSocketEvent) => void>()
  return {
    socket: {
      subscribe: (_gameId, listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    send: async event => {
      await act(async () => {
        for (const listener of [...listeners]) listener(event)
      })
      await settle()
    }
  }
}

function playEdits(data: ReturnType<typeof editsBetween>): GameSocketEvent {
  return {
    type: 'change',
    gameId: 'g1',
    kind: 'playEdits',
    at: new Date().toISOString(),
    data
  }
}

describe('the Plays tab of a game being scored', function () {
  this.timeout(30000)
  let games: Awaited<ReturnType<typeof liveGames>>
  before(async () => {
    games = await liveGames()
  })

  // jsdom lays nothing out. Here the stream stands TOP down the page, each
  // line LINE high and each pitch row under an open line PITCH more, and the
  // page that scrolls is VIEWPORT high and as long as what it holds.
  const TOP = 500
  const LINE = 100
  const PITCH = 80
  const VIEWPORT = 800
  let scrollTop = 0
  const original = {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto the prototype it came from
    rect: HTMLElement.prototype.getBoundingClientRect,
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
    clientHeight: Object.getOwnPropertyDescriptor(
      Element.prototype,
      'clientHeight'
    ),
    scrollHeight: Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollHeight'
    )
  }
  const scrolls = (node: Element): boolean =>
    ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)
  const streamHeight = (): number =>
    document.querySelectorAll('[data-testid^="plays-line-"]').length * LINE +
    document.querySelectorAll('[data-testid="plays-pitch"]').length * PITCH
  const spacerHeight = (): number => {
    const height =
      document.querySelector<HTMLElement>('[data-testid="pinnedSpacer"]')?.style
        .height ?? ''
    return height === '' ? 0 : Number.parseFloat(height)
  }
  /**
   * The screen's bottom margin under the stream, as the page opened at its
   * end shows it: the page can always scroll that much further.
   */
  let tail = 0
  /** The farthest the page can scroll with no room kept under the stream. */
  const contentEnd = (): number => TOP + streamHeight() + tail - VIEWPORT
  const page = (): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>('div')].find(
      node =>
        scrolls(node) &&
        node.querySelector('[data-testid="eventTabContent"]') != null
    )!
  const smooth: number[] = []

  beforeEach(function () {
    scrollTop = 0
    tail = 0
    smooth.length = 0
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset.testid === 'eventTabContent') {
        const top = TOP - scrollTop
        const height = streamHeight()
        return { top, bottom: top + height, height } as unknown as DOMRect
      }
      if (scrolls(this))
        return {
          top: 0,
          bottom: VIEWPORT,
          height: VIEWPORT
        } as unknown as DOMRect
      return original.rect.call(this)
    }
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return scrolls(this) ? scrollTop : 0
      },
      set(this: Element, y: number) {
        if (scrolls(this)) scrollTop = y
      }
    })
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        return scrolls(this) ? VIEWPORT : 0
      }
    })
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element) {
        return scrolls(this)
          ? Math.max(VIEWPORT, TOP + streamHeight() + spacerHeight() + tail)
          : 0
      }
    })
    // A smooth scroll lands where it was sent, as the browser's would.
    HTMLElement.prototype.scroll = function (
      this: HTMLElement,
      options?: ScrollToOptions | number
    ) {
      const top = typeof options === 'number' ? options : (options?.top ?? 0)
      smooth.push(top)
      scrollTop = top
      this.dispatchEvent(new window.Event('scroll'))
    }
  })

  afterEach(function () {
    HTMLElement.prototype.getBoundingClientRect = original.rect
    for (const key of ['scrollTop', 'clientHeight', 'scrollHeight'] as const) {
      const descriptor = original[key]
      if (descriptor != null)
        Object.defineProperty(Element.prototype, key, descriptor)
    }
    delete (HTMLElement.prototype as Partial<HTMLElement>).scroll
  })

  /** The stream lays out again, as the browser reports it. */
  async function layOut(): Promise<void> {
    const stream = document.querySelector<
      HTMLElement & { __reactLayoutHandler?: (event: unknown) => void }
    >('[data-testid="plays-stream"]')
    expect(stream, 'the stream').not.equals(null)
    await act(async () => {
      stream!.__reactLayoutHandler?.({
        nativeEvent: {
          layout: { x: 0, y: 0, width: 393, height: streamHeight() }
        },
        timeStamp: Date.now()
      })
    })
    await settle()
  }

  async function scrollTo(y: number): Promise<void> {
    scrollTop = y
    await act(async () => {
      page().dispatchEvent(new window.Event('scroll'))
    })
    // The button fades over 200 ms.
    await settle(280)
  }

  const button = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid="plays-latest"]')

  async function openLive(socket: Pick<GameSocket, 'subscribe'>): Promise<{
    tabs: string[]
    client: TeamStationClient
    game: GameDetail
  }> {
    stored = games.start
    const { client, game } = fixture({ status: 'inProgress', homeScore: 0 })
    const tabs: string[] = []
    await render({
      client,
      gameId: 'g1',
      initialTab: 'plays',
      socket,
      onTab: tab => {
        tabs.push(tab)
      }
    })
    await layOut()
    tail = scrollTop - contentEnd()
    expect(tail).within(0, 200)
    return { tabs, client, game }
  }

  it('opens at the end, following each new play down, until the viewer scrolls up', async () => {
    const { socket, send } = fakeSocket()
    await openLive(socket)
    expect(scrollTop).equals(contentEnd())
    expect(button()).equals(null)
    // A pitch grows the open line: the page goes with it.
    await send(playEdits(editsBetween(games.start, games.pitched)))
    await layOut()
    expect(scrollTop).equals(contentEnd())
    expect(button()).equals(null)
    // Scrolled up, it stays where the viewer put it, and the button shows.
    const up = contentEnd() - 2 * VIEWPORT
    await scrollTo(up)
    expect(button()).not.equals(null)
    expect(button()!.getAttribute('aria-label')).equals('Latest play')
    await send(playEdits(editsBetween(games.pitched, games.stored)))
    await layOut()
    expect(scrollTop).equals(up)
    expect(button()).not.equals(null)
  })

  it('goes back to the end from the button, and following again hides it', async () => {
    const { socket, send } = fakeSocket()
    await openLive(socket)
    await scrollTo(contentEnd() - VIEWPORT)
    expect(button()).not.equals(null)
    await act(async () => {
      button()!.click()
    })
    await settle(280)
    expect(smooth.at(-1)).equals(contentEnd())
    expect(scrollTop).equals(contentEnd())
    expect(button()).equals(null)
    await send(playEdits(editsBetween(games.start, games.pitched)))
    await layOut()
    expect(scrollTop).equals(contentEnd())
  })

  it('follows again when the viewer scrolls back to the end by hand', async () => {
    const { socket } = fakeSocket()
    await openLive(socket)
    const end = contentEnd()
    await scrollTo(end - 300)
    expect(button()).not.equals(null)
    await scrollTo(end)
    expect(button()).equals(null)
  })

  it('leaves no room under the stream when the at-bat in progress is stored and shuts', async () => {
    const { socket, send } = fakeSocket()
    await openLive(socket)
    await send(playEdits(editsBetween(games.start, games.pitched)))
    await layOut()
    const before = streamHeight()
    await send(playEdits(editsBetween(games.pitched, games.stored)))
    await layOut()
    // Two pitch rows went with the line that shut; the next batter's came.
    expect(streamHeight()).lessThan(before)
    expect(scrollTop).equals(contentEnd())
    expect(spacerHeight()).equals(0)
    expect(button()).equals(null)
  })

  it('opens a final game at the top of its plays, with no button', async () => {
    stored = await finalGame()
    const { client } = fixture()
    await render({ client, gameId: 'g1', initialTab: 'plays' })
    await layOut()
    expect(scrollTop).lessThan(contentEnd())
    await scrollTo(contentEnd() - VIEWPORT)
    await scrollTo(10)
    expect(button()).equals(null)
  })

  it('moves a viewer on Plays to the default tab when an undo takes the last pitch away, and back to the pill on the next', async () => {
    const { socket, send } = fakeSocket()
    const { tabs, client, game } = await openLive(socket)
    expect(selected()).equals('Plays')
    client.game = async () => ({ ...game, hasScoringEvents: false })
    await send(playEdits(editsBetween(games.start, games.pitched)))
    expect(pills()).not.includes('Plays')
    expect(selected()).equals('Info')
    expect(shown('plays-stream')).equals(false)
    expect(button()).equals(null)
    expect(tabs).deep.equals(['info'])
    client.game = async () => ({ ...game, hasScoringEvents: true })
    await send(playEdits(editsBetween(games.pitched, games.stored)))
    // Back with the pill; the viewer stays on the game's default section.
    expect(pills()).includes('Plays')
    expect(selected()).not.equals('Plays')
  })
})
