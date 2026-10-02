import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  type GestureResponderEvent,
  LayoutAnimation,
  Modal,
  NativeModules,
  Platform,
  StatusBar,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attachHls } from './attachHls'
import { SeekFlashView, SlowMoBadge } from './GestureFeedback'
import { ExitButton, exitClearance } from './multiCam/barParts'
import { TILE_BUFFER } from './multiCam/buffering'
import type { Rect } from './multiCam/layout'
import {
  type NativeOrientation,
  orientationLock
} from './multiCam/orientationLock'
import {
  beyondSlop,
  type MultiCamProps,
  REORDER_HOLD_MS,
  type TileDrag,
  type TileHandle,
  useMultiCam
} from './multiCam/useMultiCam'
import { MultiCamBar } from './MultiCamBar'
import type { VideoHandle } from './videoHandle'
import { VideoView } from './VideoView'

export type MultiCamViewProps = MultiCamProps

/** One finger on the grid, from down to up, as the phone sees it. */
interface Touch {
  id: number
  /** Where it came down, in the grid's own box. */
  x: number
  y: number
  /** Where it came down on the screen, which moves are measured from. */
  pageX: number
  pageY: number
  /** The tile it came down on, which a held finger can pick up. */
  tile: number | null
  timer: ReturnType<typeof setTimeout> | null
  armed: boolean
}

/** Android's `TSOrientation`, which iOS has no need of. */
const rotation = orientationLock(
  Platform.OS,
  NativeModules.TSOrientation as NativeOrientation | undefined
)

function shuffle(): void {
  LayoutAnimation.configureNext(
    LayoutAnimation.create(200, 'easeInEaseOut', 'opacity')
  )
}

/** Which tile, if any, a point in the grid's box is on. */
function tileAt(rects: Rect[], x: number, y: number): number | null {
  const index = rects.findIndex(
    rect =>
      x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  )
  return index < 0 ? null : index
}

/**
 * Four angles of one game, playing together, on a phone.
 *
 * Everything the grid decides is `useMultiCam`, the same as in a browser;
 * this file draws it with the phone's own players. Full screen as a `Modal`,
 * which a phone draws over everything — the header, the tabs and the status
 * bar included — and whose Android Back closes it. It turns with the phone,
 * the one screen of the app that does: upright the angles are stacked one
 * above another, sideways they are a two-by-two grid, laid out for the
 * screen inside its safe area either way.
 *
 * One layer over the tiles takes every touch: a tap is one of the nine
 * squares, a press held on the +10 s square crawls, and a press held a second
 * on a tile picks the tile up: in a column the others slide out of its way
 * and it is put where it is let go, in a grid it swaps with the one it is
 * dropped on — the browser's rules, through the same calls.
 */
export function MultiCamView(props: MultiCamViewProps): React.ReactElement {
  const { onClose } = props
  return (
    <Modal
      visible
      animationType="fade"
      supportedOrientations={['portrait', 'landscape']}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar hidden />
      {/* Its own safe area, measured in the modal's window. The app's is
          measured under the root view controller, which stays upright, so
          sideways it still gave the upright insets: room kept for a Dynamic
          Island at the top that was at the side. */}
      <SafeAreaProvider>
        <MultiCamGrid {...props} />
      </SafeAreaProvider>
    </Modal>
  )
}

/** The grid itself, inside the modal and its safe area. */
function MultiCamGrid(props: MultiCamViewProps): React.ReactElement {
  const { onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const screen = useWindowDimensions()
  const insets = useInsets()
  const width = Math.max(0, screen.width - insets.left - insets.right)
  const height = Math.max(0, screen.height - insets.top - insets.bottom)
  const mc = useMultiCam(props, {
    width,
    height,
    // The others slide aside rather than jump when a dragged tile changes
    // the place it would land in.
    beforeShuffle: shuffle
  })
  const {
    askAgain,
    attaching,
    attached,
    dropTile,
    goTo,
    mayReorder,
    moveTile,
    pressCancel,
    pressEnd,
    pressMoved,
    pressStart,
    showBar,
    skip,
    takeElement,
    tileWaiting,
    toggle
  } = mc

  // Turning with the phone while it is up, and upright again after.
  useEffect(() => {
    rotation.allow()
    return rotation.restore
  }, [])

  const touch = useRef<Touch | null>(null)
  const [armed, setArmed] = useState<number | null>(null)

  const disarm = (): void => {
    const held = touch.current
    if (held?.timer != null) clearTimeout(held.timer)
    setArmed(null)
  }
  useEffect(
    () => () => {
      if (touch.current?.timer != null) clearTimeout(touch.current.timer)
    },
    []
  )

  const onGrant = (event: GestureResponderEvent): void => {
    const { identifier, locationX, locationY, pageX, pageY } = event.nativeEvent
    const id = Number(identifier)
    if (!pressStart(id, locationX, locationY)) return
    const held: Touch = {
      id,
      x: locationX,
      y: locationY,
      pageX,
      pageY,
      tile: tileAt(mc.rects, locationX, locationY),
      timer: null,
      armed: false
    }
    // A second's rest on a tile picks it up, unless the press has become a
    // crawl in the meantime — the same rule, and the same second, as the web.
    if (held.tile != null) {
      held.timer = setTimeout(() => {
        held.timer = null
        if (held.tile == null || !mayReorder(id)) return
        held.armed = true
        setArmed(held.tile)
      }, REORDER_HOLD_MS)
    }
    touch.current = held
  }

  const onMove = (event: GestureResponderEvent): void => {
    const held = touch.current
    if (held == null) return
    const x = event.nativeEvent.pageX - held.pageX
    const y = event.nativeEvent.pageY - held.pageY
    if (held.armed) {
      if (held.tile != null && mayReorder(held.id)) moveTile(held.tile, x, y)
      return
    }
    // A finger that travels before the second is up is a slip, not a drag:
    // it neither moves the picture nor becomes one later.
    if (beyondSlop(x, y)) {
      if (held.timer != null) clearTimeout(held.timer)
      held.timer = null
      pressMoved(held.id)
    }
  }

  const onRelease = (event: GestureResponderEvent): void => {
    const held = touch.current
    if (held == null) return
    touch.current = null
    const x = event.nativeEvent.pageX - held.pageX
    const y = event.nativeEvent.pageY - held.pageY
    // Armed, and still the press: a finger that lost it to another is done,
    // and drops nothing.
    const wasArmed = held.armed && mayReorder(held.id)
    disarm()
    // A press that became a move is never also a tap.
    pressEnd(held.id, !beyondSlop(x, y) && !wasArmed, held.x + x, held.y + y)
    // Always: the picture goes back when the press meant nothing.
    if (held.tile != null) {
      dropTile(held.tile, wasArmed ? x : 0, wasArmed ? y : 0)
    }
  }

  const onTerminate = (): void => {
    const held = touch.current
    if (held == null) return
    touch.current = null
    disarm()
    pressCancel(held.id)
    if (held.tile != null) dropTile(held.tile, 0, 0)
  }

  const notice = mc.ended
    ? lstrings.angles_all_ended
    : mc.waiting
      ? lstrings.angles_waiting
      : null

  return (
    <View style={styles.screen}>
      <View
        style={[
          styles.box,
          { left: insets.left, top: insets.top, width, height }
        ]}
      >
        {mc.chosen.map((video, index) => (
          <Tile
            key={video.id}
            videoId={video.id}
            url={mc.urls[video.id] ?? null}
            unavailable={mc.urls[video.id] === null}
            onGiveUp={askAgain}
            // Silent throughout a crawl, whichever angle is heard.
            muted={mc.slow !== 0 || video.id !== mc.heardId || mc.soundBlocked}
            onAttaching={attaching}
            onAttached={attached}
            wantsToPlay={() => mc.intents.current.get(video.id) === true}
            rect={mc.shownRects[index] ?? { x: 0, y: 0, w: 0, h: 0 }}
            dragging={mc.drag?.index === index ? mc.drag : null}
            armed={armed === index}
            name={mc.names.get(video.id) ?? video.title}
            parked={mc.tiles[video.id]?.parked ?? null}
            waiting={tileWaiting(video.id)}
            unplaceable={video.startAt == null}
            takeRef={takeElement(video.id)}
            heard={video.id === mc.heardId}
          />
        ))}

        {/* Every touch on the grid, over the tiles and under the bar. */}
        <View
          style={styles.touches}
          onStartShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={onTerminate}
        />

        <SeekFlashView flash={mc.flash} />
        {/* Top right, clear of the finger holding the crawl on the right,
              and stepped left of the way out while that shows. */}
        <SlowMoBadge
          rate={mc.slow}
          right={
            mc.controlsShown
              ? exitClearance(theme) + theme.rem(theme.spaceSmRem)
              : undefined
          }
        />
        <ExitButton visible={mc.controlsShown} onPress={onClose} />

        {notice != null ? (
          <View style={styles.notice} pointerEvents="none">
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        {mc.take != null && mc.atWallMs != null ? (
          <MultiCamBar
            window={mc.take}
            atMs={mc.atWallMs}
            playing={mc.playing}
            angles={mc.barAngles(mc.take)}
            onTogglePlay={toggle}
            onSkip={skip}
            onScrub={goTo}
            onInteract={showBar}
            visible={mc.barShown}
          />
        ) : null}
      </View>
    </View>
  )
}

function Tile(props: {
  videoId: string
  url: string | null
  unavailable: boolean
  onGiveUp: (videoId: string) => void
  muted: boolean
  onAttaching: (id: string) => number | null
  onAttached: (id: string, element: TileHandle, toSec: number | null) => void
  wantsToPlay: () => boolean
  rect: Rect
  dragging: TileDrag | null
  /** Picked up, and waiting to be dropped. */
  armed: boolean
  name: string
  parked: 'beforeStart' | 'afterEnd' | null
  waiting: boolean
  unplaceable: boolean
  takeRef: (node: TileHandle | null) => void
  heard: boolean
}): React.ReactElement {
  const {
    videoId,
    url,
    rect,
    dragging,
    armed,
    name,
    parked,
    unavailable,
    unplaceable,
    waiting,
    heard,
    muted,
    takeRef
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [handle, setHandle] = useState<TileHandle | null>(null)
  const takeHandle = useCallback((next: VideoHandle | null): void => {
    setHandle(next)
  }, [])

  useEffect(() => {
    takeRef(handle)
    return () => {
      takeRef(null)
    }
  }, [handle, takeRef])

  // Until its first picture the tile says it is loading, rather than leaving
  // a black square to explain itself.
  const [hasPicture, setHasPicture] = useState(false)
  useEffect(() => {
    setHasPicture(handle != null && handle.readyState >= 2)
    if (handle == null) return
    const drew = (): void => {
      setHasPicture(true)
    }
    handle.addEventListener('loadeddata', drew)
    return () => {
      handle.removeEventListener('loadeddata', drew)
    }
  }, [handle, url])

  // This tile's own source, attached when it has one and detached with it.
  // The play intent is the grid's, which pauses tiles itself.
  useEffect(() => {
    const { onAttaching, onAttached, onGiveUp, wantsToPlay } = props
    if (handle == null || url == null) return
    const toSec = onAttaching(videoId)
    const detach = attachHls(
      handle,
      url,
      () => {
        onGiveUp(videoId)
      },
      { wantsToPlay }
    )
    const start = (): void => {
      onAttached(videoId, handle, toSec)
    }
    if (handle.readyState >= 1) start()
    else handle.addEventListener('loadedmetadata', start, { once: true })
    return () => {
      handle.removeEventListener('loadedmetadata', start)
      detach()
    }
    // The source and which video it is. Muting and playing are handled
    // elsewhere; including them here would reset the player on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, url, videoId])

  useEffect(() => {
    if (handle != null) handle.muted = muted
  }, [handle, muted])

  return (
    <View
      style={[
        styles.tile,
        {
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          transform: [
            { translateX: dragging?.x ?? 0 },
            { translateY: dragging?.y ?? 0 }
          ],
          zIndex: dragging != null ? 2 : 1
        }
      ]}
      pointerEvents="none"
    >
      <VideoView
        source={url}
        onHandle={takeHandle}
        resizeMode="contain"
        buffer={TILE_BUFFER}
      />
      {armed ? <View style={styles.tileArmed} /> : null}
      <View style={styles.tileName}>
        <Text style={styles.tileNameText} numberOfLines={1}>
          {heard ? `🔊 ${name}` : name}
        </Text>
      </View>
      {parked != null ||
      unavailable ||
      unplaceable ||
      waiting ||
      !hasPicture ? (
        <View style={styles.tileParked}>
          <Text style={styles.tileParkedText}>
            {unavailable
              ? lstrings.game_video_unavailable
              : unplaceable
                ? lstrings.angles_unplaceable
                : parked === 'beforeStart'
                  ? lstrings.angles_not_recording_yet
                  : parked === 'afterEnd'
                    ? lstrings.angles_stopped
                    : waiting
                      ? lstrings.angles_tile_catching_up
                      : lstrings.angles_tile_loading}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  screen: {
    flex: 1,
    backgroundColor: '#000000'
  },
  box: {
    position: 'absolute',
    overflow: 'hidden'
  },
  touches: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 3
  },
  tile: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#000000'
  },
  tileName: {
    position: 'absolute',
    top: theme.rem(theme.spaceXsRem),
    left: theme.rem(theme.spaceSmRem),
    maxWidth: '80%',
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(0, 0, 0, 0.45)'
  },
  tileArmed: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderWidth: 3,
    borderColor: theme.activeColor
  },
  tileNameText: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowRadius: 4
  },
  tileParked: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.55)'
  },
  tileParkedText: {
    color: '#ffffff',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    textAlign: 'center',
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  notice: {
    position: 'absolute',
    zIndex: 6,
    top: theme.rem(theme.spaceSmRem),
    alignSelf: 'center',
    paddingVertical: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(1),
    backgroundColor: 'rgba(0, 0, 0, 0.7)'
  },
  noticeText: {
    color: '#ffffff',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125)
  }
}))
