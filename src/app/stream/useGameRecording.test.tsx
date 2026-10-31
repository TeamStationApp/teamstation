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
async function mount(fake: ReturnType<typeof fixture>): Promise<void> {
  const phone = makePhoneStream(fake.module)
  function Harness(): React.ReactElement {
    const recording = useGameRecording(
      fake.client,
      'gam_1',
      phone,
      async () => DEVICE,
      Camera
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
  const button = [
    ...document.querySelectorAll<HTMLElement>('button,[role="button"]')
  ].find(node => node.textContent === label)
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
    await press('Home')
    await press('Start')
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
    expect(opened?.startOnOpen).equals(true)
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
    await press('Start')
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

  it('waits for the iOS name prompt to dismiss before opening the camera', async () => {
    Platform.OS = 'ios'
    const fake = fixture()
    await mount(fake)
    await press('Record')
    await press('Home')
    await press('Start')
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
    await press('Start')
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
