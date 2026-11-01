import * as ReactNative from 'react-native'

import type { RemoteDirection, RemoteInput } from './transportState'

export interface TvRemoteEvent {
  eventType: string
  eventKeyAction?: number
  body?: { state: string; x?: number; y?: number }
}

/** The pinned tvOS runtime emits taps on Up, long presses on Down/Up, and touch phases separately. */
export function normalizeRemote(
  event: TvRemoteEvent,
  ios = true
): RemoteInput | null {
  const { eventType: type, eventKeyAction: action, body } = event
  if (type === 'cancel' || type === 'disconnect') return { kind: 'cancel' }
  if (type === 'pan') {
    const phases = {
      Began: 'begin',
      Changed: 'change',
      Ended: 'end',
      Cancelled: 'cancel'
    } as const
    const phase = phases[body?.state as keyof typeof phases]
    return phase === undefined || !Number.isFinite(body?.x)
      ? null
      : { kind: 'pan', phase, x: body!.x! }
  }
  const swipe = /^swipe(Left|Right|Up|Down)$/.exec(type)
  if (swipe !== null)
    return body?.state !== undefined && body.state !== 'Ended'
      ? null
      : { kind: 'swipe', direction: swipe[1].toLowerCase() as RemoteDirection }
  const hold = /^long(Left|Right|Up|Down)$/.exec(type)
  if (hold !== null)
    return action !== 0 && action !== 1
      ? null
      : {
          kind: 'hold',
          direction: hold[1].toLowerCase() as RemoteDirection,
          phase: action === 0 ? 'begin' : 'end'
        }
  if (action !== undefined && action !== (ios ? 1 : 0)) return null
  if (type === 'playPause') return { kind: 'playPause' }
  return ['left', 'right', 'up', 'down'].includes(type)
    ? { kind: 'click', direction: type as RemoteDirection }
    : null
}

/** Optional on web; provided by the pinned React Native TV runtime on the television. */
export const tvControl = (
  ReactNative as unknown as {
    TVEventControl?: {
      enableTVMenuKey: () => void
      disableTVMenuKey: () => void
      enableTVPanGesture: () => void
      disableTVPanGesture: () => void
    }
  }
).TVEventControl

export const tvEvents = (
  ReactNative as unknown as {
    TVEventHandler?: {
      addListener: (callback: (event: TvRemoteEvent) => void) => {
        remove: () => void
      }
    }
  }
).TVEventHandler

export const TvFocusGuide =
  (
    ReactNative as unknown as {
      TVFocusGuideView?: React.ComponentType<
        React.ComponentProps<typeof ReactNative.View> & { autoFocus?: boolean }
      >
    }
  ).TVFocusGuideView ?? ReactNative.View
export const TvTextScrollView =
  (
    ReactNative as unknown as {
      TVTextScrollView?: typeof ReactNative.ScrollView
    }
  ).TVTextScrollView ?? ReactNative.ScrollView
