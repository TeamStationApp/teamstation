import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useContext, useState } from 'react'
import { AccessibilityInfo, View } from 'react-native'

import { mount, settle, unmount } from '../../test/gameFormDom'
import {
  PageScrollContext,
  type PageScrollSource
} from '../components/pageScroll'
import { TabPages } from '../components/TabPages'
import { usePinnedHead } from '../components/usePinnedHead'
import { watchLayout } from '../layout/watch'
import { GameWatchLayout } from './GameWatchLayout'

/** The props of the scroll view above a node: the layout's own scroller. */
function scroller(node: Element): Record<string, unknown> {
  const key = Object.keys(node).find(one => one.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, unknown>)[key] as {
    return: unknown
    memoizedProps: Record<string, unknown> | null
  } | null
  while (fiber != null) {
    if (fiber.memoizedProps?.scrollEventThrottle != null)
      return fiber.memoizedProps
    fiber = fiber.return as typeof fiber
  }
  throw new Error('No scroller')
}

describe('browser event pane in pill pages', function () {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored after each case.
  const query = AccessibilityInfo.isReduceMotionEnabled
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored after each case.
  const subscribe = AccessibilityInfo.addEventListener
  afterEach(async () => {
    await unmount()
    AccessibilityInfo.isReduceMotionEnabled = query
    AccessibilityInfo.addEventListener = subscribe
  })

  it('feeds the pinned head while on show, and lets go of it sliding out', async function () {
    // Motion on: the pane slides out rather than vanishing.
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
    let scrolled = 0
    let choose!: (page: string) => void
    const layout = watchLayout({
      width: 402,
      height: 874,
      chromeHeight: 108,
      aspect: 16 / 9,
      previous: 'stacked'
    })
    function Harness(): React.ReactElement {
      const [page, setPage] = useState('watch')
      choose = setPage
      const pinned = usePinnedHead({
        headerHeight: 48,
        ready: true,
        tab: 'watch',
        anchorOnRow: false,
        tail: 80,
        onScroll: () => {
          scrolled++
        }
      })
      return (
        <TabPages page={page} index={page === 'watch' ? 1 : 0} fill>
          {page === 'watch' ? (
            <GameWatchLayout
              key="watch"
              pinned={pinned}
              head={<div>Event hero</div>}
              player={<div>Picture</div>}
              description={<div>Description</div>}
              sections={<div>Event sections</div>}
              highlightList={<div>Highlights</div>}
              footer={<div>Stream</div>}
              layout={layout}
              short={layout.short}
              sideBySide={false}
              headerHeight={48}
              tabsHeight={60}
              height={874}
            />
          ) : (
            <div key="info">Info</div>
          )}
        </TabPages>
      )
    }
    await mount(<Harness />)
    // Something inside the pane's scroll view.
    const pane = (): Element =>
      [...document.querySelectorAll('[data-page="watch"] div')].find(
        node => node.textContent === 'Event sections'
      )!
    const onScroll = scroller(pane()).onScroll as (event: unknown) => void
    const before = scrolled
    await act(async () => {
      onScroll({ nativeEvent: { contentOffset: { x: 0, y: 40 } } })
    })
    expect(scrolled).greaterThan(before)
    // Info chosen: the pane slides out and stops feeding the head.
    await act(async () => {
      choose('info')
    })
    expect(
      document
        .querySelector('[data-page="watch"]')!
        .getAttribute('data-page-role')
    ).equals('outgoing')
    const leaving = scroller(pane())
    expect(leaving.onLayout).equals(undefined)
    const after = scrolled
    await act(async () => {
      ;(leaving.onScroll as (event: unknown) => void)({
        nativeEvent: { contentOffset: { x: 0, y: 80 } }
      })
    })
    expect(scrolled).equals(after)
    await settle()
  })
  it('keeps the hero and pills still while another layout of the game slides in upright, and leaves whole held sideways', async function () {
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
    let choose!: (page: string) => void
    let turn!: (sideways: boolean) => void
    function Harness(): React.ReactElement {
      const [page, setPage] = useState('watch')
      const [sideways, setSideways] = useState(false)
      choose = setPage
      turn = setSideways
      const layout = watchLayout({
        width: sideways ? 874 : 402,
        height: sideways ? 402 : 874,
        chromeHeight: 108,
        aspect: 16 / 9,
        previous: 'stacked'
      })
      const pinned = usePinnedHead({
        headerHeight: 48,
        ready: true,
        tab: 'watch',
        anchorOnRow: false,
        tail: 80,
        onScroll: () => undefined
      })
      return (
        <TabPages
          page={page}
          index={page === 'watch' ? 1 : 0}
          fill
          keepHead={!sideways}
        >
          {page === 'watch' ? (
            <GameWatchLayout
              key="watch"
              pinned={pinned}
              head={<div>Event hero</div>}
              player={<div>Picture</div>}
              description={<div>Description</div>}
              sections={<div>Event sections</div>}
              highlightList={<div>Highlights</div>}
              footer={<div>Stream</div>}
              layout={layout}
              short={layout.short}
              sideBySide={false}
              headerHeight={48}
              tabsHeight={60}
              height={sideways ? 402 : 874}
            />
          ) : (
            <div key="info">Info</div>
          )}
        </TabPages>
      )
    }
    const band = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-testid="event-pill-band"]')!
    const content = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-testid="eventTabContent"]')!
    for (const sideways of [false, true]) {
      await mount(<Harness />)
      await act(async () => {
        turn(sideways)
      })
      expect(band().textContent).equals('Event sections')
      expect(document.body.textContent!.includes('Event hero')).equals(
        !sideways
      )
      expect(band().style.opacity).not.equals('0')
      await act(async () => {
        choose('info')
      })
      // Leaving upright: its pills stand down for the arriving layout's, and
      // only what is under them moves. Sideways, with no hero to keep, the
      // layout leaves whole, pills and all.
      expect(band().style.opacity === '0').equals(!sideways)
      expect(content().dataset.pageRole).equals(
        sideways ? undefined : 'outgoing'
      )
      expect(
        document
          .querySelector('[data-page="watch"]')!
          .getAttribute('data-page-role')
      ).equals('outgoing')
      await settle()
      await unmount()
    }
  })
  it('keeps the pill band and its pills when the phone turns, upright and back', async function () {
    let turn!: (sideways: boolean) => void
    function Harness(): React.ReactElement {
      const [sideways, setSideways] = useState(false)
      turn = setSideways
      const layout = watchLayout({
        width: sideways ? 874 : 402,
        height: sideways ? 402 : 874,
        chromeHeight: 108,
        aspect: 16 / 9,
        previous: 'stacked'
      })
      const pinned = usePinnedHead({
        headerHeight: 48,
        ready: true,
        tab: 'watch',
        anchorOnRow: false,
        tail: 80,
        onScroll: () => undefined
      })
      return (
        <GameWatchLayout
          pinned={pinned}
          head={<div>Event hero</div>}
          player={<div>Picture</div>}
          description={<div>Description</div>}
          sections={<div data-testid="event-sections">Event sections</div>}
          highlightList={<div>Highlights</div>}
          footer={<div>Stream</div>}
          layout={layout}
          short={layout.short}
          sideBySide={false}
          headerHeight={48}
          tabsHeight={60}
          height={sideways ? 402 : 874}
        />
      )
    }
    const band = (): HTMLElement | null =>
      document.querySelector('[data-testid="event-pill-band"]')
    const pills = (): HTMLElement | null =>
      document.querySelector('[data-testid="event-sections"]')
    await mount(<Harness />)
    const before = { band: band(), pills: pills() }
    expect(before.band).not.equals(null)
    expect(before.pills).not.equals(null)
    for (const sideways of [true, false]) {
      await act(async () => {
        turn(sideways)
      })
      // The same nodes, not new ones: a remount would start the strip over.
      expect(band(), `sideways ${sideways}`).equals(before.band)
      expect(pills(), `sideways ${sideways}`).equals(before.pills)
      expect(document.body.textContent!.includes('Event hero')).equals(
        !sideways
      )
    }
    await settle()
    await unmount()
  })

  describe('a paged list in the highlights', function () {
    let list: PageScrollSource | undefined
    let page: PageScrollSource | undefined
    function List(): React.ReactElement {
      list = useContext(PageScrollContext)
      return <View testID="highlights" />
    }
    function Beside(): null {
      page = useContext(PageScrollContext)
      return null
    }
    function Watch(props: {
      sideways: boolean
      pagedList: boolean
    }): React.ReactElement {
      const { sideways, pagedList } = props
      const [width, height] = sideways ? [1440, 900] : [402, 874]
      const layout = watchLayout({
        width,
        height,
        chromeHeight: 108,
        aspect: 16 / 9,
        previous: sideways ? 'sideBySide' : 'stacked'
      })
      const pinned = usePinnedHead({
        headerHeight: 48,
        ready: true,
        tab: 'watch',
        anchorOnRow: false,
        tail: 80,
        onScroll: () => {}
      })
      return (
        <GameWatchLayout
          pinned={pinned}
          head={<Beside />}
          player={<div />}
          description={<div />}
          sections={<div />}
          highlightList={<List />}
          footer={<div />}
          layout={layout}
          short={layout.short}
          sideBySide={layout.mode === 'sideBySide'}
          headerHeight={48}
          tabsHeight={60}
          height={height}
          pagedList={pagedList}
        />
      )
    }

    it('follows the page upright and the pane’s own node side by side', async function () {
      await mount(<Watch sideways={false} pagedList />)
      expect(list).equals(page)
      expect(list?.element).not.equals(null)
      await unmount()
      await mount(<Watch sideways pagedList />)
      expect(list).not.equals(page)
      expect(
        (list?.element as unknown as HTMLElement).contains(
          document.querySelector('[data-testid="highlights"]')
        )
      ).equals(true)
      expect(list?.element).not.equals(page?.element)
    })

    it('has no scroller to follow without `pagedList`', async function () {
      list = undefined
      await mount(<Watch sideways pagedList={false} />)
      expect(list).equals(undefined)
    })
  })
})
