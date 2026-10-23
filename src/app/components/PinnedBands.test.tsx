import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, type LayoutChangeEvent, Text } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { PinnedContent } from './PinnedBands'
import type { PinnedHead } from './pinnedHead'
import { TabPages } from './TabPages'

interface Fiber {
  return: Fiber | null
  memoizedProps: Record<string, unknown> | null
}

/** The nearest React element above a DOM node that takes `onLayout`. */
function layoutHandler(
  node: Element,
  skip = 0
): ((event: LayoutChangeEvent) => void) | undefined {
  const key = Object.keys(node).find(one => one.startsWith('__reactFiber'))!
  let fiber: Fiber | null = (node as unknown as Record<string, unknown>)[
    key
  ] as Fiber
  let found = 0
  while (fiber != null) {
    const handler = fiber.memoizedProps?.onLayout
    if (typeof handler === 'function' && found++ === skip)
      return handler as (event: LayoutChangeEvent) => void
    fiber = fiber.return
  }
  return undefined
}

function layout(y: number, height = 300): LayoutChangeEvent {
  return {
    nativeEvent: { layout: { x: 0, y, width: 402, height } }
  } as unknown as LayoutChangeEvent
}

describe('pinned content in pill pages', function () {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored after each case.
  const query = AccessibilityInfo.isReduceMotionEnabled
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored after each case.
  const subscribe = AccessibilityInfo.addEventListener
  let root: Root | undefined
  let host: HTMLDivElement
  const seen: number[] = []
  const part: PinnedHead['content'] = {
    handleLayout: event => {
      seen.push(event.nativeEvent.layout.y)
    }
  }

  async function render(page: string, index: number): Promise<void> {
    // Motion on: a page slides out rather than vanishing.
    AccessibilityInfo.isReduceMotionEnabled = async () => false
    AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
    if (root == null) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <TabPages page={page} index={index}>
            <PinnedContent key={page} part={part} testID={`content-${page}`}>
              <Text>{page}</Text>
            </PinnedContent>
          </TabPages>
        </ThemeProvider>
      )
    })
  }
  const content = (page: string): Element =>
    host.querySelector(`[data-testid="content-${page}"]`)!

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    seen.length = 0
    AccessibilityInfo.isReduceMotionEnabled = query
    AccessibilityInfo.addEventListener = subscribe
  })

  it('reports where it sits in the column, and again when its page moves', async function () {
    await render('videos', 0)
    await act(async () => {
      layoutHandler(content('videos'))!(layout(16))
    })
    // Nothing until the pages know where they are: a report from 0 would
    // have the pinned head anchor twice.
    expect(seen).deep.equals([])
    // The pages start 120 down the column: the content is there too.
    const pages = layoutHandler(content('videos'), 1)!
    await act(async () => {
      pages(layout(120, 600))
    })
    expect(seen).deep.equals([136])
    // And again when the pages move.
    await act(async () => {
      pages(layout(140, 600))
    })
    expect(seen.at(-1)).equals(156)
  })

  it('reports again for a page that comes back mid-slide', async function () {
    await render('videos', 0)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      layoutHandler(content('videos'), 1)!(layout(0, 600))
      layoutHandler(content('videos'))!(layout(24))
    })
    expect(seen.at(-1)).equals(24)
    // Schedule, then Videos again before the slide is over: nothing about
    // the Videos page moved, so no layout event comes.
    await render('team', 2)
    await act(async () => {
      layoutHandler(content('team'))!(layout(8))
    })
    expect(seen.at(-1)).equals(8)
    await render('videos', 0)
    expect(seen.at(-1)).equals(24)
  })

  it('lets a page sliding out stop reporting', async function () {
    await render('videos', 0)
    // The motion preference settles after its promise.
    await act(async () => {
      await Promise.resolve()
    })
    await render('team', 2)
    // The leaving page's content no longer takes a layout handler of its
    // own: the nearest one above it is the pages' container.
    const leaving = layoutHandler(content('videos'))
    const arriving = layoutHandler(content('team'))
    expect(leaving).not.equals(arriving)
    await act(async () => {
      layoutHandler(content('team'), 1)!(layout(0, 600))
      arriving!(layout(8))
    })
    expect(seen.at(-1)).equals(8)
  })
})
