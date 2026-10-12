import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  type FakePhoneStreamModule,
  fakePhoneStreamModule,
  RADAR_EVENT
} from './fakePhoneStreamModule'
import type { NativePhoneStreamStatus } from './NativePhoneStream'
import { SLIDE_TRAVEL } from './overlay/SlideToStop'
import { makePhoneStream, PhoneStreamError } from './phoneStreamClient'
import {
  describeRefusal,
  StreamingScreen,
  type StreamingSession
} from './StreamingScreen.native'

const SESSION: StreamingSession = {
  gameId: 'gam_1',
  streamId: 'liv_00000000000000000001',
  url: 'rtmp://ingest.example.test:1936/live/ts_00000000000000000000',
  angleName: 'Home Plate',
  localRecording: 'none'
}

const SCALE = {
  presets: [0.5, 1, 3, 9, 18],
  switchOvers: [1, 3],
  digitalFrom: 9,
  minimum: 0.5,
  maximum: 18,
  current: 1
}

const IDLE: NativePhoneStreamStatus = {
  phase: 'idle',
  bitrateKbps: 0,
  displayedZoom: 1,
  lensLabel: '26 mm',
  batteryPercent: 64,
  charging: false,
  thermal: 'fair',
  recordingSeconds: 0,
  isRecording: false
}

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface Harness {
  native: FakePhoneStreamModule
  patches: Array<{ streamId: string; change: unknown }>
  rotations: string[]
  closes: number
  settings: number
  failPatch: boolean
}

async function mount(
  session: StreamingSession = SESSION,
  answers: Record<string, unknown> = {}
): Promise<Harness> {
  const native = fakePhoneStreamModule({
    zoomScale: SCALE,
    radarState: { ...RADAR_EVENT, devices: [] },
    ...answers
  })
  const harness: Harness = {
    native,
    patches: [],
    rotations: [],
    closes: 0,
    settings: 0,
    failPatch: false
  }
  const client = {
    baseUrl: 'https://teamstation.example.test/api/v1',
    token: 'token-0000',
    updateLiveStream: async (
      _gameId: string,
      streamId: string,
      change: unknown
    ): Promise<LiveStream> => {
      harness.patches.push({ streamId, change })
      if (harness.failPatch) throw new HttpError('internal', 'Down')
      return {} as unknown as LiveStream
    }
  } as unknown as TeamStationClient
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <StreamingScreen
          client={client}
          session={session}
          deviceId="00000000-0000-4000-8000-000000000001"
          deviceModel="iPhone 13 Pro"
          phone={makePhoneStream(native)}
          rotation={{
            lockLandscape: () => harness.rotations.push('landscape'),
            restore: () => harness.rotations.push('portrait')
          }}
          onClose={() => {
            harness.closes += 1
          }}
          onOpenSettings={() => {
            harness.settings += 1
          }}
        />
      </ThemeProvider>
    )
    await delay(20)
  })
  return harness
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

async function press(id: string): Promise<void> {
  await act(async () => {
    byTestId(id)!.click()
    await delay(20)
  })
}

async function emit(
  native: FakePhoneStreamModule,
  status: Partial<NativePhoneStreamStatus>
): Promise<void> {
  await act(async () => {
    native.emitStatus({ ...IDLE, ...status })
    await delay(10)
  })
}

/** A finger dragged across the slider, as the responder system hears a mouse. */
async function slide(distance: number): Promise<void> {
  const track = byTestId('slide-to-stop-track')!
  const at = (type: string, x: number): MouseEvent =>
    new window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 10,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1
    })
  await act(async () => {
    track.dispatchEvent(at('mousedown', 100))
    track.dispatchEvent(at('mousemove', 100 + distance / 2))
    track.dispatchEvent(at('mousemove', 100 + distance))
    track.dispatchEvent(at('mouseup', 100 + distance))
    await delay(20)
  })
}

const calls = (native: FakePhoneStreamModule, name: string): unknown[][] =>
  native.calls.filter(call => call.name === name).map(call => call.args)

describe('the streaming screen', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
  })

  it('opens the engine sideways under the Cameraman overlay, and closes it after', async function () {
    const h = await mount()
    expect(h.rotations).deep.equals(['landscape'])
    expect(calls(h.native, 'open')).deep.equals([['Home Plate', true, []]])
    await emit(h.native, {})
    expect(byTestId('camera-name')?.textContent).equals('Home Plate')
    expect(byTestId('stream-status-pill')?.textContent).equals(
      'Press record to start stream'
    )
    expect(byTestId('camera-thermal')?.textContent).equals('FAIR')
    expect(byTestId('camera-battery')?.textContent).contains('64%')
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid^="zoom-preset-"]'
        )
      ].map(pill => pill.textContent)
    ).deep.equals(['18x', '9x', '3x', '1x', '0.5x'])
    expect(byTestId('zoom-preset-1x')?.getAttribute('aria-selected')).equals(
      'true'
    )
    expect(byTestId('radar-speeds')).equals(null)
    // A pill sets the zoom; the readout follows the engine.
    await press('zoom-preset-3x')
    expect(calls(h.native, 'setZoom')).deep.equals([[3]])
    await emit(h.native, { displayedZoom: 2.4 })
    expect(byTestId('zoom-label')?.textContent).equals('2x')
    // The gear is M12's settings sheet; here it only calls the hook.
    await press('settings-button')
    expect(h.settings).equals(1)
    await press('camera-close')
    expect(h.closes).equals(1)
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
    expect(calls(h.native, 'close')).has.length(1)
    expect(h.rotations).deep.equals(['landscape', 'portrait'])
  })

  it('records on the stream URL with the redial’s request, holds Close, and stops with a slide', async function () {
    const h = await mount()
    await emit(h.native, {})
    await press('broadcast-button')
    expect(calls(h.native, 'startRecording')).deep.equals([
      [
        SESSION.url,
        SESSION.streamId,
        'gam_1',
        'Home Plate',
        {
          apiBase: 'https://teamstation.example.test/api/v1',
          token: 'token-0000',
          deviceId: '00000000-0000-4000-8000-000000000001',
          deviceModel: 'iPhone 13 Pro'
        }
      ]
    ])
    await emit(h.native, { phase: 'connecting', isRecording: true })
    expect(byTestId('stream-status-pill')?.textContent).equals('Connecting')
    await emit(h.native, {
      phase: 'live',
      isRecording: true,
      bitrateKbps: 2000
    })
    expect(byTestId('stream-status-pill')?.textContent).equals('Broadcasting')
    // Close is held while recording.
    expect(byTestId('camera-close')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    await press('camera-close')
    expect(h.closes).equals(0)

    // Record again asks for the slide, which a tap elsewhere puts away.
    await press('broadcast-button')
    expect(byTestId('slide-to-stop-track')).not.equals(null)
    await press('slide-to-stop-dismiss')
    expect(byTestId('slide-to-stop-track')).equals(null)
    await press('broadcast-button')
    await slide(Math.floor(SLIDE_TRAVEL * 0.79))
    expect(calls(h.native, 'stopRecording')).has.length(0)
    await slide(Math.ceil(SLIDE_TRAVEL * 0.8))
    expect(calls(h.native, 'stopRecording')).has.length(1)
    await emit(h.native, {})
    expect(byTestId('stream-status-pill')?.textContent).equals(
      'Press record to start stream'
    )
    // The phone holds the recording now: said once, however often it stops.
    expect(h.patches).deep.equals([
      { streamId: SESSION.streamId, change: { localRecording: 'recorded' } }
    ])
    await press('broadcast-button')
    await emit(h.native, { phase: 'live', isRecording: true })
    await press('broadcast-button')
    await slide(SLIDE_TRAVEL)
    expect(calls(h.native, 'stopRecording')).has.length(2)
    expect(h.patches).has.length(1)
  })

  it('says it again at the next stop when the server did not hear it, and not for a stream already recorded', async function () {
    const h = await mount()
    h.failPatch = true
    await press('broadcast-button')
    await emit(h.native, { phase: 'live', isRecording: true })
    await press('broadcast-button')
    await slide(SLIDE_TRAVEL)
    h.failPatch = false
    await emit(h.native, {})
    await press('broadcast-button')
    await emit(h.native, { phase: 'live', isRecording: true })
    await press('broadcast-button')
    await slide(SLIDE_TRAVEL)
    expect(h.patches).has.length(2)
    await act(async () => {
      root?.unmount()
    })
    const again = await mount({ ...SESSION, localRecording: 'recorded' })
    await press('broadcast-button')
    await emit(again.native, { phase: 'live', isRecording: true })
    await press('broadcast-button')
    await slide(SLIDE_TRAVEL)
    expect(again.patches).deep.equals([])
  })

  it('shows Stream ended once the camera is ended on the server, and the radar once one is paired', async function () {
    const h = await mount()
    await emit(h.native, {
      phase: 'idle',
      isRecording: true,
      error: 'streamEnded'
    })
    expect(byTestId('stream-status-pill')?.textContent).equals('Stream ended')
    await act(async () => {
      h.native.emitRadar({
        ...RADAR_EVENT,
        devices: [{ ...RADAR_EVENT.devices[0], readingAt: Date.now() }]
      })
      await delay(10)
    })
    expect(byTestId('radar-speeds')?.textContent).equals('⚡80% 54/–')
  })

  it('says why the engine refused, and flips the camera', async function () {
    const h = await mount()
    h.native.failures.startRecording = { code: 'uploadInProgress' }
    await press('broadcast-button')
    expect(byTestId('stream-problem')?.textContent).equals(
      'Home Plate is still uploading'
    )
    h.native.failures.startRecording = { code: 'permission' }
    await press('broadcast-button')
    expect(byTestId('stream-problem')?.textContent).contains(
      'needs the camera and the microphone'
    )
    await press('flip-button')
    expect(calls(h.native, 'flip')).has.length(1)
    expect(calls(h.native, 'zoomScale')).has.length(2)
    h.native.failures.flip = new Error('no front camera')
    await press('flip-button')
    expect(byTestId('stream-problem')?.textContent).equals(
      'That did not work: no front camera'
    )
    h.native.failures.stopRecording = {
      code: 'recordingFailed',
      message: 'disk'
    }
    await emit(h.native, { phase: 'live', isRecording: true })
    await press('broadcast-button')
    await slide(SLIDE_TRAVEL)
    expect(byTestId('stream-problem')?.textContent).equals(
      'That did not work: disk'
    )
    expect(h.patches).deep.equals([])
  })

  it('says so when the camera cannot be opened', async function () {
    const answers = { zoomScale: SCALE }
    const refused = fakePhoneStreamModule(answers)
    refused.failures.open = { code: 'insufficientStorage' }
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <StreamingScreen
            client={
              { baseUrl: '', token: undefined } as unknown as TeamStationClient
            }
            session={SESSION}
            deviceId="00000000-0000-4000-8000-000000000001"
            deviceModel="iPhone 13 Pro"
            phone={makePhoneStream(refused)}
            onClose={() => {}}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(byTestId('stream-problem')?.textContent).equals(
      'There is not enough free space on this phone to record.'
    )
    // Without a settings hook the gear does nothing, and a token-less client sends an empty one.
    await press('settings-button')
    await press('broadcast-button')
    expect(
      (calls(refused, 'startRecording')[0][4] as { token: string }).token
    ).equals('')
  })

  it('reads the rail again while the camera is still finding its lenses', async function () {
    const h = await mount(SESSION, {
      zoomScale: {
        ...SCALE,
        presets: [1],
        switchOvers: [],
        minimum: 1,
        maximum: 1
      }
    })
    expect(
      document.querySelectorAll('[data-testid^="zoom-preset-"]')
    ).has.length(1)
    h.native.answers.zoomScale = SCALE
    await act(async () => {
      await delay(1100)
    })
    expect(
      document.querySelectorAll('[data-testid^="zoom-preset-"]')
    ).has.length(5)
    expect(calls(h.native, 'zoomScale')).has.length(2)
  })

  it('words each refusal for the person holding the phone', function () {
    expect(describeRefusal(new PhoneStreamError('permission'), 'A')).contains(
      'camera and the microphone'
    )
    expect(
      describeRefusal(new PhoneStreamError('insufficientStorage'), 'A')
    ).equals('There is not enough free space on this phone to record.')
    expect(
      describeRefusal(new PhoneStreamError('uploadInProgress'), 'First Base')
    ).equals('First Base is still uploading')
    expect(
      describeRefusal(new PhoneStreamError('notReady', 'not ready'), 'A')
    ).equals('That did not work: not ready')
    expect(describeRefusal('gone', 'A')).equals('That did not work: gone')
  })
})
