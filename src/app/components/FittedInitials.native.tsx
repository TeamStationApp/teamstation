import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { initialsFontSize } from './initialsFit'

/** One intrinsic native text measurement; sizing never feeds back into it. */
export function FittedInitials({
  letters,
  size,
  color
}: {
  letters: string
  size: number
  color: string
}): React.ReactElement {
  const theme = useTheme()
  const box = theme.rem(size)
  const key = `${letters}:${box}:${theme.semiBoldTextFont}`
  const [measured, setMeasured] = useState<{ key: string; font: number }>()
  const font = measured?.key === key ? measured.font : box * 0.4
  return (
    <View
      style={{
        width: box * 0.8,
        height: box * 0.8,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Text
        key={key}
        accessible={false}
        allowFontScaling={false}
        style={{
          position: 'absolute',
          width: box * 8,
          opacity: 0,
          fontFamily: theme.semiBoldTextFont,
          fontWeight: '700',
          fontSize: 100,
          includeFontPadding: false
        }}
        onTextLayout={event => {
          const line = event.nativeEvent.lines[0]
          if (line == null) return
          const next = initialsFontSize(box, line.width, line.capHeight, 100)
          setMeasured(previous =>
            previous?.key === key && previous.font === next
              ? previous
              : { key, font: next }
          )
        }}
      >
        {letters}
      </Text>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.1}
        style={{
          fontFamily: theme.semiBoldTextFont,
          fontWeight: '700',
          fontSize: font,
          lineHeight: box * 0.8,
          includeFontPadding: false,
          color,
          textAlign: 'center'
        }}
      >
        {letters}
      </Text>
    </View>
  )
}
