import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type GestureResponderEvent, Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CARD_HIDE_MS, cardSeekTarget } from './cardScrub'
import { seekTo } from './explicitSeek'
import { SlowMoBadge } from './GestureFeedback'
import { clock, getBarStyles, TrackStrips } from './multiCam/barParts'
import type { Rect } from './multiCam/layout'
import { scrubSeeks } from './multiCam/scrubSeeks'
import {
  type ControlGroup,
  type GridZone,
  placeIcons,
  scrubFraction,
  zoneAt,
  zoneGroup
} from './pressGrid'
import {
  PictureScoreboard,
  type PictureScoreboardProps
} from './scoreboardOverlay/ScoreboardOverlay'
import { slowMotion } from './slowMotion'
import { seekableEndOf, type VideoHandle } from './videoHandle'
import { ZoneIcons } from './ZoneIcons'
import { beyondSlop, HOLD_MS, seekBy, STEP_SECONDS } from './zones'

/** How long the bar shows a seek's target before the player's own time. */
const AIM_HOLD_MS = 3000

export interface PlayerSurfaceProps {
  videoRef: React.RefObject<VideoHandle | null>
  /**
   * The same player, as state: the card follows its playing and its place,
   * which a ref cannot say have changed.
   */
  player?: VideoHandle | null
  width: number
  height: number
  /**
   * False while the full-screen player has the screen. It is a state of the
   * game screen, not a route, so this picture is still mounted behind it, and
   * its board would go on asking for steps nobody can see.
   */
  active?: boolean
  /**
   * The game's board over the picture, at the wall time of the frame on
   * screen: the game and the video it is of, whether it is live, and where
   * the picture is in this view. Absent, no board.
   */
  scoreboard?: Omit<PictureScoreboardProps, 'videoRef'>
  /** The top-right square: opens the full-screen player. */
  onOpen?: () => void
  /**
   * False while there is no video to play (loading, unavailable, or one this
   * device can't play): the card then shows no controls and takes no press,
   * bar its way into full screen.
   */
  playable?: boolean
  /** The card is silent until its own sound square turns the sound on. */
  muted?: boolean
  onMutedChange?: (muted: boolean) => void
  children: React.ReactNode
}

/** One finger on the card, from down to up. */
interface Press {
  x0: number
  y0: number
  zone: GridZone
  /** Running while it may still become a hold. */
  timer: ReturnType<typeof setTimeout> | null
  mode: 'pending' | 'held' | 'scrub' | 'dead'
}

/**
 * The event page's video card: the video, its board, and the press grid
 * (`pressGrid.ts`) over it, as in the full-screen player.
 *
 * Four by four squares: sound top left, full screen top right, the two
 * top-centre squares only bringing the controls up, ten seconds back and on
 * two rows tall down the sides (a hold on the right is slow motion for as
 * long as it lasts), play and pause the four in the middle, and the bottom
 * row the scrub line, which seeks to where it is pressed without pausing.
 * A press anywhere in a square runs it, with its icon showing or not.
 *
 * The controls show in two groups, for a second after a press or after the
 * mouse leaves them: every control above the scrub line together, or the
 * scrub line on its own.
 */
export function PlayerSurface(props: PlayerSurfaceProps): React.ReactElement {
  const {
    videoRef,
    player,
    width,
    height,
    active = true,
    scoreboard,
    onOpen,
    playable = true,
    muted = true,
    onMutedChange,
    children
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const bar = getBarStyles(theme)
  const box = useMemo(
    () => ({ x: 0, y: 0, w: width, h: height }),
    [width, height]
  )

  // What the card shows of its player: playing or not, where it is, and how
  // long the video is (live, as far as it can be sought), in seconds.
  const [playing, setPlaying] = useState(false)
  const [place, setPlace] = useState({ at: 0, length: 0 })
  // Where the finger has asked the video to be, in seconds: the bar shows it
  // while a drag is in hand and until the player says it is there, so the
  // time and the playhead follow the finger rather than the throttled seeks.
  const [aimed, setAimed] = useState<number | null>(null)
  const aiming = useRef<{ at: number | null; dragging: boolean }>({
    at: null,
    dragging: false
  })
  const aimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aimAt = (at: number | null, dragging: boolean): void => {
    aiming.current = { at, dragging }
    setAimed(at)
    if (aimTimer.current != null) clearTimeout(aimTimer.current)
    aimTimer.current = null
    // A seek the player never says it finished does not hold the bar.
    if (at != null && !dragging)
      aimTimer.current = setTimeout(() => {
        aimTimer.current = null
        aiming.current = { at: null, dragging: false }
        setAimed(null)
      }, AIM_HOLD_MS)
  }
  useEffect(
    () => () => {
      if (aimTimer.current != null) clearTimeout(aimTimer.current)
    },
    []
  )
  useEffect(() => {
    // A target is the last player's: a new one, or none, starts clear.
    if (aimTimer.current != null) clearTimeout(aimTimer.current)
    aimTimer.current = null
    aiming.current = { at: null, dragging: false }
    setAimed(null)
    if (player == null) {
      // No player, nothing to say: not the last one's time and length.
      setPlaying(false)
      setPlace({ at: 0, length: 0 })
      return
    }
    const read = (): void => {
      setPlaying(!player.paused)
      // The player has got to where the finger left it.
      const { at, dragging } = aiming.current
      if (at != null && !dragging && Math.abs(player.currentTime - at) < 0.5) {
        aiming.current = { at: null, dragging: false }
        setAimed(null)
      }
      const length = Number.isFinite(player.duration)
        ? player.duration
        : (seekableEndOf(player) ?? 0)
      setPlace({
        at: Math.max(0, Math.min(player.currentTime, length)),
        length: Math.max(0, length)
      })
    }
    read()
    const events = [
      'play',
      'pause',
      'timeupdate',
      'seeked',
      'durationchange'
    ] as const
    for (const name of events) player.addEventListener(name, read)
    return () => {
      for (const name of events) player.removeEventListener(name, read)
    }
  }, [player])

  // The two groups, each up for a second after whatever called it.
  const [shown, setShown] = useState<ControlGroup | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((group: ControlGroup, forMs = CARD_HIDE_MS) => {
    setShown(group)
    if (hideTimer.current != null) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      setShown(null)
    }, forMs)
  }, [])
  /** Up for as long as the mouse is over the group, then a second more. */
  const hover = useCallback((group: ControlGroup) => {
    if (hideTimer.current != null) clearTimeout(hideTimer.current)
    hideTimer.current = null
    setShown(group)
  }, [])
  useEffect(
    () => () => {
      if (hideTimer.current != null) clearTimeout(hideTimer.current)
    },
    []
  )

  // Where the board is drawn, which the icons keep clear of.
  const [board, setBoard] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // The controls group's icons: the sound and full screen in the top
  // corners, over the board while they show, and the rest clear of it. Drawn
  // there, and pressed there while they show.
  const iconSize = theme.rem(2.25)
  const icons = placeIcons(
    box,
    iconSize,
    // Only a board that is drawn: gone, it has nothing to keep clear of.
    [scoreboard != null && active ? board : null],
    theme.rem(theme.spaceXsRem),
    true,
    {
      x: theme.rem(theme.spaceSmRem) + iconSize / 2,
      y: theme.rem(theme.spaceSmRem) + iconSize / 2
    }
  )

  const crawl = useMemo(() => slowMotion(() => videoRef.current), [videoRef])
  const [slow, setSlow] = useState(0)

  // Where the bar's track is drawn in the card, so a press on the bottom row
  // lands where the finger is on it, as the full-screen bar's does.
  const track = useRef<Rect | null>(null)

  /** Seconds into the video for a point of the bottom row; null unknown. */
  const scrubTarget = (x: number): number | null => {
    const video = videoRef.current
    if (video == null) return null
    const along =
      track.current != null && track.current.w > 0
        ? scrubFraction(x, track.current)
        : x / Math.max(1, width)
    return cardSeekTarget(along, {
      duration: video.duration,
      seekableEnd: seekableEndOf(video)
    })
  }
  // A drag's seeks, at most four a second and always where the finger
  // lifts, as the full-screen bar's: a seek a move stutters a player.
  const seeks = useMemo(
    () =>
      scrubSeeks(sec => {
        const video = videoRef.current
        if (video != null) seekTo(video, sec)
      }),
    [videoRef]
  )
  useEffect(
    () => () => {
      seeks.cancel()
    },
    [seeks]
  )
  const scrubTo = (x: number, final = true): void => {
    const to = scrubTarget(x)
    if (to == null) return
    aimAt(to, !final)
    if (final) seeks.end(to)
    else seeks.move(to)
  }

  /** What a tap in a square does. */
  const run = (zone: GridZone, x: number): void => {
    show(zoneGroup(zone))
    const video = videoRef.current
    if (zone === 'scrub') {
      scrubTo(x)
      return
    }
    if (zone === 'audio') {
      // Inside the touch, the one moment iOS lets the sound back on.
      if (video != null) video.muted = !muted
      onMutedChange?.(!muted)
      return
    }
    if (zone === 'corner') {
      onOpen?.()
      return
    }
    if (video == null || zone === 'reveal') return
    if (zone === 'seekBack' || zone === 'seekForward') {
      seekBy(video, zone === 'seekBack' ? -STEP_SECONDS : STEP_SECONDS)
      return
    }
    if (video.paused) video.play().catch(() => undefined)
    else video.pause()
  }

  const press = useRef<Press | null>(null)
  const settle = (state: Press): void => {
    if (state.timer != null) clearTimeout(state.timer)
    state.timer = null
  }
  const onGrant = (event: GestureResponderEvent): void => {
    const { locationX, locationY } = event.nativeEvent
    const state: Press = {
      x0: locationX,
      y0: locationY,
      zone: zoneAt(
        locationX,
        locationY,
        box,
        shown === 'controls' ? icons : null
      ),
      timer: null,
      mode: 'pending'
    }
    // Held still on fast forward: slow motion until the finger lifts.
    if (state.zone === 'seekForward')
      state.timer = setTimeout(() => {
        state.timer = null
        if (press.current !== state || state.mode !== 'pending') return
        state.mode = 'held'
        crawl.start()
        setSlow(crawl.rate())
        show('controls')
      }, HOLD_MS)
    press.current = state
  }
  const onMove = (event: GestureResponderEvent): void => {
    const state = press.current
    if (state == null) return
    const { locationX, locationY } = event.nativeEvent
    const dx = locationX - state.x0
    const dy = locationY - state.y0
    if (state.mode === 'pending' && beyondSlop(dx, dy)) {
      settle(state)
      state.mode =
        state.zone === 'scrub' && Math.abs(dx) > Math.abs(dy) ? 'scrub' : 'dead'
    }
    if (state.mode !== 'scrub') return
    show('scrub')
    scrubTo(locationX, false)
  }
  const onEnd = (event: GestureResponderEvent | null): void => {
    const state = press.current
    press.current = null
    if (state == null) return
    settle(state)
    if (state.mode === 'held') {
      crawl.stop()
      setSlow(0)
    }
    if (state.mode === 'scrub') {
      show('scrub')
      if (event != null) scrubTo(event.nativeEvent.locationX)
      // Taken away mid-drag: the drag's last seek stands, as it is shown.
      else aimAt(aiming.current.at, false)
    }
    if (state.mode === 'pending' && event != null)
      run(state.zone, event.nativeEvent.locationX)
  }

  return (
    <View style={[styles.surface, { width, height }]}>
      {children}
      {scoreboard != null && active ? (
        <PictureScoreboard
          {...scoreboard}
          videoRef={videoRef}
          onPlaced={setBoard}
        />
      ) : null}
      {/* Every press on the picture, and the mouse over it. */}
      {playable ? (
        <View
          testID="gameVideoZones"
          style={styles.layer}
          onStartShouldSetResponder={() => true}
          onResponderTerminationRequest={() =>
            press.current == null || press.current.mode === 'pending'
          }
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onEnd}
          onResponderTerminate={() => {
            onEnd(null)
          }}
          onPointerMove={event => {
            // A mouse with a button held is dragging: the press's, not a hover.
            if (
              event.nativeEvent.pointerType !== 'mouse' ||
              event.nativeEvent.buttons !== 0
            )
              return
            const { offsetX, offsetY } = event.nativeEvent
            hover(
              zoneGroup(
                zoneAt(
                  offsetX,
                  offsetY,
                  box,
                  shown === 'controls' ? icons : null
                )
              )
            )
          }}
          onPointerLeave={() => {
            if (shown != null) show(shown)
          }}
        />
      ) : null}
      <ZoneIcons
        icons={icons}
        visible={playable && shown === 'controls'}
        playing={playing}
        soundOff={muted}
        corner={onOpen != null ? 'fullscreen' : undefined}
      />
      {/* The scrub line, on its own: the full-screen player's bar, with
          where the video is on the left and its length on the right. */}
      <View
        testID="gameVideoScrubLine"
        pointerEvents="none"
        style={[
          bar.bar,
          styles.scrubLine,
          { opacity: playable && shown === 'scrub' ? 1 : 0 }
        ]}
      >
        <Text style={bar.time}>{clock((aimed ?? place.at) * 1000)}</Text>
        <View
          style={styles.track}
          onLayout={event => {
            const { x, y, width: w, height: h } = event.nativeEvent.layout
            track.current = { x, y, w, h }
          }}
        >
          {/* The full-screen bar's strips: the card has one video, so one
              strip the whole length, where the grid draws one per camera. */}
          <TrackStrips
            take={{ fromMs: 0, toMs: Math.max(1, place.length * 1000) }}
            atMs={(aimed ?? place.at) * 1000}
            angles={[
              { id: 'video', name: '', fromMs: 0, toMs: place.length * 1000 }
            ]}
          />
        </View>
        <Text style={bar.time}>{clock(place.length * 1000)}</Text>
      </View>
      {/* Top right, stepped left of the full-screen icon while it shows. */}
      <SlowMoBadge
        rate={slow}
        right={
          theme.rem(theme.spaceSmRem) +
          (shown === 'controls' && onOpen != null
            ? iconSize + theme.rem(theme.spaceXsRem)
            : 0)
        }
      />
      {onOpen != null ? (
        // The top-right square is its own button, so the way into full
        // screen is one a screen reader, a test or a finger finds by name.
        <Pressable
          testID="gameVideoOpen"
          accessibilityRole="button"
          accessibilityLabel={lstrings.game_video_open}
          onPress={() => {
            show('controls')
            onOpen()
          }}
          style={[
            styles.corner,
            { left: (width * 3) / 4, width: width / 4, height: height / 4 }
          ]}
        />
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  surface: {
    position: 'relative',
    backgroundColor: '#000000',
    overflow: 'hidden',
    borderRadius: theme.rem(theme.radiusRem),
    // The highlights run under the picture while it is pegged, so it needs to
    // read as being above them rather than as a hole they vanish into.
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.75),
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    elevation: elevationFor(theme.rem(0.75))
  },
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 4
  },
  corner: {
    position: 'absolute',
    top: 0,
    zIndex: 6
  },
  // Across the bottom of the picture, as the bottom row is.
  scrubLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5
  },
  track: {
    flex: 1,
    height: theme.rem(1.5)
  }
}))
