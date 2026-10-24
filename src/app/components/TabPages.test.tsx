/* eslint-disable @typescript-eslint/unbound-method -- Retain accessibility functions for restoration. */
import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, createRef, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Text, View } from 'react-native'

import {
  type FrameClock,
  installFrameClock,
  translationOf
} from '../../test/frameClock'
import { ThemeProvider } from '../theme/ThemeContext'
import { Screen } from './Screen'
import {
  ActiveView,
  PAGE_MS,
  pageDirection,
  TabPages,
  useActiveRef,
  usePageActive
} from './TabPages'

describe('tab pages', function () {
  const query = AccessibilityInfo.isReduceMotionEnabled
  const subscribe = AccessibilityInfo.addEventListener
  const WIDTH = 402
  let root: Root | undefined
  let host: HTMLDivElement
  let clock: FrameClock
  const mounts = new Map<string, number>()
  const actives = new Map<string, boolean>()

  function Page(props: { name: string }): React.ReactElement {
    actives.set(props.name, usePageActive())
    useEffect(() => {
      mounts.set(props.name, (mounts.get(props.name) ?? 0) + 1)
    }, [props.name])
    return <Text>{props.name}</Text>
  }

  function sizeWindow(w: number, h: number): void {
    for (const [name, value] of [
      ['clientWidth', w],
      ['clientHeight', h]
    ] as const)
      Object.defineProperty(document.documentElement, name, {
        configurable: true,
        value
      })
    window.dispatchEvent(new window.Event('resize'))
  }

  async function render(
    element: React.ReactElement,
    reduced = false
  ): Promise<void> {
    AccessibilityInfo.isReduceMotionEnabled = async () => reduced
    AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
    if (root == null) {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => {
        root!.render(element)
      })
      await act(async () => {
        await Promise.resolve()
      })
      return
    }
    await act(async () => {
      root!.render(element)
    })
  }
  const pages = (
    page: string,
    index: number,
    name = page
  ): React.ReactElement => (
    <TabPages page={page} index={index}>
      <Page key={page} name={name} />
    </TabPages>
  )
  const frame = (key: string): HTMLElement | null =>
    host.querySelector<HTMLElement>(`[data-page="${key}"]`)
  const keys = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('[data-page]')].map(
      node => node.dataset.page ?? ''
    )
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      clock.advance(ms)
    })
  }

  beforeEach(() => {
    sizeWindow(WIDTH, 874)
    clock = installFrameClock()
    mounts.clear()
    actives.clear()
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    clock.restore()
    sizeWindow(0, 0)
    AccessibilityInfo.isReduceMotionEnabled = query
    AccessibilityInfo.addEventListener = subscribe
  })

  describe('page direction (U14)', function () {
    it('follows the pills’ order, neighbours or not', function () {
      expect(pageDirection(0, 1)).equals(1)
      expect(pageDirection(2, 1)).equals(-1)
      expect(pageDirection(0, 3)).equals(1)
      expect(pageDirection(3, 0)).equals(-1)
      expect(pageDirection(1, 1)).equals(0)
      expect(pageDirection(-1, 2)).equals(0)
      expect(pageDirection(2, -1)).equals(0)
    })
  })

  describe('page slides (U15)', function () {
    it('brings a page to the right in from the right, and the old one out left', async function () {
      await render(pages('videos', 0))
      expect(keys()).deep.equals(['videos'])
      expect(translationOf(frame('videos')!).x).equals(0)
      await render(pages('team', 2))
      expect(keys()).deep.equals(['videos', 'team'])
      expect(frame('team')!.dataset.pageRole).equals('incoming')
      expect(frame('videos')!.dataset.pageRole).equals('outgoing')
      await advance(96)
      const incoming = translationOf(frame('team')!).x
      const outgoing = translationOf(frame('videos')!).x
      expect(incoming).greaterThan(0)
      expect(incoming).lessThan(WIDTH)
      expect(outgoing).lessThan(0)
      expect(outgoing).greaterThan(-WIDTH)
      await advance(PAGE_MS)
      expect(keys()).deep.equals(['team'])
      expect(translationOf(frame('team')!).x).equals(0)
    })

    it('mirrors it for a page to the left', async function () {
      await render(pages('stats', 3))
      await render(pages('videos', 0))
      await advance(96)
      expect(translationOf(frame('videos')!).x).lessThan(0)
      expect(translationOf(frame('stats')!).x).greaterThan(0)
    })

    it('does not move on first mount, nor under reduced motion', async function () {
      await render(pages('team', 2), true)
      expect(keys()).deep.equals(['team'])
      await render(pages('stats', 3), true)
      expect(keys()).deep.equals(['stats'])
      expect(translationOf(frame('stats')!).x).equals(0)
    })

    it('keeps the pages’ nodes in place when a pill is reversed mid-slide', async function () {
      await render(pages('videos', 0))
      await render(pages('team', 2))
      const videos = frame('videos')
      expect(keys()).deep.equals(['videos', 'team'])
      await advance(96)
      await render(pages('videos', 0))
      expect(frame('videos')!.dataset.pageRole).equals('incoming')
      expect(frame('team')!.dataset.pageRole).equals('outgoing')
      expect(keys()).deep.equals(['videos', 'team'])
      expect(frame('videos')).equals(videos)
      expect(mounts.get('videos')).equals(1)
    })

    it('keeps the arriving page’s instance when the slide ends', async function () {
      await render(pages('videos', 0))
      await render(pages('team', 2))
      await advance(PAGE_MS + 32)
      expect(mounts.get('team')).equals(1)
    })
  })

  describe('page refs (U16)', function () {
    it('points a shared object ref and callback ref at the arriving page, during and after', async function () {
      const shared = createRef<React.ComponentRef<typeof View>>()
      const seen: Array<string | null> = []
      const callback = (node: React.ComponentRef<typeof View> | null): void => {
        seen.push(
          node == null
            ? null
            : ((node as unknown as HTMLElement).textContent ?? '')
        )
      }
      function Part(props: { name: string }): React.ReactElement {
        const object = useActiveRef(shared)
        const call = useActiveRef(callback)
        return (
          <View ref={object}>
            <View ref={call}>
              <Text>{props.name}</Text>
            </View>
          </View>
        )
      }
      const element = (page: string, index: number): React.ReactElement => (
        <TabPages page={page} index={index}>
          <Part key={page} name={page} />
        </TabPages>
      )
      await render(element('videos', 0))
      await render(element('team', 2))
      expect((shared.current as unknown as HTMLElement).textContent).equals(
        'team'
      )
      await advance(PAGE_MS + 32)
      expect((shared.current as unknown as HTMLElement).textContent).equals(
        'team'
      )
      // The leaving page let go before its unmount, and nothing nulls the
      // arriving page's afterwards.
      expect(seen.at(-1)).equals('team')
    })

    it('lets go of an ActiveView’s ref in a leaving page', async function () {
      const shared = createRef<React.ComponentRef<typeof View>>()
      const element = (page: string, index: number): React.ReactElement => (
        <TabPages page={page} index={index}>
          <ActiveView key={page} ref={shared}>
            <Text>{page}</Text>
          </ActiveView>
        </TabPages>
      )
      await render(element('upcoming', 0))
      await render(element('past', 1))
      await advance(PAGE_MS + 32)
      expect((shared.current as unknown as HTMLElement).textContent).equals(
        'past'
      )
    })

    it('lets go of a Screen’s scroll and layout handlers in a leaving page', async function () {
      const onScroll = (): void => undefined
      const onLayout = (): void => undefined
      const element = (page: string, index: number): React.ReactElement => (
        <ThemeProvider>
          <TabPages page={page} index={index} fill>
            <Screen key={page} onScroll={onScroll} onLayout={onLayout}>
              <Text>{page}</Text>
            </Screen>
          </TabPages>
        </ThemeProvider>
      )
      // The scroll view's props, from the fiber above a page's text.
      const scroller = (key: string): Record<string, unknown> => {
        const node = frame(key)!
        const field = Object.keys(node).find(one =>
          one.startsWith('__reactFiber')
        )!
        let fiber = (node as unknown as Record<string, unknown>)[field] as {
          child: unknown
          memoizedProps: Record<string, unknown> | null
        } | null
        // Down the page to the first part that throttles its scroll events.
        const queue = [fiber]
        while (queue.length > 0) {
          fiber = queue.shift() as typeof fiber
          if (fiber == null) continue
          if (fiber.memoizedProps?.scrollEventThrottle != null)
            return fiber.memoizedProps
          let child = fiber.child as typeof fiber & { sibling: unknown }
          while (child != null) {
            queue.push(child)
            child = child.sibling as typeof child
          }
        }
        throw new Error(`No scroller in ${key}`)
      }
      await render(element('info', 0))
      await render(element('watch', 1))
      expect(frame('info')!.dataset.pageRole).equals('outgoing')
      expect(scroller('info').onScroll).equals(undefined)
      expect(scroller('info').onLayout).equals(undefined)
      expect(scroller('watch').onScroll).equals(onScroll)
      expect(scroller('watch').onLayout).equals(onLayout)
    })

    it('counts a page inside a leaving page as leaving', async function () {
      const element = (outer: string, inner: string): React.ReactElement => (
        <TabPages page={outer} index={outer === 'schedule' ? 0 : 1}>
          <View key={outer}>
            <TabPages page={inner} index={inner === 'upcoming' ? 0 : 1}>
              <Page key={inner} name={`${outer}:${inner}`} />
            </TabPages>
          </View>
        </TabPages>
      )
      await render(element('schedule', 'upcoming'))
      expect(actives.get('schedule:upcoming')).equals(true)
      await render(element('teams', 'upcoming'))
      expect(actives.get('schedule:upcoming')).equals(false)
      expect(actives.get('teams:upcoming')).equals(true)
    })

    it('is active outside any pages', async function () {
      await render(<Page name="alone" />)
      expect(actives.get('alone')).equals(true)
    })
  })
})
