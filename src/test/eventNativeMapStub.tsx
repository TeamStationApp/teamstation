import React from 'react'

export let nativeMapProps: {
  onMapLoaded?: () => void
  provider?: string
  mapType?: string
  testID?: string
  accessibilityLabel?: string
  initialRegion?: {
    latitude: number
    longitude: number
    latitudeDelta: number
    longitudeDelta: number
  }
  rotateEnabled?: boolean
  pitchEnabled?: boolean
}
export const PROVIDER_GOOGLE = 'google'
export default function MapView(
  props: typeof nativeMapProps & { children?: React.ReactNode }
): React.ReactElement {
  nativeMapProps = props
  return <div data-testid="native-google-map">{props.children}</div>
}
export let markerProps: {
  coordinate?: { latitude: number; longitude: number }
  title?: string
  draggable?: boolean
  onDragEnd?: (event: {
    nativeEvent: { coordinate: { latitude: number; longitude: number } }
  }) => void
}
export function Marker(props: typeof markerProps): React.ReactElement {
  markerProps = props
  return <div />
}
