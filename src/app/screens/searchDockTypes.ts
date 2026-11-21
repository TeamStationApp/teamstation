import type React from 'react'
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native'

/** What Search hands its dock, on every platform (`SearchDock`). */
export interface SearchDockProps {
  /** Above the window's foot, with the keyboard closed. */
  bottom: number
  /** Between the dock's lower edge and the open keyboard. */
  gap: number
  /** The screen is on show: on Android, the keyboard controller is held. */
  active: boolean
  style: StyleProp<ViewStyle>
  onLayout: (event: LayoutChangeEvent) => void
  children?: React.ReactNode
}
