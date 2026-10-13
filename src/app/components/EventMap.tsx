import React from 'react'

import type { EventLocation } from '../../common/eventInfo'
import { eventMapDocument } from './eventMapDocument'
import { googleMapDocument } from './googleMapDocument'

export function EventMap({
  location
}: {
  location: EventLocation
}): React.ReactElement {
  return (
    <iframe
      data-testid="event-location-map"
      title="Event location map"
      srcDoc={
        location.googleMapsApiKey == null || location.googleMapsApiKey === ''
          ? eventMapDocument(location)
          : googleMapDocument(location)
      }
      style={{
        display: 'block',
        border: 0,
        width: '100%',
        height: 260,
        borderRadius: 16
      }}
    />
  )
}
