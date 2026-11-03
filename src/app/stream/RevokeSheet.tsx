import React from 'react'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { lstrings } from '../locales/strings'
import { ConfirmSheet } from './ConfirmSheet'

export interface RevokeSheetProps {
  visible: boolean
  client: TeamStationClient
  gameId: string
  stream: LiveStream
  onCancel: () => void
  /** The URL is dead and the camera over, or gone. */
  onRevoked: () => void
  onDismiss?: () => void
}

/** The confirmation before Revoke, with the angle's name in bold. */
export function RevokeSheet(props: RevokeSheetProps): React.ReactElement {
  const { visible, client, gameId, stream, onCancel, onRevoked, onDismiss } =
    props
  return (
    <ConfirmSheet
      visible={visible}
      title={lstrings.stream_revoke_title}
      body={lstrings.stream_revoke_body}
      angle={stream.label}
      confirmLabel={lstrings.stream_rtmp_revoke}
      id="revoke"
      onConfirm={async () => {
        // The server decides whether the camera goes: what the list last said
        // of it can be a moment old.
        await client.revokeLiveStream(gameId, stream.id)
      }}
      onDone={onRevoked}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />
  )
}
