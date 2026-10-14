import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The `TSPhoneStream` TurboModule's codegen spec: the phone's own streaming
// and recording engine (PhoneStream on iOS, streamcore's phonestream on
// Android). It is generated with the walk-up module, because this package's
// codegen reads one directory. iOS is ios/TeamStation/PhoneStream/, Android
// is android/.../stream/PhoneStreamModule.kt. Types and calls only; the
// adapter the screens use is shaped in phoneStreamClient.ts.
//
// A call the engine refuses rejects with the engine's error as its code:
// `notReady`, `uploadInProgress`, `insufficientStorage`, `recordingFailed`,
// `noRecording`, `stillRecording`, `permission` when the camera or the
// microphone was not allowed, or `cameraUnavailable` while the camera is
// lost (Android says so; iOS may not).

export interface NativePhoneStreamCapabilities {
  supported: boolean
  deviceModel: string
}

/** What the engine's own redial needs to ask for this device's stream again. */
export interface NativePhoneStreamRequest {
  apiBase: string
  token: string
  deviceId: string
  deviceModel: string
}

/** Four times a second while the engine is open. */
export interface NativePhoneStreamStatus {
  /** `idle`, `connecting`, `live` or `retrying`. */
  phase: string
  retryInSeconds?: CodegenTypes.Double
  bitrateKbps: CodegenTypes.Double
  displayedZoom: CodegenTypes.Double
  lensLabel: string
  batteryPercent?: CodegenTypes.Double
  charging: boolean
  /** `cool`, `fair`, `warm` or `hot`. */
  thermal: string
  recordingSeconds: CodegenTypes.Double
  isRecording: boolean
  /**
   * The engine's error code: `streamEnded`, `recordingStoppedLowStorage`,
   * `recordingFailed`, or `cameraUnavailable` for as long as the camera is
   * lost (Android sends it; iOS may not).
   */
  error?: string
}

export interface NativePhoneZoomScale {
  presets: CodegenTypes.Double[]
  switchOvers: CodegenTypes.Double[]
  digitalFrom?: CodegenTypes.Double
  minimum: CodegenTypes.Double
  maximum: CodegenTypes.Double
  current: CodegenTypes.Double
}

export interface NativePhoneLens {
  id: string
  /** `back` or `front`. */
  position: string
  title: string
  subtitle: string
  displayedZoom: CodegenTypes.Double
  focalLengthMM?: CodegenTypes.Double
  enabled: boolean
  canDisable: boolean
}

export interface NativeRadarDevice {
  serial: string
  /** `off`, `scanning`, `connecting`, `connected` or `bluetoothOff`. */
  connection: string
  batteryPercent?: CodegenTypes.Double
  pitchMph?: CodegenTypes.Double
  exitMph?: CodegenTypes.Double
  /** Milliseconds since 1970. */
  readingAt?: CodegenTypes.Double
}

export interface NativeRadarState {
  enabled: boolean
  scanning: boolean
  /** `on`, `off` or `unknown`. */
  bluetooth: string
  devices: NativeRadarDevice[]
  nearby: string[]
}

export interface NativePhoneRecording {
  liveStreamId: string
  gameId: string
  angleName: string
  /** Milliseconds since 1970, on the steady wall clock. */
  startedAt: CodegenTypes.Double
  endedAt?: CodegenTypes.Double
  parts: CodegenTypes.Int32
  uploadId?: string
  uploadTitle?: string
  uploadedAt?: CodegenTypes.Double
  videoId?: string
  stoppedForLowStorage: boolean
  publishedOutsideParts: boolean
  /** Its upload is running in this process now. */
  uploadRunning: boolean
  /** Where that running upload stands now: its last `onUpload`, for a screen that opens part-way. */
  uploadProgress?: NativeUploadProgress
}

export interface NativeUploadProgress {
  liveStreamId: string
  /** `exporting`, `uploading`, `processing`, `uploaded` or `failed`. */
  state: string
  fraction: CodegenTypes.Double
  bytesSent: CodegenTypes.Double
  bytesTotal: CodegenTypes.Double
  step?: string
  videoId?: string
  message?: string
}

export interface NativeInterruptedSession {
  liveStreamId: string
  gameId: string
  angleName: string
  streaming: boolean
  downtimeSeconds: CodegenTypes.Double
}

export interface Spec extends TurboModule {
  readonly onStatus: CodegenTypes.EventEmitter<NativePhoneStreamStatus>
  readonly onRadar: CodegenTypes.EventEmitter<NativeRadarState>
  readonly onUpload: CodegenTypes.EventEmitter<NativeUploadProgress>

  capabilities: () => Promise<NativePhoneStreamCapabilities>

  open: (
    angleName: string,
    audioEnabled: boolean,
    disabledLenses: string[]
  ) => Promise<void>
  close: () => Promise<void>
  setAngleName: (name: string) => Promise<void>
  startRecording: (
    rtmpUrl: string,
    liveStreamId: string,
    gameId: string,
    angleName: string,
    request: NativePhoneStreamRequest
  ) => Promise<void>
  stopRecording: () => Promise<void>
  interruptedSession: () => Promise<NativeInterruptedSession | null>
  resumeInterrupted: (request: NativePhoneStreamRequest) => Promise<boolean>

  setZoom: (displayed: CodegenTypes.Double) => void
  pinch: (scale: CodegenTypes.Double, ended: boolean) => void
  zoomScale: () => Promise<NativePhoneZoomScale>
  lenses: () => Promise<NativePhoneLens[]>
  setDisabledLenses: (ids: string[]) => Promise<void>
  flip: () => Promise<void>
  setAudioEnabled: (enabled: boolean) => Promise<void>

  radarSetEnabled: (enabled: boolean) => Promise<void>
  radarScan: () => Promise<void>
  radarStopScan: () => Promise<void>
  radarPair: (serial: string) => Promise<boolean>
  radarUnpair: (serial: string) => Promise<void>
  radarState: () => Promise<NativeRadarState>

  recordings: () => Promise<NativePhoneRecording[]>
  uploadRecording: (
    liveStreamId: string,
    apiBase: string,
    token: string,
    title: string
  ) => Promise<string>
  resumePendingUploads: (
    apiBase: string,
    token: string
  ) => Promise<CodegenTypes.Int32>
  cancelUpload: (liveStreamId: string) => Promise<void>
  deleteRecording: (liveStreamId: string) => Promise<void>
}

/** Null in a build without the module, which then offers no Record video. */
export default TurboModuleRegistry.get<Spec>('TSPhoneStream')
