import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Text, useWindowDimensions, View } from 'react-native'

import { webStyle } from '../components/glass'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attachHls } from './attachHls'
import { SeekFlashView, SlowMoBadge } from './GestureFeedback'
import {
  ExitButton,
  exitClearance,
  exitSize,
  exitTopClear
} from './multiCam/barParts'
import { useFullScreen } from './multiCam/fullScreen'
import { edgeToEdge, type Rect } from './multiCam/layout'
import {
  type PlayerLayout,
  playerLayout,
  topOfAngles
} from './multiCam/playerLayout'
import {
  beyondSlop,
  type MultiCamProps,
  REORDER_HOLD_MS,
  type TileHandle,
  useMultiCam
} from './multiCam/useMultiCam'
import { MultiCamBar } from './MultiCamBar'
import type { PlayIntent } from './playIntent'
import {
  GridScoreboard,
  useGridBoard
} from './scoreboardOverlay/GridScoreboard'
import type { Size } from './scoreboardOverlay/overlayLayout'
import { useScreenInsets } from './useScreenInsets'

export type MultiCamViewProps = MultiCamProps

/**
 * The tile the grid's logic holds, for a browser's own element.
 *
 * The one place the seam is crossed: in a browser the element is everything
 * `TileHandle` describes, under the DOM's own types.
 */
function asTile(element: HTMLVideoElement): TileHandle {
  return element
}

/**
 * A mouse button other than the main one.
 *
 * A right click is the browser's menu and a middle click its scroll, and
 * neither is a tap on the picture — a long right press used to start a crawl.
 */
function otherButton(event: { pointerType: string; button: number }): boolean {
  return event.pointerType === 'mouse' && event.button !== 0
}

/**
 * Four angles of one game, playing together, in a browser.
 *
 * The pictures are ours to place, so the browser's own controls are off and
 * `MultiCamBar` draws the only ones there are. What the grid decides lives in
 * `useMultiCam`, shared with the phone's view; this file is the part that has
 * to touch the DOM — the elements, the pointer, the page behind, and the
 * browser's full screen.
 *
 * It lives inside the game screen rather than on a route of its own, because
 * this app renders only the top of its navigation stack and a route would tear
 * the game screen — and its player — down on the way in. That leaves the
 * single player mounted underneath, which is why it is suspended while this is
 * up: five decoders on a phone is not four, and two capture-phase key
 * listeners would both answer an arrow.
 */
export function MultiCamView(props: MultiCamViewProps): React.ReactElement {
  const { onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { height, width } = useWindowDimensions()
  // Either way up: sideways a two-by-two grid, upright one column.
  const landscape = width > height
  /**
   * `?debug=1`, which draws what each tile is actually doing.
   *
   * Written because the view's own account of itself — "camera catching up",
   * "waiting for the pictures" — is a conclusion, and a conclusion is no use
   * to somebody on a gigabit line who can see the same view stall. This shows
   * the numbers it reached that conclusion from.
   */
  const debug = useMemo(
    () =>
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('debug') === '1',
    []
  )

  // The game's board and box score, at the wall time of the master tile's
  // frame, and the angles around them (`playerLayout`).
  const board = useGridBoard(props, landscape)
  // Under the rounded corners and the camera while the grid is up: the
  // pictures run to the edges, and the board, the box and the controls keep
  // to what the hardware leaves.
  const insets = useScreenInsets()
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
      x: width - insets.right - theme.rem(theme.spaceSmRem) - exitSize(theme),
      y: insets.top + theme.rem(theme.spaceSmRem),
      w: exitSize(theme),
      h: exitSize(theme)
    },
    [layout.board, layout.box],
    theme.rem(theme.spaceSmRem)
  )
  const mc = useMultiCam(props, {
    width,
    height,
    debug,
    rects: layout.tiles
  })
  board.follow(mc)
  const {
    askAgain,
    attaching,
    attached,
    pressStart,
    pressMoved,
    pressEnd,
    pressCancel,
    mayReorder,
    toggle,
    skip,
    goTo,
    showBar,
    moveTile,
    dropTile,
    takeElement,
    tileWaiting,
    barAngles
  } = mc

  // A mouse over the bottom third calls the bar up, as a tap there does. A
  // mouse only: a finger's `pointermove` is a drag, and belongs to the tiles.
  useEffect(() => {
    const hover = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return
      if (event.clientY >= (window.innerHeight * 2) / 3) showBar()
    }
    document.addEventListener('pointermove', hover)
    return () => {
      document.removeEventListener('pointermove', hover)
    }
  }, [showBar])

  /**
   * The keyboard calls the bar up too, and Tab takes the focus into it.
   *
   * A hidden bar is inert, so Tab alone cannot be trusted to reach it: the
   * focus may move before React has drawn the bar as visible, and then lands
   * on the page behind the view instead. So a Tab from outside the bar is taken over —
   * the bar is shown, and once it has been drawn the focus goes to its first
   * control, or its last for Shift-Tab. Inside the bar, Tab is left alone and
   * only keeps it up. The keys the view answers show it as well, so a seek
   * from the keyboard shows where it went.
   */
  const barRoot = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const keys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
    const down = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const bar = barRoot.current
      if (bar == null) return
      if (event.key === 'Tab') {
        showBar()
        if (bar.contains(document.activeElement)) return
        event.preventDefault()
        const backwards = event.shiftKey
        requestAnimationFrame(() => {
          const controls = barRoot.current?.querySelectorAll<HTMLElement>(
            'button, [tabindex="0"]'
          )
          if (controls == null || controls.length === 0) return
          controls[backwards ? controls.length - 1 : 0]?.focus()
        })
        return
      }
      if (keys.has(event.key) || event.key === ' ' || event.key === 'k') {
        showBar()
      }
    }
    window.addEventListener('keydown', down, true)
    return () => {
      window.removeEventListener('keydown', down, true)
    }
  }, [showBar])

  /** Where a press on the black around the tiles came down. */
  const marginFrom = useRef<{ x: number; y: number; id: number } | null>(null)

  // Black around the view as well as under it. Safari keeps the page out of
  // the notch and the home indicator when a phone is held sideways, and
  // paints those two strips in the page's own background — the app's pale
  // green-grey, which read as white bars either side of the pictures.
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const theme = document.querySelector('meta[name="theme-color"]')
    const before = {
      html: html.style.backgroundColor,
      body: body.style.backgroundColor,
      theme: theme?.getAttribute('content') ?? null
    }
    html.style.backgroundColor = '#000000'
    body.style.backgroundColor = '#000000'
    theme?.setAttribute('content', '#000000')
    // A long press is a crawl or a move here, never a selection: Safari
    // answered one by selecting the whole view and offering to copy it. Set
    // on the body, where the prefixed names reach the browser as written.
    const unselectable = [
      'user-select',
      '-webkit-user-select',
      '-webkit-touch-callout'
    ]
    const selecting = unselectable.map(name =>
      body.style.getPropertyValue(name)
    )
    for (const name of unselectable) body.style.setProperty(name, 'none')
    return () => {
      unselectable.forEach((name, index) => {
        body.style.setProperty(name, selecting[index] ?? '')
      })
      html.style.backgroundColor = before.html
      body.style.backgroundColor = before.body
      if (before.theme != null) theme?.setAttribute('content', before.theme)
    }
  }, [])

  // Full screen, to the extent each browser allows, whichever way the screen
  // is turned. On an iPhone this is a swipe the viewer makes, and the layers
  // let it through to the page while it is wanted.
  const { swipeToHide } = useFullScreen(landscape, height)
  const touchAction = swipeToHide ? 'pan-y' : 'none'

  const notice = mc.ended
    ? lstrings.angles_all_ended
    : mc.waiting
      ? lstrings.angles_waiting
      : mc.soundBlocked
        ? lstrings.angles_tap_for_sound
        : swipeToHide
          ? lstrings.angles_swipe_full_screen
          : null

  // Into the document's own body, not into the screen that opened it.
  //
  // Two things go wrong without this, and both are invisible until it is on a
  // real page: the app's header is a later sibling with its own stacking
  // context, so it draws *over* a picture that is supposed to be the whole
  // screen; and `position: fixed` is measured against the nearest transformed
  // ancestor rather than the window, which a scroll view up the tree supplies
  // — so the grid started below the header and ran off the bottom by the same
  // amount.
  return createPortal(
    <View style={styles.overlay}>
      {/* The black around the tiles, which takes the same squares they do. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          touchAction
        }}
        onPointerDown={event => {
          if (otherButton(event)) return
          if (!pressStart(event.pointerId, event.clientX, event.clientY)) {
            return
          }
          ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
          marginFrom.current = {
            x: event.clientX,
            y: event.clientY,
            id: event.pointerId
          }
        }}
        // The same rule as on a tile: a finger that travels is a drag, which
        // neither becomes a crawl nor lands as a tap.
        onPointerMove={event => {
          const from = marginFrom.current
          if (from?.id !== event.pointerId) return
          if (beyondSlop(event.clientX - from.x, event.clientY - from.y)) {
            pressMoved(event.pointerId)
          }
        }}
        onPointerUp={event => {
          const from = marginFrom.current
          if (from?.id !== event.pointerId) return
          marginFrom.current = null
          const still = !beyondSlop(
            event.clientX - from.x,
            event.clientY - from.y
          )
          pressEnd(event.pointerId, still, event.clientX, event.clientY)
        }}
        onPointerCancel={event => {
          if (marginFrom.current?.id === event.pointerId) {
            marginFrom.current = null
          }
          pressCancel(event.pointerId)
        }}
        onPointerLeave={event => {
          if (marginFrom.current?.id === event.pointerId) {
            marginFrom.current = null
          }
          pressCancel(event.pointerId)
        }}
      />
      {mc.chosen.map((video, index) => (
        <Tile
          key={video.id}
          videoId={video.id}
          url={mc.urls[video.id] ?? null}
          unavailable={mc.urls[video.id] === null}
          onGiveUp={askAgain}
          // Silent throughout a crawl, whichever angle is heard: the sound
          // follows the moment, and a crawl across two recordings would
          // otherwise switch one on at a quarter speed.
          muted={mc.slow !== 0 || video.id !== mc.heardId || mc.soundBlocked}
          onAttaching={attaching}
          onAttached={attached}
          wantsToPlay={() => mc.intents.current.get(video.id) === true}
          buffer={mc.bufferFor(video.id)}
          isLive={
            video.status === 'live' && props.isLive != null
              ? liveCheck(props.isLive, video.id)
              : undefined
          }
          rect={mc.shownRects[index] ?? { x: 0, y: 0, w: 0, h: 0 }}
          dragging={mc.drag?.index === index ? mc.drag : null}
          standingAside={mc.drag != null && mc.drag.index !== index}
          name={mc.names.get(video.id) ?? video.title}
          parked={mc.tiles[video.id]?.parked ?? null}
          waiting={tileWaiting(video.id)}
          unplaceable={video.startAt == null}
          takeRef={takeElement(video.id)}
          touchAction={touchAction}
          heard={video.id === mc.heardId}
          nameTop={board.nameTop(index, mc.rects[index], mc.zoomed)}
          onPressStart={pressStart}
          onPressMoved={pressMoved}
          onPressEnd={pressEnd}
          onPressCancel={pressCancel}
          canReorder={mayReorder}
          pressPointer={mc.pressPointer}
          onMove={(x, y) => {
            moveTile(index, x, y)
          }}
          onDrop={(x, y) => {
            dropTile(index, x, y)
          }}
        />
      ))}

      <GridScoreboard board={board} layout={layoutFor} />

      <SeekFlashView flash={mc.flash} />
      {/* Top right, clear of the finger holding the crawl on the right, and
          stepped left of the way out while that shows. */}
      <SlowMoBadge
        rate={mc.slow}
        right={
          mc.controlsShown
            ? insets.right + exitClearance(theme) + theme.rem(theme.spaceSmRem)
            : undefined
        }
      />
      <ExitButton
        visible={mc.controlsShown}
        onPress={() => {
          onClose(mc.atWallMs)
        }}
        top={exitTop - theme.rem(theme.spaceSmRem)}
        right={insets.right}
      />

      {/* One at a time, most specific first: they share a place on the screen
          and two of them printed over each other unreadably. The swipe for
          full screen comes last, because it is advice about the browser and
          can wait while the pictures themselves have something to say. On
          the pictures, below the board's band: it is about them, and over
          the band it hid the score. */}
      {notice != null ? (
        <View
          style={[
            styles.notice,
            {
              // At the top of the highest angle: under the band upright, and
              // sideways with two angles, whose board rests on them; at the
              // top of the pictures otherwise.
              top:
                Math.max(safe.y, topOfAngles(layout)) +
                theme.rem(theme.spaceSmRem)
            }
          ]}
          pointerEvents="none"
        >
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {debug && mc.readout.length > 0 ? (
        <View style={styles.readout} pointerEvents="none">
          {mc.readout.map(line => (
            <Text key={line} style={styles.readoutText}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      {mc.take != null && mc.atWallMs != null ? (
        <MultiCamBar
          window={mc.take}
          atMs={mc.atWallMs}
          playing={mc.playing}
          angles={barAngles(mc.take)}
          onTogglePlay={toggle}
          onSkip={skip}
          onScrub={goTo}
          onInteract={showBar}
          visible={mc.barShown}
          rootRef={barRoot}
          panPage={swipeToHide}
          insets={insets}
        />
      ) : null}
    </View>,
    document.body
  )
}

/** One tile's question to the server, about its own video. */
function liveCheck(
  isLive: (videoId: string) => Promise<boolean>,
  videoId: string
): () => Promise<boolean> {
  return async () => await isLive(videoId)
}

function Tile(props: {
  videoId: string
  /** This one has stopped drawing, and has been stopped long enough to say. */
  waiting: boolean
  url: string | null
  /** Its player has stopped trying; the address is what to try next. */
  onGiveUp: (videoId: string) => void
  muted: boolean
  /** Where this tile should start, and a note that it is not there yet. */
  onAttaching: (id: string) => number | null
  onAttached: (id: string, element: TileHandle, toSec: number | null) => void
  wantsToPlay: () => boolean
  /** How far ahead its source loads, and the grid's hold on that. */
  buffer: PlayIntent['buffer']
  /** For a tile that was live when it was opened (`PlayIntent.isLive`). */
  isLive?: PlayIntent['isLive']
  rect: Rect
  dragging: { x: number; y: number } | null
  /**
   * Another tile is being dragged, so this one slides to where it is told
   * rather than jumping. Only then: on the drop every tile is already where
   * it ends up except the one let go, which goes straight to its place.
   */
  standingAside: boolean
  name: string
  parked: 'beforeStart' | 'afterEnd' | null
  unplaceable: boolean
  /** Its media is not there — the server answered, and there is nothing to play. */
  unavailable: boolean
  takeRef: (node: TileHandle | null) => void
  /** `pan-y` while a swipe should reach the page and hide Safari's bars. */
  touchAction: 'none' | 'pan-y'
  /** True while this is the one being heard. */
  heard: boolean
  /** Where its name goes, below the grid's board; at the top otherwise. */
  nameTop?: number
  /**
   * False while the press is doing something else, like a crawl, or once
   * another finger has taken it over.
   */
  canReorder: (pointerId: number) => boolean
  /** The finger the view's press now belongs to. */
  pressPointer: number | null
  /**
   * The press itself, in window coordinates, for the view's nine squares.
   * False when the view is ignoring this finger.
   */
  onPressStart: (pointerId: number, x: number, y: number) => boolean
  onPressMoved: (pointerId: number) => void
  /** True when the press was a hold, which is not a drop. */
  onPressEnd: (
    pointerId: number,
    still: boolean,
    x: number,
    y: number
  ) => boolean
  onPressCancel: (pointerId: number) => void
  onMove: (x: number, y: number) => void
  onDrop: (x: number, y: number) => void
}): React.ReactElement {
  const {
    rect,
    dragging,
    name,
    parked,
    unavailable,
    unplaceable,
    waiting,
    takeRef,
    heard,
    nameTop
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const element = useRef<HTMLVideoElement | null>(null)
  /**
   * Whether this tile has drawn its first picture since its source was
   * attached. Until then it is black, and says it is loading rather than
   * leaving a black square to explain itself.
   */
  const [hasPicture, setHasPicture] = useState(false)
  useEffect(() => {
    const node = element.current
    setHasPicture(node != null && node.readyState >= 2)
    if (node == null) return
    const drew = (): void => {
      setHasPicture(true)
    }
    node.addEventListener('loadeddata', drew)
    return () => {
      node.removeEventListener('loadeddata', drew)
    }
  }, [props.url])

  // Its sound as the view wants it, set before its source is attached: the
  // first play of WebKit's own player is a silent one, and it puts back the
  // sound the view wants (`PlayIntent.muted`).
  const mutedNow = useRef(props.muted)
  mutedNow.current = props.muted
  useEffect(() => {
    if (element.current != null) element.current.muted = props.muted
  }, [props.muted])

  // This tile's own source, attached when it has one and detached with it.
  // The play intent is injected rather than read off the element's pause
  // events: the view pauses tiles itself — holding them while another stalls,
  // parking one that was not recording yet — and `attachHls` would otherwise
  // read every one of those as the viewer pressing pause and never resume this
  // tile after a media error again.
  useEffect(() => {
    const node = element.current
    const {
      url,
      videoId,
      onAttaching,
      onAttached,
      onGiveUp,
      wantsToPlay,
      buffer,
      isLive
    } = props
    if (node == null || url == null) return
    const toSec = onAttaching(videoId)
    const detach = attachHls(
      node,
      url,
      () => {
        onGiveUp(videoId)
      },
      { wantsToPlay, buffer, isLive }
    )
    const start = (): void => {
      onAttached(videoId, asTile(node), toSec)
    }
    if (node.readyState >= 1) start()
    else node.addEventListener('loadedmetadata', start, { once: true })
    return () => {
      node.removeEventListener('loadedmetadata', start)
      detach()
    }
    // The source and which video it is. Muting and playing are handled
    // elsewhere; including them here would reset the element on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url, props.videoId])

  /**
   * The press the view turns into a square's action, and — after a finger has
   * rested for a second — a drag that moves the picture.
   *
   * Not through the gesture library the single player uses, for two reasons
   * that are both about where this view lives: it is portalled into the
   * document body, outside the tree that library instruments, and the app is
   * web-only, so a pointer is a pointer. The same seam the game screen already
   * keeps for its `<video>` and its sticky `div`.
   */
  const dragFrom = useRef<{ x: number; y: number; id: number } | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armedRef = useRef(false)
  const [armed, setArmed] = useState(false)

  const disarm = (): void => {
    if (armTimer.current != null) clearTimeout(armTimer.current)
    armTimer.current = null
    armedRef.current = false
    setArmed(false)
  }
  useEffect(() => disarm, [])

  // Another finger has taken the press: a picture this tile had picked up
  // goes back where it was, and the finger that lifted it is done with it.
  const onDropRef = useRef(props.onDrop)
  onDropRef.current = props.onDrop
  useEffect(() => {
    const from = dragFrom.current
    if (!armedRef.current || from == null || from.id === props.pressPointer) {
      return
    }
    disarm()
    onDropRef.current(0, 0)
  }, [props.pressPointer])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (otherButton(event)) return
    // A finger the view is ignoring — another is holding a crawl — is not
    // this tile's to follow either.
    if (!props.onPressStart(event.pointerId, event.clientX, event.clientY)) {
      return
    }
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
    dragFrom.current = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId
    }
    disarm()
    armTimer.current = setTimeout(() => {
      armTimer.current = null
      if (!props.canReorder(event.pointerId)) return
      armedRef.current = true
      setArmed(true)
    }, REORDER_HOLD_MS)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current
    if (from?.id !== event.pointerId) return
    const x = event.clientX - from.x
    const y = event.clientY - from.y
    if (armedRef.current) {
      if (!props.canReorder(event.pointerId)) return
      props.onMove(x, y)
      return
    }
    // A finger that travels before the second is up is a slip, not a drag:
    // it neither moves the picture nor becomes one later.
    if (beyondSlop(x, y)) {
      if (armTimer.current != null) clearTimeout(armTimer.current)
      armTimer.current = null
      props.onPressMoved(event.pointerId)
    }
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current
    if (from?.id !== event.pointerId) return
    dragFrom.current = null
    // Armed, and still the press: a finger that lost it to another is done,
    // and drops nothing.
    const wasArmed = armedRef.current && props.canReorder(event.pointerId)
    disarm()
    const moved = {
      x: event.clientX - from.x,
      y: event.clientY - from.y
    }
    const still = !beyondSlop(moved.x, moved.y)
    // A press that became a move is never also a tap.
    props.onPressEnd(
      event.pointerId,
      still && !wasArmed,
      event.clientX,
      event.clientY
    )
    // Always: the parent puts the picture back when the press meant nothing.
    if (wasArmed) props.onDrop(moved.x, moved.y)
    else props.onDrop(0, 0)
  }

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
        },
        props.standingAside ? styles.tileSliding : null
      ]}
    >
      <video
        ref={node => {
          element.current = node
          takeRef(node == null ? null : asTile(node))
        }}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        playsInline
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          touchAction: props.touchAction,
          cursor: 'grab'
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={event => {
          if (dragFrom.current?.id !== event.pointerId) return
          dragFrom.current = null
          disarm()
          props.onPressCancel(event.pointerId)
          props.onDrop(0, 0)
        }}
      />
      {armed ? <View style={styles.tileArmed} pointerEvents="none" /> : null}
      <View
        style={[styles.tileName, nameTop == null ? null : { top: nameTop }]}
        pointerEvents="none"
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
        <View style={styles.tileParked} pointerEvents="none">
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
  // Pinned to the window rather than to whatever happens to be positioned
  // above it in the tree: this is the whole screen while it is up. `fixed` is
  // a web value React Native has no name for, so it goes through the one cast
  // this app keeps for exactly that.
  overlay: webStyle({
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000000',
    zIndex: 100
  }),
  tile: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: '#000000'
  },
  tileSliding: webStyle({
    transitionProperty: 'left, top',
    transitionDuration: '200ms',
    transitionTimingFunction: 'ease'
  }),
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
  readout: {
    position: 'absolute',
    // Above the tiles and clear of the notice, which sits at the top middle.
    zIndex: 6,
    top: theme.rem(theme.spaceSmRem),
    left: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(0.375),
    backgroundColor: 'rgba(0, 0, 0, 0.72)'
  },
  readoutText: {
    color: '#9cff9c',
    fontFamily: 'monospace',
    fontSize: theme.rem(0.6875)
  },
  notice: {
    position: 'absolute',
    // Above the tiles, which stack explicitly: otherwise the pictures draw
    // over the words. Its top is the band's bottom, set where it is drawn.
    zIndex: 6,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
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
