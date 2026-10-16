import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'

import type { EventLocation } from '../../common/eventInfo'
import { EventMap as WebEventMap } from './EventMap.native'

/** Native Google Maps SDK; its Android-restricted key lives in the built manifest. */
export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  if (
    location.latitude == null ||
    location.longitude == null ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.latitude) > 90 ||
    Math.abs(location.longitude) > 180
  )
    throw new Error('The address could not be located.')
  return (
    <NativeGoogleMap
      key={`${location.latitude}/${location.longitude}`}
      location={location}
      coordinate={{
        latitude: location.latitude,
        longitude: location.longitude
      }}
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
