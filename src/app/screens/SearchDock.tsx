import React from 'react'
import { Keyboard, View } from 'react-native'

import type { SearchDockProps } from './searchDockTypes'

/**
 * Search's dock where there is no keyboard to ride (`SearchDock.native.tsx`
 * is the phone's): its pills above its field, floating `bottom` above the
 * window's foot. A browser puts the field at the top instead and never
 * draws this.
 */
export function SearchDock(props: SearchDockProps): React.ReactElement {
  return (
    <View
      testID="search-dock"
      pointerEvents="box-none"
      style={[props.style, { bottom: props.bottom }]}
      onLayout={props.onLayout}
    >
      {props.children}
    </View>
  )
}

/** No keyboard to make room for. */
export function KeyboardSpacer(): React.ReactElement | null {
  return null
}

/** Puts away whatever keyboard there is. */
export function dismissKeyboard(): void {
  Keyboard.dismiss()
}
