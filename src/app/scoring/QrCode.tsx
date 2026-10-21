import React from 'react'

import { type QrCodeProps, qrMatrix, QUIET_ZONE } from './lineupQrMatrix'

/** A QR code, black on white, as one path in a DOM `<svg>`. */
export function QrCode({
  text,
  size,
  accessibilityLabel
}: QrCodeProps): React.ReactElement {
  const matrix = React.useMemo(() => qrMatrix(text), [text])
  const box = matrix.size + 2 * QUIET_ZONE
  return (
    <svg
      role="img"
      aria-label={accessibilityLabel}
      data-testid="qrCode"
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      style={{ display: 'block', background: '#ffffff' }}
    >
      <rect width={box} height={box} fill="#ffffff" />
      <path d={matrix.path} fill="#000000" />
    </svg>
  )
}
