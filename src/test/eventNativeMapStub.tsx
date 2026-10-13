import React from 'react'

export let nativeMapProps: { onMapLoaded?: () => void; provider?: string }
export const PROVIDER_GOOGLE = 'google'
export default function MapView(
  props: typeof nativeMapProps
): React.ReactElement {
  nativeMapProps = props
  return <div data-testid="native-google-map" />
}
export function Marker(): React.ReactElement {
  return <div />
}
