import React from 'react'
import { Text, View } from 'react-native'

import type { CameraSource } from '../../common/api'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * RTMP in a box, two letters over two, for a camera that is no make in
 * particular.
 */
export function RtmpIcon(): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.tile} testID="rtmp-icon">
      {[
        ['R', 'T'],
        ['M', 'P']
      ].map(row => (
        <View key={row[0]} style={styles.letters}>
          {row.map(letter => (
            <Text key={letter} style={styles.letter}>
              {letter}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}

/**
 * A camera's make on a row, as its name on a small tile: the repository is
 * public and holds no maker's logo files.
 */
export function CameraLogo(props: {
  source: CameraSource
}): React.ReactElement {
  const styles = getStyles(useTheme())
  if (props.source === 'rtmp') return <RtmpIcon />
  return (
    <View style={styles.tile}>
      <Text
        style={styles.name}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {props.source === 'gopro'
          ? lstrings.stream_source_gopro
          : lstrings.stream_source_mevo}
      </Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  tile: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.containerBackgroundColor,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(0.0625)
  },
  letters: {
    flexDirection: 'row',
    gap: theme.rem(0.375)
  },
  letter: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.75),
    lineHeight: theme.rem(0.875),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  name: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    color: theme.primaryTextColor
  }
}))
