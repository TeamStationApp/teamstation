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
  remainingMs?: number
  onCameraGesture?: (active: boolean) => void
  summary: string
  accessibilitySummary?: string
  children?: React.ReactNode
  ballInPlayControl?: React.ReactNode
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
              onActive={props.onCameraGesture ?? (() => undefined)}
            />
            <CameraDragControl
              kind="tilt"
              value={tilt}
              onChange={setTilt}
              onActive={props.onCameraGesture ?? (() => undefined)}
            />
            <CameraDragControl
              kind="height"
              value={height}
              onChange={setHeight}
              onActive={props.onCameraGesture ?? (() => undefined)}
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
            accessibilityHint={
              props.remainingMs == null
                ? undefined
                : `${Math.ceil(props.remainingMs / 1000)} seconds to edit this play`
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
            {props.remainingMs != null && (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="Time to edit play"
                aria-valuemin={0}
                aria-valuemax={10}
                aria-valuenow={Math.ceil(props.remainingMs / 1000)}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${Math.max(0, props.remainingMs / 100)}%`,
                  backgroundColor: '#b69a3b66',
                  borderRadius: 8
                }}
              />
            )}
            <Text style={{ color: 'white' }}>
              ↶ Undo
              {props.historyLabel == null ? '' : ` · ${props.historyLabel}`}
              {props.remainingMs == null
                ? ''
                : ` · ${Math.ceil(props.remainingMs / 1000)}s`}
            </Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {PITCH_CONTROLS.map(control =>
              control.kind === 'play' && props.ballInPlayControl != null ? (
                <React.Fragment key={control.kind}>
                  {props.ballInPlayControl}
                </React.Fragment>
              ) : (
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
                    style={{
                      color: 'white',
                      fontSize: 11,
                      textAlign: 'center'
                    }}
                  >
                    {control.label}
                  </Text>
                </Pressable>
              )
            )}
          </View>
        </View>
      </View>
    </View>
  )
}
