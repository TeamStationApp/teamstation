import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView
} from 'react-native'

import { type TailFollow, useTailFollow } from './tailFollow'

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
})
