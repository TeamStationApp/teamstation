import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Animated,
  type GestureResponderEvent,
  LayoutAnimation,
  Modal,
  NativeModules,
  PanResponder,
  StatusBar,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { lstrings, sprintf } from '../locales/strings'
import { useVideoAnalytics } from '../observability/useVideoAnalytics'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attachHls } from './attachHls'
import { SeekFlashView, SlowMoBadge } from './GestureFeedback'
import type { ParkReason } from './multiCam/align'
import { ExitButton, exitClearance, gridControls } from './multiCam/barParts'
import { TILE_BUFFER } from './multiCam/buffering'
import { edgeToEdge, type Rect } from './multiCam/layout'
import {
  gridRotation,
  type NativeOrientation
} from './multiCam/orientationLock'
import {
  type PlayerLayout,
  playerLayout,
  topOfAngles
} from './multiCam/playerLayout'
import { claimsSwipe, commitsSwipe, followOf } from './multiCam/sheetSwipe'
import { tileNotice } from './multiCam/tileNotice'
import {
  type MultiCamProps,
  type TileDrag,
  type TileHandle,
  useMultiCam
} from './multiCam/useMultiCam'
import { MultiCamBar } from './MultiCamBar'
import {
  GridScoreboard,
  useGridBoard
} from './scoreboardOverlay/GridScoreboard'
import type { Size } from './scoreboardOverlay/overlayLayout'
import { useScreenInsets } from './useScreenInsets'
import type { VideoHandle } from './videoHandle'
import { VideoView } from './VideoView'
import type { WallMapping } from './wallMapping'
import { ZoneIcons } from './ZoneIcons'

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
  /** It has moved its tile while carrying it. */
  carried: boolean
}

/** `TSOrientation`, which lets the sheet turn with the phone on both. */
const rotation = gridRotation(
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
 * this file draws it with the phone's own players. Full screen as a sheet: a
 * transparent `Modal`, which a phone draws over everything — the header, the
 * tabs and the status bar included — sliding up from the bottom. A downward
 * swipe anywhere on it, on the pictures, the controls or the scrub line,
 * pulls it down with the finger, and one that goes far enough, or fast
 * enough, closes it; one that does not lets it spring back. A grabber in the
 * top inset says so. The ✕ and Android's Back close it the same way. It
 * turns with the phone,
 * the one screen of the app that does: upright the angles are stacked one
 * above another, sideways they are a two-by-two grid, laid out for the
 * screen inside its safe area either way.
 *
 * One layer over the tiles takes every touch: a tap is one of the nine
 * squares, a press held on the +10 s square crawls, and a press held a second
 * on a tile picks the tile up: in a column the others slide out of its way
 * and it is put where it is let go, in a grid it swaps with the one it is
 * dropped on — the browser's rules, through the same calls.
 *
 * The game's board is drawn as the browser draws it (`GridScoreboard`): in a
 * band above the column upright, over the top-left angle sideways, at the
 * wall time of the master tile's frame.
 */
export function MultiCamView(props: MultiCamViewProps): React.ReactElement {
  // The grid's way out, for Android's Back, which the modal hears rather
  // than the grid inside it.
  const closeRef = useRef<(ended?: boolean) => void>(() => undefined)
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      supportedOrientations={['portrait', 'landscape']}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        closeRef.current()
      }}
    >
      <StatusBar hidden />
      {/* Its own safe area, measured in the modal's window: right through
          the turn on iOS, where the root turns with the sheet a beat behind
          it, and on Android, where the modal is a dialog of its own. */}
      <SafeAreaProvider>
        <MultiCamGrid {...props} closeRef={closeRef} />
      </SafeAreaProvider>
    </Modal>
  )
}

/** The grid itself, the sheet inside the modal and its safe area. */
function MultiCamGrid(
  props: MultiCamViewProps & {
    closeRef: React.RefObject<(ended?: boolean) => void>
  }
): React.ReactElement {
  const { onClose, closeRef } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  // Sideways the pictures have the whole screen; upright, all of it below the
  // top of the safe area. The controls and the board keep to the safe area.
  const { width, height } = useWindowDimensions()
  const insets = useScreenInsets()
  const landscape = width > height
  // The board, the box score and the angles around them, the board and the
  // box inside the safe area (`playerLayout`).
  const board = useGridBoard(props)
  const { safe } = edgeToEdge({ width, height }, insets, 0, landscape)
  const zoomedIndex =
    props.zoomedId == null ? null : props.order.indexOf(props.zoomedId)
  const layoutFor = (natural: Size): PlayerLayout =>
    playerLayout({
      screen: { width, height },
      safe,
      count: board.count,
      aspect: board.aspect,
      landscape,
      settings: board.settings,
      board: board.hasBoard ? natural : null,
      line: board.hasLine,
      zoomed: zoomedIndex != null && zoomedIndex >= 0 ? zoomedIndex : null
    })
  const layout = layoutFor(board.natural)
  // The controls go on the block of videos, kept inside the safe area: the
  // press grid over it (`pressGrid.ts`), the icons and the way out at its
  // top, the scrub line on its bottom.
  const { block, gap, icons, exitTop, blockRight } = gridControls(
    theme,
    layout,
    safe,
    width,
    zoomedIndex
  )

  /**
   * The sheet's offset down the screen: 0 where it sits, following a finger
   * that pulls it, and the screen's height once it has gone.
   */
  const translateY = useRef(new Animated.Value(0)).current
  const closing = useRef(false)
  /**
   * Slides the sheet away, then tells the screen where the grid had got to
   * and whether it was playing — or, at a highlight's end, that it stopped
   * there: the highlight is over, and the card stays where it ended.
   */
  const close = (ended = false): void => {
    if (closing.current) return
    closing.current = true
    // Read now: the tiles may be gone by the time the slide ends.
    const atWallMs = mc.wallNow() ?? mc.atWallMs
    const playing = mc.playing && !ended
    Animated.timing(translateY, {
      toValue: height,
      duration: 200,
      useNativeDriver: true
    }).start(() => {
      onClose(atWallMs, playing)
    })
  }
  closeRef.current = close
  const closeLatest = useRef(close)
  closeLatest.current = close
  const heightRef = useRef(height)
  heightRef.current = height
  // Taken in the capture phase, so a downward swipe that starts on a tile,
  // the ✕ or the scrub line is the sheet's — once the press under it has
  // let go of it (`pressYields`).
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        !closing.current && claimsSwipe(gesture.dx, gesture.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_event, gesture) => {
        translateY.setValue(followOf(gesture.dy))
      },
      onPanResponderRelease: (_event, gesture) => {
        if (commitsSwipe(gesture.dy, gesture.vy, heightRef.current)) {
          closeLatest.current()
          return
        }
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true
        }).start()
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true
        }).start()
      }
    })
  ).current
  const mc = useMultiCam(
    {
      ...props,
      // A highlight's end closes the sheet, as a swipe down would.
      onEndReached: () => {
        props.onEndReached?.()
        closeRef.current(true)
      }
    },
    {
      width,
      height,
      block,
      icons,
      onCorner: () => {
        closeRef.current()
      },
      rects: layout.tiles,
      // The others slide aside rather than jump when a dragged tile changes
      // the place it would land in.
      beforeShuffle: shuffle,
      // A phone's players read no dates: each tile is placed by its video's
      // wall timeline, where the server has one.
      fallbackMapping: board.mappingOf
    }
  )
  board.follow(mc)
  const {
    askAgain,
    attaching,
    attached,
    dropTile,
    moveTile,
    pressCancel,
    pressEnd,
    pressMove,
    pressYields,
    pressStart,
    setTrackRect,
    takeElement,
    tileWaiting
  } = mc

  // Turning with the phone while it is up, and upright again after.
  useEffect(() => {
    rotation.allow()
    return rotation.restore
  }, [])

  const touch = useRef<Touch | null>(null)

  const armed = mc.armedTile

  // The grid's own press does the rest — a tap's square, a scrub, a crawl,
  // a tile picked up — from the same points the browser hands it.
  const onGrant = (event: GestureResponderEvent): void => {
    const { identifier, locationX, locationY, pageX, pageY } = event.nativeEvent
    const id = Number(identifier)
    const tile = tileAt(mc.rects, locationX, locationY)
    if (!pressStart(id, locationX, locationY, tile)) return
    touch.current = {
      id,
      x: locationX,
      y: locationY,
      pageX,
      pageY,
      tile,
      carried: false
    }
  }

  const onMove = (event: GestureResponderEvent): void => {
    const held = touch.current
    if (held == null) return
    const x = event.nativeEvent.pageX - held.pageX
    const y = event.nativeEvent.pageY - held.pageY
    pressMove(held.id, held.x + x, held.y + y)
    if (held.tile == null || armed !== held.tile) return
    held.carried = true
    moveTile(held.tile, x, y)
  }

  const onRelease = (event: GestureResponderEvent): void => {
    const held = touch.current
    if (held == null) return
    touch.current = null
    const x = event.nativeEvent.pageX - held.pageX
    const y = event.nativeEvent.pageY - held.pageY
    const mode = pressEnd(held.id, held.x + x, held.y + y)
    // Always: the picture goes back when the press meant nothing.
    if (held.tile != null) {
      const carried = mode === 'reorder'
      dropTile(held.tile, carried ? x : 0, carried ? y : 0)
    }
  }

  const onTerminate = (): void => {
    const held = touch.current
    if (held == null) return
    touch.current = null
    pressCancel(held.id)
    if (held.tile != null) dropTile(held.tile, 0, 0)
  }

  const notice = mc.ended
    ? lstrings.angles_all_ended
    : mc.waiting
      ? lstrings.angles_waiting
      : null

  return (
    <Animated.View
      style={[styles.screen, { transform: [{ translateY }] }]}
      {...swipe.panHandlers}
    >
      {/* The sheet's own: it can be pulled down. In the top inset, above
          the pictures, and never one of the video controls. */}
      <View
        testID="sheet-grabber"
        accessible
        accessibilityLabel={lstrings.angles_swipe_to_close}
        style={[
          styles.grabber,
          {
            left: width / 2 - GRABBER_WIDTH / 2,
            top: Math.max(6, (safe.y - GRABBER_HEIGHT) / 2)
          }
        ]}
        pointerEvents="none"
      />
      <View style={[styles.box, { left: 0, top: 0, width, height }]}>
        {mc.chosen.map((video, index) => (
          <Tile
            key={video.id}
            videoId={video.id}
            url={mc.urls[video.id] ?? null}
            unavailable={mc.urls[video.id] === null}
            onGiveUp={askAgain}
            // Silent throughout a crawl, whichever angle is heard.
            muted={
              mc.slow !== 0 ||
              video.id !== mc.heardId ||
              mc.soundBlocked ||
              mc.soundOff
            }
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
            onWallMapping={mc.takeMapping(video.id)}
            heard={video.id === mc.heardId}
          />
        ))}

        <GridScoreboard board={board} layout={layoutFor} />

        {/* Every touch on the grid, over the tiles and under the bar. */}
        <View
          testID="grid-touches"
          style={styles.touches}
          onStartShouldSetResponder={() => true}
          // A press still waiting to be something lets the sheet's swipe
          // have the finger; a scrub, a crawl or a carried tile keeps it.
          onResponderTerminationRequest={() =>
            touch.current == null || pressYields(touch.current.id)
          }
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={onTerminate}
        />

        {/* The controls, over the touches, on the block of videos. */}
        <View
          style={[styles.controls, { left: 0, top: 0, width, height }]}
          pointerEvents="box-none"
        >
          <View
            style={[
              styles.flashBox,
              { left: block.x, top: block.y, width: block.w, height: block.h }
            ]}
            pointerEvents="none"
          >
            <SeekFlashView flash={mc.flash} />
          </View>
          <ZoneIcons
            icons={icons}
            visible={mc.controlsShown}
            playing={mc.playing}
            soundOff={mc.soundOff}
          />
          {/* Top right of the block, clear of the finger holding the crawl
              on the right, and stepped left of the way out while that
              shows. */}
          <SlowMoBadge
            rate={mc.slow}
            top={block.y + gap}
            right={
              blockRight + gap + (mc.controlsShown ? exitClearance(theme) : 0)
            }
          />
          <ExitButton
            visible={mc.controlsShown}
            onPress={() => {
              close()
            }}
            top={exitTop - gap}
            right={blockRight}
          />

          {/* On the pictures, below the board's band: over the band it would
            hide the score. */}
          {notice != null ? (
            <View
              style={[
                styles.notice,
                {
                  // At the top of the highest angle, as the browser's grid puts
                  // it, so it is never over the board.
                  top: Math.max(safe.y, topOfAngles(layout)) + gap
                }
              ]}
              pointerEvents="none"
            >
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          {mc.take != null && mc.atWallMs != null ? (
            <MultiCamBar
              window={mc.take}
              atMs={mc.atWallMs}
              angles={mc.barAngles(mc.take)}
              onTrackRect={setTrackRect}
              visible={mc.scrubShown}
              frame={{
                left: block.x,
                width: block.w,
                bottom: height - (block.y + block.h)
              }}
            />
          ) : null}
        </View>
      </View>
    </Animated.View>
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
  parked: ParkReason | null
  waiting: boolean
  unplaceable: boolean
  takeRef: (node: TileHandle | null) => void
  /** Where its player says it has no dates of its own (`PlayIntent`). */
  onWallMapping: (mapping: WallMapping | null) => void
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
  useVideoAnalytics(handle, videoId, url, heard)
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
    const { onAttaching, onAttached, onGiveUp, wantsToPlay, onWallMapping } =
      props
    if (handle == null || url == null) return
    const toSec = onAttaching(videoId)
    const detach = attachHls(
      handle,
      url,
      () => {
        onGiveUp(videoId)
      },
      { wantsToPlay, onWallMapping }
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
      // A picture, named for its angle, to assistive technology — and to the
      // end-to-end suite, which finds each tile's place on the glass by it.
      accessible
      accessibilityRole="image"
      accessibilityLabel={sprintf(lstrings.angles_tile_label, name)}
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
        // The heard tile takes the audio session, as the videos page's
        // player does: sound with the ring switch on silent.
        primary={heard}
      />
      {armed ? <View style={styles.tileArmed} /> : null}
      {parked != null ||
      unavailable ||
      unplaceable ||
      waiting ||
      !hasPicture ? (
        <View style={styles.tileParked}>
          <Text style={styles.tileParkedText}>
            {tileNotice({ unavailable, unplaceable, parked, waiting })}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/** The grabber's size, in points. */
const GRABBER_WIDTH = 36
const GRABBER_HEIGHT = 5

const getStyles = cacheStyles((theme: Theme) => ({
  screen: {
    flex: 1,
    backgroundColor: '#000000'
  },
  grabber: {
    position: 'absolute',
    width: GRABBER_WIDTH,
    height: GRABBER_HEIGHT,
    borderRadius: GRABBER_HEIGHT / 2,
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    // Over the pictures where they reach the top, under nothing.
    zIndex: 9
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
  controls: {
    position: 'absolute',
    zIndex: 4
  },
  flashBox: {
    position: 'absolute'
  },
  tile: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#000000'
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
    // Its top is the band's bottom, set where it is drawn.
    zIndex: 6,
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
