import { expect } from 'chai'
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import type { NavTabId } from './tabBarModel'
import { useCapsuleDrag } from './useCapsuleDrag'

describe('selecting a lower tab with a drag', () => {
  it('previews each new slot, honors release bounds and delivers one request', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const requests: NavTabId[] = []
    let haptics = 0
    let bar!: ReturnType<typeof useCapsuleDrag>
    function Capsule(): React.ReactElement {
      const bounds = useRef({ width: 400, height: 52, count: 5 })
      bar = useCapsuleDrag(
        bounds,
        0,
        id => requests.push(id),
        () => {
          haptics++
        }
      )
      return <span>{bar.dragged ?? 'rest'}</span>
    }
    try {
      await act(async () => {
        root.render(<Capsule />)
      })
      bar.press('home')
      for (const [y, canceled, expected] of [
        [-52, false, 'search'],
        [-53, false, null],
        [10, true, null]
      ] as const) {
        requests.length = 0
        haptics = 0
        await act(async () => {
          bar.gesture.onTouchesDown()
          bar.gesture.onActivate({ x: 30 })
        })
        expect(host.textContent).equals('0')
        await act(async () => {
          bar.gesture.onUpdate({ x: 280 })
          bar.gesture.onUpdate({ x: 285 })
        })
        expect(host.textContent).equals('3')
        expect(haptics).equals(1)
        expect(requests).deep.equals([])
        await act(async () => {
          bar.gesture.onDeactivate({ x: 280, y, canceled })
          bar.gesture.onFinalize()
        })
        bar.press('home')
        expect(requests).deep.equals(expected == null ? [] : [expected])
        expect(host.textContent).equals('rest')
      }
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => {
          resolve()
        })
      )
      bar.press('chat')
      expect(requests).deep.equals(['chat'])
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  })
  it('springs back without a request when the drag returns to the selected tab', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const requests: NavTabId[] = []
    let bar!: ReturnType<typeof useCapsuleDrag>
    function Capsule(props: { selected: number }): React.ReactElement {
      const bounds = useRef({ width: 400, height: 52, count: 5 })
      bar = useCapsuleDrag(
        bounds,
        props.selected,
        id => requests.push(id),
        () => {}
      )
      return <span>{bar.dragged ?? 'rest'}</span>
    }
    const nextFrame = async (): Promise<void> => {
      await new Promise<void>(resolve =>
        requestAnimationFrame(() => {
          resolve()
        })
      )
    }
    const drag = async (
      from: number,
      over: number,
      to: number
    ): Promise<void> => {
      await act(async () => {
        bar.gesture.onTouchesDown()
        bar.gesture.onActivate({ x: from })
        bar.gesture.onUpdate({ x: over })
      })
      expect(host.textContent).equals(String(Math.floor(over / 80)))
      await act(async () => {
        bar.gesture.onUpdate({ x: to })
        bar.gesture.onDeactivate({ x: to, y: 26, canceled: false })
        bar.gesture.onFinalize()
      })
      expect(host.textContent).equals('rest')
    }
    try {
      await act(async () => {
        root.render(<Capsule selected={0} />)
      })
      // Home is selected and three screens deep: toward Chat and back again.
      await drag(30, 370, 30)
      expect(requests).deep.equals([])
      // The same return from a drag that began on another tab still springs
      // back to the selection, not to the tab under the first touch.
      await act(async () => {
        root.render(<Capsule selected={2} />)
      })
      await drag(30, 370, 200)
      expect(requests).deep.equals([])
      await drag(200, 30, 30)
      expect(requests).deep.equals(['home'])
      // A plain tap on the selected tab still asks for its root.
      await nextFrame()
      bar.press('schedule')
      expect(requests).deep.equals(['home', 'schedule'])
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  })
})
