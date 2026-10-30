import { expect } from 'chai'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform, Text, View } from 'react-native'

import type { Page } from '../../common/api'
import { measureChatTestViewport } from '../chat/chatViews.test.helpers'
import { usePagedList } from '../hooks/usePagedList'
import type * as Native from './PagedList.native'
import {
  PageScrollContext,
  type PageScrollPublisher,
  REST_MS,
  usePageScrollSource
} from './pageScroll'
import { TabPages } from './TabPages'

const ROW = 100
const TALL = 130
const VIEWPORT = 800

/**
 * The phone's list and proxy with Legend List's phone build, which the bundle
 * gives this file alone, on the new architecture, with React Native Web's
 * views standing in for the host views and every view `ROW` tall. So what is
 * proved is the wiring against Legend List's own code. No device scrolled.
 */
describe('PagedList on a phone', function () {
  let native: typeof Native
  let savedOs: PropertyDescriptor
  const unstand: Array<() => void> = []
  let root: Root | undefined
  let host: HTMLElement | undefined
  let source!: PageScrollPublisher
  /** Where the scroller was told to go. */
  let moves: number[] = []
  /** The top of the list in the scroller's content, which `measureLayout` reads. */
  let listTop = 0

  const standIn = (name: string, get: (node: HTMLElement) => number): void => {
    const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this)
      }
    })
    unstand.push(() => {
      Object.defineProperty(HTMLElement.prototype, name, saved)
    })
  }

  before(async function () {
    savedOs = Object.getOwnPropertyDescriptor(Platform, 'OS')!
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    // Read once as Legend List loads: the new architecture's `measure`.
    const fabric = globalThis as { nativeFabricUIManager?: object }
    fabric.nativeFabricUIManager = {}
    native = await import('./PagedList.native')
    Reflect.deleteProperty(fabric, 'nativeFabricUIManager')
  })

  after(function () {
    Object.defineProperty(Platform, 'OS', savedOs)
  })

  // Each test's own: other suites put these prototypes back after every test.
  beforeEach(function () {
    moves = []
    listTop = 0
    unstand.push(measureChatTestViewport({ width: 390, height: VIEWPORT }))
    standIn('offsetHeight', node =>
      node.querySelector('[data-testid^="tall"]') == null ? ROW : TALL
    )
    standIn('offsetWidth', () => 390)
    standIn('offsetTop', node => (node.dataset.proxy == null ? 0 : listTop))
  })

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    for (const restore of unstand.splice(0)) restore()
  })

  const wait = async (ms = 20): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }

  /** A scroller, already laid out, as the page's would be. */
  function Scroller(props: { children: React.ReactNode }): React.ReactElement {
    source = usePageScrollSource()
    const [content] = useState(() =>
      document.body.appendChild(document.createElement('div'))
    )
    source.attachScroller({
      scrollTo: ({ y }) => {
        moves.push(y)
      },
      getInnerViewRef: () => content
    })
    source.resized(VIEWPORT)
    return (
      <PageScrollContext.Provider value={source}>
        {props.children}
      </PageScrollContext.Provider>
    )
  }

  const render = async (element: React.ReactElement): Promise<void> => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(element)
    })
    await wait()
  }

  const row = (name: string): React.ReactElement => (
    <View testID={name} style={{ height: ROW }}>
      <Text>{name}</Text>
    </View>
  )
  const rows = (): string[] =>
    [...document.querySelectorAll('[data-testid^="row"]')].map(node =>
      node.getAttribute('data-testid')!
    )
  const shown = (name: string): boolean =>
    document.querySelector(`[data-testid="${name}"]`) != null
  const range = (from: number, count: number): number[] =>
    Array.from({ length: count }, (_v, index) => from + index)
  const scroll = async (offset: number): Promise<void> => {
    await act(async () => {
      source.scrolled(offset, VIEWPORT)
    })
    await wait()
  }
  const drag = async (offset: number): Promise<void> => {
    await act(async () => {
      source.beganDrag()
      source.scrolled(offset, VIEWPORT)
      source.endedDrag()
    })
    await wait()
  }
  /** The end of the drag's fling. */
  const rest = async (): Promise<void> => {
    await act(async () => {
      source.momentumEnded()
    })
    await wait()
  }

  describe('the page scroll proxy', function () {
    /** What Legend List would hand its scroll component, and what it heard. */
    const heard = {
      layouts: [] as Array<{ height: number; width: number; y: number }>,
      offsets: [] as number[],
      begins: 0,
      ends: 0
    }
    let proxy: { measure: (answer: (...sizes: number[]) => void) => void }
    let scrollTo: (to: { y?: number; animated?: boolean }) => void
    let node!: HTMLElement

    beforeEach(async function () {
      heard.layouts = []
      heard.offsets = []
      heard.begins = 0
      heard.ends = 0
      await render(
        <Scroller>
          <native.PageScrollProxy
            ref={(handle: unknown) => {
              proxy = handle as typeof proxy
              if (handle != null)
                ({ scrollTo } = handle as { scrollTo: typeof scrollTo })
            }}
            onLayout={event => {
              heard.layouts.push(event.nativeEvent.layout)
            }}
            onScroll={event => {
              heard.offsets.push(
                (event as { nativeEvent: { contentOffset: { y: number } } })
                  .nativeEvent.contentOffset.y
              )
            }}
            onScrollBeginDrag={() => {
              heard.begins++
            }}
            onScrollEndDrag={() => {
              heard.ends++
            }}
          >
            <View testID="inside" />
          </native.PageScrollProxy>
        </Scroller>
      )
      node = document.querySelector('[data-testid="inside"]')!.parentElement!
      node.dataset.proxy = ''
    })

    const layOut = async (height: number): Promise<void> => {
      await act(async () => {
        ;(
          node as unknown as {
            __reactLayoutHandler: (event: object) => void
          }
        ).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 12, width: 390, height } }
        })
      })
      await wait()
    }

    it('answers `measure` with the page viewport, not the height of its rows', async function () {
      const answer = await new Promise<number[]>(resolve => {
        proxy.measure((...sizes) => {
          resolve(sizes)
        })
      })
      expect(answer[2]).equals(390)
      expect(answer[3]).equals(VIEWPORT)
    })

    it('reports a layout as the page viewport, and again when that changes', async function () {
      await layOut(5000)
      expect(heard.layouts.at(-1)).deep.includes({
        y: 12,
        width: 390,
        height: VIEWPORT
      })
      await act(async () => {
        source.resized(700)
      })
      expect(heard.layouts.at(-1)?.height).equals(700)
    })

    it('reports the page offset less the list top, clamped at 0', async function () {
      listTop = 300
      await layOut(5000)
      await scroll(1000)
      expect(heard.offsets.at(-1)).equals(700)
      await scroll(100)
      expect(heard.offsets.at(-1)).equals(0)
    })

    it('adds the list top to a scroll in list coordinates', async function () {
      listTop = 300
      await layOut(5000)
      scrollTo({ y: 900, animated: false })
      expect(moves).deep.equals([1200])
      scrollTo({})
      expect(moves.at(-1)).equals(300)
    })

    it('measures the list top again when the content above it changes height', async function () {
      await layOut(5000)
      await scroll(1000)
      expect(heard.offsets.at(-1)).equals(1000)
      listTop = 450
      await act(async () => {
        source.contentResized()
      })
      await wait()
      expect(heard.offsets.at(-1)).equals(550)
      // And a later scroll is from the new top.
      await scroll(1100)
      expect(heard.offsets.at(-1)).equals(650)
    })

    it('hands a drag on the page to the scroll props Legend List gave it', async function () {
      await act(async () => {
        source.beganDrag()
        source.endedDrag()
      })
      expect(heard.begins).equals(1)
      expect(heard.ends).equals(1)
    })
  })

  describe('with Legend List', function () {
    it('draws from the viewport `measure` gives it, then rows for a mid-list offset', async function () {
      await render(
        <Scroller>
          <native.PagedList
            data={range(0, 200)}
            keyOf={index => `row${index}`}
            estimatedItemSize={ROW}
            renderItem={index => row(`row${index}`)}
          />
        </Scroller>
      )
      expect(shown('row0')).equals(true)
      await scroll(5000)
      expect(shown('row50')).equals(true)
      expect(shown('row58')).equals(true)
      expect(shown('row120')).equals(false)
      // No more than a window of rows plus the screen kept at the top.
      expect(rows().length).lessThan(40)
    })

    it('reports the end again after a load, once the reader drags, and no row twice', async function () {
      const ends: number[] = []
      let grow!: (rows: number) => void
      function Grown(): React.ReactElement {
        const [count, set] = useState(100)
        grow = set
        return (
          <native.PagedList
            data={range(0, count)}
            keyOf={index => `row${index}`}
            estimatedItemSize={ROW}
            renderItem={index => row(`row${index}`)}
            onEndReached={() => {
              ends.push(count)
            }}
          />
        )
      }
      await render(
        <Scroller>
          <Grown />
        </Scroller>
      )
      await scroll(5000)
      expect(ends).deep.equals([])
      await drag(9000)
      expect(ends).deep.equals([100])
      await act(async () => {
        grow(150)
      })
      await wait()
      await drag(13800)
      expect(ends).deep.equals([100, 150])
      expect(shown('row149')).equals(true)
    })

    it('follows the list top, however far down the page the list starts', async function () {
      listTop = 2000
      await render(
        <Scroller>
          <native.PagedList
            data={range(0, 200)}
            keyOf={index => `row${index}`}
            estimatedItemSize={ROW}
            renderItem={index => row(`row${index}`)}
          />
        </Scroller>
      )
      ;(host!.firstElementChild as HTMLElement).dataset.proxy = ''
      await act(async () => {
        source.contentResized()
      })
      await wait()
      await scroll(7000)
      expect(shown('row50')).equals(true)
      expect(shown('row70')).equals(false)
    })

    it('reports the row an anchor names from the top of the parent, on each occasion', async function () {
      const positions: number[] = []
      let anchor!: (key: string) => void
      function Anchored(): React.ReactElement {
        const [key, set] = useState('row5')
        anchor = set
        return (
          <native.PagedList
            data={range(0, 40)}
            keyOf={index => `row${index}`}
            estimatedItemSize={ROW}
            renderItem={index => row(`row${index}`)}
            anchorKey={key}
            onAnchorPosition={y => {
              positions.push(y)
            }}
          />
        )
      }
      await render(
        <Scroller>
          <Anchored />
        </Scroller>
      )
      await wait()
      await act(async () => {
        ;(
          host!.firstElementChild as unknown as {
            __reactLayoutHandler: (event: object) => void
          }
        ).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 40, width: 390, height: 4000 } }
        })
      })
      await wait()
      expect(positions.at(-1)).equals(540)
      await act(async () => {
        anchor('row9')
      })
      await wait()
      expect(positions.at(-1)).equals(940)
    })
  })

  describe('kept and sliding pages', function () {
    function Pages(props: {
      page: string
      end: () => void
      start?: () => void
    }): React.ReactElement {
      const { page, end, start } = props
      return (
        <TabPages page={page} index={page === 'list' ? 0 : 1} keep>
          {page === 'list' ? (
            <native.PagedList
              data={range(0, 100)}
              keyOf={index => `row${index}`}
              estimatedItemSize={ROW}
              renderItem={index => row(`row${index}`)}
              onEndReached={end}
              onStartReached={start}
            />
          ) : (
            <View testID="other" />
          )}
        </TabPages>
      )
    }

    it('follows only at rest while kept, loads nothing there, and loads when it arrives at its end', async function () {
      let ends = 0
      let starts = 0
      const end = (): void => {
        ends++
      }
      const start = (): void => {
        starts++
      }
      let setPage!: (page: string) => void
      function Host(): React.ReactElement {
        const [page, set] = useState('list')
        setPage = set
        return <Pages page={page} end={end} start={start} />
      }
      await render(
        <Scroller>
          <Host />
        </Scroller>
      )
      await act(async () => {
        setPage('other')
      })
      await wait(400)
      await drag(4000)
      // Not during the scroll.
      expect(shown('row40')).equals(false)
      await wait(REST_MS + 50)
      expect(shown('row40')).equals(true)
      // At the very end, at rest: nothing to load from out of sight.
      await drag(9200)
      await wait(REST_MS + 50)
      expect(shown('row99')).equals(true)
      await drag(9000)
      await wait(REST_MS + 50)
      expect(ends).equals(0)
      expect(starts).equals(0)
      expect(moves).deep.equals([])
      await act(async () => {
        setPage('list')
      })
      await wait()
      expect(ends).equals(1)
      // And from here it follows each scroll, with no wait.
      await act(async () => {
        source.scrolled(4000, VIEWPORT)
      })
      expect(shown('row40')).equals(true)
    })

    it('loads nothing on arriving away from its end', async function () {
      let ends = 0
      let setPage!: (page: string) => void
      function Host(): React.ReactElement {
        const [page, set] = useState('other')
        setPage = set
        return (
          <Pages
            page={page}
            end={() => {
              ends++
            }}
          />
        )
      }
      await render(
        <Scroller>
          <Host />
        </Scroller>
      )
      await act(async () => {
        setPage('list')
      })
      await wait(400)
      await act(async () => {
        setPage('other')
      })
      await wait(400)
      await act(async () => {
        setPage('list')
      })
      await wait()
      expect(ends).equals(0)
    })

    it('follows a list that left mid-scroll at rest, from the scroll end', async function () {
      let setPage!: (page: string) => void
      function Host(): React.ReactElement {
        const [page, set] = useState('list')
        setPage = set
        return <Pages page={page} end={() => undefined} />
      }
      await render(
        <Scroller>
          <Host />
        </Scroller>
      )
      await act(async () => {
        setPage('other')
      })
      await wait(400)
      await act(async () => {
        source.scrolled(4000, VIEWPORT)
      })
      expect(shown('row40')).equals(false)
      await act(async () => {
        source.momentumEnded()
      })
      await wait()
      expect(shown('row40')).equals(true)
    })
  })

  describe('the position keeper', function () {
    let prepend!: (rows: number, name?: string) => void
    let starts = 0

    function Keeper(): React.ReactElement {
      const [items, set] = useState(() =>
        range(0, 60).map(index => `row${index}`)
      )
      prepend = (count, name = 'older') => {
        set(held => [
          ...range(0, count).map(index => `${name}${held.length + index}`),
          ...held
        ])
      }
      return (
        <native.PagedList
          data={items}
          keyOf={key => key}
          estimatedItemSize={ROW}
          renderItem={key => row(key)}
          onStartReached={() => {
            starts++
          }}
        />
      )
    }

    beforeEach(function () {
      starts = 0
    })

    it('does nothing before the reader has moved the page', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await scroll(300)
      await act(async () => {
        prepend(10)
      })
      await wait()
      expect(starts).equals(0)
      expect(moves).deep.equals([])
    })

    it('holds the first row when a page of rows of even height is prepended', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await drag(3000)
      expect(moves).deep.equals([])
      await rest()
      await act(async () => {
        prepend(10)
      })
      await wait()
      // Legend List says nothing here: every position it holds by index is
      // unchanged, with other rows at them.
      expect(moves).deep.equals([4000])
    })

    it('loads older rows only once a person has moved the page', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await drag(2000)
      await wait()
      expect(starts).equals(0)
      await drag(600)
      expect(starts).equals(1)
    })

    it('holds it again as prepended rows are measured', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await drag(3000)
      await rest()
      await act(async () => {
        prepend(5, 'tall')
      })
      await wait()
      // The scroll the first move sends, on which the rows at the top draw.
      await scroll(3500)
      await wait(60)
      // Rows are measured a few at a time, and those not yet drawn take the
      // new average, so the page is moved more than once.
      expect(moves[0]).equals(3500)
      expect(moves.length).greaterThan(1)
      const reader = document.querySelector('[data-testid="row30"]')!
      const top = getComputedStyle(reader.parentElement!).top
      expect(moves.at(-1)).closeTo(Number.parseFloat(top), 0.51)
    })

    it('moves nothing in motion, and puts right at rest what rows landing then moved', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await drag(3000)
      await act(async () => {
        prepend(10)
      })
      await wait()
      await scroll(3100)
      expect(moves).deep.equals([])
      await rest()
      await wait()
      expect(moves).deep.equals([3100 + 10 * ROW])
    })

    it('holds an older page that arrives in motion until rest, then keeps the row', async function () {
      const answers: Array<(page: Page<string>) => void> = []
      function Older(): React.ReactElement {
        const list = usePagedList<string>({
          listKey: 'older',
          keyOf: key => key,
          read: async cursor =>
            cursor == null
              ? {
                  items: range(10, 60).map(index => `row${index}`),
                  nextCursor: null,
                  prevCursor: 'older',
                  anchorId: null,
                  counts: null
                }
              : await new Promise(resolve => {
                  answers.push(resolve)
                })
        })
        return (
          <native.PagedList
            data={list.rows}
            keyOf={key => key}
            estimatedItemSize={ROW}
            renderItem={key => row(key)}
            onStartReached={atRest => {
              list.loadOlder(atRest).catch(() => undefined)
            }}
          />
        )
      }
      await render(
        <Scroller>
          <Older />
        </Scroller>
      )
      await wait()
      await drag(2000)
      await wait()
      await drag(600)
      await act(async () => {
        answers.shift()?.({
          items: range(0, 10).map(index => `row${index}`),
          nextCursor: null,
          prevCursor: null,
          anchorId: null,
          counts: null
        })
      })
      await wait()
      expect(moves).deep.equals([])
      expect(shown('row0')).equals(false)
      await rest()
      await wait()
      expect(moves).deep.equals([1600])
      expect(answers).deep.equals([])
    })

    it('stands down while the list is kept', async function () {
      let setPage!: (page: string) => void
      function Host(): React.ReactElement {
        const [page, set] = useState('list')
        setPage = set
        return (
          <TabPages page={page} index={page === 'list' ? 0 : 1} keep>
            {page === 'list' ? <Keeper /> : <View testID="other" />}
          </TabPages>
        )
      }
      await render(
        <Scroller>
          <Host />
        </Scroller>
      )
      await drag(3000)
      await act(async () => {
        setPage('other')
      })
      await wait(400)
      await act(async () => {
        prepend(10)
      })
      await wait()
      expect(moves).deep.equals([])
    })
  })

  it('throws with no scroller above it', async function () {
    const quiet = console.error
    console.error = () => undefined
    let caught: unknown
    class Boundary extends React.Component<
      { children: React.ReactNode },
      { failed: boolean }
    > {
      override state = { failed: false }

      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true }
      }

      override componentDidCatch(error: unknown): void {
        caught = error
      }

      override render(): React.ReactNode {
        return this.state.failed ? null : this.props.children
      }
    }
    await render(
      <Boundary>
        <native.PagedList
          data={[]}
          keyOf={String}
          estimatedItemSize={ROW}
          renderItem={() => null}
        />
      </Boundary>
    )
    console.error = quiet
    expect(String(caught)).includes('needs a scroller')
  })
})
