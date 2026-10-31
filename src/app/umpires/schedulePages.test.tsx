import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import type { UmpireGameRow, UmpireSchedule } from '../../common/umpireSchedule'
import { umpireColumns } from '../../common/umpireSchedule'
import {
  listProps,
  reachEnd,
  reachStart,
  reportAnchor
} from '../../test/PagedListStandIn'
import { pageOfUmpireSchedule } from '../../test/pageOf'
import { fixturePositions, fixtureTypes } from '../../test/umpireTypes'
import type { UmpireScheduleRoute } from '../navigation/routes'
import { ThemeProvider } from '../theme/ThemeContext'
import { UmpireScheduleScreen } from './UmpireScheduleScreen'

const LIMIT = 50
const ROUTE: UmpireScheduleRoute = { name: 'umpireSchedule', id: 'demo' }
const NOTE = { id: 'color', name: 'Jersey Color', position: 0, inUse: false }

function game(index: number): UmpireGameRow {
  const month = String(1 + (index % 12)).padStart(2, '0')
  const day = String(1 + (index % 28)).padStart(2, '0')
  return {
    id: `game-${index}`,
    seasonId: 'spring',
    seasonName: 'Spring',
    levelId: 'majors',
    levelName: 'majors',
    startAt: `${2090 + Math.floor(index / 300)}-${month}-${day}T00:00:00Z`,
    endAt: null,
    timezone: 'UTC',
    date: `Game ${index}`,
    status: 'scheduled',
    home: 'Demo Hawks',
    away: 'Demo Eagles',
    venue: 'Field 1',
    notes: '',
    umpireNotes: {},
    positions: fixturePositions(),
    assignments: {},
    conflicts: [],
    choices: {
      'uty_plate:1': [{ userId: 'uma', name: 'Uma L', reason: null }],
      'uty_field:1': [{ userId: 'uma', name: 'Uma L', reason: null }]
    }
  }
}

interface World {
  client: TeamStationClient
  schedule: UmpireSchedule
  reads: Array<{ query: string; page: unknown }>
  boardReads: () => number
  scheduled: Array<{ userId: string; name: string; count: number }>
}

/** Rows either side of an opening game, which is `opening` from the top. */
function world(opening = 0, total = 120): World {
  const games = Array.from({ length: total }, (_, index) => game(index))
  for (const past of games.slice(0, opening)) {
    past.startAt = '2000-01-01T00:00:00Z'
    past.status = 'final'
  }
  const schedule: UmpireSchedule = {
    settings: { management: true, credits: false },
    types: fixtureTypes,
    noteTypes: [NOTE],
    levels: [{ id: 'majors', name: 'majors', position: 0, inUse: true }],
    viewerId: 'uma',
    isAdmin: true,
    view: 'umpire',
    creditTeams: [],
    games
  }
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const reads: World['reads'] = []
  const scheduled: World['scheduled'] = []
  let boards = 0
  client.umpireSchedulePage = async (_league, query, page) => {
    reads.push({ query: query ?? '', page })
    return pageOfUmpireSchedule(schedule, { limit: LIMIT, ...page })
  }
  client.umpireLeaderboard = async () => {
    boards++
    return {
      completed: [],
      scheduled: scheduled.map(row => ({ ...row, symbol: '🏆' })),
      teams: null
    }
  }
  client.saveUmpireNote = async (_game, _type, _before, value) => ({ value })
  client.assignUmpire = async (id, assignment) => {
    const row = schedule.games.find(g => g.id === id)!
    row.assignments[assignment.slot] = {
      userId: assignment.userId,
      name: 'Uma L',
      assignedBy: 'uma',
      canRemove: true
    }
    scheduled.push({ userId: 'uma', name: 'Uma L', count: 1 })
    // What a sign-up does to the games beside it, wherever they are.
    schedule.games[0].conflicts = [
      {
        userId: 'uma',
        name: 'Uma L',
        activity: 'already umpiring',
        gameId: id,
        time: '4:00 pm',
        closeness: 'ends 10 minutes before this game starts'
      }
    ]
  }
  client.removeUmpire = async (id, slot) => {
    const row = schedule.games.find(g => g.id === id)!
    row.assignments = Object.fromEntries(
      Object.entries(row.assignments).filter(([key]) => key !== slot)
    )
    scheduled.length = 0
    schedule.games[0].conflicts = []
  }
  return {
    client,
    schedule,
    reads,
    scheduled,
    boardReads: () => boards
  }
}

function target(label: string): HTMLElement {
  const n = [
    ...document.querySelectorAll<HTMLElement>('[aria-label], [role="button"]')
  ].find(n => (n.getAttribute('aria-label') ?? n.textContent) === label)
  expect(n, label).not.equals(undefined)
  return n!
}

function rowIds(): string[] {
  return [...document.querySelectorAll('[data-testid^="umpire-game-"]')].map(
    row => row.getAttribute('data-testid')!.replace('umpire-game-', '')
  )
}

/** The props the element for `id` was given. */
function propsOf(id: string): {
  onLayout: (event: unknown) => void
} {
  const node = document.querySelector(`[data-testid="${id}"]`)!
  const key = Object.keys(node).find(k => k.startsWith('__reactFiber'))!
  let fiber = (node as unknown as Record<string, unknown>)[key] as {
    memoizedProps?: { testID?: string; onLayout: (event: unknown) => void }
    return?: unknown
  } | null
  let found: ReturnType<typeof propsOf> | undefined
  while (fiber != null) {
    if (fiber.memoizedProps?.testID === id) found = fiber.memoizedProps
    fiber = fiber.return as typeof fiber
  }
  return found!
}

function measure(id: string, width: number, height: number, y: number): void {
  propsOf(id).onLayout({ nativeEvent: { layout: { width, height, y } } })
}

/** The page's scroller, with what the screen asks of it written down. */
function pageScroller(): { node: HTMLElement; asked: number[] } {
  let node = document.querySelector<HTMLElement>(
    '[data-testid="umpire-table"]'
  )!
  while (getComputedStyle(node).overflowY === 'visible')
    node = node.parentElement!
  const asked: number[] = []
  Object.assign(node, {
    scroll: ({ top }: { top: number }) => {
      asked.push(top)
    }
  })
  return { node, asked }
}

describe('umpire schedule pages', () => {
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
  async function press(label: string): Promise<void> {
    await act(async () => {
      target(label).click()
    })
  }
  async function fill(value: string): Promise<void> {
    await act(async () => {
      const n = document.querySelector('input')!
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )!.set!.call(n, value)
      n.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  async function open(f: World): Promise<void> {
    await mount(
      <UmpireScheduleScreen
        client={f.client}
        route={ROUTE}
        leagues={[]}
        onRoute={() => undefined}
      />
    )
  }
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
  })

  it('is as wide as its columns, which stay put as pages arrive', async () => {
    const f = world()
    // A column that only rows past the first page offer.
    const late = fixturePositions(true, 1, 1)
    f.schedule.games[100].positions = late
    await open(f)
    await act(async () => {
      measure('umpire-signup-measure', 75, 24, 0)
      measure('umpire-conflict-measure', 80, 24, 0)
      measure('umpire-date-measure', 120, 16, 0)
      measure('umpire-table', 1200, 300, 200)
    })
    const columns = umpireColumns(f.schedule.types, f.schedule.games)
    expect(columns.length).greaterThan(2)
    const custom = Math.max(160, 1200 / (6 + columns.length + 1))
    const expected = 5 * 136 + columns.length * 107 + custom + 93
    expect(listProps().width).equals(expected)
    const header = document.querySelector(
      '[data-testid="umpire-table-header-scroll"]'
    )!
    const before = header.textContent
    expect(before).contains('Optional')
    const cells = rowIds()[0]
    expect(
      document.querySelector(`[data-testid="umpire-game-${cells}"]`)!
        .childElementCount
    ).equals(5 + columns.length + 1 + 1)
    await act(async () => {
      reachEnd()
    })
    await act(async () => {
      reachEnd()
    })
    expect(rowIds()).length(120)
    expect(header.textContent).equals(before)
    expect(listProps().width).equals(expected)
    expect(
      document.querySelector('[data-testid="umpire-game-game-100"]')!
        .childElementCount
    ).equals(5 + columns.length + 1 + 1)
  })

  it('measures its date column on a sample, not on the rows it holds', async () => {
    const f = world()
    f.schedule.games[0].date = 'A date far wider than any the rule writes'
    await open(f)
    const samples = document.querySelectorAll(
      '[data-testid="umpire-date-measure"]'
    )
    expect(samples).length(1)
    expect(samples[0].textContent).equals('May 28, 12:00 pm')
  })

  it('opens on the rule’s game and follows it until the reader moves', async () => {
    const f = world(60)
    await open(f)
    expect(f.reads[0].page).deep.equals({ around: 'next' })
    expect(listProps().anchorKey).equals('game-60')
    expect(rowIds()[0]).equals('game-35')
    const { node, asked } = pageScroller()
    await act(async () => {
      measure('umpire-table', 1200, 300, 200)
      measure('umpire-sticky-stack', 1200, 96, 0)
      reportAnchor(400)
    })
    expect(asked).deep.equals([504])
    // Rows above it were measured, and moved it.
    await act(async () => {
      reportAnchor(440)
    })
    expect(asked).deep.equals([504, 544])
    await act(async () => {
      node.dispatchEvent(new window.Event('wheel'))
    })
    await act(async () => {
      reportAnchor(480)
      measure('umpire-sticky-stack', 1200, 120, 0)
    })
    expect(asked).deep.equals([504, 544])
  })

  it('opens at the top when the rule’s game is the first row', async () => {
    const f = world()
    await open(f)
    const { asked } = pageScroller()
    await act(async () => {
      measure('umpire-table', 1200, 300, 200)
      measure('umpire-sticky-stack', 1200, 96, 0)
      reportAnchor(0)
    })
    expect(asked).deep.equals([0])
  })

  it('loads older rows above, past the first older page', async () => {
    const f = world(80)
    await open(f)
    const opening = rowIds()
    expect(opening[0]).equals('game-55')
    await act(async () => {
      reachStart()
    })
    const held = rowIds()
    expect(held[0]).equals('game-5')
    expect(held.slice(-opening.length)).deep.equals(opening)
    await act(async () => {
      reachStart()
    })
    expect(rowIds()[0]).equals('game-0')
    expect(listProps().anchorKey).equals('game-80')
  })

  it('keeps an open editor’s row drawn and its text as pages arrive', async () => {
    const f = world()
    await open(f)
    const label = 'Edit Jersey Color, Demo Hawks vs Demo Eagles, Game 3'
    expect(listProps().alwaysRenderKeys).deep.equals([])
    await press(label)
    expect(listProps().alwaysRenderKeys).deep.equals(['game-3'])
    const before = listProps().extraData
    await fill('Navy')
    // Rows read the editor from here, which a mounted row is drawn again for.
    expect(listProps().extraData).not.equals(before)
    await act(async () => {
      reachEnd()
    })
    expect(document.querySelector('input')!.value).equals('Navy')
    expect(f.reads).length(2)
    await act(async () => {
      document.querySelector('input')!.blur()
      document
        .querySelector('input')!
        .dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
    })
    expect(listProps().alwaysRenderKeys).deep.equals([])
    expect(target(label).textContent).equals('Navy')
    // The row is updated in place, with no read of the list.
    expect(f.reads).length(2)
  })

  it('shows a sign-up and a removal past the first page, everywhere they reach', async () => {
    const f = world()
    function Harness(): React.ReactElement {
      const [route, setRoute] = useState(ROUTE)
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
    await act(async () => {
      reachEnd()
    })
    const held = rowIds()
    expect(held).length(100)
    expect(document.body.textContent).not.contains('Conflict,')
    await press('Sign Up, Plate, Demo Hawks vs Demo Eagles, Game 70')
    await press('Confirm')
    expect(document.body.textContent).not.contains('Confirm')
    target('Uma L, uty_plate:1')
    expect(rowIds()).deep.equals(held)
    expect(
      document.querySelector('[data-testid="umpire-game-game-0"]')!.textContent
    ).contains('Conflict')
    expect(f.boardReads()).equals(2)
    await press('Leaderboard')
    expect(document.body.textContent).contains('Uma L')
    await press('Schedule')
    expect(rowIds()).deep.equals(held)
    await press('Uma L, uty_plate:1')
    await press('Remove assignment')
    expect(document.body.textContent).not.contains('Remove assignment')
    expect(rowIds()).deep.equals(held)
    expect(document.querySelector('[aria-label="Uma L, uty_plate:1"]')).equals(
      null
    )
    expect(
      document.querySelector('[data-testid="umpire-game-game-0"]')!.textContent
    ).not.contains('Conflict')
    expect(f.boardReads()).equals(3)
    await press('Leaderboard')
    expect(document.body.textContent).not.contains('Uma L')
  })

  it('keeps its rows when the held rows cannot be read again', async () => {
    const f = world()
    await open(f)
    await press('Sign Up, Plate, Demo Hawks vs Demo Eagles, Game 2')
    const read = f.client.umpireSchedulePage.bind(f.client)
    f.client.umpireSchedulePage = async () => {
      throw new Error('Schedule offline')
    }
    await press('Confirm')
    expect(document.body.textContent).contains('Schedule offline')
    expect(rowIds()).length(50)
    f.client.umpireSchedulePage = read
    await act(async () => {
      reachEnd()
    })
    expect(rowIds()).length(100)
  })

  it('offers Retry under the table when a later page fails', async () => {
    const f = world()
    await open(f)
    const read = f.client.umpireSchedulePage.bind(f.client)
    f.client.umpireSchedulePage = async () => {
      throw new Error('Schedule offline')
    }
    await act(async () => {
      reachEnd()
    })
    expect(rowIds()).length(50)
    const end = target('Retry')
    expect(
      document
        .querySelector('[data-testid="umpire-table-body-scroll"]')!
        .contains(end)
    ).equals(false)
    f.client.umpireSchedulePage = read
    await press('Retry')
    expect(rowIds()).length(100)
  })

  it('starts the list again when a filter changes or a note is discarded', async () => {
    const f = world(60)
    function Harness(): React.ReactElement {
      const [route, setRoute] = useState(ROUTE)
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
    await act(async () => {
      reachEnd()
      reachStart()
    })
    expect(rowIds().length).greaterThan(50)
    const { node, asked } = pageScroller()
    await act(async () => {
      measure('umpire-table', 1200, 300, 200)
      measure('umpire-sticky-stack', 1200, 96, 0)
      node.dispatchEvent(new window.Event('wheel'))
      reportAnchor(400)
    })
    expect(asked).deep.equals([])
    await press('Schedule filters')
    await press('Monday')
    await press('Apply filters')
    expect(rowIds()[0]).equals('game-35')
    expect(rowIds().at(-1)).equals('game-109')
    expect(new URLSearchParams(f.reads.at(-1)!.query).get('days')).equals('0')
    expect(f.reads.at(-1)!.page).deep.equals({ around: 'next' })
    // A new list is the opening's again.
    await act(async () => {
      reportAnchor(400)
    })
    expect(asked).length(1)

    await press('Edit Jersey Color, Demo Hawks vs Demo Eagles, Game 40')
    await fill('Teal')
    f.client.saveUmpireNote = async () => {
      throw new Error('Note unavailable')
    }
    await press('Schedule filters')
    expect(document.body.textContent).contains('Note unavailable')
    const reads = f.reads.length
    await press('Discard note changes')
    expect(f.reads).length(reads + 1)
    expect(f.reads.at(-1)!.page).deep.equals({ around: 'next' })
    expect(rowIds()).length(75)
  })

  it('drops a late page of a filter that has gone', async () => {
    const f = world()
    function Harness(): React.ReactElement {
      const [route, setRoute] = useState(ROUTE)
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
    const read = f.client.umpireSchedulePage.bind(f.client)
    let late: (() => void) | undefined
    f.client.umpireSchedulePage = async (...args) => {
      const page = await read(...args)
      if (args[2]?.cursor != null)
        await new Promise<void>(resolve => {
          late = resolve
        })
      return page
    }
    await act(async () => {
      reachEnd()
    })
    await press('Schedule filters')
    await press('Monday')
    await press('Apply filters')
    expect(rowIds()).length(50)
    await act(async () => {
      late?.()
    })
    expect(rowIds()).length(50)
  })
})
