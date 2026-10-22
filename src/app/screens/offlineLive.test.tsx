import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { asLiveNow, asSeasonGame, asTeamSummary } from '../../common/api'
import { CachingClient } from '../sync/cachingClient'
import { OFFLINE_UNPLAYABLE } from '../sync/useOffline'
import { ThemeProvider } from '../theme/ThemeContext'
import { GamesFeedScreen } from './GamesFeedScreen'
import { HomeScreen } from './HomeScreen'

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/** A game whose camera was publishing when the phone last read it. */
const streaming = asSeasonGame({
  id: 'gam_live',
  homeTeamId: 'tem_sox',
  awayTeamId: 'tem_badgers',
  homeTeamName: 'Sox',
  awayTeamName: 'Badgers',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: null,
  startAt: '2026-10-04T19:30:00Z',
  venue: null,
  status: 'inProgress',
  homeScore: 1,
  awayScore: 0,
  ingestStatus: 'none',
  videoCount: 1,
  isLive: true
})

/** The phone's client, its last request failed to leave the device. */
function phone(offline: boolean): CachingClient {
  const client = new CachingClient({
    baseUrl: 'http://x/api/v1',
    openCache: async () => {
      throw new Error('no file')
    }
  })
  client.offline = offline
  return client
}

async function draw(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <GestureHandlerRootView>{element}</GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

const text = (): string => host?.textContent ?? ''

describe('a live game the phone read before it lost signal', function () {
  for (const offline of [true, false])
    it(`is ${offline ? 'not ' : ''}offered to play on Videos ${offline ? 'offline' : 'online'}`, async function () {
      const client = phone(offline)
      client.games = async () => [streaming]
      const opened: unknown[] = []
      await draw(
        <GamesFeedScreen
          client={client}
          mode="videos"
          onOpenGame={(_id, _title, options) => opened.push(options)}
        />
      )
      expect(text().includes(OFFLINE_UNPLAYABLE)).equals(offline)
      expect(text().includes('live')).equals(!offline)
      const row = [
        ...(host?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])
      ].find(node => node.textContent?.includes('Badgers') === true)!
      await act(async () => {
        row.click()
      })
      expect(opened).deep.equals([{ tab: 'watch', autoPlay: !offline }])
    })

  it('is not offered on Home offline: no Live now, and no Watch on the recent game', async function () {
    const client = phone(true)
    client.teams = async () => [
      asTeamSummary({
        id: 'tem_sox',
        name: 'Sox',
        shortName: null,
        logoPath: null,
        logoUrl: null
      })
    ]
    client.seasons = async () => []
    client.recentGame = async () => streaming
    client.liveNow = async () => [
      asLiveNow({
        gameId: 'gam_live',
        videoId: 'vid_live',
        homeTeamName: 'Sox',
        awayTeamName: 'Badgers',
        title: 'Badgers at Sox',
        startedAt: null,
        gameStartAt: '2026-10-04T19:30:00Z',
        angles: 1
      })
    ]
    client.game = async () => {
      throw new Error('not on the phone')
    }
    await draw(
      <HomeScreen
        client={client}
        onOpenTeam={() => undefined}
        onOpenSeason={() => undefined}
        onOpenGame={() => undefined}
      />
    )
    expect(text().toLowerCase()).includes('recent game')
    expect(text()).includes(OFFLINE_UNPLAYABLE)
    expect(text().toLowerCase()).not.includes('live now')
    expect(text()).not.includes('Watch')
  })
})
