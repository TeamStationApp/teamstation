import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { Wheel } from './Wheel'

let root: Root | undefined
const delay = async (ms = 15): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

const ROW = 44
const OPTIONS = [-1, 0, 5, 10, 15]
const format = (option: number): string =>
  option === -1 ? 'Default' : `${option}%`

/** The wheel, holding its value, and every value it was handed. */
async function render(start = 5): Promise<number[]> {
  const chosen: number[] = []
  function Held(): React.ReactElement {
    const [value, setValue] = useState(start)
    return (
      <Wheel
        label="Height"
        options={OPTIONS}
        value={value}
        onChange={next => {
          chosen.push(next)
          setValue(next)
        }}
        format={format}
        testID="height-wheel"
        rowTestID="height"
        width={112}
      />
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Held />
      </ThemeProvider>
    )
    await delay()
  })
  return chosen
}

/**
 * The handler React holds for the outermost component above `node` that was
 * given `name`: what a phone calls that a browser never does.
 */
function handler(
  node: Element,
  name: string,
  /** A prop the component that holds it also has. */
  beside?: string
): (event: unknown) => void {
  const key = Object.keys(node).find(one => one.startsWith('__reactFiber'))!
  let fiber = (node as unknown as Record<string, unknown>)[key] as {
    memoizedProps?: Record<string, unknown>
    return?: unknown
  } | null
  // The outermost: what the component's caller gave it, not what the
  // renderer's own parts below it pass on.
  let outermost: ((event: unknown) => void) | undefined
  while (fiber != null) {
    const found = fiber.memoizedProps?.[name]
    if (
      typeof found === 'function' &&
      (beside == null || fiber.memoizedProps?.[beside] != null)
    )
      outermost = found as (event: unknown) => void
    fiber = fiber.return as typeof fiber
  }
  if (outermost == null) throw new Error(`no ${name}`)
  return outermost
}

const row = (option: number): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="height-${option}"]`)!
/** What the wheel says it is set to. */
const chosenLabel = (): string | null =>
  document
    .querySelector('[aria-label^="Height: "]')
    ?.getAttribute('aria-label') ?? null
const wheel = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-testid="height-wheel"]')!

describe('the wheel', function () {
  it('shows each option as it reads, the chosen one selected', async function () {
    await render(5)
    expect(
      [...document.querySelectorAll('[data-testid^="height-"]')]
        .filter(node => node !== wheel())
        .map(node => node.textContent)
    ).deep.equals(['Default', '0%', '5%', '10%', '15%'])
    expect(chosenLabel()).equals('Height: 5%')
    // Its value reads as the row does, not as a share of the range: a phone
    // reads the prop, which React Native Web does not write to the page.
    const viewport = document.querySelector('[aria-label^="Height: "]')!
    const key = Object.keys(viewport).find(one =>
      one.startsWith('__reactFiber')
    )!
    let fiber = (viewport as unknown as Record<string, unknown>)[key] as {
      memoizedProps?: { accessibilityValue?: { text?: string } }
      return?: unknown
    } | null
    let value: { text?: string } | undefined
    while (fiber != null && value == null) {
      value = fiber.memoizedProps?.accessibilityValue
      fiber = fiber.return as typeof fiber
    }
    expect(value?.text).equals('5%')
    expect(row(10).getAttribute('aria-label')).equals('Height 10%')
    expect(document.body.textContent).contains('Height')
  })

  it('chooses a row it is tapped on', async function () {
    const chosen = await render(5)
    await act(async () => {
      row(-1).click()
      await delay()
    })
    expect(chosen).deep.equals([-1])
    expect(chosenLabel()).equals('Height: Default')
  })

  it('chooses the row a scroll comes to rest on, in a browser', async function () {
    const chosen = await render(0)
    // A browser's scroll settles once it has been still a moment.
    const scrolled = async (top: number): Promise<void> => {
      handler(
        wheel(),
        'onScroll',
        'snapToInterval'
      )({
        nativeEvent: { contentOffset: { y: top } }
      })
    }
    await act(async () => {
      await scrolled(2 * ROW)
      await scrolled(3 * ROW + 10)
      await delay(200)
    })
    expect(chosen).deep.equals([10])
  })

  it('chooses where a phone’s drag or fling stops, kept to the ends', async function () {
    const chosen = await render(0)
    await act(async () => {
      handler(
        wheel(),
        'onMomentumScrollEnd'
      )({
        nativeEvent: { contentOffset: { y: 2 * ROW } }
      })
      handler(
        wheel(),
        'onScrollEndDrag'
      )({
        nativeEvent: { contentOffset: { y: 99 * ROW } }
      })
      handler(wheel(), 'onContentSizeChange')(undefined)
      await delay()
    })
    expect(chosen).deep.equals([5, 15])
  })

  it('moves by one for an assistive increment or decrement, kept to the ends', async function () {
    const chosen = await render(15)
    const act11y = handler(wheel(), 'onAccessibilityAction')
    await act(async () => {
      act11y({ nativeEvent: { actionName: 'increment' } })
      await delay()
    })
    await act(async () => {
      handler(
        wheel(),
        'onAccessibilityAction'
      )({
        nativeEvent: { actionName: 'decrement' }
      })
      await delay()
    })
    expect(chosen).deep.equals([15, 10])
  })
})
