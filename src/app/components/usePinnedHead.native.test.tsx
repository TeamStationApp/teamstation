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
        // Content long enough after the row that the row can come to the top.
        head.content.handleLayout!(layout(260, 1500))
        head.rowSection.handleLayout!(layout(0, 1500))
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

  it('holds a row anchor as the rows above it settle, with no room after the last row, until a finger takes the page', async () => {
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
    const offsets: number[] = []
    const layout = (y: number, height: number): never => {
      const event: unknown = {
        nativeEvent: { layout: { x: 0, y, width: 390, height } }
      }
      return event as never
    }
    const worklet = (event: Record<string, unknown>): void => {
      const handler = head.screen.onScroll as unknown as {
        workletEventHandler: { worklet: (event: unknown) => void }
      }
      handler.workletEventHandler.worklet({
        contentOffset: { x: 0, y: offsets.at(-1) ?? 0 },
        contentSize: { width: 390, height: 3000 },
        layoutMeasurement: { width: 390, height: 600 },
        ...event
      })
    }
    const room = (): number => (head.spacer.style as { height: number }).height
    const settle = async (): Promise<void> => {
      await act(async () => {
        head.spacer.handleLayout!(layout(0, room()))
        await new Promise(resolve => setTimeout(resolve, 60))
      })
    }
    try {
      await act(async () => {
        root.render(<Harness />)
      })
      ;(head.screen.scrollRef as unknown as (node: unknown) => void)({
        scrollTo: ({ y }: { y: number }): void => {
          offsets.push(y)
        }
      })
      await act(async () => {
        head.screen.onLayout!(layout(0, 600))
        head.pillBand.handleLayout!(layout(200, 60))
        head.content.handleLayout!(layout(260, 900))
        head.rowSection.handleLayout!(layout(0, 900))
        head.nextRow.handleLayout!(layout(600, 90))
      })
      await settle()
      expect(offsets.at(-1)).equals(600)
      expect(room()).equals(0)
      // The rows above it settle shorter: the anchor follows its row.
      await act(async () => {
        head.content.handleLayout!(layout(260, 700))
        head.nextRow.handleLayout!(layout(400, 90))
      })
      await settle()
      expect(offsets.at(-1)).equals(400)
      expect(room()).equals(0)
      // Once a finger has the page, the page is left where it is taken.
      await act(async () => {
        worklet({ eventName: 'onScrollBeginDrag' })
      })
      const taken = offsets.length
      await act(async () => {
        head.content.handleLayout!(layout(260, 600))
        head.nextRow.handleLayout!(layout(300, 90))
      })
      await settle()
      expect(offsets.length).equals(taken)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  })
})
