import { useCallback, useEffect, useState } from 'react'

import type {
  NativePhoneLens,
  NativePhoneRecording,
  NativePhoneStreamRequest,
  NativePhoneStreamStatus,
  NativePhoneZoomScale,
  NativeRadarDevice,
  NativeRadarState,
  NativeUploadProgress,
  Spec
} from './NativePhoneStream'

/** The stream's state, as the pill shows it. */
export type PhoneStreamPhase = 'idle' | 'connecting' | 'live' | 'retrying'
/** TS Cameraman's four heat levels. */
export type ThermalLevel = 'cool' | 'fair' | 'warm' | 'hot'

export interface PhoneStreamCapabilities {
  /** This phone can record video: the module is there and it encodes HEVC 1080p30. */
  supported: boolean
  /** What TeamStation lists this phone as beside its angles, "" when unsupported. */
  deviceModel: string
  /**
   * Whether Record would keep a recording now, rather than only streaming:
   * false under the engine's start floor. Read at Record, not kept.
   */
  canRecordLocally: boolean
}

/** What the engine's redial needs to ask for this device's stream again. */
export type PhoneStreamRequest = NativePhoneStreamRequest

export interface PhoneStreamStatus {
  phase: PhoneStreamPhase
  /** While `retrying`, how long until the next redial. */
  retryInSeconds: number | null
  bitrateKbps: number
  displayedZoom: number
  lensLabel: string
  /** Null when the phone does not say, as a simulator does not. */
  batteryPercent: number | null
  charging: boolean
  thermal: ThermalLevel
  recordingSeconds: number
  isRecording: boolean
  /**
   * The engine's error code, such as `streamEnded`,
   * `recordingStoppedLowStorage`, or `cameraUnavailable` while the camera is
   * lost (`CAMERA_UNAVAILABLE`).
   */
  error: string | null
}

/**
 * The error code the engine reports, and refuses Record with, for as long as
 * the camera is lost. Android sends it; iOS may not, and then nothing is
 * shown.
 */
export const CAMERA_UNAVAILABLE = 'cameraUnavailable'

/** Whether the engine says the camera is lost just now. */
export function cameraUnavailable(status: PhoneStreamStatus | null): boolean {
  return status?.error === CAMERA_UNAVAILABLE
}

export interface PhoneZoomScale {
  presets: number[]
  switchOvers: number[]
  /** Where digital zoom starts, null when the camera has none. */
  digitalFrom: number | null
  minimum: number
  maximum: number
  current: number
}

export interface PhoneLens {
  id: string
  position: 'back' | 'front'
  title: string
  subtitle: string
  displayedZoom: number
  focalLengthMM: number | null
  enabled: boolean
  canDisable: boolean
}

export interface RadarDevice {
  serial: string
  connection: string
  batteryPercent: number | null
  pitchMph: number | null
  exitMph: number | null
  /** Milliseconds since 1970 of the latest reading. */
  readingAt: number | null
}

export interface RadarState {
  enabled: boolean
  scanning: boolean
  bluetooth: 'on' | 'off' | 'unknown'
  devices: RadarDevice[]
  nearby: string[]
}

export interface PhoneRecording {
  liveStreamId: string
  gameId: string
  angleName: string
  /** Milliseconds since 1970. */
  startedAt: number
  endedAt: number | null
  parts: number
  uploadId: string | null
  uploadTitle: string | null
  uploadedAt: number | null
  videoId: string | null
  stoppedForLowStorage: boolean
  publishedOutsideParts: boolean
  /** An upload was opened and has not landed: running, or cut off and waiting to resume. */
  hasPendingUpload: boolean
  /** Its upload is running in this process now. */
  uploadRunning: boolean
  /**
   * Where that running upload stands as the list was read. An upload resumed
   * at launch reports before any screen listens, so its row starts from this.
   */
  uploadProgress: UploadProgress | null
}

export type UploadState =
  'exporting' | 'uploading' | 'processing' | 'uploaded' | 'failed'

export interface UploadProgress {
  liveStreamId: string
  state: UploadState
  fraction: number
  bytesSent: number
  bytesTotal: number
  step: string | null
  videoId: string | null
  message: string | null
}

export interface InterruptedSession {
  liveStreamId: string
  gameId: string
  angleName: string
  streaming: boolean
  downtimeSeconds: number
}

/**
 * A call the engine refused, by the engine's code: `notReady`,
 * `uploadInProgress`, `recordingFailed`, `noRecording`, `stillRecording`,
 * `permission`, `cameraUnavailable`, or `unsupported` in a build without the
 * module.
 */
export class PhoneStreamError extends Error {
  readonly code: string
  constructor(code: string, message: string = code) {
    super(message)
    this.name = 'PhoneStreamError'
    this.code = code
  }
}

/** How Android's runtime permissions are asked; off Android `androidApi` is null. */
export interface PermissionHost {
  androidApi: number | null
  /** Asks for every one of `permissions`; true when all are granted. */
  request: (permissions: string[]) => Promise<boolean>
}

export const NO_PERMISSIONS: PermissionHost = {
  androidApi: null,
  request: async () => true
}

const CAMERA = 'android.permission.CAMERA'
const RECORD_AUDIO = 'android.permission.RECORD_AUDIO'
const BLUETOOTH_SCAN = 'android.permission.BLUETOOTH_SCAN'
const BLUETOOTH_CONNECT = 'android.permission.BLUETOOTH_CONNECT'
const ACCESS_FINE_LOCATION = 'android.permission.ACCESS_FINE_LOCATION'
const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS'

/**
 * The Android permissions each step needs, by API level: the camera and the
 * microphone to open; for the radar the Bluetooth pair on 31 and later, fine
 * location on 30; and notifications on 33 and later before an upload, so its
 * progress notification shows.
 */
export function androidPermissionsFor(
  step: 'open' | 'radar' | 'upload',
  api: number
): string[] {
  if (step === 'open') return [CAMERA, RECORD_AUDIO]
  if (step === 'radar')
    return api >= 31
      ? [BLUETOOTH_SCAN, BLUETOOTH_CONNECT]
      : [ACCESS_FINE_LOCATION]
  return api >= 33 ? [POST_NOTIFICATIONS] : []
}

/** The subset of React Native's `PermissionsAndroid` the host uses. */
export interface PermissionsAndroidLike {
  requestMultiple: (permissions: never[]) => Promise<Record<string, string>>
  RESULTS: { GRANTED: string }
}

/** A `PermissionHost` over `PermissionsAndroid`, or none off Android. */
export function androidPermissionHost(
  os: string,
  version: number | string,
  permissions: PermissionsAndroidLike
): PermissionHost {
  if (os !== 'android') return NO_PERMISSIONS
  return {
    androidApi: Number(version),
    request: async wanted => {
      if (wanted.length === 0) return true
      const results = await permissions.requestMultiple(wanted as never[])
      return wanted.every(name => results[name] === permissions.RESULTS.GRANTED)
    }
  }
}

const orNull = <T>(value: T | null | undefined): T | null => value ?? null

const PHASES: readonly PhoneStreamPhase[] = [
  'idle',
  'connecting',
  'live',
  'retrying'
]
const THERMALS: readonly ThermalLevel[] = ['cool', 'fair', 'warm', 'hot']

export function toStatus(event: NativePhoneStreamStatus): PhoneStreamStatus {
  return {
    phase: PHASES.includes(event.phase as PhoneStreamPhase)
      ? (event.phase as PhoneStreamPhase)
      : 'idle',
    retryInSeconds: orNull(event.retryInSeconds),
    bitrateKbps: event.bitrateKbps,
    displayedZoom: event.displayedZoom,
    lensLabel: event.lensLabel,
    batteryPercent: orNull(event.batteryPercent),
    charging: event.charging,
    thermal: THERMALS.includes(event.thermal as ThermalLevel)
      ? (event.thermal as ThermalLevel)
      : 'cool',
    recordingSeconds: event.recordingSeconds,
    isRecording: event.isRecording,
    error: orNull(event.error)
  }
}

function toZoomScale(scale: NativePhoneZoomScale): PhoneZoomScale {
  return {
    presets: [...scale.presets],
    switchOvers: [...scale.switchOvers],
    digitalFrom: orNull(scale.digitalFrom),
    minimum: scale.minimum,
    maximum: scale.maximum,
    current: scale.current
  }
}

function toLens(lens: NativePhoneLens): PhoneLens {
  return {
    id: lens.id,
    position: lens.position === 'front' ? 'front' : 'back',
    title: lens.title,
    subtitle: lens.subtitle,
    displayedZoom: lens.displayedZoom,
    focalLengthMM: orNull(lens.focalLengthMM),
    enabled: lens.enabled,
    canDisable: lens.canDisable
  }
}

function toRadarDevice(device: NativeRadarDevice): RadarDevice {
  return {
    serial: device.serial,
    connection: device.connection,
    batteryPercent: orNull(device.batteryPercent),
    pitchMph: orNull(device.pitchMph),
    exitMph: orNull(device.exitMph),
    readingAt: orNull(device.readingAt)
  }
}

export function toRadarState(state: NativeRadarState): RadarState {
  return {
    enabled: state.enabled,
    scanning: state.scanning,
    bluetooth:
      state.bluetooth === 'on' || state.bluetooth === 'off'
        ? state.bluetooth
        : 'unknown',
    devices: state.devices.map(toRadarDevice),
    nearby: [...state.nearby]
  }
}

export function toRecording(recording: NativePhoneRecording): PhoneRecording {
  const uploadId = orNull(recording.uploadId)
  const uploadedAt = orNull(recording.uploadedAt)
  return {
    liveStreamId: recording.liveStreamId,
    gameId: recording.gameId,
    angleName: recording.angleName,
    startedAt: recording.startedAt,
    endedAt: orNull(recording.endedAt),
    parts: recording.parts,
    uploadId,
    uploadTitle: orNull(recording.uploadTitle),
    uploadedAt,
    videoId: orNull(recording.videoId),
    stoppedForLowStorage: recording.stoppedForLowStorage,
    publishedOutsideParts: recording.publishedOutsideParts,
    // Wanted and not landed: the engines mark an upload wanted by its title before the export, so
    // one cut off while exporting resumes with the next launch, and an opened one carries its id.
    hasPendingUpload:
      (uploadId != null || recording.uploadTitle != null) && uploadedAt == null,
    uploadRunning: recording.uploadRunning,
    uploadProgress:
      recording.uploadRunning && recording.uploadProgress != null
        ? toUploadProgress(recording.uploadProgress)
        : null
  }
}

const UPLOAD_STATES: readonly UploadState[] = [
  'exporting',
  'uploading',
  'processing',
  'uploaded',
  'failed'
]

export function toUploadProgress(event: NativeUploadProgress): UploadProgress {
  return {
    liveStreamId: event.liveStreamId,
    state: UPLOAD_STATES.includes(event.state as UploadState)
      ? (event.state as UploadState)
      : 'failed',
    fraction: event.fraction,
    bytesSent: event.bytesSent,
    bytesTotal: event.bytesTotal,
    step: orNull(event.step),
    videoId: orNull(event.videoId),
    message: orNull(event.message)
  }
}

type Listener<T> = (value: T) => void

/** The engine as the screens use it: typed results, and refusals as `PhoneStreamError`. */
export interface PhoneStream {
  capabilities: () => Promise<PhoneStreamCapabilities>
  open: (
    angleName: string,
    options?: { audioEnabled?: boolean; disabledLenses?: string[] }
  ) => Promise<void>
  close: () => Promise<void>
  setAngleName: (name: string) => Promise<void>
  startRecording: (options: {
    rtmpUrl: string
    liveStreamId: string
    gameId: string
    angleName: string
    request: PhoneStreamRequest
  }) => Promise<void>
  stopRecording: () => Promise<void>
  interruptedSession: () => Promise<InterruptedSession | null>
  resumeInterrupted: (request: PhoneStreamRequest) => Promise<boolean>
  setZoom: (displayed: number) => void
  pinch: (scale: number, ended?: boolean) => void
  zoomScale: () => Promise<PhoneZoomScale>
  lenses: () => Promise<PhoneLens[]>
  setDisabledLenses: (ids: string[]) => Promise<void>
  flip: () => Promise<void>
  setAudioEnabled: (enabled: boolean) => Promise<void>
  radarSetEnabled: (enabled: boolean) => Promise<void>
  radarScan: () => Promise<void>
  radarStopScan: () => Promise<void>
  radarPair: (serial: string) => Promise<boolean>
  radarUnpair: (serial: string) => Promise<void>
  radarState: () => Promise<RadarState>
  recordings: () => Promise<PhoneRecording[]>
  uploadRecording: (options: {
    liveStreamId: string
    apiBase: string
    token: string
    title: string
  }) => Promise<string>
  resumePendingUploads: (apiBase: string, token: string) => Promise<number>
  /**
   * Carries on one take's cut-off upload, as `uploadRecording` does but
   * without asking for anything: nobody pressed a button for it.
   */
  resumeUpload: (options: {
    liveStreamId: string
    apiBase: string
    token: string
    title: string
  }) => Promise<string>
  cancelUpload: (liveStreamId: string) => Promise<void>
  deleteRecording: (liveStreamId: string) => Promise<void>
  onStatus: (listener: Listener<PhoneStreamStatus>) => () => void
  onRadar: (listener: Listener<RadarState>) => () => void
  onUpload: (listener: Listener<UploadProgress>) => () => void
}

/** A native rejection's code, kept; anything else is passed on as it is. */
function refusal(error: unknown): unknown {
  if (error instanceof PhoneStreamError) return error
  if (typeof error === 'object' && error != null && 'code' in error) {
    const { code } = error
    const message = (error as { message?: unknown }).message
    if (typeof code === 'string' && code !== '')
      return new PhoneStreamError(
        code,
        typeof message === 'string' && message !== '' ? message : code
      )
  }
  return error
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw refusal(error)
  }
}

/**
 * The engine behind typed calls. With no module (the web, or a build without
 * it) `capabilities` answers unsupported, every other call rejects with
 * `unsupported`, and the listeners never hear anything.
 */
export function makePhoneStream(
  native: Spec | null | undefined,
  permissions: PermissionHost = NO_PERMISSIONS
): PhoneStream {
  const module = native ?? null
  const need = (): Spec => {
    if (module == null) throw new PhoneStreamError('unsupported')
    return module
  }
  const allow = async (
    step: 'open' | 'radar' | 'upload',
    required: boolean
  ): Promise<void> => {
    if (permissions.androidApi == null) return
    const wanted = androidPermissionsFor(step, permissions.androidApi)
    const granted = await permissions.request(wanted)
    if (!granted && required) throw new PhoneStreamError('permission')
  }
  const listen = <N, T>(
    subscribe: ((handler: (event: N) => void) => { remove: () => void }) | null,
    convert: (event: N) => T,
    listener: Listener<T>
  ): (() => void) => {
    if (subscribe == null) return () => {}
    const subscription = subscribe(event => {
      listener(convert(event))
    })
    return () => {
      subscription.remove()
    }
  }

  return {
    capabilities: async () => {
      const none = {
        supported: false,
        deviceModel: '',
        canRecordLocally: false
      }
      if (module == null) return none
      try {
        const answer = await module.capabilities()
        return {
          supported: answer.supported,
          deviceModel: answer.deviceModel,
          canRecordLocally: answer.canRecordLocally
        }
      } catch {
        return none
      }
    },
    open: async (angleName, options = {}) => {
      await call(async () => {
        const engine = need()
        await allow('open', true)
        await engine.open(
          angleName,
          options.audioEnabled ?? true,
          options.disabledLenses ?? []
        )
      })
    },
    close: async () => {
      await call(async () => {
        await need().close()
      })
    },
    setAngleName: async name => {
      await call(async () => {
        await need().setAngleName(name)
      })
    },
    startRecording: async ({
      rtmpUrl,
      liveStreamId,
      gameId,
      angleName,
      request
    }) => {
      await call(async () => {
        await need().startRecording(
          rtmpUrl,
          liveStreamId,
          gameId,
          angleName,
          request
        )
      })
    },
    stopRecording: async () => {
      await call(async () => {
        await need().stopRecording()
      })
    },
    interruptedSession: async () =>
      await call(async () => {
        const session = await need().interruptedSession()
        return session == null
          ? null
          : {
              liveStreamId: session.liveStreamId,
              gameId: session.gameId,
              angleName: session.angleName,
              streaming: session.streaming,
              downtimeSeconds: session.downtimeSeconds
            }
      }),
    resumeInterrupted: async request =>
      await call(async () => await need().resumeInterrupted(request)),
    setZoom: displayed => {
      module?.setZoom(displayed)
    },
    pinch: (scale, ended = false) => {
      module?.pinch(scale, ended)
    },
    zoomScale: async () =>
      await call(async () => toZoomScale(await need().zoomScale())),
    lenses: async () =>
      await call(async () => (await need().lenses()).map(toLens)),
    setDisabledLenses: async ids => {
      await call(async () => {
        await need().setDisabledLenses(ids)
      })
    },
    flip: async () => {
      await call(async () => {
        await need().flip()
      })
    },
    setAudioEnabled: async enabled => {
      await call(async () => {
        await need().setAudioEnabled(enabled)
      })
    },
    radarSetEnabled: async enabled => {
      await call(async () => {
        const engine = need()
        if (enabled) await allow('radar', true)
        await engine.radarSetEnabled(enabled)
      })
    },
    radarScan: async () => {
      await call(async () => {
        await need().radarScan()
      })
    },
    radarStopScan: async () => {
      await call(async () => {
        await need().radarStopScan()
      })
    },
    radarPair: async serial =>
      await call(async () => await need().radarPair(serial)),
    radarUnpair: async serial => {
      await call(async () => {
        await need().radarUnpair(serial)
      })
    },
    radarState: async () =>
      await call(async () => toRadarState(await need().radarState())),
    recordings: async () =>
      await call(async () => (await need().recordings()).map(toRecording)),
    uploadRecording: async ({ liveStreamId, apiBase, token, title }) =>
      await call(async () => {
        const engine = need()
        // Without it the upload still runs; only its notification is hidden.
        await allow('upload', false)
        return await engine.uploadRecording(liveStreamId, apiBase, token, title)
      }),
    resumePendingUploads: async (apiBase, token) =>
      await call(async () => await need().resumePendingUploads(apiBase, token)),
    resumeUpload: async ({ liveStreamId, apiBase, token, title }) =>
      await call(
        async () =>
          await need().uploadRecording(liveStreamId, apiBase, token, title)
      ),
    cancelUpload: async liveStreamId => {
      await call(async () => {
        await need().cancelUpload(liveStreamId)
      })
    },
    deleteRecording: async liveStreamId => {
      await call(async () => {
        await need().deleteRecording(liveStreamId)
      })
    },
    onStatus: listener => listen(module?.onStatus ?? null, toStatus, listener),
    onRadar: listener =>
      listen(module?.onRadar ?? null, toRadarState, listener),
    onUpload: listener =>
      listen(module?.onUpload ?? null, toUploadProgress, listener)
  }
}

/** The latest status, null until the engine first reports. */
export function usePhoneStreamStatusOf(
  stream: PhoneStream
): PhoneStreamStatus | null {
  const [status, setStatus] = useState<PhoneStreamStatus | null>(null)
  useEffect(() => stream.onStatus(setStatus), [stream])
  return status
}

/** The radars: read once, then every change the engine reports. */
export function useRadarStateOf(stream: PhoneStream): RadarState | null {
  const [state, setState] = useState<RadarState | null>(null)
  useEffect(() => {
    let live = true
    let heard = false
    const stop = stream.onRadar(next => {
      heard = true
      setState(next)
    })
    stream.radarState().then(
      first => {
        // A report that came while the read was out is newer than it.
        if (live && !heard) setState(first)
      },
      () => {}
    )
    return () => {
      live = false
      stop()
    }
  }, [stream])
  return state
}

export interface Recordings {
  recordings: PhoneRecording[]
  /** The latest progress of each upload heard of, by live stream. */
  uploads: Record<string, UploadProgress>
  refresh: () => void
}

/**
 * The takes on this phone, with each upload's progress. The list is read
 * again whenever an upload lands or fails, so its row changes with it.
 */
export function useRecordingsOf(stream: PhoneStream): Recordings {
  const [recordings, setRecordings] = useState<PhoneRecording[]>([])
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({})
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => {
    setGeneration(value => value + 1)
  }, [])
  useEffect(() => {
    let live = true
    stream.recordings().then(
      list => {
        if (live) setRecordings(list)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [stream, generation])
  useEffect(
    () =>
      stream.onUpload(progress => {
        setUploads(current => ({
          ...current,
          [progress.liveStreamId]: progress
        }))
        if (progress.state === 'uploaded' || progress.state === 'failed')
          refresh()
      }),
    [stream, refresh]
  )
  return { recordings, uploads, refresh }
}
