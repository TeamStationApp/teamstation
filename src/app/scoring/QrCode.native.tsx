import React from 'react'
import Svg, { Path, Rect } from 'react-native-svg'

import { type QrCodeProps, qrMatrix, QUIET_ZONE } from './lineupQrMatrix'

/** A QR code, black on white, as one path in a native `Svg`. */
export function QrCode({
  text,
  size,
  accessibilityLabel
}: QrCodeProps): React.ReactElement {
  const matrix = React.useMemo(() => qrMatrix(text), [text])
  const box = matrix.size + 2 * QUIET_ZONE
  return (
    <Svg
      testID="qrCode"
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
    >
      <Rect width={box} height={box} fill="#ffffff" />
      <Path d={matrix.path} fill="#000000" />
    </Svg>
  )
}
