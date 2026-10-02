import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { WalkUpControl, type WalkUpControlProps } from './WalkUpControl'

/** U33: the scoring screen's music note — labels, icons and the dim. */
let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

async function render(props: Partial<WalkUpControlProps>): Promise<number> {
  let presses = 0
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <WalkUpControl
          batterName="Tom A"
          playing={false}
          dimmed={false}
          onPress={() => {
            presses++
          }}
          {...props}
        />
      </ThemeProvider>
    )
  })
  const button = document.querySelector<HTMLElement>(
    '[data-testid="walk-up-note"]'
  )
  await act(async () => {
    button?.click()
  })
  return presses
}

const note = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-testid="walk-up-note"]')!
const toast = (): HTMLElement | null =>
  document.querySelector('[data-testid="walk-up-toast"]')

describe('WalkUpControl', () => {
  it('plays with a music note and SONG, labelled for the batter', async () => {
    const presses = await render({})
    expect(note().getAttribute('aria-label')).equals(
      'Play Tom A’s walk-up song'
    )
    expect(note().textContent).includes('SONG')
    expect(note().querySelector('svg')).not.equals(null)
    expect(getComputedStyle(note()).height).equals('56px')
    expect(getComputedStyle(note()).borderTopLeftRadius).equals('12px')
    expect(getComputedStyle(note()).borderBottomRightRadius).equals('12px')
    expect(Number(getComputedStyle(note()).opacity)).equals(1)
    expect(toast()).equals(null)
    expect(presses).equals(1)
  })

  it('keeps the music note and says STOP while the song plays', async () => {
    const presses = await render({ playing: true })
    expect(note().getAttribute('aria-label')).equals(
      'Stop Tom A’s walk-up song'
    )
    expect(note().textContent).includes('STOP')
    expect(note().querySelector('svg')).not.equals(null)
    expect(presses).equals(1)
  })

  it('is dimmed when the song is not on this phone, still takes the tap, and shows the toast', async () => {
    const presses = await render({
      dimmed: true,
      toast: 'Walk This Way isn’t on this phone'
    })
    expect(note().getAttribute('aria-label')).equals(
      'Walk-up song for Tom A, not on this phone'
    )
    expect(note().textContent).includes('SONG')
    expect(Number(getComputedStyle(note()).opacity)).lessThan(1)
    expect(toast()?.textContent).equals('Walk This Way isn’t on this phone')
    expect(presses).equals(1)
  })
})
