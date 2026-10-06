import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ageOn } from '../../common/age'
import {
  asRosterEntry,
  type Guardian,
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

interface Family {
  guardians: Guardian[] | Error
  /** `YYYY-MM`, null, or undefined for a viewer who is not shown it. */
  birthMonth?: string | null
  births: Array<{ year: number; month: number } | null>
}

function settingsClient(
  roster: RosterEntry[] | Error,
  saves: Saved[],
  answer?: (settings: PlayerSettings) => RosterEntry | Error,
  family: Family = { guardians: [], birthMonth: null, births: [] }
): TeamStationClient {
  return {
    player: async () => ({
      userId: 7,
      name: 'Jordan P',
      teams: [],
      ...(family.birthMonth === undefined
        ? {}
        : { birthMonth: family.birthMonth })
    }),
    guardians: async () => {
      if (family.guardians instanceof Error) throw family.guardians
      return family.guardians
    },
    setBirthMonth: async (
      _userId: string,
      birth: { year: number; month: number } | null
    ) => {
      family.births.push(birth)
      if (birth?.year === 1999) throw new Error('Not that year')
      return birth == null
        ? null
        : `${birth.year}-${String(birth.month).padStart(2, '0')}`
    },
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

  it('picks a birth month and a year, never a day, and can clear it', async function () {
    const family: Family = { guardians: [], birthMonth: null, births: [] }
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], [], undefined, family)}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).includes('BIRTH MONTH')
    expect(text()).includes('Not set')
    expect(document.querySelector('[aria-label*="Day"]')).equals(null)
    const saveBirth = (): boolean =>
      labelled('Save birth month').getAttribute('aria-disabled') === 'true'
    expect(saveBirth()).equals(true)
    expect(labelled('Clear birth month').getAttribute('aria-disabled')).equals(
      'true'
    )

    const year = new Date().getUTCFullYear() - 12
    await press('Month March')
    expect(checked('Month March')).equals(true)
    await press('One year earlier')
    await press('One year earlier')
    await press('One year later')
    expect(text()).includes(String(year - 1))
    await press('Save birth month')
    expect(family.births).deep.equals([{ year: year - 1, month: 3 }])
    expect(text()).includes(
      `Born March ${year - 1} \u00b7 ${ageOn(year - 1, 3, new Date())} today`
    )
    expect(text()).includes('Birth month saved.')
    expect(saveBirth()).equals(true)

    await press('Clear birth month')
    expect(family.births.at(-1)).equals(null)
    expect(text()).includes('Not set')
    expect(text()).includes('Birth month cleared.')

    // A refusal stays on the form.
    for (let n = year - 1; n > 1999; n -= 1) await press('One year earlier')
    await press('Month May')
    await press('Save birth month')
    expect(text()).includes('Not that year')
  })

  it('shows no birth month to somebody the server does not show it to', async function () {
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], [], undefined, {
          guardians: [],
          births: []
        })}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).not.includes('BIRTH MONTH')
    expect(text()).includes('GUARDIANS AND FAMILY')
  })

  it('reads a birth month already set', async function () {
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], [], undefined, {
          guardians: [],
          birthMonth: '2012-11',
          births: []
        })}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).includes('Born November 2012')
    expect(checked('Month November')).equals(true)
  })

  it('lists the guardians and family, and opens the modal to change them', async function () {
    const family: Family = {
      guardians: [
        { userId: 11, name: 'Gale Guardian', email: 'g1@x', kind: 'guardian' },
        { userId: 12, name: 'Blair Brooks', email: null, kind: 'family' }
      ],
      births: []
    }
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], [], undefined, family)}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).includes('GUARDIANS AND FAMILY')
    expect(text()).includes('Gale Guardian')
    expect(text()).includes('Guardian \u00b7 g1@x')
    expect(text()).includes('Family')
    await press('Change guardians and family')
    expect(text()).includes('Guardians and family of Jordan P')
    await press('Done')
    expect(text()).not.includes('Guardians and family of Jordan P')
  })

  it('says when the guardians cannot be read', async function () {
    await render(
      <PlayerSettingsTab
        client={settingsClient([jordan], [], undefined, {
          guardians: new Error('offline'),
          births: []
        })}
        teamId="t1"
        userId="7"
      />
    )
    expect(text()).includes('Cannot load the guardians.')
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
