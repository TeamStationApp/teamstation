import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'

import { attachHls } from '../player/attachHls'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon } from './Icon'

export interface VideoPosterProps {
  /** A frame of the video. Absent until one has been cut. */
  uri?: string | null
  /**
   * Play the video itself in the frame, silently.
   *
   * The home card does this: the game is already on screen, so it moves.
   * Muted because a browser will refuse an unmuted autoplay without a gesture,
   * and because a page that starts talking the moment it loads is rude — the
   * sound is what `Watch Replay` is for.
   */
  videoUrl?: string | null
  /** The player has stopped trying; the URL is the thing left to doubt. */
  onVideoGone?: () => void
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
  /** How wide a thumb is, in rem. Narrower on a phone, where words are short. */
  width?: number
  /**
   * Take the height of the row and let the width follow from 16:9.
   *
   * A thumbnail sized by its width leaves the rest of the row's height empty
   * beside it, which is what made these look small for the tiles they sit in.
   * Sized by the height, the picture fills the row and the margins above and
   * below it are the row's own padding.
   */
  fillHeight?: boolean
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
    videoUrl,
    onVideoGone,
    time,
    showPlay = false,
    onPlay,
    size = 'thumb',
    width,
    fillHeight = false,
    children
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const hero = size === 'hero'
  const hasPicture = uri != null && uri !== ''
  const [moving, setMoving] = useState(false)
  const teardown = useRef<(() => void) | undefined>(undefined)

  // The poster stays underneath until there are frames to cover it, so the
  // card never flashes empty while the first segment loads.
  const playInFrame = useCallback(
    (element: HTMLVideoElement | null): void => {
      if (element == null || videoUrl == null || videoUrl === '') return
      const detach = attachHls(element, videoUrl, onVideoGone)
      const start = (): void => {
        if (element.paused !== true) return
        setMoving(true)
        element.play().catch(() => {
          // Refused even muted. The poster is already there, so there is
          // nothing to say and nothing to put right.
          setMoving(false)
        })
      }
      // `canplay` rather than `loadeddata` once, because a live game watched
      // from a card is watched through whatever the network does to it: a
      // stall pauses the element, and nothing here would ever start it again.
      // There are no controls on this one, so there is no one to overrule.
      element.addEventListener('canplay', start)
      element.addEventListener('loadeddata', start)
      teardown.current = () => {
        element.removeEventListener('canplay', start)
        element.removeEventListener('loadeddata', start)
        detach()
      }
    },
    [videoUrl, onVideoGone]
  )
  useEffect(() => {
    return () => teardown.current?.()
  }, [])

  return (
    <View
      style={[
        styles.frame,
        hero ? styles.frameHero : styles.frameThumb,
        !hero && fillHeight ? styles.frameFill : undefined,
        !hero && !fillHeight && width != null
          ? { width: theme.rem(width) }
          : undefined
      ]}
    >
      {hasPicture ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri }}
          style={styles.picture}
        />
      ) : (
        // A game with no video still gets a row, and the dark video colour
        // with nothing on it is a black slab that reads as a failed image.
        // A pale tile with a quiet film mark says *there is no video here*.
        <View style={styles.blank}>
          <Icon name="videocam" color={theme.secondaryTextColor} />
        </View>
      )}

      {videoUrl != null && videoUrl !== '' && (
        // After the poster so it covers it, and before the gradient and the
        // score so those stay on top of both. Clipped to the card's rounded
        // corners by the frame's `overflow: hidden`, exactly like the picture
        // it replaces.
        //
        // Web only, like the gradient below and for the same reason: there is
        // no React Native video primitive here, and the browser's own player
        // is what decodes HEVC.
        <video
          ref={playInFrame}
          muted
          playsInline
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            // Faded in only once there are frames, so the card never flashes
            // empty over the poster while the first segment loads.
            opacity: moving ? 1 : 0
          }}
        />
      )}

      {(hasPicture || moving) && (
        <View
          // The bottom fifth for a thumbnail, which carries four characters;
          // the bottom third for a hero, which carries two teams and two
          // scores.
          style={[styles.gradient, hero ? styles.gradientHero : undefined]}
          pointerEvents="none"
        />
      )}

      {children != null && (
        <View style={[styles.overlay, hero && styles.overlayHero]}>
          {children}
        </View>
      )}

      {time != null && time !== '' && (
        <Text style={[styles.time, hero && styles.timeHero]}>{time}</Text>
      )}

      {showPlay && !moving && (
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
  frameFill: {
    // The width follows from `aspectRatio`, which is on `frame`.
    height: '100%',
    alignSelf: 'stretch'
  },
  frameHero: {
    width: '100%'
  },
  frameThumb: {
    width: theme.rem(7)
  },
  blank: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
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
