import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { ScoringMenuButton } from './ScoringMenuAppearance'

let root: Root | undefined
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

describe('scoring menu rows', function () {
  // The top-right menu takes its width from its rows. A phone lays a row out
  // with Yoga, which sizes a flex item from its basis: a zero basis made
  // every label, and so the menu, about 26 points wide.
  it('size their label from its text, so a menu of them is as wide as its words', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ScoringMenuButton
            label="Set Team Rosters"
            onPress={() => undefined}
          />
        </ThemeProvider>
      )
    })
    const label = host.querySelector<HTMLElement>(
      '[data-testid="scoring-menu-label"]'
    )
    expect(label?.textContent).equals('Set Team Rosters')
    for (const node of [label!, label!.parentElement!]) {
      const style = getComputedStyle(node)
      expect(style.flexBasis, 'basis').not.match(/^0/)
      expect(style.flexGrow, 'grow').equals('1')
      expect(style.flexShrink, 'shrink').equals('1')
    }
  })
})
