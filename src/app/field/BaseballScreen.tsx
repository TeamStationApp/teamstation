import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import type { TagTarget } from '../../common/eventTags'
import type { GameState } from '../../common/scoring/state'
import { ButtonIcon } from '../components/ButtonIcon'
import { GlassView } from '../components/GlassView'
import { PillButton } from '../components/PillTabs'
import { lstrings, sprintf } from '../locales/strings'
import {
  InstructionToast,
  type ScoreboardBounds,
  type SetupToast
} from '../scoring/InstructionToast'
import {
  RemoteScoringUpdates,
  type RemoteScoringUpdatesProps
} from '../scoring/RemoteScoringUpdates'
import {
  CONTROL_COLORS,
  CONTROL_DECK_HEIGHT,
  CONTROL_GAP,
  CONTROL_HEIGHT,
  ControlBackdrop,
  ControlFace,
  controlFrame,
  ControlIcon,
  DICTATION_LOG_HEIGHT
} from '../scoring/ScoringControlAppearance'
import { DONE_WIDTH, scoringControlRow } from '../scoring/scoringControlStyle'
import {
  type HistoryBounds,
  HistoryPopup,
  type HistoryRow
} from '../scoring/ScoringHistory'
import { ScoringSidePanel } from '../scoring/ScoringSidePanel'
import { SwitchHitterHint } from '../scoring/SwitchHitterHint'
import { UndoTicker } from '../scoring/UndoTicker'
import { useHoldSelection } from '../scoring/useHoldSelection'
import { useMenuEscape } from '../scoring/useMenuEscape'
import { useTheme } from '../theme/ThemeContext'
import { SCORING_BOTTOM_EXTENSION, SCORING_CAMERA } from './cameraModel'
import type { ScreenRect } from './catcherBounds'
import { FieldCanvas } from './FieldCanvas'
import { createRelay, type Relay, useRelay } from './fieldPropsRelay'
import {
  bandedSafe,
  compactToastBounds,
  type MenuButtonEdges,
  menuButtonEdges,
  toastTopBelow,
  topLift,
  WEB_MENU_BUTTON
} from './fieldSafeArea'
import type { BaseProjection, FieldCanvasProps } from './fieldTypes'
import type { ScoringFrame } from './scoringFrame'
import { useFieldInsets, useFieldSurface } from './useFieldSurface'
import { VolumeButton } from './VolumeButton'

export { SCORING_CAMERA, SCORING_BOTTOM_EXTENSION } from './cameraModel'

export const PITCH_CONTROLS = [
  { kind: 'ball', label: 'Ball' },
  { kind: 'called', label: 'Called Strike' },
  { kind: 'swing', label: 'Swing and Miss' },
  { kind: 'foul', label: 'Foul Ball' },
  { kind: 'play', label: 'Ball in Play' }
] as const
export interface BaseballScreenProps {
  boxState?: GameState
  frame?: ScoringFrame
  onRootSize?: (size: { width: number; height: number }) => void
  remoteUpdates?: Pick<
    RemoteScoringUpdatesProps,
    'game' | 'userId' | 'obscured'
  >
  suspended?: boolean
  setupToast?: SetupToast
  field: FieldCanvasProps
  onMenu: () => void
  /**
   * Where ☰ ends up, measured: on a phone it sits at the safe inset rather
   * than the web's 8, and whatever opens beside it must clear it.
   */
  onMenuButton?: (edges: MenuButtonEdges) => void
  onUndo: () => void
  onPitch: (kind: (typeof PITCH_CONTROLS)[number]['kind']) => void
  historyRows?: HistoryRow[]
  /** Undo wording only when its action produced the newest tag target. */
  tagHistoryDetail?: { primary: string; secondary?: string }
  onHistoryOpen?: () => void
  onHistoryClose?: () => void
  onTagSelect?: (target: TagTarget) => void
  historyLabel?: string
  /** The last play in two lines, shown in place of the label and the hint. */
  historyDetail?: { primary: string; secondary?: string }
  canPitch: boolean
  enabledPitchKinds?: ReadonlyArray<(typeof PITCH_CONTROLS)[number]['kind']>
  remainingMs?: number
  instruction?: string
  instructionStatus?: string
  instructionDetail?: string
  finishLabel?: string
  canFinish?: boolean
  onFinish?: () => void
  onCameraGesture?: (active: boolean) => void
  summary: string
  accessibilitySummary?: string
  children?: React.ReactNode
  ballInPlayControl?: React.ReactNode
  moreControl?: React.ReactNode
  /**
   * The batter's walk-up note, in a row of its own directly above the row
   * More starts. Only a phone passes one.
   */
  walkUpControl?: React.ReactNode
  /** Sits directly above the column that holds Bunt and Swing. */
  dictationControl?: React.ReactNode
  /**
   * Sits in the top-left corner, ending left of the menu button; with the
   * speaker, between it and the menu button.
   */
  dictationLog?: React.ReactNode
  /**
   * The speaker at the top-left corner, opposite ☰: the game's sounds, on
   * or off. Walk-up songs are not its to stop.
   */
  sound?: { on: boolean; onToggle: () => void }
  onDismissHint?: () => void
}

/** Raise the field into the top inset and extend its canvas to the screen's foot. */
export function fieldHolderStyle(offset: number): ViewStyle {
  return offset === 0
    ? { flex: 1 }
    : {
        flex: 1,
        transform: [{ translateY: offset }],
        marginBottom: Math.min(0, offset)
      }
}

/** Translate canvas-local points into the root coordinates that the controls use. */
function rootField(field: FieldCanvasProps, offset: number): FieldCanvasProps {
  if (offset === 0) return field
  const toRoot = <T extends { y: number }>(point: T): T => ({
    ...point,
    y: point.y + offset
  })
  const { onBaseProjection, onRunnerDrag, onRunnerHold, onRunnerPlacement } =
    field
  return {
    ...field,
    ...(onBaseProjection == null
      ? {}
      : {
          onBaseProjection: projection => {
            onBaseProjection({
              ...projection,
              bases: projection.bases.map(toRoot),
              ...(projection.heads == null
                ? {}
                : { heads: projection.heads.map(toRoot) }),
              ...(projection.feet == null
                ? {}
                : { feet: projection.feet.map(toRoot) })
            })
          }
        }),
    ...(onRunnerDrag == null
      ? {}
      : {
          onRunnerDrag: view => {
            onRunnerDrag(
              view == null
                ? null
                : { ...view, safe: toRoot(view.safe), out: toRoot(view.out) }
            )
          }
        }),
    ...(onRunnerPlacement == null
      ? {}
      : {
          onRunnerPlacement: (id, point, anchor, generation) => {
            onRunnerPlacement(id, point, toRoot(anchor), generation)
          }
        }),
    ...(onRunnerHold == null
      ? {}
      : {
          onRunnerHold: (id, anchor) => {
            onRunnerHold(id, toRoot(anchor))
          }
        })
  }
}

function rootBounds(
  canvas: ScoreboardBounds,
  offset: number
): ScoreboardBounds {
  return offset === 0 ? canvas : { ...canvas, y: canvas.y + offset }
}

/** Reproject the last canvas reports when a rotation changes the inset. */
function useFieldReports(
  field: FieldCanvasProps,
  offset: number
): {
  field: FieldCanvasProps
  bounds: ScoreboardBounds | undefined
  onScoreboardBounds: (canvas: ScoreboardBounds) => void
} {
  const [bounds, setBounds] = useState<ScoreboardBounds>()
  const canvasBoard = useRef<ScoreboardBounds>(undefined)
  const canvasBases = useRef<BaseProjection>(undefined)
  const onScoreboardBounds = useCallback(
    (canvas: ScoreboardBounds) => {
      canvasBoard.current = canvas
      setBounds(rootBounds(canvas, offset))
    },
    [offset]
  )
  const translated = rootField(field, offset)
  const report = translated.onBaseProjection
  const latest = useRef(report)
  latest.current = report
  useEffect(() => {
    if (canvasBoard.current != null)
      setBounds(rootBounds(canvasBoard.current, offset))
    if (canvasBases.current != null) latest.current?.(canvasBases.current)
  }, [offset])
  return {
    field:
      report == null
        ? translated
        : {
            ...translated,
            onBaseProjection: projection => {
              canvasBases.current = projection
              report(projection)
            }
          },
    bounds,
    onScoreboardBounds
  }
}

/** What the screen on top of a kept field draws it with. */
interface KeptFieldDraw {
  field: FieldCanvasProps
  /** The canvas's vertical offset in the screen. */
  offset: number
  fieldWidth?: number
  suspended: boolean
  /** Counts the screens that have taken the field, the first 1. */
  taken: number
}
const KeptFieldContext = createContext<Relay<KeptFieldDraw | undefined> | null>(
  null
)

/**
 * Keeps one field — its canvas, the scene and the scoreboard the scene draws
 * — under whichever `BaseballScreen` inside it is on screen now. A screen
 * that replaces another (the scoring panel of a game opened again, after a
 * swap of home and away) draws its players and scoreboard on the same field
 * in the next frame: on a phone a new GL canvas takes most of two seconds to
 * draw anything, and the field would be blank until it had. The field takes
 * the props of the screen drawn last and keeps them while none is drawn.
 */
export function FieldKeeper(props: {
  rootStyle?: ViewStyle
  children: React.ReactNode
}): React.ReactElement {
  const [relay] = useState(() =>
    createRelay<KeptFieldDraw | undefined>(undefined)
  )
  const theme = useTheme()
  return (
    <KeptFieldContext.Provider value={relay}>
      <View
        testID="scoring-viewport"
        style={[
          { backgroundColor: theme.backgroundColor },
          props.rootStyle ?? { flex: 1 }
        ]}
      >
        <KeptField relay={relay} />
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {props.children}
        </View>
      </View>
    </KeptFieldContext.Provider>
  )
}

function KeptField(props: {
  relay: Relay<KeptFieldDraw | undefined>
}): React.ReactElement {
  const draw = useRelay(props.relay)
  const latest = useRef(draw)
  latest.current = draw
  /**
   * What the scene last said of its bases, board and catcher. It says each
   * only when it moves, so a screen that takes the field is told it here.
   */
  const heard = useRef<{
    bases?: BaseProjection
    board?: ScoreboardBounds
    catcher?: ScreenRect
  }>({})
  const [reports] = useState(() => ({
    handleBaseProjection: (bases: BaseProjection) => {
      heard.current.bases = bases
      latest.current?.field.onBaseProjection?.(bases)
    },
    handleScoreboardBounds: (board: ScoreboardBounds) => {
      heard.current.board = board
      latest.current?.field.onScoreboardBounds?.(board)
    },
    handleCatcherBounds: (catcher: ScreenRect) => {
      heard.current.catcher = catcher
      latest.current?.field.onCatcherBounds?.(catcher)
    }
  }))
  const taken = draw?.taken
  useLayoutEffect(() => {
    const field = latest.current?.field
    if (taken == null || taken < 2 || field == null) return
    const { bases, board, catcher } = heard.current
    if (bases != null) field.onBaseProjection?.(bases)
    if (board != null) field.onScoreboardBounds?.(board)
    if (catcher != null) field.onCatcherBounds?.(catcher)
  }, [taken])
  const field = draw?.field
  return (
    <View
      testID="scoring-field-holder"
      style={[fieldHolderStyle(draw?.offset ?? 0), { width: draw?.fieldWidth }]}
    >
      {field != null && draw?.suspended === false && (
        <FieldCanvas
          {...field}
          {...SCORING_CAMERA}
          basicTouchShadows
          bottomExtension={SCORING_BOTTOM_EXTENSION}
          onBaseProjection={
            field.onBaseProjection == null
              ? undefined
              : reports.handleBaseProjection
          }
          onScoreboardBounds={reports.handleScoreboardBounds}
          onCatcherBounds={
            field.onCatcherBounds == null
              ? undefined
              : reports.handleCatcherBounds
          }
        />
      )}
    </View>
  )
}

/**
 * Hands the field this screen draws to the `FieldKeeper` around it, each
 * render; none when there is no keeper, and the screen draws its own.
 */
function useKeptField(
  field: FieldCanvasProps,
  offset: number,
  suspended: boolean,
  fieldWidth?: number
): boolean {
  const relay = useContext(KeptFieldContext)
  const taken = useRef(0)
  useLayoutEffect(() => {
    if (relay == null) return
    // This screen takes the field: the keeper tells it where the bases, the
    // board and the catcher are, as a field of its own tells it as it starts.
    if (taken.current === 0) taken.current = (relay.get()?.taken ?? 0) + 1
    relay.set({ field, offset, fieldWidth, suspended, taken: taken.current })
  })
  return relay != null
}

/** Immersive scoring surface, with one fixed responsive camera. */
export function BaseballScreen(props: BaseballScreenProps): React.ReactElement {
  const [historyBounds, setHistoryBounds] = useState<HistoryBounds | null>(null)
  const undoButton = useRef<React.ComponentRef<typeof View>>(null)
  const {
    onPressIn: handleUndoPressIn,
    onPressOut: handleUndoPressOut,
    onLongPress: handleUndoLongPress
  } = useHoldSelection()
  const { onHistoryClose } = props
  const closeHistory = useCallback(() => {
    setHistoryBounds(null)
    onHistoryClose?.()
  }, [onHistoryClose])
  useMenuEscape(
    historyBounds != null && props.suspended !== true,
    closeHistory,
    `Undo ${props.historyLabel ?? ''}`
  )
  useEffect(() => {
    if (props.historyLabel == null) closeHistory()
  }, [props.historyLabel, closeHistory])
  const theme = useTheme()
  const insets = useFieldInsets()
  const lift = topLift(insets.top, Platform.OS)
  const offset = -lift
  const {
    field: translatedCanvas,
    bounds,
    onScoreboardBounds
  } = useFieldReports({ ...props.field, frame: props.frame?.camera }, offset)
  const kept = useKeptField(
    { ...translatedCanvas, onScoreboardBounds },
    offset,
    props.suspended === true,
    props.frame?.fieldWidth
  )
  const surface = useFieldSurface(
    kept ? 'contained' : props.frame != null ? 'scoring' : 'field'
  )
  const [viewportHeight, setViewportHeight] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [header, setHeader] = useState<ScoreboardBounds>()
  const menuButton =
    header == null || viewportWidth === 0
      ? WEB_MENU_BUTTON
      : menuButtonEdges(header, viewportWidth)
  const { onMenuButton } = props
  const { bottom: menuBottom, right: menuRight } = menuButton
  useEffect(() => {
    onMenuButton?.({ bottom: menuBottom, right: menuRight })
  }, [menuBottom, menuRight, onMenuButton])
  const compact = viewportHeight > 0 && viewportHeight < 480 && header != null
  const toastBounds = compact
    ? compactToastBounds(header, props.sound != null)
    : bounds
  const button = { ...controlFrame, flex: 1 } as const
  const { frame } = props
  const row = scoringControlRow(frame?.fieldWidth ?? viewportWidth, insets)
  const showDone =
    (props.instruction != null || props.remainingMs != null) &&
    (props.onFinish != null || props.remainingMs != null)
  return (
    <View
      // Over a kept field, the field shows through, and takes the touches
      // nothing drawn over it takes.
      testID="baseball-screen"
      pointerEvents={kept ? 'box-none' : 'auto'}
      style={[
        surface.root,
        { backgroundColor: kept ? 'transparent' : theme.backgroundColor }
      ]}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        props.onRootSize?.({ width, height })
        setViewportHeight(event.nativeEvent.layout.height)
        setViewportWidth(event.nativeEvent.layout.width)
      }}
    >
      {historyBounds != null && (
        <HistoryPopup
          viewport={{ width: viewportWidth, height: viewportHeight }}
          bounds={historyBounds}
          rows={(props.historyRows ?? []).slice(-6)}
          onClose={closeHistory}
          onSelect={target => {
            closeHistory()
            props.onTagSelect?.(target)
          }}
        />
      )}
      {!kept && (
        <View
          testID="scoring-field-holder"
          style={[fieldHolderStyle(offset), { width: frame?.fieldWidth }]}
        >
          {props.suspended !== true && (
            <FieldCanvas
              {...translatedCanvas}
              {...SCORING_CAMERA}
              basicTouchShadows
              bottomExtension={SCORING_BOTTOM_EXTENSION}
              onScoreboardBounds={onScoreboardBounds}
            />
          )}
        </View>
      )}
      <View
        pointerEvents="box-none"
        style={[
          { position: 'absolute', inset: 0, justifyContent: 'space-between' },
          frame == null
            ? undefined
            : {
                width: frame.fieldWidth,
                right: undefined,
                // Web menus anchored to the viewport can extend over the box score.
                zIndex: Platform.OS === 'web' && frame.side ? 1 : undefined
              },
          bandedSafe(surface.safe, offset)
        ]}
      >
        <View
          pointerEvents="box-none"
          style={{ flexDirection: 'row', justifyContent: 'flex-end' }}
          onLayout={event => {
            setHeader(event.nativeEvent.layout)
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            accessibilityLabel={props.accessibilitySummary ?? props.summary}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              overflow: 'hidden',
              opacity: 0
            }}
          >
            {props.summary}
          </Text>
          {props.sound != null && (
            <View style={{ marginRight: 8 }}>
              <VolumeButton
                on={props.sound.on}
                onToggle={() => {
                  props.sound?.onToggle()
                }}
              />
            </View>
          )}
          {(props.dictationLog != null || props.sound != null) && (
            <View
              pointerEvents="box-none"
              style={{ flex: 1, minWidth: 0, height: 48, marginRight: 8 }}
            >
              <View
                pointerEvents="box-none"
                style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
              >
                {props.dictationLog}
              </View>
            </View>
          )}
          <GlassView
            radius={24}
            interactive
            // Real glass over the field: iOS's own, Android's backdrop blur,
            // and the web's backdrop-filter.
            androidBlur
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              overflow: 'hidden'
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open scoring menu"
              onPress={props.onMenu}
              style={{
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <ButtonIcon name="menu">
                <Text
                  selectable={false}
                  style={{ color: theme.primaryTextColor, fontSize: 26 }}
                >
                  ☰
                </Text>
              </ButtonIcon>
            </Pressable>
          </GlassView>
        </View>
        <InstructionToast
          setup={props.setupToast}
          instruction={props.instruction}
          status={props.instructionStatus}
          detail={props.instructionDetail}
          finishLabel={props.finishLabel}
          remainingMs={props.remainingMs}
          canFinish={props.canFinish}
          onFinish={props.onFinish}
          bounds={toastBounds}
          compact={compact}
          minTop={toastTopBelow(menuButton)}
          below={props.dictationLog == null ? 0 : DICTATION_LOG_HEIGHT + 8}
        />
        {props.onDismissHint != null && (
          <SwitchHitterHint bounds={bounds} onDismiss={props.onDismissHint} />
        )}
        {props.children}
        <View
          pointerEvents="box-none"
          style={
            frame == null
              ? undefined
              : {
                  position: 'absolute',
                  top: frame.deckTop,
                  left: row.left,
                  right: row.right
                }
          }
        >
          {(props.walkUpControl != null ||
            props.dictationControl != null ||
            showDone) && (
            <View
              pointerEvents="box-none"
              testID="walk-up-row"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: CONTROL_DECK_HEIGHT + CONTROL_GAP,
                flexDirection: 'row',
                alignItems: 'center',
                height: CONTROL_HEIGHT
              }}
            >
              <View pointerEvents="box-none" style={{ width: row.buttonWidth }}>
                {props.walkUpControl}
              </View>
              <View pointerEvents="none" style={{ flex: 1 }} />
              {showDone && (
                <View
                  pointerEvents="box-none"
                  style={{
                    width: DONE_WIDTH,
                    marginRight: props.dictationControl == null ? 0 : 6
                  }}
                >
                  <PillButton
                    testID="scoring-done-pill"
                    fitLabel
                    label={lstrings.common_done}
                    accessibilityLabel={sprintf(
                      lstrings.scoring_bottom_action,
                      props.finishLabel ?? lstrings.scoring_finish_at_bat
                    )}
                    disabled={props.canFinish !== true}
                    onPress={props.onFinish}
                  />
                </View>
              )}
              {props.dictationControl != null && (
                <View
                  pointerEvents="box-none"
                  style={{ width: row.buttonWidth }}
                >
                  {props.dictationControl}
                </View>
              )}
            </View>
          )}
          <View
            testID="scoring-deck"
            style={{
              flexDirection: 'row',
              gap: 6,
              height: CONTROL_DECK_HEIGHT
            }}
          >
            <View style={{ flex: 4, flexBasis: 18, gap: 8, minWidth: 0 }}>
              <View
                style={{ flexDirection: 'row', gap: 6, height: CONTROL_HEIGHT }}
              >
                {props.moreControl}
                <View style={{ flex: 3, flexBasis: 12 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      props.historyLabel == null
                        ? 'Nothing to undo'
                        : `Undo ${props.historyLabel}`
                    }
                    ref={undoButton}
                    disabled={props.historyLabel == null}
                    delayLongPress={500}
                    onPressIn={handleUndoPressIn}
                    onPressOut={handleUndoPressOut}
                    onLongPress={
                      props.onHistoryOpen == null
                        ? undefined
                        : () => {
                            handleUndoLongPress?.()
                            props.onHistoryOpen?.()
                            undoButton.current?.measureInWindow(
                              (x, y, width, height) => {
                                setHistoryBounds({ x, y, width, height })
                              }
                            )
                          }
                    }
                    onPress={() => {
                      props.onUndo()
                    }}
                    style={{
                      ...button,
                      flexDirection: 'row',
                      borderColor: CONTROL_COLORS.undo.border,
                      backgroundColor: CONTROL_COLORS.undo.bottom,
                      paddingHorizontal: 8,
                      opacity: props.historyLabel == null ? 0.5 : 1
                    }}
                  >
                    <ControlBackdrop kind="undo" />
                    <View
                      pointerEvents="none"
                      style={{
                        alignItems: 'center',
                        paddingRight: 8,
                        borderRightWidth: 1,
                        borderRightColor: '#ffffff1a',
                        gap: 2
                      }}
                    >
                      <View
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          backgroundColor: '#273a30',
                          borderWidth: 1,
                          borderColor: '#176448',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                      >
                        <ButtonIcon>
                          <ControlIcon kind="undo" size={14} />
                        </ButtonIcon>
                      </View>
                      <Text
                        selectable={false}
                        style={{
                          color: '#fbbf24',
                          fontFamily: theme.regularTextFont,
                          fontSize: 8,
                          fontWeight: '900',
                          letterSpacing: 1
                        }}
                      >
                        {lstrings.scoring_control_undo}
                      </Text>
                    </View>
                    <View
                      pointerEvents="none"
                      style={{ flex: 1, minWidth: 0, paddingLeft: 8, gap: 3 }}
                    >
                      <UndoTicker
                        enabled={
                          historyBounds == null &&
                          props.suspended !== true &&
                          props.historyLabel != null
                        }
                        testID="scoring-control-label"
                        style={{
                          color: '#ffffff',
                          fontFamily: theme.regularTextFont,
                          fontSize: 12,
                          fontWeight: '900'
                        }}
                        text={
                          props.historyLabel == null
                            ? lstrings.scoring_no_plays
                            : (props.historyDetail?.primary ??
                              props.historyLabel)
                        }
                      />
                      <UndoTicker
                        enabled={
                          historyBounds == null &&
                          props.suspended !== true &&
                          props.historyLabel != null
                        }
                        testID="scoring-undo-description"
                        style={{
                          color: '#cbd5e1',
                          fontFamily: theme.regularTextFont,
                          fontSize: 9
                        }}
                        text={
                          props.historyLabel == null
                            ? lstrings.scoring_history_hint
                            : props.historyDetail == null
                              ? lstrings.scoring_undo_hint
                              : (props.historyDetail.secondary ?? '')
                        }
                      />
                    </View>
                  </Pressable>
                </View>
              </View>
              <View
                style={{ flexDirection: 'row', gap: 6, height: CONTROL_HEIGHT }}
              >
                {PITCH_CONTROLS.filter(control => control.kind !== 'play').map(
                  control => (
                    <Pressable
                      key={control.kind}
                      accessibilityRole="button"
                      accessibilityLabel={control.label}
                      disabled={
                        !props.canPitch ||
                        (props.enabledPitchKinds != null &&
                          !props.enabledPitchKinds.includes(control.kind))
                      }
                      onPress={() => {
                        props.onPitch(control.kind)
                      }}
                      style={{
                        ...button,
                        backgroundColor: CONTROL_COLORS[control.kind].bottom,
                        borderColor: CONTROL_COLORS[control.kind].border,
                        opacity:
                          props.canPitch &&
                          (props.enabledPitchKinds == null ||
                            props.enabledPitchKinds.includes(control.kind))
                            ? 1
                            : 0.5
                      }}
                    >
                      <ControlBackdrop kind={control.kind} />
                      <ControlFace kind={control.kind} />
                    </Pressable>
                  )
                )}
              </View>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              {props.ballInPlayControl ?? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Swing in Play"
                  disabled={!props.canPitch}
                  onPress={() => {
                    props.onPitch('play')
                  }}
                  style={{ ...button, opacity: props.canPitch ? 1 : 0.5 }}
                >
                  <ControlBackdrop kind="contact" />
                  <ControlFace kind="contact" contact="swing" />
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </View>
      {frame != null && (
        <View
          testID="scoring-notice-strip"
          pointerEvents="none"
          collapsable={false}
          style={{
            position: 'absolute',
            top: frame.stripTop,
            left: 0,
            width: frame.fieldWidth,
            height: frame.stripHeight
          }}
        />
      )}
      {frame == null && props.remoteUpdates != null && (
        <RemoteScoringUpdates
          {...props.remoteUpdates}
          frame={{
            top: 0,
            left: row.left,
            width: viewportWidth - row.left - row.right,
            lines: 0
          }}
        />
      )}
      {frame != null && (
        <ScoringSidePanel
          frame={frame}
          insets={insets}
          row={row}
          updates={props.remoteUpdates}
          state={props.boxState}
        />
      )}
    </View>
  )
}
