import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Linking, Platform } from 'react-native'

import { TeamStationClient } from '../../common/api'
import {
  UMPIRE_RANK_SYMBOLS,
  type UmpireSchedule
} from '../../common/umpireSchedule'
import { fixturePositions, fixtureTypes } from '../../test/umpireTypes'
import { AppHeader } from '../components/AppHeader'
import type { UmpireScheduleRoute } from '../navigation/routes'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameUmpires } from './GameUmpires'
import { UmpireLeaderboardView } from './UmpireLeaderboardView'
import {
  initialUmpireGame,
  optionalPositionHeader,
  umpireFilterLabel,
  UmpireScheduleScreen
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
      measure('umpire-game-game', 1200, 49, 0)
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
      measure('umpire-game-game', 1200, 49, 400)
    })
  })
  it('requests the viewer timezone and puts compact conflicts after custom notes', async () => {
    const f = fixture()
    f.schedule.noteTypes = [
      { id: 'note', name: 'Jersey Color', position: 0, inUse: false }
    ]
    let query = ''
    f.client.umpireSchedule = async (_id, q) => {
      query = q ?? ''
      return f.schedule
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
        '[aria-label="Umpire pages"] [data-testid="settings-pill-tab"]'
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
    const fiberKey = Object.keys(button).find(k =>
      k.startsWith('__reactFiber')
    )!
    let fiber = (button as unknown as Record<string, unknown>)[fiberKey] as {
      memoizedProps?: { automaticallyAdjustKeyboardInsets?: boolean }
      stateNode?: {
        scrollResponderScrollNativeHandleToKeyboard: (
          ...args: unknown[]
        ) => void
      }
      ref?: {
        current?: {
          scrollResponderScrollNativeHandleToKeyboard: (
            ...args: unknown[]
          ) => void
        }
      }
      return?: unknown
    } | null
    let insets = false
    let scroll: NonNullable<NonNullable<typeof fiber>['stateNode']> | undefined
    while (fiber != null) {
      if (fiber.memoizedProps?.automaticallyAdjustKeyboardInsets === true)
        insets = true
      if (
        typeof fiber.ref?.current
          ?.scrollResponderScrollNativeHandleToKeyboard === 'function'
      )
        scroll = fiber.ref.current
      fiber = fiber.return as typeof fiber
    }
    expect(
      insets,
      'owning vertical scroll view adjusts keyboard insets'
    ).equals(true)
    expect(scroll).not.equals(undefined)
    const reveal =
      scroll!.scrollResponderScrollNativeHandleToKeyboard.bind(scroll)
    const revealed: unknown[][] = []
    const os = Platform.OS
    try {
      Platform.OS = 'ios'
      await press(label)
      scroll!.scrollResponderScrollNativeHandleToKeyboard = (...args) => {
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
      scroll!.scrollResponderScrollNativeHandleToKeyboard = reveal
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
    client.umpireSchedule = async () => schedule
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
    expect(initialUmpireGame([], now)).equals(undefined)
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
    f.client.umpireSchedule = async (id, query) => {
      const params = new URLSearchParams(query)
      const view = params.get('view')
      requests.push({ id, view, levels: params.get('levels') })
      if (id === 'visitors' && view === 'league')
        throw new Error('Forbidden league view')
      return { ...f.schedule, isAdmin: id === 'demo' }
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
  it('leaves the umpire mask out of the header: bell and account only', async () => {
    await mount(
      <AppHeader
        nav={<span>Tabs</span>}
        notifications={{ pending: false, onPress: () => undefined }}
        account={{ name: 'Uma', onPress: () => undefined }}
      />
    )
    const labels = [...document.querySelectorAll('[role="button"]')].map(n =>
      n.getAttribute('aria-label')
    )
    expect(labels).deep.equals(['Notifications', 'Account, Uma'])
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
  it('opens notes, conflicts, signup, removal, filters and leaderboard', async () => {
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
    await press('Remove assignment')
    expect(f.saved.length).equals(2)
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
  it('keeps cutoff names black for a regular umpire and blue for an admin', async () => {
    const f = fixture()
    f.schedule.games[0].startAt = '2000-01-01T00:00:00Z'
    f.schedule.games[0].assignments['uty_plate:1'] = {
      userId: 'uma',
      name: 'Uma L',
      assignedBy: 'uma',
      canRemove: true
    }
    f.schedule.isAdmin = false
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(target('Uma L, uty_plate:1').getAttribute('aria-disabled')).equals(
      'true'
    )
    f.schedule.isAdmin = true
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(
      target('Uma L, uty_plate:1').getAttribute('aria-disabled')
    ).not.equals('true')
  })
})
