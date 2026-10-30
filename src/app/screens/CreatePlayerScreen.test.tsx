import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { NewRosterPlayer } from '../../common/playerSettings'
import { mintedRosterEntry } from '../../test/mintedRosterEntry'
import { ThemeProvider } from '../theme/ThemeContext'
import { bodyOf, CreatePlayerScreen } from './CreatePlayerScreen'

let root: Root | undefined
const node = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const text = (): string => document.body.textContent ?? ''
async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node(label), value)
    node(label)!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
async function click(label: string): Promise<void> {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function open(
  create: (teamId: string, body: NewRosterPlayer) => Promise<void> = async () =>
    undefined
): Promise<{ sent: unknown[]; created: Array<[string, boolean]> }> {
  const sent: unknown[] = []
  const created: Array<[string, boolean]> = []
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  client.createRosterPlayer = async (teamId, body) => {
    sent.push({ teamId, body })
    await create(teamId, body)
    return mintedRosterEntry(body)
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <CreatePlayerScreen
          client={client}
          teamId="tem_falcons"
          onCreated={(name, another) => created.push([name, another])}
        />
      </ThemeProvider>
    )
  })
  return { sent, created }
}

describe('team settings Create Player', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    document.body.innerHTML = ''
  })

  it('creates the player from the form, and says so on the way back', async () => {
    const { sent, created } = await open()
    expect(text()).includes('Create Player')
    expect((node('First name') as HTMLInputElement).value).equals('')
    expect(node('Throws Right')!.getAttribute('aria-checked')).equals('true')
    expect(node('Bats Right')!.getAttribute('aria-checked')).equals('true')
    await type('First name', 'Walker')
    await type('Last name', 'Buehler')
    await type('Jersey number', '21')
    await click('Player position P')
    await click('Create Player')
    expect(sent).deep.equals([
      {
        teamId: 'tem_falcons',
        body: {
          firstName: 'Walker',
          lastName: 'Buehler',
          jersey: '21',
          bats: 'right',
          throws: 'right',
          positions: ['P']
        }
      }
    ])
    expect(created).deep.equals([['Walker Buehler', false]])
  })

  it('creates and starts again at First name for another', async () => {
    const { sent, created } = await open()
    await type('First name', 'Max')
    await type('Last name', 'Muncy')
    await type('Jersey number', '13')
    await click('Player position 3B')
    let focused = false
    node('First name')!.addEventListener('focus', () => {
      focused = true
    })
    await click('Create Player and Add Another')
    expect(sent).has.length(1)
    expect(created).deep.equals([['Max Muncy', true]])
    expect((node('First name') as HTMLInputElement).value).equals('')
    expect((node('Jersey number') as HTMLInputElement).value).equals('')
    expect(node('Player position 3B')!.getAttribute('aria-selected')).equals(
      'false'
    )
    expect(focused).equals(true)
  })

  it('asks for a name first, and keeps the form over a refusal', async () => {
    const { sent, created } = await open(async () => {
      throw new HttpError('conflict', 'That jersey number is taken')
    })
    await click('Create Player')
    expect(text()).includes('Enter a player name.')
    expect(sent).has.length(0)
    await type('First name', 'Mookie')
    await type('Jersey number', '50')
    await click('Create Player')
    expect(text()).includes('That jersey number is taken')
    expect((node('First name') as HTMLInputElement).value).equals('Mookie')
    expect(created).has.length(0)
    // Nothing the client can say: the general line.
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    await open(async () => {
      throw new Error('')
    })
    await type('First name', 'Mookie')
    await click('Create Player and Add Another')
    expect(text()).includes('Unable to create the player. Please try again.')
  })

  it('stores no jersey for an empty field, and right hands when unknown', () => {
    expect(
      bodyOf({
        firstName: ' Will ',
        lastName: ' Smith ',
        jersey: ' ',
        throws: null,
        bats: null,
        positions: ['C']
      })
    ).deep.equals({
      firstName: 'Will',
      lastName: 'Smith',
      jersey: null,
      bats: 'right',
      throws: 'right',
      positions: ['C']
    })
  })
})
