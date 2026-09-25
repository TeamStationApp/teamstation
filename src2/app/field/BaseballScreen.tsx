import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { GlassView } from '../components/GlassView'
import {
  InstructionToast,
  type ScoreboardBounds
} from '../scoring/InstructionToast'
import { SwitchHitterHint } from '../scoring/SwitchHitterHint'
import { useTheme } from '../theme/ThemeContext'
import { FieldCanvas } from './FieldCanvas'
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
  field: FieldCanvasProps
  onMenu: () => void
  onUndo: () => void
  onPitch: (kind: (typeof PITCH_CONTROLS)[number]['kind']) => void
  historyLabel?: string
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
  onDismissHint?: () => void
}
/** Immersive scoring surface, with one fixed responsive camera. */
export function BaseballScreen(props: BaseballScreenProps): React.ReactElement {
  const surface = useFieldSurface()
  const theme = useTheme()
  const [bounds, setBounds] = useState<ScoreboardBounds>()
  const [viewportHeight, setViewportHeight] = useState(0)
  const [header, setHeader] = useState<ScoreboardBounds>()
  const compact = viewportHeight > 0 && viewportHeight < 480 && header != null
  const toastBounds = compact
    ? { ...header, width: Math.max(100, header.width - 56) }
    : bounds
  const button = {
    minHeight: 52,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.scoringControlBackground,
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3
  } as const
  const label = {
    color: theme.scoringControlText,
    fontFamily: theme.semiBoldTextFont,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center'
  } as const
  return (
    <View
      style={[surface.root, { backgroundColor: theme.backgroundColor }]}
      onLayout={event => {
        setViewportHeight(event.nativeEvent.layout.height)
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
          <GlassView
            radius={24}
            interactive
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
          instruction={props.instruction}
          status={props.instructionStatus}
          detail={props.instructionDetail}
          finishLabel={props.finishLabel}
          remainingMs={props.remainingMs}
          canFinish={props.canFinish}
          onFinish={props.onFinish}
          bounds={toastBounds}
          compact={compact}
        />
        {props.onDismissHint != null && (
          <SwitchHitterHint bounds={bounds} onDismiss={props.onDismissHint} />
        )}
        {props.children}
        <View style={{ flexDirection: 'row', gap: 4, height: 112 }}>
          <View style={{ flex: 4, gap: 8, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', gap: 4, height: 52 }}>
              {props.moreControl}
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
                  alignItems: 'flex-start',
                  padding: 12,
                  opacity: props.historyLabel == null ? 0.5 : 1
                }}
              >
                <Text
                  selectable={false}
                  style={{
                    color: theme.scoringControlText,
                    fontFamily: theme.semiBoldTextFont
                  }}
                >
                  ↶ Undo
                  {props.historyLabel == null ? '' : ` · ${props.historyLabel}`}
                </Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: 'row', gap: 4, height: 52 }}>
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
                    style={{ ...button, opacity: props.canPitch ? 1 : 0.5 }}
                  >
                    <Text selectable={false} style={label}>
                      {control.label}
                    </Text>
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
                <Text selectable={false} style={label}>
                  Swing in Play
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  )
}
