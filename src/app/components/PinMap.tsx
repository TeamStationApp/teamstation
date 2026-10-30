import React, { useMemo } from 'react'

import { MapFrame } from './MapFrame'
import { pinMapDocument, type PinMapProps, pinMovedOf } from './pinMapDocument'

export type { PinMapProps } from './pinMapDocument'

/**
 * A map with one pin, which an owner can drag to mark exactly where a field
 * is. On the web the map is Google's, in a frame that posts the pin back, or
 * the document's "couldn’t load" panel when Google's map cannot draw.
 */
export function PinMap({ settings, onMove }: PinMapProps): React.ReactElement {
  const html = useMemo(
    () => pinMapDocument(settings),
    // A new document only when where it starts, its key, or editing changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      settings.latitude,
      settings.longitude,
      settings.googleMapsApiKey,
      settings.editable
    ]
  )
  return (
    <MapFrame
      html={html}
      title="Field location map"
      testID="pin-map"
      point={settings}
      onMessage={data => {
        const moved = pinMovedOf(data)
        if (moved != null)
          onMove?.({ latitude: moved.latitude, longitude: moved.longitude })
      }}
    />
  )
}
