import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text, type TextInput } from 'react-native'

import {
  changeTheme,
  getTheme,
  ThemeProvider,
  useTheme,
  watchTheme
} from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import type { Theme } from '../theme/types'
import { modalRendererFixture } from './scoringModals.e2e.preview'
import { ScoringPill } from './ScoringPill'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import { scoringSheetTheme } from './scoringSheetTheme'
import { ScoringTextInput } from './ScoringTextInput'

let root: Root | undefined
const node = (label: string): HTMLElement =>
  document.querySelector(`[aria-label="${label}"]`)!
const css = (element: Element): CSSStyleDeclaration =>
  window.getComputedStyle(element)
async function mount(children: React.ReactNode): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{children}</ThemeProvider>)
  })
}

describe('scoped scoring presentation', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
      changeTheme(tsBallpark)
    })
    root = undefined
  })
  it('reaches renderer fixture dialogs through real scoring transitions', () => {
    for (const kind of ['runner-advance', 'runner-out']) {
      const state = modalRendererFixture(kind)
      expect(state.phase).equals('runnerReason')
      expect(state.runnerAction?.decision).equals(
        kind === 'runner-advance' ? 'safe' : 'out'
      )
      expect(state.runnerDraft).not.equals(undefined)
    }
    const error = modalRendererFixture('error-credit')
    expect(error.phase).equals('errorCredit')
    expect(error.runnerAction?.defensiveRoute?.map(hop => hop.id)).deep.equals([
      10
    ])
  })
  it('isolates nested sheets from the live global theme and preserves main controls', async () => {
    let outside: Theme | undefined
    let inside: Theme | undefined
    let nested: Theme | undefined
    const observed: Theme[] = []
    const unsubscribe = watchTheme(theme => {
      observed.push(theme)
    })
    function Probe({ scope }: { scope: string }): React.ReactElement {
      const theme = useTheme()
      if (scope === 'outside') outside = theme
      else if (scope === 'inside') inside = theme
      else nested = theme
      return (
        <Text
          accessibilityLabel={scope}
          style={{ color: theme.primaryTextColor }}
        >
          {scope}
        </Text>
      )
    }
    try {
      await mount(
        <>
          <Probe scope="outside" />
          <ScoringButton label="Main control" onPress={() => undefined} />
          <ScoringSheet title="Outer" onClose={() => undefined}>
            <Probe scope="inside" />
            <ScoringButton label="Sheet control" onPress={() => undefined} />
            <ScoringSheet title="Inner" onClose={() => undefined}>
              <Probe scope="nested" />
            </ScoringSheet>
          </ScoringSheet>
        </>
      )
      for (const theme of [tsBallpark, tsDark]) {
        await act(async () => {
          changeTheme(theme)
        })
        expect(outside).equals(theme)
        expect(inside!.scoringSheet).equals(true)
        expect(nested).equals(inside)
        expect(getTheme()).equals(theme)
        expect(scoringSheetTheme(inside!)).equals(inside)
        expect(css(node('inside')).color).equals('rgb(226, 232, 240)')
        expect(css(node('Main control')).backgroundColor).equals(
          theme === tsBallpark ? 'rgb(43, 66, 33)' : 'rgb(107, 142, 78)'
        )
        expect(css(node('Sheet control')).backgroundColor).equals(
          'rgb(29, 107, 66)'
        )
        expect(css(node('Sheet control')).borderTopLeftRadius).equals(
          `${theme.radiusPill}px`
        )
      }
      expect(observed).includes(tsDark)
    } finally {
      unsubscribe()
    }
  })

  it('keeps input values, placeholders, focus, submit, refs and caller styles intact', async () => {
    const ref = createRef<React.ComponentRef<typeof TextInput>>()
    const calls: string[] = []
    await mount(
      <ScoringSheet title="Field" onClose={() => undefined}>
        <ScoringTextInput
          ref={ref}
          accessibilityLabel="Tag field"
          placeholder="Short tag"
          defaultValue="great catch"
          style={{ marginTop: 7 }}
          onFocus={() => calls.push('focus')}
          onBlur={() => calls.push('blur')}
          onSubmitEditing={() => calls.push('submit')}
        />
        <ScoringTextInput
          accessibilityLabel="Disabled field"
          editable={false}
          placeholderTextColor={tsBallpark.scoringSurface.accent}
          selectionColor={tsBallpark.scoringSurface.text}
        />
      </ScoringSheet>
    )
    const input = node('Tag field') as HTMLInputElement
    expect(input.value).equals('great catch')
    expect(input.placeholder).equals('Short tag')
    expect(css(input).backgroundColor).equals('rgb(36, 59, 48)')
    expect(css(input).color).equals('rgb(226, 232, 240)')
    expect(css(input).marginTop).equals('7px')
    expect(input.style.fontSize).equals('16px')
    expect(css(input).borderTopColor).equals('rgb(101, 133, 120)')
    await act(async () => {
      ref.current!.focus()
    })
    expect(document.activeElement).equals(input)
    expect(css(input).borderTopColor).equals('rgb(52, 211, 153)')
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
    })
    await act(async () => {
      ref.current!.blur()
    })
    expect(calls).includes('focus').and.includes('blur').and.includes('submit')
    expect(css(node('Disabled field')).opacity).equals('0.5')
  })

  it('exposes multiword pill labels and checked/disabled state without truncation', async () => {
    let presses = 0
    await mount(
      <ScoringSheet title="Pills" onClose={() => undefined}>
        <ScoringPill
          label="great catch"
          selected
          onPress={() => {
            presses++
          }}
        />
        <ScoringPill
          label="Disabled position"
          disabled
          onPress={() => {
            presses++
          }}
        />
        <ScoringPill
          label="Available position"
          onPress={() => {
            presses++
          }}
        />
      </ScoringSheet>
    )
    expect(node('great catch').getAttribute('aria-checked')).equals('true')
    expect(node('Disabled position').getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(node('great catch').textContent).equals('great catch')
    expect(css(node('great catch').firstElementChild!).textOverflow).not.equals(
      'ellipsis'
    )
    await act(async () => {
      node('great catch').click()
      node('Disabled position').click()
      node('Available position').click()
    })
    expect(presses).equals(2)
  })
})
