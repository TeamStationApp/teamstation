import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { defaultSponsorSettings } from '../../common/nodeSettings'
import {
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
import { imagePicker } from '../../test/stubs/reactNativeImagePicker'
import { drawnVideos } from '../../test/stubs/reactNativeVideo'
import { createApiSponsorStore } from './apiSponsorStore'
import {
  SponsorEventStreamScreen,
  SponsorFeaturesScreen,
  SponsorLogosScreen,
  SponsorReelsScreen
} from './SponsorScreens'
import type { PickedFile, PreparedFile } from './sponsorTypes'

/**
 * U12: the cross-platform sponsor screens in the native bundle, where
 * `scripts/sponsorNativePlugin.mjs` resolves each sponsor file to its
 * `.native` twin as Metro does: the photo-album chooser, the
 * react-native-video sample and reel previews, and the app's date and time
 * pickers.
 */

const NOW = new Date('2026-11-24T20:00:00.000Z')
const LEAGUE = 'lea_al'

const shrunk: Array<[string, string]> = []
const prepare = async (
  purpose: string,
  picked: PickedFile
): Promise<PreparedFile> => {
  shrunk.push([purpose, picked.name])
  return {
    ...picked,
    type: purpose === 'reel' ? 'video/mp4' : picked.type,
    bytes: new Uint8Array(5),
    size: 5,
    url: `file:///cache/shrunk-${picked.name}`,
    width: purpose === 'reel' ? 640 : 480,
    height: purpose === 'reel' ? 360 : 270
  }
}

const videoProps = (): Array<Record<string, unknown>> =>
  [...document.querySelectorAll('[data-video-props]')].map(
    node =>
      JSON.parse(node.getAttribute('data-video-props')!) as Record<
        string,
        unknown
      >
  )

beforeEach(() => {
  shrunk.length = 0
  imagePicker.calls.length = 0
  imagePicker.next = { didCancel: true }
  drawnVideos.length = 0
})
afterEach(async () => {
  await unmount()
})

async function render(element: React.ReactElement): Promise<void> {
  await mount(element)
  await settle(0)
}

describe('U12 the sponsor screens in the native bundle', () => {
  it('opens each sponsor screen from the menu on a phone', async () => {
    const opened: string[] = []
    await render(
      <SponsorFeaturesScreen
        client={fakeSponsorClient()}
        league={LEAGUE}
        onOpen={name => opened.push(name)}
      />
    )
    expect(text()).includes('Sponsor video reels')
    expect(text()).includes('Sponsor in event stream')
    await press(
      'Sponsor video logos, Place a league sponsor logo in the upper right of game videos.'
    )
    expect(opened).deep.equals(['sponsorLogos'])
  })

  it('picks a logo from the photo album, refusing a JPEG, and adds a PNG over the native sample', async () => {
    const client = fakeSponsorClient({
      state: usedSponsorState(NOW),
      now: () => NOW
    })
    await render(
      <SponsorLogosScreen client={client} league={LEAGUE} prepare={prepare} />
    )
    expect(text()).not.includes('Drop a PNG here')
    imagePicker.next = {
      assets: [
        {
          uri: 'file:///album/field.jpg',
          fileName: 'field.jpg',
          type: 'image/jpg'
        }
      ]
    }
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(imagePicker.calls.at(-1)).deep.include({
      mediaType: 'photo',
      selectionLimit: 1
    })
    expect(text()).includes('Logos must be PNG files.')
    expect(shrunk).deep.equals([])
    imagePicker.next = {
      assets: [
        {
          uri: 'file:///album/Bayside.png',
          fileName: 'Bayside Bakery.png',
          type: 'image/png',
          width: 960,
          height: 540
        }
      ]
    }
    await press('Choose from Photos: Add Logo')
    await settle(0)
    expect(shrunk).deep.equals([['logo', 'Bayside Bakery.png']])
    expect(
      document.querySelector('[data-testid="sponsor-logo-preview"]')
    ).not.equals(null)
    // The sample plays through react-native-video, muted.
    expect(videoProps()[0]).deep.include({
      source: { uri: 'https://example.test/sponsors/sample/default.mp4' },
      muted: true,
      repeat: false,
      resizeMode: 'cover'
    })
    expect(document.querySelector('video')).equals(null)
    await fill('Credits for this logo', '50')
    await press('Accept')
    await settle(0)
    expect(text()).includes('Remaining game logo credits: 70 of 300')
  })

  it('seeks the native sample to its window, back at the window’s end, and says when it fails', async () => {
    const client = fakeSponsorClient({
      sample: {
        kind: 'recording',
        videoId: 'vid_home',
        url: 'https://example.test/vid_home.m3u8',
        window: [1800, 1920],
        overlay: defaultSponsorSettings
      }
    })
    await render(
      <SponsorLogosScreen client={client} league={LEAGUE} prepare={prepare} />
    )
    const sample = drawnVideos.find(
      each =>
        (each.props.source as { uri: string }).uri ===
        'https://example.test/vid_home.m3u8'
    )!
    const fire = async (name: string, ...args: unknown[]): Promise<void> => {
      await act(async () => {
        ;(sample.props[name] as (...a: unknown[]) => void)(...args)
      })
    }
    await fire('onLoad', {})
    await fire('onProgress', { currentTime: 1850 })
    await fire('onProgress', { currentTime: 1920 })
    await fire('onEnd')
    expect(sample.calls).deep.equals([
      { name: 'seek', args: [1800] },
      { name: 'seek', args: [1800] },
      { name: 'seek', args: [1800] },
      { name: 'resume', args: [] }
    ])
    await fire('onError', {})
    expect(text()).includes('The sample video could not be played.')
  })

  it('previews a picked reel with react-native-video in the scoreboard’s place, and each row’s first frame paused', async () => {
    const client = fakeSponsorClient({
      state: usedSponsorState(NOW),
      now: () => NOW
    })
    await render(
      <SponsorReelsScreen client={client} league={LEAGUE} prepare={prepare} />
    )
    // The table's pictures: paused, each its own reel.
    expect(videoProps().filter(props => props.paused === true)).deep.equals([
      {
        source: { uri: 'https://example.test/media/harbor.mp4' },
        accessibilityLabel: 'Harbor Hardware reel',
        muted: true,
        repeat: true,
        resizeMode: 'cover',
        paused: true
      },
      {
        source: { uri: 'https://example.test/media/ridgeview.mp4' },
        accessibilityLabel: 'Ridgeview Auto reel',
        muted: true,
        repeat: true,
        resizeMode: 'cover',
        paused: true
      }
    ])
    imagePicker.next = {
      assets: [
        {
          uri: 'file:///album/clip.mov',
          fileName: 'clip.mov',
          type: 'video/quicktime',
          duration: 12,
          width: 1920,
          height: 1080
        }
      ]
    }
    await press('Choose from Photos: Add Reel')
    await settle(0)
    expect(imagePicker.calls.at(-1)).deep.include({ mediaType: 'video' })
    expect(shrunk).deep.equals([['reel', 'clip.mov']])
    const preview = document.querySelector(
      '[data-testid="sponsor-reel-preview"] [data-video-props]'
    )
    expect(preview, 'the pending reel').not.equals(null)
    expect(JSON.parse(preview!.getAttribute('data-video-props')!)).deep.equals({
      source: { uri: 'file:///cache/shrunk-clip.mov' },
      accessibilityLabel: 'Preview of clip.mov',
      muted: true,
      repeat: true,
      resizeMode: 'cover',
      paused: false
    })
    await press('Cancel')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Preview Ridgeview Auto"]')
        ?.click()
    })
    await settle(0)
    const shown = document.querySelector(
      '[data-testid="sponsor-reel-preview"] [data-video-props]'
    )
    expect(JSON.parse(shown!.getAttribute('data-video-props')!)).deep.include({
      source: { uri: 'https://example.test/media/ridgeview.mp4' },
      paused: false
    })
    expect(document.querySelector('video')).equals(null)
  })

  it('refuses a reel whose length the album did not give, or of the wrong length', async () => {
    const client = fakeSponsorClient({
      state: usedSponsorState(NOW),
      now: () => NOW
    })
    await render(
      <SponsorReelsScreen client={client} league={LEAGUE} prepare={prepare} />
    )
    imagePicker.next = {
      assets: [{ uri: 'file:///album/a.mov', type: 'video/quicktime' }]
    }
    await press('Choose from Photos: Add Reel')
    await settle(0)
    expect(text()).includes('This video could not be read. Try another file.')
    imagePicker.next = {
      assets: [
        { uri: 'file:///album/b.mov', type: 'video/quicktime', duration: 20 }
      ]
    }
    await press('Choose from Photos: Add Reel')
    await settle(0)
    expect(text()).includes('This reel is 20 seconds.')
    expect(shrunk).deep.equals([])
  })

  it('chooses a row’s date and time with the app’s calendar and time pickers', async () => {
    const client = fakeSponsorClient({ now: () => NOW })
    await render(
      <SponsorEventStreamScreen
        client={client}
        league={LEAGUE}
        store={createApiSponsorStore(client, LEAGUE, { prepare })}
        now={() => NOW}
      />
    )
    expect(document.querySelector('input[type="datetime-local"]')).equals(null)
    await press('Date: ')
    await settle(50)
    expect(find('Previous month')).not.equals(undefined)
    const day = [
      ...document.querySelectorAll<HTMLElement>('[aria-label^="Choose 20"]')
    ][0]
    const chosen = day.getAttribute('aria-label')!.replace('Choose ', '')
    await act(async () => {
      day.click()
    })
    await press('Use date')
    await settle(50)
    expect(find(`Date: ${chosen}`)).not.equals(undefined)
    expect(find('Time: 12:00 PM')).not.equals(undefined)
    await press('Time: 12:00 PM')
    await settle(50)
    expect(find('Use time')).not.equals(undefined)
    await press('Cancel time picker')
    await settle(50)
    await press('Time: 12:00 PM')
    await settle(50)
    await press('Use time')
    await settle(50)
    expect(find('Time: 12:00 PM')).not.equals(undefined)
    // Rows' pictures come from the album too.
    imagePicker.next = {
      assets: [
        {
          uri: 'file:///album/logo.jpg',
          fileName: 'logo.jpg',
          type: 'image/jpeg'
        }
      ]
    }
    await press('Choose from Photos: Logo')
    await settle(0)
    expect(text()).includes('logo.jpg')
  })
})
