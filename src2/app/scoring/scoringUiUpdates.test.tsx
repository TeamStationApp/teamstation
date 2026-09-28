import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { PillTabs } from '../components/PillTabs'
import {
  BaseballScreen,
  type BaseballScreenProps
} from '../field/BaseballScreen'
import { gsBallpark } from '../theme/gsBallpark'
import { gsDark } from '../theme/gsDark'
import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { OutcomeControls } from './OutcomeControls'
import { CORRECTION_WINDOW_MS } from './scoringTypes'

let root: Root | undefined
const node = (label: string): HTMLElement | null =>
  document.querySelector(`[aria-label="${label}"]`)
const style = (element: Element): CSSStyleDeclaration =>
  window.getComputedStyle(element)
afterEach(async () => {
  await act(async () => {
    root?.unmount()
    changeTheme(gsBallpark)
  })
  root = undefined
})
describe('scoring UI updates', () => {
  it('shares camera-view pill styling and routes both Done buttons through one guarded action', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    let finishes = 0
    let pitches = 0
    const props: BaseballScreenProps = {
      field: {
        players: [],
        selected: '',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1
      },
      onMenu: () => undefined,
      onUndo: () => undefined,
      onPitch: () => {
        pitches++
      },
      canPitch: true,
      summary: 'Game',
      historyLabel: 'Ball'
    }
    const render = async (
      changes: Partial<BaseballScreenProps>
    ): Promise<void> => {
      await act(async () => {
        root!.render(
          <ThemeProvider>
            <PillTabs
              tabs={[{ id: 'camera', label: 'Home Plate Camera' }]}
              selected="camera"
              onSelect={() => undefined}
            />
            <BaseballScreen
              {...props}
              {...changes}
              ballInPlayControl={
                <OutcomeControls
                  disabled={false}
                  onActive={() => undefined}
                  onChoose={() => undefined}
                />
              }
            />
          </ThemeProvider>
        )
      })
    }
    await render({})
    expect(node('Bottom Finish at-bat')).equals(null)
    for (const theme of [gsBallpark, gsDark]) {
      await act(async () => {
        changeTheme(theme)
      })
      await render({
        instruction: 'Choose receiver',
        onFinish: () => {
          finishes++
        },
        canFinish: true
      })
      const bottom = node('Bottom Finish at-bat')!
      const schedule = node('Home Plate Camera')!
      for (const property of [
        'borderRadius',
        'boxShadow',
        'minHeight',
        'paddingLeft',
        'backgroundColor'
      ] as const)
        expect(style(bottom.firstElementChild!)[property], property).equals(
          style(schedule.firstElementChild!)[property]
        )
      expect(style(bottom.querySelector('[dir="auto"]')!).color).equals(
        style(schedule.querySelector('[dir="auto"]')!).color
      )
      expect(style(bottom).minHeight).equals('48px')
      expect(style(bottom.firstElementChild!).minHeight).equals('36px')
      await act(async () => {
        bottom.click()
        node('Finish at-bat')!.click()
      })
      expect(finishes).equals(theme === gsBallpark ? 2 : 4)
      for (const [label, color, text] of [
        ['Ball', 'rgb(15, 92, 59)', 'rgb(255, 255, 255)'],
        ['Called Strike', 'rgb(146, 64, 14)', 'rgb(255, 255, 255)'],
        ['Swing and Miss', 'rgb(130, 30, 20)', 'rgb(255, 255, 255)'],
        ['Foul Ball', 'rgb(127, 100, 69)', 'rgb(23, 23, 23)']
      ]) {
        const button = node(label)!
        expect(style(button).backgroundColor).equals(color)
        expect(
          style(button.querySelector('[data-testid="scoring-control-label"]')!)
            .color
        ).equals(text)
      }
      expect(node('Foul Ball')!.textContent).equals('FOUL\nBALL')
      for (const label of ['Swing', 'Bunt']) {
        const button = node(`${label} in Play`)!
        expect(button.querySelector('svg')).not.equals(null)
        expect(button.textContent).contains(label.toUpperCase())
        expect(button.textContent).contains('IN PLAY')
        expect(style(button).height).equals('56px')
      }
    }
    await render({
      remainingMs: CORRECTION_WINDOW_MS,
      canFinish: false,
      canPitch: false,
      onFinish: () => {
        finishes++
      }
    })
    await act(async () => {
      node('Bottom Finish at-bat')!.click()
      node('Finish at-bat')!.click()
      node('Ball')!.click()
    })
    expect(finishes).equals(4)
    expect(pitches).equals(0)
    await render({
      onFinish: () => {
        finishes++
      }
    })
    expect(node('Bottom Finish at-bat')).equals(null)
    await render({ instruction: 'Trajectory' })
    expect(node('Bottom Finish at-bat')).equals(null)
  })
})
