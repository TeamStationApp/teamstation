import React from 'react'

export let nativeMapProps: {
  onMapLoaded?: () => void
  provider?: string
  mapType?: string
}
export const PROVIDER_GOOGLE = 'google'
export default function MapView(
  props: typeof nativeMapProps & { children?: React.ReactNode }
): React.ReactElement {
  nativeMapProps = props
  return <div data-testid="native-google-map">{props.children}</div>
}
export let markerProps: {
  draggable?: boolean
  onDragEnd?: (event: {
    nativeEvent: { coordinate: { latitude: number; longitude: number } }
  }) => void
}
export function Marker(props: typeof markerProps): React.ReactElement {
  markerProps = props
  return <div />
}
