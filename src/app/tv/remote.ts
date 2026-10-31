import * as ReactNative from 'react-native'

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
      addListener: (
        callback: (event: {
          eventType: string
          eventKeyAction?: number
          body?: { state: string; x: number; y: number }
        }) => void
      ) => { remove: () => void }
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
