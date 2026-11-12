import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import {
  asGameDetail,
  asGameStatistics,
  type GameDetail
} from '../../common/api'
import {
  GameSocket,
  type GameSocketListener,
  type WebSocketLike
} from '../../common/gameSocket'
import { replayTimelineOf } from '../../common/replay/replayTimeline'
import type { StoredGame } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { stubFieldInsets } from '../../test/fieldInsetsStub'
import { nativeStatistics } from '../../test/gameStatisticsFixture'
import {
  finalGame,
  inProgressGame,
  REPLAY_GAME_ID,
  REPLAY_TEAMS,
  replayActions,
  replayContext,
  replaySetup,
  scored
} from '../../test/replayGameFixture'
import {
  SCORING_BOTTOM_EXTENSION,
  SCORING_CAMERA
} from '../field/BaseballScreen'
import type { ScreenRect } from '../field/catcherBounds'
import type { FieldCanvas } from '../field/FieldCanvas'
import {
  FIELD_EDGE_GAP,
  FLOATING_MARGIN,
  FLOATING_SIZE,
  floatingBottom,
  topLift
} from '../field/fieldSafeArea'
import type { Insets } from '../platform/insets'
import { scoringAudio } from '../scoring/scoringAudio'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import {
  boxScoreInset,
  DECK_MIN,
  FLOATING_BUTTON,
  GameReplayScreen,
  type ReplayClient,
  replayLayout,
  type ReplaySocket,
  SIDE_DECK_WIDTH,
  tallDeck
} from './GameReplayScreen'

type FieldProps = Parameters<typeof FieldCanvas>[0]
/** A `#RRGGBB` colour as the browser writes it in a style. */
const rgb = (hex: string): string =>
  `rgb(${[1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(', ')})`
const MUTE = 'Mute game sounds'
const UNMUTE = 'Unmute game sounds'
const CLOSE = 'Close replay'
interface Fiber {
  type?: { name?: string } | string | null
  memoizedProps?: unknown
  child?: Fiber | null
  sibling?: Fiber | null
}

/** What the fake server says about its announcer, and what it was asked. */
const announcer = {
  health: true as boolean | 'fails',
  /** The node's replay pitch delay health reports, or none (an older server). */
  pitchSec: undefined as number | undefined,
  audio: 'ok' as 'ok' | 'fails',
  asked: [] as string[],
  /** How often the phone's ready check was asked for: never, in a browser. */
  readied: 0,
  /** The steps whose sentences the page played, in order. */
  played: [] as string[]
}

function fakeClient(
  game: () => Promise<GameDetail>,
  events: () => Promise<StoredGame>
): ReplayClient {
  let metadata: Promise<GameDetail> | undefined
  return {
    game: async () => {
      metadata = game()
      return await metadata
    },
    gameStatistics: async () =>
      nativeStatistics(await (metadata ?? game()), await events()),
    health: async () => {
      if (announcer.health === 'fails') throw new Error('offline')
      return {
        narration: announcer.health,
        ...(announcer.pitchSec == null
          ? {}
          : { replayPitchSec: announcer.pitchSec })
      }
    },
    narrationAudio: async (_gameId, step) => {
      announcer.asked.push(step.key)
      if (announcer.audio === 'fails') throw new Error('503')
      return Object.assign(new Blob(['mp3']), { stepKey: step.key })
    },
    narrationReady: async () => {
      announcer.readied++
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

/**
 * The safe area the page's inset probe reads (`useFieldInsets`): jsdom has
 * none, so a test says what a phone's browser would. Null: none.
 */
let safeArea: Insets | null = null
let unstubSafeArea = (): void => undefined
/** An iPhone held upright: the island and the home indicator. */
const IPHONE: Insets = { top: 59, bottom: 34, left: 0, right: 0 }

/** What the replay asked of the field cues, in order. */
const cues: string[] = []
const setCues = scoringAudio.setEnabled
const unlockCues = scoringAudio.unlock

describe('the replay screen', function () {
  this.timeout(30000)

  beforeEach(function () {
    announcer.pitchSec = undefined
    announcer.health = true
    announcer.audio = 'ok'
    announcer.asked = []
    announcer.readied = 0
    announcer.played = []
    cues.length = 0
    safeArea = null
    unstubSafeArea = stubFieldInsets(() => safeArea)
    scoringAudio.setEnabled = value => {
      cues.push(value ? 'on' : 'off')
      setCues(value)
    }
    scoringAudio.unlock = () => {
      cues.push('unlock')
    }
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
    unstubSafeArea()
    scoringAudio.setEnabled = setCues
    scoringAudio.unlock = unlockCues
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

  it('lays the box score below the field on a tall window and beside it on a wide one', function () {
    expect(replayLayout(402, 874)).deep.equals({ side: false })
    expect(replayLayout(1440, 900)).deep.equals({ side: true })
    expect(replayLayout(1024, 1366)).deep.equals({ side: true })
    expect(replayLayout(767, 1024)).deep.equals({ side: false })
  })

  it('opens a finished game on the field, with the X, the sound off, pause, and the box score', async function () {
    resize(402, 874)
    const shown = await show(gameOf(), finalGame())
    const text = document.body.textContent ?? ''
    expect(byLabel(CLOSE)).not.equals(undefined)
    expect(text).not.includes('Exit')
    expect(byLabel(UNMUTE)).not.equals(undefined)
    expect(byLabel('Pause replay')).not.equals(undefined)
    expect(text).includes('Harbor Hawks batting')
    expect(text).includes('Valley Pines pitching')
    // The card waits for the field to say where the catcher is.
    expect(card()).equals('')
    await showCatcher()
    expect(card()).includes('Play ball!')
    expect(field().view).equals('home')
    await press(CLOSE)
    expect(shown.exits).equals(1)
  })

  /** The first pitch shows at 2200; the next comes when its slot ends. */
  const holds = async (pitchMs: number): Promise<void> => {
    resize(402, 874)
    await show(gameOf(), finalGame())
    await showCatcher()
    await firstPitch()
    const first = card()
    now = 2200 + pitchMs - 400
    await wait(250)
    expect(card(), `still the first pitch before ${pitchMs} ms`).equals(first)
    now = 2200 + pitchMs + 400
    await wait(250)
    expect(card(), `the next step after ${pitchMs} ms`).not.equals(first)
  }

  it('holds each pitch for the node’s pitch delay', async function () {
    announcer.pitchSec = 7
    await holds(7000)
  })

  it('holds each pitch five seconds for a server that does not say', async function () {
    await holds(5000)
  })

  it('holds each pitch five seconds when health cannot be read', async function () {
    announcer.health = 'fails'
    await holds(5000)
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

  it('keeps the public label on the field and the scoreboard for a player read in full', async function () {
    resize(402, 874)
    // As the server answers a reader who may read them in full: the public
    // label in the documents, and the whole name beside it.
    const setup = replaySetup()
    const full = new Map<string, string>()
    for (const [id, player] of Object.entries(setup.players))
      if (
        player.fullName === 'Juan Soto' ||
        player.fullName === 'Tyler Glasnow'
      ) {
        full.set(id, player.fullName)
        player.fullName = player.fullName === 'Juan Soto' ? 'Juan S' : 'Tyler G'
      }
    const game = gameOf()
    const events = finalGame(setup)
    const client = fakeClient(
      async () => game,
      async () => await events
    )
    client.gameStatistics = async () => {
      const native = nativeStatistics(game, await events)
      return asGameStatistics(
        JSON.parse(
          JSON.stringify({
            ...native,
            source: { generation: 0, ...native.source },
            readerNames: Object.fromEntries(full)
          })
        )
      )
    }
    await show(game, events, client)
    await showCatcher()
    await firstPitch()
    const { players, scoreboard } = field()
    const labels = players.map(player => player.displayName ?? '')
    expect(labels).includes('Juan S')
    expect(labels.some(label => /Soto|Glasnow/.test(label))).equals(false)
    expect(scoreboard?.batter.firstName).equals('Juan S')
    expect(scoreboard?.pitcher.firstName).equals('Tyler G')
  })

  /** The element with `testID` in the page. */
  const node = (testID: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(
      `[data-testid="${testID}"]`
    )
    expect(found, testID).not.equals(null)
    return found!
  }

  for (const narration of [true, false])
    it(`puts the volume button upper left ${narration ? 'with' : 'without'} an announcer, and the X upper right`, async function () {
      resize(402, 874)
      announcer.health = narration
      const shown = await show(gameOf(), finalGame())
      const speaker = node('replay-speaker')
      expect(speaker.getAttribute('aria-label')).equals(UNMUTE)
      expect(speaker.style.backgroundColor).equals('rgb(255, 255, 255)')
      expect(speaker.parentElement?.style).deep.include({
        position: 'absolute',
        top: '0px',
        left: '0px'
      })
      const exit = node('replay-exit')
      expect(exit.getAttribute('aria-label')).equals(CLOSE)
      expect(exit.textContent).equals('close')
      // Dark on the glass, as the scoring screen's ☰: the app theme's text.
      const glyph = [...exit.querySelectorAll<HTMLElement>('*')].find(
        item => item.childElementCount === 0 && item.textContent === 'close'
      )
      expect(glyph?.style.color).equals(rgb(tsBallpark.primaryTextColor))
      expect(exit.parentElement?.style).deep.include({
        position: 'absolute',
        top: '0px',
        right: '0px',
        width: '48px',
        height: '48px'
      })
      expect(exit.parentElement?.style.left).equals('')
      expect(document.body.textContent).not.includes('Exit')
      await press(CLOSE)
      expect(shown.exits).equals(1)
      expect(flat(propsOf('replay-rewind').style)).deep.include({ left: 16 })
      expect(flat(propsOf('replay-pause').style)).deep.include({ right: 16 })
    })

  const fieldBox = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-testid="replay-field"]')!
  const cardStyle = (): CSSStyleDeclaration | undefined =>
    document.querySelector<HTMLElement>('[data-testid="replay-play-card"]')
      ?.style
  const px = (value: string | undefined): number =>
    Number.parseFloat(value ?? 'NaN')

  for (const inset of [null, IPHONE])
    it(`frames the field as the scoring screen does, lifted ${topLift(inset?.top ?? 0, 'web')} points under a ${inset?.top ?? 0} point inset`, async function () {
      resize(402, 874)
      safeArea = inset
      await show(gameOf(), finalGame())
      const lift = topLift(inset?.top ?? 0, 'web')
      const { zoom, cameraTilt, cameraHeight, bottomExtension } = field()
      expect({ zoom, cameraTilt, cameraHeight }).deep.equals(SCORING_CAMERA)
      expect(bottomExtension).equals(SCORING_BOTTOM_EXTENSION)
      expect(bottomExtension).equals(112)
      // The canvas fills the column from the window's top, raised by the lift.
      expect(fieldBox().style.marginTop).equals('')
      expect(fieldBox().style.transform).equals(
        lift === 0 ? '' : `translateY(-${lift}px)`
      )
      // And as much taller, so its bottom stays on the column's.
      expect(fieldBox().style.marginBottom).equals(
        lift === 0 ? '' : `-${lift}px`
      )
      // The top controls sit the lift higher into the inset, never above
      // the edge gap.
      const overlay = document.querySelector('[data-testid="replay-speaker"]')
        ?.parentElement?.parentElement?.parentElement
      expect(px(overlay?.style.paddingTop)).equals(
        Math.max(FIELD_EDGE_GAP, (inset?.top ?? 0) - lift)
      )
      // The card hangs below the catcher where the lifted canvas draws it.
      await showCatcher()
      expect(px(cardStyle()?.top)).equals(
        CATCHER.y + CATCHER.height + 24 - lift
      )
    })

  it('keeps the lifted field down to the bottom of its column beside the box score', async function () {
    // An iPad held sideways: a 24 point top inset, a lift of 16, and
    // nothing over the field column's bottom.
    resize(1366, 1024)
    safeArea = { top: 24, bottom: 20, left: 0, right: 0 }
    await show(gameOf(), finalGame())
    expect(node('replay-side')).not.equals(null)
    const lift = topLift(24, 'web')
    expect(lift).equals(16)
    expect(fieldBox().style.transform).equals(`translateY(-${lift}px)`)
    expect(fieldBox().style.marginBottom).equals(`-${lift}px`)
    expect(fieldBox().style.flexGrow).equals('1')
  })

  it('lifts nothing on Android: the top buttons and the scene stay below the status bar', async function () {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android'
    })
    try {
      resize(402, 874)
      safeArea = IPHONE
      await show(gameOf(), finalGame())
      expect(fieldBox().style.transform).equals('')
      const overlay = document.querySelector('[data-testid="replay-speaker"]')
        ?.parentElement?.parentElement?.parentElement
      expect(px(overlay?.style.paddingTop)).equals(
        Math.max(FIELD_EDGE_GAP, IPHONE.top)
      )
      await showCatcher()
      expect(px(cardStyle()?.top)).equals(CATCHER.y + CATCHER.height + 24)
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: os })
    }
  })

  for (const bottom of [0, 24, 34])
    it(`seats rewind left and pause right on a ${bottom} point bottom inset`, async function () {
      resize(402, 874)
      safeArea = { top: 0, bottom, left: 0, right: 0 }
      await show(gameOf(), finalGame())
      expect(flat(propsOf('replay-rewind').style)).deep.include({
        left: FLOATING_MARGIN,
        bottom: floatingBottom(bottom)
      })
      expect(flat(propsOf('replay-pause').style)).deep.include({
        right: FLOATING_MARGIN,
        bottom: floatingBottom(bottom)
      })
      // Measured from the window's edges: no safe padding around them.
      const holder = node('replay-rewind').parentElement
      expect(holder?.style.paddingBottom).equals('')
      expect(holder?.style).deep.include({ position: 'absolute' })
    })

  it('keeps rewind and pause beside a notch, held sideways', async function () {
    resize(874, 402)
    safeArea = { top: 0, bottom: 21, left: 59, right: 47 }
    await show(gameOf(), finalGame())
    expect(flat(propsOf('replay-rewind').style)).deep.include({
      left: FLOATING_MARGIN + 59,
      bottom: floatingBottom(21)
    })
    expect(flat(propsOf('replay-pause').style)).deep.include({
      right: FLOATING_MARGIN + 47
    })
  })

  it('scrolls the box score’s last row clear of the buttons', async function () {
    // The tall deck runs to the window's bottom.
    expect(boxScoreInset(0, 0)).equals(16 + FLOATING_SIZE + 8)
    expect(boxScoreInset(34, 0)).equals(6 + FLOATING_SIZE + 8)
    // The side column ends its safe padding above the window's bottom.
    expect(boxScoreInset(21, 21 + FIELD_EDGE_GAP)).equals(
      floatingBottom(21) + FLOATING_SIZE + 8 - 29
    )
    resize(402, 874)
    safeArea = IPHONE
    await show(gameOf(), finalGame())
    expect(
      flat(propsOf('replay-box-score').contentContainerStyle).paddingBottom
    ).equals(boxScoreInset(34, 0))
    await act(async () => {
      root?.unmount()
    })
    resize(874, 402)
    safeArea = { top: 0, bottom: 21, left: 59, right: 47 }
    await show(gameOf(), finalGame())
    expect(
      flat(propsOf('replay-box-score').contentContainerStyle).paddingBottom
    ).equals(boxScoreInset(21, 21 + FIELD_EDGE_GAP))
  })

  /** The play card's layout event, as the browser would send it. */
  async function measureCard(height: number): Promise<void> {
    await act(async () => {
      ;(
        propsOf('replay-play-card') as {
          onLayout: (event: unknown) => void
        }
      ).onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height } }
      })
    })
  }

  it('keeps the deck its least height until the card is measured', async function () {
    resize(402, 874)
    await show(gameOf(), finalGame())
    expect(px(node('replay-deck').style.top)).equals(874 - DECK_MIN)
    expect(tallDeck(874, null, 96)).deep.equals({
      top: 874 - DECK_MIN,
      card: true
    })
    expect(tallDeck(874, CATCHER, 0)).deep.equals({
      top: 874 - DECK_MIN,
      card: true
    })
  })

  it('hangs the card below the catcher at 402 × 874, the box score below it', async function () {
    resize(402, 874)
    await show(gameOf(), finalGame())
    await showCatcher()
    await measureCard(96)
    const below = CATCHER.y + CATCHER.height + 24
    expect(px(cardStyle()?.top)).equals(below)
    expect(cardStyle()?.position).equals('absolute')
    const deck = node('replay-deck')
    expect(px(deck.style.top)).equals(below + 96 + 8)
    expect(deck.contains(node('replay-play-card'))).equals(false)
    expect(874 - (below + 96 + 8)).gte(DECK_MIN)
    expect(tallDeck(874, CATCHER, 96)).deep.equals({
      top: below + 96 + 8,
      card: true
    })
  })

  it('draws no card on a tall window whose catcher sits too low for it, the deck below the nameplate', async function () {
    resize(600, 1000)
    await show(gameOf(), finalGame())
    // A catcher this low: hung below it, the card would leave the
    // box score less than DECK_MIN.
    const catcher = { x: 285, y: 760, width: 30, height: 40 }
    await act(async () => {
      field().onCatcherBounds?.(catcher)
    })
    await measureCard(96)
    const below = catcher.y + catcher.height + 24
    expect(1000 - (below + 96 + 8)).lessThan(DECK_MIN)
    expect(document.querySelector('[data-testid="replay-play-card"]')).equals(
      null
    )
    const deck = node('replay-deck')
    expect(px(deck.style.top)).equals(below)
    expect(1000 - below).gte(DECK_MIN)
    expect(tallDeck(1000, catcher, 96)).deep.equals({ top: below, card: false })
    // Lower still, the deck keeps DECK_MIN over the nameplate's foot.
    expect(tallDeck(1000, { ...catcher, y: 820 }, 96)).deep.equals({
      top: 1000 - DECK_MIN,
      card: false
    })
  })

  it('puts the card at the top of the side column on a wide window, the box score below it', async function () {
    resize(874, 402)
    await show(gameOf(), finalGame())
    await showCatcher()
    const side = node('replay-side')
    expect(side.style.width).equals(`${SIDE_DECK_WIDTH}px`)
    const cards = document.querySelectorAll<HTMLElement>(
      '[data-testid="replay-play-card"]'
    )
    expect(cards).length(1)
    const [card] = cards
    expect(side.firstElementChild).equals(card)
    expect(card.style.position).not.equals('absolute')
    expect(card.style.marginLeft).equals('12px')
    expect(card.style.marginRight).equals('12px')
    expect(card.textContent).includes('Play ball!')
    expect(card.nextElementSibling?.contains(node('replay-box-score'))).equals(
      true
    )
    expect(
      (card.nextElementSibling as HTMLElement | null)?.style.marginTop
    ).equals('8px')
    expect(document.querySelector('[data-testid="replay-deck"]')).equals(null)
    expect(fieldBox().parentElement?.contains(card)).equals(false)
  })

  it('turns the cues and the announcer on, and off again, with the volume button', async function () {
    resize(402, 874)
    await show(gameOf(), finalGame())
    // The replay opens with the field cues off.
    expect(cues).deep.equals(['off'])
    await press(UNMUTE)
    expect(byLabel(MUTE)).not.equals(undefined)
    expect(cues.slice(1)).deep.equals(['unlock', 'on'])
    // The announcer is unlocked on the tap, and fetches ahead.
    await wait(50)
    expect(announcer.asked).not.deep.equals([])
    await press(MUTE)
    expect(byLabel(UNMUTE)).not.equals(undefined)
    expect(cues.at(-1)).equals('off')
  })

  it('puts the box score in a column beside the field on a wide window', async function () {
    resize(1440, 900)
    await show(gameOf(), finalGame())
    const deck = document.querySelector<HTMLElement>(
      '[data-testid="replay-box-score"]'
    )
    expect(deck).not.equals(null)
    expect(node('replay-side').contains(deck)).equals(true)
    expect(node('replay-side').style.width).equals('360px')
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
      expect(rewindStyle).deep.equals({
        ...FLOATING_BUTTON,
        left: 16,
        bottom: 16
      })
      expect(pauseStyle).deep.equals({
        ...FLOATING_BUTTON,
        right: 16,
        bottom: 16
      })
      expect(FLOATING_MARGIN).equals(16)
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
      await show(gameOf(), finalGame())
      const scroll = propsOf('replay-box-score')
      expect(flat(scroll.contentContainerStyle).alignItems).equals('center')
      // The line score and the tables centre apart, so a long game's line
      // score that fills a phone leaves the tables centred. The line score is
      // a row: its team names beside its scrolling innings.
      expect(flat(propsOf('replay-box-score-line').style)).deep.equals({
        alignSelf: 'center',
        maxWidth: '100%',
        flexDirection: 'row'
      })
      expect(flat(propsOf('replay-box-score-tables').style)).deep.equals({
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
      expect(document.body.textContent).not.includes(
        'earlier innings were imported'
      )
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
      await press(UNMUTE)
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
    for (const health of [false, 'fails'] as const)
      it(`is never asked for a sentence by a server that ${health === false ? 'has none' : 'cannot say'}, while the cues play`, async function () {
        resize(402, 874)
        announcer.health = health
        await show(gameOf(), finalGame())
        await showCatcher()
        await press(UNMUTE)
        expect(byLabel(MUTE)).not.equals(undefined)
        expect(cues.slice(1)).deep.equals(['unlock', 'on'])
        await firstPitch()
        now += 6000
        await wait(250)
        expect(announcer.asked).deep.equals([])
        expect(announcer.readied).equals(0)
        expect(announcer.played).deep.equals([])
        expect(cues.at(-1)).equals('on')
      })

    it('reads nothing while muted, and each step once the speaker is on', async function () {
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      now = 100
      await wait(250)
      expect(announcer.asked).deep.equals([])
      await press(UNMUTE)
      expect(byLabel(MUTE)).not.equals(undefined)
      // The two steps ahead are fetched at once, and the next as each plays.
      await wait(50)
      expect(announcer.asked).deep.equals(['0-0', '0-1'])
      now = 2200
      await wait(300)
      expect(announcer.asked).deep.equals(['0-0', '0-1', '0-2'])
      await press(MUTE)
      expect(byLabel(UNMUTE)).not.equals(undefined)
    })

    it('says it is unavailable after three sentences fail, leaving the sound on', async function () {
      resize(402, 874)
      announcer.audio = 'fails'
      await show(gameOf(), finalGame())
      await showCatcher()
      await press(UNMUTE)
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
      // The button stays on, and so do the field cues.
      expect(byLabel(MUTE)).not.equals(undefined)
      expect(cues.at(-1)).equals('on')
      // Nothing more is asked of it while it is unavailable.
      const asked = announcer.asked.length
      now += 10000
      await wait(250)
      expect(announcer.asked.length).equals(asked)
      // Off and on again tries the announcer again.
      announcer.audio = 'ok'
      await press(MUTE)
      await press(UNMUTE)
      expect(card()).not.includes('Announcer unavailable')
      await wait(100)
      expect(announcer.asked.length).greaterThan(asked)
    })

    it('reads the final call when the replay reaches it', async function () {
      this.timeout(120000)
      resize(402, 874)
      await show(gameOf(), finalGame())
      await showCatcher()
      await press(UNMUTE)
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
      await press(UNMUTE)
      await act(async () => {
        root?.unmount()
      })
      await show(gameOf(), finalGame())
      expect(byLabel(UNMUTE)).not.equals(undefined)
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
    /**
     * A game as the server reads it, with a digest of its own, the digest of
     * the book it names the plays from, and its generation.
     */
    let digests = 0
    const book = 'names1'
    const asRead = (stored: StoredGame, halves?: string[]): StoredGame => ({
      ...stored,
      playsDigest: `d${++digests}`,
      namesDigest: book,
      generation: 0,
      ...(halves == null ? {} : { halves })
    })
    /**
     * A change as the server sends it: a `playEdits` change takes the game
     * from `from` to `next` (every play of `next` put, and the plays it no
     * longer has removed), or with neither says only to read it again.
     */
    const change = (
      kind: 'playEdits' | 'walkUpSong',
      next?: StoredGame,
      from?: StoredGame
    ): Parameters<GameSocketListener>[0] =>
      kind === 'playEdits'
        ? {
            type: 'change',
            gameId: REPLAY_GAME_ID,
            kind,
            at: '',
            data:
              next == null || from == null
                ? {
                    generation: 0,
                    fromDigest: null,
                    digest: null,
                    namesDigest: null,
                    edits: null
                  }
                : {
                    generation: 0,
                    fromDigest: from.playsDigest ?? null,
                    digest: next.playsDigest ?? null,
                    namesDigest: next.namesDigest ?? null,
                    edits: [
                      ...next.plays.map((gumbo, index) => ({
                        op: 'put' as const,
                        play: {
                          id: `evt_${index}`,
                          gameId: REPLAY_GAME_ID,
                          gumbo
                        }
                      })),
                      ...from.plays
                        .map(play => play.about.atBatIndex)
                        .filter(
                          index =>
                            !next.plays.some(
                              play => play.about.atBatIndex === index
                            )
                        )
                        .map(atBatIndex => ({
                          op: 'remove' as const,
                          atBatIndex
                        }))
                    ],
                    currentPlay: next.currentPlay
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
      socket?: ReplaySocket,
      pollMs?: number,
      /** The teams whose players' halves each read carries. */
      halves?: string[]
    ): Promise<{
      setStored: (count: number) => Promise<StoredGame>
      /** What the server answers a read of the game now. */
      current: () => StoredGame
      reads: () => number
      setStatus: (status: GameDetail['status']) => void
    }> {
      let stored = asRead(await scored(actions.slice(0, 10)), halves)
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
          stored = asRead(await scored(actions.slice(0, count)), halves)
          return stored
        },
        current: () => stored,
        reads: () => reads,
        setStatus: value => {
          status = value
        }
      }
    }

    it('subscribes on opening, plays what the scorer adds, and lets go on closing', async function () {
      resize(402, 874)
      const socket = new FakeSocket()
      const game = await following(socket)
      expect(socket.listeners.has(REPLAY_GAME_ID)).equals(true)
      const opened = card()
      // Each notice refreshes the canonical statistics revision.
      await socket.emit(change('playEdits', await game.setStored(11)))
      expect(game.reads()).equals(1)
      now = 100
      await wait(250)
      expect(card()).not.equals(opened)
      // A change that carries no game it can use: read the game instead.
      await game.setStored(12)
      await socket.emit(change('playEdits'))
      expect(game.reads()).equals(2)
      // Nothing to read in a walk-up song.
      await socket.emit(change('walkUpSong'))
      expect(game.reads()).equals(2)
      await socket.emit({ type: 'resync', gameId: REPLAY_GAME_ID })
      expect(game.reads()).equals(3)
      await act(async () => {
        root?.unmount()
      })
      expect(socket.listeners.size).equals(0)
      expect(socket.statuses.size).equals(0)
    })

    it('reads the game again on an older worker’s whole list of plays, heard through the app’s socket', async function () {
      resize(402, 874)
      /** The socket's wire, which the test speaks for. */
      class Wire implements WebSocketLike {
        static made: Wire[] = []
        sent: Array<{ type?: string; id?: string }> = []
        onopen: ((event: unknown) => void) | null = null
        onmessage: ((event: { data: unknown }) => void) | null = null
        onclose: ((event: unknown) => void) | null = null
        onerror: ((event: unknown) => void) | null = null
        constructor() {
          Wire.made.push(this)
        }

        send(data: string): void {
          this.sent.push(JSON.parse(data))
        }

        close(): void {}
        async receive(frame: unknown): Promise<void> {
          await act(async () => {
            this.onmessage?.({ data: JSON.stringify(frame) })
            await new Promise(resolve => setTimeout(resolve, 30))
          })
        }
      }
      const socket = new GameSocket({
        baseUrl: 'http://api.test:9100/api/v1',
        WebSocketImpl: Wire
      })
      try {
        const game = await following(socket)
        const wire = Wire.made[0]
        await act(async () => {
          wire.onopen?.({})
        })
        const subscribe = wire.sent.find(frame => frame.type === 'subscribe')
        await wire.receive({
          type: 'subscribed',
          gameId: REPLAY_GAME_ID,
          id: subscribe?.id
        })
        expect(game.reads()).equals(1)
        const stored = await game.setStored(11)
        await wire.receive({
          type: 'change',
          gameId: REPLAY_GAME_ID,
          kind: 'plays',
          at: '',
          data: {
            plays: stored.plays,
            currentPlay: stored.currentPlay,
            digest: stored.playsDigest
          }
        })
        expect(game.reads()).equals(2)
      } finally {
        socket.close()
      }
    })

    it('reads the game again for each change when its read carries somebody’s halves', async function () {
      resize(402, 874)
      const socket = new FakeSocket()
      // A manager of the home team reads its players' whole names, which the
      // edits, named for everybody, do not carry.
      const game = await following(socket, undefined, ['tem_home'])
      await socket.emit({ type: 'subscribed', gameId: REPLAY_GAME_ID })
      expect(game.reads()).equals(1)
      const held = game.current()
      await socket.emit(change('playEdits', await game.setStored(11), held))
      expect(game.reads()).equals(2)
      const next = game.current()
      await socket.emit(change('playEdits', await game.setStored(12), next))
      expect(game.reads()).equals(3)
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
      await press(UNMUTE)
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
      await press(UNMUTE)
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
