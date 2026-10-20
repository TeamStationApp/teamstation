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
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attachHls } from './attachHls'
import { SeekFlashView, SlowMoBadge } from './GestureFeedback'
import type { ParkReason } from './multiCam/align'
import {
  ExitButton,
  exitClearance,
  exitSize,
  exitTopClear
} from './multiCam/barParts'
import { TILE_BUFFER } from './multiCam/buffering'
import { clearOf, edgeToEdge, type Rect } from './multiCam/layout'
import {
  type NativeOrientation,
  orientationLock
} from './multiCam/orientationLock'
import {
  type PlayerLayout,
  playerLayout,
  topOfAngles
} from './multiCam/playerLayout'
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
 *
 * The game's board is drawn as the browser draws it (`GridScoreboard`): in a
 * band above the column upright, over the top-left angle sideways, at the
 * wall time of the master tile's frame.
 */
export function MultiCamView(props: MultiCamViewProps): React.ReactElement {
  const { onClose } = props
  // Where the grid has got to, for Android's Back, which the modal hears
  // rather than the grid inside it.
  const wallNowRef = useRef<() => number | null>(() => null)
  return (
    <Modal
      visible
      animationType="fade"
      supportedOrientations={['portrait', 'landscape']}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        onClose(wallNowRef.current())
      }}
    >
      <StatusBar hidden />
      {/* Its own safe area, measured in the modal's window. The app's is
          measured under the root view controller, which stays upright, so
          sideways it still gave the upright insets: room kept for a Dynamic
          Island at the top that was at the side. */}
      <SafeAreaProvider>
        <MultiCamGrid {...props} wallNowRef={wallNowRef} />
      </SafeAreaProvider>
    </Modal>
  )
}

/** The grid itself, inside the modal and its safe area. */
function MultiCamGrid(
  props: MultiCamViewProps & {
    wallNowRef: React.RefObject<() => number | null>
  }
): React.ReactElement {
  const { onClose, wallNowRef } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  // Sideways the pictures have the whole screen; upright, all of it below the
  // top of the safe area. The controls and the board keep to the safe area.
  const { width, height } = useWindowDimensions()
  const insets = useScreenInsets()
  const landscape = width > height
  // The board, the box score and the angles around them, the board and the
  // box inside the safe area (`playerLayout`).
  const board = useGridBoard(props, landscape)
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
  // The way out, in the top right, or under the board where it reaches there.
  const exitTop = exitTopClear(
    {
      x: safe.x + safe.w - theme.rem(theme.spaceSmRem) - exitSize(theme),
      y: safe.y + theme.rem(theme.spaceSmRem),
      w: exitSize(theme),
      h: exitSize(theme)
    },
    [layout.board, layout.box],
    theme.rem(theme.spaceSmRem)
  )
  const mc = useMultiCam(props, {
    width,
    height,
    rects: layout.tiles,
    // The others slide aside rather than jump when a dragged tile changes
    // the place it would land in.
    beforeShuffle: shuffle,
    // A phone's players read no dates: each tile is placed by its video's
    // wall timeline, where the server has one.
    fallbackMapping: board.mappingOf
  })
  board.follow(mc)
  wallNowRef.current = mc.wallNow
  const {
    askAgain,
    attaching,
    attached,
    dropTile,
    goTo,
    moveTile,
    pressCancel,
    pressEnd,
    pressMove,
    pressStart,
    setTrackWidth,
    showBar,
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
    <View style={styles.screen}>
      <View style={[styles.box, { left: 0, top: 0, width, height }]}>
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
            onWallMapping={mc.takeMapping(video.id)}
            heard={video.id === mc.heardId}
            nameTop={board.nameTop(index, mc.rects[index], mc.zoomed, safe)}
            nameClear={clearOf(mc.shownRects[index], safe)}
          />
        ))}

        <GridScoreboard board={board} layout={layoutFor} />

        {/* Every touch on the grid, over the tiles and under the bar. */}
        <View
          testID="grid-touches"
          style={styles.touches}
          onStartShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={onTerminate}
        />

        {/* The controls, over the touches, where the hardware leaves room. */}
        <View
          style={[
            styles.controls,
            { left: safe.x, top: safe.y, width: safe.w, height: safe.h }
          ]}
          pointerEvents="box-none"
        >
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
          <ExitButton
            visible={mc.controlsShown}
            onPress={() => {
              onClose(mc.wallNow())
            }}
            // In the safe area's coordinates, as the controls are.
            top={exitTop - safe.y - theme.rem(theme.spaceSmRem)}
          />

          {/* On the pictures, below the board's band: over the band it would
            hide the score. */}
          {notice != null ? (
            <View
              style={[
                styles.notice,
                {
                  // In the safe area's coordinates, as the controls are; at
                  // the top of the highest angle, as the browser's grid puts
                  // it, so it is never over the board.
                  top:
                    Math.max(0, topOfAngles(layout) - safe.y) +
                    theme.rem(theme.spaceSmRem)
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
              onScrub={goTo}
              onTrackWidth={setTrackWidth}
              onInteract={showBar}
              visible={mc.barShown}
            />
          ) : null}
        </View>
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
  parked: ParkReason | null
  waiting: boolean
  unplaceable: boolean
  takeRef: (node: TileHandle | null) => void
  /** Where its player says it has no dates of its own (`PlayIntent`). */
  onWallMapping: (mapping: WallMapping | null) => void
  heard: boolean
  /** Where its name goes, below the grid's board; at the top otherwise. */
  nameTop?: number
  /** How far its name must come in to be clear of a notch or a corner. */
  nameClear: { left: number; top: number }
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
    takeRef,
    nameTop,
    nameClear
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
      <View
        style={[
          styles.tileName,
          {
            // Below the board, which is already kept clear; else at the
            // top, moved in clear of the hardware.
            top: nameTop ?? theme.rem(theme.spaceXsRem) + nameClear.top,
            left: theme.rem(theme.spaceSmRem) + nameClear.left
          }
        ]}
      >
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
                    : parked === 'notYet'
                      ? lstrings.angles_tile_waiting_live
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
  controls: {
    position: 'absolute',
    zIndex: 4
  },
  tile: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#000000'
  },
  tileName: {
    // At the top left, `top` and `left` set where it is drawn.
    position: 'absolute',
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
