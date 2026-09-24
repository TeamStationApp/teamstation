import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { MORE_GROUPS, type MoreInput } from './moreActions'
import { MoreMenu } from './MoreMenu'
import { MoreMenu as NativeMoreMenu } from './MoreMenu.native'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
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
async function mount(native = false, occupied = false): Promise<void> {
  let state = initialScoringState(createDevelopmentSession(gameFixture, [], []))
  if (occupied)
    state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
  state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
  state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const Component = native ? NativeMoreMenu : MoreMenu
  await act(async () => {
    root!.render(
      <Component
        state={state}
        disabled={false}
        onActive={() => undefined}
        onChoose={input => {
          inputs.push(input)
        }}
      />
    )
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  inputs.splice(0)
})
describe('More scoring menu', function () {
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
    expect(button('Put Batter on Base').style.backgroundColor).equals(
      'rgb(36, 113, 61)'
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
    expect(parent.lastElementChild!.textContent).equals('›')
    expect(parent.style.justifyContent).equals('space-between')
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
      await mount(native)
      await click('More')
      for (const group of MORE_GROUPS)
        expect(document.body.textContent).includes(group.label)
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
      await click('Placed runner')
      await click('Choose Placed runner Player 3')
      await click('Destination base')
      await click('Choose Destination base Second')
      await click('Place Runner')
      expect(inputs.pop()).deep.equals({
        action: 'Place a Runner (Tiebreaker)',
        base: 2,
        playerId: 3
      })
      await click('More')
      await click('Put Batter on Base')
      await click('First')
      expect(inputs.pop()).deep.equals({
        action: 'Put Batter on Base',
        base: 1
      })
      expect(inputs).has.length(0)
      await click('More')
      await click(native ? 'Cancel' : 'Dismiss More')
    })
  for (const native of [false, true])
    it(`hides placement on occupied bases on ${native ? 'native' : 'web'}`, async () => {
      await mount(native, true)
      await click('More')
      expect(
        document.querySelector('[aria-label="Put Batter on Base"]')
      ).equals(null)
      await click(native ? 'Cancel' : 'Dismiss More')
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
      expect(button('Hit by Pitch')).not.equals(null)
      await click('More')
      await click('Dismiss More')
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
