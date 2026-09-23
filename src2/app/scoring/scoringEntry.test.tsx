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
  it('renders Score Game between Videos and Box score and launches only on press', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => gameFixture
    client.teams = async () => []
    let opened = 0
    await render(
      <GameScreen
        client={client}
        gameId="g1"
        onScoreGame={() => {
          opened++
        }}
      />
    )
    expect(opened).equals(0)
    expect(button('Score Game')?.getAttribute('role')).equals('button')
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Videos')).lessThan(text.indexOf('Score Game'))
    expect(text.indexOf('Score Game')).lessThan(text.indexOf('Box score'))
    await act(async () => {
      button('Score Game')?.click()
    })
    expect(opened).equals(1)
  })
  it('does not offer scoring for a recorded 0–0 game', async function () {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => ({ ...gameFixture, awayScore: 0, homeScore: 0 })
    client.teams = async () => []
    await render(
      <GameScreen client={client} gameId="g1" onScoreGame={() => undefined} />
    )
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
      await render(
        <GameScreen client={client} gameId="g1" onScoreGame={() => undefined} />
      )
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
      scoringOwner: 'gamestation' as const,
      status: 'inProgress',
      awayScore: 1
    })
    client.teams = async () => []
    await render(
      <GameScreen client={client} gameId="g1" onScoreGame={() => undefined} />
    )
    expect(button('Continue Scoring')).not.equals(null)
  })
})

describe('scoring entry on the phones', function () {
  // The phone app draws the field through expo-gl, so the tab follows the
  // same rules there as in a browser: a scorekeeper, a game that can still be
  // scored, and somewhere to go.
  const web = Platform.OS
  afterEach(function () {
    Platform.OS = web
  })
  // Gesture Handler insists on its root view off the web, as `App.tsx` gives it.
  async function renderOn(
    os: 'ios' | 'android',
    element: React.ReactElement
  ): Promise<void> {
    Platform.OS = os
    await render(<GestureHandlerRootView>{element}</GestureHandlerRootView>)
  }
  async function tabs(
    os: 'ios' | 'android',
    game: typeof gameFixture
  ): Promise<{ score: boolean; resume: boolean }> {
    const client = new GameStationClient({ baseUrl: '/api/v1' })
    client.game = async () => game
    client.teams = async () => []
    await renderOn(
      os,
      <GameScreen client={client} gameId="g1" onScoreGame={() => undefined} />
    )
    const shown = {
      score: button('Score Game') != null,
      resume: button('Continue Scoring') != null
    }
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    return shown
  }
  for (const os of ['ios', 'android'] as const) {
    it(`shows Score Game on ${os} under the same rules as the web`, async function () {
      const inProgress = {
        ...gameFixture,
        scoringOwner: 'gamestation' as const,
        status: 'inProgress',
        awayScore: 1
      }
      expect(await tabs(os, gameFixture)).deep.equals({
        score: true,
        resume: false
      })
      expect(await tabs(os, inProgress)).deep.equals({
        score: false,
        resume: true
      })
      expect(
        await tabs(os, { ...gameFixture, awayScore: 0, homeScore: 0 })
      ).deep.equals({ score: false, resume: false })
      expect(await tabs(os, { ...gameFixture, canScore: false })).deep.equals({
        score: false,
        resume: false
      })
      expect(await tabs(os, { ...inProgress, canScore: false })).deep.equals({
        score: false,
        resume: false
      })
    })
    it(`opens the scorer on ${os} only on press`, async function () {
      const client = new GameStationClient({ baseUrl: '/api/v1' })
      client.game = async () => gameFixture
      client.teams = async () => []
      let opened = 0
      await renderOn(
        os,
        <GameScreen
          client={client}
          gameId="g1"
          onScoreGame={() => {
            opened++
          }}
        />
      )
      expect(opened).equals(0)
      await act(async () => {
        button('Score Game')?.click()
      })
      expect(opened).equals(1)
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
