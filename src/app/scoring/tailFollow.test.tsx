import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView
} from 'react-native'

import type { PinnedHead } from '../components/pinnedHead'
import {
  followAfterScroll,
  type PageTailFollow,
  type TailFollow,
  usePageTailFollow,
  useTailFollow
} from './tailFollow'

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  host?.remove()
  root = undefined
})

/** The hook, mounted, with a scroll view that records where it was sent. */
async function mount(): Promise<{
  tail: () => TailFollow
  scrolls: Array<{ animated?: boolean }>
}> {
  let latest: TailFollow | undefined
  const scrolls: Array<{ animated?: boolean }> = []
  function Probe(): null {
    const tail = useTailFollow()
    tail.ref.current = {
      scrollToEnd: (options?: { animated?: boolean }) => {
        scrolls.push(options ?? {})
      }
    } as unknown as React.ComponentRef<typeof ScrollView>
    latest = tail
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<Probe />)
  })
  return { tail: () => latest!, scrolls }
}

function scrolled(y: number): NativeSyntheticEvent<NativeScrollEvent> {
  const event: unknown = {
    nativeEvent: {
      contentOffset: { x: 0, y },
      contentSize: { width: 300, height: 500 },
      layoutMeasurement: { width: 300, height: 100 }
    }
  }
  return event as NativeSyntheticEvent<NativeScrollEvent>
}
/** An event a handler takes but does not read. */
const unread: unknown = {}

async function call(run: () => void): Promise<void> {
  await act(async () => {
    run()
  })
}

describe('tail follow', function () {
  it('scrolls to the end, animated, as content grows and on layout', async () => {
    const { tail, scrolls } = await mount()
    expect(tail().following).equals(true)
    await call(() => tail().scrollProps.onContentSizeChange?.(300, 500))
    await call(() => tail().scrollProps.onLayout?.(unread as never))
    expect(scrolls).deep.equals([{ animated: true }, { animated: true }])
    expect(tail().scrollProps.scrollEventThrottle).equals(16)
  })

  it('stops following on a drag and scrolls nowhere while stopped', async () => {
    const { tail, scrolls } = await mount()
    await call(() => tail().scrollProps.onScrollBeginDrag?.(unread as never))
    expect(tail().following).equals(false)
    await call(() => tail().scrollProps.onContentSizeChange?.(300, 600))
    expect(scrolls).deep.equals([])
  })

  it('stops following when scrolled up, and follows again at the bottom', async () => {
    const { tail } = await mount()
    await call(() => tail().scrollProps.onScroll?.(scrolled(400)))
    expect(tail().following).equals(true)
    await call(() => tail().scrollProps.onScroll?.(scrolled(200)))
    expect(tail().following).equals(false)
    // Half a point short of the end still counts as the end.
    await call(() => tail().scrollProps.onScroll?.(scrolled(398.5)))
    expect(tail().following).equals(true)
  })

  it('ignores a downward scroll short of the end', async () => {
    const { tail } = await mount()
    await call(() => tail().scrollProps.onScroll?.(scrolled(100)))
    await call(() => tail().scrollProps.onScroll?.(scrolled(200)))
    expect(tail().following).equals(true)
  })

  it('resumes by scrolling to the end, and resets without scrolling', async () => {
    const { tail, scrolls } = await mount()
    await call(() => tail().scrollProps.onScrollBeginDrag?.(unread as never))
    await call(() => {
      tail().resume()
    })
    expect(tail().following).equals(true)
    expect(scrolls).deep.equals([{ animated: true }])
    await call(() => tail().scrollProps.onScroll?.(scrolled(300)))
    await call(() => tail().scrollProps.onScrollBeginDrag?.(unread as never))
    await call(() => {
      tail().reset()
    })
    expect(tail().following).equals(true)
    expect(scrolls).has.length(1)
    // After a reset, a scroll from the top is not taken as scrolling up.
    await call(() => tail().scrollProps.onScroll?.(scrolled(0)))
    expect(tail().following).equals(true)
  })

  const at = (
    y: number,
    lastY: number
  ): Parameters<typeof followAfterScroll>[1] => ({
    y,
    lastY,
    viewport: 100,
    content: 500
  })

  it('follows at the end, and within two points of it', function () {
    expect(followAfterScroll(false, at(400, 0))).equals(true)
    expect(followAfterScroll(false, at(398, 0))).equals(true)
    expect(followAfterScroll(false, at(397.5, 0))).equals(false)
  })

  it('stops following when moved up, and leaves it as it was moving down short of the end', function () {
    expect(followAfterScroll(true, at(300, 302))).equals(false)
    // A point's jitter is not moving up.
    expect(followAfterScroll(true, at(300, 301))).equals(true)
    expect(followAfterScroll(true, at(300, 200))).equals(true)
    expect(followAfterScroll(false, at(300, 200))).equals(false)
  })

  /** The page hook, mounted, with a pinned head that records its ends. */
  async function mountPage(initial: { enabled: boolean }): Promise<{
    tail: () => PageTailFollow
    ends: boolean[]
    render: (enabled: boolean) => Promise<void>
  }> {
    let latest: PageTailFollow | undefined
    const ends: boolean[] = []
    const pinned: React.RefObject<PinnedHead | null> = {
      current: {
        scrollToEnd: (animated: boolean) => {
          ends.push(animated)
        }
      } as unknown as PinnedHead
    }
    function Probe(props: { enabled: boolean }): null {
      latest = usePageTailFollow({ pinned, enabled: props.enabled })
      return null
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const render = async (enabled: boolean): Promise<void> => {
      await act(async () => {
        root!.render(<Probe enabled={enabled} />)
      })
    }
    await render(initial.enabled)
    return { tail: () => latest!, ends, render }
  }

  it('scrolls the page to its end as it grows while following, and keeps no room', async function () {
    const { tail, ends } = await mountPage({ enabled: true })
    expect(tail().following).equals(true)
    expect(tail().followEnd).equals(true)
    await call(() => {
      tail().onGrow()
    })
    await call(() => {
      tail().onGrow()
    })
    expect(ends).deep.equals([false, false])
  })

  it('stops on a drag, and scrolls nowhere until resumed', async function () {
    const { tail, ends } = await mountPage({ enabled: true })
    await call(() => {
      tail().pause()
    })
    expect(tail().following).equals(false)
    expect(tail().followEnd).equals(false)
    await call(() => {
      tail().onGrow()
    })
    expect(ends).deep.equals([])
    await call(() => {
      tail().resume()
    })
    expect(tail().following).equals(true)
    expect(ends).deep.equals([true])
    await call(() => {
      tail().onGrow()
    })
    expect(ends).deep.equals([true, false])
  })

  it('stops when the page moves up, and follows again at the end by hand', async function () {
    const { tail, ends } = await mountPage({ enabled: true })
    await call(() => {
      tail().onPosition({ y: 900, end: 900 })
    })
    expect(tail().following).equals(true)
    await call(() => {
      tail().onPosition({ y: 700, end: 900 })
    })
    expect(tail().following).equals(false)
    // Down, short of the end: still stopped.
    await call(() => {
      tail().onPosition({ y: 800, end: 900 })
    })
    expect(tail().following).equals(false)
    await call(() => {
      tail().onGrow()
    })
    expect(ends).deep.equals([])
    await call(() => {
      tail().onPosition({ y: 899, end: 900 })
    })
    expect(tail().following).equals(true)
    await call(() => {
      tail().onGrow()
    })
    expect(ends).deep.equals([false])
  })

  it('does nothing while disabled', async function () {
    const { tail, ends, render } = await mountPage({ enabled: false })
    expect(tail().followEnd).equals(false)
    await call(() => {
      tail().onPosition({ y: 900, end: 900 })
      tail().onPosition({ y: 100, end: 900 })
      tail().pause()
      tail().onGrow()
    })
    expect(tail().following).equals(true)
    expect(ends).deep.equals([])
    // Enabled later, it starts out following.
    await render(true)
    expect(tail().followEnd).equals(true)
  })
})
