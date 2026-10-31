import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  fakePhoneStreamModule,
  RADAR_EVENT,
  RECORDING,
  STATUS_EVENT
} from './fakePhoneStreamModule'
import {
  androidPermissionHost,
  androidPermissionsFor,
  CAMERA_UNAVAILABLE,
  cameraUnavailable,
  makePhoneStream,
  type PermissionHost,
  type PhoneStream,
  PhoneStreamError,
  type Recordings,
  toRecording,
  toStatus,
  toUploadProgress,
  usePhoneStreamStatusOf,
  useRadarStateOf,
  useRecordingsOf
} from './phoneStreamClient'

const REQUEST = {
  apiBase: 'https://teamstation.example.test/api/v1',
  token: 'token-0000',
  deviceId: '00000000-0000-4000-8000-000000000001',
  deviceModel: 'iPhone 13 Pro'
}

let root: Root | undefined
afterEach(function () {
  act(() => {
    root?.unmount()
  })
  root = undefined
})

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function mount<T>(useValue: () => T): { current: () => T } {
  let latest: T | undefined
  function Probe(): null {
    latest = useValue()
    return null
  }
  const element = document.createElement('div')
  root = createRoot(element)
  act(() => {
    root!.render(<Probe />)
  })
  return { current: () => latest as T }
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected a rejection')
}

function recordingPermissions(granted: boolean): PermissionHost & {
  asked: string[][]
} {
  const asked: string[][] = []
  return {
    asked,
    androidApi: 34,
    request: async permissions => {
      asked.push(permissions)
      return granted
    }
  }
}

describe('the phone stream bridge', function () {
  it('passes every call through to the module with its arguments', async function () {
    const native = fakePhoneStreamModule({
      radarPair: true,
      uploadRecording: 'vid_00000000000000000001',
      resumePendingUploads: 2,
      resumeInterrupted: true
    })
    const stream = makePhoneStream(native)
    await stream.open('Home Plate')
    await stream.open('First Base', {
      audioEnabled: false,
      disabledLenses: ['back-13']
    })
    await stream.setAngleName('Third Base')
    await stream.startRecording({
      rtmpUrl: 'rtmp://live.example.test/live/key-0000',
      liveStreamId: 'lst_00000000000000000001',
      gameId: 'gam_00000000000000000001',
      angleName: 'Home Plate',
      request: REQUEST
    })
    expect(await stream.resumeInterrupted(REQUEST)).equals(true)
    await stream.stopRecording()
    stream.setZoom(2)
    stream.pinch(1.5)
    stream.pinch(1.2, true)
    await stream.setDisabledLenses(['back-77'])
    await stream.flip()
    await stream.setAudioEnabled(false)
    await stream.radarSetEnabled(false)
    await stream.radarScan()
    await stream.radarStopScan()
    expect(await stream.radarPair('TAG-00000002')).equals(true)
    await stream.radarUnpair('TAG-00000002')
    expect(
      await stream.uploadRecording({
        liveStreamId: 'lst_00000000000000000001',
        apiBase: REQUEST.apiBase,
        token: REQUEST.token,
        title: 'Home Plate'
      })
    ).equals('vid_00000000000000000001')
    expect(
      await stream.resumePendingUploads(REQUEST.apiBase, REQUEST.token)
    ).equals(2)
    await stream.cancelUpload('lst_00000000000000000001')
    await stream.deleteRecording('lst_00000000000000000001')
    await stream.close()
    expect(native.calls).deep.equals([
      { name: 'open', args: ['Home Plate', true, []] },
      { name: 'open', args: ['First Base', false, ['back-13']] },
      { name: 'setAngleName', args: ['Third Base'] },
      {
        name: 'startRecording',
        args: [
          'rtmp://live.example.test/live/key-0000',
          'lst_00000000000000000001',
          'gam_00000000000000000001',
          'Home Plate',
          REQUEST
        ]
      },
      { name: 'resumeInterrupted', args: [REQUEST] },
      { name: 'stopRecording', args: [] },
      { name: 'setZoom', args: [2] },
      { name: 'pinch', args: [1.5, false] },
      { name: 'pinch', args: [1.2, true] },
      { name: 'setDisabledLenses', args: [['back-77']] },
      { name: 'flip', args: [] },
      { name: 'setAudioEnabled', args: [false] },
      { name: 'radarSetEnabled', args: [false] },
      { name: 'radarScan', args: [] },
      { name: 'radarStopScan', args: [] },
      { name: 'radarPair', args: ['TAG-00000002'] },
      { name: 'radarUnpair', args: ['TAG-00000002'] },
      {
        name: 'uploadRecording',
        args: [
          'lst_00000000000000000001',
          REQUEST.apiBase,
          REQUEST.token,
          'Home Plate'
        ]
      },
      { name: 'resumePendingUploads', args: [REQUEST.apiBase, REQUEST.token] },
      { name: 'cancelUpload', args: ['lst_00000000000000000001'] },
      { name: 'deleteRecording', args: ['lst_00000000000000000001'] },
      { name: 'close', args: [] }
    ])
  })

  it('shapes what the module answers', async function () {
    const native = fakePhoneStreamModule({
      capabilities: {
        supported: true,
        deviceModel: 'iPhone 13 Pro',
        canRecordLocally: true
      },
      zoomScale: {
        presets: [0.5, 1, 3],
        switchOvers: [1, 3],
        minimum: 0.5,
        maximum: 15,
        current: 1
      },
      lenses: [
        {
          id: 'back-26',
          position: 'back',
          title: '26 mm',
          subtitle: 'Back · 1x',
          displayedZoom: 1,
          focalLengthMM: 26,
          enabled: true,
          canDisable: false
        },
        {
          id: 'front-1',
          position: 'front',
          title: '1x',
          subtitle: 'Front · 1x',
          displayedZoom: 1,
          enabled: true,
          canDisable: true
        }
      ],
      radarState: { ...RADAR_EVENT, bluetooth: 'resetting' },
      recordings: [
        RECORDING,
        {
          ...RECORDING,
          liveStreamId: 'lst_00000000000000000002',
          endedAt: 1_790_000_060_000,
          uploadId: 'upl_00000000000000000001',
          uploadTitle: 'Home Plate',
          uploadRunning: true,
          uploadProgress: {
            liveStreamId: 'lst_00000000000000000002',
            state: 'uploading',
            fraction: 0.52,
            bytesSent: 52,
            bytesTotal: 100
          }
        },
        {
          ...RECORDING,
          liveStreamId: 'lst_00000000000000000003',
          uploadId: 'upl_00000000000000000002',
          uploadedAt: 1_790_000_900_000,
          videoId: 'vid_00000000000000000001',
          // Not running here: whatever it last said is not where it stands.
          uploadProgress: {
            liveStreamId: 'lst_00000000000000000003',
            state: 'uploading',
            fraction: 0.9,
            bytesSent: 90,
            bytesTotal: 100
          }
        }
      ],
      interruptedSession: {
        liveStreamId: 'lst_00000000000000000001',
        gameId: 'gam_00000000000000000001',
        angleName: 'Home Plate',
        streaming: true,
        downtimeSeconds: 42
      }
    })
    const stream = makePhoneStream(native)
    expect(await stream.capabilities()).deep.equals({
      supported: true,
      deviceModel: 'iPhone 13 Pro',
      canRecordLocally: true
    })
    expect(await stream.zoomScale()).deep.equals({
      presets: [0.5, 1, 3],
      switchOvers: [1, 3],
      digitalFrom: null,
      minimum: 0.5,
      maximum: 15,
      current: 1
    })
    const lenses = await stream.lenses()
    expect(lenses.map(lens => [lens.position, lens.focalLengthMM])).deep.equals(
      [
        ['back', 26],
        ['front', null]
      ]
    )
    const radar = await stream.radarState()
    expect(radar.bluetooth).equals('unknown')
    expect(radar.devices).deep.equals([
      {
        serial: 'TAG-00000001',
        connection: 'connected',
        batteryPercent: 80,
        pitchMph: 54,
        exitMph: null,
        readingAt: 1_790_000_000_000
      }
    ])
    const recordings = await stream.recordings()
    expect(
      recordings.map(recording => [
        recording.liveStreamId,
        recording.hasPendingUpload,
        recording.uploadRunning,
        recording.endedAt
      ])
    ).deep.equals([
      ['lst_00000000000000000001', false, false, null],
      ['lst_00000000000000000002', true, true, 1_790_000_060_000],
      ['lst_00000000000000000003', false, false, null]
    ])
    expect(recordings.map(recording => recording.uploadProgress)).deep.equals([
      null,
      {
        liveStreamId: 'lst_00000000000000000002',
        state: 'uploading',
        fraction: 0.52,
        bytesSent: 52,
        bytesTotal: 100,
        step: null,
        videoId: null,
        message: null
      },
      null
    ])
    expect(await stream.interruptedSession()).deep.equals({
      liveStreamId: 'lst_00000000000000000001',
      gameId: 'gam_00000000000000000001',
      angleName: 'Home Plate',
      streaming: true,
      downtimeSeconds: 42
    })
    native.answers.interruptedSession = null
    expect(await stream.interruptedSession()).equals(null)
  })

  it('reads unknown phases, heat, and upload states as their safe defaults', function () {
    expect(
      toStatus({ ...STATUS_EVENT, phase: 'other', thermal: 'nominal' })
    ).to.include({ phase: 'idle', thermal: 'cool' })
    expect(
      toUploadProgress({
        liveStreamId: 'lst_00000000000000000001',
        state: 'other',
        fraction: 0,
        bytesSent: 0,
        bytesTotal: 0
      })
    ).deep.equals({
      liveStreamId: 'lst_00000000000000000001',
      state: 'failed',
      fraction: 0,
      bytesSent: 0,
      bytesTotal: 0,
      step: null,
      videoId: null,
      message: null
    })
  })

  it('turns a native rejection into the engine’s error code', async function () {
    const native = fakePhoneStreamModule()
    native.failures.startRecording = Object.assign(
      new Error('The take is uploading'),
      { code: 'uploadInProgress' }
    )
    native.failures.stopRecording = { code: 'notReady', message: '' }
    native.failures.close = new Error('plain')
    native.failures.recordings = { code: '' }
    native.failures.capabilities = new Error('gone')
    const stream = makePhoneStream(native)
    const started = await rejection(
      stream.startRecording({
        rtmpUrl: 'rtmp://live.example.test/live/key-0000',
        liveStreamId: 'lst_00000000000000000001',
        gameId: 'gam_00000000000000000001',
        angleName: 'Home Plate',
        request: REQUEST
      })
    )
    expect(started).instanceOf(PhoneStreamError)
    expect(started).to.include({
      code: 'uploadInProgress',
      message: 'The take is uploading'
    })
    expect(await rejection(stream.stopRecording())).to.include({
      code: 'notReady',
      message: 'notReady'
    })
    const plain = await rejection(stream.close())
    expect(plain).not.instanceOf(PhoneStreamError)
    expect(await rejection(stream.recordings())).deep.equals({ code: '' })
    expect(await stream.capabilities()).deep.equals({
      supported: false,
      deviceModel: '',
      canRecordLocally: false
    })
  })

  it('asks Android for the camera and microphone before opening, and stops when refused', async function () {
    const native = fakePhoneStreamModule()
    const allowed = recordingPermissions(true)
    await makePhoneStream(native, allowed).open('Home Plate')
    expect(allowed.asked).deep.equals([
      ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO']
    ])
    const refused = recordingPermissions(false)
    const error = await rejection(
      makePhoneStream(native, refused).open('Home Plate')
    )
    expect(error).to.include({ code: 'permission' })
    expect(native.calls.map(call => call.name)).deep.equals(['open'])
  })

  it('asks for Bluetooth only to turn the radar on, and notifications before an upload', async function () {
    const native = fakePhoneStreamModule({ uploadRecording: 'vid_1' })
    const refused = recordingPermissions(false)
    const stream = makePhoneStream(native, refused)
    await stream.radarSetEnabled(false)
    expect(await rejection(stream.radarSetEnabled(true))).to.include({
      code: 'permission'
    })
    // Refused notifications hide the progress notification, not the upload.
    expect(
      await stream.uploadRecording({
        liveStreamId: 'lst_00000000000000000001',
        apiBase: REQUEST.apiBase,
        token: REQUEST.token,
        title: 'Home Plate'
      })
    ).equals('vid_1')
    expect(refused.asked).deep.equals([
      [
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT'
      ],
      ['android.permission.POST_NOTIFICATIONS']
    ])
    expect(native.calls.map(call => call.name)).deep.equals([
      'radarSetEnabled',
      'uploadRecording'
    ])

    // Resumed at launch, nobody pressed anything: nothing is asked.
    expect(
      await stream.resumeUpload({
        liveStreamId: 'lst_00000000000000000001',
        apiBase: REQUEST.apiBase,
        token: REQUEST.token,
        title: 'Home Plate'
      })
    ).equals('vid_1')
    expect(refused.asked).length(2)
    expect(native.calls.at(-1)).deep.equals({
      name: 'uploadRecording',
      args: [
        'lst_00000000000000000001',
        REQUEST.apiBase,
        REQUEST.token,
        'Home Plate'
      ]
    })
  })

  it('names the permissions each Android level needs', function () {
    expect(androidPermissionsFor('radar', 30)).deep.equals([
      'android.permission.ACCESS_FINE_LOCATION'
    ])
    expect(androidPermissionsFor('radar', 31)).deep.equals([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_CONNECT'
    ])
    expect(androidPermissionsFor('upload', 32)).deep.equals([])
    expect(androidPermissionsFor('upload', 33)).deep.equals([
      'android.permission.POST_NOTIFICATIONS'
    ])
  })

  it('asks PermissionsAndroid on Android only, and needs every permission granted', async function () {
    const requested: string[][] = []
    const answers: Record<string, string> = {
      'android.permission.CAMERA': 'granted',
      'android.permission.RECORD_AUDIO': 'denied'
    }
    const permissions = {
      RESULTS: { GRANTED: 'granted' },
      requestMultiple: async (wanted: never[]) => {
        requested.push(wanted)
        return answers
      }
    }
    const host = androidPermissionHost('android', '34', permissions)
    expect(host.androidApi).equals(34)
    expect(
      await host.request([
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO'
      ])
    ).equals(false)
    expect(await host.request(['android.permission.CAMERA'])).equals(true)
    expect(await host.request([])).equals(true)
    expect(requested).has.length(2)
    const ios = androidPermissionHost('ios', '18.0', permissions)
    expect(ios.androidApi).equals(null)
    expect(await ios.request(['android.permission.CAMERA'])).equals(true)
    expect(requested).has.length(2)
  })

  it('without a module answers unsupported and refuses every call', async function () {
    const stream = makePhoneStream(null)
    expect(await stream.capabilities()).deep.equals({
      supported: false,
      deviceModel: '',
      canRecordLocally: false
    })
    for (const call of [
      async () => {
        await stream.open('Home Plate')
      },
      stream.close,
      stream.recordings,
      stream.radarState,
      stream.zoomScale
    ])
      expect(await rejection(call())).to.include({ code: 'unsupported' })
    stream.setZoom(2)
    stream.pinch(2)
    const stop = stream.onStatus(() => {})
    stop()
    stream.onRadar(() => {})()
    stream.onUpload(() => {})()
  })
})

describe('a recording from the engine', function () {
  const base = {
    liveStreamId: 'lst_00000000000000000004',
    gameId: 'gam_00000000000000000001',
    angleName: 'Home Plate',
    startedAt: 1_790_000_000_000,
    endedAt: 1_790_000_060_000,
    parts: 1,
    stoppedForLowStorage: false,
    publishedOutsideParts: false,
    uploadRunning: false
  }

  it('is still to upload once an upload is wanted, before the server has opened it', function () {
    expect(toRecording(base).hasPendingUpload).equals(false)
    // An export the background cut off: the title says it was wanted, there is no id yet.
    expect(
      toRecording({ ...base, uploadTitle: 'Home Plate' }).hasPendingUpload
    ).equals(true)
    expect(
      toRecording({ ...base, uploadTitle: 'Home Plate', uploadId: 'dup_1' })
        .hasPendingUpload
    ).equals(true)
    expect(
      toRecording({
        ...base,
        uploadTitle: 'Home Plate',
        uploadId: 'dup_1',
        uploadedAt: 1_790_000_900_000
      }).hasPendingUpload
    ).equals(false)
  })
})

describe('the phone stream hooks', function () {
  it('map each status event to the hook’s state, and let go on unmount', function () {
    const native = fakePhoneStreamModule()
    const stream = makePhoneStream(native)
    const status = mount(() => usePhoneStreamStatusOf(stream))
    expect(status.current()).equals(null)
    act(() => {
      native.emitStatus(STATUS_EVENT)
    })
    expect(status.current()).deep.equals({
      phase: 'live',
      retryInSeconds: null,
      bitrateKbps: 2000,
      displayedZoom: 1,
      lensLabel: '26 mm',
      batteryPercent: 64,
      charging: true,
      thermal: 'fair',
      recordingSeconds: 12.5,
      isRecording: true,
      error: null
    })
    act(() => {
      native.emitStatus({
        ...STATUS_EVENT,
        phase: 'retrying',
        retryInSeconds: 4,
        batteryPercent: undefined,
        error: 'streamEnded'
      })
    })
    expect(status.current()).to.include({
      phase: 'retrying',
      retryInSeconds: 4,
      batteryPercent: null,
      error: 'streamEnded'
    })
    expect(cameraUnavailable(status.current())).equals(false)
    // Android says so while the camera is lost.
    act(() => {
      native.emitStatus({ ...STATUS_EVENT, error: 'cameraUnavailable' })
    })
    expect(status.current()?.error).equals(CAMERA_UNAVAILABLE)
    expect(cameraUnavailable(status.current())).equals(true)
    expect(cameraUnavailable(null)).equals(false)
    expect(native.listenerCount()).equals(1)
    act(() => {
      root?.unmount()
    })
    root = undefined
    expect(native.listenerCount()).equals(0)
  })

  it('read the radars once, then follow each change', async function () {
    const native = fakePhoneStreamModule({
      radarState: { ...RADAR_EVENT, enabled: false, devices: [] }
    })
    const stream = makePhoneStream(native)
    const radar = mount(() => useRadarStateOf(stream))
    await flush()
    expect(radar.current()).to.include({ enabled: false })
    act(() => {
      native.emitRadar({ ...RADAR_EVENT, scanning: true })
    })
    expect(radar.current()?.scanning).equals(true)
    expect(radar.current()?.devices[0]?.pitchMph).equals(54)
  })

  it('keep a radar report that arrives before the first read answers', async function () {
    const native = fakePhoneStreamModule({ radarState: RADAR_EVENT })
    const stream = makePhoneStream(native)
    const radar = mount(() => useRadarStateOf(stream))
    act(() => {
      native.emitRadar({ ...RADAR_EVENT, nearby: [] })
    })
    await flush()
    expect(radar.current()?.nearby).deep.equals([])
  })

  it('list the recordings, follow upload progress, and read the list again when one lands', async function () {
    const native = fakePhoneStreamModule({ recordings: [RECORDING] })
    const stream = makePhoneStream(native)
    const recordings = mount(() => useRecordingsOf(stream))
    expect(recordings.current().loaded).equals(false)
    await flush()
    expect(recordings.current().loaded).equals(true)
    expect(recordings.current().recordings.map(r => r.parts)).deep.equals([2])
    act(() => {
      native.emitUpload({
        liveStreamId: RECORDING.liveStreamId,
        state: 'uploading',
        fraction: 0.25,
        bytesSent: 25,
        bytesTotal: 100
      })
    })
    expect(recordings.current().uploads[RECORDING.liveStreamId]).to.include({
      state: 'uploading',
      fraction: 0.25
    })
    const reads = (): number =>
      native.calls.filter(call => call.name === 'recordings').length
    expect(reads()).equals(1)
    native.answers.recordings = [
      { ...RECORDING, uploadedAt: 1_790_000_900_000, videoId: 'vid_1' }
    ]
    act(() => {
      native.emitUpload({
        liveStreamId: RECORDING.liveStreamId,
        state: 'uploaded',
        fraction: 1,
        bytesSent: 100,
        bytesTotal: 100,
        videoId: 'vid_1'
      })
    })
    await flush()
    expect(reads()).equals(2)
    expect(recordings.current().recordings[0]?.videoId).equals('vid_1')
    act(() => {
      recordings.current().refresh()
    })
    await flush()
    expect(reads()).equals(3)
  })

  it('leave the list empty when it cannot be read', async function () {
    const native = fakePhoneStreamModule()
    native.failures.recordings = { code: 'noRecording' }
    native.failures.radarState = { code: 'notReady' }
    const stream: PhoneStream = makePhoneStream(native)
    const recordings = mount((): Recordings => useRecordingsOf(stream))
    await flush()
    expect(recordings.current().recordings).deep.equals([])
    expect(recordings.current().loaded).equals(false)
    act(() => {
      root?.unmount()
    })
    const radar = mount(() => useRadarStateOf(stream))
    await flush()
    expect(radar.current()).equals(null)
  })
})
