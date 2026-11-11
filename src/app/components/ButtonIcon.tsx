import React from 'react'
import {
  I18nManager,
  Platform,
  StyleSheet,
  Text,
  type TextProps,
  type TextStyle,
  useWindowDimensions,
  View
} from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { fonts } from '../theme/fonts'
import { useTheme } from '../theme/ThemeContext'
import { Icon, type IconName } from './Icon'
import { iconText } from './iconText'

const customNames = ['menu', 'reply', 'more', 'check', 'pin'] as const
type CustomName = (typeof customNames)[number]
function isCustomName(name: IconName | CustomName): name is CustomName {
  return customNames.some(custom => custom === name)
}

// Text metrics stay on the sizing Text; every other style belongs to its box.
const typographyKeys = new Set([
  'color',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontVariant',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textAlignVertical',
  'textDecorationLine',
  'textDecorationStyle',
  'textDecorationColor',
  'textShadowColor',
  'textShadowOffset',
  'textShadowRadius',
  'textTransform',
  'includeFontPadding',
  'writingDirection',
  'userSelect',
  'verticalAlign'
])

export type ButtonIconProps =
  | {
      name: IconName | CustomName
      size?: number
      color?: string
      /** Existing web artwork, when the control uses a custom glyph. */
      children?: React.ReactElement
    }
  | {
      /** Vector artwork has no font baseline to compensate. */
      children: React.ReactElement
      name?: never
      size?: never
      color?: never
    }

/** Places artwork inside an existing button without creating a second target. */
export function ButtonIcon(props: ButtonIconProps): React.ReactElement {
  return Platform.OS === 'web' ? (
    <WebButtonIcon {...props} />
  ) : (
    <NativeButtonIcon {...props} />
  )
}
function WebButtonIcon(props: ButtonIconProps): React.ReactElement {
  const theme = useTheme()
  if (props.children != null) return props.children
  if (props.name != null && !isCustomName(props.name))
    return <Icon name={props.name} size={props.size} color={props.color} />
  return (
    <Artwork
      name={props.name}
      points={theme.rem(props.size ?? 1.25)}
      color={props.color ?? theme.primaryTextColor}
    />
  )
}
function NativeButtonIcon(props: ButtonIconProps): React.ReactElement {
  const theme = useTheme()
  const { fontScale } = useWindowDimensions()
  const { name, size, children } = props
  const textStyle =
    children?.type === Text
      ? StyleSheet.flatten((children.props as TextProps).style)
      : undefined
  const color = props.color ?? textStyle?.color ?? theme.primaryTextColor
  const textProps =
    children?.type === Text ? (children.props as TextProps) : undefined
  const basePoints =
    size != null
      ? theme.rem(size)
      : (textStyle?.fontSize ?? (textProps != null ? 14 : theme.rem(1.25)))
  const maxScale = textProps?.maxFontSizeMultiplier
  const scale =
    textProps?.allowFontScaling === false
      ? 1
      : maxScale != null && maxScale >= 1
        ? Math.min(fontScale, maxScale)
        : fontScale
  const points = basePoints * scale
  if (textProps != null && children != null) {
    const layout: TextStyle = {}
    const typography: TextStyle = {}
    for (const [key, value] of Object.entries(textStyle ?? {}))
      Object.assign(typographyKeys.has(key) ? typography : layout, {
        [key]: value
      })
    const alignment = textStyle?.textAlign
    const direction = textStyle?.writingDirection ?? textStyle?.direction
    const rtl =
      direction === 'rtl' || (direction !== 'ltr' && I18nManager.isRTL)
    return (
      <View
        pointerEvents="none"
        accessible={false}
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            justifyContent: 'center',
            direction: rtl ? 'rtl' : 'ltr',
            alignItems:
              alignment === 'center'
                ? 'center'
                : (alignment === 'left' && rtl) ||
                    (alignment === 'right' && !rtl)
                  ? 'flex-end'
                  : 'flex-start'
          },
          layout
        ]}
      >
        <View>
          {React.cloneElement(children as React.ReactElement<TextProps>, {
            style: [typography, name != null && { opacity: 0 }]
          })}
          {name != null && (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                { alignItems: 'center', justifyContent: 'center' }
              ]}
            >
              <Artwork name={name} points={points} color={color} />
            </View>
          )}
        </View>
      </View>
    )
  }
  return (
    <Artwork name={name} points={points} color={color}>
      {children}
    </Artwork>
  )
}

function Artwork({
  name,
  points,
  color,
  children
}: {
  name: ButtonIconProps['name']
  points: number
  color: TextStyle['color']
  children?: React.ReactElement
}): React.ReactElement {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
        name != null && { width: points, height: points }
      ]}
    >
      {name === 'reply' || name === 'check' || name === 'pin' ? (
        <Svg width={points} height={points} viewBox="0 0 24 24">
          <Path
            d={
              name === 'pin'
                ? 'M12 2 V7 M12 17 V22 M2 12 H7 M17 12 H22 M18 12 A6 6 0 1 1 6 12 A6 6 0 1 1 18 12'
                : name === 'check'
                  ? 'M4 12 L9 17 L20 6'
                  : 'M10 5 L4 11 L10 17 M4 11 H15 Q20 11 20 19'
            }
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      ) : name === 'more' ? (
        <View
          style={{
            width: points,
            flexDirection: 'row',
            justifyContent: 'space-between'
          }}
        >
          {[0, 1, 2].map(dot => (
            <View
              key={dot}
              style={{
                width: points / 6,
                height: points / 6,
                borderRadius: points / 12,
                backgroundColor: color
              }}
            />
          ))}
        </View>
      ) : name === 'menu' ? (
        <View
          style={{
            width: points * 0.8,
            height: points * 0.65,
            justifyContent: 'space-between'
          }}
        >
          {[0, 1, 2].map(line => (
            <View
              key={line}
              style={{ height: points / 12, backgroundColor: color }}
            />
          ))}
        </View>
      ) : name != null ? (
        <Text
          selectable={false}
          allowFontScaling={false}
          style={{
            fontFamily: fonts.materialSymbols,
            fontSize: points,
            includeFontPadding: false,
            // Both native renderers retain the font's 0.1em descender below
            // its visible artwork when centering the natural text frame.
            transform: [
              { translateY: -points / 10 },
              // The bundled play outline spans x=320..760 in a 960-unit
              // advance: center its ink, which sits 60 units right of center.
              { translateX: name === 'play_arrow' ? -points / 16 : 0 }
            ],
            color
          }}
        >
          {iconText(name)}
        </Text>
      ) : (
        children
      )}
    </View>
  )
}
