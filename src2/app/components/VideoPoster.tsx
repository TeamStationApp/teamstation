import React from 'react'
import { Image, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface VideoPosterProps {
  /** A frame of the video. Absent until one has been cut. */
  uri?: string | null
  /** `1:24:10` for a whole video, or where a highlight seeks to. */
  time?: string
  /**
   * Draw the play button. It means *this starts a video*, so a highlight —
   * which only moves the video already on screen — passes false.
   */
  showPlay?: boolean
  onPlay?: () => void
  /** A hero fills a card; a thumb sits at the front of a row. */
  size?: 'hero' | 'thumb'
  /** Laid over the gradient at the bottom left: a score, a title. */
  children?: React.ReactNode
}

/**
 * A frame of a video, with the things that are always drawn on one.
 *
 * The bottom of the picture is darkened with a gradient and the time is set on
 * it in plain white. A pill behind the text was the other option and reads as
 * pasted on; a gradient belongs to the picture, and works over a bright sky
 * and a dark dugout alike.
 *
 * The play button is a dark translucent disc with a white triangle, at the top
 * **left**. Top left keeps it off the duration at the bottom right and off the
 * middle of the frame, which is where the play usually is.
 *
 * The gradient is the one piece of this that is not React Native: there is no
 * gradient primitive, so on the web it is a `View` with a `backgroundImage`.
 * Confining it here means the native port replaces one file.
 */
export function VideoPoster(props: VideoPosterProps): React.ReactElement {
  const {
    uri,
    time,
    showPlay = false,
    onPlay,
    size = 'thumb',
    children
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const hero = size === 'hero'

  return (
    <View style={[styles.frame, hero ? styles.frameHero : styles.frameThumb]}>
      {uri != null && uri !== '' && (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri }}
          style={styles.picture}
        />
      )}

      <View
        // The bottom fifth for a thumbnail, which carries four characters; the
        // bottom third for a hero, which carries two teams and two scores.
        style={[styles.gradient, hero ? styles.gradientHero : undefined]}
        pointerEvents="none"
      />

      {children != null && (
        <View style={[styles.overlay, hero && styles.overlayHero]}>
          {children}
        </View>
      )}

      {time != null && time !== '' && (
        <Text style={[styles.time, hero && styles.timeHero]}>{time}</Text>
      )}

      {showPlay && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Play"
          onPress={() => {
            onPlay?.()
          }}
          style={({ pressed }) => [
            styles.playTarget,
            pressed && styles.pressed
          ]}
        >
          <View style={[styles.disc, hero && styles.discHero]}>
            <View style={[styles.triangle, hero && styles.triangleHero]} />
          </View>
        </Pressable>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  frame: {
    aspectRatio: 16 / 9,
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.videoBackgroundColor,
    overflow: 'hidden'
  },
  frameHero: {
    width: '100%'
  },
  frameThumb: {
    width: theme.rem(7)
  },
  picture: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    resizeMode: 'cover'
  },
  gradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '20%',
    // Web only, and deliberately the only place in the app that says so.
    backgroundImage:
      'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.7) 100%)'
  },
  gradientHero: {
    height: '34%'
  },
  overlay: {
    position: 'absolute',
    left: theme.rem(theme.spaceSmRem),
    right: theme.rem(theme.spaceSmRem),
    bottom: theme.rem(theme.spaceXsRem)
  },
  overlayHero: {
    left: theme.rem(theme.spaceMdRem),
    right: theme.rem(theme.spaceMdRem),
    bottom: theme.rem(theme.spaceSmRem)
  },
  time: {
    position: 'absolute',
    right: theme.rem(theme.spaceXsRem),
    bottom: theme.rem(0.125),
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700'
  },
  timeHero: {
    right: theme.rem(theme.spaceSmRem),
    bottom: theme.rem(theme.spaceXsRem),
    fontSize: theme.rem(0.875)
  },
  playTarget: {
    position: 'absolute',
    left: 0,
    top: 0,
    padding: theme.rem(theme.spaceXsRem),
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'flex-start',
    justifyContent: 'flex-start'
  },
  disc: {
    width: theme.rem(1.75),
    height: theme.rem(1.75),
    borderRadius: theme.radiusPill,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  discHero: {
    width: theme.rem(2.75),
    height: theme.rem(2.75)
  },
  // A triangle out of borders, so there is no glyph to load and no font to
  // wait for before the button looks like a button.
  triangle: {
    width: 0,
    height: 0,
    marginLeft: theme.rem(0.125),
    borderTopWidth: theme.rem(0.375),
    borderBottomWidth: theme.rem(0.375),
    borderLeftWidth: theme.rem(0.625),
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#ffffff',
    borderStyle: 'solid'
  },
  triangleHero: {
    borderTopWidth: theme.rem(0.5625),
    borderBottomWidth: theme.rem(0.5625),
    borderLeftWidth: theme.rem(0.9375)
  },
  pressed: {
    opacity: 0.8
  }
}))
