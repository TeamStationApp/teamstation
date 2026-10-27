import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'

import type { PinMapProps } from './pinMapDocument'
import { PinMapUnavailable } from './PinMapUnavailable'

/**
 * The pin map on Android: Google's SDK, with a pin that drags when it may.
 * When the SDK has not drawn in 15 seconds, the "couldn’t load" panel takes
 * its place, and its Retry gives the SDK another try.
 */
export function PinMap({
  settings,
  onMove,
  fallbackAfterMs = 15000
}: PinMapProps): React.ReactElement {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const loaded = useRef(false)
  useEffect(() => {
    loaded.current = false
    const timer = setTimeout(() => {
      if (!loaded.current) setFailed(true)
    }, fallbackAfterMs)
    return () => {
      clearTimeout(timer)
    }
  }, [fallbackAfterMs, attempt])
  if (failed)
    return (
      <PinMapUnavailable
        latitude={settings.latitude}
        longitude={settings.longitude}
        onRetry={() => {
          setFailed(false)
          setAttempt(count => count + 1)
        }}
      />
    )
  const coordinate = {
    latitude: settings.latitude,
    longitude: settings.longitude
  }
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
        key={attempt}
        testID="pin-map"
        accessibilityLabel="Field location map"
        provider={PROVIDER_GOOGLE}
        onMapLoaded={() => {
          loaded.current = true
        }}
        style={{ flex: 1 }}
        initialRegion={{
          ...coordinate,
          latitudeDelta: 0.004,
          longitudeDelta: 0.004
        }}
        mapType="hybrid"
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        <Marker
          testID="pin-map-marker"
          accessibilityLabel="Field pin"
          coordinate={coordinate}
          title="Field location"
          draggable={settings.editable}
          onDragEnd={event => {
            onMove?.(event.nativeEvent.coordinate)
          }}
        />
      </MapView>
    </View>
  )
}
