import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { OutcomePicker, PRIMARY_OUTCOMES } from './OutcomePicker'
import { OutcomePicker as NativePicker } from './OutcomePicker.native'
let root: Root | undefined
function button(label: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(node, label).not.equals(null)
  return node!
}
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}
async function mount(onChoose: (outcome: string) => void): Promise<void> {
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root!.render(
      <OutcomePicker
        disabled={false}
        onChoose={onChoose}
        onActive={() => undefined}
      />
    )
  })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})
describe('ball-in-play outcome menu', function () {
  it('keeps tap priority, toggles the left submenu and accepts only leaves', async function () {
    const chosen: string[] = []
    await mount(outcome => {
      chosen.push(outcome)
    })
    await click('Ball in Play')
    expect(
      Array.from(document.querySelectorAll('[data-outcome]')).map(node =>
        node.getAttribute('aria-label')
      )
    ).deep.equals([...PRIMARY_OUTCOMES])
    await click('Batter Out')
    expect(button('Throw Out')).not.equals(null)
    expect(chosen).has.length(0)
    await click('Batter Out')
    expect(document.querySelector('[aria-label="Throw Out"]')).equals(null)
    await click('Batter Out')
    await click('Throw Out')
    expect(chosen).deep.equals(['Throw Out'])
    for (const label of [
      'Single',
      'Double',
      'Triple',
      'Home Run',
      "Fielder's Choice",
      'Error',
      'Batter Interference'
    ]) {
      await click('Ball in Play')
      await click(label)
    }
    expect(chosen).has.length(8)
    await click('Ball in Play')
    await click('Ball in Play')
    expect(document.querySelector('[role="menu"]')).equals(null)
    await click('Ball in Play')
    await act(async () => {
      button('Ball in Play').dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(document.querySelector('[role="menu"]')).equals(null)
  })
  it('reverses drag priority, keeps the gap open and cancels interrupted releases without an action', async function () {
    const chosen: string[] = []
    await mount(outcome => {
      chosen.push(outcome)
    })
    // Save the host method solely for restoration.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const hitTest = document.elementsFromPoint
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
        button('Ball in Play').dispatchEvent(event)
      })
    }
    try {
      await pointer('pointerdown', 900, 800)
      await pointer('pointermove', 900, 700)
      expect(
        Array.from(document.querySelectorAll('[data-outcome]')).map(node =>
          node.getAttribute('aria-label')
        )
      ).deep.equals([...PRIMARY_OUTCOMES].reverse())
      hit = [button('Batter Out')]
      await pointer('pointermove', 900, 680)
      expect(button('Ball Caught')).not.equals(null)
      hit = []
      await pointer('pointermove', 700, 680)
      expect(button('Ball Caught')).not.equals(null)
      hit = [button('Single')]
      await pointer('pointermove', 900, 640)
      expect(document.querySelector('[aria-label="Ball Caught"]')).equals(null)
      hit = [button('Batter Out')]
      await pointer('pointermove', 900, 680)
      hit = [button('Ball Caught')]
      await pointer('pointermove', 200, 680)
      await pointer('pointerup', 200, 680)
      expect(chosen).deep.equals(['Ball Caught'])
      // Consume the browser's post-drag click; it must not reopen the menu.
      await click('Ball in Play')
      expect(document.querySelector('[role="menu"]')).equals(null)
      hit = []
      await pointer('pointerdown', 900, 800)
      await pointer('pointermove', 900, 700)
      await pointer('pointercancel', 900, 700)
      expect(chosen).has.length(1)
      await pointer('pointerdown', 900, 800)
      await pointer('pointermove', 900, 700)
      await pointer('lostpointercapture', 900, 700)
      expect(document.querySelector('[role="menu"]')).equals(null)
      await act(async () => {
        root!.render(
          <NativePicker
            disabled
            onChoose={() => undefined}
            onActive={() => undefined}
          />
        )
      })
      expect(button('Ball in Play').getAttribute('aria-disabled')).equals(
        'true'
      )
    } finally {
      document.elementsFromPoint = hitTest
    }
  })
})
