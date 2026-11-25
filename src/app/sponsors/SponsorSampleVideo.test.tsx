import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { Text } from 'react-native'

import { mount, settle, text, unmount } from '../../test/gameFormDom'
import type { VideoHandle } from '../player/videoHandle'
import type { SampleClient, SampleRecording } from './sampleRecording'
import { OverlayAt, SponsorSampleVideo } from './SponsorSampleVideo'

const client = {} as unknown as SampleClient
const FOUND: SampleRecording = {
  kind: 'found',
  gameId: 'gam_demo',
  videoId: 'vid_demo',
  url: 'https://media.example/vid_demo.m3u8',
  durationSec: 3600
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

let showPreview: (shown: boolean) => void = () => undefined
function WithPreview({
  attach
}: {
  attach: (handle: VideoHandle, url: string) => () => void
}): React.ReactElement {
  const [shown, setShown] = useState(false)
  showPreview = setShown
  return (
    <SponsorSampleVideo
      client={client}
      leagueId="lea_demo"
      attach={attach}
      find={async () => FOUND}
    >
      {shown && (
        <OverlayAt
          box={{ x: 0.7, y: 0.05, width: 0.25, height: 0.25 }}
          testID="preview"
        >
          <Text>Preview</Text>
        </OverlayAt>
      )}
    </SponsorSampleVideo>
  )
}

afterEach(async () => {
  await unmount()
})

describe('the sponsor sample video', () => {
  it('says it is finding a recording, then plays it muted and without controls', async () => {
    let finish: (found: SampleRecording) => void = () => undefined
    const fake = fakeAttach()
    await mount(
      <SponsorSampleVideo
        client={client}
        leagueId="lea_demo"
        attach={fake.attach}
        find={async () =>
          await new Promise<SampleRecording>(resolve => {
            finish = resolve
          })
        }
      />
    )
    expect(text()).includes('Finding a recording…')
    expect(document.querySelector('video')).equals(null)
    await act(async () => {
      finish(FOUND)
    })
    await settle(0)
    const element = videoElement()
    expect(element.getAttribute('src')).equals(FOUND.url)
    expect(element.muted).equals(true)
    expect(element.hasAttribute('controls')).equals(false)
    expect(fake.attached).deep.equals([FOUND.url])
    expect(text()).not.includes('Finding a recording…')
  })

  it('starts at 30:00 and goes back there at 32:00', async () => {
    const fake = fakeAttach()
    await mount(
      <SponsorSampleVideo
        client={client}
        leagueId="lea_demo"
        attach={fake.attach}
        find={async () => FOUND}
      />
    )
    const element = videoElement()
    let position = 0
    Object.defineProperty(element, 'currentTime', {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value
      }
    })
    element.dispatchEvent(new window.Event('loadedmetadata'))
    expect(position).equals(1800)
    position = 1850
    element.dispatchEvent(new window.Event('timeupdate'))
    expect(position).equals(1850)
    position = 1920
    element.dispatchEvent(new window.Event('timeupdate'))
    expect(position).equals(1800)
    await unmount()
    expect(fake.detached).equals(1)
  })

  it('shows "No recording to preview" when there is none, or the search fails', async () => {
    await mount(
      <SponsorSampleVideo
        client={client}
        leagueId="lea_demo"
        find={async () => ({ kind: 'none' })}
      />
    )
    expect(text()).includes('No recording to preview')
    expect(document.querySelector('video')).equals(null)
    await unmount()
    await mount(
      <SponsorSampleVideo
        client={client}
        leagueId="lea_demo"
        find={async () => {
          throw new Error('offline')
        }}
      />
    )
    expect(text()).includes('No recording to preview')
  })

  it('keeps the same video element while a preview comes and goes', async () => {
    const fake = fakeAttach()
    await mount(<WithPreview attach={fake.attach} />)
    const before = videoElement()
    await act(async () => {
      showPreview(true)
    })
    expect(
      document.querySelector('[data-testid="preview"]'),
      'the preview'
    ).not.equals(null)
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
