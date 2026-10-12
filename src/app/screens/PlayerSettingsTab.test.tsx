import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  asRosterEntry,
  type RosterEntry,
  type TeamStationClient
} from '../../common/api'
import type { PlayerSettings } from '../../common/playerSettings'
import { ThemeProvider } from '../theme/ThemeContext'
import { changesOf, PlayerSettingsTab } from './PlayerSettingsTab'

/**
 * The form a coach edits a player with: it starts from the roster, offers
 * Save only once something differs, sends only what differs, and keeps a
 * refusal on the screen.
 */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay(10)
  })
}

function labelled(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(found, label).not.equals(null)
  return found!
}

async function press(label: string): Promise<void> {
  await act(async () => {
    labelled(label).click()
    await delay(10)
  })
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    const input = labelled(label) as HTMLInputElement
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay(10)
  })
}

const checked = (label: string): boolean =>
  labelled(label).getAttribute('aria-checked') === 'true'
const saveDisabled = (): boolean =>
  labelled('Save').getAttribute('aria-disabled') === 'true'
const text = (): string => document.body.textContent ?? ''

const jordan = asRosterEntry({
  userId: 7,
  shortName: 'Jordan P',
  jersey: '4',
  positions: ['CF', 'OF'],
  bats: 'right',
  throws: 'right',
  isPlayer: true,
  role: 'member',
  group: 'player'
})

interface Saved {
  teamId: string
  userId: string
  settings: PlayerSettings
}

function settingsClient(
  roster: RosterEntry[] | Error,
  saves: Saved[],
  answer?: (settings: PlayerSettings) => RosterEntry | Error
): TeamStationClient {
  return {
    roster: async () => {
      if (roster instanceof Error) throw roster
      return roster
    },
    setPlayerSettings: async (
      teamId: string,
      userId: string,
      settings: PlayerSettings
    ) => {
      saves.push({ teamId, userId, settings })
      const result = answer?.(settings) ?? {
        ...jordan,
        ...settings,
        positions: settings.positions ?? jordan.positions
      }
      if (result instanceof Error) throw result
      return result
    }
  } as unknown as TeamStationClient
}

describe('a player’s settings form', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('saves an authorized name together with the jersey and retains refused edits', async function () {
    const entry = {
      ...jordan,
      nameDetails: {
        firstName: 'Mookie',
        lastName: 'Betts',
        displayName: 'Mookie Betts'
      }
    }
    const saves: Saved[] = []
    let refuse = true
    const client = settingsClient([entry], saves, settings =>
      refuse
        ? new Error('Cannot save')
        : {
            ...entry,
            jersey: settings.jersey ?? entry.jersey,
            shortName: 'Paul G',
            nameDetails: { ...settings.name!, displayName: 'Paul Goldschmidt' }
          }
    )
    await render(<PlayerSettingsTab client={client} teamId="t1" userId="7" />)
    expect((labelled('First name') as HTMLInputElement).value).equals('Mookie')
    await type('First name', ' Mookie ')
    expect(saveDisabled()).equals(true)
    await type('First name', 'Paul')
    await type('Last name', 'Goldschmidt')
    await type('Jersey number', '14')
    await press('Save')
    expect(text()).includes('Cannot save')
    expect((labelled('First name') as HTMLInputElement).value).equals('Paul')
    refuse = false
    await press('Save')
    expect(saves[1].settings).deep.equals({
      name: { firstName: 'Paul', lastName: 'Goldschmidt' },
      jersey: '14'
    })
    expect(saveDisabled()).equals(true)
    expect(text()).includes('Saved.')
  })

  it('preserves complete legacy names when either or both imported parts are absent', async function () {
    for (const parts of [
      { firstName: 'Mookie', lastName: null },
      { firstName: null, lastName: 'Betts' },
      { firstName: null, lastName: null },
      { firstName: 'Mookie', lastName: null, displayName: 'Mookie' }
    ]) {
      await render(
        <PlayerSettingsTab
          client={settingsClient(
            [
              {
                ...jordan,
                nameDetails: { displayName: 'Mookie Betts', ...parts }
              }
            ],
            []
          )}
          teamId="t1"
          userId="7"
        />
      )
      expect((labelled('First name') as HTMLInputElement).value).equals(
        'Mookie'
      )
      expect((labelled('Last name') as HTMLInputElement).value).equals(
        'displayName' in parts ? '' : 'Betts'
      )
      expect(saveDisabled()).equals(true)
      await act(async () => {
        root?.unmount()
      })
      root = undefined
    }
  })

  it('keeps a surname-only name in the last-name field when adding its missing first name', async function () {
    const saves: Saved[] = []
    const entry = {
      ...jordan,
      nameDetails: { firstName: null, lastName: 'Betts', displayName: 'Betts' }
    }
    await render(
      <PlayerSettingsTab
        client={settingsClient([entry], saves, settings => ({
          ...entry,
          nameDetails: { ...settings.name!, displayName: 'Mookie Betts' }
        }))}
        teamId="t1"
        userId="7"
      />
    )
    expect((labelled('First name') as HTMLInputElement).value).equals('')
    expect((labelled('Last name') as HTMLInputElement).value).equals('Betts')
    expect(saveDisabled()).equals(true)
    await type('First name', 'Mookie')
    await press('Save')
    expect(saves[0].settings).deep.equals({
      name: { firstName: 'Mookie', lastName: 'Betts' }
    })
  })

  it('preserves a compound first name through clearing, reopening and restoring its surname', async function () {
    const saves: Saved[] = []
    let current: RosterEntry = {
      ...jordan,
      nameDetails: {
        firstName: 'Hyun Jin',
        lastName: 'Ryu',
        displayName: 'Hyun Jin Ryu'
      }
    }
    const client = settingsClient([current], saves, settings => {
      current = {
        ...current,
        nameDetails: {
          firstName:
            settings.name!.firstName === '' ? null : settings.name!.firstName,
          lastName:
            settings.name!.lastName === '' ? null : settings.name!.lastName,
          displayName: [settings.name!.firstName, settings.name!.lastName]
            .filter(Boolean)
            .join(' ')
        }
      }
      return current
    })
    client.roster = async () => [current]
    await render(<PlayerSettingsTab client={client} teamId="t1" userId="7" />)
    await type('Last name', '')
    await press('Save')
    expect((labelled('First name') as HTMLInputElement).value).equals(
      'Hyun Jin'
    )
    expect((labelled('Last name') as HTMLInputElement).value).equals('')
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    await render(<PlayerSettingsTab client={client} teamId="t1" userId="7" />)
    expect((labelled('First name') as HTMLInputElement).value).equals(
      'Hyun Jin'
    )
    await type('Last name', 'Ryu')
    await press('Save')
    expect(saves.map(saved => saved.settings)).deep.equals([
      { name: { firstName: 'Hyun Jin', lastName: '' } },
      { name: { firstName: 'Hyun Jin', lastName: 'Ryu' } }
    ])
  })

  it('loads the player’s values on this team', async function () {
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], [])}
        teamId="t1"
        userId="7"
      />
    )
    expect((labelled('Jersey number') as HTMLInputElement).value).equals('4')
    expect(checked('CF')).equals(true)
    expect(checked('SS')).equals(false)
    expect(checked('Bats Right')).equals(true)
    expect(checked('Throws Right')).equals(true)
    expect(saveDisabled()).equals(true)
  })

  it('offers Save only after a change, and sends only what changed', async function () {
    const saves: Saved[] = []
    const saved: RosterEntry[] = []
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], saves)}
        teamId="t1"
        userId="7"
        onSaved={entry => {
          saved.push(entry)
        }}
      />
    )
    // A change undone is no change.
    await press('Bats Left')
    expect(saveDisabled()).equals(false)
    await press('Bats Right')
    expect(saveDisabled()).equals(true)

    await type('Jersey number', '12')
    await press('SS')
    await press('2B')
    await press('CF')
    await press('Bats Left')
    expect(saveDisabled()).equals(false)
    await press('Save')
    expect(saves).deep.equals([
      {
        teamId: 't1',
        userId: '7',
        settings: { jersey: '12', positions: ['2B', 'SS'], bats: 'left' }
      }
    ])
    expect(saved.map(entry => entry.jersey)).deep.equals(['12'])
    expect(text()).includes('Saved.')
    expect(saveDisabled()).equals(true)
    expect(checked('SS')).equals(true)
    expect(checked('Bats Left')).equals(true)

    // The next change clears the note.
    await press('Throws Left')
    expect(text()).not.includes('Saved.')
  })

  it('keeps an error on the form, with what was typed', async function () {
    const saves: Saved[] = []
    await render(
      <PlayerSettingsTab
        client={settingsClient(
          [jordan],
          saves,
          () => new Error('jersey: A jersey number is at most 3 characters')
        )}
        teamId="t1"
        userId="7"
      />
    )
    await type('Jersey number', '1234')
    await press('Save')
    expect(text()).includes('A jersey number is at most 3 characters')
    expect((labelled('Jersey number') as HTMLInputElement).value).equals('1234')
    expect(saveDisabled()).equals(false)
  })

  it('says why when there is nothing to edit', async function () {
    await render(
      <PlayerSettingsTab
        client={settingsClient([{ ...jordan, userId: 8 }], [])}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).includes('not on this team')
    await act(async () => {
      root?.unmount()
    })
    await render(
      <PlayerSettingsTab
        client={settingsClient(new Error('offline'), [])}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).includes('Cannot load this player')
  })

  it('treats an emptied jersey as no number, and positions as a set', function () {
    const draft = {
      jersey: ' ',
      positions: ['CF' as const],
      bats: jordan.bats,
      throws: jordan.throws
    }
    expect(changesOf(jordan, draft)).deep.equals({ jersey: null })
    expect(changesOf({ ...jordan, jersey: null }, draft)).deep.equals({})
  })
})
