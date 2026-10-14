import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useRef } from 'react'
import { useSharedValue } from 'react-native-reanimated'

import { mount, settle, unmount } from '../../test/gameFormDom'
import type { Handoff } from '../components/handoff'
import type { PinnedHead } from '../components/pinnedHead'
import { usePinnedHead } from '../components/usePinnedHead.native'
import { watchLayout } from '../layout/watch'
import { GameWatchLayout } from './GameWatchLayout.native'
import { watchHandoff } from './gameWatchLayoutProps'

/** Deliver native layout/scroll events to the rendered component in the DOM harness. */
function handler(node: Element, name: string): unknown {
  const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, any>)[key]
  while (fiber != null) {
    if (
      fiber.memoizedProps?.[name] != null &&
      (name !== 'onScroll' ||
        fiber.memoizedProps[name].workletEventHandler != null)
    )
      return fiber.memoizedProps[name]
    fiber = fiber.return
  }
  throw new Error(`Missing native handler ${name}`)
}
describe('native event section and picture pinning', () => {
  afterEach(unmount)
  for (const [width, height] of [
    [402, 874],
    [874, 402],
    [1440, 900]
  ])
    it(`keeps sections before the same video/list at ${width}x${height}`, async () => {
      let scrolled = 0
      let measured = 0
      let head!: PinnedHead
      let handoff!: Handoff
      const layout = watchLayout({
        width,
        height,
        chromeHeight: 108,
        aspect: 16 / 9,
        previous: 'stacked'
      })
      function Harness(): React.ReactElement {
        const progress = useSharedValue(0)
        const shortWindow = useRef(layout.short)
        handoff = watchHandoff(
          {
            progress,
            ref: () => {},
            handleScroll: () => {
              measured++
              // An empty hero at the header's edge produces a half handoff.
              progress.value = 0.5
            }
          },
          shortWindow
        )
        const pinned = usePinnedHead({
          headerHeight: 48,
          ready: true,
          tab: 'watch',
          anchorOnRow: false,
          tail: 80,
          onScroll: () => {
            scrolled++
            handoff.handleScroll()
          }
        })
        head = pinned
        return (
          <GameWatchLayout
            pinned={pinned}
            head={<div>Event hero</div>}
            player={<div data-testid="fixture-player">Picture</div>}
            description={<div>Description</div>}
            sections={<div>Event sections</div>}
            highlightList={<div>Highlights</div>}
            footer={<div>Stream</div>}
            layout={layout}
            short={layout.short}
            sideBySide={layout.mode === 'sideBySide'}
            headerHeight={48}
            tabsHeight={60}
            height={height}
          />
        )
      }
      await mount(<Harness />)
      const body = document.querySelector('[data-testid="eventTabContent"]')!
      const band = document.querySelector('[data-testid="event-pill-band"]')!
      const video = document.querySelector(
        '[data-testid="event-pegged-video"]'
      )!
      const deliver = (node: Element, y: number, h: number): void => {
        const call = handler(node, 'onLayout') as (event: unknown) => void
        call({ nativeEvent: { layout: { x: 0, y, width, height: h } } })
      }
      await act(async () => {
        const viewportEvent: unknown = {
          nativeEvent: { layout: { x: 0, y: 0, width, height } }
        }
        head.screen.onLayout!(viewportEvent as never)
        deliver(band, layout.short ? 0 : 200, 60)
        deliver(body, layout.short ? 60 : 260, 1200)
        deliver(video, 0, 260)
        const list = video.nextElementSibling!
        deliver(list, layout.mode === 'sideBySide' ? 0 : 260, 1200)
        const size = handler(body, 'onContentSizeChange') as (
          width: number,
          height: number
        ) => void
        size(width, 1600)
      })
      await act(async () => {
        const spacerEvent: unknown = {
          nativeEvent: {
            layout: {
              x: 0,
              y: 0,
              width,
              height: (head.spacer.style as { height: number }).height
            }
          }
        }
        head.spacer.handleLayout!(spacerEvent as never)
      })
      await settle(100)
      expect(scrolled).greaterThan(0)
      expect(handoff.progress.value).equals(layout.short ? 1 : 0.5)
      const beforeScroll = scrolled
      handoff.progress.value = 0
      await act(async () => {
        const scroll = handler(body, 'onScroll') as {
          workletEventHandler: { worklet: (event: unknown) => void }
        }
        const event = {
          contentOffset: { x: 0, y: 500 },
          contentSize: { width, height: 1600 },
          layoutMeasurement: { width, height }
        }
        scroll.workletEventHandler.worklet({
          ...event,
          eventName: 'onScrollBeginDrag'
        })
        scroll.workletEventHandler.worklet({ ...event, eventName: 'onScroll' })
      })
      await settle()
      expect(scrolled - beforeScroll).equals(1)
      expect(handoff.progress.value).equals(layout.short ? 1 : 0.5)
      expect(measured === 0).equals(layout.short)
      expect(band.parentElement).equals(body.parentElement)
      expect(
        video.contains(document.querySelector('[data-testid="fixture-player"]'))
      ).equals(true)
      expect(document.body.textContent)
        .includes('Highlights')
        .and.includes('Description')
      expect(document.body.textContent!.includes('Event hero')).equals(
        !layout.short
      )
    })
})
