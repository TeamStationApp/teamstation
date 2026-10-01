import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  GameStationClient,
  SeasonGame,
  SeasonSummary,
  StandingsRow,
  TeamSummary
} from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { shortDate, shortDateNoWeekday } from './format'
import { SeasonScreen } from './SeasonScreen'
import type { When } from './whenFilter'

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (days: number): string =>
  new Date(Date.now() + days * DAY).toISOString()

function season(patch: Partial<SeasonSummary> = {}): SeasonSummary {
  return {
    id: 'sea_spring',
    leagueId: null,
    name: 'Spring 2026',
    year: 2026,
    term: null,
    ageGroup: null,
    teams: 6,
    games: 30,
    videos: 12,
    logoUrl: null,
    ...patch
  }
}

function team(
  id: string,
  name: string,
  patch: Partial<TeamSummary> = {}
): TeamSummary {
  return {
    id,
    name,
    shortName: null,
    logoPath: null,
    logoUrl: null,
    record: null,
    ...patch
  }
}

function game(id: string, patch: Partial<SeasonGame> = {}): SeasonGame {
  return {
    id,
    homeTeamId: 'tem_sox',
    awayTeamId: 'tem_hawks',
    homeTeamName: 'Bay Stars',
    awayTeamName: 'Alta Hawks',
    homeTeamExternal: false,
    awayTeamExternal: false,
    seasonId: 'sea_spring',
    startAt: daysFromNow(-10),
    venue: 'Field 3',
    status: 'final',
    homeScore: 4,
    awayScore: 7,
    ingestStatus: 'done',
    videoCount: 2,
    durationSec: 5400,
    posterUrl: null,
    isLive: false,
    externalIds: [],
    ...patch
  }
}

function standing(
  teamId: string,
  teamName: string,
  patch: Partial<StandingsRow> = {}
): StandingsRow {
  return {
    teamId,
    teamName,
    w: 0,
    l: 0,
    t: 0,
    runsFor: 0,
    runsAgainst: 0,
    played: 0,
    winningPct: null,
    runDifferential: 0,
    ...patch
  }
}

/** A finished game with video, one being played now, and one to come. */
const PLAYED = game('gam_played')
const LIVE = game('gam_live', {
  awayTeamName: 'Rivals',
  homeTeamName: 'Comets',
  startAt: daysFromNow(-0.01),
  awayScore: 1,
  homeScore: 0,
  isLive: true,
  durationSec: null,
  videoCount: 1
})
const AHEAD = game('gam_ahead', {
  awayTeamName: 'Comets',
  homeTeamName: 'Alta Hawks',
  startAt: daysFromNow(5),
  venue: null,
  awayScore: null,
  homeScore: null,
  status: 'scheduled',
  videoCount: 0,
  durationSec: null
})

const TEAMS = [
  team('tem_hawks', 'Alta Hawks', {
    record: { w: 12, l: 3, t: 0, seasonName: 'Spring 2026' }
  }),
  team('tem_sox', 'Bay Stars', {
    record: { w: 8, l: 6, t: 1, seasonName: 'Spring 2026' }
  }),
  team('tem_comets', 'Comets', { shortName: 'COM' }),
  team('tem_rivals', 'Rivals', { logoUrl: 'https://img.example/rivals.png' })
]

const STANDINGS = [
  standing('tem_hawks', 'Alta Hawks', {
    w: 12,
    l: 3,
    runsFor: 98,
    runsAgainst: 41,
    runDifferential: 57
  }),
  standing('tem_sox', 'Bay Stars', {
    w: 8,
    l: 6,
    t: 1,
    runsFor: 60,
    runsAgainst: 72,
    runDifferential: -12
  })
]

interface Setup {
  season?: SeasonSummary
  games?: () => Promise<SeasonGame[]>
  teams?: () => Promise<TeamSummary[]>
  standings?: () => Promise<StandingsRow[]>
  canManage?: boolean
  manage?: boolean
  initialTab?: string
  initialWhen?: When
}

interface Calls {
  games: Array<{ gameId: string; title: string; options?: unknown }>
  teams: TeamSummary[]
  tabs: Array<[string, boolean | undefined]>
  whens: When[]
  managed: number
  invites: string[]
  loads: string[]
}

async function mount(setup: Setup = {}): Promise<Calls> {
  const calls: Calls = {
    games: [],
    teams: [],
    tabs: [],
    whens: [],
    managed: 0,
    invites: [],
    loads: []
  }
  const client = {
    seasonGames: async (seasonId: string) => {
      calls.loads.push(`games ${seasonId}`)
      return await (setup.games ?? (async () => [PLAYED, LIVE, AHEAD]))()
    },
    seasonTeams: async (seasonId: string) => {
      calls.loads.push(`teams ${seasonId}`)
      return await (setup.teams ?? (async () => TEAMS))()
    },
    standings: async (seasonId: string) => {
      calls.loads.push(`standings ${seasonId}`)
      return await (setup.standings ?? (async () => STANDINGS))()
    },
    invites: async (scopeType: string, scopeId: string) => {
      calls.invites.push(`${scopeType} ${scopeId}`)
      return { canInvite: setup.canManage ?? true, invites: [] }
    }
  } as unknown as GameStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <SeasonScreen
          client={client}
          season={setup.season ?? season()}
          onOpenGame={(gameId, title, options) =>
            calls.games.push({ gameId, title, options })
          }
          onOpenTeam={opened => calls.teams.push(opened)}
          onManage={
            setup.manage === true
              ? () => {
                  calls.managed++
                }
              : undefined
          }
          initialTab={setup.initialTab}
          onTab={(tab, correcting) => calls.tabs.push([tab, correcting])}
          initialWhen={setup.initialWhen}
          onWhen={when => calls.whens.push(when)}
        />
      </ThemeProvider>
    )
    await delay(10)
  })
  return calls
}

function text(): string {
  return document.body.textContent ?? ''
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

/** A pressable whose spoken name starts with these words. */
function control(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ].filter(node => (node.getAttribute('aria-label') ?? '').startsWith(label))
  expect(found, label).has.lengthOf(1)
  return found[0]
}

function tabNames(strip: string): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[aria-label="${strip}"] [role="tab"]`
    )
  ].map(node => node.textContent ?? '')
}

/** The game rows on the schedule, by what each one says aloud. */
function gameRows(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="button"]')]
    .map(node => node.getAttribute('aria-label') ?? '')
    .filter(label => label.includes(' @ '))
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

describe('the season screen', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    delete (document.documentElement as unknown as Record<string, unknown>)
      .clientWidth
    window.dispatchEvent(new window.Event('resize'))
  })

  it('says it is loading until the season’s games, teams and standings arrive', async function () {
    let finish: (games: SeasonGame[]) => void = () => undefined
    const calls = await mount({
      games: async () =>
        await new Promise<SeasonGame[]>(resolve => {
          finish = resolve
        })
    })
    expect(calls.loads).deep.equals([
      'games sea_spring',
      'teams sea_spring',
      'standings sea_spring'
    ])
    expect(text()).includes('Loading…')
    expect(text()).not.includes('Nothing here yet.')
    await act(async () => {
      finish([PLAYED])
      await delay(10)
    })
    expect(text()).not.includes('Loading…')
    expect(text()).includes('1 game')
  })

  it('draws nothing from an answer that arrives after it has gone', async function () {
    let finish: (games: SeasonGame[]) => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    await mount({
      games: async () =>
        await new Promise<SeasonGame[]>(resolve => {
          finish = resolve
        })
    })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await act(async () => {
      finish([PLAYED])
      await delay(10)
    })
    expect(text()).equals('')

    await mount({
      games: async () =>
        await new Promise<SeasonGame[]>((_resolve, reject) => {
          fail = reject
        })
    })
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await act(async () => {
      fail(new Error('Too late'))
      await delay(10)
    })
    expect(text()).equals('')
  })

  it('shows the server’s reason when the season will not load', async function () {
    await mount({
      teams: async () => {
        throw new Error('Season not found')
      }
    })
    expect(text()).includes('Season not found')
    expect(text()).not.includes('Loading…')
    // The section is still drawn, with nothing in it.
    expect(text()).includes('Nothing here yet.')
  })

  it('says it cannot load when the failure is not an error', async function () {
    await mount({
      standings: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a rejection that is not an Error, as a broken proxy can send
        throw 'offline'
      }
    })
    expect(text()).includes('Cannot load')
  })

  it('names the season, its year, term and age group, and its counts', async function () {
    await mount({
      season: season({
        name: 'Summer league',
        year: 2025,
        term: 'Summer',
        ageGroup: '12U',
        teams: 8,
        games: 40,
        videos: 21
      })
    })
    expect(text()).includes('Summer league')
    expect(text()).includes('2025 · Summer · 12U')
    expect(text()).includes('TEAMS8')
    expect(text()).includes('GAMES40')
    expect(text()).includes('VIDEOS21')
    // No logo: the event glyph stands in, and there is no picture.
    expect(document.querySelector('img')).equals(null)
    expect(text()).includes('event')
  })

  it('shows just the year when there is no term or age group', async function () {
    await mount()
    expect(text()).includes('Spring 2026')
    expect(text()).includes('2026')
    expect(text()).not.includes('2026 ·')
  })

  it('shows the season’s own logo when it has one', async function () {
    await mount({ season: season({ logoUrl: 'https://img.example/s.png' }) })
    const picture = document.querySelector('img')
    expect(picture).not.equals(null)
    expect(picture!.getAttribute('src')).equals('https://img.example/s.png')
  })

  it('offers the manage gear only to an administrator who was given onManage', async function () {
    const calls = await mount({ manage: true })
    expect(calls.invites).deep.equals(['season sea_spring'])
    await press(labelled('Manage'))
    expect(calls.managed).equals(1)
    await act(async () => {
      root?.unmount()
    })

    const without = await mount()
    expect(without.invites).deep.equals([])
    expect(document.querySelector('[aria-label="Manage"]')).equals(null)
    await act(async () => {
      root?.unmount()
    })

    // Given onManage, but the server says this person may not.
    const refused = await mount({ manage: true, canManage: false })
    expect(refused.invites).deep.equals(['season sea_spring'])
    expect(document.querySelector('[aria-label="Manage"]')).equals(null)
  })

  it('opens on the schedule, past games first, with the filter beneath the sections', async function () {
    const calls = await mount()
    expect(tabNames('Season sections')).deep.equals([
      'Schedule',
      'Teams',
      'Standings'
    ])
    expect(tabNames('Which games')).deep.equals(['Past', 'Upcoming', 'All'])
    // Nothing to correct: no tab was asked for.
    expect(calls.tabs).deep.equals([])
    expect(text()).includes('2 games')
    // The live game is newest, so it is first, and says it is live rather
    // than giving a score that is still changing.
    const rows = gameRows()
    expect(rows).has.lengthOf(2)
    expect(rows[0]).includes('Rivals @ Comets')
    expect(rows[0]).includes('1 video')
    expect(rows[1]).includes('Alta Hawks @ Bay Stars')
    expect(rows[1]).includes('2 videos')
    expect(text()).includes('live')
    expect(text()).includes('7–4')
    expect(text()).includes('1:30:00')
    expect(text()).includes('Field 3')
    expect(text()).not.includes('Comets @ Alta Hawks')
  })

  it('filters the schedule to upcoming and all, and tells the shell', async function () {
    const calls = await mount()
    await press(control('Upcoming'))
    expect(calls.whens).deep.equals(['upcoming'])
    expect(text()).includes('1 game')
    const ahead = gameRows()
    expect(ahead).has.lengthOf(1)
    expect(ahead[0]).includes('Comets @ Alta Hawks')
    // Nothing recorded yet, so no video count in its line.
    expect(ahead[0]).not.includes('video')

    await press(control('All'))
    expect(calls.whens).deep.equals(['upcoming', 'all'])
    expect(text()).includes('3 games')
    expect(gameRows()).has.lengthOf(3)

    await press(control('Past'))
    expect(calls.whens).deep.equals(['upcoming', 'all', 'past'])
    expect(gameRows()).has.lengthOf(2)
  })

  it('opens on the filter the address names', async function () {
    const calls = await mount({ initialWhen: 'upcoming' })
    expect(gameRows()).has.lengthOf(1)
    expect(gameRows()[0]).includes('Comets @ Alta Hawks')
    expect(calls.whens).deep.equals([])
  })

  it('says so when no game matches the filter', async function () {
    await mount({ games: async () => [PLAYED] })
    await press(control('Upcoming'))
    expect(text()).includes('0 games')
    expect(text()).includes('Nothing here yet.')
  })

  it('opens a game with its title, playing it only when it has video', async function () {
    const calls = await mount({ initialWhen: 'all' })
    await press(control('Alta Hawks @ Bay Stars'))
    await press(control('Comets @ Alta Hawks'))
    expect(calls.games).deep.equals([
      {
        gameId: 'gam_played',
        title: 'Alta Hawks @ Bay Stars',
        options: { autoPlay: true }
      },
      {
        gameId: 'gam_ahead',
        title: 'Comets @ Alta Hawks',
        options: { autoPlay: false }
      }
    ])
  })

  it('drops the weekday from a game’s date on a phone, and keeps it wider', async function () {
    await mount({ games: async () => [PLAYED] })
    const phone = gameRows()[0]
    expect(phone).includes(shortDateNoWeekday(PLAYED.startAt))
    expect(phone).not.includes(shortDate(PLAYED.startAt))

    await setWidth(1200)
    const wide = gameRows()[0]
    expect(wide).includes(shortDate(PLAYED.startAt))
  })

  it('switches to the teams, with each record or short name, and opens one', async function () {
    const calls = await mount()
    await press(control('Teams'))
    expect(calls.tabs).deep.equals([['teams', undefined]])
    expect(text()).not.includes('Nothing here yet.')
    labelled('Alta Hawks, 12–3')
    labelled('Bay Stars, 8–6–1')
    labelled('Comets, COM')
    labelled('Rivals')
    expect(document.querySelector('img')!.getAttribute('src')).equals(
      'https://img.example/rivals.png'
    )
    await press(labelled('Bay Stars, 8–6–1'))
    expect(calls.teams.map(opened => opened.id)).deep.equals(['tem_sox'])
  })

  it('shows an empty team list as a count of nought', async function () {
    await mount({ teams: async () => [], initialTab: 'teams' })
    expect(text()).includes('TEAMS0')
  })

  it('switches to the standings, ranked, with the leader called out', async function () {
    const calls = await mount()
    await press(control('Standings'))
    expect(calls.tabs).deep.equals([['standings', undefined]])
    expect(text()).includes('2 teams')
    expect(text()).includes('TeamWLRFRADIFF')
    expect(text()).includes('1Alta Hawks1239841+57')
    expect(text()).includes('2Bay Stars866072-12')
    expect(text()).includes('Alta Hawks leads')
  })

  it('says when nothing in the season has been scored', async function () {
    await mount({ standings: async () => [], initialTab: 'standings' })
    expect(text()).includes('0 teams')
    expect(text()).includes('No games have been scored in this season yet.')
    expect(text()).not.includes('leads')
  })

  it('opens on the tab the address names, without correcting it', async function () {
    const calls = await mount({ initialTab: 'standings' })
    expect(text()).includes('Alta Hawks leads')
    expect(calls.tabs).deep.equals([])
  })

  it('corrects an address naming a tab it does not have', async function () {
    const calls = await mount({ initialTab: 'videos' })
    expect(calls.tabs).deep.equals([['schedule', true]])
    expect(gameRows()).has.lengthOf(2)
  })
})
