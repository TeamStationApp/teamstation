import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import { guestCreator } from '../../test/guestPlayers'
import { scoringSession } from '../../test/scoringSession'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { gameFixture } from './isUnscoredGame.test'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import { clampPlayerCount, countAtOffset } from './playerCount'
import { PlayerCountPicker } from './PlayerCountPicker'
import { PlayerCountPicker as NativePicker } from './PlayerCountPicker.native'
import { RosterEditor } from './RosterEditor'
import { initialScoringState } from './scoringMachine'

let root: Root | undefined
const node = (label: string): HTMLElement =>
  document.querySelector(`[aria-label="${label}"]`)!
async function click(label: string): Promise<void> {
  await act(async () => {
    node(label).click()
  })
}
async function mount(child: React.ReactNode): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{child}</ThemeProvider>)
  })
}
describe('placeholder count sheet and platform adapters', function () {
  const platform = Platform.OS
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
      changeTheme(tsBallpark)
    })
    root = undefined
    Platform.OS = platform
  })
  it('keeps the placeholder text action green in dark mode', async function () {
    await act(async () => {
      changeTheme(tsDark)
    })
    await mount(
      <RosterEditor
        onCreateGuest={guestCreator()}
        state={initialScoringState(scoringSession(gameFixture))}
        onSave={() => undefined}
      />
    )
    await click('Create Player')
    expect(
      (node('Create Placeholder Player').firstChild as HTMLElement).style.color
    ).equals('rgb(52, 211, 153)')
  })
  it('returns to player entry on cancellation and to the roster after creating placeholders', async function () {
    await mount(
      <RosterEditor
        onCreateGuest={guestCreator()}
        state={initialScoringState(scoringSession(gameFixture))}
        onSave={() => undefined}
      />
    )
    await click('Create Player')
    expect(document.activeElement).not.equals(node('First Name'))
    await click('Create Placeholder Player')
    await click('Cancel')
    expect(node('First Name')).not.equals(null)
    await click('Create Placeholder Player')
    await click('Player count 3')
    await click('Create')
    expect(node('First Name')).equals(null)
    expect(node('Number of placeholder players')).equals(null)
    expect(node('Save Rosters')).not.equals(null)
    await click('Create Player')
    expect(document.activeElement).not.equals(node('First Name'))
  })
  it('retries a failed asynchronous add and prevents duplicate submissions while saving', async function () {
    let attempts = 0
    let closes = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    await mount(
      <PlaceholderPlayersSheet
        onClose={() => {
          closes++
        }}
        onAdd={async () => {
          attempts++
          if (attempts === 1) throw new Error('Offline')
          await pending
        }}
      />
    )
    await click('Create')
    expect(document.body.textContent).includes(
      'Unable to create the players. Please try again.'
    )
    expect(closes).equals(0)
    await act(async () => {
      node('Create').click()
      node('Create').click()
    })
    expect(attempts).equals(2)
    expect(node('Create').getAttribute('aria-disabled')).equals('true')
    await act(async () => {
      release()
      await pending
    })
    expect(closes).equals(1)
  })
  it('clamps rows and commits the currently scrolled selection exactly once', async function () {
    expect(
      [NaN, Infinity, -1, 0, 1, 2.7, 16, 99].map(clampPlayerCount)
    ).deep.equals([1, 1, 1, 1, 1, 3, 16, 16])
    expect([-50, 0, 19, 21, 600, 900].map(countAtOffset)).deep.equals([
      1, 1, 1, 2, 16, 16
    ])
    const counts: number[] = []
    let closes = 0
    await mount(
      <PlaceholderPlayersSheet
        onAdd={n => {
          counts.push(n)
        }}
        onClose={() => {
          closes++
        }}
      />
    )
    const wheel = node('Number of placeholder players')
    expect(node('Player count 1').getAttribute('aria-selected')).equals('true')
    await act(async () => {
      wheel.scrollTop = 600
      wheel.dispatchEvent(new window.Event('scroll'))
    })
    expect(node('Player count 16').getAttribute('aria-selected')).equals('true')
    await click('Create')
    await click('Create')
    expect(counts).deep.equals([16])
    expect(closes).equals(1)
  })
  it('supports click, arrows, endpoints, external values and cancellation', async function () {
    let selected = 0
    let update: (n: number) => void = () => undefined
    function Harness(): React.ReactElement {
      const [value, setValue] = useState(4)
      update = setValue
      return (
        <PlayerCountPicker
          value={value}
          onChange={n => {
            selected = n
            setValue(n)
          }}
        />
      )
    }
    await mount(<Harness />)
    const wheel = node('Number of placeholder players')
    expect(wheel.scrollTop).equals(120)
    await click('Player count 3')
    expect(selected).equals(3)
    for (const [key, count] of [
      ['ArrowDown', 4],
      ['ArrowUp', 3],
      ['End', 16],
      ['Home', 1],
      ['Enter', 1]
    ] as const) {
      await act(async () => {
        wheel.dispatchEvent(
          new window.KeyboardEvent('keydown', { key, bubbles: true })
        )
      })
      expect(selected).equals(count)
    }
    await act(async () => {
      update(7)
    })
    expect(wheel.scrollTop).equals(240)
    let added = 0
    let closed = 0
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlaceholderPlayersSheet
            onAdd={() => {
              added++
            }}
            onClose={() => {
              closed++
            }}
          />
        </ThemeProvider>
      )
    })
    await click('Cancel')
    expect(added).equals(0)
    expect(closed).equals(1)
  })
  it('uses the iOS Picker adapter and the Android snapping scroll adapter', async function () {
    let selected = 0
    Platform.OS = 'ios'
    await mount(
      <NativePicker
        value={3}
        onChange={n => {
          selected = n
        }}
      />
    )
    const picker = document.querySelector('select')!
    expect(picker).not.equals(null)
    await act(async () => {
      picker.value = '16'
      picker.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    expect(selected).equals(16)
    Platform.OS = 'android'
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NativePicker
            value={1}
            onChange={n => {
              selected = n
            }}
          />
        </ThemeProvider>
      )
    })
    await click('Player count 4')
    expect(selected).equals(4)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <NativePicker
            value={16}
            onChange={n => {
              selected = n
            }}
          />
        </ThemeProvider>
      )
    })
    const wheel = node('Number of placeholder players')
    expect(wheel).not.equals(null)
    await act(async () => {
      wheel.scrollTop = 80
      wheel.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    })
  })
})
