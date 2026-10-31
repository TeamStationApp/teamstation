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

  it('defaults unknown throws to right, saves once, and keeps a refused edit', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    let calls = 0
    let closes = 0
    let refuse = true
    let saved: PlayerDraft | undefined
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlayerEntrySheet
            initialDraft={{
              firstName: 'Jose',
              lastName: 'Ramirez',
              jersey: '11',
              bats: 'switch',
              throws: null,
              positions: ['DH']
            }}
            onAdd={draft => {
              calls++
              if (refuse) throw new Error('refused')
              saved = draft
            }}
            onClose={() => {
              closes++
            }}
          />
        </ThemeProvider>
      )
    })
    expect((node('First Name') as HTMLInputElement).value).equals('Jose')
    expect(node('Throws R').getAttribute('aria-selected')).equals('true')
    expect(node('Throws —')).equals(null)
    expect(
      document.querySelector('[aria-label="Save and Create Another Player"]')
    ).equals(null)
    await input('Last Name', 'Altuve')
    await tap('Save Player')
    expect(document.body.textContent).includes('Unable to save the player')
    expect((node('Last Name') as HTMLInputElement).value).equals('Altuve')
    refuse = false
    await tap('Throws L')
    await tap('Throws R')
    await tap('Save Player')
    await tap('Save Player')
    expect(calls).equals(2)
    expect(closes).equals(1)
    expect(saved).includes({
      firstName: 'Jose',
      lastName: 'Altuve',
      throws: 'right'
    })
  })

  it('cancels an unset throwing hand without saving the right-hand default', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const original: PlayerDraft = {
      firstName: 'Jose',
      lastName: 'Ramirez',
      jersey: '11',
      bats: 'right',
      throws: null,
      positions: ['DH']
    }
    let saves = 0
    let cancels = 0
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlayerEntrySheet
            initialDraft={original}
            onAdd={() => {
              saves++
            }}
            onClose={() => undefined}
            onCancel={() => {
              cancels++
            }}
          />
        </ThemeProvider>
      )
    })
    expect(node('Throws R').getAttribute('aria-selected')).equals('true')
    await tap('Cancel')
    expect(cancels).equals(1)
    expect(saves).equals(0)
    expect(original.throws).equals(null)
  })

  it('opens without focusing, validates, and focuses the reset form only after saving another', async function () {
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
      (node('Save and Create Another Player').firstChild as HTMLElement).style
        .color
    ).equals('rgb(52, 211, 153)')
    await act(async () => {
      changeTheme(tsBallpark)
    })
    expect(document.activeElement).not.equals(node('First Name'))
    expect(node('Jersey Number').getAttribute('inputmode')).equals('numeric')
    await tap('Create Player')
    expect(document.body.textContent).includes('Enter a player name.')
    await input('First Name', 'Alex')
    const enter = async (label: string): Promise<void> => {
      await act(async () => {
        node(label).dispatchEvent(
          new window.KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true
          })
        )
      })
    }
    await enter('First Name')
    expect(document.activeElement).equals(node('Last Name'))
    await enter('Last Name')
    expect(document.activeElement).equals(node('Jersey Number'))
    await enter('Jersey Number')
    expect(document.activeElement).not.equals(node('Jersey Number'))
    await input('Last Name', 'Local')
    await input('Jersey Number', '7x')
    await tap('Create Player')
    expect(document.body.textContent).includes('Use digits')
    await input('Jersey Number', '07')
    await tap('Throws L')
    await tap('Throws R')
    await tap('Throws L')
    for (const side of ['L', 'S', 'R', 'S']) await tap(`Bats ${side}`)
    await tap('Player position P')
    await tap('Player position DH')
    await tap('Player position P')
    expect(node('Player position DH').getAttribute('aria-pressed')).equals(
      'true'
    )
    expect(node('Player position P').getAttribute('aria-pressed')).equals(
      'false'
    )
    const scroll = node('First Name').closest<HTMLElement>(
      '[data-testid="Scoring sheet content"]'
    )!
    scroll.scrollTop = 280
    await tap('Save and Create Another Player')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
    })
    expect(scroll.scrollTop).equals(0)
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
    await tap('Create Player')
    await tap('Create Player')
    expect(added).length(2)
    expect(closes).equals(2)
  })
  it('maps compact three-way segments with bounded edges', function () {
    expect(
      [-20, 0, 49, 50, 99, 100, 200].map(x => rosterSegmentAt(x, 0, 150, 3))
    ).deep.equals([0, 0, 0, 1, 1, 2, 2])
    expect(rosterSegmentAt(1, 0, 0, 3)).equals(2)
  })

  it("greys a pool player's name and hands, and leaves their jersey editable", async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <PlayerEntrySheet
            ownIdentity
            initialDraft={{
              firstName: 'Mookie',
              lastName: 'B',
              jersey: '50',
              bats: 'right',
              throws: null,
              positions: ['RF']
            }}
            onAdd={() => undefined}
            onClose={() => undefined}
          />
        </ThemeProvider>
      )
    })
    expect((node('First Name') as HTMLInputElement).readOnly).equals(true)
    expect((node('Last Name') as HTMLInputElement).readOnly).equals(true)
    expect((node('Jersey Number') as HTMLInputElement).readOnly).equals(false)
    expect(node('Throws unknown')).not.equals(null)
    // A draft's bat side is a guess for scoring: theirs is shown as held.
    expect(node('Bats unknown')).not.equals(null)
    expect(document.querySelector('[aria-label="Throws L"]')).equals(null)
  })
})
