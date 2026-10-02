import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asLiveNow,
  asSeasonGame,
  asSeasonSummary,
  asTeamSummary,
  TeamStationClient
} from '../../common/api'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
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

const recent = asSeasonGame({
  id: 'gam_oct4',
  homeTeamId: 'tem_ag',
  awayTeamId: 'tem_br',
  homeTeamName: 'Allied Gardens',
  awayTeamName: 'Bandits (Ruden)',
  homeTeamExternal: false,
  awayTeamExternal: false,
  seasonId: null,
  startAt: '2026-10-04T19:30:00Z',
  venue: null,
  status: 'inProgress',
  homeScore: 0,
  awayScore: 0,
  ingestStatus: 'none',
  videoCount: 0,
  awayLogoUrl: 'https://space.example/bandits-96.png',
  homeLogoUrl: null
})

const team = asTeamSummary({
  id: 'tem_br',
  name: 'Bandits (Ruden)',
  shortName: null,
  logoPath: 'images/team/tem_br/abc',
  logoUrl: 'https://space.example/bandits-96.png'
})

const season = asSeasonSummary({
  id: 'sea_fall',
  leagueId: null,
  name: 'NPLL Fall 2026',
  year: 2026,
  term: null,
  ageGroup: null,
  teams: 6,
  games: 30,
  videos: 12
})

interface Opened {
  teams: string[]
  seasons: string[]
  games: Array<{ id: string; options: unknown }>
}

async function renderHome(
  setup: (client: TeamStationClient) => void = () => undefined
): Promise<{ container: HTMLElement; opened: Opened }> {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.teams = async () => [team]
  client.seasons = async () => [season]
  client.liveNow = async () => []
  client.recentGame = async () => recent
  setup(client)
  const opened: Opened = { teams: [], seasons: [], games: [] }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <GestureHandlerRootView>
          <HomeScreen
            client={client}
            onOpenTeam={opened_ => opened.teams.push(opened_.id)}
            onOpenSeason={opened_ => opened.seasons.push(opened_.id)}
            onOpenGame={(id, _title, options) =>
              opened.games.push({ id, options })
            }
          />
        </GestureHandlerRootView>
      </ThemeProvider>
    )
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return { container: host, opened }
}

function leaf(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).find(
    node => node.children.length === 0 && node.textContent === text
  )
}

async function press(container: HTMLElement, label: string): Promise<void> {
  const node = Array.from(
    container.querySelectorAll<HTMLElement>('[role="button"], [aria-label]')
  ).find(
    one =>
      one.getAttribute('aria-label') === label ||
      // A button's text runs on from its icon's ligature name.
      one.textContent?.trim().endsWith(label) === true
  )
  if (node == null) throw new Error(`nothing to press for ${label}`)
  await act(async () => {
    node.click()
  })
}

describe('HomeScreen', function () {
  it('shows the recent game with the logo of a side that has one', async function () {
    const { container } = await renderHome()
    expect(container.textContent).includes('Bandits (Ruden)')
    expect(container.innerHTML).includes('bandits-96.png')
    // The side with no logo gets its tile instead, not a picture.
    expect(leaf(container, 'AG')).not.equals(undefined)
    expect(leaf(container, 'BR')).equals(undefined)
  })

  it('lists the teams and seasons, and opens what is pressed', async function () {
    const { container, opened } = await renderHome()
    expect(container.textContent).includes('NPLL Fall 2026')
    await press(container, 'Box Score')
    expect(opened.games).deep.equals([
      { id: 'gam_oct4', options: { tab: 'boxScore' } }
    ])
    const teamRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]')
    ).find(node => node.textContent?.includes('Bandits (Ruden)') === true)
    if (teamRow == null) throw new Error('no team row')
    await act(async () => {
      teamRow.click()
    })
    expect(opened.teams).includes('tem_br')
    const seasonRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]')
    ).find(node => node.textContent?.includes('NPLL Fall 2026') === true)
    if (seasonRow == null) throw new Error('no season row')
    await act(async () => {
      seasonRow.click()
    })
    expect(opened.seasons).includes('sea_fall')
  })

  it('plays a recent game that has a recording, and offers to watch it', async function () {
    const playbacks: string[] = []
    const { container, opened } = await renderHome(client => {
      client.recentGame = async () => ({
        ...recent,
        status: 'final',
        videoCount: 1,
        posterUrl: 'https://space.example/poster.jpg'
      })
      client.game = async () => ({
        ...gameFixture,
        id: 'gam_oct4',
        videos: [
          {
            ...gameFixture.videos[0],
            id: 'vid_1',
            kind: 'game',
            title: 'Primary',
            status: 'ready',
            storage: 'spaces',
            startAt: null,
            syncOffsetSec: 0,
            durationSec: 600,
            width: 1920,
            height: 1080,
            codecs: null,
            numCameras: 1,
            posterUrl: null
          }
        ]
      })
      client.playback = async (videoId: string) => {
        playbacks.push(videoId)
        return {
          videoId,
          storage: 'spaces',
          url: 'https://media.example/vid_1.m3u8',
          expiresAt: null,
          durationSec: 600,
          unavailable: false
        }
      }
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(playbacks).includes('vid_1')
    await press(container, 'Watch')
    expect(opened.games).deep.equals([
      { id: 'gam_oct4', options: { autoPlay: true } }
    ])
  })

  it('puts a game being streamed right now at the top', async function () {
    const { container } = await renderHome(client => {
      client.liveNow = async () => [
        asLiveNow({
          videoId: 'vid_live',
          gameId: 'gam_oct4',
          title: 'Live',
          homeTeamName: 'Allied Gardens',
          awayTeamName: 'Bandits (Ruden)',
          startedAt: null,
          gameStartAt: '2026-10-04T19:30:00Z'
        }),
        // A second game on at the same time is listed under the first.
        asLiveNow({
          videoId: 'vid_other',
          gameId: 'gam_other',
          title: 'Live',
          homeTeamName: 'Trosky Force 11U',
          awayTeamName: 'SD Natives 11U',
          startedAt: '2026-10-04T19:35:00Z',
          gameStartAt: '2026-10-04T19:30:00Z'
        })
      ]
      client.playback = async (videoId: string) => ({
        videoId,
        storage: 'local',
        url: 'https://media.example/live.m3u8',
        expiresAt: null,
        durationSec: null,
        unavailable: false
      })
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(container.textContent).includes('LIVE NOW')
    expect(container.textContent).includes('Trosky Force 11U')
  })

  it('says what went wrong when the teams cannot be read', async function () {
    const { container } = await renderHome(client => {
      client.teams = async () => {
        throw new Error('The server is down')
      }
    })
    expect(container.textContent).includes('The server is down')
  })
})
