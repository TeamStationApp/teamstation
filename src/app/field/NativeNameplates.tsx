import React, { useCallback, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue
} from 'react-native-reanimated'

import { fonts } from '../theme/fonts'
import {
  anchorFrame,
  facesKey,
  type NameplateFace,
  nameplateFaces,
  type NameplateSpot,
  nameplateSpots,
  sameSpots
} from './nameplateOverlay'
import {
  EMPTY_POSITION_FONT,
  EMPTY_POSITION_SIZE,
  NAMEPLATE_FONT,
  NAMEPLATE_LINE_GAP,
  NAMEPLATE_NUMBER_FONT,
  NAMEPLATE_PAD,
  type NameplatePlacement
} from './playerPresentation'

type Spots = SharedValue<Record<string, NameplateSpot>>

/**
 * The field's nameplates on a phone: what the scene reports each frame it
 * draws (`FieldScene`'s `onNameplates`, the browser's own), as views over the
 * GL canvas.
 *
 * A frame moves the plates on the UI thread through a shared value; React
 * renders them again only when what they say changes — a player comes or
 * goes, or takes the ball. `report` is stable.
 */
export function useFieldNameplates(): {
  report: (plates: NameplatePlacement[]) => void
  faces: NameplateFace[]
  spots: Spots
} {
  const spots = useSharedValue<Record<string, NameplateSpot>>({})
  const [faces, setFaces] = useState<NameplateFace[]>([])
  const shown = useRef(facesKey([]))
  const placed = useRef<Record<string, NameplateSpot>>({})
  const report = useCallback(
    (plates: NameplatePlacement[]) => {
      const where = nameplateSpots(plates)
      if (!sameSpots(placed.current, where)) {
        placed.current = where
        spots.value = where
      }
      const next = nameplateFaces(plates)
      const key = facesKey(next)
      if (key === shown.current) return
      shown.current = key
      setFaces(next)
    },
    [spots]
  )
  return { report, faces, spots }
}

/** Laid over the field, the same size, touching nothing. */
export function FieldNameplates({
  faces,
  spots
}: {
  faces: NameplateFace[]
  spots: Spots
}): React.ReactElement {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
    >
      {faces.map(face => (
        <Nameplate key={face.id} face={face} spots={spots} />
      ))}
    </View>
  )
}

function Nameplate({
  face,
  spots
}: {
  face: NameplateFace
  spots: Spots
}): React.ReactElement {
  const { id } = face
  const moved = useAnimatedStyle(() => {
    const spot = spots.value[id]
    return {
      opacity: spot?.visible ? 1 : 0,
      transform: [{ translateX: spot?.x ?? 0 }, { translateY: spot?.y ?? 0 }]
    }
  })
  const frame = anchorFrame(face.anchorX, face.anchorY)
  return (
    <Animated.View
      testID="field-nameplate"
      style={[{ position: 'absolute', ...PLATE_ORIGIN }, moved]}
    >
      <View style={{ position: 'absolute', ...frame }}>
        <View
          accessibilityLabel={
            face.emptyPosition === true ? `Assign ${face.name}` : undefined
          }
          style={{
            padding: NAMEPLATE_PAD,
            gap: face.number === '' ? 0 : NAMEPLATE_LINE_GAP,
            borderRadius: face.emptyPosition === true ? 2 : 8,
            backgroundColor:
              face.emptyPosition === true
                ? 'rgba(255, 190, 190, 0.22)'
                : face.color,
            borderWidth: face.emptyPosition === true ? 2 : 0,
            borderStyle: face.emptyPosition === true ? 'dashed' : 'solid',
            borderColor: '#d65454',
            width:
              face.emptyPosition === true ? EMPTY_POSITION_SIZE : undefined,
            height:
              face.emptyPosition === true ? EMPTY_POSITION_SIZE : undefined,
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          <Text
            numberOfLines={1}
            style={[
              styles.line,
              {
                fontSize:
                  face.emptyPosition === true
                    ? EMPTY_POSITION_FONT
                    : NAMEPLATE_FONT,
                lineHeight:
                  face.emptyPosition === true
                    ? EMPTY_POSITION_FONT
                    : NAMEPLATE_FONT,
                fontWeight: face.emptyPosition === true ? '700' : '400',
                color: '#ffffff'
              }
            ]}
          >
            {face.name}
          </Text>
          {face.number !== '' && (
            <Text
              numberOfLines={1}
              style={[
                styles.line,
                {
                  fontSize: NAMEPLATE_NUMBER_FONT,
                  lineHeight: NAMEPLATE_NUMBER_FONT
                }
              ]}
            >
              {face.number}
            </Text>
          )}
        </View>
      </View>
    </Animated.View>
  )
}

/**
 * Where a plate's moving view sits before its transform: at the field's
 * corner, one point square. Never empty: iOS recycles native views, and a
 * recycled view's layout starts as an empty frame at the origin, so a view
 * laid out as exactly that is never moved or sized again and keeps the place
 * of whatever view it last was. A plate came up off the screen, or over the
 * wrong player, and a runner's stayed at first base after a double.
 */
export const PLATE_ORIGIN = { left: 0, top: 0, width: 1, height: 1 } as const

const styles = StyleSheet.create({
  line: {
    color: '#ffffff',
    fontFamily: fonts.spaceGrotesk,
    fontWeight: '400',
    textAlign: 'center',
    // Android pads text for accents; the browser's plate hugs the type.
    includeFontPadding: false
  }
})
