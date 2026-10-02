import React, { useMemo, useRef } from 'react'
import { View } from 'react-native'
import {
  GestureDetector,
  useExclusiveGestures,
  useLongPressGesture,
  useTapGesture
} from 'react-native-gesture-handler'

import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { controlRects, edgeBars, liveRects, type Rect } from './controlGeometry'
import { playerEngine } from './engine'
import { SeekFlashView, SlowMoBadge, useFlash } from './GestureFeedback'
import { slowMotion } from './slowMotion'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import type { VideoHandle } from './videoHandle'
import {
  type GestureAction,
  gestureAction,
  HOLD_MS,
  seekBy,
  STEP_SECONDS,
  type Zone,
  zoneFor
} from './zones'

export interface PlayerSurfaceProps {
  videoRef: React.RefObject<VideoHandle | null>
  width: number
  height: number
  /**
   * Whether the player's own control bar is on screen right now.
   *
   * `true` unless something says otherwise, which keeps a browser exactly as
   * it was: it cannot tell us, and its rectangles are the measured ones.
   */
  controlsVisible?: boolean
  /**
   * False while something else owns the picture and the keyboard.
   *
   * The multi-camera view is a state of the game screen, not a route, so this
   * player is still mounted behind it — and two capture-phase key listeners
   * would both answer an arrow key, seeking a hidden video as well as the one
   * on screen.
   */
  active?: boolean
  children: React.ReactNode
}

/**
 * The nine squares, and the keyboard where there is one.
 *
 * The middle sides move ten seconds a tap, and the right one runs at a quarter
 * speed for as long as it is held; every other square pauses. On a
 * laptop the arrow keys do the same thing, taken in the capture phase because
 * the control bar takes them for itself once the scrubber has focus.
 *
 * A ten-second tap leaves a circular arrow behind it and a held crawl says
 * `Slow Mo 25%` in the corner, so a press that landed by accident still says
 * what it did.
 *
 * **The player's own controls stay, and they win where they are.** Whose they
 * are depends on where this is running — the browser's, AVPlayer's or
 * ExoPlayer's — and `controlGeometry.ts` knows where each of them puts things.
 * This layer is the picture minus the rectangles they occupy, in pieces, so a
 * press on the scrubber or the fullscreen button reaches them untouched. Which
 * piece catches a press makes no difference: the zone is worked out against
 * the whole picture, so the grid is even thirds however it has been cut up.
 */
export function PlayerSurface(props: PlayerSurfaceProps): React.ReactElement {
  const {
    videoRef,
    width,
    height,
    controlsVisible = true,
    active = true,
    children
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const slow = useMemo(() => slowMotion(() => videoRef.current), [videoRef])
  const [speed, setSpeed] = React.useState(0)
  const holding = useRef(false)
  const [flash, showFlash] = useFlash()

  const engine = useMemo(() => playerEngine(), [])
  const pieces = useMemo(
    // A hole is cut for a control, not for where a control sometimes is. The
    // bar fades after a few seconds; while it is gone the whole picture is
    // ours, and on Android that is the difference between the square that
    // runs the film backwards being reachable and being covered up.
    () =>
      controlsVisible
        ? liveRects(width, height, engine)
        : [{ x: 0, y: 0, w: width, h: height }],
    [controlsVisible, engine, height, width]
  )
  // The slow-motion words sit just below whatever the player draws along the
  // top, and in the corner itself once that has faded.
  const topBar = useMemo(
    () =>
      controlsVisible
        ? edgeBars(controlRects(width, height, engine), height).top
        : 0,
    [controlsVisible, engine, height, width]
  )

  /** `play()` returns a promise the caller has no use for, and may reject. */
  const play = (video: VideoHandle): void => {
    video.play().catch(() => undefined)
  }

  const act = (zone: Zone): void => {
    const video = videoRef.current
    if (video == null) return
    if (zone === 'seekBack') {
      seekBy(video, -STEP_SECONDS)
      showFlash('back')
      return
    }
    if (zone === 'seekForward') {
      seekBy(video, STEP_SECONDS)
      showFlash('forward')
      return
    }
    const direction = video.paused ? 'play' : 'pause'
    if (video.paused) play(video)
    else video.pause()
    showFlash(direction)
  }

  const beginSlow = (action: GestureAction | null): void => {
    if (action !== 'slowForward') return
    holding.current = true
    slow.start()
    setSpeed(slow.rate())
  }

  const endSlow = (): void => {
    if (!holding.current) return
    holding.current = false
    slow.stop()
    setSpeed(0)
  }

  // The keyboard, on a platform that has one. Lifted out because React Native
  // defines `global.window` and gives it no `addEventListener`, so binding to
  // it here brought down the one screen the app is for. Silent while the
  // multi-camera view is up: it uses this same hook, and two capture-phase
  // listeners would both answer one arrow key.
  useKeyboardShortcuts({
    enabled: active,
    video: () => videoRef.current,
    act,
    beginSlow,
    endSlow,
    holding: () => holding.current
  })

  return (
    <View style={[styles.surface, { width, height }]}>
      {children}
      {pieces.map(piece => (
        <GesturePiece
          key={`${piece.x}:${piece.y}:${piece.w}:${piece.h}`}
          piece={piece}
          width={width}
          height={height}
          onTap={act}
          onHold={beginSlow}
          onRelease={endSlow}
        />
      ))}
      <SeekFlashView flash={flash} />
      <SlowMoBadge rate={speed} top={topBar + theme.rem(theme.spaceSmRem)} />
    </View>
  )
}

function GesturePiece(props: {
  piece: Rect
  width: number
  height: number
  onTap: (zone: Zone) => void
  onHold: (action: GestureAction | null) => void
  onRelease: () => void
}): React.ReactElement {
  const { piece, width, height, onTap, onHold, onRelease } = props
  const zoneAt = (x: number, y: number): Zone =>
    zoneFor(piece.x + x, piece.y + y, width, height)

  const hold = useLongPressGesture({
    minDuration: HOLD_MS,
    // A finger that travels is a scroll, not a press.
    maxDistance: 10,
    runOnJS: true,
    onActivate: event => {
      onHold(gestureAction(zoneAt(event.x, event.y), 'hold'))
    },
    onFinalize: () => {
      onRelease()
    }
  })
  const tap = useTapGesture({
    maxDuration: HOLD_MS + 100,
    maxDistance: 10,
    runOnJS: true,
    onActivate: event => {
      onTap(zoneAt(event.x, event.y))
    }
  })
  // The hold wins where both could fire, so a press that becomes a hold does
  // not also pause when the finger comes off.
  const gesture = useExclusiveGestures(hold, tap)

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={{
          position: 'absolute',
          left: piece.x,
          top: piece.y,
          width: piece.w,
          height: piece.h
        }}
      />
    </GestureDetector>
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
  }
}))
