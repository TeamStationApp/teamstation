import React from 'react'

import type { TeamStationClient } from '../../common/api'
import { CameraAnglesPanel } from './CameraAnglesPanel.native'

export interface StreamFooterProps {
  client: TeamStationClient
  gameId: string
}

/**
 * What the Videos tab ends with on a phone: its cameras on the game, with
 * Record video to film it from this one. The browser keeps its stream-URL
 * panel (`StreamFooter.tsx`).
 */
export function StreamFooter(props: StreamFooterProps): React.ReactElement {
  const { client, gameId } = props
  return <CameraAnglesPanel key={gameId} client={client} gameId={gameId} />
}
