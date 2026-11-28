import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Linking, Platform } from 'react-native'

import { TeamStationClient, type UmpireSchedulePage } from '../../common/api'
import type { UmpireAvailability } from '../../common/umpires'
import {
  UMPIRE_RANK_SYMBOLS,
  type UmpireSchedule
} from '../../common/umpireSchedule'
import { reachEnd, reportAnchor } from '../../test/PagedListStandIn'
import { pageOfUmpireSchedule } from '../../test/pageOf'
import { fixturePositions, fixtureTypes } from '../../test/umpireTypes'
import { AppHeader } from '../components/AppHeader'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { SceneShownProvider } from '../components/sceneShown'
import type { UmpireScheduleRoute } from '../navigation/routes'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameUmpires } from './GameUmpires'
import { UmpireLeaderboardView } from './UmpireLeaderboardView'
import {
  appliedAvailability,
  availabilityDiffers,
  initialUmpireGame,
  optionalPositionHeader,
  routeDays,
  routeNamesFilter,
  umpireFilterLabel,
  UmpireScheduleScreen,
  withAvailability
} from './UmpireScheduleScreen'
import { UmpireSignup } from './UmpireSignup'
describe('scheduleUi.test.tsx', () => {
  let root: Root | undefined
  async function mount(node: React.ReactElement): Promise<void> {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<ThemeProvider>{node}</ThemeProvider>)
    })
  }
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })
  it('measures compact divided columns and synchronizes the sticky table scrollers', async () => {
    const f = fixture()
    f.schedule.noteTypes = [
      { id: 'color', name: 'Jersey Color', position: 0, inUse: false }
    ]
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    const props = (id: string): any => {
      const node = document.querySelector(`[data-testid="${id}"]`)!
      let fiber = (node as any)[
        Object.keys(node).find(k => k.startsWith('__reactFiber'))!
      ]
      let found: any
      while (fiber != null) {
        if (fiber.memoizedProps?.testID === id) found = fiber.memoizedProps
        fiber = fiber.return
      }
      return found
    }
    const measure = (id: string, width: number, height = 48, y = 0): void => {
      props(id).onLayout({ nativeEvent: { layout: { width, height, y } } })
    }
    await act(async () => {
      measure('umpire-date-measure', 120)
      measure('umpire-signup-measure', 75)
      measure('umpire-conflict-measure', 80)
      measure('umpire-table', 1200, 300, 200)
      measure('umpire-sticky-stack', 1200, 96)
      reportAnchor(0)
    })
    const header = document.querySelector(
      '[data-testid="umpire-table-header-scroll"]'
    )!
    const text = [...header.querySelectorAll<HTMLElement>('[dir="auto"]')].find(
      n => n.textContent === 'Date'
    )!
    expect(text.parentElement!.style.width).equals('136px')
    expect(getComputedStyle(text.parentElement!).borderRightWidth).equals('1px')
    expect(getComputedStyle(text).fontWeight).equals('700')
    await act(async () => {
      props('umpire-table-header-scroll').onScroll({
        nativeEvent: { contentOffset: { x: 100 } }
      })
      props('umpire-table-body-scroll').onScroll({
        nativeEvent: { contentOffset: { x: 100 } }
      })
      props('umpire-table-body-scroll').onScroll({
        nativeEvent: { contentOffset: { x: 200 } }
      })
      reportAnchor(400)
    })
  })
  it('lets only the scroller a finger took move the other, so late reports cannot swap them for ever', async () => {
    const f = fixture()
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    const HEADER = 'umpire-table-header-scroll'
    const BODY = 'umpire-table-body-scroll'
    const props = (id: string): any => {
      const node = document.querySelector(`[data-testid="${id}"]`)!
      let fiber = (node as any)[
        Object.keys(node).find(k => k.startsWith('__reactFiber'))!
      ]
      let found: any
      while (fiber != null) {
        if (fiber.memoizedProps?.testID === id) found = fiber.memoizedProps
        fiber = fiber.return
      }
      return found
    }
    // Where each scroller is sent, as `scrollTo` reaches the page.
    const sent: string[] = []
    const scroll = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scroll'
    )
    Object.defineProperty(HTMLElement.prototype, 'scroll', {
      configurable: true,
      writable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        sent.push(`${this.dataset.testid}:${options.left}`)
      }
    })
    const report = (id: string, x: number): void => {
      props(id).onScroll({ nativeEvent: { contentOffset: { x } } })
    }
    try {
      await act(async () => {
        props(BODY).onScrollBeginDrag()
        report(BODY, 100)
        // The header's report of where it was before it heard 100, and then
        // the body's of where it was before the header's 60 reached it: as
        // equals, each would send the other back, and so on for ever.
        report(HEADER, 60)
        report(BODY, 120)
        report(HEADER, 100)
        report(HEADER, 120)
      })
      expect(sent).deep.equals([
        `${HEADER}:100`,
        `${HEADER}:100`,
        `${HEADER}:120`,
        `${HEADER}:120`
      ])
      sent.length = 0
      // A finger on the header makes it the one the body follows.
      await act(async () => {
        props(HEADER).onScrollBeginDrag()
        report(HEADER, 200)
        report(BODY, 130)
      })
      expect(sent).deep.equals([`${BODY}:200`, `${BODY}:200`])
    } finally {
      if (scroll == null)
        Reflect.deleteProperty(HTMLElement.prototype, 'scroll')
      else Object.defineProperty(HTMLElement.prototype, 'scroll', scroll)
    }
  })
  it('opens on the route’s game, and on the next game with none', async () => {
    for (const [game, around] of [
      ['game', 'game'],
      [undefined, 'next']
    ] as const) {
      const f = fixture()
      const pages: unknown[] = []
      f.client.umpireSchedulePage = async (_id, _q, page) => {
        pages.push(page)
        return pageOfUmpireSchedule(f.schedule, page)
      }
      await mount(
        <UmpireScheduleScreen
          client={f.client}
          leagues={[]}
          route={{
            name: 'umpireSchedule',
            id: 'demo',
            view: 'league',
            ...(game == null ? {} : { game })
          }}
          onRoute={() => undefined}
        />
      )
      expect(pages[0], around).deep.equals({ around })
    }
  })

  it('requests the viewer timezone and puts compact conflicts after custom notes', async () => {
    const f = fixture()
    f.schedule.noteTypes = [
      { id: 'note', name: 'Jersey Color', position: 0, inUse: false }
    ]
    let query = ''
    f.client.umpireSchedulePage = async (_id, q, page) => {
      query = q ?? ''
      return pageOfUmpireSchedule(f.schedule, page)
    }
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        leagues={[]}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        onRoute={() => undefined}
      />
    )
    expect(new URLSearchParams(query).get('timezone')).equals(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    )
    // The screen is titled Umpire.
    const headings = [
      ...document.querySelectorAll('[role="heading"], h1, h2')
    ].map(node => node.textContent)
    expect(headings).contains('Umpire')
    expect(headings).not.contains('Umpire Schedule')
    const game = document.querySelector('[data-testid="umpire-game-game"]')!
    expect(game.lastElementChild?.textContent).equals('Conflict')
    expect(
      document
        .querySelector('[data-testid="umpire-table-header-scroll"]')!
        .textContent!.endsWith('Conflicts')
    ).equals(true)
    expect(getComputedStyle(game.firstElementChild!).paddingTop).equals('0px')
    expect(
      document.querySelector(
        '[aria-label="Umpire pages"] [data-testid="glass-tab-label"]'
      )
    ).not.equals(null)
  })
  function target(label: string): HTMLElement {
    const n = [
      ...document.querySelectorAll<HTMLElement>('[aria-label], [role="button"]')
    ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
    expect(n, label).not.equals(undefined)
    return n!
  }
  async function press(label: string): Promise<void> {
    await act(async () => {
      target(label).click()
    })
  }
  it('edits custom notes in the schedule and blocks filter changes until a failed note saves', async () => {
    const f = fixture()
    f.schedule.noteTypes = [
      { id: 'color', name: 'Jersey Color', position: 0, inUse: false }
    ]
    f.schedule.games.push({
      ...f.schedule.games[0],
      id: 'other',
      date: 'Apr 3'
    })
    const writes: unknown[] = []
    f.client.saveUmpireNote = async (...args) => {
      writes.push(args)
      return { value: args[3] }
    }
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        leagues={[]}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        onRoute={() => undefined}
      />
    )
    const label = 'Edit Jersey Color, Demo Hawks vs Demo Eagles, Apr 2, 5:00 pm'
    const button = target(label)
    // The table scrolls sideways inside the page. Focusing a note must reveal
    // it through the vertical page's public ScrollView responder.
    let owner: HTMLElement | null = button
    while (owner != null && getComputedStyle(owner).overflowY !== 'auto')
      owner = owner.parentElement
    expect(owner, 'owning vertical scroll view').not.equals(null)
    const scroll = owner as HTMLElement & {
      scrollResponderScrollNativeHandleToKeyboard: (...args: unknown[]) => void
    }
    const fiberKey = Object.keys(scroll).find(k =>
      k.startsWith('__reactFiber')
    )!
    let fiber = (scroll as unknown as Record<string, unknown>)[fiberKey] as {
      memoizedProps?: { automaticallyAdjustKeyboardInsets?: boolean }
      return?: unknown
    } | null
    let insets = false
    while (fiber != null) {
      if (fiber.memoizedProps?.automaticallyAdjustKeyboardInsets === true)
        insets = true
      fiber = fiber.return as typeof fiber
    }
    expect(
      insets,
      'owning vertical scroll view adjusts keyboard insets'
    ).equals(true)
    const reveal = scroll.scrollResponderScrollNativeHandleToKeyboard
    expect(reveal).to.be.a('function')
    const revealed: unknown[][] = []
    const os = Platform.OS
    try {
      await press(label)
      // Only for the focus: drawn as a phone, the page's scroller is another.
      Platform.OS = 'ios'
      scroll.scrollResponderScrollNativeHandleToKeyboard = (...args) => {
        revealed.push(args)
      }
      await act(async () => {
        const input = document.querySelector('input')!
        input.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
      })
      expect(revealed).length(1)
      expect(revealed[0].slice(1)).deep.equals([16, true])
    } finally {
      Platform.OS = os
      scroll.scrollResponderScrollNativeHandleToKeyboard = reveal
    }
    const fill = async (value: string): Promise<void> => {
      await act(async () => {
        const n = document.querySelector('input')!
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )!.set!.call(n, value)
        n.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }
    await fill('Blue')
    await press('Schedule filters')
    expect(writes).deep.equals([['game', 'color', '', 'Blue']])
    await press('Cancel')
    expect(target(label).textContent).equals('Blue')
    await press(label)
    await fill('Gold')
    f.client.saveUmpireNote = async () => {
      throw new Error('Note unavailable')
    }
    await press('Schedule filters')
    expect(document.body.textContent).contains('Note unavailable')
    expect(document.body.textContent).not.contains('Apply filters')
    expect(document.querySelector('input')!.value).equals('Gold')
    await press('Discard note changes')
    expect(document.querySelector('input')).equals(null)
    expect(document.body.textContent).not.contains('Note unavailable')
    await press('Schedule filters')
    expect(document.body.textContent).contains('Apply filters')
  })
  it('keeps star ranks in trophy-sized clusters in both leaderboards', async () => {
    const people = UMPIRE_RANK_SYMBOLS.map((symbol, index) => ({
      userId: String(index),
      name: `Umpire ${index + 1}`,
      count: 10 - index,
      symbol
    }))
    await mount(
      <UmpireLeaderboardView
        board={{
          completed: people,
          scheduled: people,
          teams: people.map(p => ({
            id: p.userId,
            name: p.name,
            count: p.count
          }))
        }}
      />
    )
    for (let count = 1; count <= 5; count++) {
      const tiles = document.querySelectorAll<HTMLElement>(
        `[aria-label="${count} ${count === 1 ? 'star' : 'stars'}"]`
      )
      expect(tiles.length).equals(3)
      for (const tile of tiles) {
        expect(tile.style.width).equals('28px')
        expect(tile.style.height).equals('28px')
        const stars = [
          ...tile.querySelectorAll<HTMLElement>('[aria-hidden="true"]')
        ]
        expect(stars.length).equals(count)
        expect(
          new Set(stars.map(s => `${s.style.left},${s.style.top}`)).size
        ).equals(count)
        if (count >= 2 && count <= 4) {
          for (const axis of ['left', 'top'] as const) {
            const positions = stars.map(star =>
              Number.parseInt(star.style[axis])
            )
            expect(Math.max(...positions) - Math.min(...positions)).at.most(10)
          }
        }
        for (const star of stars) {
          expect(star.textContent).equals('★')
          expect(Number.parseInt(star.style.left)).within(0, 18)
          expect(Number.parseInt(star.style.top)).within(0, 18)
        }
      }
    }
    expect(
      document.querySelectorAll('[aria-label="Gold trophy"]').length
    ).equals(3)
    expect(document.body.textContent).contains('👍').and.contains('👌')
  })
  function fixture(): {
    client: TeamStationClient
    schedule: UmpireSchedule
    saved: unknown[]
  } {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const saved: unknown[] = []
    const schedule: UmpireSchedule = {
      settings: { management: true, credits: true },
      types: fixtureTypes,
      noteTypes: [],
      levels: [{ id: 'majors', name: 'majors', position: 0, inUse: true }],
      viewerId: 'uma',
      isAdmin: true,
      view: 'umpire',
      creditTeams: [
        { id: 'hawks', name: 'Demo Hawks' },
        { id: 'owls', name: 'Demo Owls' }
      ],
      games: [
        {
          id: 'game',
          seasonId: 'spring',
          seasonName: 'Spring',
          levelId: 'majors',
          levelName: 'majors',
          startAt: '2099-04-03T00:00:00Z',
          endAt: null,
          timezone: 'America/Los_Angeles',
          date: 'Apr 2, 5:00 pm',
          status: 'scheduled',
          home: 'Demo Hawks',
          away: 'Demo Eagles',
          venue: 'Field 1',
          field: '',
          notes: 'North diamond entrance',
          umpireNotes: {},
          positions: fixturePositions(),
          assignments: {},
          conflicts: [
            {
              userId: 'billy',
              name: 'Billy L',
              activity: 'playing',
              gameId: 'other',
              time: '4:00 pm',
              closeness: 'ends 10 minutes before this game starts'
            }
          ],
          choices: {
            'uty_plate:1': [
              { userId: 'uma', name: 'Uma L', reason: null },
              {
                userId: 'billy',
                name: 'Billy L',
                reason: 'already playing then'
              }
            ],
            'uty_field:1': [
              {
                userId: 'uma',
                name: 'Uma L',
                reason: 'not certified for field ump'
              },
              { userId: 'bobby', name: 'Bobby L', reason: null }
            ]
          }
        }
      ]
    }
    client.umpireSchedulePage = async (_id, _query, page) =>
      pageOfUmpireSchedule(schedule, page)
    client.umpireAvailability = async () => null
    client.umpireLeaderboard = async () => ({
      completed: [{ userId: 'uma', name: 'Uma L', count: 1, symbol: '🏆' }],
      scheduled: [],
      teams: [{ id: 'hawks', name: 'Demo Hawks', count: 1 }]
    })
    client.assignUmpire = async (id, assignment) => {
      saved.push([id, assignment])
      schedule.games[0].assignments[assignment.slot] = {
        userId: assignment.userId,
        name: 'Uma L',
        displayName: 'Uma Lee',
        assignedBy: 'uma',
        canRemove: true
      }
    }
    client.removeUmpire = async (id, slot) => {
      saved.push([id, slot])
      schedule.games[0].assignments = Object.fromEntries(
        Object.entries(schedule.games[0].assignments).filter(
          ([key]) => key !== slot
        )
      )
    }
    return { client, schedule, saved }
  }
  it('opens blue team/game/map links and shows quieter assignment affiliations', async () => {
    const f = fixture()
    const opened: string[] = []
    Object.assign(f.schedule.games[0], {
      homeTeamId: 'hawks',
      awayTeamId: 'eagles',
      location: 'Demo Park & Field'
    })
    f.schedule.games[0].assignments['uty_plate:1'] = {
      userId: 'uma',
      name: 'Uma L',
      displayName: 'Uma Lee',
      assignedBy: 'uma',
      canRemove: false,
      teams: [{ id: 'hawks', name: 'Demo Hawks' }]
    }
    const previous = Linking.openURL.bind(Linking)
    Linking.openURL = async url => {
      opened.push(url)
    }
    try {
      await mount(
        <UmpireScheduleScreen
          client={f.client}
          route={{ name: 'umpireSchedule', id: 'demo' }}
          leagues={[]}
          onRoute={() => undefined}
          onOpenTeam={id => opened.push(id)}
          onOpenGame={id => opened.push(id)}
        />
      )
      await press('Open Demo Hawks')
      await press('Open Demo Eagles')
      await press('Open game Apr 2, 5:00 pm')
      await press('Map of Field 1')
      expect(opened).deep.equals([
        'hawks',
        'eagles',
        'game',
        'https://www.google.com/maps/dir/?api=1&destination=Demo%20Park%20%26%20Field'
      ])
      const name = target('Uma L, uty_plate:1')
      expect(name.textContent).equals('Uma LDemo Hawks')
      expect(
        parseFloat(
          getComputedStyle(
            name.querySelectorAll('[data-testid="ticker-text-content"]')[1]
          ).fontSize
        )
      ).lessThan(
        parseFloat(
          getComputedStyle(
            name.querySelectorAll('[data-testid="ticker-text-content"]')[0]
          ).fontSize
        )
      )
      Linking.openURL = async () => {
        throw new Error('Map unavailable')
      }
      await press('Map of Field 1')
      expect(document.body.textContent).contains('Map unavailable')
    } finally {
      Linking.openURL = previous
    }
  })
  it('positions an ongoing game before future games, with a last-row fallback', () => {
    const game = fixture().schedule.games[0]
    const ongoing = {
      ...game,
      id: 'ongoing',
      status: 'inProgress' as const,
      startAt: '2027-04-01T11:00:00Z'
    }
    const past = { ...ongoing, id: 'past', status: 'final' as const }
    const now = Date.parse('2027-04-01T12:00:00Z')
    expect(initialUmpireGame([past, ongoing, game], now)?.id).equals('ongoing')
    expect(initialUmpireGame([past, game], now)?.id).equals('game')
    expect(initialUmpireGame([past], now)?.id).equals('past')
    expect(initialUmpireGame<typeof game>([], now)).equals(undefined)
  })
  it('does not offer an umpire-only view to an administrator without that role', async () => {
    const f = fixture()
    f.schedule.view = 'league'
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo', view: 'league' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(document.body.textContent).not.contains('Umpire view')
    expect(document.body.textContent).contains('Demo Hawks')
    await press('Schedule filters')
    expect(target('Monday').getAttribute('aria-pressed')).equals('false')
  })
  it('switches leagues to an authorized view and clears league-specific filters', async () => {
    const f = fixture()
    const requests: Array<{
      id: string
      view: string | null
      levels: string | null
    }> = []
    f.client.umpireSchedulePage = async (id, query, page) => {
      const params = new URLSearchParams(query)
      const view = params.get('view')
      requests.push({ id, view, levels: params.get('levels') })
      if (id === 'visitors' && view === 'league')
        throw new Error('Forbidden league view')
      return pageOfUmpireSchedule(
        { ...f.schedule, isAdmin: id === 'demo' },
        page
      )
    }
    function Harness(): React.ReactElement {
      const [route, setRoute] = useState<UmpireScheduleRoute>({
        name: 'umpireSchedule',
        id: 'demo',
        view: 'league',
        levels: 'majors'
      })
      return (
        <UmpireScheduleScreen
          client={f.client}
          route={route}
          leagues={[
            { id: 'demo', name: 'Demo League', logoUrl: null },
            { id: 'visitors', name: 'Demo Visitors', logoUrl: null }
          ]}
          onRoute={setRoute}
        />
      )
    }
    await mount(<Harness />)
    await press('Demo League')
    expect(requests).length(1)
    await press('Demo Visitors')
    expect(requests.at(-1)).deep.equals({
      id: 'visitors',
      view: 'schedule',
      levels: null
    })
    expect(document.body.textContent)
      .contains('Demo Hawks')
      .and.not.contains('Schedule unavailable')
  })
  it('keeps drafts local, applies independent toggles, and clears draft filters without closing or changing the applied route', async () => {
    const f = fixture()
    f.schedule.levels.push({ id: 'aa', name: 'AA', position: 1, inUse: false })
    let current: UmpireScheduleRoute
    function Harness(): React.ReactElement {
      const [route, setRoute] = useState<UmpireScheduleRoute>({
        name: 'umpireSchedule',
        id: 'demo',
        view: 'league',
        priorSeasons: 'true',
        days: '0',
        levels: 'majors',
        from: '08:00',
        to: '18:00'
      })
      current = route
      return (
        <UmpireScheduleScreen
          client={f.client}
          route={route}
          leagues={[]}
          onRoute={setRoute}
        />
      )
    }
    await mount(<Harness />)
    await press('Schedule filters')
    expect(target('Monday').getAttribute('aria-pressed')).equals('true')
    expect(target('Monday').getAttribute('aria-selected')).equals('true')
    expect(target('majors').getAttribute('aria-selected')).equals('true')
    expect((target('Prior seasons') as HTMLInputElement).checked).equals(true)
    await press('Prior seasons')
    await press('Monday')
    await press('Sunday')
    await press('majors')
    await press('AA')
    await press('Cancel')
    expect(current!.priorSeasons).equals('true')
    expect(current!.days).equals('0')
    expect(current!.levels).equals('majors')
    await press('Schedule filters')
    expect(target('Sunday').getAttribute('aria-pressed')).equals('false')
    await press('Sunday')
    await press('AA')
    await press('Start time')
    await press('Hour 09')
    await press('Use time')
    await press('Apply filters')
    expect(current!).includes({
      days: '0,6',
      levels: 'majors,aa',
      from: '09:00',
      to: '18:00'
    })
    await press('Schedule filters')
    await press('End time')
    await press('Hour 07')
    await press('Period AM')
    await press('Use time')
    expect(target('Apply filters').getAttribute('aria-disabled')).equals('true')
    expect(target('Clear filters').getAttribute('aria-disabled')).not.equals(
      'true'
    )
    await press('Clear filters')
    expect(current!.from).equals('09:00')
    expect(target('Apply filters')).not.equals(undefined)
    expect(target('Start time').textContent).contains('Any time')
    expect(target('End time').textContent).contains('Any time')
    expect(target('Monday').getAttribute('aria-pressed')).equals('false')
    expect(target('majors').getAttribute('aria-pressed')).equals('false')
    expect(target('Monday').getAttribute('aria-selected')).equals('false')
    expect(target('majors').getAttribute('aria-selected')).equals('false')
    await press('Apply filters')
    expect(current!.priorSeasons).equals(undefined)
    expect(current!.days).equals(undefined)
    expect(current!.from).equals(undefined)
    expect(target('Schedule filters').textContent).equals('filter_altFilter')
    await press('Schedule filters')
    await press('Start time')
    await press('Hour 11')
    await press('Cancel time picker')
    expect(target('Start time').textContent).contains('Any time')
    await press('Start time')
    await press('End time')
    await press('Use time')
    expect(target('End time').textContent).contains('5:00 PM')
    await press('Start time')
    await press('Clear filters')
    expect(
      document.querySelector('[data-testid="umpire-filter-time-picker"]')
    ).equals(null)
    await press('Cancel')
    expect(current!.to).equals(undefined)
  })
  it('summarizes applied filters and distinguishes optional from mixed field columns', async () => {
    const f = fixture()
    const route: UmpireScheduleRoute = {
      name: 'umpireSchedule',
      id: 'demo',
      days: '4,0,2',
      from: '09:00',
      to: '17:30',
      levels: 'majors'
    }
    expect(umpireFilterLabel(route, f.schedule.levels)).equals(
      'Filter · MWF · 9:00 AM–5:30 PM · majors'
    )
    expect(
      umpireFilterLabel(
        { ...route, days: undefined, levels: undefined, to: undefined },
        []
      )
    ).equals('Filter · From 9:00 AM')
    expect(
      umpireFilterLabel({ name: 'umpireSchedule', id: 'demo', to: '00:00' }, [])
    ).equals('Filter · Until 12:00 AM')
    f.schedule.games[0].positions = fixturePositions(true, 1, 1)
    expect(optionalPositionHeader(f.schedule.games, 'uty_field:1')).equals(
      undefined
    )
    expect(optionalPositionHeader(f.schedule.games, 'uty_field:2')).equals(
      'Optional'
    )
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={route}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(
      document.querySelector('[data-testid="umpire-game-demo-game"]')
        ?.textContent ?? ''
    ).not.contains('Optional')
    expect(document.body.textContent!.match(/Optional/g)).length(1)
    f.schedule.games.push({
      ...f.schedule.games[0],
      id: 'second',
      positions: fixturePositions(true, 2)
    })
    expect(optionalPositionHeader(f.schedule.games, 'uty_field:2')).equals(
      'Optional in some games'
    )
  })
  it('leaves the umpire mask out of the header: the picture only', async () => {
    await mount(
      <AppHeader
        nav={<span>Tabs</span>}
        notifications={{ pending: false, onPress: () => undefined }}
        account={{
          userId: 'usr_uma',
          name: 'Uma',
          onPress: () => undefined
        }}
      />
    )
    const labels = [...document.querySelectorAll('[role="button"]')].map(n =>
      n.getAttribute('aria-label')
    )
    expect(labels).deep.equals(['Account, Uma'])
    expect(document.querySelector('[aria-label="Umpire schedule"]')).equals(
      null
    )
  })
  it('renders occupied positions as person cards, groups types and omits empty slots', async () => {
    await mount(<GameUmpires umpires={null} />)
    expect(document.body.textContent).equals('')
    await mount(
      <GameUmpires
        umpires={{
          positions: fixturePositions().map(p => ({ ...p, person: null }))
        }}
      />
    )
    expect(document.body.textContent).equals('')
    const positions = fixturePositions().map(p => ({
      ...p,
      person:
        p.typeId === 'uty_plate'
          ? {
              userId: 'mike',
              name: 'Mike T',
              avatarUrl: 'https://example.test/avatar.webp'
            }
          : null
    }))
    await mount(<GameUmpires umpires={{ positions }} />)
    expect(document.body.textContent)
      .contains('Mike T')
      .and.contains('Plate')
      .and.not.contains('Field')
    expect(document.querySelectorAll('[data-testid^="umpire-person-"]')).length(
      1
    )
    expect(document.querySelector('img')?.getAttribute('src')).equals(
      'https://example.test/avatar.webp'
    )
    await mount(
      <GameUmpires
        umpires={{
          positions: fixturePositions().map(p => ({
            ...p,
            person: { userId: 'mike', name: 'Mike T' }
          }))
        }}
      />
    )
    expect(document.querySelectorAll('[data-testid^="umpire-person-"]')).length(
      1
    )
    expect(document.body.textContent)
      .contains('Plate, Field')
      .and.contains('MT')
  })
  it('preselects an eligible person and requires the team choice', async () => {
    const f = fixture()
    let saved = false
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="uty_field:1"
        schedule={f.schedule}
        onClose={() => undefined}
        onSaved={() => {
          saved = true
        }}
      />
    )
    expect(target('Bobby L').getAttribute('aria-checked')).equals('true')
    expect(target('Confirm').getAttribute('aria-disabled')).equals('true')
    await press('Demo Hawks')
    await press('Confirm')
    expect(saved).equals(true)
    expect(f.saved).deep.equals([
      ['game', { slot: 'uty_field:1', userId: 'bobby', creditTeamId: 'hawks' }]
    ])
  })
  it('keeps confirmation unavailable for all-gray and empty choices', async () => {
    const f = fixture()
    f.schedule.games[0].choices['uty_plate:1'] = [
      { userId: 'uma', name: 'Uma L', reason: 'not certified for plate ump' }
    ]
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="uty_plate:1"
        schedule={f.schedule}
        onClose={() => undefined}
        onSaved={() => undefined}
      />
    )
    expect(target('Confirm').getAttribute('aria-disabled')).equals('true')
    f.schedule.games[0].choices['uty_plate:1'] = []
    f.schedule.games[0].positions = []
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="uty_plate:1"
        schedule={f.schedule}
        onClose={() => undefined}
        onSaved={() => undefined}
      />
    )
    expect(document.body.textContent).contains('No eligible people')
    expect(target('Confirm').getAttribute('aria-disabled')).equals('true')
  })
  it('opens notes, conflicts, signup, the profile sheet, filters and leaderboard', async () => {
    const f = fixture()
    function Harness(): React.ReactElement {
      const [route, setRoute] = useState<UmpireScheduleRoute>({
        name: 'umpireSchedule',
        id: 'demo'
      })
      return (
        <UmpireScheduleScreen
          client={f.client}
          route={route}
          leagues={[
            { id: 'demo', name: 'Demo League', logoUrl: null },
            { id: 'visitors', name: 'Demo Visitors', logoUrl: null }
          ]}
          onRoute={setRoute}
        />
      )
    }
    await mount(<Harness />)
    await press('Notes for Apr 2, 5:00 pm')
    expect(document.body.textContent).contains('North diamond entrance')
    await press('Cancel')
    expect(
      getComputedStyle(target('Conflict').firstElementChild!).minHeight
    ).equals('24px')
    expect(
      getComputedStyle(
        target('Sign Up, Plate, Demo Hawks vs Demo Eagles, Apr 2, 5:00 pm')
          .firstElementChild!
      ).minHeight
    ).equals('24px')
    await press('Conflict')
    expect(document.body.textContent).contains('ends 10 minutes')
    await press('Cancel')
    await press('Sign Up, Plate, Demo Hawks vs Demo Eagles, Apr 2, 5:00 pm')
    await press('Demo Hawks')
    await press('Confirm')
    await press('Uma L, uty_plate:1')
    expect(document.body.textContent)
      .contains('Uma Lee')
      .and.contains('Go to profile page')
      .and.contains('Remove assignment')
      .and.contains('Cancel')
    await press('Cancel')
    expect(f.saved.length).equals(1)
    await press('Schedule filters')
    await press('Monday')
    await press('majors')
    await press('Apply filters')
    await press('Leaderboard')
    expect(document.body.textContent)
      .contains('COMPLETED GAMES')
      .and.contains('TEAM CREDITS')
    await press('Schedule')
    expect(document.body.textContent).not.contains('League view')
    await press('Demo Visitors')
  })
  it('shows signup details and reserves radios for eligible people', async () => {
    const f = fixture()
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="uty_plate:1"
        schedule={f.schedule}
        onClose={() => undefined}
        onSaved={() => undefined}
      />
    )
    expect(document.body.textContent)
      .contains('Apr 2, 5:00 pm')
      .and.contains('Field 1')
      .and.contains('North diamond entrance')
    expect(document.querySelectorAll('[role="radio"]').length).equals(1)
    expect(
      target('Billy L, already playing then').getAttribute('role')
    ).not.equals('radio')
  })
  it('disables signup in the league view and renders unneeded and final cells without buttons', async () => {
    const f = fixture()
    f.schedule.view = 'league'
    f.schedule.games.push({
      ...f.schedule.games[0],
      id: 'final',
      status: 'final'
    })
    f.schedule.games.push({
      ...f.schedule.games[0],
      id: 'no-plate',
      positions: []
    })
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo', view: 'league' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(
      target(
        'Sign Up, Plate, Demo Hawks vs Demo Eagles, Apr 2, 5:00 pm'
      ).getAttribute('aria-disabled')
    ).equals('true')
    await press('Sign Up, Plate, Demo Hawks vs Demo Eagles, Apr 2, 5:00 pm')
    expect(document.querySelector('[role="radio"]')).equals(null)
    expect(
      document
        .querySelector('[data-testid="umpire-game-final"]')
        ?.querySelector('[aria-label^="Sign Up, Plate"]')
    ).equals(null)
    expect(document.body.textContent)
      .contains('Home team')
      .and.contains('Away team')
  })
  it('shows the event field in the column to the right of the venue', async () => {
    const f = fixture()
    f.schedule.games[0].field = 'North Diamond'
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    const header = document.querySelector(
      '[data-testid="umpire-table-header-scroll"]'
    )!
    expect(header.textContent).contains('VenueFieldNotes')
    const cells = [
      ...document.querySelector('[data-testid="umpire-game-game"]')!.children
    ].map(node => node.textContent)
    const venue = cells.indexOf('Field 1')
    expect(venue).greaterThan(-1)
    expect(cells[venue + 1]).equals('North Diamond')
  })
  it('opens every assigned umpire on a profile sheet titled with the display name', async () => {
    const f = fixture()
    const opened: string[] = []
    f.schedule.games[0].startAt = '2000-01-01T00:00:00Z'
    f.schedule.games[0].assignments['uty_plate:1'] = {
      userId: 'uma',
      name: 'Uma L',
      displayName: 'Uma Lee',
      assignedBy: 'uma',
      canRemove: false
    }
    f.schedule.isAdmin = false
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
        onOpenPerson={(userId, name) => {
          opened.push(`${userId}:${name}`)
        }}
      />
    )
    const name = target('Uma L, uty_plate:1')
    expect(name.getAttribute('aria-disabled')).not.equals('true')
    const shown = name.querySelector('[data-testid="ticker-text-content"]')!
    expect(getComputedStyle(shown).color).equals('rgb(21, 101, 192)')
    await press('Uma L, uty_plate:1')
    expect(document.body.textContent).contains('Uma Lee')
    expect(document.body.textContent).not.contains('Remove assignment')
    const profile = target('Go to profile page')
    expect(getComputedStyle(profile).borderTopWidth).not.equals('0px')
    expect(
      getComputedStyle(profile.querySelector('[dir="auto"]')!).color
    ).equals('rgb(21, 101, 192)')
    expect(
      getComputedStyle(target('Cancel').querySelector('[dir="auto"]')!).color
    ).equals('rgb(21, 101, 192)')
    await press('Go to profile page')
    expect(opened).deep.equals(['uma:Uma Lee'])
  })
  it('removes an assignment the viewer may revoke and hides it after the cutoff', async () => {
    const f = fixture()
    f.schedule.isAdmin = false
    f.schedule.games[0].assignments['uty_plate:1'] = {
      userId: 'uma',
      name: 'Uma L',
      displayName: 'Uma Lee',
      assignedBy: 'uma',
      canRemove: true
    }
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    await press('Uma L, uty_plate:1')
    const remove = target('Remove assignment')
    expect(
      getComputedStyle(remove.querySelector('[dir="auto"]')!).color
    ).equals('rgb(186, 26, 26)')
    await press('Remove assignment')
    expect(f.saved).deep.equals([['game', 'uty_plate:1']])
    expect(document.querySelector('[aria-label="Uma L, uty_plate:1"]')).equals(
      null
    )
    f.schedule.games[0].startAt = '2000-01-01T00:00:00Z'
    f.schedule.games[0].assignments['uty_plate:1'] = {
      userId: 'uma',
      name: 'Uma L',
      displayName: 'Uma Lee',
      assignedBy: 'uma',
      canRemove: true
    }
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    await press('Uma L, uty_plate:1')
    expect(document.body.textContent).contains('Go to profile page')
    expect(document.body.textContent).not.contains('Remove assignment')
    f.schedule.isAdmin = true
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    await press('Uma L, uty_plate:1')
    expect(document.body.textContent).contains('Remove assignment')
  })
  it('leaves a choice sheet that omits link flags on the danger Cancel', async () => {
    await mount(
      <ChoiceSheet
        title="Create"
        choices={[{ label: 'Make a team', onPress: () => undefined }]}
        onClose={() => undefined}
      />
    )
    expect(
      getComputedStyle(target('Make a team').querySelector('[dir="auto"]')!)
        .color
    ).not.equals('rgb(21, 101, 192)')
    expect(
      getComputedStyle(target('Cancel').querySelector('[dir="auto"]')!).color
    ).equals('rgb(186, 26, 26)')
  })

  it('holds its leave check only while its screen is on show', async () => {
    const f = fixture()
    const held: string[] = []
    const onBeforeLeave = (): (() => void) => {
      held.push('held')
      return () => {
        held.push('let go')
      }
    }
    const screen = (shown: boolean): React.ReactElement => (
      <SceneShownProvider value={shown}>
        <UmpireScheduleScreen
          client={f.client}
          route={{ name: 'umpireSchedule', id: 'demo' }}
          leagues={[]}
          onRoute={() => undefined}
          onBeforeLeave={onBeforeLeave}
        />
      </SceneShownProvider>
    )
    await mount(screen(true))
    expect(held).deep.equals(['held'])
    // Covered by a team opened from it: Back up there is not its to gate.
    await act(async () => {
      root!.render(<ThemeProvider>{screen(false)}</ThemeProvider>)
    })
    expect(held).deep.equals(['held', 'let go'])
    await act(async () => {
      root!.render(<ThemeProvider>{screen(true)}</ThemeProvider>)
    })
    expect(held).deep.equals(['held', 'let go', 'held'])
  })
  describe('Division and sort', () => {
    /** The screen on a route of its own, with every schedule query kept. */
    async function harness(
      f: ReturnType<typeof fixture>,
      start: Partial<UmpireScheduleRoute> = {},
      leagues: Array<{ id: string; name: string; logoUrl: null }> = []
    ): Promise<{
      route: () => UmpireScheduleRoute
      queries: string[]
      remount: () => Promise<void>
    }> {
      const queries: string[] = []
      f.client.umpireSchedulePage = async (id, query, page) => {
        queries.push(`${id}?${query ?? ''}`)
        return pageOfUmpireSchedule(f.schedule, page)
      }
      let current: UmpireScheduleRoute = {
        name: 'umpireSchedule',
        id: 'demo',
        ...start
      }
      function Harness(): React.ReactElement {
        const [route, setRoute] = useState<UmpireScheduleRoute>(current)
        current = route
        return (
          <UmpireScheduleScreen
            client={f.client}
            route={route}
            leagues={leagues}
            onRoute={setRoute}
          />
        )
      }
      await mount(<Harness />)
      return {
        route: () => current,
        queries,
        // Drawn again from the stack: a new screen on the route it held.
        remount: async () => {
          await mount(<Harness key="again" />)
        }
      }
    }
    const sent = (query: string): URLSearchParams =>
      new URLSearchParams(query.split('?')[1])
    /** The ids and labels of what stands on the filter row, in order. */
    const row = (): string[] =>
      [
        ...document.querySelector('[data-testid="umpire-filter-row"]')!
          .firstElementChild!.children
      ].map(
        node =>
          node.getAttribute('data-testid') ??
          node.getAttribute('aria-label') ??
          ''
      )
    const saveSort = (): HTMLElement | null =>
      document.querySelector('[data-testid="umpire-save-sort"]')
    /** Opens a sort button's dropdown and picks a row of it. */
    async function pick(button: string, option: string): Promise<void> {
      await act(async () => {
        document
          .querySelector<HTMLElement>(`[data-testid="${button}"]`)!
          .click()
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      await press(option)
    }

    it('heads a Division column after Date and fills it with each game’s season, in both views', async () => {
      for (const view of ['umpire', 'league'] as const) {
        const f = fixture()
        f.schedule.view = view
        await harness(f, view === 'league' ? { view } : {})
        const header = document.querySelector(
          '[data-testid="umpire-table-header"]'
        )!
        const headings = [...header.children].map(cell => cell.textContent)
        expect(headings.slice(0, 7)).deep.equals([
          'Date',
          'Division',
          'Home team',
          'Away team',
          'Venue',
          'Field',
          'Notes'
        ])
        const cells = document.querySelector(
          '[data-testid="umpire-game-game"]'
        )!.children
        expect(cells[0].textContent).equals('Apr 2, 5:00 pm')
        expect(cells[1].textContent).equals('Spring')
        expect(cells[2].textContent).equals('Demo Hawks')
        // As wide as the other fixed columns.
        expect((cells[1] as HTMLElement).style.width).equals(
          (cells[0] as HTMLElement).style.width
        )
        expect((header.children[1] as HTMLElement).style.width).equals(
          (cells[1] as HTMLElement).style.width
        )
      }
    })

    it('draws the row as one line that scrolls sideways, in order, with what is not needed left out', async () => {
      const f = fixture()
      f.schedule.settings.sort = null
      const h = await harness(f)
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="umpire-filter-row"]'
      )!
      expect(getComputedStyle(scroller).overflowX).equals('auto')
      const line = scroller.firstElementChild!
      expect(getComputedStyle(line).flexDirection).equals('row')
      expect(getComputedStyle(line).flexWrap).equals('nowrap')
      // The default sort: both sorts, no + Sort, no Save filter or Save sort.
      expect(row()).deep.equals([
        'settings-pill-button',
        'umpire-sort-1',
        'umpire-sort-2'
      ])
      expect(target('Schedule filters').textContent).contains('Filter')
      expect(
        target('Sort by Date, oldest to newest').querySelector(
          '[data-testid="sort-icon"]'
        )!.textContent
      ).equals('19')
      expect(target('Then by Season, A to Z').textContent).contains('Season')
      // A filter and one sort: Save filter, then the sort and + Sort, then
      // Save sort, last.
      await pick('umpire-sort-2', 'Remove sort')
      expect(h.route().sort).equals('date')
      expect(row()).deep.equals([
        'settings-pill-button',
        'umpire-sort-1',
        'umpire-sort-add',
        'umpire-save-sort'
      ])
      await press('Schedule filters')
      await press('Saturday')
      await press('Apply filters')
      expect(row()).deep.equals([
        'settings-pill-button',
        'umpire-save-filter',
        'umpire-sort-1',
        'umpire-sort-add',
        'umpire-save-sort'
      ])
      // The filter's whole label: nothing caps or shrinks it.
      const filterButton = target('Schedule filters')
      expect(filterButton.style.maxWidth).equals('')
      expect(h.route()).includes({ days: '5', sort: 'date' })
    })

    it('sends the route’s sort only when it has one, cleaned of what is not valid', async () => {
      const f = fixture()
      const plain = await harness(f)
      expect(sent(plain.queries[0]).has('sort')).equals(false)
      const cases: Array<[string, string | null, string[]]> = [
        ['date,-season', 'date,-season', ['Date', 'Season']],
        [
          'bogus,season,-season,certification',
          'season,certification',
          ['Season', 'Certification']
        ],
        ['bogus', null, ['Date', 'Season']],
        ['none', 'none', ['Sort']]
      ]
      for (const [link, query, labels] of cases) {
        const g = fixture()
        const h = await harness(g, { sort: link })
        const asked = sent(h.queries[0])
        expect(asked.get('sort'), link).equals(query)
        // The address is left as it was.
        expect(h.route().sort).equals(link)
        const shown = row()
          .filter(id => id.startsWith('umpire-sort-'))
          .map(id =>
            document
              .querySelector(`[data-testid="${id}"]`)!
              .textContent!.replace(/^(AZ|ZA|19|91)/, '')
          )
        expect(shown, link).deep.equals(labels)
      }
    })

    it('shows the sort the server applied when the route has none', async () => {
      const f = fixture()
      f.schedule.sort = ['-certification', 'seasonPriority']
      f.schedule.settings.sort = ['-certification', 'seasonPriority']
      await harness(f)
      expect(target('Sort by Certification, Z to A')).not.equals(undefined)
      expect(target('Then by Season, league order, first to last')).not.equals(
        undefined
      )
      expect(saveSort()).equals(null)
    })

    it('writes a sort choice into the route, keeping the filter marker, and asks for it', async () => {
      const f = fixture()
      const h = await harness(f, { filter: 'none' })
      await pick('umpire-sort-1', 'Date, newest to oldest')
      expect(h.route()).includes({ sort: '-date,season', filter: 'none' })
      expect(sent(h.queries.at(-1)!).get('sort')).equals('-date,season')
      await pick('umpire-sort-1', 'Remove sort')
      await pick('umpire-sort-1', 'Remove sort')
      expect(h.route().sort).equals('none')
      expect(sent(h.queries.at(-1)!).get('sort')).equals('none')
      expect(row().filter(id => id.startsWith('umpire-sort-'))).deep.equals([
        'umpire-sort-1'
      ])
    })

    it('drops the sort on a league switch, and keeps it when drawn again from its route', async () => {
      const f = fixture()
      const h = await harness(f, { sort: 'certification' }, [
        { id: 'demo', name: 'Demo League', logoUrl: null },
        { id: 'visitors', name: 'Demo Visitors', logoUrl: null }
      ])
      await h.remount()
      expect(h.route().sort).equals('certification')
      expect(sent(h.queries.at(-1)!).get('sort')).equals('certification')
      expect(target('Sort by Certification, A to Z')).not.equals(undefined)
      await press('Demo Visitors')
      expect(h.route()).includes({ id: 'visitors' })
      expect(h.route().sort).equals(undefined)
      expect(sent(h.queries.at(-1)!).has('sort')).equals(false)
    })

    it('offers Save sort only to an admin whose sort differs from the league default, saves it, and hides', async () => {
      // Not an admin: never.
      const reader = fixture()
      reader.schedule.isAdmin = false
      await harness(reader, { sort: 'certification' })
      expect(saveSort()).equals(null)
      // An admin with no sort in the route: none.
      const f = fixture()
      f.schedule.settings.sort = null
      await harness(f)
      expect(saveSort()).equals(null)
      // The built-in default in the route, with none saved: none.
      await harness(fixture(), { sort: 'date,season' })
      expect(saveSort()).equals(null)
      // The saved default in the route: none.
      const g = fixture()
      g.schedule.settings.sort = ['-certification']
      await harness(g, { sort: '-certification' })
      expect(saveSort()).equals(null)
      // A different sort: Save sort, green, saved as the league's.
      const saves: unknown[] = []
      g.client.setUmpireSettings = async (league, settings) => {
        saves.push([league, settings])
        return { management: true, credits: true, sort: settings.sort }
      }
      const h = await harness(g, { sort: 'seasonPriority' })
      expect(saveSort()).not.equals(null)
      expect(saveSort()!.getAttribute('aria-label')).equals(
        'Save this sort as the league default'
      )
      expect(saveSort()!.textContent).equals('Save sort')
      expect(
        getComputedStyle(
          saveSort()!.querySelector('[data-testid="settings-pill-tab"]')!
        ).backgroundColor
      ).not.equals(
        getComputedStyle(
          target('Sort by Season, league order, first to last').querySelector(
            '[data-testid="settings-pill-tab"]'
          )!
        ).backgroundColor
      )
      const reads = h.queries.length
      await press('Save this sort as the league default')
      expect(saves).deep.equals([['demo', { sort: ['seasonPriority'] }]])
      expect(saveSort()).equals(null)
      // The rows are already in this sort: nothing is read again.
      expect(h.queries).length(reads)
      expect(h.route().sort).equals('seasonPriority')
    })

    it('shows the screen’s error when Save sort fails, and keeps the button', async () => {
      const f = fixture()
      f.client.setUmpireSettings = async () => {
        throw new Error('Choose up to two sorts of different fields.')
      }
      await harness(f, { sort: 'certification' })
      await press('Save this sort as the league default')
      expect(document.body.textContent).contains(
        'Choose up to two sorts of different fields.'
      )
      expect(saveSort()).not.equals(null)
    })

    it('keeps Save sort hidden when a page read begun before the save answers after it', async () => {
      const f = fixture()
      f.schedule.settings.sort = ['-certification']
      // A long schedule: the first page names a later one.
      const [first] = f.schedule.games
      f.schedule.games = Array.from({ length: 60 }, (_, i) => ({
        ...first,
        id: `game-${i}`
      }))
      f.client.setUmpireSettings = async (_league, settings) => ({
        management: true,
        credits: true,
        sort: settings.sort
      })
      await harness(f, { sort: 'seasonPriority' })
      expect(saveSort()).not.equals(null)
      // The later page's read waits on the test, and answers with the
      // default as the server held it when the read began.
      let answer!: () => void
      f.client.umpireSchedulePage = async (_id, _query, page) =>
        await new Promise<UmpireSchedulePage>(resolve => {
          answer = () => {
            resolve(pageOfUmpireSchedule(f.schedule, page))
          }
        })
      await act(async () => {
        reachEnd()
      })
      await press('Save this sort as the league default')
      expect(saveSort()).equals(null)
      await act(async () => {
        answer()
      })
      // The later rows are in, and the saved default still stands.
      expect(
        document.querySelectorAll('[data-testid^="umpire-game-game-"]')
      ).length(60)
      expect(saveSort()).equals(null)
    })
  })
  describe('Save filter', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const other = zone === 'America/Chicago' ? 'Asia/Tokyo' : 'America/Chicago'
    const weeknights: UmpireAvailability = {
      levels: [],
      days: [0, 1, 2, 3, 4],
      from: '17:00',
      to: '23:00',
      timezone: other
    }
    const saveButton = (): HTMLElement | null =>
      document.querySelector('[data-testid="umpire-save-filter"]')
    /** A read of the saved filter that answers when the test says. */
    function deferred<T>(): {
      promise: Promise<T>
      resolve: (value: T) => void
    } {
      let answer!: (value: T) => void
      const promise = new Promise<T>(resolve => {
        answer = resolve
      })
      return { promise, resolve: answer }
    }
    /** The screen on a route of its own, with every schedule query kept. */
    async function harness(
      f: ReturnType<typeof fixture>,
      start: Partial<UmpireScheduleRoute> = {},
      leagues: Array<{ id: string; name: string; logoUrl: null }> = []
    ): Promise<{ route: () => UmpireScheduleRoute; queries: string[] }> {
      const queries: string[] = []
      f.client.umpireSchedulePage = async (id, query, page) => {
        queries.push(`${id}?${query ?? ''}`)
        return pageOfUmpireSchedule(f.schedule, page)
      }
      let current: UmpireScheduleRoute
      function Harness(): React.ReactElement {
        const [route, setRoute] = useState<UmpireScheduleRoute>({
          name: 'umpireSchedule',
          id: 'demo',
          ...start
        })
        current = route
        return (
          <UmpireScheduleScreen
            client={f.client}
            route={route}
            leagues={leagues}
            onRoute={setRoute}
          />
        )
      }
      await mount(<Harness />)
      return { route: () => current, queries }
    }
    it('compares the applied filter with the saved one, the zone only where days or times read it', () => {
      const route: UmpireScheduleRoute = { name: 'umpireSchedule', id: 'demo' }
      const none = appliedAvailability(route)
      expect(none).deep.equals({
        levels: [],
        days: [],
        from: null,
        to: null,
        timezone: zone
      })
      expect(availabilityDiffers(none, null)).equals(false)
      expect(availabilityDiffers({ ...none, levels: ['majors'] }, null)).equals(
        true
      )
      expect(availabilityDiffers(none, weeknights)).equals(true)
      const applied = appliedAvailability(withAvailability(route, weeknights))
      expect(availabilityDiffers(applied, weeknights)).equals(false)
      expect(
        availabilityDiffers(
          { ...applied, days: [4, 3, 2, 1, 0] },
          { ...weeknights }
        )
      ).equals(false)
      expect(
        availabilityDiffers({ ...applied, to: '22:00' }, weeknights)
      ).equals(true)
      expect(
        availabilityDiffers({ ...applied, timezone: zone }, weeknights)
      ).equals(true)
      const levelsOnly = { ...weeknights, days: [], from: null, to: null }
      expect(
        availabilityDiffers(
          { ...levelsOnly, levels: ['majors'], timezone: zone },
          { ...levelsOnly, levels: ['majors'] }
        )
      ).equals(false)
      expect(
        availabilityDiffers(
          { ...levelsOnly, levels: ['majors'] },
          { ...levelsOnly, levels: ['aa'] }
        )
      ).equals(true)
      expect(routeNamesFilter({ ...route, priorSeasons: 'true' })).equals(false)
      expect(routeNamesFilter({ ...route, to: '18:00' })).equals(true)
      expect(
        withAvailability(
          { ...route, priorSeasons: 'true', levels: 'aa' },
          { ...weeknights, levels: [], days: [] }
        )
      ).deep.equals({
        ...route,
        priorSeasons: 'true',
        levels: undefined,
        days: undefined,
        from: '17:00',
        to: '23:00',
        timezone: other
      })
    })
    it('refuses half a time range in the dialog, so Apply stays off', async () => {
      const f = fixture()
      const h = await harness(f)
      await press('Schedule filters')
      await press('Start time')
      await press('Use time')
      expect(document.body.textContent).contains(
        'Choose both a start and an end time.'
      )
      expect(target('Apply filters').getAttribute('aria-disabled')).equals(
        'true'
      )
      await press('End time')
      await press('Use time')
      expect(document.body.textContent).not.contains(
        'Choose both a start and an end time.'
      )
      await press('Start time')
      await press('Clear filters')
      await press('End time')
      await press('Use time')
      expect(document.body.textContent).contains(
        'Choose both a start and an end time.'
      )
      await press('Cancel')
      expect(h.route().to).equals(undefined)
    })
    it('waits for the saved filter, then applies it with its zone and keeps prior seasons', async () => {
      const f = fixture()
      const read = deferred<UmpireAvailability | null>()
      const leagues: string[] = []
      f.client.umpireAvailability = async league => {
        leagues.push(league)
        return await read.promise
      }
      const h = await harness(f, { priorSeasons: 'true' })
      expect(leagues).deep.equals(['demo'])
      // No schedule request before the saved filter is known.
      expect(h.queries).deep.equals([])
      expect(saveButton()).equals(null)
      expect(document.body.textContent).contains('Loading…')
      await act(async () => {
        read.resolve(weeknights)
      })
      expect(h.route()).includes({
        days: '0,1,2,3,4',
        from: '17:00',
        to: '23:00',
        timezone: other,
        priorSeasons: 'true'
      })
      expect(h.route().levels).equals(undefined)
      const first = new URLSearchParams(h.queries[0].split('?')[1])
      expect(first.get('days')).equals('0,1,2,3,4')
      expect(first.get('from')).equals('17:00')
      // Rows are dated in the device's zone; the saved days and range are
      // matched in the zone they were saved in.
      expect(first.get('timezone')).equals(zone)
      expect(first.get('filterTimezone')).equals(other)
      expect(
        h.queries.every(
          q =>
            new URLSearchParams(q.split('?')[1]).get('filterTimezone') === other
        )
      ).equals(true)
      expect(h.queries.every(q => q.includes('days=0'))).equals(true)
      expect(target('Schedule filters').textContent).contains('MTWTF')
      // Applied equals saved: nothing to save.
      expect(saveButton()).equals(null)
    })
    it('reads no saved filter for an empty league and loads as before', async () => {
      const f = fixture()
      const leagues: string[] = []
      f.client.umpireAvailability = async league => {
        leagues.push(league)
        return weeknights
      }
      const h = await harness(f, { id: '' })
      expect(leagues).deep.equals([])
      expect(h.queries).length(1)
      expect(h.route().days).equals(undefined)
      expect(saveButton()).equals(null)
    })
    it('leaves a route that names a filter as it is and loads it at once', async () => {
      const f = fixture()
      const read = deferred<UmpireAvailability | null>()
      f.client.umpireAvailability = async () => await read.promise
      const h = await harness(f, { days: '5' })
      expect(h.queries).length(1)
      expect(
        new URLSearchParams(h.queries[0].split('?')[1]).get('timezone')
      ).equals(zone)
      expect(
        new URLSearchParams(h.queries[0].split('?')[1]).has('filterTimezone')
      ).equals(false)
      expect(saveButton()).equals(null)
      await act(async () => {
        read.resolve(weeknights)
      })
      expect(h.route().days).equals('5')
      expect(h.route().timezone).equals(undefined)
      // A filter other than the saved one: Save filter, right of the filter,
      // then the sorts, on one line of a row that scrolls sideways.
      const line = document.querySelector(
        '[data-testid="umpire-filter-row"]'
      )!.firstElementChild!
      expect(line.children[1]).equals(saveButton())
      expect(line.firstElementChild).equals(target('Schedule filters'))
      expect(line.children[2].getAttribute('data-testid')).equals(
        'umpire-sort-1'
      )
      expect(getComputedStyle(line).flexDirection).equals('row')
      expect(getComputedStyle(line).flexWrap).equals('nowrap')
      expect(saveButton()!.getAttribute('aria-label')).equals(
        'Save this filter as your availability'
      )
      expect(saveButton()!.textContent).contains('Save filter')
    })
    it('shows Save filter for a change, saves the applied filter or null, and hides', async () => {
      const f = fixture()
      const saves: Array<[string, UmpireAvailability | null]> = []
      const save = deferred<undefined>()
      f.client.saveUmpireAvailability = async (league, availability) => {
        saves.push([league, availability])
        await save.promise
        return availability
      }
      const h = await harness(f)
      // None saved and none applied: nothing to save.
      expect(h.queries).length(1)
      expect(saveButton()).equals(null)
      await press('Schedule filters')
      await press('Saturday')
      await press('majors')
      await press('Apply filters')
      expect(saveButton()).not.equals(null)
      await press('Save this filter as your availability')
      expect(saveButton()!.getAttribute('aria-busy')).equals('true')
      await act(async () => {
        save.resolve(undefined)
      })
      expect(saves).deep.equals([
        [
          'demo',
          {
            levels: ['majors'],
            days: [5],
            from: null,
            to: null,
            timezone: zone
          }
        ]
      ])
      expect(saveButton()).equals(null)
      // Clear filters, then Apply: the saved filter is no longer applied.
      await press('Schedule filters')
      await press('Clear filters')
      await press('Apply filters')
      expect(h.route().days).equals(undefined)
      expect(saveButton()).not.equals(null)
      await press('Save this filter as your availability')
      expect(saves.at(-1)).deep.equals(['demo', null])
      expect(saveButton()).equals(null)
    })
    it('shows the screen’s error when a save fails, and keeps the button', async () => {
      const f = fixture()
      f.client.saveUmpireAvailability = async () => {
        throw new Error('Choose a valid filter.')
      }
      await harness(f, { levels: 'majors' })
      await press('Save this filter as your availability')
      expect(document.body.textContent).contains('Choose a valid filter.')
      expect(saveButton()).not.equals(null)
      expect(saveButton()!.getAttribute('aria-busy')).equals('false')
    })
    it('loads unfiltered with no error and no Save filter when the read fails', async () => {
      const f = fixture()
      f.client.umpireAvailability = async () => {
        throw new Error('Saved filter unavailable')
      }
      const h = await harness(f, { levels: 'majors' })
      expect(saveButton()).equals(null)
      expect(document.body.textContent).not.contains('Saved filter unavailable')
      const g = fixture()
      g.client.umpireAvailability = async () => {
        throw new Error('Saved filter unavailable')
      }
      const fresh = await harness(g)
      expect(fresh.queries).length(1)
      expect(
        new URLSearchParams(fresh.queries[0].split('?')[1]).has('days')
      ).equals(false)
      expect(document.body.textContent)
        .contains('Demo Hawks')
        .and.not.contains('Saved filter unavailable')
      expect(saveButton()).equals(null)
      expect(h.route().levels).equals('majors')
    })
    it('clears Save filter’s busy state when the league changes before the save answers', async () => {
      const f = fixture()
      const save = deferred<undefined>()
      f.client.umpireAvailability = async () => null
      f.client.saveUmpireAvailability = async (_league, availability) => {
        await save.promise
        return availability
      }
      const h = await harness(f, { levels: 'majors' }, [
        { id: 'demo', name: 'Demo League', logoUrl: null },
        { id: 'visitors', name: 'Demo Visitors', logoUrl: null }
      ])
      await press('Save this filter as your availability')
      expect(saveButton()!.getAttribute('aria-busy')).equals('true')
      await press('Demo Visitors')
      expect(h.route()).includes({ id: 'visitors' })
      await act(async () => {
        save.resolve(undefined)
      })
      await press('Schedule filters')
      await press('majors')
      await press('Apply filters')
      expect(h.route()).includes({ id: 'visitors', levels: 'majors' })
      expect(saveButton()).not.equals(null)
      expect(saveButton()!.getAttribute('aria-busy')).equals('false')
    })
    it('keeps a saved filter’s zone when Apply changes a level or a day, and drops it once no day or time is left', async () => {
      const device = process.env.TZ
      process.env.TZ = 'America/Los_Angeles'
      try {
        const f = fixture()
        const evenings: UmpireAvailability = {
          levels: [],
          days: [1],
          from: '18:00',
          to: '21:00',
          timezone: 'America/New_York'
        }
        f.client.umpireAvailability = async () => evenings
        const h = await harness(f)
        expect(h.route()).includes({ timezone: 'America/New_York' })
        await press('Schedule filters')
        await press('majors')
        await press('Apply filters')
        expect(h.route()).includes({
          levels: 'majors',
          days: '1',
          from: '18:00',
          to: '21:00',
          timezone: 'America/New_York'
        })
        const last = new URLSearchParams(h.queries.at(-1)!.split('?')[1])
        expect(last.get('timezone')).equals('America/Los_Angeles')
        expect(last.get('filterTimezone')).equals('America/New_York')
        expect(last.get('levels')).equals('majors')
        expect(last.get('from')).equals('18:00')
        expect(last.get('to')).equals('21:00')
        // Only the level differs from the saved filter, in its own zone.
        await press('Save this filter as your availability')
        // A changed day is read in the zone the dialog names.
        await press('Schedule filters')
        await press('Saturday')
        await press('Apply filters')
        expect(h.route()).includes({
          days: '1,5',
          timezone: 'America/New_York'
        })
        expect(
          new URLSearchParams(h.queries.at(-1)!.split('?')[1]).get(
            'filterTimezone'
          )
        ).equals('America/New_York')
        // With no day or time left, nothing reads the zone.
        await press('Schedule filters')
        await press('Clear filters')
        await press('majors')
        await press('Apply filters')
        expect(h.route()).includes({ levels: 'majors' })
        expect(h.route().timezone).equals(undefined)
        expect(
          new URLSearchParams(h.queries.at(-1)!.split('?')[1]).get('timezone')
        ).equals('America/Los_Angeles')
        expect(
          new URLSearchParams(h.queries.at(-1)!.split('?')[1]).has(
            'filterTimezone'
          )
        ).equals(false)
      } finally {
        if (device == null) delete process.env.TZ
        else process.env.TZ = device
      }
    })
    it('leaves a levels-only saved filter in the device’s zone', async () => {
      const device = process.env.TZ
      process.env.TZ = 'America/Los_Angeles'
      try {
        const f = fixture()
        f.client.umpireAvailability = async () => ({
          levels: ['majors'],
          days: [],
          from: null,
          to: null,
          timezone: 'America/New_York'
        })
        const h = await harness(f)
        expect(h.route().levels).equals('majors')
        expect(h.route().timezone).equals(undefined)
        const first = new URLSearchParams(h.queries[0].split('?')[1])
        expect(first.get('levels')).equals('majors')
        expect(first.get('timezone')).equals('America/Los_Angeles')
        expect(first.has('filterTimezone')).equals(false)
        expect(h.queries.every(q => !q.includes('New_York'))).equals(true)
        // The zone reads no days or range, so applied equals saved.
        expect(saveButton()).equals(null)
      } finally {
        if (device == null) delete process.env.TZ
        else process.env.TZ = device
      }
    })
    it('drops days a hand-edited link holds that are no weekday', async () => {
      const f = fixture()
      const saves: Array<UmpireAvailability | null> = []
      f.client.umpireAvailability = async () => null
      f.client.saveUmpireAvailability = async (_league, availability) => {
        saves.push(availability)
        return availability
      }
      const h = await harness(f, { days: 'x,1,9' })
      expect(routeDays(h.route())).deep.equals([1])
      expect(
        new URLSearchParams(h.queries[0].split('?')[1]).get('days')
      ).equals('1')
      await press('Save this filter as your availability')
      expect(saves).deep.equals([
        { levels: [], days: [1], from: null, to: null, timezone: zone }
      ])
    })
    it('compares and saves only the levels the league still has', async () => {
      const f = fixture()
      const saves: Array<UmpireAvailability | null> = []
      f.client.umpireAvailability = async () => ({
        levels: ['majors'],
        days: [],
        from: null,
        to: null,
        timezone: zone
      })
      f.client.saveUmpireAvailability = async (_league, availability) => {
        saves.push(availability)
        return availability
      }
      // A stale link: a level since deleted beside one the league has.
      const h = await harness(f, { levels: 'majors,gone' })
      expect(h.route().levels).equals('majors,gone')
      expect(saveButton()).equals(null)
      expect(
        appliedAvailability({ ...h.route(), days: '5' }, ['majors']).levels
      ).deep.equals(['majors'])
      // A change saves without the stale level.
      await press('Schedule filters')
      await press('Saturday')
      await press('Apply filters')
      await press('Save this filter as your availability')
      expect(saves).deep.equals([
        { levels: ['majors'], days: [5], from: null, to: null, timezone: zone }
      ])
      // A link naming only a deleted level asks for no save.
      const g = fixture()
      g.client.umpireAvailability = async () => null
      await harness(g, { levels: 'gone' })
      expect(saveButton()).equals(null)
    })
    it('reads half a range in a link as no range, neither compared nor saved', async () => {
      const route: UmpireScheduleRoute = { name: 'umpireSchedule', id: 'demo' }
      for (const half of [{ from: '18:00' }, { to: '21:00' }]) {
        expect(appliedAvailability({ ...route, ...half })).deep.equals({
          levels: [],
          days: [],
          from: null,
          to: null,
          timezone: zone
        })
        expect(
          availabilityDiffers(appliedAvailability({ ...route, ...half }), null)
        ).equals(false)
      }
      expect(
        appliedAvailability({ ...route, from: '18:00', to: '21:00' })
      ).deep.include({ from: '18:00', to: '21:00' })
      // A lone from, with nothing saved: no Save filter.
      const f = fixture()
      f.client.umpireAvailability = async () => null
      await harness(f, { from: '18:00' })
      expect(saveButton()).equals(null)
      // Days with a lone from: Save filter saves the days alone.
      const g = fixture()
      const saves: Array<UmpireAvailability | null> = []
      g.client.umpireAvailability = async () => null
      g.client.saveUmpireAvailability = async (_league, availability) => {
        saves.push(availability)
        return availability
      }
      await harness(g, { days: '1', from: '18:00' })
      await press('Save this filter as your availability')
      expect(saves).deep.equals([
        { levels: [], days: [1], from: null, to: null, timezone: zone }
      ])
    })
    it('switches league to that league’s saved filter, and back', async () => {
      const f = fixture()
      const saturday: UmpireAvailability = {
        levels: [],
        days: [5],
        from: null,
        to: null,
        timezone: zone
      }
      const reads: Record<
        string,
        ReturnType<typeof deferred<UmpireAvailability | null>>
      > = {}
      f.client.umpireAvailability = async league => {
        reads[league] = deferred<UmpireAvailability | null>()
        return await reads[league].promise
      }
      const h = await harness(f, {}, [
        { id: 'demo', name: 'Demo League', logoUrl: null },
        { id: 'visitors', name: 'Demo Visitors', logoUrl: null }
      ])
      await act(async () => {
        reads.demo.resolve(weeknights)
      })
      expect(h.route().days).equals('0,1,2,3,4')
      const before = h.queries.length
      await press('Demo Visitors')
      expect(h.route()).includes({ id: 'visitors' })
      for (const key of ['days', 'from', 'to', 'timezone', 'levels'] as const)
        expect(h.route()[key], key).equals(undefined)
      // The next league waits for its own saved filter.
      expect(h.queries.length).equals(before)
      await act(async () => {
        reads.visitors.resolve(saturday)
      })
      expect(h.route()).includes({ id: 'visitors', days: '5' })
      const first = new URLSearchParams(h.queries[before].split('?')[1])
      expect(h.queries[before].startsWith('visitors?')).equals(true)
      expect(first.get('days')).equals('5')
      expect(saveButton()).equals(null)
      await press('Demo League')
      await act(async () => {
        reads.demo.resolve(weeknights)
      })
      expect(h.route()).includes({
        id: 'demo',
        days: '0,1,2,3,4',
        timezone: other
      })
    })
    it('applies no saved filter once the person has changed the filter, and shows no rows of the old one', async () => {
      const f = fixture()
      const read = deferred<UmpireAvailability | null>()
      f.client.umpireAvailability = async () => await read.promise
      const h = await harness(f, { days: '1' })
      const row = (): Element | null =>
        document.querySelector('[data-testid="umpire-game-game"]')
      expect(row()).not.equals(null)
      await press('Schedule filters')
      await press('Clear filters')
      await press('Apply filters')
      expect(routeNamesFilter(h.route())).equals(false)
      // Until the saved filter is read, the unfiltered schedule waits, and
      // the old filter's rows are not on show under its pill.
      expect(row()).equals(null)
      expect(document.querySelector('[aria-label="Schedule filters"]')).equals(
        null
      )
      const before = h.queries.length
      await act(async () => {
        read.resolve(weeknights)
      })
      expect(routeNamesFilter(h.route())).equals(false)
      expect(h.route().timezone).equals(undefined)
      expect(h.queries.length).greaterThan(before)
      const last = new URLSearchParams(h.queries.at(-1)!.split('?')[1])
      expect(last.has('days')).equals(false)
      expect(last.has('filterTimezone')).equals(false)
      expect(row()).not.equals(null)
      expect(target('Schedule filters').textContent).not.contains('·')
      // The saved filter is not the applied one.
      expect(saveButton()).not.equals(null)
    })
    it('keeps a cleared saved filter cleared when the screen is drawn again from its route, and applies it on a fresh entry (6.harness-review.3)', async () => {
      const f = fixture()
      f.client.umpireAvailability = async () => weeknights
      const fresh = await harness(f)
      // A fresh entry: the saved filter applies.
      expect(fresh.route()).includes({ days: '0,1,2,3,4', timezone: other })
      expect(fresh.route().filter).equals(undefined)
      expect(saveButton()).equals(null)
      await press('Schedule filters')
      await press('Clear filters')
      await press('Apply filters')
      const cleared = fresh.route()
      expect(routeNamesFilter(cleared)).equals(false)
      expect(cleared.filter).equals('none')
      // Back from a game and its team: the screen mounts again on the route
      // its stack entry kept.
      const again = await harness(f, cleared)
      expect(routeNamesFilter(again.route())).equals(false)
      expect(again.route().filter).equals('none')
      const last = new URLSearchParams(again.queries.at(-1)!.split('?')[1])
      expect(last.has('days')).equals(false)
      expect(last.has('filterTimezone')).equals(false)
      expect(saveButton()).not.equals(null)
      // Choosing a filter again drops the marker; a fresh entry (no marker)
      // applies the saved filter as before.
      await press('Schedule filters')
      await press('Saturday')
      await press('Apply filters')
      expect(again.route()).includes({ days: '5' })
      expect(again.route().filter).equals(undefined)
      const reentered = await harness(f)
      expect(reentered.route()).includes({ days: '0,1,2,3,4' })
    })
    it('names the filter’s zone in its label and dialog when it is not the device’s', async () => {
      const device = process.env.TZ
      process.env.TZ = 'America/Los_Angeles'
      try {
        const route: UmpireScheduleRoute = {
          name: 'umpireSchedule',
          id: 'demo',
          days: '0',
          from: '18:00',
          to: '20:00',
          timezone: 'America/Chicago'
        }
        expect(umpireFilterLabel(route, [])).matches(
          /^Filter · M · 6:00 PM–8:00 PM C[SD]T$/
        )
        expect(
          umpireFilterLabel({ ...route, from: undefined, to: undefined }, [])
        ).matches(/^Filter · M · C[SD]T$/)
        expect(
          umpireFilterLabel({ ...route, days: undefined, levels: 'a' }, [
            { id: 'a', name: 'AA', position: 0, inUse: true }
          ])
        ).matches(/^Filter · 6:00 PM–8:00 PM C[SD]T · AA$/)
        // A levels-only filter reads no zone.
        expect(
          umpireFilterLabel(
            { ...route, days: undefined, from: undefined, to: undefined },
            []
          )
        ).equals('Filter')
        expect(
          umpireFilterLabel({ ...route, timezone: 'America/Los_Angeles' }, [])
        ).equals('Filter · M · 6:00 PM–8:00 PM')
        expect(umpireFilterLabel({ ...route, timezone: undefined }, [])).equals(
          'Filter · M · 6:00 PM–8:00 PM'
        )
        const f = fixture()
        f.client.umpireAvailability = async () => null
        const h = await harness(f, { ...route, timezone: undefined })
        await press('Schedule filters')
        expect(
          document.querySelector('[data-testid="umpire-filter-zone"]')
        ).equals(null)
        await press('Cancel')
        const g = fixture()
        g.client.umpireAvailability = async () => null
        await harness(g, route)
        expect(target('Schedule filters').textContent).matches(/C[SD]T/)
        await press('Schedule filters')
        expect(
          document.querySelector('[data-testid="umpire-filter-zone"]')
            ?.textContent
        ).matches(/^Days and times in C[SD]T$/)
        expect(h.route().timezone).equals(undefined)
      } finally {
        if (device == null) delete process.env.TZ
        else process.env.TZ = device
      }
    })
    it('keeps the saved zone when Apply edits only one end of the range', async () => {
      const device = process.env.TZ
      process.env.TZ = 'America/Los_Angeles'
      try {
        const f = fixture()
        f.client.umpireAvailability = async () => ({
          levels: [],
          days: [],
          from: '18:00',
          to: '20:00',
          timezone: 'America/Chicago'
        })
        const h = await harness(f)
        expect(h.route()).includes({ timezone: 'America/Chicago' })
        await press('Schedule filters')
        await press('End time')
        await press('Hour 09')
        await press('Use time')
        await press('Apply filters')
        expect(h.route()).includes({
          from: '18:00',
          to: '21:00',
          timezone: 'America/Chicago'
        })
        const last = new URLSearchParams(h.queries.at(-1)!.split('?')[1])
        expect(last.get('from')).equals('18:00')
        expect(last.get('to')).equals('21:00')
        expect(last.get('filterTimezone')).equals('America/Chicago')
        expect(last.get('timezone')).equals('America/Los_Angeles')
      } finally {
        if (device == null) delete process.env.TZ
        else process.env.TZ = device
      }
    })
    it('compares a link’s repeated levels as the saved filter stores them', async () => {
      const f = fixture()
      const saves: Array<UmpireAvailability | null> = []
      f.client.umpireAvailability = async () => null
      f.client.saveUmpireAvailability = async (_league, availability) => {
        saves.push(availability)
        return availability
      }
      const h = await harness(f, { levels: 'majors,majors' })
      expect(appliedAvailability(h.route()).levels).deep.equals(['majors'])
      await press('Save this filter as your availability')
      expect(saves).deep.equals([
        { levels: ['majors'], days: [], from: null, to: null, timezone: zone }
      ])
      expect(saveButton()).equals(null)
      expect(
        availabilityDiffers(
          appliedAvailability({ ...h.route(), days: '3,1,1' }),
          {
            levels: ['majors'],
            days: [1, 3],
            from: null,
            to: null,
            timezone: zone
          }
        )
      ).equals(false)
    })
  })
})
