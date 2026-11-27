import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Dimensions, Platform } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { TestChatAge } from '../../test/chatAgeTesting'
import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark as theme } from '../theme/tsBallpark'
import { AppNav } from './AppNav'
import { AppNavCapsule, UNREAD } from './AppNavCapsule'
import { TAB_GLYPHS } from './tabGlyphs'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
describe('Search navigation', () => {
  it('keeps scaled native artwork above every label and inside the compact slots', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    const originalGet = Dimensions.get.bind(Dimensions)
    const originalOS = Platform.OS
    const window = { ...originalGet('window'), width: 393, fontScale: 3 }
    Dimensions.get = () => window
    Platform.OS = 'android'
    try {
      for (const compact of [false, true]) {
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <GestureHandlerRootView>
                <AppNavCapsule
                  mode="floating"
                  selected="schedule"
                  onSelect={() => {}}
                  bottom={21}
                  compact={compact}
                  reduced
                />
              </GestureHandlerRootView>
            </ThemeProvider>
          )
        })
        const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
        expect(tabs.length).equals(5)
        for (const tab of tabs) {
          const icon = tab.firstElementChild!.firstElementChild as HTMLElement
          const size = parseFloat(icon.style.height)
          expect(parseFloat(icon.style.width)).equals(size)
          expect(size).to.be.greaterThan(theme.rem(1.3))
          if (compact) {
            expect(size).to.be.at.most(228 / 5 - 8)
            expect(size).to.be.at.most(52 - 8)
          } else {
            const label = tab.lastElementChild as HTMLElement
            expect(label.style.position).equals('absolute')
            const top = parseFloat(tab.style.paddingTop)
            const bottom = parseFloat(tab.style.paddingBottom)
            expect(size).to.be.at.most(62 - top - bottom)
            expect(bottom).to.be.at.least(
              parseFloat(label.style.lineHeight) +
                parseFloat(label.style.bottom)
            )
          }
        }
      }
    } finally {
      Platform.OS = originalOS
      Dimensions.get = originalGet
    }
  })
  it('keeps default labels in the pill at 390, 375 and 360 points', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    const originalGet = Dimensions.get.bind(Dimensions)
    try {
      for (const reduced of [false, true])
        for (const width of [390, 375, 360]) {
          Dimensions.get = () => ({
            ...originalGet('window'),
            width,
            fontScale: 1
          })
          await act(async () => {
            root!.render(
              <ThemeProvider>
                <GestureHandlerRootView>
                  <AppNavCapsule
                    mode="floating"
                    selected="schedule"
                    onSelect={() => {}}
                    bottom={21}
                    compact={false}
                    reduced={reduced}
                  />
                </GestureHandlerRootView>
              </ThemeProvider>
            )
          })
          const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
          expect(tabs.length).equals(5)
          for (const tab of tabs) {
            const label = tab.lastElementChild as HTMLElement
            expect(label.style.position, width + ' points').not.equals(
              'absolute'
            )
            expect(Number(tab.style.paddingBottom.replace('px', ''))).equals(0)
          }
        }
    } finally {
      Dimensions.get = originalGet
    }
  })
  it('shadows the painted platter on the web and Android', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    const originalOS = Platform.OS
    const color = (value: string): string => {
      const swatch = document.createElement('div')
      swatch.style.color = value
      return swatch.style.color
    }
    try {
      for (const os of ['web', 'android'] as const)
        for (const reduced of [false, true]) {
          Platform.OS = os
          await act(async () => {
            root!.render(
              <ThemeProvider>
                <GestureHandlerRootView>
                  <AppNavCapsule
                    mode="floating"
                    selected="schedule"
                    onSelect={() => {}}
                    bottom={21}
                    compact={false}
                    reduced={reduced}
                  />
                </GestureHandlerRootView>
              </ThemeProvider>
            )
          })
          const platter = host.querySelector<HTMLElement>(
            '[data-testid="tab-bar-platter"]'
          )!
          const shell = getComputedStyle(platter.parentElement!)
          const painted = getComputedStyle(platter)
          if (os === 'web') {
            expect(painted.boxShadow).contains(color('rgba(0, 0, 0, 0.18)'))
            expect(painted.boxShadow).contains('0px 4px 12px')
          } else {
            // Android: the elevated shell carries the platter's fill.
            expect(painted.boxShadow).equals('')
            expect(shell.backgroundColor).equals(
              color(
                reduced
                  ? theme.navOpaqueBackgroundColor
                  : theme.glassFallbackColor
              )
            )
            expect(shell.borderTopLeftRadius).equals('31px')
          }
        }
    } finally {
      Platform.OS = originalOS
    }
  })
  it('says Chat is unread on the tab itself and keeps its dot findable beside it', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    const draw = async (unread: boolean, separate = false): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <GestureHandlerRootView>
              <AppNavCapsule
                mode="floating"
                selected="home"
                onSelect={() => {}}
                bottom={21}
                reduced={false}
                compact={separate}
                dots={unread ? { chat: true } : {}}
              />
            </GestureHandlerRootView>
          </ThemeProvider>
        )
      })
    }
    const tab = (id: string): HTMLElement =>
      host.querySelector<HTMLElement>('[data-testid="tab-' + id + '"]')!
    const dot = (): HTMLElement | null =>
      host.querySelector<HTMLElement>('[data-testid="chat-unread"]')

    await draw(true)
    expect(tab('chat').getAttribute('aria-valuetext')).equals(UNREAD)
    expect(tab('chat').getAttribute('aria-label')).equals('Chat')
    for (const id of ['home', 'videos', 'schedule', 'search'])
      expect(tab(id).getAttribute('aria-valuetext')).equals(null)
    // Beside the tab, in its slot: an accessible tab hides what it holds.
    expect(dot()).not.equals(null)
    expect(tab('chat').contains(dot())).equals(false)
    expect(tab('chat').parentElement!.contains(dot())).equals(true)
    expect(getComputedStyle(dot()!).pointerEvents).not.equals('auto')

    await draw(true, true)
    expect(tab('chat').getAttribute('aria-valuetext')).equals(UNREAD)
    expect(dot()).not.equals(null)

    await draw(false)
    expect(tab('chat').getAttribute('aria-valuetext')).equals(null)
    expect(dot()).equals(null)
  })

  it('updates the same mounted capsule from fallback fills to opaque colors and back', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Keep the original for restoration and call it with its window receiver.
    const original = window.matchMedia
    const query = new EventTarget() as MediaQueryList
    let reduced = false
    Object.defineProperty(query, 'matches', { get: () => reduced })
    window.matchMedia = media =>
      media === '(prefers-reduced-transparency: reduce)'
        ? query
        : original.call(window, media)
    const rgb = (color: string): string => {
      const swatch = document.createElement('div')
      swatch.style.color = color
      return swatch.style.color
    }
    const background = (id: string): string =>
      getComputedStyle(host.querySelector('[data-testid="' + id + '"]')!)
        .backgroundColor
    try {
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <AppNav mode="floating" selected="home" onSelect={() => {}} />
          </ThemeProvider>
        )
      })
      const capsule = host.querySelector('[data-testid="tab-bar-capsule"]')
      const label = (id: string): CSSStyleDeclaration => {
        const tab = host.querySelector('[data-testid="tab-' + id + '"]')!
        return getComputedStyle(tab.lastElementChild!)
      }
      const glyph = (id: string): string | null =>
        host
          .querySelector('[data-testid="tab-' + id + '"] path')!
          .getAttribute('d')
      for (const next of [false, true, false]) {
        await act(async () => {
          reduced = next
          query.dispatchEvent(new Event('change'))
        })
        expect(host.querySelector('[data-testid="tab-bar-capsule"]')).equals(
          capsule
        )
        expect(background('tab-bar-platter')).equals(
          rgb(next ? theme.navOpaqueBackgroundColor : theme.glassFallbackColor)
        )
        expect(background('tab-bar-pill')).equals(
          rgb(next ? theme.navOpaqueSelectedColor : theme.navSelectedColor)
        )
        // As on UIKit: one medium weight, the selected glyph filled.
        expect(label('home').fontWeight).equals('500')
        expect(label('videos').fontWeight).equals('500')
        expect(glyph('home')).equals(TAB_GLYPHS.home.filled)
        expect(glyph('videos')).equals(TAB_GLYPHS.videos.outlined)
        expect(
          getComputedStyle(host.querySelector('[data-testid="tab-bar-pill"]')!)
            .borderTopWidth
        ).oneOf(['', '0px'])
        expect(label('home').color).equals(
          rgb(next ? theme.navOpaqueActiveColor : theme.navTabActiveColor)
        )
        expect(label('videos').color).equals(
          rgb(next ? theme.navOpaqueInactiveColor : theme.navTabInactiveColor)
        )
      }
    } finally {
      window.matchMedia = original
    }
  })
  for (const mode of ['header', 'floating'] as const) {
    it(`makes Search a tab after Schedule in the ${mode} navigation`, async () => {
      const host = document.createElement('div')
      document.body.append(host)
      const selected: string[] = []
      root = createRoot(host)
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <AppNav
              selected="search"
              mode={mode}
              onSelect={id => selected.push(id)}
            />
          </ThemeProvider>
        )
      })
      const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
      expect(tabs.map(tab => tab.getAttribute('data-testid'))).deep.equals([
        'tab-home',
        'tab-videos',
        'tab-schedule',
        'tab-search',
        'tab-chat'
      ])
      expect(tabs.map(node => node.getAttribute('aria-label'))).deep.equals([
        'Home',
        'Videos',
        'Schedule',
        'Search',
        'Chat'
      ])
      for (const tab of tabs) {
        const label = tab.getAttribute('aria-label')!
        // Header tabs identify their icons to screen readers. Expanded phone
        // tabs also display the label beneath the icon.
        expect(tab.textContent?.includes(label)).equals(mode === 'floating')
      }
      expect(host.querySelectorAll('[role="button"]')).length(0)
      await act(async () => {
        tabs[3].click()
        tabs[2].click()
      })
      expect(selected).deep.equals(['search', 'schedule'])
    })
  }
})

describe('chat in the navigation, whatever the age answer', () => {
  for (const mode of ['header', 'floating'] as const)
    for (const access of ['ask', 'blocked', 'pending', 'allowed'] as const)
      it(`keeps Chat in the ${mode} navigation while chat is ${access}`, async () => {
        const host = document.createElement('div')
        document.body.append(host)
        const selected: string[] = []
        root = createRoot(host)
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <TestChatAge access={access}>
                <AppNav
                  selected="search"
                  mode={mode}
                  onSelect={id => selected.push(id)}
                />
              </TestChatAge>
            </ThemeProvider>
          )
        })
        const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
        expect(tabs.map(node => node.getAttribute('aria-label'))).deep.equals([
          'Home',
          'Videos',
          'Schedule',
          'Search',
          'Chat'
        ])
        await act(async () => {
          tabs[4].click()
        })
        // The tab press is the Shell's to gate; the bar only reports it.
        expect(selected).deep.equals(['chat'])
      })
})
