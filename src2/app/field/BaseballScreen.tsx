import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { CameraDragControl } from './CameraDragControl'
import { FieldCanvas } from './FieldCanvas'
import type { FieldCanvasProps } from './fieldTypes'
import { PitchIcon } from './PitchIcon'
import { glassStyle, useFieldSurface } from './useFieldSurface'

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
  summary: string
  accessibilitySummary?: string
  children?: React.ReactNode
}
/** The game owns scoring and history; this surface owns only the camera. */
export function BaseballScreen(props: BaseballScreenProps): React.ReactElement {
  const surface = useFieldSurface()
  const [zoom, setZoom] = useState(1.25)
  const [tilt, setTilt] = useState((-11 * Math.PI) / 180)
  const [height, setHeight] = useState(33)
  return (
    <View style={[surface.root, { backgroundColor: '#102b23' }]}>
      <View style={{ flex: 1, marginBottom: 112 }}>
        <FieldCanvas
          {...props.field}
          zoom={zoom}
          cameraTilt={tilt}
          cameraHeight={height}
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
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            accessibilityLabel={props.accessibilitySummary ?? props.summary}
            style={{
              color: 'white',
              fontSize: 12,
              maxWidth: '44%',
              backgroundColor: '#14382dcc',
              padding: 6,
              borderRadius: 6
            }}
          >
            {props.summary}
          </Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            <CameraDragControl
              kind="zoom"
              value={zoom}
              onChange={setZoom}
              onActive={() => undefined}
            />
            <CameraDragControl
              kind="tilt"
              value={tilt}
              onChange={setTilt}
              onActive={() => undefined}
            />
            <CameraDragControl
              kind="height"
              value={height}
              onChange={setHeight}
              onActive={() => undefined}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open scoring menu"
              onPress={props.onMenu}
              style={{
                minWidth: 48,
                minHeight: 48,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#14382ddd',
                borderRadius: 8
              }}
            >
              <Text style={{ color: 'white', fontSize: 24 }}>☰</Text>
            </Pressable>
          </View>
        </View>
        {props.children}
        <View style={{ gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              props.historyLabel == null
                ? 'Nothing to undo'
                : `Undo ${props.historyLabel}`
            }
            disabled={props.historyLabel == null}
            onPress={props.onUndo}
            style={[
              glassStyle,
              {
                minHeight: 48,
                justifyContent: 'center',
                borderRadius: 8,
                padding: 12,
                backgroundColor: '#14382ddd'
              }
            ]}
          >
            <Text style={{ color: 'white' }}>
              ↶ Undo
              {props.historyLabel == null ? '' : ` · ${props.historyLabel}`}
            </Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {PITCH_CONTROLS.map(control => (
              <Pressable
                key={control.kind}
                accessibilityRole="button"
                accessibilityLabel={control.label}
                disabled={!props.canPitch}
                onPress={() => {
                  props.onPitch(control.kind)
                }}
                style={{
                  minHeight: 52,
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 8,
                  backgroundColor: '#14382ddd',
                  opacity: props.canPitch ? 1 : 0.5
                }}
              >
                <PitchIcon kind={control.kind} />
                <Text
                  style={{ color: 'white', fontSize: 11, textAlign: 'center' }}
                >
                  {control.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </View>
  )
}
