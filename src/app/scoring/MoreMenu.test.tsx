import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { scoringSession } from '../../test/scoringSession'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { gameFixture } from './isUnscoredGame.test'
import { MORE_GROUPS, type MoreInput } from './moreActions'
import { MoreMenu } from './MoreMenu'
import { MoreMenu as NativeMoreMenu } from './MoreMenu.native'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
let root: Root | undefined
const inputs: MoreInput[] = []
function button(label: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(element, label).not.equals(null)
  return element!
}
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}
async function mount(
  native = false,
  occupied = false,
  pristine = false,
  edit?: (state: ScoringState) => void
): Promise<void> {
  let state = initialScoringState(scoringSession(gameFixture))
  if (occupied)
    state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
  edit?.(state)
  if (!pristine) {
    state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
    state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const Component = native ? NativeMoreMenu : MoreMenu
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Component
          state={state}
          disabled={false}
          onActive={() => undefined}
          onChoose={input => {
            inputs.push(input)
          }}
        />
      </ThemeProvider>
    )
  })
}
afterEach(async () => {
  await act(async () => {
    changeTheme(tsBallpark)
    root?.unmount()
  })
  root = undefined
  inputs.splice(0)
})
describe('More scoring menu', function () {
  it('omits headings and unavailable Balk in both themes', async () => {
    await mount()
    await click('More')
    for (const theme of [tsBallpark, tsDark]) {
      await act(async () => {
        changeTheme(theme)
      })
      const panel = button('More scoring actions')
      for (const group of MORE_GROUPS)
        expect(panel.textContent).not.includes(group.label)
      expect(document.querySelector('[aria-label="Balk"]')).equals(null)
      expect(button('More').style.fontSize).equals('16px')
      expect(button('More').style.fontWeight).equals('400')
    }
  })

  it('keeps the primary menu left and the child right with dark green focus', async function () {
    await mount()
    await click('More')
    const parent = button('More scoring actions')
    const width = parent.style.width
    const left = parent.style.left
    expect(width).includes('50vw')
    await act(async () => {
      button('Put Batter on Base').focus()
    })
    expect(button('Put Batter on Base').style.backgroundImage).includes(
      'linear-gradient'
    )
    expect(button('Put Batter on Base').style.color).equals(
      'rgb(255, 255, 255)'
    )
    await click('Put Batter on Base')
    expect(parent.style.width).equals(width)
    expect(parent.style.left).equals(left)
    expect(button('Batter base').style.left).includes('50vw')
    await click('Dismiss More')
  })
  it('aligns the child with its parent, clamps to the viewport and follows scroll', async function () {
    await mount()
    await click('More')
    const parent = button('Put Batter on Base')
    let top = 230
    parent.getBoundingClientRect = () => new window.DOMRect(0, top, 160, 44)
    await click('Put Batter on Base')
    expect(button('Batter base').style.top).equals('230px')
    expect(
      parent.lastElementChild!.lastElementChild!.textContent?.endsWith('›')
    ).equals(true)
    expect(
      parent.querySelector('[data-testid="scoring-menu-label"]')
    ).not.equals(null)
    top = 10000
    await act(async () => {
      window.dispatchEvent(new window.Event('scroll'))
    })
    expect(Number.parseFloat(button('Batter base').style.top)).at.most(
      window.innerHeight - 8
    )
    top = -10
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    expect(button('Batter base').style.top).equals('8px')
    await click('Dismiss More')
  })
  for (const native of [false, true])
    it(`groups real scoring actions and places immediately on ${native ? 'native' : 'web'}`, async function () {
      await mount(native, false, true)
      await click('More')
      expect(document.body.textContent).not.includes('This pitch')
      expect(document.body.textContent).not.includes('Between pitches')
      expect(document.body.textContent).not.includes("Didn't see it")
      expect(document.querySelector('[aria-label="Wild Pitch"]')).equals(null)
      expect(document.querySelector('[aria-label="Passed Ball"]')).equals(null)
      await click('Hit by Pitch')
      expect(inputs.pop()?.action).equals('Hit by Pitch')
      await click('More')
      await click('Put Batter on Base')
      await click('Third')
      expect(inputs.pop()).deep.equals({
        action: 'Put Batter on Base',
        base: 3
      })
      expect(
        document.querySelector('[aria-label="Confirm Placements"]')
      ).equals(null)
      await click('More')
      await click('Place a Runner (Tiebreaker)')
      expect(inputs.pop()).deep.equals({
        action: 'Place a Runner (Tiebreaker)'
      })
      expect(document.querySelector('[aria-label="Placed runner"]')).equals(
        null
      )
      await click('More')
      await click('Put Batter on Base')
      await click('First')
      expect(inputs.pop()).deep.equals({
        action: 'Put Batter on Base',
        base: 1
      })
      expect(inputs).has.length(0)
      await click('More')
      await click('Dismiss More')
    })
  for (const native of [false, true])
    it(`disables tiebreaker setup after a pitch on ${native ? 'native' : 'web'}`, async () => {
      await mount(native)
      await click('More')
      const choice = button('Place a Runner (Tiebreaker)')
      expect(
        choice.hasAttribute('disabled') ||
          choice.getAttribute('aria-disabled') === 'true'
      ).equals(true)
      await click('Place a Runner (Tiebreaker)')
      expect(inputs).has.length(0)
      expect(document.querySelector('[aria-label="Placed runner"]')).equals(
        null
      )
      await click('Dismiss More')
    })
  for (const native of [false, true])
    it(`hides placement on occupied bases on ${native ? 'native' : 'web'}`, async () => {
      await mount(native, true)
      await click('More')
      expect(button('Balk')).not.equals(null)
      expect(
        document.querySelector('[aria-label="Put Batter on Base"]')
      ).equals(null)
      await click('Dismiss More')
    })
  it('supports captured release and rightward escape without scoring an opened menu', async function () {
    await mount()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const saved = document.elementsFromPoint
    let hit: Element[] = []
    document.elementsFromPoint = () => hit
    const pointer = async (
      type: string,
      x: number,
      y: number
    ): Promise<void> => {
      await act(async () => {
        const event = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y
        })
        Object.defineProperty(event, 'pointerId', { value: 1 })
        button('More').dispatchEvent(event)
      })
    }
    try {
      await pointer('pointerdown', 50, 800)
      await pointer('pointermove', 50, 700)
      hit = [button('Hit by Pitch')]
      await pointer('pointermove', 50, 680)
      await pointer('pointerup', 50, 680)
      expect(inputs.pop()?.action).equals('Hit by Pitch')
      // iOS Safari can omit the synthetic click after captured release.
      // The next real tap must still open More on its first press.
      await pointer('pointerdown', 50, 800)
      await pointer('pointerup', 50, 800)
      await click('More')
      expect(button('Hit by Pitch')).not.equals(null)
      await click('Dismiss More')
      hit = []
      await pointer('pointerdown', 50, 800)
      await pointer('pointermove', 50, 700)
      await pointer('pointermove', 500, 600)
      await pointer('pointerup', 500, 600)
      expect(inputs).has.length(0)
      expect(document.querySelector('[aria-label="Hit by Pitch"]')).equals(null)
      await click('More') // compatibility click is ignored
      expect(document.querySelector('[role="menu"]')).equals(null)
      await pointer('pointerdown', 50, 800)
      await pointer('pointermove', 50, 700)
      await pointer('pointercancel', 50, 700)
      expect(document.querySelector('[aria-label="Hit by Pitch"]')).equals(null)
      await click('More')
      await act(async () => {
        document.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      })
      expect(document.querySelector('[aria-label="Hit by Pitch"]')).equals(null)
    } finally {
      document.elementsFromPoint = saved
    }
  })
})

describe('Double Play in More', () => {
  const GROUND = ['6-4-3', '4-6-3', '5-4-3', '3-6-3', '1-6-3', '1-4-3']
  const onSecond = (state: ScoringState): void => {
    state.session.liveData.linescore.offense.second = playerRef(
      state.session,
      3
    )
  }
  /** The labels of the rows in the panel labelled `panel`. */
  const rowsOf = (panel: string): string[] =>
    [...button(panel).querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label')!)
      .filter(label => label !== panel)
  for (const native of [false, true]) {
    const surface = native ? 'native' : 'web'
    it(`opens the seven double plays to its right with a runner on 1st on ${surface}`, async () => {
      await mount(native, true)
      await click('More')
      // It heads the menu, with a chevron, as Put Batter on Base would.
      expect(rowsOf('More scoring actions')[0]).equals('Double Play')
      expect(button('Double Play').textContent).includes('›')
      await click('Double Play')
      expect(rowsOf('Double play')).deep.equals([...GROUND, 'Caught out'])
      expect(button('Caught out').textContent).includes('Did not tag')
      expect(document.querySelector('[aria-label="Batter base"]')).equals(null)
      await click('6-4-3')
      expect(inputs.pop()).deep.equals({
        action: 'Double Play',
        doublePlay: '6-4-3'
      })
      expect(document.querySelector('[aria-label="Double play"]')).equals(null)
      await click('More')
      await click('Double Play')
      await click('Double Play')
      expect(document.querySelector('[aria-label="Double play"]')).equals(null)
      await click('Double Play')
      await click('Caught out')
      expect(inputs.pop()).deep.equals({
        action: 'Double Play',
        doublePlay: 'caught'
      })
      expect(inputs).has.length(0)
    })
    it(`offers only Caught out without a runner on 1st on ${surface}`, async () => {
      await mount(native, false, false, onSecond)
      await click('More')
      await click('Double Play')
      expect(rowsOf('Double play')).deep.equals(['Caught out'])
      await click('Dismiss More')
    })
    it(`hides Double Play with the bases empty or two outs on ${surface}`, async () => {
      await mount(native)
      await click('More')
      expect(document.querySelector('[aria-label="Double Play"]')).equals(null)
      expect(button('Put Batter on Base')).not.equals(null)
      await click('Dismiss More')
      await act(async () => {
        root?.unmount()
      })
      await mount(native, true, false, state => {
        state.session.liveData.linescore.outs = 2
      })
      await click('More')
      expect(document.querySelector('[aria-label="Double Play"]')).equals(null)
      expect(button('Balk')).not.equals(null)
      await click('Dismiss More')
    })
  }
  it('aligns the web submenu with the Double Play row and opens it on a drag', async () => {
    await mount(false, true)
    await click('More')
    const row = button('Double Play')
    row.getBoundingClientRect = () => new window.DOMRect(0, 180, 160, 44)
    await click('Double Play')
    expect(button('Double play').style.top).equals('180px')
    expect(button('Double play').style.left).includes('50vw')
    await click('Dismiss More')
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const saved = document.elementsFromPoint
    let hit: Element[] = []
    document.elementsFromPoint = () => hit
    const pointer = async (
      type: string,
      x: number,
      y: number
    ): Promise<void> => {
      await act(async () => {
        const e = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y
        })
        Object.defineProperty(e, 'pointerId', { value: 1 })
        button('More').dispatchEvent(e)
      })
    }
    try {
      await pointer('pointerdown', 50, 800)
      await pointer('pointermove', 50, 700)
      hit = [button('Double Play')]
      await pointer('pointermove', 50, 200)
      expect(rowsOf('Double play')).has.length(7)
      hit = [button('4-6-3')]
      await pointer('pointermove', 250, 200)
      await pointer('pointerup', 250, 200)
      expect(inputs.pop()).deep.equals({
        action: 'Double Play',
        doublePlay: '4-6-3'
      })
      // A release on the Double Play row itself chooses nothing.
      await pointer('pointerdown', 50, 800)
      await pointer('pointermove', 50, 700)
      hit = [button('Double Play')]
      await pointer('pointermove', 50, 200)
      await pointer('pointerup', 50, 200)
      expect(inputs).has.length(0)
    } finally {
      document.elementsFromPoint = saved
    }
  })
})

describe('More drag boundary', () => {
  it('permits upward approach and the submenu bridge, then cancels a departed gesture permanently', async () => {
    await mount()
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const saved = document.elementsFromPoint
    let hit: Element[] = []
    document.elementsFromPoint = () => hit
    const pointer = async (
      type: string,
      x: number,
      y: number
    ): Promise<void> => {
      await act(async () => {
        const e = new window.MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y
        })
        Object.defineProperty(e, 'pointerId', { value: 1 })
        button('More').dispatchEvent(e)
      })
    }
    try {
      for (const submenu of [false, true]) {
        hit = []
        await pointer('pointerdown', 50, 800)
        await pointer('pointermove', 50, 780)
        button('More scoring actions').getBoundingClientRect = () =>
          new window.DOMRect(8, 200, 176, 450)
        await pointer('pointermove', 50, 720)
        expect(button('Hit by Pitch')).not.equals(null)
        if (submenu) {
          hit = [button('Put Batter on Base')]
          await pointer('pointermove', 60, 300)
          button('Batter base').getBoundingClientRect = () =>
            new window.DOMRect(208, 300, 176, 132)
          hit = []
          await pointer('pointermove', 196, 320)
          expect(button('Batter base')).not.equals(null)
          hit = [button('First')]
          await pointer('pointermove', 250, 320)
          expect(button('Batter base')).not.equals(null)
        }
        hit = []
        await pointer('pointermove', 500, 150)
        expect(document.querySelector('[role="menu"]')).equals(null)
        await pointer('pointermove', 50, 300)
        await pointer('pointerup', 50, 300)
        await click('More')
        expect(document.querySelector('[role="menu"]')).equals(null)
        expect(inputs).has.length(0)
        await pointer('pointerdown', 50, 800)
        await pointer('pointerup', 50, 800)
        await click('More')
        expect(button('Hit by Pitch')).not.equals(null)
        await click('Dismiss More')
      }
    } finally {
      document.elementsFromPoint = saved
    }
  })
})
