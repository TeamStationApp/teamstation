import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asBattingRow,
  asPitchingRow,
  asVideoSummary,
  GameStationClient
} from '../../common/api'
import { ScoreGameScreen } from '../scoreboard/ScoreGameScreen'
import { GameScreen } from '../screens/GameScreen'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'

let root: Root | undefined
async function render(element: React.ReactElement): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}
function button(label: string): HTMLElement | null {
  return document.querySelector(`[aria-label="${label}"]`)
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})
describe('actual game scoring entry', function () {
  it('renders Score Game after Box score and Videos, and shows its choices under the pills', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({ ...gameFixture, canScore: true })
    client.teams = async () => []
    await render(<GameScreen client={client} gameId="g1" />)
    expect(button('Score Game')?.getAttribute('role')).equals('tab')
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Box score')).lessThan(text.indexOf('Videos'))
    expect(text.indexOf('Videos')).lessThan(text.indexOf('Score Game'))
    expect(text).includes('Owls')
    expect(text).not.includes('Full game scoring')
    await act(async () => {
      button('Score Game')?.click()
    })
    const next = document.body.textContent ?? ''
    expect(next).includes('Owls')
    expect(next).includes('Full game scoring')
    expect(next.indexOf('Owls')).lessThan(next.indexOf('Full game scoring'))
    expect(button('Videos')).not.equals(null)
    expect(button('Box score')).not.equals(null)
  })
  it('launches full scoring from the Score Game screen, for a game in progress too', async function () {
    for (const game of [
      gameFixture,
      { ...gameFixture, scoringOwner: 'gamestation' as const, homeScore: 1 }
    ]) {
      const client = new GameStationClient({ baseUrl: '/api/v1' })
      client.game = async () => ({ ...game, canScore: true })
      let scored = 0
      await render(
        <ScoreGameScreen
          client={client}
          gameId="g1"
          onFullScoring={() => {
            scored++
          }}
          onScoreboard={() => undefined}
        />
      )
      await act(async () => {
        button('Full game scoring')?.click()
      })
      expect(scored).equals(1)
      await act(async () => {
        root?.unmount()
      })
    }
  })
  it('does not offer scoring for a recorded 0–0 game', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      canScore: true,
      awayScore: 0,
      homeScore: 0
    })
    client.teams = async () => []
    await render(<GameScreen client={client} gameId="g1" />)
    expect(button('Score Game')).equals(null)
    expect(button('Videos')).not.equals(null)
    expect(button('Box score')).not.equals(null)
  })
  it('offers scoring only to a scorekeeper, never to a member, coach or songkeeper', async function () {
    // The server says `canScore: false` to everybody who is not a
    // scorekeeper or an administrator of either team; a coach and a
    // songkeeper are two of them, and read exactly as a member does.
    for (const game of [
      { ...gameFixture, canScore: false },
      {
        ...gameFixture,
        canScore: false,
        scoringOwner: 'gamestation' as const,
        status: 'inProgress',
        awayScore: 1
      }
    ]) {
      const client = new GameStationClient({ baseUrl: '/api/v1' })
      client.game = async () => game
      client.teams = async () => []
      await render(<GameScreen client={client} gameId="g1" />)
      expect(button('Score Game')).equals(null)
      expect(button('Continue Scoring')).equals(null)
      expect(button('Box score')).not.equals(null)
      await act(async () => {
        root?.unmount()
      })
    }
    // The same game, seen by its scorekeeper, is scored.
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      canScore: true,
      scoringOwner: 'gamestation' as const,
      status: 'inProgress',
      awayScore: 1
    })
    client.teams = async () => []
    await render(<GameScreen client={client} gameId="g1" />)
    expect(button('Score Game')).not.equals(null)
  })
})

describe('scoring entry on the phones', function () {
  // Score Game is a tab of the game page on every platform, for the same
  // people, and sits immediately before DJ Game where there is one.
  const web = Platform.OS
  afterEach(function () {
    Platform.OS = web
  })
  async function renderOn(
    os: 'ios' | 'android',
    element: React.ReactElement
  ): Promise<void> {
    Platform.OS = os
    await render(<GestureHandlerRootView>{element}</GestureHandlerRootView>)
  }
  function pills(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))
      .map(node => node.getAttribute('aria-label') ?? '')
      .filter(label =>
        ['Box score', 'Videos', 'Score Game', 'DJ Game'].includes(label)
      )
  }
  for (const os of ['ios', 'android'] as const) {
    it(`offers Score Game on ${os}, before DJ Game`, async function () {
      const client = new GameStationClient({ baseUrl: '/api/v1' })
      client.game = async () => ({
        ...gameFixture,
        canScore: true,
        canDj: true
      })
      client.teams = async () => []
      await renderOn(
        os,
        <GameScreen
          client={client}
          gameId="g1"
          music={{ available: true }}
          onDjGame={() => undefined}
        />
      )
      expect(pills()).deep.equals([
        'Box score',
        'Videos',
        'Score Game',
        'DJ Game'
      ])
      expect(button('Continue Scoring')).equals(null)
    })

    it(`does not offer Score Game on ${os} to somebody who may not score`, async function () {
      const client = new GameStationClient({ baseUrl: '/api/v1' })
      client.game = async () => ({ ...gameFixture, canScore: false })
      client.teams = async () => []
      await renderOn(os, <GameScreen client={client} gameId="g1" />)
      expect(button('Score Game')).equals(null)
      expect(button('Box score')).not.equals(null)
    })
  }
})

describe('game actions preserve box score and videos', function () {
  it('keeps both teams statistics usable beside the new entry', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({
      ...gameFixture,
      linescore: {
        away: { runs: [1, 0], r: 1, h: 2, e: 0, bb: 0, k: 2, hr: 0, hbp: 0 },
        home: {
          runs: [0],
          r: 0,
          h: null,
          e: null,
          bb: null,
          k: null,
          hr: null,
          hbp: null
        }
      }
    })
    client.teams = async () => []
    client.boxScore = async () => ({
      stats: undefined,
      batting: [
        asBattingRow({
          userId: 1,
          shortName: 'Alex',
          teamId: 'away',
          pa: 2,
          ab: 2,
          h: 1,
          singles: 1,
          doubles: 0,
          triples: 0,
          hr: 0,
          bb: 0,
          k: 1,
          hbp: 0,
          rbi: 1,
          rates: { avg: 0.5, obp: 0.5, slg: 0.5, ops: 1 }
        })
      ],
      pitching: [
        asPitchingRow({
          userId: 2,
          shortName: 'Blake',
          teamId: 'home',
          ip: '1.0',
          outs: 3,
          bf: 4,
          h: 1,
          hr: 0,
          hbp: 0,
          r: 1,
          bb: 0,
          k: 1,
          rates: { era: 7, whip: 1 }
        })
      ]
    })
    const opened: number[] = []
    const from: unknown[] = []
    await render(
      <GameScreen
        client={client}
        gameId="g1"
        onOpenPlayer={(id, _name, side) => {
          opened.push(id)
          from.push(side)
        }}
      />
    )
    await act(async () => {
      button('Box score')?.click()
    })
    expect(document.body.textContent).includes('Alex')
    expect(document.body.textContent).includes('Blake')
    await act(async () => {
      button('Alex')?.click()
      button('Blake')?.click()
    })
    expect(opened).deep.equals([1, 2])
    // Each line opens the player on its own side: the Stats filter, and the
    // team a coach's Settings tab edits them on.
    expect(from).deep.equals([
      { seasonId: undefined, teamId: 'away', onTeam: 'away' },
      { seasonId: undefined, teamId: 'home', onTeam: 'home' }
    ])
    await act(async () => {
      button('Videos')?.click()
    })
    expect(button('Box score')?.getAttribute('aria-selected')).not.equals(
      'true'
    )
  })
  it('switches available recordings and returns from the box score at the same moment', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    const video = asVideoSummary({
      id: 'v1',
      title: 'Game — Home plate',
      numCameras: 1,
      kind: 'primary',
      status: 'ready',
      storage: 'local',
      startAt: '2026-09-22T10:00:00Z',
      durationSec: 300,
      width: 1920,
      height: 1080,
      codecs: null
    })
    client.game = async () => ({
      ...gameFixture,
      videos: [video, { ...video, id: 'v2', title: 'Game — Outfield' }]
    })
    client.teams = async () => []
    client.highlights = async () => ({
      withheld: null,
      droppedCount: 0,
      highlights: [
        {
          eventId: 'e1',
          atBatIndex: 1,
          title: 'Alex single',
          startOffsetSec: 20,
          playOffsetSec: 23,
          eventType: 'single',
          isScoringPlay: true,
          stillUrl: '',
          description: 'Alex reaches first.'
        }
      ]
    })
    client.playback = async id => ({
      videoId: id,
      storage: 'local',
      url: '/sample.mp4',
      expiresAt: null,
      durationSec: 300,
      unavailable: false
    })
    client.boxScore = async () => ({
      batting: [],
      pitching: [],
      stats: undefined
    })
    // Save the host method for restoration; it is never called unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const play = window.HTMLMediaElement.prototype.play
    // Save the host method for restoration; it is never called unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const pause = window.HTMLMediaElement.prototype.pause
    // Save the host method for restoration; it is never called unbound.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const load = window.HTMLMediaElement.prototype.load
    window.HTMLMediaElement.prototype.play = async () => undefined
    window.HTMLMediaElement.prototype.pause = () => undefined
    window.HTMLMediaElement.prototype.load = () => undefined
    const moments: Array<[string, number]> = []
    try {
      await render(
        <GameScreen
          client={client}
          gameId="g1"
          autoPlay
          startAtSec={7}
          onMoment={(id, sec) => {
            moments.push([id, sec])
          }}
        />
      )
      const player = document.querySelector('video')
      expect(player).not.equals(null)
      await act(async () => {
        player?.dispatchEvent(new window.Event('loadedmetadata'))
      })
      expect(player?.currentTime).equals(7)
      const highlight = Array.from(
        document.querySelectorAll<HTMLElement>('[tabindex="0"]')
      ).find(node => node.textContent?.includes('Alex single') === true)
      await act(async () => {
        highlight?.click()
      })
      expect(moments).deep.includes(['v1', 20])
      await act(async () => {
        button('Outfield')?.click()
      })
      await act(async () => {
        player?.dispatchEvent(new window.Event('loadedmetadata'))
      })
      expect(moments.some(([id]) => id === 'v2')).equals(true)
      await act(async () => {
        button('Box score')?.click()
      })
      await act(async () => {
        button('Videos')?.click()
      })
      const restored = document.querySelector('video')
      await act(async () => {
        restored?.dispatchEvent(new window.Event('loadedmetadata'))
      })
      expect(restored?.currentTime).equals(20)
    } finally {
      await act(async () => {
        root?.unmount()
        root = undefined
      })
      window.HTMLMediaElement.prototype.play = play
      window.HTMLMediaElement.prototype.pause = pause
      window.HTMLMediaElement.prototype.load = load
    }
  })
})
