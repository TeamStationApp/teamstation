import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  SeasonGame,
  SeasonSummary,
  StandingsRow,
  TeamStationClient,
  TeamSummary
} from '../../common/api'
import { asSeasonGame, asStandingsRow, asTeamSummary } from '../../common/api'
import {
  asGroupDetail,
  asPublicGroup,
  type GroupDetail
} from '../../common/publicGroups'
import { seasonParticipantDestination } from '../navigation/seasonParticipant'
import { ThemeProvider } from '../theme/ThemeContext'
import { scheduleDate, shortDate, shortTime } from './format'
import { SeasonScreen } from './SeasonScreen'
import { battingFixture, pitchingFixture } from './statColumns.test'
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
  return asTeamSummary({
    id,
    name,
    shortName: null,
    logoPath: null,
    logoUrl: null,
    record: null,
    kind: 'full',
    seasonCategory: 'inSeason',
    ...patch
  })
}

function game(id: string, patch: Partial<SeasonGame> = {}): SeasonGame {
  return asSeasonGame({
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
    homeLogoUrl: null,
    awayLogoUrl: null,
    isLive: false,
    externalIds: [],
    exhibition: false,
    timezone: 'UTC',
    pendingApproval: false,
    pendingRequestId: null,
    ...patch
  })
}

function standing(
  teamId: string,
  teamName: string,
  patch: Partial<StandingsRow> = {}
): StandingsRow {
  return asStandingsRow({
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
    logoUrl: null,
    teamKind: 'full',
    gamesBehind: null,
    streak: null,
    home: { w: 0, l: 0, t: 0 },
    away: { w: 0, l: 0, t: 0 },
    ...patch
  })
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
  defaultTab?: boolean
  publicDetail?: GroupDetail
  stats?: () => Promise<{
    seasonId: string
    batting: Array<typeof battingFixture>
    pitching: Array<typeof pitchingFixture>
  }>
}

interface Calls {
  client?: TeamStationClient
  games: Array<{ gameId: string; title: string; options?: unknown }>
  teams: TeamSummary[]
  tabs: Array<[string, boolean | undefined]>
  whens: When[]
  managed: number
  invites: string[]
  loads: string[]
  filters: boolean[]
  refresh?: (detail: GroupDetail) => Promise<void>
}

async function mount(setup: Setup = {}): Promise<Calls> {
  const calls: Calls = {
    games: [],
    teams: [],
    tabs: [],
    whens: [],
    managed: 0,
    invites: [],
    loads: [],
    filters: []
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
    standings: async (
      seasonId: string,
      options: { includeExhibitions: boolean }
    ) => {
      calls.loads.push(`standings ${seasonId}`)
      calls.filters.push(options.includeExhibitions)
      return await (setup.standings ?? (async () => STANDINGS))()
    },
    seasonStats: async (seasonId: string) => {
      calls.loads.push(`stats ${seasonId}`)
      return await (
        setup.stats ?? (async () => ({ seasonId, batting: [], pitching: [] }))
      )()
    },
    invites: async (scopeType: string, scopeId: string) => {
      calls.invites.push(`${scopeType} ${scopeId}`)
      return { canInvite: setup.canManage ?? true, invites: [] }
    },
    // A public visitor's Follow asks what they follow; nothing here.
    follows: async () => [],
    // Whether the People tab shows; App.teamRoutes.test.tsx covers it.
    group: async () => ({ canSeePeople: false })
  } as unknown as TeamStationClient
  calls.client = client
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (): void => {
    root!.render(
      <ThemeProvider>
        <SeasonScreen
          client={client}
          season={setup.season ?? season()}
          onOpenGame={(gameId, title, options) =>
            calls.games.push({ gameId, title, options })
          }
          onOpenTeam={opened => calls.teams.push(opened)}
          onSettings={
            setup.manage === true
              ? () => {
                  calls.managed++
                }
              : undefined
          }
          initialTab={
            setup.defaultTab === true
              ? undefined
              : (setup.initialTab ?? 'schedule')
          }
          publicDetail={setup.publicDetail}
          onTab={(tab, correcting) => calls.tabs.push([tab, correcting])}
          initialWhen={setup.initialWhen}
          onWhen={when => calls.whens.push(when)}
        />
      </ThemeProvider>
    )
  }
  calls.refresh = async detail => {
    setup.publicDetail = detail
    await act(async () => {
      render()
      await delay(10)
    })
  }
  await act(async () => {
    render()
    await delay(10)
  })
  return calls
}

function text(): string {
  return document.body.textContent ?? ''
}

function statisticsScroll(column = 'W'): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('div')].find(
    node =>
      window.getComputedStyle(node).overflowX === 'auto' &&
      [...node.querySelectorAll('div')].some(
        cell => cell.children.length === 0 && cell.textContent === column
      )
  )
  expect(found, 'horizontal statistics scroll').not.equals(undefined)
  return found!
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

/** A pressable whose spoken name starts with these words. */
/** Not in a pill page kept out of sight, which nobody can reach. */
function reachable(node: HTMLElement): boolean {
  return node.closest('[data-page-role="kept"]') == null
}

function control(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"], [role="tab"]')
  ]
    .filter(reachable)
    .filter(node => (node.getAttribute('aria-label') ?? '').startsWith(label))
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
    .filter(reachable)
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
  const privateDetail = (): GroupDetail =>
    asGroupDetail({
      nonMemberView: false,
      group: asPublicGroup({
        id: 'sea_spring',
        kind: 'season',
        name: 'Spring 2026',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      games: [],
      staff: [],
      canManage: true,
      canViewPrivate: true
    })
  it('uses each participant permission from Teams and Standings on a direct season', async function () {
    const participants = [
      team('tem_owned', 'Owned participant', { canViewPrivate: true }),
      team('tem_guest', 'Visiting participant', { canViewPrivate: false }),
      team('tem_placeholder', 'Custodied placeholder', {
        kind: 'external',
        canViewPrivate: false
      })
    ]
    const calls = await mount({
      initialTab: 'teams',
      teams: async () => participants,
      standings: async () =>
        participants.map(item => standing(item.id, item.name))
    })
    for (const item of participants) await press(control('Open ' + item.name))
    await press(control('Standings'))
    for (const item of participants) await press(control('Open ' + item.name))
    expect(calls.teams.map(seasonParticipantDestination)).deep.equals(
      [...participants, ...participants].map(item =>
        item.canViewPrivate
          ? { name: 'team', team: item }
          : { name: 'group', kind: 'team', id: item.id }
      )
    )
  })
  it('refreshes Home-linked private collections while retaining standings, selections and horizontal position', async function () {
    let finish!: (rows: StandingsRow[]) => void
    let refreshing = false
    let loadedGames = [AHEAD]
    let loadedTeams = TEAMS
    const calls = await mount({
      publicDetail: privateDetail(),
      initialTab: 'standings',
      initialWhen: 'all',
      games: async () => loadedGames,
      teams: async () => loadedTeams,
      standings: async () =>
        refreshing
          ? await new Promise(resolve => {
              finish = resolve
            })
          : STANDINGS
    })
    await press(control('Include Exhibitions'))
    const table = statisticsScroll()
    table.scrollLeft = 73
    refreshing = true
    loadedGames = [
      game('gam_accepted', { venue: 'Accepted field', pendingApproval: false })
    ]
    loadedTeams = [team('tem_new', 'New participant')]
    await calls.refresh!(privateDetail())
    expect(statisticsScroll()).equals(table)
    expect(table.scrollLeft).equals(73)
    expect(text()).not.includes('Loading standings')
    expect(calls.filters).deep.equals([false, true, true])
    await act(async () => {
      finish([standing('tem_new', 'New participant', { w: 1 })])
      await delay(10)
    })
    expect(text()).includes('New participant')
    expect(table.scrollLeft).equals(73)
    await press(control('Schedule'))
    expect(text()).includes('Accepted field')
    expect(control('All').getAttribute('aria-selected')).equals('true')
    expect(text()).not.includes('Pending approval')
    await press(control('Teams'))
    expect(text()).includes('New participant')
    expect(calls.loads.filter(load => load.startsWith('games'))).has.lengthOf(2)
    expect(calls.loads.filter(load => load.startsWith('teams'))).has.lengthOf(2)
  })
  it('refreshes visible statistics without unmounting the table and ignores superseded parent responses', async function () {
    let mode = 0
    let finishGames!: (rows: SeasonGame[]) => void
    let finishStats!: (rows: {
      seasonId: string
      batting: Array<typeof battingFixture>
      pitching: Array<typeof pitchingFixture>
    }) => void
    const calls = await mount({
      publicDetail: privateDetail(),
      initialTab: 'stats',
      initialWhen: 'all',
      games: async () =>
        mode === 1
          ? await new Promise(resolve => {
              finishGames = resolve
            })
          : [
              game('gam_fresh', {
                venue: mode === 2 ? 'Fresh field' : 'Original field'
              })
            ],
      stats: async () =>
        mode === 1
          ? await new Promise(resolve => {
              finishStats = resolve
            })
          : {
              seasonId: 'sea_spring',
              batting: [
                {
                  ...battingFixture,
                  shortName: mode === 2 ? 'Fresh player' : 'Original player'
                }
              ],
              pitching: []
            }
    })
    const table = statisticsScroll('PA')
    mode = 1
    await calls.refresh!(privateDetail())
    expect(statisticsScroll('PA')).equals(table)
    expect(text()).includes('Original player')
    mode = 2
    await calls.refresh!(privateDetail())
    expect(text()).includes('Fresh player')
    await act(async () => {
      finishGames([game('gam_stale', { venue: 'Stale field' })])
      finishStats({
        seasonId: 'sea_spring',
        batting: [{ ...battingFixture, shortName: 'Stale player' }],
        pitching: []
      })
      await delay(10)
    })
    expect(text()).includes('Fresh player')
    expect(text()).not.includes('Stale player')
    await press(control('Schedule'))
    expect(text()).includes('Fresh field')
    expect(text()).not.includes('Stale field')
    expect(calls.loads.filter(load => load.startsWith('stats'))).has.lengthOf(3)
  })
  it('does not load private collections when a public parent refreshes', async function () {
    const detail = {
      ...privateDetail(),
      canViewPrivate: false,
      canManage: false
    }
    const calls = await mount({ publicDetail: detail, initialTab: 'schedule' })
    await calls.refresh!({ ...detail })
    expect(calls.loads).deep.equals([])
    expect(tabNames('Season sections')).deep.equals([
      'Schedule',
      'Teams',
      'Chats'
    ])
  })

  it('keeps public approved scores and cancellation history informational without private reads', async function () {
    const base = {
      homeTeam: { id: 'tem_home', name: 'Demo Host' },
      awayTeam: { id: 'tem_guest', name: 'Demo Visitor' },
      seasonId: 'sea_spring',
      startAt: daysFromNow(-1),
      venue: 'Demo Public Field',
      homeScore: 4,
      awayScore: 2,
      withdrawnByTeamId: null,
      pendingApproval: false,
      pendingRequestId: null
    }
    const publicDetail = asGroupDetail({
      nonMemberView: false,
      group: asPublicGroup({
        id: 'sea_spring',
        kind: 'season',
        name: 'Spring 2026',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      staff: [],
      canManage: false,
      canViewPrivate: false,
      games: [
        {
          ...base,
          id: 'gam_public_final',
          isUmpire: true,
          isGameLive: true,
          status: 'final',
          cancellationReason: null
        },
        {
          ...base,
          id: 'gam_public_withdrawn',
          isUmpire: true,
          isGameLive: true,
          status: 'cancelled',
          cancellationReason: 'withdrawal',
          withdrawnByTeamName: 'Demo Visitor'
        },
        {
          ...base,
          id: 'gam_public_replaced',
          status: 'cancelled',
          cancellationReason: 'replacement',
          homeScore: null,
          awayScore: null
        }
      ]
    })
    const calls = await mount({
      publicDetail,
      initialTab: 'schedule',
      initialWhen: 'all'
    })
    expect(text()).includes('final · 2–4')
    const badges = [
      ...document.querySelectorAll('[data-testid="settings-pill-badge"]')
    ]
    expect(badges.map(b => b.textContent)).deep.equals(['UMP', 'LIVE'])
    expect(badges[0].parentElement).equals(badges[1].parentElement)
    expect(text()).includes(
      `${shortDate(base.startAt)} · ${shortTime(base.startAt)} · Demo Public Field`
    )
    expect(text()).includes('Canceled — Demo Visitor withdrew')
    expect(text().match(/Canceled/g)).has.lengthOf(2)
    expect(
      document.querySelector('[aria-label^="Open game proposal for "]')
    ).equals(null)
    expect(calls.loads).deep.equals([])
    expect(calls.games).deep.equals([])
  })
  for (const pendingRequestId of ['req_visiting_team', null]) {
    it(`keeps visiting-team season request access scoped when private collection access is absent (${pendingRequestId == null ? 'informational' : 'authorized request'})`, async function () {
      const publicDetail = asGroupDetail({
        nonMemberView: false,
        group: asPublicGroup({
          id: 'sea_spring',
          kind: 'season',
          name: 'Spring 2026',
          imageUrl: null,
          locality: null
        }),
        parents: [],
        children: [],
        competingTeams: [],
        participatingSeasons: [],
        staff: [],
        canManage: false,
        canViewPrivate: false,
        games: [
          {
            id: 'gam_visiting_pending',
            homeTeam: { id: 'tem_home', name: 'Demo Host' },
            awayTeam: { id: 'tem_guest', name: 'Demo Visitor' },
            seasonId: 'sea_spring',
            startAt: daysFromNow(1),
            venue: 'Demo Public Field',
            status: 'scheduled',
            homeScore: 91,
            awayScore: 82,
            cancellationReason: null,
            withdrawnByTeamId: null,
            pendingApproval: true,
            pendingRequestId
          }
        ]
      })
      const calls = await mount({
        publicDetail,
        initialTab: 'schedule',
        initialWhen: 'all'
      })
      expect(calls.loads).deep.equals([])
      expect(tabNames('Season sections')).deep.equals([
        'Schedule',
        'Teams',
        'Chats'
      ])
      expect(text()).includes('Pending approval')
      expect(text()).includes('Demo Visitor at Demo Host')
      const marker = document.querySelector(
        '[aria-label="Pending approval for Demo Visitor at Demo Host"]'
      )
      expect(marker).not.equals(null)
      expect(marker?.parentElement?.textContent).equals(
        'Demo Visitor at Demo HostPending approval'
      )
      expect(text().match(/Pending approval/g)).has.lengthOf(1)
      expect(text()).not.includes('82–91')
      if (pendingRequestId == null) {
        expect(
          document.querySelector('[aria-label^="Open game proposal for "]')
        ).equals(null)
        expect(calls.games).deep.equals([])
      } else {
        await press(control('Open game proposal'))
        expect(calls.games).deep.equals([
          {
            gameId: 'gam_visiting_pending',
            title: 'Demo Visitor at Demo Host',
            options: { pendingRequestId }
          }
        ])
      }
      expect(calls.loads).deep.equals([])
      expect(text()).not.includes('Batting')
    })
  }
  it('opens an authorized pending schedule request instead of its unpublished event', async function () {
    const calls = await mount({
      initialWhen: 'all',
      games: async () => [
        game('gam_reserved', {
          pendingApproval: true,
          pendingRequestId: 'req_season',
          homeScore: null,
          awayScore: null,
          videoCount: 0,
          status: 'scheduled'
        })
      ]
    })
    expect(text()).includes('Pending approval')
    await press(control('Alta Hawks @ Bay Stars'))
    expect(calls.games).deep.equals([
      {
        gameId: 'gam_reserved',
        title: 'Alta Hawks @ Bay Stars',
        options: { pendingRequestId: 'req_season' }
      }
    ])
  })
  it('does not open a pending event when its request ID is private', async function () {
    const calls = await mount({
      initialWhen: 'all',
      games: async () => [
        game('gam_reserved', {
          pendingApproval: true,
          pendingRequestId: null,
          homeScore: null,
          awayScore: null,
          videoCount: 0,
          status: 'scheduled'
        })
      ]
    })
    expect(text()).includes('Pending approval')
    expect(gameRows()).deep.equals([])
    expect(calls.games).deep.equals([])
  })
  it('retries failed game loading without changing the schedule tab or upcoming filter', async function () {
    let attempts = 0
    const calls = await mount({
      initialTab: 'schedule',
      initialWhen: 'upcoming',
      games: async () => {
        if (attempts++ === 0) throw new Error('Schedule offline')
        return [PLAYED, AHEAD]
      }
    })
    expect(text()).includes('Schedule offline')
    await press(control('Retry season'))
    expect(gameRows()).has.lengthOf(1)
    expect(gameRows()[0]).includes('Comets @ Alta Hawks')
    expect(
      labelled('Which games').querySelector('[aria-selected="true"]')!
        .textContent
    ).equals('Upcoming')
    expect(calls.tabs).deep.equals([])
    expect(calls.whens).deep.equals([])
    expect(calls.loads.filter(call => call.startsWith('games'))).has.lengthOf(2)
    expect(text()).not.includes('Schedule offline')
  })
  it('retries team loading and updates the participant count in the active Teams section', async function () {
    let attempts = 0
    await mount({
      initialTab: 'teams',
      teams: async () => {
        if (attempts++ === 0) throw new Error('Teams offline')
        return TEAMS
      }
    })
    await press(control('Retry season'))
    expect(text()).includes('TEAMS4')
    expect(
      labelled('Season sections').querySelector('[aria-selected="true"]')!
        .textContent
    ).equals('Teams')
    expect(text()).not.includes('Teams offline')
  })
  it('retries standings with the selected exhibition filter intact', async function () {
    let attempts = 0
    const calls = await mount({
      initialTab: 'standings',
      standings: async () => {
        if (attempts++ === 1) throw new Error('Standings offline')
        return STANDINGS
      }
    })
    await press(control('Include Exhibitions'))
    expect(text()).includes('Standings offline')
    await press(control('Retry standings'))
    expect(calls.filters).deep.equals([false, true, true])
    expect(
      labelled('Standings games').querySelector('[aria-selected="true"]')!
        .textContent
    ).equals('Include Exhibitions')
    expect(text()).includes('Alta Hawks')
    expect(text()).not.includes('Standings offline')
  })
  it('retries failed statistics without leaving Stats or refetching the season schedule', async function () {
    let attempts = 0
    const calls = await mount({
      initialTab: 'stats',
      stats: async () => {
        if (attempts++ === 0) throw new Error('Stats offline')
        return {
          seasonId: 'sea_spring',
          batting: [battingFixture],
          pitching: [pitchingFixture]
        }
      }
    })
    await press(control('Retry stats'))
    expect(
      labelled('Season sections').querySelector('[aria-selected="true"]')!
        .textContent
    ).equals('Stats')
    expect(text()).includes('AVG')
    expect(text()).includes('ERA')
    expect(text()).not.includes('Stats offline')
    expect(calls.loads.filter(call => call.startsWith('stats'))).has.lengthOf(2)
    expect(calls.loads.filter(call => call.startsWith('games'))).has.lengthOf(1)
  })
  it('defaults to Standings with all five sections and requests only in-season records', async function () {
    const calls = await mount({ defaultTab: true })
    expect(tabNames('Season sections')).deep.equals([
      'Standings',
      'Schedule',
      'Stats',
      'Videos',
      'Teams',
      'Chats'
    ])
    expect(
      labelled('Season sections').querySelector('[aria-selected="true"]')
        ?.textContent
    ).equals('Standings')
    expect(calls.filters).deep.equals([false])
    await press(control('Include Exhibitions'))
    expect(calls.filters).deep.equals([false, true])
    await press(control('In-Season'))
    expect(calls.filters).deep.equals([false, true, false])
    await press(labelled('Open Alta Hawks'))
    expect(calls.teams.map(team => team.id)).deep.equals(['tem_hawks'])
    const sticky = document.querySelector<HTMLElement>(
      '[data-testid="sticky-season-sections"]'
    )!
    expect(sticky.style.position).equals('sticky')
    expect(sticky.style.top).equals('48px')
  })

  it('does not request private collections for a public visitor, including a private tab link', async function () {
    const publicDetail = asGroupDetail({
      nonMemberView: false,
      group: asPublicGroup({
        id: 'sea_spring',
        kind: 'season',
        name: 'Spring 2026',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      games: [],
      staff: [],
      canManage: false,
      canViewPrivate: false
    })
    const calls = await mount({ publicDetail, initialTab: 'stats' })
    expect(calls.loads).deep.equals([])
    expect(calls.tabs).deep.equals([['schedule', true]])
    expect(tabNames('Season sections')).deep.equals([
      'Schedule',
      'Teams',
      'Chats'
    ])
    expect(text()).not.includes('Batting')
    expect(text()).not.includes('VIDEOS12')
  })

  it('discards a private statistics answer after access is revoked', async function () {
    let finish!: (value: {
      seasonId: string
      batting: Array<typeof battingFixture>
      pitching: Array<typeof pitchingFixture>
    }) => void
    const calls = await mount({
      initialTab: 'stats',
      stats: async () =>
        await new Promise(resolve => {
          finish = resolve
        })
    })
    const before = [...calls.loads]
    const publicDetail = asGroupDetail({
      nonMemberView: false,
      group: asPublicGroup({
        id: 'sea_spring',
        kind: 'season',
        name: 'Spring 2026',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      games: [],
      staff: [],
      canManage: false,
      canViewPrivate: false
    })
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonScreen
            client={calls.client!}
            season={season()}
            publicDetail={publicDetail}
            initialTab="stats"
            onOpenGame={() => undefined}
            onOpenTeam={() => undefined}
          />
        </ThemeProvider>
      )
      finish({
        seasonId: 'sea_spring',
        batting: [battingFixture],
        pitching: [pitchingFixture]
      })
      await delay(10)
    })
    expect(calls.loads).deep.equals(before)
    expect(tabNames('Season sections')).deep.equals([
      'Schedule',
      'Teams',
      'Chats'
    ])
    expect(text()).not.includes(battingFixture.shortName ?? 'Unknown')
    expect(text()).not.includes('BATTING')
  })

  it('renders disjoint team categories with placeholder status independent of category', async function () {
    await mount({
      initialTab: 'teams',
      teams: async () => [
        team('mixed', 'Mixed Club', {
          seasonCategory: 'inSeason',
          kind: 'external'
        }),
        team('guest', 'Guest Club', { seasonCategory: 'exhibition' }),
        team('idle', 'Idle Club', {
          seasonCategory: 'unscheduled',
          kind: 'external'
        })
      ]
    })
    const content = text()
    expect(content.indexOf('Mixed Club')).lessThan(
      content.indexOf('EXHIBITION TEAMS')
    )
    expect(content.indexOf('Guest Club')).lessThan(
      content.indexOf('UNSCHEDULED')
    )
    expect(content).includes(
      "These teams are in the season but don't have scheduled games."
    )
    expect(content.match(/Placeholder/g)).has.lengthOf(2)
    expect(content.match(/Mixed Club/g)).has.lengthOf(1)
    expect(content).includes('TEAMS3')
  })

  it('loads only season statistics and recorded season games when their sections open', async function () {
    const calls = await mount({
      initialTab: 'stats',
      stats: async () => ({
        seasonId: 'sea_spring',
        batting: [battingFixture],
        pitching: [pitchingFixture]
      })
    })
    expect(calls.loads).includes('stats sea_spring')
    expect(text()).includes('BATTING')
    expect(text()).includes('PITCHING')
    expect(text()).includes('AVG')
    expect(text()).includes('ERA')
    await press(control('Videos'))
    expect(text()).includes('GAME VIDEOS')
    expect(text()).includes('2 games')
    expect(text()).not.includes('Comets @ Alta Hawks')
    expect(calls.loads.filter(call => call.startsWith('games'))).has.lengthOf(1)
    await press(control('Rivals @ Comets'))
    expect(calls.games[0]).deep.equals({
      gameId: 'gam_live',
      title: 'Rivals @ Comets',
      options: { autoPlay: true }
    })
  })

  it('shows loaded games and recording counts on a Home-linked season with a thin public summary', async function () {
    const publicDetail = asGroupDetail({
      nonMemberView: false,
      group: asPublicGroup({
        id: 'sea_spring',
        kind: 'season',
        name: 'Spring 2026',
        imageUrl: null,
        locality: null
      }),
      parents: [],
      children: [],
      competingTeams: [],
      participatingSeasons: [],
      games: [],
      staff: [],
      canManage: true,
      canViewPrivate: true
    })
    await mount({
      publicDetail,
      season: season({ teams: 0, games: 0, videos: 0 }),
      initialTab: 'videos'
    })
    expect(text()).includes('TEAMS4')
    expect(text()).includes('GAMES3')
    expect(text()).includes('VIDEOS3')
    expect(text()).includes('2 games')
    expect(text()).includes('Alta Hawks')
  })

  it('keeps a statistics failure scoped to that section and shows empty statistics', async function () {
    await mount({
      initialTab: 'stats',
      stats: async () => {
        throw new Error('Statistics unavailable')
      }
    })
    expect(text()).includes('Statistics unavailable')
    await press(control('Schedule'))
    expect(gameRows()).has.lengthOf(2)
    await act(async () => root?.unmount())
    await mount({ initialTab: 'stats' })
    expect(text()).includes('No batting statistics yet.')
    expect(text()).includes('No pitching statistics yet.')
  })

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
      initialTab: 'standings',
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
    expect(text()).includes('TEAMS4')
    expect(text()).includes('GAMES3')
    expect(text()).includes('VIDEOS3')
    // No logo: the season initials stand in, and there is no picture.
    expect(document.querySelector('img')).equals(null)
    expect(text()).includes('SL')
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

  it('offers the settings gear only to an administrator who was given onSettings', async function () {
    const calls = await mount({ manage: true })
    expect(calls.invites).deep.equals(['season sea_spring'])
    await press(labelled('Season settings'))
    expect(calls.managed).equals(1)
    await act(async () => {
      root?.unmount()
    })

    const without = await mount()
    expect(without.invites).deep.equals([])
    expect(document.querySelector('[aria-label="Season settings"]')).equals(
      null
    )
    await act(async () => {
      root?.unmount()
    })

    // Given onSettings, but the server says this person may not.
    const refused = await mount({ manage: true, canManage: false })
    expect(refused.invites).deep.equals(['season sea_spring'])
    expect(document.querySelector('[aria-label="Season settings"]')).equals(
      null
    )
  })

  it('opens on the schedule, past games first, with the filter beneath the sections', async function () {
    const calls = await mount()
    expect(tabNames('Season sections')).deep.equals([
      'Standings',
      'Schedule',
      'Stats',
      'Videos',
      'Teams',
      'Chats'
    ])
    expect(tabNames('Which games')).deep.equals(['Past', 'Upcoming', 'All'])
    // Nothing to correct: no tab was asked for.
    expect(calls.tabs).deep.equals([])
    expect(text()).includes('2 games')
    // Newest first. A camera publishing on a finished game is the score,
    // not a LIVE pill, and the row carries the date instead of a thumbnail.
    const rows = gameRows()
    const liveDate = scheduleDate(LIVE.startAt)
    const playedDate = scheduleDate(PLAYED.startAt)
    expect(rows).has.lengthOf(2)
    expect(rows[0]).includes('Rivals @ Comets')
    expect(rows[0]).includes(liveDate.time)
    expect(rows[1]).includes('Alta Hawks @ Bay Stars')
    expect(rows[1]).includes(playedDate.time)
    expect(text()).includes(liveDate.month)
    expect(text()).includes(liveDate.day)
    expect(text()).includes('1–0')
    expect(text()).includes('7–4')
    expect(text()).includes('Field 3')
    expect(text()).not.includes('1 video')
    expect(text()).not.includes('2 videos')
    expect(text()).not.includes('1:30:00')
    expect(text()).not.includes('LIVE')
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
        options: { autoPlay: false }
      },
      {
        gameId: 'gam_ahead',
        title: 'Comets @ Alta Hawks',
        options: { autoPlay: false }
      }
    ])
  })

  it('keeps the weekday in the date column and time in the details at both widths', async function () {
    await mount({ games: async () => [PLAYED] })
    const when = scheduleDate(PLAYED.startAt).time
    expect(gameRows()[0]).includes(when)
    expect(text()).includes(when)

    await setWidth(1200)
    expect(gameRows()[0]).includes(when)
    expect(text()).includes(when)
  })

  it('switches to the teams, with each record or short name, and opens one', async function () {
    const calls = await mount()
    await press(control('Teams'))
    expect(calls.tabs).deep.equals([['teams', undefined]])
    expect(text()).not.includes('Nothing here yet.')
    // Each team is a card of its own: its name opens it, with the record or
    // the short name beneath.
    for (const [name, line] of [
      ['Alta Hawks', '12–3'],
      ['Bay Stars', '8–6–1'],
      ['Comets', 'COM']
    ]) {
      labelled('Open ' + name)
      expect(text()).includes(line)
    }
    labelled('Open Rivals')
    expect(document.querySelector('img')!.getAttribute('src')).equals(
      'https://img.example/rivals.png'
    )
    await press(labelled('Open Bay Stars'))
    expect(calls.teams.map(opened => opened.id)).deep.equals(['tem_sox'])
  })

  it('shows an empty team list as a count of nought', async function () {
    await mount({ teams: async () => [], initialTab: 'teams' })
    expect(text()).includes('No teams in this season yet.')
  })

  it('switches to the standings, ranked, with the leader called out', async function () {
    const calls = await mount()
    await press(control('Standings'))
    expect(calls.tabs).deep.equals([['standings', undefined]])
    expect(text()).includes('2 teams')
    expect(text()).includes('WL T'.replaceAll(' ', ''))
    expect(text()).includes('%GBRSRADiffStreakHomeAway')
    expect(text()).includes('Alta Hawks')
    expect(text()).includes('+57')
    expect(text()).includes('Bay Stars')
    expect(text()).includes('-12')
    expect(text()).includes('Alta Hawks')
  })

  it('says when nothing in the season has been scored', async function () {
    await mount({ standings: async () => [], initialTab: 'standings' })
    expect(text()).includes('0 teams')
    expect(text()).includes('No games have been scored in this season yet.')
    expect(text()).not.includes('leads')
  })

  it('opens on the tab the address names, without correcting it', async function () {
    const calls = await mount({ initialTab: 'standings' })
    expect(text()).includes('Alta Hawks')
    expect(calls.tabs).deep.equals([])
  })

  it('corrects an address naming a tab it does not have', async function () {
    const calls = await mount({ initialTab: 'unknown' })
    expect(calls.tabs).deep.equals([['standings', true]])
    expect(gameRows()).has.lengthOf(0)
  })
})
