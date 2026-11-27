import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'
import { Image } from 'react-native'

import { badRequest } from '../../common/errors'
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
import { SponsorLogosScreen } from './SponsorLogosScreen'
import { sponsorStoreFor } from './sponsorStore'
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

const png = (name = 'Bayside Bakery.png'): File =>
  new window.File([new Uint8Array(16)], name, { type: 'image/png' })
const jpeg = new window.File([new Uint8Array(16)], 'field.jpg', {
  type: 'image/jpeg'
})

/** A shrink that answers `size` for every logo, recording what it was given. */
function shrinkTo(
  size = { width: 480, height: 270 },
  shrunk: PickedFile[] = []
): (purpose: string, picked: PickedFile) => Promise<PreparedFile> {
  return async (_purpose, picked) => {
    shrunk.push(picked)
    return {
      ...picked,
      bytes: new Uint8Array(9),
      size: 9,
      url: `blob:shrunk-${picked.name}`,
      ...size
    }
  }
}

async function open({
  canManage = true,
  state = usedSponsorState(NOW),
  prepare = shrinkTo()
}: {
  canManage?: boolean | 'fails'
  state?: SponsorState
  prepare?: (purpose: string, picked: PickedFile) => Promise<PreparedFile>
} = {}): Promise<FakeSponsorClient> {
  const client = fakeSponsorClient({ state, now: () => NOW, canManage })
  await mount(
    <SponsorLogosScreen
      client={client}
      league={LEAGUE}
      prepare={prepare}
      attachSample={() => () => undefined}
    />
  )
  await settle(0)
  return client
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

describe('U11 the Sponsor Video Logos screen on the API store', () => {
  it('lists the league’s logos under their headers, with the credits the server holds', async () => {
    const client = await open()
    const page = text()
    expect(page).includes('Sponsor Video Logos')
    expect(page).includes(
      'Your sponsor logo appears in the upper-right of every applicable game video, overlaid during playback on Apple TV, web, and mobile.'
    )
    for (const header of ['Logo', 'Games used', 'Games remaining', 'Action'])
      expect(page).includes(header)
    expect(page).includes('Remaining game logo credits: 120 of 300')
    expect(rowCount()).equals(3)
    expect(row('slg_harbor')).includes('Harbor Hardware')
    expect(row('slg_harbor')).includes('4258')
    expect(row('slg_lakeside')).includes('Inactive')
    expect(page).not.includes('Demo data')
    expect(client.calls.map(call => call.name)).includes('sponsorState')
    // The node's sample plays behind the previews.
    expect(document.querySelector('video')?.getAttribute('src')).equals(
      'https://example.test/sponsors/sample/default.mp4'
    )
  })

  it('reads "No logos yet. Add one above." for a league with none, at 300 of 300', async () => {
    await open({ state: emptySponsorState() })
    expect(text()).includes('No logos yet. Add one above.')
    expect(text()).not.includes('Games used')
    expect(text()).includes('Remaining game logo credits: 300 of 300')
  })

  it('refuses a JPEG with its sentence, shrinking nothing', async () => {
    const shrunk: PickedFile[] = []
    await open({ prepare: shrinkTo(undefined, shrunk) })
    await choose(ADD, jpeg)
    expect(text()).includes('Logos must be PNG files.')
    expect(pending()).equals(null)
    expect(preview()).equals(null)
    expect(shrunk).deep.equals([])
  })

  it('shows why a logo could not be shrunk', async () => {
    await open({
      prepare: async () => {
        throw new Error('This picture could not be read. Try another file.')
      }
    })
    await choose(ADD, png())
    expect(text()).includes('This picture could not be read. Try another file.')
    expect(pending()).equals(null)
  })

  it('previews the shrunk PNG over the video, with Accept held until the credits are valid, and Cancel uploads nothing', async () => {
    const client = await open()
    await choose(ADD, png())
    expect(preview(), 'the preview').not.equals(null)
    expect(
      document
        .querySelector('[data-testid="sponsor-logo-preview"] img')
        ?.getAttribute('src')
    ).equals('blob:shrunk-Bayside Bakery.png')
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
    expect(client.calls.map(call => call.name)).not.includes(
      'uploadSponsorMedia'
    )
  })

  it('uploads and adds an accepted logo with its credits', async () => {
    const client = await open()
    await choose(ADD, png())
    await fill('Credits for this logo', '50')
    await press('Accept')
    await settle(0)
    expect(pending()).equals(null)
    expect(rowCount()).equals(4)
    expect(text()).includes('Bayside Bakery')
    expect(text()).includes('Remaining game logo credits: 70 of 300')
    expect([...client.media.values()]).deep.equals([
      { purpose: 'logo', type: 'image/png', bytes: 9 }
    ])
    expect(client.state().logos.at(-1)).deep.include({
      name: 'Bayside Bakery',
      allocation: 50
    })
  })

  it('says when no credits are left to assign', async () => {
    const client = await open()
    await act(async () => {
      await sponsorStoreFor(LEAGUE, client).setLogoAllocation('slg_summit', 170)
    })
    await choose(ADD, png())
    expect(text()).includes('No game logo credits left to assign')
    expect(disabled('No game logo credits left to assign')).equals(true)
  })

  it('confirms Deactivate, and Cancel changes nothing', async () => {
    await open()
    await press('Deactivate Harbor Hardware')
    await settle(50)
    expect(text()).includes('Deactivate Harbor Hardware?')
    expect(text()).includes('stays listed as inactive')
    await press('Cancel')
    await settle(50)
    expect(row('slg_harbor')).not.includes('Inactive')
    expect(text()).includes('Remaining game logo credits: 120 of 300')
  })

  it('keeps a used logo as inactive, and removes an unused one with its credits', async () => {
    await open()
    await press('Deactivate Harbor Hardware')
    await settle(50)
    await press('Deactivate')
    await settle(50)
    expect(row('slg_harbor')).includes('Inactive')
    expect(text()).includes('Remaining game logo credits: 120 of 300')
    await press('Deactivate Summit Dental')
    await settle(50)
    expect(text()).includes('so it is removed')
    await press('Deactivate')
    await settle(50)
    expect(row('slg_summit')).equals('')
    expect(text()).includes('Remaining game logo credits: 170 of 300')
  })

  it('shows a league viewer only that it is for administrators', async () => {
    await open({ canManage: false })
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })

  it('treats a league that cannot be read as not the viewer’s to manage', async () => {
    await open({ canManage: 'fails' })
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })

  it('draws the pending logo in the upper-right at its own proportions', async () => {
    await open({ prepare: shrinkTo({ width: 480, height: 120 }) })
    await choose(ADD, png())
    await settle(0)
    const style = (preview() as HTMLElement).style
    // A quarter of the frame's width, at 4:1.
    expect(parseFloat(style.width)).closeTo(25, 1e-6)
    expect(parseFloat(style.height)).closeTo((25 * 16) / 9 / 4, 1e-6)
    expect(parseFloat(style.top)).closeTo(5, 1e-6)
    expect(parseFloat(style.left)).closeTo(70, 1e-6)
  })

  it('draws a listed logo at the size its picture loads at', async () => {
    const getSize = Object.getOwnPropertyDescriptor(Image, 'getSize')!
    Object.defineProperty(Image, 'getSize', {
      configurable: true,
      value: (
        _uri: string,
        success: (width: number, height: number) => void
      ) => {
        success(100, 400)
      }
    })
    try {
      await open()
      await act(async () => {
        document
          .querySelector<HTMLElement>('[aria-label="Preview Harbor Hardware"]')
          ?.click()
      })
      await settle(0)
      const style = (preview() as HTMLElement).style
      // A quarter of the frame's height, at 1:4.
      expect(parseFloat(style.height)).closeTo(25, 1e-6)
    } finally {
      Object.defineProperty(Image, 'getSize', getSize)
    }
  })

  it('shows why an accepted logo was refused, and keeps it pending', async () => {
    const client = await open()
    client.failNext(
      'addSponsorLogo',
      badRequest('Only 10 game logo credits are left to assign.')
    )
    await choose(ADD, png())
    await fill('Credits for this logo', '50')
    await press('Accept')
    await settle(0)
    expect(text()).includes('Only 10 game logo credits are left to assign.')
    expect(pending(), 'still pending').not.equals(null)
    expect(rowCount()).equals(3)
  })

  it('edits a logo’s remaining games in place: refuses too many, saves, and shows a server refusal', async () => {
    const client = await open()
    await press('Edit remaining, Summit Dental')
    await fill('Remaining, Summit Dental', '200')
    expect(text()).includes('Only 170 game logo credits are left to assign.')
    expect(disabled('Save remaining, Summit Dental')).equals(true)
    await fill('Remaining, Summit Dental', '60')
    client.failNext(
      'setSponsorLogoAllocation',
      badRequest('That logo is no longer listed.')
    )
    await press('Save remaining, Summit Dental')
    await settle(0)
    expect(text()).includes('That logo is no longer listed.')
    await fill('Remaining, Summit Dental', '60')
    await press('Save remaining, Summit Dental')
    await settle(0)
    expect(client.state().logos[1]).deep.include({ allocation: 60, used: 0 })
    expect(text()).includes('Remaining game logo credits: 110 of 300')
  })

  it('drops an in-place edit on Escape, or on leaving the field unchanged, and saves on Enter', async () => {
    const client = await open()
    await press('Edit remaining, Summit Dental')
    const field = (): HTMLInputElement =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Remaining, Summit Dental"]'
      )!
    await act(async () => {
      field().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(
      document.querySelector('input[aria-label="Remaining, Summit Dental"]')
    ).equals(null)
    await press('Edit remaining, Summit Dental')
    await act(async () => {
      field().focus()
      field().blur()
    })
    expect(
      document.querySelector('input[aria-label="Remaining, Summit Dental"]')
    ).equals(null)
    await press('Edit remaining, Summit Dental')
    await fill('Remaining, Summit Dental', '40')
    await act(async () => {
      field().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      )
    })
    await settle(0)
    expect(client.state().logos[1].allocation).equals(40)
  })
})
