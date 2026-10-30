import React, { useLayoutEffect, useRef, useState } from 'react'

import { MAP_FRAME_READY_MS } from './pinMapDocument'
import { PinMapUnavailable } from './PinMapUnavailable'

const typeOf = (data: unknown): unknown =>
  data == null || typeof data !== 'object'
    ? undefined
    : (data as { type?: unknown }).type

/**
 * Draws a map's document on the web, in `/mapFrame.html` under a sandbox.
 *
 * A document in `srcdoc` would take the page's policy, which refuses inline
 * script. The frame's own URL escapes that, and the sandbox, with no
 * `allow-same-origin`, leaves it an opaque origin, so Google's code reaches
 * none of the app's storage, cookies or page. The popups are its terms links.
 *
 * The frame says when it is ready and is sent the document. One that has not
 * said so within `readyMs` of starting gives way to the panel, but goes on
 * loading beneath it, so a slow connection still gets its map. A document may
 * rewrite itself after that, as Google's falls back to Leaflet, and is left to
 * it: only a remount, from Retry in either panel, restarts the frame.
 */
export function MapFrame({
  html,
  title,
  testID,
  point,
  onMessage,
  readyMs = MAP_FRAME_READY_MS
}: {
  html: string
  title: string
  testID: string
  /** Where the map is, for the panel. */
  point: { latitude: number; longitude: number }
  /** Whatever else the frame posts. */
  onMessage?: (data: unknown) => void
  readyMs?: number
}): React.ReactElement {
  const frame = useRef<HTMLIFrameElement>(null)
  const heard = useRef(onMessage)
  heard.current = onMessage
  const [attempt, setAttempt] = useState(0)
  const [stalled, setStalled] = useState<string>()
  const start = `${attempt}:${html}`
  // In the commit that inserts the frame, so its ready can't arrive first.
  useLayoutEffect(() => {
    setStalled(undefined)
    const wait = setTimeout(() => {
      setStalled(start)
    }, readyMs)
    const listen = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow
      if (event.source == null || event.source !== target) return
      const type = typeOf(event.data)
      if (type === 'teamstation:mapFrameReady') {
        clearTimeout(wait)
        setStalled(undefined)
        // `*` because an opaque origin has no name; `target` is this frame's.
        target.postMessage({ type: 'teamstation:mapDocument', html }, '*')
      } else if (type === 'teamstation:mapRetry') setAttempt(value => value + 1)
      else heard.current?.(event.data)
    }
    window.addEventListener('message', listen)
    return () => {
      clearTimeout(wait)
      window.removeEventListener('message', listen)
    }
  }, [start, html, readyMs])
  const late = stalled === start
  return (
    <>
      {late && (
        <PinMapUnavailable
          latitude={point.latitude}
          longitude={point.longitude}
          onRetry={() => {
            setAttempt(value => value + 1)
          }}
        />
      )}
      <iframe
        key={start}
        ref={frame}
        data-testid={testID}
        title={title}
        src="/mapFrame.html"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        allow="fullscreen"
        style={{
          display: late ? 'none' : 'block',
          border: 0,
          width: '100%',
          height: 260,
          borderRadius: 16
        }}
      />
    </>
  )
}
