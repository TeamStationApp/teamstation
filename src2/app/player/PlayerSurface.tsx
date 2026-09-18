import React, { useEffect, useMemo, useRef } from 'react'
import { Text, View } from 'react-native'
import {
  GestureDetector,
  useExclusiveGestures,
  useLongPressGesture,
  useTapGesture
} from 'react-native-gesture-handler'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { engineOf, liveRects, type Rect } from './controlGeometry'
import { slowMotion } from './slowMotion'
import { seekBy, STEP_SECONDS, type Zone, zoneFor } from './zones'

export interface PlayerSurfaceProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  width: number
  height: number
  children: React.ReactNode
}

/** A press becomes a hold at a quarter of a second. */
const HOLD_MS = 250

/**
 * The nine squares, and the keyboard.
 *
 * The middle sides move ten seconds a tap; the top and bottom middles run at a
 * quarter speed for as long as they are held; every other square pauses. The
 * arrow keys do the same thing, and are taken in the capture phase because the
 * browser's own control bar takes them for itself once the scrubber has focus.
 *
 * The browser's controls stay, and they win where they are: this layer is the
 * picture minus the rectangles they occupy, in pieces, so a press on the
 * scrubber or the fullscreen button reaches them untouched. Which piece catches
 * a press makes no difference — the zone is worked out against the whole
 * picture, so the grid is even thirds however it has been cut up.
 */
export function PlayerSurface(props: PlayerSurfaceProps): React.ReactElement {
  const { videoRef, width, height, children } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const slow = useMemo(() => slowMotion(() => videoRef.current), [videoRef])
  const [speed, setSpeed] = React.useState(0)
  const holding = useRef(false)

  const engine = useMemo(
    () => engineOf(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    []
  )
  const pieces = useMemo(
    () => liveRects(width, height, engine),
    [engine, height, width]
  )

  /** `play()` returns a promise the caller has no use for, and may reject. */
  const play = (video: HTMLVideoElement): void => {
    video.play().catch(() => undefined)
  }

  const act = (zone: Zone): void => {
    const video = videoRef.current
    if (video == null) return
    if (zone === 'seekBack') {
      seekBy(video, -STEP_SECONDS)
      return
    }
    if (zone === 'seekForward') {
      seekBy(video, STEP_SECONDS)
      return
    }
    // Explicit comparisons: the DOM types are not in this project's lib, so
    // `paused` arrives as `any` and the linter rightly refuses to guess.
    if (video.paused === true) play(video)
    else video.pause()
  }

  const beginSlow = (zone: Zone): void => {
    if (zone !== 'slowForward' && zone !== 'slowBack') return
    holding.current = true
    slow.start(zone === 'slowForward' ? 'forward' : 'back')
    setSpeed(slow.rate())
  }

  const endSlow = (): void => {
    if (!holding.current) return
    holding.current = false
    slow.stop()
    setSpeed(0)
  }

  // The keyboard, while this screen is on top. Capture, because the native
  // control bar seeks on arrow keys the moment its scrubber has focus, and a
  // bubble-phase listener arrives after it has already moved.
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      const node = target as HTMLElement | null
      const tag = node?.tagName.toLowerCase()
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        node?.isContentEditable === true
      )
    }
    const down = (event: KeyboardEvent): void => {
      const video = videoRef.current
      if (video == null) return
      if (
        event.ctrlKey === true ||
        event.metaKey === true ||
        event.altKey === true
      ) {
        return
      }
      if (isTyping(event.target)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seekBy(video, -STEP_SECONDS)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        seekBy(video, STEP_SECONDS)
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        if (event.repeat === true || holding.current) return
        beginSlow(event.key === 'ArrowUp' ? 'slowForward' : 'slowBack')
      } else if (event.key === ' ' || event.key === 'k') {
        event.preventDefault()
        act('toggle')
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') endSlow()
    }
    // A key held while the tab changes never delivers its `keyup`.
    const blur = (): void => {
      endSlow()
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      endSlow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef])

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
      {speed !== 0 && (
        <View style={styles.speed} pointerEvents="none">
          <Text style={styles.speedText}>
            {speed < 0 ? '◀ 0.25×' : '0.25×'}
          </Text>
        </View>
      )}
    </View>
  )
}

function GesturePiece(props: {
  piece: Rect
  width: number
  height: number
  onTap: (zone: Zone) => void
  onHold: (zone: Zone) => void
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
      onHold(zoneAt(event.x, event.y))
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
    shadowOffset: { width: 0, height: theme.rem(0.25) }
  },
  speed: {
    position: 'absolute',
    top: theme.rem(theme.spaceSmRem),
    left: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(0, 0, 0, 0.55)'
  },
  speedText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600'
  }
}))
