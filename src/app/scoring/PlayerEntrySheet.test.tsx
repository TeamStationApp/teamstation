import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { changeTheme, ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import type { PlayerDraft } from './playerDraft'
import { PlayerEntrySheet } from './PlayerEntrySheet'
import { rosterSegmentAt } from './RosterSelector'
let root: Root | undefined
const node = (label: string): HTMLElement =>
  document.querySelector(`[aria-label="${label}"]`)!
async function tap(label: string): Promise<void> {
  await act(async () => {
    node(label).click()
  })
}
async function input(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node(label), value)
    node(label).dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
describe('player entry sheet', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
      changeTheme(tsBallpark)
    })
    root = undefined
  })

  it('focuses, validates, saves all optional fields, resets for another and cancels without adding', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const added: PlayerDraft[] = []
    let closes = 0
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlayerEntrySheet
            onAdd={p => {
              added.push(p)
            }}
            onClose={() => {
              closes++
            }}
          />
        </ThemeProvider>
      )
    })
    await act(async () => {
      changeTheme(tsDark)
    })
    expect(
      (node('Save and Add Another Player').firstChild as HTMLElement).style
        .color
    ).equals('rgb(122, 152, 96)')
    await act(async () => {
      changeTheme(tsBallpark)
    })
    expect(document.activeElement).equals(node('First Name'))
    await tap('Add Player')
    expect(document.body.textContent).includes('Enter a player name.')
    await input('First Name', 'Alex')
    await input('Last Name', 'Local')
    await input('Jersey Number', '7x')
    await tap('Add Player')
    expect(document.body.textContent).includes('Use digits')
    await input('Jersey Number', '07')
    await tap('Throws L')
    await tap('Throws R')
    await tap('Throws L')
    for (const side of ['L', 'S', 'R', 'S']) await tap(`Bats ${side}`)
    await tap('Player position P')
    await tap('Player position DH')
    await tap('Player position P')
    expect(node('Player position DH').getAttribute('aria-checked')).equals(
      'true'
    )
    expect(node('Player position P').getAttribute('aria-checked')).equals(
      'false'
    )
    await tap('Save and Add Another Player')
    expect(added).deep.equals([
      {
        firstName: 'Alex',
        lastName: 'Local',
        jersey: '07',
        throws: 'left',
        bats: 'switch',
        positions: ['DH']
      }
    ])
    expect((node('First Name') as HTMLInputElement).value).equals('')
    expect(node('Throws R').getAttribute('aria-selected')).equals('true')
    expect(node('Bats R').getAttribute('aria-selected')).equals('true')
    expect(document.activeElement).equals(node('First Name'))
    await tap('Cancel')
    expect(closes).equals(1)
    expect(added).length(1)
    await input('Last Name', 'Solo')
    await tap('Add Player')
    await tap('Add Player')
    expect(added).length(2)
    expect(closes).equals(2)
  })
  it('maps compact three-way segments with bounded edges', function () {
    expect(
      [-20, 0, 49, 50, 99, 100, 200].map(x => rosterSegmentAt(x, 0, 150, 3))
    ).deep.equals([0, 0, 0, 1, 1, 2, 2])
    expect(rosterSegmentAt(1, 0, 0, 3)).equals(2)
  })
})
