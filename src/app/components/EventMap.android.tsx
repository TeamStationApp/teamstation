import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'

import type { EventLocation } from '../../common/eventInfo'
import { EventMap as WebEventMap } from './EventMap.native'
import { eventMapCoordinate } from './eventMapCoordinate'

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
  if (fallback)
    return (
      <WebEventMap location={{ ...location, googleMapsApiKey: undefined }} />
    )
  return (
    <View
      style={{
        height: 260,
        width: '100%',
        borderRadius: 16,
        overflow: 'hidden'
      }}
    >
      <MapView
        key={`${coordinate.latitude}/${coordinate.longitude}`}
        testID="event-location-map"
        accessibilityLabel="Event location map"
        provider={PROVIDER_GOOGLE}
        onMapLoaded={() => {
          if (failed.current) return
          loaded.current = true
          clearDeadline.current()
        }}
        style={{ flex: 1 }}
        initialRegion={{
          ...coordinate,
          latitudeDelta: 0.015,
          longitudeDelta: 0.015
        }}
        scrollEnabled
        zoomEnabled
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        <Marker coordinate={coordinate} title="Event location" />
      </MapView>
    </View>
  )
}
