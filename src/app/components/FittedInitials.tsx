import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { initialsFontSize } from './initialsFit'

/** Measure the loaded font rather than guessing the width of wide initials. */
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
  const [measured, setMeasured] = useState<{ key: string; font: number }>()
  const key = `${letters}:${box}:${theme.semiBoldTextFont}`
  useEffect(() => {
    let active = true
    const measure = (): void => {
      const context = document.createElement('canvas').getContext('2d')
      if (context == null) return
      context.font = `700 100px ${theme.semiBoldTextFont}`
      const metrics = context.measureText(letters)
      const font = initialsFontSize(
        box,
        Math.max(
          metrics.width,
          metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
        ),
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
        100
      )
      if (active) setMeasured({ key, font })
    }
    measure()
    document.fonts?.ready.then(measure).catch(() => undefined)
    document.fonts?.addEventListener('loadingdone', measure)
    return () => {
      active = false
      document.fonts?.removeEventListener('loadingdone', measure)
    }
  }, [letters, box, theme.semiBoldTextFont, key])
  return (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      style={{
        fontFamily: theme.semiBoldTextFont,
        fontWeight: '700',
        color,
        fontSize: measured?.key === key ? measured.font : box * 0.4,
        lineHeight: box * 0.8,
        textAlign: 'center',
        includeFontPadding: false
      }}
    >
      {letters}
    </Text>
  )
}
