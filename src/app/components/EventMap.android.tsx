import React from 'react'
import { View } from 'react-native'
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps'

import type { EventLocation } from '../../common/eventInfo'

/** Native Google Maps SDK; its Android-restricted key lives in the built manifest. */
export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  if (location.latitude == null || location.longitude == null)
    throw new Error('The address could not be located.')
  const coordinate = {
    latitude: location.latitude,
    longitude: location.longitude
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
        key={`${coordinate.latitude}/${coordinate.longitude}`}
        testID="event-location-map"
        accessibilityLabel="Event location map"
        provider={PROVIDER_GOOGLE}
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
