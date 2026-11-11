import React from 'react'
import { Platform, StyleSheet, Text, type TextProps, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { fonts } from '../theme/fonts'
import { useTheme } from '../theme/ThemeContext'
import { Icon, type IconName } from './Icon'
import { iconText } from './iconText'

export type ButtonIconProps =
  | {
      name: IconName | 'menu' | 'reply' | 'more' | 'check' | 'pin'
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
  const theme = useTheme()
  const { name, size, children } = props
  const textStyle =
    children?.type === Text
      ? StyleSheet.flatten((children.props as TextProps).style)
      : undefined
  const color = props.color ?? textStyle?.color ?? theme.primaryTextColor
  if (Platform.OS === 'web') {
    if (children != null) return children
    if (
      name != null &&
      !['menu', 'reply', 'more', 'check', 'pin'].includes(name)
    )
      return <Icon name={name as IconName} size={size} color={props.color} />
  }
  const points =
    size != null ? theme.rem(size) : (textStyle?.fontSize ?? theme.rem(1.25))
  return (
    <View
      pointerEvents="none"
      accessible={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
        // Selection marks can be anchored over artwork. Preserve that slot's
        // placement while keeping font-baseline correction inside this component.
        textStyle?.position === 'absolute' && {
          position: 'absolute',
          top: textStyle.top,
          right: textStyle.right,
          bottom: textStyle.bottom,
          left: textStyle.left
        },
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
            transform: [{ translateY: -points / 10 }],
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
