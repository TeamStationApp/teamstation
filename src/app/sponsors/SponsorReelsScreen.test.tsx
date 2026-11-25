import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'

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
import { SponsorReelsScreen } from './SponsorReelsScreen'
import { createMockSponsorStore, type SponsorStore } from './sponsorStore'
import type { PickedFile } from './sponsorTypes'

const NOW = new Date('2026-11-24T20:00:00.000Z')

const NOTE =
  'Each broadcast reel will be evenly distributed across all videos recorded by your league. One broadcast credit is used at the beginning of each game and between each half-inning, until the allocated broadcast count is depleted.'
const LIMITS =
  'Reels are 10 to 15 seconds long and 640 × 360. Larger videos are shrunk automatically to fit 640 × 360, keeping their proportions. After shrinking, a reel can be at most 3.2 MB.'

function fakeClient(canManage = true): SampleClient {
  return {
    group: async () => ({ canManage, children: [] })
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

const webm = (name: string): File =>
  new window.File([new Uint8Array(16)], name, { type: 'video/webm' })

/**
 * Each stubbed video's length, by its name: a number, `'unreadable'` to
 * reject, or `'never'` to wait for `release`.
 */
const LENGTHS: Record<string, number | 'unreadable' | 'never'> = {
  'Bayside Bakery.webm': 12,
  'long.webm': 20,
  'broken.webm': 'unreadable',
  'Harbor new.webm': 11,
  'slow.webm': 'never'
}
let release: ((seconds: number) => void) | undefined
const readDuration = async (picked: PickedFile): Promise<number> => {
  const length = LENGTHS[picked.name]
  if (length === 'unreadable')
    throw new Error('This video could not be read. Try another file.')
  if (length === 'never')
    return await new Promise<number>(resolve => {
      release = resolve
    })
  return length ?? NaN
}

async function open(canManage = true): Promise<SponsorStore> {
  const store = createMockSponsorStore({ now: () => NOW })
  await mount(
    <SponsorReelsScreen
      client={fakeClient(canManage)}
      league="lea_demo"
      store={store}
      findSample={async () => ({ kind: 'none' })}
      readDuration={readDuration}
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
  document.querySelector('[data-testid="sponsor-reel-pending"]')
const preview = (): HTMLElement | null =>
  document.querySelector('[data-testid="sponsor-reel-preview"]')
const row = (id: string): string =>
  document.querySelector(`[data-testid="sponsor-row-${id}"]`)?.textContent ?? ''
const rowCount = (): number =>
  document.querySelectorAll('[data-testid^="sponsor-row-"]').length
const disabled = (label: string): boolean =>
  find(label)?.getAttribute('aria-disabled') === 'true'

describe('the Sponsor Video Reels screen', () => {
  it('lists the seeded reels under their headers, with the note, the limits and the credits left', async () => {
    await open()
    const page = text()
    expect(page).includes('Sponsor Video Reels')
    expect(page).includes(
      "Reels play in the scoreboard's place over a single landscape video."
    )
    expect(page).includes(LIMITS)
    expect(page).includes(NOTE)
    for (const header of [
      'Video reel',
      'Broadcasts used',
      'Broadcasts remaining',
      'Action'
    ])
      expect(page).includes(header)
    expect(page).includes('Remaining reel broadcast credits: 500 of 1,000')
    expect(page).includes('No recording to preview')
    expect(rowCount()).equals(2)
    expect(row('reel-harbor-hardware')).includes('Harbor Hardware')
    expect(row('reel-harbor-hardware')).includes('12 s')
    // Used 120 of 400.
    expect(row('reel-harbor-hardware')).includes('120280')
    expect(row('reel-ridgeview-auto')).includes('15 s')
    expect(find('Change Reel, Ridgeview Auto')).not.equals(undefined)
  })

  it('refuses a 20 second reel with its sentence and nothing pending', async () => {
    await open()
    await choose(ADD, webm('long.webm'))
    expect(text()).includes(
      'This reel is 20 seconds. Reels must be 10 to 15 seconds long.'
    )
    expect(pending()).equals(null)
    expect(preview()).equals(null)
  })

  it('refuses a video whose length cannot be read', async () => {
    await open()
    await choose(ADD, webm('broken.webm'))
    expect(text()).includes('This video could not be read. Try another file.')
    expect(pending()).equals(null)
  })

  it('refuses a file that is not a video', async () => {
    await open()
    await choose(
      ADD,
      new window.File([new Uint8Array(4)], 'logo.png', { type: 'image/png' })
    )
    expect(text()).includes('Choose a video file.')
    expect(pending()).equals(null)
  })

  it('previews a 12 second reel in the scoreboard’s place, and Accept with 100 leaves 400', async () => {
    const store = await open()
    await choose(ADD, webm('Bayside Bakery.webm'))
    const shown = preview()
    expect(shown, 'the preview').not.equals(null)
    expect(shown!.style.width).match(/^33\.33/)
    expect(shown!.style.height).match(/^33\.33/)
    expect(shown!.style.left).equals('1%')
    expect(shown!.style.top).equals('1%')
    const video = shown!.querySelector('video')!
    expect(video.muted).equals(true)
    expect(video.loop).equals(true)
    expect(video.getAttribute('src')).match(/^blob:Bayside Bakery\.webm#/)
    expect(text()).includes('Bayside Bakery.webm · 12 s')
    expect(text()).includes('Up to 500 broadcast credits left')
    expect(disabled('Accept')).equals(true)
    await fill('Broadcasts for this reel', '501')
    expect(text()).includes('Only 500 broadcast credits are left to assign.')
    expect(disabled('Accept')).equals(true)
    await fill('Broadcasts for this reel', '100')
    expect(disabled('Accept')).equals(false)
    await press('Accept')
    await settle(0)
    expect(pending()).equals(null)
    expect(preview()).equals(null)
    expect(rowCount()).equals(3)
    expect(text()).includes('Remaining reel broadcast credits: 400 of 1,000')
    const added = (await store.read()).reels.at(-1)!
    expect(added).deep.include({
      name: 'Bayside Bakery',
      allocation: 100,
      durationSec: 12,
      used: 0
    })
    expect(row(added.id)).includes('12 s')
    expect(
      document.querySelector(`[data-testid="sponsor-row-${added.id}"] video`)
    ).not.equals(null)
  })

  it('drops a pending reel on Cancel', async () => {
    await open()
    await choose(ADD, webm('Bayside Bakery.webm'))
    await press('Cancel')
    expect(pending()).equals(null)
    expect(preview()).equals(null)
    expect(rowCount()).equals(2)
  })

  it('drops a length read that a newer pick overtook', async () => {
    await open()
    await choose(ADD, webm('slow.webm'))
    expect(text()).includes("Reading the reel's length…")
    await choose(ADD, webm('long.webm'))
    expect(text()).includes('This reel is 20 seconds.')
    await act(async () => {
      release?.(12)
    })
    await settle(0)
    expect(pending()).equals(null)
    expect(text()).includes('This reel is 20 seconds.')
  })

  it('says when no broadcast credits are left to assign', async () => {
    const store = await open()
    await act(async () => {
      await store.setReelAllocation('reel-ridgeview-auto', 600)
    })
    await choose(ADD, webm('Bayside Bakery.webm'))
    expect(text()).includes('No broadcast credits left to assign')
    expect(disabled('No broadcast credits left to assign')).equals(true)
  })

  it('shows why an accepted reel was refused, and keeps it pending', async () => {
    const store = await open()
    store.addReel = async () => {
      throw new Error('Only 10 broadcast credits are left to assign.')
    }
    await choose(ADD, webm('Bayside Bakery.webm'))
    await fill('Broadcasts for this reel', '100')
    await press('Accept')
    await settle(0)
    expect(text()).includes('Only 10 broadcast credits are left to assign.')
    expect(pending(), 'still pending').not.equals(null)
  })

  it('checks a row’s allocation and saves it', async () => {
    await open()
    await fill('Broadcasts allocated, Harbor Hardware', '901')
    expect(text()).includes('Only 900 broadcast credits are left to assign.')
    await fill('Broadcasts allocated, Harbor Hardware', '450')
    await press('Save broadcasts allocated, Harbor Hardware')
    await settle(0)
    expect(row('reel-harbor-hardware')).includes('120330')
    expect(text()).includes('Remaining reel broadcast credits: 450 of 1,000')
  })

  it('keeps a used reel as inactive, and removes an unused one with its credits', async () => {
    await open()
    await press('Deactivate Harbor Hardware')
    await settle(50)
    expect(text()).includes('stays listed as inactive')
    await press('Deactivate')
    await settle(50)
    expect(row('reel-harbor-hardware')).includes('Inactive')
    expect(find('Change Reel, Harbor Hardware')).equals(undefined)
    expect(text()).includes('Remaining reel broadcast credits: 500 of 1,000')
    await press('Deactivate Ridgeview Auto')
    await settle(50)
    expect(text()).includes('so it is removed')
    await press('Deactivate')
    await settle(50)
    expect(row('reel-ridgeview-auto')).equals('')
    expect(text()).includes('Remaining reel broadcast credits: 600 of 1,000')
  })

  it('changes a reel and keeps its counts', async () => {
    const store = await open()
    let chooserOpened = 0
    document.querySelector(CHANGE)!.addEventListener('click', () => {
      chooserOpened++
    })
    await press('Change Reel, Harbor Hardware')
    expect(chooserOpened).equals(1)
    await choose(CHANGE, webm('Harbor new.webm'))
    expect(preview(), 'the preview').not.equals(null)
    expect(text()).includes(
      'Broadcasts already assigned Harbor Hardware keep the version they had.'
    )
    expect(
      document.querySelector('input[aria-label="Broadcasts for this reel"]')
    ).equals(null)
    await press('Accept')
    await settle(0)
    const harbor = (await store.read()).reels.find(
      reel => reel.id === 'reel-harbor-hardware'
    )!
    expect(harbor.videoUrl).match(/^blob:Harbor new\.webm#/)
    expect(harbor).deep.include({
      version: 2,
      allocation: 400,
      used: 120,
      durationSec: 11
    })
    expect(row('reel-harbor-hardware')).includes('11 s')
    expect(text()).includes('Remaining reel broadcast credits: 500 of 1,000')
  })

  it('refuses a changed reel of the wrong length', async () => {
    await open()
    await press('Change Reel, Harbor Hardware')
    await choose(CHANGE, webm('long.webm'))
    expect(text()).includes('This reel is 20 seconds.')
    expect(pending()).equals(null)
  })

  it('clears every row, and puts the samples back', async () => {
    await open()
    await press('Clear all rows')
    await settle(0)
    expect(text()).includes('No reels yet. Add one above.')
    expect(text()).not.includes('Broadcasts used')
    expect(text()).includes('Remaining reel broadcast credits: 1,000 of 1,000')
    await press('Reset to sample rows')
    await settle(0)
    expect(rowCount()).equals(2)
    expect(text()).includes('Remaining reel broadcast credits: 500 of 1,000')
  })

  it('shows a league viewer only that it is for administrators', async () => {
    await open(false)
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })
})
