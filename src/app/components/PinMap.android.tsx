import React, { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'

import { PinMap as WebPinMap } from './PinMap.native'
import type { PinMapProps } from './pinMapDocument'

/**
 * The pin map on Android: Google's SDK, with a pin that drags when it may,
 * and the WebView's map when the SDK has not drawn in 15 seconds.
 */
export function PinMap({
  settings,
  onMove,
  fallbackAfterMs = 15000
}: PinMapProps): React.ReactElement {
  const [fallback, setFallback] = useState(false)
  const loaded = useRef(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loaded.current) setFallback(true)
    }, fallbackAfterMs)
    return () => {
      clearTimeout(timer)
    }
  }, [fallbackAfterMs])
  if (fallback)
    return (
      <WebPinMap
        settings={{ ...settings, googleMapsApiKey: undefined }}
        onMove={onMove}
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
