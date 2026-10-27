import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Platform } from 'react-native'

import type { SetupSeason } from '../../common/seasonScheduling'
import { mount, settle, unmount } from '../../test/gameFormDom'
import { tapLabel } from '../../test/venueDom'
import { SeasonScheduleGrid } from '../screens/SeasonScheduleGrid'
import { HOLD_MS, offsetShowing } from './WideTable'

const SEASON: SetupSeason = {
  id: 'sea_a',
  name: 'Demo Regular',
  year: 2027,
  timezone: 'UTC',
  participants: 7,
  exhibitionTeams: 2,
  teams: [],
  saved: false,
  settings: {
    fieldSize: '50/70',
    gameMinutes: 90,
    bufferMinutes: 10,
    regularGames: 4,
    exhibitionGames: 1,
    doubleheaders: 'allowed',
    startsOn: '2027-03-01',
    endsOn: '2027-05-31',
    blackouts: [],
    windows: []
  }
}

type Laid = HTMLElement & {
  __reactLayoutHandler?: (event: {
    nativeEvent: {
      layout: { x: number; y: number; width: number; height: number }
    }
  }) => void
}

/** Reports a layout to the element's onLayout, as the browser would. */
async function lay(node: Laid, x: number, width: number): Promise<void> {
  await act(async () => {
    node.__reactLayoutHandler!({
      nativeEvent: { layout: { x, y: 0, width, height: 48 } }
    })
  })
}

/** The grid's sideways scroller. */
function table(): Laid {
  return [
    ...document.querySelectorAll<Laid>(
      '[data-testid="season-schedule-grid"] div'
    )
  ].find(node => 'scrollResponderScrollNativeHandleToKeyboard' in node)!
}

function cell(column: string): Laid {
  return document.querySelector<Laid>(
    `[data-testid="grid-cell-sea_a-${column}"]`
  )!
}

/** Scrolls the table to `x`, as a finger or the native view would. */
async function scrollTable(x: number): Promise<void> {
  await act(async () => {
    table().scrollLeft = x
    table().dispatchEvent(new window.Event('scroll'))
  })
  // Past the web scroll view's scroll-end tick, which reports it again.
  await settle(130)
}

/** The TextInput-free props the table's ScrollView holds, from React. */
function scrollProps(): Record<string, unknown> {
  const node = table()
  const key = Object.keys(node).find(k => k.startsWith('__reactFiber'))!
  let fiber = (node as unknown as Record<string, unknown>)[key] as {
    memoizedProps?: Record<string, unknown>
    return?: unknown
  } | null
  while (fiber != null) {
    if (fiber.memoizedProps?.onScrollBeginDrag != null)
      return fiber.memoizedProps
    fiber = fiber.return as typeof fiber
  }
  throw new Error('No ScrollView props')
}

async function grid(): Promise<void> {
  await mount(
    <SeasonScheduleGrid
      seasons={[SEASON]}
      onEdit={() => undefined}
      onSaveNumber={async () => null}
      onOpenSeason={() => undefined}
    />
  )
  // The test DOM's element.scroll moves nothing; scroll as a browser does.
  const node = table()
  Object.defineProperty(node, 'scroll', {
    configurable: true,
    value: (options: ScrollToOptions) => {
      node.scrollLeft = options.left ?? 0
    }
  })
  // A phone's 380-point grid, scrolled to show Game MINS and # Regular.
  await lay(table(), 0, 380)
  await lay(cell('gameMinutes'), 300, 88)
  await lay(cell('regularGames'), 488, 88)
}

describe('a wide table holding its offset while a cell opens', () => {
  const was = Platform.OS
  afterEach(async () => {
    Platform.OS = was
    await unmount()
  })

  it('moves as little as it can to show a whole cell', () => {
    expect(offsetShowing(240, 380, undefined)).equals(240)
    expect(offsetShowing(240, 0, { x: 300, width: 88 })).equals(240)
    // In view: stays.
    expect(offsetShowing(240, 380, { x: 300, width: 88 })).equals(240)
    // Cut off on the left: its left edge comes to the table's.
    expect(offsetShowing(240, 380, { x: 200, width: 88 })).equals(200)
    // Cut off on the right: its right edge comes to the table's.
    expect(offsetShowing(240, 380, { x: 580, width: 88 })).equals(288)
    // Wider than the table: its left edge shows.
    expect(offsetShowing(0, 80, { x: 300, width: 88 })).equals(300)
  })

  it('puts the grid back where it was when the native view snaps it on opening a cell', async () => {
    Platform.OS = 'android'
    await grid()
    await scrollTable(240)
    await tapLabel('Demo Regular Game length in minutes: 90')
    expect(table().scrollLeft).equals(240)
    // Android's scroll view jumps to an earlier fling's offset as the
    // opened cell lays out: the table goes straight back.
    await scrollTable(0)
    expect(table().scrollLeft).equals(240)
    expect(
      document.querySelector(
        '[data-testid="grid-cell-input-sea_a-gameMinutes"]'
      )
    ).not.equals(null)
  })

  it('scrolls just far enough to show a cell opened at the table’s edge', async () => {
    Platform.OS = 'android'
    await grid()
    // # Regular’s right edge, 576, is past the table’s at 150 + 380.
    await scrollTable(150)
    await tapLabel('Demo Regular Regular-season games: 4')
    expect(table().scrollLeft).equals(196)
    await scrollTable(0)
    expect(table().scrollLeft).equals(196)
  })

  it('lets a finger’s drag, or the moment after, move the table', async () => {
    Platform.OS = 'android'
    await grid()
    await scrollTable(240)
    await tapLabel('Demo Regular Game length in minutes: 90')
    await act(async () => {
      ;(scrollProps().onScrollBeginDrag as () => void)()
    })
    await scrollTable(60)
    expect(table().scrollLeft).equals(60)
    // Once the hold has run out, a scroll stands too.
    await tapLabel('Demo Regular Regular-season games: 4')
    const now = Date.now
    try {
      Date.now = () => now() + HOLD_MS + 1
      await scrollTable(20)
    } finally {
      Date.now = now
    }
    expect(table().scrollLeft).equals(20)
  })

  it('leaves a browser’s offset to the browser', async () => {
    await grid()
    await scrollTable(240)
    await tapLabel('Demo Regular Game length in minutes: 90')
    await scrollTable(0)
    expect(table().scrollLeft).equals(0)
  })
})
