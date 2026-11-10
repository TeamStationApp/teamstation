import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GestureResponderEvent, ViewProps } from 'react-native'

import type { LineupPlayer } from '../../../common/api'
import type { GamePlan, PlanCell } from '../../../common/gamePlan'
import { EMPTY_PLAN_SAME_DAY } from '../../../common/planWarnings'
import {
  DEFAULT_PLAYING_TIME_RULES,
  type PlayingTimeRules
} from '../../../common/playingTimeRules'
import { ThemeProvider } from '../../theme/ThemeContext'
import { PLAN_REFUSAL_MS } from './PlanCell'
import { PLAN_COLUMN_WIDTH, planPickerTop } from './planLayout'
import { type PlanContext, PlanTab } from './PlanTab'

const LINEUP: LineupPlayer[] = [
  { gumboId: 101, fullName: 'Babe Ruth', jersey: '3' },
  { gumboId: 102, fullName: 'Lou Gehrig', jersey: '4' },
  { gumboId: 103, fullName: 'Willie Mays', jersey: '24' }
]
const blank = (innings = 6): PlanCell[] =>
  Array.from({ length: innings }, () => '' as const)
const PLAN: GamePlan = {
  enabled: false,
  innings: 6,
  rows: LINEUP.map(player => ({ player, cells: blank() }))
}
const NO_RULES: PlanContext = {
  rules: null,
  sameDay: EMPTY_PLAN_SAME_DAY,
  status: 'scheduled'
}
const ruled = (
  rules: Partial<PlayingTimeRules>,
  context: Partial<PlanContext> = {}
): PlanContext => ({
  ...NO_RULES,
  rules: { ...DEFAULT_PLAYING_TIME_RULES, ...rules },
  ...context
})

let root: Root | undefined
let host: HTMLDivElement | undefined
let latest: GamePlan
let order: number[]
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

/**
 * The tab as the editor holds it: the plan and the batting order in state,
 * a dropped or moved player put where the Lineup tab would put him.
 */
function Harness({
  plan,
  context,
  os
}: {
  plan: GamePlan
  context: PlanContext
  os: string
}): React.ReactElement {
  const [shown, setShown] = useState(plan)
  const [ids, setIds] = useState([1, 2, 3])
  latest = shown
  order = ids
  const move = (id: number, index: number): void => {
    setIds(held => {
      const next = held.filter(each => each !== id)
      next.splice(Math.max(0, Math.min(index, next.length)), 0, id)
      return next
    })
  }
  return (
    <PlanTab
      plan={shown}
      batters={ids.map(id => ({
        id,
        player: LINEUP[id - 1],
        name: LINEUP[id - 1].fullName,
        jersey: LINEUP[id - 1].jersey
      }))}
      context={context}
      onChange={setShown}
      onDrop={(id, index, edge) => {
        const from = ids.indexOf(id)
        const to = index + (edge === 'after' ? 1 : 0)
        move(id, from < to ? to - 1 : to)
      }}
      onReorder={(id, delta) => {
        move(id, ids.indexOf(id) + delta)
      }}
      os={os}
    />
  )
}

async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
}
async function mount({
  plan = PLAN,
  context = NO_RULES,
  os = 'web'
}: {
  plan?: GamePlan
  context?: PlanContext
  os?: string
} = {}): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness plan={plan} context={context} os={os} />
      </ThemeProvider>
    )
  })
  await settle()
}
const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)
const cell = (row: number, inning: number): HTMLElement =>
  byId(`Plan cell ${row}-${inning}`)!
/** What a web cell shows: its value, or the letter being typed into it. */
const shown = (row: number, inning: number): string =>
  String(cell(row, inning).textContent)
const lit = (row: number, inning: number): boolean =>
  cell(row, inning).getAttribute('aria-selected') === 'true'
const grid = (): HTMLElement => byId('Plan grid')!
const cells = (): PlanCell[][] => latest.rows.map(row => row.cells)
const picker = (): HTMLElement | null => byId('Plan field picker')
async function press(element: HTMLElement | null): Promise<void> {
  expect(element).not.equals(null)
  await act(async () => {
    element!.click()
  })
  await settle()
}
/** A key pressed on the grid, which holds the focus for its cells. */
async function key(
  name: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}
): Promise<KeyboardEvent> {
  const event = new window.KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...modifiers
  })
  await act(async () => {
    grid().dispatchEvent(event)
  })
  await settle(1)
  return event
}
/** A clipboard event on the grid, whose clipboard holds `text`. */
async function clipboard(
  type: 'copy' | 'paste',
  text = ''
): Promise<{ event: Event; copied: string[] }> {
  const copied: string[] = []
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (kind: string) => (kind === 'text' ? text : ''),
      setData: (kind: string, value: string) => {
        copied.push(`${kind}:${value}`)
      }
    }
  })
  await act(async () => {
    grid().dispatchEvent(event)
  })
  await settle(1)
  return { event, copied }
}
/** Nothing the sheet draws is a text field, and no text is selected. */
function expectNoTextField(): void {
  expect(document.activeElement).equals(grid())
  expect(document.querySelector('[data-testid="Plan tab"] input')).equals(null)
  expect(String(window.getSelection())).equals('')
  // A collapsed selection in the grid aims Chromium's copy and paste at it.
  expect(window.getSelection()!.anchorNode).equals(grid())
}
interface Fiber {
  memoizedProps: Record<string, unknown>
  return: Fiber | null
}
/** The nearest component props above a node that hold `name`. */
function propsWith(node: Element, name: string): Record<string, unknown> {
  const key = Object.keys(node).find(each => each.startsWith('__reactFiber$'))!
  let fiber = Reflect.get(node, key) as Fiber | null
  while (fiber != null && fiber.memoizedProps[name] == null)
    fiber = fiber.return
  expect(fiber, name).not.equals(null)
  return fiber!.memoizedProps
}
const touch = (x: number, y: number): GestureResponderEvent =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({ nativeEvent: { pageX: x, pageY: y } }) as GestureResponderEvent
/** A box where jsdom, which lays nothing out, is told a node is drawn. */
const box = (x: number, y: number, width: number, height: number): DOMRect =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height
  }) as DOMRect
/** Puts each of the picker's targets at a known place in the window. */
function placeTargets(): void {
  const spots: Record<string, [number, number]> = {
    CF: [200, 100],
    LF: [120, 140],
    bench: [300, 260]
  }
  for (const [value, [x, y]] of Object.entries(spots)) {
    const target = byId(`Plan pick ${value}`)!
    target.getBoundingClientRect = () => box(x, y, 44, 26)
  }
}

describe('the game plan tab', function () {
  it('lists the lineup in batting order, name then jersey, under six inning columns and a plus', async function () {
    await mount()
    const players = [1, 2, 3].map(
      row => byId(`Plan player ${row}`)!.textContent
    )
    expect(players).deep.equals([
      'Babe Ruth #3',
      'Lou Gehrig #4',
      'Willie Mays #24'
    ])
    const headers = [
      ...document.querySelectorAll('[data-testid^="Plan inning "]')
    ]
    expect(headers.map(node => node.textContent)).deep.equals([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6'
    ])
    // Each inning is one column of two characters' width.
    expect(PLAN_COLUMN_WIDTH).equals(28)
    for (const node of [headers[0], cell(1, 1).parentElement!])
      expect(getComputedStyle(node).width).equals(`${PLAN_COLUMN_WIDTH}px`)
    // The innings scroll sideways with no scrollbar track drawn under them.
    expect(
      getComputedStyle(byId('Plan innings')!).getPropertyValue(
        'scrollbar-width'
      )
    ).equals('none')
    await press(byId('Plan add inning'))
    expect(latest.innings).equals(7)
    expect(cells().map(row => row.length)).deep.equals([7, 7, 7])
    expect(byId('Plan inning 7')).not.equals(null)
    expect(cell(3, 7)).not.equals(null)
  })

  it('stops adding innings at twelve', async function () {
    await mount({
      plan: {
        ...PLAN,
        innings: 12,
        rows: PLAN.rows.map(row => ({ ...row, cells: blank(12) }))
      }
    })
    expect(byId('Plan inning 12')).not.equals(null)
    expect(byId('Plan add inning')).equals(null)
  })

  it('highlights a clicked web cell, with no text field focused and nothing selected, opens the picker, and writes what is picked there', async function () {
    await mount({
      plan: {
        ...PLAN,
        rows: PLAN.rows.map((row, at) =>
          at === 0 ? { ...row, cells: ['P', 'C', '', '', '', ''] } : row
        )
      }
    })
    expect(picker()).equals(null)
    // The grid is the one tab stop; no cell is.
    expect(grid().getAttribute('tabindex')).equals('0')
    expect(cell(1, 2).getAttribute('tabindex')).equals('-1')
    await press(cell(1, 2))
    expectNoTextField()
    expect(lit(1, 2)).equals(true)
    expect(lit(1, 1)).equals(false)
    expect(shown(1, 2)).equals('C')
    expect(cell(1, 2).getAttribute('aria-label')).equals(
      'Babe Ruth, inning 2, C'
    )
    expect(picker()!.textContent).includes('Assign: Babe Ruth #3 (Inn 2)')
    // The cell's own value is lit there.
    expect(byId('Plan pick C')!.getAttribute('aria-selected')).equals('true')
    expect(byId('Plan pick CF')!.getAttribute('aria-selected')).equals('false')
    await press(byId('Plan pick CF'))
    expect(cells()[0]).deep.equals(['P', 'CF', '', '', '', ''])
    expect(picker()).equals(null)
    // The keys come back to the grid, the cell still highlighted.
    expectNoTextField()
    expect(lit(1, 2)).equals(true)
    // Picked again, the cell's own value takes it off.
    await press(cell(1, 2))
    await press(byId('Plan pick CF'))
    expect(cells()[0][1]).equals('')
    // Bench blanks the cell, and is lit for a blank one; the close button
    // leaves the cell alone.
    await press(cell(1, 1))
    expect(byId('Plan pick bench')!.getAttribute('aria-selected')).equals(
      'false'
    )
    await press(byId('Plan pick bench'))
    expect(cells()[0][0]).equals('')
    await press(cell(1, 3))
    expect(byId('Plan pick bench')!.getAttribute('aria-selected')).equals(
      'true'
    )
    await press(byId('Plan pick bench'))
    expect(cells()[0][2]).equals('')
    await press(cell(1, 4))
    await press(byId('Plan picker close'))
    expect(picker()).equals(null)
    expect(cells()[0][3]).equals('')
    expectNoTextField()
    // Escape closes it too, and keeps the highlight.
    await press(cell(1, 4))
    expect(picker()).not.equals(null)
    await key('Escape')
    expect(picker()).equals(null)
    expect(lit(1, 4)).equals(true)
    expectNoTextField()
  })

  it('moves the web highlight with the arrow keys, held at the sheet’s edges, closing the picker', async function () {
    await mount()
    // Tabbed to, with nothing highlighted, an arrow starts at the first
    // cell.
    await act(async () => {
      grid().focus()
    })
    await key('Enter')
    await key('Delete')
    expect(
      cells()
        .flat()
        .every(each => each === '')
    ).equals(true)
    await key('ArrowDown')
    expect(lit(1, 1)).equals(true)
    await press(cell(2, 2))
    expect(picker()).not.equals(null)
    const right = await key('ArrowRight')
    // The arrow moves the highlight, not the sheet's scroll.
    expect(right.defaultPrevented).equals(true)
    expect(lit(2, 3)).equals(true)
    expect(lit(2, 2)).equals(false)
    expect(picker()).equals(null)
    for (const [name, times, row, inning] of [
      ['ArrowUp', 3, 1, 3],
      ['ArrowRight', 9, 1, 6],
      ['ArrowDown', 5, 3, 6],
      ['ArrowLeft', 9, 3, 1]
    ] as const) {
      for (let at = 0; at < times; at++) await key(name)
      expect(lit(row, inning), name).equals(true)
    }
    expect(
      document.querySelectorAll(
        '[data-testid^="Plan cell "][aria-selected="true"]'
      )
    ).has.length(1)
    expectNoTextField()
    // Nothing was written on the way.
    expect(
      cells()
        .flat()
        .every(each => each === '')
    ).equals(true)
  })

  it('writes a position from its first key on the web, in either case, staying in the highlight; C waits for an F; other keys do nothing', async function () {
    await mount()
    const table: Array<[string, PlanCell]> = [
      ['1', '1B'],
      ['2', '2B'],
      ['3', '3B'],
      ['s', 'SS'],
      ['L', 'LF'],
      ['r', 'RF'],
      ['D', 'DH'],
      ['e', 'EH'],
      ['p', 'P']
    ]
    for (const [at, [name, value]] of table.entries()) {
      const [row, inning] = [(at % 3) + 1, Math.floor(at / 3) + 1]
      await press(cell(row, inning))
      expect(picker()).not.equals(null)
      const typed = await key(name)
      expect(typed.defaultPrevented).equals(true)
      expect(cells()[row - 1][inning - 1], name).equals(value)
      expect(shown(row, inning)).equals(value)
      // Written at once: no edit is left open, the picker closes, and the
      // cell stays highlighted.
      expect(byId(`Plan cell ${row}-${inning} caret`)).equals(null)
      expect(picker()).equals(null)
      expect(lit(row, inning)).equals(true)
      expectNoTextField()
    }
    // C then F is CF. C alone shows, with a caret, while the plan keeps
    // the cell's old value.
    await press(cell(1, 4))
    await key('c')
    expect(shown(1, 4)).equals('C')
    expect(byId('Plan cell 1-4 caret')).not.equals(null)
    expect(cells()[0][3]).equals('')
    expect(picker()).equals(null)
    await key('f')
    expect(cells()[0][3]).equals('CF')
    expect(byId('Plan cell 1-4 caret')).equals(null)
    // C then Enter, Tab, an arrow or leaving the grid is C.
    await key('C')
    await key('Enter')
    expect(cells()[0][3]).equals('C')
    await key('ArrowDown')
    await key('c')
    // Tab writes it and keeps the focus, and the highlight, on the grid.
    expect((await key('Tab')).defaultPrevented).equals(true)
    expect(cells()[1][3]).equals('C')
    expect(lit(2, 4)).equals(true)
    // With nothing being typed, Tab leaves the grid as usual, and nothing
    // stays lit, wherever the focus lands.
    expect((await key('Tab')).defaultPrevented).equals(false)
    expect(lit(2, 4)).equals(false)
    await press(cell(2, 4))
    await key('Escape')
    await key('ArrowDown')
    await key('c')
    await key('ArrowRight')
    expect(cells()[2][3]).equals('C')
    expect(lit(3, 5)).equals(true)
    await key('c')
    await act(async () => {
      grid().blur()
    })
    await settle()
    expect(cells()[2][4]).equals('C')
    expect(lit(3, 5)).equals(false)
    // Escape drops a C being typed; Backspace there benches.
    await press(cell(1, 1))
    await key('c')
    await key('Escape')
    expect(shown(1, 1)).equals('1B')
    expect(cells()[0][0]).equals('1B')
    await key('c')
    await key('Backspace')
    expect(cells()[0][0]).equals('')
    // X, Q, F and a dash start nothing: nothing changes, and nothing is
    // refused.
    await press(cell(2, 1))
    for (const name of ['x', 'Q', 'f', '-', 'Shift'])
      expect((await key(name)).defaultPrevented, name).equals(name.length === 1)
    expect(cells()[1][0]).equals('2B')
    expect(byId('Plan refusal')!.textContent).equals('')
    // A key held with Command or Control is the browser's.
    const command = await key('s', { metaKey: true })
    expect(command.defaultPrevented).equals(false)
    await key('d', { ctrlKey: true })
    expect(cells()[1][0]).equals('2B')
    // After C, a key that makes nothing with it is refused in red, and the
    // C waits on.
    await key('c')
    await key('x')
    expect(shown(2, 1)).equals('C')
    expect(byId('Plan refusal')!.textContent).includes('CX is not a position')
    expect(getComputedStyle(cell(2, 1)).borderTopColor).equals(
      'rgb(248, 113, 113)'
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, PLAN_REFUSAL_MS + 50))
    })
    expect(getComputedStyle(cell(2, 1)).borderTopColor).not.equals(
      'rgb(248, 113, 113)'
    )
    await key('f')
    expect(cells()[1][0]).equals('CF')
  })

  it('pastes a whole value into the highlighted web cell, refuses anything else, copies its value and benches it on Delete, all without a text field', async function () {
    await mount({
      plan: {
        ...PLAN,
        rows: PLAN.rows.map((row, at) =>
          at === 0 ? { ...row, cells: ['P', '', '', '', '', ''] } : row
        )
      }
    })
    await press(cell(2, 3))
    const pasted = await clipboard('paste', 'ss')
    expect(pasted.event.defaultPrevented).equals(true)
    expect(cells()[1][2]).equals('SS')
    // Written whole, with no edit opened: the cell stays highlighted.
    expect(lit(2, 3)).equals(true)
    expect(byId('Plan cell 2-3 caret')).equals(null)
    expect(picker()).equals(null)
    expectNoTextField()
    // The clipboard's text is trimmed.
    await clipboard('paste', ' lf\n')
    expect(cells()[1][2]).equals('LF')
    // X, a dash and SSS are refused in red, the value kept.
    for (const text of ['X', '-', 'SSS']) {
      const refused = await clipboard('paste', text)
      expect(refused.event.defaultPrevented, text).equals(true)
      expect(cells()[1][2], text).equals('LF')
      expect(byId('Plan refusal')!.textContent).includes(
        `${text} is not a position`
      )
      expect(getComputedStyle(cell(2, 3)).borderTopColor).equals(
        'rgb(248, 113, 113)'
      )
    }
    // Copy takes the highlighted cell's value, blank or not.
    const copied = await clipboard('copy')
    expect(copied.event.defaultPrevented).equals(true)
    expect(copied.copied).deep.equals(['text/plain:LF'])
    await key('ArrowLeft')
    expect((await clipboard('copy')).copied).deep.equals(['text/plain:'])
    await key('ArrowUp')
    await key('ArrowLeft')
    expect((await clipboard('copy')).copied).deep.equals(['text/plain:P'])
    // Pasted two cells away, the value lands there.
    await key('ArrowRight')
    await key('ArrowRight')
    await clipboard('paste', 'P')
    expect(cells()[0]).deep.equals(['P', '', 'P', '', '', ''])
    // A paste over a C being typed drops the C.
    await key('c')
    await clipboard('paste', 'dh')
    expect(cells()[0][2]).equals('DH')
    expect(byId('Plan cell 1-3 caret')).equals(null)
    // Delete and Backspace bench.
    await key('Delete')
    expect(cells()[0][2]).equals('')
    await key('ArrowLeft')
    await key('ArrowLeft')
    await key('Backspace')
    expect(cells()[0][0]).equals('')
    expectNoTextField()
    // With nothing highlighted, the clipboard is the browser's.
    await act(async () => {
      grid().blur()
    })
    await settle()
    expect((await clipboard('copy')).event.defaultPrevented).equals(false)
    expect((await clipboard('paste', 'P')).event.defaultPrevented).equals(false)
    expect(cells()[0][0]).equals('')
  })

  it('closes the web picker and drops the highlight when focus leaves the grid and the picker, and keeps both moving between cells', async function () {
    await mount()
    await press(cell(1, 1))
    await press(cell(2, 2))
    expect(picker()!.textContent).includes('(Inn 2)')
    expect(lit(2, 2)).equals(true)
    // Focus on the picker keeps both.
    await act(async () => {
      byId('Plan pick CF')!.focus()
    })
    await settle()
    expect(picker()).not.equals(null)
    expect(lit(2, 2)).equals(true)
    await act(async () => {
      byId('Plan help')!.focus()
    })
    await settle()
    expect(picker()).equals(null)
    expect(lit(2, 2)).equals(false)
  })

  it('has no hover handler on a web cell', async function () {
    await mount()
    const input = cell(1, 1)
    const key = Object.keys(input).find(each =>
      each.startsWith('__reactProps$')
    )!
    const props = Reflect.get(input, key) as Record<string, unknown>
    for (const name of [
      'onMouseEnter',
      'onMouseOver',
      'onMouseLeave',
      'onPointerEnter',
      'onPointerOver',
      'onPointerLeave'
    ])
      expect(props[name], name).equals(undefined)
  })

  it('opens the picker on a phone’s tap and writes the position a second tap chooses', async function () {
    await mount({ os: 'ios' })
    const tapped = byId('Plan cell 2-4')!
    expect(tapped.tagName).not.equals('INPUT')
    await press(tapped)
    expect(picker()!.textContent).includes('Assign: Lou Gehrig #4 (Inn 4)')
    await press(byId('Plan pick LF'))
    expect(cells()[1][3]).equals('LF')
    expect(picker()).equals(null)
    expect(byId('Plan cell 2-4')!.getAttribute('aria-label')).equals(
      'Lou Gehrig, inning 4, LF'
    )
  })

  it('assigns on a phone by holding a cell and letting go over a position, and changes nothing let go elsewhere', async function () {
    await mount({ os: 'ios' })
    const root = byId('Plan tab')!
    const responder = (): ViewProps => propsWith(root, 'onResponderMove')
    const hold = async (row: number, inning: number): Promise<void> => {
      const props = propsWith(
        byId(`Plan cell ${row}-${inning}`)!,
        'onLongPress'
      )
      await act(async () => {
        ;(props.onLongPress as (event: GestureResponderEvent) => void)(
          touch(20, 400)
        )
      })
      await settle()
      placeTargets()
    }
    await hold(3, 2)
    expect(picker()!.textContent).includes('(Inn 2)')
    // Once held, the root takes the finger's moves.
    expect(responder().onMoveShouldSetResponderCapture!(touch(30, 380))).equals(
      true
    )
    await act(async () => {
      responder().onResponderGrant!(touch(30, 380))
      responder().onResponderMove!(touch(100, 300))
      responder().onResponderMove!(touch(210, 110))
    })
    await settle()
    await act(async () => {
      responder().onResponderMove!(touch(210, 110))
    })
    await settle()
    // The target under the finger is lit.
    expect(byId('Plan pick CF')!.style.borderTopWidth).equals('2px')
    await act(async () => {
      responder().onResponderRelease!(touch(210, 110))
    })
    await settle()
    expect(cells()[2][1]).equals('CF')
    expect(picker()).equals(null)
    // Let go off the picture: unchanged, and the picker closes.
    await hold(3, 2)
    await act(async () => {
      responder().onResponderGrant!(touch(30, 380))
      responder().onResponderMove!(touch(30, 600))
    })
    await act(async () => {
      responder().onResponderRelease!(touch(30, 600))
    })
    await settle()
    expect(cells()[2][1]).equals('CF')
    expect(picker()).equals(null)
    // Let go where it held, with no move: the picker stays for a tap.
    await hold(1, 1)
    const out = propsWith(byId('Plan cell 1-1')!, 'onPressOut')
    await act(async () => {
      ;(out.onPressOut as () => void)()
    })
    await settle()
    expect(responder().onMoveShouldSetResponderCapture!(touch(0, 0))).equals(
      false
    )
    expect(picker()).not.equals(null)
    expect(cells()[0][0]).equals('')
  })

  it('moves a row with every inning’s cell when its player is moved', async function () {
    await mount({
      plan: {
        ...PLAN,
        rows: [
          { player: LINEUP[0], cells: ['P', 'P', '', '', '', ''] },
          { player: LINEUP[1], cells: ['C', 'C', 'C', '', '', ''] },
          { player: LINEUP[2], cells: ['CF', '', 'LF', '', '', ''] }
        ]
      }
    })
    // The keyboard's move: grab Mays, up two, drop.
    const mays = document.querySelector<HTMLElement>(
      '[aria-label="Reorder Willie Mays"]'
    )!
    const key = async (name: string): Promise<void> => {
      await act(async () => {
        mays.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: name, bubbles: true })
        )
      })
    }
    await key('Enter')
    await key('ArrowUp')
    await key('ArrowUp')
    await key('Enter')
    await settle()
    expect(order).deep.equals([3, 1, 2])
    expect(byId('Plan player 1')!.textContent).equals('Willie Mays #24')
    expect([1, 2, 3].map(inning => shown(1, inning))).deep.equals([
      'CF',
      '',
      'LF'
    ])
    expect([1, 2, 3].map(inning => shown(3, inning))).deep.equals([
      'C',
      'C',
      'C'
    ])
    // A drag of a player row onto another's lower half.
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-roster-target^="plan-"]')
    ]
    rows.forEach((row, at) => {
      row.getBoundingClientRect = () => box(24, 100 + at * 44, 136, 43)
    })
    const pointer = async (type: string, y: number): Promise<void> => {
      const event = new window.MouseEvent(type, {
        bubbles: true,
        clientX: 60,
        clientY: y,
        button: 0
      })
      Object.defineProperties(event, {
        pointerType: { value: 'mouse' },
        pointerId: { value: 1 }
      })
      await act(async () => {
        rows[0].dispatchEvent(event)
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    // The sheet's scroll area, which clips where a row can be dropped.
    byId('Plan sheet area')!.getBoundingClientRect = () => box(0, 0, 400, 600)
    rows[0].setPointerCapture = () => undefined
    rows[0].hasPointerCapture = () => false
    await pointer('pointerdown', 120)
    await pointer('pointermove', 160)
    await pointer('pointermove', 225)
    await pointer('pointerup', 225)
    await settle()
    expect(order).deep.equals([1, 2, 3])
    expect(byId('Plan player 3')!.textContent).equals('Willie Mays #24')
    expect([1, 2, 3].map(inning => shown(3, inning))).deep.equals([
      'CF',
      '',
      'LF'
    ])
  })

  it('has no toggle: a plan is on while a cell holds a position', async function () {
    await mount()
    expect(byId('Plan toggle row')).equals(null)
    expect(document.body.textContent).not.includes('Enable per-inning')
    expect(document.querySelector('[role="switch"]')).equals(null)
    await press(cell(1, 2))
    await key('p')
    expect(latest.enabled).equals(true)
    // DH bats without fielding: no position, so still off once P is gone.
    await press(cell(2, 2))
    await key('d')
    await press(cell(1, 2))
    await key('Delete')
    expect(cells()[1][1]).equals('DH')
    expect(latest.enabled).equals(false)
  })

  it('warns in yellow and red, and judges again as a cell changes and as a player moves', async function () {
    await mount({
      context: ruled({
        defensivePlayingTime: true,
        measuredIn: 'outs',
        enforceSittingLimits: true
      }),
      plan: {
        ...PLAN,
        rows: [
          { player: LINEUP[0], cells: ['1B', '', '', '', '', ''] },
          { player: LINEUP[1], cells: ['LF', '', '', '', '', ''] },
          { player: LINEUP[2], cells: ['CF', 'CF', '', '', '', ''] }
        ]
      }
    })
    const listed = (): string[] =>
      [...document.querySelectorAll('[data-testid^="Plan warning "]')].map(
        node => String(node.getAttribute('data-testid'))
      )
    // Ruth's and Gehrig's six outs are still reachable in the innings not
    // planned yet: yellow; nothing red yet.
    expect(listed()).deep.equals(['Plan warning yellow defensivePlayingTime'])
    // Planning the third inning without them is a second sit, which breaks
    // Max Sits at once, before any save.
    await press(cell(3, 3))
    await key('c')
    await key('Enter')
    expect(listed()).deep.include('Plan warning red maxSitsPerGame')
    const red = byId('Plan warning red maxSitsPerGame')!
    expect(red.textContent).includes('Babe Ruth, Lou Gehrig')
    expect(red.getAttribute('aria-label')).match(/^Red warning: /)
    // Under the sheet, which Clear is above.
    const warnings = byId('Plan warnings')!
    expect(
      byId('Plan sheet')!.compareDocumentPosition(warnings) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(
      byId('Plan clear')!.compareDocumentPosition(byId('Plan sheet')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    // Gehrig moved above Ruth: the warning names him first.
    const gehrig = document.querySelector<HTMLElement>(
      '[aria-label="Reorder Lou Gehrig"]'
    )!
    for (const name of ['Enter', 'ArrowUp', 'Enter'])
      await act(async () => {
        gehrig.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: name, bubbles: true })
        )
      })
    await settle()
    expect(byId('Plan warning red maxSitsPerGame')!.textContent).includes(
      'Lou Gehrig, Babe Ruth'
    )
  })

  it('says a team with rules has nothing to warn of, and shows nothing for one with none', async function () {
    await mount({ context: ruled({}) })
    expect(byId('Plan warnings')!.textContent).equals(
      'No playing-time warnings.'
    )
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    host!.remove()
    await mount()
    expect(byId('Plan warnings')).equals(null)
  })

  it('asks before clearing: Cancel keeps the plan, Clear blanks every cell', async function () {
    const filled: GamePlan = {
      enabled: true,
      innings: 7,
      rows: LINEUP.map(player => ({
        player,
        cells: ['P', 'C', '1B', '2B', '3B', 'SS', 'LF']
      }))
    }
    await mount({ plan: filled })
    await press(byId('Plan clear'))
    const sheet = document.querySelector<HTMLElement>(
      '[aria-label="Clear the whole plan?"]'
    )!
    expect(sheet.textContent).includes('Clear the whole plan?')
    // Red Clear first, the blue Cancel beneath it.
    const actions = [
      ...sheet.querySelectorAll<HTMLElement>('[role="button"]')
    ].map(node => String(node.textContent))
    expect(actions).deep.equals(['Clear', 'Cancel'])
    await press(
      [...sheet.querySelectorAll<HTMLElement>('[role="button"]')].find(
        node => node.textContent === 'Cancel'
      )!
    )
    expect(
      document.querySelector('[aria-label="Clear the whole plan?"]')
    ).equals(null)
    expect(latest).deep.equals({ ...filled, rows: latest.rows })
    expect(cells()[0]).deep.equals(['P', 'C', '1B', '2B', '3B', 'SS', 'LF'])
    await press(byId('Plan clear'))
    await press(byId('Plan clear confirm'))
    await settle()
    expect(cells()).deep.equals([blank(7), blank(7), blank(7)])
    // Empty, the plan is off; the innings stay.
    expect(latest.enabled).equals(false)
    expect(latest.innings).equals(7)
  })

  it('puts a blue Help left of a red Clear above the sheet, with no Clear below it, and Help slides up the tab’s help', async function () {
    await mount()
    const row = byId('Plan help row')!
    const help = byId('Plan help')!
    const clear = byId('Plan clear')!
    expect(row.contains(help) && row.contains(clear)).equals(true)
    expect(help.getAttribute('aria-label')).equals('Plan help')
    expect(help.textContent).equals('Help')
    expect(clear.textContent).equals('Clear')
    expect(
      help.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(
      row.compareDocumentPosition(byId('Plan sheet')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    // One Clear: none under the sheet.
    expect(document.querySelectorAll('[data-testid="Plan clear"]')).has.length(
      1
    )
    const color = (node: HTMLElement): string =>
      getComputedStyle(node.querySelector('[dir="auto"]') ?? node).color
    expect(color(help)).not.equals(color(clear))
    const sheetText = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="Help sheet text"]')
    expect(sheetText()).equals(null)
    await press(help)
    expect(sheetText()!.textContent).equals(
      'Tap and hold a player to drag them to a new batting order. Tap or hold an inning slot to set a player’s position.'
    )
    await press(
      document.querySelector<HTMLElement>('[aria-label="Dismiss sheet"]')
    )
    expect(sheetText()).equals(null)
  })

  it('draws an added inning’s number in red, and deletes that inning only once confirmed', async function () {
    const filled: GamePlan = {
      enabled: true,
      innings: 8,
      rows: LINEUP.map(player => ({
        player,
        cells: ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'RF']
      }))
    }
    await mount({ plan: filled })
    const red = getComputedStyle(
      byId('Plan clear')!.querySelector('[dir="auto"]')!
    ).color
    const number = (inning: number): HTMLElement =>
      byId(`Plan inning ${inning}`)!
    for (const inning of [1, 6]) {
      expect(number(inning).getAttribute('role'), `${inning}`).not.equals(
        'button'
      )
      expect(
        getComputedStyle(number(inning).firstElementChild!).color
      ).not.equals(red)
    }
    for (const inning of [7, 8]) {
      expect(number(inning).getAttribute('role')).equals('button')
      expect(number(inning).getAttribute('aria-label')).equals(
        `Delete inning ${inning}`
      )
      expect(getComputedStyle(number(inning).firstElementChild!).color).equals(
        red
      )
    }
    // Inning 1's number does nothing.
    await press(number(1))
    expect(document.querySelector('[aria-label="Delete inning 1?"]')).equals(
      null
    )
    await press(number(7))
    const sheet = document.querySelector<HTMLElement>(
      '[aria-label="Delete inning 7?"]'
    )!
    expect(sheet.textContent).includes('Delete inning 7?')
    // Red Delete first, the blue Cancel beneath it.
    const actions = (): HTMLElement[] => [
      ...document
        .querySelector('[aria-label="Delete inning 7?"]')!
        .querySelectorAll<HTMLElement>('[role="button"]')
    ]
    expect(actions().map(node => String(node.textContent))).deep.equals([
      'Delete',
      'Cancel'
    ])
    await press(actions().find(node => node.textContent === 'Cancel')!)
    expect(document.querySelector('[aria-label="Delete inning 7?"]')).equals(
      null
    )
    expect(latest.innings).equals(8)
    await press(number(7))
    await press(byId('Plan delete inning confirm'))
    await settle()
    // Inning 8 moves up to be inning 7.
    expect(latest.innings).equals(7)
    expect(cells()[0]).deep.equals(['P', 'C', '1B', '2B', '3B', 'SS', 'RF'])
    expect(byId('Plan inning 8')).equals(null)
    expect(latest.enabled).equals(true)
  })

  it('closes the picker, changing nothing, on a tap outside it on a phone and a click outside it on the web', async function () {
    await mount({ os: 'ios' })
    await press(byId('Plan cell 2-3'))
    expect(picker()).not.equals(null)
    await press(byId('Plan picker backdrop'))
    expect(picker()).equals(null)
    expect(cells()[1][2]).equals('')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    host!.remove()
    await mount()
    expect(byId('Plan picker backdrop')).equals(null)
    await press(cell(2, 3))
    expect(picker()).not.equals(null)
    // A press on another cell, or on the picker, keeps it.
    for (const inside of [cell(1, 1), picker()!]) {
      await act(async () => {
        inside.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
      })
      await settle()
      expect(picker()).not.equals(null)
    }
    await act(async () => {
      byId('Plan help row')!.dispatchEvent(
        new window.Event('pointerdown', { bubbles: true })
      )
    })
    await settle()
    expect(picker()).equals(null)
    expect(cells()[1][2]).equals('')
    // The click that follows a closing press, on a tab outside the sheet,
    // closes the picker only: the tab never sees it. A later click does.
    const tab = document.createElement('button')
    document.body.appendChild(tab)
    let clicked = 0
    tab.addEventListener('click', () => {
      clicked++
    })
    const clickTab = async (): Promise<MouseEvent> => {
      const click = new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true
      })
      await act(async () => {
        tab.dispatchEvent(click)
      })
      return click
    }
    const pressTab = async (button: number): Promise<void> => {
      await act(async () => {
        tab.dispatchEvent(
          new window.MouseEvent('pointerdown', { bubbles: true, button })
        )
      })
      await settle()
    }
    try {
      // A right press outside closes the picker too, but no click follows
      // it, so the next real click is not stopped.
      await press(cell(2, 3))
      await pressTab(2)
      expect(picker()).equals(null)
      expect((await clickTab()).defaultPrevented).equals(false)
      expect(clicked).equals(1)
      clicked = 0
      await press(cell(2, 3))
      expect(picker()).not.equals(null)
      await pressTab(0)
      expect(picker()).equals(null)
      expect((await clickTab()).defaultPrevented).equals(true)
      expect(clicked).equals(0)
      expect((await clickTab()).defaultPrevented).equals(false)
      expect(clicked).equals(1)
      // Nor is a click stopped that comes long after its press, or lands
      // elsewhere.
      for (const late of [true, false]) {
        await press(cell(2, 3))
        await pressTab(0)
        if (late) {
          const now = Date.now
          Date.now = () => now() + 1001
          try {
            await clickTab()
          } finally {
            Date.now = now
          }
        } else
          await act(async () => {
            document.body.click()
          })
      }
      expect(clicked).equals(2)
    } finally {
      tab.remove()
    }
  })

  it('assigns on a phone by holding a picker position, whose enlarged box shows and follows the finger, and writes where it lets go', async function () {
    await mount({ os: 'ios' })
    const root = byId('Plan tab')!
    const responder = (): ViewProps => propsWith(root, 'onResponderMove')
    const enlarged = (): HTMLElement | null => byId('Plan pick enlarged')
    const hold = async (target: string): Promise<void> => {
      const props = propsWith(byId(`Plan pick ${target}`)!, 'onLongPress')
      await act(async () => {
        ;(props.onLongPress as (event: GestureResponderEvent) => void)(
          touch(210, 110)
        )
      })
      await settle()
    }
    const letGo = async (target: string): Promise<void> => {
      const props = propsWith(byId(`Plan pick ${target}`)!, 'onPressOut')
      await act(async () => {
        ;(props.onPressOut as () => void)()
      })
      await settle()
    }
    // A plain tap shows no enlarged box.
    await press(byId('Plan cell 1-2'))
    placeTargets()
    expect(enlarged()).equals(null)
    // Held where it is and let go: written.
    await hold('CF')
    expect(enlarged()!.textContent).equals('CF')
    expect(getComputedStyle(enlarged()!).pointerEvents).equals('none')
    await letGo('CF')
    expect(cells()[0][1]).equals('CF')
    expect(picker()).equals(null)
    expect(enlarged()).equals(null)
    // Held on CF, then carried by the root down to LF: the box follows.
    await press(byId('Plan cell 2-2'))
    placeTargets()
    await hold('CF')
    await act(async () => {
      responder().onResponderGrant!(touch(212, 112))
    })
    await letGo('CF')
    // The first move measures the targets, the second finds LF under it.
    for (let move = 0; move < 2; move++) {
      await act(async () => {
        responder().onResponderMove!(touch(140, 150))
      })
      await settle()
    }
    expect(enlarged()!.textContent).equals('LF')
    await act(async () => {
      responder().onResponderRelease!(touch(140, 150))
    })
    await settle()
    expect(cells()[1][1]).equals('LF')
    expect(picker()).equals(null)
    expect(enlarged()).equals(null)
    // The cell's own position, held and let go, takes it off, as a tap on
    // it does.
    await press(byId('Plan cell 1-2'))
    placeTargets()
    await hold('CF')
    await letGo('CF')
    expect(cells()[0][1]).equals('')
    expect(picker()).equals(null)
  })

  it('gives the web’s keys back to the grid after a picker position is held and let go', async function () {
    await mount()
    await press(cell(1, 2))
    placeTargets()
    const target = byId('Plan pick CF')!
    await act(async () => {
      ;(
        propsWith(target, 'onLongPress').onLongPress as (
          event: GestureResponderEvent
        ) => void
      )(touch(210, 110))
    })
    await settle()
    await act(async () => {
      target.focus()
      ;(propsWith(target, 'onPressOut').onPressOut as () => void)()
    })
    await settle()
    expect(cells()[0][1]).equals('CF')
    expect(picker()).equals(null)
    expect(document.activeElement).equals(grid())
    // The next key reaches the highlighted cell.
    await key('s')
    expect(cells()[0][1]).equals('SS')
  })

  it('judges a final game that stopped short on the innings it played', async function () {
    const plan: GamePlan = {
      ...PLAN,
      rows: [
        { player: LINEUP[0], cells: ['', '', '', '', 'P', 'P'] },
        { player: LINEUP[1], cells: ['C', 'C', 'C', 'C', 'C', 'C'] },
        { player: LINEUP[2], cells: ['CF', 'CF', 'CF', 'CF', 'CF', 'CF'] }
      ]
    }
    const red = (): string[] =>
      [...document.querySelectorAll('[data-testid^="Plan warning red"]')].map(
        node => String(node.textContent)
      )
    await mount({
      plan,
      context: ruled(
        { defensivePlayingTime: true, measuredIn: 'outs' },
        { status: 'inProgress', playedInnings: 4 }
      )
    })
    expect(red()).deep.equals([])
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    host!.remove()
    await mount({
      plan,
      context: ruled(
        { defensivePlayingTime: true, measuredIn: 'outs' },
        { status: 'final', playedInnings: 4 }
      )
    })
    expect(red()).deep.equals(['Cannot reach 6 defensive outs: Babe Ruth'])
  })
})

describe('the game plan picker’s place', function () {
  it('goes under the row it edits, else over it, else against the roomier edge', function () {
    const area = { areaTop: 40, areaBottom: 600, height: 262 }
    expect(planPickerTop({ ...area, rowTop: 80, rowBottom: 124 })).equals(128)
    expect(planPickerTop({ ...area, rowTop: 400, rowBottom: 444 })).equals(134)
    // Neither fits: the side with more room, kept inside the area.
    expect(
      planPickerTop({ ...area, areaBottom: 400, rowTop: 180, rowBottom: 224 })
    ).equals(138)
    expect(
      planPickerTop({ ...area, areaBottom: 400, rowTop: 220, rowBottom: 264 })
    ).equals(40)
  })
})
