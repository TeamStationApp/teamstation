import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asGameDetail,
  asHighlightsResponse,
  asVideoSummary,
  type GameDetail,
  TeamStationClient
} from '../../common/api'
import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

let root: Root | undefined
let restoreViewport: (() => void) | undefined
// eslint-disable-next-line @typescript-eslint/unbound-method -- restored below
const reduceMotionQuery = AccessibilityInfo.isReduceMotionEnabled

afterEach(async () => {
  AccessibilityInfo.isReduceMotionEnabled = reduceMotionQuery
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  restoreViewport?.()
  restoreViewport = undefined
})

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const video = asVideoSummary({
  id: 'v1',
  title: 'Game — Home plate',
  numCameras: 1,
  kind: 'primary',
  status: 'ready',
  storage: 'local',
  startAt: '2026-05-02T18:30:00Z',
  durationSec: 300,
  width: 1920,
  height: 1080,
  codecs: null,
  posterUrl: 'https://example.com/poster.jpg'
})

function gameWith(fields: Partial<GameDetail>): GameDetail {
  return {
    ...asGameDetail({
      id: 'g1',
      nonMemberView: false,
      homeTeamId: 'home',
      awayTeamId: 'away',
      homeTeamName: 'Owls',
      awayTeamName: 'Eagles',
      seasonId: null,
      startAt: '2026-05-02T18:00:00Z',
      endAt: '2026-05-02T20:00:00Z',
      venue: null,
      status: 'final',
      homeScore: 5,
      awayScore: 3,
      ingestStatus: 'none',
      ingestMessage: null,
      videos: []
    }),
    replayable: true,
    ...fields
  }
}

interface Page {
  replays: number
  signIns: number
}

async function page(
  game: GameDetail,
  options: {
    signedIn?: boolean | null
    initialTab?: 'info' | 'boxScore' | 'watch'
    onReplay?: boolean
  } = {}
): Promise<Page> {
  const { signedIn = true, initialTab = 'info', onReplay = true } = options
  const counts: Page = { replays: 0, signIns: 0 }
  // Motion as most people have it, so the Live pulse can be seen.
  AccessibilityInfo.isReduceMotionEnabled = async () => false
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.game = async () => ({ ...game })
  client.teams = async () => []
  client.seasonTeams = async () => []
  client.highlights = async () =>
    asHighlightsResponse({ withheld: null, droppedCount: 0, highlights: [] })
  client.boxScore = async () => ({
    batting: [],
    pitching: [],
    stats: undefined
  })
  client.eventInfo = async () => {
    throw new Error('not an event manager')
  }
  client.gameScheduling = async () => {
    throw new Error('not a scheduler')
  }
  // Still on its way: the player box shows its spinner meanwhile.
  client.playback = async () => await new Promise(() => undefined)
  client.wallTimeline = async () => await new Promise(() => undefined)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <GameScreen
            client={client}
            gameId="g1"
            signedIn={signedIn}
            initialTab={initialTab}
            onSignIn={() => {
              counts.signIns++
            }}
            onReplay={
              onReplay
                ? () => {
                    counts.replays++
                  }
                : undefined
            }
          />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await act(async () => {
    await delay(20)
  })
  return counts
}

const hero = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="event-hero"]')
const button = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="game-hero-replay"]')
const sections = (): HTMLElement =>
  document.querySelector<HTMLElement>('[aria-label="Game sections"]')!

async function tap(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click()
  })
  await act(async () => {
    await delay(20)
  })
}

function sheetAction(label: string): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="button"]')
  ).find(node => node.textContent === label)
}

/** Whether the opacity round the button moves over a few frames. */
async function pulses(): Promise<boolean> {
  const seen = new Set<string>()
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await delay(60)
    })
    seen.add(button()!.parentElement!.style.opacity)
  }
  return [...seen].some(value => value !== '' && value !== '1')
}

/** A phone held sideways: the window `watchLayout` calls short. */
function sideways(): void {
  const keys = ['visualViewport', 'innerWidth', 'innerHeight'] as const
  const saved = keys.map(
    key => [key, Object.getOwnPropertyDescriptor(window, key)] as const
  )
  const visual = Object.assign(new window.EventTarget(), {
    width: 844,
    height: 390,
    scale: 1,
    offsetTop: 0
  })
  Object.defineProperties(window, {
    visualViewport: { configurable: true, value: visual },
    innerWidth: { configurable: true, value: 844 },
    innerHeight: { configurable: true, value: 390 }
  })
  window.dispatchEvent(new window.Event('resize'))
  restoreViewport = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor == null) Reflect.deleteProperty(window, key)
      else Object.defineProperty(window, key, descriptor)
    }
    window.dispatchEvent(new window.Event('resize'))
  }
}

describe('the game hero’s Live / Replay button on a game page', function () {
  it('is a member’s Replay in the hero, never in the section pills, and opens the replay', async function () {
    const counts = await page(gameWith({}))
    const replay = button()
    expect(replay?.textContent).equals('Replay')
    expect(hero()?.contains(replay)).equals(true)
    expect(sections().textContent).not.includes('Replay')
    expect(sections().textContent).not.includes('Live')
    await tap(replay!)
    expect(counts.replays).equals(1)
  })

  it('is a member’s Live while the game is scored, with no inline live label', async function () {
    await page(gameWith({ status: 'inProgress', isGameLive: true }))
    expect(button()?.textContent).equals('Live')
    expect(hero()?.contains(button())).equals(true)
    expect(hero()?.querySelector('[aria-label="Live now"]')).equals(null)
    expect(sections().textContent).not.includes('Live')
  })

  for (const [why, fields] of [
    [
      'a scheduled game with scoring events',
      { status: 'scheduled', isGameLive: true }
    ],
    [
      'a game in progress with nothing TeamStation scored',
      { status: 'inProgress', isGameLive: true, replayable: false }
    ]
  ] as const)
    it(`draws neither a button nor a live label for ${why} the server calls live`, async function () {
      await page(gameWith(fields))
      expect(button()).equals(null)
      expect(hero()?.querySelector('[aria-label="Live now"]')).equals(null)
      expect(hero()?.textContent).not.includes('Live')
    })

  for (const [why, fields] of [
    ['scheduled', { status: 'scheduled', homeScore: null, awayScore: null }],
    ['cancelled', { status: 'cancelled' }],
    ['final with nothing stored', { replayable: false }]
  ] as const)
    it(`draws no button for a game ${why}`, async function () {
      await page(gameWith(fields))
      expect(hero()).not.equals(null)
      expect(button()).equals(null)
    })

  it('draws no button where the app cannot open the replay', async function () {
    await page(gameWith({}), { onReplay: false })
    expect(button()).equals(null)
  })

  it('moves the button beside the actions into the pill band on a phone held sideways on Videos', async function () {
    sideways()
    const counts = await page(
      gameWith({
        videos: [video],
        canScore: true,
        assignedRoles: { away: [], home: ['scorekeeper'] }
      }),
      { initialTab: 'watch' }
    )
    expect(hero()).equals(null)
    const band = document.querySelector<HTMLElement>(
      '[data-testid="event-pill-band"]'
    )
    const replay = button()
    expect(replay?.textContent).equals('Replay')
    expect(band?.contains(replay)).equals(true)
    expect(sections().contains(replay)).equals(false)
    const actions = band!.querySelector('[data-testid="game-hero-actions"]')
    expect(actions?.textContent).includes('Score')
    expect(
      actions!.compareDocumentPosition(replay!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    await tap(replay!)
    expect(counts.replays).equals(1)
  })

  it('keeps the button in the hero, and out of the pill band, on Info held sideways', async function () {
    sideways()
    await page(gameWith({ videos: [video] }))
    expect(hero()?.contains(button())).equals(true)
    const band = document.querySelector<HTMLElement>(
      '[data-testid="event-pill-band"]'
    )
    expect(band?.contains(button()) ?? false).equals(false)
  })

  it('offers a non-member the membership sheet for the live game and its replay, never the replay', async function () {
    const counts = await page(gameWith({ nonMemberView: true }))
    expect(button()?.textContent).equals('Replay')
    await tap(button()!)
    expect(document.body.textContent).includes(
      lstrings.game_replay_members_only
    )
    expect(sheetAction('Request membership')).not.equals(undefined)
    expect(counts.replays).equals(0)
  })

  it('offers the signed out the sheet with Log in / Sign up, which signs them in', async function () {
    const counts = await page(gameWith({ status: 'inProgress' }), {
      signedIn: false
    })
    expect(button()?.textContent).equals('Live')
    await tap(button()!)
    expect(document.body.textContent).includes(
      lstrings.game_replay_members_only
    )
    const signIn = sheetAction('Log in / Sign up')
    expect(signIn).not.equals(undefined)
    await tap(signIn!)
    expect(counts.signIns).equals(1)
    expect(counts.replays).equals(0)
  })

  it('opens nothing while the session is still being restored', async function () {
    const counts = await page(gameWith({}), { signedIn: null })
    const replay = button()!
    expect(getComputedStyle(replay).opacity).equals('0.5')
    await tap(replay)
    expect(document.body.textContent).not.includes(
      lstrings.game_replay_members_only
    )
    expect(counts.replays).equals(0)
  })

  it('still offers a non-member the videos sheet from the video preview', async function () {
    await page(gameWith({ nonMemberView: true, videos: [video] }), {
      initialTab: 'watch'
    })
    const preview = document.querySelector<HTMLElement>(
      '[data-testid="gameVideoPreview"]'
    )!
    await tap(preview)
    expect(document.body.textContent).includes(
      lstrings.game_videos_members_only
    )
    expect(document.body.textContent).not.includes(
      lstrings.game_replay_members_only
    )
  })

  it('holds Live still in a browser on Videos, where the video plays under it, and pulses it on Info', async function () {
    await page(gameWith({ status: 'inProgress', videos: [video] }))
    expect(await pulses(), 'Info').equals(true)
    await act(async () => root?.unmount())
    document.body.replaceChildren()
    await page(gameWith({ status: 'inProgress', videos: [video] }), {
      initialTab: 'watch'
    })
    expect(await pulses(), 'Videos').equals(false)
  })
})
