import React from 'react'

import { CameraAnglesPanel } from './CameraAnglesPanel.native'
import type { StreamFooterProps } from './streamFooterProps'

export type { StreamFooterProps }

/**
 * What the Videos tab ends with on a phone: its cameras on the game, with
 * Record Video to add one, or "No videos" while it has neither. The browser
 * keeps its stream-URL panel (`StreamFooter.tsx`).
 */
export function StreamFooter(props: StreamFooterProps): React.ReactElement {
  const { client, gameId, onPublishing, hasVideo, onPlay } = props
  return (
    <CameraAnglesPanel
      key={gameId}
      client={client}
      gameId={gameId}
      onPublishing={onPublishing}
      hasVideo={hasVideo}
      onPlay={onPlay}
    />
  )
}
