import React from 'react'
import { View } from 'react-native'
import MapView, { Marker, type PROVIDER_GOOGLE } from 'react-native-maps'

/**
 * The native event map both platforms draw: a 260-high rounded frame on the
 * event's point, with its marker. iOS passes no provider, which is Apple
 * Maps; Android passes Google's and listens for the first load.
 */
export function NativeEventMapView({
  coordinate,
  provider,
  onMapLoaded
}: {
  coordinate: { latitude: number; longitude: number }
  provider?: typeof PROVIDER_GOOGLE
  onMapLoaded?: () => void
}): React.ReactElement {
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
        provider={provider}
        onMapLoaded={onMapLoaded}
        style={{ flex: 1 }}
        initialRegion={{
          ...coordinate,
          latitudeDelta: 0.015,
          longitudeDelta: 0.015
        }}
        scrollEnabled
        zoomEnabled
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
      >
        <Marker coordinate={coordinate} title="Event location" />
      </MapView>
    </View>
  )
}
