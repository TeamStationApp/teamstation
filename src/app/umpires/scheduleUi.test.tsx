import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { UmpireSchedule } from '../../common/umpireSchedule'
import { AppHeader } from '../components/AppHeader'
import type { UmpireScheduleRoute } from '../navigation/routes'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameUmpires } from './GameUmpires'
import { UmpireMask } from './UmpireMask'
import { initialUmpireGame, UmpireScheduleScreen } from './UmpireScheduleScreen'
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
  function fixture(): {
    client: TeamStationClient
    schedule: UmpireSchedule
    saved: unknown[]
  } {
    const client = new TeamStationClient({ baseUrl: '/api/v1' })
    const saved: unknown[] = []
    const schedule: UmpireSchedule = {
      settings: { management: true, credits: true },
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
          plate: true,
          fieldCount: 1,
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
            plate: [
              { userId: 'uma', name: 'Uma L', reason: null },
              {
                userId: 'billy',
                name: 'Billy L',
                reason: 'already playing then'
              }
            ],
            'field:1': [
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
    await press('Filters')
    expect(document.body.textContent).contains('Monday')
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
      view: 'umpire',
      levels: null
    })
    expect(document.body.textContent)
      .contains('Demo Hawks')
      .and.not.contains('Schedule unavailable')
  })
  it('places the mask before bell and account and opens on activation', async () => {
    let opened = false
    await mount(
      <AppHeader
        nav={<span>Tabs</span>}
        umpire={
          <UmpireMask
            onPress={() => {
              opened = true
            }}
          />
        }
        notifications={{ pending: false, onPress: () => undefined }}
        account={{ name: 'Uma', onPress: () => undefined }}
      />
    )
    const labels = [...document.querySelectorAll('[role="button"]')].map(n =>
      n.getAttribute('aria-label')
    )
    expect(labels).deep.equals([
      'Umpire schedule',
      'Notifications',
      'Account, Uma'
    ])
    await press('Umpire schedule')
    expect(opened).equals(true)
  })
  it('shows unassigned game positions and assigned abbreviated names', async () => {
    await mount(<GameUmpires umpires={null} />)
    expect(document.body.textContent).equals('')
    await mount(
      <GameUmpires
        umpires={{
          plateNeeded: true,
          plate: { userId: 'uma', name: 'Uma L' },
          fieldCount: 1,
          field: [null]
        }}
      />
    )
    expect(document.body.textContent)
      .contains('Plate umpire: Uma L')
      .and.contains('Field ump 1')
    await mount(
      <GameUmpires
        umpires={{
          plateNeeded: true,
          plate: null,
          fieldCount: 1,
          field: [{ userId: 'bobby', name: 'Bobby L' }]
        }}
      />
    )
    expect(document.body.textContent)
      .contains('Plate umpire')
      .and.contains('Bobby L')
  })
  it('preselects an eligible person and requires the team choice', async () => {
    const f = fixture()
    let saved = false
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="field:1"
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
      ['game', { slot: 'field:1', userId: 'bobby', creditTeamId: 'hawks' }]
    ])
  })
  it('keeps confirmation unavailable for all-gray and empty choices', async () => {
    const f = fixture()
    f.schedule.games[0].choices.plate = [
      { userId: 'uma', name: 'Uma L', reason: 'not certified for plate ump' }
    ]
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="plate"
        schedule={f.schedule}
        onClose={() => undefined}
        onSaved={() => undefined}
      />
    )
    expect(target('Confirm').getAttribute('aria-disabled')).equals('true')
    f.schedule.games[0].choices.plate = []
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="plate"
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
    await press('Conflict')
    expect(document.body.textContent).contains('ends 10 minutes')
    await press('Cancel')
    await press('Plate umpire')
    await press('Demo Hawks')
    await press('Confirm')
    await press('Uma L, plate')
    await press('Remove assignment')
    expect(f.saved.length).equals(2)
    await press('Filters')
    await press('Monday')
    await press('majors')
    await press('Apply filters')
    await press('Leaderboard')
    expect(document.body.textContent)
      .contains('COMPLETED GAMES')
      .and.contains('TEAM CREDITS')
    await press('Schedule')
    await press('League view')
    await press('Demo Visitors')
  })
  it('shows signup details and reserves radios for eligible people', async () => {
    const f = fixture()
    await mount(
      <UmpireSignup
        client={f.client}
        game={f.schedule.games[0]}
        slot="plate"
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
      plate: false,
      fieldCount: 0
    })
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo', view: 'league' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(target('Plate umpire').getAttribute('aria-disabled')).equals('true')
    await press('Plate umpire')
    expect(document.querySelector('[role="radio"]')).equals(null)
    expect(
      document
        .querySelector('[data-testid="umpire-game-final"]')
        ?.querySelector('[aria-label="Plate umpire"]')
    ).equals(null)
    expect(document.body.textContent)
      .contains('Home team')
      .and.contains('Away team')
  })
  it('keeps cutoff names black for a regular umpire and blue for an admin', async () => {
    const f = fixture()
    f.schedule.games[0].startAt = '2000-01-01T00:00:00Z'
    f.schedule.games[0].assignments.plate = {
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
    expect(target('Uma L, plate').getAttribute('aria-disabled')).equals('true')
    f.schedule.isAdmin = true
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={{ name: 'umpireSchedule', id: 'demo' }}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
    expect(target('Uma L, plate').getAttribute('aria-disabled')).not.equals(
      'true'
    )
  })
})
