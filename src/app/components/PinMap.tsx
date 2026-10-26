import React, { useEffect, useMemo, useRef } from 'react'

import { pinMapDocument, type PinMapProps, pinMovedOf } from './pinMapDocument'

export type { PinMapProps } from './pinMapDocument'

/**
 * A map with one pin, which an owner can drag to mark exactly where a field
 * is. On the web the map is Google's, in a framed document that posts the pin
 * back, or the document's "couldn’t load" panel when Google's map cannot draw.
 */
export function PinMap({ settings, onMove }: PinMapProps): React.ReactElement {
  const frame = useRef<HTMLIFrameElement>(null)
  const move = useRef(onMove)
  move.current = onMove
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
  useEffect(() => {
    const listen = (event: MessageEvent): void => {
      if (event.source == null || event.source !== frame.current?.contentWindow)
        return
      const moved = pinMovedOf(event.data)
      if (moved != null)
        move.current?.({ latitude: moved.latitude, longitude: moved.longitude })
    }
    window.addEventListener('message', listen)
    return () => {
      window.removeEventListener('message', listen)
    }
  }, [])
  return (
    <iframe
      ref={frame}
      data-testid="pin-map"
      title="Field location map"
      srcDoc={html}
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
