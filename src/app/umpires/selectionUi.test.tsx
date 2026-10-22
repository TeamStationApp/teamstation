import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { responderDrag } from '../../test/responderDrag'
import { ThemeProvider } from '../theme/ThemeContext'
import { selectedRange, selectUmpire, touchedRow } from './umpireSelection'
import {
  UmpireSelector,
  useTouchInterface,
  useUnsavedWarning
} from './UmpireSelector'
import {
  UmpireSelector as NativeSelector,
  useTouchInterface as nativeTouch,
  useUnsavedWarning as nativeWarning
} from './UmpireSelector.native'

describe('umpire pointer selection', () => {
  let root: Root | undefined
  // Preserve the method itself so the browser fixture can be restored.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalMedia = window.matchMedia
  const originalTouch = Object.getOwnPropertyDescriptor(
    navigator,
    'maxTouchPoints'
  )
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
    window.matchMedia = originalMedia
    if (originalTouch != null)
      Object.defineProperty(navigator, 'maxTouchPoints', originalTouch)
    else Reflect.deleteProperty(navigator, 'maxTouchPoints')
  })
  async function mount(native = false, disabled = false): Promise<void> {
    const node = document.createElement('div')
    document.body.append(node)
    root = createRoot(node)
    function Example(): React.ReactElement {
      const [selected, setSelected] = useState<string[]>([])
      const [anchor, setAnchor] = useState<number>()
      const [held, setHeld] = useState<string[]>([])
      const touch = useTouchInterface()
      useUnsavedWarning(selected.length > 0)
      const Selector = native ? NativeSelector : UmpireSelector
      return (
        <ThemeProvider>
          <span>{touch ? 'Touch interface' : 'Mouse interface'}</span>
          {['a', 'b', 'c', 'd'].map((id, index) => (
            <Selector
              key={id}
              label={id}
              checked={selected.includes(id)}
              disabled={disabled}
              index={index}
              count={4}
              testID={`selector-${id}`}
              onToggle={mods => {
                setSelected(ids =>
                  selectUmpire(['a', 'b', 'c', 'd'], ids, index, anchor, mods)
                )
                if (mods?.shiftKey !== true) setAnchor(index)
              }}
              onRangeStart={() => {
                setHeld(selected)
                setAnchor(index)
              }}
              onRange={last => {
                setSelected(
                  selectedRange(['a', 'b', 'c', 'd'], index, last, held)
                )
              }}
            />
          ))}
        </ThemeProvider>
      )
    }
    await act(async () => {
      root!.render(<Example />)
    })
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      const target = document.querySelector<HTMLElement>(
        `[data-testid="selector-${id}"]`
      )!
      Object.defineProperty(target, 'offsetTop', {
        configurable: true,
        value: index * 80
      })
      target.getBoundingClientRect = () => ({
        top: index * 80,
        height: 80,
        left: 0,
        right: 48,
        bottom: (index + 1) * 80,
        width: 48,
        x: 0,
        y: index * 80,
        toJSON: () => ({})
      })
    }
  }
  const checked = (): string[] =>
    [
      ...document.querySelectorAll('[role="checkbox"][aria-checked="true"]')
    ].map(n => n.getAttribute('aria-label')!)
  async function click(id: string, mods: MouseEventInit = {}): Promise<void> {
    await act(async () => {
      document
        .querySelector(`[aria-label="${id}"]`)!
        .dispatchEvent(
          new window.MouseEvent('click', { bubbles: true, detail: 1, ...mods })
        )
    })
  }
  async function pointer(
    id: string,
    type: string,
    y: number,
    pointerType = 'touch',
    pointerId = 1
  ): Promise<void> {
    await act(async () => {
      const e = new window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientY: y
      })
      Object.defineProperties(e, {
        pointerType: { value: pointerType },
        pointerId: { value: pointerId }
      })
      document.querySelector(`[data-testid="selector-${id}"]`)!.dispatchEvent(e)
    })
  }
  it('selects a third row individually, Shift ranges, Command/Control toggles and additive ranges', async () => {
    await mount()
    await click('a')
    await click('c')
    expect(checked()).deep.equals(['a', 'c'])
    await click('c', { ctrlKey: true })
    expect(checked()).deep.equals(['a'])
    await click('a', { metaKey: true })
    expect(checked()).deep.equals([])
    await click('a')
    await click('c', { shiftKey: true })
    expect(checked()).deep.equals(['a', 'b', 'c'])
    await click('d', { metaKey: true })
    await click('b', { shiftKey: true, ctrlKey: true })
    expect(checked()).deep.equals(['a', 'b', 'c', 'd'])
    await click('b', { shiftKey: true })
    expect(checked()).deep.equals(['b', 'c', 'd'])
    expect(
      selectUmpire(['a', 'b'], [], 1, undefined, { shiftKey: true })
    ).deep.equals(['b'])
  })
  it('owns touch taps and drags exactly once, handles reverse dragging and ignores cancelled/mouse pointers', async () => {
    await mount()
    await pointer('a', 'pointermove', 100)
    await pointer('a', 'pointerup', 100)
    await pointer('a', 'pointerdown', 20, 'mouse')
    await pointer('a', 'pointermove', 180, 'mouse')
    await pointer('a', 'pointerup', 180, 'mouse')
    expect(checked()).deep.equals([])
    await pointer('a', 'pointerdown', 20)
    await pointer('a', 'pointermove', 180)
    expect(checked()).deep.equals(['a', 'b', 'c'])
    await pointer('a', 'pointermove', 100)
    expect(checked()).deep.equals(['a', 'b'])
    await pointer('a', 'pointermove', 20)
    expect(checked()).deep.equals(['a'])
    await pointer('a', 'pointerup', 20)
    await click('a')
    expect(checked()).deep.equals(['a'])
    await pointer('c', 'pointerdown', 180)
    await pointer('c', 'pointerup', 180)
    await click('c')
    await act(async () => {
      const event = new window.MouseEvent('click', { bubbles: true, detail: 0 })
      Object.defineProperty(event, 'pointerType', { value: 'touch' })
      document.querySelector('[aria-label="c"]')!.dispatchEvent(event)
    })
    expect(checked()).deep.equals(['a', 'c'])
    await pointer('a', 'pointerdown', 20)
    await pointer('a', 'pointercancel', 20)
    await pointer('a', 'pointerup', 20)
    expect(checked()).deep.equals(['a', 'c'])
    await pointer('d', 'pointerdown', 260)
    await pointer('d', 'pointermove', 20)
    await pointer('d', 'pointerup', 20)
    expect(checked()).deep.equals(['a', 'b', 'c', 'd'])
  })
  it('uses row bounds for off-center drags and tolerates a removed anchor', async () => {
    expect(
      selectUmpire(['b', 'c', 'd'], [], 1, -1, { shiftKey: true })
    ).deep.equals(['c'])
    expect(selectUmpire(['b', 'c'], [], 1, 4, { shiftKey: true })).deep.equals([
      'c'
    ])
    expect(touchedRow(176, 0, 80, 0, 4)).equals(2)
    expect(touchedRow(63, 160, 80, 2, 4)).equals(0)
    await mount()
    await pointer('a', 'pointerdown', 63)
    await pointer('a', 'pointermove', 176)
    await pointer('a', 'pointerup', 176)
    expect(checked()).deep.equals(['a', 'b', 'c'])
    await click('a')
    await click('b')
    await click('c')
    // Real mouse pointer-down removes the compatibility-click guard.
    await pointer('a', 'pointerdown', 63, 'mouse')
    await click('a')
    expect(checked()).deep.equals([])
    await pointer('c', 'pointerdown', 176)
    await pointer('c', 'pointermove', 63)
    await pointer('c', 'pointerup', 63)
    expect(checked()).deep.equals(['a', 'b', 'c'])
  })
  it('detects touch capability changes and warns only with dirty state', async () => {
    let listener: (() => void) | undefined
    let removed = false
    let coarse = false
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 0
    })
    window.matchMedia = (() => ({
      get matches() {
        return coarse
      },
      addEventListener: (_name: string, fn: () => void) => {
        listener = fn
      },
      removeEventListener: () => {
        removed = true
      }
    })) as unknown as typeof window.matchMedia
    await mount()
    expect(document.body.textContent).contains('Mouse interface')
    await act(async () => {
      coarse = true
      listener!()
    })
    expect(document.body.textContent).contains('Touch interface')
    let e = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).equals(false)
    await click('b')
    e = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).equals(true)
    await click('b')
    e = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).equals(false)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(removed).equals(true)
  })
  it('ignores disabled touch starts and supports keyboard selection', async () => {
    await mount(false, true)
    await pointer('a', 'pointerdown', 20)
    await pointer('a', 'pointerup', 20)
    expect(checked()).deep.equals([])
    await act(async () => {
      root!.unmount()
    })
    document.body.replaceChildren()
    await mount()
    await act(async () => {
      document
        .querySelector('[aria-label="c"]')!
        .dispatchEvent(
          new window.KeyboardEvent('keydown', { bubbles: true, key: ' ' })
        )
    })
    expect(checked()).deep.equals(['c'])
  })
  async function nativeDrag(
    target: HTMLElement,
    points: Array<[number, number]>
  ): Promise<void> {
    await responderDrag(target, points)
    // Native measurement is asynchronous, including a release before it returns.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
  }
  it('measures the native outer row for descendant-origin forward/reverse drags', async () => {
    await mount(true)
    const first = document.querySelector<HTMLElement>(
      '[data-testid="selector-a"]'
    )!
    const third = document.querySelector<HTMLElement>(
      '[data-testid="selector-c"]'
    )!
    const child = first.querySelector<HTMLElement>(
      '[data-testid="checkbox-square"]'
    )!
    child.getBoundingClientRect = () => ({
      top: 28,
      height: 24,
      left: 12,
      right: 36,
      bottom: 52,
      width: 24,
      x: 12,
      y: 28,
      toJSON: () => ({})
    })
    await nativeDrag(child, [
      [24, 40],
      [24, 180]
    ])
    expect(checked()).deep.equals(['a', 'b', 'c'])
    for (const id of ['a', 'b', 'c']) await click(id)
    expect(checked()).deep.equals([])
    await nativeDrag(
      third.querySelector<HTMLElement>('[data-testid="checkbox-square"]')!,
      [
        [24, 200],
        [24, 60]
      ]
    )
    expect(checked()).deep.equals(['a', 'b', 'c'])
  })
  it('keeps native tap and range selection on the shared checkbox', async () => {
    expect(nativeTouch()).equals(true)
    nativeWarning(true)
    await mount(true)
    const target = document.querySelector<HTMLElement>(
      '[data-testid="selector-a"]'
    )!
    await nativeDrag(target, [
      [10, 10],
      [10, 170]
    ])
    expect(checked()).deep.equals(['a', 'b', 'c'])
    await nativeDrag(target, [
      [10, 10],
      [10, 10]
    ])
    expect(checked()).deep.equals(['b', 'c'])
    await nativeDrag(target, [
      [10, 10],
      [10, 170],
      [10, 10]
    ])
    expect(checked()).deep.equals(['a', 'b', 'c'])
  })
})
