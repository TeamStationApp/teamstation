import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { AppNav } from './AppNav'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
describe('Search navigation', () => {
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
      expect(tabs.map(node => node.getAttribute('aria-label'))).deep.equals([
        'Home',
        'Videos',
        'Schedule',
        'Search'
      ])
      expect(host.querySelectorAll('[role="button"]')).length(0)
      await act(async () => {
        tabs[3].click()
        tabs[2].click()
      })
      expect(selected).deep.equals(['search', 'schedule'])
    })
  }
})
