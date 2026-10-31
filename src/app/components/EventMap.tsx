import React, { useMemo } from 'react'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapDocument } from './eventMapDocument'
import { googleMapDocument } from './googleMapDocument'
import { MapFrame } from './MapFrame'

export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  const html = useMemo(
    () =>
      location.googleMapsApiKey == null || location.googleMapsApiKey === ''
        ? eventMapDocument(location)
        : googleMapDocument(location),
    [location]
  )
  return (
    <MapFrame
      html={html}
      title="Event location map"
      testID="event-location-map"
      point={{
        latitude: location.latitude ?? 0,
        longitude: location.longitude ?? 0
      }}
    />
  )
}
