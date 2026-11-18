import React from 'react'
import { Platform } from 'react-native'
import {
  KeyboardController,
  useReanimatedKeyboardAnimation
} from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'

// A phone-only module, so it takes the phone's owner by name.
import { useKeyboardControllerOwner } from '../components/keyboardControllerOwner.native'
import type { SearchDockProps } from './searchDockTypes'

/**
 * Search's dock on a phone or tablet: its location pills above its field,
 * floating at the bottom, riding the keyboard up and back down on every
 * frame of the keyboard's own animation. Closed it rests `bottom` above the
 * window's foot; open, its lower edge sits `gap` above the keyboard.
 *
 * On Android the keyboard controller is held on while the screen is
 * `active` (on show): only then does the keyboard report its frames rather
 * than resize the window, which every other screen still relies on.
 */
export function SearchDock(props: SearchDockProps): React.ReactElement {
  useKeyboardControllerOwner(props.active)
  const { height, progress } = useReanimatedKeyboardAnimation()
  const opened = props.bottom - props.gap
  const ride = useAnimatedStyle(
    () => ({
      transform: [
        { translateY: dockShift(height.value, progress.value, opened) }
      ]
    }),
    [opened]
  )
  return (
    <Animated.View
      testID="search-dock"
      pointerEvents="box-none"
      style={[props.style, { bottom: props.bottom }, ride]}
      onLayout={props.onLayout}
    >
      {props.children}
    </Animated.View>
  )
}

/**
 * How far the dock rises for a keyboard `height` tall (negative, as
 * keyboard-controller reports it) and `progress` of the way open: by the
 * keyboard, less the room it already stood clear by (`opened`), and never
 * down. A keyboard shorter than that room, such as a hardware keyboard's
 * shortcut bar, leaves the dock where it rests rather than pushing it into
 * the tab bar.
 */
export function dockShift(
  height: number,
  progress: number,
  opened: number
): number {
  'worklet'
  return Math.min(0, height + opened * progress)
}

/**
 * The keyboard's height under the last result, on Android: the window no
 * longer shrinks for it there, so the list needs the room to scroll its last
 * row clear of the raised dock. iOS insets the scroll view by the keyboard
 * itself (`automaticallyAdjustKeyboardInsets` on `Screen`): nothing here.
 */
export function KeyboardSpacer(): React.ReactElement | null {
  return Platform.OS === 'android' ? <AndroidKeyboardSpacer /> : null
}

function AndroidKeyboardSpacer(): React.ReactElement {
  const { height } = useReanimatedKeyboardAnimation()
  // The keyboard's height runs from 0 down to minus its height as it opens.
  const style = useAnimatedStyle(() => ({ height: -height.value }), [height])
  return <Animated.View testID="search-keyboard-spacer" style={style} />
}

/** Puts the keyboard away with its own animation, the dock following it. */
export function dismissKeyboard(): void {
  KeyboardController.dismiss().catch(() => undefined)
}
