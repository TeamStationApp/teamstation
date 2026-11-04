import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Platform } from 'react-native'

import type {
  DeviceStreamOptions,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import type { CameraLinks } from './cameraDeepLinks'
import { fakePhoneStreamModule, RECORDING } from './fakePhoneStreamModule'
import { makePhoneStream } from './phoneStreamClient'
import type { StreamingScreenProps } from './StreamingScreen.native'
import { useGameRecording } from './useGameRecording.native'

const DEVICE = '00000000-0000-4000-8000-000000000001'
const originalPlatform = Platform.OS
const held: LiveStream = {
  id: 'liv_00000000000000000001',
  gameId: 'gam_1',
  userId: userIdOfGumbo(7),
  ownerName: 'Mookie Betts',
  slot: 1,
  label: 'Home',
  keyPrefix: 'ts_0000',
  state: 'idle',
  opensAt: '2026-05-20T16:00:00.000Z',
  closesAt: null,
  videoId: null,
  lastError: null,
  status: null,
  deviceId: DEVICE,
  deviceModel: 'Phone',
  localRecording: 'recorded',
  url: 'rtmp://ingest.example.test/live/ts_0000'
}
let root: Root | undefined
let opened: StreamingScreenProps | undefined
const pause = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20))
}
function Camera(props: StreamingScreenProps): React.ReactElement {
  opened = props
  return <button onClick={props.onClose}>Close camera</button>
}
function fixture(): {
  module: ReturnType<typeof fakePhoneStreamModule>
  calls: Array<{ name?: string; options?: DeviceStreamOptions }>
  mine: LiveStream[]
  allowed: boolean
  reads: number
  next: () => Promise<LiveStream>
  client: TeamStationClient
} {
  const module = fakePhoneStreamModule({
    capabilities: {
      supported: true,
      deviceModel: 'Phone',
      canRecordLocally: true
    },
    recordings: []
  })
  const calls: Array<{ name?: string; options?: DeviceStreamOptions }> = []
  const fake = {
    module,
    calls,
    mine: [] as LiveStream[],
    allowed: true,
    reads: 0,
    next: async (): Promise<LiveStream> => held,
    client: undefined as unknown as TeamStationClient
  }
  fake.client = {
    liveStreams: async () => {
      fake.reads++
      if (!fake.allowed) throw new Error('Not allowed')
      return { mine: fake.mine, others: [], canAdd: 4, maxCameras: 4 }
    },
    addLiveStream: async (
      _gameId: string,
      name?: string,
      options?: DeviceStreamOptions
    ) => {
      calls.push({ name, options })
      return await fake.next()
    },
    revealLiveStream: async () => held
  } as unknown as TeamStationClient
  return fake
}
async function mount(
  fake: ReturnType<typeof fixture>,
  externalOptions: { links?: CameraLinks; launchLimitMs?: number } = {}
): Promise<void> {
  const phone = makePhoneStream(fake.module)
  function Harness(): React.ReactElement {
    const recording = useGameRecording(
      fake.client,
      'gam_1',
      phone,
      async () => DEVICE,
      Camera,
      externalOptions
    )
    return (
      <>
        {recording.open != null && (
          <button
            disabled={recording.busy}
            onClick={() => {
              recording.open?.()
            }}
          >
            Record
          </button>
        )}
        <span>{recording.error}</span>
        {recording.screen}
      </>
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    )
    await pause()
  })
}
async function press(label: string): Promise<void> {
  const ids: Record<string, string> = {
    GoPro: 'gopro',
    Mevo: 'mevo',
    'Mevo Studio': 'mevoStudio',
    'Other camera': 'rtmp'
  }
  const button =
    (ids[label] == null
      ? undefined
      : document.querySelector<HTMLElement>(
          `[data-testid="camera-source-${ids[label]}"]`
        )) ??
    [...document.querySelectorAll<HTMLElement>('button,[role="button"]')].find(
      node => node.textContent?.replace(/chevron_right$/, '') === label
    )
  expect(button, label).not.equals(undefined)
  await act(async () => {
    button!.click()
    await pause()
  })
}
const prompt = (): Element | null =>
  document.querySelector('[data-testid="angle-name-prompt"]')

describe('recording from the game hero', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
      await pause()
    })
    root = undefined
    opened = undefined
    document.body.replaceChildren()
    Platform.OS = originalPlatform
  })

  it('asks for a camera name and opens its stream ready to start recording', async () => {
    const fake = fixture()
    await mount(fake)
    await press('Record')
    expect(prompt()).not.equals(null)
    expect(document.body.textContent).contains('Use external camera')
    await press('Home')
    await press('Record with this phone')
    expect(fake.calls).deep.equals([
      {
        name: 'Home',
        options: {
          deviceId: DEVICE,
          deviceModel: 'Phone',
          recordsLocally: true
        }
      }
    ])
    expect(opened?.session.streamId).equals(held.id)
    expect(
      fake.module.calls.filter(call => call.name === 'startRecording')
    ).has.length(0)
  })

  const links = (installed = true): CameraLinks => ({
    canOpenURL: async () => installed,
    openURL: async () => {},
    appInstalled: async () => installed,
    openInApp: async () => installed
  })
  const external = async (): Promise<void> => {
    await press('Record')
    await press('Home')
    await press('Use external camera')
  }
  const dismiss = async (): Promise<void> => {
    await act(async () => {
      for (const node of document.body.querySelectorAll('div'))
        for (const name of ['animationend', 'webkitAnimationEnd'])
          node.dispatchEvent(new window.Event(name, { bubbles: true }))
      await pause()
    })
  }

  it('offers external RTMP with the supplied name and no phone device identity', async () => {
    const fake = fixture()
    await mount(fake)
    await external()
    await press('Other camera')
    expect(fake.calls).deep.equals([
      { name: 'Home', options: { source: 'rtmp' } }
    ])
    expect(document.body.textContent).contains(held.url)
    expect(opened).equals(undefined)
    await press('Done')
    await dismiss()
    await press('Record')
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Camera angle"]'
      )?.value
    ).equals('')
  })

  for (const [label, source] of [
    ['GoPro', 'gopro'],
    ['Mevo', 'mevo'],
    ['Mevo Studio', 'mevoStudio']
  ]) {
    it(`launches ${label} from the hero`, async () => {
      Platform.OS = 'android'
      const fake = fixture()
      const openedLinks: string[] = []
      await mount(fake, {
        links: {
          ...links(),
          openURL: async url => {
            openedLinks.push(url)
          },
          openInApp: async url => {
            openedLinks.push(url)
            return true
          }
        }
      })
      await external()
      await press(label)
      expect(fake.calls[0]).deep.equals({ name: 'Home', options: { source } })
      expect(openedLinks).has.length(1)
      expect(opened).equals(undefined)
    })
  }

  it('waits for iOS dismissals through external RTMP and revoke cancellation', async () => {
    Platform.OS = 'ios'
    const fake = fixture()
    await mount(fake)
    await external()
    expect(document.body.textContent).not.contains('Stream with your camera')
    await dismiss()
    expect(document.body.textContent).contains('Stream with your camera')
    await press('Other camera')
    expect(fake.calls).has.length(0)
    await dismiss()
    expect(fake.calls).has.length(1)
    await press('Revoke')
    await dismiss()
    await press('Cancel')
    await dismiss()
    expect(document.body.textContent).contains(held.url)
  })

  it('ignores a revoked setup completing after a new hero prompt opens', async () => {
    Platform.OS = 'android'
    const fake = fixture()
    let finish!: () => void
    fake.client.revokeLiveStream = async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return {
        removed: true,
        streams: await fake.client.liveStreams(held.gameId)
      }
    }
    await mount(fake)
    await external()
    await press('Other camera')
    await press('Revoke')
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-testid="revoke-confirm"]')!
        .click()
      await pause()
    })
    await act(async () => {
      document
        .querySelector('[data-testid="revoke-sheet"]')!
        .parentElement!.querySelector<HTMLElement>('[aria-label="Cancel"]')!
        .click()
      await pause()
    })
    await press('Done')
    await dismiss()
    await press('Record')
    expect(prompt()).not.equals(null)
    await act(async () => {
      finish()
      await pause()
    })
    expect(prompt()).not.equals(null)
    await press('Home')
    await press('Record with this phone')
    expect(opened).not.equals(undefined)
  })

  it('falls back to RTMP when an iOS maker app is missing', async () => {
    Platform.OS = 'ios'
    const fake = fixture()
    await mount(fake, { links: links(false) })
    await external()
    await dismiss()
    await press('GoPro')
    await dismiss()
    expect(document.body.textContent).contains(held.url)
  })

  it('opens the store without creating a camera on Android and permits retry', async () => {
    Platform.OS = 'android'
    const fake = fixture()
    await mount(fake, { links: links(false) })
    await external()
    await press('GoPro')
    expect(fake.calls).has.length(0)
    await press('Other camera')
    expect(fake.calls).has.length(1)
  })

  it('shows maker errors and retries', async () => {
    Platform.OS = 'android'
    const fake = fixture()
    fake.next = async () => {
      throw new Error('Camera refused')
    }
    await mount(fake, { links: links() })
    await external()
    await press('GoPro')
    expect(document.body.textContent).contains('Camera refused')
    fake.next = async () => held
    await press('GoPro')
    expect(fake.calls).has.length(2)
  })

  it('times out a maker launch and ignores its late response', async () => {
    Platform.OS = 'android'
    const fake = fixture()
    let finish!: (value: LiveStream) => void
    fake.next = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    let launched = 0
    await mount(fake, {
      launchLimitMs: 10,
      links: {
        ...links(),
        openInApp: async () => {
          launched++
          return true
        }
      }
    })
    await external()
    await press('GoPro')
    expect(document.body.textContent).contains('too long')
    await act(async () => {
      finish(held)
      await pause()
    })
    expect(launched).equals(0)
  })

  it('cancels an in-flight maker launch without opening its late result', async () => {
    Platform.OS = 'android'
    const fake = fixture()
    let finish!: (value: LiveStream) => void
    fake.next = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    let launched = 0
    await mount(fake, {
      links: {
        ...links(),
        openInApp: async () => {
          launched++
          return true
        }
      }
    })
    await external()
    await press('GoPro')
    await act(async () => {
      root!.unmount()
      await pause()
    })
    root = undefined
    await act(async () => {
      finish(held)
      await pause()
    })
    expect(launched).equals(0)
    expect(opened).equals(undefined)
  })

  it('asks for a stream that keeps no recording on a phone under the start floor', async () => {
    const fake = fixture()
    fake.module.answers.capabilities = {
      supported: true,
      deviceModel: 'Phone',
      canRecordLocally: false
    }
    await mount(fake)
    await press('Record')
    await press('Home')
    await press('Record with this phone')
    expect(fake.calls[0].options?.recordsLocally).equals(false)
  })

  it('continues this device’s existing camera directly with its held stream id', async () => {
    const fake = fixture()
    fake.mine = [held]
    await mount(fake)
    await press('Record')
    expect(prompt()).equals(null)
    expect(fake.calls[0].options?.heldStreamId).equals(held.id)
    expect(opened?.session.url).equals(held.url)
  })

  describe('with a take of that name uploading', () => {
    const uploading = { ...RECORDING, gameId: 'gam_1', angleName: 'Home' }
    const ended: LiveStream = {
      ...held,
      state: 'ended',
      closesAt: '2026-05-20T17:00:00.000Z'
    }
    const asking = async (fake: ReturnType<typeof fixture>): Promise<void> => {
      await mount(fake)
      await press('Record')
      await press('Home')
      await press('Record with this phone')
    }

    it('films a new camera beside an ended one', async () => {
      const fake = fixture()
      fake.mine = [ended]
      fake.module.answers.recordings = [
        { ...uploading, liveStreamId: ended.id, uploadId: 'upl_1' }
      ]
      await asking(fake)
      expect(document.body.textContent).not.contains('still uploading')
      expect(fake.calls.map(call => call.name)).deep.equals(['Home'])
      expect(fake.calls[0].options?.heldStreamId).equals(undefined)
    })

    it('films when its camera is no longer listed', async () => {
      const fake = fixture()
      fake.module.answers.recordings = [
        { ...uploading, liveStreamId: 'liv_gone', uploadRunning: true }
      ]
      await asking(fake)
      expect(fake.calls.map(call => call.name)).deep.equals(['Home'])
    })

    it('refuses on the same active camera', async () => {
      const fake = fixture()
      fake.mine = [
        { ...held, deviceId: '00000000-0000-4000-8000-00000000000a' }
      ]
      fake.module.answers.recordings = [
        { ...uploading, liveStreamId: held.id, uploadId: 'upl_1' }
      ]
      await asking(fake)
      expect(document.body.textContent).contains('Home is still uploading')
      expect(fake.calls).deep.equals([])
    })

    it('refuses when the list cannot be read to say which it is', async () => {
      const fake = fixture()
      fake.mine = [ended]
      fake.module.answers.recordings = [
        { ...uploading, liveStreamId: ended.id, uploadId: 'upl_1' }
      ]
      await mount(fake)
      await press('Record')
      await press('Home')
      fake.allowed = false
      await press('Record with this phone')
      expect(document.body.textContent).contains('Home is still uploading')
      expect(fake.calls).deep.equals([])
    })
  })

  it('waits for the iOS name prompt to dismiss before opening the camera', async () => {
    Platform.OS = 'ios'
    const fake = fixture()
    await mount(fake)
    await press('Record')
    await press('Home')
    await press('Record with this phone')
    expect(opened).equals(undefined)
    await act(async () => {
      for (const node of document.body.querySelectorAll('div'))
        for (const name of ['animationend', 'webkitAnimationEnd'])
          node.dispatchEvent(new window.Event(name, { bubbles: true }))
      await pause()
    })
    expect(opened?.session.streamId).equals(held.id)
  })

  it('prefers the interrupted take over another camera belonging to this device', async () => {
    const fake = fixture()
    fake.mine = [{ ...held, id: 'liv_other', label: 'Dugout' }, held]
    fake.module.answers.interruptedSession = {
      liveStreamId: held.id,
      gameId: 'gam_1',
      angleName: 'Home',
      streaming: true,
      downtimeSeconds: 20
    }
    await mount(fake)
    await press('Record')
    expect(fake.calls[0].options?.heldStreamId).equals(held.id)
  })

  it('does not continue another device’s camera or an ended camera', async () => {
    const fake = fixture()
    fake.mine = [
      { ...held, deviceId: '00000000-0000-4000-8000-000000000002' },
      { ...held, id: 'liv_ended', state: 'ended' }
    ]
    await mount(fake)
    await press('Record')
    expect(prompt()).not.equals(null)
    expect(fake.calls).has.length(0)
  })

  it('offers no recording on an unsupported device', async () => {
    const fake = fixture()
    fake.module.answers.capabilities = {
      supported: false,
      deviceModel: '',
      canRecordLocally: false
    }
    await mount(fake)
    expect(document.body.textContent).not.includes('Record')
    expect(fake.reads).equals(0)
  })

  it('offers no recording without permission to film', async () => {
    const fake = fixture()
    fake.allowed = false
    await mount(fake)
    expect(document.body.textContent).not.includes('Record')
  })

  it('keeps a failed start retryable and does not start a take while it uploads', async () => {
    const fake = fixture()
    fake.mine = [held]
    fake.module.answers.recordings = [
      {
        ...RECORDING,
        gameId: 'gam_1',
        liveStreamId: held.id,
        uploadRunning: true
      }
    ]
    await mount(fake)
    await press('Record')
    expect(fake.calls).has.length(0)
    expect(opened).equals(undefined)
    expect(document.body.textContent).includes('upload')
    fake.module.answers.recordings = []
    await press('Record')
    expect(opened?.session.streamId).equals(held.id)
  })

  it('ignores a creation response after cancelling the name prompt', async () => {
    const fake = fixture()
    let finish!: (value: LiveStream) => void
    fake.next = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    await mount(fake)
    await press('Record')
    await press('Home')
    await press('Record with this phone')
    await press('Cancel')
    await act(async () => {
      finish(held)
      await pause()
    })
    expect(opened).equals(undefined)
  })

  it('ignores a continuation response after leaving the game', async () => {
    const fake = fixture()
    fake.mine = [held]
    let finish!: (value: LiveStream) => void
    fake.next = async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    await mount(fake)
    await press('Record')
    await act(async () => {
      root!.unmount()
      await pause()
    })
    root = undefined
    await act(async () => {
      finish(held)
      await pause()
    })
    expect(opened).equals(undefined)
  })
})
