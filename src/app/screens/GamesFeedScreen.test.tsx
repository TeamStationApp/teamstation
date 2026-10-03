import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { SeasonGame, TeamStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { shortDate, shortDateNoWeekday } from './format'
import { GamesFeedScreen } from './GamesFeedScreen'

let root: Root | undefined
let host: HTMLElement | undefined

const START = '2026-10-04T23:45:00.000Z'

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function game(id: string, patch: Partial<SeasonGame> = {}): SeasonGame {
  return {
    id,
    homeTeamId: 'tem_sox',
    awayTeamId: 'tem_bandits',
    homeTeamName: 'Sox',
    awayTeamName: 'Bandits',
    homeTeamExternal: false,
    awayTeamExternal: false,
    seasonId: 'sea_spring',
    startAt: START,
    venue: 'Field 2',
    status: 'final',
    homeScore: 0,
    awayScore: 4,
    ingestStatus: 'done',
    videoCount: 1,
    durationSec: 5400,
    posterUrl: null,
    homeLogoUrl: null,
    awayLogoUrl: null,
    isLive: false,
    externalIds: [],
    ...patch
  }
}

interface Opened {
  gameId: string
  title: string
  options?: { autoPlay?: boolean }
}

async function mount(
  mode: 'videos' | 'schedule',
  games: SeasonGame[]
): Promise<Opened[]> {
  const opened: Opened[] = []
  const client = {
    games: async () => games
  } as unknown as TeamStationClient
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <GamesFeedScreen
          client={client}
          mode={mode}
          initialWhen="all"
          onOpenGame={(gameId, title, options) => {
            opened.push({ gameId, title, options })
          }}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
  return opened
}

function text(): string {
  return host?.textContent ?? ''
}

function control(label: string): HTMLElement {
  const found = [
    ...(host?.querySelectorAll<HTMLElement>('[role="button"]') ?? [])
  ].filter(node => (node.getAttribute('aria-label') ?? '').startsWith(label))
  expect(found, label).has.lengthOf(1)
  return found[0]
}

async function press(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click()
    await delay(10)
  })
}

async function setWidth(width: number): Promise<void> {
  await act(async () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => width
    })
    window.dispatchEvent(new window.Event('resize'))
    await delay(10)
  })
}

describe('the games feed', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
      delete (document.documentElement as unknown as Record<string, unknown>)
        .clientWidth
      window.dispatchEvent(new window.Event('resize'))
    })
    root = undefined
    host?.remove()
    host = undefined
  })

  it('opens a schedule row, with and without a recording', async function () {
    const opened = await mount('schedule', [
      game('gam_final'),
      game('gam_now', {
        awayTeamName: 'Comets',
        homeTeamName: 'Hawks',
        status: 'inProgress',
        awayScore: 2,
        homeScore: 1,
        videoCount: 0
      })
    ])
    expect(host?.querySelector('img')).equals(null)
    expect(text()).includes('4–0')
    expect(text()).includes('LIVE')
    expect(text()).not.includes('2–1')
    await press(control('Bandits @ Sox'))
    await press(control('Comets @ Hawks'))
    expect(opened).deep.equals([
      {
        gameId: 'gam_final',
        title: 'Bandits @ Sox',
        options: { autoPlay: true }
      },
      {
        gameId: 'gam_now',
        title: 'Comets @ Hawks',
        options: { autoPlay: false }
      }
    ])
  })

  it('opens a video row for a live game, a score, and a game with no date', async function () {
    const opened = await mount('videos', [
      game('gam_live', {
        isLive: true,
        durationSec: 90,
        awayTeamName: 'Comets',
        homeTeamName: 'Hawks'
      }),
      game('gam_plain', {
        awayTeamName: 'Rivals',
        homeTeamName: 'Oaks',
        awayScore: 3,
        homeScore: 2,
        durationSec: null
      }),
      game('gam_open', {
        awayTeamName: 'Aces',
        homeTeamName: 'Bats',
        awayScore: null,
        homeScore: null,
        startAt: null,
        durationSec: null
      })
    ])
    expect(text()).includes('live')
    expect(text()).includes('3–2')
    expect(text()).includes('1:30')
    expect(text()).includes('Date to be confirmed')
    expect(text()).includes(shortDateNoWeekday(START))
    await press(control('Comets @ Hawks'))
    await press(control('Rivals @ Oaks'))
    expect(opened.map(item => item.gameId)).deep.equals([
      'gam_live',
      'gam_plain'
    ])
    expect(opened[0].options).deep.equals({ autoPlay: true })
    await setWidth(1440)
    expect(text()).includes(shortDate(START))
  })
})
