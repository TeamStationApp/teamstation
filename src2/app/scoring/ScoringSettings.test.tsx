import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'
import { ScoringSettings } from './ScoringSettings'
import { swipeCloses } from './ScoringSheet'

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})
async function render(
  userId: string,
  props: Partial<React.ComponentProps<typeof ScoringSettings>> = {}
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ScoringSettings userId={userId} {...props} />
      </ThemeProvider>
    )
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
function find(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
}
describe('the settings sheet', function () {
  it('turns sound and switch-hitter help on and off with switches', async function () {
    const sounds: boolean[] = []
    await render('switches', { onSoundChange: on => sounds.push(on) })
    const on = (label: string): boolean | undefined =>
      document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
        ?.checked
    expect(on('Toggle scoring sound')).equals(true)
    await act(async () => {
      find('Toggle scoring sound')!.click()
    })
    expect(on('Toggle scoring sound')).equals(false)
    expect(sounds).deep.equals([false])
    await act(async () => {
      find('Toggle switch-hitter help')!.click()
    })
    expect(await scoringPreferences.read('switches')).deep.include({
      sound: false,
      help: false
    })
  })

  it('closes when pulled far enough down, or flicked', function () {
    expect(swipeCloses(121, 0)).equals(true)
    expect(swipeCloses(60, 1.2)).equals(true)
    expect(swipeCloses(60, 0.2)).equals(false)
    expect(swipeCloses(10, 3)).equals(false)
    expect(swipeCloses(-200, 0)).equals(false)
  })
})
