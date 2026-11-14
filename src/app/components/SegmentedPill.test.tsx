import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Animated, View } from 'react-native'

import { recordAnimationStarts, responderDrag } from '../../test/responderDrag'
import { ThemeProvider } from '../theme/ThemeContext'
import { pillIndexAt, SegmentedPill } from './SegmentedPill'

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
/** A pill of any two to four choices, numbered or named. */
async function renderMany<Id extends string | number>(
  options: ReadonlyArray<{ id: Id; label: string }>,
  initial: Id,
  fit?: 'fill' | 'content'
): Promise<Id[]> {
  const selected: Id[] = []
  function Harness(): React.ReactElement {
    const [value, setValue] = useState<Id>(initial)
    return (
      <SegmentedPill
        options={options}
        selected={value}
        accessibilityLabel="Choices"
        fit={fit}
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
/** Lays a content-width pill's choices out side by side at these widths. */
async function measureChoices(widths: number[]): Promise<void> {
  const tabs = [...host.querySelectorAll('[role="tab"]')] as unknown as Array<{
    __reactLayoutHandler: (event: {
      nativeEvent: { layout: { x: number; width: number } }
    }) => void
  }>
  let x = 0
  await act(async () => {
    tabs.forEach((tab, at) => {
      tab.__reactLayoutHandler({
        nativeEvent: { layout: { x, width: widths[at] } }
      })
      x += widths[at]
    })
  })
  await measure(x)
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
  it('keeps a drag that strays well below the rail, and slides on from where it is let go', async () => {
    const selected = await render()
    await measure(300)
    const tab = host.querySelector<HTMLElement>('[role="tab"]')!
    const animations = recordAnimationStarts()
    restoreAnimation = animations.restore
    // The pill takes the drag at x 40; 90 of the 150 px to the other half
    // later, the finger is 150 px below the rail.
    await responderDrag(tab, [
      [20, 10],
      [40, 12],
      [90, 80],
      [130, 160]
    ])
    expect(selected).deep.equals(['all'])
    // It slides on from where it was let go, 90 of 150 px across, and never
    // starts again from the left.
    expect(animations.starts.length).greaterThan(0)
    expect(animations.starts[0]).closeTo(90 / 150, 0.01)
    expect(animations.starts.every(start => start > 0.5)).equals(true)
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(150px)')
  })
  it('lets go short of the middle and slides back from there', async () => {
    const selected = await render()
    await measure(300)
    const tab = host.querySelector<HTMLElement>('[role="tab"]')!
    const animations = recordAnimationStarts()
    restoreAnimation = animations.restore
    await responderDrag(tab, [
      [20, 10],
      [40, 12],
      [80, 14]
    ])
    expect(selected).deep.equals([])
    expect(animations.starts).deep.equals([40 / 150])
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(0px)')
  })
  it('keeps its drag when a scrolling parent asks for it mid-way', async () => {
    const selected: string[] = []
    let asked = 0
    let taken = 0
    function Harness(): React.ReactElement {
      const [value, setValue] = useState<'inSeason' | 'all'>('inSeason')
      return (
        <View
          onMoveShouldSetResponderCapture={() => ++asked > 1}
          onResponderGrant={() => {
            taken++
          }}
        >
          <SegmentedPill
            options={OPTIONS}
            selected={value}
            accessibilityLabel="Standings games"
            onSelect={next => {
              selected.push(next)
              setValue(next)
            }}
          />
        </View>
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
    await measure(300)
    await responderDrag(host.querySelector<HTMLElement>('[role="tab"]')!, [
      [20, 10],
      [40, 12],
      [100, 90],
      [200, 200]
    ])
    expect(asked).greaterThan(1)
    expect(taken).equals(0)
    expect(selected).deep.equals(['all'])
  })
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
  it('slides among three and four equal choices, by tap and by drag', async () => {
    const three = await renderMany(
      [
        { id: 3, label: '3' },
        { id: 6, label: '6' },
        { id: 9, label: '9' }
      ],
      6
    )
    await measure(300)
    expect(getComputedStyle(fill()).width).equals('33.333333333333336%')
    expect(fill().style.transform).equals('translateX(100px)')
    await select('9')
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(200px)')
    expect(three).deep.equals([9])
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()

    const four = await renderMany<number | 'none'>(
      [
        { id: 3, label: '3rd' },
        { id: 4, label: '4th' },
        { id: 5, label: '5th' },
        { id: 'none', label: 'n/a' }
      ],
      3
    )
    await measure(400)
    expect(getComputedStyle(fill()).width).equals('25%')
    const animations = recordAnimationStarts()
    restoreAnimation = animations.restore
    // 160 px past where it took the drag is 1.6 choices of 100: let go
    // there, it settles on the third.
    await responderDrag(host.querySelector<HTMLElement>('[role="tab"]')!, [
      [20, 10],
      [40, 12],
      [120, 14],
      [200, 16]
    ])
    expect(four).deep.equals([5])
    expect(animations.starts[0]).closeTo(1.6, 0.01)
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(200px)')
    // A drag past the last choice stops on it.
    await responderDrag(host.querySelector<HTMLElement>('[role="tab"]')!, [
      [20, 10],
      [40, 12],
      [600, 14]
    ])
    expect(four).deep.equals([5, 'none'])
    await finishAnimation()
    expect(fill().style.transform).equals('translateX(300px)')
  })
  it('fits its labels with fit="content", each clear of the round ends, and slides between unequal choices', async () => {
    const selected = await renderMany<number | 'none'>(
      [
        { id: 3, label: '3' },
        { id: 4, label: '4' },
        { id: 5, label: '5' },
        { id: 'none', label: 'Disable' }
      ],
      'none',
      'content'
    )
    const track = host.querySelector<HTMLElement>('[role="tablist"]')!
    const tabs = [...track.querySelectorAll<HTMLElement>('[role="tab"]')]
    // Not stretched to the row: as wide as its choices, none of which grows.
    expect(getComputedStyle(track).width).equals('auto')
    expect(getComputedStyle(track).flexShrink).equals('0')
    for (const tab of tabs) {
      const style = getComputedStyle(tab)
      // 26 points high, in 12-point type, its target 48.
      expect(style.height).equals('26px')
      expect(
        getComputedStyle(tab.querySelector('[dir="auto"]')!).fontSize
      ).equals('12px')
      expect(style.flexGrow, tab.textContent!).not.equals('1')
      expect(parseFloat(style.paddingLeft)).greaterThanOrEqual(
        parseFloat(style.height) / 2
      )
      expect(parseFloat(style.paddingRight)).greaterThanOrEqual(
        parseFloat(style.height) / 2
      )
    }
    // The selected region is the measured choice's width, at its place.
    await measureChoices([40, 40, 40, 90])
    expect(fill().style.width).equals('90px')
    expect(fill().style.transform).equals('translateX(120px)')
    await select('4')
    await finishAnimation()
    expect(fill().style.width).equals('40px')
    expect(fill().style.transform).equals('translateX(40px)')
    // Dragged 80 px right from 4's left edge at 40, the fill's edge is at
    // 120, Disable's: it lets go on Disable.
    const animations = recordAnimationStarts()
    restoreAnimation = animations.restore
    await responderDrag(tabs[1], [
      [60, 10],
      [80, 12],
      [140, 14],
      [160, 16]
    ])
    expect(animations.starts[0]).equals(3)
    expect(selected).deep.equals([4, 'none'])
    await finishAnimation()
    expect(fill().style.width).equals('90px')
  })
  it('reads a fill edge between unequal choices as a fraction of the way', () => {
    const offsets = [0, 40, 80, 120]
    expect(pillIndexAt(offsets, -10)).equals(0)
    expect(pillIndexAt(offsets, 0)).equals(0)
    expect(pillIndexAt(offsets, 20)).equals(0.5)
    expect(pillIndexAt(offsets, 100)).equals(2.5)
    expect(pillIndexAt(offsets, 120)).equals(3)
    expect(pillIndexAt(offsets, 500)).equals(3)
    expect(pillIndexAt([0, 60, 200], 130)).equals(1.5)
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
