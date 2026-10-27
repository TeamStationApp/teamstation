import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { Image, Pressable, Text, View } from 'react-native'

import { attachHls } from '../player/attachHls'
import type { VideoHandle } from '../player/videoHandle'
import { VideoView } from '../player/VideoView'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Gradient } from './Gradient'
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
  /**
   * The video is streaming now. It then plays as every live viewer does,
   * `LIVE_DELAY_SEC` behind its newest footage, and is brought back there if
   * the network stalls it, rather than from wherever its playlist begins:
   * Safari and the phones open a live game's playlist at its start.
   */
  live?: boolean
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
  /** 16:9 for a hero or a highlight. 4:3 for a list row, which then grows taller. */
  aspect?: '16:9' | '4:3'
  /**
   * The frame's width in pixels. The height is that width at 4:3.
   *
   * Not `width`: that prop is a rem count (`theme.rem(width)`). A list row
   * already knows its text height in pixels and passes the frame here.
   */
  frameWidth?: number
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
 * Center-crop the picture on the web, including an image inserted after paint.
 *
 * A React Native host node is an `HTMLElement` and has no CSS `style`. Writing
 * `objectFit` there throws, and React Native treats that throw as fatal. The
 * native picture already crops with `resizeMode`.
 */
export function applyCoverCrop(root: unknown): (() => void) | undefined {
  interface CropNode {
    style: { objectFit?: string; objectPosition?: string }
    children: Iterable<unknown>
  }
  const browser = globalThis as unknown as {
    HTMLElement?: new () => CropNode
    MutationObserver?: new (callback: () => void) => {
      observe: (
        node: CropNode,
        options: { childList: boolean; subtree: boolean }
      ) => void
      disconnect: () => void
    }
  }
  const Host = browser.HTMLElement
  if (Host == null || !(root instanceof Host) || root.style == null) return
  const paint = (node: CropNode): void => {
    if (node.style != null) {
      node.style.objectFit = 'cover'
      node.style.objectPosition = 'center'
    }
    for (const child of node.children) {
      if (child instanceof Host) paint(child)
    }
  }
  paint(root)
  const Observer = browser.MutationObserver
  if (Observer == null) return
  const observer = new Observer(() => {
    paint(root)
  })
  observer.observe(root, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
  }
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
 * The two pieces that are not plain React Native — the picture itself and the
 * gradient over it — are each behind a component with a platform sibling, so
 * this file says the same thing on a page and on a handset.
 */
export function VideoPoster(props: VideoPosterProps): React.ReactElement {
  const {
    uri,
    videoUrl,
    live = false,
    onVideoGone,
    time,
    showPlay = false,
    onPlay,
    size = 'thumb',
    width,
    aspect = '16:9',
    frameWidth,
    fillHeight = false,
    children
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const hero = size === 'hero'
  const hasPicture = uri != null && uri !== ''
  const frameRef = useRef<React.ComponentRef<typeof View>>(null)
  const [moving, setMoving] = useState(false)
  const teardown = useRef<(() => void) | undefined>(undefined)
  // Asked when its playlist ends, so a game that has finished is let go.
  const liveNow = useRef(live)
  liveNow.current = live
  // Whether this address has been live while shown: set once it turns live,
  // and only cleared by a new address. The player is attached again when a
  // card turns live, to join as a live viewer, but not when its game ends:
  // attached again then, it opened the finished playlist at its start.
  const wasLive = useRef<{ url: string | null | undefined; live: boolean }>({
    url: videoUrl,
    live
  })
  if (wasLive.current.url !== videoUrl)
    wasLive.current = { url: videoUrl, live }
  else if (live) wasLive.current.live = true
  const joinedLive = wasLive.current.live
  // Read when it is called, so a new function each render does not tear the
  // player down and start it again.
  const goneNow = useRef(onVideoGone)
  goneNow.current = onVideoGone

  // The poster stays underneath until there are frames to cover it, so the
  // card never flashes empty while the first segment loads.
  const takeVideo = useCallback(
    (video: VideoHandle | null): void => {
      // Whatever the last one left behind goes first, whether this is a new
      // player or none at all.
      teardown.current?.()
      teardown.current = undefined
      if (video == null || videoUrl == null || videoUrl === '') return

      const detach = attachHls(
        video,
        videoUrl,
        () => {
          goneNow.current?.()
        },
        joinedLive
          ? {
              wantsToPlay: () => true,
              isLive: () => liveNow.current,
              preview: true
            }
          : undefined
      )
      const start = (): void => {
        if (!video.paused) return
        setMoving(true)
        video.play().catch(() => {
          // Refused even muted. The poster is already there, so there is
          // nothing to say and nothing to put right.
          setMoving(false)
        })
      }
      // `canplay` rather than `loadeddata` once, because a live game watched
      // from a card is watched through whatever the network does to it: a
      // stall pauses the player, and nothing here would ever start it again.
      // There are no controls on this one, so there is no one to overrule.
      video.addEventListener('canplay', start)
      video.addEventListener('loadeddata', start)
      // Safari loads only what a video is until something asks it to play, so
      // `canplay` never comes and the card sat on its poster for good. Asked
      // as soon as it knows what it is, and shown once it is moving.
      const ask = (): void => {
        if (!video.paused) return
        video.play().catch(() => undefined)
      }
      const shown = (): void => {
        setMoving(true)
      }
      video.addEventListener('loadedmetadata', ask)
      video.addEventListener('playing', shown)
      teardown.current = () => {
        video.removeEventListener('canplay', start)
        video.removeEventListener('loadeddata', start)
        video.removeEventListener('loadedmetadata', ask)
        video.removeEventListener('playing', shown)
        detach()
      }
    },
    // Attached again when the card turns live, so it joins as a live viewer;
    // a stream that has ended is let go by `isLive`, which reads the ref.
    [videoUrl, joinedLive]
  )
  useEffect(() => {
    return () => teardown.current?.()
  }, [])

  // The picture is a center crop. On the web that image is added after the
  // first paint, so the fit is applied then as well as now.
  useLayoutEffect(() => {
    return applyCoverCrop(frameRef.current)
  }, [uri, hasPicture])

  return (
    <View
      ref={frameRef}
      style={[
        styles.frame,
        aspect === '4:3' ? { aspectRatio: 4 / 3 } : undefined,
        hero ? styles.frameHero : styles.frameThumb,
        !hero && fillHeight ? styles.frameFill : undefined,
        !hero && !fillHeight && width != null
          ? { width: theme.rem(width) }
          : undefined,
        !hero && frameWidth != null
          ? {
              width: frameWidth,
              height: frameWidth * (3 / 4),
              aspectRatio: 4 / 3
            }
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
        <VideoView
          source={videoUrl}
          onHandle={takeVideo}
          muted
          live={live}
          resizeMode="cover"
          // Faded in only once there are frames, so the card never flashes
          // empty over the poster while the first segment loads.
          opacity={moving ? 1 : 0}
        />
      )}

      {(hasPicture || moving) && (
        <Gradient
          // The bottom fifth for a thumbnail, which carries four characters;
          // the bottom third for a hero, which carries two teams and two
          // scores.
          style={[styles.gradient, hero ? styles.gradientHero : undefined]}
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

      {showPlay && !moving && onPlay == null ? (
        <View style={styles.playTarget}>
          <View style={[styles.disc, hero && styles.discHero]}>
            <View style={[styles.triangle, hero && styles.triangleHero]} />
          </View>
        </View>
      ) : showPlay && !moving ? (
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
      ) : null}
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
    height: '20%'
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
