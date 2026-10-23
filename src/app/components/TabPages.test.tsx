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
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { ThemeProvider } from '../theme/ThemeContext'
import { Screen } from './Screen'
import {
  ActiveView,
  PAGE_MS,
  pageDirection,
  SlidingContent,
  TabPages,
  useActiveRef,
  usePageActive,
  usePageHeadHidden,
  usePageSliding
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

    it('reverses from where the pages are, not from the start', async function () {
      await render(pages('videos', 0))
      await render(pages('team', 2))
      await advance(96)
      const team = translationOf(frame('team')!).x
      const videos = translationOf(frame('videos')!).x
      expect(team).greaterThan(0)
      expect(videos).lessThan(0)
      await render(pages('videos', 0))
      // The same places the moment it turns, then back the way they came.
      expect(translationOf(frame('team')!).x).closeTo(team, 1)
      expect(translationOf(frame('videos')!).x).closeTo(videos, 1)
      // A moment's hold while the pages take their new parts: where the turn
      // is read on the thread that moves them, a frame on at most.
      await advance(32)
      const held = translationOf(frame('team')!).x
      expect(held).closeTo(team, WIDTH / 10)
      await advance(16)
      expect(translationOf(frame('team')!).x).closeTo(held, 1)
      await advance(48)
      expect(translationOf(frame('team')!).x).greaterThan(held)
      expect(translationOf(frame('videos')!).x).greaterThan(videos)
      // In the rest of the time, not a whole slide's.
      await advance(PAGE_MS - 96)
      expect(keys()).deep.equals(['videos'])
      expect(translationOf(frame('videos')!).x).equals(0)
    })

    it('carries both pages on from where they are when a third pill is chosen mid-slide', async function () {
      await render(pages('videos', 0))
      await render(pages('schedule', 1))
      await advance(96)
      const schedule = translationOf(frame('schedule')!).x
      const videos = translationOf(frame('videos')!).x
      expect(schedule).greaterThan(0)
      expect(videos).lessThan(0)
      await render(pages('stats', 3))
      // The page part way in leaves from where it is; the page part way out
      // goes on out; the new page comes in from the right.
      expect(frame('schedule')!.dataset.pageRole).equals('outgoing')
      expect(translationOf(frame('schedule')!).x).closeTo(schedule, WIDTH / 10)
      expect(translationOf(frame('videos')!).x).closeTo(videos, WIDTH / 10)
      expect(translationOf(frame('stats')!).x).greaterThan(schedule)
      await advance(48)
      expect(translationOf(frame('schedule')!).x).lessThan(schedule)
      expect(translationOf(frame('videos')!).x).lessThan(videos)
      await advance(PAGE_MS)
      expect(keys()).deep.equals(['stats'])
      expect(translationOf(frame('stats')!).x).equals(0)
    })

    it('lets every page still leaving finish its way off when four pills come in quick succession', async function () {
      await render(pages('videos', 0))
      await render(pages('schedule', 1))
      await advance(64)
      await render(pages('team', 2))
      await advance(64)
      const videos = translationOf(frame('videos')!).x
      expect(videos).lessThan(0)
      // A fourth pill before the third lands: Videos, still leaving by the
      // first slide, goes on off the edge rather than vanishing.
      await render(pages('stats', 3))
      expect(frame('videos')).not.equals(null)
      expect(translationOf(frame('videos')!).x).closeTo(videos, WIDTH / 10)
      await advance(48)
      expect(translationOf(frame('videos')!).x).lessThan(videos)
      await advance(PAGE_MS)
      expect(keys()).deep.equals(['stats'])
      expect(translationOf(frame('stats')!).x).equals(0)
    })

    it('sends both pages back from where they are when a third pill is turned back', async function () {
      await render(pages('videos', 0))
      await render(pages('schedule', 1))
      await advance(96)
      await render(pages('stats', 3))
      await advance(64)
      const schedule = translationOf(frame('schedule')!).x
      const stats = translationOf(frame('stats')!).x
      const videos = translationOf(frame('videos')!).x
      expect(schedule).lessThan(0)
      expect(stats).greaterThan(0)
      // Schedule again, mid-slide: it comes back from where it is, Stats goes
      // back the way it came, and Videos runs on out.
      await render(pages('schedule', 1))
      expect(frame('schedule')!.dataset.pageRole).equals('incoming')
      expect(frame('stats')!.dataset.pageRole).equals('outgoing')
      expect(translationOf(frame('schedule')!).x).closeTo(schedule, WIDTH / 10)
      expect(translationOf(frame('stats')!).x).closeTo(stats, WIDTH / 10)
      expect(frame('videos')).not.equals(null)
      await advance(96)
      expect(translationOf(frame('schedule')!).x).greaterThan(schedule)
      expect(translationOf(frame('stats')!).x).greaterThan(stats)
      expect(translationOf(frame('videos')!).x).lessThan(videos)
      await advance(PAGE_MS)
      expect(keys()).deep.equals(['schedule'])
      expect(translationOf(frame('schedule')!).x).equals(0)
    })

    it('brings a page still trailing out back from where it is when it is chosen again', async function () {
      await render(pages('videos', 0))
      await render(pages('schedule', 1))
      await advance(16)
      await render(pages('stats', 3))
      await advance(16)
      const videos = translationOf(frame('videos')!).x
      expect(videos).lessThan(0)
      expect(videos).greaterThan(-WIDTH / 2)
      // Videos again, while it still leaves by the first slide: it turns
      // where it stands rather than jumping out to the edge.
      await render(pages('videos', 0))
      expect(frame('videos')!.dataset.pageRole).equals('incoming')
      expect(translationOf(frame('videos')!).x).closeTo(videos, WIDTH / 10)
      await advance(64)
      expect(translationOf(frame('videos')!).x).greaterThan(videos)
      await advance(PAGE_MS)
      expect(keys()).deep.equals(['videos'])
      expect(translationOf(frame('videos')!).x).equals(0)
    })

    it('keeps the arriving page’s instance when the slide ends', async function () {
      await render(pages('videos', 0))
      await render(pages('team', 2))
      await advance(PAGE_MS + 32)
      expect(mounts.get('team')).equals(1)
    })
  })

  describe('kept pages', function () {
    const kept = (page: string, index: number): React.ReactElement => (
      <TabPages page={page} index={index} keep>
        <Page key={page} name={page} />
      </TabPages>
    )
    const spinning = (key: string): boolean =>
      frame(key)?.querySelector('[aria-label="Loading"]') != null

    it('slides a page in as a spinner the first time, and draws it once it has landed', async function () {
      await render(kept('upcoming', 0))
      expect(spinning('upcoming')).equals(false)
      expect(mounts.get('upcoming')).equals(1)
      await render(kept('past', 1))
      expect(frame('past')!.dataset.pageRole).equals('incoming')
      expect(spinning('past')).equals(true)
      expect(mounts.has('past')).equals(false)
      await advance(96)
      expect(translationOf(frame('past')!).x).greaterThan(0)
      await advance(PAGE_MS)
      expect(frame('past')!.dataset.pageRole).equals('top')
      expect(spinning('past')).equals(false)
      expect(mounts.get('past')).equals(1)
    })

    it('keeps a page it has shown, hidden and inactive beside the one on show, and slides it back in', async function () {
      await render(kept('upcoming', 0))
      const upcoming = frame('upcoming')
      await render(kept('past', 1))
      await advance(PAGE_MS + 32)
      expect(keys()).deep.equals(['upcoming', 'past'])
      expect(frame('upcoming')).equals(upcoming)
      expect(frame('upcoming')!.dataset.pageRole).equals('kept')
      expect(frame('upcoming')!.style.visibility).equals('hidden')
      expect(frame('upcoming')!.getAttribute('aria-hidden')).equals('true')
      // Waiting on the side it would come back from.
      expect(translationOf(frame('upcoming')!).x).equals(-WIDTH)
      expect(actives.get('upcoming')).equals(false)
      expect(frame('past')!.dataset.pageRole).equals('top')

      await render(kept('all', 2))
      await advance(PAGE_MS + 32)
      expect(keys()).deep.equals(['upcoming', 'past', 'all'])
      expect(translationOf(frame('past')!).x).equals(-WIDTH)
      // Back across one it skips: the page it kept slides in from the left,
      // drawn as it was, not a spinner.
      await render(kept('upcoming', 0))
      expect(frame('upcoming')).equals(upcoming)
      expect(frame('upcoming')!.dataset.pageRole).equals('incoming')
      expect(spinning('upcoming')).equals(false)
      expect(frame('all')!.dataset.pageRole).equals('outgoing')
      expect(frame('past')!.dataset.pageRole).equals('kept')
      await advance(96)
      expect(translationOf(frame('upcoming')!).x).lessThan(0)
      expect(translationOf(frame('upcoming')!).x).greaterThan(-WIDTH)
      await advance(PAGE_MS)
      expect(frame('upcoming')!.dataset.pageRole).equals('top')
      expect(translationOf(frame('all')!).x).equals(WIDTH)
      expect(translationOf(frame('past')!).x).equals(WIDTH)
      expect(actives.get('upcoming')).equals(true)
      expect(mounts.get('upcoming')).equals(1)
      expect(mounts.get('past')).equals(1)
      expect(mounts.get('all')).equals(1)
    })

    it('keeps a page that never landed a spinner, its slide reversed', async function () {
      await render(kept('upcoming', 0))
      await render(kept('past', 1))
      await advance(96)
      await render(kept('upcoming', 0))
      expect(frame('past')!.dataset.pageRole).equals('outgoing')
      expect(spinning('past')).equals(true)
      await advance(PAGE_MS + 32)
      expect(frame('past')!.dataset.pageRole).equals('kept')
      expect(spinning('past')).equals(true)
      expect(mounts.has('past')).equals(false)
    })

    it('holds the leaving page’s height while a shorter one slides in', async function () {
      for (const keeping of [true, false]) {
        await render(keeping ? kept('upcoming', 0) : pages('upcoming', 0))
        const container = frame('upcoming')!.parentElement!
        // jsdom lays nothing out: the container reports, as a browser's
        // layout would, through the handler react-native-web hangs on it,
        // the height of the page on show.
        const handler = (
          container as unknown as {
            __reactLayoutHandler?: (event: unknown) => void
          }
        ).__reactLayoutHandler
        await act(async () => {
          handler?.({
            nativeEvent: { layout: { x: 0, y: 0, width: WIDTH, height: 2400 } }
          })
        })
        await render(keeping ? kept('past', 1) : pages('past', 1))
        expect(container.style.minHeight, String(keeping)).equals('2400px')
        await advance(PAGE_MS + 32)
        expect(container.style.minHeight).equals('')
        await act(async () => {
          root?.unmount()
        })
        root = undefined
        host.remove()
      }
    })

    it('hides a kept page outright under reduced motion', async function () {
      await render(kept('upcoming', 0), true)
      await render(kept('past', 1), true)
      expect(frame('past')!.dataset.pageRole).equals('top')
      expect(spinning('past')).equals(false)
      expect(frame('upcoming')!.dataset.pageRole).equals('kept')
      expect(frame('upcoming')!.style.opacity).equals('0')
      await render(kept('upcoming', 0), true)
      expect(frame('upcoming')!.style.opacity).not.equals('0')
      expect(frame('past')!.style.opacity).equals('0')
    })

    it('reads nothing on a kept page until it is chosen again', async function () {
      const reads = new Map<string, number>()
      function Reading(props: { name: string }): React.ReactElement {
        useForegroundRefresh(async () => {
          reads.set(props.name, (reads.get(props.name) ?? 0) + 1)
        })
        return <Text>{props.name}</Text>
      }
      const reading = (page: string, index: number): React.ReactElement => (
        <TabPages page={page} index={index} keep>
          <Reading key={page} name={page} />
        </TabPages>
      )
      await render(reading('upcoming', 0))
      expect(reads.get('upcoming')).equals(1)
      await render(reading('past', 1))
      await advance(PAGE_MS + 32)
      expect(reads.get('past')).equals(1)
      // Back to the app: the page on show reads, the kept one does not.
      await act(async () => {
        window.dispatchEvent(new window.Event('focus'))
      })
      expect(reads.get('past')).equals(2)
      expect(reads.get('upcoming')).equals(1)
      // Chosen again, it reads once.
      await render(reading('upcoming', 0))
      expect(reads.get('upcoming')).equals(2)
    })

    it('holds the height of a page that grew the container as it arrived', async function () {
      await render(pages('short', 0))
      const container = frame('short')!.parentElement!
      const layOut = async (height: number): Promise<void> => {
        const handler = (
          container as unknown as {
            __reactLayoutHandler?: (event: unknown) => void
          }
        ).__reactLayoutHandler
        await act(async () => {
          handler?.({
            nativeEvent: { layout: { x: 0, y: 0, width: WIDTH, height } }
          })
        })
      }
      await layOut(400)
      // A taller page: the container grows as it comes in, and no layout
      // follows when it lands.
      await render(pages('tall', 1))
      await layOut(2400)
      await advance(PAGE_MS + 32)
      // Leaving for a short page, the tall one is held whole.
      await render(pages('other', 2))
      expect(container.style.minHeight).equals('2400px')
      await advance(PAGE_MS + 32)
      // And one that landed at the height it replaced takes that height.
      await render(pages('same', 3))
      await advance(PAGE_MS + 32)
      await render(pages('other', 2))
      expect(container.style.minHeight).not.equals('')
    })

    it('lets go of what it kept once it keeps no more', async function () {
      await render(kept('upcoming', 0))
      await render(kept('past', 1))
      await advance(PAGE_MS + 32)
      await render(pages('all', 2))
      await advance(PAGE_MS + 32)
      expect(keys()).deep.equals(['all'])
    })
  })

  describe('two layouts of one screen (U18)', function () {
    const heads = new Map<string, boolean>()
    const slidings = new Map<string, boolean>()
    /** A full-height layout: a hero and pills that stay, content that slides. */
    function Layout(props: {
      name: string
      pills?: string
    }): React.ReactElement {
      heads.set(props.name, usePageHeadHidden())
      slidings.set(props.name, usePageSliding())
      return (
        <View>
          <Text>{`${props.name} hero`}</Text>
          {props.pills == null ? (
            <SlidingContent testID={`${props.name}-content`}>
              <Text>{`${props.name} content`}</Text>
            </SlidingContent>
          ) : (
            <TabPages page={props.pills} index={props.pills === 'info' ? 0 : 1}>
              <Page key={props.pills} name={props.pills} />
            </TabPages>
          )}
        </View>
      )
    }
    const screen = (page: 'watch' | 'sections'): React.ReactElement => (
      <TabPages page={page} index={page === 'watch' ? 2 : 0} fill keepHead>
        {page === 'watch' ? (
          <Layout key="watch" name="watch" />
        ) : (
          <Layout key="sections" name="sections" pills="info" />
        )}
      </TabPages>
    )
    const content = (name: string): HTMLElement =>
      host.querySelector<HTMLElement>(`[data-testid="${name}-content"]`)!
    // The sections' pill pages, which their layout carries.
    const carried = (): HTMLElement => frame('info')!.parentElement!

    beforeEach(() => {
      heads.clear()
      slidings.clear()
    })

    it('keeps both layouts in place and slides only what is under the pills', async function () {
      await render(screen('sections'))
      await render(screen('watch'))
      expect(frame('watch')!.dataset.pageRole).equals('incoming')
      expect(frame('sections')!.dataset.pageRole).equals('outgoing')
      await advance(96)
      expect(translationOf(frame('watch')!).x).equals(0)
      expect(translationOf(frame('sections')!).x).equals(0)
      const incoming = translationOf(content('watch')).x
      const outgoing = translationOf(carried()).x
      expect(incoming).greaterThan(0)
      expect(incoming).lessThan(WIDTH)
      expect(outgoing).lessThan(0)
      expect(outgoing).greaterThan(-WIDTH)
      expect(content('watch').dataset.pageRole).equals('incoming')
      expect(carried().dataset.pageRole).equals('outgoing')
      await advance(PAGE_MS)
      expect(keys()).deep.equals(['watch'])
      expect(translationOf(content('watch')).x).equals(0)
      expect(content('watch').dataset.pageRole).equals(undefined)
    })

    it('mirrors it back, the pill pages carried in from the left', async function () {
      await render(screen('watch'))
      await render(screen('sections'))
      await advance(96)
      expect(translationOf(carried()).x).lessThan(0)
      expect(translationOf(content('watch')).x).greaterThan(0)
    })

    it('stands down the leaving layout’s hero and pills, and clears both while they slide', async function () {
      await render(screen('sections'))
      expect(heads.get('sections')).equals(false)
      expect(slidings.get('sections')).equals(false)
      await render(screen('watch'))
      expect(heads.get('sections')).equals(true)
      expect(heads.get('watch')).equals(false)
      expect(slidings.get('sections')).equals(true)
      expect(slidings.get('watch')).equals(true)
      // The arriving layout's hero and pills over the leaving one's.
      expect(frame('watch')!.style.zIndex).equals('1')
      expect(frame('sections')!.style.zIndex).equals('0')
      await advance(PAGE_MS + 32)
      expect(heads.get('watch')).equals(false)
      expect(slidings.get('watch')).equals(false)
    })

    it('draws a leaving Screen clear, and an arriving one too', async function () {
      const element = (page: string): React.ReactElement => (
        <ThemeProvider>
          <TabPages page={page} index={page === 'info' ? 0 : 1} fill keepHead>
            <Screen key={page}>
              <Text>{page}</Text>
            </Screen>
          </TabPages>
        </ThemeProvider>
      )
      const background = (key: string): string => {
        // The scroller is the first part down the page that paints.
        let node = frame(key)!.firstElementChild as HTMLElement | null
        while (node?.style.backgroundColor === '')
          node = node.firstElementChild as HTMLElement | null
        return node?.style.backgroundColor ?? ''
      }
      await render(element('info'))
      const opaque = background('info')
      expect(opaque).not.equals('')
      expect(opaque).not.equals('rgba(0, 0, 0, 0)')
      await render(element('watch'))
      expect(background('info')).equals('rgba(0, 0, 0, 0)')
      expect(background('watch')).equals('rgba(0, 0, 0, 0)')
      await advance(PAGE_MS + 32)
      expect(background('watch')).equals(opaque)
    })

    it('slides the whole layouts when they keep no head in common', async function () {
      const whole = (page: 'watch' | 'sections'): React.ReactElement => (
        <TabPages page={page} index={page === 'watch' ? 2 : 0} fill>
          {page === 'watch' ? (
            <Layout key="watch" name="watch" />
          ) : (
            <Layout key="sections" name="sections" pills="info" />
          )}
        </TabPages>
      )
      await render(whole('sections'))
      await render(whole('watch'))
      await advance(96)
      expect(translationOf(frame('watch')!).x).greaterThan(0)
      expect(translationOf(frame('sections')!).x).lessThan(0)
      expect(translationOf(content('watch')).x).equals(0)
      expect(heads.get('sections')).equals(false)
      expect(slidings.get('watch')).equals(false)
      expect(frame('watch')!.style.zIndex).equals('')
    })

    it('slides nothing outside a filled page', async function () {
      await render(
        <SlidingContent testID="alone-content">
          <Text>alone</Text>
        </SlidingContent>
      )
      expect(translationOf(content('alone')).x).equals(0)
      expect(content('alone').dataset.pageRole).equals(undefined)
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

    it('lets go of an ActiveView’s layout handler in a kept page', async function () {
      const seen: string[] = []
      const element = (page: string, index: number): React.ReactElement => (
        <TabPages page={page} index={index} keep>
          <ActiveView
            key={page}
            testID={`active-${page}`}
            onLayout={() => {
              seen.push(page)
            }}
          >
            <Text>{page}</Text>
          </ActiveView>
        </TabPages>
      )
      const handlerOf = (
        page: string
      ): ((event: unknown) => void) | undefined =>
        (
          host.querySelector(`[data-testid="active-${page}"]`) as unknown as {
            __reactLayoutHandler?: (event: unknown) => void
          }
        ).__reactLayoutHandler
      await render(element('upcoming', 0))
      await render(element('past', 1))
      await advance(PAGE_MS + 32)
      expect(frame('upcoming')!.dataset.pageRole).equals('kept')
      expect(handlerOf('upcoming')).equals(undefined)
      expect(handlerOf('past')).not.equals(undefined)
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
