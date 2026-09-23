import React from 'react'
import { View } from 'react-native'

import type { RosterDragProps } from './rosterDragProps'
export function RosterDragGroup({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  return <View>{children}</View>
}
export function RosterDrag({ children }: RosterDragProps): React.ReactElement {
  return <View>{children}</View>
}
