import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Animated } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { SegmentedPill } from './SegmentedPill'

const OPTIONS = [
  { id: 'inSeason', label: 'In-Season' },
  { id: 'all', label: 'Include Exhibitions' }
] as const
let root: Root | undefined
let host: HTMLElement
let restoreAnimation: (() => void) | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  restoreAnimation?.()
  restoreAnimation = undefined
  document.body.replaceChildren()
})
async function render(
  initial: 'inSeason' | 'all' = 'inSeason',
  disabled = false
): Promise<string[]> {
  const selected: string[] = []
  function Harness(): React.ReactElement {
    const [value, setValue] = useState(initial)
    return (
      <SegmentedPill
        options={OPTIONS}
        selected={value}
        accessibilityLabel="Standings games"
        disabled={disabled}
        onSelect={next => {
          selected.push(next)
          setValue(next)
        }}
      />
    )
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
  })
  return selected
}
async function measure(width: number): Promise<void> {
  // JSDOM's ResizeObserver does not measure. Deliver the actual RN web layout callback.
  const track = host.querySelector(
    '[data-testid="segmented-pill"]'
  ) as unknown as {
    __reactLayoutHandler: (event: {
      nativeEvent: { layout: { width: number } }
    }) => void
  }
  await act(async () => {
    track.__reactLayoutHandler({ nativeEvent: { layout: { width } } })
  })
}
async function select(id: string): Promise<void> {
  await act(async () => {
    host.querySelector<HTMLElement>(`[aria-label="${id}"]`)!.click()
  })
}
async function finishAnimation(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 260))
  })
}
function fill(): HTMLElement {
  return host.querySelector('[data-testid="segmented-pill-fill"]')!
}

describe('one sliding standings capsule', () => {
  it('keeps disabled choices selected without issuing a change', async () => {
    const changes = await render('inSeason', true)
    await select('Include Exhibitions')
    expect(changes).deep.equals([])
    expect(
      host
        .querySelector('[aria-label="Include Exhibitions"]')!
        .getAttribute('aria-disabled')
    ).equals('true')
    expect(host.querySelector('[aria-selected="true"]')!.textContent).equals(
      'In-Season'
    )
  })
  it('renders two accessible equal regions inside one rounded pill with white active text', async () => {
    await render()
    const track = host.querySelector<HTMLElement>('[role="tablist"]')!
    const tabs = [...track.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs.map(tab => tab.getAttribute('aria-label'))).deep.equals([
      'In-Season',
      'Include Exhibitions'
    ])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).deep.equals([
      'true',
      'false'
    ])
    expect(getComputedStyle(track).overflowX).equals('hidden')
    expect(getComputedStyle(track).overflowY).equals('hidden')
    expect(getComputedStyle(tabs[0]).flexGrow).equals('1')
    expect(getComputedStyle(tabs[1]).flexGrow).equals('1')
    expect(getComputedStyle(fill()).width).equals('50%')
    expect(getComputedStyle(fill()).backgroundColor).equals('rgb(43, 66, 33)')
    expect(getComputedStyle(tabs[0].firstElementChild!).color).equals(
      'rgb(255, 255, 255)'
    )
  })
  it('slides between halves and leaves repeated selection of the active region unchanged', async () => {
    const selected = await render()
    await measure(320)
    await select('Include Exhibitions')
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(160px)')
    expect(host.querySelector('[aria-selected="true"]')!.textContent).equals(
      'Include Exhibitions'
    )
    await select('Include Exhibitions')
    expect(selected).deep.equals(['all'])
    await select('In-Season')
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(0px)')
    expect(selected).deep.equals(['all', 'inSeason'])
  })
  it('keeps the selected right half aligned when the capsule resizes', async () => {
    await render('all')
    await measure(300)
    expect(fill().style.transform).equals('translateX(150px)')
    await measure(420)
    expect(fill().style.transform).equals('translateX(210px)')
    expect(host.querySelector('[aria-selected="true"]')!.textContent).equals(
      'Include Exhibitions'
    )
  })
  it('stops superseded and unmounted animations instead of leaving their timers running', async () => {
    const original = Animated.timing
    const descriptor = Object.getOwnPropertyDescriptor(Animated, 'timing')!
    let stopped = 0
    const timing = (
      ...args: Parameters<typeof Animated.timing>
    ): ReturnType<typeof Animated.timing> => {
      const animation = original(...args)
      const stop = animation.stop.bind(animation)
      animation.stop = () => {
        stopped++
        stop()
      }
      return animation
    }
    Object.defineProperty(Animated, 'timing', { ...descriptor, value: timing })
    restoreAnimation = () => {
      Object.defineProperty(Animated, 'timing', descriptor)
    }
    await render()
    await measure(320)
    await select('Include Exhibitions')
    await select('In-Season')
    expect(stopped).equals(1)
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(stopped).equals(2)
    await finishAnimation()
    expect(host.textContent).equals('')
  })
})
