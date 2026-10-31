import React from 'react'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { lstrings } from '../locales/strings'
import { ConfirmSheet } from './ConfirmSheet'

export interface RevokeSheetProps {
  visible: boolean
  client: TeamStationClient
  gameId: string
  /** The camera, as the list last gave it. */
  stream: LiveStream
  onCancel: () => void
  /** The URL is dead and the camera over, or gone. */
  onRevoked: () => void
  onDismiss?: () => void
}

/**
 * End stops a camera and Remove deletes it, and Remove is refused while live,
 * so Revoke asks for both. A camera that never carried video goes altogether,
 * and one that did stays as an ended row, keeping what it recorded.
 */
async function revoke(
  client: TeamStationClient,
  gameId: string,
  stream: LiveStream
): Promise<void> {
  await client.endLiveStream(gameId, stream.id)
  // `publishedAt` is on the list's items only, so a camera just made has none.
  if (stream.publishedAt == null)
    await client.removeLiveStream(gameId, stream.id)
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
        await revoke(client, gameId, stream)
      }}
      onDone={onRevoked}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />
  )
}
