import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Pressable, Text } from 'react-native'

import { lstrings } from '../locales/strings'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { phoneLandscape, RotateToPortrait } from './RotateToPortrait'

describe('a phone browser held sideways while scoring', function () {
  // WCAG relative luminance of an opaque #RRGGBB colour.
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map(i => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  for (const [name, theme] of [
    ['Ballpark', tsBallpark],
    ['dark', tsDark]
  ] as const)
    it(`draws the request readably in the ${name} theme`, function () {
      // The card is opaque, so its own fill is all that is behind the text.
      const [a, b] = [
        luminance(theme.primaryTextColor),
        luminance(theme.backgroundColor)
      ].sort((x, y) => y - x)
      expect((a + 0.05) / (b + 0.05)).at.least(7)
    })

  for (const [name, view, screen, shown] of [
    ['iPhone 15 sideways', [852, 393], [852, 393], true],
    [
      'iPhone 15 sideways under Safari’s toolbars',
      [852, 283],
      [393, 852],
      true
    ],
    ['a Pixel sideways', [915, 412], [915, 412], true],
    ['iPhone 15 upright', [393, 852], [393, 852], false],
    ['iPad mini sideways', [1133, 744], [1133, 744], false],
    ['a short desktop window', [1200, 600], [1920, 1080], false],
    ['a desktop window as short as a phone', [852, 393], [1440, 900], false]
  ] as const)
    it(`${shown ? 'covers' : 'leaves'} scoring on ${name}`, function () {
      expect(
        phoneLandscape(
          { width: view[0], height: view[1] },
          { width: screen[0], height: screen[1] }
        )
      ).equals(shown)
    })

  let host: HTMLDivElement
  let root: Root
  const sized = (width: number, height: number): void => {
    for (const [target, values] of [
      [window, { innerWidth: width, innerHeight: height }],
      [window.screen, { width, height }]
    ] as const)
      for (const [key, value] of Object.entries(values))
        Object.defineProperty(target, key, { configurable: true, value })
  }
  const saved = {
    innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
    innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
    width: Object.getOwnPropertyDescriptor(window.screen, 'width'),
    height: Object.getOwnPropertyDescriptor(window.screen, 'height')
  }
  beforeEach(function () {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async function () {
    await act(async () => {
      root.unmount()
    })
    host.remove()
    for (const [target, keys] of [
      [window, ['innerWidth', 'innerHeight']],
      [window.screen, ['width', 'height']]
    ] as const)
      for (const key of keys) {
        const descriptor = saved[key]
        if (descriptor != null) Object.defineProperty(target, key, descriptor)
        else Reflect.deleteProperty(target, key)
      }
  })

  it('covers the whole page above everything, and goes when turned upright with the screen as it was', async function () {
    let pitches = 0
    sized(393, 852)
    await act(async () => {
      root.render(
        <ThemeProvider>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ball"
            onPress={() => {
              pitches += 1
            }}
          >
            <Text>Ball</Text>
          </Pressable>
          <RotateToPortrait />
        </ThemeProvider>
      )
    })
    const cover = (): HTMLElement | null =>
      document.querySelector('[data-testid="rotate-to-portrait"]')
    expect(cover()).equals(null)
    const ball = document.querySelector<HTMLElement>('[aria-label="Ball"]')!
    sized(852, 393)
    await act(async () => {
      window.dispatchEvent(new window.Event('resize'))
    })
    const shown = cover()!
    expect(shown.textContent).equals(lstrings.scoring_rotate_to_portrait)
    expect(shown.textContent).equals('Rotate to portrait to continue scoring.')
    // Outside the app's tree, last on the page and fixed over all of it, so
    // a tap anywhere lands on it rather than on a control or a sheet.
    expect(host.contains(shown)).equals(false)
    expect(shown.parentElement).equals(document.body)
    expect(document.body.lastElementChild).equals(shown)
    const style = window.getComputedStyle(shown)
    expect(style.position).equals('fixed')
    expect(Number(style.zIndex)).at.least(2147483000)
    for (const side of ['top', 'right', 'bottom', 'left'] as const)
      expect(style[side]).equals('0px')
    expect(shown.getAttribute('aria-modal')).equals('true')
    // The words sit on an opaque card in the theme's page colours.
    const card = shown.querySelector<HTMLElement>(
      '[data-testid="rotate-to-portrait-card"]'
    )!
    expect(card.textContent).equals(lstrings.scoring_rotate_to_portrait)
    expect(window.getComputedStyle(card).backgroundColor).not.equals('')
    // The screen beneath is untouched: the same button, not pressed.
    expect(document.querySelector('[aria-label="Ball"]')).equals(ball)
    expect(pitches).equals(0)
    sized(393, 852)
    await act(async () => {
      window.dispatchEvent(new window.Event('orientationchange'))
    })
    expect(cover()).equals(null)
    expect(document.querySelector('[aria-label="Ball"]')).equals(ball)
    await act(async () => {
      ball.click()
    })
    expect(pitches).equals(1)
  })
})
