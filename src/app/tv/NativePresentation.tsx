import React from 'react'
import {
  Image,
  Platform,
  requireNativeComponent,
  StyleSheet,
  View,
  type ViewProps
} from 'react-native'

export interface TvSearchItem {
  id: string
  title: string
  detail: string
  image: string | null
}
interface SearchProps extends ViewProps {
  items: TvSearchItem[]
  status: string
  onQuery: (event: { nativeEvent: { query: string } }) => void
  onSelect: (event: { nativeEvent: { id: string } }) => void
  onDismiss: () => void
}
export const nativeTvPresentation = Platform.OS === 'ios' && Platform.isTV
export const NativeSearch = nativeTvPresentation
  ? requireNativeComponent<SearchProps>('TVSearch')
  : null
const NativePoster = nativeTvPresentation
  ? requireNativeComponent<
      ViewProps & { uri: string; previewFocused: boolean }
    >('TVPoster')
  : null
export const NativeGradient = nativeTvPresentation
  ? requireNativeComponent<
      ViewProps & { direction: 'left' | 'right' | 'bottom'; maxOpacity: number }
    >('TVGradient')
  : null
export const PlaybackBoundary = nativeTvPresentation
  ? requireNativeComponent<
      ViewProps & {
        transportEnabled: boolean
        scrubEnabled: boolean
        onTransportRelease: (event: {
          nativeEvent: { direction: 'left' | 'right' | 'up' }
        }) => void
        onCancelTransport: () => void
        onPanCancelled: () => void
      }
    >('TVPlaybackBoundary')
  : View
const NativeBlur = nativeTvPresentation
  ? requireNativeComponent<
      ViewProps & { shade: string; tintOpacity: number; highlighted: boolean }
    >('TVBlur')
  : null
/** Tint is separate from the content so labels keep their full contrast. */
export function TvBlur({
  shade,
  opacity = 0.8,
  highlighted = false
}: {
  shade: string
  opacity?: number
  highlighted?: boolean
}): React.ReactElement {
  return NativeBlur === null ? (
    <View
      pointerEvents="none"
      testID="tv-blur-fallback"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor:
            shade.toLowerCase() === '#ffffff' ? '#ffffff' : '#4c4c4c',
          borderRadius: 20
        }
      ]}
    />
  ) : (
    <NativeBlur
      pointerEvents="none"
      shade={shade}
      tintOpacity={opacity}
      highlighted={highlighted}
      style={StyleSheet.absoluteFill}
    />
  )
}
export function TvPoster({
  uri,
  children,
  focused = false
}: {
  uri: string
  children?: React.ReactNode
  focused?: boolean
}): React.ReactElement {
  return NativePoster === null ? (
    <View style={StyleSheet.absoluteFill}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
      />
      {children}
    </View>
  ) : (
    <NativePoster
      uri={uri}
      previewFocused={focused}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      {children}
    </NativePoster>
  )
}
