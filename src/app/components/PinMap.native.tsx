import React from 'react'
import { View } from 'react-native'
import MapView, { Marker } from 'react-native-maps'

import type { PinMapProps } from './pinMapDocument'

/**
 * The pin map on iOS: Apple Maps, through react-native-maps' default
 * provider, as a hybrid of satellite and roads. The pin drags when the map is
 * editable, and reports where it was let go.
 */
export function PinMap({ settings, onMove }: PinMapProps): React.ReactElement {
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
        style={{ flex: 1 }}
        initialRegion={{
          ...coordinate,
          latitudeDelta: 0.004,
          longitudeDelta: 0.004
        }}
        mapType="hybrid"
        rotateEnabled={false}
        pitchEnabled={false}
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
