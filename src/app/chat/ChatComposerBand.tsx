import React from 'react'
import { View } from 'react-native'

import type { ChatComposerBandProps } from './ChatViewport'

/** Browser layout tracks its visual viewport, including a resized mobile keyboard. */
export function ChatComposerBand({
  viewport,
  active: _active,
  style,
  ...rest
}: ChatComposerBandProps): React.ReactElement {
  return <View {...rest} style={[style, { bottom: viewport.composerBottom }]} />
}
