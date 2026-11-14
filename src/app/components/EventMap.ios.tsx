import React from 'react'
import { View } from 'react-native'
import MapView, { Marker } from 'react-native-maps'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapCoordinate } from './eventMapCoordinate'

/**
 * The event map on iOS: Apple Maps, through react-native-maps' default
 * provider, with a marker on the event's point. It needs no key and never
 * draws Google's map.
 */
export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  const coordinate = eventMapCoordinate(location)
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
      >
        <Marker coordinate={coordinate} title="Event location" />
      </MapView>
    </View>
  )
}
