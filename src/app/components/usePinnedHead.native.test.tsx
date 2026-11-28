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

  /**
   * A tab at its top on a phone, laid out and landed, that asks where its page
   * is: the scroll commands sent and what `onPosition` was told are kept.
   * The content is `height` tall, from 260 in the column, under a 72 header,
   * with a 30 tail and a 600 viewport.
   */
  async function landAtTop(options: {
    followEnd: boolean
    /** `scrollToEnd` asked for before anything is laid out. */
    endFirst?: boolean
  }): Promise<{
    head: () => PinnedHead
    sent: Array<{ y: number; animated?: boolean }>
    positions: Array<{ y: number; end: number }>
    room: () => number
    end: () => number
    resize: (height: number) => Promise<void>
    scroll: (y: number) => Promise<void>
    /** `scrollToEnd`, and the frame its scroll command is sent in. */
    toEnd: (animated: boolean) => Promise<void>
    wait: (ms: number) => Promise<void>
    cleanup: () => Promise<void>
  }> {
    let head!: PinnedHead
    let height = 1500
    const sent: Array<{ y: number; animated?: boolean }> = []
    const positions: Array<{ y: number; end: number }> = []
    function Harness(): React.ReactElement {
      head = usePinnedHead({
        headerHeight: 72,
        ready: true,
        tab: 'plays',
        anchorOnRow: false,
        tail: 30,
        onScroll: () => undefined,
        onPosition: at => {
          positions.push(at)
        },
        followEnd: options.followEnd
      })
      return <div />
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const layout = (y: number, h: number): never => {
      const event: unknown = {
        nativeEvent: { layout: { x: 0, y, width: 390, height: h } }
      }
      return event as never
    }
    const room = (): number => (head.spacer.style as { height: number }).height
    const bottom = (): number => 72 + 260 + height + 30
    const wait = async (ms: number): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms))
      })
    }
    const scroll = async (y: number): Promise<void> => {
      await act(async () => {
        const handler = head.screen.onScroll as unknown as {
          workletEventHandler: { worklet: (event: unknown) => void }
        }
        handler.workletEventHandler.worklet({
          eventName: 'onScroll',
          contentOffset: { x: 0, y },
          contentSize: { width: 390, height: bottom() + room() },
          layoutMeasurement: { width: 390, height: 600 }
        })
      })
    }
    await act(async () => {
      root.render(<Harness />)
    })
    ;(head.screen.scrollRef as unknown as (node: unknown) => void)({
      scrollTo: ({ y, animated }: { y: number; animated?: boolean }): void => {
        sent.push({ y, animated })
      }
    })
    if (options.endFirst === true) {
      await act(async () => {
        head.scrollToEnd(false)
      })
    }
    await act(async () => {
      head.screen.onLayout!(layout(0, 600))
      head.pillBand.handleLayout!(layout(200, 60))
      head.content.handleLayout!(layout(260, height))
      head.spacer.handleLayout!(layout(0, room()))
    })
    // Landed, and the landing's retries over.
    await wait(1100)
    return {
      head: () => head,
      sent,
      positions,
      room,
      end: () => Math.max(200, bottom() - 600),
      resize: async next => {
        height = next
        await act(async () => {
          head.content.handleLayout!(layout(260, height))
        })
        await wait(20)
      },
      toEnd: async animated => {
        await act(async () => {
          head.scrollToEnd(animated)
        })
        await wait(20)
      },
      scroll,
      wait,
      cleanup: async () => {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    }
  }

  it('tells a screen where its page is only as it reaches its end or moves up from it', async () => {
    const page = await landAtTop({ followEnd: false })
    try {
      const end = page.end()
      for (const y of [300, 400, 500]) await page.scroll(y)
      expect(page.positions).deep.equals([])
      // At the end, and bouncing past it: told once.
      for (const y of [end, end + 1, end + 6, end]) await page.scroll(y)
      expect(page.positions).deep.equals([{ y: end, end }])
      // Flung up: told once, then nothing as it coasts.
      for (const y of [end - 100, end - 200, end - 300]) await page.scroll(y)
      expect(page.positions).deep.equals([
        { y: end, end },
        { y: end - 100, end }
      ])
      // Down, short of the end, and then to it.
      for (const y of [end - 200, end - 2]) await page.scroll(y)
      expect(page.positions).deep.equals([
        { y: end, end },
        { y: end - 100, end },
        { y: end - 2, end }
      ])
    } finally {
      await page.cleanup()
    }
  })

  it('scrolls to the end of the page, smoothly when asked', async () => {
    const page = await landAtTop({ followEnd: false })
    try {
      const end = page.end()
      await page.toEnd(false)
      expect(page.sent.at(-1)).deep.equals({ y: end, animated: false })
      expect(page.positions.at(-1)).deep.equals({ y: end, end })
      expect(page.room()).equals(0)
      await page.wait(1000)
      await page.scroll(0)
      await page.toEnd(true)
      expect(page.sent.at(-1)).deep.equals({ y: end, animated: true })
    } finally {
      await page.cleanup()
    }
  })

  it('lets go of the room kept for a page that shrank at its end, and lands on the last content', async () => {
    const page = await landAtTop({ followEnd: false })
    try {
      await page.scroll(page.end())
      const at = page.end()
      // A line collapses under the page at its end: room is kept for it.
      await page.resize(1200)
      expect(page.room()).equals(at - page.end())
      await page.toEnd(false)
      expect(page.room()).equals(0)
      expect(page.sent.at(-1)).deep.equals({ y: page.end(), animated: false })
      expect(page.positions.at(-1)).deep.equals({
        y: page.end(),
        end: page.end()
      })
      // The scroll view's pull back to the new end is not put back.
      const sent = page.sent.length
      await page.scroll(page.end())
      await page.wait(300)
      expect(page.room()).equals(0)
      expect(page.sent.slice(sent).every(({ y }) => y === page.end())).equals(
        true
      )
    } finally {
      await page.cleanup()
    }
  })

  it('keeps no room below a page that follows its end as its content shrinks', async () => {
    const page = await landAtTop({ followEnd: true })
    try {
      await page.toEnd(false)
      await page.scroll(page.end())
      // A line collapses, laid out before any scroll says so.
      await page.resize(1200)
      expect(page.room()).equals(0)
      expect(page.sent.at(-1)).deep.equals({ y: page.end(), animated: false })
      expect(page.positions.at(-1)).deep.equals({
        y: page.end(),
        end: page.end()
      })
      await page.scroll(page.end())
      await page.wait(1000)
      // A line removed, and the scroll view pulls the page back first.
      const at = page.end()
      await act(async () => {
        const handler = page.head().screen.onScroll as unknown as {
          workletEventHandler: { worklet: (event: unknown) => void }
        }
        handler.workletEventHandler.worklet({
          eventName: 'onScroll',
          contentOffset: { x: 0, y: at - 100 },
          contentSize: { width: 390, height: at - 100 + 600 },
          layoutMeasurement: { width: 390, height: 600 }
        })
      })
      await page.resize(1100)
      await page.wait(300)
      expect(page.room()).equals(0)
      expect(page.sent.at(-1)?.y).equals(page.end())
      expect(page.positions.at(-1)).deep.equals({
        y: page.end(),
        end: page.end()
      })
    } finally {
      await page.cleanup()
    }
  })

  it('waits for a pending anchor before scrolling to the end', async () => {
    const page = await landAtTop({ followEnd: false, endFirst: true })
    try {
      // Anchored at its top, then sent to its end; nothing sent it back.
      expect(page.sent.some(({ y }) => y === 0)).equals(true)
      expect(page.sent.at(-1)).deep.equals({ y: page.end(), animated: false })
      expect(page.positions.at(-1)).deep.equals({
        y: page.end(),
        end: page.end()
      })
    } finally {
      await page.cleanup()
    }
  })
})
