import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asGameDetail, type GameDetail } from '../../common/api'
import type { StoredGame } from '../../common/scoring/session'
import {
  finalGame,
  inProgressGame,
  REPLAY_GAME_ID,
  REPLAY_TEAMS,
  scored
} from '../../test/replayGameFixture'
import type { ScreenRect } from '../field/catcherBounds'
import type { FieldCanvas } from '../field/FieldCanvas'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  DECK_SHARE,
  GameReplayScreen,
  type ReplayClient,
  replayLayout,
  SIDE_CARD_ROOM
} from './GameReplayScreen'

type FieldProps = Parameters<typeof FieldCanvas>[0]
interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
}

let container: HTMLElement | undefined
let root: Root | undefined
let now = 0

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = undefined
  root = undefined
})

function find(
  fiber: Fiber | null | undefined,
  name: string
): Fiber | undefined {
  for (let node = fiber; node != null; node = node.sibling) {
    if (typeof node.type === 'function' && node.type.name === name) return node
    const inside = find(node.child, name)
    if (inside != null) return inside
  }
  return undefined
}

/** The replay's props to the field, read from React's tree. */
function field(): FieldProps {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )
  const host = (container as unknown as Record<string, Fiber>)[key ?? '']
  const current = (host as { stateNode?: { current?: Fiber } }).stateNode
    ?.current
  const found = find(current ?? host, 'FieldCanvas')
  if (found == null) throw new Error('The field has not rendered')
  return found.memoizedProps as FieldProps
}

function gameOf(fields: Partial<GameDetail> = {}): GameDetail {
  return {
    ...asGameDetail({
      nonMemberView: false,
      id: REPLAY_GAME_ID,
      awayTeamId: REPLAY_TEAMS.away.id,
      homeTeamId: REPLAY_TEAMS.home.id,
      awayTeamName: REPLAY_TEAMS.away.name,
      homeTeamName: REPLAY_TEAMS.home.name,
      seasonId: null,
      startAt: null,
      venue: null,
      status: 'final',
      homeScore: 3,
      awayScore: 2,
      ingestStatus: 'none',
      ingestMessage: null,
      videos: [],
      replayable: true
    }),
    ...fields
  }
}

/** The window React Native for Web measures: the root element's size. */
function resize(width: number, height: number): void {
  const root = document.documentElement
  Object.defineProperty(root, 'clientWidth', {
    configurable: true,
    value: width
  })
  Object.defineProperty(root, 'clientHeight', {
    configurable: true,
    value: height
  })
  window.dispatchEvent(new window.Event('resize'))
}

const wait = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

interface Shown {
  exits: number
  notReplayable: number
  /** Renders the screen again, as the shell does, with new callbacks. */
  rerender: () => Promise<void>
}

async function show(
  game: GameDetail,
  stored: Promise<StoredGame> | StoredGame,
  client?: ReplayClient
): Promise<Shown> {
  const events = await stored
  const reader = client ?? {
    game: async () => game,
    gameEvents: async () => events
  }
  const render = async (): Promise<void> => {
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GameReplayScreen
            client={reader}
            gameId={game.id}
            onExit={() => {
              shown.exits++
            }}
            onNotReplayable={() => {
              shown.notReplayable++
            }}
            clock={() => now}
          />
        </ThemeProvider>
      )
    })
  }
  const shown: Shown = { exits: 0, notReplayable: 0, rerender: render }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  now = 0
  await render()
  await wait(50)
  return shown
}

function byLabel(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node =>
      node.getAttribute('aria-label') === label || node.textContent === label
  )
}

async function press(label: string): Promise<void> {
  const node = byLabel(label)
  expect(node, label).not.equals(undefined)
  await act(async () => {
    node!.click()
  })
}

const card = (): string =>
  document.querySelector('[data-testid="replay-play-card"]')?.textContent ?? ''

const CATCHER: ScreenRect = { x: 190, y: 300, width: 22, height: 30 }

async function showCatcher(): Promise<void> {
  await act(async () => {
    field().onCatcherBounds?.(CATCHER)
  })
}

describe('the replay screen', function () {
  this.timeout(30000)

  it('lays the box score below the field on a phone and beside it on a wide window', function () {
    expect(replayLayout(402, 874)).deep.equals({
      side: false,
      bottomExtension: Math.round(DECK_SHARE * 874),
      deckTop: 874 - Math.round(DECK_SHARE * 874)
    })
    expect(replayLayout(1440, 900)).deep.equals({
      side: true,
      bottomExtension: SIDE_CARD_ROOM,
      deckTop: 900 - SIDE_CARD_ROOM
    })
  })

  it('opens a finished game on the field, with Exit, the speaker muted, pause, and the box score', async function () {
    resize(402, 874)
    const shown = await show(gameOf(), finalGame())
    const text = document.body.textContent ?? ''
    expect(text).includes('Exit')
    expect(byLabel('Turn announcer on')).not.equals(undefined)
    expect(byLabel('Pause replay')).not.equals(undefined)
    expect(text).includes('Harbor Hawks batting')
    expect(text).includes('Valley Pines pitching')
    // The card waits for the field to say where the catcher is.
    expect(card()).equals('')
    await showCatcher()
    expect(card()).includes('Play ball!')
    expect(field().view).equals('home')
    await press('Exit')
    expect(shown.exits).equals(1)
  })

  it('plays the first pitch on the clock, and holds on pause', async function () {
    resize(402, 874)
    await show(gameOf(), finalGame())
    await showCatcher()
    now = 100
    await wait(250)
    expect(card()).not.includes('Play ball!')
    await press('Pause replay')
    expect(byLabel('Play replay')).not.equals(undefined)
    expect(card()).includes('Paused')
    const paused = card()
    now = 60000
    await wait(250)
    expect(card()).equals(paused)
    await press('Play replay')
    expect(byLabel('Pause replay')).not.equals(undefined)
    expect(card()).not.includes('Paused')
  })

  it('passes the field’s callbacks to the replay, and the field’s pause with it', async function () {
    resize(402, 874)
    await show(gameOf(), finalGame())
    expect(field().presentationPaused).equals(false)
    await press('Pause replay')
    expect(field().presentationPaused).equals(true)
    await press('Play replay')
    await showCatcher()
    now = 100
    await wait(250)
    // With no WebGL the field ends each presentation as it gets it, so the
    // pitch has been thrown and answered.
    expect(field().presentation).equals(null)
    const pitched = card()
    expect(pitched).not.includes('Play ball!')
    await act(async () => {
      field().onPresentationContact?.('stale', -1)
      field().onPresentationDone?.('stale', -1, 'delivery')
      field().onMovementComplete?.('stale', -1)
    })
    expect(card()).equals(pitched)
  })

  it('turns the announcer on and off', async function () {
    resize(402, 874)
    await show(gameOf(), finalGame())
    await press('Turn announcer on')
    expect(byLabel('Turn announcer off')).not.equals(undefined)
    await press('Turn announcer off')
    expect(byLabel('Turn announcer on')).not.equals(undefined)
  })

  it('puts the box score in a column beside the field on a wide window', async function () {
    resize(1440, 900)
    await show(gameOf(), finalGame())
    const deck = document.querySelector<HTMLElement>(
      '[data-testid="replay-box-score"]'
    )
    expect(deck).not.equals(null)
    expect(deck?.parentElement?.style.width).equals('360px')
  })

  it('follows a game in progress from where it stands', async function () {
    resize(402, 874)
    await show(gameOf({ status: 'inProgress' }), inProgressGame())
    await showCatcher()
    expect(card()).not.includes('Play ball!')
    expect(card()).not.equals('')
    expect(byLabel('Pause replay')).not.equals(undefined)
  })

  it('reads the game once, however often the shell renders it', async function () {
    resize(402, 874)
    const reads = { game: 0, events: 0 }
    const shown = await show(gameOf(), finalGame(), {
      game: async () => {
        reads.game++
        return gameOf()
      },
      gameEvents: async () => {
        reads.events++
        return await finalGame()
      }
    })
    await shown.rerender()
    await shown.rerender()
    await wait(100)
    expect(reads).deep.equals({ game: 1, events: 1 })
    expect(document.querySelector('[data-testid="game-replay"]')).not.equals(
      null
    )
  })

  it('shows the game instead when there is nothing to replay', async function () {
    resize(402, 874)
    expect(
      (await show(gameOf({ replayable: false }), finalGame())).notReplayable
    ).equals(1)
    await act(async () => {
      root?.unmount()
    })
    expect((await show(gameOf(), scored([]))).notReplayable).equals(1)
    await act(async () => {
      root?.unmount()
    })
    expect(
      (
        await show(gameOf(), finalGame(), {
          game: async () => {
            throw new Error('offline')
          },
          gameEvents: async () => await finalGame()
        })
      ).notReplayable
    ).equals(1)
    expect(document.querySelector('[data-testid="game-replay"]')).equals(null)
  })

  it('ends on the final score with the pause button gone', async function () {
    resize(402, 874)
    await show(gameOf({ status: 'inProgress' }), finalGame())
    await showCatcher()
    expect(card()).includes('Valley Pines win')
    expect(byLabel('Pause replay')).equals(undefined)
  })
})
