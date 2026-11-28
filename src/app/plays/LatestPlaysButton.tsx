import React, { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, View } from 'react-native'

import { ButtonIcon } from '../components'
import { GlassView } from '../components/GlassView'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'

/** The button's side, in points. */
const SIZE = 48
/** How long it takes to fade in or out. */
export const LATEST_FADE_MS = 200

/**
 * The round glass button that takes a viewer who scrolled up on a game's
 * live Plays back to the newest play: a chevron pointing down, at the bottom
 * right, `bottom` above the screen's foot. It fades in when `shown` and out
 * when not, and while hidden it is not there to tap.
 */
export function LatestPlaysButton(props: {
  shown: boolean
  bottom: number
  right: number
  onPress: () => void
}): React.ReactElement | null {
  const { shown } = props
  const theme = useTheme()
  const opacity = useRef(new Animated.Value(shown ? 1 : 0)).current
  // Held mounted while it fades out, then gone.
  const [present, setPresent] = useState(shown)
  useEffect(() => {
    if (shown) setPresent(true)
    const fade = Animated.timing(opacity, {
      toValue: shown ? 1 : 0,
      duration: LATEST_FADE_MS,
      useNativeDriver: Platform.OS !== 'web'
    })
    fade.start(({ finished }) => {
      if (finished && !shown) setPresent(false)
    })
    return () => {
      fade.stop()
    }
  }, [shown, opacity])
  if (!present) return null
  return (
    <Animated.View
      pointerEvents={shown ? 'box-none' : 'none'}
      style={{
        position: 'absolute',
        right: props.right,
        bottom: props.bottom,
        zIndex: 3,
        opacity
      }}
    >
      <GlassView
        radius={SIZE / 2}
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          // Edged and lifted, so it reads as a button over the stream's own
          // chevrons rather than one of them.
          borderWidth: 1,
          borderColor: theme.defaultBorderColor,
          boxShadow: '0px 2px 10px rgba(0, 0, 0, 0.2)'
        }}
      >
        <Pressable
          testID="plays-latest"
          accessibilityRole="button"
          accessibilityLabel={lstrings.plays_latest}
          onPress={props.onPress}
          style={{
            width: SIZE,
            height: SIZE,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <View style={{ transform: [{ rotate: '90deg' }] }}>
            <ButtonIcon name="chevron_right" color={theme.primaryTextColor} />
          </View>
        </Pressable>
      </GlassView>
    </Animated.View>
  )
}
