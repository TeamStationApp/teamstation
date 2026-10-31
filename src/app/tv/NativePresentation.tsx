import React from 'react'
import {
  Image,
  Platform,
  requireNativeComponent,
  StyleSheet,
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
  ? requireNativeComponent<ViewProps & { uri: string }>('TVPoster')
  : null
export const NativeGradient = nativeTvPresentation
  ? requireNativeComponent<
      ViewProps & { direction: 'left' | 'right' | 'bottom' }
    >('TVGradient')
  : null
export function TvPoster({ uri }: { uri: string }): React.ReactElement {
  return NativePoster === null ? (
    <Image
      source={{ uri }}
      style={StyleSheet.absoluteFill}
      resizeMode="cover"
    />
  ) : (
    <NativePoster
      uri={uri}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  )
}
