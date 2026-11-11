import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform, Text } from 'react-native'

import { ScopedThemeProvider, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import {
  PLAYER_POSITION_SPOTS,
  PlayerPositionField
} from './PlayerPositionField'
import { RosterSelector } from './RosterSelector'
import { ScoringPill } from './ScoringPill'
import { ScoringPlayerCard, scoringPlayerCardStyle } from './ScoringPlayerCard'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import { scoringSheetTheme } from './scoringSheetTheme'

let root: Root | undefined
const node = (label: string): HTMLElement =>
  document.querySelector(`[aria-label="${label}"]`)!
const css = (el: HTMLElement): CSSStyleDeclaration =>
  window.getComputedStyle(el)
const mount = async (children: React.ReactNode): Promise<void> => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{children}</ThemeProvider>)
  })
}

describe('scoring UI polish', () => {
  it('reserves footer clearance in a non-scrolling sheet', async () => {
    await mount(
      <ScoringSheet
        title="Correction"
        scroll={false}
        onClose={() => undefined}
        footer={<ScoringButton label="Apply" onPress={() => undefined} />}
      >
        <Text>Last row</Text>
      </ScoringSheet>
    )
    const footer = document.querySelector<HTMLElement>(
      '[data-testid="Scoring sheet footer"]'
    )!
    await act(async () => {
      ;(
        footer as HTMLElement & {
          __reactLayoutHandler: (event: unknown) => void
        }
      ).__reactLayoutHandler({
        nativeEvent: { layout: { x: 0, y: 0, width: 350, height: 80 } }
      })
    })
    const content = document.querySelector<HTMLElement>(
      '[data-testid="Scoring sheet content"]'
    )!
    expect(content.style.paddingBottom).equals('92px')
    expect(content.contains(node('Apply'))).equals(false)
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('shares the defensive card idle/active fill, border and radius with tappable and drag-hosted cards', async () => {
    const theme = scoringSheetTheme(tsBallpark)
    expect(scoringPlayerCardStyle(theme)).includes({
      backgroundColor: theme.scoringSurface.idle,
      borderColor: theme.scoringSurface.divider,
      borderWidth: 1,
      borderRadius: 12
    })
    expect(scoringPlayerCardStyle(theme, true).backgroundColor).equals(
      theme.scoringSurface.active
    )
    let taps = 0
    await mount(
      <ScoringPlayerCard
        label="Choose Mike Trout"
        name="Mike Trout #27"
        width="48%"
        onPress={() => {
          taps++
        }}
      />
    )
    expect(css(node('Choose Mike Trout')).borderTopWidth).equals('1px')
    expect(css(node('Choose Mike Trout')).borderTopLeftRadius).equals('12px')
    expect(node('Choose Mike Trout').textContent).equals('Mike Trout #27')
    await act(async () => {
      node('Choose Mike Trout').click()
    })
    expect(taps).equals(1)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScoringPlayerCard
            label="Unavailable"
            selected
            disabled
            onPress={() => {
              taps++
            }}
          >
            <Text>Position badge</Text>
          </ScoringPlayerCard>
        </ThemeProvider>
      )
    })
    await act(async () => {
      node('Unavailable').click()
    })
    expect(taps).equals(1)
    expect(css(node('Unavailable')).opacity).equals('0.4')
  })

  it('uses equal position targets in overhead field order and a lower centered DH/EH pair', async () => {
    let chosen = ''
    await mount(
      <PlayerPositionField
        positions={['SS']}
        onToggle={value => {
          chosen = value
        }}
      />
    )
    for (const position of [
      'LF',
      'CF',
      'RF',
      '3B',
      'SS',
      '2B',
      '1B',
      'P',
      'C',
      'DH',
      'EH'
    ]) {
      const el = node(`Player position ${position}`)
      expect(css(el).width, position).equals('48px')
      expect(css(el).minHeight, position).equals('48px')
      await act(async () => {
        el.click()
      })
      expect(chosen).equals(position)
    }
    expect(node('Player position SS').getAttribute('aria-pressed')).equals(
      'true'
    )
    const spot = (position: string): (typeof PLAYER_POSITION_SPOTS)[number] =>
      PLAYER_POSITION_SPOTS.find(s => s.position === position)!
    expect(spot('CF').y).lessThan(spot('LF').y)
    expect(spot('LF').y).equals(spot('RF').y)
    expect(spot('SS').y).lessThan(spot('3B').y)
    expect(spot('SS').y).equals(spot('2B').y)
    expect(spot('3B').y).equals(spot('1B').y)
    expect(spot('P').x).equals(0.5)
    expect(spot('C').x).equals(0.5)
    expect(spot('P').y).greaterThan(spot('3B').y)
    expect(spot('C').y).greaterThan(spot('P').y)
    expect(
      Number.parseInt(
        css(document.querySelector('[data-testid="Extra hitter positions"]')!)
          .top
      )
    ).greaterThan(spot('C').y + 48 + 24)
  })

  it('keeps the bottom safe area inside docked sheet backgrounds on phones', async () => {
    const os = Platform.OS
    const observer = globalThis.ResizeObserver
    // jsdom has no layout; use the provider's window-inset fallback.
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: undefined
    })
    const computed = window.getComputedStyle.bind(window)
    Platform.OS = 'ios'
    // Supply the inset measured by the provider's hidden CSS probe.
    window.getComputedStyle = (element, pseudo) => {
      const style = computed(element, pseudo)
      if (
        (element as HTMLElement).style.visibility === 'hidden' &&
        (element as HTMLElement).style.zIndex === '-1'
      )
        return new Proxy(style, {
          get: (target, key) =>
            key === 'paddingBottom' ? '34px' : Reflect.get(target, key)
        })
      return style
    }
    try {
      for (const tall of [false, true]) {
        const content = (
          <ScoringSheet title="Settings" tall={tall} onClose={() => undefined}>
            <Text>Controls</Text>
          </ScoringSheet>
        )
        if (root == null) await mount(content)
        else
          await act(async () => {
            root!.render(<ThemeProvider>{content}</ThemeProvider>)
          })
        const sheet = document.querySelector<HTMLElement>(
          '[data-testid="Scoring sheet"]'
        )!
        expect(sheet.style.paddingBottom).equals('50px')
        expect(computed(sheet).borderBottomWidth).equals('0px')
        expect(computed(sheet).borderLeftWidth).equals('1px')
        expect(computed(sheet).borderRightWidth).equals('1px')
        expect(sheet.parentElement!.style.paddingBottom).equals('0px')
      }
    } finally {
      Platform.OS = os
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: observer
      })
      window.getComputedStyle = computed
    }
  })

  it('makes every sheet Cancel red text, removes the full-screen frame, and centers the rounded placeholder sheet', async () => {
    let closed = 0
    await mount(
      <ScoringSheet
        title="Roster"
        fullScreen
        onClose={() => {
          closed++
        }}
      >
        <Text>Players</Text>
      </ScoringSheet>
    )
    const sheet = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-testid="Scoring sheet"]')!
    expect(css(sheet()).borderTopWidth).equals('0px')
    const cancel = node('Cancel')
    expect(css(cancel.firstElementChild as HTMLElement).color).equals(
      'rgb(248, 113, 113)'
    )
    expect(css(cancel).backgroundColor).equals('rgba(0, 0, 0, 0)')
    await act(async () => {
      cancel.click()
    })
    expect(closed).equals(1)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlaceholderPlayersSheet
            onClose={() => {
              closed++
            }}
            onAdd={() => undefined}
          />
        </ThemeProvider>
      )
    })
    expect(css(sheet().parentElement!).justifyContent).equals('center')
    expect(css(sheet()).marginBottom).equals('24px')
    for (const radius of [
      'borderTopLeftRadius',
      'borderTopRightRadius',
      'borderBottomLeftRadius',
      'borderBottomRightRadius'
    ] as const)
      expect(Number.parseFloat(css(sheet())[radius])).greaterThan(0)
    const picker = node('Number of placeholder players')
    expect(
      css(picker.previousElementSibling as HTMLElement).borderTopWidth
    ).equals('1px')
    await act(async () => {
      node('Dismiss sheet').click()
    })
    expect(closed).equals(2)
  })

  it('outlines scoring selectors without changing their measured geometry or non-scoring consumers, and protects pill text margins', async () => {
    const contents = (scoring: boolean): React.ReactElement => (
      <ScopedThemeProvider
        theme={scoring ? scoringSheetTheme(tsBallpark) : tsBallpark}
      >
        <RosterSelector
          labels={['L', 'R']}
          value={0}
          onChange={() => undefined}
        />
        <ScoringButton label="A longer action" onPress={() => undefined} />
        <ScoringPill label="Short tag" onPress={() => undefined} />
      </ScopedThemeProvider>
    )
    await mount(contents(true))
    expect(
      document.querySelector('[data-testid="Scoring selector outline"]')
    ).not.equals(null)
    expect(css(node('A longer action')).paddingLeft).equals('22px')
    expect(css(node('Short tag')).paddingLeft).equals('22px')
    await act(async () => {
      root!.render(<ThemeProvider>{contents(false)}</ThemeProvider>)
    })
    expect(
      document.querySelector('[data-testid="Scoring selector outline"]')
    ).equals(null)
    expect(css(node('A longer action')).paddingLeft).equals('10px')
  })
})
