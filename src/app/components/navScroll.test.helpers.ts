import { act, createElement, type ReactElement } from 'react'

import { NavCompactProvider, useNavCompact } from './navCompact'

function BarState(): ReactElement {
  return createElement(
    'output',
    { 'data-testid': 'nav-scroll-state' },
    useNavCompact() ? 'compact' : 'expanded'
  )
}

export function withNavScroll(screen: ReactElement): ReactElement {
  return createElement(
    NavCompactProvider,
    null,
    screen,
    createElement(BarState)
  )
}

export function scrollState(): string | undefined {
  return (
    document.querySelector('[data-testid="nav-scroll-state"]')?.textContent ??
    undefined
  )
}

/** Give the rendered RN Web scroller the geometry a phone would measure. */
export async function scrollFrom(
  child: Element | null,
  ...offsets: Array<number | 'wheel' | 'End' | 'pointer'>
): Promise<void> {
  let scroll: Element | null = child
  while (scroll != null && getComputedStyle(scroll).overflowY !== 'auto')
    scroll = scroll.parentElement
  if (scroll == null) throw new Error('Expected a vertical scroller')
  const node = scroll
  Object.defineProperties(node, {
    offsetHeight: { configurable: true, value: 300 },
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1200 }
  })
  for (const [i, offset] of offsets.entries())
    await act(async () => {
      if (typeof offset !== 'number') {
        // Chromium can advance its compositor before React receives a passive wheel.
        const afterWheel = offsets[i + 1]
        if (offset === 'wheel' && typeof afterWheel === 'number')
          node.scrollTop = afterWheel
        node.dispatchEvent(
          offset === 'wheel'
            ? new window.WheelEvent('wheel', { bubbles: true, deltaY: 500 })
            : offset === 'pointer'
              ? new window.Event('pointerdown', { bubbles: true })
              : new window.KeyboardEvent('keydown', {
                  bubbles: true,
                  key: offset
                })
        )
        return
      }
      node.scrollTop = offset
      node.dispatchEvent(new window.Event('scroll'))
      // RN Web sends the last sample at the end of its 100 ms scroll window.
      await new Promise(resolve => setTimeout(resolve, 110))
    })
}
