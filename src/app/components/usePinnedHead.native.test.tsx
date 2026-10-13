import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { PinnedHead } from './pinnedHead'
import { usePinnedHead } from './usePinnedHead.native'

describe('native pinned schedule anchoring', () => {
  it('does not recursively correct clamped scroll events and lands when content mounts', async () => {
    let head!: PinnedHead
    function Harness(): React.ReactElement {
      head = usePinnedHead({
        headerHeight: 72,
        ready: true,
        tab: 'schedule',
        anchorOnRow: true,
        tail: 30,
        onScroll: () => undefined
      })
      return <div />
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let available = 0
    let depth = 0
    let maximumDepth = 0
    const offsets: number[] = []
    const layout = (y: number, height: number): never => {
      const event: unknown = {
        nativeEvent: { layout: { x: 0, y, width: 390, height } }
      }
      return event as never
    }
    const scroll = (y: number): void => {
      const handler = head.screen.onScroll as unknown as {
        workletEventHandler: { worklet: (event: unknown) => void }
      }
      handler.workletEventHandler.worklet({
        eventName: 'onScroll',
        contentOffset: { x: 0, y },
        contentSize: { width: 390, height: available + 600 },
        layoutMeasurement: { width: 390, height: 600 }
      })
    }
    try {
      await act(async () => {
        root.render(<Harness />)
      })
      const view = {
        scrollTo: ({ y }: { y: number }): void => {
          depth++
          maximumDepth = Math.max(maximumDepth, depth)
          const landed = Math.min(y, available)
          offsets.push(landed)
          // Cap the predecessor's recursion so this regression test stays safe.
          if (depth <= 8) scroll(landed)
          depth--
        }
      }
      ;(head.screen.scrollRef as unknown as (node: unknown) => void)(view)
      await act(async () => {
        head.screen.onLayout!(layout(0, 600))
        head.pillBand.handleLayout!(layout(200, 60))
        head.content.handleLayout!(layout(260, 300))
        head.rowSection.handleLayout!(layout(0, 300))
        head.nextRow.handleLayout!(layout(800, 90))
      })
      await act(async () => {
        head.spacer.handleLayout!(
          layout(0, (head.spacer.style as { height: number }).height)
        )
        await new Promise(resolve => setTimeout(resolve, 180))
      })
      expect(offsets.length).greaterThan(0)
      expect(maximumDepth).equals(1)
      expect(offsets.at(-1)).equals(0)
      available = 2000
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 180))
      })
      expect(offsets.at(-1)).equals(800)
      expect(maximumDepth).equals(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
