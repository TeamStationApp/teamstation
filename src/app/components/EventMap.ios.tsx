import React from 'react'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapCoordinate } from './eventMapCoordinate'
import { NativeEventMapView } from './NativeEventMapView'

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
  return (
    <NativeEventMapView
      coordinate={eventMapCoordinate(location)}
      pitchEnabled={false}
    />
  )
}
