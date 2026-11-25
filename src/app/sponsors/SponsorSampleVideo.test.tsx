import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { Text } from 'react-native'

import { defaultSponsorSettings } from '../../common/nodeSettings'
import { mount, settle, text, unmount } from '../../test/gameFormDom'
import type { VideoHandle } from '../player/videoHandle'
import { OverlayAt, SponsorSampleVideo } from './SponsorSampleVideo'
import type { SampleVideo } from './sponsorTypes'
import { SAMPLE_FAILED, type SampleClient } from './useSponsorSample'

const RECORDING: SampleVideo = {
  kind: 'recording',
  videoId: 'vid_home',
  url: 'https://example.test/vid_home.m3u8',
  window: [1800, 1920],
  overlay: defaultSponsorSettings
}
const NODE: SampleVideo = {
  kind: 'node',
  url: 'https://example.test/sponsors/sample/default.mp4',
  window: [0, 120],
  overlay: defaultSponsorSettings
}

/** A client whose sample read answers `answer`, counting the reads. */
function sampleClient(
  answer: SampleVideo | Error | Promise<SampleVideo>
): SampleClient & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    sponsorSample: async (leagueId: string) => {
      reads.push(leagueId)
      if (answer instanceof Error) throw answer
      return await answer
    }
  }
}

/** An attach that only points the element at the URL, and counts teardowns. */
function fakeAttach(): {
  attach: (handle: VideoHandle, url: string) => () => void
  attached: string[]
  detached: number
} {
  const record = {
    attached: [] as string[],
    detached: 0,
    attach: (handle: VideoHandle, url: string) => {
      ;(handle as unknown as HTMLVideoElement).src = url
      record.attached.push(url)
      return () => {
        record.detached++
      }
    }
  }
  return record
}

function videoElement(): HTMLVideoElement {
  const found = document.querySelector('video')
  expect(found, 'the sample video').not.equals(null)
  return found!
}

/** Stands in for the element's playhead, as jsdom has none. */
function playhead(element: HTMLVideoElement): { at: number } {
  const head = { at: 0 }
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => head.at,
    set: (value: number) => {
      head.at = value
    }
  })
  return head
}

let showPreview: (shown: boolean) => void = () => undefined
function WithPreview({
  client,
  attach
}: {
  client: SampleClient
  attach: (handle: VideoHandle, url: string) => () => void
}): React.ReactElement {
  const [shown, setShown] = useState(false)
  showPreview = setShown
  return (
    <SponsorSampleVideo client={client} leagueId="lea_al" attach={attach}>
      {overlay =>
        shown && (
          <OverlayAt
            box={{
              x: overlay.logo.single.side,
              y: 0.05,
              width: 0.25,
              height: 0.25
            }}
            testID="preview"
          >
            <Text>Preview</Text>
          </OverlayAt>
        )
      }
    </SponsorSampleVideo>
  )
}

afterEach(async () => {
  await unmount()
})

describe('U11 the sponsor sample video', () => {
  it('stays dark while the sample is read, then plays the league’s recording muted through HLS', async () => {
    let finish: (sample: SampleVideo) => void = () => undefined
    const fake = fakeAttach()
    const client = sampleClient(
      new Promise<SampleVideo>(resolve => {
        finish = resolve
      })
    )
    await mount(
      <SponsorSampleVideo
        client={client}
        leagueId="lea_al"
        attach={fake.attach}
      />
    )
    expect(text()).equals('')
    expect(document.querySelector('video')).equals(null)
    await act(async () => {
      finish(RECORDING)
    })
    await settle(0)
    const element = videoElement()
    expect(element.getAttribute('src')).equals(RECORDING.url)
    expect(element.muted).equals(true)
    expect(element.hasAttribute('controls')).equals(false)
    expect(fake.attached).deep.equals([RECORDING.url])
    expect(client.reads).deep.equals(['lea_al'])
  })

  it('starts at the window’s start and goes back there at its end', async () => {
    const fake = fakeAttach()
    await mount(
      <SponsorSampleVideo
        client={sampleClient(RECORDING)}
        leagueId="lea_al"
        attach={fake.attach}
      />
    )
    await settle(0)
    const element = videoElement()
    const head = playhead(element)
    element.dispatchEvent(new window.Event('loadedmetadata'))
    expect(head.at).equals(1800)
    head.at = 1850
    element.dispatchEvent(new window.Event('timeupdate'))
    expect(head.at).equals(1850)
    head.at = 1920
    element.dispatchEvent(new window.Event('timeupdate'))
    expect(head.at).equals(1800)
    await unmount()
    expect(fake.detached).equals(1)
  })

  it('plays the node’s sample clip as a plain file, its first two minutes', async () => {
    const fake = fakeAttach()
    await mount(
      <SponsorSampleVideo
        client={sampleClient(NODE)}
        leagueId="lea_al"
        attach={fake.attach}
      />
    )
    await settle(0)
    const element = videoElement()
    expect(element.getAttribute('src')).equals(NODE.url)
    expect(fake.attached).deep.equals([])
    const head = playhead(element)
    head.at = 120
    element.dispatchEvent(new window.Event('timeupdate'))
    expect(head.at).equals(0)
  })

  it('says the sample could not be played when the read fails, or the video does', async () => {
    await mount(
      <SponsorSampleVideo
        client={sampleClient(new Error('offline'))}
        leagueId="lea_al"
      />
    )
    await settle(0)
    expect(text()).equals(SAMPLE_FAILED)
    expect(document.querySelector('video')).equals(null)
    await unmount()
    await mount(
      <SponsorSampleVideo client={sampleClient(NODE)} leagueId="lea_al" />
    )
    await settle(0)
    expect(text()).equals('')
    await act(async () => {
      videoElement().dispatchEvent(new window.Event('error'))
    })
    expect(text()).equals('The sample video could not be played.')
  })

  it('keeps the same video element while a preview comes and goes, placed by the node’s settings', async () => {
    const fake = fakeAttach()
    await mount(
      <WithPreview client={sampleClient(RECORDING)} attach={fake.attach} />
    )
    await settle(0)
    const before = videoElement()
    await act(async () => {
      showPreview(true)
    })
    const shown = document.querySelector<HTMLElement>('[data-testid="preview"]')
    expect(shown, 'the preview').not.equals(null)
    expect(parseFloat(shown!.style.left)).closeTo(5, 1e-9)
    expect(videoElement()).equals(before)
    await act(async () => {
      showPreview(false)
    })
    expect(document.querySelector('[data-testid="preview"]')).equals(null)
    expect(videoElement()).equals(before)
    expect(fake.attached).lengthOf(1)
    expect(fake.detached).equals(0)
  })
})
