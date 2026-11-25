import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { Image } from 'react-native'

import {
  fill,
  find,
  mount,
  press,
  settle,
  text,
  unmount
} from '../../test/gameFormDom'
import type { SampleClient } from './sampleRecording'
import { SponsorLogosScreen } from './SponsorLogosScreen'
import { createMockSponsorStore, type SponsorStore } from './sponsorStore'

const NOW = new Date('2026-11-24T20:00:00.000Z')

function fakeClient(canManage: boolean | 'fails' = true): SampleClient {
  return {
    group: async () => {
      if (canManage === 'fails') throw new Error('offline')
      return { canManage, children: [] }
    }
  } as unknown as SampleClient
}

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

const png = (name = 'Bayside Bakery.png'): File =>
  new window.File([new Uint8Array(16)], name, { type: 'image/png' })
const jpeg = new window.File([new Uint8Array(16)], 'field.jpg', {
  type: 'image/jpeg'
})

async function open(
  canManage: boolean | 'fails' = true
): Promise<SponsorStore> {
  const store = createMockSponsorStore({ now: () => NOW })
  await mount(
    <SponsorLogosScreen
      client={fakeClient(canManage)}
      league="lea_demo"
      store={store}
      findSample={async () => ({ kind: 'none' })}
    />
  )
  await settle(0)
  return store
}

/** Hands `file` to the file input picked out by `selector`. */
async function choose(selector: string, file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(selector)
  expect(input, selector).not.equals(null)
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => {
    input!.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle(0)
}
const ADD = '[data-testid="sponsor-drop-zone-input"]'
const CHANGE = '[data-testid="sponsor-change-input"]'

const pending = (): Element | null =>
  document.querySelector('[data-testid="sponsor-logo-pending"]')
const preview = (): Element | null =>
  document.querySelector('[data-testid="sponsor-logo-preview"]')
const row = (id: string): string =>
  document.querySelector(`[data-testid="sponsor-row-${id}"]`)?.textContent ?? ''
const rowCount = (): number =>
  document.querySelectorAll('[data-testid^="sponsor-row-"]').length
const disabled = (label: string): boolean =>
  find(label)?.getAttribute('aria-disabled') === 'true'

describe('the Sponsor Video Logos screen', () => {
  it('lists the seeded logos under their headers, with the credits left', async () => {
    await open()
    const page = text()
    expect(page).includes('Sponsor Video Logos')
    expect(page).includes(
      'Your sponsor logo appears in the upper-right of every applicable game video, overlaid during playback on Apple TV, web, and mobile.'
    )
    for (const header of ['Logo', 'Games used', 'Games remaining', 'Action'])
      expect(page).includes(header)
    expect(page).includes('Remaining game logo credits: 120 of 300')
    expect(page).includes('No recording to preview')
    expect(rowCount()).equals(3)
    expect(row('logo-harbor-hardware')).includes('Harbor Hardware')
    expect(row('logo-harbor-hardware')).includes('4258')
    expect(row('logo-lakeside-pizza')).includes('Inactive')
    expect(text()).includes('Demo data — nothing here is saved.')
  })

  it('refuses a JPEG with its sentence and nothing pending', async () => {
    await open()
    await choose(ADD, jpeg)
    expect(text()).includes('Logos must be PNG files.')
    expect(pending()).equals(null)
    expect(preview()).equals(null)
  })

  it('previews a PNG over the video, with Accept held until the credits are valid, and Cancel drops it', async () => {
    await open()
    await choose(ADD, png())
    expect(preview(), 'the preview').not.equals(null)
    expect(text()).includes('Up to 120 game logo credits left')
    expect(disabled('Accept')).equals(true)
    await fill('Credits for this logo', '121')
    expect(text()).includes('Only 120 game logo credits are left to assign.')
    expect(disabled('Accept')).equals(true)
    await fill('Credits for this logo', '50')
    expect(disabled('Accept')).equals(false)
    await press('Cancel')
    expect(pending()).equals(null)
    expect(preview()).equals(null)
    expect(rowCount()).equals(3)
    expect(text()).includes('Remaining game logo credits: 120 of 300')
  })

  it('adds an accepted logo with its credits', async () => {
    const store = await open()
    await choose(ADD, png())
    await fill('Credits for this logo', '50')
    await press('Accept')
    await settle(0)
    expect(pending()).equals(null)
    expect(rowCount()).equals(4)
    expect(text()).includes('Bayside Bakery')
    expect(text()).includes('Remaining game logo credits: 70 of 300')
    const added = (await store.read()).logos.at(-1)!
    expect(added).deep.include({ name: 'Bayside Bakery', allocation: 50 })
  })

  it('says when no credits are left to assign', async () => {
    const store = await open()
    await act(async () => {
      await store.setLogoAllocation('logo-summit-dental', 170)
    })
    await choose(ADD, png())
    expect(text()).includes('No game logo credits left to assign')
    expect(disabled('No game logo credits left to assign')).equals(true)
  })

  it('checks a row’s allocation and saves it', async () => {
    await open()
    await fill('Games allocated, Harbor Hardware', '300')
    expect(text()).includes('Only 220 game logo credits are left to assign.')
    expect(disabled('Save games allocated, Harbor Hardware')).equals(true)
    await fill('Games allocated, Harbor Hardware', '120')
    expect(disabled('Save games allocated, Harbor Hardware')).equals(false)
    await press('Save games allocated, Harbor Hardware')
    await settle(0)
    // Used 42 of 120.
    expect(row('logo-harbor-hardware')).includes('4278')
    expect(text()).includes('Remaining game logo credits: 100 of 300')
  })

  it('shows a refused save’s sentence on the row', async () => {
    const store = await open()
    store.setLogoAllocation = async () => {
      throw new Error('Harbor Hardware could not be saved.')
    }
    await fill('Games allocated, Harbor Hardware', '110')
    await press('Save games allocated, Harbor Hardware')
    await settle(0)
    expect(row('logo-harbor-hardware')).includes(
      'Harbor Hardware could not be saved.'
    )
  })

  it('confirms Deactivate, and Cancel changes nothing', async () => {
    await open()
    await press('Deactivate Harbor Hardware')
    await settle(50)
    expect(text()).includes('Deactivate Harbor Hardware?')
    expect(text()).includes('stays listed as inactive')
    await press('Cancel')
    await settle(50)
    expect(row('logo-harbor-hardware')).not.includes('Inactive')
    expect(text()).includes('Remaining game logo credits: 120 of 300')
  })

  it('keeps a used logo as inactive, and removes an unused one with its credits', async () => {
    await open()
    await press('Deactivate Harbor Hardware')
    await settle(50)
    await press('Deactivate')
    await settle(50)
    expect(row('logo-harbor-hardware')).includes('Inactive')
    expect(find('Change Logo, Harbor Hardware')).equals(undefined)
    expect(text()).includes('Remaining game logo credits: 120 of 300')
    await press('Deactivate Summit Dental')
    await settle(50)
    expect(text()).includes('so it is removed')
    await press('Deactivate')
    await settle(50)
    expect(row('logo-summit-dental')).equals('')
    expect(text()).includes('Remaining game logo credits: 170 of 300')
  })

  it('changes a logo’s picture and keeps its counts', async () => {
    const store = await open()
    let chooserOpened = 0
    document.querySelector(CHANGE)!.addEventListener('click', () => {
      chooserOpened++
    })
    await press('Change Logo, Harbor Hardware')
    expect(chooserOpened).equals(1)
    await choose(CHANGE, png('Harbor new.png'))
    expect(preview(), 'the preview').not.equals(null)
    expect(text()).includes(
      'Games already assigned Harbor Hardware keep the version they had.'
    )
    expect(
      document.querySelector('input[aria-label="Credits for this logo"]')
    ).equals(null)
    await press('Accept')
    await settle(0)
    const harbor = (await store.read()).logos.find(
      logo => logo.id === 'logo-harbor-hardware'
    )!
    expect(harbor.imageUrl).match(/^blob:Harbor new\.png#/)
    expect(harbor).deep.include({ version: 2, allocation: 100, used: 42 })
    expect(row('logo-harbor-hardware')).includes('4258')
    expect(text()).includes('Remaining game logo credits: 120 of 300')
  })

  it('refuses a changed picture that is not a PNG', async () => {
    await open()
    await press('Change Logo, Harbor Hardware')
    await choose(CHANGE, jpeg)
    expect(text()).includes('Logos must be PNG files.')
    expect(pending()).equals(null)
  })

  it('clears every row, and puts the samples back', async () => {
    await open()
    await press('Clear all rows')
    await settle(0)
    expect(text()).includes('No logos yet. Add one above.')
    expect(text()).not.includes('Games used')
    expect(text()).includes('Remaining game logo credits: 300 of 300')
    await press('Reset to sample rows')
    await settle(0)
    expect(rowCount()).equals(3)
    expect(text()).includes('Remaining game logo credits: 120 of 300')
  })

  it('shows a league viewer only that it is for administrators', async () => {
    await open(false)
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })

  it('treats a league that cannot be read as not the viewer’s to manage', async () => {
    await open('fails')
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })

  it('draws the pending logo in the upper-right at its own proportions', async () => {
    const getSize = Object.getOwnPropertyDescriptor(Image, 'getSize')!
    Object.defineProperty(Image, 'getSize', {
      configurable: true,
      value: (
        _uri: string,
        success: (width: number, height: number) => void
      ) => {
        success(480, 120)
      }
    })
    try {
      await open()
      await choose(ADD, png())
      await settle(0)
      const style = (preview() as HTMLElement).style
      // A quarter of the frame's width, at 4:1.
      expect(style.width).equals('25%')
      expect(parseFloat(style.height)).closeTo((25 * 16) / 9 / 4, 1e-6)
      expect(style.top).equals('5%')
      expect(style.left).equals('70%')
    } finally {
      Object.defineProperty(Image, 'getSize', getSize)
    }
  })

  it('shows why an accepted logo was refused, and keeps it pending', async () => {
    const store = await open()
    store.addLogo = async () => {
      throw new Error('Only 10 game logo credits are left to assign.')
    }
    await choose(ADD, png())
    await fill('Credits for this logo', '50')
    await press('Accept')
    await settle(0)
    expect(text()).includes('Only 10 game logo credits are left to assign.')
    expect(pending(), 'still pending').not.equals(null)
    expect(rowCount()).equals(3)
  })
})
