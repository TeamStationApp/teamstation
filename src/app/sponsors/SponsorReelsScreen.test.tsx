import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'

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
import { NoWebCodecs } from './prepareMedia'
import { SponsorReelsScreen } from './SponsorReelsScreen'
import { sponsorStoreFor } from './sponsorStore'
import type { PickedFile, PreparedFile, SponsorState } from './sponsorTypes'

const NOW = new Date('2026-11-24T20:00:00.000Z')
const LEAGUE = 'lea_al'

const NOTE =
  'Each broadcast reel will be evenly distributed across all videos recorded by your league. One broadcast credit is used at the beginning of each game and between each half-inning, until the allocated broadcast count is depleted.'
const LIMITS =
  'Reels are 10 to 15 seconds long and 640 × 360. Larger videos are shrunk automatically to fit 640 × 360, keeping their proportions. After shrinking, a reel can be at most 3.2 MB.'

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

/** A shrink to 640 × 360 MP4, or the refusal `fails` names. */
function shrink(
  fails?: Error
): (purpose: string, picked: PickedFile) => Promise<PreparedFile> {
  return async (_purpose, picked) => {
    if (fails != null) throw fails
    return {
      ...picked,
      type: 'video/mp4',
      bytes: new Uint8Array(11),
      size: 11,
      url: `blob:shrunk-${picked.name}`,
      width: 640,
      height: 360,
      durationMs: (picked.durationSec ?? 0) * 1000
    }
  }
}

async function open({
  canManage = true,
  state = usedSponsorState(NOW),
  prepare = shrink()
}: {
  canManage?: boolean
  state?: SponsorState
  prepare?: (purpose: string, picked: PickedFile) => Promise<PreparedFile>
} = {}): Promise<FakeSponsorClient> {
  const client = fakeSponsorClient({ state, now: () => NOW, canManage })
  await mount(
    <SponsorReelsScreen
      client={client}
      league={LEAGUE}
      readDuration={readDuration}
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
  document.querySelector('[data-testid="sponsor-reel-pending"]')
const preview = (): HTMLElement | null =>
  document.querySelector('[data-testid="sponsor-reel-preview"]')
const row = (id: string): string =>
  document.querySelector(`[data-testid="sponsor-row-${id}"]`)?.textContent ?? ''
const rowCount = (): number =>
  document.querySelectorAll('[data-testid^="sponsor-row-"]').length
const disabled = (label: string): boolean =>
  find(label)?.getAttribute('aria-disabled') === 'true'

describe('U11 the Sponsor Video Reels screen on the API store', () => {
  it('lists the league’s reels under their headers, with the note, the limits and the credits the server holds', async () => {
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
    expect(rowCount()).equals(2)
    expect(row('srl_harbor')).includes('Harbor Hardware')
    expect(row('srl_harbor')).includes('12 s')
    // Used 120 of 400.
    expect(row('srl_harbor')).includes('120280')
    expect(row('srl_ridgeview')).includes('15 s')
    // Each row's picture is its own first frame, paused.
    const picture = document.querySelector<HTMLVideoElement>(
      '[data-testid="sponsor-row-srl_harbor"] video'
    )!
    expect(picture.getAttribute('src')).equals(
      'https://example.test/media/harbor.mp4'
    )
    expect(picture.autoplay).equals(false)
    expect(picture.getAttribute('preload')).equals('metadata')
  })

  it('reads "No reels yet. Add one above." for a league with none', async () => {
    await open({ state: emptySponsorState() })
    expect(text()).includes('No reels yet. Add one above.')
    expect(text()).includes('Remaining reel broadcast credits: 1,000 of 1,000')
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

  it('tells a browser without WebCodecs to upload reels from the mobile app', async () => {
    const client = await open({ prepare: shrink(new NoWebCodecs()) })
    await choose(ADD, webm('Bayside Bakery.webm'))
    expect(text()).includes(
      "This browser can't shrink videos. Upload reels from the TeamStation mobile app."
    )
    expect(pending()).equals(null)
    expect(client.media.size).equals(0)
  })

  it('previews the shrunk reel in the scoreboard’s place, and Accept with 100 uploads it and leaves 400', async () => {
    const client = await open()
    await choose(ADD, webm('Bayside Bakery.webm'))
    const shown = preview()
    expect(shown, 'the preview').not.equals(null)
    expect(shown!.style.width).match(/^33\.33/)
    expect(shown!.style.height).match(/^33\.33/)
    expect(parseFloat(shown!.style.left)).closeTo(1, 1e-9)
    expect(parseFloat(shown!.style.top)).closeTo(1, 1e-9)
    const video = shown!.querySelector('video')!
    expect(video.muted).equals(true)
    expect(video.loop).equals(true)
    expect(video.getAttribute('src')).equals('blob:shrunk-Bayside Bakery.webm')
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
    expect([...client.media.values()]).deep.equals([
      { purpose: 'reel', type: 'video/mp4', bytes: 11 }
    ])
    const added = client.state().reels.at(-1)!
    expect(added).deep.include({
      name: 'Bayside Bakery',
      allocation: 100,
      used: 0
    })
    expect(
      document.querySelector(`[data-testid="sponsor-row-${added.id}"] video`)
    ).not.equals(null)
  })

  it('shows a listed reel playing in the scoreboard’s place when its name is tapped', async () => {
    await open()
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Preview Ridgeview Auto"]')
        ?.click()
    })
    await settle(0)
    const video = preview()!.querySelector('video')!
    expect(video.getAttribute('src')).equals(
      'https://example.test/media/ridgeview.mp4'
    )
    expect(video.autoplay).equals(true)
  })

  it('shows a poster for a reel that has one', async () => {
    const state = usedSponsorState(NOW)
    state.reels[0] = {
      ...state.reels[0],
      videoUrl: '',
      posterUrl: 'https://example.test/p.png'
    }
    await open({ state })
    expect(
      document.querySelector('[aria-label="Harbor Hardware reel"]')
    ).not.equals(null)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Preview Harbor Hardware"]')
        ?.click()
    })
    await settle(0)
    expect(preview()!.querySelector('video')).equals(null)
  })

  it('drops a pending reel on Cancel, uploading nothing', async () => {
    const client = await open()
    await choose(ADD, webm('Bayside Bakery.webm'))
    await press('Cancel')
    expect(pending()).equals(null)
    expect(preview()).equals(null)
    expect(rowCount()).equals(2)
    expect(client.media.size).equals(0)
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
    const client = await open()
    await act(async () => {
      await sponsorStoreFor(LEAGUE, client).setReelAllocation(
        'srl_ridgeview',
        600
      )
    })
    await choose(ADD, webm('Bayside Bakery.webm'))
    expect(text()).includes('No broadcast credits left to assign')
    expect(disabled('No broadcast credits left to assign')).equals(true)
  })

  it('shows why an accepted reel was refused, and keeps it pending', async () => {
    const client = await open()
    client.failNext(
      'uploadSponsorMedia',
      badRequest('Reels can be at most 640 × 360.')
    )
    await choose(ADD, webm('Bayside Bakery.webm'))
    await fill('Broadcasts for this reel', '100')
    await press('Accept')
    await settle(0)
    expect(text()).includes('Reels can be at most 640 × 360.')
    expect(pending(), 'still pending').not.equals(null)
    expect(rowCount()).equals(2)
  })

  it('keeps a used reel as inactive, and removes an unused one with its credits', async () => {
    await open()
    await press('Deactivate Harbor Hardware')
    await settle(50)
    expect(text()).includes('stays listed as inactive')
    await press('Deactivate')
    await settle(50)
    expect(row('srl_harbor')).includes('Inactive')
    expect(text()).includes('Remaining reel broadcast credits: 500 of 1,000')
    await press('Deactivate Ridgeview Auto')
    await settle(50)
    expect(text()).includes('so it is removed')
    await press('Deactivate')
    await settle(50)
    expect(row('srl_ridgeview')).equals('')
    expect(text()).includes('Remaining reel broadcast credits: 600 of 1,000')
  })

  it('shows a league viewer only that it is for administrators', async () => {
    await open({ canManage: false })
    expect(text()).equals(
      'Only a league administrator can set up sponsor features.'
    )
  })
})
