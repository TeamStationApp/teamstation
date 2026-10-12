import React, { useRef } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { PhoneZoomScale } from '../phoneStreamClient'
import {
  CHROME_BLACK,
  MONOSPACE_FONT,
  ROUNDED_FONT,
  WHITE,
  ZOOM
} from './overlayTheme'
import type { RailBand } from './zoomGestures'
import {
  isDigitalSegment,
  isDigitalZoom,
  type ScaleHighlight,
  scaleHighlight,
  sliderLabel,
  zoomLabel
} from './zoomRail'

/** What can say where it is in the window: a laid-out view. */
export interface Measurable {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void
  ) => void
}

/**
 * Where the rail is in the window, top pill to bottom pill, and the gap from
 * one pill's centre to the next: what a vertical drag is measured against.
 */
export function measureRail(
  view: Measurable | null,
  pills: number,
  onRail: (band: RailBand, pointsPerSegment: number) => void
): void {
  view?.measureInWindow((_x, y, _width, height) => {
    onRail(
      { top: y, bottom: y + height },
      pills >= 2 ? (height - ZOOM.pill) / (pills - 1) : 0
    )
  })
}

export interface ZoomScaleProps {
  scale: PhoneZoomScale
  /** The zoom now, from the engine's status. */
  displayed: number
  onSelect: (displayed: number) => void
  /** Where the rail is on the screen, and its pill-to-pill gap, once laid out. */
  onRail?: (band: RailBand, pointsPerSegment: number) => void
}

/**
 * TS Cameraman's zoom rail, on the right edge: a pill per lens and for the
 * digital ceilings, widest at the bottom, five ticks between each pair, and
 * the zoom now to their left. A pill or tick lights for the zoom it stands
 * for; past the longest lens they are yellow.
 */
export function ZoomScale(props: ZoomScaleProps): React.ReactElement {
  const { scale, displayed, onSelect, onRail } = props
  const rail = useRef<React.ComponentRef<typeof View>>(null)
  const highlight = scaleHighlight(scale, displayed)
  const presets = scale.presets
  const order = presets.map((_, index) => index).reverse()

  return (
    <View testID="zoom-scale" style={styles.row}>
      <Text
        testID="zoom-label"
        style={[
          styles.readout,
          { color: isDigitalZoom(scale, displayed) ? ZOOM.digital : WHITE }
        ]}
      >
        {sliderLabel(displayed)}
      </Text>
      <View
        ref={rail}
        style={[styles.rail, presets.length <= 1 && styles.single]}
        onLayout={() => {
          if (onRail != null) measureRail(rail.current, presets.length, onRail)
        }}
      >
        {order.map(index => (
          <React.Fragment key={index}>
            <PresetPill
              preset={presets[index]}
              active={
                highlight.kind === 'preset' &&
                highlight.value === presets[index]
              }
              digital={isDigitalZoom(scale, presets[index])}
              onSelect={onSelect}
            />
            {index > 0 ? (
              <Ticks
                segment={index - 1}
                highlight={highlight}
                digital={isDigitalSegment(scale, index - 1)}
              />
            ) : null}
          </React.Fragment>
        ))}
      </View>
    </View>
  )
}

function PresetPill(props: {
  preset: number
  active: boolean
  digital: boolean
  onSelect: (displayed: number) => void
}): React.ReactElement {
  const { preset, active, digital, onSelect } = props
  const color = digital ? ZOOM.digital : WHITE
  return (
    <Pressable
      testID={`zoom-preset-${zoomLabel(preset)}`}
      accessibilityRole="button"
      aria-selected={active}
      onPress={() => {
        onSelect(preset)
      }}
      style={[
        styles.pill,
        active
          ? {
              backgroundColor: digital
                ? ZOOM.activeDigitalFill
                : ZOOM.activeFill
            }
          : styles.pillIdle
      ]}
    >
      <Text style={[styles.pillText, { color: active ? '#000000' : color }]}>
        {sliderLabel(preset)}
      </Text>
    </Pressable>
  )
}

function Ticks(props: {
  segment: number
  highlight: ScaleHighlight
  digital: boolean
}): React.ReactElement {
  const { segment, highlight, digital } = props
  const color = digital ? ZOOM.digital : WHITE
  const indexes = Array.from(
    { length: ZOOM.ticksPerSegment },
    (_, i) => i
  ).reverse()
  return (
    <View style={styles.ticks} pointerEvents="none">
      {indexes.map(index => {
        const active =
          highlight.kind === 'tick' &&
          highlight.segment === segment &&
          highlight.index === index
        return (
          <View
            key={index}
            testID={`zoom-tick-${segment}-${index}`}
            aria-selected={active}
            style={[
              styles.tick,
              {
                backgroundColor: color,
                width: active ? ZOOM.activeTickWidth : ZOOM.tickWidth,
                opacity: active ? 1 : ZOOM.tickOpacity
              }
            ]}
          />
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ZOOM.readoutGap,
    alignSelf: 'stretch'
  },
  readout: {
    minWidth: ZOOM.readoutMinWidth,
    textAlign: 'right',
    fontFamily: MONOSPACE_FONT,
    fontSize: ZOOM.fontSize,
    fontWeight: '600'
  },
  rail: {
    width: ZOOM.pill,
    alignSelf: 'stretch',
    alignItems: 'center'
  },
  single: {
    justifyContent: 'center'
  },
  pill: {
    width: ZOOM.pill,
    height: ZOOM.pill,
    borderRadius: ZOOM.pill / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pillIdle: {
    backgroundColor: CHROME_BLACK
  },
  pillText: {
    fontFamily: ROUNDED_FONT,
    fontSize: ZOOM.fontSize,
    fontWeight: '600'
  },
  ticks: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-evenly'
  },
  tick: {
    height: ZOOM.tickThickness,
    borderRadius: ZOOM.tickThickness / 2
  }
})
