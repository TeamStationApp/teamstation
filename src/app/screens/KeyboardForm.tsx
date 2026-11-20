import React from 'react'
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native'

/**
 * A form in a browser, which has no keyboard of its own to avoid and pads
 * its safe area itself (`KeyboardForm.native.tsx` is the phone's).
 */
export function KeyboardForm({
  style,
  children
}: {
  style: StyleProp<ViewStyle>
  children: React.ReactNode
}): React.ReactElement {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={style}
    >
      {children}
    </ScrollView>
  )
}
