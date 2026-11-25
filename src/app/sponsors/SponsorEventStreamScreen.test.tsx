import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'

import {
  emptySponsorState,
  type FakeSponsorClient,
  fakeSponsorClient,
  usedSponsorState
} from '../../test/fakeSponsorClient'
import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import { createApiSponsorStore } from './apiSponsorStore'
import { SponsorEventStreamScreen } from './SponsorEventStreamScreen'
import type { PickedFile, PreparedFile, SponsorState } from './sponsorTypes'

const NOW = new Date('2026-11-24T20:00:00.000Z')
const LEAGUE = 'lea_al'

let urlCount = 0
const createObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
before(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (file: File) => `blob:${file.name}#${++urlCount}`
  })
})
after(() => {
  if (createObjectURL == null) Reflect.deleteProperty(URL, 'createObjectURL')
  else Object.defineProperty(URL, 'createObjectURL', createObjectURL)
})
afterEach(async () => {
  await unmount()
})

const image = (name: string, type: string): File =>
  new window.File([new Uint8Array(8)], name, { type })

/** Row pictures "shrunk" as they are, recorded by purpose. */
function shrinker(): {
  shrunk: string[]
  prepare: (purpose: string, picked: PickedFile) => Promise<PreparedFile>
} {
  const shrunk: string[] = []
  return {
    shrunk,
    prepare: async (purpose, picked) => {
      shrunk.push(`${purpose} ${picked.name}`)
      return {
        ...picked,
        bytes: new Uint8Array(3),
        size: 3,
        width: 128,
        height: 128
      }
    }
  }
}

async function open({
  canManage = true,
  state = usedSponsorState(NOW),
  now = NOW
}: { canManage?: boolean; state?: SponsorState; now?: Date } = {}): Promise<{
  client: FakeSponsorClient
  shrunk: string[]
}> {
  const client = fakeSponsorClient({ state, now: () => now, canManage })
  const { shrunk, prepare } = shrinker()
  await mount(
    <SponsorEventStreamScreen
      client={client}
      league={LEAGUE}
      store={createApiSponsorStore(client, LEAGUE, { prepare })}
      now={() => now}
    />
  )
  await settle(0)
  return { client, shrunk }
}

async function choose(testID: string, file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    `[data-testid="${testID}-input"]`
  )
  expect(input, testID).not.equals(null)
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input!.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle(0)
}

const placements = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-testid="sponsor-placement"]')
]
const slots = (): string =>
  document.querySelector('[data-testid="sponsor-slots-left"]')?.textContent ??
  ''
const disabled = (label: string): boolean =>
  find(label)?.getAttribute('aria-disabled') === 'true'

async function fillRow(): Promise<void> {
  await choose('sponsor-logo-drop', image('logo.jpg', 'image/jpeg'))
  await choose('sponsor-background-drop', image('field.png', 'image/png'))
  await fill('Title', 'Bayside Bakery')
  await fill('Message', 'Fresh bread for every team after the game.')
  await fill('Website', 'https://example.test/bread')
  await fill('Date and time', '2026-12-01T17:30')
}

describe('U11 the Sponsor in Event Stream screen on the API store', () => {
  it('lists the league’s rows, newest first, with the slots the server holds', async () => {
    await open()
    expect(text()).includes('Sponsor in Event Stream')
    expect(slots()).equals('8 of 10 event stream slots left')
    expect(placements().map(each => each.textContent)).satisfies(
      (rows: string[]) =>
        rows[0].includes('Lakeside Pizza') && rows[1].includes('Summit Dental')
    )
    expect(text()).not.includes('Demo data')
  })

  it('reads its empty state for a league with no rows', async () => {
    await open({ state: emptySponsorState() })
    expect(text()).includes('No sponsored rows yet. Add one below.')
    expect(slots()).equals('10 of 10 event stream slots left')
  })

  it('places a row with a JPEG logo, a background and White text, using a slot', async () => {
    const { client, shrunk } = await open({ state: emptySponsorState() })
    await fillRow()
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="tab"][aria-label="White"]')
        ?.click()
    })
    expect(disabled('Save')).equals(false)
    await press('Save')
    await settle(0)
    expect(shrunk).deep.equals(['rowLogo logo.jpg', 'rowBackground field.png'])
    expect(slots()).equals('9 of 10 event stream slots left')
    const placed = client.state().placements[0]
    expect(placed).deep.include({
      title: 'Bayside Bakery',
      url: 'https://example.test/bread',
      textColor: 'white',
      startsAt: new Date('2026-12-01T17:30').toISOString()
    })
    expect(
      [...client.media.values()].map(each => `${each.purpose} ${each.type}`)
    ).deep.equals(['rowLogo image/jpeg', 'rowBackground image/png'])
    expect(placements()).has.length(1)
  })

  it('shows the sentences for an http address and a 21-character title, holding Save', async () => {
    await open({ state: emptySponsorState() })
    await fillRow()
    await fill('Title', 'Bayside Bakery Breads')
    await fill('Website', 'http://example.test/bread')
    expect(text()).includes('20')
    expect(document.querySelectorAll('[role="alert"]').length).equals(2)
    expect(disabled('Save')).equals(true)
  })

  it('refuses a picture that is not JPEG or PNG', async () => {
    await open({ state: emptySponsorState() })
    await choose('sponsor-logo-drop', image('logo.gif', 'image/gif'))
    expect(text()).includes('Images must be JPEG or PNG.')
  })

  it('edits a row within 24 hours, moving its date and time, and keeps its pictures', async () => {
    const { client, shrunk } = await open()
    await press('Edit Lakeside Pizza')
    expect(text().toLowerCase()).includes('edit sponsored row')
    await fill('Date and time', '2026-12-03T09:00')
    await press('Save')
    await settle(0)
    expect(shrunk).deep.equals([])
    const row = client
      .state()
      .placements.find(each => each.id === 'ser_lakeside')!
    expect(row.startsAt).equals(new Date('2026-12-03T09:00').toISOString())
    expect(row.textColor).equals('white')
    expect(row.logoUrl).equals(usedSponsorState(NOW).placements[1].logoUrl)
  })

  it('offers only Delete after 24 hours, and deleting keeps the slot', async () => {
    await open()
    expect(find('Edit Summit Dental')).equals(undefined)
    expect(find('Delete Summit Dental')).not.equals(undefined)
    expect(text()).includes(
      'Placed more than 24 hours ago: it can be deleted, but not edited or moved, and its slot stays used.'
    )
    await press('Delete Summit Dental')
    await settle(50)
    expect(text()).includes('its slot stays used')
    await press('Delete')
    await settle(50)
    expect(slots()).equals('8 of 10 event stream slots left')
    expect(placements()).has.length(1)
  })

  it('returns the slot of a row deleted within 24 hours', async () => {
    await open()
    await press('Delete Lakeside Pizza')
    await settle(50)
    expect(text()).includes('so its slot returns')
    await press('Delete')
    await settle(50)
    expect(slots()).equals('9 of 10 event stream slots left')
  })

  it('says when every slot is used', async () => {
    const state = usedSponsorState(NOW)
    state.keptSlots = 8
    await open({ state })
    expect(text()).includes('All 10 event stream slots are used.')
  })

  it('previews the row being written in a Schedule between two games', async () => {
    await open({ state: emptySponsorState() })
    await fill('Title', 'Bayside Bakery')
    const preview = document.querySelector(
      '[data-testid="sponsor-schedule-preview"]'
    )!
    expect(preview.textContent).includes('Bayside Bakery')
    expect(preview.textContent).includes('Sponsored')
    await press('Cancel')
    expect(preview.textContent).not.includes('Bayside Bakery')
  })

  it('shows a league viewer only that it is for administrators', async () => {
    await open({ canManage: false })
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })
})
