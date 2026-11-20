import React from 'react'
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * A form kept clear of the keyboard on a phone or tablet (Add Player's Add
 * to Roster), able to scroll its last control above it. With the keyboard
 * closed its content clears the home indicator, which the scene leaves to
 * it.
 *
 * The form runs to the bottom of the screen, so the keyboard covers its
 * own height of it: the form gives up that much at its foot, by the height
 * the dock rides on. An avoiding view, keyboard-controller's or React
 * Native's, measures the keyboard's frame against its own, and on an iPad's
 * sheet that came out short, the button left under the keyboard.
 */
export function KeyboardForm({
  style,
  children
}: {
  style: StyleProp<ViewStyle>
  children: React.ReactNode
}): React.ReactElement {
  const insets = useSafeAreaInsets()
  const { height } = useReanimatedKeyboardAnimation()
  // The keyboard's height runs from 0 down to minus its height as it opens.
  const room = useAnimatedStyle(
    () => ({ paddingBottom: -height.value }),
    [height]
  )
  return (
    <Animated.View testID="keyboard-form" style={[{ flex: 1 }, room]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[style, { paddingBottom: insets.bottom + 16 }]}
      >
        {children}
      </ScrollView>
    </Animated.View>
  )
}
