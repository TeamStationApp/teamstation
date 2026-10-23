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

  /**
   * A page pinned on one tab, then another tab selected and laid out until
   * it has jumped; the scroll commands sent, and how often the screen was
   * told, are kept.
   */
  async function landOnSecondTab(
    options: { fingerDown?: boolean } = {}
  ): Promise<{
    sent: number[]
    told: () => number
    landed: number
    drag: (eventName: string) => void
    cleanup: () => Promise<void>
  }> {
    let head!: PinnedHead
    let told = 0
    const sent: number[] = []
    function Harness(props: { tab: string }): React.ReactElement {
      head = usePinnedHead({
        headerHeight: 72,
        ready: true,
        tab: props.tab,
        anchorOnRow: false,
        tail: 30,
        onScroll: () => {
          told++
        }
      })
      return <div />
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const layout = (y: number, height: number): never => {
      const event: unknown = {
        nativeEvent: { layout: { x: 0, y, width: 390, height } }
      }
      return event as never
    }
    const event = (eventName: string, y: number): void => {
      const handler = head.screen.onScroll as unknown as {
        workletEventHandler: { worklet: (event: unknown) => void }
      }
      handler.workletEventHandler.worklet({
        eventName,
        contentOffset: { x: 0, y },
        contentSize: { width: 390, height: 2000 },
        layoutMeasurement: { width: 390, height: 600 }
      })
    }
    const lay = async (): Promise<void> => {
      await act(async () => {
        head.screen.onLayout!(layout(0, 600))
        head.pillBand.handleLayout!(layout(200, 60))
        head.content.handleLayout!(layout(260, 1500))
        head.spacer.handleLayout!(
          layout(0, (head.spacer.style as { height: number }).height)
        )
      })
    }
    await act(async () => {
      root.render(<Harness tab="info" />)
    })
    // Lands where it is sent, and says so the first time only, as a page
    // already in place would not.
    ;(head.screen.scrollRef as unknown as (node: unknown) => void)({
      scrollTo: ({ y }: { y: number }): void => {
        sent.push(y)
        if (sent.length === 1) event('onScroll', y)
      }
    })
    await lay()
    // Once the first tab has landed, pinned, then another tab.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000))
    })
    await act(async () => {
      event('onScroll', 300)
    })
    await act(async () => {
      // A finger on the page from before the pill was chosen, still down
      // through the jump.
      if (options.fingerDown === true) event('onScrollBeginDrag', 300)
      head.select('watch')
      root.render(<Harness tab="watch" />)
    })
    // The new tab lays out, then its room does, however long that takes.
    for (let tries = 0; tries < 20 && !sent.some(y => y > 0); tries++) {
      await lay()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
    }
    return {
      sent,
      told: () => told,
      landed: sent.find(y => y > 0) ?? 0,
      drag: eventName => {
        event(eventName, sent.find(y => y > 0) ?? 0)
      },
      cleanup: async () => {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    }
  }

  it('writes the landed offset again with a scroll, then tells the screen, though the page sent none', async () => {
    const page = await landOnSecondTab()
    try {
      expect(page.landed).greaterThan(0)
      const before = page.told()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1200))
      })
      // A pixel short and back, after the retries.
      expect(page.sent.slice(-2)).deep.equals([page.landed - 1, page.landed])
      expect(page.told() - before).greaterThan(0)
    } finally {
      await page.cleanup()
    }
  })

  it('leaves a page a finger was already on as it jumped', async () => {
    const page = await landOnSecondTab({ fingerDown: true })
    try {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1200))
      })
      expect(page.landed).greaterThan(0)
      expect(page.sent).not.includes(page.landed - 1)
    } finally {
      await page.cleanup()
    }
  })

  it('leaves a page a finger took after it landed, coasting or not', async () => {
    const page = await landOnSecondTab()
    try {
      // Flicked and let go before the landing is over: still coasting.
      await act(async () => {
        page.drag('onScrollBeginDrag')
        page.drag('onScrollEndDrag')
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 1200))
      })
      expect(page.sent).not.includes(page.landed - 1)
    } finally {
      await page.cleanup()
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
