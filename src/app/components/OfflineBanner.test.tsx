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
    it(`is white on #6B3E00 in the ${name} theme, a refusal and a held team included`, async () => {
      const host = await draw(theme, {
        text: 'Offline · 1 edit waiting',
        refusal: 'Creating needs a connection',
        held: [
          { key: 'tem_a', text: 'A player was not saved', onPress: () => {} }
        ]
      })
      const banner = byTestId(host, 'offlineBanner')!
      expect(getComputedStyle(banner).backgroundColor).equals(rgb('#6B3E00'))
      const lines = [
        byTestId(host, 'offlineBannerText')!,
        byTestId(host, 'offlineCreateMessage')!,
        byTestId(host, 'heldTeamMessage')!.firstElementChild as HTMLElement
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

  it('opens a held team from its line', async () => {
    let opened = 0
    const host = await draw(tsBallpark, {
      held: [{ key: 'tem_a', text: 'Not saved', onPress: () => opened++ }]
    })
    await act(async () => {
      byTestId(host, 'heldTeamMessage')!.click()
    })
    expect(opened).equals(1)
  })
})
