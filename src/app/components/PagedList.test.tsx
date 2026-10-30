import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text, View } from 'react-native'

import { measureChatTestViewport } from '../chat/chatViews.test.helpers'
import { PagedList } from './PagedList.tsx'
import { PageScrollContext, REST_MS, usePageScrollSource } from './pageScroll'
import { TabPages } from './TabPages'

const ROW = 100
const VIEWPORT = 800

/**
 * The browser's list on Legend List's browser build, following a real element
 * of a test DOM that has no layout: the element's sizes, and a row's, are
 * stubbed, and a scroll is a `scrollTop` and its event.
 */
describe('PagedList in a browser', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined
  let page!: HTMLElement

  /** A prototype's own property, put back as it was after each test. */
  const standIns: Array<() => void> = []
  const standIn = (name: string, value: PropertyDescriptor): void => {
    const proto = HTMLElement.prototype
    const saved = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, { configurable: true, ...value })
    standIns.push(() => {
      if (saved == null) Reflect.deleteProperty(proto, name)
      else Object.defineProperty(proto, name, saved)
    })
  }
  beforeEach(function () {
    page = document.createElement('div')
    Object.defineProperties(page, {
      clientHeight: { configurable: true, value: VIEWPORT },
      clientWidth: { configurable: true, value: 390 },
      scrollTo: {
        configurable: true,
        value: ({ top }: { top: number }) => {
          page.scrollTop = top
        }
      }
    })
    document.body.append(page)
    standIns.push(measureChatTestViewport({ width: 390, height: VIEWPORT }))
    // Legend List ignores a scroll of content with no size.
    standIn('scrollHeight', { get: () => 100_000 })
    // The list stands at the top of the page's content, and each row's
    // container is `ROW` tall.
    standIn('getBoundingClientRect', {
      value(this: HTMLElement) {
        const scrolled = this === page ? 0 : page.scrollTop
        const single = this.querySelectorAll('[data-testid]').length <= 1
        return {
          top: -scrolled,
          left: 0,
          width: 390,
          height: this === page ? VIEWPORT : single ? ROW : 0
        }
      }
    })
  })

  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host = undefined
    page.remove()
    for (const restore of standIns.splice(0)) restore()
  })

  const wait = async (ms = 40): Promise<void> => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  }

  function Scroller(props: { children: React.ReactNode }): React.ReactElement {
    const source = usePageScrollSource()
    const { attachElement } = source
    React.useLayoutEffect(() => {
      attachElement(page)
    }, [attachElement])
    return (
      <PageScrollContext.Provider value={source}>
        {props.children}
      </PageScrollContext.Provider>
    )
  }

  const render = async (element: React.ReactElement): Promise<void> => {
    host = document.createElement('div')
    page.append(host)
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
  const range = (from: number, count: number): number[] =>
    Array.from({ length: count }, (_v, index) => from + index)
  const shown = (name: string): boolean =>
    document.querySelector(`[data-testid="${name}"]`) != null
  const scroll = async (top: number): Promise<void> => {
    await act(async () => {
      page.scrollTop = top
      page.dispatchEvent(new window.Event('scroll'))
    })
    await wait()
  }
  const wheel = async (): Promise<void> => {
    await act(async () => {
      page.dispatchEvent(new window.Event('wheel'))
    })
  }

  it('draws rows from the element it follows', async function () {
    await render(
      <Scroller>
        <PagedList
          data={range(0, 200)}
          keyOf={index => `row${index}`}
          estimatedItemSize={ROW}
          renderItem={index => row(`row${index}`)}
        />
      </Scroller>
    )
    expect(shown('row0')).equals(true)
    expect(shown('row120')).equals(false)
    await scroll(5000)
    expect(shown('row50')).equals(true)
    expect(shown('row120')).equals(false)
  })

  it('takes a list width', async function () {
    await render(
      <Scroller>
        <PagedList
          data={[0]}
          keyOf={String}
          estimatedItemSize={ROW}
          renderItem={() => row('only')}
          width={777}
        />
      </Scroller>
    )
    expect(host?.querySelector<HTMLElement>('div')?.style.width).equals('777px')
  })

  it('turns the browser’s scroll anchoring off while a list that loads older rows is on the element', async function () {
    let setShowing!: (showing: boolean) => void
    function Lists(): React.ReactElement {
      const [showing, set] = useState(true)
      setShowing = set
      const list = (name: string): React.ReactElement => (
        <PagedList
          key={name}
          data={[0]}
          keyOf={String}
          estimatedItemSize={ROW}
          renderItem={() => row(name)}
          onStartReached={() => undefined}
        />
      )
      return (
        <>
          {list('kept')}
          {showing ? list('second') : null}
        </>
      )
    }
    await render(
      <Scroller>
        <Lists />
      </Scroller>
    )
    expect(page.style.overflowAnchor).equals('none')
    await act(async () => {
      setShowing(false)
    })
    expect(page.style.overflowAnchor).equals('none')
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(page.style.overflowAnchor).equals('')
  })

  it('leaves the browser’s scroll anchoring alone for a list with no older rows', async function () {
    await render(
      <Scroller>
        <PagedList
          data={[0]}
          keyOf={String}
          estimatedItemSize={ROW}
          renderItem={() => row('only')}
        />
      </Scroller>
    )
    expect(page.style.overflowAnchor).equals('')
  })

  describe('kept pages', function () {
    it('loads nothing while kept, and on returning at its end loads', async function () {
      let ends = 0
      let setChosen!: (page: string) => void
      function Host(): React.ReactElement {
        const [chosen, set] = useState('list')
        setChosen = set
        return (
          <TabPages page={chosen} index={chosen === 'list' ? 0 : 1} keep>
            {chosen === 'list' ? (
              <PagedList
                data={range(0, 100)}
                keyOf={index => `row${index}`}
                estimatedItemSize={ROW}
                renderItem={index => row(`row${index}`)}
                onEndReached={() => {
                  ends++
                }}
              />
            ) : (
              <View testID="other" />
            )}
          </TabPages>
        )
      }
      await render(
        <Scroller>
          <Host />
        </Scroller>
      )
      await act(async () => {
        setChosen('other')
      })
      await wait(400)
      // In a browser a kept list still follows every scroll.
      await wheel()
      await scroll(9200)
      expect(shown('row99')).equals(true)
      expect(ends).equals(0)
      await act(async () => {
        setChosen('list')
      })
      await wait()
      expect(ends).equals(1)
    })
  })

  describe('the position keeper', function () {
    let prepend!: (count: number) => void
    let starts = 0

    function Keeper(): React.ReactElement {
      const [items, set] = useState(() =>
        range(0, 60).map(index => `row${index}`)
      )
      prepend = count => {
        set(held => [
          ...range(0, count).map(index => `older${held.length + index}`),
          ...held
        ])
      }
      return (
        <PagedList
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

    it('leaves a page an anchor moved alone: its scroll is no reader', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await scroll(3000)
      await act(async () => {
        prepend(10)
      })
      await wait()
      expect(page.scrollTop).equals(3000)
      expect(starts).equals(0)
    })

    it('holds the first row at rest, and may load older rows, after a wheel', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await wheel()
      await scroll(3000)
      await wait(REST_MS + 40)
      await act(async () => {
        prepend(10)
      })
      await wait()
      expect(page.scrollTop).equals(4000)
      await wheel()
      await scroll(200)
      expect(starts).equals(1)
    })

    it('moves nothing while the page is moving, at rest or after', async function () {
      await render(
        <Scroller>
          <Keeper />
        </Scroller>
      )
      await wheel()
      await scroll(3000)
      await act(async () => {
        prepend(10)
      })
      await wait()
      expect(page.scrollTop).equals(3000)
      await wait(REST_MS + 40)
      expect(page.scrollTop).equals(3000)
    })
  })

  it('reports where its anchored row is from the top of the parent', async function () {
    const positions: number[] = []
    await render(
      <Scroller>
        <PagedList
          data={range(0, 40)}
          keyOf={index => `row${index}`}
          estimatedItemSize={ROW}
          renderItem={index => row(`row${index}`)}
          anchorKey="row5"
          onAnchorPosition={y => {
            positions.push(y)
          }}
        />
      </Scroller>
    )
    expect(positions.at(-1)).equals(500)
  })
})
