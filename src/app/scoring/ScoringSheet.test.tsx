import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Text, View } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { NOTICE_TEXT_AREA } from './scoringControlStyle'
import { ScoringSheet } from './ScoringSheet'

describe('the scoring sheet’s notice slot', function () {
  let host: HTMLDivElement
  let root: Root
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
  })
  const draw = async (notice: boolean): Promise<Element> => {
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ScoringSheet
            title="Set Team Rosters"
            headerless
            fullScreen
            scroll={false}
            onClose={() => undefined}
            notice={
              notice ? (
                <View
                  testID="notice-slot"
                  style={{ position: 'absolute', inset: 0 }}
                  pointerEvents="box-none"
                >
                  <Text>Roster conflict</Text>
                </View>
              ) : undefined
            }
          >
            <Text>Roster editor</Text>
            <Text accessibilityRole="button">Save Rosters</Text>
          </ScoringSheet>
        </ThemeProvider>
      )
    })
    return document.querySelector('[aria-modal="true"]')!
  }

  it('draws the notice last in the modal, over the whole window, and ends the sheet above the strip', async function () {
    const modal = await draw(true)
    const slot = modal.querySelector('[data-testid="notice-slot"]')!
    expect(slot).not.equals(null)
    expect(slot.parentElement?.lastElementChild).equals(slot)
    expect(window.getComputedStyle(slot).position).equals('absolute')
    const sheet = modal.querySelector<HTMLElement>(
      '[data-testid="Scoring sheet"]'
    )!
    expect(sheet.contains(slot)).equals(false)
    expect(window.getComputedStyle(sheet).marginBottom).equals(
      `${NOTICE_TEXT_AREA}px`
    )
  })

  it('draws nothing extra without a notice, and the sheet keeps the whole height', async function () {
    const withNotice = await draw(true)
    const count = withNotice.querySelectorAll('*').length
    const modal = await draw(false)
    expect(modal.querySelector('[data-testid="notice-slot"]')).equals(null)
    // Only the slot and its text are gone.
    expect(modal.querySelectorAll('*').length).equals(count - 2)
    const sheet = modal.querySelector<HTMLElement>(
      '[data-testid="Scoring sheet"]'
    )!
    expect(['', '0px']).includes(window.getComputedStyle(sheet).marginBottom)
  })
})
