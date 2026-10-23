import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { EventName, Property } from '../../common/observability/contract'
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
  events: Array<{ event: EventName; properties: Record<string, Property> }>
  native: FakePhoneStreamModule
  patches: Array<{ streamId: string; change: unknown }>
  rotations: string[]
  ios: string[]
  closes: number
  failPatch: boolean
}

async function mount(
  session: StreamingSession = SESSION,
  answers: Record<string, unknown> = {},
  startOnOpen = false
): Promise<Harness> {
  const native = fakePhoneStreamModule({
    zoomScale: SCALE,
    radarState: { ...RADAR_EVENT, devices: [] },
    ...answers
  })
  const harness: Harness = {
    events: [],
    native,
    patches: [],
    rotations: [],
    ios: [],
    closes: 0,
    failPatch: false
  }
  const client = {
    captureAnalytics:
      () => (event: EventName, properties: Record<string, Property>) => {
        harness.events.push({ event, properties })
      },
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
          startOnOpen={startOnOpen}
          client={client}
          session={session}
          deviceId="00000000-0000-4000-8000-000000000001"
          deviceModel="iPhone 13 Pro"
          phone={makePhoneStream(native)}
          rotation={{
            allow: () => harness.rotations.push('any'),
            lockLandscape: () => harness.rotations.push('landscape'),
            restore: () => harness.rotations.push('portrait')
          }}
          cameraOrientation={{
            landscape: () => harness.ios.push('landscape'),
            any: () => harness.ios.push('any'),
            portrait: () => harness.ios.push('portrait')
          }}
          onClose={() => {
            harness.closes += 1
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

  it('starts recording after the hero opens the camera', async function () {
    const h = await mount(SESSION, {}, true)
    expect(calls(h.native, 'startRecording')).has.length(1)
    const names = h.native.calls.map(call => call.name)
    expect(names.indexOf('open')).lessThan(names.indexOf('startRecording'))
    expect(byTestId('camera-close')?.getAttribute('aria-disabled')).equals(
      'true'
    )
  })

  it('does not start a second recording when the hero resumes an interrupted take', async function () {
    const h = await mount(
      SESSION,
      {
        interruptedSession: {
          liveStreamId: SESSION.streamId,
          gameId: SESSION.gameId,
          angleName: SESSION.angleName,
          streaming: true,
          downtimeSeconds: 10
        },
        resumeInterrupted: true
      },
      true
    )
    expect(calls(h.native, 'resumeInterrupted')).has.length(1)
    expect(calls(h.native, 'startRecording')).has.length(0)
  })

  it('opens the engine sideways under the Cameraman overlay, and closes it after', async function () {
    const h = await mount()
    expect(h.rotations).deep.equals(['landscape'])
    expect(h.ios).deep.equals(['landscape'])
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
    // The gear opens settings, which may stand upright. Done gives the
    // camera its landscape hold back.
    await press('settings-button')
    expect(byTestId('settings-done')).not.equals(null)
    expect(h.rotations).deep.equals(['landscape', 'any'])
    await press('settings-done')
    expect(byTestId('settings-done')).equals(null)
    expect(h.rotations).deep.equals(['landscape', 'any', 'landscape'])
    await press('camera-close')
    expect(h.closes).equals(1)
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
    expect(calls(h.native, 'close')).has.length(1)
    expect(h.rotations).deep.equals([
      'landscape',
      'any',
      'landscape',
      'portrait'
    ])
    expect(h.ios).deep.equals(['landscape', 'any', 'landscape', 'portrait'])
  })

  it('returns to portrait when the screen goes while settings is still open', async function () {
    const h = await mount()
    await press('settings-button')
    expect(h.ios).deep.equals(['landscape', 'any'])
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
    // The screen's hold is gone before the sheet's cleanup runs, so the
    // sheet does not turn the phone sideways again on its way out.
    expect(h.ios).deep.equals(['landscape', 'any', 'portrait'])
    expect(h.rotations).deep.equals(['landscape', 'any', 'portrait'])
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
    // A token-less client sends an empty one.
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

  it('refuses Android’s back while recording or streaming, as it refuses Close', async function () {
    const back = async (): Promise<void> => {
      await act(async () => {
        document.dispatchEvent(
          new window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true })
        )
        await delay(10)
      })
    }
    const h = await mount()
    // The modal listens for back once its fade-in has ended; React hears the
    // DOM's end of an animation under its prefixed name here.
    await act(async () => {
      for (const element of document.body.querySelectorAll('*'))
        for (const type of ['animationend', 'webkitAnimationEnd'])
          element.dispatchEvent(new window.Event(type, { bubbles: true }))
      await delay(10)
    })
    await emit(h.native, {})
    await back()
    expect(h.closes).equals(1)
    await emit(h.native, { phase: 'live', isRecording: true })
    await back()
    expect(h.closes).equals(1)
    expect(calls(h.native, 'close')).has.length(0)
    // The part stopped for low storage and the stream goes on: still held,
    // and the button stops the stream rather than offering a Record that
    // the engine would refuse.
    await emit(h.native, {
      phase: 'live',
      isRecording: false,
      error: 'recordingStoppedLowStorage'
    })
    await back()
    expect(h.closes).equals(1)
    expect(byTestId('camera-close')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    // The part's end told the server the phone holds a recording.
    expect(h.patches).deep.equals([
      { streamId: SESSION.streamId, change: { localRecording: 'recorded' } }
    ])
    await press('broadcast-button')
    expect(calls(h.native, 'startRecording')).has.length(0)
    await slide(SLIDE_TRAVEL)
    expect(calls(h.native, 'stopRecording')).has.length(1)
    await emit(h.native, {})
    await back()
    expect(h.closes).equals(2)
    expect(h.patches).has.length(1)
  })

  it('tells the server whenever a part ends, once, and again only if it did not hear', async function () {
    const h = await mount()
    h.failPatch = true
    await emit(h.native, { phase: 'live', isRecording: true })
    await emit(h.native, { phase: 'live', isRecording: false })
    expect(h.events.map(row => row.event)).includes('recording_started')
    expect(h.events.map(row => row.event)).includes('recording_stopped')
    expect(
      h.events.find(row => row.event === 'recording_stopped')!.properties.dur
    ).at.least(0)
    expect(JSON.stringify(h.events)).not.includes('rtmp:')
    expect(h.patches).has.length(1)
    h.failPatch = false
    await emit(h.native, { phase: 'live', isRecording: true })
    await emit(h.native, { phase: 'idle', isRecording: false })
    expect(h.patches).has.length(2)
    await emit(h.native, { phase: 'live', isRecording: true })
    await emit(h.native, { phase: 'idle', isRecording: false })
    expect(h.patches).has.length(2)
  })

  it('closes the engine only once a slow open has finished', async function () {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const h = await mount()
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
    // A second screen whose open is still waiting on the permission prompt.
    const slow = fakePhoneStreamModule({ zoomScale: SCALE })
    const order: string[] = []
    const open = slow.open
    slow.open = async (...args) => {
      order.push('open')
      await gate
      await open(...args)
      order.push('opened')
    }
    const close = slow.close
    slow.close = async () => {
      order.push('close')
      await close()
    }
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
            phone={makePhoneStream(slow)}
            onClose={() => {}}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
    expect(order).deep.equals(['open'])
    release()
    await act(async () => {
      await delay(20)
    })
    expect(order).deep.equals(['open', 'opened', 'close'])
    expect(calls(h.native, 'close')).has.length(1)
  })

  it('carries a take a kill interrupted on, when opened again on its stream', async function () {
    const interrupted = {
      liveStreamId: SESSION.streamId,
      gameId: SESSION.gameId,
      angleName: 'Home Plate',
      streaming: true,
      downtimeSeconds: 40
    }
    const h = await mount(SESSION, {
      interruptedSession: interrupted,
      resumeInterrupted: true
    })
    expect(calls(h.native, 'resumeInterrupted')).deep.equals([
      [
        {
          apiBase: 'https://teamstation.example.test/api/v1',
          token: 'token-0000',
          deviceId: '00000000-0000-4000-8000-000000000001',
          deviceModel: 'iPhone 13 Pro'
        }
      ]
    ])
    // Recording again before the engine's first status says so.
    expect(byTestId('camera-close')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined

    // A take of another stream is left for that stream's Record to close.
    const other = await mount(SESSION, {
      interruptedSession: { ...interrupted, liveStreamId: 'liv_other' },
      resumeInterrupted: true
    })
    expect(calls(other.native, 'interruptedSession')).has.length(1)
    expect(calls(other.native, 'resumeInterrupted')).deep.equals([])
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined

    // Refused: the screen says why.
    const again = fakePhoneStreamModule({
      zoomScale: SCALE,
      interruptedSession: interrupted
    })
    again.failures.resumeInterrupted = { code: 'insufficientStorage' }
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
            phone={makePhoneStream(again)}
            onClose={() => {}}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(byTestId('stream-problem')?.textContent).equals(
      'There is not enough free space on this phone to record.'
    )
  })

  it('says the camera is unavailable while the engine reports it lost, and offers no Record', async function () {
    const h = await mount()
    await emit(h.native, {})
    expect(byTestId('camera-unavailable')).equals(null)
    await emit(h.native, { error: 'cameraUnavailable' })
    expect(byTestId('camera-unavailable')?.textContent).equals(
      'Camera unavailable'
    )
    expect(byTestId('broadcast-button')?.getAttribute('aria-disabled')).equals(
      'true'
    )
    await press('broadcast-button')
    expect(calls(h.native, 'startRecording')).has.length(0)
    // Lost mid-take: the stop control still works.
    await emit(h.native, {
      phase: 'live',
      isRecording: true,
      error: 'cameraUnavailable'
    })
    expect(byTestId('camera-unavailable')).not.equals(null)
    await press('broadcast-button')
    expect(byTestId('slide-to-stop-track')).not.equals(null)
    await press('slide-to-stop-dismiss')
    // Back: the message goes and Record is offered again.
    await emit(h.native, {})
    expect(byTestId('camera-unavailable')).equals(null)
    await press('broadcast-button')
    expect(calls(h.native, 'startRecording')).has.length(1)
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
    expect(
      describeRefusal(new PhoneStreamError('cameraUnavailable'), 'A')
    ).equals('Camera unavailable')
    expect(describeRefusal('gone', 'A')).equals('That did not work: gone')
  })
})
