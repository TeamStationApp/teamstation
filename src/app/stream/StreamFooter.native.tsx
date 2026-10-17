import React from 'react'

import type { TeamStationClient } from '../../common/api'
import { CameraAnglesPanel } from './CameraAnglesPanel.native'

export interface StreamFooterProps {
  client: TeamStationClient
  gameId: string
  /** The videos this game's cameras are publishing to, each time that changes. */
  onPublishing?: (videoIds: string[]) => void
}

/**
 * What the Videos tab ends with on a phone: its cameras on the game, with
 * Record video to film it from this one. The browser keeps its stream-URL
 * panel (`StreamFooter.tsx`).
 */
export function StreamFooter(props: StreamFooterProps): React.ReactElement {
  const { client, gameId, onPublishing } = props
  return (
    <CameraAnglesPanel
      key={gameId}
      client={client}
      gameId={gameId}
      onPublishing={onPublishing}
    />
  )
}
