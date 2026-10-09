import React from 'react'
import { View } from 'react-native'

import type { ChatDropTargetProps } from './chatFileTypes'

/** Native pickers own files; the transparent pane never installs DOM handlers. */
export function ChatDropTarget({
  children
}: ChatDropTargetProps): React.ReactElement {
  return <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
}
