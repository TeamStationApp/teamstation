import React, { useId, useState } from 'react'
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native'
import {
  Defs,
  LinearGradient as SvgGradient,
  Rect,
  Stop,
  Svg
} from 'react-native-svg'

export interface LinearGradientProps {
  colors: string[]
  /** Fractions of the box, as `react-native-linear-gradient` takes them. */
  start?: { x: number; y: number }
  end?: { x: number; y: number }
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}

/**
 * The board's gradients on a phone, with the props
 * `react-native-linear-gradient` takes, drawn by `react-native-svg`.
 *
 * The web draws them with `react-native-web-linear-gradient`
 * (`linearGradient.tsx`); the native gradient package is not installed, and
 * `react-native-svg` already is, for the mark. The colours are spread evenly
 * along the line from `start` to `end`, and the defaults are that package's:
 * top to bottom down the middle.
 *
 * The `Svg` fills the box behind the children, and the box clips it to its
 * own rounded corners, so the caller styles a box in the ordinary way. It is
 * drawn at 100% until the box is measured, so the first frame is filled, and
 * at the box's laid-out size from then on: a percentage `Svg` keeps the size
 * it first had, so a box that grows after its first layout (a team bar
 * widened to the board's least width) was left part filled.
 */
export default function LinearGradient(
  props: LinearGradientProps
): React.ReactElement {
  const {
    colors,
    start = { x: 0.5, y: 0 },
    end = { x: 0.5, y: 1 },
    style,
    children
  } = props
  // Unique per gradient, since every `Svg` on a screen shares one id space,
  // and without the colons `useId` puts in, which a `url(#…)` cannot name.
  const id = `gradient${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const last = Math.max(1, colors.length - 1)
  const [measured, setSize] = useState<{ width: number; height: number }>()
  const size = measured ?? { width: '100%', height: '100%' }
  return (
    <View
      style={[style, styles.clip]}
      onLayout={event => {
        // The layout is the box's outside, border included; the `Svg` fills
        // the inside, so the border comes off each side.
        const border = bordersOf(style)
        const width = Math.max(
          0,
          event.nativeEvent.layout.width - border.left - border.right
        )
        const height = Math.max(
          0,
          event.nativeEvent.layout.height - border.top - border.bottom
        )
        setSize(current =>
          current?.width === width && current.height === height
            ? current
            : { width, height }
        )
      }}
    >
      <Svg
        style={StyleSheet.absoluteFill}
        width={size.width}
        height={size.height}
      >
        <Defs>
          <SvgGradient
            id={id}
            x1={String(start.x)}
            y1={String(start.y)}
            x2={String(end.x)}
            y2={String(end.y)}
          >
            {colors.map((color, index) => (
              <Stop
                key={`${index}:${color}`}
                offset={String(index / last)}
                stopColor={color}
              />
            ))}
          </SvgGradient>
        </Defs>
        <Rect width={size.width} height={size.height} fill={`url(#${id})`} />
      </Svg>
      {children}
    </View>
  )
}

/** The widths of a box's border, side by side, as its style gives them. */
function bordersOf(style: StyleProp<ViewStyle>): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const flat = StyleSheet.flatten(style) ?? {}
  const all = typeof flat.borderWidth === 'number' ? flat.borderWidth : 0
  const side = (width: unknown): number =>
    typeof width === 'number' ? width : all
  return {
    left: side(flat.borderLeftWidth ?? flat.borderStartWidth),
    right: side(flat.borderRightWidth ?? flat.borderEndWidth),
    top: side(flat.borderTopWidth),
    bottom: side(flat.borderBottomWidth)
  }
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' }
})
