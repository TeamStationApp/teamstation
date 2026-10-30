import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useContext } from 'react'
import { Platform, View } from 'react-native'
import {
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'

import { mount, settle, unmount } from '../../test/gameFormDom'
import { HeaderSlotProvider } from './headerSlot'
import {
  PageScrollContext,
  type PageScrollListener,
  type PageScrollPublisher,
  type PageScrollSource,
  REST_MS,
  STILL_MS,
  usePageScrollSource
} from './pageScroll'
import { PageScrollView } from './PageScrollView'
import { Screen } from './Screen'
import { StickySectionLayout } from './StickySectionLayout'
import { StickySectionLayout as NativeStickySectionLayout } from './StickySectionLayout.native'

/** The source of the nearest scroller, as a list finds it. */
let seen: PageScrollSource | undefined
function Reader(): null {
  seen = useContext(PageScrollContext)
  return null
}

/** What the components above a node were given as `name`, nearest first. */
function fiberProps(node: Element, name: string): unknown[] {
  const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'))!
  let fiber = (node as unknown as Record<string, any>)[key]
  const found: unknown[] = []
  while (fiber != null) {
    if (fiber.memoizedProps?.[name] != null)
      found.push(fiber.memoizedProps[name])
    fiber = fiber.return
  }
  return found
}

/** The animation thread's handler above a node. */
function worklets(node: Element): Worklets {
  return fiberProps(node, 'onScroll').find(
    handler => (handler as Worklets).workletEventHandler != null
  ) as Worklets
}

interface Worklets {
  workletEventHandler: { worklet: (event: object) => void }
}

/** A scroll event on the animation thread. */
const event = (eventName: string, y: number): object => ({
  eventName,
  contentOffset: { x: 0, y },
  contentSize: { width: 390, height: 4000 },
  layoutMeasurement: { width: 390, height: 800 }
})

const asPhone = (): (() => void) => {
  const saved = Object.getOwnPropertyDescriptor(Platform, 'OS')!
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
  return () => {
    Object.defineProperty(Platform, 'OS', saved)
  }
}

const inHeader = (element: React.ReactElement): React.ReactElement => (
  <HeaderSlotProvider headerHeight={48} onHandoff={() => undefined}>
    {element}
  </HeaderSlotProvider>
)

describe('page scroll', function () {
  let restorePlatform: (() => void) | undefined
  afterEach(async function () {
    restorePlatform?.()
    restorePlatform = undefined
    seen = undefined
    await unmount()
  })

  describe('a source', function () {
    let source!: PageScrollPublisher
    function Source(): null {
      source = usePageScrollSource()
      return null
    }
    const heard = (active: boolean): string[] => {
      const log: string[] = []
      const listener: PageScrollListener = {
        onOffset: (offset, viewport) => {
          log.push(`offset ${offset} ${viewport}`)
        },
        onViewport: viewport => {
          log.push(`viewport ${viewport}`)
        },
        onContentSize: () => {
          log.push('content')
        },
        onBeginDrag: () => {
          log.push('begin')
        },
        onEndDrag: () => {
          log.push('end')
        },
        onReaderMoved: () => {
          log.push('moved')
        }
      }
      source.subscribe(listener, { active })
      return log
    }

    it('tells a list of a height only a scroll reports, as a side-by-side pane has', async function () {
      await mount(<Source />)
      source.resized(700)
      const log = heard(true)
      source.scrolled(10, 700)
      source.scrolled(20, 900)
      expect(log).deep.equals([
        'offset 10 700',
        'viewport 900',
        'offset 20 900'
      ])
    })

    it('tells a list on show of every scroll and all the rest', async function () {
      await mount(<Source />)
      const log = heard(true)
      source.scrolled(10, 800)
      source.scrolled(20, 0)
      source.resized(700)
      source.resized(700)
      source.contentResized()
      source.beganDrag()
      source.endedDrag()
      source.readerMoved()
      expect(log).deep.equals([
        'viewport 800',
        'offset 10 800',
        'offset 20 800',
        'viewport 700',
        'content',
        'begin',
        'moved',
        'end',
        'moved'
      ])
      expect(source.current()).deep.equals({ offset: 20, viewport: 700 })
    })

    it('tells a kept list only at rest', async function () {
      await mount(<Source />)
      source.resized(800)
      const log = heard(false)
      source.scrolled(10, 800)
      source.scrolled(20, 800)
      expect(log).deep.equals([])
      await settle(REST_MS / 2)
      source.scrolled(30, 800)
      await settle(REST_MS / 2)
      expect(log).deep.equals([])
      await settle(REST_MS)
      expect(log).deep.equals(['offset 30 800'])
    })

    it('tells a kept list at the end of a fling with no wait, once', async function () {
      await mount(<Source />)
      source.resized(800)
      const log = heard(false)
      source.scrolled(10, 800)
      source.momentumEnded()
      expect(log).deep.equals(['offset 10 800'])
      await settle(REST_MS + 50)
      expect(log.length).equals(1)
    })

    describe('motion', function () {
      const rests = (): { count: number } => {
        const heard = { count: 0 }
        source.subscribe(
          {
            onRest: () => {
              heard.count++
            }
          },
          { active: true }
        )
        return heard
      }

      it('runs from a drag to the end of its momentum', async function () {
        await mount(<Source />)
        const rest = rests()
        expect(source.moving()).equals(false)
        source.beganDrag()
        source.scrolled(100, 800)
        expect(source.moving()).equals(true)
        source.endedDrag()
        source.scrolled(200, 800)
        await settle(REST_MS / 2)
        source.scrolled(300, 800)
        await settle(REST_MS / 2)
        expect(source.moving()).equals(true)
        source.momentumEnded()
        expect(source.moving()).equals(false)
        expect(rest.count).equals(1)
      })

      it('ends a set time after a drag with no fling', async function () {
        await mount(<Source />)
        const rest = rests()
        source.beganDrag()
        source.scrolled(100, 800)
        source.endedDrag()
        await settle(REST_MS + 50)
        expect(source.moving()).equals(false)
        expect(rest.count).equals(1)
      })

      it('goes on for as long as a finger holds the page still', async function () {
        await mount(<Source />)
        const rest = rests()
        source.beganDrag()
        source.scrolled(100, 800)
        await settle(REST_MS + 50)
        expect(source.moving()).equals(true)
        expect(rest.count).equals(0)
      })

      it('counts a finger gone when it has said nothing for a while, as a cancelled touch leaves it', async function () {
        await mount(<Source />)
        const rest = rests()
        let ended = 0
        source.subscribe(
          {
            onEndDrag: () => {
              ended++
            }
          },
          { active: true }
        )
        source.beganDrag()
        source.scrolled(100, 800)
        await settle(STILL_MS + REST_MS + 50)
        expect(source.moving()).equals(false)
        expect(rest.count).equals(1)
        expect(ended).equals(1)
      })

      it('waits for a finger that goes on moving, and answers `atRest` once it stops', async function () {
        await mount(<Source />)
        source.beganDrag()
        for (let step = 0; step < 4; step++) {
          await settle(STILL_MS / 2)
          source.scrolled(100 * step, 800)
        }
        expect(source.moving()).equals(true)
        let rested = false
        source
          .atRest()
          .then(() => {
            rested = true
          })
          .catch(() => undefined)
        source.endedDrag()
        await settle(REST_MS + 50)
        expect(rested).equals(true)
        await settle(STILL_MS)
        expect(source.moving()).equals(false)
      })

      it('takes the page back in hand when a finger counted gone moves it again', async function () {
        await mount(<Source />)
        const rest = rests()
        source.beganDrag()
        source.scrolled(100, 800)
        await settle(STILL_MS + REST_MS + 50)
        expect(source.moving()).equals(false)
        source.scrolled(120, 800)
        expect(source.moving()).equals(true)
        source.endedDrag()
        await settle(REST_MS + 50)
        expect(source.moving()).equals(false)
        expect(rest.count).equals(2)
      })

      it('does not take the echo of a correction for that finger', async function () {
        await mount(<Source />)
        source.attachScroller({ scrollTo: () => undefined })
        source.beganDrag()
        source.scrolled(100, 800)
        await settle(STILL_MS + REST_MS + 50)
        source.scrollBy(500)
        source.scrolled(600, 800)
        expect(source.moving()).equals(false)
      })

      it('goes on when a finger catches a fling', async function () {
        await mount(<Source />)
        const rest = rests()
        source.beganDrag()
        source.endedDrag()
        source.beganDrag()
        source.momentumEnded()
        expect(source.moving()).equals(true)
        expect(rest.count).equals(0)
      })

      it('is not started by the app’s own scroll', async function () {
        await mount(<Source />)
        const rest = rests()
        source.scrolled(100, 800)
        expect(source.moving()).equals(false)
        await settle(REST_MS + 50)
        expect(rest.count).equals(0)
      })

      it('runs in a browser from a person’s event until scrolling stops', async function () {
        await mount(<Source />)
        const rest = rests()
        source.readerMoved()
        expect(source.moving()).equals(true)
        await settle(REST_MS / 2)
        source.scrolled(100, 800)
        await settle(REST_MS / 2 + 20)
        expect(source.moving()).equals(true)
        await settle(REST_MS)
        expect(source.moving()).equals(false)
        expect(rest.count).equals(1)
      })

      it('answers `atRest` at once at rest, and otherwise when it stops', async function () {
        await mount(<Source />)
        await source.atRest()
        source.beganDrag()
        let answered = false
        source
          .atRest()
          .then(() => {
            answered = true
          })
          .catch(() => undefined)
        await settle(10)
        expect(answered).equals(false)
        source.endedDrag()
        source.momentumEnded()
        await settle(10)
        expect(answered).equals(true)
      })
    })

    it('hears nothing once unsubscribed', async function () {
      await mount(<Source />)
      const log: number[] = []
      const stop = source.subscribe(
        {
          onOffset: offset => {
            log.push(offset)
          }
        },
        { active: true }
      )
      stop()
      source.scrolled(10, 800)
      expect(log).deep.equals([])
    })

    it('moves a phone’s scroller, and adds a correction to where it has been sent', async function () {
      await mount(<Source />)
      const moves: Array<{ y: number; animated: boolean }> = []
      const inner = {}
      expect(source.contentRef.current).equals(null)
      source.attachScroller({
        scrollTo: ({ y, animated }) => {
          moves.push({ y, animated })
        },
        getInnerViewRef: () => inner
      })
      expect(source.contentRef.current).equals(inner)
      source.scrolled(100, 800)
      source.scrollBy(50)
      source.scrollBy(25)
      source.scrollTo(400, true)
      expect(moves).deep.equals([
        { y: 150, animated: false },
        { y: 175, animated: false },
        { y: 400, animated: true }
      ])
    })

    it('corrects from where it sent the page, over a report of where it had been', async function () {
      await mount(<Source />)
      const moves: number[] = []
      source.attachScroller({
        scrollTo: ({ y }) => {
          moves.push(y)
        }
      })
      source.scrolled(100, 800)
      source.scrollBy(50)
      // Written on the animation thread before that scroll reached it.
      source.scrolled(100, 800)
      source.scrollBy(25)
      expect(moves).deep.equals([150, 175])
      source.scrolled(150, 800)
      source.scrolled(175, 800)
      source.scrollBy(5)
      expect(moves.at(-1)).equals(180)
    })

    it('corrects from where a finger took the page, not where it was sent', async function () {
      await mount(<Source />)
      const moves: number[] = []
      source.attachScroller({
        scrollTo: ({ y }) => {
          moves.push(y)
        }
      })
      source.scrolled(100, 800)
      source.scrollBy(50)
      source.beganDrag()
      source.scrolled(90, 800)
      source.endedDrag()
      source.scrollBy(10)
      expect(moves.at(-1)).equals(100)
    })

    it('moves a browser’s element, and watches it once it is attached', async function () {
      await mount(<Source />)
      const element = document.createElement('div')
      Object.defineProperty(element, 'clientHeight', { value: 640 })
      await act(async () => {
        source.attachElement(element)
      })
      expect(source.element).equals(element)
      source.resized(640)
      const log = heard(true)
      element.scrollTop = 120
      element.dispatchEvent(new window.Event('scroll'))
      expect(log).deep.equals(['offset 120 640'])
      expect(source.current()).deep.equals({ offset: 120, viewport: 640 })
      source.scrollBy(30)
      expect(element.scrollTop).equals(150)
      for (const name of ['wheel', 'touchmove', 'pointerdown', 'keydown'])
        element.dispatchEvent(new window.Event(name))
      expect(log.filter(line => line === 'moved').length).equals(4)
      // An anchor's own `scrollTop` makes none of those.
      source.scrollTo(300)
      expect(log.filter(line => line === 'moved').length).equals(4)
      await unmount()
      element.dispatchEvent(new window.Event('wheel'))
      expect(log.filter(line => line === 'moved').length).equals(4)
    })
  })

  describe('a scroller that opts in', function () {
    it('leaves a Screen without `pagedList` as it was', async function () {
      const onScroll = (): void => undefined
      await mount(
        inHeader(
          <Screen onScroll={onScroll}>
            <Reader />
            <View testID="inside" />
          </Screen>
        )
      )
      const plain = document.body.innerHTML
      expect(seen).equals(undefined)
      expect(
        fiberProps(
          document.querySelector('[data-testid="inside"]')!,
          'onScroll'
        )
      ).includes(onScroll)
      await unmount()
      await mount(
        inHeader(
          <Screen onScroll={onScroll} pagedList>
            <Reader />
            <View testID="inside" />
          </Screen>
        )
      )
      expect(document.body.innerHTML).equals(plain)
      expect(seen).not.equals(undefined)
      expect(seen!.element).not.equals(null)
      expect(
        fiberProps(
          document.querySelector('[data-testid="inside"]')!,
          'onScroll'
        )
      ).includes(onScroll)
    })

    it('gives a browser’s Screen ref both the caller and the source', async function () {
      const object: { current: unknown } = { current: null }
      const called: unknown[] = []
      await mount(
        inHeader(
          <>
            <Screen scrollRef={object as never} pagedList>
              <Reader />
            </Screen>
            <Screen
              scrollRef={(node: unknown) => {
                called.push(node)
              }}
              pagedList
            >
              <View />
            </Screen>
          </>
        )
      )
      expect(object.current).not.equals(null)
      expect(called[0]).not.equals(undefined)
    })

    it('passes `pagedList` through the browser’s sticky layout', async function () {
      await mount(
        inHeader(
          <StickySectionLayout
            hero={null}
            sections={null}
            onScroll={() => undefined}
            pagedList
          >
            <Reader />
          </StickySectionLayout>
        )
      )
      expect(seen).not.equals(undefined)
    })

    it('leaves the browser’s sticky layout without it as it was', async function () {
      await mount(
        inHeader(
          <StickySectionLayout
            hero={null}
            sections={null}
            onScroll={() => undefined}
          >
            <Reader />
          </StickySectionLayout>
        )
      )
      expect(seen).equals(undefined)
    })

    it('publishes a phone’s scroll, and a plain `onScroll` still fires', async function () {
      restorePlatform = asPhone()
      const plain: number[] = []
      const log: string[] = []
      await mount(
        inHeader(
          <Screen
            pagedList
            onScroll={(event: {
              nativeEvent: { contentOffset: { y: number } }
            }) => {
              plain.push(event.nativeEvent.contentOffset.y)
            }}
          >
            <Reader />
            <View testID="inside" />
          </Screen>
        )
      )
      seen!.subscribe(
        {
          onOffset: offset => {
            log.push(`offset ${offset}`)
          },
          onBeginDrag: () => {
            log.push('begin')
          },
          onEndDrag: () => {
            log.push('end')
          },
          onReaderMoved: () => {
            log.push('moved')
          }
        },
        { active: true }
      )
      const handler = worklets(
        document.querySelector('[data-testid="inside"]')!
      )
      await act(async () => {
        const run = handler.workletEventHandler.worklet
        run(event('onScrollBeginDrag', 100))
        run(event('onScroll', 200))
        run(event('onScrollEndDrag', 200))
        run(event('onMomentumScrollEnd', 300))
      })
      await settle(20)
      expect(log).deep.equals(['begin', 'moved', 'offset 200', 'end'])
      expect(plain).deep.equals([200])
      expect(seen!.current()).deep.equals({ offset: 200, viewport: 800 })
    })

    it('joins a Reanimated `onScroll` to a phone’s publishing handler', async function () {
      restorePlatform = asPhone()
      let y = { value: 0 }
      function Host(): React.ReactElement {
        const shared = useSharedValue(0)
        y = shared
        const onScroll = useAnimatedScrollHandler(scroll => {
          shared.value = scroll.contentOffset.y
        })
        return (
          <PageScrollView onScroll={onScroll}>
            <Reader />
            <View testID="inside" />
          </PageScrollView>
        )
      }
      await mount(<Host />)
      const handler = worklets(
        document.querySelector('[data-testid="inside"]')!
      )
      await act(async () => {
        handler.workletEventHandler.worklet(event('onScroll', 250))
      })
      await settle(20)
      expect(y.value).equals(250)
      expect(seen!.current().offset).equals(250)
    })

    it('reports a phone’s layout and content size as well as the caller’s handlers', async function () {
      restorePlatform = asPhone()
      const log: string[] = []
      const ref: { current: unknown } = { current: null }
      const onLayout = (): void => {
        log.push('layout')
      }
      const onContentSizeChange = (): void => {
        log.push('content')
      }
      await mount(
        <PageScrollView
          ref={ref as never}
          onLayout={onLayout}
          onContentSizeChange={onContentSizeChange}
        >
          <Reader />
          <View testID="inside" />
        </PageScrollView>
      )
      seen!.subscribe(
        {
          onViewport: viewport => {
            log.push(`viewport ${viewport}`)
          },
          onContentSize: () => {
            log.push('source content')
          }
        },
        { active: true }
      )
      const node = document.querySelector('[data-testid="inside"]')!
      // What the scroll view was given, above which the caller's own remain.
      const layout = fiberProps(node, 'onLayout')
        .filter(handler => handler !== onLayout)
        .at(-1) as (event: object) => void
      const size = fiberProps(node, 'onContentSizeChange')
        .filter(handler => handler !== onContentSizeChange)
        .at(-1) as (width: number, height: number) => void
      await act(async () => {
        layout({ nativeEvent: { layout: { height: 700 } } })
        size(390, 4000)
      })
      expect(log).deep.equals([
        'viewport 700',
        'layout',
        'source content',
        'content'
      ])
      expect(ref.current).not.equals(null)
      expect(seen!.contentRef.current).not.equals(null)
    })

    it('stands aside for the scroller above while `inert`', async function () {
      function Nested(props: { inert: boolean }): React.ReactElement {
        return (
          <PageScrollView>
            <Outer />
            <PageScrollView inert={props.inert}>
              <Reader />
            </PageScrollView>
          </PageScrollView>
        )
      }
      let outer: PageScrollSource | undefined
      function Outer(): null {
        outer = useContext(PageScrollContext)
        return null
      }
      await mount(<Nested inert />)
      expect(seen).equals(outer)
      await unmount()
      await mount(<Nested inert={false} />)
      expect(seen).not.equals(outer)
    })

    it('publishes from the phone’s sticky layout, whose own handler still pins the band', async function () {
      restorePlatform = asPhone()
      let scrolled = 0
      await mount(
        inHeader(
          <NativeStickySectionLayout
            hero={null}
            sections={<View />}
            onScroll={() => {
              scrolled++
            }}
            pagedList
          >
            <Reader />
            <View testID="inside" />
          </NativeStickySectionLayout>
        )
      )
      const handler = worklets(
        document.querySelector('[data-testid="inside"]')!
      )
      await act(async () => {
        handler.workletEventHandler.worklet(event('onScroll', 150))
      })
      await settle(20)
      expect(seen!.current().offset).equals(150)
      expect(scrolled).equals(1)
    })

    it('keeps the phone’s sticky layout without it as it was', async function () {
      await mount(
        inHeader(
          <NativeStickySectionLayout
            hero={null}
            sections={<View />}
            onScroll={() => undefined}
          >
            <Reader />
          </NativeStickySectionLayout>
        )
      )
      expect(seen).equals(undefined)
    })
  })
})
