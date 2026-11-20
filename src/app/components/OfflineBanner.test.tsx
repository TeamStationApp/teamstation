import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ScopedThemeProvider, type Theme } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import {
  OFFLINE_BANNER_BACKGROUND,
  OFFLINE_BANNER_TEXT,
  OfflineBanner,
  type OfflineBannerProps
} from './OfflineBanner'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function draw(
  theme: Theme,
  props: OfflineBannerProps
): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ScopedThemeProvider theme={theme}>
        <OfflineBanner {...props} />
      </ScopedThemeProvider>
    )
  })
  return host
}

/** `#RRGGBB` as the browser reports a computed colour. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

/** Whether a line is drawn underlined, however the web writes it. */
const underlined = (node: HTMLElement): boolean => {
  const style = getComputedStyle(node)
  return `${style.textDecorationLine} ${style.textDecoration}`.includes(
    'underline'
  )
}

const byTestId = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`)

describe('the offline banner', () => {
  it('fixes the fill and the text colour', () => {
    expect(OFFLINE_BANNER_BACKGROUND).equals('#6B3E00')
    expect(OFFLINE_BANNER_TEXT).equals('#ffffff')
  })

  for (const [name, theme] of [
    ['ballpark', tsBallpark],
    ['dark', tsDark]
  ] as const) {
    it(`is white on #6B3E00 in the ${name} theme, a refusal and a line that opens the held list included`, async () => {
      const host = await draw(theme, {
        text: '1 edit not sent',
        refusal: 'Creating needs a connection',
        onOpenHeld: () => {}
      })
      const banner = byTestId(host, 'offlineBanner')!
      expect(getComputedStyle(banner).backgroundColor).equals(rgb('#6B3E00'))
      const lines = [
        byTestId(host, 'offlineBannerText')!,
        byTestId(host, 'offlineCreateMessage')!
      ]
      for (const line of lines)
        expect(getComputedStyle(line).color, line.textContent!).equals(
          rgb('#ffffff')
        )
    })
  }

  it('draws nothing with nothing to say', async () => {
    const host = await draw(tsBallpark, {})
    expect(byTestId(host, 'offlineBanner')).equals(null)
  })

  it('takes the place the shell gives it, and reports its height', async () => {
    const heights: number[] = []
    const host = await draw(tsBallpark, {
      text: 'Offline',
      style: { position: 'absolute', bottom: 34 },
      onLayout: height => heights.push(height)
    })
    const banner = byTestId(host, 'offlineBanner')! as HTMLElement & {
      __reactLayoutHandler?: (event: object) => void
    }
    expect(getComputedStyle(banner).position).equals('absolute')
    expect(getComputedStyle(banner).bottom).equals('34px')
    await act(async () => {
      banner.__reactLayoutHandler?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 40 } }
      })
    })
    expect(heights).deep.equals([40])
  })

  it('opens the held list from its line, a button labelled for it', async () => {
    let opened = 0
    const host = await draw(tsBallpark, {
      text: '2 edits not sent',
      onOpenHeld: () => opened++
    })
    const button = byTestId(host, 'offlineBannerButton')!
    expect(button.getAttribute('role')).equals('button')
    expect(button.getAttribute('aria-label')).equals('Edits not sent')
    expect(underlined(byTestId(host, 'offlineBannerText')!)).equals(true)
    await act(async () => {
      button.click()
    })
    expect(opened).equals(1)
  })

  it('keeps the line plain text with nothing held', async () => {
    const host = await draw(tsBallpark, { text: 'Sending 1 edit…' })
    expect(byTestId(host, 'offlineBannerButton')).equals(null)
    expect(byTestId(host, 'offlineBannerText')!.textContent).equals(
      'Sending 1 edit…'
    )
    expect(underlined(byTestId(host, 'offlineBannerText')!)).equals(false)
  })
})
