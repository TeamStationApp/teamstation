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
