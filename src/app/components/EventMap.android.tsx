import React, { useEffect, useRef, useState } from 'react'
import { PROVIDER_GOOGLE } from 'react-native-maps'

import type { EventLocation } from '../../common/eventInfo'
import { EventMap as WebEventMap } from './EventMap.native'
import { eventMapCoordinate } from './eventMapCoordinate'
import { NativeEventMapView } from './NativeEventMapView'

/** Native Google Maps SDK; its Android-restricted key lives in the built manifest. */
export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  const coordinate = eventMapCoordinate(location)
  return (
    <NativeGoogleMap
      key={`${coordinate.latitude}/${coordinate.longitude}`}
      location={location}
      coordinate={coordinate}
    />
  )
}

function NativeGoogleMap({
  location,
  coordinate
}: {
  location: EventLocation
  coordinate: { latitude: number; longitude: number }
}): React.ReactElement {
  const [fallback, setFallback] = useState(false)
  const failed = useRef(false)
  const loaded = useRef(false)
  const clearDeadline = useRef<() => void>(() => undefined)
  useEffect(() => {
    failed.current = false
    if (loaded.current) return
    const timer = setTimeout(() => {
      failed.current = true
      setFallback(true)
    }, 15000)
    clearDeadline.current = () => {
      clearTimeout(timer)
    }
    return () => {
      failed.current = true
      clearTimeout(timer)
    }
  }, [])
  if (fallback) return <WebEventMap location={location} />
  return (
    <NativeEventMapView
      coordinate={coordinate}
      provider={PROVIDER_GOOGLE}
      onMapLoaded={() => {
        if (failed.current) return
        loaded.current = true
        clearDeadline.current()
      }}
    />
  )
}
