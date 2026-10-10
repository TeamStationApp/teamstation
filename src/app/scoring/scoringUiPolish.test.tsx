import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text } from 'react-native'

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
    expect(node('Player position SS').getAttribute('aria-checked')).equals(
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
