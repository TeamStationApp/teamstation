import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asGameDetail, type GameDetail } from '../../common/api'
import type { GameSocketListener } from '../../common/gameSocket'
import { replayTimelineOf } from '../../common/replay/replayTimeline'
import type { StoredGame } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import {
  finalGame,
  importedThenScoredGame,
  inProgressGame,
  REPLAY_GAME_ID,
  REPLAY_TEAMS,
  replayActions,
  replayContext,
  replaySetup,
  scored
} from '../../test/replayGameFixture'
import type { ScreenRect } from '../field/catcherBounds'
import type { FieldCanvas } from '../field/FieldCanvas'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  CONTROLS_ROW,
  DECK_SHARE,
  EXIT_RESERVE,
  fieldTop,
  FLOATING_BUTTON,
  FLOATING_MARGIN,
  GameReplayScreen,
  type ReplayClient,
  replayIconDrop,
  replayLayout,
  type ReplaySocket,
  SIDE_CARD_ROOM,
  SPEAKER_RESERVE
} from './GameReplayScreen'

type FieldProps = Parameters<typeof FieldCanvas>[0]
interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
}

/** What the fake server says about its announcer, and what it was asked. */
const announcer = {
  health: true as boolean | 'fails',
  audio: 'ok' as 'ok' | 'fails',
  asked: [] as string[],
  /** The steps whose sentences the page played, in order. */
  played: [] as string[]
}

function fakeClient(
  game: () => Promise<GameDetail>,
  events: () => Promise<StoredGame>
): ReplayClient {
  return {
    game,
    gameEvents: events,
    health: async () => {
      if (announcer.health === 'fails') throw new Error('offline')
      return { narration: announcer.health }
    },
    narrationAudio: async (_gameId, step) => {
      announcer.asked.push(step.key)
      if (announcer.audio === 'fails') throw new Error('503')
      return Object.assign(new Blob(['mp3']), { stepKey: step.key })
    },
    narrationReady: async () => {
      throw new Error('a browser downloads the sentence')
    },
    narrationSource: (gameId, step) => ({
      uri: `/games/${gameId}/narrations/${step.key}?count=${step.count}`,
      headers: {}
    })
  }
}

let container: HTMLElement | undefined
let root: Root | undefined
let now = 0

const saved = new Map<string, PropertyDescriptor | undefined>()
const swaps = (): Array<[object, string]> => [
  [window.HTMLMediaElement.prototype, 'play'],
  [window.HTMLMediaElement.prototype, 'pause'],
  [URL, 'createObjectURL'],
  [URL, 'revokeObjectURL']
]

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

/** The props of the element with `testID`, read from React's tree. */
function propsOf(testID: string): Record<string, unknown> {
  const key = Object.keys(container ?? {}).find(name =>
    name.startsWith('__reactContainer$')
  )
  const host = (container as unknown as Record<string, Fiber>)[key ?? '']
  const current =
    (host as { stateNode?: { current?: Fiber } }).stateNode?.current ?? host
  const seek = (fiber: Fiber | null | undefined): Fiber | undefined => {
    for (let node = fiber; node != null; node = node.sibling) {
      const props = node.memoizedProps as { testID?: unknown } | undefined
      if (props?.testID === testID) return node
      const inside = seek(node.child)
      if (inside != null) return inside
    }
    return undefined
  }
  const found = seek(current)
  if (found == null) throw new Error(`Nothing has the testID ${testID}`)
  return found.memoizedProps as Record<string, unknown>
}

/** A style prop, arrays merged as React Native merges them. */
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style))
    return Object.assign({}, ...style.map(item => flat(item)))
  return style != null && typeof style === 'object'
    ? (style as Record<string, unknown>)
    : {}
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
  client?: ReplayClient,
  live: { socket?: ReplaySocket; pollMs?: number } = {}
): Promise<Shown> {
  const events = await stored
  const reader =
    client ??
    fakeClient(
      async () => game,
      async () => events
    )
  const render = async (): Promise<void> => {
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <GameReplayScreen
            client={reader}
            gameId={game.id}
            socket={live.socket}
            pollMs={live.pollMs}
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
  // Loading takes a moment, longer on a busy machine.
  for (
    let i = 0;
    i < 100 &&
    shown.notReplayable === 0 &&
    document.querySelector('[data-testid="game-replay"]') == null;
    i++
  )
    await wait(50)
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

/** On to a replay's first pitch: it opens on "Play ball!" for a moment. */
async function firstPitch(): Promise<void> {
  now = 100
  await wait(250)
  expect(card()).includes('Play ball!')
  now = 2200
  await wait(250)
}

const CATCHER: ScreenRect = { x: 190, y: 300, width: 22, height: 30 }

async function showCatcher(): Promise<void> {
  await act(async () => {
    field().onCatcherBounds?.(CATCHER)
  })
}

describe('the replay screen', function () {
  this.timeout(30000)

  beforeEach(function () {
    announcer.health = true
    announcer.audio = 'ok'
    announcer.asked = []
    announcer.played = []
    // jsdom plays no media and makes no object URLs: a sentence "plays" for
    // a moment and ends, and its URL names its step.
    const values: unknown[] = [
      async function (this: HTMLMediaElement) {
        const src = this.src
        if (src.startsWith('blob:')) {
          announcer.played.push(src.slice('blob:'.length))
          setTimeout(() => {
            this.onended?.(new window.Event('ended'))
          }, 20)
        }
      },
      () => undefined,
      (blob: Blob & { stepKey?: string }) => `blob:${blob.stepKey ?? ''}`,
      () => undefined
    ]
    swaps().forEach(([target, name], i) => {
      saved.set(name, Object.getOwnPropertyDescriptor(target, name))
      Object.defineProperty(target, name, {
        configurable: true,
        value: values[i]
      })
    })
  })

  afterEach(async function () {
    for (const [target, name] of swaps()) {
      const descriptor = saved.get(name)
      if (descriptor == null) Reflect.deleteProperty(target, name)
      else Object.defineProperty(target, name, descriptor)
    }
    await act(async () => {
      root?.unmount()
    })
    container?.remove()
    container = undefined
    root = undefined
  })

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
    await firstPitch()
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
    await firstPitch()
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

  it('names players by first name and last initial on the field and the scoreboard', async function () {
    resize(402, 874)
    const setup = replaySetup()
    for (const [index, player] of Object.values(setup.players).entries())
      player.jersey = String(index + 1)
    await show(gameOf(), finalGame(setup))
    await showCatcher()
    await firstPitch()
    const { players, scoreboard } = field()
    const labels = players.map(player => player.displayName ?? '')
    expect(labels).includes('Juan S')
    expect(labels.some(label => /Soto|Betts|Judge/.test(label))).equals(false)
    expect(scoreboard?.batter.firstName).equals('Juan S')
    expect(scoreboard?.batter.lastName).equals('')
    expect(scoreboard?.pitcher.firstName).match(/^\S+ \S{1,2}$/)
    const juan = Object.values(setup.players).find(
      player => player.fullName === 'Juan Soto'
    )
    expect(juan?.jersey).match(/^\d+$/)
    expect(scoreboard?.batterJersey).equals(juan?.jersey)
    expect(scoreboard?.pitcher.firstName).equals('Tyler G')
    const pitcher = Object.values(setup.players).find(
      player => player.fullName === 'Tyler Glasnow'
    )
    expect(pitcher?.jersey).match(/^\d+$/)
    expect(scoreboard?.pitcherJersey).equals(pitcher?.jersey)
  })

  it('puts the speaker upper left and Exit upper right, and the rewind and pause in the bottom corners', async function () {
    resize(402, 874)
    announcer.health = true
    await show(gameOf(), finalGame())
    expect(flat(propsOf('replay-speaker').style)).deep.include({
      position: 'absolute',
      top: 0,
      left: 16
    })
    expect(flat(propsOf('replay-speaker').style)).not.have.property('right')
    expect(flat(propsOf('replay-exit').style)).deep.include({
      position: 'absolute',
      top: 0,
      right: 16,
      minWidth: 76
    })
    expect(flat(propsOf('replay-exit').style)).not.have.property('left')
    expect(flat(propsOf('replay-rewind').style)).deep.include({ left: 16 })
    expect(flat(propsOf('replay-pause').style)).deep.include({ right: 16 })
  })

  it('drops the glyphs 2 points on a phone, and not on the web', function () {
    expect(replayIconDrop('ios')).equals(2)
    expect(replayIconDrop('android')).equals(2)
    expect(replayIconDrop('web')).equals(0)
  })

  it('leaves the web’s glyphs where they are', async function () {
    resize(402, 874)
    announcer.health = true
    await show(gameOf(), finalGame())
    const icons = document.querySelectorAll<HTMLElement>(
      '[data-testid="replay-icon"]'
    )
    // The speaker's, pause's and rewind's.
    expect(icons.length).equals(3)
    for (const icon of icons) expect(icon.style.transform).equals('')
  })

  it('keeps Exit and the speaker off the scoreboard and the fielders', async function () {
    expect(SPEAKER_RESERVE).equals(68)
    expect(EXIT_RESERVE).equals(100)
    // Clear of both: the field starts at the top.
    expect(
      fieldTop(
        { x: SPEAKER_RESERVE, y: 20, width: 1200 - 100 - 68, height: 120 },
        47,
        1200,
        true
      )
    ).equals(0)
    expect(fieldTop(null, 47, 402, true)).equals(0)
    // Under the speaker only while there is one.
    const left = { x: 30, y: 20, width: 300, height: 120 }
    expect(fieldTop(left, 47, 1200, true)).equals(47 + CONTROLS_ROW)
    expect(fieldTop(left, 47, 1200, false)).equals(0)
    // Under Exit.
    expect(
      fieldTop({ x: 800, y: 20, width: 350, height: 120 }, 47, 1200, false)
    ).equals(47 + CONTROLS_ROW)
    // A phone's board spans the width: the field starts under the controls.
    expect(
      fieldTop({ x: 30, y: 50, width: 340, height: 120 }, 47, 402, true)
    ).equals(47 + CONTROLS_ROW)
    resize(402, 874)
    await show(gameOf(), finalGame())
    await showCatcher()
    const fieldBox = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="replay-field"]')
    expect(['', '0px']).includes(fieldBox()?.style.marginTop ?? '')
    await act(async () => {
      field().onScoreboardBounds?.({ x: 30, y: 50, width: 340, height: 120 })
    })
    const moved = Number.parseFloat(fieldBox()?.style.marginTop ?? '0')
    expect(moved).greaterThanOrEqual(CONTROLS_ROW)
    // Measured again under the controls, the board does not move it twice.
    await act(async () => {
      field().onScoreboardBounds?.({ x: 30, y: 10, width: 340, height: 120 })
    })
    expect(Number.parseFloat(fieldBox()?.style.marginTop ?? '0')).equals(moved)
    // The card still hangs below the catcher, where the field now is.
    const cardTop = Number.parseFloat(
      document.querySelector<HTMLElement>('[data-testid="replay-play-card"]')
        ?.style.top ?? '0'
    )
    expect(cardTop).greaterThan(CATCHER.y + CATCHER.height + moved)
  })

  it('moves the field under Exit when the board reaches the field column’s edge beside the box score', async function () {
    // A phone on its side: the field's column is 874 - 360 = 514 wide.
    resize(874, 402)
    await show(gameOf(), finalGame())
    await showCatcher()
    const fieldBox = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="replay-field"]')
    expect(['', '0px']).includes(fieldBox()?.style.marginTop ?? '')
    await act(async () => {
      field().onScoreboardBounds?.({ x: 200, y: 20, width: 300, height: 100 })
    })
    expect(
      Number.parseFloat(fieldBox()?.style.marginTop ?? '0')
    ).greaterThanOrEqual(CONTROLS_ROW)
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
        await show(
          gameOf(),
          finalGame(),
          fakeClient(
            async () => {
              throw new Error('offline')
            },
            async () => await finalGame()
          )
        )
      ).notReplayable
    ).equals(1)
    expect(document.querySelector('[data-testid="game-replay"]')).equals(null)
  })

  it('reads the game once, however often the shell renders it', async function () {
    resize(402, 874)
    const reads = { game: 0, events: 0 }
    const shown = await show(
      gameOf(),
      finalGame(),
      fakeClient(
        async () => {
          reads.game++
          return gameOf()
        },
        async () => {
          reads.events++
          return await finalGame()
        }
      )
    )
    await shown.rerender()
    await shown.rerender()
    await wait(100)
    expect(reads).deep.equals({ game: 1, events: 1 })
    expect(document.querySelector('[data-testid="game-replay"]')).not.equals(
      null
    )
  })

  it('ends on the final score with the pause button gone', async function () {
    resize(402, 874)
    await show(gameOf({ status: 'inProgress' }), finalGame())
    await showCatcher()
    expect(card()).includes('Valley Pines win')
    expect(byLabel('Pause replay')).equals(undefined)
  })

  describe('rewind', function () {
    const REWIND = 'Rewind half an inning'
    const line = (): HTMLElement | null =>
      document.querySelector('[data-testid="replay-play-card-line"]')

    it("sits at the bottom left in the pause button's own look", async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      const rewind = byLabel(REWIND)
      expect(rewind).not.equals(undefined)
      expect(rewind?.textContent).equals('skip_previous')
      const rewindStyle = flat(propsOf('replay-rewind').style)
      const pauseStyle = flat(propsOf('replay-pause').style)
      expect(rewindStyle).deep.equals({ ...FLOATING_BUTTON, left: 16 })
      expect(pauseStyle).deep.equals({ ...FLOATING_BUTTON, right: 16 })
      expect(FLOATING_MARGIN).equals(16)
      expect(FLOATING_BUTTON.bottom).equals(FLOATING_MARGIN)
    })

    it('stays after the end, when pause has gone', async function () {
      resize(402, 874)
      await show(gameOf({ status: 'inProgress' }), finalGame())
      await showCatcher()
      expect(byLabel('Pause replay')).equals(undefined)
      expect(byLabel(REWIND)).not.equals(undefined)
    })

    it('centres the box score, as wide as its widest row', async function () {
      resize(1024, 1366)
      await show(gameOf(), importedThenScoredGame())
      const scroll = propsOf('replay-box-score')
      expect(flat(scroll.contentContainerStyle).alignItems).equals('center')
      // The line score and the tables centre apart, so a long game's line
      // score that fills a phone leaves the tables centred.
      for (const id of ['replay-box-score-line', 'replay-box-score-column'])
        expect(flat(propsOf(id).style)).deep.equals({
          alignSelf: 'center',
          maxWidth: '100%'
        })
      const line = document.querySelector(
        '[data-testid="replay-box-score-line"]'
      )
      const tables = document.querySelector(
        '[data-testid="replay-box-score-column"]'
      )
      expect(line?.contains(tables)).equals(false)
      expect(line?.textContent).includes('R')
      expect(tables?.textContent).includes('batting')
      // The imported-plays note spans the deck, centred, outside the column.
      const note = [...document.querySelectorAll('div')].find(node =>
        (node.textContent ?? '').startsWith('Stats from the')
      )
      expect(note).not.equals(undefined)
      const column = document.querySelector(
        '[data-testid="replay-box-score-column"]'
      )
      expect(column?.contains(note!)).equals(false)
    })

    it('writes where it went on the card, then plays on from there', async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      await firstPitch()
      now = 2200 + 4600
      await wait(250)
      expect(card()).not.includes('Play ball!')
      await press(REWIND)
      expect(line()?.textContent).equals('Rewind to top of first')
      expect(card()).includes('0–0 · 0 outs')
      // The card is the same brown card; only its words changed.
      expect(
        document.querySelector('[data-testid="replay-play-card"]')
      ).not.equals(null)
      now += 2000 - 100
      await wait(250)
      expect(line()?.textContent).equals('Rewind to top of first')
      now += 100
      await wait(250)
      expect(line()?.textContent).not.includes('Rewind')
      expect(line()?.textContent).includes('steps in')
    })

    it('holds the words, then fades them, and starts again on the next tap', async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      await firstPitch()
      await press('Pause replay')
      const at = now
      await press(REWIND)
      const opacity = (): number => {
        const value = line()?.style.opacity ?? ''
        return value === '' ? 1 : Number(value)
      }
      expect(opacity()).equals(1)
      now = at + 1400
      await wait(100)
      expect(opacity()).equals(1)
      now = at + 1700
      await wait(100)
      expect(opacity()).closeTo(0.5, 0.01)
      now = at + 1990
      await wait(100)
      expect(opacity()).lessThan(0.05)
      // Paused, the words still go, and the card shows the game again.
      now = at + 2000
      await wait(150)
      expect(line()?.textContent).not.includes('Rewind')
      expect(card()).includes('Paused')
      await press(REWIND)
      await wait(100)
      expect(opacity()).equals(1)
      expect(line()?.textContent).equals('Rewind to top of first')
    })

    it('stops the announcer, and reads the rewound steps again', async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      await press('Turn announcer on')
      await firstPitch()
      const freed: string[] = []
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: (url: string) => freed.push(url)
      })
      // The first sentence read to its end and its clip freed.
      for (let i = 0; i < 40 && !freed.includes('blob:0-0'); i++) await wait(50)
      expect(announcer.played).includes('0-0')
      expect(freed).includes('blob:0-0')
      const pauses: number[] = []
      Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        value: () => pauses.push(1)
      })
      const asked = announcer.asked.length
      await press(REWIND)
      expect(pauses.length).greaterThan(0)
      // During the words, before the first rewound step is shown, the half's
      // first sentence, already read and freed, is fetched again; the second
      // was fetched ahead before the tap and is kept.
      await wait(100)
      expect(line()?.textContent).equals('Rewind to top of first')
      expect(announcer.asked.slice(asked)).deep.equals(['0-0'])
      now += 2000
      for (
        let i = 0;
        i < 40 && announcer.played.filter(key => key === '0-0').length < 2;
        i++
      )
        await wait(50)
      expect(announcer.played.filter(key => key === '0-0')).length(2)
    })
  })

  describe('the announcer', function () {
    it('is offered only by a server that has one', async function () {
      resize(402, 874)
      announcer.health = false
      await show(gameOf(), finalGame())
      expect(byLabel('Turn announcer on')).equals(undefined)
      expect(byLabel('Exit')).not.equals(undefined)
      await act(async () => {
        root?.unmount()
      })
      announcer.health = 'fails'
      await show(gameOf(), finalGame())
      expect(byLabel('Turn announcer on')).equals(undefined)
    })

    it('reads nothing while muted, and each step once the speaker is on', async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      now = 100
      await wait(250)
      expect(announcer.asked).deep.equals([])
      await press('Turn announcer on')
      expect(byLabel('Turn announcer off')).not.equals(undefined)
      // The two steps ahead are fetched at once, and the next as each plays.
      await wait(50)
      expect(announcer.asked).deep.equals(['0-0', '0-1'])
      now = 2200
      await wait(300)
      expect(announcer.asked).deep.equals(['0-0', '0-1', '0-2'])
      await press('Turn announcer off')
      expect(byLabel('Turn announcer on')).not.equals(undefined)
    })

    it('turns itself off and says so after three sentences fail', async function () {
      resize(402, 874)
      announcer.audio = 'fails'
      await show(gameOf(), finalGame())
      await showCatcher()
      await press('Turn announcer on')
      await firstPitch()
      // Each sentence fails as its step is shown; the third turns it off.
      expect(card()).not.includes('Announcer unavailable')
      for (
        let i = 0;
        i < 20 && !card().includes('Announcer unavailable');
        i++
      ) {
        now += 5000
        await wait(150)
      }
      expect(announcer.asked.length).greaterThanOrEqual(3)
      expect(card()).includes('Announcer unavailable')
      expect(byLabel('Turn announcer on')).not.equals(undefined)
      announcer.audio = 'ok'
      await press('Turn announcer on')
      expect(card()).not.includes('Announcer unavailable')
    })

    it('reads the final call when the replay reaches it', async function () {
      this.timeout(120000)
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      await press('Turn announcer on')
      for (let i = 0; i < 1200 && !announcer.played.includes('9999-1'); i++) {
        now += 20000
        await wait(120)
        // jsdom draws no field: its runners arrive at once.
        await act(async () => {
          for (const player of field().players)
            if (player.motion != null && !player.motion.reported)
              field().onMovementComplete?.(
                player.motion.id,
                player.motion.generation
              )
        })
      }
      expect(card()).includes("That's the ballgame")
      expect(announcer.played.at(-1)).equals('9999-1')
      expect(announcer.played.at(-2)).equals('20-3')
    })

    it('opens muted every time', async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      await press('Turn announcer on')
      await act(async () => {
        root?.unmount()
      })
      await show(gameOf(), finalGame())
      expect(byLabel('Turn announcer on')).not.equals(undefined)
    })
  })

  describe('following a game', function () {
    /** A socket the test speaks for. */
    class FakeSocket implements ReplaySocket {
      connected = true
      listeners = new Map<string, GameSocketListener>()
      statuses = new Set<(connected: boolean) => void>()
      onStatus(listener: (connected: boolean) => void): () => void {
        this.statuses.add(listener)
        return () => this.statuses.delete(listener)
      }

      subscribe(gameId: string, listener: GameSocketListener): () => void {
        this.listeners.set(gameId, listener)
        return () => this.listeners.delete(gameId)
      }

      async emit(event: Parameters<GameSocketListener>[0]): Promise<void> {
        await act(async () => {
          this.listeners.get(REPLAY_GAME_ID)?.(event)
          await new Promise(resolve => setTimeout(resolve, 30))
        })
      }

      async status(connected: boolean): Promise<void> {
        this.connected = connected
        await act(async () => {
          for (const listener of this.statuses) listener(connected)
        })
      }
    }

    const actions = replayActions()
    /** A change as the server sends it: a `plays` change carries the game. */
    const change = (
      kind: 'plays' | 'walkUpSong',
      stored?: StoredGame
    ): Parameters<GameSocketListener>[0] =>
      kind === 'plays'
        ? {
            type: 'change',
            gameId: REPLAY_GAME_ID,
            kind,
            at: '',
            data:
              stored == null
                ? { plays: [{ broken: true }], currentPlay: null, digest: 'd0' }
                : {
                    plays: stored.plays.map((gumbo, index) => ({
                      id: `evt_${index}`,
                      gameId: REPLAY_GAME_ID,
                      gumbo
                    })),
                    currentPlay: stored.currentPlay,
                    digest: `d${stored.plays.length}`
                  }
          }
        : {
            type: 'change',
            gameId: REPLAY_GAME_ID,
            kind,
            at: '',
            data: { teamId: 't', userId: userIdOfGumbo(1), song: null }
          }

    async function following(
      socket?: FakeSocket,
      pollMs?: number
    ): Promise<{
      setStored: (count: number) => Promise<StoredGame>
      reads: () => number
      setStatus: (status: GameDetail['status']) => void
    }> {
      let stored = await scored(actions.slice(0, 10))
      let reads = 0
      let status: GameDetail['status'] = 'inProgress'
      const game = gameOf({ status: 'inProgress' })
      await show(
        game,
        stored,
        fakeClient(
          async () => ({ ...game, status }),
          async () => {
            reads++
            return stored
          }
        ),
        { socket, pollMs }
      )
      await showCatcher()
      reads = 0
      return {
        setStored: async count => {
          stored = await scored(actions.slice(0, count))
          return stored
        },
        reads: () => reads,
        setStatus: value => {
          status = value
        }
      }
    }

    it('notes the imported innings under the box score once earlier plays are imported', async function () {
      resize(402, 874)
      const socket = new FakeSocket()
      await following(socket)
      const imported = 'earlier innings were imported'
      expect(document.body.textContent).not.includes(imported)
      await socket.emit(change('plays', await importedThenScoredGame()))
      await wait(100)
      expect(document.body.textContent).includes(imported)
    })

    it('subscribes on opening, plays what the scorer adds, and lets go on Exit', async function () {
      resize(402, 874)
      const socket = new FakeSocket()
      const game = await following(socket)
      expect(socket.listeners.has(REPLAY_GAME_ID)).equals(true)
      const opened = card()
      // The plays come with the change: nothing to read.
      await socket.emit(change('plays', await game.setStored(11)))
      expect(game.reads()).equals(0)
      now = 100
      await wait(250)
      expect(card()).not.equals(opened)
      // A change that carries no game it can use: read the game instead.
      await game.setStored(12)
      await socket.emit(change('plays'))
      expect(game.reads()).equals(1)
      // Nothing to read in a walk-up song.
      await socket.emit(change('walkUpSong'))
      expect(game.reads()).equals(1)
      await socket.emit({ type: 'resync', gameId: REPLAY_GAME_ID })
      expect(game.reads()).equals(2)
      await act(async () => {
        root?.unmount()
      })
      expect(socket.listeners.size).equals(0)
      expect(socket.statuses.size).equals(0)
    })

    it('reads the game every few seconds while the socket is down or refused', async function () {
      resize(402, 874)
      const socket = new FakeSocket()
      const game = await following(socket, 60)
      await wait(200)
      expect(game.reads()).equals(0)
      await socket.status(false)
      await wait(200)
      expect(game.reads()).greaterThan(1)
      await socket.status(true)
      await socket.emit({ type: 'subscribed', gameId: REPLAY_GAME_ID })
      const back = game.reads()
      await wait(200)
      expect(game.reads()).equals(back)
      await socket.emit({
        type: 'error',
        gameId: REPLAY_GAME_ID,
        code: 'tooMany',
        message: ''
      })
      await wait(200)
      expect(game.reads()).equals(back)
      await socket.emit({
        type: 'error',
        gameId: REPLAY_GAME_ID,
        code: 'internal',
        message: ''
      })
      await wait(200)
      expect(game.reads()).greaterThan(back)
    })

    it('ends on the final score when the game is over', async function () {
      resize(402, 874)
      const socket = new FakeSocket()
      await following(socket)
      expect(byLabel('Pause replay')).not.equals(undefined)
      await socket.emit({
        type: 'change',
        gameId: REPLAY_GAME_ID,
        kind: 'game',
        at: '',
        data: { status: 'inProgress', awayScore: 1, homeScore: 0 }
      })
      now = 100
      await wait(250)
      expect(byLabel('Pause replay')).not.equals(undefined)
      await socket.emit({
        type: 'change',
        gameId: REPLAY_GAME_ID,
        kind: 'game',
        at: '',
        data: { status: 'final', awayScore: 1, homeScore: 0 }
      })
      now = 200
      await wait(250)
      expect(byLabel('Pause replay')).equals(undefined)
    })

    it('ends the view when a read on reconnecting brings the end of the game, reading only where it lands', async function () {
      this.timeout(120000)
      resize(402, 874)
      const socket = new FakeSocket()
      const game = await following(socket)
      await press('Turn announcer on')
      // Away while the scorer finished the game; the game change was missed.
      await game.setStored(actions.length)
      await socket.emit({ type: 'subscribed', gameId: REPLAY_GAME_ID })
      expect(game.reads()).equals(1)
      for (let i = 0; i < 600 && byLabel('Pause replay') != null; i++) {
        now += 2000
        await wait(60)
        await act(async () => {
          for (const player of field().players)
            if (player.motion != null && !player.motion.reported)
              field().onMovementComplete?.(
                player.motion.id,
                player.motion.generation
              )
        })
      }
      expect(byLabel('Pause replay')).equals(undefined)
      expect(card()).includes("That's the ballgame!")
      // Hurrying through the missed steps, it read only the last.
      expect(announcer.played).deep.equals(['9999-1'])
    })

    it('fetches no sentence for a ball in play until the scorer places it', async function () {
      resize(402, 874)
      const inPlay = actions.findIndex(action => action.type === 'ballInPlay')
      const bare = { type: 'ballInPlay' as const, contact: 'swing' as const }
      let stored = await scored([...actions.slice(0, inPlay), bare])
      const key = replayTimelineOf(stored, replayContext()).steps.at(-1)!.key
      const game = gameOf({ status: 'inProgress' })
      await show(
        game,
        stored,
        fakeClient(
          async () => game,
          async () => stored
        ),
        { pollMs: 60 }
      )
      await showCatcher()
      await press('Turn announcer on')
      for (let i = 0; i < 5; i++) {
        now += 5000
        await wait(60)
      }
      expect(announcer.asked).not.includes(key)
      expect(card()).not.includes('in play')
      stored = await scored([
        ...actions.slice(0, inPlay),
        bare,
        ...actions.slice(inPlay, inPlay + 3)
      ])
      for (let i = 0; i < 40 && !card().includes('single'); i++) {
        now += 1000
        await wait(60)
      }
      expect(announcer.asked).includes(key)
      expect(card()).includes('single')
    })

    it('with no socket, reads the game until it is over', async function () {
      resize(402, 874)
      const game = await following(undefined, 60)
      await wait(200)
      expect(game.reads()).greaterThan(1)
      game.setStatus('final')
      now = 100
      await wait(300)
      expect(byLabel('Pause replay')).equals(undefined)
      // Over: it stops reading.
      const done = game.reads()
      await wait(300)
      expect(game.reads()).equals(done)
    })
  })
})
