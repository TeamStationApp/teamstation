import React from 'react'

import { StreamPanel } from '../components/StreamPanel'
import type { StreamFooterProps } from './streamFooterProps'

export type { StreamFooterProps }

/**
 * What the Videos tab ends with for the people who run the team. In a
 * browser that is the cameras panel with their stream URLs, for streaming
 * software or TS Director; a phone records with its own camera instead
 * (`StreamFooter.native.tsx`).
 */
export function StreamFooter(props: StreamFooterProps): React.ReactElement {
  const { client, gameId, onPublishing } = props
  return (
    <StreamPanel
      key={gameId}
      client={client}
      gameId={gameId}
      onPublishing={onPublishing}
    />
  )
}
