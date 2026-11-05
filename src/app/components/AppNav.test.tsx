import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TestChatAge } from '../../test/chatAgeTesting'
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
        'Search',
        'Chat'
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

describe('chat in the navigation, whatever the age answer', () => {
  for (const mode of ['header', 'floating'] as const)
    for (const access of ['ask', 'blocked', 'pending', 'allowed'] as const)
      it(`keeps Chat in the ${mode} navigation while chat is ${access}`, async () => {
        const host = document.createElement('div')
        document.body.append(host)
        const selected: string[] = []
        root = createRoot(host)
        await act(async () => {
          root!.render(
            <ThemeProvider>
              <TestChatAge access={access}>
                <AppNav
                  selected="search"
                  mode={mode}
                  onSelect={id => selected.push(id)}
                />
              </TestChatAge>
            </ThemeProvider>
          )
        })
        const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')]
        expect(tabs.map(node => node.getAttribute('aria-label'))).deep.equals([
          'Home',
          'Videos',
          'Schedule',
          'Search',
          'Chat'
        ])
        await act(async () => {
          tabs[4].click()
        })
        // The tab press is the Shell's to gate; the bar only reports it.
        expect(selected).deep.equals(['chat'])
      })
})
