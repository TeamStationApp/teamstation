import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Platform, Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * One tap to show: a ten-second jump, or the play or pause it just caused.
 * The count makes two in a row both show.
 */
export interface SeekFlash {
  direction: 'back' | 'forward' | 'play' | 'pause'
  id: number
}

/**
 * The flash to draw, and a way to show the next one.
 *
 * Each call counts one past the last, so a second tap in the same direction
 * is a new flash and fades in again rather than being taken for the one
 * already on screen.
 */
export function useFlash(): [
  SeekFlash | null,
  (direction: SeekFlash['direction']) => void
] {
  const [flash, setFlash] = useState<SeekFlash | null>(null)
  const show = useCallback((direction: SeekFlash['direction']): void => {
    setFlash(last => ({ direction, id: (last?.id ?? 0) + 1 }))
  }, [])
  return [flash, show]
}

const FLASH_ICONS = {
  back: 'replay_10',
  forward: 'forward_10'
} as const

/** The white of every glyph: nearly opaque, so it reads over any picture. */
const GLYPH = 'rgba(255, 255, 255, 0.9)'

/** Where each one is drawn: the third of the picture that was tapped. */
const FLASH_LEFT = {
  back: '0%',
  play: '33.333%',
  pause: '33.333%',
  forward: '66.667%'
} as const

/** How long the arrow takes to fade away. */
const FLASH_MS = 1000

/**
 * What a tap on the picture just did, drawn over it for a second.
 *
 * A tap on the side of the picture moves it and nothing else changes on
 * screen — the picture jumps, which looks exactly like a tap that landed by
 * accident and did something nobody can name. So the jump says what it was:
 * clockwise for forwards, anticlockwise for back, with the ten in the middle.
 * A tap that plays or pauses shows the play or the pause it caused, in the
 * middle. A white glyph in a grey translucent circle, in the third of the
 * picture that was tapped, fading out over a second.
 */
export function SeekFlashView(props: {
  flash: SeekFlash | null
}): React.ReactElement | null {
  const { flash } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (flash == null) return
    opacity.setValue(1)
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: FLASH_MS,
      // The web has no native driver, and says so on every tap if asked.
      useNativeDriver: Platform.OS !== 'web'
    })
    fade.start()
    return () => {
      fade.stop()
    }
  }, [flash, opacity])

  if (flash == null) return null
  return (
    <View
      pointerEvents="none"
      style={[styles.flashThird, { left: FLASH_LEFT[flash.direction] }]}
    >
      <Animated.View style={[styles.flashCircle, { opacity }]}>
        {/* Play and pause are drawn, not set: the icon font is the outlined
            style, and these two are meant to be solid. */}
        {flash.direction === 'play' ? (
          <View style={styles.playGlyph} />
        ) : flash.direction === 'pause' ? (
          <View style={styles.pauseGlyph}>
            <View style={styles.pauseBar} />
            <View style={styles.pauseBar} />
          </View>
        ) : (
          <Icon name={FLASH_ICONS[flash.direction]} size={2.5} color={GLYPH} />
        )}
      </Animated.View>
    </View>
  )
}

/**
 * `Slow Mo 25%`, in the bottom right corner, for as long as a crawl is held.
 *
 * `bottom` lifts it clear of whatever control bar is showing, so the words do
 * not sit on the buttons.
 */
export function SlowMoBadge(props: {
  rate: number
  bottom?: number
}): React.ReactElement | null {
  const { rate, bottom } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  if (rate === 0) return null
  return (
    <View
      pointerEvents="none"
      style={[styles.slowMo, bottom != null ? { bottom } : null]}
    >
      <Text style={styles.slowMoText}>
        {rate < 0 ? lstrings.player_slow_mo_back : lstrings.player_slow_mo}
      </Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  flashThird: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '33.333%',
    // Above the pictures and the gesture layer both, which stack explicitly
    // on the multi-camera view.
    zIndex: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  flashCircle: {
    width: theme.rem(4.5),
    height: theme.rem(4.5),
    borderRadius: theme.rem(2.25),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(90, 90, 90, 0.55)'
  },
  // A triangle out of borders, nudged right so its weight sits in the
  // middle of the circle rather than its bounding box.
  playGlyph: {
    width: 0,
    height: 0,
    marginLeft: theme.rem(0.3),
    borderTopWidth: theme.rem(0.9),
    borderBottomWidth: theme.rem(0.9),
    borderLeftWidth: theme.rem(1.5),
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: GLYPH
  },
  pauseGlyph: {
    flexDirection: 'row',
    gap: theme.rem(0.4)
  },
  pauseBar: {
    width: theme.rem(0.5),
    height: theme.rem(1.75),
    borderRadius: theme.rem(0.1),
    backgroundColor: GLYPH
  },
  slowMo: {
    position: 'absolute',
    right: theme.rem(theme.spaceSmRem),
    bottom: theme.rem(theme.spaceSmRem),
    zIndex: 6,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(0, 0, 0, 0.55)'
  },
  slowMoText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600'
  }
}))
