import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { Text } from 'react-native'

import {
  byTestId,
  render,
  settle,
  unmount,
  windowSize
} from '../../test/tessTestKit'
import { TessDivider } from './TessDivider'
import { TESS_WIDTH_KEY, tessMaxWidth, useTessWidth } from './tessLayout'

type Resized = Array<[number, boolean]>

function divider(): HTMLElement {
  return byTestId('Tess divider')!
}

async function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
  { button = 0, isPrimary }: { button?: number; isPrimary?: boolean } = {}
): Promise<MouseEvent> {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    button
  })
  // A pointer event's own field, which a mouse event lacks.
  if (isPrimary != null)
    Object.defineProperty(event, 'isPrimary', { value: isPrimary })
  await act(async () => {
    const target = type === 'pointerdown' ? divider() : window
    target.dispatchEvent(event)
  })
  return event
}

async function press(key: string): Promise<KeyboardEvent> {
  const event = new window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true
  })
  await act(async () => {
    divider().dispatchEvent(event)
  })
  return event
}

async function show(width = 400, max = 720): Promise<Resized> {
  const resized: Resized = []
  await render(
    <TessDivider
      width={width}
      max={max}
      onResize={(next, done) => resized.push([next, done])}
    />
  )
  return resized
}

describe("Tess's divider", () => {
  afterEach(unmount)

  it('is a focusable vertical separator called "Resize Tess" that says its width', async () => {
    await show(400, 720)
    const node = divider()
    expect(node.getAttribute('role')).equals('separator')
    expect(node.getAttribute('aria-label')).equals('Resize Tess')
    expect(node.getAttribute('aria-orientation')).equals('vertical')
    expect(
      ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].map(name =>
        node.getAttribute(name)
      )
    ).deep.equals(['400', '320', '720'])
    expect(node.getAttribute('tabindex')).equals('0')
    expect(getComputedStyle(node).cursor).equals('col-resize')
    expect(getComputedStyle(node).width).equals('12px')
    // A 3-point line and, halfway down, a grip that says it drags.
    expect(getComputedStyle(node.firstElementChild!).width).equals('3px')
    const grip = node.querySelector<HTMLElement>(
      '[data-testid="Tess divider grip"]'
    )!
    expect(getComputedStyle(grip).width).equals('8px')
    expect(getComputedStyle(grip).height).equals('44px')
  })

  it('drags once a frame, ends where the pointer is let go, and clamps to 320 and the window’s limit', async () => {
    const resized = await show(400, 720)
    await pointer('pointerdown', 400)
    await pointer('pointermove', 450)
    await pointer('pointermove', 520)
    await settle()
    await settle()
    await new Promise(resolve => setTimeout(resolve, 30))
    await settle()
    // Two moves in one frame: only the last is drawn.
    expect(resized).deep.equals([[520, false]])
    await pointer('pointermove', 2000)
    await pointer('pointerup', 2000)
    expect(
      resized.slice(1),
      'the last move dropped; the end clamped'
    ).deep.equals([[720, true]])
    // The window is let go: later moves drag nothing.
    await pointer('pointermove', 600)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(resized).length(2)
    await pointer('pointerdown', 400)
    await pointer('pointercancel', -500)
    expect(resized.at(-1)).deep.equals([320, true])
  })

  it('drags for the primary button, a finger or a pen alone: a right-click, a middle click or a second finger resizes nothing', async () => {
    const resized = await show(400, 720)
    for (const press of [{ button: 2 }, { button: 1 }, { isPrimary: false }]) {
      const down = await pointer('pointerdown', 400, press)
      // Its own default kept: a right-click still opens its menu.
      expect(down.defaultPrevented, JSON.stringify(press)).equals(false)
      await pointer('pointermove', 500)
      await new Promise(resolve => setTimeout(resolve, 30))
      await pointer('pointerup', 520)
    }
    expect(resized).deep.equals([])
    // A first finger or a pen drags.
    const touch = await pointer('pointerdown', 400, { isPrimary: true })
    expect(touch.defaultPrevented).equals(true)
    await pointer('pointerup', 480)
    expect(resized).deep.equals([[480, true]])
  })

  it('moves 16 points a press of ← or →, within its limits, and leaves other keys alone', async () => {
    let resized = await show(400, 720)
    expect((await press('ArrowRight')).defaultPrevented).equals(true)
    expect((await press('ArrowLeft')).defaultPrevented).equals(true)
    expect((await press('Tab')).defaultPrevented).equals(false)
    expect(resized).deep.equals([
      [416, true],
      [384, true]
    ])
    await unmount()
    resized = await show(320, 330)
    await press('ArrowLeft')
    await press('ArrowRight')
    expect(resized).deep.equals([
      [320, true],
      [330, true]
    ])
  })

  it('stops following the pointer when it goes away mid-drag', async () => {
    const resized = await show(400, 720)
    await pointer('pointerdown', 400)
    await unmount()
    await pointer('pointermove', 600)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(resized).deep.equals([])
  })
})

describe("Tess's column width", () => {
  let restore: (() => Promise<void>) | undefined
  afterEach(async () => {
    await unmount()
    await restore?.()
    restore = undefined
    window.localStorage.removeItem(TESS_WIDTH_KEY)
  })

  let set: ((width: number, done: boolean) => void) | undefined
  function Column(): React.ReactElement {
    const { width, max, setWidth } = useTessWidth()
    set = setWidth
    return <Text testID="width">{`${width}/${max}`}</Text>
  }
  const shown = (): string => byTestId('width')!.textContent ?? ''
  const showColumn = async (): Promise<void> => {
    await render(<Column />)
    await settle()
  }

  it('is 400 until dragged, at most 720 and always leaving the pane 520', async () => {
    restore = (await windowSize(1280)).restore
    await showColumn()
    expect(shown()).equals('400/720')
    expect([1025, 1100, 1240, 1600].map(tessMaxWidth)).deep.equals([
      505, 580, 720, 720
    ])
    await act(async () => {
      set!(900, false)
    })
    expect(shown()).equals('720/720')
    await windowSize(1100)
    expect(shown()).equals('580/580')
    await act(async () => {
      set!(100, false)
    })
    expect(shown()).equals('320/580')
  })

  it('keeps the width a drag ends on, on this device, and reads it back', async () => {
    restore = (await windowSize(1280)).restore
    await showColumn()
    await act(async () => {
      set!(512, false)
    })
    expect(window.localStorage.getItem(TESS_WIDTH_KEY)).equals(null)
    await act(async () => {
      set!(530, true)
    })
    expect(window.localStorage.getItem(TESS_WIDTH_KEY)).equals('530')
    await unmount()
    await showColumn()
    expect(shown()).equals('530/720')
    window.localStorage.setItem(TESS_WIDTH_KEY, 'wide')
    await unmount()
    await showColumn()
    expect(shown(), 'nothing readable: the default').equals('400/720')
    // A drag before the saved width is read keeps the drag.
    window.localStorage.setItem(TESS_WIDTH_KEY, '600')
    await unmount()
    await render(<Column />)
    await act(async () => {
      set!(500, false)
    })
    await settle()
    expect(shown()).equals('500/720')
  })

  it('falls back to 400, and still resizes, where the storage refuses', async () => {
    restore = (await windowSize(1280)).restore
    const storage = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('The storage is off')
      }
    })
    try {
      await showColumn()
      expect(shown()).equals('400/720')
      await act(async () => {
        set!(560, true)
      })
      expect(shown()).equals('560/720')
    } finally {
      Object.defineProperty(window, 'localStorage', storage)
    }
  })
})
