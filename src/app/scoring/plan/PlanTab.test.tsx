import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GestureResponderEvent, ViewProps } from 'react-native'

import type { LineupPlayer } from '../../../common/api'
import type { GamePlan, PlanCell } from '../../../common/gamePlan'
import {
  EMPTY_PLAN_HISTORY,
  EMPTY_PLAN_SAME_DAY
} from '../../../common/planWarnings'
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
  history: EMPTY_PLAN_HISTORY,
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
        label: `#${LINEUP[id - 1].jersey} ${LINEUP[id - 1].fullName}`
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
const cell = (row: number, inning: number): HTMLInputElement =>
  byId<HTMLInputElement>(`Plan cell ${row}-${inning}`)!
const cells = (): PlanCell[][] => latest.rows.map(row => row.cells)
const picker = (): HTMLElement | null => byId('Plan field picker')
async function press(element: HTMLElement | null): Promise<void> {
  expect(element).not.equals(null)
  await act(async () => {
    element!.click()
  })
  await settle()
}
/** A key typed into a web cell: the field's text as it now reads. */
async function typeText(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, text)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle(1)
}
async function paste(input: HTMLInputElement, text: string): Promise<Event> {
  const event = new window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') }
  })
  await act(async () => {
    input.dispatchEvent(event)
  })
  await settle(1)
  return event
}
/** A click into a cell, which a browser focuses afresh. */
async function focus(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    if (document.activeElement === input) input.blur()
    input.focus()
  })
  await settle()
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
  it('lists the lineup in batting order, jersey first, under six inning columns and a plus', async function () {
    await mount()
    const players = [1, 2, 3].map(
      row => byId(`Plan player ${row}`)!.textContent
    )
    expect(players).deep.equals([
      '#3 Babe Ruth',
      '#4 Lou Gehrig',
      '#24 Willie Mays'
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

  it('takes every value a key at a time on the web, in either case', async function () {
    await mount()
    const entries: Array<[string[], PlanCell]> = [
      [['s', 'Ss'], 'SS'],
      [['1', '1b'], '1B'],
      [['2', '2B'], '2B'],
      [['3', '3b'], '3B'],
      [['l', 'Lf'], 'LF'],
      [['r', 'RF'], 'RF'],
      [['d', 'Dh'], 'DH'],
      [['e', 'eh'], 'EH'],
      [['p'], 'P']
    ]
    for (const [at, [keys, value]] of entries.entries()) {
      const input = cell((at % 3) + 1, Math.floor(at / 3) + 1)
      await focus(input)
      for (const [step, text] of keys.entries()) {
        await typeText(input, text)
        // A first letter waits, shown, while the plan keeps the cell blank.
        if (step < keys.length - 1) {
          expect(input.value).equals(text.toUpperCase())
          expect(cells()[at % 3][Math.floor(at / 3)]).equals('')
        }
      }
      expect(cells()[at % 3][Math.floor(at / 3)], keys.join('')).equals(value)
      expect(input.value).equals(value)
    }
    // C is written at once, and F after it makes CF.
    const catcher = cell(1, 5)
    await focus(catcher)
    await typeText(catcher, 'c')
    expect(cells()[0][4]).equals('C')
    await typeText(catcher, 'Cf')
    expect(cells()[0][4]).equals('CF')
    // A deleted value blanks the cell.
    await typeText(catcher, '')
    expect(cells()[0][4]).equals('')
  })

  it('refuses X, Q, a first letter never finished and a pasted SSS, keeping the old value', async function () {
    await mount()
    const input = cell(2, 3)
    await focus(input)
    await typeText(input, 'c')
    await typeText(input, 'Cf')
    expect(cells()[1][2]).equals('CF')
    // The bench is blank, so a dash is no value either.
    for (const text of ['X', 'q', '-']) {
      await typeText(input, text)
      expect(cells()[1][2], text).equals('CF')
      expect(input.value, text).equals('CF')
      expect(byId('Plan refusal')!.textContent).includes(
        `${text} is not a position`
      )
    }
    // Refused in red for a moment.
    expect(getComputedStyle(input).borderTopColor).not.equals('transparent')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, PLAN_REFUSAL_MS + 50))
    })
    expect(getComputedStyle(input).borderTopColor).not.equals(
      'rgb(248, 113, 113)'
    )
    // A dangling S is refused as the cell is left.
    await typeText(input, 's')
    expect(input.value).equals('S')
    await act(async () => {
      input.blur()
    })
    await settle()
    expect(cells()[1][2]).equals('CF')
    expect(input.value).equals('CF')
    expect(byId('Plan refusal')!.textContent).includes('S is not a position')
    // A paste is read whole: SSS is no value, and is not cut to SS.
    await focus(input)
    const pasted = await paste(input, 'SSS')
    expect(pasted.defaultPrevented).equals(true)
    expect(cells()[1][2]).equals('CF')
    expect(input.value).equals('CF')
    expect(byId('Plan refusal')!.textContent).includes('SSS is not a position')
    // A whole value pasted is written.
    await paste(input, 'lf')
    expect(cells()[1][2]).equals('LF')
  })

  it('selects a web cell’s text as it is clicked, opens the picker, and writes what is picked there', async function () {
    await mount({
      plan: {
        ...PLAN,
        rows: PLAN.rows.map((row, at) =>
          at === 0 ? { ...row, cells: ['P', 'C', '', '', '', ''] } : row
        )
      }
    })
    expect(picker()).equals(null)
    const input = cell(1, 2)
    await focus(input)
    expect(input.selectionStart).equals(0)
    expect(input.selectionEnd).equals(1)
    expect(picker()).not.equals(null)
    expect(picker()!.textContent).includes('Assign: #3 Babe Ruth (Inn 2)')
    // The cell's own value is lit there.
    expect(byId('Plan pick C')!.getAttribute('aria-selected')).equals('true')
    expect(byId('Plan pick CF')!.getAttribute('aria-selected')).equals('false')
    await press(byId('Plan pick CF'))
    expect(cells()[0]).deep.equals(['P', 'CF', '', '', '', ''])
    expect(picker()).equals(null)
    // Picked again, the cell's own value takes it off.
    await focus(cell(1, 2))
    await press(byId('Plan pick CF'))
    expect(cells()[0][1]).equals('')
    // Bench blanks the cell, and is lit for a blank one; the close button
    // leaves the cell alone.
    await focus(cell(1, 1))
    expect(byId('Plan pick bench')!.getAttribute('aria-selected')).equals(
      'false'
    )
    await press(byId('Plan pick bench'))
    expect(cells()[0][0]).equals('')
    await focus(cell(1, 3))
    expect(byId('Plan pick bench')!.getAttribute('aria-selected')).equals(
      'true'
    )
    await press(byId('Plan pick bench'))
    expect(cells()[0][2]).equals('')
    await focus(cell(1, 4))
    await press(byId('Plan picker close'))
    expect(picker()).equals(null)
    expect(cells()[0][3]).equals('')
    // Escape closes it too.
    await focus(cell(1, 4))
    await act(async () => {
      cell(1, 4).dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    await settle()
    expect(picker()).equals(null)
  })

  it('closes the web picker when focus leaves the sheet and it, and keeps it when moving between cells', async function () {
    await mount()
    await focus(cell(1, 1))
    await focus(cell(2, 2))
    expect(picker()!.textContent).includes('(Inn 2)')
    await act(async () => {
      cell(2, 2).blur()
    })
    await settle()
    expect(picker()).equals(null)
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
    expect(picker()!.textContent).includes('Assign: #4 Lou Gehrig (Inn 4)')
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
    expect(byId('Plan player 1')!.textContent).equals('#24 Willie Mays')
    expect([1, 2, 3].map(inning => cell(1, inning).value)).deep.equals([
      'CF',
      '',
      'LF'
    ])
    expect([1, 2, 3].map(inning => cell(3, inning).value)).deep.equals([
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
    expect(byId('Plan player 3')!.textContent).equals('#24 Willie Mays')
    expect([1, 2, 3].map(inning => cell(3, inning).value)).deep.equals([
      'CF',
      '',
      'LF'
    ])
  })

  it('flips the per-inning toggle', async function () {
    await mount()
    const toggle = document.querySelector<HTMLElement>(
      '[aria-label="Enable per-inning game plan"]'
    )!
    expect(latest.enabled).equals(false)
    await press(toggle)
    expect(latest.enabled).equals(true)
  })

  it('warns in yellow and red, and judges again as a cell changes and as a player moves', async function () {
    await mount({
      context: ruled(
        {
          mandatoryPlay: true,
          enforceSittingLimits: true,
          rotateLeadoff: true
        },
        { history: { ...EMPTY_PLAN_HISTORY, lastLeadoff: 'g:102' } }
      ),
      plan: {
        ...PLAN,
        rows: [
          { player: LINEUP[0], cells: ['1B', '', '', '', '', ''] },
          { player: LINEUP[1], cells: ['C', 'C', '', '', '', ''] },
          { player: LINEUP[2], cells: ['CF', 'CF', '', '', '', ''] }
        ]
      }
    })
    const shown = (): string[] =>
      [...document.querySelectorAll('[data-testid^="Plan warning "]')].map(
        node => String(node.getAttribute('data-testid'))
      )
    // Ruth's six outs are still reachable in the innings not planned yet:
    // yellow; nothing red yet.
    expect(shown()).deep.equals(['Plan warning yellow mandatoryPlay'])
    // Planning the third inning without him is a second sit, which breaks
    // Max Sits at once, before any save.
    const input = cell(2, 3)
    await focus(input)
    await typeText(input, 'c')
    expect(shown()).deep.include('Plan warning red maxSitsPerGame')
    const red = byId('Plan warning red maxSitsPerGame')!
    expect(red.textContent).includes('Babe Ruth')
    expect(red.getAttribute('aria-label')).match(/^Red warning: /)
    // Above Clear.
    const warnings = byId('Plan warnings')!
    expect(
      warnings.compareDocumentPosition(byId('Plan clear')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.equals(0)
    expect(shown()).not.include('Plan warning yellow rotateLeadoff')
    // Gehrig led off last game: leading off again warns, softly.
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
    expect(shown()).deep.include('Plan warning yellow rotateLeadoff')
    expect(shown().filter(id => id.includes('rotateLeadoff'))).deep.equals([
      'Plan warning yellow rotateLeadoff'
    ])
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
        { mandatoryPlay: true },
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
        { mandatoryPlay: true },
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
