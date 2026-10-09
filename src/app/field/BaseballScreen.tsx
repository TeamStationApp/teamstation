import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { GlassView } from '../components/GlassView'
import { PillButton } from '../components/PillTabs'
import { lstrings, sprintf } from '../locales/strings'
import {
  InstructionToast,
  type ScoreboardBounds,
  type SetupToast
} from '../scoring/InstructionToast'
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
import { SwitchHitterHint } from '../scoring/SwitchHitterHint'
import { useTheme } from '../theme/ThemeContext'
import { FieldCanvas } from './FieldCanvas'
import {
  type MenuButtonEdges,
  menuButtonEdges,
  toastTopBelow,
  WEB_MENU_BUTTON
} from './fieldSafeArea'
import type { FieldCanvasProps } from './fieldTypes'
import { useFieldSurface } from './useFieldSurface'

export const PITCH_CONTROLS = [
  { kind: 'ball', label: 'Ball' },
  { kind: 'called', label: 'Called Strike' },
  { kind: 'swing', label: 'Swing and Miss' },
  { kind: 'foul', label: 'Foul Ball' },
  { kind: 'play', label: 'Ball in Play' }
] as const
export interface BaseballScreenProps {
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
  historyLabel?: string
  /** The last play in two lines, shown in place of the label and the hint. */
  historyDetail?: { primary: string; secondary?: string }
  canPitch: boolean
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
  /** Sits in the top-left corner, ending left of the menu button. */
  dictationLog?: React.ReactNode
  onDismissHint?: () => void
}
/** Immersive scoring surface, with one fixed responsive camera. */
export function BaseballScreen(props: BaseballScreenProps): React.ReactElement {
  const surface = useFieldSurface()
  const theme = useTheme()
  const [bounds, setBounds] = useState<ScoreboardBounds>()
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
    ? { ...header, width: Math.max(100, header.width - 56) }
    : bounds
  const button = { ...controlFrame, flex: 1 } as const
  return (
    <View
      style={[surface.root, { backgroundColor: theme.backgroundColor }]}
      onLayout={event => {
        setViewportHeight(event.nativeEvent.layout.height)
        setViewportWidth(event.nativeEvent.layout.width)
      }}
    >
      <View style={{ flex: 1 }}>
        <FieldCanvas
          {...props.field}
          zoom={1.25}
          bottomExtension={112}
          cameraTilt={(-11 * Math.PI) / 180}
          cameraHeight={33}
          onScoreboardBounds={setBounds}
        />
      </View>
      <View
        pointerEvents="box-none"
        style={[
          { position: 'absolute', inset: 0, justifyContent: 'space-between' },
          surface.safe
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
          {props.dictationLog != null && (
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
              <Text
                selectable={false}
                style={{ color: theme.primaryTextColor, fontSize: 26 }}
              >
                ☰
              </Text>
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
        <View pointerEvents="box-none">
          {props.walkUpControl != null && (
            <View
              pointerEvents="box-none"
              testID="walk-up-row"
              style={{
                flexDirection: 'row',
                gap: 6,
                height: CONTROL_HEIGHT,
                marginBottom: CONTROL_GAP
              }}
            >
              <View
                pointerEvents="box-none"
                style={{
                  flex: 4,
                  flexBasis: 18,
                  flexDirection: 'row',
                  gap: 6,
                  minWidth: 0
                }}
              >
                <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0 }}>
                  {props.walkUpControl}
                </View>
                <View pointerEvents="none" style={{ flex: 3, flexBasis: 12 }} />
              </View>
              <View pointerEvents="none" style={{ flex: 1, minWidth: 0 }} />
            </View>
          )}
          <View
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
                  {(props.instruction != null || props.remainingMs != null) &&
                    (props.onFinish != null || props.remainingMs != null) && (
                      <View
                        pointerEvents="box-none"
                        style={{
                          position: 'absolute',
                          bottom: '100%',
                          left: 0,
                          right: 0,
                          alignItems: 'center'
                        }}
                      >
                        <PillButton
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
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      props.historyLabel == null
                        ? 'Nothing to undo'
                        : `Undo ${props.historyLabel}`
                    }
                    disabled={props.historyLabel == null}
                    onPress={props.onUndo}
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
                        <ControlIcon kind="undo" size={14} />
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
                      <Text
                        selectable={false}
                        numberOfLines={1}
                        testID="scoring-control-label"
                        style={{
                          color: '#ffffff',
                          fontFamily: theme.regularTextFont,
                          fontSize: 12,
                          fontWeight: '900'
                        }}
                      >
                        {props.historyLabel == null
                          ? lstrings.scoring_no_plays
                          : (props.historyDetail?.primary ??
                            props.historyLabel)}
                      </Text>
                      <Text
                        selectable={false}
                        numberOfLines={1}
                        style={{
                          color: '#cbd5e1',
                          fontFamily: theme.regularTextFont,
                          fontSize: 9
                        }}
                      >
                        {props.historyLabel == null
                          ? lstrings.scoring_history_hint
                          : props.historyDetail == null
                            ? lstrings.scoring_undo_hint
                            : (props.historyDetail.secondary ?? '')}
                      </Text>
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
                      disabled={!props.canPitch}
                      onPress={() => {
                        props.onPitch(control.kind)
                      }}
                      style={{
                        ...button,
                        backgroundColor: CONTROL_COLORS[control.kind].bottom,
                        borderColor: CONTROL_COLORS[control.kind].border,
                        opacity: props.canPitch ? 1 : 0.5
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
              {props.dictationControl != null && (
                <View
                  pointerEvents="box-none"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: CONTROL_DECK_HEIGHT + CONTROL_GAP
                  }}
                >
                  {props.dictationControl}
                </View>
              )}
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
    </View>
  )
}
