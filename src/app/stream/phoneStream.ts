import {
  makePhoneStream,
  type PhoneStreamStatus,
  type RadarState,
  type Recordings,
  usePhoneStreamStatusOf,
  useRadarStateOf,
  useRecordingsOf
} from './phoneStreamClient'

export * from './phoneStreamClient'

/**
 * The browser has no phone camera to stream from: `capabilities()` answers
 * unsupported, so the web shows no Record video, and every other call
 * rejects with `unsupported`. `phoneStream.native.ts` is the phone's.
 */
export const phoneStream = makePhoneStream(null)

/** The browser draws no camera preview. */
export function PhoneStreamPreview(_props: { mirrored?: boolean }): null {
  return null
}

export const usePhoneStreamStatus = (): PhoneStreamStatus | null =>
  usePhoneStreamStatusOf(phoneStream)
export const useRadarState = (): RadarState | null =>
  useRadarStateOf(phoneStream)
export const useRecordings = (): Recordings => useRecordingsOf(phoneStream)

/** Nothing to report in a browser. */
export function reportPhoneStreamCapabilities(): void {}
