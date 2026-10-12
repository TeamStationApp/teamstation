import type {
  NativePhoneRecording,
  NativePhoneStreamStatus,
  NativeRadarState,
  NativeUploadProgress,
  Spec
} from './NativePhoneStream'

type Handler<T> = (event: T) => void

/**
 * A stand-in `TSPhoneStream` module for tests: it records every call by name
 * with its arguments, answers what `answers` says, and lets a test emit the
 * module's three events.
 */
export interface FakePhoneStreamModule extends Spec {
  calls: Array<{ name: string; args: unknown[] }>
  answers: Record<string, unknown>
  /** Calls that reject, with the native error each throws. */
  failures: Record<string, unknown>
  emitStatus: (event: NativePhoneStreamStatus) => void
  emitRadar: (event: NativeRadarState) => void
  emitUpload: (event: NativeUploadProgress) => void
  listenerCount: () => number
}

export const STATUS_EVENT: NativePhoneStreamStatus = {
  phase: 'live',
  retryInSeconds: undefined,
  bitrateKbps: 2000,
  displayedZoom: 1,
  lensLabel: '26 mm',
  batteryPercent: 64,
  charging: true,
  thermal: 'fair',
  recordingSeconds: 12.5,
  isRecording: true
}

export const RADAR_EVENT: NativeRadarState = {
  enabled: true,
  scanning: false,
  bluetooth: 'on',
  devices: [
    {
      serial: 'TAG-00000001',
      connection: 'connected',
      batteryPercent: 80,
      pitchMph: 54,
      readingAt: 1_790_000_000_000
    }
  ],
  nearby: ['TAG-00000002']
}

export const RECORDING: NativePhoneRecording = {
  liveStreamId: 'lst_00000000000000000001',
  gameId: 'gam_00000000000000000001',
  angleName: 'Home Plate',
  startedAt: 1_790_000_000_000,
  parts: 2,
  stoppedForLowStorage: false,
  publishedOutsideParts: false,
  uploadRunning: false
}

export function fakePhoneStreamModule(
  answers: Record<string, unknown> = {}
): FakePhoneStreamModule {
  const calls: FakePhoneStreamModule['calls'] = []
  const failures: Record<string, unknown> = {}
  const status = new Set<Handler<NativePhoneStreamStatus>>()
  const radar = new Set<Handler<NativeRadarState>>()
  const upload = new Set<Handler<NativeUploadProgress>>()
  const emitter =
    <T>(handlers: Set<Handler<T>>) =>
    (handler: Handler<T>) => {
      handlers.add(handler)
      return {
        remove: () => {
          handlers.delete(handler)
        }
      }
    }
  const answer = (name: string) => {
    return async (...args: unknown[]): Promise<never> => {
      calls.push({ name, args })
      if (name in failures) throw failures[name]
      return answers[name] as never
    }
  }
  const fire = (name: string) => {
    return (...args: unknown[]): void => {
      calls.push({ name, args })
    }
  }
  const module: Record<string, unknown> = {
    calls,
    answers,
    failures,
    onStatus: emitter(status),
    onRadar: emitter(radar),
    onUpload: emitter(upload),
    emitStatus: (event: NativePhoneStreamStatus) => {
      for (const handler of status) handler(event)
    },
    emitRadar: (event: NativeRadarState) => {
      for (const handler of radar) handler(event)
    },
    emitUpload: (event: NativeUploadProgress) => {
      for (const handler of upload) handler(event)
    },
    listenerCount: () => status.size + radar.size + upload.size,
    setZoom: fire('setZoom'),
    pinch: fire('pinch'),
    getConstants: () => ({})
  }
  for (const name of [
    'capabilities',
    'open',
    'close',
    'setAngleName',
    'startRecording',
    'stopRecording',
    'interruptedSession',
    'resumeInterrupted',
    'zoomScale',
    'lenses',
    'setDisabledLenses',
    'flip',
    'setAudioEnabled',
    'radarSetEnabled',
    'radarScan',
    'radarStopScan',
    'radarPair',
    'radarUnpair',
    'radarState',
    'recordings',
    'uploadRecording',
    'resumePendingUploads',
    'cancelUpload',
    'deleteRecording'
  ])
    module[name] = answer(name)
  return module as unknown as FakePhoneStreamModule
}
