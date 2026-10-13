import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient, TeamSummary } from '../../common/api'
import {
  type FixtureSeason,
  NEXT_ROW,
  TEAM_ID,
  TEAM_NAME,
  teamScheduleAnswer
} from '../../test/teamScheduleFixture'
import { ThemeProvider } from '../theme/ThemeContext'
import { TeamScreen } from './TeamScreen'

/**
 * The team's own schedule: the nav bar schedule's rows, one line each, in the
 * order the season is played. The fixture is the one the end-to-end tests
 * serve, so a row here is the row a phone draws.
 */
let root: Root | undefined
let host: HTMLElement | undefined

const NOW = Date.now()

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A client that answers from the fixture, as the fixture's server does. */
function fixtureClient(
  season: FixtureSeason = 'normal',
  extra: (games: Array<Record<string, unknown>>) => unknown[] = games => games
): TeamStationClient {
  const get = (path: string): unknown =>
    teamScheduleAnswer('GET', `/api/v1${path}`, NOW, undefined, season).body
  return {
    teamGames: async (teamId: string) =>
      extra(get(`/teams/${teamId}/games`) as Array<Record<string, unknown>>),
    roster: async (teamId: string) => get(`/teams/${teamId}/roster`),
    teamStats: async (teamId: string) => get(`/teams/${teamId}/stats`),
    teamPitchingStats: async (teamId: string) =>
      get(`/teams/${teamId}/stats?kind=pitching`),
    standings: async (seasonId: string) =>
      get(`/seasons/${seasonId}/standings`),
    invites: async () => get('/invites'),
    follows: async () => []
  } as unknown as TeamStationClient
}

const TEAM: TeamSummary = {
  id: TEAM_ID,
  name: TEAM_NAME,
  shortName: null,
  logoPath: null,
  logoUrl: null,
  record: null,
  seasonCategory: 'unscheduled',
  canViewPrivate: true,
  kind: 'full'
}

interface Opened {
  gameId: string
  title: string
  options?: { autoPlay?: boolean }
}

async function mount(
  season: FixtureSeason = 'normal',
  initialTab = 'schedule',
  client: TeamStationClient = fixtureClient(season),
  onCreateGame?: () => void,
  nonMemberView = false
): Promise<Opened[]> {
  const opened: Opened[] = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <TeamScreen
          client={client}
          team={TEAM}
          initialTab={initialTab}
          onCreateGame={onCreateGame}
          nonMemberView={nonMemberView}
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

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

describe('schedule event creation entry', () => {
  for (const season of ['normal', 'empty'] as const)
    it(`ends a ${season} schedule with a centered dashed Add Event card`, async () => {
      let creates = 0
      await mount(season, 'schedule', fixtureClient(season), () => {
        creates++
      })
      const card = document.querySelector<HTMLElement>(
        '[data-testid="add-event-card"]'
      )!
      expect(card).not.equals(null)
      expect(card.parentElement!.lastElementChild).equals(card)
      expect(getComputedStyle(card).borderTopStyle).equals('dashed')
      expect(getComputedStyle(card).alignItems).equals('center')
      expect(getComputedStyle(card).justifyContent).equals('center')
      await act(async () => {
        card.click()
      })
      expect(creates).equals(1)
    })
  it('does not offer creation on a non-member schedule', async () => {
    await mount('normal', 'schedule', fixtureClient(), undefined, true)
    expect(document.querySelector('[data-testid="add-event-card"]')).equals(
      null
    )
  })
  it('offers creation to an authorized placeholder custodian without private membership', async () => {
    let creates = 0
    await mount(
      'normal',
      'schedule',
      fixtureClient(),
      () => {
        creates++
      },
      true
    )
    const card = document.querySelector<HTMLElement>(
      '[data-testid="add-event-card"]'
    )!
    expect(card).not.equals(null)
    await act(async () => {
      card.click()
    })
    expect(creates).equals(1)
  })
})

const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="scheduleGame"]')
]
/** Each row's lines, the way a reader takes them in. */
const linesOf = (row: HTMLElement): string[] =>
  [...row.querySelectorAll('div')]
    .filter(node => node.childElementCount === 0)
    .map(node => node.textContent ?? '')
    .filter(line => line !== '')

describe('a team’s schedule', function () {
  it('draws one row a game, in the order the season is played', async function () {
    await mount()
    const teams = rows().map(row =>
      linesOf(row).find(line => /^(@|vs) /.test(line))
    )
    expect(teams).deep.equals([
      'vs Cranes',
      '@ Bisons',
      'vs Otters',
      '@ Herons',
      'vs Foxes',
      '@ Badgers',
      'vs Hawks',
      '@ Owls',
      'vs Falcons',
      '@ Pelicans',
      'vs Ravens',
      '@ Comets',
      'vs Lynx',
      '@ Marlins'
    ])
  })

  it('names a practice Practice and another event by its title, in place of the teams', async function () {
    const event = (
      game: Record<string, unknown>,
      id: string,
      eventType: string,
      title: string
    ): Record<string, unknown> => ({
      ...game,
      id,
      eventKind: 'event',
      eventType,
      title,
      awayTeamName: '',
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      videoCount: 0
    })
    const opened = await mount(
      'normal',
      'schedule',
      fixtureClient('normal', games => [
        ...games,
        {
          ...event(games[0], 'tev_practice', 'practice', 'Morning drills'),
          // Replies are taken for what is still to come.
          startAt: new Date(NOW + 7 * 86_400_000).toISOString(),
          playerRsvps: { yes: 2, unknown: 1, no: 0 }
        },
        event(games[0], 'tev_dinner', 'other', 'Team dinner')
      ])
    )
    // Its RSVP control is named for the practice, not its stored title.
    expect(document.querySelector('[aria-label="RSVP: Practice"]')).not.equals(
      null
    )
    const named = rows().map(row => linesOf(row))
    expect(named.some(lines => lines.includes('Practice'))).equals(true)
    expect(named.some(lines => lines.includes('Morning drills'))).equals(false)
    expect(named.some(lines => lines.includes('Team dinner'))).equals(true)
    const practice = rows().find(row => linesOf(row).includes('Practice'))!
    await act(async () => {
      practice.querySelector<HTMLElement>('[role="button"]')!.click()
      await delay(10)
    })
    expect(opened.map(item => item.title)).deep.equals(['Practice'])
  })

  it('draws a card with nothing to answer or count compact, with the weekday on its time line', async function () {
    await mount(
      'live',
      'schedule',
      fixtureClient('live', games =>
        games.map(game =>
          game.status === 'inProgress'
            ? { ...game, playerRsvps: { yes: 0, unknown: 0, no: 0 } }
            : game.status === 'scheduled'
              ? { ...game, playerRsvps: { yes: 1, unknown: 1, no: 0 } }
              : game
        )
      )
    )
    const card = (name: string): HTMLElement =>
      rows().find(row => linesOf(row).some(line => line.endsWith(name)))!
    const live = card('Owls')
    const next = card('Falcons')
    // The live game has nothing to answer and no replies to count: no RSVP
    // line, no weekday over a rule, and the weekday leads its time.
    expect(live.querySelector('[data-testid^="schedule-rsvps-"]')).equals(null)
    expect(live.querySelector('[data-testid="schedule-weekday"]')).equals(null)
    expect(
      live.querySelector('[data-testid="schedule-date-separator"]')
    ).equals(null)
    const liveTime = live.querySelector('[data-testid="schedule-time"]')!
    expect(liveTime.textContent).match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d/)
    // A game still to come keeps the RSVP line and the full date column.
    expect(next.querySelector('[data-testid^="schedule-rsvps-"]')).not.equals(
      null
    )
    expect(next.querySelector('[data-testid="schedule-weekday"]')).not.equals(
      null
    )
    expect(
      next.querySelector('[data-testid="schedule-time"]')!.textContent
    ).match(/^\d/)
    // In both, the time and the address are bold.
    for (const row of [live, next]) {
      const time = row.querySelector('[data-testid="schedule-time"]')!
      const venue = [...row.querySelectorAll('[dir="auto"]')].find(node =>
        /Park|Field/.test(node.textContent ?? '')
      )!
      expect(getComputedStyle(time).fontWeight).equals('700')
      expect(getComputedStyle(venue).fontWeight).equals('700')
    }
  })

  it('names events the same way on a visitor’s schedule', async function () {
    const opened = await mount(
      'normal',
      'schedule',
      fixtureClient('normal', games => [
        ...games,
        {
          ...games[0],
          id: 'tev_visitor_practice',
          eventKind: 'event',
          eventType: 'practice',
          title: 'Morning drills',
          awayTeamName: '',
          status: 'scheduled',
          homeScore: null,
          awayScore: null,
          videoCount: 0
        }
      ]),
      undefined,
      true
    )
    const practice = rows().find(row => linesOf(row).includes('Practice'))!
    expect(linesOf(practice)).not.includes('Morning drills')
    await act(async () => {
      practice.querySelector<HTMLElement>('[role="button"]')!.click()
      await delay(10)
    })
    expect(opened.map(item => item.title)).deep.equals(['Practice'])
  })

  it('says only who it is against, never the team’s own name', async function () {
    await mount()
    for (const row of rows()) {
      expect(row.textContent).not.includes(TEAM_NAME)
    }
    expect(document.body.textContent).includes('14 games, 6 to play')
  })

  it('opens the game it was pressed on, named for both sides', async function () {
    const opened = await mount()
    const away = rows().find(row => linesOf(row).includes('@ Owls'))!
    const home = rows().find(row => linesOf(row).includes(NEXT_ROW))!
    await act(async () => {
      away.querySelector<HTMLElement>('[role="button"]')!.click()
      home.querySelector<HTMLElement>('[role="button"]')!.click()
      await delay(10)
    })
    expect(opened).deep.equals([
      {
        gameId: 'gam_mudcats08',
        title: 'Mudcats @ Owls',
        options: { autoPlay: false }
      },
      {
        gameId: 'gam_mudcats09',
        title: 'Mudcats vs Falcons',
        options: { autoPlay: false }
      }
    ])
  })

  it('opens the automatic event section from the schedule even when a recording exists', async function () {
    const opened = await mount()
    const first = rows()[0]
    await act(async () => {
      first.querySelector<HTMLElement>('[role="button"]')!.click()
      await delay(10)
    })
    expect(opened[0]).deep.equals({
      gameId: 'gam_mudcats01',
      title: 'Mudcats vs Cranes',
      options: { autoPlay: false }
    })
  })

  it('scores each finished game from this team’s side', async function () {
    await mount()
    const hawks = rows().find(row => linesOf(row).includes('vs Hawks'))!
    const owls = rows().find(row => linesOf(row).includes('@ Owls'))!
    // At home the Mudcats won 5–2, and away at the Owls lost 3–6: ours first
    // either way, not away–home.
    expect(linesOf(hawks)).includes('W 5\u20132')
    expect(linesOf(owls)).includes('L 3\u20136')
  })

  it('marks a game being played LIVE', async function () {
    await mount('live')
    const owls = rows().find(row => linesOf(row).includes('@ Owls'))!
    expect(owls.textContent).includes('LIVE')
  })

  it('says when there are no games', async function () {
    await mount('empty')
    expect(rows()).deep.equals([])
    expect(document.body.textContent).includes('No games scheduled.')
  })
})

describe('a team’s tabs, each started under the pills', function () {
  /** The page's scroll offset, as the stubbed scroller keeps it. */
  let scrollTop = 0
  const ROW = 100
  const VIEWPORT = 400
  const original = {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto the prototype it came from
    rect: HTMLElement.prototype.getBoundingClientRect,
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
    clientHeight: Object.getOwnPropertyDescriptor(
      Element.prototype,
      'clientHeight'
    )
  }
  const scrolls = (node: Element): boolean =>
    ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)

  beforeEach(function () {
    scrollTop = 0
    // jsdom lays nothing out: each schedule row stands ROW below the last,
    // what holds them ends with the last, and everything else sits at the top.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const games = [
        ...document.querySelectorAll('[data-testid="scheduleGame"]')
      ]
      const at = games.indexOf(this)
      if (at < 0 && games.length > 0 && this.contains(games[0]))
        return {
          top: 0,
          bottom: games.length * ROW,
          height: games.length * ROW
        } as unknown as DOMRect
      if (at < 0) return original.rect.call(this)
      return {
        top: at * ROW,
        bottom: at * ROW + ROW,
        height: ROW
      } as unknown as DOMRect
    }
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return scrolls(this) ? scrollTop : 0
      },
      set(this: Element, y: number) {
        if (scrolls(this)) scrollTop = y
      }
    })
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        return scrolls(this) ? VIEWPORT : 0
      }
    })
  })

  afterEach(function () {
    HTMLElement.prototype.getBoundingClientRect = original.rect
    for (const key of ['scrollTop', 'clientHeight'] as const) {
      const descriptor = original[key]
      if (descriptor != null)
        Object.defineProperty(Element.prototype, key, descriptor)
    }
  })

  const tap = async (label: string): Promise<void> => {
    const pill = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]')
    ].find(node => (node.textContent ?? '').startsWith(label))
    expect(pill, label).not.equals(undefined)
    await act(async () => {
      pill!.click()
      await delay(10)
    })
  }

  it('opens the schedule at its next game, and other tabs at their top', async function () {
    await mount('normal', 'videos')
    expect(scrollTop).equals(0)
    await tap('Schedule')
    // vs Falcons is the ninth game.
    expect(scrollTop).equals(8 * ROW)
    await tap('Videos')
    expect(scrollTop).equals(0)
  })

  it('opens the schedule at a practice or other event when it is the next thing on it', async function () {
    for (const [eventType, title] of [
      ['practice', 'Morning drills'],
      ['other', 'Team dinner']
    ] as const) {
      await mount(
        'normal',
        'schedule',
        fixtureClient('normal', games => [
          ...games,
          {
            ...games[0],
            id: `tev_next_${eventType}`,
            eventKind: 'event',
            eventType,
            title,
            awayTeamId: '',
            awayTeamName: '',
            status: 'scheduled',
            homeScore: null,
            awayScore: null,
            videoCount: 0,
            // Two days out: before vs Falcons, a week out.
            startAt: new Date(NOW + 2 * 86_400_000).toISOString()
          }
        ])
      )
      expect(linesOf(rows()[8]).join(' ')).includes(
        eventType === 'practice' ? 'Practice' : title
      )
      expect(scrollTop, eventType).equals(8 * ROW)
      await act(async () => {
        root?.unmount()
      })
      root = undefined
      host?.remove()
      host = undefined
      scrollTop = 0
    }
  })

  it('opens at the next game on first load when the address says schedule', async function () {
    await mount('normal', 'schedule')
    expect(scrollTop).equals(8 * ROW)
  })

  it('opens a finished season toward its last game, with no room under it', async function () {
    await mount('over', 'schedule')
    // The last game is the anchor, but the page stops where that game rests
    // just above the nav bar: no further, so the games before it still show.
    expect(scrollTop)
      .greaterThan(9 * ROW)
      .and.lessThan(13 * ROW)
  })

  it('scrolls a schedule that fits on the screen not at all', async function () {
    await mount(
      'normal',
      'schedule',
      fixtureClient('normal', games => games.slice(7, 9))
    )
    expect(rows()).length(2)
    expect(scrollTop).equals(0)
  })

  it('opens an empty schedule at its top', async function () {
    await mount('empty', 'schedule')
    expect(scrollTop).equals(0)
  })

  it('lays the card, the pills, the tab and its room out side by side', async function () {
    await mount('normal', 'schedule')
    const content = document.querySelector('[data-testid="teamTabContent"]')!
    const column = content.parentElement!
    const children = [...column.children]
    expect(children.indexOf(content)).equals(2)
    expect(children.length).equals(4)
    // The room after the tab, so it can start under the pills however short.
    expect(content.nextElementSibling).equals(children[3])
    // The pills are in the band before the tab.
    expect(children[1].querySelector('[role="tab"]')).not.equals(null)
  })
})
