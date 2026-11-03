import React from 'react'

import { CameraAnglesPanel } from './CameraAnglesPanel'
import type { StreamFooterProps } from './streamFooterProps'

export type { StreamFooterProps }

/** Each game and session starts with its own camera list and setup sheets. */
export function StreamFooter(props: StreamFooterProps): React.ReactElement {
  return (
    <CameraAnglesPanel
      key={`${props.gameId}:${props.signedIn !== false}`}
      {...props}
    />
  )
}
